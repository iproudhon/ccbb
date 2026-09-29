'use strict';
// Block order in ccbb web's transcript view (desktop and phone). One API message is
// written as several JSONL lines sharing message.id — thinking, tool_use, thinking,
// text — and each block must render where its line is, in file order, both from
// history and from the live tail.
// CHROME=/path/to/chrome node test/verify-thinking.js
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), net = require('net');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to a Chromium executable');
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-thinking-fixture-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch {} await sleep(100); } throw new Error('Timed out: ' + label); }
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

const SID = '11111111-2222-4333-8444-555555555555';
const file = path.join(cfg, 'projects', '-tmp', SID + '.jsonl');
let n = 0;
const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, ++n)).toISOString();
const base = () => ({ sessionId: SID, cwd: '/tmp', timestamp: ts(), uuid: 'u-' + n + '-' + Math.random().toString(16).slice(2) });
const userLine = text => ({ type: 'user', ...base(), message: { role: 'user', content: text } });
const asstLine = (id, block) => ({ type: 'assistant', ...base(), message: { id, role: 'assistant', model: 'claude-opus-5',
  content: [block], stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
const toolResult = id => ({ type: 'user', ...base(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const think = t => ({ type: 'thinking', thinking: t, signature: 'sig' });
const text = t => ({ type: 'text', text: t });
const tool = id => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'echo ' + id } });
const write = lines => fs.appendFileSync(file, lines.map(l => JSON.stringify(l) + '\n').join(''));

let cdp, browser, web;
(async () => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const vendor = process.env.CCBB_TEST_VENDOR || path.join(os.homedir(), '.claude', 'ccbb-vendor');
  fs.cpSync(vendor, path.join(cfg, 'ccbb-vendor'), { recursive: true });
  // Real shape: several thinking blocks in one API message, one line each, and an
  // empty signature-only thinking line.
  write([userLine('go'), asstLine('msg_A', think('TH1')), asstLine('msg_A', tool('t1')), toolResult('t1'),
    asstLine('msg_A', think('')), asstLine('msg_A', think('TH2')), asstLine('msg_A', text('TX1'))]);
  const port = await freePort();
  web = spawn(process.execPath, [path.join(__dirname, '..', 'ccbb.js'), 'web', '-p', String(port)],
    { env: { ...process.env, CLAUDE_CONFIG_DIR: cfg, CCBB_HOME: cfg }, stdio: 'ignore', detached: true });
  await until(async () => (await fetch('http://127.0.0.1:' + port + '/')).ok, 'ccbb web');

  browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + path.join(cfg, 'browser'), 'about:blank'], { stdio: 'ignore', detached: true });
  const devtools = path.join(cfg, 'browser', 'DevToolsActivePort'); await until(() => fs.existsSync(devtools), 'DevTools');
  const cport = fs.readFileSync(devtools, 'utf8').split('\n')[0];
  const tabs = await (await fetch('http://127.0.0.1:' + cport + '/json')).json();
  cdp = new WebSocket(tabs[0].webSocketDebuggerUrl); await new Promise(r => cdp.once('open', r));
  let id = 0; const pending = new Map(); cdp.on('message', raw => { const m = JSON.parse(raw); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const k = ++id; pending.set(k, r); cdp.send(JSON.stringify({ id: k, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r)); return r.result.result.value; };
  await send('Page.enable');
  // The desktop page loads marked from a CDN; offline, a pass-through keeps text visible.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.marked = { parse: function (s) { return s; } };' });

  // Thinking cards, message bodies and tool cards in document order, as short tags.
  const order = () => evaluate(`[].slice.call(document.querySelectorAll('.think-card, .msg, .tool-card')).filter(function(n){
      return !n.parentElement.closest('.think-card, .msg, .tool-card'); }).map(function(n){
    if (n.classList.contains('think-card')) return 'T:' + (n.querySelector('.think-body')||{}).textContent;
    if (n.classList.contains('tool-card')) return 'tool';
    return 'M:' + ((n.querySelector('.msg-body')||{}).textContent||'').trim(); })`);
  const expect = async (label, want) => {
    await until(async () => JSON.stringify(await order()) === JSON.stringify(want), label)
      .catch(async e => { throw new Error(e.message + ': ' + JSON.stringify(await order())); });
    console.log('OK: ' + label);
  };
  const fromFile = ['M:go', 'T:TH1', 'tool', 'T:TH2', 'M:TX1'];

  for (const mobile of [false, true]) {
    await send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + port + (mobile ? '/m' : '/') });
    await until(() => evaluate('typeof openSession === "function"'), 'page');
    await evaluate('openSession(' + JSON.stringify(SID) + ', null, false, "fixture")');
    const prefix = mobile ? 'mobile' : 'desktop';
    const soFar = mobile ? all : fromFile;
    await expect(prefix + ': history keeps each block at its own line', soFar);
    if (!mobile) {
      write([userLine('again'), asstLine('msg_B', think('TH3')), asstLine('msg_B', text('TX2')),
        asstLine('msg_B', think('TH4')), asstLine('msg_B', text('TX3'))]);
      all = [...fromFile, 'M:again', 'T:TH3', 'M:TX2', 'T:TH4', 'M:TX3'];
      await expect(prefix + ': live tail keeps each block at its own line', all);
    }
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.terminate();
  for (const k of [browser, web]) if (k && k.exitCode === null) { const done = new Promise(r => k.once('exit', r)); try { process.kill(-k.pid, 'SIGKILL'); } catch {} await done; }
  fs.rmSync(cfg, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); process.exit(process.exitCode || 0);
});
let all = null;
