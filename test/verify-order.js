'use strict';
// Transcript ordering in the mux client: where // command cards land relative to the
// turns that come after them. A fake mux socket, no model, no real session data.
// CHROME=/path/to/chrome node test/verify-order.js
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-order-fixture-'));
process.env.CLAUDE_CONFIG_DIR = cfg; process.env.CCBB_HOME = cfg;
require('../ccbb-web');
const { mount } = require('../ccbb-mux-web');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to a Chromium executable');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 100; i++) { if (await fn()) return; await sleep(50); } throw new Error('Timed out: ' + label); }

const ts = n => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
const user = (id, text, n) => ({ id, role: 'user', ts: ts(n), blocks: [{ type: 'text', text }] });
const asst = (id, apiId, text, n) => ({ id, apiId, role: 'assistant', ts: ts(n), blocks: [{ type: 'text', text }] });
const snap = messages => ({ op: 'snapshot', seq: 1, epoch: 'e1', clients: [], pending: [], messages,
  state: { id: 'fx', agent: 'claude', title: 'fx', status: 'idle', cwd: '/tmp', capabilities: [] } });

let sock = null, seq = 1;
const push = ev => sock.send(JSON.stringify({ op: 'event', seq: ++seq, ...ev }));
const handler = mount({ list: () => [], token: '' });
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://fixture');
  if (req.method === 'POST' && u.pathname === '/api/session/fx/command') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ kind: 'console', title: '//pwd', content: '/tmp', cwd: '/tmp' }));
  }
  if (u.pathname.startsWith('/mux/s/') && handler(req, res, u.pathname.slice(4))) return;
  res.setHeader('Content-Type', 'application/json'); res.end('{}');
});
const wss = new WebSocketServer({ server });
let first = [];
wss.on('connection', ws => { sock = ws; ws.on('message', () => {}); ws.send(JSON.stringify(snap(first))); });

let cdp, child;
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + path.join(cfg, 'browser'), 'about:blank'], { stdio: 'ignore', detached: true });
  const devtools = path.join(cfg, 'browser', 'DevToolsActivePort'); await until(() => fs.existsSync(devtools), 'DevTools');
  const port = fs.readFileSync(devtools, 'utf8').split('\n')[0];
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  cdp = new WebSocket(tabs[0].webSocketDebuggerUrl); await new Promise(r => cdp.once('open', r));
  let id = 0; const pending = new Map(); cdp.on('message', raw => { const m = JSON.parse(raw); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); cdp.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r)); return r.result.result.value; };
  await send('Page.enable');

  // The log's items in DOM order, each reduced to a short tag: a message's text, or
  // "//pwd" for a command card.
  const order = () => evaluate(`[].slice.call(document.querySelector('.mx-log').firstChild.children).map(function(n){
    var name = n.querySelector('.tool-name'); if (name && name.textContent.indexOf('//') === 0) return name.textContent.split(' ')[0];
    var t = n.textContent.trim(); var m = t.match(/\\b(u\\d|a\\d)\\b/); return m ? m[1] : t.slice(0, 20); })`);
  const open = async messages => {
    first = messages; sock = null;
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + '/mux/s/fx' });
    await until(() => sock, 'socket');
    await until(() => evaluate('!!document.querySelector(".mx-log") && document.querySelector(".mx-log").textContent.indexOf("' + (messages.length ? 'a1' : '') + '") >= 0'), 'snapshot');
  };
  const runPwd = async () => {
    await evaluate('(function(){var i=document.querySelector(".input-box");i.value="//pwd";document.querySelector(".send-btn").click();})()');
    await until(async () => (await order()).includes('//pwd'), 'command card');
  };
  const expectAfter = async (label, want) => {
    await until(async () => JSON.stringify((await order()).filter(x => want.includes(x))) === JSON.stringify(want), label)
      .catch(async e => { throw new Error(e.message + ': ' + JSON.stringify(await order())); });
    console.log('OK: ' + label);
  };

  // 1. A reply interrupted mid-stream never gets its final message. Its streamed entry
  // must not keep the command card below every later turn.
  await open([user('m1', 'u1', 1), asst('m2', 'X', 'a1', 2)]);
  push({ kind: 'delta', messageId: 'Y', index: 0, deltaKind: 'text', text: 'partial' });
  push({ kind: 'interrupted', by: 'test' });
  await sleep(100);
  await runPwd();
  push({ kind: 'message', message: user('m3', 'u2', 10) });
  push({ kind: 'message', message: asst('m4', 'Z', 'a2', 11) });
  await expectAfter('command stays above turns after an interrupted stream', ['a1', '//pwd', 'u2', 'a2']);

  // 2. A tool_pending with no message id (or one already finalized) must not make a
  // stream entry that the card anchors to.
  await open([user('m1', 'u1', 1), asst('m2', 'X', 'a1', 2)]);
  push({ kind: 'tool_pending', messageId: null, id: 't1', name: 'Bash' });
  push({ kind: 'tool_pending', messageId: 'X', id: 't2', name: 'Bash' });
  await sleep(100);
  await runPwd();
  push({ kind: 'message', message: user('m3', 'u2', 10) });
  push({ kind: 'message', message: asst('m4', 'Z', 'a2', 11) });
  await expectAfter('command stays above turns after a stray tool_pending', ['a1', '//pwd', 'u2', 'a2']);

  // 3. A snapshot that no longer carries the card's anchor places it by time, not at
  // the end.
  await open([user('m1', 'u1', 1), asst('m2', 'X', 'a1', 2)]);
  await runPwd();
  const later = new Date(Date.now() + 60000).toISOString();
  sock.send(JSON.stringify(snap([user('n1', 'u1', 1), asst('n2', 'X', 'a1', 2),
    { ...user('n3', 'u2', 0), ts: later }, { ...asst('n4', 'Z', 'a2', 0), ts: later }])));
  await expectAfter('command with a lost anchor keeps its place by time', ['a1', '//pwd', 'u2', 'a2']);

  assert.deepEqual((await evaluate('window.ccbb.errors || []')).filter(e => !e.startsWith('ResizeObserver loop')), []);
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.terminate();
  if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); process.kill(-child.pid, 'SIGKILL'); await done; }
  for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); server.closeAllConnections(); await new Promise(r => server.close(r));
  fs.rmSync(cfg, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); process.exit(process.exitCode || 0);
});
