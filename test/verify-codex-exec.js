'use strict';
// Owned Codex sessions as `codex exec`, a process per turn (ccbb-codex-exec.js). One ccbb
// web on a free port with a throwaway config dir; `codex` is test/fake-codex-exec.js, so
// nothing here reaches a model or the app-server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-exec-'));
const TOKEN = 'tok-exec-' + process.pid;
const ENV_SENTINEL = 'env-sentinel-' + process.pid;
const ARG_SENTINEL = 'arg-sentinel-' + process.pid;
const MUX_DIR = path.join(dir, 'ccbb-mux');
const bin = path.join(dir, 'bin'), runs = path.join(dir, 'runs'), work = path.join(dir, 'work');
for (const d of [bin, runs, work]) fs.mkdirSync(d);
fs.writeFileSync(path.join(dir, 'ccbb-config.json'), JSON.stringify({ peerToken: TOKEN }));
fs.writeFileSync(path.join(bin, 'codex'), `#!/bin/bash\nexport FAKE_RUNS=${JSON.stringify(runs)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(__dirname, 'fake-codex-exec.js'))} "$@"\n`, { mode: 0o755 });

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, tries = 100, gap = 100) {
  for (let i = 0; i < tries; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(gap); }
  return null;
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
let port, web, out = '';
const freePort = () => new Promise(r => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
function req(method, p, o = {}) {
  const headers = { host: `127.0.0.1:${port}`, 'x-ccbb-token': TOKEN };
  if (o.key) headers['x-ccbb-owner-key'] = o.key;
  let body = o.body;
  if (body !== undefined) { body = JSON.stringify(body); headers['content-type'] = 'application/json'; }
  return new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, x => {
      let b = ''; x.setEncoding('utf8'); x.on('data', d => { b += d; });
      x.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} res({ status: x.statusCode, text: b, j }); });
    });
    r.on('error', rej);
    if (body !== undefined) r.write(body);
    r.end();
  });
}
function wsOpen(p) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${p}`, { headers: { host: `127.0.0.1:${port}`, 'x-ccbb-token': TOKEN } });
  const msgs = [];
  ws.on('message', d => { try { msgs.push(JSON.parse(d)); } catch {} });
  const opened = new Promise(r => { ws.once('open', () => r(true)); ws.once('error', () => r(false)); ws.once('close', () => r(false)); });
  let n = 0;
  const op = async m => {
    const id = 'm' + (++n); ws.send(JSON.stringify({ ...m, id }));
    return until(() => msgs.find(x => x.op === 'ack' && x.id === id), 50, 100);
  };
  return { ws, msgs, opened, op };
}
const create = (body, key) => req('POST', '/mux/api/sessions', { body, key });
const snap = async id => (await req('GET', '/mux/api/sessions/' + id)).j;
const idle = id => until(async () => { const s = await snap(id); return s.state.status === 'idle' && s.state.nativeId && s; }, 100, 100);
const runArgs = () => fs.readdirSync(runs).filter(f => f.startsWith('args.')).sort().map(f => JSON.parse(fs.readFileSync(path.join(runs, f), 'utf8')));
const owners = () => JSON.parse(fs.readFileSync(path.join(MUX_DIR, 'owners.json'), 'utf8'));
const ARGS = ['--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', 'x_sentinel="' + ARG_SENTINEL + '"'];
const body = (o = {}) => ({ agent: 'codex', cwd: work, owner: 'zdte', cleanEnv: true, env: { M13_SENTINEL: ENV_SENTINEL }, args: ARGS, sessionId: crypto.randomUUID(), ...o });

test.before(async () => {
  port = await freePort();
  web = spawn(process.execPath, [path.join(__dirname, '..', 'ccbb-web.js'), '-p', String(port)], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CCBB_HOME: dir, PATH: bin + path.delimiter + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  web.stdout.on('data', d => { out += d; }); web.stderr.on('data', d => { out += d; });
  if (!await until(async () => (await req('GET', '/api/identity')).status === 200)) throw new Error('ccbb web never came up\n' + out);
});
test.after(async () => {
  if (web) {
    const gone = new Promise(r => web.once('exit', r));
    try { process.kill(-web.pid, 'SIGTERM'); } catch {}
    await Promise.race([gone, sleep(3000)]);
    try { process.kill(-web.pid, 'SIGKILL'); } catch {}
  }
  for (const f of fs.readdirSync(runs).filter(f => /^(sleep|orphan)\./.test(f))) { try { process.kill(Number(fs.readFileSync(path.join(runs, f), 'utf8')), 'SIGKILL'); } catch {} }
  fs.rmSync(dir, { recursive: true, force: true });
});

let first;   // { id, key, tid }

test('an owned Codex session runs exec turns with its owner\'s args; the thread is the owner\'s', async () => {
  const b = body();
  const r = await create(b);
  assert.equal(r.status, 200, r.text);
  const id = r.j.session.id, key = r.j.ownerKey;
  assert.equal(id, b.sessionId);
  assert.equal(r.j.session.owner, 'zdte');
  // Nothing runs before the first turn.
  assert.equal(runArgs().length, 0);
  const s1 = await req('POST', `/mux/api/sessions/${id}/submit`, { key, body: { text: 'hello one', idempotencyKey: 'a' } });
  assert.equal(s1.status, 200, s1.text);
  const s = await idle(id);
  assert(s, 'the turn never ended\n' + out);
  const tid = s.state.nativeId;
  assert.equal(s.state.engine, 'exec');
  const text = JSON.stringify(s.messages);
  assert(text.includes('hello one') && text.includes('echo: hello one'), text);
  assert(s.messages.some(m => m.role === 'user'), 'no user message');
  // Both spellings of the thread are the owner's, under the session's key hash.
  const ow = owners();
  assert.equal(ow[tid].keyHash, ow[id].keyHash); assert.equal(ow['codex:' + tid].keyHash, ow[id].keyHash);
  // A second turn resumes that thread with the same args, and no -C.
  await req('POST', `/mux/api/sessions/${id}/submit`, { key, body: { text: 'hello two', idempotencyKey: 'b' } });
  await until(async () => (await snap(id)).state.turns === 2);
  const [a1, a2] = runArgs();
  assert.deepEqual(a1, ['exec', '--json', '-C', work, ...ARGS, '-']);
  assert.deepEqual(a2, ['exec', 'resume', tid, '--json', ...ARGS, '-']);
  // The child's env is the given one and the basics, nothing of the server's.
  const env = JSON.parse(fs.readFileSync(path.join(runs, fs.readdirSync(runs).find(f => f.startsWith('env.'))), 'utf8'));
  assert.equal(env.M13_SENTINEL, ENV_SENTINEL);
  assert.equal(env.CCBB_HOME, undefined);
  first = { id, key, tid };
});

test('list, snapshot and logs carry no key, env or args', async () => {
  const { id, key } = first;
  const list = (await req('GET', '/mux/api/sessions')).text;
  const one = (await req('GET', '/mux/api/sessions/' + id)).text;
  const rows = (await req('GET', '/api/sessions')).text;
  const logs = fs.existsSync(MUX_DIR) ? fs.readdirSync(MUX_DIR).filter(f => f.endsWith('.ndjson')).map(f => fs.readFileSync(path.join(MUX_DIR, f), 'utf8')).join('\n') : '';
  for (const [name, text] of Object.entries({ list, one, rows, logs, out }))
    for (const secret of [key, ENV_SENTINEL, ARG_SENTINEL]) assert(!text.includes(secret), `${name} contains ${secret.slice(0, 12)}…`);
});

test('the owned thread is not resumed on the app-server, or as exec without its key', async () => {
  const { tid } = first;
  for (const resume of [tid, 'codex:' + tid]) {
    const r = await create({ agent: 'codex', cwd: work, resume });
    assert.equal(r.status, 403, r.text);
  }
  const r = await create(body({ resume: 'codex:' + tid, sessionId: first.id }), crypto.randomBytes(32).toString('hex'));
  assert.equal(r.status, 403, r.text);
  // With its key, while it runs: refused as running, not started twice.
  const again = await create(body({ resume: 'codex:' + tid, sessionId: first.id }), first.key);
  assert.equal(again.status, 409, again.text);
});

test('an unowned thread resumed as exec becomes the owner\'s', async () => {
  const tid = crypto.randomUUID(), b = body({ resume: 'codex:' + tid });
  const r = await create(b);
  assert.equal(r.status, 200, r.text);
  const ow = owners();
  assert.equal(ow[tid].keyHash, ow[b.sessionId].keyHash); assert.equal(ow['codex:' + tid].keyHash, ow[b.sessionId].keyHash);
  assert.equal((await create({ agent: 'codex', cwd: work, resume: tid })).status, 403);
  assert.equal((await req('POST', `/mux/api/sessions/${b.sessionId}/stop`, { key: r.j.ownerKey, body: {} })).status, 200);
});

test('bad options are refused before anything starts', async () => {
  const before = runArgs().length;
  for (const bad of [
    { model: 'x' }, { sandbox: 'danger-full-access' }, { config: { a: 1 } }, { approvalPolicy: 'never' },
    { args: undefined }, { args: ['ok', 3] }, { args: ['resume', 'x'] }, { args: ['-C', '/'] }, { args: ['--cd=/'] },
    { args: ['--json'] }, { args: ['-'] }, { sessionId: undefined },
  ]) {
    const r = await create(body(bad));
    assert.equal(r.status, 400, JSON.stringify(bad) + ' ' + r.text);
  }
  // cleanEnv without an owner: Codex on the app-server cannot honour it.
  assert.equal((await create({ agent: 'codex', cwd: work, cleanEnv: true })).status, 400);
  assert.equal(runArgs().length, before);
});

test('a non-owner may not send a slash command or stop it', async () => {
  const { id, key } = first;
  const c = wsOpen('/mux/mux?session=' + id);
  assert(await c.opened);
  await until(() => c.msgs.find(m => m.op === 'snapshot'));
  const before = runArgs().length;
  const a = await c.op({ op: 'submit', text: '/status' });
  assert(a && a.error, JSON.stringify(a));
  assert.equal((await req('POST', `/mux/api/sessions/${id}/stop`, { body: {} })).status, 403);
  assert.equal((await req('POST', `/mux/api/sessions/${id}/submit`, { body: { text: 'hi' } })).status, 403);
  c.ws.close();
  await sleep(300);
  assert.equal(runArgs().length, before);
  assert.equal((await snap(id)).state.status, 'idle');
  void key;
});

test('interrupt ends the turn and the command it started, outside exec\'s group', async () => {
  const { id, key } = first;
  await req('POST', `/mux/api/sessions/${id}/submit`, { key, body: { text: 'SLEEP now', idempotencyKey: 'c' } });
  const pidFile = await until(() => fs.readdirSync(runs).find(f => f.startsWith('sleep.')), 100, 100);
  assert(pidFile, 'the fake never started its command');
  const pid = Number(fs.readFileSync(path.join(runs, pidFile), 'utf8'));
  assert(alive(pid));
  const c = wsOpen('/mux/mux?session=' + id);
  assert(await c.opened);
  await until(() => c.msgs.find(m => m.op === 'snapshot'));
  const ack = await c.op({ op: 'interrupt' });
  assert(ack && ack.ok, JSON.stringify(ack));
  c.ws.close();
  assert(await until(() => !alive(pid), 50, 100), 'the command outlived the interrupt');
  assert(await idle(id), 'the session did not come back idle');
  fs.rmSync(path.join(runs, pidFile));
});

test('interrupt also ends what a command backgrounded and left behind', async () => {
  const { id, key } = first;
  await req('POST', `/mux/api/sessions/${id}/submit`, { key, body: { text: 'ORPHAN now', idempotencyKey: 'o' } });
  const f = await until(() => { const n = fs.readdirSync(runs).find(x => x.startsWith('orphan.')); return n && fs.readFileSync(path.join(runs, n), 'utf8').trim() && n; }, 100, 100);
  assert(f, 'the fake never backgrounded its command');
  const pid = Number(fs.readFileSync(path.join(runs, f), 'utf8'));
  assert(await until(() => { try { return require('child_process').execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim() === '1'; } catch { return false; } }, 50, 100), 'not reparented');
  const c = wsOpen('/mux/mux?session=' + id);
  assert(await c.opened);
  await until(() => c.msgs.find(m => m.op === 'snapshot'));
  assert((await c.op({ op: 'interrupt' })).ok);
  c.ws.close();
  assert(await until(() => !alive(pid), 50, 100), 'the orphan outlived the interrupt');
  assert(await idle(id));
  fs.rmSync(path.join(runs, f));
});

test('stop with the key ends the running turn\'s tree; the session exits', async () => {
  const { id, key } = first;
  await req('POST', `/mux/api/sessions/${id}/submit`, { key, body: { text: 'SLEEP again', idempotencyKey: 'd' } });
  const pidFile = await until(() => fs.readdirSync(runs).find(f => f.startsWith('sleep.')), 100, 100);
  assert(pidFile);
  const pid = Number(fs.readFileSync(path.join(runs, pidFile), 'utf8'));
  const r = await req('POST', `/mux/api/sessions/${id}/stop`, { key, body: {} });
  assert.equal(r.status, 200, r.text);
  assert(await until(() => !alive(pid), 50, 100), 'the command outlived stop');
  assert.equal((await req('GET', '/mux/api/sessions/' + id)).status, 404);
  fs.rmSync(path.join(runs, pidFile));
});

test('resumed with its key after stop: the same thread, the owner\'s args again', async () => {
  const { id, key, tid } = first;
  const r = await create(body({ resume: 'codex:' + tid, sessionId: id }), key);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.j.session.id, id);
  await req('POST', `/mux/api/sessions/${id}/submit`, { key, body: { text: 'after resume', idempotencyKey: 'e' } });
  const s = await idle(id);
  assert(s && JSON.stringify(s.messages).includes('echo: after resume'));
  // What came before the resume is there too (read alongside the turn), ahead of it.
  const texts = await until(async () => { const t = JSON.stringify((await snap(id)).messages); return t.includes('before resume') && t; }, 50, 100) || '';
  assert(texts.includes('before resume') && texts.indexOf('before resume') < texts.indexOf('echo: after resume'), texts.slice(0, 400));
  assert.equal(s.state.nativeId, tid);
  assert.deepEqual(runArgs().at(-1), ['exec', 'resume', tid, '--json', ...ARGS, '-']);
});

test('shutdown kills a running turn\'s tree', async () => {
  const { id, key } = first;
  await req('POST', `/mux/api/sessions/${id}/submit`, { key, body: { text: 'SLEEP last', idempotencyKey: 'f' } });
  const pidFile = await until(() => fs.readdirSync(runs).find(f => f.startsWith('sleep.')), 100, 100);
  assert(pidFile);
  const pid = Number(fs.readFileSync(path.join(runs, pidFile), 'utf8'));
  const gone = new Promise(r => web.once('exit', r));
  process.kill(web.pid, 'SIGTERM');
  await Promise.race([gone, sleep(5000)]);
  web = null;
  assert(await until(() => !alive(pid), 50, 100), 'the command outlived ccbb');
});
