#!/usr/bin/env node
'use strict';
// ccbb web — a clean web UI for browsing Claude Code sessions, with an
// optional live composer that can drive a session running in a local tmux pane.
//
// Started via `ccbb web` (see ccbb.js) or directly with `node ccbb-web.js`.
// The data/stats/tmux/permission-parsing layer is shared with every other front-end
// through ccbb-common.js; this file owns the HTML/JS templates, the HTTP+WebSocket
// server, the web-flavored custom-command runner, and the pipe-pane permission scraper.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const common = require('./ccbb-common');
const {
  serverIdentity, peerList, peerByName, peerToken,
  CLAUDE_DIR, getSessions, getCostSummary, getSessionInfo, getSessionHistory, getSubagentHistory, getSessionStats,
  sessionLiveness, renameSession, paneForSession, injectToPane, transcriptEntry,
  getSessionCwd, findSessionJsonl, priceTable,
  loadCommands, expandRun, truncTitle, looksLikeDiff, langForFile,
  awsIdText, awsLoginStream, tmux, capturePane, parsePrompt, promptFingerprint,
  askQuestions, openAskEntry,
  startTail, stopTail,
} = common;

const DEFAULT_PORT = 8590;
let VERSION = ''; try { VERSION = require('./package.json').version || ''; } catch {}
let WS; try { WS = require('ws'); } catch {}

// ── Event bus ────────────────────────────────────────────────────────────────
// Every server-side event (permission, permission_clear, ask_block, transcript,
// command output) is emitted through emit(sessionId, obj). Browsers receive it over
// WebSocket (wsSend, wired by runWeb once the WS server exists); in-process front-ends
// (webex, confluence, launched via `ccbb web --webex/--confluence`) receive the SAME
// events by registering via onServerEvent(). This is what lets every front-end share
// the one hook+scrape permission path instead of each running its own scraper.
let wsSend = () => {};                    // set to the WS fan-out in runWeb
const busListeners = new Set();           // fn(sessionId, obj)
function onServerEvent(fn) { busListeners.add(fn); return () => busListeners.delete(fn); }
function wsBroadcast(sessionId, obj) {
  wsSend(sessionId, obj);
  for (const fn of busListeners) { try { fn(sessionId, obj); } catch (e) { console.error('[bus]', e.message); } }
}

// ── Custom "//" commands (web variant: returns structured { kind, title, content }) ──
const awsLogins = new Map();   // sessionId → running `aws sso login` child (one at a time)

// Run a "//" command for a session. Returns { kind, title, content } (or { error }).
// cwd defaults to the session's working directory; `cd` returns a new cwd the client
// persists and passes back on subsequent calls.
function runCommand(sessionId, name, args, cwd) {
  const commands = loadCommands();
  const spec = commands[name];
  if (!spec) return { error: `Unknown command: //${name}. Try //help` };
  const baseCwd = cwd || getSessionCwd(sessionId) || process.cwd();

  if (spec.builtin === 'help') return { kind: 'markdown', title: '//help', content: commandsHelp(commands) };
  if (spec.builtin === 'pwd')  return { kind: 'console', title: '//pwd', content: baseCwd, cwd: baseCwd };
  if (spec.builtin === 'clear') return { kind: 'clear' };
  if (spec.builtin === 'usage') return { kind: 'console', title: '//usage', content: '(see the header stats above)', cwd: baseCwd };
  if (spec.builtin === 'cd') {
    const target = args.trim() || os.homedir();
    const next = path.resolve(baseCwd, target);
    let ok = false;
    try { ok = fs.statSync(next).isDirectory(); } catch {}
    if (!ok) return { error: `cd: no such directory: ${target}`, cwd: baseCwd };
    return { kind: 'console', title: `//cd ${target}`, content: next, cwd: next };
  }
  if (spec.builtin === 'aws-id') {
    return { kind: 'console', title: '//aws-id', content: awsIdText(spec.cli || 'aws', spec.profile), cwd: baseCwd };
  }
  // //aws-login streams: the device URL/code print first, the process then blocks until
  // the browser login completes. We return an initial frame and push updates over WS.
  if (spec.builtin === 'aws-login') {
    if (awsLogins.has(sessionId)) {
      return { kind: 'console', title: '//aws-login', content: 'Login already in progress…', cwd: baseCwd };
    }
    let log = '';
    const push = () => wsBroadcast(sessionId, { type: 'command', kind: 'console', title: '//aws-login', content: log.trim() || 'Starting AWS SSO login…' });
    const cli = spec.cli || 'aws', profile = spec.profile;
    const child = awsLoginStream(
      cli, profile,
      chunk => { log += chunk; push(); },
      (ok, tail) => {
        awsLogins.delete(sessionId);
        log += `\n\n${ok ? '✅ Logged in.\n' + awsIdText(cli, profile) : '❌ Login failed.'}`;
        push();
      });
    awsLogins.set(sessionId, child);
    return { kind: 'console', title: '//aws-login', content: 'Starting AWS SSO login…', cwd: baseCwd };
  }
  // //sh runs the raw argument string as a shell script (no $ARGS/$1 substitution).
  if (spec.builtin === 'sh') {
    const script = args;
    if (!script.trim()) return { error: 'Usage: //sh <shell-script>', cwd: baseCwd };
    const r = spawnSync('bash', ['-lc', script], { cwd: baseCwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '');
    return { kind: 'console', title: `//sh ${truncTitle(script)}`, content: out.replace(/\s+$/, '') || '(no output)', cwd: baseCwd };
  }

  const cmd = expandRun(spec.run || '', args);
  const r = spawnSync('bash', ['-lc', cmd], { cwd: baseCwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '');
  const content = out.replace(/\s+$/, '') || '(no output)';
  const result = { title: `//${name}${args.trim() ? ' ' + args.trim() : ''}`, content, cwd: baseCwd };

  if ((spec.kind || 'console') === 'source') {
    const fname = args.trim().split(/\s+/).pop() || '';
    const ext = path.extname(fname).slice(1).toLowerCase();
    if (ext === 'md' || ext === 'markdown') { result.kind = 'markdown'; }
    else if (ext === 'diff' || ext === 'patch' || looksLikeDiff(content)) { result.kind = 'source'; result.lang = 'diff'; }
    else { result.kind = 'source'; result.lang = langForFile(fname); }
  } else {
    result.kind = spec.kind || 'console';
  }
  return result;
}

function commandsHelp(commands) {
  const lines = ['# Custom commands', '', 'Type `//name [args]` in the composer.', ''];
  for (const name of Object.keys(commands).sort()) {
    const spec = commands[name] || {};
    const what = spec.builtin ? `(built-in ${spec.builtin})` : '`' + (spec.run || '') + '`';
    lines.push(`- **//${name}** — ${what}`);
  }
  return lines.join('\n');
}

// ── Web: stacked-views app ───────────────────────────────────────────────────
// One page holds a vertical stack of VIEWS. A view is either the session LIST
// (always present, always on top, not closable) or one SESSION's transcript.
// Every view has a title bar with an update indicator plus refresh / normal-max /
// close buttons. Normal: all expanded views share the height equally (flex 1 1 0).
// Max: one view takes the space, every other view collapses to its title bar.
// Updates that land while a view is collapsed, hidden, or scrolled away light a
// prominent indicator on its bar; it clears once the view is actually seen
// (expanded and following the bottom).
const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccbb</title>
<link rel="shortcut icon" href="data:image/svg+xml,%3Csvg viewBox='0 0 64 64' xmlns='http://www.w3.org/2000/svg'%3E%3Crect x='16' y='12' width='32' height='28' rx='4' fill='%23FF6B35'/%3E%3Ccircle cx='24' cy='20' r='4' fill='%23fff'/%3E%3Ccircle cx='40' cy='20' r='4' fill='%23fff'/%3E%3Crect x='20' y='28' width='24' height='2' fill='%23fff' rx='1'/%3E%3Crect x='18' y='42' width='28' height='16' rx='2' fill='%23FF6B35'/%3E%3Crect x='8' y='46' width='10' height='8' rx='2' fill='%23FF6B35'/%3E%3Crect x='46' y='46' width='10' height='8' rx='2' fill='%23FF6B35'/%3E%3C/svg%3E" />
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/highlight.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css">
<style>
:root{
  --bg:#fff; --bg-alt:#f0eee6; --surface:#fff; --ink:#3d3d3a; --ink-soft:#6e6d66;
  --ink-faint:#9b998f; --line:#e6e3da; --line-soft:#efece4; --accent:#c96442;
  --accent-soft:#f5e9e3; --code-bg:#f5f3ec;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;background:var(--bg);color:var(--ink);height:100vh;display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
/* ── view stack ── */
#views{flex:1;min-height:0;display:flex;flex-direction:column}
.view{display:flex;flex-direction:column;flex:1 1 0;min-height:0;min-width:0;border-bottom:1px solid var(--line)}
.view:last-child{border-bottom:none}
.view.collapsed{flex:0 0 auto}
.view.collapsed .view-body{display:none}
.view-bar{flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:6px 14px;background:var(--bg-alt);border-bottom:1px solid var(--line);min-height:38px}
.view.collapsed .view-bar{cursor:pointer;border-bottom:none}
/* Stowed away: nothing but the chevron, so a folded list costs a sliver instead of a
   column. Clicking anywhere on the strip brings it back. */
.view.folded .view-bar{min-height:0;padding:3px 6px}
.view.folded .bar-title,.view.folded .bar-refreshed,.view.folded .bar-btns{display:none}
/* Pushed aside by another view's maximize — recedes, but an unseen update still shouts. */
.view.dimmed .view-bar{opacity:.5}
.view.dimmed.unseen .view-bar{opacity:1}
.bar-btns{margin-left:auto;display:flex;gap:2px;flex-shrink:0}
.vb-btn{background:none;border:none;color:var(--ink-soft);font-size:14px;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px;font-family:inherit}
.vb-btn:hover{background:var(--line);color:var(--ink)}
.unseen-ind{display:none}
.view.unseen .view-bar{background:#f9e3d5}
.view.unseen .unseen-ind{display:inline-flex;align-items:center;background:var(--accent);color:#fff;border-radius:10px;padding:2px 10px;font-size:11px;font-weight:600;flex-shrink:0;animation:pulse 1.2s ease-in-out infinite}
.view-body{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.bar-name{font-weight:600;font-size:13px;color:var(--ink);white-space:nowrap;
  display:flex;align-items:baseline;gap:10px;flex:1 1 auto;min-width:0;overflow:hidden}
.bar-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fold-btn{flex-shrink:0;cursor:pointer;color:var(--ink-soft);font-size:10px;line-height:1;
  padding:3px 5px;margin:-3px -2px -3px -5px;border-radius:5px;align-self:center}
.fold-btn:hover{background:var(--line);color:var(--ink)}
.bar-refreshed{font-weight:400;font-size:11px;color:var(--ink-faint);margin-left:auto;white-space:nowrap}
/* ── horizontal: all view headers sit in one top row, their bodies in the content row
   below, column-aligned. Each view keeps the SAME header it has in vertical mode, just
   narrower. Maximizing one view makes its body span the whole content row while the
   others' bodies hide and their headers clamp. Implemented as a 2-row grid over #views,
   with each .view flattened via display:contents so its bar and body become direct grid
   items — the bar auto-places into row 1, the body into row 2, same column.
   grid-template-columns and the maxed body's column span are set per-relayout in JS. ── */
#views.horizontal{display:grid;grid-template-rows:auto minmax(0,1fr)}
#views.horizontal .view{display:contents}
#views.horizontal .view-bar{grid-row:1;border-bottom:1px solid var(--line);border-right:1px solid var(--line)}
#views.horizontal .view:last-child .view-bar{border-right:none}
#views.horizontal .view-body{grid-row:2;min-width:0;border-right:1px solid var(--line)}
#views.horizontal .view:last-child .view-body{border-right:none}
#views.horizontal .view.collapsed .view-body{display:none}
/* A collapsed column must not hold the row open, so its header clamps: the list drops
   its timestamp, and both kinds let the title ellipsize. */
#views.horizontal .view.collapsed .bar-main{max-width:11ch}
#views.horizontal .lv.collapsed .bar-refreshed{display:none}
/* ── list view ── */
.lv{font-family:ui-monospace,'Cascadia Code',Menlo,monospace;font-size:13px;background:#fff}
.lv .view-body{display:block;overflow-y:auto}
.lv .wrap{padding:0 24px 24px;overflow-x:auto}
.lv table{width:100%;border-collapse:collapse;margin-top:16px}
.lv th{text-align:left;padding:8px 12px;color:#57606a;font-weight:500;font-size:12px;border-bottom:1px solid #d0d7de;white-space:nowrap}
.lv th.sortable{cursor:pointer;user-select:none}
.lv th.sortable:hover{color:#1f2328}
.lv th.sort-active{color:#0969da}
.lv .sort-ind{font-size:10px;margin-left:3px}
.lv td{padding:7px 12px;border-bottom:1px solid #eaeef2;vertical-align:middle}
.lv tr:hover td{background:#f6f8fa}
.lv .sid{color:#0969da;font-size:11px;font-family:monospace;text-decoration:none}
.lv .sid:hover{text-decoration:underline}
.lv .ttl{max-width:320px}
.lv .ttl-text{color:#1f2328;text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv .ttl-text:hover{color:#0969da;text-decoration:underline}
.lv .ttl-text.empty{color:#8c959f;font-style:italic}
.lv .cost{color:#1a7f37;text-align:right;white-space:nowrap}
.lv .tok{color:#57606a;text-align:right;white-space:nowrap}
.lv .num{color:#57606a;text-align:right;white-space:nowrap}
.lv .dt{color:#57606a;font-size:12px;white-space:nowrap}
.lv .proj{color:#8250df;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lv .ctx-tag{font-size:10px;color:#8c959f;margin-left:4px}
.lv .live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#2da44e;margin-right:6px;vertical-align:middle;animation:pulse 1.6s ease-in-out infinite}
.lv .live-dot.off{background:transparent;animation:none}
.lv .lmsg{text-align:center;padding:48px;color:#57606a}
.lv .err{text-align:center;padding:48px;color:#cf222e}
.lv .foot{padding:8px 24px;color:#57606a;font-size:12px;border-top:1px solid #d0d7de}
/* ── server chips: which machines the list draws from ── */
.lv .srvbar{display:flex;flex-wrap:wrap;gap:6px;padding:12px 24px 0}
.lv .chip{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #d0d7de;border-radius:999px;
  padding:3px 11px;font-family:inherit;font-size:12px;color:#8c959f;cursor:pointer}
.lv .chip:hover{border-color:#8c959f}
.lv .chip.on{background:#ddf4e4;border-color:#2da44e;color:#1f2328}
.lv .chip .cname{font-weight:600}
.lv .sdot{width:7px;height:7px;border-radius:50%;background:#2da44e;flex-shrink:0}
.lv .sdot.down{background:#cf222e}
.lv .sdot.unknown{background:#d0d7de}
.lv .srv-err{margin-top:12px;padding:6px 10px;border:1px solid #f5c2c0;background:#fff5f5;border-radius:6px;color:#cf222e;font-size:12px}
.lv .srv{color:#0969da;font-size:12px;white-space:nowrap}
.lv .srv.local{color:#8c959f}
.lv .summary{margin:16px 24px 0;border:1px solid #d0d7de;border-radius:10px;background:#f6f8fa;padding:14px 16px}
.lv .summary-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.lv .summary-head h2{font-size:13px;font-weight:600;color:#1f2328}
.lv .summary-head select{background:#fff;border:1px solid #d0d7de;color:#1f2328;padding:3px 8px;border-radius:6px;font-family:inherit;font-size:12px;cursor:pointer}
.lv .summary-head .scope-cost{margin-left:auto;font-size:14px;color:#1a7f37;font-weight:600}
.lv .sum-wrap{overflow-x:auto}
.lv .sum-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:0}
.lv .sum-table th{padding:3px 6px;font-size:10px;color:#8c959f;font-weight:500;border-bottom:1px solid #eaeef2;text-align:right;white-space:nowrap}
.lv .sum-table th:first-child{text-align:left}
.lv .sum-table td{padding:4px 6px;border-bottom:1px solid #f0f3f6;text-align:right;white-space:nowrap}
.lv .sum-table td:first-child{text-align:left;color:#1f2328}
.lv .sum-table tr:last-child td{border-bottom:none}
.lv .sum-table .c-usd{color:#1a7f37;font-weight:600}
.lv .sum-table .c-tok{color:#57606a}
.lv .sum-table .c-sub{color:#8c959f;font-size:10px;margin-left:2px}
.lv .sum-table tfoot td{border-top:1px solid #d0d7de;border-bottom:none;font-weight:600;color:#1f2328;padding-top:6px}
.lv .sum-table.prov{min-width:640px}
/* ── session view ── */
/* Which machine this session actually runs on — muted when it's this one. */
.srv-badge{flex-shrink:0;font-size:11px;font-weight:600;border-radius:5px;padding:1px 7px;background:#ddf4e4;color:#1a7f37;border:1px solid #aceebb}
.srv-badge.local{background:var(--line-soft);color:var(--ink-faint);border-color:var(--line)}
.hdr-title{font-weight:600;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;cursor:pointer;border-radius:5px;padding:1px 4px;margin:-1px -4px}
.hdr-title:hover{background:var(--line-soft)}
.hdr-title.empty{color:var(--ink-faint);font-style:italic;font-weight:400}
.hdr-title-input{font-weight:600;font-size:13px;font-family:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--accent);border-radius:6px;padding:2px 6px;flex:1;min-width:0;box-shadow:0 0 0 3px var(--accent-soft)}
.hdr-title-input:focus{outline:none}
.sv-stats{flex:0 0 auto;padding:4px 16px 5px;border-bottom:1px solid var(--line-soft);background:var(--bg)}
.hdr-proj{font-size:11px;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;display:block}
.hdr-proj b{font-weight:600;color:var(--ink)}
.hdr-stats{font-size:11px;color:var(--ink-faint);line-height:1.55;font-variant-numeric:tabular-nums;display:block}
.hdr-stats b{font-weight:600;color:var(--ink-soft)}
.hdr-stats .sub{color:var(--ink-faint)}
.subturns{font-size:0.8em;color:var(--ink-faint)}
.status-dot{width:9px;height:9px;border-radius:50%;background:var(--ink-faint);flex-shrink:0}
.status-dot.live{background:#2da44e;animation:pulse 1.6s ease-in-out infinite}
.status-dot.idle{background:#d4a72c}
.hdr-status{display:none;font-size:11px;color:#8a6d1a;margin-top:3px;font-variant-numeric:tabular-nums}
.hdr-status.show{display:block}
.hdr-status b{font-weight:600}
.query-ind{position:absolute;bottom:14px;right:16px;width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;display:none;animation:spin .7s linear infinite;pointer-events:none;z-index:5}
.query-ind.show{display:block}
@keyframes spin{to{transform:rotate(360deg)}}
.jump-marker{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;border:none;border-radius:16px;padding:5px 14px;font-size:12px;font-family:inherit;cursor:pointer;display:none;z-index:6;box-shadow:0 2px 6px rgba(0,0,0,.15)}
.jump-marker.show{display:block}
.jump-marker:hover{background:var(--accent-hover,#a84f34)}
.tr-wrap{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.transcript{flex:1;overflow-y:auto;overflow-anchor:none;padding:20px 20px;display:flex;flex-direction:column;align-items:center;gap:24px;position:relative}
.transcript>*{flex-shrink:0}
.transcript:empty::before{content:'No messages in this session.';color:var(--ink-faint);position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);pointer-events:none;font-size:14px}
.msg{display:flex;flex-direction:column;gap:6px;width:100%;max-width:740px}
.msg-body{line-height:1.7;word-break:break-word}
.msg-body p{margin-bottom:12px}.msg-body p:last-child{margin-bottom:0}
.msg-body pre{background:var(--code-bg);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:13px;line-height:1.5;margin:12px 0}
.msg-body code{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:var(--code-bg);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.msg-body pre code{background:none;border:none;padding:0}
.msg-body ul,.msg-body ol{padding-left:22px;margin-bottom:12px}.msg-body li{margin-bottom:4px}
.msg-body h1,.msg-body h2,.msg-body h3{margin:16px 0 8px;font-size:16px;font-weight:600}
.msg-body blockquote{border-left:3px solid var(--line);padding-left:14px;color:var(--ink-soft);margin:12px 0}
.msg-body a{color:var(--accent)}
.msg-body table{border-collapse:collapse;font-size:13px;margin:12px 0}
.msg-body th,.msg-body td{border:1px solid var(--line);padding:6px 10px}.msg-body th{background:var(--bg-alt)}
.msg.you{align-items:flex-end}
.msg.you .msg-label{align-self:flex-end}
.msg-label{font-size:11px;font-weight:600;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.05em}
.msg-time{text-transform:none;letter-spacing:0;font-weight:400;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.msg.you .msg-body{background:var(--bg-alt);border:1px solid var(--line);border-radius:16px 16px 4px 16px;padding:12px 16px;max-width:85%;white-space:pre-wrap}
.tool-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:13px;width:100%;max-width:740px;background:var(--surface)}
.tool-hdr{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--bg-alt);cursor:pointer;user-select:none}
.tool-hdr:hover{background:var(--line-soft)}
.tool-name{font-weight:600;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink)}
.tool-meta{margin-left:auto;display:flex;gap:8px;align-items:center}
.tool-meta .tool-status{margin-left:0}
.tool-time{font-size:11px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.tool-status{font-size:11px;margin-left:auto;padding:2px 8px;border-radius:10px;font-weight:500}
.tool-status.running{background:var(--accent-soft);color:var(--accent)}
.tool-status.done{background:var(--bg-alt);color:var(--ink-soft)}
.tool-status.error{background:#ffebe9;color:#cf222e}
.tool-toggle{font-size:10px;color:var(--ink-soft);margin-left:4px}
.tool-body{display:none;border-top:1px solid var(--line)}.tool-body.open{display:block}
.tool-input{padding:12px 14px;border-bottom:1px solid var(--line-soft)}
.tool-input pre,.tool-output pre{background:var(--code-bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:12px;overflow:auto;white-space:pre-wrap;word-break:break-all;max-height:360px;font-family:ui-monospace,Menlo,monospace}
.tool-output{padding:12px 14px}
.result-line{width:100%;max-width:740px;font-size:12px;color:var(--ink-soft);font-variant-numeric:tabular-nums;padding:4px 2px;word-break:break-word}
.result-line.hist{opacity:.65}
.result-line .rl-turn{color:var(--ink-faint);font-weight:600}
.result-line .rl-lbl{color:var(--ink-faint)}
.result-line .rl-pct{color:var(--ink-faint);font-size:10px}
.compact-marker{width:100%;max-width:740px;margin:6px 0}
.compact-line{display:flex;align-items:center;gap:10px;color:var(--ink-faint);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.compact-line::before,.compact-line::after{content:"";flex:1;height:1px;background:var(--line)}
.compact-details{margin-top:6px}
.compact-details>summary{cursor:pointer;font-size:11px;color:var(--ink-faint);text-align:center;list-style:none}
.compact-details>summary::-webkit-details-marker{display:none}
.compact-summary{margin-top:8px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:var(--bg-alt);font-size:12px;color:var(--ink-soft);white-space:pre-wrap;max-height:340px;overflow:auto}
.think-card{border:1px dashed var(--line);border-radius:12px;overflow:hidden;width:100%;max-width:740px;background:var(--bg)}
.think-hdr{display:flex;align-items:center;gap:8px;padding:8px 14px;cursor:pointer;user-select:none;color:var(--ink-soft)}
.think-hdr:hover{background:var(--bg-alt)}
.think-label{font-size:12px;font-style:italic}
.think-card .tool-toggle{margin-left:auto}
.think-body{padding:12px 14px;border-top:1px dashed var(--line);font-size:13px;line-height:1.6;color:var(--ink-soft);white-space:pre-wrap;word-break:break-word;font-style:italic}
.hist-sep{font-size:11px;color:var(--ink-faint);text-align:center;padding:4px 0;width:100%;max-width:740px;border-bottom:1px dashed var(--line);margin-bottom:4px}
.msg.hist .msg-body,.tool-card.hist,.think-card.hist{opacity:.65}
.subagent-block{border-top:1px solid var(--line);margin-top:2px}
.subagent-hdr{display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--bg-alt);cursor:pointer;user-select:none;font-size:12px;font-weight:600;color:var(--ink-soft)}
.subagent-hdr:hover{background:var(--line-soft)}
.subagent-toggle{font-size:10px;color:var(--ink-soft)}
.subagent-body{padding:10px 12px;border-left:2px solid var(--accent);margin:8px 0 8px 12px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.subagent-body>*{max-width:100%}
.subagent-loading{font-size:12px;color:var(--ink-faint);font-style:italic}
.perm-card{border:1px solid var(--accent);border-radius:12px;overflow:hidden;width:100%;max-width:740px}
.perm-hdr{padding:11px 16px;background:var(--accent-soft);border-bottom:1px solid var(--accent);font-size:13px;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:6px}
.perm-body{padding:12px 16px;background:var(--surface);font-size:14px;color:var(--ink)}
.perm-acts{padding:12px 16px;background:var(--bg-alt);border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px}
.perm-opt{background:var(--surface);border:1px solid var(--line);color:var(--ink);padding:6px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;text-align:left}
.perm-opt:hover{border-color:var(--accent);background:var(--accent-soft)}
.perm-opt.first{background:var(--accent);border-color:var(--accent);color:#fff}
.perm-opt.first:hover{background:var(--accent-hover,#a84f34)}
.perm-note{font-size:12px;color:var(--ink-faint);padding:0 16px 12px;background:var(--bg-alt)}
.perm-opt:disabled{opacity:.45;cursor:default}
.perm-opt:disabled:hover{border-color:var(--line);background:var(--surface)}
.ask-multi{color:var(--ink-faint);font-size:12px}
.ask-opt.sel{background:var(--accent);border-color:var(--accent);color:#fff}
.ask-opt.sel:hover{background:var(--accent-hover,#a84f34)}
.ask-card .ask-q{border-top:none;padding-bottom:6px}
.ask-custom{padding:0 16px 10px;background:var(--bg-alt)}
.ask-text{width:100%;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--ink)}
.ask-text:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.ask-foot{justify-content:flex-end;border-top:1px solid var(--line)}
.ask-submit{background:var(--accent);border:none;color:#fff;padding:7px 18px;border-radius:8px;font-size:13px;font-family:inherit;cursor:pointer;font-weight:600}
.ask-submit:disabled{opacity:.45;cursor:default}
.ask-submit:hover:not(:disabled){background:var(--accent-hover,#a84f34)}
.ask-card .tool-output{padding:0 16px 12px;background:var(--bg-alt)}
.ask-card .tool-output:empty{display:none}
.ask-card .tool-output pre{background:var(--code-bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;font-size:12px;white-space:pre-wrap;word-break:break-word;margin:0}
/* Sized against the VIEW, not the viewport: with views stacked, 45vh was nearly a whole
   view, so output squeezed the transcript to nothing and pushed the composer off-screen.
   45% of the body leaves both. position/z-index put it above .tr-wrap and .transcript,
   which are position:relative and so would otherwise paint over this box's own header. */
.cmd-box{flex:0 1 auto;min-height:0;max-height:45%;position:relative;z-index:1;
  border-top:1px solid var(--line);background:var(--bg);display:none;flex-direction:column}
.cmd-box.show{display:flex}
/* Maximized: leave the flex flow and cover the whole window. //cat and //ll output is
   the thing you want to read, and inside one column of a split view there is no room. */
.cmd-box.max{position:fixed;inset:0;max-height:none;z-index:50;border-top:none}
.cmd-box.min{flex:0 0 auto}
/* Title bar in the same idiom as .view-bar, so output reads as its own pane rather than
   a slab wedged into the transcript. The dot marks it as command output. */
.cmd-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 10px 6px 14px;
  background:var(--bg-alt);border-bottom:1px solid var(--line);min-height:34px;font-size:12px;color:var(--ink-soft)}
.cmd-head::before{content:'';flex-shrink:0;width:8px;height:8px;border-radius:50%;background:var(--accent);opacity:.75}
.cmd-title{font-family:ui-monospace,Menlo,monospace;font-weight:600;color:var(--ink);
  flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-btns{margin-left:auto;display:flex;gap:2px;flex-shrink:0}
.cmd-btn{background:none;border:none;color:var(--ink-soft);font-size:14px;cursor:pointer;line-height:1;padding:4px 8px;border-radius:6px;font-family:inherit}
.cmd-btn:hover{background:var(--line);color:var(--ink)}
.cmd-content{overflow:auto;padding:14px 20px;flex:1 1 auto;min-height:0}
.cmd-box.min .cmd-content{display:none}
.cmd-content pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;font-size:12.5px;line-height:1.5;overflow:auto;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.cmd-content.code pre,.cmd-content.md pre{white-space:pre;word-break:normal}
.cmd-content.md{font-size:14px;line-height:1.6}
.cmd-content code.hljs{background:none;padding:0;font-family:inherit}
.cmd-content.diff .hljs-addition{background:#e6ffec;color:#1a7f37;display:inline-block;width:100%}
.cmd-content.diff .hljs-deletion{background:#ffebe9;color:#cf222e;display:inline-block;width:100%}
.input-area{border-top:1px solid var(--line);padding:10px 16px;background:var(--bg);flex-shrink:0;display:flex;flex-direction:column;align-items:center}
.input-inner{width:100%;max-width:740px}
.input-row{display:flex;gap:8px;align-items:flex-end;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:6px 6px 6px 14px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.input-row:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.input-box{flex:1;border:none;background:none;padding:4px 0;font-size:14px;font-family:inherit;resize:none;min-height:28px;max-height:200px;line-height:1.5;overflow-y:auto;color:var(--ink)}
.input-box:focus{outline:none}
.send-btn{background:var(--accent);border:none;color:#fff;width:30px;height:30px;border-radius:9px;font-size:15px;cursor:pointer;font-family:inherit;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.send-btn:hover:not(:disabled){background:var(--accent-hover,#a84f34)}
.send-btn:disabled{opacity:.4;cursor:default}
/* toast (replaces alert(): alerts block browser automation and yank focus) */
#toast{position:fixed;bottom:18px;right:18px;background:#3d3d3a;color:#fff;border-radius:10px;padding:10px 16px;font-size:13px;z-index:99;display:none;max-width:420px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
</style>
</head>
<body>
<div id="views"></div>
<div id="toast"></div>
<script>
__APP_JS__
</script>
</body>
</html>`;

const APP_JS = `
var PRICE_TABLE = __PRICING__;
var SELF = __SELF__;             // this server's identity: {name, hostname}
var INIT_OPEN = __INIT_OPEN__;   // {sessionId, server} to open on load (deep link), or null

// ── multi-server addressing ───────────────────────────────────────────────────
// Every session belongs to a server. Local sessions live under /api/…; a peer's live
// under /peer/<name>/api/… — the SAME routes behind a prefix, so one apiBase() call
// per view is the whole difference between driving a local and a remote session.
function isLocal(server){ return !server || server === SELF.name; }
function apiBase(server){ return isLocal(server) ? '' : '/peer/'+encodeURIComponent(server); }
function sessionHref(sid, server){ return apiBase(server)+'/session/'+sid; }
function parseSessionHref(href){
  var m = href.match(/^\\/peer\\/([^/]+)\\/session\\/([^/?#]+)/);
  if (m) return { server: decodeURIComponent(m[1]), sessionId: m[2] };
  m = href.match(/^\\/session\\/([^/?#]+)/);
  return m ? { server: null, sessionId: m[1] } : null;
}

// ── shared helpers ────────────────────────────────────────────────────────────
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function trunc(s,n){ s=String(s||''); return s.length>n?s.slice(0,n-1)+'…':s; }
function fc(c){ return c!=null?'$'+(+c).toFixed(2):'—'; }
function ft(t){ return t!=null?Number(t).toLocaleString():'—'; }
function fd(iso){ if(!iso)return '—'; try{ return new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){ return iso.slice(0,16); } }
function fmtMonth(mk){ var p=mk.split('-'), names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return (names[+p[1]-1]||mk)+' '+p[0]; }
function fmtTokK(t){ t=t||0; if(t>=1e9)return (t/1e9).toFixed(1)+'B'; if(t>=1e6)return (t/1e6).toFixed(1)+'M'; if(t>=1e3)return (t/1e3).toFixed(1)+'K'; return String(t); }
function fmtTokShort(n){ n=n||0; if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1)+'M'; if(n>=1e3)return (n/1e3).toFixed(n>=1e4?0:1)+'K'; return String(n); }
function fmtCost(c){ return '$'+(c||0).toFixed(2); }
function fmtDur(ms){ if(ms==null||!isFinite(ms)||ms<0)return ''; if(ms<1000)return Math.round(ms)+'ms'; var s=ms/1000; if(s<60)return (s<10?s.toFixed(1):String(Math.round(s)))+'s'; var m=Math.floor(s/60); if(m<60)return m+'m '+Math.round(s%60)+'s'; var h=Math.floor(m/60); if(h<24)return h+'h '+(m%60)+'m'; return Math.floor(h/24)+'d '+(h%24)+'h'; }
function fmtPct(part,whole){ return (whole>0?(100*part/whole):0).toFixed(1)+'%'; }
function fmtStatDate(iso){ return fd(iso); }
function prettyModel(m){ m=String(m||''); if(!m||m==='unknown')return 'Unknown'; var x=m.replace(/^claude-/,'').replace(/-\\d{6,}$/,''); var parts=x.split('-'); var name=(parts.shift()||''); name=name.charAt(0).toUpperCase()+name.slice(1); var ver=parts.join('.'); return ver?name+' '+ver:name; }
function normId(m){ m=String(m||'').toLowerCase().replace(/^\\s+|\\s+$/g,'');
  m=m.replace(/^(us|eu|apac|au|global)\\./,'').replace(/^(anthropic|bedrock)[./]/,'').replace(/[:-]v\\d+(:\\d+)?$/,'');
  return m; }
function priceFor(model){
  var t=PRICE_TABLE||{}, byId=t.byId||{}, tiers=t.tiers||{}, id=normId(model);
  if(byId[id])return byId[id];
  var trimmed=id.replace(/-\\d{6,}$/,''); if(trimmed!==id&&byId[trimmed])return byId[trimmed];
  if(id.indexOf('opus')!==-1)return tiers.opus;
  if(id.indexOf('haiku')!==-1)return tiers.haiku;
  if(id.indexOf('sonnet')!==-1)return tiers.sonnet;
  return t.default||tiers.sonnet;
}
var toastTimer;
function toast(msg){
  var t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(function(){ t.style.display = 'none'; }, 4000);
}
function autoGrow(el){ el.style.height='auto'; el.style.height=Math.min(200, Math.max(28, el.scrollHeight))+'px'; }
function toggleTool(hdr) {
  var body = hdr.nextElementSibling, toggle = hdr.querySelector('.tool-toggle');
  var open = body.classList.toggle('open');
  if (toggle) toggle.innerHTML = open?'&#9660;':'&#9654;';
}

// ── view stack manager ────────────────────────────────────────────────────────
// views[0] is always the session list. A view object:
//   { kind:'list'|'session', sessionId?, el, barEl, maxed, unseen, refresh(), destroy?() }
var views = [];
var viewsEl = document.getElementById('views');
var orientation = 'vertical';   // 'vertical' (stacked) or 'horizontal' (columns)
function toggleOrientation(){
  orientation = orientation === 'vertical' ? 'horizontal' : 'vertical';
  viewsEl.classList.toggle('horizontal', orientation === 'horizontal');
  relayout();
}
function relayout(){
  // Folding the ONLY view would leave a bar over a blank page with nothing to reveal —
  // so a lone view is never folded, and closing the last session unfolds the list again.
  if (views.length < 2) views.forEach(function(v){ v.folded = false; });
  var maxed = null;
  for (var i=0;i<views.length;i++) if (views[i].maxed) maxed = views[i];
  views.forEach(function(v){
    // Two independent reasons to collapse: someone else is maximized, or this view was
    // folded away by hand. Maximize wins while it lasts; folding outlives it.
    var collapsed = maxed ? v !== maxed : !!v.folded;
    var was = v.el.classList.contains('collapsed');
    v.el.classList.toggle('collapsed', collapsed);
    // Folded = deliberately stowed, so the bar strips down to its chevron. Dimmed = pushed
    // aside by someone else's maximize, so the bar keeps its title (that's how you get
    // back) but recedes. The two are different states and must look different.
    v.el.classList.toggle('folded', !!v.folded);
    v.el.classList.toggle('dimmed', !!(maxed && v !== maxed));
    var mx = v.barEl.querySelector('[data-act="max"]');
    if (mx) { mx.innerHTML = v.maxed ? '&#10064;' : '&#9633;'; mx.title = v.maxed ? 'Normal (equal heights)' : 'Maximize'; }
    if (v.onFold) v.onFold();   // several paths clear .folded; sync the chevron from one place
    // A view that just became visible while following its bottom counts as seen.
    if (was && !collapsed && v.onExpanded) v.onExpanded();
    var ob = v.barEl && v.barEl.querySelector('[data-act="orient"]');
    if (ob) {
      ob.innerHTML = orientation === 'horizontal' ? '&#9636;' : '&#9637;';
      ob.title = orientation === 'horizontal' ? 'Stack vertically' : 'Stack horizontally';
    }
  });
  // Horizontal grid sizing: expanded views share the row; collapsed ones — maximized-away
  // or folded — shrink to fit their clamped header. A maxed view's body spans the row.
  //
  // Every bar and body is pinned to its own column EXPLICITLY. A collapsed view's body is
  // display:none, so it is not a grid item at all — leaving placement to the grid would
  // shift every later body one column left of its own header, which is exactly what a
  // folded list did: session 1's body landed under the list's header and the last column
  // went blank. Maximize hid that bug because it hides every other body too.
  if (orientation === 'horizontal') {
    viewsEl.style.gridTemplateColumns = views.map(function(v){
      return (maxed ? v === maxed : !v.folded) ? '1fr' : 'auto';
    }).join(' ');
    views.forEach(function(v, i){
      v.barEl.style.gridColumn = String(i + 1);
      v.bodyEl.style.gridColumn = (maxed && v === maxed) ? '1 / -1' : String(i + 1);
    });
  } else {
    viewsEl.style.gridTemplateColumns = '';
    views.forEach(function(v){ v.barEl.style.gridColumn = ''; v.bodyEl.style.gridColumn = ''; });
  }
}
function toggleMax(v){
  if (v.maxed) { v.maxed = false; }
  else { views.forEach(function(o){ o.maxed = false; }); v.maxed = true; v.folded = false; }
  relayout();
}
// Fold a view away to just its bar, leaving every other view expanded — the opposite
// gesture to maximize, and the only way to get the session list out of the way without
// maximizing something else.
function toggleFold(v){
  v.folded = !v.folded;
  if (v.folded) v.maxed = false;
  relayout();
}
function closeView(v){
  var idx = views.indexOf(v);
  if (idx <= 0) return;   // list view (idx 0) is not closable
  if (v.destroy) v.destroy();
  viewsEl.removeChild(v.el);
  views.splice(idx, 1);
  relayout();
}
function setUnseen(v, on){
  if (v.unseen === on) return;
  v.unseen = on;
  v.el.classList.toggle('unseen', on);
}
// Build a view's title bar. buttons: {close:bool}. barMain is an element.
function makeViewBar(v, barMain, buttons){
  var bar = document.createElement('div');
  bar.className = 'view-bar';
  var ind = document.createElement('span');
  ind.className = 'unseen-ind'; ind.textContent = '● new';
  bar.appendChild(ind);
  barMain.classList.add('bar-main');
  bar.appendChild(barMain);
  var btns = document.createElement('div');
  btns.className = 'bar-btns';
  btns.innerHTML = '<button class="vb-btn" data-act="refresh" title="Refresh">&#8635;</button>'+
    '<button class="vb-btn" data-act="max" title="Maximize">&#9633;</button>'+
    (buttons && buttons.orient ? '<button class="vb-btn" data-act="orient" title="Stack horizontally">&#9637;</button>' : '')+
    (buttons && buttons.close ? '<button class="vb-btn" data-act="close" title="Close">&#10005;</button>' : '');
  bar.appendChild(btns);
  bar.addEventListener('click', function(e){
    var b = e.target.closest('.vb-btn');
    if (b) {
      e.stopPropagation();
      if (b.dataset.act === 'refresh') v.refresh();
      else if (b.dataset.act === 'max') toggleMax(v);
      else if (b.dataset.act === 'orient') toggleOrientation();
      else if (b.dataset.act === 'close') closeView(v);
      return;
    }
    // Tapping a collapsed view's bar reveals it (and its unviewed updates). Collapsed
    // because something ELSE is maximized → take the maximize, as before. Collapsed
    // because it was folded → just unfold, back to an equal share.
    if (v.el.classList.contains('collapsed')) {
      if (views.some(function(o){ return o.maxed && o !== v; })) toggleMax(v);
      else if (v.folded) toggleFold(v);
    }
  });
  v.barEl = bar;
  return bar;
}
function openSession(sid, server){
  // A session is identified by (server, id): the same id could exist on two machines,
  // and two views of "the same" id on different servers are two different sessions.
  var srv = isLocal(server) ? null : server;
  for (var i=0;i<views.length;i++) {
    if (views[i].kind === 'session' && views[i].sessionId === sid && (views[i].server||null) === srv) {
      if (!views[i].maxed) toggleMax(views[i]);
      return;
    }
  }
  fetch(apiBase(srv)+'/api/session-info/'+sid).then(function(r){ return r.json(); }).then(function(d){
    var info = { sessionId: sid, server: srv, title: (d&&d.title)||'', projectPath: (d&&d.projectPath)||'',
                 live: !!(d&&d.live), liveStatus: (d&&d.liveStatus)||null, liveStatusAt: (d&&d.liveStatusAt)||null,
                 stats: (d&&d.stats)||null };
    var v = createSessionView(info);
    views.push(v);
    viewsEl.appendChild(v.el);
    relayout();
    setTimeout(function(){ v.barEl.scrollIntoView({block:'nearest'}); }, 0);
  }).catch(function(e){ toast('Failed to open session: '+e); });
}

// ── list view ─────────────────────────────────────────────────────────────────
function createListView(){
  var v = { kind:'list', maxed:false, unseen:false };
  var el = document.createElement('div');
  el.className = 'view lv';
  var barMain = document.createElement('span');
  barMain.className = 'bar-name';
  barMain.innerHTML = '<span class="fold-btn" id="foldBtn" title="Hide the session list">&#9662;</span>'+
    '<span class="bar-title" id="barTitle"></span><span class="bar-refreshed" id="refreshed"></span>';
  barMain.querySelector('#barTitle').textContent = 'ccbb — ' + SELF.name;
  el.appendChild(makeViewBar(v, barMain, { close:false, orient:true }));
  var refreshedEl = barMain.querySelector('#refreshed');
  // The chevron reflects THIS view's fold, not whether it happens to be collapsed —
  // a list hidden because a session is maximized still shows itself as unfolded.
  var foldEl = barMain.querySelector('#foldBtn');
  v.onFold = function(){
    // With nothing else open there is nowhere for the list to get out of the way TO,
    // so the control isn't offered at all.
    foldEl.style.display = views.length < 2 ? 'none' : '';
    foldEl.innerHTML = v.folded ? '&#9656;' : '&#9662;';
    foldEl.title = v.folded ? 'Show the session list' : 'Hide the session list';
  };
  foldEl.addEventListener('click', function(e){ e.stopPropagation(); toggleFold(v); });
  var body = document.createElement('div');
  body.className = 'view-body';
  body.innerHTML =
    '<div class="srvbar" id="srvbar"></div>'+
    '<div class="summary" id="summary" style="display:none">'+
      '<div class="summary-head"><h2>Cost summary</h2>'+
      '<select id="sumScope"></select><span class="scope-cost" id="sumScopeCost"></span></div>'+
      '<div id="sumProvider" class="sum-wrap"></div></div>'+
    '<div class="wrap"><div id="out" class="lmsg">Loading…</div></div>'+
    '<div class="foot" id="foot"></div>';
  el.appendChild(body);
  v.el = el;
  v.bodyEl = body;

  var sessions = [], totals = {}, costSummary = null;
  var servers = [{ name: SELF.name, self: true, status: 'up' }];
  var loadErrors = [];     // per-server load failures, shown inline instead of blanking the list
  var sortStack = [{col:'lastActivity', dir:'desc'}];
  var COL_DEFAULTS = { live:'desc', title:'asc', startedAt:'desc', totalCost:'desc', server:'asc',
    totalTokens:'desc', turns:'desc', context:'desc', lastActivity:'desc', projectPath:'asc' };

  // ── server selection ──
  // Which servers the list draws from. Persisted, so a reload keeps your working set.
  // A name that's no longer configured is dropped on load; a newly-configured server
  // starts selected, so adding a peer to the config just makes its sessions appear.
  var selected = null;
  try { var raw = localStorage.getItem('ccbb.servers'); if (raw) selected = JSON.parse(raw); } catch(e) {}
  if (!Array.isArray(selected)) selected = null;
  function saveSelection(){ try { localStorage.setItem('ccbb.servers', JSON.stringify(selected)); } catch(e) {} }
  function knownNames(){ return servers.map(function(s){ return s.name; }); }
  function selectedServers(){
    var known = knownNames();
    if (!selected) return known;
    var keep = selected.filter(function(n){ return known.indexOf(n) !== -1; });
    // Everything deselected would show an empty page with no way back; fall back to all.
    return keep.length ? keep : known;
  }
  function isSelected(name){ return selectedServers().indexOf(name) !== -1; }
  function toggleServer(name){
    var cur = selectedServers().slice();
    var i = cur.indexOf(name);
    if (i === -1) cur.push(name); else cur.splice(i, 1);
    selected = cur; saveSelection();
    renderServers(); load();
  }
  function renderServers(){
    var bar = body.querySelector('#srvbar');
    // With no peers configured there is nothing to filter — stay out of the way.
    if (servers.length < 2) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.innerHTML = servers.map(function(s){
      var on = isSelected(s.name);
      var tip = s.name + (s.self ? ' (this server)' : '')
        + (s.inbound ? ' — linked in (reached over its own connection)' : '')
        + (s.status === 'down' ? ' — offline: ' + (s.error||'unreachable') : '')
        + (s.rttMs != null && s.status === 'up' ? ' — ' + s.rttMs + 'ms' : '');
      return '<button class="chip'+(on?' on':'')+'" data-srv="'+esc(s.name)+'" title="'+esc(tip)+'">'
        + '<span class="sdot '+esc(s.status||'unknown')+'"></span>'
        + '<span class="cname">'+esc(s.name)+'</span>'
        + '</button>';
    }).join('');
  }
  async function loadServers(){
    try {
      var r = await fetch('/api/servers');
      var d = await r.json();
      if (d && Array.isArray(d.servers)) { servers = d.servers; renderServers(); }
    } catch(e) {}
  }

  function clickHeader(col, shift) {
    var idx = sortStack.findIndex(function(e){ return e.col === col; });
    if (shift) {
      if (idx >= 0) sortStack[idx].dir = sortStack[idx].dir === 'asc' ? 'desc' : 'asc';
      else sortStack.push({col: col, dir: COL_DEFAULTS[col] || 'asc'});
    } else {
      if (idx === 0) { sortStack[0].dir = sortStack[0].dir === 'asc' ? 'desc' : 'asc'; sortStack = [sortStack[0]]; }
      else if (idx > 0) { sortStack = [sortStack.splice(idx, 1)[0]]; }
      else sortStack = [{col: col, dir: COL_DEFAULTS[col] || 'asc'}];
    }
    render();
  }
  function ctxTokens(s){ return s.context ? s.context.tokens : 0; }
  function applySort(arr) {
    return arr.slice().sort(function(a, b) {
      for (var i = 0; i < sortStack.length; i++) {
        var col = sortStack[i].col, dir = sortStack[i].dir, cc = 0;
        var va = col === 'context' ? ctxTokens(a) : a[col];
        var vb = col === 'context' ? ctxTokens(b) : b[col];
        if (va == null && vb == null) continue;
        if (va == null) cc = 1;
        else if (vb == null) cc = -1;
        else if (typeof va === 'number' || typeof vb === 'number') cc = (va || 0) - (vb || 0);
        else cc = String(va).toLowerCase() < String(vb).toLowerCase() ? -1 : String(va).toLowerCase() > String(vb).toLowerCase() ? 1 : 0;
        if (cc !== 0) return dir === 'asc' ? cc : -cc;
      }
      return 0;
    });
  }
  // ── loading ──
  // The list fans out: one request per selected server, in parallel, through the proxy.
  // A server that fails contributes an error line rather than blanking the whole list —
  // one dead ssh tunnel must not hide the sessions on every other machine.
  //
  // The quiet flag is set by the auto-refresh so it never flashes "Loading…" over a table you
  // are reading; the rendered rows are simply replaced when the new data lands.
  function load(quiet) { return loadSummary(!!quiet); }
  async function fanOut(path) {
    var names = selectedServers();
    var got = await Promise.all(names.map(function(name){
      return fetch(apiBase(name) + path)
        .then(function(r){ return r.json().then(function(d){
          if (!r.ok) throw new Error((d && d.error) || r.statusText);
          return { name: name, data: d };
        }); })
        .catch(function(e){ return { name: name, error: e.message || String(e) }; });
    }));
    return got;
  }
  // Add every numeric leaf of b into a, recursively. The cost-summary buckets are
  // uniform numeric trees (months → buckets → categories), so this merges N servers'
  // summaries into one without knowing the shape.
  function deepAdd(a, b){
    if (b == null) return a;
    if (a == null) return JSON.parse(JSON.stringify(b));
    if (typeof a === 'number') return a + (typeof b === 'number' ? b : 0);
    if (typeof a !== 'object' || typeof b !== 'object') return a;
    for (var k in b) a[k] = deepAdd(a[k], b[k]);
    return a;
  }
  async function loadSessions(month, quiet) {
    var out = body.querySelector('#out');
    if (!quiet) { out.className = 'lmsg'; out.textContent = 'Loading…'; body.querySelector('#foot').textContent = ''; }
    var results = await fanOut('/api/sessions' + (month ? '?month=' + encodeURIComponent(month) : ''));
    var rows = [], tot = { totalCost: 0, totalTokens: 0 }, errs = [];
    results.forEach(function(r){
      if (r.error) { errs.push({ server: r.name, error: r.error }); return; }
      var d = r.data || {};
      (d.sessions || []).forEach(function(s){ s.server = r.name; rows.push(s); });
      if (d.totals) { tot.totalCost += d.totals.totalCost || 0; tot.totalTokens += d.totals.totalTokens || 0; }
    });
    sessions = rows; totals = tot; loadErrors = errs;
    render();
    stampRefreshed();
  }
  async function loadSummary(quiet) {
    var results = await fanOut('/api/cost-summary');
    var merged = null;
    results.forEach(function(r){ if (!r.error) merged = deepAdd(merged, r.data); });
    if (merged) {
      costSummary = merged; buildScopeOptions(); renderSummary();
      body.querySelector('#summary').style.display = '';
    } else { body.querySelector('#summary').style.display = 'none'; }
    // Drive the list from the selected scope (default: latest month). On summary failure
    // the selector is empty, so this falls back to the all-time list.
    var sel = body.querySelector('#sumScope');
    var val = sel ? sel.value : '';
    return loadSessions(val && val.indexOf('m:') === 0 ? val.slice(2) : null, quiet);
  }
  function stampRefreshed(){
    refreshedEl.textContent = 'Refreshed ' + new Date().toLocaleTimeString();
  }
  var PROV_LABEL = { bedrock:'Bedrock', anthropic:'Sub' };
  function gsub(s){ return '<span class="c-sub">'+s+'</span>'; }
  function buildScopeOptions() {
    var sel = body.querySelector('#sumScope');
    var prev = sel.value;
    var months = Object.keys(costSummary.months || {}).sort().reverse();
    var opts = ['<option value="all">All time</option>'];
    opts = opts.concat(months.map(function(mk){ return '<option value="m:'+mk+'">'+fmtMonth(mk)+'</option>'; }));
    sel.innerHTML = opts.join('');
    sel.value = (prev && sel.querySelector('option[value="'+prev+'"]')) ? prev
      : (months.length ? 'm:'+months[0] : 'all');
  }
  function onScopeChange() {
    renderSummary();
    var val = body.querySelector('#sumScope').value;
    loadSessions(val && val.indexOf('m:') === 0 ? val.slice(2) : null);
  }
  function currentScope() {
    var val = body.querySelector('#sumScope').value;
    if (val === 'all' || !val) return costSummary.overall;
    return costSummary.months[val.slice(2)] || costSummary.overall;
  }
  function catCell(cat, totCost){
    if (!cat || !cat.tokens) return '<td class="c-tok">—</td>';
    var pct = totCost > 0 ? (cat.cost/totCost*100).toFixed(1) : '0.0';
    return '<td class="c-tok">'+fmtTokK(cat.tokens)+' '+gsub(pct+'%')+'</td>';
  }
  // Avg response time + output tokens/sec for a bucket, e.g. "17s 49.0/s". Derived from the
  // bucket's summed respMs/respOut, so it stays correct for merged rows (Total).
  function respRateHtml(b){
    if (!b || !b.respCount || !(b.respMs > 0)) return '<td class="c-tok">—</td>';
    return '<td class="c-tok">'+fmtDur(b.respMs/b.respCount)+
      ' <span class="c-sub">'+(b.respOut/(b.respMs/1000)).toFixed(1)+'/s</span></td>';
  }
  function provRowHtml(label, b){
    var c = b.categories;
    var rowCost = b.cost;
    var turns = (b.turns||0) + (b.subTurns ? ' '+gsub('+'+b.subTurns) : '');
    return '<tr><td>'+esc(label)+'</td>'
      + '<td class="c-usd">'+fc(b.cost)+'</td>'
      + '<td class="c-tok">'+fmtTokK(b.tokens)+'</td>'
      + '<td class="c-tok">'+turns+'</td>'
      + catCell(c.cacheRead, rowCost)
      + catCell(c.cacheWrite, rowCost)
      + catCell(c.cacheMiss, rowCost)
      + catCell(c.output, rowCost)
      + catCell(c.input, rowCost)
      + respRateHtml(b)
      + '</tr>';
  }
  function providerTableHtml(scope){
    var map = scope.byProvider || {};
    var keys = Object.keys(map).filter(function(k){ return map[k].tokens > 0; });
    if (!keys.length) return '<div style="color:#8c959f;font-size:11px">No usage.</div>';
    keys.sort(function(a,b){ return map[b].cost - map[a].cost; });
    var tbody = keys.map(function(k){ return provRowHtml(PROV_LABEL[k]||k, map[k]); }).join('');
    var tfoot = keys.length > 1 ? '<tfoot>'+provRowHtml('Total', scope.all)+'</tfoot>' : '';
    var thead = '<thead><tr><th>&nbsp;</th><th>USD</th><th>Tokens</th><th>Turns</th>'
      + '<th>Cache Read</th><th>Cache Write</th><th>Cache Miss</th><th>Out</th><th>In</th><th>Time</th></tr></thead>';
    return '<table class="sum-table prov">'+thead+'<tbody>'+tbody+'</tbody>'+tfoot+'</table>';
  }
  function renderSummary() {
    if (!costSummary) return;
    var scope = currentScope();
    body.querySelector('#sumScopeCost').textContent = fc(scope.all.cost);
    body.querySelector('#sumProvider').innerHTML = providerTableHtml(scope);
  }
  function thSort(label, col, style) {
    var entry = sortStack.find(function(e){ return e.col === col; });
    var cls = 'sortable' + (entry ? ' sort-active' : '');
    var ind = entry ? '<span class="sort-ind">'+(entry.dir==='asc'?'▲':'▼')+'</span>' : '';
    var st = style ? ' style="'+style+'"' : '';
    return '<th class="'+cls+'" data-col="'+col+'"'+st+'>'+label+ind+'</th>';
  }
  // The Server column only earns its width once there IS more than one server —
  // a single-host install would just repeat its own name down every row.
  function multiServer(){ return servers.length > 1; }
  function rowHtml(s) {
    var sid = s.sessionId, sh = sid.slice(0,8);
    var href = sessionHref(sid, s.server);
    var titleHtml = s.title
      ? '<a class="ttl-text" href="'+href+'" title="'+esc(s.title)+'">'+esc(trunc(s.title,44))+'</a>'
      : '<a class="ttl-text empty" href="'+href+'">(no title)</a>';
    var ctx = s.context, cmax = s.contextMax;
    var ctxHtml = ctx
      ? (ctx.postCompact?'~':'')+fmtTokK(ctx.tokens)
        +(cmax && fmtTokK(cmax.tokens)!==fmtTokK(ctx.tokens)?'<span class="ctx-tag">'+fmtTokK(cmax.tokens)+'</span>':'')
        +'<span class="ctx-tag">'+fc(ctx.cost)+'</span>'
      : '—';
    var sub = s.subTurns ? '<span class="ctx-tag">+'+s.subTurns+'</span>' : '';
    return '<tr>'
      + '<td>'+(s.live?'<span class="live-dot" title="Active"></span>':'<span class="live-dot off"></span>')+'</td>'
      + (multiServer() ? '<td class="srv'+(isLocal(s.server)?' local':'')+'">'+esc(s.server||SELF.name)+'</td>' : '')
      + '<td><a class="sid" href="'+href+'">'+sh+'</a></td>'
      + '<td class="ttl">'+titleHtml+'</td>'
      + '<td class="cost">'+fc(s.totalCost)+'</td>'
      + '<td class="tok">'+ft(s.totalTokens)+'</td>'
      + '<td class="num">'+(s.turns||0)+sub+'</td>'
      + '<td class="num">'+ctxHtml+'</td>'
      + '<td class="dt">'+fd(s.lastActivity)+'</td>'
      + '<td class="dt">'+fd(s.startedAt)+'</td>'
      + '<td class="proj" title="'+esc(s.projectPath||'')+'">'+esc(trunc(s.projectPath||'',30))+'</td>'
      + '</tr>';
  }
  function render() {
    var rows = applySort(sessions);
    var out = body.querySelector('#out');
    // Unreachable servers are reported above the table, never instead of it: the
    // sessions that DID load stay usable while one peer's tunnel is down.
    var errHtml = loadErrors.map(function(e){
      return '<div class="srv-err">'+esc(e.server)+': '+esc(e.error)+'</div>';
    }).join('');
    if (!rows.length) {
      out.className = ''; out.innerHTML = errHtml + '<div class="lmsg">No sessions found.</div>';
      body.querySelector('#foot').textContent = '';
      return;
    }
    var html = errHtml + '<table><thead><tr>'
      + thSort('','live','width:1%') + (multiServer() ? thSort('Server','server') : '')
      + '<th>ID</th>' + thSort('Title','title')
      + thSort('Cost','totalCost','text-align:right')
      + thSort('Tokens','totalTokens','text-align:right')
      + thSort('Turns','turns','text-align:right')
      + thSort('Context','context','text-align:right')
      + thSort('Last activity','lastActivity')
      + thSort('Started','startedAt')
      + thSort('Project','projectPath')
      + '</tr></thead><tbody>' + rows.map(rowHtml).join('') + '</tbody></table>';
    out.className = ''; out.innerHTML = html;
    var tc = totals.totalCost != null, tt = totals.totalTokens != null;
    body.querySelector('#foot').textContent = (tc||tt)
      ? 'Total: '+(tc?fc(totals.totalCost):'')+(tc&&tt?' | ':'')+(tt?ft(totals.totalTokens)+' tokens':'') : '';
  }
  body.addEventListener('click', function(e) {
    var chip = e.target.closest('.chip[data-srv]');
    if (chip) { toggleServer(chip.dataset.srv); return; }
    // Session links open a stacked view instead of navigating (middle-click still works).
    var a = e.target.closest('a[href*="/session/"]');
    if (a) {
      var ref = parseSessionHref(a.getAttribute('href'));
      if (ref) { e.preventDefault(); openSession(ref.sessionId, ref.server); return; }
    }
    var th = e.target.closest('th[data-col]');
    if (th) clickHeader(th.dataset.col, e.shiftKey);
  });
  body.querySelector('#sumScope').addEventListener('change', onScopeChange);

  // The server list must land BEFORE the first fan-out: until it does, the only known
  // server is this one, so a saved selection naming a peer would filter down to nothing
  // and fall back to local-only — a first paint that silently drops every remote session.
  function cycle(quiet){ return loadServers().then(function(){ return load(quiet); }); }

  // Auto-refresh. Skipped while the tab is hidden or the view is collapsed to its bar —
  // no point polling several machines for a table nobody is looking at.
  var autoTimer = setInterval(function(){
    if (document.hidden || v.el.classList.contains('collapsed')) return;
    cycle(true);
  }, 10000);
  v.destroy = function(){ clearInterval(autoTimer); };

  v.refresh = function(){ return cycle(false); };
  renderServers();
  cycle(false);
  return v;
}

// ── session view ──────────────────────────────────────────────────────────────
// One view per session: its own DOM, WebSocket, timers, and scroll state, all held
// in this closure. destroy() tears everything down when the view closes.

// The composer keeps no hint line under it — the keys live in the send button's tooltip
// instead, so the transcript gets the space back.
var SEND_TIP = 'Send  ·  Ctrl+Enter  ·  Enter inserts a newline  ·  //help for commands';
var SEND_TIP_OFF = 'Session not running in a tmux pane here — input disabled. // commands still work.';

function createSessionView(INFO){
  var v = { kind:'session', sessionId: INFO.sessionId, server: INFO.server || null, maxed:false, unseen:false };
  // Everything this view touches — history, liveness, keystroke injection, permission
  // answers, //commands, rename, the WebSocket — hangs off this one prefix. A remote
  // session is therefore driven by exactly the local code path, on the peer's host.
  var API = apiBase(INFO.server);
  var SRV = INFO.server || SELF.name;
  var el = document.createElement('div');
  el.className = 'view sv';
  v.el = el;

  // — bar: status dot + originating server + renamable title —
  var barMain = document.createElement('div');
  barMain.style.cssText = 'display:flex;align-items:center;gap:10px;flex:1;min-width:0';
  barMain.innerHTML = '<div class="status-dot"></div>'
    + '<span class="srv-badge'+(isLocal(INFO.server)?' local':'')+'" title="Session lives on '+esc(SRV)+'">'+esc(SRV)+'</span>'
    + '<div class="hdr-title">Loading…</div>';
  el.appendChild(makeViewBar(v, barMain, { close:true }));
  var dotEl = barMain.querySelector('.status-dot');
  var titleEl = barMain.querySelector('.hdr-title');

  // — body —
  var body = document.createElement('div');
  body.className = 'view-body';
  body.innerHTML =
    '<div class="sv-stats"><span class="hdr-proj"></span><span class="hdr-stats"></span><div class="hdr-status"></div></div>'+
    '<div class="tr-wrap">'+
      '<div class="transcript"></div>'+
      '<button class="jump-marker">&#8595; New updates</button>'+
      '<div class="query-ind" title="Querying…"></div>'+
    '</div>'+
    '<div class="cmd-box">'+
      '<div class="cmd-head"><span class="cmd-title"></span>'+
        '<div class="cmd-btns">'+
          '<button class="cmd-btn" data-c="min" title="Minimize">&#8211;</button>'+
          '<button class="cmd-btn" data-c="max" title="Maximize">&#9633;</button>'+
          '<button class="cmd-btn" data-c="close" title="Close">&#10005;</button>'+
        '</div></div>'+
      '<div class="cmd-content"></div>'+
    '</div>'+
    '<div class="input-area"><div class="input-inner"><div class="input-row">'+
      '<textarea class="input-box" placeholder="Message the session…  (// for commands)" rows="1"></textarea>'+
      '<button class="send-btn" title="'+SEND_TIP+'">&#8593;</button>'+
    '</div></div></div>';
  el.appendChild(body);
  v.bodyEl = body;
  var projEl = body.querySelector('.hdr-proj');
  var statsEl = body.querySelector('.hdr-stats');
  var statusRow = body.querySelector('.hdr-status');
  var transcript = body.querySelector('.transcript');
  var jumpMarker = body.querySelector('.jump-marker');
  var queryEl = body.querySelector('.query-ind');
  var cmdBox = body.querySelector('.cmd-box');
  var cmdTitle = body.querySelector('.cmd-title');
  var cmdContent = body.querySelector('.cmd-content');
  var inputBox = body.querySelector('.input-box');
  var sendBtn = body.querySelector('.send-btn');

  var ws, reconnectTimer, destroyed = false;
  var msgEls = {}, toolEls = {}, seenUuids = {};
  // Timing: response time = assistant entry ts − last USER entry ts (prompt/tool_result), anchored
  // to the last user entry since one response spans several assistant entries (thinking/text/tool).
  // Reaction time = typed-prompt ts − last ASSISTANT entry ts. toolStart maps a tool_use id → its
  // assistant entry's time, paired on the result card to show how long the tool took.
  var lastUserTs = null, lastAsstTs = null, toolStart = {};
  var historyLoaded = false, pendingTranscript = [], pendingAsk = null;
  var permEls = {};    // fp -> element
  var askCards = {};   // tool_use id -> card element
  var statEls = {}, statTurnNo = {}, statTurns = 0, statSeenFirst = false;

  function renderTitle() {
    titleEl.textContent = INFO.title || '(untitled — ' + INFO.sessionId.slice(0,8) + ')';
    titleEl.className = 'hdr-title' + (INFO.title ? '' : ' empty');
    titleEl.title = 'Click to rename';
  }
  titleEl.addEventListener('click', function(e){
    if (el.classList.contains('collapsed')) return;   // bar handler expands instead
    e.stopPropagation();
    editSessionTitle();
  });
  function editSessionTitle() {
    var anchor = titleEl;
    var inp = document.createElement('input');
    inp.className = 'hdr-title-input';
    inp.value = INFO.title || '';
    inp.placeholder = 'Session name';
    inp.addEventListener('click', function(e){ e.stopPropagation(); });
    anchor.style.display = 'none';
    anchor.parentNode.insertBefore(inp, anchor.nextSibling);
    inp.focus(); inp.select();
    var done = false;
    function finish(save) {
      if (done) return; done = true;
      var val = inp.value.trim();
      if (save && val !== (INFO.title || '')) {
        INFO.title = val;
        fetch(API+'/api/session/' + INFO.sessionId, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: val })
        }).catch(function(){});
      }
      inp.remove();
      anchor.style.display = '';
      renderTitle();
    }
    inp.addEventListener('blur', function(){ finish(true); });
    inp.addEventListener('keydown', function(e){
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { finish(false); }
    });
  }
  function renderStats(st) {
    if (!st) { statsEl.textContent = ''; return; }
    projEl.innerHTML = (INFO.projectPath?'<b>'+esc(INFO.projectPath)+'</b>':'') +
      '  &middot;  last '+esc(fmtStatDate(st.lastActivity))+'  &middot;  started '+esc(fmtStatDate(st.startedAt));
    var models = (st.models||[]).filter(function(m){ return m.cost>=0.005; });
    var modelStr = models.length>=2
      ? ' ('+models.map(function(m){ return esc(prettyModel(m.model))+': '+fmtCost(m.cost); }).join(' · ')+')'
      : (models.length===1?' <span class="sub">('+esc(prettyModel(models[0].model))+')</span>':'');
    var c = st.categories||{}, totCost = st.cost||0;
    function cat(label,key){ var x=c[key]||{tokens:0,cost:0}; return '<span class="rl-lbl">'+label+'</span> '+fmtTokShort(x.tokens)+' <span class="rl-pct">'+fmtPct(x.cost,totCost)+'</span>'; }
    var tokStr = cat('cr','cacheRead')+'  '+cat('cw','cacheWrite')+'  '+cat('cm','cacheMiss')+'  '+cat('out','output')+'  '+cat('in','input')+
      (fmtDur(st.avgResponseMs)?'  <span class="rl-lbl">t</span> '+fmtDur(st.avgResponseMs)+
        (st.avgOutTps?' '+st.avgOutTps.toFixed(1)+'/s':''):'');
    var ctx = st.context, cmax = st.contextMax;
    var peakStr = ctx && cmax && fmtTokShort(cmax.tokens)!==fmtTokShort(ctx.tokens)
      ? ' <span class="subturns">peak '+fmtTokShort(cmax.tokens)+'</span>' : '';
    var ctxStr = ctx ? '  &middot;  ctx:'+(ctx.postCompact?'~':'')+'<b>'+fmtTokShort(ctx.tokens)+'</b>/'+fmtCost(ctx.cost)+peakStr+
      (ctx.postCompact?' <span class="subturns">post-compact</span>':'') : '';
    var turns = st.turns||0, subTurns = st.subTurns||0;
    var subStr = subTurns>0?' <span class="subturns">+'+subTurns+'</span>':'';
    statsEl.innerHTML = '<b>'+turns+'</b>'+subStr+' turn'+(turns===1?'':'s')+
      '  &middot;  <b>'+fmtCost(st.cost)+'</b>'+modelStr+
      '  &middot;  <b>'+fmtTokShort(st.totalTokens)+'</b>  '+tokStr+ctxStr;
  }
  // Session state from the live sidecar: busy = Claude is working, idle = it finished the
  // turn and is waiting for your input ("session end" in the turn sense), no sidecar = the
  // process has exited. We surface idle prominently: when did it stop, how long it's waited.
  function relSince(iso){
    if (iso == null) return '';
    var t = typeof iso === 'number' ? iso : Date.parse(iso); if (isNaN(t)) return '';
    var s = Math.max(0, Math.round((Date.now()-t)/1000));
    if (s < 60) return s+'s';
    var m = Math.floor(s/60); if (m < 60) return m+'m';
    var h = Math.floor(m/60), rm = m%60; return h+'h'+(rm?' '+rm+'m':'');
  }
  function setStatus(d) {
    var live = !!(d && d.live), status = d && d.status;
    var idle = live && status === 'idle';
    var className = 'status-dot' + (live ? (idle ? ' idle' : ' live') : '');
    dotEl.className = className;
    var title = !live ? 'Not running' : (idle ? 'Waiting for input' : 'Working');
    dotEl.title = title;
    if (idle) {
      var at = d.statusUpdatedAt, since = relSince(at);
      statusRow.innerHTML = '⏸ finished responding' + (at ? ' at <b>'+esc(fd(at))+'</b>' : '') +
        ' · waiting for input' + (since ? ' <b>'+since+'</b>' : '');
      statusRow.classList.add('show');
    } else {
      statusRow.classList.remove('show');
      statusRow.innerHTML = '';
    }
  }
  var queryCount = 0;
  function queryStart(){ queryCount++; queryEl.classList.add('show'); }
  function queryEnd(){ queryCount = Math.max(0, queryCount-1); if (!queryCount) queryEl.classList.remove('show'); }
  // Every session-scoped call goes through here, so the API prefix (local or peer)
  // is applied in exactly one place.
  function qfetch(url, opts){ queryStart(); return fetch(API+url, opts).finally(queryEnd); }
  function pollLive() {
    qfetch('/api/session/'+INFO.sessionId+'/live').then(function(r){return r.json();})
      .then(function(d){ setStatus(d); }).catch(function(){});
    qfetch('/api/session/'+INFO.sessionId+'/stats').then(function(r){return r.json();})
      .then(function(d){ if(d) renderStats(d); }).catch(function(){});
  }

  // — per-response usage line —
  function emitMsgStats(msg, hist, respMs) {
    var u = msg.usage||{};
    var input=u.input_tokens||0, output=u.output_tokens||0;
    var cacheRead=u.cache_read_input_tokens||0, cacheWrite=u.cache_creation_input_tokens||0;
    var totalTok = input+output+cacheRead+cacheWrite;
    if (!totalTok) return;
    var p = priceFor(msg.model);
    var cIn=input*p.input/1e6, cOut=output*p.output/1e6;
    var cCr=cacheRead*p.cacheRead/1e6, cCw=cacheWrite*p.cacheWrite/1e6;
    var cost = cIn+cOut+cCr+cCw;
    var isFirst = !statSeenFirst; statSeenFirst = true;
    var missTok = (cacheRead===0 && !isFirst) ? cacheWrite : 0;
    var missCost = (cacheRead===0 && !isFirst) ? cCw : 0;
    var pct = function(x){ return (cost>0?(x/cost*100):0).toFixed(1)+'%'; };
    var seg = function(lbl,t,x){ return '<span class="rl-lbl">'+lbl+'</span> '+fmtTokShort(t)+' <span class="rl-pct">'+pct(x)+'</span>'; };
    var turnNo;
    if (msg.id && statTurnNo[msg.id]) turnNo = statTurnNo[msg.id];
    else { turnNo = ++statTurns; if (msg.id) statTurnNo[msg.id] = turnNo; }
    var ctxTok = input+cacheRead+cacheWrite+output;
    var ctxCost = ctxTok*p.cacheRead/1e6;
    var line = '<span class="rl-turn">'+turnNo+':</span> '+
      '<b>'+fmtCost(cost)+'</b> '+fmtTokShort(totalTok)+
      '  '+seg('cr',cacheRead,cCr)+'  '+seg('cw',cacheWrite,cCw)+'  '+seg('cm',missTok,missCost)+
      '  '+seg('out',output,cOut)+'  '+seg('in',input,cIn)+
      '  <span class="rl-lbl">ctx</span> '+fmtTokShort(ctxTok)+' <span class="rl-pct">'+fmtCost(ctxCost)+'</span>'+
      (fmtDur(respMs)?'  <span class="rl-lbl">t</span> '+fmtDur(respMs):'');
    var lineEl = statEls[msg.id];
    if (!lineEl) {
      lineEl = document.createElement('div');
      lineEl.className = 'result-line'+(hist?' hist':'');
      if (msg.id) statEls[msg.id] = lineEl;
      transcript.appendChild(lineEl);
    }
    lineEl.innerHTML = line;
    scrollBottom();
  }

  // — entry rendering —
  function processEntry(entry, hist) {
    if (entry.uuid) { if (seenUuids[entry.uuid]) return; seenUuids[entry.uuid] = true; }
    var msg = entry.message;
    if (!msg) return;
    var ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (entry.role === 'assistant') {
      var respGap = (!isNaN(ts) && lastUserTs != null) ? ts - lastUserTs : null;
      if (!isNaN(ts)) lastAsstTs = ts;
      // record each tool_use's start so its result card can show how long the tool took
      if (!isNaN(ts)) for (var i=0;i<(msg.content||[]).length;i++) { var b=msg.content[i]; if (b.type==='tool_use' && b.id) toolStart[b.id]=ts; }
      renderAssistant(msg, hist);
      if (msg.usage) emitMsgStats(msg, hist, respGap);
    } else if (entry.role === 'user') {
      var youGap = (!isNaN(ts) && lastAsstTs != null) ? ts - lastAsstTs : null;
      if (!isNaN(ts)) lastUserTs = ts;
      if (entry.compact) { renderCompactMarker(msg, hist); return; }
      var hasToolResult = (msg.content||[]).some(function(b){ return b.type==='tool_result'; });
      if (hasToolResult) renderToolResults(msg, ts, entry.subagent);
      renderUserMessage(msg, hist, youGap);
    }
    repinPermissions();
  }
  function renderAssistant(msg, hist) {
    var msgId = msg.id, streaming = !msg.stop_reason;
    var textParts=[], toolBlocks=[], thinkingParts=[];
    for (var i=0;i<(msg.content||[]).length;i++) {
      var b = msg.content[i];
      if (b.type==='text') textParts.push(b.text);
      else if (b.type==='thinking') thinkingParts.push(b.thinking||'');
      else if (b.type==='tool_use') toolBlocks.push(b);
    }
    var thinkingText = thinkingParts.join('').trim();
    if (thinkingText) renderThinking(msgId, thinkingText, hist);
    var joined = textParts.join(''), hasText = joined.trim().length>0;
    if (hasText || (streaming && !toolBlocks.length && !thinkingText)) {
      var mEl = msgEls[msgId];
      if (!mEl) {
        mEl = document.createElement('div');
        mEl.className = 'msg'+(hist?' hist':'');
        mEl.innerHTML = '<div class="msg-label">Claude</div><div class="msg-body"></div>';
        msgEls[msgId] = mEl;
        transcript.appendChild(mEl);
      }
      mEl.querySelector('.msg-body').innerHTML = hasText ? marked.parse(joined) : '';
    }
    for (var j=0;j<toolBlocks.length;j++) renderToolUse(toolBlocks[j], hist);
    scrollBottom();
  }
  function renderThinking(msgId, text, hist) {
    var id = 'think-'+msgId, card = document.getElementById(id);
    if (!card) {
      card = document.createElement('div');
      card.id = id; card.className = 'think-card'+(hist?' hist':'');
      card.innerHTML = '<div class="think-hdr" onclick="toggleTool(this)"><span class="think-label">&#10024; Thinking</span><span class="tool-toggle">&#9654;</span></div><div class="tool-body"><div class="think-body"></div></div>';
      transcript.appendChild(card);
    }
    card.querySelector('.think-body').textContent = text;
  }
  function renderToolUse(block, hist) {
    if (block.name==='AskUserQuestion') return renderAskCard(block, hist);
    var id = block.id;
    if (toolEls[id]) return;
    var card = document.createElement('div');
    card.className = 'tool-card'+(hist?' hist':''); card.id = 'tool-'+id;
    var inputStr = formatToolInput(block.name, block.input);
    card.innerHTML =
      '<div class="tool-hdr" onclick="toggleTool(this)"><span class="tool-name">'+esc(block.name)+'</span>'+
        '<span class="tool-meta"><span class="tool-time" id="tm-'+id+'"></span>'+
          '<span class="tool-status '+(hist?'done':'running')+'" id="ts-'+id+'">'+(hist?'Done':'Running')+'</span></span>'+
        '<span class="tool-toggle" id="tt-'+id+'">&#9660;</span></div>'+
      '<div class="tool-body open" id="tb-'+id+'"><div class="tool-input"><pre>'+esc(inputStr)+'</pre></div>'+
        '<div class="tool-output" id="to-'+id+'"></div></div>';
    toolEls[id] = card;
    transcript.appendChild(card);
    scrollBottom();
  }
  function renderToolResults(msg, resultTs, subagent) {
    for (var i=0;i<(msg.content||[]).length;i++) {
      var block = msg.content[i];
      if (block.type!=='tool_result') continue;
      var id = block.tool_use_id;
      var outputEl = document.getElementById('to-'+id), statusEl = document.getElementById('ts-'+id);
      if (!outputEl) continue;
      var isError = block.is_error;
      if (statusEl) { statusEl.className = 'tool-status '+(isError?'error':'done'); statusEl.textContent = isError?'Error':'Done'; }
      var timeEl = document.getElementById('tm-'+id);
      if (timeEl && toolStart[id]!=null && !isNaN(resultTs)) timeEl.textContent = fmtDur(resultTs - toolStart[id]);
      var content = '';
      if (typeof block.content==='string') content = block.content;
      else if (Array.isArray(block.content)) content = block.content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('');
      outputEl.innerHTML = '<pre>'+esc(content)+'</pre>';
      // A finished Agent/Task call: nest the subagent's own transcript, collapsed, under its
      // output. Lazy-fetched on first expand (see toggleSubagent) so history stays light.
      if (subagent && subagent.toolUseId===id && !document.getElementById('sa-'+id)) {
        var sa = document.createElement('div');
        sa.className = 'subagent-block'; sa.id = 'sa-'+id;
        var label = 'Subagent transcript'+(subagent.agentType?' &middot; '+esc(subagent.agentType):'');
        sa.innerHTML =
          '<div class="subagent-hdr"><span class="subagent-toggle">&#9654;</span> '+label+'</div>'+
          '<div class="subagent-body" id="sab-'+id+'" hidden></div>';
        (function(tid, aid){
          sa.querySelector('.subagent-hdr').addEventListener('click', function(){ toggleSubagent(tid, aid); });
        })(id, subagent.agentId);
        outputEl.parentNode.appendChild(sa);
      }
      if (askCards[id]) settleAsk(id);
    }
    scrollBottom();   // results grow an existing card in place — keep following
  }
  // Expand/collapse a subagent transcript nested under an Agent/Task card. The nested tree is
  // fetched and built once (on first expand); later toggles just flip visibility.
  function toggleSubagent(toolId, agentId) {
    var body = document.getElementById('sab-'+toolId), block = document.getElementById('sa-'+toolId);
    if (!body || !block) return;
    var toggle = block.querySelector('.subagent-toggle');
    var open = body.hasAttribute('hidden');
    if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden','');
    if (toggle) toggle.innerHTML = open?'&#9660;':'&#9654;';
    if (open && body.dataset.loaded!=='1') {
      body.dataset.loaded = '1';
      body.innerHTML = '<div class="subagent-loading">Loading…</div>';
      qfetch('/api/session/'+INFO.sessionId+'/subagent/'+encodeURIComponent(agentId))
        .then(function(r){ return r.json(); })
        .then(function(d){
          body.innerHTML = '';
          var entries = (d&&d.history)||[];
          if (!entries.length) { body.innerHTML = '<div class="subagent-loading">No subagent messages.</div>'; return; }
          renderSubagentInto(body, entries);
        })
        .catch(function(){ body.dataset.loaded=''; body.innerHTML = '<div class="subagent-loading">Failed to load.</div>'; });
    }
  }
  // Static, one-shot render of a subagent's transcript into the container. Self-contained (no
  // live streaming, no shared element maps): the run is already complete. The leading user
  // entry is the agent prompt — already shown in the parent card's input — so it's dropped.
  function renderSubagentInto(container, entries) {
    var results = {};   // tool_use_id → its tool_result block, pre-indexed for inline output
    entries.forEach(function(e){
      (e.message.content||[]).forEach(function(b){ if (b.type==='tool_result') results[b.tool_use_id]=b; });
    });
    var droppedPrompt = false;
    entries.forEach(function(e){
      var content = e.message.content||[];
      if (e.role==='assistant') {
        var think = content.filter(function(b){return b.type==='thinking';}).map(function(b){return b.thinking||'';}).join('').trim();
        if (think) {
          var tc = document.createElement('div'); tc.className='think-card';
          tc.innerHTML = '<div class="think-hdr" onclick="toggleTool(this)"><span class="think-label">&#10024; Thinking</span><span class="tool-toggle">&#9654;</span></div><div class="tool-body"><div class="think-body"></div></div>';
          tc.querySelector('.think-body').textContent = think; container.appendChild(tc);
        }
        var text = content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('').trim();
        if (text) {
          var m = document.createElement('div'); m.className='msg';
          m.innerHTML = '<div class="msg-label">Subagent</div><div class="msg-body">'+marked.parse(text)+'</div>';
          container.appendChild(m);
        }
        content.filter(function(b){return b.type==='tool_use';}).forEach(function(b){ container.appendChild(subToolCard(b, results[b.id])); });
      } else if (e.role==='user') {
        if (content.some(function(b){return b.type==='tool_result';})) return;   // inlined into tool cards above
        var ut = content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('').trim();
        if (!droppedPrompt) { droppedPrompt = true; return; }                    // the agent prompt
        if (ut && !isSystemNoise(ut)) {
          var um = document.createElement('div'); um.className='msg you';
          um.innerHTML = '<div class="msg-label">User</div><div class="msg-body">'+esc(ut)+'</div>';
          container.appendChild(um);
        }
      }
    });
  }
  // A collapsed tool card for a subagent's tool call, with its result inlined. Nested Agent
  // calls render as a plain card (no recursion into deeper subagents).
  function subToolCard(block, resultBlock) {
    var card = document.createElement('div'); card.className='tool-card';
    var inputStr = formatToolInput(block.name, block.input);
    var out = '';
    if (resultBlock) {
      if (typeof resultBlock.content==='string') out = resultBlock.content;
      else if (Array.isArray(resultBlock.content)) out = resultBlock.content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('');
    }
    var isErr = resultBlock && resultBlock.is_error;
    card.innerHTML =
      '<div class="tool-hdr" onclick="toggleTool(this)"><span class="tool-name">'+esc(block.name)+'</span>'+
        '<span class="tool-meta"><span class="tool-status '+(isErr?'error':'done')+'">'+(isErr?'Error':'Done')+'</span></span>'+
        '<span class="tool-toggle">&#9654;</span></div>'+
      '<div class="tool-body"><div class="tool-input"><pre>'+esc(inputStr)+'</pre></div>'+
        '<div class="tool-output"><pre>'+esc(out)+'</pre></div></div>';
    return card;
  }
  // A question dialog: each question gets radio-select options plus a "Type something" custom
  // field; a single question answers on one click, a series collects one pick per question and
  // sends them together via Submit. The server (answerAsk) turns the picks into pane keystrokes.
  function renderAskCard(block, hist) {
    var id = block.id;
    if (toolEls[id]) return;
    var qs = (block.input && block.input.questions) || [];
    // A Submit button is needed for a series, or whenever a question is multi-select (you pick
    // several then submit). A lone single-select question keeps its one-click answer.
    var showSubmit = qs.length > 1 || qs.some(function(q){ return q && q.multiSelect; });
    // per-question state: multiSelect → {choices:[…]}; single → {choice:n} | {text:s} | null
    var sel = qs.map(function(q){ return (q && q.multiSelect) ? { choices: [] } : null; });
    function isMulti(qi){ return !!(qs[qi] && qs[qi].multiSelect); }

    var card = document.createElement('div');
    card.className = 'perm-card ask-card'+(hist?' hist':''); card.id = 'tool-'+id;
    var html = '<div class="perm-hdr">&#10067; Claude asks'+(qs.length>1?' &middot; '+qs.length+' questions':'')+'</div>';
    qs.forEach(function(q, qi){
      var ms = !!(q && q.multiSelect);
      html += '<div class="perm-body">'+(qs.length>1?'<b>'+(qi+1)+'.</b> ':'')+(q.header?'<b>'+esc(q.header)+'</b> &mdash; ':'')+esc(q.question||'')+
        (ms?' <span class="ask-multi">(pick any)</span>':'')+'</div>';
      html += '<div class="perm-acts ask-q">'+(q.options||[]).map(function(o,i){
        var lbl = typeof o==='string' ? o : (o.label||'');
        var desc = (o&&o.description)||'';
        return '<button class="perm-opt ask-opt" data-qi="'+qi+'" data-n="'+(i+1)+'" title="'+esc(desc)+'">'+(i+1)+'. '+esc(lbl)+'</button>';
      }).join('')+'</div>';
      if (!ms) html += '<div class="ask-custom"><input class="ask-text" data-qi="'+qi+'" placeholder="Type something…"></div>';
    });
    html += '<div class="perm-acts ask-foot"><button class="ask-submit"'+(showSubmit?'':' style="display:none"')+' disabled>Submit</button></div>';
    html += '<div class="perm-note" id="an-'+id+'">'+(showSubmit?'Choose your answer'+(qs.length>1?'s':'')+', then Submit.':'Tap an option, or type a custom answer.')+' Also answerable at the terminal.</div>';
    html += '<div class="tool-output" id="to-'+id+'"></div>';
    card.innerHTML = html;

    var submitBtn = card.querySelector('.ask-submit');
    function qReady(qi){
      var s = sel[qi];
      if (isMulti(qi)) return !!(s && s.choices && s.choices.length);
      return s != null;
    }
    function ready(){ return qs.every(function(_, qi){ return qReady(qi); }); }
    function refresh(){ if (submitBtn) submitBtn.disabled = !ready(); }
    function markOpts(qi){
      var s = sel[qi], ms = isMulti(qi);
      card.querySelectorAll('.ask-opt[data-qi="'+qi+'"]').forEach(function(b){
        var n = +b.dataset.n;
        var on = ms ? !!(s && s.choices && s.choices.indexOf(n) !== -1) : !!(s && s.choice === n);
        b.classList.toggle('sel', on);
      });
    }
    function doSubmit(){ if (!ready()) return; settleAsk(id); submitAsk(id, sel.slice()); }
    card.querySelectorAll('.ask-opt').forEach(function(b){
      b.addEventListener('click', function(){
        var qi = +b.dataset.qi, n = +b.dataset.n;
        if (isMulti(qi)) {
          var arr = (sel[qi] && sel[qi].choices) || [];
          var idx = arr.indexOf(n);
          if (idx === -1) arr.push(n); else arr.splice(idx, 1);
          sel[qi] = { choices: arr };
        } else {
          sel[qi] = { choice: n };
          var inp = card.querySelector('.ask-text[data-qi="'+qi+'"]'); if (inp) inp.value = '';
        }
        markOpts(qi); refresh();
        if (!showSubmit) doSubmit();   // lone single-select → one click answers
      });
    });
    card.querySelectorAll('.ask-text').forEach(function(inp){
      inp.addEventListener('input', function(){
        var qi = +inp.dataset.qi;
        sel[qi] = inp.value.length ? { text: inp.value } : null;
        markOpts(qi); refresh();
      });
      inp.addEventListener('keydown', function(e){
        if (e.key === 'Enter') { e.preventDefault(); if (ready()) doSubmit(); }
      });
    });
    if (submitBtn) submitBtn.addEventListener('click', doSubmit);

    toolEls[id] = card; askCards[id] = card;
    transcript.appendChild(card);
    scrollBottom();
  }
  function settleAsk(id) {
    var card = askCards[id];
    if (!card) return;
    card.querySelectorAll('.ask-opt, .ask-text, .ask-submit').forEach(function(b){ b.disabled = true; });
    var note = document.getElementById('an-'+id);
    if (note) note.textContent = 'Answered.';
  }
  function submitAsk(id, answers) {
    qfetch('/api/session/'+INFO.sessionId+'/ask', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ answers: answers })
    }).then(function(r){ return r.json(); })
      .then(function(d){ if (!(d&&d.ok)) toast((d&&d.error)||'Answer failed'); })
      .catch(function(e){ toast(String(e)); });
  }
  function formatToolInput(toolName, input) {
    if (!input) return '';
    var s = function(x){ return x==null?'':String(x); };
    if (toolName==='Bash' && input.command) return input.command;
    if (toolName==='Read' && input.file_path) return input.file_path;
    if (toolName==='Write' && input.file_path) return input.file_path+'\\n\\n'+s(input.content);
    if ((toolName==='Edit'||toolName==='MultiEdit') && input.file_path) {
      if (Array.isArray(input.edits)) return input.file_path+'\\n\\n'+input.edits.map(function(e){ return '- '+s(e.old_string)+'\\n+ '+s(e.new_string); }).join('\\n\\n');
      return input.file_path+'\\n\\n- '+s(input.old_string)+'\\n+ '+s(input.new_string);
    }
    if (toolName==='Glob' && input.pattern) return input.pattern;
    if (toolName==='Grep' && input.pattern) return input.pattern+(input.path?'  '+input.path:'');
    if (toolName==='WebFetch' && input.url) return input.url+(input.prompt?'\\n\\n'+s(input.prompt):'');
    if (toolName==='WebSearch' && input.query) return input.query;
    if ((toolName==='Task'||toolName==='Agent') && (input.description||input.prompt)) return s(input.description)+'\\n\\n'+s(input.prompt);
    try { return JSON.stringify(input, null, 2); } catch(e) { return String(input); }
  }
  var NOISE_TAG = /^<(command-name|command-message|command-args|local-command|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr)/;
  function isSystemNoise(text) {
    var t = (text||'').trim();
    if (!t) return true;
    if (NOISE_TAG.test(t)) return true;
    if (t.indexOf('<local-command-stdout>')!==-1) return true;
    if (t.indexOf('<task-notification>')!==-1) return true;
    if (t.indexOf('Caveat: The messages below')!==-1) return true;
    if (/^\\[Request interrupted/.test(t)) return true;
    if (/^This session is being continued from a previous conversation/.test(t)) return true;
    return false;
  }
  function renderCompactMarker(msg, hist) {
    var summary = (msg.content||[]).filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('').trim();
    var mk = document.createElement('div');
    mk.className = 'compact-marker'+(hist?' hist':'');
    mk.innerHTML = '<div class="compact-line"><span class="compact-label">&#10719; Context compacted</span></div>'+
      '<details class="compact-details"><summary>View summary</summary><div class="compact-summary">'+esc(summary)+'</div></details>';
    transcript.appendChild(mk);
    scrollBottom();
  }
  function renderUserMessage(msg, hist, gap) {
    var text = (msg.content||[]).filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('').trim();
    if (!text || isSystemNoise(text)) return false;
    var mEl = document.createElement('div');
    mEl.className = 'msg you'+(hist?' hist':'');
    var yt = fmtDur(gap);
    mEl.innerHTML = '<div class="msg-label">You'+(yt?' <span class="msg-time">'+yt+'</span>':'')+'</div><div class="msg-body">'+esc(text)+'</div>';
    transcript.appendChild(mEl);
    scrollBottom();
    return true;
  }

  // — auto-scroll —
  // "following" is sticky and set only by real scroll events. The hard part is that a
  // turn's content lands in pieces: a tool card is appended, then its RESULT arrives
  // later and EXPANDS that div in place (and it may sit above newer entries). Each
  // render calls scrollBottom(), but the growth from a late expansion happens after that
  // call, and a flex scroll container's native overflow-anchor (disabled above anyway) is
  // unreliable — so a MutationObserver is the authority on scroll math for every DOM
  // change: while following, re-pin to the bottom; while reviewing, hold the topmost
  // on-screen element fixed so an expanding div above the viewport can't shove the page.
  var NEAR_BOTTOM_PX = 250;
  var following = true;
  var anchorEl = null, anchorTop = 0;   // reading anchor used while NOT following
  function distFromBottom(t){ return t.scrollHeight - t.scrollTop - t.clientHeight; }
  // Topmost child that intersects the viewport top — the element to hold steady.
  function pickAnchor(){
    var kids = transcript.children, vpTop = transcript.scrollTop;
    anchorEl = null;
    for (var i=0;i<kids.length;i++){
      var e = kids[i];
      if (e.offsetTop + e.offsetHeight > vpTop) { anchorEl = e; anchorTop = e.offsetTop; return; }
    }
  }
  transcript.addEventListener('scroll', function(){
    following = distFromBottom(this) <= NEAR_BOTTOM_PX;
    if (following) { hideJumpMarker(); markSeen(); anchorEl = null; }
    else pickAnchor();
  });
  var scrollObserver = new MutationObserver(function(){
    if (following) { transcript.scrollTop = transcript.scrollHeight; return; }
    // Reviewing: keep the anchor element pinned to its screen position. Content added
    // BELOW the anchor (new entries at the bottom) leaves its offsetTop unchanged → no
    // move; content growing ABOVE it shifts offsetTop → compensate by the same delta.
    if (!anchorEl || anchorEl.parentNode !== transcript) pickAnchor();
    if (anchorEl) {
      var delta = anchorEl.offsetTop - anchorTop;
      if (delta) { transcript.scrollTop += delta; anchorTop = anchorEl.offsetTop; }
    }
    showJumpMarker();
  });
  scrollObserver.observe(transcript, { childList:true, subtree:true, characterData:true });
  function scrollBottom(force){
    if (force || following) {
      transcript.scrollTop = transcript.scrollHeight;
      following = true;   // explicit: programmatic scrolls don't always fire 'scroll'
      anchorEl = null;
      hideJumpMarker();
      markSeen();
    } else {
      showJumpMarker();
    }
  }
  function showJumpMarker(){ jumpMarker.classList.add('show'); }
  function hideJumpMarker(){ jumpMarker.classList.remove('show'); }
  jumpMarker.addEventListener('click', function(){ scrollBottom(true); });
  function repinPermissions(){
    for (var k in permEls) transcript.appendChild(permEls[k]);
  }

  // — unviewed-update indicator —
  // An update counts as UNVIEWED unless the view body is on screen (not collapsed,
  // tab visible) AND the transcript is following the bottom. Seen again = expanded
  // and back at the bottom.
  function bodyVisible(){ return !el.classList.contains('collapsed') && !document.hidden; }
  function noteUpdate(){ if (!bodyVisible() || !following) setUnseen(v, true); }
  function markSeen(){ if (bodyVisible()) setUnseen(v, false); }
  v.onExpanded = function(){ if (following) { transcript.scrollTop = transcript.scrollHeight; markSeen(); } };

  // — WebSocket (live tail) —
  function connect() {
    if (destroyed) return;
    clearTimeout(reconnectTimer);
    var proto = location.protocol==='https:'?'wss:':'ws:';
    ws = new WebSocket(proto+'//'+location.host+API+'/ws/'+INFO.sessionId);
    ws.onmessage = function(e){ handleWsMsg(JSON.parse(e.data)); };
    ws.onclose = function(){ if (!destroyed) reconnectTimer = setTimeout(connect, 2000); };
  }
  function handleWsMsg(msg) {
    if (msg.type==='transcript') {
      if (!historyLoaded) pendingTranscript.push(msg.entry);
      else { processEntry(msg.entry, false); noteUpdate(); }
    } else if (msg.type==='permission') {
      showPermission(msg); noteUpdate();
    } else if (msg.type==='permission_clear') {
      clearPermission(msg.fp);
    } else if (msg.type==='command') {
      showCmd(msg); noteUpdate();
    } else if (msg.type==='ask_block') {
      // Defer until history is in so the card lands at the bottom (after prior turns), not
      // above them. renderAskCard dedups by tool_use id, so a history copy won't double it.
      if (!historyLoaded) pendingAsk = msg.block;
      else { renderAskCard(msg.block, false); noteUpdate(); }
    }
  }

  // — permission prompt (from a hook, or scraped from the pane) —
  function showPermission(msg) {
    clearPermission();   // only ever one prompt at a time — drop any prior card (hook/scrape race)
    var card = document.createElement('div');
    card.className = 'perm-card'; card.id = 'perm-' + msg.fp;
    var opts = (msg.options||[]).map(function(o, i){
      return '<button class="perm-opt'+(i===0?' first':'')+'" data-n="'+o.n+'">'+o.n+'. '+esc(o.label)+'</button>';
    }).join('');
    card.innerHTML =
      '<div class="perm-hdr">&#128274; Permission needed</div>' +
      '<div class="perm-body">'+esc(msg.title)+'</div>' +
      '<div class="perm-acts">'+opts+'</div>' +
      '<div class="perm-note">Tap an option or type the number below. Also answerable at the terminal.</div>';
    card.querySelectorAll('.perm-opt').forEach(function(b){
      b.addEventListener('click', function(){
        clearPermission(msg.fp);   // dismiss immediately, don't wait for the pane scrape
        answerPermission(+b.dataset.n);
      });
    });
    permEls[msg.fp] = card;
    transcript.appendChild(card);
    scrollBottom();
  }
  function clearPermission(fp) {
    if (fp && permEls[fp]) { permEls[fp].remove(); delete permEls[fp]; return; }
    for (var k in permEls) { permEls[k].remove(); delete permEls[k]; }
  }
  function answerPermission(choice) {
    qfetch('/api/session/'+INFO.sessionId+'/permission', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ choice: choice })
    }).catch(function(){});
  }

  // — history —
  async function loadHistory() {
    var r, d;
    try { r = await qfetch('/api/session/'+INFO.sessionId+'/history'); d = await r.json(); }
    catch(e) { historyLoaded = true; flushPending(); return; }
    var entries = (d&&d.history)||[];
    for (var i=0;i<entries.length;i++) processEntry(entries[i], true);
    historyLoaded = true;
    flushPending();
    scrollBottom(true);
  }
  function flushPending() {
    for (var i=0;i<pendingTranscript.length;i++) { processEntry(pendingTranscript[i], false); }
    pendingTranscript = [];
    // An open ask that arrived before history loaded: render it now (after the transcript is
    // in place). If history already rendered the same card, renderAskCard dedups by id.
    if (pendingAsk) { renderAskCard(pendingAsk, false); pendingAsk = null; noteUpdate(); }
  }

  // — composer —
  var canDrive = false, cmdCwd = '';
  function refreshDrivable() {
    qfetch('/api/session/'+INFO.sessionId+'/pane').then(function(r){return r.json();})
      .then(function(d){ setDrivable(d && !!d.pane); }).catch(function(){ setDrivable(false); });
  }
  function setDrivable(ok) {
    canDrive = ok;
    if (ok) {
      sendBtn.title = SEND_TIP;
      inputBox.placeholder = 'Message the session…  (/compact, // for commands)';
    } else {
      sendBtn.title = SEND_TIP_OFF;
      inputBox.placeholder = 'Session not attachable — // commands still work';
    }
  }
  function sendMessage() {
    var text = inputBox.value;
    if (!text.trim()) return;
    if (text.trim().charAt(0) === '/' && text.trim().charAt(1) === '/') { runCmd(text.trim()); inputBox.value=''; autoGrow(inputBox); return; }
    if (!canDrive) { if (text.trim().charAt(0) === '/') toast('Session not running in a tmux pane here — cannot send /commands.'); return; }
    sendBtn.disabled = true;
    qfetch('/api/session/'+INFO.sessionId+'/input', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: text })
    }).then(function(r){ return r.json(); }).then(function(d){
      if (d && d.ok) { inputBox.value=''; autoGrow(inputBox); } else { toast((d&&d.error)||'Send failed'); }
    }).catch(function(e){ toast(String(e)); }).then(function(){ sendBtn.disabled=false; inputBox.focus(); });
  }
  function runCmd(raw) {
    var cbody = raw.slice(2).trim();
    var sp = cbody.indexOf(' ');
    var name = sp === -1 ? cbody : cbody.slice(0, sp);
    var args = sp === -1 ? '' : cbody.slice(sp + 1);
    if (!name) return;
    qfetch('/api/session/'+INFO.sessionId+'/command', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name: name, args: args, cwd: cmdCwd })
    }).then(function(r){ return r.json(); }).then(function(d){ showCmd(d); }).catch(function(e){ showCmd({ error:String(e) }); });
  }
  function showCmd(d) {
    if (d && d.cwd) cmdCwd = d.cwd;
    if (d && d.kind === 'clear') { hideCmd(); return; }
    if (d && d.error) {
      cmdTitle.textContent = 'error';
      cmdContent.className = 'cmd-content';
      cmdContent.innerHTML = '<pre style="color:#cf222e">'+esc(d.error)+'</pre>';
    } else if (d.kind === 'markdown') {
      cmdTitle.textContent = d.title || '';
      cmdContent.className = 'cmd-content md';
      cmdContent.innerHTML = marked.parse(d.content || '');
    } else if (d.kind === 'source') {
      cmdTitle.textContent = d.title || '';
      cmdContent.className = 'cmd-content code' + (d.lang === 'diff' ? ' diff' : '');
      var code = document.createElement('code');
      code.textContent = d.content || '';
      if (window.hljs) {
        try {
          var res = d.lang ? hljs.highlight(d.content || '', { language: d.lang, ignoreIllegals: true })
                           : hljs.highlightAuto(d.content || '');
          code.innerHTML = res.value; code.className = 'hljs';
        } catch(e) {}
      }
      var pre = document.createElement('pre'); pre.appendChild(code);
      cmdContent.innerHTML = ''; cmdContent.appendChild(pre);
    } else {
      cmdTitle.textContent = d.title || '';
      cmdContent.className = 'cmd-content';
      cmdContent.innerHTML = '<pre>'+esc(d.content||'')+'</pre>';
    }
    cmdBox.classList.remove('min', 'max');   // fresh output restores the default size
    cmdBox.classList.add('show');
    syncCmdBtns();
    cmdContent.scrollTop = 0;
  }
  function hideCmd() { cmdBox.classList.remove('show','min','max'); syncCmdBtns(); }
  // Same glyph language as the view bar: hollow square to maximize, filled to come back.
  function syncCmdBtns() {
    var on = cmdBox.classList.contains('max');
    var mx = body.querySelector('.cmd-btn[data-c="max"]');
    if (mx) { mx.innerHTML = on ? '&#10064;' : '&#9633;'; mx.title = on ? 'Restore' : 'Maximize'; }
  }
  body.querySelector('.cmd-btns').addEventListener('click', function(e){
    var b = e.target.closest('.cmd-btn');
    if (!b) return;
    if (b.dataset.c === 'min') { cmdBox.classList.toggle('min'); cmdBox.classList.remove('max'); }
    else if (b.dataset.c === 'max') { cmdBox.classList.toggle('max'); cmdBox.classList.remove('min'); }
    else hideCmd();
    syncCmdBtns();
  });
  sendBtn.addEventListener('click', sendMessage);
  inputBox.addEventListener('input', function(){ autoGrow(inputBox); });
  // Plain Enter is a newline: a prompt is usually several lines, and a stray Enter firing
  // one off half-written into a live session is not a recoverable mistake. Ctrl/Cmd+Enter
  // is the deliberate two-key send, same as the button.
  inputBox.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // — refresh / destroy —
  v.refresh = function(){
    transcript.innerHTML = '';
    msgEls = {}; toolEls = {}; seenUuids = {}; askCards = {}; lastUserTs = null; lastAsstTs = null; toolStart = {};
    statEls = {}; statTurnNo = {}; statTurns = 0; statSeenFirst = false;
    historyLoaded = false; pendingTranscript = []; pendingAsk = null;
    following = true; anchorEl = null;
    loadHistory();
    pollLive();
  };
  var livePollTimer = setInterval(pollLive, 4000);
  var drivePollTimer = setInterval(refreshDrivable, 5000);
  v.destroy = function(){
    destroyed = true;
    clearInterval(livePollTimer); clearInterval(drivePollTimer);
    clearTimeout(reconnectTimer);
    if (scrollObserver) { try { scrollObserver.disconnect(); } catch(e) {} }
    if (ws) { try { ws.close(); } catch(e) {} }
  };

  renderTitle();
  renderStats(INFO.stats);
  setStatus({ live: INFO.live, status: INFO.liveStatus, statusUpdatedAt: INFO.liveStatusAt });
  autoGrow(inputBox);
  refreshDrivable();
  connect();
  loadHistory();
  return v;
}

// ── boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', function(){
  if (!document.hidden) views.forEach(function(v){ if (v.onExpanded && !v.el.classList.contains('collapsed')) v.onExpanded(); });
});
var listView = createListView();
views.push(listView);
viewsEl.appendChild(listView.el);
relayout();
if (INIT_OPEN) openSession(INIT_OPEN.sessionId, INIT_OPEN.server);
`;

// ── Page HTML assembly ─────────────────────────────────────────────────────────
function appPageHtml(initOpenSessionId, initOpenServer) {
  const open = initOpenSessionId ? { sessionId: initOpenSessionId, server: initOpenServer || null } : null;
  return APP_HTML.replace('__APP_JS__',
    () => APP_JS
      .replace('__PRICING__', () => JSON.stringify(priceTable))
      .replace('__SELF__', () => JSON.stringify(serverIdentity()))
      .replace('__INIT_OPEN__', () => JSON.stringify(open)));
}

// ── Web: live transcript tailing (rides the shared tailer in ccbb-common) ────────
// Bridges the shared per-line tailer to a per-session dispatch. Reference-counted to
// MATCH startTail/stopTail exactly: several connections can watch one session (two tabs,
// or a page reload where the new socket connects before the old one closes), and a close
// must only drop the dispatch when it is the last watcher — an unconditional delete here
// left the tailer running but pushing into a missing entry, silently freezing transcript
// updates (ask cards, messages) while pane-scraped permission cards kept flowing.
// onEntry is the same broadcast closure for every connection of a session, so
// re-pointing it on each start is harmless.
const webWatchers = new Map();  // sessionId → { onEntry, refs }
function startWatching(sessionId, onEntry) {
  const w = webWatchers.get(sessionId);
  if (w) { w.refs++; w.onEntry = onEntry; }
  else webWatchers.set(sessionId, { onEntry, refs: 1 });
  startTail(sessionId, d => {
    const cur = webWatchers.get(sessionId);
    if (!cur) return;
    const e = transcriptEntry(d);
    if (e) cur.onEntry(e);
  });
}
function stopWatching(sessionId) {
  const w = webWatchers.get(sessionId);
  if (w && --w.refs <= 0) webWatchers.delete(sessionId);
  stopTail(sessionId);
}

// ── Claude Code hooks: peek at prompts (structured, replaces the pane scrape) ────
// When the hook installer has wired settings.json, Claude Code POSTs each interactive
// prompt to /api/hook the instant it appears — structured, no regex. We turn a
// PermissionRequest into the same {title, options} permission card the scrape produced, and
// a PreToolUse(AskUserQuestion) into the same ask card the transcript renders. Answering is
// unchanged (inject the option digit into the pane). The scrape stays as a fallback: it
// still SHOWS prompts the hooks don't cover (plan-mode, trust-folder) and CLEARS any card
// when the dialog vanishes — but it never overrides a card the hook already put up (see
// checkPrompt), so gating is per-prompt, not per-session.

// Reconstruct the permission dialog's option list from the hook payload. Claude's dialog
// always leads with the affirmative and ends with "No"; the middle "don't ask again" option
// exists exactly when the payload offers an allow-rule suggestion. The digit we send is the
// option's position, so this ordering must match the TUI.
function buildPermissionPrompt(evt) {
  const ti = evt.tool_input || {};
  const detail = ti.command || ti.file_path || ti.path || ti.url || ti.description || '';
  const title = evt.tool_name + (detail ? ': ' + String(detail) : '');
  const hasRule = Array.isArray(evt.permission_suggestions) && evt.permission_suggestions.length > 0;
  const options = hasRule
    ? [{ n: 1, label: 'Yes' }, { n: 2, label: "Yes, and don't ask again" }, { n: 3, label: 'No' }]
    : [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }];
  return { title, options };
}

function applyHookEvent(evt) {
  const sid = evt && evt.session_id;
  if (!sid) return;
  // AskUserQuestion → reuse the transcript's ask card; tool_use_id matches the block .id,
  // so the client's renderAskCard dedups against any inline copy and it self-settles.
  if (evt.hook_event_name === 'PreToolUse' && evt.tool_name === 'AskUserQuestion') {
    if (!evt.tool_use_id || !evt.tool_input) return;
    wsBroadcast(sid, { type: 'ask_block', block: { id: evt.tool_use_id, name: 'AskUserQuestion', input: evt.tool_input } });
    return;
  }
  if (evt.hook_event_name === 'PermissionRequest') {
    if (evt.tool_name === 'AskUserQuestion') return;   // handled via PreToolUse above
    const loc = paneForSession(sid);
    if (!loc) return;   // not drivable here → can't answer, so don't show a dead card
    const { title, options } = buildPermissionPrompt(evt);
    const fp = promptFingerprint({ title, options });
    const prev = activePrompts.get(sid);
    if (prev && prev.fp === fp) return;
    if (prev) wsBroadcast(sid, { type: 'permission_clear', fp: prev.fp });
    activePrompts.set(sid, { fp, title, options, pane: loc.pane, source: 'hook' });
    wsBroadcast(sid, { type: 'permission', fp, title, options });
  }
}

// ── Permission prompt scraping (tmux pane → WebSocket push) ─────────────────────
// The permission dialog is drawn only in the terminal — it never reaches the JSONL. We
// stream the pane via `tmux pipe-pane` and watch the log with fs.watch (push, not
// polling); on output we capture the pane once, detect the box, and broadcast it to the
// browser as a permission frame. The browser answers by POSTing an option number, which
// we inject back into the pane.
const activePrompts = new Map();   // sessionId → { fp, title, options:[{n,label}], pane, source }
const paneWatchers = new Map();    // sessionId → { pane, logPath, watcher, debounce }
const scrapeDeferred = new Map();  // sessionId → timer: scrape waiting to see if a hook claims it

function watchLogPath(sessionId) {
  return path.join(os.tmpdir(), `ccbb-pane-${sessionId}.log`);
}

// Inspect the pane now: broadcast a new box, or clear a vanished one.
function checkPrompt(sessionId, pane) {
  const parsed = parsePrompt(capturePane(pane));
  const prev = activePrompts.get(sessionId);
  if (!parsed) {
    // Dialog gone → clear whatever's showing, hook-sourced or scraped (covers a terminal
    // answer). This is the scrape's job even when hooks put the card up.
    const t = scrapeDeferred.get(sessionId);
    if (t) { clearTimeout(t); scrapeDeferred.delete(sessionId); }
    if (prev) { activePrompts.delete(sessionId); wsBroadcast(sessionId, { type: 'permission_clear', fp: prev.fp }); }
    return;
  }
  if (prev || scrapeDeferred.has(sessionId)) return;   // a card is up, or we're already waiting
  // Defer: give an installed hook ~300ms to claim this prompt with richer, structured
  // content (making the hook primary). If none does — plan-mode / trust-folder prompts the
  // hook doesn't fire for, or hooks not installed — the scrape shows it as the fallback.
  const timer = setTimeout(() => {
    scrapeDeferred.delete(sessionId);
    if (activePrompts.has(sessionId)) return;   // a hook claimed it
    const p2 = parsePrompt(capturePane(pane));
    if (!p2) return;
    const fp = promptFingerprint(p2);
    activePrompts.set(sessionId, { fp, title: p2.title, options: p2.options, pane, source: 'scrape' });
    wsBroadcast(sessionId, { type: 'permission', fp, title: p2.title, options: p2.options });
  }, 300);
  scrapeDeferred.set(sessionId, timer);
}

// Start (or re-point) the pane watcher for a session. Idempotent per pane.
function startPaneWatch(sessionId, pane) {
  const existing = paneWatchers.get(sessionId);
  if (existing) { if (existing.pane === pane) return; stopPaneWatch(sessionId); }
  const logPath = watchLogPath(sessionId);
  try {
    fs.writeFileSync(logPath, '');
    tmux(['pipe-pane', '-t', pane, '-o', `cat >> ${logPath}`]);
  } catch (e) { console.error('[perm] pipe-pane failed:', e.message); return; }
  const rec = { pane, logPath, watcher: null, debounce: null };
  try {
    rec.watcher = fs.watch(logPath, () => {
      clearTimeout(rec.debounce);
      rec.debounce = setTimeout(() => { try { checkPrompt(sessionId, pane); } catch (e) { console.error('[perm] check:', e.message); } }, 150);
    });
  } catch (e) { console.error('[perm] watch failed:', e.message); }
  paneWatchers.set(sessionId, rec);
  setTimeout(() => { try { checkPrompt(sessionId, pane); } catch {} }, 200);
}

function stopPaneWatch(sessionId) {
  const rec = paneWatchers.get(sessionId);
  if (!rec) return;
  paneWatchers.delete(sessionId);
  clearTimeout(rec.debounce);
  const st = scrapeDeferred.get(sessionId);
  if (st) { clearTimeout(st); scrapeDeferred.delete(sessionId); }
  if (rec.watcher) { try { rec.watcher.close(); } catch {} }
  try { tmux(['pipe-pane', '-t', rec.pane]); } catch {}
  try { fs.unlinkSync(rec.logPath); } catch {}
  activePrompts.delete(sessionId);
}

// Answer the open prompt by injecting the option number + Enter into the pane.
function answerPrompt(sessionId, choice) {
  const p = activePrompts.get(sessionId);
  if (!p) return { error: 'No prompt is open' };
  if (!p.options.some(o => o.n === choice)) return { error: 'Not a valid option' };
  try {
    tmux(['send-keys', '-t', p.pane, String(choice)]);
    tmux(['send-keys', '-t', p.pane, 'Enter']);
  } catch (e) { return { error: e.message }; }
  activePrompts.delete(sessionId);
  wsBroadcast(sessionId, { type: 'permission_clear', fp: p.fp });
  return { ok: true };
}

// Answer an open AskUserQuestion by driving the pane. `answers` is one entry per question:
//   { choice:n }    pick one predefined option (single-select)
//   { choices:[…] } toggle several options (multiSelect question)
//   { text:"…" }    a custom "Type something" answer
// Protocol verified against the TUI: a single-select digit picks + auto-advances; a
// multiSelect toggles each digit then Right advances; "<options+1>" + text + Enter enters a
// custom answer. A lone single-select question submits on Enter; anything else — a series, or
// any multiSelect question — ends on the Submit tab, confirmed with "1". Keystrokes are sent
// in question order from the fresh dialog.
function answerAsk(sessionId, answers) {
  const ask = openAskEntry(getSessionHistory(sessionId));
  if (!ask) return { error: 'No question is open (already answered?)' };
  const qs = askQuestions(ask.input);
  if (!Array.isArray(answers) || answers.length !== qs.length)
    return { error: `Answer all ${qs.length} question${qs.length === 1 ? '' : 's'}` };
  const submitViaTab = qs.length > 1 || qs.some(q => q.multiSelect);
  const ops = [];   // ordered keystrokes: { key } (a key/digit) or { text } (literal text)
  for (let i = 0; i < qs.length; i++) {
    const a = answers[i] || {}, q = qs[i];
    if (q.multiSelect) {
      const choices = Array.isArray(a.choices) ? a.choices.map(Number)
        : a.choice != null ? [Number(a.choice)] : [];
      if (!choices.length) return { error: 'Pick at least one option for question ' + (i + 1) };
      for (const c of choices) {
        if (!q.options.some(o => o.n === c)) return { error: 'Invalid option for question ' + (i + 1) };
        ops.push({ key: String(c) });                    // toggle the checkbox
      }
      ops.push({ key: 'Right' });                        // done toggling → advance to next tab
    } else if (a.text != null && String(a.text).length) {
      ops.push({ key: String(q.options.length + 1) });   // "Type something" is after the options
      ops.push({ text: String(a.text) });
      ops.push({ key: 'Enter' });                        // confirm the custom answer (advance/submit)
    } else {
      const n = Number(a.choice);
      if (!q.options.some(o => o.n === n)) return { error: 'Invalid option for question ' + (i + 1) };
      ops.push({ key: String(n) });                      // pick + auto-advance
      if (!submitViaTab) ops.push({ key: 'Enter' });     // lone single-select submits on Enter
    }
  }
  if (submitViaTab) ops.push({ key: '1' });               // confirm on the Submit tab
  const loc = paneForSession(sessionId);
  if (!loc) return { error: 'Session is not running in a tmux pane on this host' };
  try {
    for (const op of ops) {
      if (op.text != null) tmux(['send-keys', '-t', loc.pane, '-l', op.text]);
      else tmux(['send-keys', '-t', loc.pane, op.key]);
    }
  } catch (e) { return { error: e.message }; }
  return { ok: true };
}

// ── HTTP + WebSocket server ────────────────────────────────────────────────────
function send(res, code, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': body.length });
  res.end(body);
}
function sendHtml(res, html) {
  const body = Buffer.from(html);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, done) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 8 * 1024 * 1024) req.destroy(); });
  req.on('end', () => done(body));
}

// ── Peers: auth, health, proxy ─────────────────────────────────────────────────
// Multi-server ccbb is a mesh of equals. This server serves ITS OWN sessions under
// /api/… and every peer's under /peer/<name>/api/… — the same routes, reverse-proxied
// by name. The browser therefore drives a remote session through exactly the code
// path it uses for a local one: only a prefix differs.
//
// /peer/<name>/session/<id> is the one exception — it is a deep LINK, served locally
// as this app's page, because proxying it would return the peer's whole app.
const TOKEN_HEADER = 'x-ccbb-token';
const VIA_HEADER = 'x-ccbb-via';
const LEGACY_COOKIE = 'ccbb_token';
// Cookies are scoped to the HOST, not the origin — the port is ignored — so several ccbb
// servers reached as 127.0.0.1:<port> (your own, plus every peer you tunnel to a local
// port) would all read and overwrite one another's cookie, and logging into one would log
// you out of the next. Naming the cookie after the port keeps them separate.
//
// The port must come from the REQUEST's Host header, not from what we listen on: every
// ccbb tends to listen on 8590, and a peer tunnelled to the browser as 127.0.0.1:8591 is
// still :8590 on its own host. Two servers both naming their cookie after 8590 would
// collide all over again. The Host header is what the browser actually typed, so it is
// the only value that is unique per login.
let serverPort = DEFAULT_PORT;
function tokenCookieName(req) {
  const m = String((req && req.headers && req.headers.host) || '').match(/:(\d+)$/);
  return LEGACY_COOKIE + '_' + (m ? m[1] : serverPort);
}

function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + tokenCookieName(req) + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
// Auth, when config sets peerToken. The token can arrive as a header (peer proxies and
// the hook curl), a cookie (the browser, after one ?token=… visit), or a query param.
// Unset peerToken = no auth at all, which is the pre-existing single-host behavior.
function authOk(req, query) {
  const want = peerToken();
  if (!want) return true;
  const got = req.headers[TOKEN_HEADER] || (query && query.get('token')) || cookieToken(req);
  return !!got && safeEq(got, want);
}
function sendUnauthorized(res, wantsHtml, cookieName) {
  if (wantsHtml) {
    const body = Buffer.from('<!DOCTYPE html><meta charset="utf-8"><title>ccbb</title>' +
      '<body style="font:15px ui-sans-serif,system-ui;padding:40px;color:#3d3d3a">' +
      '<h2>ccbb — token required</h2><p>This server has <code>peerToken</code> set. ' +
      'Open it once as <code>?token=&lt;your token&gt;</code>; the token is then remembered in a cookie ' +
      `(<code>${cookieName}</code>, named per port so each ccbb server keeps its own).</p>`);
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length });
    return res.end(body);
  }
  send(res, 401, { error: 'unauthorized' });
}

// Peer health. Polled in the background so /api/servers answers instantly and a dead
// peer shows as down instead of hanging the session list behind a TCP timeout.
const peerHealth = new Map();   // name → { status, hostname, rttMs, lastSeen, error }
function peerRequest(peer, subPath, opts, cb) {
  const target = new URL(peer.url + subPath);
  const mod = target.protocol === 'https:' ? https : http;
  const headers = Object.assign({}, opts.headers || {});
  headers.host = target.host;
  if (peer.token) headers[TOKEN_HEADER] = peer.token;
  headers[VIA_HEADER] = serverIdentity().name;
  return mod.request(target, { method: opts.method || 'GET', headers, timeout: opts.timeout || 0 }, cb);
}
function probePeer(peer) {
  const started = Date.now();
  let done = false;
  const finish = rec => { if (done) return; done = true; peerHealth.set(peer.name, rec); };
  const req = peerRequest(peer, '/api/identity', { timeout: 5000 }, res => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', c => { buf += c; });
    res.on('end', () => {
      let id = null; try { id = JSON.parse(buf); } catch {}
      if (res.statusCode === 401) return finish({ status: 'down', error: 'unauthorized (token mismatch)', rttMs: Date.now() - started });
      if (res.statusCode !== 200 || !id || !id.name) return finish({ status: 'down', error: 'HTTP ' + res.statusCode, rttMs: Date.now() - started });
      finish({ status: 'up', hostname: id.hostname || '', remoteName: id.name, rttMs: Date.now() - started, lastSeen: new Date().toISOString() });
    });
  });
  req.on('timeout', () => { req.destroy(new Error('timed out')); });
  req.on('error', e => finish({ status: 'down', error: e.message, rttMs: Date.now() - started }));
  req.end();
}
function pollPeers() { for (const p of peerList()) probePeer(p); }
// Merged view of the mesh: this server first, then every configured peer with its last
// known health. `hostname` is what the PEER reported about itself, not what we guessed.
function serversPayload() {
  const self = serverIdentity();
  const list = [{ name: self.name, hostname: self.hostname, self: true, status: 'up' }];
  for (const p of peerList()) {
    const h = peerHealth.get(p.name) || { status: 'unknown' };
    list.push({
      name: p.name, self: false, url: p.url,
      hostname: h.hostname || '', remoteName: h.remoteName || '',
      status: h.status, rttMs: h.rttMs, lastSeen: h.lastSeen, error: h.error,
    });
  }
  // Peers we never configured, reachable only because they called us and left a link
  // open. As far as the UI is concerned they are ordinary peers.
  for (const [name, link] of inboundLinks) {
    if (list.some(x => x.name === name)) continue;   // already configured — that route wins
    list.push({ name, self: false, inbound: true, hostname: '',
      status: link.ws.readyState === 1 ? 'up' : 'down' });
  }
  return { self, servers: list };
}

// Reverse-proxy one request to a peer. Hop-by-hop and auth headers are rebuilt rather
// than forwarded: our cookie is OUR token, and the peer wants ITS token.
function proxyHttp(peer, subPath, req, res) {
  const headers = {};
  for (const k of ['content-type', 'accept']) if (req.headers[k]) headers[k] = req.headers[k];
  const preq = peerRequest(peer, subPath, { method: req.method, headers, timeout: 30000 }, pres => {
    const out = {};
    for (const k of ['content-type', 'content-length', 'cache-control']) if (pres.headers[k]) out[k] = pres.headers[k];
    res.writeHead(pres.statusCode || 502, out);
    pres.pipe(res);
  });
  preq.on('timeout', () => preq.destroy(new Error('timed out')));
  preq.on('error', e => {
    if (!res.headersSent) send(res, 502, { error: `peer "${peer.name}" unreachable: ${e.message}` });
    else res.destroy();
  });
  req.pipe(preq);
}
// Proxy a WebSocket upgrade: dial the peer, replay the handshake, then splice the two
// sockets. Keeps live transcript tailing and permission cards working for remote sessions.
function proxyUpgrade(peer, subPath, req, socket, head) {
  const headers = {};
  for (const k of ['upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version',
                   'sec-websocket-protocol', 'sec-websocket-extensions']) {
    if (req.headers[k]) headers[k] = req.headers[k];
  }
  const preq = peerRequest(peer, subPath, { method: 'GET', headers, timeout: 15000 }, () => socket.destroy());
  preq.on('upgrade', (pres, psock, phead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (const [k, v] of Object.entries(pres.headers)) lines.push(`${k}: ${v}`);
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (phead && phead.length) socket.write(phead);
    if (head && head.length) psock.write(head);
    const kill = () => { try { socket.destroy(); } catch {} try { psock.destroy(); } catch {} };
    socket.on('error', kill); psock.on('error', kill);
    socket.on('close', kill); psock.on('close', kill);
    psock.pipe(socket); socket.pipe(psock);
  });
  preq.on('timeout', () => preq.destroy(new Error('timed out')));
  preq.on('error', () => socket.destroy());
  preq.end();
}

// ── Peer links: making an INBOUND peer a real peer ─────────────────────────────
// A configured peer is reachable because we hold its URL. The reverse is not true: the
// server we call has no address for us — over an ssh tunnel our side has no listening
// address in its namespace at all — so a peer that only ever calls IN could never be
// browsed back. Adding config on both sides would fix it, but only for people who can
// open a tunnel each way.
//
// Instead, the CALLER keeps a WebSocket open to every peer it knows (/peer-link). The
// callee then sends requests back DOWN that socket. One direction of connectivity is
// enough for a two-way mesh, and the receiving side needs no configuration at all.
//
// The trick that keeps this small: a link is just a tunnel to the caller's OWN server.
// On receiving a request the caller replays it against 127.0.0.1:<its port> and pipes the
// answer back — so every route, including the live-tailing WebSocket, works over a link
// exactly as it does over HTTP, with no second implementation to keep in step.
const inboundLinks = new Map();   // name → link we ACCEPTED (we can call them back)
const outboundLinks = new Map();  // name → { ws, timer } we OPENED to a configured peer

function makeLink(ws, name) {
  const link = { name, ws, seq: 0, pending: new Map(), sockets: new Map(), openedAt: Date.now() };
  ws.on('message', raw => {
    let f; try { f = JSON.parse(raw); } catch { return; }
    try { handleLinkFrame(link, f); } catch (e) { console.error('[link]', e.message); }
  });
  const drop = () => {
    for (const cb of link.pending.values()) cb({ status: 502, body: JSON.stringify({ error: `link to "${name}" closed` }) });
    link.pending.clear();
    for (const s of link.sockets.values()) { try { s.close(); } catch {} }
    link.sockets.clear();
  };
  ws.on('close', drop);
  ws.on('error', drop);
  return link;
}
function linkSend(link, obj) {
  if (link.ws.readyState !== 1) return false;
  try { link.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
}
// Ask the peer on the other end of this link to run an HTTP request against itself.
function linkRequest(link, method, path, body) {
  return new Promise(resolve => {
    const id = ++link.seq;
    const timer = setTimeout(() => {
      link.pending.delete(id);
      resolve({ status: 504, body: JSON.stringify({ error: `peer "${link.name}" timed out` }) });
    }, 30000);
    link.pending.set(id, res => { clearTimeout(timer); resolve(res); });
    if (!linkSend(link, { t: 'req', id, method, path, body: body || '' })) {
      clearTimeout(timer); link.pending.delete(id);
      resolve({ status: 502, body: JSON.stringify({ error: `link to "${link.name}" is down` }) });
    }
  });
}

// Frames. Requests/opens flow callee→caller; responses and socket traffic flow back.
function handleLinkFrame(link, f) {
  if (f.t === 'res') {
    const cb = link.pending.get(f.id);
    if (cb) { link.pending.delete(f.id); cb({ status: f.status, ctype: f.ctype, body: f.body }); }
    return;
  }
  if (f.t === 'req') return serveLinkRequest(link, f);
  if (f.t === 'wsopen') return serveLinkWsOpen(link, f);
  if (f.t === 'wsmsg') {
    const s = link.sockets.get(f.id);
    if (s) { if (s.onRemote) s.onRemote(f.data); else if (s.readyState === 1) { try { s.send(f.data); } catch {} } }
    return;
  }
  if (f.t === 'wsclose') {
    const s = link.sockets.get(f.id);
    link.sockets.delete(f.id);
    if (s) { if (s.onRemoteClose) s.onRemoteClose(); else { try { s.close(); } catch {} } }
  }
}

// ── caller side: replay what came down the link against our own server ──
function loopbackHeaders() {
  const h = { 'content-type': 'application/json' };
  const tok = peerToken();
  if (tok) h[TOKEN_HEADER] = tok;
  return h;
}
function serveLinkRequest(link, f) {
  // A link reaches OUR sessions, never onward to our peers — that would be a second hop
  // with no loop guard, since link traffic carries no X-Ccbb-Via.
  if (/^\/peer\//.test(f.path)) {
    return linkSend(link, { t: 'res', id: f.id, status: 403, body: JSON.stringify({ error: 'peer links are one hop' }) });
  }
  const req = http.request({ host: '127.0.0.1', port: serverPort, path: f.path, method: f.method,
    headers: loopbackHeaders(), timeout: 30000 }, res => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', c => { buf += c; });
    res.on('end', () => linkSend(link, { t: 'res', id: f.id, status: res.statusCode, ctype: res.headers['content-type'], body: buf }));
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', e => linkSend(link, { t: 'res', id: f.id, status: 502, body: JSON.stringify({ error: e.message }) }));
  if (f.body) req.write(f.body);
  req.end();
}
function serveLinkWsOpen(link, f) {
  if (!WS) return linkSend(link, { t: 'wsclose', id: f.id });
  let ws;
  try {
    ws = new WS('ws://127.0.0.1:' + serverPort + f.path, { headers: loopbackHeaders() });
  } catch { return linkSend(link, { t: 'wsclose', id: f.id }); }
  link.sockets.set(f.id, ws);
  ws.on('message', d => linkSend(link, { t: 'wsmsg', id: f.id, data: String(d) }));
  ws.on('close', () => { link.sockets.delete(f.id); linkSend(link, { t: 'wsclose', id: f.id }); });
  ws.on('error', () => { link.sockets.delete(f.id); linkSend(link, { t: 'wsclose', id: f.id }); });
}

// ── callee side: serve a browser request/upgrade by going out over the link ──
function proxyHttpOverLink(link, subPath, req, res) {
  readBody(req, async body => {
    const r = await linkRequest(link, req.method, subPath, body);
    const out = { 'Content-Type': r.ctype || 'application/json' };
    const buf = Buffer.from(r.body == null ? '' : String(r.body));
    out['Content-Length'] = buf.length;
    res.writeHead(r.status || 502, out);
    res.end(buf);
  });
}
function proxyUpgradeOverLink(link, subPath, req, socket, head) {
  if (!WS) return socket.destroy();
  const wss = new WS.Server({ noServer: true });
  wss.handleUpgrade(req, socket, head, browser => {
    const id = ++link.seq;
    const entry = {
      onRemote: d => { if (browser.readyState === 1) try { browser.send(d); } catch {} },
      onRemoteClose: () => { try { browser.close(); } catch {} },
      close: () => { try { browser.close(); } catch {} },
    };
    link.sockets.set(id, entry);
    if (!linkSend(link, { t: 'wsopen', id, path: subPath })) return browser.close();
    browser.on('message', d => linkSend(link, { t: 'wsmsg', id, data: String(d) }));
    browser.on('close', () => { link.sockets.delete(id); linkSend(link, { t: 'wsclose', id }); });
    browser.on('error', () => { link.sockets.delete(id); linkSend(link, { t: 'wsclose', id }); });
  });
}

// ── caller side: keep a link open to every configured peer ──
function connectLink(peer) {
  if (!WS) return;
  const existing = outboundLinks.get(peer.name);
  if (existing && existing.ws && existing.ws.readyState <= 1) return;   // connecting or open
  const url = peer.url.replace(/^http/, 'ws') + '/peer-link?name=' + encodeURIComponent(serverIdentity().name);
  const headers = {};
  if (peer.token) headers[TOKEN_HEADER] = peer.token;
  let ws;
  try { ws = new WS(url, { headers }); } catch { return; }
  const rec = { ws, ping: null };
  outboundLinks.set(peer.name, rec);
  ws.on('open', () => {
    makeLink(ws, peer.name);
    // A link can sit idle for hours; keep it warm so an idle tunnel can't drop it silently.
    rec.ping = setInterval(() => { try { ws.ping(); } catch {} }, 30000);
    if (rec.ping.unref) rec.ping.unref();
  });
  // Forget this attempt ONLY if the map still holds it. A later attempt may already have
  // replaced it, and deleting that one would strand a healthy link and set off a redial
  // loop: poll dials again, the peer drops the socket it had as superseded, repeat.
  // pollLinks provides the retry cadence, so there is no timer here to go stale.
  const gone = () => {
    if (rec.ping) { clearInterval(rec.ping); rec.ping = null; }
    if (outboundLinks.get(peer.name) === rec) outboundLinks.delete(peer.name);
  };
  ws.on('close', gone);
  ws.on('error', gone);
}
function pollLinks() { for (const p of peerList()) connectLink(p); }

function runWeb(args) {
  let port = DEFAULT_PORT;
  let withWebex = false, withConfluence = false;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) port = parseInt(args[++i], 10);
    else if (args[i] === '--webex') withWebex = true;
    else if (args[i] === '--confluence') withConfluence = true;
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`ccbb web — web UI\n\nUsage: ccbb web [-p port] [--webex] [--confluence]\n\n` +
        `  --webex        also run the Webex front-end (shares this server's prompt path)\n` +
        `  --confluence   also run the Confluence page front-end\n\n` +
        `Multi-server: set "server".name and "peers" in ${CLAUDE_DIR}/ccbb-config.json to list\n` +
        `and drive other machines' sessions from this UI. See peers.md.`);
      return;
    }
  }

  serverPort = port;   // the cookie is named after it, so it must be set before we listen

  const server = http.createServer((req, res) => {
    const { method } = req;
    const pathname = req.url.split('?')[0];
    const qs = req.url.split('?')[1] || '';
    const query = new URLSearchParams(qs);
    let m;

    const isPage = method === 'GET' && (pathname === '/' || pathname === '/index.html' ||
      /^\/session\/[^/]+$/.test(pathname) || /^\/peer\/[^/]+\/session\/[^/]+$/.test(pathname));
    if (!authOk(req, query)) return sendUnauthorized(res, isPage, tokenCookieName(req));
    // A page opened as ?token=… banks the token in a cookie and reloads clean, so the
    // secret stops riding in the URL bar (and in every link copied out of it).
    if (isPage && peerToken() && query.get('token')) {
      const rest = new URLSearchParams(qs); rest.delete('token');
      const loc = pathname + (rest.toString() ? '?' + rest.toString() : '');
      res.writeHead(302, {
        // The second cookie expires the pre-port-scoped one, so a browser that already
        // has a shared ccbb_token from another server stops carrying it around.
        'Set-Cookie': [
          `${tokenCookieName(req)}=${encodeURIComponent(query.get('token'))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
          `${LEGACY_COOKIE}=; Path=/; Max-Age=0`,
        ],
        Location: loc,
      });
      return res.end();
    }

    // ── peer mesh ──
    if (method === 'GET' && pathname === '/api/identity') {
      const self = serverIdentity();
      return send(res, 200, { name: self.name, hostname: self.hostname, port, version: VERSION });
    }
    if (method === 'GET' && pathname === '/api/servers') return send(res, 200, serversPayload());
    if ((m = pathname.match(/^\/peer\/([^/]+)(\/.*)$/))) {
      const name = decodeURIComponent(m[1]);
      const peer = peerByName(name);
      const link = peer ? null : inboundLinks.get(name);   // configured URL wins; else call back down their link
      if (!peer && !link) return send(res, 404, { error: `unknown server "${name}"` });
      // One hop only. A request that already came through a peer's proxy must not be
      // forwarded again, or a peers-of-peers cycle would bounce forever.
      if (req.headers[VIA_HEADER]) return send(res, 403, { error: 'peer proxying is one hop' });
      const sub = m[2];
      // Deep link into a remote session: OUR page, remembering which server it lives on.
      if (method === 'GET' && (m = sub.match(/^\/session\/([^/]+)$/)))
        return sendHtml(res, appPageHtml(m[1], name));
      const full = sub + (qs ? '?' + qs : '');
      return peer ? proxyHttp(peer, full, req, res) : proxyHttpOverLink(link, full, req, res);
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) return sendHtml(res, appPageHtml(null));
    if (method === 'GET' && pathname === '/api/sessions') {
      const mk = query.get('month');
      const filter = mk && /^\d{4}-\d{2}$/.test(mk) ? { period: 'month', key: mk } : null;
      return send(res, 200, getSessions(filter));
    }
    if (method === 'GET' && pathname === '/api/cost-summary') return send(res, 200, getCostSummary());
    if (method === 'GET' && (m = pathname.match(/^\/session\/([^/]+)$/)))
      return sendHtml(res, appPageHtml(m[1]));   // deep link: app with this session opened
    if (method === 'GET' && (m = pathname.match(/^\/api\/session-info\/([^/]+)$/)))
      return send(res, 200, getSessionInfo(m[1]));
    if (method === 'GET' && (m = pathname.match(/^\/api\/session\/([^/]+)\/history$/)))
      return send(res, 200, { history: getSessionHistory(m[1]) });
    if (method === 'GET' && (m = pathname.match(/^\/api\/session\/([^/]+)\/subagent\/([^/]+)$/)))
      return send(res, 200, { history: getSubagentHistory(m[1], m[2]) });
    // Claude Code prompt-capture hooks POST here (permission dialogs, AskUserQuestion).
    if (method === 'POST' && pathname === '/api/hook') {
      readBody(req, body => {
        let evt; try { evt = JSON.parse(body || '{}'); } catch { evt = null; }
        if (evt) { try { applyHookEvent(evt); } catch (e) { console.error('[hook]', e.message); } }
        send(res, 200, { ok: true });
      });
      return;
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/session\/([^/]+)\/live$/)))
      return send(res, 200, sessionLiveness(m[1]));
    if (method === 'GET' && (m = pathname.match(/^\/api\/session\/([^/]+)\/stats$/)))
      return send(res, 200, getSessionStats(m[1]));
    if (method === 'GET' && (m = pathname.match(/^\/api\/session\/([^/]+)\/pane$/))) {
      const loc = paneForSession(m[1]);
      return send(res, 200, { pane: loc ? loc.pane : null });
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/session\/([^/]+)\/input$/))) {
      readBody(req, body => {
        let text;
        try { text = String(JSON.parse(body || '{}').text || ''); } catch { text = ''; }
        if (!text.trim()) return send(res, 400, { error: 'text required' });
        const loc = paneForSession(m[1]);
        if (!loc) return send(res, 409, { error: 'Session is not running in a tmux pane on this host' });
        try { injectToPane(loc.pane, text); startPaneWatch(m[1], loc.pane); send(res, 200, { ok: true }); }
        catch (e) { send(res, 500, { error: e.message }); }
      });
      return;
    }
    // Answer an open AskUserQuestion dialog. Validity comes from the transcript (the
    // question rides in the tool_use; the dialog is open while that's the last entry),
    // so a stale button can't type digits into the session's composer.
    if (method === 'POST' && (m = pathname.match(/^\/api\/session\/([^/]+)\/ask$/))) {
      readBody(req, body => {
        let b; try { b = JSON.parse(body || '{}'); } catch { b = {}; }
        // {answers:[…]} is the full per-question form; {choice}/{text} stay valid for one question.
        const answers = Array.isArray(b.answers) ? b.answers
          : b.choice != null ? [{ choice: Number(b.choice) }]
          : b.text != null ? [{ text: String(b.text) }] : null;
        if (!answers) return send(res, 400, { error: 'answers required' });
        const r = answerAsk(m[1], answers);
        send(res, r.ok ? 200 : 409, r);
      });
      return;
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/session\/([^/]+)\/permission$/))) {
      readBody(req, body => {
        let choice;
        try { choice = Number(JSON.parse(body || '{}').choice); } catch { choice = NaN; }
        if (!Number.isFinite(choice)) return send(res, 400, { error: 'choice required' });
        const r = answerPrompt(m[1], choice);
        send(res, r.ok ? 200 : 409, r);
      });
      return;
    }
    if (method === 'POST' && (m = pathname.match(/^\/api\/session\/([^/]+)\/command$/))) {
      readBody(req, body => {
        let name, args, cwd;
        try { const b = JSON.parse(body || '{}'); name = b.name; args = b.args || ''; cwd = b.cwd || ''; }
        catch { return send(res, 400, { error: 'bad request' }); }
        if (!name) return send(res, 400, { error: 'name required' });
        send(res, 200, runCommand(m[1], name, args, cwd));
      });
      return;
    }
    if (method === 'PATCH' && (m = pathname.match(/^\/api\/session\/([^/]+)$/))) {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        let title;
        try { title = (JSON.parse(body || '{}').title || '').trim(); } catch { title = ''; }
        if (!title) return send(res, 400, { error: 'title required' });
        const r = renameSession(m[1], title);
        send(res, r.ok ? 200 : 404, r);
      });
      return;
    }
    send(res, 404, { error: 'Not found' });
  });

  server.listen(port, '127.0.0.1', () => {
    const self = serverIdentity();
    console.log(`ccbb http://127.0.0.1:${port}  (server "${self.name}" on ${self.hostname})`);
    const peers = peerList();
    if (peers.length) console.log(`ccbb peers: ${peers.map(p => p.name + ' → ' + p.url).join(', ')}`);
    if (peerToken()) console.log('ccbb: peerToken set — open the UI once as ?token=<token>');
  });
  // Peer health runs on a timer so /api/servers never blocks on a dead tunnel.
  pollPeers();
  pollLinks();
  setInterval(() => { pollPeers(); pollLinks(); }, 15000).unref();

  // Optional in-process front-ends. They subscribe to the event bus (onServerEvent) and
  // drive sessions via the exported answer/inject/command helpers, so the permission path
  // (hooks + scrape) is shared — no separate scraper. Loaded lazily so a missing optional
  // dep (e.g. webex-node-bot-framework) only affects the flag that needs it.
  const hostApi = module.exports;
  if (withConfluence) {
    try { require('./ccbb-confluence').attachConfluence(hostApi); }
    catch (e) { console.error('ccbb: --confluence failed:', e.message); }
  }
  if (withWebex) {
    try { require('./ccbb-webex').attachWebex(hostApi); }
    catch (e) { console.error('ccbb: --webex failed:', e.message); }
  }

  if (WS) {
    const wss = new WS.Server({ noServer: true });
    const clients = new Map(); // sessionId -> Set<ws>
    const sendTo = (sessionId, obj) => {
      const set = clients.get(sessionId);
      if (!set) return;
      const json = JSON.stringify(obj);
      for (const c of set) if (c.readyState === 1) c.send(json);
    };
    wsSend = sendTo;
    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      if (!authOk(req, new URLSearchParams(url.split('?')[1] || ''))) return socket.destroy();
      // A peer opening its reverse channel to us. It authenticated above like any other
      // request; from here on we can call back into it whenever the UI asks.
      if (/^\/peer-link(\?|$)/.test(url)) {
        const name = new URLSearchParams(url.split('?')[1] || '').get('name');
        if (!name || name === serverIdentity().name) return socket.destroy();
        return wss.handleUpgrade(req, socket, head, ws => {
          const prev = inboundLinks.get(name);
          if (prev && prev.ws !== ws) { try { prev.ws.close(); } catch {} }
          const link = makeLink(ws, name);
          inboundLinks.set(name, link);
          console.log(`ccbb: peer "${name}" linked in`);
          const bye = () => { if (inboundLinks.get(name) === link) inboundLinks.delete(name); };
          ws.on('close', bye); ws.on('error', bye);
        });
      }
      const pm = url.match(/^\/peer\/([^/]+)(\/.*)$/);
      if (pm) {
        const name = decodeURIComponent(pm[1]);
        if (req.headers[VIA_HEADER]) return socket.destroy();
        const peer = peerByName(name);
        if (peer) return proxyUpgrade(peer, pm[2], req, socket, head);
        const link = inboundLinks.get(name);
        if (!link) return socket.destroy();
        return proxyUpgradeOverLink(link, pm[2], req, socket, head);
      }
      const m = url.match(/^\/ws\/([^/?]+)/);
      if (!m) return socket.destroy();
      wss.handleUpgrade(req, socket, head, ws => {
        const sessionId = m[1];
        if (!clients.has(sessionId)) clients.set(sessionId, new Set());
        clients.get(sessionId).add(ws);
        startWatching(sessionId, e => sendTo(sessionId, { type: 'transcript', entry: e }));
        const loc = paneForSession(sessionId);
        if (loc) startPaneWatch(sessionId, loc.pane);
        // Permission prompts are scraped from the pane, not the JSONL, so a freshly-opened
        // view can't recover one from /history. And a prompt already on screen won't
        // re-broadcast: startPaneWatch is idempotent and checkPrompt dedups by fingerprint.
        // So replay the current prompt straight to THIS socket — otherwise a view opened
        // (or reloaded) while a bash approval is pending would silently miss it.
        const ap = activePrompts.get(sessionId);
        if (ap) { try { ws.send(JSON.stringify({ type: 'permission', fp: ap.fp, title: ap.title, options: ap.options })); } catch {} }
        // Same story for an open AskUserQuestion: the PreToolUse hook broadcasts it once, so a
        // view opened/reconnected after the dialog appeared would miss it and only recover on a
        // full history reload. The open ask lives in the JSONL — replay it straight to THIS
        // socket. renderAskCard dedups by tool_use id, so the transcript copy won't double it.
        try {
          const ask = openAskEntry(getSessionHistory(sessionId));
          if (ask) ws.send(JSON.stringify({ type: 'ask_block', block: { id: ask.id, name: 'AskUserQuestion', input: ask.input } }));
        } catch {}
        ws.on('close', () => {
          const set = clients.get(sessionId);
          if (set) { set.delete(ws); if (!set.size) { clients.delete(sessionId); stopPaneWatch(sessionId); } }
          stopWatching(sessionId);
        });
      });
    });
  } else {
    console.error('ccbb: optional dependency "ws" not found — live tailing disabled (history still loads).');
  }

  return server;
}

module.exports = {
  runWeb, DEFAULT_PORT,
  // Server-side seam shared with the in-process front-ends (webex/confluence). They
  // subscribe to the event bus and drive sessions through the SAME hook+scrape path.
  onServerEvent, activePrompts,
  answerPrompt, answerAsk, runCommand,
  startWatching, stopWatching, startPaneWatch, stopPaneWatch,
};

if (require.main === module) runWeb(process.argv.slice(2));
