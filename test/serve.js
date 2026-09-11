#!/usr/bin/env node
'use strict';
// Stand up a real ccbb web with its in-process mux, and put one fixture session in it
// backed by test/fake-claude.js instead of the CLI. Everything except the model is the
// shipping code path — including the mux living inside the web server rather than on a
// port of its own, which is the only way it runs now.
//
//   node test/serve.js [port]        → http://127.0.0.1:<port>/mux/s/<id>
const path = require('path');
const { spawn } = require('child_process');
const common = require('../ccbb-common');

const port = Number(process.argv[2] || 8596);
const token = common.peerToken ? common.peerToken() : null;
// Its own config dir, not the machine's. ccbb web reads peers, the server name and the
// mux address file from CLAUDE_CONFIG_DIR — run against the real one, this fixture dialled
// every configured peer as a second copy of this machine (each peer dropped the real
// link for it, the real server redialled, and they flapped until the fixture exited) and
// overwrote ~/.claude/ccbb-mux/address, so `ccbb attach` landed on the fixture. The token
// is carried over so the drivers in this directory, which read the real one, still get in.
const fs = require('fs');
const cfgDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ccbb-fixture-'));
fs.writeFileSync(path.join(cfgDir, 'ccbb-config.json'),
  JSON.stringify({ server: { name: 'fixture' }, ...(token ? { peerToken: token } : {}) }), { mode: 0o600 });
const web = spawn(process.execPath, [path.join(__dirname, '..', 'ccbb-web.js'), '-p', String(port)],
  { stdio: 'ignore', env: { ...process.env, CLAUDE_CONFIG_DIR: cfgDir } });
const bye = () => {
  try { web.kill('SIGKILL'); } catch {}
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}
};
process.on('exit', bye);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { bye(); process.exit(0); });

const H = Object.assign({ 'content-type': 'application/json' }, token ? { 'x-ccbb-token': token } : {});
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  // Wait for the server, then ask its mux for a session. The create API takes the
  // fixture binary, so no fixture-only path has to exist inside the mux itself.
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/mux/api/sessions`, { headers: H });
      if (r.ok) break;
    } catch {}
    await sleep(100);
  }
  const r = await fetch(`http://127.0.0.1:${port}/mux/api/sessions`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ bin: path.join(__dirname, 'fake-claude.js'), cwd: '/tmp', label: 'fixture' }),
  });
  const j = await r.json();
  if (!j.session) { console.error('fixture: could not create a session:', JSON.stringify(j)); process.exit(1); }
  console.log(`fixture session ${j.session.id}\n  http://127.0.0.1:${port}/mux/s/${j.session.id}`);
})();
