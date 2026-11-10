'use strict';
// Login status and login flows through the mux HTTP routes, against fake claude/codex
// binaries on PATH — nothing here touches a real account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-agent-auth-'));
process.env.CLAUDE_CONFIG_DIR = dir;
process.env.CCBB_HOME = dir;
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
process.env.PATH = bin + path.delimiter + process.env.PATH;

function script(name, body) { fs.writeFileSync(path.join(bin, name), '#!/usr/bin/env bash\n' + body, { mode: 0o755 }); }
const state = path.join(dir, 'state');
// claude.ok: logged in; claude: logs in once the code "good" arrives on stdin.
script('claude.ok', `echo '{"loggedIn":true,"authMethod":"third_party","apiProvider":"bedrock"}'`);
script('claude', `
if [ "$1 $2" = "auth status" ]; then
  if [ -f ${state}.claude ]; then echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; else echo '{"loggedIn":false,"authMethod":"none"}'; fi; exit 0; fi
if [ "$1 $2" = "auth login" ]; then
  printf 'Opening browser to sign in…\\nIf the browser didn'"'"'t open, visit: \\e]8;;https://claude.example/oauth?code=true&state=abc\\ahttps://claude.example/oauth?code=true&state=abc\\e]8;;\\a\\nPaste code here if prompted > '
  read -r code; [ "$code" = good ] && { touch ${state}.claude; echo 'Login successful.'; exit 0; }; echo 'Invalid code' >&2; exit 1; fi
exit 2`);
script('codex', `
if [ "$1 $2" = "login status" ]; then [ -f ${state}.codex ] && { echo 'Logged in using ChatGPT'; exit 0; }; echo 'Not logged in'; exit 1; fi
if [ "$1 $2" = "login --device-auth" ]; then
  printf '1. Open this link\\n   \\e[94mhttps://auth.example/codex/device\\e[0m\\n\\n2. Enter this one-time code\\n   \\e[94mAB12-CD34\\e[0m\\n'
  while [ ! -f ${state}.go ]; do sleep 0.1; done; touch ${state}.codex; echo 'Successfully logged in'; exit 0; fi
exit 2`);

// sso-hlp.js: --status exits 0 valid / 2 expired; a login prints what `aws sso login
// --use-device-code` does (bare device page, code, then the page with the code in it).
script('sso-hlp.js', `
case " $* " in
  *" --status "*) [ -f ${state}.aws ] && { echo 'dsa: live SSO check passed; last login 2026-11-10T01:59:32.871Z (0.3h ago; age is informational)'; exit 0; }
     echo 'dsa: no cached SSO login; no recorded login'; exit 2;;
esac
[ -f ${state}.aws ] && [ "$*" = "--no-notify" ] && { echo 'dsa: valid'; exit 0; }
echo "$*" > ${state}.awsargs
printf 'Attempting to open the SSO authorization page:\n\nhttps://device.sso.us-west-2.amazonaws.com/\n\nThen enter the code:\n\nWXYZ-ABCD\n\nhttps://device.sso.us-west-2.amazonaws.com/?user_code=WXYZ-ABCD\n' >&2
while [ ! -f ${state}.awsgo ]; do sleep 0.1; done; touch ${state}.aws; exit 0`);

const { Mux } = require('../ccbb-mux');
let server, base;
test.before(async () => {
  const mux = new Mux();
  server = http.createServer((req, res) => mux.onHttp(req, res, req.url.replace(/^\/mux/, '')));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/mux/api/agent-auth`;
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const get = async (u) => { const r = await fetch(base + u); return { status: r.status, j: await r.json() }; };
const send = async (u, method, body) => {
  const r = await fetch(base + u, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, j: await r.json() };
};

test('status by binary, and bad names refused', async () => {
  const ok = await get('?bin=claude.ok');
  assert.equal(ok.status, 200);
  assert.equal(ok.j.loggedIn, true); assert.equal(ok.j.provider, 'bedrock'); assert.equal(ok.j.agent, 'claude');
  assert.equal((await get('?bin=claude')).j.loggedIn, false);
  const cx = await get('?bin=codex');
  assert.equal(cx.j.loggedIn, false); assert.equal(cx.j.agent, 'codex');
  assert.equal((await get('?bin=nope')).status, 400);
  assert.equal((await get('?bin=claude.missing')).status, 400);
});

test('claude login: URL, then the pasted code finishes it', async () => {
  const s = await send('/login', 'POST', { bin: 'claude' });
  assert.equal(s.status, 200);
  assert.equal(s.j.login.state, 'waiting');
  assert.equal(s.j.login.url, 'https://claude.example/oauth?code=true&state=abc');
  assert.equal(s.j.login.needsCode, true);
  const bad = await send('/login/code', 'POST', { bin: 'codex', code: 'x' });
  assert.equal(bad.status, 404);
  const done = await send('/login/code', 'POST', { bin: 'claude', code: 'good' });
  assert.equal(done.j.login.state, 'done');
  assert.equal((await get('?bin=claude')).j.loggedIn, true, 'status cache dropped after login');
});

test('claude login: a wrong code fails with the CLI\'s message', async () => {
  fs.rmSync(state + '.claude', { force: true });
  await send('/login', 'POST', { bin: 'claude' });
  const r = await send('/login/code', 'POST', { bin: 'claude', code: 'bad' });
  assert.equal(r.j.login.state, 'failed');
  assert.match(r.j.login.error, /Invalid code/);
});

test('codex device login: URL + code, done once the CLI exits', async () => {
  const s = await send('/login', 'POST', { bin: 'codex' });
  assert.equal(s.j.login.url, 'https://auth.example/codex/device');
  assert.equal(s.j.login.userCode, 'AB12-CD34');
  assert.equal(s.j.login.needsCode, false);
  const again = await send('/login', 'POST', { bin: 'codex' });
  assert.equal(again.j.login.startedAt, s.j.login.startedAt, 'a second start returns the running flow');
  fs.writeFileSync(state + '.go', '');
  let l;
  for (let i = 0; i < 50; i++) { l = (await get('/login?bin=codex')).j.login; if (l.state !== 'waiting') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(l.state, 'done');
  assert.equal((await get('?bin=codex')).j.loggedIn, true);
});

test('cancel stops the flow', async () => {
  fs.rmSync(state + '.go', { force: true });
  await send('/login', 'POST', { bin: 'codex' });
  const c = await send('/login', 'DELETE', { bin: 'codex' });
  assert.equal(c.j.login.state, 'cancelled');
});

test('aws: status through sso-hlp, a device login, and missing elsewhere', async () => {
  const st = await get('?bin=sso-hlp.js');
  assert.equal(st.j.agent, 'aws'); assert.equal(st.j.loggedIn, false); assert.equal(st.j.profile, 'dsa'); assert.equal(st.j.error, undefined);
  const s = await send('/login', 'POST', { bin: 'sso-hlp.js' });
  assert.equal(s.j.login.url, 'https://device.sso.us-west-2.amazonaws.com/?user_code=WXYZ-ABCD');
  assert.equal(s.j.login.userCode, 'WXYZ-ABCD');
  assert.equal(fs.readFileSync(state + '.awsargs', 'utf8').trim(), '--no-notify');
  fs.writeFileSync(state + '.awsgo', '');
  let l;
  for (let i = 0; i < 50; i++) { l = (await get('/login?bin=sso-hlp.js')).j.login; if (l.state !== 'waiting') break; await new Promise(r => setTimeout(r, 100)); }
  assert.equal(l.state, 'done');
  const after = await get('?bin=sso-hlp.js');
  assert.equal(after.j.loggedIn, true); assert.equal(after.j.lastLogin, '2026-11-10T01:59:32.871Z');
  // Still valid and not forced: sso-hlp leaves it alone and the flow is simply done.
  assert.equal((await send('/login', 'POST', { bin: 'sso-hlp.js' })).j.login.state, 'done');
  fs.rmSync(state + '.awsgo');
  await send('/login', 'POST', { bin: 'sso-hlp.js', force: true });
  assert.equal(fs.readFileSync(state + '.awsargs', 'utf8').trim(), '--no-notify --force');
  await send('/login', 'DELETE', { bin: 'sso-hlp.js' });
  const gone = await get('?bin=sso-hlp-elsewhere.js');
  assert.equal(gone.status, 200); assert.equal(gone.j.missing, true);
});

test('a null body is refused, not a crash', async () => {
  const r = await fetch(base + '/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
  assert.equal(r.status, 400);
});

test('a code after the CLI has quit is refused, not an EPIPE crash', async () => {
  fs.rmSync(state + '.claude', { force: true });
  await send('/login', 'POST', { bin: 'claude' });
  await send('/login/code', 'POST', { bin: 'claude', code: 'bad' });
  const r = await send('/login/code', 'POST', { bin: 'claude', code: 'good' });
  assert.equal(r.status, 404);
});
