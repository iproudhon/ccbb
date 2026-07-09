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
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const common = require('./ccbb-common');
const {
  CLAUDE_DIR, getSessions, getCostSummary, getSessionInfo, getSessionHistory, getSessionStats,
  sessionLiveness, renameSession, paneForSession, injectToPane, transcriptEntry,
  getSessionCwd, findSessionJsonl, priceTable,
  loadCommands, expandRun, truncTitle, looksLikeDiff, langForFile,
  awsIdText, awsLoginStream, tmux, capturePane, parsePrompt, promptFingerprint,
  startTail, stopTail,
} = common;

const DEFAULT_PORT = 8590;

// Broadcast hook, wired up by runWeb once the WS server exists. No-op otherwise.
let wsBroadcast = () => {};

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

const LIST_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ccbb</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,'Cascadia Code',Menlo,monospace;font-size:13px;background:#fff;color:#1f2328;min-height:100vh}
header{padding:14px 24px;border-bottom:1px solid #d0d7de;display:flex;align-items:center;gap:12px;background:#f6f8fa}
header h1{font-size:15px;font-weight:600;color:#0969da}
header .sub{color:#57606a;font-size:12px}
header .ro{margin-left:8px;font-size:10px;color:#57606a;border:1px solid #d0d7de;border-radius:10px;padding:1px 8px;text-transform:uppercase;letter-spacing:.04em}
button.refresh{margin-left:auto;background:#fff;border:1px solid #d0d7de;color:#1f2328;padding:4px 12px;border-radius:6px;font-family:inherit;font-size:12px;cursor:pointer}
button.refresh:hover{background:#f6f8fa;border-color:#8c959f}
.wrap{padding:0 24px 24px;overflow-x:auto}
table{width:100%;border-collapse:collapse;margin-top:16px}
th{text-align:left;padding:8px 12px;color:#57606a;font-weight:500;font-size:12px;border-bottom:1px solid #d0d7de;white-space:nowrap}
th.sortable{cursor:pointer;user-select:none}
th.sortable:hover{color:#1f2328}
th.sort-active{color:#0969da}
.sort-ind{font-size:10px;margin-left:3px}
td{padding:7px 12px;border-bottom:1px solid #eaeef2;vertical-align:middle}
tr:hover td{background:#f6f8fa}
.sid{color:#0969da;font-size:11px;font-family:monospace;text-decoration:none}
.sid:hover{text-decoration:underline}
.ttl{max-width:320px}
.ttl-text{color:#1f2328;text-decoration:none;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ttl-text:hover{color:#0969da;text-decoration:underline}
.ttl-text.empty{color:#8c959f;font-style:italic}
.cost{color:#1a7f37;text-align:right;white-space:nowrap}
.tok{color:#57606a;text-align:right;white-space:nowrap}
.num{color:#57606a;text-align:right;white-space:nowrap}
.dt{color:#57606a;font-size:12px;white-space:nowrap}
.proj{color:#8250df;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ctx-tag{font-size:10px;color:#8c959f;margin-left:4px}
.live-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#2da44e;margin-right:6px;vertical-align:middle;animation:pulse 1.6s ease-in-out infinite}
.live-dot.off{background:transparent;animation:none}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.msg{text-align:center;padding:48px;color:#57606a}
.err{text-align:center;padding:48px;color:#cf222e}
.foot{padding:8px 24px;color:#57606a;font-size:12px;border-top:1px solid #d0d7de}
.summary{margin:16px 24px 0;border:1px solid #d0d7de;border-radius:10px;background:#f6f8fa;padding:14px 16px}
.summary-head{display:flex;align-items:center;gap:12px;margin-bottom:10px}
.summary-head h2{font-size:13px;font-weight:600;color:#1f2328}
.summary-head select{background:#fff;border:1px solid #d0d7de;color:#1f2328;padding:3px 8px;border-radius:6px;font-family:inherit;font-size:12px;cursor:pointer}
.summary-head .scope-cost{margin-left:auto;font-size:14px;color:#1a7f37;font-weight:600}
.sum-wrap{overflow-x:auto}
.sum-table{width:100%;border-collapse:collapse;font-size:12px}
.sum-table th{padding:3px 6px;font-size:10px;color:#8c959f;font-weight:500;border-bottom:1px solid #eaeef2;text-align:right;white-space:nowrap}
.sum-table th:first-child{text-align:left}
.sum-table td{padding:4px 6px;border-bottom:1px solid #f0f3f6;text-align:right;white-space:nowrap}
.sum-table td:first-child{text-align:left;color:#1f2328}
.sum-table tr:last-child td{border-bottom:none}
.sum-table .c-usd{color:#1a7f37;font-weight:600}
.sum-table .c-tok{color:#57606a}
.sum-table .c-sub{color:#8c959f;font-size:10px;margin-left:2px}
.sum-table tfoot td{border-top:1px solid #d0d7de;border-bottom:none;font-weight:600;color:#1f2328;padding-top:6px}
.sum-table.prov{min-width:640px}
</style>
</head>
<body>
<header>
  <h1>ccbb</h1>
  <span class="sub">session browser</span>
  <button class="refresh" onclick="load()">&#8635; Refresh</button>
</header>
<div class="summary" id="summary" style="display:none">
  <div class="summary-head">
    <h2>Cost summary</h2>
    <select id="sumScope" onchange="onScopeChange()"></select>
    <span class="scope-cost" id="sumScopeCost"></span>
  </div>
  <div id="sumProvider" class="sum-wrap"></div>
</div>
<div class="wrap"><div id="out" class="msg">Loading…</div></div>
<div class="foot" id="foot"></div>
<script>
__LIST_JS__
</script>
</body>
</html>`;

const LIST_JS = `
var sessions = [], totals = {}, costSummary = null;
var sortStack = [{col:'lastActivity', dir:'desc'}];
var COL_DEFAULTS = { live:'desc', title:'asc', startedAt:'desc', totalCost:'desc',
  totalTokens:'desc', turns:'desc', context:'desc', lastActivity:'desc', projectPath:'asc' };

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
function load() {
  loadSummary();
  var sel = document.getElementById('sumScope');
  var v = sel ? sel.value : 'all';
  loadSessions(v && v.indexOf('m:') === 0 ? v.slice(2) : null);
}
async function loadSessions(month) {
  var out = document.getElementById('out');
  out.className = 'msg'; out.textContent = 'Loading…';
  document.getElementById('foot').textContent = '';
  try {
    var r = await fetch('/api/sessions' + (month ? '?month=' + encodeURIComponent(month) : ''));
    var d = await r.json();
    if (!r.ok) throw new Error(d.error || r.statusText);
    sessions = d.sessions || []; totals = d.totals || {};
    render();
  } catch(e) {
    out.className = 'err'; out.textContent = 'Error: ' + e.message;
  }
}
async function loadSummary() {
  try {
    var r = await fetch('/api/cost-summary');
    var d = await r.json();
    if (!r.ok) throw new Error();
    costSummary = d; buildScopeOptions(); renderSummary();
    document.getElementById('summary').style.display = '';
  } catch(e) { document.getElementById('summary').style.display = 'none'; }
}
var PROV_LABEL = { bedrock:'Bedrock', anthropic:'Sub' };
function fmtMonth(mk){ var p=mk.split('-'), names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; return (names[+p[1]-1]||mk)+' '+p[0]; }
function fmtTokK(t){ t=t||0; if(t>=1e9)return (t/1e9).toFixed(1)+'B'; if(t>=1e6)return (t/1e6).toFixed(1)+'M'; if(t>=1e3)return (t/1e3).toFixed(1)+'K'; return String(t); }
function fc(c){ return c!=null?'$'+(+c).toFixed(2):'—'; }
function ft(t){ return t!=null?Number(t).toLocaleString():'—'; }
function fd(iso){ if(!iso)return '—'; try{ return new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){ return iso.slice(0,16); } }
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function trunc(s,n){ s=String(s||''); return s.length>n?s.slice(0,n-1)+'…':s; }
function shortModel(m){ return String(m).replace(/^claude-/,''); }

function buildScopeOptions() {
  var sel = document.getElementById('sumScope');
  var prev = sel.value;
  var months = Object.keys(costSummary.months || {}).sort().reverse();
  var opts = ['<option value="all">All time</option>'];
  opts = opts.concat(months.map(function(mk){ return '<option value="m:'+mk+'">'+fmtMonth(mk)+'</option>'; }));
  sel.innerHTML = opts.join('');
  sel.value = (prev && sel.querySelector('option[value="'+prev+'"]')) ? prev : 'all';
}
// Scope selection drives BOTH the summary and the session list: a month reloads
// sessions scoped to that month; "All time" reloads the full list.
function onScopeChange() {
  renderSummary();
  var v = document.getElementById('sumScope').value;
  loadSessions(v && v.indexOf('m:') === 0 ? v.slice(2) : null);
}
function currentScope() {
  var v = document.getElementById('sumScope').value;
  if (v === 'all' || !v) return costSummary.overall;
  return costSummary.months[v.slice(2)] || costSummary.overall;
}
// grey small suffix, matching the list page's ctx-tag styling
function gsub(s){ return '<span class="c-sub">'+s+'</span>'; }
// token count + grey "% of USD spent" for a category cell
function catCell(cat, totCost){
  if (!cat || !cat.tokens) return '<td class="c-tok">—</td>';
  var pct = totCost > 0 ? (cat.cost/totCost*100).toFixed(1) : '0.0';
  return '<td class="c-tok">'+fmtTokK(cat.tokens)+' '+gsub(pct+'%')+'</td>';
}
function provRowHtml(label, b){
  var c = b.categories;
  // Percentages are relative to THIS row's own cost, so cr+cw+out+in ≈ 100%
  // (cache-miss is an overlay on cache-write and is excluded from the total).
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
    + '</tr>';
}
function providerTableHtml(scope){
  var map = scope.byProvider || {};
  var keys = Object.keys(map).filter(function(k){ return map[k].tokens > 0; });
  if (!keys.length) return '<div style="color:#8c959f;font-size:11px">No usage.</div>';
  keys.sort(function(a,b){ return map[b].cost - map[a].cost; });
  var body = keys.map(function(k){ return provRowHtml(PROV_LABEL[k]||k, map[k]); }).join('');
  var foot = keys.length > 1 ? '<tfoot>'+provRowHtml('Total', scope.all)+'</tfoot>' : '';
  var head = '<thead><tr><th>&nbsp;</th><th>USD</th><th>Tokens</th><th>Turns</th>'
    + '<th>Cache Read</th><th>Cache Write</th><th>Cache Miss</th><th>Out</th><th>In</th></tr></thead>';
  return '<table class="sum-table prov">'+head+'<tbody>'+body+'</tbody>'+foot+'</table>';
}
function renderSummary() {
  if (!costSummary) return;
  var scope = currentScope();
  document.getElementById('sumScopeCost').textContent = fc(scope.all.cost);
  document.getElementById('sumProvider').innerHTML = providerTableHtml(scope);
}
function thSort(label, col, style) {
  var entry = sortStack.find(function(e){ return e.col === col; });
  var cls = 'sortable' + (entry ? ' sort-active' : '');
  var ind = entry ? '<span class="sort-ind">'+(entry.dir==='asc'?'▲':'▼')+'</span>' : '';
  var st = style ? ' style="'+style+'"' : '';
  return '<th class="'+cls+'" data-col="'+col+'"'+st+'>'+label+ind+'</th>';
}
function render() {
  var rows = applySort(sessions);
  var out = document.getElementById('out');
  if (!rows.length) { out.className = 'msg'; out.textContent = 'No sessions found.'; return; }
  var html = '<table><thead><tr>'
    + thSort('','live','width:1%') + '<th>ID</th>' + thSort('Title','title')
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
  document.getElementById('foot').textContent = (tc||tt)
    ? 'Total: '+(tc?fc(totals.totalCost):'')+(tc&&tt?' | ':'')+(tt?ft(totals.totalTokens)+' tokens':'') : '';
}
function rowHtml(s) {
  var sid = s.sessionId, sh = sid.slice(0,8);
  var titleHtml = s.title
    ? '<a class="ttl-text" href="/session/'+sid+'" title="'+esc(s.title)+'">'+esc(trunc(s.title,44))+'</a>'
    : '<a class="ttl-text empty" href="/session/'+sid+'">(no title)</a>';
  var ctx = s.context;
  var ctxHtml = ctx
    ? (ctx.postCompact?'~':'')+fmtTokK(ctx.tokens)+'<span class="ctx-tag">'+fc(ctx.cost)+'</span>'
    : '—';
  var sub = s.subTurns ? '<span class="ctx-tag">+'+s.subTurns+'</span>' : '';
  return '<tr>'
    + '<td>'+(s.live?'<span class="live-dot" title="Active"></span>':'<span class="live-dot off"></span>')+'</td>'
    + '<td><a class="sid" href="/session/'+sid+'">'+sh+'</a></td>'
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
// Context column sorts on context.tokens (the row value is an object).
function ctxTokens(s){ return s.context ? s.context.tokens : 0; }
document.getElementById('out').addEventListener('click', function(e) {
  var th = e.target.closest('th[data-col]');
  if (th) clickHeader(th.dataset.col, e.shiftKey);
});
load();
`;

// ── Web: session transcript page ──────────────────────────────────

const SESSION_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ccbb</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/highlight.js@11/lib/common.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css">
<style>
:root{
  --bg:#faf9f5; --bg-alt:#f0eee6; --surface:#fff; --ink:#3d3d3a; --ink-soft:#6e6d66;
  --ink-faint:#9b998f; --line:#e6e3da; --line-soft:#efece4; --accent:#c96442;
  --accent-soft:#f5e9e3; --code-bg:#f5f3ec;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;background:var(--bg);color:var(--ink);height:100vh;display:flex;flex-direction:column;overflow:hidden;-webkit-font-smoothing:antialiased}
.hdr{padding:10px 20px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px;background:var(--bg);flex-shrink:0}
.hdr-back{color:var(--ink-soft);text-decoration:none;font-size:13px;white-space:nowrap;padding:4px 8px;border-radius:6px}
.hdr-back:hover{background:var(--bg-alt);color:var(--ink)}
.hdr-title{font-weight:600;font-size:14px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;cursor:pointer;border-radius:5px;padding:1px 4px;margin:-1px -4px}
.hdr-title:hover{background:var(--bg-alt)}
.hdr-title.empty{color:var(--ink-faint);font-style:italic;font-weight:400}
.hdr-title-input{font-weight:600;font-size:14px;font-family:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--accent);border-radius:6px;padding:2px 6px;width:100%;box-shadow:0 0 0 3px var(--accent-soft)}
.hdr-title-input:focus{outline:none}
.hdr-proj{font-size:11px;color:var(--ink-soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.hdr-proj b{font-weight:600;color:var(--ink)}
.hdr-stats{font-size:11px;color:var(--ink-faint);line-height:1.55;font-variant-numeric:tabular-nums}
.hdr-stats b{font-weight:600;color:var(--ink-soft)}
.hdr-stats .sub{color:var(--ink-faint)}
.subturns{font-size:0.8em;color:var(--ink-faint)}
.status-dot{width:9px;height:9px;border-radius:50%;background:var(--ink-faint);flex-shrink:0}
.status-dot.live{background:#2da44e;animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
/* query-in-progress spinner (bottom center of the transcript area) */
.query-ind{position:absolute;bottom:14px;right:16px;width:16px;height:16px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;display:none;animation:spin .7s linear infinite;pointer-events:none;z-index:5}
.query-ind.show{display:block}
@keyframes spin{to{transform:rotate(360deg)}}
/* jump-to-latest marker (bottom center of the transcript area) */
.jump-marker{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);background:var(--accent);color:#fff;border:none;border-radius:16px;padding:5px 14px;font-size:12px;font-family:inherit;cursor:pointer;display:none;z-index:6;box-shadow:0 2px 6px rgba(0,0,0,.15)}
.jump-marker.show{display:block}
.jump-marker:hover{background:var(--accent-hover,#a84f34)}
.transcript{flex:1;overflow-y:auto;padding:32px 20px;display:flex;flex-direction:column;align-items:center;gap:24px;position:relative}
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
.msg.you .msg-body{background:var(--bg-alt);border:1px solid var(--line);border-radius:16px 16px 4px 16px;padding:12px 16px;max-width:85%;white-space:pre-wrap}
.tool-card{border:1px solid var(--line);border-radius:12px;overflow:hidden;font-size:13px;width:100%;max-width:740px;background:var(--surface)}
.tool-hdr{display:flex;align-items:center;gap:8px;padding:9px 14px;background:var(--bg-alt);cursor:pointer;user-select:none}
.tool-hdr:hover{background:var(--line-soft)}
.tool-name{font-weight:600;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink)}
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
/* permission prompt */
.perm-card{border:1px solid var(--accent);border-radius:12px;overflow:hidden;width:100%;max-width:740px}
.perm-hdr{padding:11px 16px;background:var(--accent-soft);border-bottom:1px solid var(--accent);font-size:13px;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:6px}
.perm-body{padding:12px 16px;background:var(--surface);font-size:14px;color:var(--ink)}
.perm-acts{padding:12px 16px;background:var(--bg-alt);border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:8px}
.perm-opt{background:var(--surface);border:1px solid var(--line);color:var(--ink);padding:6px 14px;border-radius:8px;font-size:13px;cursor:pointer;font-family:inherit;text-align:left}
.perm-opt:hover{border-color:var(--accent);background:var(--accent-soft)}
.perm-opt.first{background:var(--accent);border-color:var(--accent);color:#fff}
.perm-opt.first:hover{background:var(--accent-hover,#a84f34)}
.perm-note{font-size:12px;color:var(--ink-faint);padding:0 16px 12px;background:var(--bg-alt)}
/* command output box — sits in the page's column flex between transcript and input.
   Sizes are capped so it never pushes the input area out of view: default caps at
   45vh, max grows to fill available space (transcript shrinks), min shows only the
   header. In every state the header stays put and the content scrolls internally. */
.cmd-box{flex-shrink:0;border-top:1px solid var(--line);background:var(--bg-alt);max-height:45vh;display:none;flex-direction:column;min-height:0}
.cmd-box.show{display:flex}
.cmd-box.max{flex:4 1 0;max-height:none}
.cmd-box.min{flex:0 0 auto}
.cmd-head{flex-shrink:0;display:flex;align-items:center;gap:6px;padding:8px 20px;border-bottom:1px solid var(--line);font-size:12px;color:var(--ink-soft)}
.cmd-title{font-family:ui-monospace,Menlo,monospace;font-weight:600;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cmd-btns{margin-left:auto;display:flex;gap:2px;flex-shrink:0}
.cmd-btn{background:none;border:none;color:var(--ink-soft);font-size:15px;cursor:pointer;line-height:1;padding:3px 7px;border-radius:6px;font-family:inherit}
.cmd-btn:hover{background:var(--line);color:var(--ink)}
.cmd-content{overflow:auto;padding:14px 20px;flex:1 1 auto;min-height:0}
.cmd-box.min .cmd-content{display:none}
.cmd-content pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:12px 14px;font-size:12.5px;line-height:1.5;overflow:auto;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.cmd-content.code pre,.cmd-content.md pre{white-space:pre;word-break:normal}
.cmd-content.md{font-size:14px;line-height:1.6}
.cmd-content code.hljs{background:none;padding:0;font-family:inherit}
.cmd-content.diff .hljs-addition{background:#e6ffec;color:#1a7f37;display:inline-block;width:100%}
.cmd-content.diff .hljs-deletion{background:#ffebe9;color:#cf222e;display:inline-block;width:100%}
/* input area */
.input-area{border-top:1px solid var(--line);padding:16px 20px;background:var(--bg);flex-shrink:0;display:flex;flex-direction:column;align-items:center}
.input-inner{width:100%;max-width:740px}
.input-row{display:flex;gap:8px;align-items:flex-end;background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:8px 8px 8px 16px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.input-row:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.input-box{flex:1;border:none;background:none;padding:6px 0;font-size:15px;font-family:inherit;resize:none;min-height:66px;max-height:200px;line-height:1.5;overflow-y:auto;color:var(--ink)}
.input-box:focus{outline:none}
.send-btn{background:var(--accent);border:none;color:#fff;width:36px;height:36px;border-radius:10px;font-size:16px;cursor:pointer;font-family:inherit;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.send-btn:hover:not(:disabled){background:var(--accent-hover,#a84f34)}
.send-btn:disabled{opacity:.4;cursor:default}
.input-hint{font-size:11px;color:var(--ink-faint);margin-top:8px;text-align:center;width:100%;max-width:740px}
.input-hint.off{color:#cf7a4a}
</style>
</head>
<body>
<div class="hdr">
  <a class="hdr-back" href="/">&#8592; ccbb</a>
  <div class="status-dot" id="statusDot" title="Idle"></div>
  <div style="display:flex;flex-direction:column;flex:1;min-width:0;gap:1px">
    <div class="hdr-title" id="hdrTitle">Loading…</div>
    <div class="hdr-proj" id="hdrProj"></div>
    <div class="hdr-stats" id="hdrStats"></div>
  </div>
</div>
<div style="position:relative;flex:1;min-height:0;display:flex;flex-direction:column">
  <div class="transcript" id="transcript"></div>
  <button class="jump-marker" id="jumpMarker" onclick="jumpToLatest()">&#8595; New updates</button>
  <div class="query-ind" id="queryInd" title="Querying…"></div>
</div>
<div class="cmd-box" id="cmdBox">
  <div class="cmd-head">
    <span class="cmd-title" id="cmdTitle"></span>
    <div class="cmd-btns">
      <button class="cmd-btn" id="cmdMin" onclick="minCmd()" title="Minimize">&#8211;</button>
      <button class="cmd-btn" id="cmdMax" onclick="maxCmd()" title="Maximize">&#9633;</button>
      <button class="cmd-btn" onclick="hideCmd()" title="Close">&#10005;</button>
    </div>
  </div>
  <div class="cmd-content" id="cmdContent"></div>
</div>
<div class="input-area">
  <div class="input-inner">
    <div class="input-row">
      <textarea class="input-box" id="inputBox" placeholder="Message the session…  (// for commands)" rows="3"></textarea>
      <button class="send-btn" id="sendBtn" onclick="sendMessage()" title="Send">&#8593;</button>
    </div>
  </div>
  <div class="input-hint" id="inputHint">Enter to send &nbsp;&#183;&nbsp; Shift+Enter for newline &nbsp;&#183;&nbsp; /compact to compact &nbsp;&#183;&nbsp; //help for commands</div>
</div>
<script>
__SESSION_JS__
</script>
</body>
</html>`;

const SESSION_JS = `
var INFO = __SESSION_INFO__;
var ws, reconnectTimer;
var msgEls = {}, toolEls = {}, seenUuids = {};
var historyLoaded = false, pendingTranscript = [];

// Prices injected by the server from pricing.js (LiteLLM, daily). Matched by the
// message's actual model id (mirrors pricing.js priceForModel) so the live-stream
// cost line uses the same per-version rates as the server's session totals.
var PRICE_TABLE = __PRICING__;
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
function esc(s){ return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTokShort(n){ n=n||0; if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1)+'M'; if(n>=1e3)return (n/1e3).toFixed(n>=1e4?0:1)+'K'; return String(n); }
function fmtCost(c){ return '$'+(c||0).toFixed(2); }
function fmtPct(part,whole){ return (whole>0?(100*part/whole):0).toFixed(1)+'%'; }
function fmtStatDate(iso){ if(!iso)return '—'; try{ return new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){ return String(iso).slice(0,16); } }
function prettyModel(m){ m=String(m||''); if(!m||m==='unknown')return 'Unknown'; var x=m.replace(/^claude-/,'').replace(/-\\d{6,}$/,''); var parts=x.split('-'); var name=(parts.shift()||''); name=name.charAt(0).toUpperCase()+name.slice(1); var ver=parts.join('.'); return ver?name+' '+ver:name; }

function renderTitle() {
  var el = document.getElementById('hdrTitle');
  el.textContent = INFO.title || '(untitled — ' + INFO.sessionId.slice(0,8) + ')';
  el.className = 'hdr-title' + (INFO.title ? '' : ' empty');
  el.title = 'Click to rename';
  el.onclick = editSessionTitle;
  document.title = (INFO.title || INFO.sessionId.slice(0,8)) + ' · ccbb';
}
function editSessionTitle() {
  var el = document.getElementById('hdrTitle');
  var inp = document.createElement('input');
  inp.className = 'hdr-title-input';
  inp.value = INFO.title || '';
  inp.placeholder = 'Session name';
  el.replaceWith(inp);
  inp.focus(); inp.select();
  var done = false;
  function finish(save) {
    if (done) return; done = true;
    var val = inp.value.trim();
    if (save && val !== (INFO.title || '')) {
      INFO.title = val;
      fetch('/api/session/' + INFO.sessionId, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: val })
      }).catch(function(){});
    }
    var t = document.createElement('div');
    t.id = 'hdrTitle';
    inp.replaceWith(t);
    renderTitle();
  }
  inp.addEventListener('blur', function(){ finish(true); });
  inp.addEventListener('keydown', function(e){
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { finish(false); }
  });
}
function renderStats(st) {
  var el = document.getElementById('hdrStats');
  if (!st) { el.textContent = ''; return; }
  var proj = document.getElementById('hdrProj');
  if (proj) proj.innerHTML = (INFO.projectPath?'<b>'+esc(INFO.projectPath)+'</b>':'') +
    '  &middot;  last '+esc(fmtStatDate(st.lastActivity))+'  &middot;  started '+esc(fmtStatDate(st.startedAt));
  var models = (st.models||[]).filter(function(m){ return m.cost>=0.005; });
  var modelStr = models.length>=2
    ? ' ('+models.map(function(m){ return esc(prettyModel(m.model))+': '+fmtCost(m.cost); }).join(' · ')+')'
    : (models.length===1?' <span class="sub">('+esc(prettyModel(models[0].model))+')</span>':'');
  var c = st.categories||{}, totCost = st.cost||0;
  // token count + dimmed "% of USD spent" (cr / cw / cm / out / in)
  function cat(label,key){ var x=c[key]||{tokens:0,cost:0}; return '<span class="rl-lbl">'+label+'</span> '+fmtTokShort(x.tokens)+' <span class="rl-pct">'+fmtPct(x.cost,totCost)+'</span>'; }
  var tokStr = cat('cr','cacheRead')+'  '+cat('cw','cacheWrite')+'  '+cat('cm','cacheMiss')+'  '+cat('out','output')+'  '+cat('in','input');
  var ctx = st.context;
  var ctxStr = ctx ? '  &middot;  ctx:'+(ctx.postCompact?'~':'')+'<b>'+fmtTokShort(ctx.tokens)+'</b>/'+fmtCost(ctx.cost)+
    (ctx.postCompact?' <span class="subturns">post-compact</span>':'') : '';
  var turns = st.turns||0, subTurns = st.subTurns||0;
  var subStr = subTurns>0?' <span class="subturns">+'+subTurns+'</span>':'';
  el.innerHTML = '<b>'+turns+'</b>'+subStr+' turn'+(turns===1?'':'s')+
    '  &middot;  <b>'+fmtCost(st.cost)+'</b>'+modelStr+
    '  &middot;  <b>'+fmtTokShort(st.totalTokens)+'</b>  '+tokStr+ctxStr;
}
function setLive(live) {
  var dot = document.getElementById('statusDot');
  if (live) { dot.className = 'status-dot live'; dot.title = 'Active'; }
  else { dot.className = 'status-dot'; dot.title = 'Idle'; }
}
// Query-in-progress spinner: ref-counted so overlapping fetches keep it lit.
var queryCount = 0;
function queryStart(){ queryCount++; document.getElementById('queryInd').classList.add('show'); }
function queryEnd(){ queryCount = Math.max(0, queryCount-1); if (!queryCount) document.getElementById('queryInd').classList.remove('show'); }
// fetch wrapper that drives the spinner.
function qfetch(url, opts){ queryStart(); return fetch(url, opts).finally(queryEnd); }
function pollLive() {
  qfetch('/api/session/'+INFO.sessionId+'/live').then(function(r){return r.json();})
    .then(function(d){ setLive(d&&d.live); }).catch(function(){});
  qfetch('/api/session/'+INFO.sessionId+'/stats').then(function(r){return r.json();})
    .then(function(d){ if(d) renderStats(d); }).catch(function(){});
}

// ── Per-response usage line ───────────────────────────────────────────────────
// One line per assistant response (keyed by msg.id, updated in place while streaming):
//   <turn>: <usd> <tokens>  <cache-read> <cache-write> <cache-miss> <out> <in>
// where each of the last five shows the token count + a dimmed "% of USD spent".
var statEls = {};       // msg.id → line element
var statTurnNo = {};    // msg.id → assigned turn number
var statTurns = 0;      // running count of distinct responses
var statSeenFirst = false;  // has the first billable response passed (for cache-miss)?
function emitMsgStats(msg, hist) {
  var u = msg.usage||{};
  var input=u.input_tokens||0, output=u.output_tokens||0;
  var cacheRead=u.cache_read_input_tokens||0, cacheWrite=u.cache_creation_input_tokens||0;
  var totalTok = input+output+cacheRead+cacheWrite;
  if (!totalTok) return;
  var p = priceFor(msg.model);
  var cIn=input*p.input/1e6, cOut=output*p.output/1e6;
  var cCr=cacheRead*p.cacheRead/1e6, cCw=cacheWrite*p.cacheWrite/1e6;
  var cost = cIn+cOut+cCr+cCw;
  // Cache miss: cache_read is 0 on a response that isn't the first — the cache
  // write incurred because nothing was served from cache.
  var isFirst = !statSeenFirst; statSeenFirst = true;
  var missTok = (cacheRead===0 && !isFirst) ? cacheWrite : 0;
  var missCost = (cacheRead===0 && !isFirst) ? cCw : 0;
  var pct = function(x){ return (cost>0?(x/cost*100):0).toFixed(1)+'%'; };
  // dimmed 2-letter label + token count + dimmed % of USD spent
  var seg = function(lbl,t,x){ return '<span class="rl-lbl">'+lbl+'</span> '+fmtTokShort(t)+' <span class="rl-pct">'+pct(x)+'</span>'; };
  var turnNo;
  if (msg.id && statTurnNo[msg.id]) turnNo = statTurnNo[msg.id];
  else { turnNo = ++statTurns; if (msg.id) statTurnNo[msg.id] = turnNo; }
  // ctx: this response's context size (in + cr + cw + out) and its cache-read cost.
  var ctxTok = input+cacheRead+cacheWrite+output;
  var ctxCost = ctxTok*p.cacheRead/1e6;
  var line = '<span class="rl-turn">'+turnNo+':</span> '+
    '<b>'+fmtCost(cost)+'</b> '+fmtTokShort(totalTok)+
    '  '+seg('cr',cacheRead,cCr)+'  '+seg('cw',cacheWrite,cCw)+'  '+seg('cm',missTok,missCost)+
    '  '+seg('out',output,cOut)+'  '+seg('in',input,cIn)+
    '  <span class="rl-lbl">ctx</span> '+fmtTokShort(ctxTok)+' <span class="rl-pct">'+fmtCost(ctxCost)+'</span>';
  var el = statEls[msg.id];
  if (!el) {
    el = document.createElement('div');
    el.className = 'result-line'+(hist?' hist':'');
    if (msg.id) statEls[msg.id] = el;
    document.getElementById('transcript').appendChild(el);
  }
  el.innerHTML = line;
  scrollBottom();
}

// ── Entry rendering ───────────────────────────────────────────────────────────
function processEntry(entry, hist) {
  var msg = entry.message;
  if (!msg) return;
  if (entry.uuid) { if (seenUuids[entry.uuid]) return; seenUuids[entry.uuid] = true; }
  if (entry.role === 'assistant') {
    renderAssistant(msg, hist);
    if (msg.usage) emitMsgStats(msg, hist);
  } else if (entry.role === 'user') {
    if (entry.compact) { renderCompactMarker(msg, hist); return; }
    var hasToolResult = (msg.content||[]).some(function(b){ return b.type==='tool_result'; });
    if (hasToolResult) renderToolResults(msg);
    renderUserMessage(msg, hist);
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
    var el = msgEls[msgId];
    if (!el) {
      el = document.createElement('div');
      el.className = 'msg'+(hist?' hist':'');
      el.innerHTML = '<div class="msg-label">Claude</div><div class="msg-body"></div>';
      msgEls[msgId] = el;
      document.getElementById('transcript').appendChild(el);
    }
    el.querySelector('.msg-body').innerHTML = hasText ? marked.parse(joined) : '';
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
    document.getElementById('transcript').appendChild(card);
  }
  card.querySelector('.think-body').textContent = text;
}
function renderToolUse(block, hist) {
  var id = block.id;
  if (toolEls[id]) return;
  var card = document.createElement('div');
  card.className = 'tool-card'+(hist?' hist':''); card.id = 'tool-'+id;
  var inputStr = formatToolInput(block.name, block.input);
  card.innerHTML =
    '<div class="tool-hdr" onclick="toggleTool(this)"><span class="tool-name">'+esc(block.name)+'</span>'+
      '<span class="tool-status '+(hist?'done':'running')+'" id="ts-'+id+'">'+(hist?'Done':'Running')+'</span>'+
      '<span class="tool-toggle" id="tt-'+id+'">&#9660;</span></div>'+
    '<div class="tool-body open" id="tb-'+id+'"><div class="tool-input"><pre>'+esc(inputStr)+'</pre></div>'+
      '<div class="tool-output" id="to-'+id+'"></div></div>';
  toolEls[id] = card;
  document.getElementById('transcript').appendChild(card);
  scrollBottom();
}
function renderToolResults(msg) {
  for (var i=0;i<(msg.content||[]).length;i++) {
    var block = msg.content[i];
    if (block.type!=='tool_result') continue;
    var id = block.tool_use_id;
    var outputEl = document.getElementById('to-'+id), statusEl = document.getElementById('ts-'+id);
    if (!outputEl) continue;
    var isError = block.is_error;
    if (statusEl) { statusEl.className = 'tool-status '+(isError?'error':'done'); statusEl.textContent = isError?'Error':'Done'; }
    var content = '';
    if (typeof block.content==='string') content = block.content;
    else if (Array.isArray(block.content)) content = block.content.filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('');
    outputEl.innerHTML = '<pre>'+esc(content)+'</pre>';
  }
}
function formatToolInput(toolName, input) {
  if (!input) return '';
  var s = function(v){ return v==null?'':String(v); };
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
  if (toolName==='Task' && (input.description||input.prompt)) return s(input.description)+'\\n\\n'+s(input.prompt);
  try { return JSON.stringify(input, null, 2); } catch(e) { return String(input); }
}
function toggleTool(hdr) {
  var body = hdr.nextElementSibling, toggle = hdr.querySelector('.tool-toggle');
  var open = body.classList.toggle('open');
  if (toggle) toggle.innerHTML = open?'&#9660;':'&#9654;';
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
  var el = document.createElement('div');
  el.className = 'compact-marker'+(hist?' hist':'');
  el.innerHTML = '<div class="compact-line"><span class="compact-label">&#10719; Context compacted</span></div>'+
    '<details class="compact-details"><summary>View summary</summary><div class="compact-summary">'+esc(summary)+'</div></details>';
  document.getElementById('transcript').appendChild(el);
  scrollBottom();
}
function renderUserMessage(msg, hist) {
  var text = (msg.content||[]).filter(function(b){return b.type==='text';}).map(function(b){return b.text;}).join('').trim();
  if (!text || isSystemNoise(text)) return false;
  var el = document.createElement('div');
  el.className = 'msg you'+(hist?' hist':'');
  el.innerHTML = '<div class="msg-label">You</div><div class="msg-body">'+esc(text)+'</div>';
  document.getElementById('transcript').appendChild(el);
  scrollBottom();
  return true;
}
// Auto-scroll only when the user is already near the bottom. If they've scrolled up
// (more than ~10 lines away), leave the viewport put and surface a jump marker instead,
// so a live update doesn't yank them away from what they're reading.
var NEAR_BOTTOM_PX = 250;   // ≈ 10 lines
function distFromBottom(t){ return t.scrollHeight - t.scrollTop - t.clientHeight; }
function scrollBottom(force){
  var t = document.getElementById('transcript');
  if (force || distFromBottom(t) <= NEAR_BOTTOM_PX) {
    t.scrollTop = t.scrollHeight;
    hideJumpMarker();
  } else {
    showJumpMarker();
  }
}
function showJumpMarker(){ var m = document.getElementById('jumpMarker'); if (m) m.classList.add('show'); }
function hideJumpMarker(){ var m = document.getElementById('jumpMarker'); if (m) m.classList.remove('show'); }
function jumpToLatest(){ scrollBottom(true); }
// Keep any open permission card pinned to the bottom: the pane-scrape can surface the
// prompt before the tool/command entry lands via the (slower) JSONL tail, so re-append
// permission cards whenever new transcript content arrives so they float below it.
function repinPermissions(){
  var t = document.getElementById('transcript');
  for (var k in permEls) t.appendChild(permEls[k]);
}

// ── WebSocket (live tail) ─────────────────────────────────────────────────────
function connect() {
  clearTimeout(reconnectTimer);
  var proto = location.protocol==='https:'?'wss:':'ws:';
  ws = new WebSocket(proto+'//'+location.host+'/ws/'+INFO.sessionId);
  ws.onmessage = function(e){ handleWsMsg(JSON.parse(e.data)); };
  ws.onclose = function(){ reconnectTimer = setTimeout(connect, 2000); };
}
function handleWsMsg(msg) {
  if (msg.type==='transcript') {
    if (!historyLoaded) pendingTranscript.push(msg.entry);
    else processEntry(msg.entry, false);
  } else if (msg.type==='permission') {
    showPermission(msg);
  } else if (msg.type==='permission_clear') {
    clearPermission(msg.fp);
  } else if (msg.type==='command') {
    showCmd(msg);
  }
}

// ── Permission prompt (scraped from the tmux pane, answered by injecting a number) ─
var permEls = {};   // fp -> element
function showPermission(msg) {
  clearPermission(msg.fp);
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
  document.getElementById('transcript').appendChild(card);
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

// ── Boot ──────────────────────────────────────────────────────────────────────
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
  for (var i=0;i<pendingTranscript.length;i++) processEntry(pendingTranscript[i], false);
  pendingTranscript = [];
}

// ── Composer: send input to the running session, or run a // command ────────────
var canDrive = false, cmdCwd = '';
function refreshDrivable() {
  qfetch('/api/session/'+INFO.sessionId+'/pane').then(function(r){return r.json();})
    .then(function(d){ setDrivable(d && !!d.pane); }).catch(function(){ setDrivable(false); });
}
function setDrivable(ok) {
  canDrive = ok;
  var hint = document.getElementById('inputHint');
  var box = document.getElementById('inputBox');
  if (ok) {
    hint.className = 'input-hint';
    hint.innerHTML = 'Enter to send &nbsp;&middot;&nbsp; Shift+Enter for newline &nbsp;&middot;&nbsp; /compact to compact &nbsp;&middot;&nbsp; //help for commands';
    box.placeholder = 'Message the session…  (/compact, // for commands)';
  } else {
    hint.className = 'input-hint off';
    hint.innerHTML = 'Session not running in a tmux pane here — input disabled. // commands still work.';
    box.placeholder = 'Session not attachable — // commands still work';
  }
}
function autoGrow(el){ el.style.height='auto'; el.style.height=Math.min(200, Math.max(66, el.scrollHeight))+'px'; }
function sendMessage() {
  var box = document.getElementById('inputBox');
  var text = box.value;
  if (!text.trim()) return;
  if (text.trim().charAt(0) === '/' && text.trim().charAt(1) === '/') { runCmd(text.trim()); box.value=''; autoGrow(box); return; }
  if (!canDrive) { if (text.trim().charAt(0) === '/') alert('Session not running in a tmux pane here — cannot send /commands.'); return; }
  var btn = document.getElementById('sendBtn'); btn.disabled = true;
  qfetch('/api/session/'+INFO.sessionId+'/input', {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text: text })
  }).then(function(r){ return r.json(); }).then(function(d){
    if (d && d.ok) { box.value=''; autoGrow(box); } else { alert((d&&d.error)||'Send failed'); }
  }).catch(function(e){ alert(String(e)); }).then(function(){ btn.disabled=false; box.focus(); });
}
// ── "//" custom commands ────────────────────────────────────────────────────────
function runCmd(raw) {
  var body = raw.slice(2).trim();
  var sp = body.indexOf(' ');
  var name = sp === -1 ? body : body.slice(0, sp);
  var args = sp === -1 ? '' : body.slice(sp + 1);
  if (!name) return;
  qfetch('/api/session/'+INFO.sessionId+'/command', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name: name, args: args, cwd: cmdCwd })
  }).then(function(r){ return r.json(); }).then(function(d){ showCmd(d); }).catch(function(e){ showCmd({ error:String(e) }); });
}
function showCmd(d) {
  if (d && d.cwd) cmdCwd = d.cwd;
  if (d && d.kind === 'clear') { hideCmd(); return; }
  var box = document.getElementById('cmdBox');
  var title = document.getElementById('cmdTitle');
  var content = document.getElementById('cmdContent');
  if (d && d.error) {
    title.textContent = 'error';
    content.className = 'cmd-content';
    content.innerHTML = '<pre style="color:#cf222e">'+esc(d.error)+'</pre>';
  } else if (d.kind === 'markdown') {
    title.textContent = d.title || '';
    content.className = 'cmd-content md';
    content.innerHTML = marked.parse(d.content || '');
  } else if (d.kind === 'source') {
    title.textContent = d.title || '';
    content.className = 'cmd-content code' + (d.lang === 'diff' ? ' diff' : '');
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
    content.innerHTML = ''; content.appendChild(pre);
  } else {
    title.textContent = d.title || '';
    content.className = 'cmd-content';
    content.innerHTML = '<pre>'+esc(d.content||'')+'</pre>';
  }
  box.classList.remove('min', 'max');   // fresh output restores the default size
  box.classList.add('show');
  content.scrollTop = 0;
}
function hideCmd() { document.getElementById('cmdBox').classList.remove('show','min','max'); }
function minCmd() { document.getElementById('cmdBox').classList.toggle('min'); document.getElementById('cmdBox').classList.remove('max'); }
function maxCmd() { document.getElementById('cmdBox').classList.toggle('max'); document.getElementById('cmdBox').classList.remove('min'); }

(function initComposer(){
  var box = document.getElementById('inputBox');
  box.addEventListener('input', function(){ autoGrow(box); });
  box.addEventListener('keydown', function(e){
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  autoGrow(box);
  refreshDrivable();
  setInterval(refreshDrivable, 5000);
  // Hide the jump marker once the user scrolls back down to the bottom themselves.
  var t = document.getElementById('transcript');
  t.addEventListener('scroll', function(){ if (distFromBottom(t) <= NEAR_BOTTOM_PX) hideJumpMarker(); });
})();

renderTitle();
renderStats(INFO.stats);
setLive(INFO.live);
setInterval(pollLive, 4000);
connect();
loadHistory();
`;

function listPageHtml() {
  return LIST_HTML.replace('__LIST_JS__', () => LIST_JS);
}
function sessionPageHtml(sessionId, info) {
  const safeInfo = JSON.stringify({
    sessionId,
    title: (info && info.title) || '',
    projectPath: (info && info.projectPath) || '',
    live: !!(info && info.live),
    liveStatus: (info && info.liveStatus) || null,
    stats: (info && info.stats) || null,
  });
  const safePricing = JSON.stringify(priceTable);
  return SESSION_HTML.replace('__SESSION_JS__',
    () => SESSION_JS
      .replace('__SESSION_INFO__', () => safeInfo)
      .replace('__PRICING__', () => safePricing));
}

// ── Page HTML assembly ─────────────────────────────────────────────────────────
function listPageHtml() {
  return LIST_HTML.replace('__LIST_JS__', () => LIST_JS);
}
function sessionPageHtml(sessionId, info) {
  const safeInfo = JSON.stringify({
    sessionId,
    title: (info && info.title) || '',
    projectPath: (info && info.projectPath) || '',
    live: !!(info && info.live),
    liveStatus: (info && info.liveStatus) || null,
    stats: (info && info.stats) || null,
  });
  const safePricing = JSON.stringify(priceTable);
  return SESSION_HTML.replace('__SESSION_JS__',
    () => SESSION_JS
      .replace('__SESSION_INFO__', () => safeInfo)
      .replace('__PRICING__', () => safePricing));
}

// ── Web: live transcript tailing (rides the shared tailer in ccbb-common) ────────
// Bridges the shared per-line tailer to per-client onEntry callbacks. Reference-counted
// so many browsers can watch one session.
const webWatchers = new Map();  // sessionId → { onEntry }
function startWatching(sessionId, onEntry) {
  webWatchers.set(sessionId, { onEntry });
  startTail(sessionId, d => {
    const w = webWatchers.get(sessionId);
    if (!w) return;
    const e = transcriptEntry(d);
    if (e) w.onEntry(e);
  });
}
function stopWatching(sessionId) {
  webWatchers.delete(sessionId);
  stopTail(sessionId);
}

// ── Permission prompt scraping (tmux pane → WebSocket push) ─────────────────────
// The permission dialog is drawn only in the terminal — it never reaches the JSONL. We
// stream the pane via `tmux pipe-pane` and watch the log with fs.watch (push, not
// polling); on output we capture the pane once, detect the box, and broadcast it to the
// browser as a permission frame. The browser answers by POSTing an option number, which
// we inject back into the pane.
const activePrompts = new Map();   // sessionId → { fp, title, options:[{n,label}], pane }
const paneWatchers = new Map();    // sessionId → { pane, logPath, watcher, debounce }

function watchLogPath(sessionId) {
  return path.join(os.tmpdir(), `ccbb-pane-${sessionId}.log`);
}

// Inspect the pane now: broadcast a new box, or clear a vanished one.
function checkPrompt(sessionId, pane) {
  const parsed = parsePrompt(capturePane(pane));
  const prev = activePrompts.get(sessionId);
  if (!parsed) {
    if (prev) { activePrompts.delete(sessionId); wsBroadcast(sessionId, { type: 'permission_clear', fp: prev.fp }); }
    return;
  }
  const fp = promptFingerprint(parsed);
  if (prev && prev.fp === fp) return;
  const rec = { fp, title: parsed.title, options: parsed.options, pane };
  activePrompts.set(sessionId, rec);
  wsBroadcast(sessionId, { type: 'permission', fp, title: parsed.title, options: parsed.options });
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

function runWeb(args) {
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) port = parseInt(args[++i], 10);
    else if (args[i] === '-h' || args[i] === '--help') {
      console.log(`ccbb web — web UI\n\nUsage: ccbb web [-p port]   (default ${DEFAULT_PORT})`);
      return;
    }
  }

  const server = http.createServer((req, res) => {
    const { method } = req;
    const pathname = req.url.split('?')[0];
    const query = new URLSearchParams(req.url.split('?')[1] || '');
    let m;
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) return sendHtml(res, listPageHtml());
    if (method === 'GET' && pathname === '/api/sessions') {
      const mk = query.get('month');
      const filter = mk && /^\d{4}-\d{2}$/.test(mk) ? { period: 'month', key: mk } : null;
      return send(res, 200, getSessions(filter));
    }
    if (method === 'GET' && pathname === '/api/cost-summary') return send(res, 200, getCostSummary());
    if (method === 'GET' && (m = pathname.match(/^\/session\/([^/]+)$/)))
      return sendHtml(res, sessionPageHtml(m[1], getSessionInfo(m[1])));
    if (method === 'GET' && (m = pathname.match(/^\/api\/session-info\/([^/]+)$/)))
      return send(res, 200, getSessionInfo(m[1]));
    if (method === 'GET' && (m = pathname.match(/^\/api\/session\/([^/]+)\/history$/)))
      return send(res, 200, { history: getSessionHistory(m[1]) });
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
    console.log(`ccbb http://127.0.0.1:${port}`);
  });

  let WS;
  try { WS = require('ws'); } catch {}
  if (WS) {
    const wss = new WS.Server({ noServer: true });
    const clients = new Map(); // sessionId -> Set<ws>
    const sendTo = (sessionId, obj) => {
      const set = clients.get(sessionId);
      if (!set) return;
      const json = JSON.stringify(obj);
      for (const c of set) if (c.readyState === 1) c.send(json);
    };
    wsBroadcast = sendTo;
    server.on('upgrade', (req, socket, head) => {
      const m = req.url && req.url.match(/^\/ws\/([^/?]+)/);
      if (!m) return socket.destroy();
      wss.handleUpgrade(req, socket, head, ws => {
        const sessionId = m[1];
        if (!clients.has(sessionId)) clients.set(sessionId, new Set());
        clients.get(sessionId).add(ws);
        startWatching(sessionId, e => sendTo(sessionId, { type: 'transcript', entry: e }));
        const loc = paneForSession(sessionId);
        if (loc) startPaneWatch(sessionId, loc.pane);
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

module.exports = { runWeb, DEFAULT_PORT };

if (require.main === module) runWeb(process.argv.slice(2));
