'use strict';
// CHROME=/path/to/chrome node test/verify-mobile-term.js
// Real DOM and xterm, local protocol fixture, simulated visual viewport changes.
// Software-keyboard rendering and native focus zoom still need a physical phone.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
require('../ccbb-web'); // supplies the shared page assets to mobile
const { mobilePageHtml } = require('../ccbb-mobile');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to a Chromium executable');
const vendor = process.env.CCBB_TEST_VENDOR || path.join(os.homedir(), '.claude', 'ccbb-vendor');
const assets = { 'marked.js': 'marked-12.js', 'xterm.js': 'xterm-5.5.0.js', 'xterm.css': 'xterm-5.5.0.css' };
for (const file of Object.values(assets)) assert(fs.existsSync(path.join(vendor, file)), 'Missing cached vendor asset: ' + file);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, message) {
  for (let n = 0; n < 100; n++) { if (await fn()) return; await sleep(50); }
  throw new Error('Timed out: ' + message);
}
const opened = [], inputs = [], sizes = [], closed = [], muxSockets = new Set();
let pinned = false, openDelay = 0, seq = 0, busy = false, cdp, child;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-term-browser-'));
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://fixture');
  const json = value => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  if (u.pathname.startsWith('/vendor/')) {
    const file = assets[u.pathname.slice(8)];
    res.setHeader('Content-Type', u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript');
    return res.end(file ? fs.readFileSync(path.join(vendor, file)) : '');
  }
  if (u.pathname === '/api/term/open') {
    let data = ''; for await (const chunk of req) data += chunk;
    const request = JSON.parse(data); opened.push(request);
    const result = { id: 'term-' + opened.length, cols: pinned ? 80 : request.cols,
      rows: pinned ? 40 : request.rows, pinned, where: pinned ? 'pane' : 'shell' };
    await sleep(openDelay); return json(result);
  }
  if (/\/api\/term\/.*\/close$/.test(u.pathname)) { closed.push(u.pathname); return json({}); }
  if (u.pathname.startsWith('/api/')) return json({ sessions: [], servers: [], errors: [], peers: [] });
  res.setHeader('Content-Type', 'text/html');
  res.end(mobilePageHtml(null, null, { name: 'fixture' }, {}, false, false));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  if (req.url.includes('/ws-term/')) {
    ws.on('message', raw => {
      const m = JSON.parse(raw);
      if (m.type === 'in') inputs.push(Buffer.from(m.b, 'base64').toString());
      if (m.type === 'size') sizes.push(m);
      if (m.type === 'close') closed.push(req.url);
    });
  } else if (req.url.includes('/mux/mux?')) {
    muxSockets.add(ws); ws.on('close', () => muxSockets.delete(ws));
    ws.send(JSON.stringify({ op: 'snapshot', seq, epoch: 'test', messages: [], pending: [],
      state: { id: 'fixture', agent: 'claude', title: 'Fixture', status: busy ? 'busy' : 'idle',
        activity: busy ? 'requesting' : null, turnStartedAt: Date.now(), cwd: '/tmp' } }));
  } else ws.send(JSON.stringify({ type: 'snapshot', sessions: [] }));
});
function status(value) {
  busy = value === 'busy';
  for (const ws of muxSockets) ws.send(JSON.stringify({ op: 'event', seq: ++seq, kind: 'status',
    status: value, activity: busy ? 'requesting' : null, turnStartedAt: Date.now() }));
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore', detached: true });
  await until(() => fs.existsSync(path.join(profile, 'DevToolsActivePort')), 'Chrome startup');
  const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  cdp = new WebSocket(tabs[0].webSocketDebuggerUrl);
  await new Promise(r => cdp.once('open', r));
  let id = 0; const pending = new Map();
  cdp.on('message', raw => { const m = JSON.parse(raw); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => {
    const n = ++id; pending.set(n, r); cdp.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r));
    return r.result.result.value;
  };
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.testErrors=[];
    addEventListener('error', e=>testErrors.push(e.message));
    addEventListener('unhandledrejection', e=>testErrors.push(String(e.reason)));
    window.testViewport = new EventTarget();
    Object.assign(testViewport, {height:844,offsetTop:0,scale:1});
    Object.defineProperty(window,'visualViewport',{value:testViewport});
    window.resizeViewport = (height,offsetTop=0,scale=1,event='resize') => {
      Object.assign(testViewport,{height,offsetTop,scale});testViewport.dispatchEvent(new Event(event));
    };
  ` });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
  await until(() => evaluate('typeof openTerminal === "function" && typeof openMuxSession === "function"'), 'mobile page');
  await evaluate('openMuxSession("fixture",null)');
  await until(() => evaluate('!!document.querySelector(".muxv .input-box")'), 'mux composer');
  for (const max of [false, true]) {
    await evaluate('document.querySelector(".muxv").classList.toggle("input-max",' + max + ')');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".muxv .input-box")).fontSize'), '16px');
  }
  await evaluate('document.querySelector(".muxv").classList.remove("input-max")');
  for (let n = 0; n < 3; n++) {
    status('busy');
    await until(() => evaluate('!document.querySelector(".mx-busy").hidden'), 'busy row');
    const frames = new Set();
    for (let k = 0; k < 8; k++) {
      frames.add(await evaluate('document.querySelector(".mx-spin").textContent')); await sleep(125);
    }
    assert(frames.size > 1, 'spinner animates on every turn');
    assert([...frames].every(f => f.endsWith('\uFE0E')), 'all frames request text presentation');
    status('idle');
    await until(() => evaluate('document.querySelector(".mx-busy").hidden'), 'idle row');
  }
  status('busy'); await sleep(100);
  for (const ws of muxSockets) ws.close();
  await until(() => evaluate('document.querySelector(".mx-busy").hidden'), 'disconnect stops spinner');
  await until(() => evaluate('!document.querySelector(".mx-busy").hidden'), 'reattach while busy');
  status('idle');
  console.log('OK: 16px normal/maximized composer, three animated turns, disconnect and busy reattach');

  async function fitCheck(height, offset = 0) {
    await evaluate(`resizeViewport(${height},${offset})`); await sleep(650);
    const r = await evaluate(`(()=>{const w=document.getElementById('termwrap').getBoundingClientRect(),
      k=document.querySelector('.tkeys').getBoundingClientRect(),b=document.querySelector('.tbody').getBoundingClientRect(),
      s=document.querySelector('.xterm-screen').getBoundingClientRect();
      return {top:w.top,height:w.height,bottom:k.bottom,screen:s.height,body:b.height,cols:termState.cols,rows:termState.rows};})()`);
    assert.equal(r.top, offset); assert.equal(r.height, height);
    assert(Math.abs(r.bottom - (offset + height)) < 2, 'keys above keyboard');
    assert(r.screen <= r.body, 'terminal content fits visible body');
    return r;
  }
  for (pinned of [false, true]) {
    await evaluate('resizeViewport(430,36);void openTerminal(null,null)');
    await until(() => evaluate('!!termState?.id && !!document.querySelector(".xterm-screen")'), 'terminal open');
    const up = await fitCheck(430, 36);
    const down = await fitCheck(844);
    if (pinned) { assert.equal(up.rows, 40); assert.equal(down.rows, 40); }
    else assert(up.rows < down.rows, 'free terminal rows follow keyboard');
    for (let n = 0; n < 2; n++) { await fitCheck(430, 36); await fitCheck(844); }
    const beforeSizes = sizes.length;
    await fitCheck(430, 36);
    if (pinned) assert.equal(sizes.length, beforeSizes, 'pinned terminal sends no resize');
    await evaluate('resizeViewport(220,90,2)'); await sleep(150);
    assert.equal(await evaluate('document.getElementById("termwrap").style.height'), '430px', 'pinch zoom does not resize terminal');
    await fitCheck(430, 60);
    await evaluate('resizeViewport(430,75,1,"scroll")'); await sleep(200);
    assert.equal(await evaluate('document.getElementById("termwrap").style.top'), '75px', 'viewport scroll follows offset');
    await evaluate('termState.term.focus();termState.term.write("\\x1b[?1h")'); await sleep(100);
    const count = inputs.length;
    await evaluate(`document.querySelector('[data-k="up"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0}));
      document.querySelector('[data-k="up"]').dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));`);
    await until(() => inputs.length > count, 'extra arrow');
    assert.equal(inputs.length, count + 1, 'pointer sends exactly once');
    assert.equal(inputs.at(-1), '\x1bOA', 'application cursor arrow');
    assert(await evaluate('document.activeElement.classList.contains("xterm-helper-textarea")'), 'extra keys keep input focus');
    await evaluate('termState.term.write("\\x1b[?1l")'); await sleep(100);
    const normalCount = inputs.length;
    await evaluate(`document.querySelector('[data-k="down"]').click()`);
    await until(() => inputs.length > normalCount, 'normal arrow');
    assert.equal(inputs.at(-1), '\x1b[B', 'normal cursor arrow');
    const ctrlCount = inputs.length;
    await evaluate(`document.querySelector('[data-k="ctrl"]').click();document.querySelector('[data-k="ctrlc"]').click()`);
    await until(() => inputs.length > ctrlCount, 'Ctrl-C');
    assert.equal(inputs.at(-1), '\x03');
    assert.equal(await evaluate('termState.ctrl'), false, 'extra keys consume sticky Ctrl');
    const beforeSelection = sizes.length;
    await evaluate(`document.querySelector('[data-k="sel"]').click();resizeViewport(500,30)`);
    await sleep(250);
    assert.equal(sizes.length, beforeSelection, 'hidden terminal does not resize during selection');
    await evaluate(`document.querySelector('[data-k="sel"]').click()`);
    await fitCheck(500, 30);
    await send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true });
    await fitCheck(390);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await fitCheck(844);
    await evaluate('termState.destroy();resizeViewport(844)');
    assert.equal(await evaluate('document.getElementById("termwrap").style.height'), '', 'close unpins viewport');
  }
  console.log('OK: free/pinned terminal fit, keyboard cycles, viewport offsets, pinch zoom, extra-key focus and arrows');

  // Interleave a resize with the font search on initial open; request must use
  // the settled visible grid, not the old callback's default 80x24 geometry.
  pinned = false;
  await evaluate(`resizeViewport(844);void openTerminal(null,null);
    setTimeout(()=>resizeViewport(360,20),5);setTimeout(()=>resizeViewport(430,36),35);`);
  await until(() => evaluate('!!termState?.id'), 'open during resize'); await sleep(650);
  assert.equal(opened.at(-1).rows, await evaluate('termState.rows'), 'initial open uses settled rows');
  await evaluate('termState.destroy()');
  openDelay = 200;
  const previous = opened.length;
  await evaluate('void openTerminal(null,null)');
  await until(() => opened.length > previous, 'pending open request');
  await evaluate('termState.destroy()');
  await until(() => closed.includes('/api/term/term-' + opened.length + '/close'), 'late open cleaned up');
  await sleep(200);
  assert.deepEqual((await evaluate('testErrors')).filter(e => !e.startsWith('ResizeObserver loop')), []);
  console.log('OK: resize during initial open, close during open, no browser errors');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.terminate();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(r => child.once('exit', r));
    process.kill(-child.pid, 'SIGKILL');
    await exited;
  }
  for (const ws of wss.clients) ws.terminate();
  await new Promise(r => wss.close(r));
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // All owned browser, socket and server resources are closed. Like verify-web,
  // exit explicitly so inherited launcher pipes cannot keep the driver alive.
  process.exit(process.exitCode || 0);
});
