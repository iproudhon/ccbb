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
const embedded = process.env.CCBB_TEST_EMBEDDED === '1';
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
  if (u.pathname === '/embed') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><iframe id="frame" src="/" style="position:fixed;inset:0;width:100%;height:100%;border:0"></iframe>');
  }
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
  cdp = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => cdp.once('open', r));
  let id = 0; const pending = new Map();
  cdp.on('message', raw => { const m = JSON.parse(raw); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => {
    const n = ++id; pending.set(n, r); cdp.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async expression => {
    if (embedded) expression = `document.getElementById('frame')?.contentWindow.eval(${JSON.stringify(expression)})`;
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r));
    return r.result.result.value;
  };
  await send('Page.enable');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.testErrors=[];
    addEventListener('error', e=>testErrors.push(e.message));
    addEventListener('unhandledrejection', e=>testErrors.push(String(e.reason)));
    window.testViewport = new EventTarget();
    Object.assign(testViewport, {width:390,height:844,offsetTop:0,scale:1});
    Object.defineProperty(window,'visualViewport',{value:testViewport});
    window.resizeViewport = (height,offsetTop=0,scale=1,event='resize') => {
      Object.assign(top.testViewport,{height,offsetTop,scale});top.testViewport.dispatchEvent(new top.Event(event));
    };
  ` });
  await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + (embedded ? '/embed' : '/') });
  await until(() => evaluate('typeof openTerminal === "function" && typeof openMuxSession === "function"'), 'mobile page');
  if (embedded) assert.equal(await evaluate('viewportFrames.length'), 1, 'uses host viewport inside iframe');
  await evaluate('openMuxSession("fixture",null)');
  await until(() => evaluate('!!document.querySelector(".muxv .input-box")'), 'mux composer');
  for (const max of [false, true]) {
    await evaluate('document.querySelector(".muxv").classList.toggle("input-max",' + max + ')');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".muxv .input-box")).fontSize'), '16px');
  }
  await evaluate('document.querySelector(".muxv").classList.remove("input-max")');
  // Home-screen insets stay nonzero on some iPhones with the keyboard open.
  await evaluate(`document.documentElement.style.setProperty('--safe-b','34px');
    document.documentElement.style.setProperty('--safe-t','47px')`);
  async function sessionFit(selector, footer) {
    await until(() => evaluate(`document.querySelector('${selector}').isContentEditable`), 'editable composer');
    await sleep(100);
    await evaluate(`document.querySelector('${selector}').focus();resizeViewport(430,36)`);
    assert(await evaluate(`document.activeElement === document.querySelector('${selector}')`), 'composer focused');
    const geometry = await evaluate(`(()=>{const b=document.getElementById("stack").getBoundingClientRect();
      const c=document.querySelector('${selector}').closest('.input-area,.composer').getBoundingClientRect();
      return {top:b.top,height:b.height,bottom:c.bottom,footer:getComputedStyle(document.querySelector('${footer}')).display};})()`);
    if (embedded) assert.equal(await evaluate('window.visualViewport.height'), 844, 'iframe viewport never shrinks');
    assert.equal(geometry.top, 36, 'session follows Safari focus pan');
    assert.equal(geometry.height, 430, 'session shrinks to visible viewport');
    const root = await evaluate(`({position:getComputedStyle(document.body).position,
      top:document.body.getBoundingClientRect().top,height:document.body.getBoundingClientRect().height})`);
    assert.equal(root.position, 'static', 'focus scrolling does not move a fixed document root');
    assert.equal(root.top, 0, 'document root stays at the layout origin');
    assert.equal(root.height, 844, 'document root keeps its layout height');
    assert(Math.abs(geometry.bottom - 466) < 2, 'composer directly above keyboard');
    assert.equal(geometry.footer, 'none', 'footer is out of visible keyboard area');
    if (embedded) {
      // iPhone capture: host scrollY=396, vv=397@396, fixed frame rect=-396..397.
      // Safari has scrolled the fixed iframe's rect; its layout top is still zero.
      await evaluate(`var frame = window.frameElement;
        frame.style.height='793px';
        frame.getBoundingClientRect=()=>({top:-396,bottom:397,left:0,right:390,width:390,height:793});
        Object.defineProperty(top,'scrollY',{configurable:true,value:396});
        resizeViewport(397,396)`);
      const shifted = await evaluate(`(()=>{const r=document.getElementById('stack').getBoundingClientRect();
        const c=document.querySelector('${selector}').closest('.input-area,.composer').getBoundingClientRect();
        return {top:r.top,height:r.height,screenTop:r.top-396,composerBottom:c.bottom-396};})()`);
      assert.equal(shifted.height, 397, 'focus scroll must not collapse the session to 1px');
      assert.equal(shifted.screenTop, 0, 'session fills the visible screen without dragging');
      assert(Math.abs(shifted.composerBottom-397)<2, 'composer remains at keyboard edge after host scroll');
      await evaluate(`delete frame.getBoundingClientRect;delete top.scrollY;resizeViewport(397,0)`);
      assert.equal(await evaluate('document.getElementById("stack").getBoundingClientRect().top'), 0, 'drag recovery keeps correct origin');
      await evaluate(`frame.style.height='100%';resizeViewport(430,36)`);
    }
    // Values can change without a viewport event; focus polling must still resize.
    await evaluate('top.testViewport.height=400;top.testViewport.offsetTop=50');
    await until(() => evaluate('document.getElementById("stack").getBoundingClientRect().bottom === 450'), 'viewport polling');
    await evaluate(`document.querySelector('${selector}').blur()`);
    assert(await evaluate('document.body.classList.contains("kb")'), 'blur alone does not restore footer');
    await evaluate('resizeViewport(844)');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("stack")).paddingBottom'), '34px');
    if (!await evaluate('document.querySelector(".muxv.input-max") !== null || document.body.classList.contains("comp-max")'))
      assert.notEqual(await evaluate(`getComputedStyle(document.querySelector('${footer}')).display`), 'none');
  }
  await sessionFit('.muxv .input-box', '.muxv .sv-foot');
  await evaluate('document.querySelector(".muxv").classList.add("input-max")');
  await sessionFit('.muxv .input-box', '.muxv .sv-foot');
  await evaluate('document.querySelector(".muxv").classList.remove("input-max")');
  console.log('OK: session keyboard geometry, focus pan, safe areas, missing events and blur');
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

  await evaluate('openSession("native-fixture",null)');
  await until(() => evaluate('!!document.querySelector(".cbox")'), 'native session');
  await evaluate('document.querySelector(".sfoot").classList.remove("empty")');
  await sessionFit('.cbox', '.sfoot');
  await evaluate('document.querySelector("[data-c=cmax]").click()');
  await sessionFit('.cbox', '.sfoot');
  await evaluate('document.querySelector("[data-c=cmax]").click()');
  console.log('OK: native and maximized session keyboard geometry');

  async function fitCheck(height, offset = 0) {
    await evaluate(`resizeViewport(${height},${offset})`); await sleep(650);
    const r = await evaluate(`(()=>{const w=document.getElementById('termwrap').getBoundingClientRect(),
      k=document.querySelector('.tkeys').getBoundingClientRect(),b=document.querySelector('.tbody').getBoundingClientRect(),
      s=document.querySelector('.xterm-screen').getBoundingClientRect();
      return {top:w.top,height:w.height,bottom:k.bottom,screen:s.height,body:b.height,cols:termState.cols,rows:termState.rows};})()`);
    assert.equal(r.top, offset); assert.equal(r.height, height);
    const inset = await evaluate('document.body.classList.contains("kb") ? 0 : 34');
    assert(Math.abs(r.bottom - (offset + height - inset)) < 2, 'keys above keyboard or home inset');
    assert(r.screen <= r.body, 'terminal content fits visible body');
    return r;
  }
  for (pinned of [false, true]) {
    await evaluate('resizeViewport(430,36);void openTerminal(null,null)');
    await until(() => evaluate('!!termState?.id && !!document.querySelector(".xterm-screen")'), 'terminal open');
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".xterm-helper-textarea")).fontSize'), '16px', 'terminal input prevents focus zoom');
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
    const font = () => evaluate('termState.term.options.fontSize');
    const narrow = await font();
    // Split View / Stage Manager: only the width changes, and the font must follow it.
    await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 844, deviceScaleFactor: 1, mobile: true });
    await sleep(650);
    assert(await font() > narrow, 'width-only grow refits font');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await fitCheck(844);
    assert.equal(await font(), narrow, 'width-only shrink refits font');
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
