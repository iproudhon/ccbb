'use strict';
// Model and Compact at for a new session: parsing, the per-binary memory the dialog reads
// back, what reaches a Claude child (env, through a wrapper that clears it) and a Codex
// thread (config on start/resume/fork). Fake binaries only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-new-opts-'));
process.env.CLAUDE_CONFIG_DIR = dir;
process.env.CCBB_HOME = dir;
delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; delete process.env.CCBB_COMPACT_WINDOW;
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
process.env.PATH = bin + path.delimiter + process.env.PATH;
const out = path.join(dir, 'out');
function script(name, body) { fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\n' + body, { mode: 0o755 }); }
// Records what it was started with, then idles like a child waiting for input.
script('claude', `echo "\${CLAUDE_CODE_AUTO_COMPACT_WINDOW:-unset} $*" > ${out}.$$; echo $$ >> ${out}.pids; exec sleep 30`);
// The ~/bin/claude.sh shape: clear the variable, set up the mode, re-export ccbb's.
script('claude.wrap', `unset CLAUDE_CODE_AUTO_COMPACT_WINDOW
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=280000
[ -n "\${CCBB_COMPACT_WINDOW:-}" ] && export CLAUDE_CODE_AUTO_COMPACT_WINDOW="\${CCBB_COMPACT_WINDOW}"
exec ${path.join(bin, 'claude')} "$@"`);
script('codex', 'exit 0');

const mux = require('../ccbb-mux');
const { parseCompactAt, binKey, Mux } = mux;
let server, base, m;
test.before(async () => {
  m = new Mux();
  server = http.createServer((req, res) => m.onHttp(req, res, req.url.replace(/^\/mux/, '')));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/mux/api`;
});
test.after(async () => {
  await m.stopAll();
  try { for (const p of fs.readFileSync(out + '.pids', 'utf8').split('\n').filter(Boolean)) try { process.kill(+p); } catch {} } catch {}
  server.close(); fs.rmSync(dir, { recursive: true, force: true });
});
const post = async (u, body) => { const r = await fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, j: await r.json() }; };
const bins = async () => Object.fromEntries((await (await fetch(base + '/bins')).json()).bins.map(b => [b.name, b.compactAt]));
async function childLine() {
  for (let i = 0; i < 100; i++) {
    const f = fs.readdirSync(dir).filter(n => /^out\.\d+$/.test(n));
    if (f.length) { const t = fs.readFileSync(path.join(dir, f[0]), 'utf8'); fs.rmSync(path.join(dir, f[0])); return t.trim(); }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('child never started');
}

test('parseCompactAt', () => {
  assert.equal(parseCompactAt('200k'), 200000);
  assert.equal(parseCompactAt('1.5M'), 1500000);
  assert.equal(parseCompactAt(150000), 150000);
  assert.equal(parseCompactAt('default'), null);
  assert.equal(parseCompactAt(''), null);
  assert.throws(() => parseCompactAt('5k'), /between/);
  assert.throws(() => parseCompactAt('lots'), /between/);
});

test('binKey: a name and its path are one key; symlinks stay apart', () => {
  fs.symlinkSync('claude.wrap', path.join(bin, 'claude.other'));
  assert.equal(binKey('claude.wrap'), path.join(bin, 'claude.wrap'));
  assert.equal(binKey(path.join(bin, 'claude.wrap')), binKey('claude.wrap'));
  assert.notEqual(binKey('claude.other'), binKey('claude.wrap'));
});

test('claude: Compact at reaches the child, through a wrapper too, and is remembered per binary', async () => {
  let r = await post('/sessions', { bin: 'claude', cwd: dir, compactAt: '300k', model: 'opus' });
  assert.equal(r.status, 200, JSON.stringify(r.j));
  assert.equal(r.j.session.compactAt, 300000);
  assert.match(await childLine(), /^300000 .*--model opus/);
  r = await post('/sessions', { bin: path.join(bin, 'claude.wrap'), cwd: dir, compactAt: '500k' });
  assert.match(await childLine(), /^500000 /);
  let b = await bins();
  assert.equal(b.claude, 300000); assert.equal(b['claude.wrap'], 500000, 'a path and a name share the key');
  // Absent: nothing set (the wrapper's own value stands), nothing changed in memory.
  await post('/sessions', { bin: 'claude.wrap', cwd: dir });
  assert.match(await childLine(), /^280000 /);
  assert.equal((await bins())['claude.wrap'], 500000);
  // 'remembered' (a restart) applies it; 'default' clears it.
  await post('/sessions', { bin: 'claude.wrap', cwd: dir, compactAt: 'remembered' });
  assert.match(await childLine(), /^500000 /);
  await post('/sessions', { bin: 'claude.wrap', cwd: dir, compactAt: 'default' });
  assert.match(await childLine(), /^280000 /);
  assert.equal((await bins())['claude.wrap'], null);
  assert.equal((await post('/sessions', { bin: 'claude', cwd: dir, compactAt: '1k' })).status, 400);
});

test('codex: Compact at and model go into the thread config on start, resume and fork', async () => {
  const seen = [];
  require('../ccbb-codex-session').createCodexSession = async (mx, opt) => { seen.push(opt); return { state: { id: 'codex:x' } }; };
  await post('/sessions', { agent: 'codex', bin: 'codex', compactAt: '250k', model: 'gpt-x' });
  assert.deepEqual(seen[0].config, { model_auto_compact_token_limit: 250000 });
  assert.equal(seen[0].model, 'gpt-x');
  assert.equal((await bins()).codex, 250000);
  await post('/sessions', { agent: 'codex', bin: 'codex', resume: 'codex:t1', compactAt: 'remembered' });
  assert.deepEqual(seen[1].config, { model_auto_compact_token_limit: 250000 });
  await post('/sessions', { agent: 'codex', bin: 'codex', resume: 'codex:t2' });
  assert.equal(seen[2].config, undefined);
});

test('models: Claude aliases without asking anything', async () => {
  const r = await (await fetch(base + '/models?bin=claude.wrap')).json();
  assert(r.models.some(x => x.id === 'opus[1m]'));
});
