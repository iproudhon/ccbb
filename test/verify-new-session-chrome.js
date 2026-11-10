'use strict';
// Local browser fixture for the new-session dialog: field order, model lists per agent,
// Compact at remembered per binary, and the phone sheet with the keyboard up.
// CHROME=/path/to/chrome node test/verify-new-session-chrome.js [shot-dir]
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-newsession-fixture-'));
process.env.CLAUDE_CONFIG_DIR = cfg; process.env.CCBB_HOME = cfg;
const { appPageHtml } = require('../ccbb-web');
const { mobilePageHtml } = require('../ccbb-mobile');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to a Chromium executable');
const shots = process.argv[2];

let posts = [], cdp, child;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, n) { for (let i = 0; i < (n || 100); i++) { if (await fn()) return; await sleep(50); } throw new Error('Timed out: ' + label); }
const BINS = [['claude', 'claude', 300000], ['claude.dsa', 'claude', null], ['codex', 'codex', 1500000]];
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url.replace(/^\/peer\/[^/]+/, ''), 'http://fixture');
  const json = (value, code) => { res.statusCode = code || 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  let body = ''; for await (const chunk of req) body += chunk;
  if (body) posts.push({ path: u.pathname, body: JSON.parse(body) });
  if (u.pathname.startsWith('/vendor/')) { res.setHeader('Content-Type', u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript'); return res.end(''); }
  if (u.pathname === '/api/servers') return json({ servers: [{ name: 'fixture', self: true, status: 'up' }] });
  if (u.pathname === '/mux/api/bins') return json({ bins: BINS.map(([n, a, c]) => ({ name: n, path: '/x/' + n, agent: a, compactAt: c })) });
  if (u.pathname === '/mux/api/models') return json({ models: u.searchParams.get('bin').startsWith('codex')
    ? [{ id: 'gpt-x', name: 'GPT X', isDefault: true }, { id: 'gpt-y', name: 'GPT Y' }]
    : [{ id: 'opus', name: 'Opus' }, { id: 'opus[1m]', name: 'Opus 1M' }, { id: 'sonnet', name: 'Sonnet' }] });
  if (u.pathname === '/mux/api/codex/loaded') return json({ threads: [{ id: 'busy', title: 'Busy one', cwd: '/tmp' }] });
  if (u.pathname === '/mux/api/agent-auth') return json({ bin: u.searchParams.get('bin'), loggedIn: true });
  if (u.pathname === '/api/fs/stat') return json({ path: u.searchParams.get('path'), exists: true, dir: true });
  if (u.pathname === '/mux/api/sessions' && req.method === 'POST') return json({ session: { id: 'new', title: '' } });
  if (u.pathname.startsWith('/api/') || u.pathname.startsWith('/mux/')) return json({ sessions: [], servers: [], errors: [], peers: [] });
  res.setHeader('Content-Type', 'text/html');
  res.end(u.pathname === '/m' ? mobilePageHtml(null, null, { name: 'fixture' }, {}, false, false) : appPageHtml(null, null, false));
});
const wss = new WebSocketServer({ server });
wss.on('connection', ws => ws.send(JSON.stringify({ type: 'snapshot', sessions: [] })));

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  child = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + path.join(cfg, 'browser'), 'about:blank'], { stdio: 'ignore', detached: true });
  const devtools = path.join(cfg, 'browser', 'DevToolsActivePort'); await until(() => fs.existsSync(devtools), 'DevTools');
  const port = fs.readFileSync(devtools, 'utf8').split('\n')[0];
  const tabs = await (await fetch('http://127.0.0.1:' + port + '/json')).json();
  cdp = new WebSocket(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl); await new Promise(r => cdp.once('open', r));
  let id = 0; const pending = new Map(); cdp.on('message', raw => { const m = JSON.parse(raw); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); cdp.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.error || r.result.exceptionDetails) throw new Error(JSON.stringify(r)); return r.result.result.value; };
  const shot = async name => { if (!shots) return; const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64')); };
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.testErrors=[];addEventListener("error",e=>testErrors.push(e.message+" @ "+(e.error&&e.error.stack||"").split("\\n").slice(1,3).join(" ")));addEventListener("unhandledrejection",e=>testErrors.push(String(e.reason)));' });
  for (const mobile of [false, true]) {
    posts = [];
    const tag = mobile ? 'mobile' : 'desktop';
    await send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + (mobile ? '/m' : '/') });
    await until(() => evaluate('!!document.querySelector("[data-menu=fixture]")'), tag + ' chip');
    await evaluate('localStorage.clear(); localStorage.setItem("ccbb.muxBin.fixture", "claude"); localStorage.setItem("ccbb.nsCwd.fixture", "/tmp")');
    const D = 'document.querySelector("dialog.ns-sheet[open]")';
    const open = async () => {
      await evaluate('document.querySelector("[data-menu=fixture]").click()');
      await until(() => evaluate('!!document.querySelector(".ns-menu")'), tag + ' menu');
      await evaluate('[...document.querySelectorAll(".ns-menu button")].find(b => /New session/.test(b.textContent)).click()');
      await until(() => evaluate(`!!${D} && ${D}.querySelectorAll("[name=compact] option").length > 2`), tag + ' dialog');
    };
    await open();

    // Order: title first; nothing typed-into has the focus on a phone (no keyboard).
    const labels = await evaluate(`[...${D}.querySelectorAll(".ns-body > .ns-lbl, .ns-pair .ns-lbl")].map(l => l.textContent)`);
    assert.deepEqual(labels, ['Title', 'Binary', 'Directory', 'Model', 'Compact at']);
    if (mobile) assert.equal(await evaluate('document.activeElement.tagName'), 'H3');
    else assert.equal(await evaluate('document.activeElement.name'), 'title');

    // Claude: aliases with Default chosen; Compact at is claude's remembered 300K.
    await until(() => evaluate(`[...${D}.querySelectorAll("[name=model] option")].some(o => o.value === "opus[1m]")`), tag + ' claude models');
    assert.equal(await evaluate(`${D}.querySelector("[name=model]").value`), '');
    assert.equal(await evaluate(`${D}.querySelector("[name=compact]").value`), '300000');
    assert.deepEqual(await evaluate(`[...${D}.querySelectorAll("[name=compact] option")].map(o => o.textContent)`), ['Default', '100K', '200K', '300K', '500K', '800K', 'Other…']);
    await shot(tag + '-new');

    // claude.dsa: nothing remembered → Default. Codex: its own list (default named), 1.5M.
    const pick = async n => { await evaluate(`[...${D}.querySelectorAll(".ns-bin")].find(b => b.textContent === "${n}").click()`); await sleep(300); };
    await pick('claude.dsa');
    assert.equal(await evaluate(`${D}.querySelector("[name=compact]").value`), '');
    await pick('codex');
    await until(() => evaluate(`[...${D}.querySelectorAll("[name=model] option")].some(o => o.value === "gpt-y")`), tag + ' codex models');
    assert.equal(await evaluate(`${D}.querySelector("[name=model] option").textContent`), 'Default (GPT X)');
    assert.equal(await evaluate(`${D}.querySelector("[name=compact]").value`), '1500000');
    assert.equal(await evaluate(`${D}.querySelector("[name=compact]").selectedOptions[0].textContent`), '1.5M');

    // A loaded Codex thread keeps its own settings: both selects switch off.
    await evaluate(`(()=>{var r=${D}.querySelector("[name=resume]");r.value="busy";r.dispatchEvent(new Event("input"));})()`);
    await until(() => evaluate(`${D}.querySelector("[name=compact]").disabled`), tag + ' loaded thread');
    assert.match(await evaluate(`${D}.querySelector("[data-r=setmsg]").textContent`), /Already loaded/);
    await evaluate(`(()=>{var r=${D}.querySelector("[name=resume]");r.value="";r.dispatchEvent(new Event("input"));})()`);

    // Other… reveals a field; the typed value is sent.
    await evaluate(`(()=>{var s=${D}.querySelector("[name=compact]");s.value="\\u0000other";s.dispatchEvent(new Event("change"));})()`);
    assert.equal(await evaluate(`${D}.querySelector("[name=compactOther]").hidden`), false);
    await evaluate(`(()=>{${D}.querySelector("[name=compactOther]").value="600k";${D}.querySelector("[name=model]").value="gpt-y";${D}.querySelector("[name=title]").value="T";${D}.querySelector("form").requestSubmit();})()`);
    await until(() => posts.some(p => p.path === '/mux/api/sessions'), tag + ' create');
    const sent = posts.find(p => p.path === '/mux/api/sessions').body;
    assert.deepEqual({ bin: sent.bin, model: sent.model, compactAt: sent.compactAt, name: sent.name }, { bin: 'codex', model: 'gpt-y', compactAt: '600k', name: 'T' });

    // Default sends 'default' (clears what the dialog offers next time).
    posts = [];
    await open();
    await evaluate(`(()=>{${D}.querySelector("[name=compact]").value="";${D}.querySelector("form").requestSubmit();})()`);
    await until(() => posts.some(p => p.path === '/mux/api/sessions'), tag + ' create default');
    assert.equal(posts.find(p => p.path === '/mux/api/sessions').body.compactAt, 'default');
    assert.equal(posts.find(p => p.path === '/mux/api/sessions').body.model, undefined);

    // Restart (▶): the same Model and Compact at, resolved for the caller to send.
    await evaluate('window.picked = undefined; pickBinary({ server: "fixture", base: "", agent: "codex", title: "Old one" }).then(v => { window.picked = v; }); 0');
    await until(() => evaluate(`!!${D} && ${D}.querySelector("[name=compact]").value === "1500000"`), tag + ' restart dialog');
    await until(() => evaluate(`[...${D}.querySelectorAll("[name=model] option")].some(o => o.value === "gpt-y")`), tag + ' restart models');
    assert.match(await evaluate(`${D}.querySelector("[data-r=compact]").textContent`), /compacts on the next turn/);
    await shot(tag + '-restart');
    await evaluate(`(()=>{${D}.querySelector("[name=model]").value="gpt-y";var c=${D}.querySelector("[name=compact]");c.value="500000";c.dispatchEvent(new Event("change"));${D}.querySelector("form").requestSubmit();})()`);
    await until(() => evaluate('window.picked !== undefined'), tag + ' restart picked');
    assert.deepEqual(await evaluate('window.picked'), { bin: 'codex', model: 'gpt-y', compactAt: '500000' });

    if (mobile) {
      // Keyboard up: the visual viewport shrinks to 400px and pans by 120. The sheet sits
      // at its top, fits inside it, and the Start button stays on screen.
      await open();
      await evaluate(`(()=>{var d=${D};d.style.setProperty("--vh","400px");d.style.setProperty("--vtop","120px");})()`);
      const box = await evaluate(`(()=>{var r=${D}.getBoundingClientRect(),b=${D}.querySelector("[type=submit]").getBoundingClientRect();return {top:r.top,bottom:r.bottom,btn:b.bottom,w:r.width,scroll:getComputedStyle(${D}.querySelector(".ns-body")).overflowY};})()`);
      assert.equal(box.top, 120); assert(box.bottom <= 520.5, JSON.stringify(box)); assert(box.btn <= 520.5, JSON.stringify(box));
      assert.equal(box.w, 390); assert.equal(box.scroll, 'auto');
      await shot(tag + '-keyboard');
      // A tap outside (on the backdrop) does not close it on a phone.
      await evaluate(`${D}.dispatchEvent(new MouseEvent("click",{bubbles:true}))`);
      assert.equal(await evaluate(`!!${D}`), true);
      assert.equal(await evaluate(`getComputedStyle(${D}.querySelector("[name=model]")).fontSize`), '16px');
      await evaluate(`${D}.close()`);
    }
    assert.deepEqual((await evaluate('testErrors')).filter(e => !e.startsWith('ResizeObserver loop') && !/reading 'all'/.test(e)), []);
    console.log('OK: ' + tag + ' new-session dialog');
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.terminate();
  if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); process.kill(-child.pid, 'SIGKILL'); await done; }
  for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); server.closeAllConnections(); await new Promise(r => server.close(r));
  fs.rmSync(cfg, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); process.exit(process.exitCode || 0);
});
