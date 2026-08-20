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
const zlib = require('zlib');
const { spawnSync, spawn } = require('child_process');

const common = require('./ccbb-common');
// The phone front-end. Same server, same API, its own page — see ccbb-mobile.js.
const { mobilePageHtml, isMobileUA, serveVendor } = require('./ccbb-mobile');
const {
  serverIdentity, peerList, peerByName, peerToken, readToken, configUnreadable, isCcbbGroupSession,
  CLAUDE_DIR, getSessions, getCostSummary, getSubscription, getSessionInfo, getSessionHistory, getSessionHistoryWindow,
  getSubagentHistory, getSessionStats, watchSessionChanges,
  sessionLiveness, pidAlive, renameSession, paneForSession, panesForLiveSessions, injectToPane, transcriptEntry,
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
// ── the icon ──────────────────────────────────────────────────────────────────
// The tab favicon is an inline SVG and every browser draws it crisply. Chrome's
// "install this page as an app" is not a browser tab, though: the shortcut it writes and
// the taskbar entry it creates come from its icon downloader, which wants a raster it can
// resize — an SVG data: URI is not one, so an installed ccbb came out as a generic tile.
//
// Real PNGs, then. Which normally means a build step and binaries checked into the tree,
// for a mark that is seven rounded rectangles and two circles — so it is drawn here
// instead, at whatever size is asked for, and cached. Nothing to regenerate, nothing to
// keep in sync with the SVG above it: this IS the SVG above it, in numbers.
const ICON_FG = [0xff, 0x6b, 0x35], ICON_ON = [0xff, 0xff, 0xff];
const ICON_SHAPES = [                                    // painter's order, all opaque
  { x: 16, y: 12, w: 32, h: 28, r: 4, c: ICON_FG },      // head
  { cx: 24, cy: 20, rad: 4, c: ICON_ON },                // eyes
  { cx: 40, cy: 20, rad: 4, c: ICON_ON },
  { x: 20, y: 28, w: 24, h: 2, r: 1, c: ICON_ON },       // mouth
  { x: 18, y: 42, w: 28, h: 16, r: 2, c: ICON_FG },      // body
  { x: 8, y: 46, w: 10, h: 8, r: 2, c: ICON_FG },        // arms
  { x: 46, y: 46, w: 10, h: 8, r: 2, c: ICON_FG },
];
function iconHit(s, x, y) {
  if (s.rad != null) { const dx = x - s.cx, dy = y - s.cy; return dx * dx + dy * dy <= s.rad * s.rad; }
  if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) return false;
  if (!s.r) return true;
  // Nearest point of the rectangle shrunk by the corner radius: zero inside, and the
  // radius test then rounds exactly the four corners.
  const cx = Math.min(Math.max(x, s.x + s.r), s.x + s.w - s.r);
  const cy = Math.min(Math.max(y, s.y + s.r), s.y + s.h - s.r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= s.r * s.r;
}
// 4×4 supersampling, and colour averaged over the COVERED samples only while alpha is the
// coverage — average them together and every edge picks up a dark fringe from the
// transparent black it is being mixed with.
function iconRgba(size, scale, bg) {
  const SS = 4, out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const ux = (((px + (sx + 0.5) / SS) / size * 64) - 32) / scale + 32;
        const uy = (((py + (sy + 0.5) / SS) / size * 64) - 32) / scale + 32;
        let c = bg;
        for (const s of ICON_SHAPES) if (iconHit(s, ux, uy)) c = s.c;
        if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
      }
      const i = (py * size + px) * 4;
      if (!hits) continue;
      out[i] = Math.round(r / hits); out[i + 1] = Math.round(g / hits); out[i + 2] = Math.round(b / hits);
      out[i + 3] = Math.round(hits / (SS * SS) * 255);
    }
  }
  return out;
}
const iconCrc32 = zlib.crc32 || (() => {
  const T = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); T[n] = c; }
  return (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();
function pngEncode(size, rgba) {
  const stride = size * 4 + 1, raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0); head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(iconCrc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;              // 8 bits per channel, truecolour with alpha
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const ICON_SIZES = [32, 48, 64, 180, 192, 512];
const iconCache = new Map();
// A maskable icon is cropped to whatever shape the platform likes, so it fills the square
// and keeps the mark inside the safe circle — the plain one stays transparent and edge
// to edge, which is what a taskbar and a tab want.
function iconPngFor(size, maskable) {
  const key = size + (maskable ? 'm' : 'a');
  let png = iconCache.get(key);
  if (!png) {
    png = pngEncode(size, maskable ? iconRgba(size, 0.62, [0xff, 0xff, 0xff]) : iconRgba(size, 1, null));
    iconCache.set(key, png);
  }
  return png;
}
// Enough for Chrome to install it as an app under a name that says WHICH ccbb it is —
// several of these end up on one taskbar. Fetched with the cookie (the link element says
// use-credentials), so the name stays behind the token; the icons it points at do not
// need to be, and are served without it.
function webManifest(self) {
  const name = 'ccbb' + (self && self.name ? ' — ' + self.name : '');
  return {
    name, short_name: (self && self.name) || 'ccbb', id: '/', start_url: '/', scope: '/',
    display: 'standalone', background_color: '#ffffff', theme_color: '#f0eee6',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}

const APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccbb</title>
<link rel="shortcut icon" href="data:image/svg+xml,%3Csvg viewBox='0 0 64 64' xmlns='http://www.w3.org/2000/svg'%3E%3Crect x='16' y='12' width='32' height='28' rx='4' fill='%23FF6B35'/%3E%3Ccircle cx='24' cy='20' r='4' fill='%23fff'/%3E%3Ccircle cx='40' cy='20' r='4' fill='%23fff'/%3E%3Crect x='20' y='28' width='24' height='2' fill='%23fff' rx='1'/%3E%3Crect x='18' y='42' width='28' height='16' rx='2' fill='%23FF6B35'/%3E%3Crect x='8' y='46' width='10' height='8' rx='2' fill='%23FF6B35'/%3E%3Crect x='46' y='46' width='10' height='8' rx='2' fill='%23FF6B35'/%3E%3C/svg%3E" />
<!-- The SVG is what a tab draws. Chrome's app installer wants a raster and a
     manifest, and gets both here — see iconPngFor()/webManifest() in ccbb-web.js. -->
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
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
.view-bar{position:relative;flex:0 0 auto;display:flex;align-items:center;gap:10px;padding:6px 14px;background:var(--bg-alt);border-bottom:1px solid var(--line);min-height:38px}
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
/* ── a view's actions, folded away ──
   A session bar carried six buttons, and a two-line stats block sat above the transcript
   for good, all of it on screen for the sake of the moment you want one of them. It is
   one dots button now, and that button unfolds the rest: the buttons open in the bar
   itself, to the left of the dots, and the header hangs down from the bar's lower edge.
   Click again — or outside, or Escape — to fold it all away. */
.vb-acts{display:none;gap:2px}
.bar-btns.open .vb-acts{display:flex}
/* Fixed and placed as it opens, because in horizontal mode the bar is a grid cell with
   overflow:hidden and a block positioned against it would be clipped away. Placed at the
   bar's own left edge and width, so it reads as the bar continuing downwards. */
.vb-head{display:none;position:fixed;z-index:60;background:var(--bg);
  border:1px solid var(--line);border-top:none;border-radius:0 0 10px 10px;
  box-shadow:0 12px 24px rgba(0,0,0,.13);overflow:hidden}
.vb-head.open{display:block}
.view.folded .vb-head{display:none}
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
/* min-width:0 so the bar can be narrower than its own content, and overflow:hidden so
   what does not fit is clipped inside its own column instead of spilling across the
   neighbour's. The body already had both; the bar is the grid item that did not. */
#views.horizontal .view-bar{grid-row:1;min-width:0;overflow:hidden;border-bottom:1px solid var(--line);border-right:1px solid var(--line)}
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
/* Subscriptions: what a plan has actually spent of its two rolling windows. */
.lv .summary-head .scope-win{color:#57606a;font-weight:500;font-size:12px}
.lv .subs{margin-top:14px;border-top:1px solid #eaeef2;padding-top:10px}
.lv .subs h3{font-size:11px;font-weight:600;color:#8c959f;text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px}
.lv .subs-table{min-width:560px}
.lv .subs-table .c-pct{color:#1f2328;white-space:nowrap}
/* Bar first, number after: the eye reads the fill, the number confirms it. */
.lv .ubar{display:inline-block;width:52px;height:5px;border-radius:3px;background:#eaeef2;vertical-align:middle;margin-right:6px;overflow:hidden}
.lv .ubar i{display:block;height:100%;background:#1a7f37;border-radius:3px}
.lv .ubar i.warm{background:#bf8700}
.lv .ubar i.hot{background:#cf222e}
.lv .subs-table .upct{display:inline-block;min-width:30px;text-align:right}
/* ── session view ── */
/* Which machine this session actually runs on — muted when it's this one. */
.srv-badge{flex-shrink:0;font-size:11px;font-weight:600;border-radius:5px;padding:1px 7px;background:#ddf4e4;color:#1a7f37;border:1px solid #aceebb}
.srv-badge.local{background:var(--line-soft);color:var(--ink-faint);border-color:var(--line)}
.hdr-title{font-weight:600;font-size:13px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;cursor:pointer;border-radius:5px;padding:1px 4px;margin:-1px -4px}
.hdr-title:hover{background:var(--line-soft)}
.hdr-title.empty{color:var(--ink-faint);font-style:italic;font-weight:400}
.hdr-title-input{font-weight:600;font-size:13px;font-family:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--accent);border-radius:6px;padding:2px 6px;flex:1;min-width:0;box-shadow:0 0 0 3px var(--accent-soft)}
.hdr-title-input:focus{outline:none}
.sv-stats{padding:8px 12px 9px;background:var(--bg);max-height:44vh;overflow:auto}
.hdr-proj{font-size:11px;color:var(--ink-soft);overflow-wrap:anywhere;font-variant-numeric:tabular-nums;display:block;margin-bottom:2px}
.hdr-proj b{font-weight:600;color:var(--ink)}
.hdr-stats{font-size:11px;color:var(--ink-faint);line-height:1.55;font-variant-numeric:tabular-nums;display:block}
.hdr-stats b{font-weight:600;color:var(--ink-soft)}
.hdr-stats .sub{color:var(--ink-faint)}
/* Plan windows, hung directly off the session cost with no separator — "$1.23/5h:24%/w:41%"
   is one figure, the way the status line reads it. */
.hdr-stats .plan-win{color:var(--ink-soft);cursor:help}
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
/* Transcript prose reads as black, not the app's soft ink. Scoped to the session body so
   the list view, the bars and the deliberately muted metadata keep their palette. */
.sv .view-body{color:#000}
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
/* The unloaded middle of a windowed transcript: a marker that fills itself in when it
   scrolls into view, with buttons for anyone who would rather ask. */
.hist-gap{width:100%;max-width:740px;margin:10px 0;display:flex;align-items:center;justify-content:center;gap:10px;
  font-size:11px;color:var(--ink-faint);border-top:1px dashed var(--line);border-bottom:1px dashed var(--line);padding:6px 2px}
.hist-gap button{font:inherit;font-size:11px;color:var(--accent);background:none;border:none;cursor:pointer;padding:2px 4px}
.hist-gap button:hover{text-decoration:underline}
.hist-gap.loading{opacity:.5;pointer-events:none}
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
.input-inner{position:relative;width:100%;max-width:740px}
/* History and expand live ABOVE the box, and only while it has focus: at rest the composer
   is one line and a send button, and three cold controls would cost the transcript a row
   for nothing. Driven by :focus-within rather than a blur handler — focusout fires before
   the button's own click, so JS that hid this row would eat every press on it.
   Floating (absolute, out of flow) rather than a row of its own: appearing and vanishing
   as the focus comes and goes, an in-flow row would shove the whole transcript up and
   back down again on every click into the box. Out of flow it costs nothing and moves
   nothing — it just hangs over the last line of the transcript while you type. */
.input-tools{position:absolute;right:0;bottom:100%;margin-bottom:6px;z-index:6;
  display:flex;align-items:center;gap:4px;
  opacity:0;transform:translateY(4px);pointer-events:none;
  transition:opacity .12s ease,transform .12s ease}
.input-inner:focus-within>.input-tools{opacity:1;transform:none}
/* Only the buttons take clicks, never the gaps between them: this thing hovers over the
   transcript, and its dead space must not swallow a click meant for what is underneath. */
.input-tools>*{pointer-events:none}
.input-inner:focus-within>.input-tools>*{pointer-events:auto}
.input-row{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:5px 5px 5px 12px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.input-row:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
/* A contenteditable, not a textarea, for one reason: the send button sits in a notch cut
   out of the LAST line of the text — the floated ::after below — so every line above it
   runs the full width of the box. Nothing flows around a float inside a textarea. The
   rest of the file still talks to this like a textarea; asTextarea() is what makes that
   true. Fixed-width, like the terminal: a prompt is usually code, paths and flags, and a
   proportional font makes those hard to line up and hard to proofread. */
.input-box{border:none;background:none;padding:3px 0;font-size:13px;
  font-family:ui-monospace,Menlo,Consolas,'Cascadia Code',monospace;
  min-height:24px;max-height:200px;line-height:1.5;overflow-y:auto;color:var(--ink);
  white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;outline:none;cursor:text}
/* The notch itself. overflow-y:auto above is load-bearing twice over: it scrolls a long
   prompt AND makes this box a block formatting context, without which the float would
   escape the box instead of stretching it to fit. */
.input-box::after{content:'';display:block;float:right;width:32px;height:24px}
.input-box.empty::before{content:attr(data-ph);color:var(--ink-faint);pointer-events:none}
/* Maximized composer: the whole content area of the session, for writing something long
   enough that a five-line box is in the way. Everything above it is hidden rather than
   scrolled off, so the editor gets the full height instead of a share of it. The notch
   goes away here — the text starts at the top of a tall box while the button stays in the
   corner, so a last-line cutout would be nowhere near it; a reserved strip does the job. */
.view-body.input-max>.tr-wrap,.view-body.input-max>.cmd-box,.view-body.input-max>.sv-foot{display:none}
.view-body.input-max>.input-area{flex:1 1 auto;min-height:0;border-top:none}
.view-body.input-max .input-inner{max-width:none;height:100%;display:flex;flex-direction:column}
.view-body.input-max .input-row{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
.view-body.input-max .input-box{flex:1 1 auto;min-height:0;max-height:none;padding-bottom:32px}
.view-body.input-max .input-box::after{display:none}
/* Maximized there is no transcript left to float over, and the row is wanted whether or
   not the box has the focus — so it goes back into the flow, at the top of the editor. */
.view-body.input-max .input-tools{position:static;margin:0 0 5px;justify-content:flex-end;
  opacity:1;transform:none;pointer-events:auto}
.view-body.input-max .input-tools>*{pointer-events:auto}
/* Opaque, and shadowed: floating over the transcript, a transparent button would have
   somebody else's words showing through it. */
.exp-btn,.hist-btn{background:var(--surface);border:1px solid var(--line);color:var(--ink-soft);
  width:28px;height:28px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;
  flex-shrink:0;display:flex;align-items:center;justify-content:center;padding:0;
  box-shadow:0 1px 4px rgba(0,0,0,.10)}
.exp-btn:hover:not(:disabled),.hist-btn:hover:not(:disabled){border-color:var(--accent);color:var(--ink);background:var(--accent-soft)}
.exp-btn:disabled,.hist-btn:disabled{opacity:.35;cursor:default}
.hist-btn{font-size:10px}
/* A spacer, not a rule: a bare 1px line hanging over the transcript reads as a rendering
   artifact, and the buttons already separate themselves now that each has a background.
   Called .tool-gap and not .hist-sep because that name is already taken further up by the
   dashed "older history" divider, whose border-bottom was showing through this one. */
.tool-gap{width:5px;flex-shrink:0}
.send-btn{position:absolute;right:5px;bottom:5px;background:var(--accent);border:none;color:#fff;width:24px;height:24px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;padding:0}
.send-btn:hover:not(:disabled){background:var(--accent-hover,#a84f34)}
.send-btn:disabled{opacity:.4;cursor:default}
/* ── read-only ──
   One class on <html>, set before the first paint, removing every control that would
   only earn a 403. The affordances are gone, not disabled: a viewer has no use for a
   send button it can never press, and on a session view the composer is a third of the
   screen. What stays is everything that tells you what the machine is doing.
   A permission card is the exception — its options are the QUESTION, so they stay
   readable and merely stop being buttons. */
.ro .input-area,.ro .chip-term,.ro .term-open{display:none}
.ro .perm-opt{pointer-events:none;opacity:.65}
.ro .ask-custom,.ro .ask-foot{display:none}
.ro .hdr-title{cursor:default}
/* ── a session's terminal, in the view itself ──
   Not a window over the page: the session view IS the place you are already looking at
   the session, so its content area is where its terminal belongs. It takes the whole of
   that area — transcript, composer and //command box step aside rather than share it —
   because the grid it must draw is tmux's, not one it may choose, and half the height
   would only mean half the font.
   Anchored top-left: a grid that cannot quite fit is then cropped on the far edge only,
   where a centred one would lose a column at each end and a row top and bottom. */
.sv-term{display:none;flex:1 1 auto;min-height:0;position:relative;overflow:hidden;background:#fff}
.sv-term.dark{background:#000}
.sv-term.dead{opacity:.6}
/* Padding lives on .xterm, not on the box, so clientWidth/clientHeight stay the honest
   measurement the font fit divides by. Kept in sync with TERM_PAD_X/Y in the script. */
.term-host{position:absolute;inset:0}
.sv-term .xterm{padding:3px 0 0 4px}
/* The scrollbar would take columns out of a grid that is not ours to shrink, and there
   is nothing behind it worth scrolling to: an attached tmux keeps its own scrollback,
   and the wheel still reaches xterm's. */
.sv-term .xterm-viewport{scrollbar-width:none}
.sv-term .xterm-viewport::-webkit-scrollbar{display:none}
.sv.terming .tr-wrap,.sv.terming .input-area,.sv.terming .cmd-box{display:none}
.sv.terming .sv-term{display:block}
.vb-btn.on{background:var(--accent-soft);color:var(--accent)}
.term-fit{position:absolute;right:6px;bottom:4px;z-index:2;pointer-events:none;
  font-family:ui-monospace,Menlo,monospace;font-size:10px;color:var(--ink-faint);
  background:var(--bg);opacity:.55;padding:0 4px;border-radius:4px}
.sv-term.dark .term-fit{background:#000;color:#8c959f}

/* ── the status line, at the foot ──
   The shape Claude Code's own status line uses (statusline-instructions.md): model,
   session cost with the plan windows riding on it, turns, and context as
   current/peak/resend. One dim line at the bottom, where a status line belongs — the
   breakdown it summarises is in the header block the dots button opens. It stays up in
   terminal mode too, which is the one view with nothing else to read the numbers from. */
.sv-foot{flex:0 0 auto;display:flex;align-items:baseline;gap:12px;padding:4px 14px 5px;
  border-top:1px solid var(--line);background:var(--bg-alt);
  font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--ink-soft);
  font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.sv-foot .sl{overflow:hidden;text-overflow:ellipsis;min-width:0}
.sv-foot b{font-weight:600;color:var(--ink)}
.sv-foot .plan-win{color:var(--ink-soft);cursor:help}
.sv-foot .sl-idle{margin-left:auto;flex-shrink:0;color:#8a6d1a}

/* ── ssh terminal ──
   A terminal is deliberately NOT a view: you want it over whatever you are reading, at
   whatever size, and still there when you switch sessions. So it floats above #views with
   its own drag/resize/min/max — and its own font size and theme, because a terminal is
   read at a different size and contrast than prose. ── */
.term-win{position:fixed;z-index:80;display:flex;flex-direction:column;background:var(--bg);
  border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.28);
  overflow:hidden;min-width:340px;min-height:150px}
.term-win.max{left:0!important;top:0!important;width:100%!important;height:100%!important;border-radius:0}
.term-win.min{height:auto!important;min-height:0}
.term-win.min .term-body,.term-win.min .term-grip{display:none}
.term-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:6px 8px 6px 14px;
  background:var(--bg-alt);border-bottom:1px solid var(--line);min-height:34px;font-size:12px;
  color:var(--ink-soft);cursor:move;user-select:none}
/* Dot doubles as the connection lamp: grey connecting, green live, red exited. */
.term-head::before{content:'';flex-shrink:0;width:8px;height:8px;border-radius:50%;background:var(--ink-faint)}
.term-win.live .term-head::before{background:#2da44e}
.term-win.dead .term-head::before{background:#cf222e}
.term-title{font-family:ui-monospace,Menlo,monospace;font-weight:600;color:var(--ink);
  flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.term-btns{margin-left:auto;display:flex;align-items:stretch;gap:2px;flex-shrink:0}
.term-btn{background:none;border:none;color:var(--ink-soft);font-size:13px;cursor:pointer;
  line-height:1;padding:4px 7px;border-radius:6px;font-family:inherit}
.term-btn:hover{background:var(--line);color:var(--ink)}
.term-sep{width:1px;margin:3px 3px;background:var(--line);flex-shrink:0}
/* No padding HERE, deliberately. The fit addon sizes the grid from the parent's computed
   height minus the terminal element's own padding — and with box-sizing:border-box that
   computed height still includes this box's padding, which it therefore never subtracts.
   Padding here means a grid a row too tall for the space, and the last line clipped by
   the overflow:hidden below. On .xterm it lands on the side of the measurement that is
   actually accounted for, so the inset is real and the arithmetic stays exact. */
.term-body{flex:1 1 auto;min-height:0;padding:0;background:#fff;overflow:hidden}
.term-body .xterm{padding:6px 6px 6px 8px}
.term-win.dark .term-body{background:#000}
.term-grip{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;z-index:2}
.term-grip::after{content:'';position:absolute;right:4px;bottom:4px;width:7px;height:7px;
  border-right:2px solid var(--ink-faint);border-bottom:2px solid var(--ink-faint);opacity:.7}
.term-win.max .term-grip,.term-win.min .term-grip{display:none}
.term-pick{padding:14px 16px;overflow:auto;height:100%;background:var(--bg)}
.term-note{color:var(--ink-soft);font-size:12.5px;line-height:1.6}
.term-note code{font-family:ui-monospace,Menlo,monospace;background:var(--code-bg);border:1px solid var(--line);border-radius:4px;padding:0 4px}
/* Config panel: text size, theme and an explicit grid. Tucked behind the gear rather
   than spread across the title bar, which a terminal narrowed to 40 columns has no room
   for. Anchored inside the window, so it travels with it. */
.term-cfg{position:absolute;top:36px;right:8px;z-index:4;display:none;background:var(--surface);
  border:1px solid var(--line);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.22);
  padding:10px 12px;font-size:12px;color:var(--ink);min-width:212px}
.term-win.cfg .term-cfg{display:block}
.term-cfg .crow{display:flex;align-items:center;gap:6px;margin-bottom:8px}
.term-cfg .crow:last-child{margin-bottom:0}
.term-cfg .clbl{color:var(--ink-soft);width:48px;flex-shrink:0}
.term-cfg button{background:var(--bg-alt);border:1px solid var(--line);border-radius:6px;color:var(--ink);
  font-family:inherit;font-size:12px;padding:3px 9px;cursor:pointer;line-height:1.4}
.term-cfg button:hover{border-color:var(--accent);background:var(--accent-soft)}
.term-cfg .cval{font-family:ui-monospace,Menlo,monospace;min-width:30px;text-align:center;color:var(--ink-soft)}
.term-cfg input{width:54px;background:var(--surface);border:1px solid var(--line);border-radius:6px;color:var(--ink);
  font-family:ui-monospace,Menlo,monospace;font-size:12px;padding:3px 6px;text-align:right}
.term-cfg input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.term-cfg .cx{color:var(--ink-faint)}
.lv .chip-term{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:11px;color:#8c959f;
  border-radius:5px;padding:0 4px;margin:-2px -6px -2px 0;line-height:1.6}
.lv .chip-term:hover{background:#d0d7de;color:#1f2328}
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
// Baked into the page rather than fetched, because the affordances it removes must never
// exist — not appear and then vanish a round-trip later. The server refuses these routes
// regardless; this only keeps the page from offering what it knows will be refused.
var RO = __RO__;                 // this browser holds the read-only token
if (RO) document.documentElement.classList.add('ro');
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
// ── subscription windows ──
// A Claude.ai plan runs out of WINDOW, not money, so the two rolling limits travel next
// to every dollar figure: "$1.23/5h:24%/w:41%", the same shape the status line uses.
// A window that the account doesn't report is dropped rather than shown as 0%.
function subPct(w){ return w ? Math.round(w.pct)+'%' : '—'; }
// How long until a window resets. Whole-ish units — this is read at a glance, and the
// seconds on a 4-hour countdown are noise.
function fmtUntil(iso){
  if(!iso) return '—';
  var t = Date.parse(iso); if (isNaN(t)) return '—';
  var s = Math.round((t - Date.now())/1000);
  if (s <= 0) return 'due';
  var m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d > 0) return d+'d '+(h%24)+'h';
  if (h > 0) return h+'h '+(m%60)+'m';
  return m+'m';
}
function subWinStr(win){
  if (!win) return '';
  var p = [];
  if (win.fiveHour) p.push('5h:'+subPct(win.fiveHour));
  if (win.sevenDay) p.push('w:'+subPct(win.sevenDay));
  return p.length ? '/'+p.join('/') : '';
}
// Where the reading came from and how old it is — a percentage with no provenance is
// indistinguishable from a stale one.
function subWinTitle(sub){
  if (!sub || !sub.windows) return '';
  var w = sub.windows, parts = [];
  if (w.fiveHour) parts.push('5-hour window '+subPct(w.fiveHour)+' used, resets in '+fmtUntil(w.fiveHour.resetsAt));
  if (w.sevenDay) parts.push('7-day window '+subPct(w.sevenDay)+' used, resets in '+fmtUntil(w.sevenDay.resetsAt));
  if (sub.fetchedAt) parts.push('read '+fmtUntilAge(sub.fetchedAt)+' ago from '+(sub.source==='api'?'the account API':'Claude Code\\'s cache'));
  return parts.join('\\n');
}
function fmtUntilAge(ms){
  var s = Math.max(0, Math.round((Date.now()-ms)/1000));
  if (s < 60) return s+'s';
  var m = Math.floor(s/60); if (m < 60) return m+'m';
  var h = Math.floor(m/60); if (h < 24) return h+'h';
  return Math.floor(h/24)+'d';
}
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
// ── the composer's editable ───────────────────────────────────────────────────
// Makes a contenteditable div answer to the three textarea properties the composer code
// uses — value, placeholder, setSelectionRange — so the swap costs nothing above this
// line. It has to be a div: the send button sits in a notch cut out of the last line by
// a floated ::after, and a textarea has no inline content for a float to displace.
// Sizing is CSS now (min-height/max-height), so there is no autoGrow to call: a div is
// exactly as tall as its text.
function asTextarea(el){
  el.setAttribute('contenteditable', 'plaintext-only');
  el.setAttribute('spellcheck', 'false');
  // Paste is flattened by hand rather than left to plaintext-only: Firefox before 136
  // ignores that value and silently falls back to full rich-text editing, and a pasted
  // stack trace would arrive as markup. execCommand, deprecated as it is, is the only
  // insert that the browser's own undo stack still knows about.
  el.addEventListener('paste', function(e){
    var cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    e.preventDefault();
    document.execCommand('insertText', false, cd.getData('text/plain'));
  });
  // :empty is not usable for the placeholder — browsers leave a stray <br> behind in an
  // "empty" editable — so the class is maintained by hand.
  function sync(){ el.classList.toggle('empty', !el.innerText); }
  el.addEventListener('input', sync);
  Object.defineProperty(el, 'value', {
    // innerText, not textContent: it is the one reader that turns however this browser
    // chose to represent the line breaks (<br>, nested divs) back into real newlines.
    // Trailing ones go: an editable keeps a bogus block after the last line, so a prompt
    // ended with Enter would arrive at the pane with a blank line after it — which in a
    // pane that submits on Enter is not a cosmetic difference.
    get: function(){ return el.innerText.replace(/\\n+$/, ''); },
    set: function(v){ el.textContent = v == null ? '' : String(v); sync(); }
  });
  Object.defineProperty(el, 'placeholder', {
    get: function(){ return el.getAttribute('data-ph') || ''; },
    set: function(v){ el.setAttribute('data-ph', v == null ? '' : String(v)); }
  });
  // Only ever called collapsed (start === end): the history buttons put the caret at one
  // end of what they just dropped in.
  el.setSelectionRange = function(_start, end){ edCaret(el, end); };
  sync();
  return el;
}
function edCaret(el, pos){
  var sel = window.getSelection();
  if (!sel) return;
  var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  var n, seen = 0, node = null, off = 0;
  while ((n = walker.nextNode())) {
    node = n; off = n.nodeValue.length;
    if (seen + off >= pos) { off = pos - seen; break; }
    seen += off;
  }
  var r = document.createRange();
  if (node) r.setStart(node, Math.max(0, Math.min(off, node.nodeValue.length)));
  else r.selectNodeContents(el);
  r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  el.focus();
}
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
// 'vertical' (stacked) or 'horizontal' (columns). Remembered per server, in a cookie:
// which way you want the views stacked is a property of the machine you are working on,
// and two ccbb servers open side by side keep their own answers. (cookieGet and friends
// live with the terminal below; function declarations hoist.)
function uiCookieName(){ return 'ccbb_ui_' + String(SELF.name || 'self').replace(/[^A-Za-z0-9]/g, '_'); }
var uiPrefs = {};
try { uiPrefs = JSON.parse(cookieGet(uiCookieName()) || '{}') || {}; } catch(e) { uiPrefs = {}; }
var orientation = uiPrefs.orientation === 'horizontal' ? 'horizontal' : 'vertical';
function saveUiPrefs(){
  uiPrefs.orientation = orientation;
  cookieSet(uiCookieName(), JSON.stringify(uiPrefs));
}
function toggleOrientation(){
  orientation = orientation === 'vertical' ? 'horizontal' : 'vertical';
  viewsEl.classList.toggle('horizontal', orientation === 'horizontal');
  saveUiPrefs();
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
    // minmax(0,1fr), not 1fr: a bare 1fr is minmax(AUTO,1fr), so a column can never shrink
    // below its own min-content and one stubborn header silently steals width from every
    // other column — three views came out 480/480/515 instead of thirds. The rows above
    // already say minmax(0,1fr) for exactly this reason.
    viewsEl.style.gridTemplateColumns = views.map(function(v){
      return (maxed ? v === maxed : !v.folded) ? 'minmax(0,1fr)' : 'auto';
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
// The buttons a view offers, wherever they are drawn: inline in the bar, or in the block
// the dots button opens. Two terminals, deliberately distinct: $_ is this view's own
// content area, #_ is the floating window — the same one per server the session list
// opens, with the same remembered place, font and grid.
function viewBtnsHtml(buttons){
  var menu = !!(buttons && buttons.menu);
  return '<button class="vb-btn" data-act="refresh" title="Refresh">&#8635;</button>'+
    (menu ? '<button class="vb-btn" data-act="fold" title="Minimize">&#8211;</button>' : '')+
    '<button class="vb-btn" data-act="max" title="Maximize">&#9633;</button>'+
    (buttons && buttons.term && !RO ? '<button class="vb-btn term-open" data-act="term" title="Terminal in this view">$_</button>' : '')+
    (buttons && buttons.term && !RO ? '<button class="vb-btn" data-act="termwin" title="Floating terminal for this session">#_</button>' : '')+
    (buttons && buttons.orient ? '<button class="vb-btn" data-act="orient" title="Stack horizontally">&#9637;</button>' : '')+
    (buttons && buttons.close ? '<button class="vb-btn" data-act="close" title="Close">&#10005;</button>' : '');
}
// Build a view's title bar. buttons: {close, term, orient, menu, headEl}. barMain is an
// element. With menu:true the bar shows one dots button and everything else — the button
// row and headEl, the view's own header block — moves into the block it opens.
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
  var head = null, foldable = !!(buttons && buttons.menu);
  if (foldable) {
    btns.innerHTML = '<span class="vb-acts">' + viewBtnsHtml(buttons) + '</span>' +
      '<button class="vb-btn vb-dots" data-act="menu" title="Actions and details">&#8942;</button>';
    if (buttons.headEl) {
      head = document.createElement('div');
      head.className = 'vb-head';
      head.appendChild(buttons.headEl);
    }
  } else {
    btns.innerHTML = viewBtnsHtml(buttons);
  }
  bar.appendChild(btns);
  if (head) bar.appendChild(head);

  function menuIsOpen(){ return btns.classList.contains('open'); }
  function onDocDown(e){ if (!bar.contains(e.target)) closeMenu(); }
  function onDocKey(e){ if (e.key === 'Escape') closeMenu(); }
  function closeMenu(){
    if (!menuIsOpen()) return;
    btns.classList.remove('open');
    if (head) head.classList.remove('open');
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', closeMenu);
  }
  function openMenu(){
    if (!foldable || menuIsOpen()) return;
    // Maximize is the one button that reads differently depending on where the view
    // already is, so it is written as it unfolds rather than left stale.
    var mb = btns.querySelector('.vb-btn[data-act="max"]');
    if (mb) { mb.innerHTML = v.maxed ? '&#10064;' : '&#9633;'; mb.title = v.maxed ? 'Normal size' : 'Maximize'; }
    btns.classList.add('open');
    if (head) {
      // Measured after the buttons are in, since showing them can grow the bar.
      var r = bar.getBoundingClientRect();
      head.style.top = Math.round(r.bottom) + 'px';
      head.style.left = Math.round(r.left) + 'px';
      head.style.width = Math.round(r.width) + 'px';
      head.classList.add('open');
    }
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', closeMenu);
  }
  v.closeMenu = closeMenu;

  bar.addEventListener('click', function(e){
    var b = e.target.closest('.vb-btn');
    if (b) {
      e.stopPropagation();
      if (b.dataset.act === 'menu') { if (menuIsOpen()) closeMenu(); else openMenu(); return; }
      closeMenu();
      if (b.dataset.act === 'refresh') v.refresh();
      else if (b.dataset.act === 'term') { if (v.onTerm) v.onTerm(); }
      else if (b.dataset.act === 'termwin') { if (v.onTermWin) v.onTermWin(); }
      else if (b.dataset.act === 'fold') toggleFold(v);
      else if (b.dataset.act === 'max') toggleMax(v);
      else if (b.dataset.act === 'orient') toggleOrientation();
      else if (b.dataset.act === 'close') closeView(v);
      return;
    }
    // Reading the header block, or selecting out of it, is not a click on the bar.
    if (head && head.contains(e.target)) return;
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
      '<div id="sumProvider" class="sum-wrap"></div>'+
      // Subscriptions sit under the provider breakdown and share its scope selector: the
      // USD column is that scope's subscription-billed spend, the windows are live.
      '<div id="subs" class="subs" style="display:none">'+
        '<h3>Subscriptions</h3><div id="subsTable" class="sum-wrap"></div></div>'+
    '</div>'+
    '<div class="wrap"><div id="out" class="lmsg">Loading…</div></div>'+
    '<div class="foot" id="foot"></div>';
  el.appendChild(body);
  v.el = el;
  v.bodyEl = body;

  var sessions = [], totals = {}, costSummary = null;
  // The merged summary above answers "what did everything cost"; these two keep the
  // per-server split the subscriptions table needs, since a plan belongs to one login on
  // one set of machines, not to the fan-out as a whole.
  var sumByServer = {};    // server → its own /api/cost-summary
  var subsByServer = {};   // server → its own /api/subscription (absent when not on a plan)
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
    renderServers(); syncSockets();
  }
  function renderServers(){
    var bar = body.querySelector('#srvbar');
    // Shown even for a lone server: the chip is where a machine's terminal is opened
    // from, so hiding the bar would leave a single-machine install with no launcher.
    bar.style.display = '';
    bar.innerHTML = servers.map(function(s){
      var on = isSelected(s.name);
      var tip = s.name + (s.self ? ' (this server)' : '')
        + (s.inbound ? ' — linked in (reached over its own connection)' : '')
        + (s.status === 'down' ? ' — offline: ' + (s.error||'unreachable') : '')
        + (s.rttMs != null && s.status === 'up' ? ' — ' + s.rttMs + 'ms' : '');
      // Not a <button>: it carries the terminal launcher, and a button inside a button
      // is invalid and swallows the inner click in some browsers.
      return '<span class="chip'+(on?' on':'')+'" data-srv="'+esc(s.name)+'" title="'+esc(tip)+'">'
        + '<span class="sdot '+esc(s.status||'unknown')+'"></span>'
        + '<span class="cname">'+esc(s.name)+'</span>'
        + (RO ? '' : '<span class="chip-term" data-term="'+esc(s.name)+'" title="Open a terminal on '+esc(s.name)+'">&gt;_</span>')
        + '</span>';
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
        // A session that just started has no activity yet; sort it by when it started, so
        // the newest thing you launched lands at the top rather than the bottom.
        var va = col === 'context' ? ctxTokens(a) : col === 'lastActivity' ? (a.lastActivity || a.startedAt) : a[col];
        var vb = col === 'context' ? ctxTokens(b) : col === 'lastActivity' ? (b.lastActivity || b.startedAt) : b[col];
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
  // The table is fed by one WebSocket per selected server (peers through the same proxy as
  // everything else): a snapshot on connect and another whenever you refresh or re-scope.
  // Nothing here polls. The server can also push row-level deltas from a filesystem watch,
  // which is currently off by default (CCBB_LIST_WATCH=1) — the client applies them if they
  // arrive. A server that drops contributes an error line and reconnects on its own; one
  // dead ssh tunnel must not hide the sessions on every other machine.
  //
  // The cost summary is the one thing still fetched over HTTP, on open / manual refresh /
  // scope change: it is a whole-history aggregate, not something that moves per turn.
  var srvRows = {};        // server → { rows: {sessionId: row}, totals }
  var srvErr = {};         // server → error text, while it is unreachable
  var socks = {};          // server → { ws, timer, tries, closed, opened }
  var scopeMonth = null;   // null = all time
  var lastChange = 0;      // when the table last actually changed (drives the age label)

  function rebuild(){
    var rows = [], tot = { totalCost: 0, totalTokens: 0 }, errs = [];
    selectedServers().forEach(function(name){
      if (srvErr[name]) errs.push({ server: name, error: srvErr[name] });
      var e = srvRows[name];
      if (!e) return;
      for (var id in e.rows) { e.rows[id].server = name; rows.push(e.rows[id]); }
      tot.totalCost += (e.totals && e.totals.totalCost) || 0;
      tot.totalTokens += (e.totals && e.totals.totalTokens) || 0;
    });
    sessions = rows; totals = tot; loadErrors = errs;
  }
  function applyMessage(name, d){
    if (d.type === 'list') {
      var rows = {};
      (d.sessions || []).forEach(function(s){ rows[s.sessionId] = s; });
      srvRows[name] = { rows: rows, totals: d.totals || {} };
      return true;
    }
    if (d.type === 'delta') {
      var e = srvRows[name] || (srvRows[name] = { rows: {}, totals: {} });
      (d.upd || []).forEach(function(s){ e.rows[s.sessionId] = s; });
      (d.del || []).forEach(function(id){ delete e.rows[id]; });
      if (d.totals) e.totals = d.totals;
      return true;
    }
    return false;
  }
  function listWsUrl(name){
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + apiBase(name) + '/ws/list'
      + (scopeMonth ? '?month=' + encodeURIComponent(scopeMonth) : '');
  }
  var SNAPSHOT_MS = 5000, FALLBACK_POLL_MS = 15000, FALLBACK_RETRY_MS = 60000;
  function openSocket(name){
    if (socks[name]) return;
    var st = { ws:null, timer:null, snapTimer:null, pollTimer:null, tries:0, closed:false, opened:false, http:false };
    socks[name] = st;
    function stopSnapTimer(){ if (st.snapTimer) { clearTimeout(st.snapTimer); st.snapTimer = null; } }
    // HTTP fallback: one whole-list fetch, the pre-socket protocol.
    function pull(){
      fetch(apiBase(name) + '/api/sessions' + (scopeMonth ? '?month=' + encodeURIComponent(scopeMonth) : ''))
        .then(function(r){ if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(d){
          applyMessage(name, { type:'list', sessions: d.sessions || [], totals: d.totals || {} });
          delete srvErr[name]; rebuild(); noteChange(); render();
        })
        .catch(function(e){ srvErr[name] = e.message || String(e); rebuild(); render(); });
    }
    // A peer running an older ccbb accepts /ws/list as though "list" were a session id and
    // then says nothing at all — its sessions would silently vanish from the table. So
    // silence is treated as a version mismatch, not an outage: poll that server over HTTP
    // and re-try the socket now and then, in case it gets upgraded under us.
    function fallback(){
      if (st.closed) return;
      if (st.ws) { try { st.ws.onclose = st.ws.onerror = st.ws.onmessage = null; st.ws.close(); } catch(e){} st.ws = null; }
      stopSnapTimer();
      if (!st.http) { st.http = true; pull(); st.pollTimer = setInterval(pull, FALLBACK_POLL_MS); }
      st.timer = setTimeout(connect, FALLBACK_RETRY_MS);
    }
    function retry(){
      if (st.closed) return;
      stopSnapTimer();
      // Only complain once we have actually failed — a socket still on its first
      // handshake is not an outage worth painting across the table.
      if (!st.http && (st.opened || st.tries > 0)) { srvErr[name] = 'disconnected'; rebuild(); render(); }
      var wait = Math.min(15000, 1000 * Math.pow(2, st.tries++));
      st.timer = setTimeout(connect, wait);
    }
    function connect(){
      if (st.closed) return;
      var ws;
      try { ws = new WebSocket(listWsUrl(name)); } catch(e) { return retry(); }
      st.ws = ws;
      var done = false;
      ws.onopen = function(){
        st.opened = true; st.tries = 0;
        st.snapTimer = setTimeout(fallback, SNAPSHOT_MS);   // no snapshot ⇒ not a list socket
      };
      ws.onmessage = function(ev){
        var d; try { d = JSON.parse(ev.data); } catch(e) { return; }
        if (d.type === 'error') { srvErr[name] = d.error || 'error'; rebuild(); render(); return; }
        if (!applyMessage(name, d)) return;
        stopSnapTimer();
        if (st.http) { clearInterval(st.pollTimer); st.pollTimer = null; st.http = false; }
        delete srvErr[name];
        rebuild(); noteChange(); render();
      };
      ws.onclose = ws.onerror = function(){ if (done) return; done = true; st.ws = null; retry(); };
    }
    connect();
  }
  function closeSocket(name){
    var st = socks[name];
    if (!st) return;
    st.closed = true;
    if (st.timer) clearTimeout(st.timer);
    if (st.snapTimer) clearTimeout(st.snapTimer);
    if (st.pollTimer) clearInterval(st.pollTimer);
    if (st.ws) { try { st.ws.close(); } catch(e){} }
    delete socks[name];
    delete srvRows[name];
    delete srvErr[name];
  }
  // Sockets follow the server selection: connect what is newly selected, drop what isn't.
  function syncSockets(){
    var want = selectedServers();
    for (var name in socks) if (want.indexOf(name) === -1) closeSocket(name);
    want.forEach(openSocket);
    rebuild(); render();
  }
  // Re-scope in place where we can — the server answers with a fresh snapshot, so there is
  // no reconnect and no second HTTP round trip.
  function pushScope(force){
    selectedServers().forEach(function(name){
      var st = socks[name];
      if (!st) return openSocket(name);
      if (st.ws && st.ws.readyState === 1) {
        // Answered with a whole fresh list, which is also what the refresh button wants —
        // so this one message serves both, and always carries the current scope.
        try { st.ws.send(JSON.stringify({ type:'scope', month: scopeMonth })); } catch(e){}
      } else if (st.http) {
        closeSocket(name); openSocket(name);   // re-pulls under the new scope, retries the socket
      } else if (force) {
        // A waiting reconnect: don't make the user sit out the backoff on a manual refresh.
        closeSocket(name); openSocket(name);
      }
    });
  }
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
  function scopeFromSelect(){
    var sel = body.querySelector('#sumScope');
    var val = sel ? sel.value : '';
    return val && val.indexOf('m:') === 0 ? val.slice(2) : null;
  }
  async function loadSummary(force) {
    var results = await fanOut('/api/cost-summary');
    var merged = null;
    // deepAdd copies the first summary rather than mutating it, so the per-server
    // originals stay intact and can be re-scoped without another round trip.
    sumByServer = {};
    results.forEach(function(r){ if (!r.error) { sumByServer[r.name] = r.data; merged = deepAdd(merged, r.data); } });
    if (merged) {
      costSummary = merged; buildScopeOptions(); renderSummary();
      body.querySelector('#summary').style.display = '';
    } else { body.querySelector('#summary').style.display = 'none'; }
    renderSubs();   // its USD column comes from these summaries, whichever load lands first
    // Drive the list from the selected scope (default: latest month). On summary failure
    // the selector is empty, so this falls back to the all-time list.
    scopeMonth = scopeFromSelect();
    pushScope(!!force);
  }
  // Plan windows move turn by turn, so unlike the summary this is re-polled on its own
  // clock. A server that fails just drops out of the table — one unreachable peer must
  // not take the other accounts' rows with it.
  async function loadSubs() {
    // Read-only draws none of it, and a request per selected server for something that is
    // about to be dropped on the floor is worth not making.
    if (RO) return;
    var results = await fanOut('/api/subscription');
    var next = {};
    results.forEach(function(r){ if (!r.error && r.data && r.data.account) next[r.name] = r.data; });
    subsByServer = next;
    renderSubs();
    if (costSummary) renderSummary();   // the inline "/5h:…/w:…" beside the scope cost
  }
  // The bar shows how old the table is, not when a request last completed: it is stamped by
  // a delta that changed something, so "3m" means the sessions have been quiet for 3
  // minutes, not that the page has stopped listening.
  function noteChange(){ lastChange = Date.now(); renderAge(); }
  function fmtAge(ms){
    var s = Math.round(ms/1000);
    if (s < 60) return s + 's';
    var m = Math.round(s/60);
    if (m < 60) return m + 'm';
    return Math.round(m/60) + 'h';
  }
  function renderAge(){
    if (!lastChange) { refreshedEl.textContent = ''; return; }
    refreshedEl.textContent = fmtAge(Date.now() - lastChange);
    refreshedEl.title = 'Last change ' + new Date(lastChange).toLocaleTimeString();
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
    renderSummary(); renderSubs();
    scopeMonth = scopeFromSelect();
    pushScope(false);
  }
  function scopeLabel() {
    var val = body.querySelector('#sumScope').value;
    return (val && val.indexOf('m:') === 0) ? fmtMonth(val.slice(2)) : 'All time';
  }
  function currentScope() {
    var val = body.querySelector('#sumScope').value;
    if (val === 'all' || !val) return costSummary.overall;
    return costSummary.months[val.slice(2)] || costSummary.overall;
  }
  // Same scope, applied to ONE server's summary. Unlike currentScope this returns null
  // for a month the server has no spend in — falling back to its all-time total there
  // would quietly bill a quiet machine for its whole history.
  function serverScope(name) {
    var cs = sumByServer[name];
    if (!cs) return null;
    var val = body.querySelector('#sumScope').value;
    if (val === 'all' || !val) return cs.overall || null;
    return (cs.months || {})[val.slice(2)] || null;
  }
  // What that server put through its subscription in the selected scope. Bedrock and
  // API-key traffic on the same machine is somebody else's bill and is left out.
  function subCostFor(name) {
    var sc = serverScope(name);
    var b = sc && sc.byProvider && sc.byProvider.anthropic;
    return b ? (b.cost || 0) : 0;
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
  // Bedrock alone for a read-only viewer. The subscription row is one login's personal
  // spend against a personal quota, which is not what a shared link is for — and the Total
  // goes with it, since Total minus Bedrock is the row that was just removed.
  //
  // This is presentation, not enforcement, and the difference is worth being honest about:
  // the numbers are still in /api/cost-summary, which a read-only caller keeps because the
  // session list is built from it. What the read token withholds is elsewhere (see
  // authLevel); what this withholds is a figure nobody sharing a link means to share.
  function providerTableHtml(scope){
    var map = scope.byProvider || {};
    var keys = Object.keys(map).filter(function(k){ return map[k].tokens > 0 && !(RO && k !== 'bedrock'); });
    if (!keys.length) return '<div style="color:#8c959f;font-size:11px">No '+(RO?'Bedrock ':'')+'usage.</div>';
    keys.sort(function(a,b){ return map[b].cost - map[a].cost; });
    var tbody = keys.map(function(k){ return provRowHtml(PROV_LABEL[k]||k, map[k]); }).join('');
    var tfoot = (keys.length > 1 && !RO) ? '<tfoot>'+provRowHtml('Total', scope.all)+'</tfoot>' : '';
    var thead = '<thead><tr><th>&nbsp;</th><th>USD</th><th>Tokens</th><th>Turns</th>'
      + '<th>Cache Read</th><th>Cache Write</th><th>Cache Miss</th><th>Out</th><th>In</th><th>Time</th></tr></thead>';
    return '<table class="sum-table prov">'+thead+'<tbody>'+tbody+'</tbody>'+tfoot+'</table>';
  }
  function renderSummary() {
    if (!costSummary) return;
    var scope = currentScope();
    var costEl = body.querySelector('#sumScopeCost');
    // The headline has to agree with the table under it. Read-only shows Bedrock's own
    // spend — printing the everything-total over a Bedrock-only table would hand back by
    // subtraction exactly the number the table left out — and no window badge, which is
    // quota on a personal plan.
    if (RO) {
      var bed = (scope.byProvider || {}).bedrock;
      costEl.textContent = fc(bed ? bed.cost : 0);
    } else {
      // "$1.23/5h:24%/w:41%" — but only with ONE plan in view. Two accounts have two sets
      // of windows and no meaningful sum, so there the table alone speaks for them.
      var groups = subGroups(), one = groups.length === 1 ? groups[0] : null;
      costEl.innerHTML = esc(fc(scope.all.cost))
        + (one && one.windows ? '<span class="scope-win" title="'+esc(subWinTitle(one))+'">'+esc(subWinStr(one.windows))+'</span>' : '');
    }
    body.querySelector('#sumProvider').innerHTML = providerTableHtml(scope);
  }
  // One row per ACCOUNT, not per server: the windows belong to a login, so two machines
  // sharing one would otherwise show the same percentages twice and read as double the
  // usage. Their spend is summed; the freshest of their readings wins.
  function subGroups() {
    var byAcct = {};
    selectedServers().forEach(function(name){
      var s = subsByServer[name];
      if (!s || !s.account) return;
      var g = byAcct[s.account.accountUuid] || (byAcct[s.account.accountUuid] =
        { account: s.account, plan: s.plan || '', servers: [], windows: null, fetchedAt: 0, source: null, cost: 0 });
      g.servers.push(name);
      if (s.windows && (s.fetchedAt || 0) >= g.fetchedAt) {
        g.windows = s.windows; g.fetchedAt = s.fetchedAt || 0; g.source = s.source;
      }
      g.cost += subCostFor(name);
    });
    return Object.keys(byAcct).map(function(k){ return byAcct[k]; })
      .sort(function(a, b){ return b.cost - a.cost; });
  }
  // Percentage plus a proportional bar, so a nearly-spent window is visible without
  // reading the number. Amber past 70%, red past 90%.
  function subPctCell(w) {
    if (!w) return '<td class="c-tok">—</td>';
    var p = Math.max(0, Math.min(100, w.pct));
    var cls = p >= 90 ? ' hot' : p >= 70 ? ' warm' : '';
    return '<td class="c-pct"><span class="ubar"><i class="'+cls.trim()+'" style="width:'+p.toFixed(1)+'%"></i></span>'
      + '<span class="upct">'+subPct(w)+'</span></td>';
  }
  function subRowHtml(g) {
    var w = g.windows || {};
    var acct = esc(g.account.name)
      + (g.plan ? ' <span class="c-sub">'+esc(g.plan)+'</span>' : '')
      + (multiServer() ? '<span class="c-sub"> '+esc(g.servers.join(', '))+'</span>' : '');
    var tip = [g.account.email, g.account.org].filter(Boolean).join(' · ');
    var stale = g.fetchedAt ? '<span class="c-sub" title="'+esc(subWinTitle(g))+'">'+esc(fmtUntilAge(g.fetchedAt))+'</span>' : '';
    return '<tr><td title="'+esc(tip)+'">'+acct+'</td>'
      + '<td class="c-usd">'+fc(g.cost)+'</td>'
      + subPctCell(w.fiveHour)
      + '<td class="c-tok">'+esc(fmtUntil(w.fiveHour && w.fiveHour.resetsAt))+'</td>'
      + subPctCell(w.sevenDay)
      + '<td class="c-tok">'+esc(fmtUntil(w.sevenDay && w.sevenDay.resetsAt))+'</td>'
      + '<td class="c-tok">'+stale+'</td>'
      + '</tr>';
  }
  function renderSubs() {
    var groups = RO ? [] : subGroups();
    var wrap = body.querySelector('#subs');
    // Nothing to say on a Bedrock-only or API-key install — an empty table would just be
    // a heading over a blank row. Read-only lands here too: the table is an account's
    // name, email, org, plan and quota, which is the most personal thing on the page.
    if (!groups.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    var thead = '<thead><tr><th>Account</th><th>USD ('+esc(scopeLabel())+')</th>'
      + '<th>5h used</th><th>5h resets</th><th>Week used</th><th>Week resets</th><th>Read</th></tr></thead>';
    body.querySelector('#subsTable').innerHTML =
      '<table class="sum-table subs-table">'+thead+'<tbody>'+groups.map(subRowHtml).join('')+'</tbody></table>';
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
      // "No sessions" is a claim about a server that answered; while one is still opening
      // its socket the honest state is that we don't know yet.
      var waiting = selectedServers().some(function(n){ return !srvRows[n] && !srvErr[n]; });
      out.className = ''; out.innerHTML = errHtml + '<div class="lmsg">'+(waiting ? 'Loading…' : 'No sessions found.')+'</div>';
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
    var tbtn = e.target.closest('.chip-term[data-term]');
    if (tbtn) { openTerminalWindow(tbtn.dataset.term); return; }
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

  // The server list must land BEFORE the sockets open: until it does, the only known
  // server is this one, so a saved selection naming a peer would filter down to nothing
  // and connect local-only — a first paint that silently drops every remote session.
  function cycle(force){
    return loadServers().then(function(){
      syncSockets();
      loadSubs();                       // independent of the summary; don't make it wait
      return loadSummary(force);
    });
  }

  // Two timers. The age label counts up between pushes, and the same tick re-renders the
  // subscriptions table so its reset countdowns move without another round trip.
  var ageTimer = setInterval(function(){ renderAge(); renderSubs(); }, 10000);
  // Plan windows are account state, not transcript state — nothing pushes them, so they
  // are the one thing here that still polls.
  var subsTimer = setInterval(loadSubs, 60000);
  v.destroy = function(){
    clearInterval(ageTimer);
    clearInterval(subsTimer);
    for (var name in socks) closeSocket(name);
  };

  v.refresh = function(){ return cycle(true); };
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
var EXPAND_TIP = 'Expand the composer to the whole session';
var HIST_PREV_TIP = 'Earlier input  ·  this session\\'s prompts and this page\\'s // commands';
var HIST_NEXT_TIP = 'Later input  ·  past the newest returns what you were typing';

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
  // The header block. It is built here — renderStats writes into these same elements
  // wherever they end up — and handed to the bar, which keeps it in the block the dots
  // button opens. Hidden by default: the numbers that are wanted at a glance are on the
  // status line at the foot, and this is the detail behind them.
  var headEl = document.createElement('div');
  headEl.className = 'sv-stats';
  headEl.innerHTML = '<span class="hdr-proj"></span><span class="hdr-stats"></span><div class="hdr-status"></div>';
  el.appendChild(makeViewBar(v, barMain, { close:true, term:true, menu:true, headEl:headEl }));
  var dotEl = barMain.querySelector('.status-dot');
  var titleEl = barMain.querySelector('.hdr-title');

  // — body —
  var body = document.createElement('div');
  body.className = 'view-body';
  body.innerHTML =
    '<div class="tr-wrap">'+
      '<div class="transcript"></div>'+
      '<button class="jump-marker">&#8595; New updates</button>'+
      '<div class="query-ind" title="Querying…"></div>'+
    '</div>'+
    '<div class="sv-term"><div class="term-host"></div><div class="term-fit"></div></div>'+
    '<div class="cmd-box">'+
      '<div class="cmd-head"><span class="cmd-title"></span>'+
        '<div class="cmd-btns">'+
          '<button class="cmd-btn" data-c="min" title="Minimize">&#8211;</button>'+
          '<button class="cmd-btn" data-c="max" title="Maximize">&#9633;</button>'+
          '<button class="cmd-btn" data-c="close" title="Close">&#10005;</button>'+
        '</div></div>'+
      '<div class="cmd-content"></div>'+
    '</div>'+
    '<div class="input-area"><div class="input-inner">'+
      '<div class="input-tools">'+
        '<button class="hist-btn" data-h="prev" title="'+HIST_PREV_TIP+'">&#9650;</button>'+
        '<button class="hist-btn" data-h="next" title="'+HIST_NEXT_TIP+'">&#9660;</button>'+
        '<span class="tool-gap"></span>'+
        '<button class="exp-btn" title="'+EXPAND_TIP+'">&#9633;</button>'+
      '</div>'+
      '<div class="input-row">'+
        '<div class="input-box" data-ph="Message the session…  (// for commands)"></div>'+
        '<button class="send-btn" title="'+SEND_TIP+'">&#8593;</button>'+
      '</div>'+
    '</div></div>'+
    '<div class="sv-foot"><span class="sl"></span><span class="sl-idle"></span></div>';
  el.appendChild(body);
  v.bodyEl = body;
  var projEl = headEl.querySelector('.hdr-proj');
  var statsEl = headEl.querySelector('.hdr-stats');
  var statusRow = headEl.querySelector('.hdr-status');
  var footEl = body.querySelector('.sv-foot .sl');
  var footIdleEl = body.querySelector('.sv-foot .sl-idle');
  var transcript = body.querySelector('.transcript');
  var jumpMarker = body.querySelector('.jump-marker');
  var queryEl = body.querySelector('.query-ind');
  var cmdBox = body.querySelector('.cmd-box');
  var cmdTitle = body.querySelector('.cmd-title');
  var cmdContent = body.querySelector('.cmd-content');
  var inputBox = asTextarea(body.querySelector('.input-box'));
  var sendBtn = body.querySelector('.send-btn');
  var expBtn = body.querySelector('.exp-btn');
  var inputTools = body.querySelector('.input-tools');
  var histPrevBtn = body.querySelector('.hist-btn[data-h="prev"]');
  var histNextBtn = body.querySelector('.hist-btn[data-h="next"]');

  // — this session's terminal, in this view's content area —
  // The bar's >_ toggles it. Created on first use and destroyed when closed, deliberately:
  // an attached tmux client that lingered would keep tmux sizing that window for a browser
  // nobody is looking at, which is the very thing the pinned grid exists to avoid.
  var termEl = body.querySelector('.sv-term');
  var termHost = termEl.querySelector('.term-host');
  var termFitEl = termEl.querySelector('.term-fit');
  var termRef = null, termObs = null, termFitTimer = null;
  var TERM_PAD_X = 4, TERM_PAD_Y = 3;    // .sv-term .xterm padding, kept in sync with the CSS

  // The grid is tmux's and does not move, so what gives is the font.
  //
  // This cannot be solved for. xterm rounds a cell to whole device pixels, so the map
  // from font size to grid size is a STAIRCASE: 5.5pt and 5.75pt can draw the identical
  // screen, and a quarter-point more can cost a whole pixel per row. The obvious loop —
  // measure, scale by how far off you are, repeat — therefore oscillates between two
  // neighbouring steps and never settles, which is exactly what it did.
  //
  // So: binary search on the quarter-point grid, between the largest size known to fit
  // and the smallest known not to. Seven measurements cover 3pt to 28pt — a tenth of a
  // second, and then it is still. It lands on the largest size that actually fitted, not
  // on the last one probed, so the terminal is never left one pixel over the edge.
  // A search is a sequence of measurements over several frames, so two of them running
  // at once — the open finishing while the ResizeObserver's first callback is in flight —
  // interleave their probes and each concludes from the other's font. One counter, and
  // the older search stands down.
  var TERM_FONT_MIN = 3, TERM_FONT_MAX = 28, fitRun = 0;
  function fitTermFont(run, lo, hi, pass){
    var core = termRef;
    if (!core || !core.term || core.destroyed || run !== fitRun) return;
    var scr = termHost.querySelector('.xterm-screen');
    if (!scr) return;
    var r = scr.getBoundingClientRect();
    var availW = termHost.clientWidth - TERM_PAD_X, availH = termHost.clientHeight - TERM_PAD_Y;
    if (!(r.width > 0 && r.height > 0 && availW > 0 && availH > 0)) return;
    if (lo == null) { lo = TERM_FONT_MIN; hi = TERM_FONT_MAX + 0.25; }
    var cur = core.term.options.fontSize;
    // Half a pixel of slack: these are subpixel measurements of a grid drawn to whole
    // device pixels, and an exact comparison rejects a size that visibly fits.
    if (r.width <= availW + 0.5 && r.height <= availH + 0.5) { if (cur > lo) lo = cur; }
    else if (cur < hi) hi = cur;
    var next = Math.floor((lo + hi) / 2 * 4) / 4;
    if (next > lo && next < hi && (pass || 0) < 14) {
      core.term.options.fontSize = next;
      return setTimeout(function(){ fitTermFont(run, lo, hi, (pass || 0) + 1); }, 20);
    }
    if (cur !== lo) {
      core.term.options.fontSize = lo;
      return setTimeout(function(){ if (run === fitRun) showTermGeom(); }, 20);
    }
    showTermGeom();
  }
  function showTermGeom(){
    var core = termRef;
    if (!core || !core.term) return;
    termFitEl.textContent = core.term.cols + '×' + core.term.rows + ' · ' +
      core.term.options.fontSize + 'px' +
      (core.where === 'pane' ? ' · session pane' : core.where === 'window' ? ' · new window' : '');
  }
  // Two sizings, one entry point. A pinned terminal keeps its grid and moves its font; a
  // login shell (no tmux on that host) has no grid to respect, so it behaves like every
  // other terminal and fits the grid to the box.
  function syncTermSize(){
    var core = termRef;
    if (!core || !core.term) return;
    if (core.pinned) return fitTermFont(++fitRun);
    try { core.fit.fit(); } catch(e) { return; }
    if (core.term.cols !== core.cols || core.term.rows !== core.rows)
      core.setSize(core.term.cols, core.term.rows);
    showTermGeom();
  }
  function setTermBtn(on){
    var d = el.querySelector('.vb-btn.vb-dots');
    if (d) d.classList.toggle('on', on);
    var b = el.querySelector('.vb-btn.term-open');
    if (!b) return;
    b.classList.toggle('on', on);
    b.title = on ? 'Back to the transcript' : 'Terminal in this view';
  }
  function openSessionTerm(){
    if (termRef) return;
    el.classList.add('terming');
    setTermBtn(true);
    var core = termCore(termHost, {
      server: INFO.server, title: SRV, sessionId: INFO.sessionId,
      // The one terminal that must not resize tmux: you are looking at this session here,
      // and reflowing the window you are working in to fit a browser pane is intolerable.
      pin: true,
      fontSize: 12, theme: 'light',
      // A sensible hint for the case tmux does not overrule it — a login shell should
      // still come up at the size of the box it is about to be drawn in.
      onReady: function(){ try { core.fit.fit(); } catch(e) {} },
      onOpen: function(){
        if (core.pinned) { try { core.term.resize(core.cols, core.rows); } catch(e) {} }
        setTimeout(function(){ syncTermSize(); core.term.focus(); }, 30);
      },
      onState: function(st){ termEl.classList.toggle('dead', st === 'dead'); },
    });
    termRef = core;
    core.start();
    if (window.ResizeObserver) {
      termObs = new ResizeObserver(function(){
        clearTimeout(termFitTimer);
        termFitTimer = setTimeout(syncTermSize, 80);
      });
      termObs.observe(termHost);
    }
  }
  function closeSessionTerm(){
    if (termObs) { try { termObs.disconnect(); } catch(e) {} termObs = null; }
    clearTimeout(termFitTimer);
    if (termRef) { termRef.destroy(); termRef = null; }
    el.classList.remove('terming');
    termEl.classList.remove('dead');
    setTermBtn(false);
    // The transcript grew while it was hidden, where every scroll measurement is zero.
    // Put it back where it was reading rather than at whatever the browser left behind.
    if (following) scrollBottom(true);
  }
  v.onTerm = function(){ if (termRef) closeSessionTerm(); else openSessionTerm(); };
  // The other mode: the floating window, which is the very one the session list opens per
  // server — same window, same cookie, so its place, font size and grid are the ones you
  // left it at. Opening it against a session re-targets that server's window at the
  // session's tmux pane; there is still only ever one of them per server.
  v.onTermWin = function(){ openTerminalWindow(INFO.server, { sessionId: INFO.sessionId }); };

  var ws, reconnectTimer, destroyed = false, connected = false;
  var msgEls = {}, toolEls = {}, seenUuids = {};
  // Timing: response time = assistant entry ts − last USER entry ts (prompt/tool_result), anchored
  // to the last user entry since one response spans several assistant entries (thinking/text/tool).
  // Reaction time = typed-prompt ts − last ASSISTANT entry ts. toolStart maps a tool_use id → its
  // assistant entry's time, paired on the result card to show how long the tool took.
  var lastUserTs = null, lastAsstTs = null, toolStart = {};
  var historyLoaded = false, pendingTranscript = [], pendingAsk = null;
  // A long session is megabytes of transcript, nearly all of it scrolled past. The view
  // opens on a WINDOW: the first few entries (what the session was asked to do) and the
  // last screenful (what it is doing now), with a gap marker between that fills itself in
  // as you scroll up. histCount is the server's entry count, not what we rendered — /ws/
  // tails from end-of-file with no resume cursor, so after a dropped socket we re-ask for
  // everything from histCount on, and get only what was appended.
  var HIST_HEAD = 5, HIST_TAIL = 25, HIST_CHUNK = 25;
  var histCount = 0;          // total entries the server has
  var gapEl = null;           // the "N earlier messages" marker, while a gap exists
  var gapFrom = 0;            // index of the oldest entry rendered below the gap
  var gapTo = 0;              // index just past the newest entry rendered above it
  var gapLoading = false;
  // Older entries are inserted where the gap is, not appended at the bottom. Every
  // transcript insertion goes through here so one flag redirects them all; the scroll
  // MutationObserver already compensates for content growing above the reading anchor.
  var insertAnchor = null;
  function tAppend(node){
    if (insertAnchor && insertAnchor.parentNode === transcript) transcript.insertBefore(node, insertAnchor);
    else transcript.appendChild(node);
  }
  var permEls = {};    // fp -> element
  var askCards = {};   // tool_use id -> card element
  var statEls = {}, statTurnNo = {}, statTurns = 0, statSeenFirst = false;

  function renderTitle() {
    titleEl.textContent = INFO.title || '(untitled — ' + INFO.sessionId.slice(0,8) + ')';
    titleEl.className = 'hdr-title' + (INFO.title ? '' : ' empty');
    titleEl.title = RO ? (INFO.title || '') : 'Click to rename';
  }
  titleEl.addEventListener('click', function(e){
    if (el.classList.contains('collapsed')) return;   // bar handler expands instead
    if (RO) return;
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
  // This session's server, when it's on a Claude.ai plan. Its two rolling windows ride
  // beside the session cost as "$1.23/5h:24%/w:41%" — on a plan the dollars are notional
  // list price and the windows are the figure that actually runs out.
  var subInfo = null, lastStats = null;
  function planWinHtml(st) {
    if (!subInfo || !subInfo.windows) return '';
    // A Bedrock or API-key session on a machine that also has a login is not billed to
    // that plan, so its windows say nothing about this session.
    var onPlan = (st.providers||[]).some(function(p){ return p.provider === 'anthropic' && p.cost > 0; });
    if (!onPlan) return '';
    var s = subWinStr(subInfo.windows);
    return s ? '<span class="plan-win" title="'+esc(subWinTitle(subInfo))+'">'+esc(s)+'</span>' : '';
  }
  function fetchSub() {
    fetch(API+'/api/subscription').then(function(r){ return r.json(); })
      .then(function(d){
        subInfo = (d && d.account) ? d : null;
        if (lastStats) renderStats(lastStats);
      }).catch(function(){});
  }
  function renderStats(st) {
    if (!st) { statsEl.textContent = ''; footEl.innerHTML = ''; return; }
    lastStats = st;
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
      '  &middot;  <b>'+fmtCost(st.cost)+'</b>'+planWinHtml(st)+modelStr+
      '  &middot;  <b>'+fmtTokShort(st.totalTokens)+'</b>  '+tokStr+ctxStr;
    renderFoot();
  }
  // The status line, in the shape statusline-instructions.md describes: model, session
  // cost with the plan windows appended, turns, and context as current/peak/resend. No
  // monthly estimate — that one is a whole-machine figure and this line is one session's.
  // The model is whichever one the last turn ran on, not the one that cost the most:
  // this reports what the session IS, and the header behind it lists the rest.
  function renderFoot(){
    var st = lastStats;
    if (!st) { footEl.innerHTML = ''; return; }
    var ctx = st.context, cmax = st.contextMax;
    var mdl = ctx && ctx.model ? prettyModel(ctx.model) : '';
    if (!mdl) {
      var ms = (st.models||[]).slice().sort(function(a,b){ return (b.cost||0)-(a.cost||0); });
      if (ms.length) mdl = prettyModel(ms[0].model);
    }
    var ctxStr = '';
    if (ctx) {
      var peak = (cmax && cmax.tokens > ctx.tokens) ? cmax.tokens : ctx.tokens;
      ctxStr = 'ctx:'+(ctx.postCompact?'~':'')+'<b>'+fmtTokShort(ctx.tokens)+'</b>/'+
        fmtTokShort(peak)+'/'+fmtCost(ctx.cost);
    }
    var turns = st.turns||0, subTurns = st.subTurns||0;
    footEl.innerHTML = [
      mdl ? '<b>'+esc(mdl)+'</b>' : '',
      '<b>'+fmtCost(st.cost)+'</b>'+planWinHtml(st),
      'turns:<b>'+turns+'</b>'+(subTurns?'+'+subTurns:''),
      ctxStr,
    ].filter(Boolean).join('&nbsp;&nbsp;');
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
      // The header it normally lives in is hidden now, and "it stopped and is waiting for
      // you" is the one piece of status you should not have to open a block to learn.
      footIdleEl.textContent = '⏸ waiting' + (since ? ' ' + since : '');
      footIdleEl.title = statusRow.textContent;
    } else {
      statusRow.classList.remove('show');
      statusRow.innerHTML = '';
      footIdleEl.textContent = '';
      footIdleEl.title = '';
    }
  }
  var queryCount = 0;
  function queryStart(){ queryCount++; queryEl.classList.add('show'); }
  function queryEnd(){ queryCount = Math.max(0, queryCount-1); if (!queryCount) queryEl.classList.remove('show'); }
  // Every session-scoped call goes through here, so the API prefix (local or peer)
  // is applied in exactly one place.
  function qfetch(url, opts){ queryStart(); return fetch(API+url, opts).finally(queryEnd); }
  // Liveness arrives on the socket now (the server watches the registry), so nothing here
  // polls for it. What is left is the stats line, which only moves when the transcript
  // does — so it is fetched on open and then debounced behind incoming entries.
  var lastStatus = null, statsTimer = null;
  function setStatusFromWs(msg) {
    lastStatus = { live: msg.live, status: msg.status, statusUpdatedAt: msg.statusAt };
    setStatus(lastStatus);
  }
  function fetchStats() {
    qfetch('/api/session/'+INFO.sessionId+'/stats').then(function(r){return r.json();})
      .then(function(d){ if(d) renderStats(d); }).catch(function(){});
  }
  function statsSoon() {
    if (statsTimer) return;
    statsTimer = setTimeout(function(){ statsTimer = null; fetchStats(); }, 3000);
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
      tAppend(lineEl);
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
        tAppend(mEl);
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
      tAppend(card);
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
    tAppend(card);
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
    html += '<div class="perm-note" id="an-'+id+'">'+
      (RO ? 'Waiting for an answer at the terminal.'
          : (showSubmit?'Choose your answer'+(qs.length>1?'s':'')+', then Submit.':'Tap an option, or type a custom answer.')+' Also answerable at the terminal.')+'</div>';
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
    tAppend(card);
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
    tAppend(mk);
    scrollBottom();
  }
  function renderUserMessage(msg, hist, gap) {
    var text = (msg.content||[]).filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('').trim();
    if (!text || isSystemNoise(text)) return false;
    var mEl = document.createElement('div');
    mEl.className = 'msg you'+(hist?' hist':'');
    var yt = fmtDur(gap);
    mEl.innerHTML = '<div class="msg-label">You'+(yt?' <span class="msg-time">'+yt+'</span>':'')+'</div><div class="msg-body">'+esc(text)+'</div>';
    histAdd(text);   // the transcript IS the prompt history; ↑ reaches back past this page
    tAppend(mEl);
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
    var first = !connected;
    ws = new WebSocket(proto+'//'+location.host+API+'/ws/'+INFO.sessionId);
    // The tail starts at end-of-file, so every entry written while we were
    // disconnected is gone from this view unless we go back for it. Cheap on a
    // LAN and rare; through a tunnel, where a phone drops the socket on every
    // screen lock, this is the difference between a live transcript and one
    // with silent holes in it.
    ws.onopen = function(){ connected = true; if (!first) loadHistory(true); };
    ws.onmessage = function(e){ handleWsMsg(JSON.parse(e.data)); };
    ws.onclose = function(){ if (!destroyed) reconnectTimer = setTimeout(connect, 2000); };
  }
  function handleWsMsg(msg) {
    if (msg.type==='transcript') {
      histCount++;   // keep the resume cursor in step with the file we are being tailed from
      if (!historyLoaded) pendingTranscript.push(msg.entry);
      else { processEntry(msg.entry, false); noteUpdate(); }
      statsSoon();
    } else if (msg.type==='live') {
      setStatusFromWs(msg);
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
      '<div class="perm-note">'+(RO ? 'Waiting for an answer at the terminal.'
        : 'Tap an option or type the number below. Also answerable at the terminal.')+'</div>';
    card.querySelectorAll('.perm-opt').forEach(function(b){
      b.addEventListener('click', function(){
        clearPermission(msg.fp);   // dismiss immediately, don't wait for the pane scrape
        answerPermission(+b.dataset.n);
      });
    });
    permEls[msg.fp] = card;
    tAppend(card);
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
  // Opening: ask for the two ends only. Resuming after a dropped socket: ask for what was
  // appended since, which on a session that has been running for hours is a handful of
  // entries instead of its whole transcript.
  async function loadHistory(resume) {
    var q = resume ? 'from=' + histCount : 'head=' + HIST_HEAD + '&tail=' + HIST_TAIL;
    var r, d;
    try { r = await qfetch('/api/session/'+INFO.sessionId+'/history?'+q); d = await r.json(); }
    catch(e) { historyLoaded = true; flushPending(); return; }
    var added = 0;
    if (d && d.entries) {                       // one contiguous run: a resume, or a short session
      for (var i=0;i<d.entries.length;i++) processEntry(d.entries[i], true);
      added = d.entries.length;
      if (!resume) { gapFrom = 0; gapTo = 0; }
    } else if (d && (d.head || d.tail)) {
      var head = d.head || [], tail = d.tail || [];
      for (var h=0;h<head.length;h++) processEntry(head[h], true);
      gapTo = head.length;
      gapFrom = d.tailFrom != null ? d.tailFrom : (d.total - tail.length);
      showGap();
      for (var t=0;t<tail.length;t++) processEntry(tail[t], true);
      added = head.length + tail.length;
    }
    // Entries the socket delivered while this fetch was in flight already counted, so the
    // cursor is whichever is further along.
    if (d && d.total != null) histCount = Math.max(histCount, d.total);
    historyLoaded = true;
    flushPending();
    // Don't yank the view back if the reader has scrolled up to read something.
    if (!resume) scrollBottom(true);
    else if (added) { if (following) scrollBottom(true); noteUpdate(); }
  }
  // The gap marker doubles as the loader: it fetches the previous chunk when it scrolls
  // into view, so reading upward just keeps working, and offers the whole rest in one go
  // for anyone who would rather search the page.
  function showGap(){
    var missing = gapFrom - gapTo;
    if (missing <= 0) { hideGap(); return; }
    if (!gapEl) {
      gapEl = document.createElement('div');
      gapEl.className = 'hist-gap';
      gapEl.addEventListener('click', function(e){
        var b = e.target.closest('button');
        if (!b) return;
        loadOlder(b.dataset.all ? Infinity : HIST_CHUNK);
      });
      if (gapObserver) gapObserver.observe(gapEl);
    }
    gapEl.innerHTML = '<span class="hist-gap-n">'+missing+' earlier '+(missing===1?'message':'messages')+'</span>'+
      '<button data-n="'+HIST_CHUNK+'">Show '+Math.min(HIST_CHUNK, missing)+' more</button>'+
      '<button data-all="1">Show all</button>';
    // Placed once, between head and tail; re-rendering its label must not move it.
    if (gapEl.parentNode !== transcript) tAppend(gapEl);
  }
  function hideGap(){
    if (!gapEl) return;
    if (gapObserver) { try { gapObserver.unobserve(gapEl); } catch(e){} }
    gapEl.remove(); gapEl = null;
  }
  async function loadOlder(n){
    if (gapLoading || !gapEl) return;
    var to = gapFrom, from = n === Infinity ? gapTo : Math.max(gapTo, gapFrom - n);
    if (to <= from) { hideGap(); return; }
    gapLoading = true;
    gapEl.classList.add('loading');
    var r, d;
    try {
      r = await qfetch('/api/session/'+INFO.sessionId+'/history?from='+from+'&to='+to);
      d = await r.json();
    } catch(e) { gapLoading = false; gapEl && gapEl.classList.remove('loading'); return; }
    // Insert directly below the marker, in order, so the transcript stays chronological.
    // The scroll observer holds the reading position while the page grows above it.
    insertAnchor = gapEl.nextSibling;
    try { ((d && d.entries) || []).forEach(function(e){ processEntry(e, true); }); }
    finally { insertAnchor = null; }
    gapFrom = from;
    gapLoading = false;
    if (gapEl) gapEl.classList.remove('loading');
    if (gapFrom <= gapTo) hideGap(); else showGap();
  }
  var gapObserver = null;
  if (window.IntersectionObserver) {
    gapObserver = new IntersectionObserver(function(ents){
      for (var i=0;i<ents.length;i++) if (ents[i].isIntersecting) loadOlder(HIST_CHUNK);
    }, { root: transcript, rootMargin: '200px 0px 0px 0px' });
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
    if (text.trim().charAt(0) === '/' && text.trim().charAt(1) === '/') {
      // Back to one line once it is gone: the expanded composer is for writing, and it
      // covers the very output this command is about to produce.
      histAdd(text); runCmd(text.trim()); inputBox.value=''; setInputMax(false); return;
    }
    if (!canDrive) { if (text.trim().charAt(0) === '/') toast('Session not running in a tmux pane here — cannot send /commands.'); return; }
    sendBtn.disabled = true;
    qfetch('/api/session/'+INFO.sessionId+'/input', {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: text })
    }).then(function(r){ return r.json(); }).then(function(d){
      // Added on success only: a prompt the pane refused was never sent, and the
      // transcript will add it a moment later anyway (histAdd drops the repeat).
      // Only on success: a prompt the pane refused is still in the box, and shrinking
      // would hide most of what you would have to retype.
      if (d && d.ok) { histAdd(text); inputBox.value=''; setInputMax(false); } else { toast((d&&d.error)||'Send failed'); }
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

  // — expand —
  function inputMaxed(){ return body.classList.contains('input-max'); }
  function setInputMax(on){
    body.classList.toggle('input-max', !!on);
    expBtn.innerHTML = on ? '&#10064;' : '&#9633;';
    expBtn.title = on ? 'Shrink the composer back' : EXPAND_TIP;
    inputBox.focus();
  }
  expBtn.addEventListener('click', function(){ setInputMax(!inputMaxed()); });

  // — input history —
  // Seeded from the prompts already in the transcript, so ↑ reaches what you sent before
  // this page was opened. // commands are appended as they are run and are never written
  // anywhere: they live only in this page, and a reload starts them over.
  // histDraft holds what you had typed when you started walking back, so ↓ past the end
  // returns it rather than dropping it.
  var inputHist = [], histPos = -1, histDraft = '';
  function histAdd(text){
    text = String(text || '');
    if (!text.trim()) return;
    if (inputHist.length && inputHist[inputHist.length - 1] === text) return;   // no runs of duplicates
    inputHist.push(text);
    if (inputHist.length > 200) inputHist.shift();
    histPos = -1;
    histSync();
  }
  // Buttons, not the arrow keys: the composer is a multi-line editor — maximized it is
  // the whole page — and ↑/↓ belong to the caret there.
  function histSync(){
    histPrevBtn.disabled = !inputHist.length || histPos === 0;
    histNextBtn.disabled = !inputHist.length || histPos === -1;
  }
  function histShow(text, toEnd){
    inputBox.value = text;
    var at = toEnd ? text.length : 0;
    try { inputBox.setSelectionRange(at, at); } catch(e) {}
    histSync();
  }
  function histWalk(delta){
    if (!inputHist.length) return false;
    if (histPos === -1) {
      if (delta > 0) return false;             // already at the live draft
      histDraft = inputBox.value;
      histPos = inputHist.length;
    }
    var next = histPos + delta;
    if (next >= inputHist.length) { histPos = -1; histShow(histDraft, true); return true; }
    if (next < 0) next = 0;
    histPos = next;
    histShow(inputHist[histPos], true);
    return true;
  }
  // mousedown is where focus is lost, so that is where it is refused: the caret stays in
  // the textarea and the click never takes it away.
  inputTools.addEventListener('mousedown', function(e){ if (e.target.closest('.hist-btn,.exp-btn')) e.preventDefault(); });
  histPrevBtn.addEventListener('click', function(){ histWalk(-1); inputBox.focus(); });
  histNextBtn.addEventListener('click', function(){ histWalk(1); inputBox.focus(); });
  // Clicking anywhere in the composer's frame — the padding, the gap beside the buttons —
  // means "I want to type here". Without this those pixels just drop the focus.
  body.querySelector('.input-row').addEventListener('mousedown', function(e){
    if (e.target === inputBox || e.target.closest('button')) return;
    e.preventDefault();
    inputBox.focus();
  });
  histSync();

  // Plain Enter is a newline: a prompt is usually several lines, and a stray Enter firing
  // one off half-written into a live session is not a recoverable mistake. Ctrl/Cmd+Enter
  // is the deliberate two-key send, same as the button.
  inputBox.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      sendMessage();
      return;
    }
    // ↑/↓ are deliberately NOT bound: they move the caret. History is on the buttons.
    if (e.key === 'Escape' && inputMaxed() && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      setInputMax(false);
    }
  });

  // — refresh / destroy —
  v.refresh = function(){
    transcript.innerHTML = '';
    msgEls = {}; toolEls = {}; seenUuids = {}; askCards = {}; lastUserTs = null; lastAsstTs = null; toolStart = {};
    statEls = {}; statTurnNo = {}; statTurns = 0; statSeenFirst = false;
    historyLoaded = false; pendingTranscript = []; pendingAsk = null; histCount = 0;
    gapEl = null; gapFrom = 0; gapTo = 0; gapLoading = false; insertAnchor = null;
    following = true; anchorEl = null;
    // The transcript is about to be replayed, and every user message re-seeds the input
    // history — so clear it first, or a refresh would double every prompt. // commands
    // are lost with it, which is what "only for this page" means.
    inputHist = []; histPos = -1; histSync();
    loadHistory();
    fetchStats();
  };
  // The idle line counts up ("waiting 4m"), so it is re-rendered from the status we were
  // last pushed — no request involved. Drivability is a tmux fact, which changes only when
  // a session is attached or killed; 15s is plenty.
  var statusTimer = setInterval(function(){ if (lastStatus) setStatus(lastStatus); }, 10000);
  var drivePollTimer = setInterval(refreshDrivable, 15000);
  // Plan windows belong to the account, not the transcript, so nothing pushes them.
  var subTimer = setInterval(fetchSub, 60000);
  v.destroy = function(){
    destroyed = true;
    closeSessionTerm();
    clearInterval(statusTimer); clearInterval(drivePollTimer); clearInterval(subTimer);
    clearTimeout(reconnectTimer); clearTimeout(statsTimer);
    if (gapObserver) { try { gapObserver.disconnect(); } catch(e) {} }
    if (scrollObserver) { try { scrollObserver.disconnect(); } catch(e) {} }
    if (ws) { try { ws.close(); } catch(e) {} }
  };

  renderTitle();
  renderStats(INFO.stats);
  setStatus({ live: INFO.live, status: INFO.liveStatus, statusUpdatedAt: INFO.liveStatusAt });
  fetchSub();
  refreshDrivable();
  connect();
  loadHistory();
  return v;
}

// ── host terminal ─────────────────────────────────────────────────────────────
// A login shell on the machine a server chip names, in a floating window. No ssh: a
// peer's terminal rides the connection ccbb already holds to it, since /peer/<name>/…
// is spliced by the same proxy that carries the session WebSockets.
//
// One WebSocket, both directions, so bytes cannot arrive out of order either way. The
// sequence number on output is an assertion and a resume cursor, not the input to a
// reordering buffer: a number that isn't lastSeq+1 means bytes were LOST, and the only
// honest repair is to drop the socket and let the reconnect replay the backlog.
var XTERM_BASE = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/';
var XTERM_FIT = 'https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js';
var xtermLoad = null;
function loadScriptTag(src){
  return new Promise(function(ok, fail){
    var s = document.createElement('script');
    s.src = src;
    s.onload = function(){ ok(); };
    s.onerror = function(){ fail(new Error('could not load ' + src)); };
    document.head.appendChild(s);
  });
}
// Fetched on the first terminal open, never at page load: the rest of the app must not
// pay a CDN round trip for a feature it isn't using.
function loadXterm(){
  if (!xtermLoad) {
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = XTERM_BASE + 'css/xterm.css';
    document.head.appendChild(css);
    xtermLoad = loadScriptTag(XTERM_BASE + 'lib/xterm.js').then(function(){ return loadScriptTag(XTERM_FIT); });
    xtermLoad.catch(function(){ xtermLoad = null; });   // a later open may retry
  }
  return xtermLoad;
}

var TERM_THEMES = {
  light: { background:'#ffffff', foreground:'#000000', cursor:'#000000', cursorAccent:'#ffffff',
    selectionBackground:'#cfe3ff', selectionForeground:'#000000',
    black:'#000000', red:'#c1272d', green:'#1a7f37', yellow:'#8a6d1a', blue:'#0969da',
    magenta:'#8250df', cyan:'#116a72', white:'#57606a', brightBlack:'#8c959f', brightRed:'#cf222e',
    brightGreen:'#2da44e', brightYellow:'#bf8700', brightBlue:'#218bff', brightMagenta:'#a475f9',
    brightCyan:'#1b7c83', brightWhite:'#24292f' },
  dark: { background:'#000000', foreground:'#e6e6e6', cursor:'#e6e6e6', cursorAccent:'#000000',
    selectionBackground:'#3a4a63', selectionForeground:'#ffffff',
    black:'#2e3436', red:'#cc0000', green:'#4e9a06', yellow:'#c4a000', blue:'#3465a4',
    magenta:'#75507b', cyan:'#06989a', white:'#d3d7cf', brightBlack:'#555753', brightRed:'#ef2929',
    brightGreen:'#8ae234', brightYellow:'#fce94f', brightBlue:'#729fcf', brightMagenta:'#ad7fa8',
    brightCyan:'#34e2e2', brightWhite:'#eeeeec' }
};

// — per-server persistence, in a cookie —
// Keyed by the server the shell runs on, so each machine's terminal comes back where you
// left it, at the size and contrast you left it at.
function termCookieName(server){ return 'ccbb_term_' + String(server || 'self').replace(/[^A-Za-z0-9]/g, '_'); }
function cookieGet(name){
  var parts = document.cookie ? document.cookie.split(';') : [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].replace(/^\\s+/, '');
    var eq = p.indexOf('=');
    if (eq > 0 && p.slice(0, eq) === name) { try { return decodeURIComponent(p.slice(eq + 1)); } catch(e) { return ''; } }
  }
  return '';
}
function cookieSet(name, val){
  document.cookie = name + '=' + encodeURIComponent(val) + '; Path=/; SameSite=Strict; Max-Age=31536000';
}
// Missing must fall back to the default, not to zero: Number(null) is 0 and Number('')
// is 0, so neither can be left to Number() and isFinite() alone.
function tnum(v, d){
  if (v === null || v === undefined || v === '') return d;
  v = Number(v);
  return isFinite(v) ? v : d;
}
// A rect saved on a bigger screen — or on a monitor that is no longer there — would put
// the window somewhere it can never be grabbed back from. Clamp until all of it is on
// screen: size first (it bounds the position), then position.
function sanitizeTermGeom(g){
  var vw = Math.max(360, window.innerWidth), vh = Math.max(200, window.innerHeight);
  var out = {};
  out.w = Math.round(Math.min(Math.max(340, tnum(g && g.w, 880)), vw));
  out.h = Math.round(Math.min(Math.max(150, tnum(g && g.h, 480)), vh));
  out.x = Math.round(Math.min(Math.max(0, tnum(g && g.x, 56)), vw - out.w));
  out.y = Math.round(Math.min(Math.max(0, tnum(g && g.y, 56)), vh - out.h));
  return out;
}

var termWins = [];
var termZTop = 80;
function b64FromBytes(u8){
  var s = '';
  for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function bytesFromB64(s){
  var bin = atob(s), u = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// Every terminal on this page, so closing the tab can end the shells it opened.
var termCores = [];

// The half of a terminal that is the same wherever it is drawn: xterm, the pty behind it,
// and the socket between. Geometry is deliberately NOT here, because the two callers want
// opposite things from it — a floating window fits its GRID to the box you dragged it to,
// while a session's terminal is pinned to the grid tmux already has and fits its FONT to
// the box instead. One question with two right answers stays with the caller.
//
// opts: { server, title, sessionId, pin, fontSize, theme, onReady, onOpen(d), onState(s) }
// pin defaults to true and only matters with a sessionId: it is the caller saying whether
// tmux's grid rules this terminal, or this terminal's grid rules tmux.
function termCore(bodyEl, opts){
  var srv = isLocal(opts.server) ? null : opts.server;
  var API = apiBase(srv);                  // '' locally, '/peer/<name>' for a peer
  var c = { term:null, fit:null, ws:null, id:null, lastSeq:null, resyncing:false,
            dead:false, destroyed:false, cols:0, rows:0,
            attached:false, pinned:false, where:'shell', api:API, server:srv || SELF.name };
  termCores.push(c);
  function fire(n, a){ if (opts[n]) opts[n](a); }
  c.send = function(o){ if (c.ws && c.ws.readyState === 1) { try { c.ws.send(JSON.stringify(o)); } catch(e) {} } };
  // The ONLY way to change the grid. It records what was sent, which is what a reconnect
  // replays on open — set the size any other way and a dropped socket comes back asking
  // the server for the size the terminal had when it was first opened, silently resizing
  // the pty out from under a window the user has since resized.
  c.setSize = function(cols, rows){
    if (c.pinned) return;                  // tmux owns this one; the server drops it anyway
    c.cols = cols; c.rows = rows;
    c.send({ type:'size', cols:cols, rows:rows });
  };
  c.note = function(html){ bodyEl.innerHTML = '<div class="term-pick"><div class="term-note">' + html + '</div></div>'; };

  c.start = function(){
    c.note('Starting a shell on <code>' + esc(opts.title || c.server) + '</code>&hellip;');
    return loadXterm().then(function(){
      if (c.destroyed) return;
      bodyEl.innerHTML = '';
      c.term = new Terminal({
        fontSize: opts.fontSize || 13,
        fontFamily: 'ui-monospace, Menlo, Consolas, "Cascadia Code", monospace',
        cursorBlink: true, scrollback: 5000,
        theme: TERM_THEMES[opts.theme === 'dark' ? 'dark' : 'light'],
      });
      c.fit = new FitAddon.FitAddon();
      c.term.loadAddon(c.fit);
      c.term.open(bodyEl);
      fire('onReady');                     // the caller's one chance to size the grid first
      c.cols = c.term.cols; c.rows = c.term.rows;
      // One socket is one ordered stream, so keystrokes need no sequencing of their own.
      c.term.onData(function(d){ c.send({ type:'in', b: b64FromBytes(new TextEncoder().encode(d)) }); });
      // onBinary hands over raw bytes as latin-1 chars — encoding them as UTF-8 would
      // corrupt anything above 0x7f, so they go across as they are.
      c.term.onBinary(function(d){
        var u = new Uint8Array(d.length);
        for (var i = 0; i < d.length; i++) u[i] = d.charCodeAt(i) & 0xff;
        c.send({ type:'in', b: b64FromBytes(u) });
      });
      return fetch(API + '/api/term/open', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ cols:c.cols, rows:c.rows, sessionId: opts.sessionId || null,
                               pin: opts.pin !== false }) })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (c.destroyed) return;
          if (!d || d.error) {
            c.term.write('\\r\\n\\x1b[31m' + ((d && d.error) || 'could not start a shell') + '\\x1b[0m\\r\\n');
            c.dead = true; fire('onState', 'dead');
            return;
          }
          c.id = d.id;
          c.attached = !!d.attached;
          c.pinned = !!d.pinned;
          c.where = d.where || (d.attached ? 'pane' : 'shell');
          // A pinned terminal's grid is tmux's, not ours — the server sized the pty to
          // what tmux already had, and this is the browser being told what it must draw.
          if (c.pinned && d.cols && d.rows) { c.cols = d.cols; c.rows = d.rows; }
          fire('onOpen', d);
          connect();
        });
    }).catch(function(e){
      if (!c.destroyed) c.note('Could not load xterm.js from the CDN (' + esc(String(e.message || e)) + '). ' +
        'The terminal needs it; the rest of ccbb does not.');
    });
  };

  // — the socket —
  var reconnectTimer = null, resyncQuiet = null;
  // A replayed backlog arrives in bulk, and xterm only sticks to the bottom while the
  // viewport is already there — so after a reset the screen would be rebuilt correctly
  // and then left scrolled to the middle of it. Follow the tail until replay goes quiet.
  function afterResyncWrite(){
    c.term.scrollToBottom();
    clearTimeout(resyncQuiet);
    resyncQuiet = setTimeout(function(){ c.resyncing = false; }, 400);
  }
  function connect(){
    if (c.destroyed || c.dead || !c.id) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + API + '/ws-term/' + c.id +
      (c.lastSeq != null ? '?from=' + c.lastSeq : ''));
    c.ws = ws;
    ws.onopen = function(){
      fire('onState', 'live');
      // Never for a pinned terminal: its size is tmux's, and the server drops the frame
      // anyway. Saying it at all would be the page claiming an authority it gave up.
      if (!c.pinned) c.send({ type:'size', cols:c.cols, rows:c.rows });
    };
    ws.onmessage = function(ev){
      var f; try { f = JSON.parse(ev.data); } catch(e) { return; }
      if (f.type === 'o') {
        // Ordered by construction. A hole means loss, not reordering — so drop the
        // socket and let the reconnect replay, rather than piecing the screen together.
        if (c.lastSeq != null && f.seq !== c.lastSeq + 1) { c.lastSeq = null; try { ws.close(); } catch(e) {} return; }
        c.lastSeq = f.seq;
        c.term.write(bytesFromB64(f.b), c.resyncing ? afterResyncWrite : undefined);
      } else if (f.type === 'reset') {
        c.term.reset(); c.lastSeq = null; c.resyncing = true;
      } else if (f.type === 'exit') {
        c.dead = true;
        fire('onState', 'dead');
        c.term.write('\\r\\n\\x1b[90m[shell exited' + (f.code != null ? ' (' + f.code + ')' : '') + ']\\x1b[0m\\r\\n');
        try { ws.close(); } catch(e) {}
      }
    };
    ws.onclose = function(){
      if (c.destroyed || c.dead) return;
      fire('onState', '');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1000);
    };
  }

  c.destroy = function(){
    if (c.destroyed) return;
    c.destroyed = true;
    clearTimeout(reconnectTimer); clearTimeout(resyncQuiet);
    if (c.id && !c.dead) {
      if (c.ws && c.ws.readyState === 1) c.send({ type:'close' });
      else fetch(API + '/api/term/' + c.id + '/close', { method:'POST' }).catch(function(){});
    }
    if (c.ws) { try { c.ws.close(); } catch(e) {} }
    if (c.term) { try { c.term.dispose(); } catch(e) {} }
    var i = termCores.indexOf(c);
    if (i >= 0) termCores.splice(i, 1);
  };
  return c;
}

function openTerminalWindow(server, opts){
  opts = opts || {};
  var srv = isLocal(server) ? null : server;
  var name = srv || SELF.name;
  var API = apiBase(srv);          // '' locally, '/peer/<name>' for a peer — same routes
  // One terminal per server. A second window would be a second writer of that server's
  // cookie, so the two would fight over the remembered layout. Replacing means the old
  // shell ends and the new one takes its place — including its position and size, which
  // destroy() has just written to the cookie the new window is about to read.
  for (var q = termWins.length - 1; q >= 0; q--) if (termWins[q].server === name) termWins[q].destroy();
  var saved = null;
  var raw = cookieGet(termCookieName(name));
  if (raw) { try { saved = JSON.parse(raw); } catch(e) { saved = null; } }

  var w = { term:null, fit:null, destroyed:false, cols:0, rows:0, server:name,
            fontSize: Math.max(8, Math.min(28, Math.round(tnum(saved && saved.fontSize, 13)))),
            theme: (saved && saved.theme === 'dark') ? 'dark' : 'light' };
  // Cascade only a window we have never placed; a remembered one goes back where it was.
  var n = termWins.length % 8;
  var geom = sanitizeTermGeom(saved || { x: 56 + n * 28, y: 56 + n * 28, w: 880, h: 480 });

  var el = document.createElement('div');
  el.className = 'term-win' + (w.theme === 'dark' ? ' dark' : '');
  el.style.cssText = 'left:'+geom.x+'px;top:'+geom.y+'px;width:'+geom.w+'px;height:'+geom.h+'px;z-index:'+(++termZTop);
  el.innerHTML =
    '<div class="term-head"><span class="term-title"></span>'+
      '<div class="term-btns">'+
        '<button class="term-btn" data-t="cfg" title="Settings">&#9881;</button>'+
        '<span class="term-sep"></span>'+
        '<button class="term-btn" data-t="min" title="Minimize">&#8211;</button>'+
        '<button class="term-btn" data-t="max" title="Maximize">&#9633;</button>'+
        '<button class="term-btn" data-t="close" title="Close">&#10005;</button>'+
      '</div></div>'+
    '<div class="term-cfg">'+
      '<div class="crow"><span class="clbl">Text</span>'+
        '<button data-c="fdown" title="Smaller">A&#8722;</button>'+
        '<span class="cval" data-v="font"></span>'+
        '<button data-c="fup" title="Larger">A+</button></div>'+
      '<div class="crow"><span class="clbl">Theme</span>'+
        '<button data-c="theme" data-v="theme"></button></div>'+
      '<div class="crow"><span class="clbl">Size</span>'+
        '<input data-c="cols" type="number" min="20" max="500" title="Columns">'+
        '<span class="cx">&times;</span>'+
        '<input data-c="rows" type="number" min="5" max="200" title="Rows">'+
        '<button data-c="grid" title="Resize the window to this grid">Set</button></div>'+
    '</div>'+
    '<div class="term-body"></div>'+
    '<div class="term-grip" title="Resize"></div>';
  document.body.appendChild(el);
  w.el = el;
  termWins.push(w);

  var head = el.querySelector('.term-head');
  var titleEl = el.querySelector('.term-title');
  var bodyEl = el.querySelector('.term-body');
  var cfgEl = el.querySelector('.term-cfg');
  var grip = el.querySelector('.term-grip');
  titleEl.textContent = name;
  el.addEventListener('mousedown', function(){ el.style.zIndex = ++termZTop; });

  // — remembered state —
  // Maximized and minimized are transient: persisting either would restore a window
  // that fills the screen, or one with no body, and hide where it really lives.
  var lastRect = { x: geom.x, y: geom.y, w: geom.w, h: geom.h };
  var lastGrid = { cols: Math.round(tnum(saved && saved.cols, 0)), rows: Math.round(tnum(saved && saved.rows, 0)) };
  // The grid to open at, kept apart from the one being tracked. noteRect() overwrites
  // lastGrid with whatever the terminal currently measures, and it runs — via onOpen —
  // before the remembered grid is applied, so reading the wish out of lastGrid at that
  // point read back the fit it was meant to correct, and the saved columns and rows were
  // silently ignored on every open.
  var openGrid = { cols: lastGrid.cols, rows: lastGrid.rows };
  var saveTimer = null;
  function transient(){ return el.classList.contains('max') || el.classList.contains('min'); }
  function noteRect(){
    if (transient()) return;
    var r = el.getBoundingClientRect();
    lastRect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    if (w.term) lastGrid = { cols: w.term.cols, rows: w.term.rows };
  }
  function writeState(){
    cookieSet(termCookieName(name), JSON.stringify({
      x: lastRect.x, y: lastRect.y, w: lastRect.w, h: lastRect.h,
      fontSize: w.fontSize, theme: w.theme, cols: lastGrid.cols, rows: lastGrid.rows,
    }));
  }
  function saveSoon(){ clearTimeout(saveTimer); saveTimer = setTimeout(writeState, 250); }
  // Called on unload, where a debounce would never fire.
  w.saveNow = function(){ clearTimeout(saveTimer); noteRect(); writeState(); };

  // — drag by the header, resize by the corner grip —
  function dragWith(e, onMove){
    var sx = e.clientX, sy = e.clientY, r = el.getBoundingClientRect();
    function mv(ev){ onMove(r, ev.clientX - sx, ev.clientY - sy); }
    function up(){
      document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
      noteRect(); saveSoon();
    }
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    e.preventDefault();
  }
  head.addEventListener('mousedown', function(e){
    if (e.target.closest('.term-btn') || el.classList.contains('max')) return;
    dragWith(e, function(r, dx, dy){
      // Keep the whole window on screen, for the same reason the saved rect is clamped.
      el.style.left = Math.max(0, Math.min(window.innerWidth - r.width, r.left + dx)) + 'px';
      el.style.top = Math.max(0, Math.min(window.innerHeight - r.height, r.top + dy)) + 'px';
    });
  });
  grip.addEventListener('mousedown', function(e){
    dragWith(e, function(r, dx, dy){
      el.style.width = Math.max(340, Math.min(window.innerWidth - r.left, r.width + dx)) + 'px';
      el.style.height = Math.max(150, Math.min(window.innerHeight - r.top, r.height + dy)) + 'px';
    });
  });

  // — header + config controls —
  function syncBtns(){
    var mx = el.querySelector('.term-btn[data-t="max"]');
    var on = el.classList.contains('max');
    mx.innerHTML = on ? '&#10064;' : '&#9633;';
    mx.title = on ? 'Restore' : 'Maximize';
  }
  function syncCfg(){
    cfgEl.querySelector('[data-v="font"]').textContent = w.fontSize;
    cfgEl.querySelector('[data-v="theme"]').textContent = w.theme === 'dark' ? 'white on black' : 'black on white';
    var ci = cfgEl.querySelector('input[data-c="cols"]'), ri = cfgEl.querySelector('input[data-c="rows"]');
    if (document.activeElement !== ci) ci.value = w.term ? w.term.cols : (lastGrid.cols || '');
    if (document.activeElement !== ri) ri.value = w.term ? w.term.rows : (lastGrid.rows || '');
  }
  function applyTheme(){
    el.classList.toggle('dark', w.theme === 'dark');
    if (w.term) w.term.options.theme = TERM_THEMES[w.theme];
  }
  function applyFont(){
    if (w.term) w.term.options.fontSize = w.fontSize;
    refit();
  }
  el.querySelector('.term-btns').addEventListener('click', function(e){
    var b = e.target.closest('.term-btn');
    if (!b) return;
    var t = b.dataset.t;
    if (t === 'close') return destroy();
    if (t === 'cfg') { el.classList.toggle('cfg'); syncCfg(); return; }
    if (t === 'min') { el.classList.toggle('min'); el.classList.remove('max'); }
    else if (t === 'max') { el.classList.toggle('max'); el.classList.remove('min'); }
    syncBtns();
    if (!transient()) { noteRect(); saveSoon(); }
    if (w.term && !el.classList.contains('min')) w.term.focus();
  });
  cfgEl.addEventListener('click', function(e){
    var b = e.target.closest('button');
    if (!b) return;
    var c = b.dataset.c;
    if (c === 'fup') { w.fontSize = Math.min(28, w.fontSize + 1); applyFont(); }
    else if (c === 'fdown') { w.fontSize = Math.max(8, w.fontSize - 1); applyFont(); }
    else if (c === 'theme') { w.theme = w.theme === 'dark' ? 'light' : 'dark'; applyTheme(); }
    else if (c === 'grid') applyGridFromInputs();
    syncCfg(); saveSoon();
  });
  cfgEl.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); applyGridFromInputs(); }
  });
  cfgEl.addEventListener('change', function(e){ if (e.target.tagName === 'INPUT') applyGridFromInputs(); });
  function applyGridFromInputs(){
    var c = parseInt(cfgEl.querySelector('input[data-c="cols"]').value, 10);
    var r = parseInt(cfgEl.querySelector('input[data-c="rows"]').value, 10);
    if (isFinite(c) && isFinite(r)) applyGrid(c, r, 0);
  }
  syncBtns(); syncCfg();

  // — geometry —
  // The grid is what you ask for and the window wraps it, so the two can never disagree:
  // typing a size resizes the window, dragging the window updates the size.
  function applyGrid(cols, rows, tries){
    if (!w.term) return;
    cols = Math.max(20, Math.min(500, Math.round(cols)));
    rows = Math.max(5, Math.min(200, Math.round(rows)));
    var scr = el.querySelector('.xterm-screen');
    if (!scr) return;
    var sr = scr.getBoundingClientRect();
    var cw = sr.width / w.term.cols, ch = sr.height / w.term.rows;
    if (!(cw > 0 && ch > 0)) return;
    el.classList.remove('max', 'min');
    var er = el.getBoundingClientRect();
    var g = sanitizeTermGeom({ x: er.left, y: er.top,
      w: Math.round(er.width + (cols - w.term.cols) * cw),
      h: Math.round(er.height + (rows - w.term.rows) * ch) });
    el.style.left = g.x + 'px'; el.style.top = g.y + 'px';
    el.style.width = g.w + 'px'; el.style.height = g.h + 'px';
    syncBtns();
    // Cell sizes are fractional, so the first guess lands a column or two out; one or
    // two corrections settle it. A grid too big for the screen stops here instead, with
    // the fields showing what it actually got.
    setTimeout(function(){
      fitNow();
      if ((w.term.cols !== cols || w.term.rows !== rows) && (tries || 0) < 2) applyGrid(cols, rows, (tries || 0) + 1);
      else { noteRect(); syncCfg(); saveSoon(); }
    }, 80);
  }
  function fitNow(){
    // The window opens unpinned even against a session (see the termCore call below), so
    // this is a guard against a server that pinned it anyway rather than a case.
    if (!w.term || !w.fit || core.pinned || el.classList.contains('min')) return;
    try { w.fit.fit(); } catch(e) { return; }
    if (w.term.cols === w.cols && w.term.rows === w.rows) return;
    w.cols = w.term.cols; w.rows = w.term.rows;
    core.setSize(w.cols, w.rows);
    syncCfg();
    noteRect(); saveSoon();
  }
  var refitTimer = null;
  function refit(){ clearTimeout(refitTimer); refitTimer = setTimeout(fitNow, 60); }
  var obs = null;
  if (window.ResizeObserver) { obs = new ResizeObserver(refit); obs.observe(bodyEl); }
  // A browser window that shrank can leave a remembered rect hanging off the edge.
  function onViewportResize(){
    if (!transient()) {
      var g = sanitizeTermGeom(el.getBoundingClientRect());
      el.style.left = g.x + 'px'; el.style.top = g.y + 'px';
      el.style.width = g.w + 'px'; el.style.height = g.h + 'px';
      noteRect();
    }
    refit();
  }
  window.addEventListener('resize', onViewportResize);

  // The chrome above is this function's; the terminal itself is not. onReady runs with a
  // live xterm and no pty yet, which is the one moment the grid can be fitted to the
  // window before anything is opened at the wrong size.
  var core = termCore(bodyEl, {
    server: srv, title: name, sessionId: opts.sessionId || null,
    // Explicitly not pinned. This window has a size you dragged it to and a grid
    // remembered in a cookie; it is a tmux client like any other and resizes the session
    // to fit itself. Only the in-view terminal leaves tmux's grid alone.
    pin: false,
    fontSize: w.fontSize, theme: w.theme,
    onReady: function(){
      w.term = core.term; w.fit = core.fit;
      try { core.fit.fit(); } catch(e) {}
      w.cols = core.term.cols; w.rows = core.term.rows;
      core.term.focus();
      syncCfg();
    },
    onOpen: function(d){
      // The title is the server, nothing else — it is the one thing you need to read at
      // a glance. Which of the three shells you got still matters (asking for a pane and
      // silently getting a login shell would be a surprise), so it goes in the tooltip.
      titleEl.textContent = name;
      titleEl.title = name + (d.where === 'pane' ? ' — attached to the session pane'
                            : d.where === 'window' ? ' — a window opened for this session'
                            : ' — login shell');
      // Write the state once up front. Otherwise a window that is opened and never
      // touched — the common case — would leave nothing behind to restore, since
      // every other save hangs off an actual change.
      noteRect(); saveSoon();
      // A remembered grid is applied once the shell is up, so the window ends at the
      // size it had rather than at whatever the restored rect happened to fit.
      if (!core.pinned && openGrid.cols && openGrid.rows)
        setTimeout(function(){ applyGrid(openGrid.cols, openGrid.rows, 0); }, 60);
    },
    onState: function(st){
      el.classList.toggle('live', st === 'live');
      el.classList.toggle('dead', st === 'dead');
    },
  });
  core.start();

  function destroy(){
    w.destroyed = true;
    clearTimeout(refitTimer);
    w.saveNow();   // the debounce would be cancelled by the teardown below
    core.destroy();
    if (obs) { try { obs.disconnect(); } catch(e) {} }
    window.removeEventListener('resize', onViewportResize);
    el.remove();
    var i = termWins.indexOf(w);
    if (i >= 0) termWins.splice(i, 1);
  }
  w.destroy = destroy;
  return w;
}
// Closing the tab ends the shells it opened. sendBeacon is the only thing that survives
// unload, which is why one HTTP close route exists alongside the socket.
window.addEventListener('pagehide', function(){
  termWins.forEach(function(w){ if (w.saveNow) w.saveNow(); });
  termCores.forEach(function(c){
    if (c.id && !c.dead && navigator.sendBeacon) navigator.sendBeacon(c.api + '/api/term/' + c.id + '/close');
  });
});

// ── boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('visibilitychange', function(){
  if (!document.hidden) views.forEach(function(v){ if (v.onExpanded && !v.el.classList.contains('collapsed')) v.onExpanded(); });
});
var listView = createListView();
views.push(listView);
viewsEl.appendChild(listView.el);
// The remembered orientation has to reach the DOM before the first layout, or a page
// restored as columns would flash stacked and reflow.
viewsEl.classList.toggle('horizontal', orientation === 'horizontal');
relayout();
if (INIT_OPEN) openSession(INIT_OPEN.sessionId, INIT_OPEN.server);
`;

// ── Page HTML assembly ─────────────────────────────────────────────────────────
function appPageHtml(initOpenSessionId, initOpenServer, ro) {
  const open = initOpenSessionId ? { sessionId: initOpenSessionId, server: initOpenServer || null } : null;
  return APP_HTML.replace('__APP_JS__',
    () => APP_JS
      .replace('__PRICING__', () => JSON.stringify(priceTable))
      .replace('__SELF__', () => JSON.stringify(serverIdentity()))
      .replace('__RO__', () => JSON.stringify(!!ro))
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

// ── Session-list sockets: snapshot once, then deltas ─────────────────────────
// The list used to poll every server every 10s for a table that changes a few times an
// hour. Instead each browser holds one socket per server: the first message is the whole
// list, and afterwards only the rows that actually changed are sent, driven by the
// filesystem watcher rather than a timer. A busy session's row moves a few hundred bytes;
// an idle machine sends nothing at all.
//
// Scope (all-time vs one month) is per socket and can be changed in place — the snapshot
// is re-sent, no reconnect. Each socket remembers the JSON it last sent per row, which is
// what makes the diff exact without the client acknowledging anything.
const listClients = new Set();   // { ws, month, rows: Map<sessionId, json>, totals }
const clients = new Map();       // sessionId → Set<ws>, the open session views
let listUnwatch = null;

function listSnapshot(month) {
  return getSessions(month ? { period: 'month', key: month } : null);
}

function sendList(c, snap) {
  const rows = new Map();
  for (const row of snap.sessions) rows.set(row.sessionId, JSON.stringify(row));
  c.rows = rows;
  c.totals = JSON.stringify(snap.totals);
  wsJson(c.ws, { type: 'list', sessions: snap.sessions, totals: snap.totals, month: c.month || null });
}

function wsJson(ws, obj) {
  if (ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}

// One pass over the watcher's event: compute each distinct scope at most once, then send
// each client only its own difference.
function pushListDeltas() {
  if (!listClients.size) return;
  const snaps = new Map();
  for (const c of listClients) {
    const key = c.month || '';
    if (!snaps.has(key)) { try { snaps.set(key, listSnapshot(c.month)); } catch { snaps.set(key, null); } }
    const snap = snaps.get(key);
    if (!snap) continue;
    const upd = [], next = new Map();
    for (const row of snap.sessions) {
      const j = JSON.stringify(row);
      next.set(row.sessionId, j);
      if (c.rows.get(row.sessionId) !== j) upd.push(row);
    }
    const del = [];
    for (const id of c.rows.keys()) if (!next.has(id)) del.push(id);
    const totals = JSON.stringify(snap.totals);
    c.rows = next;
    if (!upd.length && !del.length && totals === c.totals) continue;
    c.totals = totals;
    wsJson(c.ws, { type: 'delta', upd, del, totals: snap.totals });
  }
}

// Liveness for the open session views. The registry is watched anyway, so a session going
// busy → idle → gone reaches the page as a push instead of a per-view poll.
const liveSent = new Map();   // sessionId → last JSON sent
function liveMsg(sessionId) {
  const l = sessionLiveness(sessionId);
  return JSON.stringify({ type: 'live', live: !!l.live, status: l.status || null, statusAt: l.statusUpdatedAt || null });
}
function pushLiveStatus() {
  for (const sessionId of clients.keys()) {
    const msg = liveMsg(sessionId);
    if (liveSent.get(sessionId) === msg) continue;
    liveSent.set(sessionId, msg);
    const set = clients.get(sessionId);
    for (const ws of set) if (ws.readyState === 1) { try { ws.send(msg); } catch {} }
  }
  for (const id of Array.from(liveSent.keys())) if (!clients.has(id)) liveSent.delete(id);
}

// Watch-driven list deltas are OFF by default: the list updates when you ask it to
// (the refresh button re-requests a snapshot over the same socket). Set
// CCBB_LIST_WATCH=1 to have the filesystem watcher push row changes as they happen.
const LIST_WATCH = process.env.CCBB_LIST_WATCH === '1';

function onSessionSetChanged() {
  if (LIST_WATCH) pushListDeltas();
  pushLiveStatus();
}

// Liveness for open session views does not ride on the watcher alone. Reading the session
// registry is a directory of small files on local disk, so a 5s sweep costs nothing, and
// pushLiveStatus only sends when a session's status actually changed — an idle machine
// still puts no bytes on the wire.
const LIVE_SWEEP_MS = 5000;
let liveTimer = null;
function ensureSessionWatch() {
  // With list pushes off, the watcher has no consumer the sweep doesn't already cover, so
  // it isn't started at all.
  if (LIST_WATCH && !listUnwatch) listUnwatch = watchSessionChanges(onSessionSetChanged);
  if (!liveTimer) { liveTimer = setInterval(pushLiveStatus, LIVE_SWEEP_MS); if (liveTimer.unref) liveTimer.unref(); }
}
function releaseSessionWatch() {
  if (listClients.size || clients.size) return;
  if (listUnwatch) { listUnwatch(); listUnwatch = null; }
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
}
function addListClient(c) { listClients.add(c); ensureSessionWatch(); }
function removeListClient(c) { listClients.delete(c); releaseSessionWatch(); }

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

// ── host terminals ─────────────────────────────────────────────────────────────
// A login shell on the machine this server runs on, under a real pty. No ssh: a peer's
// terminal rides the connection ccbb already holds to that peer — /peer/<name>/ws-term/…
// is spliced by proxyUpgrade for a configured peer, and by proxyUpgradeOverLink for one
// that only linked in to us. That is also why the transport is a WebSocket rather than
// SSE: proxyHttpOverLink buffers a whole response before returning it, so a stream would
// never reach a browser through an inbound link, while WebSockets splice both ways.
//
// One socket is one ordered stream, so bytes cannot arrive out of order in either
// direction. The sequence number on output is an assertion and a resume cursor, not the
// input to a reordering buffer: a number that isn't last+1 means bytes were LOST, and
// the only honest repair is to clear the screen and replay the backlog.
//
// Node cannot open a pty without a native module, so script(1) opens it. That costs us
// the master fd — but the pty's SLAVE is the shell's stdin, and setting the window size
// THERE is what makes the kernel raise SIGWINCH, so resize still reaches full-screen
// programs.
const TERM_BACKLOG_BYTES = 256 * 1024;   // replayed after a dropped socket
const TERM_GRACE_MS = 5 * 60 * 1000;     // reconnect window after the last socket goes
const terms = new Map();                 // id → terminal
let termIds = 0;
function clampInt(v, lo, hi, dflt) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
}

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

// ── where a session's terminal lands ──────────────────────────────────────────
// The rule this whole block exists to keep: attaching must not resize tmux. A browser
// terminal is a tmux CLIENT, and tmux sizes a session to its clients — so a pty even one
// row off from what tmux already has reflows the TUI in the user's own terminal, and
// leaves it reflowed until the browser closes. The pty is therefore built to tmux's
// measurements rather than the window's, and the browser scales its FONT to that grid.

// A client carries the status line(s); the window does not. window_height is the window,
// so a client of exactly window_height rows is one (or two, or none) short of what tmux
// expects and tmux shrinks the window to match. Ask what the status costs and add it.
function tmuxStatusLines(sess) {
  const read = args => { try { return tmux(args).trim(); } catch { return ''; } };
  // Unset on the session means "inherit the global"; show-options prints nothing rather
  // than the inherited value, so an empty answer is a question, not an answer.
  const v = (sess && read(['show-options', '-v', '-t', sess, 'status'])) ||
            read(['show-options', '-g', '-v', 'status']);
  if (v === 'off') return 0;
  if (v === 'on' || v === '') return 1;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 1;
}

// Which real tmux session a pane belongs to. NOT display-message '#{session_name}':
// grouped sessions share a window list, so a pane in a group belongs to several sessions
// at once and tmux answers with whichever name sorts first — often one of OUR ccbb-*
// sessions, i.e. this feature's own bookkeeping mistaken for the user's session.
function baseSessionForPane(pane) {
  let lines = '';
  try { lines = tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}']); } catch { return null; }
  let fallback = null;
  for (const l of lines.split('\n')) {
    const [id, sess] = l.split('\t');
    if (id !== pane || !sess) continue;
    if (!isOurGroupName(sess)) return sess;   // a session of the user's — the answer
    fallback = fallback || sess;
  }
  return fallback;                            // only ours left: the base was killed
}

// The pane's session, its window, and the window's own size. The STATUS LINES are not
// added here on purpose: they belong to the session the client attaches to, which is the
// grouped one, and session options do not cross into a grouped session — a `status off`
// set on the user's session leaves the group inheriting the global `on`. Measuring the
// wrong session is one row of error, and one row of error resizes the window, which is
// the single thing this must never do. See termTargetFor for where they are added.
function tmuxGeom(pane) {
  let out;
  try { out = tmux(['display-message', '-p', '-t', pane, '#{window_width}\t#{window_height}\t#{window_id}']); }
  catch { return null; }
  const [w, h, win] = out.split('\n')[0].split('\t');
  const sess = baseSessionForPane(pane);
  const cols = Number(w), rows = Number(h);
  if (!sess || !Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return null;
  return { session: sess, window: win || '', cols, winRows: rows };
}

// ── one tmux client per session page ──────────────────────────────────────────
// Every browser terminal is already its own tmux CLIENT, but they all used to attach to
// the same tmux SESSION — and a session has one current window, shared by every client on
// it. So opening session B's terminal dragged session A's terminal, and your own terminal,
// onto B's window.
//
// Sessions in a GROUP share the window list but each keeps its own current window, which
// is exactly the seam this needs: one grouped session per Claude session. It is named so
// that it is obvious in `tmux ls` whose it is, and so the orphan sweep below can recognise
// its own work without guessing.
//
// What grouping does NOT isolate: a window's active pane belongs to the WINDOW, so
// selecting Claude's pane still moves it for everyone. Only the window jump stops leaking.
// Fixed length, always: tmux target strings fall back to prefix and glob matching after
// an exact miss, so a SHORT name is a wildcard for a longer one — `ccbb-1a2b` resolves to
// `ccbb-1a2b3c4d` and a kill-session aimed at the first destroys the second. Names are
// therefore all exactly 13 characters, which no other name of ours can be a prefix of,
// and the id is validated at the route so a short one never reaches here.
function tmuxGroupName(sessionId) {
  const clean = String(sessionId).replace(/[^A-Za-z0-9]/g, '');
  // Eight alphanumerics ALWAYS. Stripping before slicing means a punctuation-heavy id
  // ("a_______") would otherwise yield "ccbb-a" — six characters, which isOurGroupName
  // rejects and which prefix-matches every longer sibling on the calls that cannot use
  // exact() (set-option refuses it). Then the sweep never reaps it and a defuse aimed at
  // it disarms somebody else. A hash keeps the length rule true for any input while
  // staying deterministic; a real session id takes the readable path.
  if (clean.length >= 8) return 'ccbb-' + clean.slice(0, 8);
  return 'ccbb-' + crypto.createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 8);
}
function isOurGroupName(name) { return isCcbbGroupSession(name); }
// `=` is tmux's exact-match prefix. Belt and braces over the length rule above, and used
// on the two calls where being wrong is destructive rather than merely wrong.
function exact(name) { return '=' + name; }

// The session to actually attach to: a grouped one when we can make it, otherwise the base
// session itself. Falling back rather than failing matters — attaching to the base is what
// ccbb always did, so an old tmux or a name we cannot claim costs you the isolation and
// nothing else.
function tmuxAttachSession(sessionId, base) {
  const name = tmuxGroupName(sessionId);
  const group = t => { try { return tmux(['display-message', '-p', '-t', t, '#{session_group}']).trim(); } catch { return null; } };
  try {
    let exists = true;
    try { tmux(['has-session', '-t', exact(name)]); } catch { exists = false; }
    // A Claude session can move between tmux sessions across a restart, and a grouped
    // session left pointing at the old one shares the wrong window list entirely.
    if (exists && group(name) !== (group(base) || base)) {
      try { tmux(['kill-session', '-t', exact(name)]); } catch {}
      exists = false;
    }
    if (!exists) tmux(['new-session', '-d', '-s', name, '-t', base]);
    return name;
  } catch { return base; }
}

// destroy-unattached is what lets tmux reap the grouped session with no help from ccbb —
// including after a kill -9 that ccbb cannot catch, and including the case of two browser
// terminals sharing one session, where "is anyone else still here" is not a question ccbb
// should be trying to answer.
//
// It is armed only once a client is actually attached. Set on a session that is still
// detached, tmux destroys it inside a second and the attach that was a moment away finds
// nothing left to attach to. That is not a theoretical race; it is what happens.
// How many sessions still share this one's windows. 1 means it is the only thing holding
// them: the user's session was killed out from under it, and the windows — a running
// Claude among them — now live HERE. Destroying it then destroys them.
function groupSize(name) {
  try { return Number(tmux(['display-message', '-p', '-t', name, '#{session_group_size}'])) || 1; }
  catch { return 0; }                      // gone already
}
// Take the charge out of a session that has become the sole holder of its windows.
// destroy-unattached has no notion of "unless that would kill something", so the notion
// has to be applied before the last client leaves rather than after.
function defuseIfSoleHolder(name) {
  // Exactly one. Zero means the session is already gone, and reporting that as "kept"
  // would log about something that no longer exists.
  if (groupSize(name) !== 1) return false;
  try { tmux(['set-option', '-t', name, 'destroy-unattached', 'off']); } catch {}
  return true;
}
function armDestroyUnattached(name, tries) {
  let clients = '';
  try { clients = tmux(['list-clients', '-t', name, '-F', '#{client_name}']).trim(); } catch {}
  if (clients) { try { tmux(['set-option', '-t', name, 'destroy-unattached', 'on']); } catch {} return; }
  if ((tries || 0) < 25) {                 // 5s, then give up and let the sweep have it
    const h = setTimeout(() => armDestroyUnattached(name, (tries || 0) + 1), 200);
    if (h.unref) h.unref();
  }
}

// The tmux session that already holds the most Claude Codes. A session that isn't running
// gets a window made for it, and it belongs beside its siblings rather than in whichever
// tmux session happens to be listed first. Ties break on the most recently updated Claude
// session in each, then on the name — so the answer is stable across calls instead of
// depending on directory read order.
function busiestTmuxSession() {
  const score = new Map();
  for (const hit of panesForLiveSessions().values()) {
    // Our own grouped sessions are not somewhere to put a window: they come and go with a
    // browser tab, and one of them being "busiest" would mean making the user's window
    // inside another page's scratch session.
    if (!hit.session || isOurGroupName(hit.session)) continue;
    const e = score.get(hit.session) || { n: 0, newest: 0 };
    e.n++; e.newest = Math.max(e.newest, hit.rec.updatedAt || 0);
    score.set(hit.session, e);
  }
  if (score.size) {
    return Array.from(score.keys()).sort((a, b) =>
      (score.get(b).n - score.get(a).n) ||
      (score.get(b).newest - score.get(a).newest) ||
      a.localeCompare(b))[0];
  }
  // tmux is running but no Claude is: any session beats inventing one.
  try {
    const names = tmux(['list-sessions', '-F', '#{session_name}'])
      .split('\n').filter(n => n && !isOurGroupName(n)).sort();
    return names[0] || null;
  } catch { return null; }
}

// The window this server made for a session that was not running, found by NAME rather
// than remembered in a Map. Memory does not survive a restart, and a second open after one
// would make a second window for the same session — which is the littering this exists to
// prevent. The name is also what tells you in tmux whose window it is, and it is the same
// slug as the grouped session so the two read as a pair.
function findMadeWindow(sessionId) {
  const want = tmuxGroupName(sessionId);
  let lines = '';
  try { lines = tmux(['list-windows', '-a', '-F', '#{window_name}\t#{pane_id}']); } catch { return null; }
  // list-windows -a repeats a window once per session in its group, so the same window
  // arrives several times; the first hit is the answer either way.
  for (const l of lines.split('\n')) {
    const [name, pane] = l.split('\t');
    if (name === want && pane) return pane;
  }
  return null;
}

// A recorded cwd can name a directory that has since been deleted or unmounted. spawn()
// answers that with 'error' and 'close' but NO 'exit', so the terminal would never report
// its own death: the lamp stays green, no exit frame is sent, and the entry lingers until
// the reaper. tmux is blunter — new-window just fails — which then falls back to a login
// shell in the same missing directory. Check once, here.
function usableCwd(dir) {
  if (!dir) return null;
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

// Where a session's terminal should land, in order of preference:
//   • the session is live in a pane       → attach there
//   • it is not, but tmux is running here → a window of its own in the busiest tmux
//                                           session, cd'd to the session's directory.
//                                           No claude is started: resuming a session is
//                                           the user's decision, not a side effect of
//                                           opening a terminal.
//   • no tmux at all                      → null; openTerm falls back to a login shell
function termTargetFor(sessionId) {
  // The grouped session is resolved once, at the end, from whichever pane won — it hangs
  // off the Claude session, not off how the pane was found.
  const withGroup = (t) => {
    t.attachTo = tmuxAttachSession(sessionId, t.session);
    t.grouped = t.attachTo !== t.session;
    // Now, and not before: the status lines belong to whichever session the client
    // attaches to, and that is only decided here. See tmuxGeom.
    t.rows = t.winRows + tmuxStatusLines(t.attachTo);
    return t;
  };
  const loc = paneForSession(sessionId);
  if (loc) {
    const g = tmuxGeom(loc.pane);
    if (g) return withGroup({ pane: loc.pane, session: g.session, window: g.window,
                              cols: g.cols, winRows: g.winRows, where: 'pane' });
  }
  const kept = findMadeWindow(sessionId);
  if (kept) {
    const g = tmuxGeom(kept);
    if (g) return withGroup({ pane: kept, session: g.session, window: g.window,
                              cols: g.cols, winRows: g.winRows, where: 'window' });
  }
  const host = busiestTmuxSession();
  if (!host) return null;
  const cwd = usableCwd(getSessionCwd(sessionId)) || os.homedir();
  let pane;
  // -d: making the window must not yank whoever is attached to that tmux session onto it.
  // Our own attach selects it a moment later, on our grouped session only.
  // -n also turns automatic-rename off, which is what makes the name stay findable.
  try { pane = tmux(['new-window', '-d', '-t', host + ':', '-c', cwd,
                     '-n', tmuxGroupName(sessionId), '-P', '-F', '#{pane_id}']).split('\n')[0].trim(); }
  catch { return null; }
  if (!pane) return null;
  const g = tmuxGeom(pane);
  if (!g) return null;
  return withGroup({ pane, session: g.session, window: g.window,
                     cols: g.cols, winRows: g.winRows, where: 'window' });
}

// Select the window AND the pane before attaching, so the client lands on Claude's pane
// rather than wherever the tmux session was last left — including the case where another
// pane in the same window has the focus.
function tmuxAttachCmd(target) {
  // The window is selected on the session being ATTACHED to — the grouped one — so the
  // jump is this page's alone. The pane is selected by id, which is window-scoped and
  // therefore shared however this is targeted.
  const win = target.window ? target.attachTo + ':' + target.window : target.pane;
  return 'tmux select-window -t ' + shQuote(win) + ' 2>/dev/null; ' +
         'tmux select-pane -t ' + shQuote(target.pane) + ' 2>/dev/null; ' +
         'exec tmux attach -t ' + shQuote(target.attachTo);
}

// script(1) is two different programs wearing one name. util-linux takes the command
// with -c and flushes with -f; the BSD one on macOS takes the command as trailing
// arguments and flushes with -F (and older ones want -F to carry a value, so plain is a
// third possibility). Rather than key off process.platform and hope, ask the binary that
// is actually here: run each shape once, keep the one that works. Both are told to write
// their typescript to /dev/null — we read the pty through the pipe, not the file.
const SCRIPT_STYLES = {
  linux: cmd => ['-q', '-f', '-c', cmd, '/dev/null'],
  bsdF:  cmd => ['-q', '-F', '/dev/null', '/bin/sh', '-c', cmd],
  bsd:   cmd => ['-q', '/dev/null', '/bin/sh', '-c', cmd],
};

// What script(1) is handed for stdin is not a detail. BSD script calls tcgetattr() on
// its own stdin before anything else and only forgives the failure for the errnos that
// mean "not a terminal" — ENOTTY and friends. On macOS a socket (and a FIFO) answers
// EOPNOTSUPP instead, and Node's stdio:'pipe' is a socketpair, so every terminal died at
// birth with "tcgetattr/ioctl: Operation not supported on socket". Only an anonymous
// pipe answers ENOTTY, and nothing in Node creates one — a shell pipeline does. Hence
// `cat |`: cat reads our socketpair and its stdout is the pipe script wanted.
//
// util-linux script does not care, but the wrapper is used everywhere anyway. Two spawn
// shapes would mean two kill paths and two process-tree shapes for termPts() to know
// about, for no gain on the platform that already worked.
// The wrapper is NOT used unconditionally. `{ cat & } | …` puts an asynchronous command
// in a pipeline, and on WSL2 that construct silently forwards nothing: the fds are wired
// correctly — cat's stdout and script's stdin are the same pipe — but no byte ever
// crosses it, so the shell came up, printed its prompt, and then ignored every keystroke.
// It fails there under both dash and bash, and passes on native Linux, which is why "use
// the wrapper everywhere, it costs nothing" was wrong. So each machine is asked which
// shapes work and the simplest one wins: unwrapped everywhere, wrapper first on macOS
// where it is the whole point.
//
// The probe writes a marker in and waits to see it come back out, because that is the
// only question worth asking. Checking an exit status is what hid the WSL2 break, the
// same way probing with /dev/null on stdin hid the macOS one: both proved the arguments
// parsed, neither proved data moves.
let termSpawn = null;   // { style, wrapped }
function probeTermSpawn(style, wrapped) {
  const args = SCRIPT_STYLES[style]('exec cat');
  const opts = { input: 'CCBB-PROBE\n', encoding: 'utf8', timeout: 5000 };
  const r = wrapped ? spawnSync('/bin/sh', ['-c', wrapScript(args)], opts)
                    : spawnSync('script', args, opts);
  return !r.error && String(r.stdout || '').indexOf('CCBB-PROBE') !== -1;
}
function resolveTermSpawn() {
  if (termSpawn) return termSpawn;
  const mac = process.platform === 'darwin';
  const styles = mac ? ['bsdF', 'bsd', 'linux'] : ['linux', 'bsdF', 'bsd'];
  for (const wrapped of (mac ? [true, false] : [false, true])) {
    for (const style of styles) {
      if (probeTermSpawn(style, wrapped)) {
        termSpawn = { style, wrapped };
        console.log(`ccbb: terminals use script(1) ${style} style${wrapped ? ' behind a cat pipeline' : ''}`);
        return termSpawn;
      }
    }
  }
  termSpawn = mac ? { style: 'bsdF', wrapped: true } : { style: 'linux', wrapped: false };
  console.log('ccbb: no script(1) invocation passed the probe; terminals will try ' +
    `${termSpawn.style} style${termSpawn.wrapped ? ' behind a cat pipeline' : ''} anyway`);
  return termSpawn;
}
// Every piece of this line is load-bearing:
//   `cat &`   — a shell waits for every member of a pipeline, and cat stays blocked on
//               our socket long after the shell inside the pty is gone. Foreground, it
//               would hold our child open forever and a terminal exited with `exit`
//               would never report it. Backgrounded, the pipeline's first element is a
//               subshell that returns at once; cat outlives it as an orphan, still in
//               our process group, and closing the terminal kills the group.
//   `<&3`     — POSIX gives an asynchronous command /dev/null for stdin unless it is
//               redirected explicitly. Plain `cat &` would read EOF immediately, script
//               would see its stdin close, and the shell would exit before its first
//               prompt. fd 3 is the dup of ours made just before.
//   `exec`    — the pipeline's second element becomes script itself rather than a shell
//               sitting on top of it, which is what keeps the pty exactly two levels
//               below our child.
//   `3<&-`    — that dup is ours, not the user's; it does not belong in their shell.
// Everything is quoted because an argument list is being flattened back into a shell
// line, and cmd carries quoting of its own.
function wrapScript(args) {
  return 'exec 3<&0; { cat <&3 & } | exec 3<&- ' + ['script'].concat(args).map(shQuote).join(' ');
}

// pin: whether this terminal takes tmux's grid instead of imposing its own. The
// in-view terminal ($_) asks for it — you are looking at the session in the page beside
// it, and a browser that reflowed the window you are working in would be intolerable.
// The floating window (#_) does not: it is a window you sized, with a remembered grid,
// and it behaves like every other tmux client — it resizes the session to fit itself.
function openTerm(cols, rows, sessionId, pin) {
  cols = clampInt(cols, 20, 500, 80);
  rows = clampInt(rows, 5, 200, 24);
  const id = String(++termIds);
  const shell = process.env.SHELL || '/bin/bash';
  const target = sessionId ? termTargetFor(String(sessionId)) : null;
  const pinned = !!target && pin !== false;
  // Pinned, the browser's cols/rows are a HINT and tmux overrules it: sizing the pty to
  // the box the page happens to have would resize tmux on attach, while sizing it to
  // tmux leaves the far end untouched and hands the browser a grid to scale its font to.
  // Unpinned, the request is taken as asked and tmux resizes to match on attach.
  // `pinned` is that fact travelling to the front-end, and back into termResize below.
  if (pinned) { cols = target.cols; rows = target.rows; }
  const attach = target ? tmuxAttachCmd(target) : null;
  // A session's shell, when there is no tmux to put it in, still opens where the session
  // lives — the same courtesy the new tmux window gets.
  const cwd = (sessionId && !target && usableCwd(getSessionCwd(String(sessionId)))) || os.homedir();
  // stty runs inside the pty before the shell starts, so the first prompt is drawn at
  // the right geometry instead of at 80x24 and then redrawn.
  // "columns", not "cols": GNU stty takes either, BSD stty only spells it out.
  //
  // `tty` in the same breath names the pty slave, asked of the one process that can
  // answer without guessing — the shell inside it, before it becomes the shell. Walking
  // the process tree for it is the fallback, not the plan; see termPts().
  const ptsFile = path.join(os.tmpdir(), `ccbb-pts-${process.pid}-${id}`);
  const cmd = `stty rows ${rows} columns ${cols} 2>/dev/null; tty > ${shQuote(ptsFile)} 2>/dev/null; ` +
              (attach || `exec ${shell} -l`);
  let child;
  try {
    // detached either way: our child leads its own process group, so closing the terminal
    // can signal everything at once. With the wrapper that matters most — killing the sh
    // alone would strand cat and script — but keeping it for the plain shape too means
    // one kill path and one process-tree shape instead of two.
    const shape = resolveTermSpawn();
    const args = SCRIPT_STYLES[shape.style](cmd);
    const opts = {
      cwd,
      env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    };
    child = shape.wrapped ? spawn('/bin/sh', ['-c', wrapScript(args)], opts)
                          : spawn('script', args, opts);
  } catch (e) { return { error: 'could not start script(1): ' + e.message }; }
  // ptsCols/ptsRows: the geometry the pty already has. The stty above runs inside it
  // before the shell starts, so at birth it matches what was asked for.
  const t = { id, child, ptsFile, seq: 0, buf: [], bytes: 0, subs: new Set(), cols, rows, attached: !!attach,
              pinned, tmuxGroup: (target && target.grouped) ? target.attachTo : null,
              ptsCols: cols, ptsRows: rows,
              pts: null, alive: true, exitCode: null, graceTimer: null, idleSince: Date.now() };
  terms.set(id, t);
  child.stdout.on('data', c => termPush(t, c));
  child.stderr.on('data', c => termPush(t, c));
  child.stdin.on('error', () => {});
  child.on('error', e => termPush(t, Buffer.from(`\r\nccbb: ${e.message}\r\n`)));
  child.on('exit', code => {
    t.alive = false; t.exitCode = code;
    termBroadcast(t, { type: 'exit', code });
    t.idleSince = Date.now();
  });
  // Nothing here ends the grouped session — tmux does, once the last client leaves. That
  // is the whole point of arming it: closeTerm stays a matter of killing one pty, and two
  // browser terminals on one session need no bookkeeping to share it.
  if (target && target.grouped) armDestroyUnattached(target.attachTo);
  // `where` says which of the three cases the caller got: the session's own pane, a
  // window made for it, or a plain login shell. Asking for a pane and silently getting a
  // shell would be a surprise, and the page says which in its title.
  return { id, cols, rows, shell, attached: !!(target && target.where === 'pane'),
           where: target ? target.where : 'shell', pinned };
}

function termBroadcast(t, obj) {
  const frame = JSON.stringify(obj);
  for (const ws of t.subs) { try { if (ws.readyState === 1) ws.send(frame); } catch {} }
}
function termPush(t, chunk) {
  const rec = { seq: ++t.seq, b: chunk.toString('base64'), n: chunk.length };
  t.buf.push(rec);
  t.bytes += rec.n;
  while (t.buf.length > 1 && t.bytes > TERM_BACKLOG_BYTES) t.bytes -= t.buf.shift().n;
  termBroadcast(t, { type: 'o', seq: rec.seq, b: rec.b });
}

// One browser window attaching to one terminal. `from` is the last sequence number it
// already has; absent means it wants a fresh screen.
function attachTerm(t, ws, from) {
  const sendJ = o => { try { if (ws.readyState === 1) ws.send(JSON.stringify(o)); } catch {} };
  const oldest = t.buf.length ? t.buf[0].seq : t.seq + 1;
  // No cursor at all must stay distinguishable from a cursor of 0 — Number(null) is 0,
  // not NaN, so this cannot be left to Number() alone.
  let start = (from === undefined || from === null || from === '') ? null : Number(from);
  if (start !== null && (!Number.isFinite(start) || start < 0)) start = null;
  // A cursor ahead of anything we ever sent belongs to a previous life of this id.
  if (start !== null && start > t.seq) start = null;
  // Either a fresh window, or a resume from further back than the backlog reaches.
  // Appending could not make the screen correct, so say so and replay what we do hold.
  if (start === null || start + 1 < oldest) { sendJ({ type: 'reset' }); start = oldest - 1; }
  for (const rec of t.buf) if (rec.seq > start) sendJ({ type: 'o', seq: rec.seq, b: rec.b });
  if (!t.alive) { sendJ({ type: 'exit', code: t.exitCode }); try { ws.close(); } catch {} return; }

  t.subs.add(ws);
  if (t.graceTimer) { clearTimeout(t.graceTimer); t.graceTimer = null; }
  ws.on('message', raw => {
    let f; try { f = JSON.parse(raw); } catch { return; }
    if (f.type === 'in' && typeof f.b === 'string') {
      try { t.child.stdin.write(Buffer.from(f.b, 'base64')); } catch {}
    } else if (f.type === 'size') {
      termResize(t, f.cols, f.rows);
    } else if (f.type === 'close') {
      closeTerm(t);
    }
  });
  const bye = () => {
    t.subs.delete(ws);
    t.idleSince = Date.now();
    if (t.subs.size || !t.alive || t.graceTimer) return;
    // The window owns the shell. The grace period covers a reconnect — a reload, a
    // blipped tunnel — and, the case that sets its length, a phone whose browser was
    // backgrounded: iOS closes the socket on the way out, so answering a message used
    // to cost you the shell. Not wide enough for walking away and coming back.
    t.graceTimer = setTimeout(() => { t.graceTimer = null; if (!t.subs.size) closeTerm(t); }, TERM_GRACE_MS);
    if (t.graceTimer.unref) t.graceTimer.unref();
  };
  ws.on('close', bye);
  ws.on('error', bye);
}

// script(1) holds the pty master; the shell it forked holds the slave as its controlling
// terminal. Setting the size on the slave is what raises SIGWINCH on the foreground
// group — the only way to resize this pty without a native module.
//
// Normally the slave names itself: `tty` runs inside the pty before the shell starts and
// writes the device path where openTerm() can read it. The ps walk below is only for the
// case where that file never appeared. There the name ps reports is not spelled the same
// everywhere ("pts/3", "ttys003", or bare "s003"), so candidates are tried against the
// filesystem instead of assumed.
function ttyDevice(name) {
  const cands = [];
  if (name.startsWith('/')) cands.push(name);
  else {
    cands.push('/dev/' + name);
    if (!/^tty/.test(name)) cands.push('/dev/tty' + name);
  }
  for (const c of cands) {
    try { if (fs.statSync(c).isCharacterDevice()) return c; } catch {}
  }
  return null;
}
function pgrepChildren(pid) {
  try {
    const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8', timeout: 3000 });
    return String(r.stdout || '').trim().split(/\s+/).filter(Boolean);
  } catch { return []; }
}
function processTty(pid) {
  try {
    const r = spawnSync('ps', ['-o', 'tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
    const name = String(r.stdout || '').trim();
    if (!name || name === '?' || name === '??' || name === '-') return null;
    return ttyDevice(name);
  } catch { return null; }
}
// The pty side is always a grandchild: our sh forks script, and script forks the shell
// (or the tmux client). Never "the first process with a tty" — when ccbb itself was
// started from a terminal, everything in between inherits ITS tty, and resizing that
// would resize the window ccbb is running in.
let ownTty;
function ptsFromProcessTree(t) {
  if (ownTty === undefined) ownTty = processTty(process.pid);
  for (const kid of pgrepChildren(t.child.pid)) {
    for (const g of pgrepChildren(kid)) {
      const dev = processTty(g);
      if (dev && dev !== ownTty) return dev;
    }
  }
  return null;
}
function termPts(t) {
  if (t.pts) return t.pts;
  // Nothing partial gets cached: an empty or half-written file just means the pty is
  // younger than this resize, and the next one should look again.
  let named = null;
  try { named = fs.readFileSync(t.ptsFile, 'utf8').trim(); } catch {}
  if (named && named.startsWith('/')) {
    try { if (fs.statSync(named).isCharacterDevice()) return (t.pts = named); } catch {}
  }
  return (t.pts = ptsFromProcessTree(t)) || null;
}
// GNU stty selects the device with -F, BSD stty with -f. Same trick as script(1): try,
// then remember which one this machine answers to.
let sttyFileFlag = null;
function sttySize(dev, rows, cols) {
  for (const flag of (sttyFileFlag ? [sttyFileFlag] : ['-F', '-f'])) {
    const r = spawnSync('stty', [flag, dev, 'rows', String(rows), 'columns', String(cols)],
      { timeout: 3000, stdio: 'ignore' });
    if (!r.error && r.status === 0) { sttyFileFlag = flag; return true; }
  }
  return false;
}
// t.cols/t.rows are what the window WANTS; t.ptsCols/t.ptsRows are what the pty actually
// got. Keeping them apart is what makes a resize retryable: the pty does not name itself
// until script(1) has started the shell inside it, so a size that arrives in the first
// moments after open — which is exactly when a browser sends its real geometry — finds no
// device to set. Recording it as done there left the shell at 80x24 forever, with the
// browser drawing a grid the program on the other end had never heard of.
function termResize(t, cols, rows, tries) {
  // A tmux terminal's size is tmux's. Honouring a resize here would reach straight
  // through the attach and reflow the window in the user's own terminal — so a stray
  // size frame from an older front-end is dropped rather than obeyed.
  if (t.pinned) return { ok: true, resized: false, cols: t.cols, rows: t.rows };
  const c = clampInt(cols, 20, 500, t.cols), r = clampInt(rows, 5, 200, t.rows);
  t.cols = c; t.rows = r;
  if (t.ptsCols === c && t.ptsRows === r) return { ok: true, resized: false, cols: c, rows: r };
  const pts = termPts(t);
  if (!pts) {
    if (t.alive && (tries || 0) < 12) {
      const h = setTimeout(() => termResize(t, t.cols, t.rows, (tries || 0) + 1), 200);
      if (h.unref) h.unref();
    }
    return { ok: true, resized: false, cols: c, rows: r };
  }
  const done = sttySize(pts, r, c);
  if (done) { t.ptsCols = c; t.ptsRows = r; }
  return { ok: true, resized: done, cols: c, rows: r };
}

// SIGKILL, and not as a last resort: script(1) absorbs both SIGHUP and SIGTERM without
// dying and without passing them on, so anything gentler leaves the pty — and the shell
// or tmux client behind it — running forever. Killing it is not abrupt for the shell:
// closing the master hangs up the pty, which delivers SIGHUP to the foreground process
// group, exactly as closing a terminal window does. The grandchild goes with it.
//
// The signal goes to the whole group because our child is a shell running a pipeline:
// killing it alone would strand cat and script. spawn(detached) made it the group leader,
// so the negative pid reaches every part at once.
// Only while the child is still running: once it has exited and been reaped, that pid
// belongs to whoever the OS hands it to next, and a bare kill(2) on a negative pid has
// none of the protection child.kill() gets from holding the process handle. Nothing is
// lost by skipping it — the sh only exits once script has, and the group empties with it.
function killTermChild(t) {
  if (t.child.exitCode === null && t.child.signalCode === null) {
    try { process.kill(-t.child.pid, 'SIGKILL'); }
    catch { try { t.child.kill('SIGKILL'); } catch {} }
  }
  try { fs.unlinkSync(t.ptsFile); } catch {}
}
function closeTerm(t) {
  // Before the pty dies, not after: killing it removes the last client, and
  // destroy-unattached fires on that instant. If this grouped session is all that holds
  // its windows, the reaping we asked tmux for would take a running Claude with it.
  if (t.tmuxGroup && defuseIfSoleHolder(t.tmuxGroup))
    console.log(`ccbb: keeping tmux session ${t.tmuxGroup} — it is the last holder of its windows`);
  terms.delete(t.id);
  if (t.graceTimer) { clearTimeout(t.graceTimer); t.graceTimer = null; }
  t.alive = false;
  termBroadcast(t, { type: 'exit', code: t.exitCode });
  for (const ws of t.subs) { try { ws.close(); } catch {} }
  t.subs.clear();
  killTermChild(t);
}
// ── orphans from a kill -9 ────────────────────────────────────────────────────
// SIGKILL cannot be caught, so closeAllTerms never runs: the ptys are reparented to init
// and keep running. A pty running `tmux attach` is a tmux CLIENT, and it holds its session
// ATTACHED — which means destroy-unattached will not fire for it either. Nothing tmux or
// the OS does clears it. The only moment left to clean up is the next start.
//
// Two handles survive, and both have to agree before anything is ended:
//   • the pts file. Every terminal writes its pty device to $TMPDIR/ccbb-pts-<pid>-<id>
//     and unlinks it only on a CLEAN close, so the files whose <pid> is dead name exactly
//     the ttys that were left behind.
//   • the client list. A pts number is RECYCLED, so a stale file can name a tty that now
//     belongs to a real terminal of yours — detaching that would be worse than the leak.
//     So a tty is only ended if it is also, right now, a client of one of our own ccbb-*
//     sessions.
// Detaching the client ends its `tmux attach`, which ends the script(1) holding the pty,
// which is the whole process tree. Then any ccbb-* session left unattached had its last
// client taken away and is ours to remove.
function sweepOrphanTerms() {
  // The pts files first, and unconditionally. tmux may not be running at all here, and a
  // sweep that gave up before this loop left these accumulating forever on such a host.
  const stale = [];
  let files = [];
  try { files = fs.readdirSync(os.tmpdir()); } catch {}
  for (const f of files) {
    const m = /^ccbb-pts-(\d+)-(\d+)$/.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    // A live pid is a live ccbb — or an unrelated process that inherited the number.
    // Either way those terminals are not ours to end, and skipping leaves a leak rather
    // than taking a risk.
    if (pid === process.pid || pidAlive(pid)) continue;
    const file = path.join(os.tmpdir(), f);
    let dev = '';
    try { dev = fs.readFileSync(file, 'utf8').trim(); } catch {}
    if (dev) stale.push(dev);
    try { fs.unlinkSync(file); } catch {}
  }

  const clientSession = new Map();
  try {
    for (const l of tmux(['list-clients', '-F', '#{client_name}\t#{client_session}']).split('\n')) {
      const [name, sess] = l.split('\t');
      if (name) clientSession.set(name, sess || '');
    }
  } catch { return; }                      // no tmux server: the files above were the job

  // Defuse before detaching, in that order. A ccbb-* session that is the sole holder of
  // its windows still carries destroy-unattached from the run that was killed, so pulling
  // its stranded client would destroy it — and the windows, and whatever runs in them.
  // The guard further down would never get to speak: there would be nothing left to list.
  const kept = [];
  let lines = '';
  try { lines = tmux(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_group_size}']); }
  catch {}
  for (const l of lines.split('\n')) {
    const [name, , size] = l.split('\t');
    if (!name || !isOurGroupName(name) || Number(size) > 1) continue;
    try { tmux(['set-option', '-t', name, 'destroy-unattached', 'off']); } catch {}
    kept.push(name);
  }

  let detached = 0;
  for (const dev of stale) {
    // A pts number is RECYCLED, so a stale file can name a tty that now belongs to a real
    // terminal of yours — detaching that would be worse than the leak. So a tty is only
    // ended if it is also, right now, a client of one of our own ccbb-* sessions.
    if (!isOurGroupName(clientSession.get(dev) || '')) continue;
    try { tmux(['detach-client', '-t', dev]); detached++; } catch {}
  }

  // Now what is left unattached is ours and has no client to serve. The defused ones are
  // skipped by the same rule that defused them.
  let killed = 0;
  try { lines = tmux(['list-sessions', '-F', '#{session_name}\t#{session_attached}\t#{session_group_size}']); }
  catch { lines = ''; }
  for (const l of lines.split('\n')) {
    const [name, attached, size] = l.split('\t');
    if (!name || !isOurGroupName(name) || attached !== '0') continue;
    if (Number(size) <= 1) continue;       // defused above; leaving it is the point
    try { tmux(['kill-session', '-t', exact(name)]); killed++; } catch {}
  }
  for (const name of kept)
    console.log(`ccbb: keeping tmux session ${name} — it is the last holder of its windows`);
  if (detached || killed)
    console.log(`ccbb: swept ${detached} orphaned terminal client(s) and ${killed} tmux session(s) from a previous run`);
}

// A pty is a child process, not a resource the OS reclaims with us: nothing kills these
// shells when ccbb goes away, so every restart would otherwise strand one per terminal
// that was open. SIGKILL cannot be caught, so `kill -9` on the server still leaks — a
// plain stop or Ctrl-C, which is how it is actually restarted, does not.
function closeAllTerms() {
  // Same reason closeTerm defuses, and this is the path a restart actually takes: killing
  // the pty removes the last client of the grouped session, and destroy-unattached fires
  // on that instant. If the base session died while the terminal was open, that reaping
  // takes the windows — and a running Claude Code — with it. Ctrl-C must not do that.
  for (const t of terms.values()) if (t.tmuxGroup) defuseIfSoleHolder(t.tmuxGroup);
  for (const t of Array.from(terms.values())) killTermChild(t);
  terms.clear();
}
process.on('exit', closeAllTerms);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { closeAllTerms(); process.exit(0); });
}

// Backstop. The grace timer normally does this, but a terminal that never had a socket
// at all (opened, then the browser died before connecting) has no timer to fire.
function termReap() {
  const now = Date.now();
  // Defusing at close time cannot help when the client dies without ccbb deciding it —
  // the user detaches from inside the browser terminal, or the tunnel drops. The moment
  // that matters is when the grouped session BECOMES the last holder of its windows,
  // which is when the base session went away, so notice that on a timer instead of only
  // on the way out. A minute of exposure beats the alternative of not noticing at all.
  for (const t of terms.values()) if (t.alive && t.tmuxGroup) defuseIfSoleHolder(t.tmuxGroup);
  for (const [id, t] of terms) {
    if (t.subs.size) { t.idleSince = now; continue; }
    // Dead already, so there is nothing to kill — but killTermChild is also what takes
    // the pts file away, and a shell that exited on its own never went through closeTerm.
    if (!t.alive) { if (now - t.idleSince > 60000) { killTermChild(t); terms.delete(id); } continue; }
    if (!t.graceTimer && now - t.idleSince > 5 * 60 * 1000) closeTerm(t);
  }
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
// Which UI this browser asked for, if it has said. Set by ?ui=mobile / ?ui=desktop; with
// no cookie the user agent decides. A cookie, not localStorage: the choice has to be
// known on the server, before a byte of the page is written.
const UI_COOKIE = 'ccbb_ui';
function uiPref(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)ccbb_ui=(mobile|desktop)/);
  return m ? m[1] : '';
}
function cookieToken(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + tokenCookieName(req) + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}
// Auth, when config sets peerToken. The token can arrive as a header (peer proxies and
// the hook curl), a cookie (the browser, after one ?token=… visit), or a query param.
// Unset peerToken = no auth at all, which is the pre-existing single-host behavior.
//
// Two tokens, two answers: 'full' drives, 'read' only looks. Null is no answer at all.
// The level is decided once, at the top of the request, and carried on the request object
// — so a route that forgets to consult it fails closed only if we make it, which is why
// every mutating route below asks `ro` explicitly rather than trusting a shared middleware
// that a new route could be written without.
let warnedBrokenConfig = false;
function authLevel(req, query) {
  // A config file that exists but does not parse tells us nothing about what this server
  // requires — and "nothing" must not be read as "requires nothing". peerToken() would
  // come back '' from the same broken read and wave everyone through, silently, for as
  // long as the typo lived. Refuse instead, and say why once.
  if (configUnreadable()) {
    if (!warnedBrokenConfig) {
      warnedBrokenConfig = true;
      console.error('ccbb: ccbb-config.json exists but does not parse - refusing every request until it does');
    }
    return null;
  }
  warnedBrokenConfig = false;
  const want = peerToken(), ro = readToken();
  if (!want) return 'full';
  const got = req.headers[TOKEN_HEADER] || (query && query.get('token')) || cookieToken(req);
  if (!got) return null;
  if (safeEq(got, want)) return 'full';
  // Checked second and only if it is set, so a server without readToken behaves exactly
  // as before — same comparisons, same failures.
  if (ro && safeEq(got, ro)) return 'read';
  return null;
}
function sendForbidden(res, what) {
  send(res, 403, { error: `read-only token cannot ${what}` });
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
// A peer reached over an ssh tunnel loses established connections in bursts: the link
// goes through a short episode where sockets already open are torn down while brand new
// ones connect fine. Measured on the `thelab` hop — two failures 16s apart, each on a
// REUSED socket, each while a fresh socket answered 200 in the same instant. Node reports
// it as ECONNRESET or "socket hang up".
//
// The peer never saw the request when this happens, so replaying it is safe rather than
// merely convenient, and the replay lands on a fresh socket — the case that was observed
// working. Both the health probe and the proxy retry once on this.
const PEER_RETRY_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT',
                                  'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN']);
function peerErrorIsTransient(e) {
  return PEER_RETRY_CODES.has(e.code) || e.message === 'socket hang up';
}
function probePeer(peer) {
  const started = Date.now();
  let done = false, tries = 0;
  const finish = rec => { if (done) return; done = true; peerHealth.set(peer.name, rec); };
  const attempt = () => {
    tries++;
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
    let timedOut = false;
    req.on('timeout', () => { timedOut = true; req.destroy(new Error('timed out')); });
    // A pooled socket killed mid-episode is not a peer that went away. Without the retry
    // the server list flashes a healthy peer as down every time the link hiccups — and at
    // a 15s poll that wrong answer is what the UI shows until the next round.
    req.on('error', e => {
      if (tries === 1 && !timedOut && peerErrorIsTransient(e)) return attempt();
      finish({ status: 'down', error: e.message + (tries > 1 ? ' (retried once)' : ''),
               rttMs: Date.now() - started });
    });
    req.end();
  };
  attempt();
}
function pollPeers() { for (const p of peerList()) probePeer(p); }
// Merged view of the mesh: this server first, then every configured peer with its last
// known health. `hostname` is what the PEER reported about itself, not what we guessed.
// `ro` — a read-only caller is told about this machine and no other. Not a filter the
// UI applies for cosmetics: the list is also what the front-end opens sockets against,
// so leaving peers in it and hiding the chips would have the page reaching for hops the
// server is about to refuse.
function serversPayload(ro) {
  const self = serverIdentity();
  const list = [{ name: self.name, hostname: self.hostname, self: true, status: 'up' }];
  if (ro) return { self, servers: list };
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
  // Only a bodyless request can be replayed: by the time the error arrives the client's
  // stream has been consumed and cannot be rewound. GET and HEAD are all the UI sends
  // over a peer hop anyway, so nothing real loses the retry.
  const replayable = req.method === 'GET' || req.method === 'HEAD';
  let tries = 0;
  const attempt = () => {
    tries++;
    const preq = peerRequest(peer, subPath, { method: req.method, headers, timeout: 30000 }, pres => {
      const out = {};
      for (const k of ['content-type', 'content-length', 'cache-control']) if (pres.headers[k]) out[k] = pres.headers[k];
      res.writeHead(pres.statusCode || 502, out);
      pres.pipe(res);
    });
    let timedOut = false;
    preq.on('timeout', () => { timedOut = true; preq.destroy(new Error('timed out')); });
    preq.on('error', e => {
      if (res.headersSent) return res.destroy();   // too late — the client already has bytes
      // Once only, and never after a timeout: a peer that is merely slow is still working
      // on the first copy, and a second would add load to something already struggling.
      if (replayable && tries === 1 && !timedOut && peerErrorIsTransient(e)) return attempt();
      send(res, 502, { error: `peer "${peer.name}" unreachable: ${e.message}`
        + (tries > 1 ? ' (retried once)' : '') });
    });
    if (replayable) preq.end(); else req.pipe(preq);
  };
  attempt();
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
  // The same one-hop rule serveLinkRequest enforces, and for the same reason - this one
  // was missing it. A link replays against our own port with loopbackHeaders(), which
  // carry OUR token and no X-Ccbb-Via, so the upgrade handler's loop guard never fires:
  // a peer that merely dialled in could ask for /peer/<someone-else>/ws/... and reach a
  // server it has no relationship with, on our credentials. Refuse before dialling.
  if (/^\/peer\//.test(String(f.path || ''))) return linkSend(link, { t: 'wsclose', id: f.id });
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

// ── link liveness ──
// A link that is merely open is not a link that works, and BOTH ways one dies leave the
// socket looking perfectly healthy to Node:
//
//   • the handshake never finishes. An ssh forward whose far end is gone still ACCEPTS,
//     so TCP connects and the upgrade response simply never arrives. ws emits no error and
//     no close; readyState sits at CONNECTING forever. connectLink's "already connecting or
//     open" check then skipped the redial on every single poll — which is why a link that
//     failed this way was dialled once at startup and never again.
//   • the socket is half-open. The tunnel died without a FIN, which is the ordinary way a
//     tunnel dies. readyState stays OPEN and nothing ever errors. Pinging without checking
//     that a pong came back — which is what this used to do — detects none of it.
//
// So a deadline for the first and an answered ping for the second, and both end by
// destroying the socket. That matters more than the detection: the 15s poll is already
// there and already correct, it was only ever being told the link was fine.
const LINK_HANDSHAKE_MS = 10000;
const LINK_PING_MS = 30000;
// terminate(), not close(): close() waits for a reply from an end that has stopped
// replying, which is precisely the state being diagnosed. One missed pong is enough —
// the far end answers automatically and has a whole interval to do it in.
function linkHeartbeat(ws) {
  let alive = true;
  ws.on('pong', () => { alive = true; });
  // Any frame counts, not just a pong. This one socket also carries every proxied HTTP
  // response and every proxied terminal and tail frame, so a peer streaming a large file
  // down a narrow tunnel can leave its pong queued behind that backlog - and terminating
  // then would kill the very transfer that caused the delay. Traffic IS liveness.
  ws.on('message', () => { alive = true; });
  const timer = setInterval(() => {
    if (!alive) { try { ws.terminate(); } catch {} return; }   // 'close' fires; the poll redials
    alive = false;
    try { ws.ping(); } catch { try { ws.terminate(); } catch {} }
  }, LINK_PING_MS);
  if (timer.unref) timer.unref();
  const stop = () => clearInterval(timer);
  ws.on('close', stop);
  ws.on('error', stop);
  return stop;
}

// ── caller side: keep a link open to every configured peer ──
function connectLink(peer) {
  if (!WS) return;
  const existing = outboundLinks.get(peer.name);
  if (existing && existing.ws) {
    const st = existing.ws.readyState;
    // Retargeting a tunnel to a new port, or rotating a peer's token, has to reach an
    // already-open link: config is re-read every poll, but a healthy socket was dialled
    // against the OLD values and would go on serving them indefinitely.
    if (existing.url !== peer.url || existing.token !== (peer.token || '')) {
      try { existing.ws.terminate(); } catch {}
    }
    else if (st === 1) return;                             // open, and answering pings
    // Mid-handshake is fine, briefly. Bounding it here as well as with handshakeTimeout is
    // deliberate: this is the check that used to make the failure permanent, so it is the
    // one that must not be able to wait forever again.
    if (st === 0 && Date.now() - existing.startedAt < LINK_HANDSHAKE_MS * 2) return;
    try { existing.ws.terminate(); } catch {}
  }
  const url = peer.url.replace(/^http/, 'ws') + '/peer-link?name=' + encodeURIComponent(serverIdentity().name);
  const headers = {};
  if (peer.token) headers[TOKEN_HEADER] = peer.token;
  let ws;
  try { ws = new WS(url, { headers, handshakeTimeout: LINK_HANDSHAKE_MS }); } catch { return; }
  const rec = { ws, startedAt: Date.now(), stopBeat: null, url: peer.url, token: peer.token || '' };
  outboundLinks.set(peer.name, rec);
  ws.on('open', () => {
    makeLink(ws, peer.name);
    // A link can sit idle for hours; the heartbeat keeps it warm AND proves it is there.
    rec.stopBeat = linkHeartbeat(ws);
  });
  // Forget this attempt ONLY if the map still holds it. A later attempt may already have
  // replaced it, and deleting that one would strand a healthy link and set off a redial
  // loop: poll dials again, the peer drops the socket it had as superseded, repeat.
  // pollLinks provides the retry cadence, so there is no reconnect timer here to go stale.
  const gone = () => {
    if (rec.stopBeat) { rec.stopBeat(); rec.stopBeat = null; }
    if (outboundLinks.get(peer.name) === rec) outboundLinks.delete(peer.name);
  };
  ws.on('close', gone);
  ws.on('error', gone);
}
function pollLinks() {
  const configured = new Set();
  for (const p of peerList()) { configured.add(p.name); connectLink(p); }
  // A peer removed from the config keeps no link open. The config is re-read per poll, so
  // this is how "delete the peer and it goes away" stays true without a restart.
  for (const [name, rec] of outboundLinks) {
    if (configured.has(name)) continue;
    try { rec.ws.terminate(); } catch {}
    outboundLinks.delete(name);
  }
}

// Interface addresses worth printing: the ones a phone on the same network can dial.
function lanAddrs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if (/^(lo|utun|awdl|llw|bridge)/.test(name)) continue;
    for (const a of ifs[name] || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function runWeb(args) {
  let port = DEFAULT_PORT;
  let host = '127.0.0.1';
  let withWebex = false, withConfluence = false;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) port = parseInt(args[++i], 10);
    else if (args[i] === '--host' && args[i + 1]) host = args[++i];
    else if (args[i] === '--webex') withWebex = true;
    else if (args[i] === '--confluence') withConfluence = true;
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`ccbb web — web UI\n\nUsage: ccbb web [-p port] [--host addr] [--webex] [--confluence]\n\n` +
        `  --host         address to bind (default 127.0.0.1; use 0.0.0.0 to reach it from the LAN)\n` +
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

    const isDesktopPage = method === 'GET' && (pathname === '/' || pathname === '/index.html' ||
      /^\/session\/[^/]+$/.test(pathname) || /^\/peer\/[^/]+\/session\/[^/]+$/.test(pathname));
    const isMobilePage = method === 'GET' && (pathname === '/m' || pathname === '/m/' ||
      pathname === '/m/index.html' || /^\/m\/session\/[^/]+$/.test(pathname) ||
      /^\/m\/peer\/[^/]+\/session\/[^/]+$/.test(pathname));
    // Both UIs' pages: what the ?token=… hand-off and the HTML 401 apply to. A /m page
    // left out here would take the JSON-401 branch and could never bank the token.
    const isPage = isDesktopPage || isMobilePage;

    // The app icons, ahead of the token check on purpose. They are seven rectangles and
    // two circles — they say nothing about this machine or the sessions on it — and the
    // fetch that matters most is the one we cannot put a cookie on: Chrome's icon
    // downloader, running for an install, outside the page that holds the token.
    if (method === 'GET' && (m = /^\/icon-(\d+)(-maskable)?\.png$/.exec(pathname))) {
      const size = Number(m[1]);
      if (!ICON_SIZES.includes(size)) return send(res, 404, { error: 'no such icon size' });
      const png = iconPngFor(size, !!m[2]);
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length,
                           'Cache-Control': 'public, max-age=604800' });
      return res.end(png);
    }

    const level = authLevel(req, query);
    if (!level) return sendUnauthorized(res, isPage, tokenCookieName(req));
    // Whoever came in with the read token. Every route that changes something — a session's
    // input, a terminal, a peer hop — consults this; everything that only reads ignores it.
    const ro = level === 'read';
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

    // ── which UI ──
    // Strictly after the token hand-off above: redirecting first would drop the ?token=
    // and leave a phone's first visit in a 401 loop.
    if (isPage && (query.get('ui') === 'mobile' || query.get('ui') === 'desktop')) {
      const rest = new URLSearchParams(qs); rest.delete('ui');
      res.writeHead(302, {
        'Set-Cookie': `${UI_COOKIE}=${query.get('ui')}; Path=/; SameSite=Strict; Max-Age=31536000`,
        Location: pathname + (rest.toString() ? '?' + rest.toString() : ''),
      });
      return res.end();
    }
    // A phone gets the phone UI — including on a deep link, which is how a session URL
    // copied off a desktop is usually opened. `?ui=desktop` once, and it stops.
    if (isDesktopPage) {
      const pref = uiPref(req);
      if (pref === 'mobile' || (!pref && isMobileUA(req.headers['user-agent']))) {
        const loc = '/m' + (pathname === '/' || pathname === '/index.html' ? '' : pathname);
        res.writeHead(302, { Location: loc + (qs ? '?' + qs : '') });
        return res.end();
      }
    }
    // marked/xterm, fetched by us and cached — see ccbb-mobile.js.
    if (method === 'GET' && serveVendor(pathname, res)) return;
    if (isMobilePage) {
      const self = serverIdentity();
      if (pathname === '/m' || pathname === '/m/' || pathname === '/m/index.html')
        return sendHtml(res, mobilePageHtml(null, null, self, priceTable, ro));
      if ((m = pathname.match(/^\/m\/session\/([^/]+)$/)))
        return sendHtml(res, mobilePageHtml(m[1], null, self, priceTable, ro));
      // A read-only browser has no peers to deep-link into, and the page it would get
      // could only sit there failing to load. Send it to its own list instead.
      if ((m = pathname.match(/^\/m\/peer\/([^/]+)\/session\/([^/]+)$/))) {
        if (ro) { res.writeHead(302, { Location: '/m' }); return res.end(); }
        return sendHtml(res, mobilePageHtml(m[2], decodeURIComponent(m[1]), self, priceTable, ro));
      }
    }

    // ── peer mesh ──
    if (method === 'GET' && pathname === '/api/identity') {
      const self = serverIdentity();
      return send(res, 200, { name: self.name, hostname: self.hostname, port, version: VERSION });
    }
    if (method === 'GET' && pathname === '/api/servers') return send(res, 200, serversPayload(ro));
    if ((m = pathname.match(/^\/peer\/([^/]+)(\/.*)$/))) {
      // A page navigation gets a redirect rather than a JSON 403 — a read-only browser
      // following a deep link copied off a full-access one should land on its own list,
      // not on a wall of error text. Everything else (the API, the sockets) is refused.
      if (ro) {
        if (isDesktopPage) { res.writeHead(302, { Location: '/' }); return res.end(); }
        return sendForbidden(res, 'reach peers');
      }
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

    // Behind the token, unlike the icons: it carries this server's name, which is the
    // whole point of it — several ccbb apps end up on one taskbar and they have to be
    // told apart. The link element asks for it with credentials, so the cookie is sent.
    if (method === 'GET' && pathname === '/manifest.webmanifest') {
      const body = Buffer.from(JSON.stringify(webManifest(serverIdentity())));
      res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8',
                           'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      return res.end(body);
    }
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) return sendHtml(res, appPageHtml(null, null, ro));
    if (method === 'GET' && pathname === '/api/sessions') {
      const mk = query.get('month');
      const filter = mk && /^\d{4}-\d{2}$/.test(mk) ? { period: 'month', key: mk } : null;
      return send(res, 200, getSessions(filter));
    }
    if (method === 'GET' && pathname === '/api/cost-summary') return send(res, 200, getCostSummary());
    // This server's Claude.ai plan windows. `{}` — not a 404 — when it isn't on a
    // subscription, so a Bedrock peer in a fan-out contributes nothing rather than an error.
    // Windows only, no spend: this is polled every minute and both front-ends already have
    // the dollars — the desktop from its cost summaries, the phone from the list totals.
    if (method === 'GET' && pathname === '/api/subscription') {
      const sub = getSubscription() || {};
      // The quota windows are what the UI draws, and a read-only viewer is allowed those
      // - but this payload also carries the account's uuid, display name, EMAIL, org and
      // plan tier, none of which appears anywhere on the page. Hiding the subscriptions
      // table in the front-end left all of that one curl away from anyone holding a link.
      // `account` stays an object because the front-ends use its presence to mean "this
      // machine is on a plan"; it simply stops saying who.
      if (ro) return send(res, 200, { account: { readOnly: true }, plan: '',
        windows: sub.windows || null, fetchedAt: sub.fetchedAt || 0, source: sub.source || '' });
      return send(res, 200, sub);
    }
    // Just the month keys, for a scope selector that has no use for the summary's numbers —
    // the phone would otherwise pull a full cost breakdown to fill one dropdown.
    if (method === 'GET' && pathname === '/api/months')
      return send(res, 200, { months: Object.keys(getCostSummary().months).sort().reverse() });
    if (method === 'GET' && (m = pathname.match(/^\/session\/([^/]+)$/)))
      return sendHtml(res, appPageHtml(m[1], null, ro));   // deep link: app with this session opened
    // ── host terminals ──
    if (method === 'POST' && pathname === '/api/term/open') {
      if (ro) return sendForbidden(res, 'open a terminal');
      readBody(req, body => {
        let b; try { b = JSON.parse(body || '{}'); } catch { b = {}; }
        // The id becomes a tmux session NAME, and tmux target strings prefix-match — so a
        // short id would name, and could kill, another session's. Anything that is not a
        // plausible session id is treated as no id at all: a plain login shell.
        const sid = /^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/.test(String(b.sessionId || '')) ? b.sessionId : null;
        // Absent means pinned, which is what the phone and every older front-end mean.
        const r = openTerm(b.cols, b.rows, sid, b.pin !== false);
        send(res, r.error ? 500 : 200, r);
      });
      return;
    }
    // Everything else about a terminal rides its WebSocket. This one route stays HTTP so
    // a closing tab can end the shell with sendBeacon, which cannot open a socket.
    if (method === 'POST' && (m = pathname.match(/^\/api\/term\/([^/]+)\/close$/))) {
      if (ro) return sendForbidden(res, 'close a terminal');
      const t = terms.get(m[1]);
      if (!t) return send(res, 404, { error: 'no such terminal' });
      closeTerm(t);
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/session-info\/([^/]+)$/)))
      return send(res, 200, getSessionInfo(m[1]));
    // History, whole or windowed. `head`/`tail` open a session without shipping its middle;
    // `from`/`to` fill the gap in, or fetch only what was appended since `total`. Plain
    // /history (no params) still returns everything, which is what the bots want.
    if (method === 'GET' && (m = pathname.match(/^\/api\/session\/([^/]+)\/history$/))) {
      const num = k => (query.get(k) == null ? null : Math.max(0, parseInt(query.get(k), 10) || 0));
      const head = num('head'), tail = num('tail'), from = num('from'), to = num('to');
      if (head == null && tail == null && from == null && to == null)
        return send(res, 200, { history: getSessionHistory(m[1]) });
      return send(res, 200, getSessionHistoryWindow(m[1], { head, tail, from, to }));
    }
    if (method === 'GET' && (m = pathname.match(/^\/api\/session\/([^/]+)\/subagent\/([^/]+)$/)))
      return send(res, 200, { history: getSubagentHistory(m[1], m[2]) });
    // Claude Code prompt-capture hooks POST here (permission dialogs, AskUserQuestion).
    if (method === 'POST' && pathname === '/api/hook') {
      // The hooks run on this machine and carry the full token; a viewer forging one
      // could open a permission card that was never asked for.
      if (ro) return sendForbidden(res, 'post hook events');
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
      if (ro) return sendForbidden(res, 'message a session');
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
      if (ro) return sendForbidden(res, 'answer a question');
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
      if (ro) return sendForbidden(res, 'answer a permission prompt');
      readBody(req, body => {
        let choice;
        try { choice = Number(JSON.parse(body || '{}').choice); } catch { choice = NaN; }
        if (!Number.isFinite(choice)) return send(res, 400, { error: 'choice required' });
        const r = answerPrompt(m[1], choice);
        send(res, r.ok ? 200 : 409, r);
      });
      return;
    }
    // //commands run a shell command on this host — the least read-only thing here.
    if (method === 'POST' && (m = pathname.match(/^\/api\/session\/([^/]+)\/command$/))) {
      if (ro) return sendForbidden(res, 'run commands');
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
      if (ro) return sendForbidden(res, 'rename a session');
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

  server.listen(port, host, () => {
    const self = serverIdentity();
    console.log(`ccbb http://127.0.0.1:${port}  (server "${self.name}" on ${self.hostname})`);
    if (host !== '127.0.0.1') for (const a of lanAddrs()) console.log(`ccbb http://${a}:${port}`);
    const peers = peerList();
    if (peers.length) console.log(`ccbb peers: ${peers.map(p => p.name + ' → ' + p.url).join(', ')}`);
    if (peerToken()) console.log('ccbb: peerToken set — open the UI once as ?token=<token>');
    if (readToken()) console.log('ccbb: readToken set — ' +
      (!peerToken() ? 'IGNORED as a restriction: peerToken is unset, so everyone already has full access'
       : readToken() === peerToken() ? 'IGNORED: it is the same string as peerToken, which wins'
       : 'that token gives a view-only UI (no peers, no terminal, no input)'));
  });
  // Before anything can open a terminal: whatever a kill -9 on the last run left attached
  // to tmux is still attached, and this is the only moment it can be recognised as ours.
  sweepOrphanTerms();
  // Peer health runs on a timer so /api/servers never blocks on a dead tunnel.
  pollPeers();
  pollLinks();
  setInterval(() => { pollPeers(); pollLinks(); }, 15000).unref();
  setInterval(termReap, 60000).unref();

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
    const sendTo = (sessionId, obj) => {
      const set = clients.get(sessionId);
      if (!set) return;
      const json = JSON.stringify(obj);
      for (const c of set) if (c.readyState === 1) c.send(json);
    };
    wsSend = sendTo;
    server.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      const level = authLevel(req, new URLSearchParams(url.split('?')[1] || ''));
      if (!level) return socket.destroy();
      // A socket has no status code to refuse with that a browser would show, so a
      // read-only caller reaching for a peer, a peer link or a shell just gets nothing.
      const ro = level === 'read';
      // A peer opening its reverse channel to us. It authenticated above like any other
      // request; from here on we can call back into it whenever the UI asks.
      if (/^\/peer-link(\?|$)/.test(url)) {
        if (ro) return socket.destroy();   // a link is a peer dialling in — and outbound reach for us
        const name = new URLSearchParams(url.split('?')[1] || '').get('name');
        if (!name || name === serverIdentity().name) return socket.destroy();
        return wss.handleUpgrade(req, socket, head, ws => {
          const prev = inboundLinks.get(name);
          // terminate(), not close(): a replacement arrives precisely when the caller
          // decided the old socket was half-open, so waiting for a close handshake from
          // that end defers makeLink's drop - and every browser socket riding the old
          // link - by ws's 30s close timeout.
          if (prev && prev.ws !== ws) { try { prev.ws.terminate(); } catch {} }
          const link = makeLink(ws, name);
          inboundLinks.set(name, link);
          console.log(`ccbb: peer "${name}" linked in`);
          // The callee pings too. Only the caller redials, but only the callee can notice
          // that the caller is gone — and an inbound link is listed in /api/servers as an
          // ordinary peer, so a dead one left in the map is a machine reported "up" that
          // nobody can reach.
          linkHeartbeat(ws);
          const bye = () => { if (inboundLinks.get(name) === link) inboundLinks.delete(name); };
          ws.on('close', bye); ws.on('error', bye);
        });
      }
      const pm = url.match(/^\/peer\/([^/]+)(\/.*)$/);
      if (pm) {
        if (ro) return socket.destroy();
        const name = decodeURIComponent(pm[1]);
        if (req.headers[VIA_HEADER]) return socket.destroy();
        const peer = peerByName(name);
        if (peer) return proxyUpgrade(peer, pm[2], req, socket, head);
        const link = inboundLinks.get(name);
        if (!link) return socket.destroy();
        return proxyUpgradeOverLink(link, pm[2], req, socket, head);
      }
      // A host terminal. Reached on a peer as /peer/<name>/ws-term/<id>, which the block
      // above splices — over the peer's URL, or back down the link it opened to us.
      const tm = url.match(/^\/ws-term\/([^/?]+)/);
      if (tm) {
        if (ro) return socket.destroy();
        const t = terms.get(tm[1]);
        if (!t) return socket.destroy();
        const from = new URLSearchParams(url.split('?')[1] || '').get('from');
        return wss.handleUpgrade(req, socket, head, ws => attachTerm(t, ws, from));
      }
      // The session list. One per browser per server (peers arrive as /peer/<name>/ws/list,
      // spliced by the block above), carrying its own scope.
      if (/^\/ws\/list(\?|$)/.test(url)) {
        const q = new URLSearchParams(url.split('?')[1] || '');
        const mk = q.get('month');
        return wss.handleUpgrade(req, socket, head, ws => {
          const c = { ws, month: mk && /^\d{4}-\d{2}$/.test(mk) ? mk : null, rows: new Map(), totals: '' };
          addListClient(c);
          try { sendList(c, listSnapshot(c.month)); } catch (e) { wsJson(ws, { type: 'error', error: e.message }); }
          ws.on('message', raw => {
            let d; try { d = JSON.parse(raw); } catch { return; }
            if (!d) return;
            // Scope changes in place, and the refresh button asks for a new snapshot —
            // both answered on this socket, neither needing a reconnect.
            if (d.type === 'scope' || d.type === 'refresh') {
              if (d.type === 'scope')
                c.month = typeof d.month === 'string' && /^\d{4}-\d{2}$/.test(d.month) ? d.month : null;
              try { sendList(c, listSnapshot(c.month)); } catch {}
            }
          });
          const bye = () => removeListClient(c);
          ws.on('close', bye); ws.on('error', bye);
        });
      }
      const m = url.match(/^\/ws\/([^/?]+)/);
      if (!m) return socket.destroy();
      wss.handleUpgrade(req, socket, head, ws => {
        const sessionId = m[1];
        if (!clients.has(sessionId)) clients.set(sessionId, new Set());
        clients.get(sessionId).add(ws);
        // Liveness rides this socket, pushed by the same watcher the list uses — the view
        // no longer polls /api/session-info to find out the session went idle.
        ensureSessionWatch();
        const l0 = liveMsg(sessionId);
        liveSent.set(sessionId, l0);   // primed, so the next watch tick isn't a repeat
        try { ws.send(l0); } catch {}
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
          releaseSessionWatch();
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
