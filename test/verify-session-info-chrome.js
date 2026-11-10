'use strict';
// The session info grid behind ⋮ and the status line, in all four session views: ccbb
// web's terminal and mux views, and the phone's session and mux panels. Local fixture
// only. CHROME=/path/to/chrome node test/verify-session-info-chrome.js [shotDir]
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-si-chrome-'));
process.env.CLAUDE_CONFIG_DIR = cfg; process.env.CCBB_HOME = cfg;
const { appPageHtml } = require('../ccbb-web');
const { mobilePageHtml } = require('../ccbb-mobile');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to a Chromium executable');
const shots = process.argv[2] || null;
const vendor = process.env.CCBB_TEST_VENDOR || path.join(os.homedir(), '.claude', 'ccbb-vendor');
const assets = { 'marked.js': 'marked-12.js', 'xterm.js': 'xterm-5.5.0.js', 'xterm.css': 'xterm-5.5.0.css' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, n = 100) { for (let i = 0; i < n; i++) { if (await fn()) return; await sleep(50); } throw new Error('Timed out: ' + label); }

let ago = 60e3;   // how long since the last response, for warm/cold
const stats = () => ({
  cost: 12.345, turns: 7, subTurns: 2, totalTokens: 1.5e6, cacheTtl: 300,
  lastAssistantAt: new Date(Date.now() - ago).toISOString(),
  startedAt: '2026-11-10T09:00:00Z', lastActivity: new Date(Date.now() - ago).toISOString(),
  categories: { cacheRead: { tokens: 1.2e6, cost: 1.8 }, cacheWrite: { tokens: 2.5e5, cost: 4.7 }, cacheMiss: { tokens: 3e3, cost: 0.05 }, output: { tokens: 4.2e4, cost: 3.1 }, input: { tokens: 900, cost: 0.01 } },
  context: { tokens: 128400, cost: 0.06, costWrite: 0.8, model: 'claude-opus-5', provider: 'anthropic' },
  contextMax: { tokens: 151000 }, providers: [{ provider: 'anthropic', cost: 12.3 }],
  models: [{ model: 'claude-opus-5', cost: 11.1 }, { model: 'claude-haiku-5', cost: 1.2 }], avgResponseMs: 8400, avgOutTps: 55,
});
const proc = { bin: 'claude', via: 'Bedrock', compactAt: 200000, model: null };
const sub = { account: { name: 'me' }, windows: { fiveHour: { pct: 24, resetsAt: new Date(Date.now() + 3 * 3600e3).toISOString() }, sevenDay: { pct: 41, resetsAt: new Date(Date.now() + 4 * 86400e3).toISOString() } }, fetchedAt: Date.now() };
const muxState = () => ({ id: 'mux-1', agent: 'claude', bin: 'claude.dsa', model: 'claude-opus-5', compactAt: 300000,
  permissionMode: 'acceptEdits', title: 'Mux fixture', status: 'idle', live: true, cwd: '/home/u/src/project',
  cost: 12.345, turns: 7, subTurns: 2, contextTokens: 128400, contextPeak: 151000, stats: stats(), capabilities: [] });
const info = () => ({ sessionId: 'native-1', title: 'Native fixture', projectPath: '/home/u/src/project', live: true,
  liveStatus: 'idle', liveStatusAt: new Date(Date.now() - ago).toISOString(), stats: stats(), proc });

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://fixture');
  const json = v => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v)); };
  if (u.pathname.startsWith('/vendor/')) {
    res.setHeader('Content-Type', u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript');
    const f = assets[u.pathname.slice(8)]; return res.end(f ? fs.readFileSync(path.join(vendor, f)) : '');
  }
  if (u.pathname === '/api/subscription') return json(sub);
  if (u.pathname === '/api/session-info/native-1') return json(info());
  if (u.pathname === '/api/session/native-1/stats') return json(Object.assign(stats(), { proc }));
  if (u.pathname === '/api/session/native-1/history') return json({ entries: [], total: 0, from: 0, to: 0 });
  if (u.pathname.startsWith('/api/')) return json({ sessions: [], servers: [], errors: [], peers: [] });
  res.setHeader('Content-Type', 'text/html');
  res.end(u.pathname === '/m' ? mobilePageHtml(null, null, { name: 'fixture' }, {}, false, false) : appPageHtml(null, null, false));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  if (req.url.includes('/mux/mux')) ws.send(JSON.stringify({ op: 'snapshot', seq: 0, epoch: 'f', clients: [{ label: 'web-1', kind: 'web' }], pending: [], messages: [], state: muxState() }));
  else if (req.url.includes('/ws/list')) ws.send(JSON.stringify({ type: 'snapshot', sessions: [] }));
});

let cdp, child;
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + path.join(cfg, 'browser'), 'about:blank'], { stdio: 'ignore', detached: true });
  const devtools = path.join(cfg, 'browser', 'DevToolsActivePort'); await until(() => fs.existsSync(devtools), 'DevTools');
  const port = fs.readFileSync(devtools, 'utf8').split('\n')[0];
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  cdp = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl); await new Promise(r => cdp.once('open', r));
  let id = 0; const pending = new Map(); cdp.on('message', raw => { const m = JSON.parse(raw); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); cdp.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r)); return r.result.result.value; };
  const shot = async name => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64'));
  };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.testErrors=[];addEventListener("error",e=>testErrors.push(e.message));addEventListener("unhandledrejection",e=>testErrors.push(String(e.reason)));' });

  const labels = sel => evaluate(`[...document.querySelectorAll('${sel} .si dt')].map(d=>d.textContent)`);
  for (const mobile of [false, true]) for (const kind of ['native', 'mux']) {
    const name = (mobile ? 'mobile' : 'desktop') + '-' + kind;
    ago = 60e3;
    await send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1280, height: 844, deviceScaleFactor: mobile ? 2 : 1, mobile });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + (mobile ? '/m' : '/') });
    await until(() => evaluate('typeof openSession === "function"'), 'page');
    await evaluate(kind === 'mux' ? (mobile ? 'openMuxSession("mux-1",null)' : 'openSession("mux-1",null,true,"Mux fixture")')
      : (mobile ? 'openSession("native-1",null)' : 'openSession("native-1",null,false,"Native fixture")'));
    const foot = mobile && kind === 'native' ? '.sfoot .tot' : '.sv-foot .sl';
    await until(() => evaluate(`!!document.querySelector('${foot} .sl-ctx') && document.querySelector('${foot}').textContent.includes('5h')`), name + ' footer');
    const text = await evaluate(`document.querySelector('${foot}').textContent`);
    assert.match(text, /\$12\.35/, text);
    assert.match(text, /7\+2/, text);
    assert.match(text, /128K\/151K\/\$0\.06/, text);
    assert.doesNotMatch(text, /ttft|tok\/s|out\/s|controller|\dx\b/, text);
    assert.equal(await evaluate(`!!document.querySelector('${foot} .sl-rs.cold')`), false);

    await evaluate(mobile ? 'document.querySelector(".pdots").click()' : 'document.querySelector(".vb-dots").click()');
    const panel = mobile ? '.panel.menu .subhead' : '.vb-head.open';
    await until(() => evaluate(`!!document.querySelector('${panel} .si dt')`), name + ' grid');
    const got = await labels(panel);
    for (const l of ['Directory', 'Session', 'Binary', 'Model', 'Compact at', 'Status', 'Cost', 'Turns', 'Context', 'Resend', 'Tokens'])
      assert(got.includes(l), name + ' grid lacks ' + l + ': ' + got);
    const grid = await evaluate(`document.querySelector('${panel} .si').textContent`);
    if (kind === 'mux') { assert.match(grid, /claude\.dsa/); assert.match(grid, /300K/); assert.match(grid, /acceptEdits/); }
    else { assert.match(grid, /claude\s*Bedrock/); assert.match(grid, /200K/); assert.match(grid, /64% of 200K/); }
    assert.match(grid, /Opus 5/);
    assert.match(grid, /5h 24% · 7d 41%/);
    // The copy button must not fold the panel it sits in.
    await evaluate(`document.querySelector('${panel} .si-copy').click()`);
    await sleep(100);
    assert(await evaluate(`!!document.querySelector('${panel} .si')`), name + ' copy folded the panel');
    await shot(name + '-light');
    if (mobile) {   // ccbb web has no dark theme
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
      await sleep(100);
      await shot(name + '-dark');
    }
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

    // Past the 5m TTL the resend flips to the cache-write price on the 10s repaint, with
    // nothing arriving: the clock is pushed 400s ahead.
    await evaluate(`(function(){var o=Date.now;Date.now=function(){return o()+400e3;};})()`);
    await until(() => evaluate(`!!document.querySelector('${foot} .sl-rs.cold')`), name + ' cold resend (timer)', 300);
    assert.match(await evaluate(`document.querySelector('${foot}').textContent`), /\$0\.80/);
    assert.deepEqual((await evaluate('testErrors')).filter(e => !e.startsWith('ResizeObserver loop')), []);
    console.log('OK: ' + name + ' grid and footer');
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.terminate();
  if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); process.kill(-child.pid, 'SIGKILL'); await done; }
  for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); server.closeAllConnections(); await new Promise(r => server.close(r));
  fs.rmSync(cfg, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); process.exit(process.exitCode || 0);
});
