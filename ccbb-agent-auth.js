'use strict';
// Login status and login flows for a named claude*/codex* binary — what the server
// chip's badges and its Logins dialog drive. Always by binary, never by agent: the
// claude.* wrappers each set their own provider/env, so `claude.aws auth status` and
// `claude auth status` are different answers about different accounts.
//
//   claude: `<bin> auth status --json`; login is `<bin> auth login --claudeai`, which
//           prints an authorize URL and then reads the code the page shows from stdin.
//   codex:  `<bin> login status` (exit 0 = logged in); login is `--device-auth`, which
//           prints a URL and a one-time code and exits once the user has signed in.
//           Starting it discards the current Codex login, so the UI warns first.
//   aws:    sso-hlp.js (~/src/ttn) for the SSO profile in ~/.config/sso-hlp.json.
//           `--status` exits 0 valid / 2 expired / else unknown; a login is
//           `--no-notify` (the UI shows the device link, no Webex page), and `--force`
//           when the session is still valid. sso-hlp's own lock keeps it from racing
//           the resident `sso-hlp --listen`.

const { spawn } = require('child_process');

const STATUS_TTL_MS = 30000;
const STATUS_TIMEOUT_MS = 30000;
const LOGIN_TTL_MS = 15 * 60 * 1000;
const OUT_CAP = 64 * 1024;

const statusCache = new Map();   // bin → {at, promise}
const logins = new Map();        // bin → flow

function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')   // OSC 8 hyperlink open/close
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[@-_]/g, '');
}

// The group, not just the child: sso-hlp's `aws sso login` would outlive it.
function killGroup(child, sig) {
  if (!child.pid) return;
  try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
}

function run(bin, args, timeoutMs) {
  return new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, BROWSER: '/bin/true' } });
    const fin = r => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { killGroup(child, 'SIGKILL'); fin({ code: null, out, error: 'timed out' }); }, timeoutMs);
    const take = d => { if (out.length < OUT_CAP) out += d; };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', e => fin({ code: null, out, error: e.message }));
    child.on('close', code => fin({ code, out }));
  });
}

function claudeStatus(r, common) {
  const text = stripAnsi(r.out);
  const m = /\{[\s\S]*\}/.exec(text);
  let j = null; try { j = m && JSON.parse(m[0]); } catch {}
  if (!j) return { loggedIn: false, error: r.error || text.trim().split('\n').slice(-3).join(' ') || `exit ${r.code}` };
  const s = { loggedIn: !!j.loggedIn, method: j.authMethod || '', provider: j.apiProvider || '', expiresAt: j.loginExpiresAt || null };
  // Subscription details only exist for a claude.ai login. Not `oauth_token`: that is
  // ANTHROPIC_AUTH_TOKEN from the environment (a wrapper's gateway key, a setup-token),
  // and the account in .claude.json says nothing about whose it is.
  if (s.loggedIn && /claude\.ai/i.test(s.method) && s.provider === 'firstParty' && common) {
    try {
      const a = common.subscriptionAccount && common.subscriptionAccount();
      if (a) { s.email = a.email || ''; s.org = a.org || ''; s.tier = a.tier || ''; }
    } catch {}
  }
  return s;
}

function awsStatus(r) {
  const text = stripAnsi(r.out).trim().split('\n').filter(l => !/^sso-hlp: re-?exec/i.test(l)).pop() || '';
  if (r.error) return { loggedIn: false, error: r.error };
  // "<profile>: <reason>; last login <iso> (1.2h ago; …)" or "…; no recorded login"
  const m = /^([\w.@-]+):\s*([^;]*)(?:;\s*(.*))?$/.exec(text);
  const s = { loggedIn: r.code === 0, method: 'sso', profile: m ? m[1] : '', detail: m ? m[2].trim() : text };
  const age = m && /last login (\S+)/.exec(m[3] || '');
  if (age) s.lastLogin = age[1];
  if (r.code !== 0 && r.code !== 2) s.error = s.detail || `exit ${r.code}`;
  return s;
}

function codexStatus(r) {
  const text = stripAnsi(r.out).trim();
  if (r.error) return { loggedIn: false, error: r.error };
  return { loggedIn: r.code === 0, method: r.code === 0 ? text.replace(/^Logged in (using )?/i, '') : '', detail: text };
}

// agent: 'claude'|'codex'|'aws'. Cached briefly — every open page asks now and then.
function status(bin, agent, { fresh = false, common = null } = {}) {
  const hit = statusCache.get(bin);
  if (hit && !fresh && Date.now() - hit.at < STATUS_TTL_MS) return hit.promise;
  const promise = agent === 'aws' ? run(bin, ['--status'], STATUS_TIMEOUT_MS).then(awsStatus)
    : agent === 'codex' ? run(bin, ['login', 'status'], STATUS_TIMEOUT_MS).then(codexStatus)
    : run(bin, ['auth', 'status', '--json'], STATUS_TIMEOUT_MS).then(r => claudeStatus(r, common));
  const entry = { at: Date.now(), promise: promise.then(s => ({ bin, agent, ...s, checkedAt: new Date().toISOString() })) };
  statusCache.set(bin, entry);
  return entry.promise;
}

function flowView(f) {
  return f && { bin: f.bin, agent: f.agent, state: f.state, url: f.url || '', userCode: f.userCode || '',
    needsCode: f.agent === 'claude', error: f.error || '', startedAt: f.startedAt };
}

function endFlow(f, state, error) {
  if (f.state !== 'waiting' && f.state !== 'starting') return;
  f.state = state; if (error) f.error = error;
  clearTimeout(f.timer);
  f.endedAt = Date.now();
  statusCache.delete(f.bin);
  // TERM first, then KILL whatever of the group is left — a new login for this bin can
  // start right away, and must not race the old one.
  killGroup(f.child, 'SIGTERM');
  setTimeout(() => killGroup(f.child, 'SIGKILL'), 3000).unref();
  for (const w of f.waiters.splice(0)) w();
}

// Starts (or returns the running) login for bin; resolves once the URL is known.
// force: aws only — log in even though the session is still valid.
function startLogin(bin, agent, { force = false } = {}) {
  const cur = logins.get(bin);
  if (cur && (cur.state === 'starting' || cur.state === 'waiting')) return Promise.resolve(flowView(cur));
  const args = agent === 'aws' ? ['--no-notify'].concat(force ? ['--force'] : [])
    : agent === 'codex' ? ['login', '--device-auth'] : ['auth', 'login', '--claudeai'];
  const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true, env: { ...process.env, BROWSER: '/bin/true', NO_COLOR: '1' } });
  const f = { bin, agent, child, state: 'starting', out: '', url: '', userCode: '', error: '', startedAt: new Date().toISOString(), waiters: [] };
  const coded = agent !== 'claude';
  logins.set(bin, f);
  f.timer = setTimeout(() => endFlow(f, 'failed', 'login timed out'), LOGIN_TTL_MS);
  const take = d => {
    if (f.out.length < OUT_CAP) f.out += d;
    const text = stripAnsi(f.out);
    // Only URLs a whitespace follows: a chunk boundary can split one. AWS prints the
    // bare device page and one with the code already in it; the latter is one tap.
    const urls = [...text.matchAll(/(https:\/\/\S+)\s/g)].map(m => m[1].replace(/[)\].,]+$/, ''));
    if (coded && !f.userCode) { const m = /user_code=([A-Z0-9-]+)/.exec(text) || /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/.exec(text); if (m) f.userCode = m[1]; }
    if (urls.length) f.url = (f.userCode && urls.find(u => u.includes('user_code=' + f.userCode))) || f.url || urls[0];
    if (f.state === 'starting' && f.url && (!coded || f.userCode)) { f.state = 'waiting'; for (const w of f.waiters.splice(0)) w(); }
  };
  child.stdout.on('data', take); child.stderr.on('data', take);
  child.stdin.on('error', () => {});   // a code pasted after the CLI quit: EPIPE, not a crash
  child.on('error', e => endFlow(f, 'failed', e.message));
  child.on('close', code => {
    if (code === 0) endFlow(f, 'done');
    else endFlow(f, 'failed', stripAnsi(f.out).trim().split('\n').filter(Boolean).slice(-2).join(' ') || `exit ${code}`);
  });
  return new Promise(resolve => {
    const t = setTimeout(() => { if (f.state === 'starting') endFlow(f, 'failed', 'no login URL from ' + bin); }, STATUS_TIMEOUT_MS);
    f.waiters.push(() => { clearTimeout(t); resolve(flowView(f)); });
  });
}

// A finished flow is reported for a couple of minutes (the dialog's poll needs to see
// it end), then forgotten so a later visit doesn't show an old result.
function getLogin(bin) {
  const f = logins.get(bin);
  if (f && f.endedAt && Date.now() - f.endedAt > 120000) { logins.delete(bin); return null; }
  return flowView(f) || null;
}

process.on('exit', () => { for (const f of logins.values()) if (!f.endedAt) killGroup(f.child, 'SIGKILL'); });

// Claude only: the code the authorize page shows. Resolves when the CLI has finished.
function submitCode(bin, code) {
  const f = logins.get(bin);
  if (!f || f.state !== 'waiting') return Promise.reject(Object.assign(new Error('no login waiting for a code'), { code: 'ENOENT' }));
  if (f.agent !== 'claude') return Promise.reject(Object.assign(new Error(f.agent + ' logins finish on the device page'), { code: 'EINVAL' }));
  if (f.child.exitCode !== null || !f.child.stdin.writable) return Promise.reject(Object.assign(new Error('the login has already ended'), { code: 'ENOENT' }));
  // Resolves when the CLI exits — or, if it asks again (a wrong code), with the flow
  // still waiting, so the request does not hang for the whole login.
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(flowView(f)), 20000);
    f.waiters.push(() => { clearTimeout(t); resolve(flowView(f)); });
    f.child.stdin.write(String(code).trim() + '\n');
  });
}

function cancelLogin(bin) {
  const f = logins.get(bin);
  if (f) endFlow(f, 'cancelled');
  return flowView(f) || null;
}

module.exports = { status, startLogin, getLogin, submitCode, cancelLogin, stripAnsi };
