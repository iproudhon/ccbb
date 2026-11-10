'use strict';
// Local browser fixture for the server chip's login badges, its Logins dialog and the
// new-session title. No real binaries or accounts: every API answer is canned here.
// CHROME=/path/to/chrome node test/verify-agent-auth-chrome.js [shot-dir]
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-auth-fixture-'));
process.env.CLAUDE_CONFIG_DIR = cfg; process.env.CCBB_HOME = cfg;
const { appPageHtml } = require('../ccbb-web');
const { mobilePageHtml } = require('../ccbb-mobile');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to a Chromium executable');
const shots = process.argv[2];

const status = {
  claude: { bin: 'claude', agent: 'claude', loggedIn: true, method: 'claude.ai', provider: 'firstParty', email: 'me@example.com', tier: 'max' },
  'claude.aws': { bin: 'claude.aws', agent: 'claude', loggedIn: true, method: 'third_party', provider: 'bedrock' },
  codex: { bin: 'codex', agent: 'codex', loggedIn: false, method: '' },
  'sso-hlp.js': { bin: 'sso-hlp.js', agent: 'aws', loggedIn: true, method: 'sso', profile: 'dsa', detail: 'live SSO check passed' },
};
let posts = [], loginStarted = false, cdp, child;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, n) { for (let i = 0; i < (n || 100); i++) { if (await fn()) return; await sleep(50); } throw new Error('Timed out: ' + label); }
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url.replace(/^\/peer\/[^/]+/, ''), 'http://fixture');
  const json = (value, code) => { res.statusCode = code || 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
  let body = ''; for await (const chunk of req) body += chunk;
  if (body) posts.push({ path: u.pathname, method: req.method, body: JSON.parse(body) });
  if (u.pathname.startsWith('/vendor/')) { res.setHeader('Content-Type', u.pathname.endsWith('.css') ? 'text/css' : 'application/javascript'); return res.end(''); }
  if (u.pathname === '/api/servers') return json({ servers: [{ name: 'fixture', self: true, status: 'up' }] });
  if (u.pathname === '/mux/api/bins') return json({ bins: ['claude', 'claude.aws', 'codex'].map(n => ({ name: n, path: '/x/' + n, agent: n.startsWith('codex') ? 'codex' : 'claude' })) });
  if (u.pathname === '/mux/api/agent-auth') return json(status[u.searchParams.get('bin')] || { error: 'not found' }, status[u.searchParams.get('bin')] ? 200 : 400);
  if (u.pathname === '/mux/api/agent-auth/login' && req.method === 'GET') {
    return json({ login: loginStarted === u.searchParams.get('bin') ? { bin: loginStarted, agent: 'codex', state: 'done', url: 'https://auth.example/codex/device', userCode: 'AB12-CD34', needsCode: false } : null });
  }
  if (u.pathname === '/mux/api/agent-auth/login' && req.method === 'POST') {
    loginStarted = JSON.parse(body).bin;
    return json({ login: { bin: loginStarted, agent: 'codex', state: 'waiting', url: 'https://auth.example/codex/device', userCode: 'AB12-CD34', needsCode: false } });
  }
  if (u.pathname === '/mux/api/sessions' && req.method === 'POST') return json({ session: { id: 'new', title: body.name || '' } });
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
  // DARK=1: the same run in the dark theme (for screenshots).
  if (process.env.DARK) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.testErrors=[];addEventListener("error",e=>testErrors.push(e.message+" @ "+(e.error&&e.error.stack||"").split("\\n").slice(1,3).join(" ")));addEventListener("unhandledrejection",e=>testErrors.push(String(e.reason)));' });
  for (const mobile of [false, true]) {
    posts = [];
    const tag = mobile ? 'mobile' : 'desktop';
    await send('Emulation.setDeviceMetricsOverride', { width: mobile ? 390 : 1280, height: 844, deviceScaleFactor: 1, mobile });
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port + (mobile ? '/m' : '/') });
    await evaluate('localStorage.clear()');
    await send('Page.reload');
    await until(() => evaluate('!!document.querySelector("[data-menu=fixture]")'), tag + ' chip');
    assert.equal(await evaluate('document.querySelectorAll(".ns-auth, .ns-au").length'), 0, 'no login badges on the chip');
    const icon = a => `document.querySelector(".ns-menu .ns-mrow [data-k=auth-${a}]")`;
    const openMenu = async () => {
      await evaluate('document.querySelector(".ns-menu") && document.querySelector(".ns-menu")._close()');
      await evaluate('document.querySelector("[data-menu=fixture]").click()');
      await until(() => evaluate('!!document.querySelector(".ns-menu .ns-mrow")'), tag + ' menu');
    };

    // First menu row: Claude, OpenAI, AWS icons — green logged in, gray not.
    await openMenu();
    await until(() => evaluate(`${icon('claude')}.classList.contains('ok') && ${icon('aws')}.classList.contains('ok')`), tag + ' icons colour');
    const row = await evaluate('[...document.querySelectorAll(".ns-menu .ns-mrow .ns-mi")].map(b => [b.dataset.k, b.className, b.title, !!b.querySelector("svg")])');
    assert.deepEqual(row.map(r => r[0]), ['auth-claude', 'auth-codex', 'auth-aws']);
    assert(row.every(r => r[3]), 'icons are SVGs');
    assert.match(row[0][2], /Claude — claude: logged in \(claude\.ai\) — me@example\.com · max/);
    assert.equal(row[1][1], 'ns-mi ns-auic'); assert.match(row[1][2], /Codex — codex: not logged in/);
    assert.match(row[2][2], /AWS SSO — sso-hlp\.js: logged in \(dsa\) — live SSO check passed/);
    assert.equal(await evaluate('getComputedStyle(document.querySelector(".ns-menu .ns-mrow")).display'), 'flex');
    assert.equal(await evaluate('document.querySelector(".ns-menu").children[1].textContent.trim()'), '+New session');
    // Brand colours when logged in, gray when not.
    assert.equal(await evaluate(`getComputedStyle(${icon('claude')}.querySelector('.ns-mic')).color`), 'rgb(217, 119, 87)');
    assert.equal(await evaluate(`getComputedStyle(${icon('codex')}.querySelector('.ns-mic')).color`), 'rgb(140, 149, 159)');
    assert.equal(await evaluate(`getComputedStyle(${icon('codex')}.querySelector('.ns-mic')).opacity`), '0.45');
    assert.equal(await evaluate(`getComputedStyle(${icon('claude')}.querySelector('.ns-mic')).opacity`), '1');
    assert.equal(await evaluate(`getComputedStyle(${icon('aws')}.querySelector('svg path:last-child')).fill`), 'rgb(255, 153, 0)');
    await shot(tag + '-menu');

    // Green Claude → dialog, no login started; switching to claude.aws re-checks and
    // the menu's icon follows it.
    await evaluate(`${icon('claude')}.click()`);
    await until(() => evaluate('/me@example/.test((document.querySelector("dialog.ns-new[open] [data-r=st]")||{}).textContent)'), tag + ' claude status');
    assert.equal(await evaluate('document.querySelector("dialog.ns-new[open] [data-r=login]").textContent'), 'Log in again');
    assert.deepEqual(await evaluate('[...document.querySelectorAll("dialog.ns-new[open] .ns-bin")].map(b => b.textContent)'), ['claude', 'claude.aws']);
    await evaluate('[...document.querySelectorAll("dialog.ns-new[open] .ns-bin")].find(b => b.textContent === "claude.aws").click()');
    await until(() => evaluate('/bedrock/.test(document.querySelector("dialog.ns-new[open] [data-r=st]").textContent)'), tag + ' claude.aws status');
    await evaluate('document.querySelector("dialog.ns-new[open] [data-r=close]").click()');
    assert(!posts.some(p => p.path === '/mux/api/agent-auth/login'), 'a green icon starts no login');
    await openMenu();
    assert.match(await evaluate(`${icon('claude')}.title`), /^Claude — claude\.aws: logged in \(bedrock\)/);

    // Gray Codex → the login starts by itself: link and device code, then done.
    await evaluate(`${icon('codex')}.click()`);
    await until(() => evaluate('(document.querySelector("dialog.ns-new[open] [data-r=ucode]")||{}).textContent === "AB12-CD34"'), tag + ' device code');
    assert.equal(await evaluate('document.querySelector("dialog.ns-new[open] [data-r=link]").href'), 'https://auth.example/codex/device');
    assert.equal(await evaluate('document.querySelector("dialog.ns-new[open] [data-r=coderow]").hidden'), true);
    await shot(tag + '-codex-login');
    // Copy answers either way (headless Chrome refuses both clipboard paths; a phone is
    // checked by hand), and the fallback cleans up after itself.
    await evaluate('document.querySelector("dialog.ns-new[open] [data-r=copy]").click()');
    await until(() => evaluate('/^(Copied|Select it)$/.test(document.querySelector("dialog.ns-new[open] [data-r=copy]").textContent)'), tag + ' copy answers');
    await evaluate('nsCopyFallback("AB12-CD34")');
    assert.equal(await evaluate('document.querySelectorAll("textarea[readonly]").length'), 0);
    assert.deepEqual(posts.find(p => p.path === '/mux/api/agent-auth/login').body, { bin: 'codex' });
    status.codex.loggedIn = true; status.codex.method = 'ChatGPT';
    await until(() => evaluate('/Logged in/.test(document.querySelector("dialog.ns-new[open] [data-r=step]").textContent)'), tag + ' login done', 200);
    status.codex.loggedIn = false; status.codex.method = ''; loginStarted = false;
    await evaluate('document.querySelector("dialog.ns-new[open] [data-r=close]").click()');

    // Green AWS → its dialog: no binary picker, and logging in again forces.
    await openMenu();
    await evaluate(`${icon('aws')}.click()`);
    await until(() => evaluate('/live SSO check passed/.test((document.querySelector("dialog.ns-new[open] [data-r=st]")||{}).textContent)'), tag + ' aws status');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("dialog.ns-new[open] [name=bin]")).display'), 'none');
    assert.match(await evaluate('document.querySelector("dialog.ns-new[open] h3").textContent'), /^AWS SSO login on fixture/);
    await shot(tag + '-aws');
    posts = [];
    await evaluate('document.querySelector("dialog.ns-new[open] [data-r=login]").click()');
    await until(() => posts.some(p => p.path === '/mux/api/agent-auth/login'), tag + ' aws login');
    assert.deepEqual(posts.find(p => p.path === '/mux/api/agent-auth/login').body, { bin: 'sso-hlp.js', force: true });
    loginStarted = false;
    await evaluate('document.querySelector("dialog.ns-new[open] [data-r=close]").click()');

    // A server without sso-hlp leaves the AWS icon out.
    const was = status['sso-hlp.js']; status['sso-hlp.js'] = { bin: 'sso-hlp.js', agent: 'aws', missing: true, loggedIn: false, error: 'not found' };
    await evaluate('NS_AUTH = {}');
    await openMenu();
    await until(() => evaluate(`${icon('aws')}.hidden`), tag + ' aws hidden');
    status['sso-hlp.js'] = was;
    await evaluate('document.querySelector(".ns-menu")._close()');

    // The cost summary reads this fixture's catch-all /api answer; that is its own business.
    assert.deepEqual((await evaluate('testErrors')).filter(e => !e.startsWith('ResizeObserver loop') && !/reading 'all'/.test(e)), []);

    // New session: the title goes up as `name`. (What opens next is the fixture's
    // non-session, so page errors after this point are not this test's.)
    await evaluate('document.querySelector("[data-menu=fixture]").click()');
    await until(() => evaluate('!!document.querySelector(".ns-menu")'), tag + ' menu for new');
    await evaluate('[...document.querySelectorAll(".ns-menu button")].find(b => /New session/.test(b.textContent)).click()');
    await until(() => evaluate('!!document.querySelector("dialog.ns-new[open] [name=title]")'), tag + ' new-session title');
    await evaluate(`(()=>{var d=document.querySelector('dialog.ns-new[open]');d.querySelector('[name=bin]').value='claude';d.querySelector('[name=cwd]').value='/tmp';d.querySelector('[name=title]').value='  My task ';d.querySelector('form').requestSubmit();})()`);
    await until(() => posts.some(p => p.path === '/mux/api/sessions'), tag + ' create');
    assert.equal(posts.find(p => p.path === '/mux/api/sessions').body.name, 'My task');
    console.log('OK: ' + tag + ' login icons, login dialog, new-session title');
  }
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  if (cdp) cdp.terminate();
  if (child && child.exitCode === null) { const done = new Promise(r => child.once('exit', r)); process.kill(-child.pid, 'SIGKILL'); await done; }
  for (const ws of wss.clients) ws.terminate(); await new Promise(r => wss.close(r)); server.closeAllConnections(); await new Promise(r => server.close(r));
  fs.rmSync(cfg, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); process.exit(process.exitCode || 0);
});
