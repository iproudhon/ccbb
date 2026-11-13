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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-m13-'));
const TOKEN = 'tok-m13-' + process.pid;
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
const create = (body, o = {}) => req('POST', '/mux/api/sessions', { token: true, body, ...o });

test.before(async () => { port = await freePort(); await startWeb(); });
test.after(async () => {
  try { for (const s of (await req('GET', '/mux/api/sessions', { token: true })).j.sessions || []) await req('POST', `/mux/api/sessions/${s.id}/stop?force=1`, { token: true, body: {}, key: owned && owned.key }); } catch {}
  await stopWeb();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the public name serves /mux only, signs in with its own cookie, and refuses ?token=', async () => {
  assert.equal((await pub('GET', '/api/sessions', { token: true })).status, 404);
  assert.equal((await pub('GET', '/', { token: true })).status, 404);
  assert.equal((await pub('GET', '/api/identity', { token: true })).status, 404);
  // Fails closed: a Host that is neither the public name nor plainly local is public.
  for (const host of [PUB + '.', PUB.toUpperCase() + ':443', 'other.example.test'])
    assert.equal((await req('GET', '/api/identity', { token: true, host })).status, 404, 'Host ' + JSON.stringify(host));
  // A trusted name gets all of ccbb, and its https page may write.
  assert.equal((await req('GET', '/api/identity', { token: true, host: 'full.example.test' })).status, 200);
  assert.equal((await req('POST', '/mux/api/sessions', { token: true, host: 'full.example.test', body: {}, headers: { origin: 'https://full.example.test' } })).status, 400);
  assert.equal((await req('POST', '/mux/api/sessions', { token: true, host: 'full.example.test', body: {}, headers: { origin: 'https://evil.test' } })).status, 403);
  for (const host of ['localhost:' + port, '[::1]:' + port])
    assert.equal((await req('GET', '/api/identity', { token: true, host })).status, 200, 'Host ' + host);
  assert.equal((await pub('GET', '/mux/api/sessions', { token: true })).status, 200);
  assert.equal((await pub('GET', '/mux/api/sessions?token=' + TOKEN)).status, 400);
  assert.equal((await pub('GET', '/mux/api/sessions')).status, 401);
  // A local page's cookie is not the public one.
  assert.equal((await pub('GET', '/mux/api/sessions', { headers: { cookie: 'ccbb_token=' + TOKEN } })).status, 401);
  const form = await pub('GET', '/mux/');
  assert.equal(form.status, 401); assert.match(form.text, /action="\/mux\/login"/);
  const bad = await pub('POST', '/mux/login', { body: 'token=nope&back=%2Fmux%2F', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(bad.status, 303); assert.match(bad.headers.location, /login=0/); assert.equal(bad.headers['set-cookie'], undefined);
  const good = await pub('POST', '/mux/login', { body: 'token=' + TOKEN + '&back=%2Fmux%2Fs%2Fabc', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(good.status, 303); assert.equal(good.headers.location, '/mux/s/abc');
  const ck = good.headers['set-cookie'][0];
  assert.match(ck, /^ccbb_mux=/); for (const a of ['Path=/mux', 'Secure', 'HttpOnly', 'SameSite=Strict']) assert(ck.includes(a), ck);
  // An off-site back is not followed.
  const off = await pub('POST', '/mux/login', { body: 'token=' + TOKEN + '&back=%2F%2Fevil.test%2F', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(off.headers.location, '/mux/');
  const cookie = ck.split(';')[0];
  assert.equal((await pub('GET', '/mux/api/sessions', { headers: { cookie } })).status, 200);
  const list = await pub('GET', '/mux/', { headers: { cookie } });
  assert.equal(list.status, 200); assert(!list.text.includes(TOKEN), 'the list page puts no token in its links');
  assert.match(list.headers['content-security-policy'], /frame-ancestors 'self'/);
  const page = await pub('GET', '/mux/s/abc', { headers: { cookie } });
  assert.equal(page.status, 200); assert(!page.text.includes(TOKEN));
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  // The page's own calls to ccbb, under /mux; //commands are refused there.
  assert.notEqual((await pub('GET', '/mux/api/subscription', { headers: { cookie } })).status, 404);
  assert.equal((await pub('POST', '/mux/api/session/x/command', { headers: { cookie }, body: { name: 'pwd' } })).status, 403);
  // WebSocket: /mux only.
  assert.equal(await wsOpen('/', { host: PUB, headers: { cookie } }).opened, false);
});

test('the public name creates from presets only, and never Codex', async () => {
  const o = { host: PUB, token: true };
  const ok = await pub('POST', '/mux/api/sessions', { ...o, body: { bin: 'claude-m13', cwd: work } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await req('GET', '/mux/api/sessions/' + ok.j.session.id, { token: true })).j.state.permissionMode, 'default', 'no mode given is the asking mode, not a settings default');
  for (const body of [
    { bin: 'claude-m13', cwd: work, permissionMode: 'bypassPermissions' },
    { bin: 'claude-m13', cwd: work, extraArgs: ['--x'] },
    { bin: 'claude-m13', cwd: work, env: { A: '1' } },
    { bin: 'claude-m13', cwd: work, owner: 'zdte' },
    { bin: '/bin/sh', cwd: work },
    { bin: path.join(__dirname, 'fake-claude.js'), cwd: work },
    { agent: 'codex', bin: 'codex' },
    { bin: 'codex-anything' },
  ]) {
    const r = await pub('POST', '/mux/api/sessions', { ...o, body });
    assert.equal(r.status, 403, JSON.stringify(body) + ' → ' + r.status + ' ' + r.text);
  }
  // Over the socket too.
  const c = wsOpen('/mux/mux', { host: PUB, token: true, origin: 'https://' + PUB });
  assert(await c.opened);
  const a = await c.op({ op: 'new', options: { bin: 'claude-m13', cwd: work, extraArgs: ['--x'] } });
  assert.match(a.error, /presets only/);
  // Nor can a session be switched to bypass from outside.
  const m = wsOpen('/mux/mux?session=' + ok.j.session.id, { host: PUB, token: true, origin: 'https://' + PUB });
  assert(await m.opened);
  await until(() => m.msgs.find(x => x.op === 'snapshot'));
  assert.match((await m.op({ op: 'set_mode', mode: 'bypassPermissions' })).error || '', /not allowed/);
  m.ws.close();
  c.ws.close();
  await req('POST', `/mux/api/sessions/${ok.j.session.id}/stop?force=1`, { token: true, body: {} });
});

test('Origin: mutations and upgrades from another origin are refused', async () => {
  const body = { bin: 'claude-m13', cwd: work };
  assert.equal((await create(body, { headers: { origin: 'http://evil.test' } })).status, 403);
  // DNS rebinding: the page's own origin, but under a name that is not this host's.
  assert.equal((await create(body, { host: `evil.test:${port}`, headers: { origin: `http://evil.test:${port}` } })).status, 403);
  // A root route too.
  assert.equal((await req('POST', '/api/term/open', { token: true, body: {}, headers: { origin: 'http://evil.test' } })).status, 403);
  // On the public name only https://<publicHost>.
  assert.equal((await pub('POST', '/mux/api/sessions', { token: true, body, headers: { origin: 'http://127.0.0.1:' + port } })).status, 403);
  const same = await create(body, { headers: { origin: `http://127.0.0.1:${port}` } });
  assert.equal(same.status, 200, same.text);
  await req('POST', `/mux/api/sessions/${same.j.session.id}/stop?force=1`, { token: true, body: {} });
  assert.equal(await wsOpen('/mux/mux', { token: true, origin: 'http://evil.test' }).opened, false);
  assert.equal(await wsOpen('/ws-term/x', { token: true, origin: 'http://evil.test' }).opened, false);
  const ok = wsOpen('/mux/mux', { token: true, origin: `http://127.0.0.1:${port}` });
  assert.equal(await ok.opened, true); ok.ws.close();
});

test('CSRF: a mux write without a JSON content type is refused', async () => {
  for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const r = await req('POST', '/mux/api/sessions', { token: true, body: '{"bin":"claude-m13"}', headers: { 'content-type': ct } });
    assert.equal(r.status, 415, ct);
  }
});

let owned = null;
test('owner: the key comes back once, and list, snapshot and logs carry no key, env or args', async () => {
  const r = await create({ bin: 'claude-m13', cwd: work, owner: 'zdte', cleanEnv: true,
    env: { M13_SENTINEL: ENV_SENTINEL }, extraArgs: ['--append-system-prompt', ARG_SENTINEL], name: 'owned-one' });
  assert.equal(r.status, 200, r.text);
  assert.match(r.j.ownerKey, /^[0-9a-f]{64}$/);
  owned = { id: r.j.session.id, key: r.j.ownerKey };
  assert.equal(r.j.session.owner, 'zdte');
  await until(async () => (await req('GET', '/mux/api/sessions', { token: true })).j.sessions.find(s => s.id === owned.id && s.status !== 'starting'));
  const list = (await req('GET', '/mux/api/sessions', { token: true })).text;
  const snap = (await req('GET', '/mux/api/sessions/' + owned.id, { token: true })).text;
  const rows = (await req('GET', '/api/sessions', { token: true })).text;
  assert.equal(JSON.parse(list).sessions.find(s => s.id === owned.id).owner, 'zdte');
  assert.equal(JSON.parse(rows).sessions.find(s => s.sessionId === owned.id).owner, 'zdte');
  // The WS snapshot as well.
  const c = wsOpen('/mux/mux?session=' + owned.id, { token: true });
  assert(await c.opened);
  const ws = JSON.stringify(await until(() => c.msgs.find(m => m.op === 'snapshot')));
  c.ws.close();
  const logs = fs.readdirSync(MUX_DIR).map(f => fs.readFileSync(path.join(MUX_DIR, f), 'utf8')).join('\n');
  for (const [name, text] of Object.entries({ list, snap, rows, ws, logs, out })) {
    for (const secret of [owned.key, ENV_SENTINEL, ARG_SENTINEL, LEAK]) assert(!text.includes(secret), `${name} contains ${secret.slice(0, 12)}…`);
  }
  // owners.json holds the hash, 0600, in a 0700 dir; the raw log is 0600.
  const ow = JSON.parse(fs.readFileSync(path.join(MUX_DIR, 'owners.json'), 'utf8'))[owned.id];
  assert.equal(ow.owner, 'zdte'); assert.match(ow.keyHash, /^[0-9a-f]{64}$/); assert.notEqual(ow.keyHash, owned.key);
  assert.equal(fs.statSync(path.join(MUX_DIR, 'owners.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(MUX_DIR).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(MUX_DIR, owned.id + '.ndjson')).mode & 0o777, 0o600);
});

test('cleanEnv: the child gets the given env and the basics, nothing of the server’s', async () => {
  // A plain child, left running long enough to have dumped its env (the ones above were
  // stopped as soon as they started, some before the wrapper got that far).
  const plain = (await create({ bin: 'claude-m13', cwd: work })).j.session;
  await until(async () => (await req('GET', '/mux/api/sessions/' + plain.id, { token: true })).j.state.status !== 'starting');
  await req('POST', `/mux/api/sessions/${plain.id}/stop?force=1`, { token: true, body: {} });
  const files = fs.readdirSync(dumps).map(f => fs.readFileSync(path.join(dumps, f), 'utf8'));
  const env = files.find(t => t.includes('M13_SENTINEL='));
  assert(env, 'the owned child dumped its env');
  const keys = env.split('\n').filter(Boolean).map(l => l.split('=')[0]);
  assert(env.includes('CLAUDE_CODE_ENTRYPOINT=ccbb-mux'));
  assert(keys.includes('HOME') && keys.includes('PATH'));
  assert(!env.includes(LEAK), 'a server variable reached a cleanEnv child');
  assert(!keys.includes('CCBB_HOME'));
  // And a plain child still inherits, as before.
  assert(files.some(t => t.includes(LEAK)), 'a non-cleanEnv child inherits the server env');
  const { childEnv } = require('../ccbb-mux');
  const e = childEnv({ X: '1' }, true);
  assert.deepEqual(Object.keys(e).filter(k => !['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'TMPDIR', 'CLAUDE_CONFIG_DIR'].includes(k)).sort(), ['CLAUDE_CODE_ENTRYPOINT', 'X']);
});

test('a locked session refuses mode, model, stop, resume and fork without its key', async () => {
  const { id, key } = owned;
  let r = await req('POST', `/mux/api/sessions/${id}/stop`, { token: true, body: {} });
  assert.equal(r.status, 403); assert.equal(r.j.reason, 'owned');
  r = await req('POST', `/mux/api/sessions/${id}/stop`, { token: true, body: {}, key: 'f'.repeat(64) });
  assert.equal(r.status, 403);
  r = await req('POST', `/mux/api/sessions/${id}/submit`, { token: true, body: { text: 'hi' } });
  assert.equal(r.status, 403);
  const c = wsOpen('/mux/mux?session=' + id, { token: true });
  assert(await c.opened);
  await until(() => c.msgs.find(m => m.op === 'snapshot'));
  for (const m of [{ op: 'set_mode', mode: 'bypassPermissions' }, { op: 'set_model', model: 'opus' }, { op: 'stop' }]) {
    const a = await c.op(m);
    assert(a && a.error, m.op + ' was not refused');
  }
  // Slash commands that change the session behind its owner; /compact and friends pass.
  assert.match((await c.op({ op: 'submit', text: '/clear' })).error || '', /owner/);
  assert.match((await c.op({ op: 'submit', text: '/model sonnet' })).error || '', /owner/);
  assert.match((await c.op({ op: 'submit', content: [{ type: 'text', text: '/clear' }] })).error || '', /owner/);
  // Any text block, not just the first; zero-width characters do not hide a command.
  assert.match((await c.op({ op: 'submit', content: [{ type: 'text', text: '' }, { type: 'text', text: '/model sonnet' }] })).error || '', /owner/);
  assert.match((await c.op({ op: 'submit', content: [{ type: 'text', text: 'hello' }, { type: 'text', text: '/clear' }] })).error || '', /owner/);
  assert.match((await c.op({ op: 'submit', text: '\u200b/model sonnet' })).error || '', /owner/);
  // close only leaves.
  const cl = await c.op({ op: 'close' });
  assert.equal(cl.stopped, false);
  c.ws.close();
  await sleep(300);
  assert.notEqual((await req('GET', '/mux/api/sessions/' + id, { token: true })).j.state.status, 'exited');
  // Resume and fork of an owned id, from HTTP without the key and from the socket.
  r = await create({ bin: 'claude-m13', cwd: work, resume: id, fork: true });
  assert.equal(r.status, 403); assert.equal(r.j.reason, 'owned');
  r = await create({ bin: 'claude-m13', cwd: work, sessionId: id });
  assert.equal(r.status, 403);
  const d = wsOpen('/mux/mux', { token: true }); assert(await d.opened);
  assert.equal((await d.op({ op: 'new', options: { bin: 'claude-m13', cwd: work, resume: id, fork: true } })).reason, 'owned');
  d.ws.close();
  // A fork WITH the key is allowed, and is the owner's too.
  r = await create({ bin: 'claude-m13', cwd: work, resume: id, fork: true }, { key });
  assert.equal(r.status, 200, r.text);
  await req('POST', `/mux/api/sessions/${r.j.session.id}/stop?force=1`, { token: true, body: {} });
});

test('submit over HTTP: one turn per idempotency key; tool requests are auto-denied', async () => {
  const { id, key } = owned;
  const turns = async () => (await req('GET', '/mux/api/sessions/' + id, { token: true })).j.messages.filter(m => m.role === 'user' && !m.compact && !m.command).length;
  const before = await turns();
  const a = await req('POST', `/mux/api/sessions/${id}/submit`, { token: true, key, body: { text: 'turn one', idempotencyKey: 'k1' } });
  assert.equal(a.status, 200, a.text); assert.equal(a.j.ok, true); assert.equal(typeof a.j.seq, 'number');
  const b = await req('POST', `/mux/api/sessions/${id}/submit`, { token: true, key, body: { text: 'turn one', idempotencyKey: 'k1' } });
  assert.equal(b.status, 200); assert.equal(b.j.duplicate, true); assert.equal(b.j.seq, a.j.seq);
  assert.equal((await req('POST', `/mux/api/sessions/${id}/submit`, { token: true, key, body: { idempotencyKey: 'k2' } })).status, 400);
  // agent-auth sign-in while a Claude session is busy: refused before anything runs.
  const auth = await req('POST', '/mux/api/agent-auth/login', { token: true, body: { bin: 'claude-m13' } });
  assert.equal(auth.status, 409, auth.text);
  await until(async () => (await req('GET', '/mux/api/sessions/' + id, { token: true })).j.state.status === 'idle', 100, 100);
  assert.equal(await turns(), before + 1, 'the duplicate submitted nothing');
  // Scene 2 asks can_use_tool; the owner's policy denies it with no one answering.
  await req('POST', `/mux/api/sessions/${id}/submit`, { token: true, key, body: { text: 'turn two', idempotencyKey: 'k3' } });
  const denied = await until(async () => {
    const s = (await req('GET', '/mux/api/sessions/' + id, { token: true })).j;
    return JSON.stringify(s.messages).includes('leaving it alone') && s.pending.length === 0;
  }, 100, 100);
  assert(denied, 'the permission request was not auto-denied');
});

test('a resumed owned session keeps its owner across a restart; noRemember leaves no memory', async () => {
  const { id, key } = owned;
  assert.equal((await req('POST', `/mux/api/sessions/${id}/stop`, { token: true, key, body: {} })).status, 200);
  await stopWeb(); await startWeb();
  let r = await create({ bin: 'claude-m13', cwd: work, resume: id });
  assert.equal(r.status, 403, r.text); assert.equal(r.j.reason, 'owned');
  r = await create({ bin: 'claude-m13', cwd: work, resume: id }, { key });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.session.owner, 'zdte'); assert.equal(r.j.ownerKey, key);
  assert.equal((await req('GET', '/api/session-info/' + id, { token: true })).j.owner, 'zdte');
  assert.equal((await req('POST', `/mux/api/sessions/${id}/stop`, { token: true, key, body: {} })).status, 200);
  // noRemember: a compactAt that is used but not remembered for the binary.
  const bins = async () => ((await req('GET', '/mux/api/bins', { token: true })).j.bins.find(b => b.name === 'claude-m13') || {}).compactAt;
  r = await create({ bin: 'claude-m13', cwd: work, compactAt: '300k', noRemember: true });
  assert.equal(r.status, 200, r.text); assert.equal(r.j.session.compactAt, 300000);
  assert.equal(await bins(), null);
  await req('POST', `/mux/api/sessions/${r.j.session.id}/stop?force=1`, { token: true, body: {} });
  r = await create({ bin: 'claude-m13', cwd: work, compactAt: '300k' });
  assert.equal(await bins(), 300000);
  await req('POST', `/mux/api/sessions/${r.j.session.id}/stop?force=1`, { token: true, body: {} });
});

test('owner: a caller key is the new session’s key; a retry gets that session; an owned id is not taken over', async () => {
  const crypto = require('crypto');
  const sha = k => crypto.createHash('sha256').update(k).digest('hex');
  const owners = () => JSON.parse(fs.readFileSync(path.join(MUX_DIR, 'owners.json'), 'utf8'));
  const key = crypto.randomBytes(32).toString('hex'), id = crypto.randomUUID();
  const mark = 'retry-' + process.pid;
  const body = { bin: 'claude-m13', cwd: work, owner: 'zdte', sessionId: id, env: { M13_RETRY: mark } };
  // A key that is not 64 hex is refused before anything starts.
  let r = await create({ ...body, sessionId: crypto.randomUUID() }, { key: 'not-a-key' });
  assert.equal(r.status, 400, r.text);
  // The caller's key is taken for a new id: the hash on disk is its hash.
  r = await create(body, { key });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.session.id, id); assert.equal(r.j.ownerKey, key);
  assert.equal(owners()[id].keyHash, sha(key));
  const startedAt = r.j.session.startedAt;
  await until(async () => (await req('GET', '/mux/api/sessions/' + id, { token: true })).j.state.status !== 'starting');
  // A retry of the same create (its reply lost): the same session, no second child.
  r = await create(body, { key });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.session.id, id); assert.equal(r.j.ownerKey, key); assert.equal(r.j.session.startedAt, startedAt);
  await sleep(500);
  assert.equal(fs.readdirSync(dumps).filter(f => fs.readFileSync(path.join(dumps, f), 'utf8').includes(mark)).length, 1, 'one child');
  assert.equal(owners()[id].keyHash, sha(key));
  // Another key, or none, never takes the owned id over.
  r = await create(body, { key: 'f'.repeat(64) });
  assert.equal(r.status, 403, r.text); assert.equal(r.j.reason, 'owned');
  r = await create(body);
  assert.equal(r.status, 403, r.text);
  r = await create({ bin: 'claude-m13', cwd: work, owner: 'other', resume: id }, { key: 'e'.repeat(64) });
  assert.equal(r.status, 403, r.text);
  assert.equal(owners()[id].keyHash, sha(key));
  // Stopped and resumed with its key: the same key and hash.
  assert.equal((await req('POST', `/mux/api/sessions/${id}/stop`, { token: true, key, body: {} })).status, 200);
  r = await create({ bin: 'claude-m13', cwd: work, owner: 'zdte', resume: id }, { key });
  assert.equal(r.status, 200, r.text); assert.equal(r.j.ownerKey, key);
  assert.equal(owners()[id].keyHash, sha(key));
  assert.equal((await req('POST', `/mux/api/sessions/${id}/stop`, { token: true, key, body: {} })).status, 200);
  // An unowned id still in the mux is not created a second time.
  const plain = (await create({ bin: 'claude-m13', cwd: work, sessionId: crypto.randomUUID() })).j.session;
  r = await create({ bin: 'claude-m13', cwd: work, sessionId: plain.id });
  assert.equal(r.status, 409, r.text); assert.equal(r.j.reason, 'id-in-use');
  // An unowned session resumed in place by an owner with its own key: that key.
  assert.equal((await req('POST', `/mux/api/sessions/${plain.id}/stop?force=1`, { token: true, body: {} })).status, 200);
  const k2 = crypto.randomBytes(32).toString('hex');
  r = await create({ bin: 'claude-m13', cwd: work, owner: 'zdte', resume: plain.id }, { key: k2 });
  assert.equal(r.status, 200, r.text); assert.equal(r.j.ownerKey, k2);
  assert.equal(owners()[plain.id].keyHash, sha(k2));
  await req('POST', `/mux/api/sessions/${plain.id}/stop?force=1`, { token: true, body: {}, key: k2 });
});

test('health names the mux dir and the Claude config dir', async () => {
  const r = await req('GET', '/mux/api/health', { token: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.muxDir, MUX_DIR); assert.equal(r.j.configDir, dir);
});

test('existing raw logs are tightened when the mux starts', async () => {
  const f = path.join(MUX_DIR, 'old-session.ndjson');
  fs.writeFileSync(f, '{}\n', { mode: 0o644 }); fs.chmodSync(f, 0o644); fs.chmodSync(MUX_DIR, 0o755);
  await stopWeb(); await startWeb();
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(fs.statSync(MUX_DIR).mode & 0o777, 0o700);
});

test('a resumed transcript keeps its compaction seam', () => {
  const common = require('../ccbb-common');
  const { Session } = require('../ccbb-mux');
  const file = path.join(dir, 'h.jsonl');
  const line = o => JSON.stringify(o);
  fs.writeFileSync(file, [
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'before the seam' } }),
    line({ type: 'system', subtype: 'compact_boundary', uuid: 'b1', compactMetadata: { trigger: 'auto', preTokens: 500000, postTokens: 9000, durationMs: 1000 } }),
    line({ type: 'user', uuid: 's1', isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: 'user', content: 'THE SUMMARY' } }),
    line({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'after the seam' } }),
  ].join('\n') + '\n');
  const orig = common.findSessionJsonl;
  common.findSessionJsonl = () => file;
  // A real history-only Session (no child, no log): a hand-built stub misses whatever
  // onModelMessage grew since, and its try/catch hides that as an empty transcript.
  let sess;
  try { sess = new Session({}, { historyOnly: true, resume: 'x', cwd: dir }); } finally { common.findSessionJsonl = orig; }
  const summary = sess.messages.find(m => m.compact);
  assert(summary, 'the summary is tagged as a compaction');
  assert.equal(summary.compact.trigger, 'auto'); assert.equal(summary.compact.preTokens, 500000);
  assert.equal(sess.messages.filter(m => !m.compact).length, 2);
  assert.equal(sess._compactMeta, null);
  assert.equal(sess.seq, 0);
});

// The sanitizer, in a real browser: it is a <template> walk, which nothing short of a
// DOM can run. Loaded from ccbb web's own mux page, which also proves the page boots
// under its CSP.
test('the public sign-in locks after repeated failures', async () => {
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  let r;
  for (let i = 0; i < 12; i++) r = await pub('POST', '/mux/login', { body: 'token=nope', headers: form });
  assert.equal(r.status, 429);
  r = await pub('POST', '/mux/login', { body: 'token=' + TOKEN, headers: form });
  assert.equal(r.status, 429); assert.equal(r.headers['set-cookie'], undefined);
});

test('safeHtml strips scripts, handlers, javascript: URLs and frames', { skip: !process.env.CHROME && 'set CHROME' }, async () => {
  const made = (await create({ bin: 'claude-m13', cwd: work, owner: 'zdte' })).j;
  const s = made.session;
  const prof = path.join(dir, 'chrome');
  const chrome = spawn(process.env.CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=0', '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore', detached: true });
  try {
    const dt = path.join(prof, 'DevToolsActivePort');
    assert(await until(() => fs.existsSync(dt)), 'DevTools');
    const cport = fs.readFileSync(dt, 'utf8').split('\n')[0];
    const tabs = await (await fetch(`http://127.0.0.1:${cport}/json`)).json();
    const cdp = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise(r => cdp.once('open', r));
    let n = 0; const waiting = new Map();
    const thrown = [];
    cdp.on('message', raw => { const m = JSON.parse(raw);
      if (m.method === 'Runtime.exceptionThrown') thrown.push(JSON.stringify(m.params.exceptionDetails).slice(0, 600));
      if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
    const send = (method, params = {}) => new Promise(r => { const id = ++n; waiting.set(id, r); cdp.send(JSON.stringify({ id, method, params })); });
    const ev = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r.result && r.result.result && r.result.result.value; };
    await send('Runtime.enable');
    // Every CSP violation on the page, from before its first script runs.
    await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || '') + ' ' + (e.sourceFile || '') + ':' + e.lineNumber));` });
    // The session page's policy: scripts from itself, its pinned CDN files and its own
    // inline scripts by hash — never unsafe-inline or unsafe-eval.
    const head = await req('GET', `/mux/s/${s.id}`, { token: true });
    assert.equal(head.status, 200, head.status + ' ' + head.text.slice(0, 200));
    const csp = head.headers['content-security-policy'] || '';
    assert.match(csp, /script-src 'self' /); assert(!/unsafe-/.test(csp), csp);
    assert.match(csp, /'sha256-/);
    assert(!/@1[12]\//.test(head.text), 'a CDN asset is not pinned to an exact version');
    for (const tag of head.text.match(/<(script src|link rel="stylesheet")[^>]*>/g)) assert.match(tag, /integrity="sha384-[^"]+" crossorigin="anonymous"/, tag);
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/mux/s/${s.id}?token=${TOKEN}` });
    assert(await until(() => ev('typeof safeHtml === "function" && !!window.ccbb'), 100, 100), 'the mux page booted: ' + await ev('location.href + " " + typeof safeHtml + " " + document.title + " " + document.body.innerText.slice(0,200)') + ' ' + thrown.join(' / '));
    // An owned session's page: the badge, no mode picker, and "sessions" stays in /mux.
    const bar = await until(() => ev(`(() => { const b = document.querySelector('.mx-owner'); return b && b.textContent ? { owner: b.textContent,
      mode: document.querySelector('.mx-mode').hidden, up: document.querySelector('.mx-up').getAttribute('href') } : null; })()`), 50, 100);
    assert.deepEqual(bar, { owner: 'zdte', mode: true, up: '/mux/' });
    // The page booted under its policy without tripping it once.
    assert.deepEqual(await ev('window.__csp'), []);
    const cases = {
      '<p>hi<script>alert(1)</script></p>': h => !/script/i.test(h) && /hi/.test(h),
      '<img src="x.png" onerror="alert(1)">': h => !/onerror/i.test(h),
      '<a href="javascript:alert(1)">x</a>': h => !/javascript:/i.test(h) && />x</.test(h),
      '<a href=" JaVaScRiPt:alert(1)">x</a>': h => !/javascript/i.test(h),
      '<iframe src="https://evil.test"></iframe>ok': h => !/iframe/i.test(h) && /ok/.test(h),
      '<svg><script>alert(1)</script></svg>': h => !/script|svg/i.test(h),
      '<div style="x" onclick="a()"><b onmouseover="b()">bold</b></div>': h => !/on(click|mouseover)/i.test(h) && /<b>bold<\/b>/.test(h),
      '<a href="https://ok.test/">ok</a>': h => /href="https:\/\/ok.test\/"/.test(h) && /noopener/.test(h),
      '<object data="x"></object><embed src="y"><form action="z"><input name="q"></form>': h => !/object|embed|form|name="q"/i.test(h),
      '<img src="data:image/svg+xml,<svg onload=alert(1)>">': h => !/svg\+xml/i.test(h),
      '<button class="allow perm-btn">Allow</button><code class="language-js hljs fake">x</code>': h => !/allow|perm-btn|fake/.test(h.replace('>Allow<', '')) && /class="language-js hljs"/.test(h),
    };
    for (const [input, ok] of Object.entries(cases)) {
      const h = await ev(`safeHtml(${JSON.stringify(input)})`);
      assert(ok(h), input + ' → ' + h);
    }
    // And marked's own output for a hostile message goes through it.
    // marked and highlight.js loaded (their integrity matched, the policy let them run).
    assert.deepEqual(await until(() => ev(`typeof marked === 'object' && typeof marked.parse === 'function' && typeof hljs === 'object' ? 'ok' : ''`), 50, 100), 'ok');
    const md = await ev(`safeHtml(marked.parse('[x](javascript:alert(1)) <img src=x onerror=alert(1)>'))`);
    assert(!/javascript:|onerror/i.test(md), md);
    // A script injected the way a hostile reply would try it is refused by the policy.
    await ev(`(() => { const s = document.createElement('script'); s.textContent = 'window.__ran = 1'; document.body.appendChild(s); })()`);
    await sleep(200);
    assert.equal(await ev('window.__ran === 1'), false);
    // (The handlers in the cases above are reported too — Chrome checks them as the inert
    // template parses them — but none of them is the page's own.)
    const v = await ev('window.__csp');
    assert(v.some(x => /^script-src-elem inline/.test(x)), JSON.stringify(v));
    cdp.close();
  } finally {
    try { process.kill(-chrome.pid, 'SIGKILL'); } catch {}
    await req('POST', `/mux/api/sessions/${s.id}/stop?force=1`, { token: true, body: {}, key: made.ownerKey });
  }
});
