'use strict';
// `ccbb autostart install|uninstall|status` — run `ccbb web` at login via a macOS
// LaunchAgent. The plist carries only an allowlist of env vars (PATH, CA bundles, proxy,
// config dirs), never a full env snapshot, so no tokens land in a plaintext file.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'dev.ccbb.web';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', LABEL + '.plist');
const LOG = path.join(os.homedir(), 'Library', 'Logs', 'ccbb.log');
const DEFAULT_PORT = 8590;
const LOG_TRIM_BYTES = 5 * 1024 * 1024;   // install trims a log past this…
const LOG_KEEP_BYTES = 256 * 1024;        // …down to its last this-many bytes
const ENV_KEYS = [
  'PATH', 'SHELL', 'LANG', 'LC_ALL',
  'NODE_EXTRA_CA_CERTS', 'AWS_CA_BUNDLE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
  'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy',
  'CLAUDE_CONFIG_DIR', 'CCBB_HOME', 'CODEX_HOME', 'AWS_PROFILE', 'AWS_REGION',
];

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// process.execPath and __dirname are symlink-resolved (e.g. Homebrew's
// Cellar/<version>/bin/node, or a global install under a versioned node prefix), which
// break on the next upgrade. Prefer a PATH entry that points at the same file.
function stableOnPath(name, file) {
  let real;
  try { real = fs.realpathSync(file); } catch { return file; }
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const cand = path.join(dir, name);
    try { if (fs.realpathSync(cand) === real) return cand; } catch {}
  }
  return file;
}

function plistXml(programArgs, env) {
  const arr = programArgs.map(a => `    <string>${xml(a)}</string>`).join('\n');
  const envs = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${arr}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(os.homedir())}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envs}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(LOG)}</string>
</dict>
</plist>
`;
}

function launchctl(...args) {
  return spawnSync('launchctl', args, { encoding: 'utf8' });
}
const domain = () => `gui/${process.getuid()}`;
function loaded() { return launchctl('print', `${domain()}/${LABEL}`).status === 0; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
// bootout returns before launchd has finished tearing the job down; a bootstrap issued
// meanwhile fails with "5: Input/output error".
async function bootoutAndWait() {
  launchctl('bootout', `${domain()}/${LABEL}`);
  for (let i = 0; i < 50 && loaded(); i++) await sleep(100);
  return !loaded();
}
// The port the installed plist runs `ccbb web` on, or null.
function installedPort() {
  const r = spawnSync('plutil', ['-extract', 'ProgramArguments', 'json', '-o', '-', PLIST], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  try {
    const a = JSON.parse(r.stdout);
    const i = a.findIndex(x => x === '-p' || x === '--port');
    return i >= 0 ? Number(a[i + 1]) : DEFAULT_PORT;
  } catch { return null; }
}
function logSize() { try { return fs.statSync(LOG).size; } catch { return 0; } }
function trimLog() {
  const size = logSize();
  if (size <= LOG_TRIM_BYTES) return;
  try {
    const fd = fs.openSync(LOG, 'r');
    const buf = Buffer.alloc(LOG_KEEP_BYTES);
    const n = fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
    fs.closeSync(fd);
    let tail = buf.subarray(0, n);
    const nl = tail.indexOf(10);
    if (nl >= 0) tail = tail.subarray(nl + 1);
    fs.writeFileSync(LOG, Buffer.concat([Buffer.from(`[ccbb autostart: log trimmed from ${size} bytes]\n`), tail]));
  } catch {}
}
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';

function portBusy(port, host) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: host === '0.0.0.0' ? '127.0.0.1' : host });
    s.setTimeout(1000);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function usage() {
  console.log(`ccbb autostart — start the web UI at login (macOS LaunchAgent)

Usage:
  ccbb autostart install [-p port] [--host addr] [--dry-run] [--force]
  ccbb autostart uninstall
  ccbb autostart status

install writes ${PLIST.replace(os.homedir(), '~')} and loads it.
Logs: ${LOG.replace(os.homedir(), '~')}
--dry-run prints the plist without writing it; --force skips the busy-port check.`);
}

async function install(args) {
  let port = DEFAULT_PORT, host = null, dry = false, force = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-p' || a === '--port') port = Number(args[++i]);
    else if (a === '--host') host = args[++i];
    else if (a === '--dry-run') dry = true;
    else if (a === '--force') force = true;
    else { console.error(`unknown option: ${a}`); return usage(), process.exit(2); }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error('invalid port'); process.exit(2);
  }
  const progArgs = [stableOnPath('node', process.execPath), stableOnPath('ccbb', path.join(__dirname, 'ccbb.js')),
    'web', '-p', String(port)];
  if (host) progArgs.push('--host', host);
  const env = {};
  for (const k of ENV_KEYS) if (process.env[k]) env[k] = process.env[k];
  const body = plistXml(progArgs, env);
  if (dry) { process.stdout.write(body); return; }

  // A loaded agent on this same port is the one we're replacing, not a conflict.
  const ours = loaded() && installedPort() === port;
  if (!force && !ours && await portBusy(port, host || '127.0.0.1')) {
    console.error(`port ${port} is already in use (a ccbb web running in a terminal?).
Stop it first, or pass --force to install anyway (launchd will retry every 30s).`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  if (!await bootoutAndWait()) { console.error(`launchctl: ${LABEL} is still loaded after bootout; try again`); process.exit(1); }
  trimLog();
  fs.writeFileSync(PLIST, body);
  const lint = spawnSync('plutil', ['-lint', PLIST], { encoding: 'utf8' });
  if (lint.status !== 0) { console.error(lint.stdout + lint.stderr); process.exit(1); }
  const r = launchctl('bootstrap', domain(), PLIST);
  if (r.status !== 0) { console.error(`launchctl bootstrap failed: ${(r.stderr || r.stdout).trim()}`); process.exit(1); }
  console.log(`installed ${LABEL}: ${progArgs.slice(1).join(' ')}`);
  console.log(`  http://${host && host !== '0.0.0.0' ? host : '127.0.0.1'}:${port}   log: ${LOG}`);
}

async function uninstall() {
  const was = loaded();
  await bootoutAndWait();
  let removed = false;
  try { fs.unlinkSync(PLIST); removed = true; } catch {}
  console.log(was || removed ? `uninstalled ${LABEL}` : 'not installed');
}

function status() {
  const exists = fs.existsSync(PLIST);
  if (!exists && !loaded()) { console.log('not installed'); return; }
  const r = launchctl('print', `${domain()}/${LABEL}`);
  const pick = re => ((r.stdout || '').match(re) || [])[1];
  console.log(`plist:  ${exists ? PLIST : '(missing)'}`);
  console.log(`loaded: ${r.status === 0 ? 'yes' : 'no'}`);
  if (r.status === 0) {
    console.log(`state:  ${pick(/^\s*state = (.+)$/m) || '?'}`);
    const pid = pick(/^\s*pid = (\d+)$/m);
    if (pid) console.log(`pid:    ${pid}`);
    const ex = pick(/^\s*last exit code = (.+)$/m);
    if (ex) console.log(`last exit: ${ex}`);
  }
  const size = logSize();
  console.log(`log:    ${LOG} (${mb(size)})`);
  const state = r.status === 0 && pick(/^\s*state = (.+)$/m);
  const ex = r.status === 0 && pick(/^\s*last exit code = (.+)$/m);
  if (state && state !== 'running' && ex && ex !== '0' && !/never exited/.test(ex))
    console.log(`warning: not running and last exit was ${ex} — launchd restarts it every 30s; see the log`);
  if (size > LOG_TRIM_BYTES) console.log(`warning: log is over ${mb(LOG_TRIM_BYTES)}; 'ccbb autostart install' trims it`);
}

async function runAutostart(args) {
  if (process.platform !== 'darwin') {
    console.error('ccbb autostart supports macOS (launchd) only. On Linux, use a systemd user unit running: ccbb web');
    process.exit(1);
  }
  const [sub, ...rest] = args;
  if (sub === 'install') return install(rest);
  if (sub === 'uninstall' || sub === 'remove') return uninstall();
  if (sub === 'status') return status();
  usage();
  if (sub && sub !== '-h' && sub !== '--help' && sub !== 'help') process.exit(2);
}

module.exports = { runAutostart };
