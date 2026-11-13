'use strict';
// The public /mux name, Origin and content-type checks, owned (locked) sessions, HTTP
// submit, raw-log modes and the Markdown sanitizer. One ccbb web on a free port with a
// throwaway config dir; the child is test/fake-claude.js behind a claude-named wrapper,
// so nothing here reaches a model. The sanitizer runs in Chrome when CHROME is set.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-m14-'));
const TOKEN = 'tok-m14-' + process.pid;
const PUB = 'mux.example.test';
const ENV_SENTINEL = 'env-sentinel-' + process.pid;
const ARG_SENTINEL = 'arg-sentinel-' + process.pid;
const LEAK = 'leak-sentinel-' + process.pid;
const MUX_DIR = path.join(dir, 'ccbb-mux');
const bin = path.join(dir, 'bin'), dumps = path.join(dir, 'env'), work = path.join(dir, 'work');
for (const d of [bin, dumps, work]) fs.mkdirSync(d);
fs.writeFileSync(path.join(dir, 'ccbb-config.json'), JSON.stringify({ peerToken: TOKEN, publicHost: PUB, trustedHosts: ['full.example.test'] }));
// What the child was started with, then the fake child itself.
fs.writeFileSync(path.join(bin, 'claude-m13'), `#!/bin/bash\nenv > ${dumps}/env.$$\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'fake-claude.js'))} "$@"\n`, { mode: 0o755 });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, tries = 100, gap = 100) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}
let port, web, out = '';
const freePort = () => new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function startWeb() {
  web = spawn(process.execPath, [path.join(__dirname, '..', 'ccbb-web.js'), '-p', String(port)], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CCBB_HOME: dir, PATH: bin + path.delimiter + process.env.PATH, M13_LEAK: LEAK },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  web.stdout.on('data', d => { out += d; }); web.stderr.on('data', d => { out += d; });
  const up = await until(async () => (await req('GET', '/api/identity', { token: true })).status === 200);
  if (!up) throw new Error('ccbb web never came up on ' + port + '\n' + out);
}
async function stopWeb() {
  if (!web) return;
  const gone = new Promise(r => web.once('exit', r));
  try { process.kill(-web.pid, 'SIGTERM'); } catch {}
  await Promise.race([gone, sleep(3000)]);
  try { process.kill(-web.pid, 'SIGKILL'); } catch {}
  web = null;
}

// Raw http, because fetch will not let a test set Host — and Host is what makes a
// request the public name's.
function req(method, p, o = {}) {
  const headers = { ...(o.headers || {}) };
  headers.host = 'host' in o ? o.host : `127.0.0.1:${port}`;
  if (o.token) headers['x-ccbb-token'] = TOKEN;
  if (o.key) headers['x-ccbb-owner-key'] = o.key;
  let body = o.body;
  if (body !== undefined && typeof body !== 'string') { body = JSON.stringify(body); if (!headers['content-type']) headers['content-type'] = 'application/json'; }
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, x => {
      let b = ''; x.setEncoding('utf8'); x.on('data', d => { b += d; });
      x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} res({ status: x.statusCode, headers: x.headers, text: b, j }); });
    });
    r.on('error', rej);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
const pub = (method, p, o = {}) => req(method, p, { ...o, host: PUB });
function wsOpen(p, o = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers: { host: o.host || `127.0.0.1:${port}`, ...(o.token ? { 'x-ccbb-token': TOKEN } : {}), ...(o.headers || {}) }, origin: o.origin });
  const msgs = [];
  ws.on('message', d => { try { msgs.push(JSON.parse(d)); } catch {} });
  const opened = new Promise(r => { ws.once('open', () => r(true)); ws.once('error', () => r(false)); ws.once('unexpected-response', () => r(false)); ws.once('close', () => r(false)); });
  let n = 0;
  const op = async m => {
    const id = 'm' + (++n); ws.send(JSON.stringify({ ...m, id }));
    return until(() => msgs.find(x => x.op === 'ack' && x.id === id), 50, 100);
  };
  return { ws, msgs, opened, op };
}

// A stopped Claude session on disk, for the history page and its alias.
const HID = '0b6c2f2e-5d0e-4a8e-9a43-' + String(process.pid).padStart(12, '0').slice(-12);
const proj = path.join(dir, 'projects', '-tmp-m14');
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, HID + '.jsonl'), [
  { type: 'user', uuid: 'u1', sessionId: HID, cwd: '/tmp/m14', timestamp: '2026-11-11T10:00:00Z', message: { role: 'user', content: 'hello m14' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: HID, cwd: '/tmp/m14', timestamp: '2026-11-11T10:00:01Z',
    message: { id: 'msg1', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'hi from history' }], usage: { input_tokens: 1, output_tokens: 1 } } },
].map(x => JSON.stringify(x)).join('\n') + '\n');

test.before(async () => { port = await freePort(); await startWeb(); });
test.after(async () => { await stopWeb(); fs.rmSync(dir, { recursive: true, force: true }); });

const crypto = require('crypto');
const PAGES = ['/mux/s/abc', '/mux/m/s/abc', '/mux/h/claude/' + HID, '/mux/m/h/codex/thr1'];
let cookie;
async function signIn() {
  if (cookie) return cookie;
  const r = await pub('POST', '/mux/login', { body: 'token=' + TOKEN + '&back=%2Fmux%2F', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  return (cookie = String(r.headers['set-cookie']).split(';')[0]);
}

test('signed out, every framed page gets the sign-in form, which comes back with the query', async () => {
  for (const p of PAGES) {
    const r = await pub('GET', p + '?embed=1&theme=dark');
    assert.equal(r.status, 401, p);
    assert.match(r.text, /action="\/mux\/login"/);
    assert(r.text.includes(`name="back" value="${p}?embed=1&amp;theme=dark"`), r.text);
  }
  const back = await pub('POST', '/mux/login', { body: 'token=' + TOKEN + '&back=' + encodeURIComponent('/mux/m/s/abc?embed=1&theme=dark'), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(back.status, 303);
  assert.equal(back.headers.location, '/mux/m/s/abc?embed=1&theme=dark');
});

test('each page is served with a policy that hashes exactly its inline scripts; the phone one adds its dress', async () => {
  const c = await signIn();
  for (const p of PAGES) {
    const r = await pub('GET', p + '?embed=1', { headers: { cookie: c } });
    assert.equal(r.status, 200, p);
    const csp = String(r.headers['content-security-policy']);
    assert.match(csp, /frame-ancestors 'self'/);
    const inline = [...r.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    assert(inline.length >= 2, p);
    for (const js of inline) {
      assert(csp.includes(`'sha256-${crypto.createHash('sha256').update(js).digest('base64')}'`), p + ': unhashed script');
      new Function(js);   // parses
    }
    const phone = p.startsWith('/mux/m/');
    assert.equal(r.text.includes('function syncViewport'), phone, p);
    assert.equal(r.text.includes('--full-h: 100dvh'), phone, p);
    assert(r.text.includes(':root[data-theme=dark]'), p);
  }
  for (const p of ['/mux/h/gemini/x', '/mux/m/x/abc', '/mux/m/s/a/b']) {
    assert.notEqual((await pub('GET', p, { headers: { cookie: c } })).status, 200, p);
  }
});

test('a stopped session reads through /mux on the public name, GET only', async () => {
  const c = await signIn();
  const h = await pub('GET', `/mux/api/claude/history/${HID}?win=5,25`, { headers: { cookie: c } });
  assert.equal(h.status, 200, h.text);
  assert.equal(h.j.state.agent, 'claude');
  assert(JSON.stringify(h.j).includes('hi from history'));
  assert.equal((await pub('GET', '/mux/api/claude/history/nope', { headers: { cookie: c } })).status, 404);
  assert.equal((await pub('GET', `/mux/api/claude/history/${HID}`)).status, 401);
  assert.notEqual((await pub('POST', `/mux/api/claude/history/${HID}`, { headers: { cookie: c }, body: {} })).status, 200);
});

test('the phone app still builds, sharing the viewport sync', () => {
  const { mobilePageHtml } = require('../ccbb-mobile.js');
  assert.equal(typeof mobilePageHtml, 'function');
  const html = mobilePageHtml({});
  assert(html, 'phone page html');
  assert(html.includes('viewportHooks.push') && html.includes('function syncViewport'));
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(m[1]);
});

test('in a browser: the framed pages boot, theme, hide the bar, and tell the parent', { skip: !process.env.CHROME && 'set CHROME' }, async () => {
  const prof = path.join(dir, 'chrome');
  const chrome = spawn(process.env.CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore', detached: true });
  try {
    const dt = path.join(prof, 'DevToolsActivePort');
    assert(await until(() => fs.existsSync(dt)), 'DevTools');
    const cport = fs.readFileSync(dt, 'utf8').split('\n')[0];
    const tabs = await (await fetch(`http://127.0.0.1:${cport}/json`)).json();
    const cdp = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => cdp.once('open', r));
    let n = 0; const waiting = new Map(), thrown = [];
    cdp.on('message', raw => { const m = JSON.parse(raw);
      if (m.method === 'Runtime.exceptionThrown') thrown.push(JSON.stringify(m.params.exceptionDetails).slice(0, 600));
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
    const send = (method, params = {}) => new Promise(r => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
    const ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };
    await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
    // Every request the pages make: on the public name only /mux/* exists, so a path
    // outside it here is one that 404s there.
    const asked = [];
    cdp.on('message', raw => { const m = JSON.parse(raw); if (m.method === 'Network.requestWillBeSent') asked.push(m.params.request.url); });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));` });
    const base = `http://127.0.0.1:${port}`;

    // A stopped session's transcript, embedded and dark: no bar, the history shown.
    await send('Page.navigate', { url: `${base}/mux/m/h/claude/${HID}?embed=1&theme=dark&token=${TOKEN}` });
    assert(await until(() => ev(`document.body.innerText.includes('hi from history')`), 100, 100),
      'history page: ' + await ev('document.body.innerText.slice(0,300)') + ' ' + thrown.join(' / '));
    assert.equal(await ev(`document.documentElement.getAttribute('data-theme')`), 'dark');
    assert.equal(await ev(`!!document.querySelector('.mx-bar')`), false);
    assert.equal(await ev(`getComputedStyle(document.getElementById('app')).position`), 'fixed');
    assert.equal(await ev(`getComputedStyle(document.querySelector('.input-box') || document.body).fontSize`), '16px');
    assert.deepEqual(await ev('window.__csp'), []);

    // A session that is not there, framed by a page on the same origin: the parent hears
    // "missing" from the frame, and the frame stays where it is.
    await send('Page.navigate', { url: `${base}/mux/?token=${TOKEN}` });
    assert(await until(() => ev(`document.readyState === 'complete'`)));
    const heard = await ev(`new Promise(res => {
      window.addEventListener('message', e => res({ data: e.data, origin: e.origin, src: e.source === f.contentWindow, href: f.contentWindow.location.pathname }));
      var f = document.createElement('iframe'); f.src = '/mux/s/gone-m14?embed=1'; document.body.appendChild(f);
      setTimeout(() => res(null), 8000);
    })`);
    assert(heard, 'no message from the frame: ' + thrown.join(' / '));
    assert.deepEqual(heard, { data: { ccbb: 'missing', session: 'gone-m14' }, origin: base, src: true, href: '/mux/s/gone-m14' });

    // A session that ends under an attached frame (stopped elsewhere) says so; one that
    // goes away altogether (a ccbb restart) says it is missing, rather than the frame
    // retrying a dead id forever.
    const live = async () => {
      const made = await req('POST', '/mux/api/sessions', { token: true, body: { bin: 'claude-m13', cwd: work } });
      assert.equal(made.status, 200, made.text);
      const sid = made.j.session.id;
      await ev(`window.__heard = []; window.onmessage = e => window.__heard.push(e.data);
        document.getElementById('live') && document.getElementById('live').remove();
        var g = document.createElement('iframe'); g.id = 'live'; g.src = '/mux/s/${sid}?embed=1'; document.body.appendChild(g); 1`);
      assert(await until(() => ev(`(() => { try { const w = document.getElementById('live').contentWindow; return !!(w.ccbb && w.ccbb.state && w.document.querySelector('.input-box')); } catch (e) { return false; } })()`), 100, 100), 'live frame never attached');
      await sleep(500);
      return sid;
    };
    const heardFrom = (sid, what) => until(() => ev(`window.__heard.some(d => d && d.ccbb === '${what}' && d.session === '${sid}')`), 150, 100);
    let sid = await live();
    // /exit typed in the frame is the host's to act on: it hears `end`, and the session runs on.
    const inLive = js => ev(`(() => { const w = document.getElementById('live').contentWindow; return ${js}; })()`);
    await inLive(`(w.document.querySelector('.input-box').textContent = '/exit', w.document.querySelector('.send-btn').click(), 1)`);
    assert(await heardFrom(sid, 'end'), 'no end after /exit: ' + JSON.stringify(await ev('window.__heard')));
    assert.equal(await ev(`window.__heard.some(d => d && d.ccbb === 'exit')`), false);
    assert(!(await inLive(`!!w.document.querySelector('.mx-closed')`)));
    // The host's theme follows in place: no reload.
    const hostTheme = t => ev(`(document.getElementById('live').contentWindow.postMessage({ host: 'theme', theme: '${t}' }, location.origin), 1)`);
    const themeIs = t => until(() => inLive(`w.document.documentElement.getAttribute('data-theme') === '${t}' && w.__mark === 1`), 50, 100);
    await inLive(`(w.__mark = 1)`);
    await hostTheme('light');
    assert(await themeIs('light'), 'theme message not applied in place');
    // Posted from the frame's own realm (a postMessage's source is its caller's window).
    await inLive(`(w.eval("postMessage({ host: 'theme', theme: 'dark' }, '*')"), 1)`);
    await sleep(200);
    assert.equal(await inLive(`w.document.documentElement.getAttribute('data-theme')`), 'light', 'took a theme from itself, not its host');
    await hostTheme('dark');
    assert(await themeIs('dark'), 'theme message not applied in place');
    await req('POST', `/mux/api/sessions/${sid}/stop?force=1`, { token: true, body: {} });
    assert(await heardFrom(sid, 'exit'), 'no exit after a stop: ' + JSON.stringify(await ev('window.__heard')));
    sid = await live();
    await stopWeb(); await startWeb();
    assert(await heardFrom(sid, 'missing'), 'no missing after a restart: ' + JSON.stringify(await ev('window.__heard')));
    // ResizeObserver's loop notice is the browser deferring a layout pass, not a fault.
    const real = errs => (errs || []).filter(e => !/^ResizeObserver loop/.test(e));
    assert.deepEqual(real(await ev(`document.getElementById('live').contentWindow.ccbb.errors`)), []);

    // The phone page framed the way zdte's phone frames it: the frame's height and the
    // home-indicator inset (data-safe-b, since env() is 0 inside a frame) reach its root.
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await ev(`var h = document.createElement('iframe'); h.id = 'phone'; h.setAttribute('data-safe-b', '34px');
      h.style.cssText = 'position:fixed;top:0;left:0;width:390px;height:600px;border:0';
      h.src = '/mux/m/h/claude/${HID}?embed=1&theme=dark'; document.body.appendChild(h); 1`);
    const inPhone = x => ev(`(() => { try { const w = document.getElementById('phone').contentWindow; return ${x}; } catch (e) { return null; } })()`);
    assert(await until(() => inPhone(`w.document.body.innerText.includes('hi from history')`), 100, 100), 'phone frame never rendered');
    assert.equal(await inPhone(`getComputedStyle(w.document.documentElement).getPropertyValue('--safe-b').trim()`), '34px');
    assert(await until(() => inPhone(`!!w.document.documentElement.style.getPropertyValue('--app-h')`), 30, 100), 'no --app-h in the phone frame');
    assert.equal(await inPhone(`Math.round(w.document.getElementById('app').getBoundingClientRect().bottom)`), 600);
    assert.deepEqual(real(await inPhone(`w.ccbb.errors`)), []);
    assert.equal(await inPhone(`Math.max(w.document.documentElement.scrollWidth, w.document.getElementById('app').scrollWidth)`), 390, 'the phone page scrolls sideways');

    // (The browser's own favicon probe aside: a 404 there costs nothing.)
    const offPath = asked.filter(u => u.startsWith(base) && !/^\/(mux\/|favicon\.ico$)/.test(new URL(u).pathname));
    assert.deepEqual(offPath, []);
    assert.deepEqual(thrown, []);
    cdp.close();
  } finally {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
  }
});

// The public name end to end, as close to the tunnel as a test gets without root: TLS on a
// local port, Chrome resolving the public name to it, and the proxy standing in for the
// edge on 443 (Host and Origin without the port), /mux to ccbb and everything else to a
// stand-in for zdte's page that frames it. What it adds over the loopback test: the
// sign-in inside the frame, the Secure SameSite=Strict cookie, and the socket over wss.
test('over TLS on the public name: sign in inside the frame, then the session attaches', { skip: !process.env.CHROME && 'set CHROME' }, async () => {
  const https = require('https'), net = require('net'), { execFileSync } = require('child_process');
  const tls = path.join(dir, 'tls'); fs.mkdirSync(tls);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=' + PUB,
    '-keyout', path.join(tls, 'k.pem'), '-out', path.join(tls, 'c.pem')], { stdio: 'ignore' });
  const edge = h => { const o = { ...h, host: PUB }; if (o.origin) o.origin = o.origin.replace(/:\d+$/, ''); return o; };
  const HOST_PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0"><script>
    window.__heard = []; addEventListener('message', e => __heard.push({ data: e.data, origin: e.origin }));
    var f = document.createElement('iframe'); f.id = 'f'; f.setAttribute('data-safe-b', '34px');
    f.style.cssText = 'position:fixed;top:44px;left:0;width:390px;height:700px;border:0';
    f.src = new URLSearchParams(location.search).get('src'); document.body.appendChild(f);
  </script>`;
  const server = https.createServer({ key: fs.readFileSync(path.join(tls, 'k.pem')), cert: fs.readFileSync(path.join(tls, 'c.pem')) }, (rq, rs) => {
    if (!rq.url.startsWith('/mux')) { rs.writeHead(200, { 'content-type': 'text/html' }); return rs.end(HOST_PAGE); }
    const up = http.request({ host: '127.0.0.1', port, method: rq.method, path: rq.url, headers: edge(rq.headers) }, x => { rs.writeHead(x.statusCode, x.headers); x.pipe(rs); });
    up.on('error', () => rs.destroy());
    rq.pipe(up);
  });
  server.on('upgrade', (rq, sock, head) => {
    const up = net.connect(port, '127.0.0.1', () => {
      const h = edge(rq.headers);
      up.write(`${rq.method} ${rq.url} HTTP/1.1\r\n` + Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const tport = server.address().port, origin = `https://${PUB}:${tport}`;

  const prof = path.join(dir, 'chrome-tls');
  const chrome = spawn(process.env.CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + prof,
    `--host-resolver-rules=MAP ${PUB} 127.0.0.1`, '--ignore-certificate-errors', 'about:blank'], { stdio: 'ignore', detached: true });
  try {
    const dt = path.join(prof, 'DevToolsActivePort');
    assert(await until(() => fs.existsSync(dt)), 'DevTools');
    const cport = fs.readFileSync(dt, 'utf8').split('\n')[0];
    const tabs = await (await fetch(`http://127.0.0.1:${cport}/json`)).json();
    const cdp = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => cdp.once('open', r));
    let n = 0; const waiting = new Map();
    cdp.on('message', raw => { const m = JSON.parse(raw); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
    const send = (method, params = {}) => new Promise(r => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
    const ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };
    const inF = x => ev(`(() => { try { const w = document.getElementById('f').contentWindow; return ${x}; } catch (e) { return null; } })()`);
    await send('Runtime.enable'); await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

    const made = await req('POST', '/mux/api/sessions', { token: true, body: { bin: 'claude-m13', cwd: work } });
    assert.equal(made.status, 200, made.text);
    const sid = made.j.session.id, src = `/mux/m/s/${sid}?embed=1&theme=dark`;
    await send('Page.navigate', { url: `${origin}/agent?src=${encodeURIComponent(src)}` });

    // Signed out: the frame shows ccbb's sign-in, and signing in there lands back on the
    // framed page, query and all, with the socket up over wss.
    assert(await until(() => inF(`!!w.document.querySelector('form[action="/mux/login"]')`), 100, 100), 'no sign-in form in the frame');
    await inF(`(w.document.querySelector('input[name=token]').value = ${JSON.stringify(TOKEN)}, w.document.querySelector('form').submit(), 1)`);
    assert(await until(() => inF(`w.location.pathname + w.location.search === ${JSON.stringify(src)} && !!w.ccbb && !!w.ccbb.state().epoch`), 100, 100),
      'frame never attached: ' + await inF('w.location.href + " " + w.document.body.innerText.slice(0, 200)'));
    assert.equal(await inF(`w.document.documentElement.getAttribute('data-theme')`), 'dark');
    assert.equal(await inF(`getComputedStyle(w.document.documentElement).getPropertyValue('--safe-b').trim()`), '34px');

    // Ended elsewhere: the host hears it, from its own origin.
    await req('POST', `/mux/api/sessions/${sid}/stop?force=1`, { token: true, body: {} });
    assert(await until(() => ev(`__heard.some(h => h.data && h.data.ccbb === 'exit' && h.data.session === '${sid}' && h.origin === '${origin}')`), 100, 100),
      'no exit: ' + JSON.stringify(await ev('__heard')));

    // Once signed in, a stopped session's transcript opens framed with no sign-in, its
    // history read through the /mux alias.
    await send('Page.navigate', { url: `${origin}/agent?src=${encodeURIComponent(`/mux/m/h/claude/${HID}?embed=1`)}` });
    assert(await until(() => inF(`w.document.body.innerText.includes('hi from history')`), 100, 100),
      'history frame: ' + await inF('w.location.href + " " + w.document.body.innerText.slice(0, 200)'));
    cdp.close();
  } finally {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
    server.close();
  }
});
