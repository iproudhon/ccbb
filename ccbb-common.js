'use strict';
// ── ccbb-common.js ───────────────────────────────────────────────────────────
// The shared core for every ccbb front-end (CLI `ls`, `web`, `webex`, `confluence`).
// It owns everything the front-ends must agree on so they can't drift:
//   • Pricing — LiteLLM-sourced model prices, refreshed daily.
//   • Session discovery + per-session usage/cost stats, with a size+mtime cache.
//   • The transcript/history layer.
//   • tmux pane location + keystroke injection (driving a live session).
//   • Permission-prompt parsing (the shared bit; each front-end keeps its own
//     watch/answer loop since those are transport-shaped).
//   • Custom "//" command execution + AWS SSO helpers.
// Front-ends layer their own transport, rendering, and live-tailing on top.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CONFIG_FILE = path.join(CLAUDE_DIR, 'ccbb-config.json');
const CACHE_FILE = path.join(CLAUDE_DIR, 'ccbb-cache.json');

// Config lives in CLAUDE_DIR/ccbb-config.json; re-read on demand so edits take effect
// without a restart. Shape (all keys optional except where a front-end needs them):
//   { "token": "<webex bot token>", "allow": ["you@example.com"],
//     "commands": { "name": { "run": "…", "kind": "console" } },
//     "confluence": { "baseUrl": "…", "token": "…", "rootPageId": "…", "allow": […] },
//     "server": { "name": "workbox" }, "peerToken": "…",
//     "peers": [ { "name": "laptop", "url": "http://127.0.0.1:8591", "token": "…" } ] }
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

// ── Multi-server identity ─────────────────────────────────────────────────────
// A ccbb server has a NAME (config server.name, default the hostname) and a list of
// PEERS it can reach — normally other ccbb servers forwarded to localhost over ssh.
// There is no master: every peer proxies to every other peer it's configured with,
// so any of them can drive any other's sessions.
//
// Peers are addressed by NAME, never by a URL supplied by the client — the name is
// looked up in this config and nothing else, so a browser can't turn a ccbb server
// into an open proxy.
function serverIdentity() {
  const s = (readConfig().server) || {};
  const hostname = os.hostname();
  return { name: String(s.name || hostname).trim() || hostname, hostname };
}
// Configured peers, normalized. Entries without a url, duplicates, and any entry
// naming ourselves are dropped — a peer pointing back at this server would make
// /peer/<self> an infinite loop.
function peerList() {
  const cfg = readConfig();
  const self = serverIdentity().name;
  const out = [];
  for (const p of (Array.isArray(cfg.peers) ? cfg.peers : [])) {
    if (!p || !p.url) continue;
    const url = String(p.url).trim().replace(/\/+$/, '');
    const name = String(p.name || url).trim();
    if (!name || name === self || out.some(q => q.name === name)) continue;
    // Each peer may run its own token; peerToken is the fallback for a shared secret.
    out.push({ name, url, token: String(p.token || cfg.peerToken || '') });
  }
  return out;
}
function peerByName(name) { return peerList().find(p => p.name === name) || null; }
// The token THIS server requires of its callers. Empty string = no auth (the default).
function peerToken() { return String(readConfig().peerToken || ''); }

// ── Pricing ────────────────────────────────────────────────────────────────
// Model pricing sourced from LiteLLM's community price list (the same data ccusage
// uses) and refreshed daily — so costs stay current and each model version is priced
// correctly (e.g. Opus 4 = $15/$75 but Opus 4.5+ = $5/$25).
// Layers, lowest → highest precedence:
//   1. FALLBACK_TIERS below         — in-code last resort (opus/haiku/sonnet)
//   2. SNAPSHOT_BY_ID below         — in-code per-id snapshot, works offline on first run
//   3. CLAUDE_DIR/ccbb-pricing.json  — the live daily LiteLLM cache (auto-managed)
// Matching is by the transcript's actual model id (normalized). Prices are USD per 1M tokens.
const LIVE_FILE = path.join(CLAUDE_DIR, 'ccbb-pricing.json');
const ATTEMPT_FILE = path.join(CLAUDE_DIR, 'ccbb-pricing.attempt');
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // refresh when the live cache is older than a day
const RETRY_MS = 60 * 60 * 1000;          // but don't re-attempt more than hourly (offline throttle)
const FETCH_TIMEOUT_MS = 8000;

const FALLBACK_TIERS = {
  opus:   { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6,  cacheRead: 0.3 },
  haiku:  { input: 1, output: 5,  cacheWrite5m: 1.25, cacheWrite1h: 2,  cacheRead: 0.1 },
};

// In-code per-id snapshot of LiteLLM Anthropic prices (USD per 1M tokens), the offline /
// first-run bootstrap before the live daily cache exists. Fields: [input, output,
// cacheRead, cacheWrite5m, cacheWrite1h]. The live cache overrides it.
const SNAP = (i, o, cr, cw5, cw1) => ({ input: i, output: o, cacheRead: cr, cacheWrite5m: cw5, cacheWrite1h: cw1 });
const SNAPSHOT_BY_ID = {
  'claude-3-7-sonnet-20250219': SNAP(3, 15, 0.3, 3.75, 6),
  'claude-3-haiku-20240307':    SNAP(0.25, 1.25, 0.03, 0.3, 6),
  'claude-3-opus-20240229':     SNAP(15, 75, 1.5, 18.75, 6),
  'claude-4-opus-20250514':     SNAP(15, 75, 1.5, 18.75, 18.75),
  'claude-4-sonnet-20250514':   SNAP(3, 15, 0.3, 3.75, 3.75),
  'claude-fable-5':             SNAP(10, 50, 1, 12.5, 20),
  'claude-haiku-4-5':           SNAP(1, 5, 0.1, 1.25, 2),
  'claude-haiku-4-5-20251001':  SNAP(1, 5, 0.1, 1.25, 2),
  'claude-opus-4-1':            SNAP(15, 75, 1.5, 18.75, 30),
  'claude-opus-4-1-20250805':   SNAP(15, 75, 1.5, 18.75, 30),
  'claude-opus-4-20250514':     SNAP(15, 75, 1.5, 18.75, 30),
  'claude-opus-4-5':            SNAP(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-5-20251101':   SNAP(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-6':            SNAP(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-6-20260205':   SNAP(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-7':            SNAP(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-7-20260416':   SNAP(5, 25, 0.5, 6.25, 10),
  'claude-opus-4-8':            SNAP(5, 25, 0.5, 6.25, 10),
  'claude-sonnet-4-20250514':   SNAP(3, 15, 0.3, 3.75, 6),
  'claude-sonnet-4-5':          SNAP(3, 15, 0.3, 3.75, 6),
  'claude-sonnet-4-5-20250929': SNAP(3, 15, 0.3, 3.75, 6),
  'claude-sonnet-4-6':          SNAP(3, 15, 0.3, 3.75, 6),
  'claude-sonnet-5':            SNAP(2, 10, 0.2, 2.5, 4),
};

function pnum(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }

function normalizeId(model) {
  let m = String(model || '').toLowerCase().trim();
  m = m.replace(/^(us|eu|apac|au|global)\./, '');
  m = m.replace(/^(anthropic|bedrock)[./]/, '');
  m = m.replace(/[:-]v\d+(:\d+)?$/, '');
  return m;
}

function priceObj(input, output, cacheRead, cw5m, cw1h) {
  const c5 = round6(cw5m);
  return {
    input: round6(input), output: round6(output), cacheRead: round6(cacheRead),
    cacheWrite: c5, cacheWrite5m: c5, cacheWrite1h: round6(cw1h != null ? cw1h : cw5m),
  };
}
function normalizePrice(p) {
  p = p || {};
  const cw5 = pnum(p.cacheWrite5m, pnum(p.cacheWrite, 0));
  return priceObj(pnum(p.input, 0), pnum(p.output, 0), pnum(p.cacheRead, 0), cw5, pnum(p.cacheWrite1h, cw5));
}
function tiersFrom(src) {
  const t = {};
  for (const k of Object.keys(src)) t[k] = normalizePrice(src[k]);
  return t;
}

function convertLiteLLM(j) {
  const byId = {};
  for (const key of Object.keys(j).sort()) {
    if (!/^claude/i.test(key)) continue;
    const e = j[key];
    if (!e || typeof e !== 'object') continue;
    if (e.input_cost_per_token == null || e.output_cost_per_token == null) continue;
    byId[normalizeId(key)] = priceObj(
      e.input_cost_per_token * 1e6,
      e.output_cost_per_token * 1e6,
      (e.cache_read_input_token_cost || 0) * 1e6,
      (e.cache_creation_input_token_cost || 0) * 1e6,
      e.cache_creation_input_token_cost_above_1hr != null ? e.cache_creation_input_token_cost_above_1hr * 1e6 : null,
    );
  }
  return byId;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function loadTable() {
  const table = { byId: {}, tiers: tiersFrom(FALLBACK_TIERS), default: null };
  table.default = table.tiers.sonnet;
  for (const k of Object.keys(SNAPSHOT_BY_ID)) table.byId[k] = normalizePrice(SNAPSHOT_BY_ID[k]);
  const j = readJson(LIVE_FILE);
  if (j) {
    if (j.byId) for (const k of Object.keys(j.byId)) table.byId[k] = normalizePrice(j.byId[k]);
    if (j.tiers) for (const k of Object.keys(j.tiers)) table.tiers[k] = normalizePrice(j.tiers[k]);
    if (j.default) table.default = normalizePrice(j.default);
  }
  return table;
}

function priceForModelIn(model, table) {
  const byId = table.byId || {};
  const id = normalizeId(model);
  if (byId[id]) return byId[id];
  const trimmed = id.replace(/-\d{6,}$/, '');
  if (trimmed !== id && byId[trimmed]) return byId[trimmed];
  if (id.includes('opus')) return table.tiers.opus;
  if (id.includes('haiku')) return table.tiers.haiku;
  if (id.includes('sonnet')) return table.tiers.sonnet;
  return table.default || table.tiers.sonnet;
}

function tableSig(table) {
  const norm = { byId: {}, tiers: {}, default: table.default };
  for (const k of Object.keys(table.byId).sort()) norm.byId[k] = table.byId[k];
  for (const k of Object.keys(table.tiers).sort()) norm.tiers[k] = table.tiers[k];
  return crypto.createHash('sha1').update(JSON.stringify(norm)).digest('hex').slice(0, 16);
}

function atomicWrite(file, obj) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function touchAttempt() { try { fs.writeFileSync(ATTEMPT_FILE, new Date().toISOString()); } catch {} }
function fileAgeMs(file) { try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return Infinity; } }

async function fetchLiteLLM() {
  const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function updatePricingNow() {
  touchAttempt();
  const j = await fetchLiteLLM();
  const byId = convertLiteLLM(j);
  if (!Object.keys(byId).length) throw new Error('no anthropic models parsed from LiteLLM');
  const out = {
    _comment: 'Auto-generated by ccbb from LiteLLM (refreshed daily). Do not hand-edit — this file is overwritten. Delete it to force a rebuild.',
    _source: LITELLM_URL,
    _fetchedAt: new Date().toISOString(),
    byId,
    tiers: tiersFrom(FALLBACK_TIERS),
    default: normalizePrice(FALLBACK_TIERS.sonnet),
  };
  atomicWrite(LIVE_FILE, out);
  return out;
}

// Fire-and-forget: if the live cache is stale (and we haven't tried recently), spawn a
// detached child to refresh it for next time. Never blocks or throws.
function maybeRefreshPricing() {
  try {
    if (fileAgeMs(LIVE_FILE) <= MAX_AGE_MS) return;
    if (fileAgeMs(ATTEMPT_FILE) <= RETRY_MS) return;
    touchAttempt();
    const child = spawn(process.execPath, [__filename, '--update-pricing'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* best-effort */ }
}

const PRICE_TABLE = loadTable();
const PRICING = PRICE_TABLE.tiers;
function priceForModel(model) { return priceForModelIn(model, PRICE_TABLE); }
function contextMaxFor(model) { return 200000; }

// ── Subscription usage windows ───────────────────────────────────────────────
// A Claude.ai plan is not billed in dollars, it is rationed by two rolling RATE-LIMIT
// WINDOWS — five-hour and seven-day — each reported as a percentage used plus when it
// resets. The dollar figures ccbb computes from transcripts are list-price notional
// there; the windows are what actually runs out. Nothing in a transcript carries them
// (they are a property of the account, not the conversation), so there are two sources:
//
//   1. `cachedUsageUtilization` in Claude Code's own .claude.json — free and offline,
//      but only as fresh as the last time Claude Code itself asked.
//   2. GET /api/oauth/usage with the OAuth access token from .credentials.json —
//      always current, at the cost of one authenticated call on the user's login.
//
// Both are read; whichever reading is newer wins. (2) refreshes into ccbb's own cache
// file in the background and NEVER blocks a response — a caller gets the best value on
// hand and the next poll picks up the result. The cache holds only percentages and
// reset times, never the token.
const CREDENTIALS_FILE = path.join(CLAUDE_DIR, '.credentials.json');
const USAGE_FILE = path.join(CLAUDE_DIR, 'ccbb-usage.json');
const USAGE_ATTEMPT_FILE = path.join(CLAUDE_DIR, 'ccbb-usage.attempt');
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_BETA = 'oauth-2025-04-20';
const USAGE_MAX_AGE_MS = 60 * 1000;        // a window percentage moves turn by turn
const USAGE_RETRY_MS = 5 * 60 * 1000;      // …but back off after a failure (offline throttle)

// Claude Code keeps .claude.json beside its config dir when CLAUDE_CONFIG_DIR is set,
// and in the home directory otherwise. Resolved per call: the file can appear later.
function claudeJsonFile() {
  const beside = path.join(CLAUDE_DIR, '.claude.json');
  try { if (fs.statSync(beside).isFile()) return beside; } catch {}
  return path.join(os.homedir(), '.claude.json');
}
// That file runs to tens of KB and is re-read on every poll, so cache the parse against
// size+mtime the way the session stats cache does.
let claudeJsonCache = { key: '', data: null };
function readClaudeJson() {
  const file = claudeJsonFile();
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${file}:${st.size}:${st.mtimeMs}`;
  if (claudeJsonCache.key === key) return claudeJsonCache.data;
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = null; }
  claudeJsonCache = { key, data };
  return data;
}
// The logged-in Claude.ai account, or null when this machine runs on Bedrock / an API
// key — in which case there is no subscription to report and no row to draw.
function subscriptionAccount() {
  const j = readClaudeJson();
  const a = j && j.oauthAccount;
  if (!a || !a.accountUuid) return null;
  return {
    accountUuid: String(a.accountUuid),
    name: String(a.displayName || a.emailAddress || a.accountUuid.slice(0, 8)),
    email: String(a.emailAddress || ''),
    org: String(a.organizationName || ''),
    orgType: String(a.organizationType || ''),
    tier: String(a.organizationRateLimitTier || a.userRateLimitTier || ''),
  };
}
function oauthCreds() {
  try {
    const o = (JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8')) || {}).claudeAiOauth;
    if (!o || !o.accessToken) return null;
    return {
      token: String(o.accessToken),
      expiresAt: Number(o.expiresAt) || 0,
      subscriptionType: String(o.subscriptionType || ''),
    };
  } catch { return null; }
}
// Both sources return the same payload shape, so one normalizer serves both. Returns
// null when neither window is present — an empty object would read as "0% used".
function normalizeUsageWindows(u) {
  if (!u || typeof u !== 'object') return null;
  const win = k => {
    const w = u[k];
    if (!w || typeof w.utilization !== 'number' || !isFinite(w.utilization)) return null;
    return { pct: w.utilization, resetsAt: w.resets_at || null };
  };
  const fiveHour = win('five_hour'), sevenDay = win('seven_day');
  if (!fiveHour && !sevenDay) return null;
  return { fiveHour, sevenDay };
}
let usageRefreshing = false;
// Fire-and-forget refresh of USAGE_FILE. Never blocks, never throws, never renews the
// token: an expired one is Claude Code's to refresh, and rewriting the credentials file
// underneath it would be a good way to log the user out. Falls back to the cache instead.
function maybeRefreshUsage() {
  try {
    if (usageRefreshing) return;
    if (fileAgeMs(USAGE_FILE) <= USAGE_MAX_AGE_MS) return;
    if (fileAgeMs(USAGE_ATTEMPT_FILE) <= USAGE_RETRY_MS) return;
    const account = subscriptionAccount();
    const creds = oauthCreds();
    if (!account || !creds) return;
    if (creds.expiresAt && creds.expiresAt <= Date.now()) return;
    usageRefreshing = true;
    // Stamped BEFORE the request, so a hung fetch can't let a second one start.
    try { fs.writeFileSync(USAGE_ATTEMPT_FILE, new Date().toISOString()); } catch {}
    fetch(USAGE_URL, {
      headers: {
        authorization: 'Bearer ' + creds.token,
        'anthropic-beta': USAGE_BETA,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(u => {
        // A 200 carrying no windows is a failure, not an empty account — writing it
        // would park a useless file in front of Claude Code's own usable cache.
        if (!normalizeUsageWindows(u)) throw new Error('no usage windows in response');
        atomicWrite(USAGE_FILE, {
          _comment: 'Auto-generated by ccbb from the account usage endpoint. Percentages and reset times only — no credentials. Safe to delete.',
          accountUuid: account.accountUuid,
          fetchedAtMs: Date.now(),
          utilization: u,
        });
        try { fs.unlinkSync(USAGE_ATTEMPT_FILE); } catch {}
      })
      .catch(() => { /* leave the previous file and let the throttle hold us off */ })
      .finally(() => { usageRefreshing = false; });
  } catch { usageRefreshing = false; }
}
// This server's subscription, or null when it isn't on one. Kicks the background
// refresh and answers from whatever is already on disk.
function getSubscription() {
  const account = subscriptionAccount();
  if (!account) return null;
  maybeRefreshUsage();
  const readings = [];
  let live = null;
  try { live = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch {}
  // A reading stamped with a different account is a leftover from a previous login.
  if (live && live.accountUuid === account.accountUuid)
    readings.push({ at: Number(live.fetchedAtMs) || 0, u: live.utilization, source: 'api' });
  const cached = (readClaudeJson() || {}).cachedUsageUtilization;
  if (cached && (!cached.accountUuid || cached.accountUuid === account.accountUuid))
    readings.push({ at: Number(cached.fetchedAtMs) || 0, u: cached.utilization, source: 'claude-code' });
  readings.sort((a, b) => b.at - a.at);
  const creds = oauthCreds();
  const out = {
    server: serverIdentity().name,
    account,
    plan: (creds && creds.subscriptionType) || account.orgType || '',
    windows: null, fetchedAt: null, source: null,
  };
  for (const r of readings) {
    const windows = normalizeUsageWindows(r.u);
    if (!windows) continue;
    out.windows = windows; out.fetchedAt = r.at || null; out.source = r.source;
    break;
  }
  return out;
}

// ── Period keys ──────────────────────────────────────────────────────────────
// Local-time period bucket key for a timestamp: day→YYYY-MM-DD, month→YYYY-MM,
// week→the Monday of the local week as YYYY-MM-DD.
function pad2(n) { return String(n).padStart(2, '0'); }
function periodKey(iso, period) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const y = d.getFullYear(), mo = pad2(d.getMonth() + 1), day = pad2(d.getDate());
  if (period === 'month') return `${y}-${mo}`;
  if (period === 'day') return `${y}-${mo}-${day}`;
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (monday.getDay() + 6) % 7; // Mon=0 … Sun=6
  monday.setDate(monday.getDate() - dow);
  return `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
}

// ── Session discovery ─────────────────────────────────────────────────────────
function sessionJsonlPaths() {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  const results = [];
  if (!fs.existsSync(projectsDir)) return results;
  let slugs;
  try { slugs = fs.readdirSync(projectsDir); } catch { return results; }
  for (const slug of slugs) {
    const slugDir = path.join(projectsDir, slug);
    let files;
    try { files = fs.readdirSync(slugDir); } catch { continue; }
    for (const file of files) {
      if (path.extname(file) === '.jsonl') results.push(path.join(slugDir, file));
    }
  }
  return results;
}

// sessionId → main JSONL path, built with one directory walk and memoized. Callers that
// enumerate the whole list should refresh once up front via sessionPathIndex(true).
let _pathIndex = null;
function sessionPathIndex(force) {
  if (_pathIndex && !force) return _pathIndex;
  const m = new Map();
  for (const p of sessionJsonlPaths()) m.set(path.basename(p, '.jsonl'), p);
  _pathIndex = m;
  return m;
}
function findSessionJsonl(sessionId) {
  let m = sessionPathIndex();
  if (m.has(sessionId)) return m.get(sessionId);
  m = sessionPathIndex(true);   // a new session may have appeared since the walk
  return m.get(sessionId) || null;
}

function collectJsonl(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectJsonl(full, out);
    else if (e.name.endsWith('.jsonl')) out.push(full);
  }
}
// All JSONL transcripts that count toward a session's usage: its own plus any subagent
// transcripts under <dir>/<sessionId>/ (matches ccusage grouping).
function sessionUsagePaths(sessionId, mainPath) {
  const main = mainPath || findSessionJsonl(sessionId);
  if (!main) return [];
  const paths = [main];
  collectJsonl(path.join(path.dirname(main), sessionId), paths);
  return paths;
}

// ── Per-session stats (single pass over the session's files) ──────────────────
// Aggregates the session's own JSONL plus subagent transcripts (group-by-sessionId,
// matching ccusage). Cost is estimated from usage × pricing. In ONE read it also derives
// title (custom-title over ai-title) and startedAt, so listings don't need a separate pass.
//
// opts.periodFilter: { period:'day'|'week'|'month', key } — when set, only messages whose
// local-time timestamp falls in that period contribute to token/cost totals. startedAt/
// lastActivity always reflect all-time activity; hasUsage flags whether the session ever
// billed. context is null when filtering.
function computeSessionStats(sessionId, opts) {
  opts = opts || {};
  const periodFilter = opts.periodFilter || null;
  const inPeriod = ts => !periodFilter || periodKey(ts, periodFilter.period) === periodFilter.key;
  const categories = {
    input:      { tokens: 0, cost: 0 },
    cacheRead:  { tokens: 0, cost: 0 },
    cacheWrite: { tokens: 0, cost: 0 },
    cacheMiss:  { tokens: 0, cost: 0 },  // cache-write on a non-first msg with cache_read==0
    output:     { tokens: 0, cost: 0 },
  };
  const firstSeen = {};   // per usage-source path: has the first billable msg passed?
  const modelMap = {};
  const providerMap = {};
  // lastAssistantAt/cacheTtl answer "is the prompt cache still warm?" — the question the
  // status line's resend cost turns on. lastActivity can't: it is the max over EVERY
  // entry, so a user message typed a moment ago reads warm while Claude last answered
  // twenty minutes back. The TTL is read off the last response that carried a
  // cache_creation breakdown (1h if it asked for the 1-hour cache), never guessed.
  const s = { startedAt: null, lastActivity: null, totalTokens: 0, cost: 0, turns: 0,
    categories, models: [], providers: [], context: null, contextMax: null, subTurns: 0, hasUsage: false, title: '',
    lastAssistantAt: null, cacheTtl: null };
  let lastCtxTs = null, lastCtx = null, maxCtx = null;
  const ctxSamples = []; const seenCtxIds = new Set();
  let lastCompactTs = null, lastCompactTokens = 0;
  let aiTitle, customTitle, firstTs = null;
  // Average server response time: for each billable assistant message on the MAIN transcript,
  // its write time minus the last user entry (prompt or tool_result) before it. Anchored to the
  // last user entry, not the adjacent line, since one response spans several assistant entries.
  let lastUserTs = null, respSum = 0, respCount = 0, respOut = 0;
  const seenMsgIds = new Set();
  const seenTurnIds = new Set();
  const PERIODS = ['day', 'week', 'month'];
  const byPeriod = { day: {}, week: {}, month: {} };
  const pFirst = { day: {}, week: {}, month: {} };
  const pTurns = { day: {}, week: {}, month: {} };
  const emptyCats = () => ({ input: { tokens: 0, cost: 0 }, cacheRead: { tokens: 0, cost: 0 },
    cacheWrite: { tokens: 0, cost: 0 }, cacheMiss: { tokens: 0, cost: 0 }, output: { tokens: 0, cost: 0 } });
  const usagePaths = opts.usagePaths || sessionUsagePaths(sessionId, opts.mainPath);
  const mainPath = usagePaths[0];
  for (const filePath of usagePaths) {
    const isMain = filePath === mainPath;
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (isMain) {
        if (firstTs === null && d.timestamp) firstTs = d.timestamp;
        if (d.type === 'ai-title' && aiTitle === undefined) aiTitle = d.aiTitle || '';
        else if (d.type === 'custom-title') customTitle = d.customTitle || '';
      }
      if (d.sessionId !== sessionId) continue;
      if (d.timestamp) {
        if (!s.startedAt || d.timestamp < s.startedAt) s.startedAt = d.timestamp;
        if (!s.lastActivity || d.timestamp > s.lastActivity) s.lastActivity = d.timestamp;
      }
      if (!periodFilter && d.isCompactSummary === true && d.timestamp &&
          (!lastCompactTs || d.timestamp >= lastCompactTs)) {
        lastCompactTs = d.timestamp;
        const c = d.message && d.message.content;
        const sumStr = typeof c === 'string' ? c : (c ? JSON.stringify(c) : '');
        lastCompactTokens = Math.ceil(sumStr.length / 4);
      }
      if (isMain && d.type === 'user' && d.timestamp) { const t = Date.parse(d.timestamp); if (!isNaN(t)) lastUserTs = t; }
      if (d.type === 'assistant' && d.message && d.message.usage) s.hasUsage = true;
      const dkey = (d.message && d.message.id) ? d.message.id + '|' + (d.requestId || '') : null;
      if (d.type === 'assistant' && d.message && d.message.usage &&
          inPeriod(d.timestamp) && !(dkey && seenMsgIds.has(dkey))) {
        if (dkey) seenMsgIds.add(dkey);
        if (isMain && d.timestamp && lastUserTs != null) {
          const r = Date.parse(d.timestamp) - lastUserTs;
          // respOut tracks the output tokens of exactly the messages that contribute to
          // respSum, so avgOutTps below is the rate over the same measured window as `t`.
          if (r >= 0) { respSum += r; respCount++; respOut += d.message.usage.output_tokens || 0; }
        }
        const u = d.message.usage;
        const inp = u.input_tokens || 0, out = u.output_tokens || 0;
        const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
        const p = priceForModel(d.message.model);
        const cInp = inp * p.input / 1e6, cOut = out * p.output / 1e6;
        const cCr = cr * p.cacheRead / 1e6;
        const cc = u.cache_creation || null;
        const cw5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : cw;
        const cw1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
        const cCw = (cw5 * p.cacheWrite5m + cw1 * p.cacheWrite1h) / 1e6;
        if (isMain && d.timestamp && (!s.lastAssistantAt || d.timestamp > s.lastAssistantAt)) {
          s.lastAssistantAt = d.timestamp;
          if (cw1 > 0) s.cacheTtl = 3600;
          else if (cw5 > 0) s.cacheTtl = 300;
        }
        const isFirst = !firstSeen[filePath];
        firstSeen[filePath] = true;
        const miss = (cr === 0 && !isFirst);
        categories.input.tokens += inp;      categories.input.cost += cInp;
        categories.cacheRead.tokens += cr;   categories.cacheRead.cost += cCr;
        categories.cacheWrite.tokens += cw;  categories.cacheWrite.cost += cCw;
        categories.output.tokens += out;     categories.output.cost += cOut;
        if (miss) { categories.cacheMiss.tokens += cw; categories.cacheMiss.cost += cCw; }
        const msgTok = inp + out + cr + cw;
        const msgCost = cInp + cOut + cCr + cCw;
        const key = d.message.model || 'unknown';
        if (!modelMap[key]) modelMap[key] = { model: key, tokens: 0, cost: 0 };
        modelMap[key].tokens += msgTok;
        modelMap[key].cost += msgCost;
        const prov = String(d.message.id || '').startsWith('msg_bdrk_') ? 'bedrock' : 'anthropic';
        if (!providerMap[prov]) providerMap[prov] = { provider: prov, tokens: 0, cost: 0 };
        providerMap[prov].tokens += msgTok;
        providerMap[prov].cost += msgCost;
        s.totalTokens += msgTok;
        s.cost += msgCost;
        if (d.message.id && !seenTurnIds.has(d.message.id)) {
          seenTurnIds.add(d.message.id);
          if (isMain) s.turns++; else s.subTurns++;
        }
        if (!periodFilter) {
          for (const kind of PERIODS) {
            const pk = periodKey(d.timestamp, kind);
            if (!pk) continue;
            let b = byPeriod[kind][pk];
            if (!b) b = byPeriod[kind][pk] = { cost: 0, tokens: 0, turns: 0, subTurns: 0, categories: emptyCats(), models: {} };
            const first = pFirst[kind];
            if (!first[pk]) first[pk] = {};
            const missP = (cr === 0 && first[pk][filePath]);
            first[pk][filePath] = true;
            b.categories.input.tokens += inp;      b.categories.input.cost += cInp;
            b.categories.cacheRead.tokens += cr;   b.categories.cacheRead.cost += cCr;
            b.categories.cacheWrite.tokens += cw;  b.categories.cacheWrite.cost += cCw;
            b.categories.output.tokens += out;     b.categories.output.cost += cOut;
            if (missP) { b.categories.cacheMiss.tokens += cw; b.categories.cacheMiss.cost += cCw; }
            b.tokens += msgTok; b.cost += msgCost;
            if (!b.models[key]) b.models[key] = { model: key, tokens: 0, cost: 0 };
            b.models[key].tokens += msgTok; b.models[key].cost += msgCost;
            const turns = pTurns[kind];
            if (!turns[pk]) turns[pk] = new Set();
            if (d.message.id && !turns[pk].has(d.message.id)) {
              turns[pk].add(d.message.id);
              if (isMain) b.turns++; else b.subTurns++;
            }
          }
        }
        const ctxTok = inp + cr + cw + out;
        if (!lastCtxTs || (d.timestamp && d.timestamp >= lastCtxTs)) {
          lastCtxTs = d.timestamp || lastCtxTs;
          lastCtx = { tokens: ctxTok, cost: ctxTok * p.cacheRead / 1e6, model: d.message.model || null, max: contextMaxFor(d.message.model) };
        }
        // Collect per-turn context samples (deduped by message id, in chronological order)
        // so the peak can be computed after the loop with spike artifacts discounted.
        if (!(d.message.id && seenCtxIds.has(d.message.id))) {
          if (d.message.id) seenCtxIds.add(d.message.id);
          ctxSamples.push({ tokens: ctxTok, cost: ctxTok * p.cacheRead / 1e6,
            model: d.message.model || null, ts: d.timestamp ? Date.parse(d.timestamp) : null });
        }
      }
    }
  }
  // Peak context the session ever reached — differs from the current context after a
  // /compact (which resets it) or when the final turn is smaller than an earlier one.
  // Discount cache-accounting spikes: on a prompt-cache refresh the usage can double-count
  // the cached prefix, so a lone turn reads ~2x the surrounding turns and reverts on the
  // next one. Signature: context >= 1.8x both neighbors, and the neighbors match each other
  // (the pre/post-revert level) — the symmetry check also rejects subagent-interleave cases
  // where the neighbors are a small subagent turn and a full main turn. Skip such turns.
  const SPIKE_RATIO = 1.8, NEIGHBOR_SYM = 0.7;
  for (let i = 0; i < ctxSamples.length; i++) {
    const c = ctxSamples[i], prev = ctxSamples[i - 1], next = ctxSamples[i + 1];
    if (prev && next) {
      const lo = Math.min(prev.tokens, next.tokens), hi = Math.max(prev.tokens, next.tokens);
      if (hi > 0 && c.tokens >= SPIKE_RATIO * hi && lo >= NEIGHBOR_SYM * hi) continue;
    }
    if (!maxCtx || c.tokens > maxCtx.tokens)
      maxCtx = { tokens: c.tokens, cost: c.cost, model: c.model, max: contextMaxFor(c.model) };
  }
  if (lastCompactTs && (!lastCtxTs || lastCompactTs > lastCtxTs)) {
    const model = lastCtx ? lastCtx.model : null;
    const p = priceForModel(model);
    lastCtx = {
      tokens: lastCompactTokens,
      cost: lastCompactTokens * p.cacheRead / 1e6,
      model, max: contextMaxFor(model), postCompact: true,
    };
  }
  s.context = periodFilter ? null : lastCtx;
  s.contextMax = periodFilter ? null : maxCtx;
  s.avgResponseMs = respCount ? respSum / respCount : null;
  // Output tokens per second of response time — equivalently avg output tokens ÷ avg
  // response time, since both share respCount. Null when no response time was measured.
  s.avgOutTps = respSum > 0 ? respOut / (respSum / 1000) : null;
  s.models = Object.values(modelMap).sort((a, b) => b.cost - a.cost);
  s.providers = Object.values(providerMap).sort((a, b) => b.cost - a.cost);
  s.title = customTitle !== undefined ? customTitle : (aiTitle || '');
  if (!periodFilter) {
    for (const kind of PERIODS)
      for (const b of Object.values(byPeriod[kind])) b.models = Object.values(b.models).sort((a, x) => x.cost - a.cost);
    s.byPeriod = byPeriod;
  }
  if (!s.startedAt) s.startedAt = firstTs || null;
  return s;
}

// ── Skeleton extraction (privacy-safe, for stats collection / replay) ─────────
// Reduces a session to structure + numbers only: NO message text, tool args/results,
// prompts, cwd, file paths, git branches or titles survive. What's kept is a session
// fingerprint (SHA over the main transcript's event sequence — used to dedup identical
// sessions across a collection) plus one numeric row per billable assistant message
// (token usage, provider, model, response time, local hour). Provider is anthropic vs
// bedrock (msg_bdrk_ id prefix); a custom Anthropic-compatible endpoint can't be told
// apart from subscription and reads as 'anthropic'.
function buildSkeleton(sessionId, opts = {}) {
  const usagePaths = sessionUsagePaths(sessionId, opts.mainPath);
  if (!usagePaths.length) return null;
  const mainPath = usagePaths[0];
  const responses = [];
  const models = new Set(), providers = new Set();
  const fpParts = [];
  const seenMsgIds = new Set();
  let version = null, startedAt = null, lastActivity = null;
  for (const filePath of usagePaths) {
    const isMain = filePath === mainPath;
    let text;
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { continue; }
    let lastUserTs = null;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (d.sessionId && d.sessionId !== sessionId) continue;
      if (d.version && !version) version = d.version;
      if (d.timestamp) {
        if (!startedAt || d.timestamp < startedAt) startedAt = d.timestamp;
        if (!lastActivity || d.timestamp > lastActivity) lastActivity = d.timestamp;
      }
      // Structural fingerprint — main transcript only, in file order. Records the shape
      // of the conversation (turn kinds + tool names), never any content.
      if (isMain && d.message) {
        const c = d.message.content;
        if (d.type === 'user') {
          const isTR = Array.isArray(c) && c.some(b => b && b.type === 'tool_result');
          fpParts.push(isTR ? 'r' : 'u');
        } else if (d.type === 'assistant' && Array.isArray(c)) {
          for (const b of c) {
            if (!b) continue;
            if (b.type === 'tool_use') fpParts.push('t:' + (b.name || ''));
            else if (b.type === 'text') fpParts.push('x');
            else if (b.type === 'thinking') fpParts.push('k');
            else fpParts.push(b.type || '?');
          }
        }
      }
      if (isMain && d.type === 'user' && d.timestamp) {
        const t = Date.parse(d.timestamp); if (!isNaN(t)) lastUserTs = t;
      }
      const dkey = (d.message && d.message.id) ? d.message.id + '|' + (d.requestId || '') : null;
      if (d.type === 'assistant' && d.message && d.message.usage && !(dkey && seenMsgIds.has(dkey))) {
        if (dkey) seenMsgIds.add(dkey);
        const u = d.message.usage;
        const input = u.input_tokens || 0, output = u.output_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
        const provider = String(d.message.id || '').startsWith('msg_bdrk_') ? 'bedrock' : 'anthropic';
        const model = d.message.model || 'unknown';
        models.add(model); providers.add(provider);
        let respMs = null;
        if (isMain && d.timestamp && lastUserTs != null) {
          const r = Date.parse(d.timestamp) - lastUserTs;
          if (r >= 0) respMs = r;
        }
        const ts = d.timestamp || null;
        responses.push({
          ts,
          hour: ts ? new Date(ts).getHours() : null,   // local hour at extraction time
          model, provider, main: isMain,
          input, cacheRead, cacheWrite, output,
          promptTokens: input + cacheRead + cacheWrite,  // context fed in
          respMs,
        });
      }
    }
  }
  if (!responses.length) return null;
  const fingerprint = crypto.createHash('sha256').update(fpParts.join('|')).digest('hex').slice(0, 16);
  return {
    sessionId, fingerprint, version, startedAt, lastActivity,
    models: [...models], providers: [...providers],
    responses,
  };
}

// Build skeletons for every discoverable session. Returns the collection object that
// `ccbb skel` serializes to one JSON file.
function buildAllSkeletons() {
  const idx = sessionPathIndex(true);
  const sessions = [];
  for (const [sessionId, mainPath] of idx) {
    let sk = null;
    try { sk = buildSkeleton(sessionId, { mainPath }); } catch {}
    if (sk) sessions.push(sk);
  }
  return {
    tool: 'ccbb', kind: 'skeleton', schema: 1,
    generatedAt: new Date().toISOString(),
    count: sessions.length,
    sessions,
  };
}

// ── Stats cache (size+mtime keyed, persisted to CLAUDE_DIR/ccbb-cache.json) ────
// Session JSONLs are append-only, so a session's computed stats stay valid until one of
// its files changes size or mtime. Only unfiltered (all-time) stats are cached. Cached
// costs depend on the active pricing, so tie the whole cache to a pricing fingerprint.
const PRICING_SIG = tableSig(PRICE_TABLE);
let _statsCache = null, _cacheDirty = false;
function loadStatsCache() {
  if (_statsCache) return _statsCache;
  try {
    const d = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (d && d.version === 9 && d.sessions && d.pricingSig === PRICING_SIG) _statsCache = d;
  } catch { /* missing/corrupt → start fresh */ }
  if (!_statsCache) _statsCache = { version: 9, pricingSig: PRICING_SIG, sessions: {} };
  return _statsCache;
}
// The cache is a few hundred KB, and a watched server rebuilds its list every time a
// transcript grows — which during an active turn is a few times a second. So the write is
// throttled: the in-memory cache is always current, the file catches up at most every 10s,
// and an exit hook flushes whatever the throttle was holding.
const SAVE_MIN_MS = 10000;
let _lastSave = 0;
function saveStatsCache(force) {
  if (!_cacheDirty) return;
  const now = Date.now();
  if (!force && now - _lastSave < SAVE_MIN_MS) return;
  const c = loadStatsCache();
  const tmp = CACHE_FILE + '.tmp.' + process.pid;
  try { fs.writeFileSync(tmp, JSON.stringify(c)); fs.renameSync(tmp, CACHE_FILE); }
  catch { /* cache is best-effort */ }
  _cacheDirty = false;
  _lastSave = now;
}
process.on('exit', () => { try { saveStatsCache(true); } catch {} });
function sessionSig(usagePaths) {
  const parts = [];
  for (const p of usagePaths) {
    let st; try { st = fs.statSync(p); } catch { continue; }
    parts.push(p + ':' + st.size + ':' + Math.round(st.mtimeMs));
  }
  return parts.join('|');
}

// Public entry: per-session stats, cache-backed for the common all-time case.
function getSessionStats(sessionId, opts) {
  opts = opts || {};
  const usagePaths = sessionUsagePaths(sessionId, opts.mainPath);
  if (opts.periodFilter) {
    return computeSessionStats(sessionId, { periodFilter: opts.periodFilter, usagePaths });
  }
  const sig = sessionSig(usagePaths);
  const cache = loadStatsCache();
  let e = cache.sessions[sessionId];
  if (e && e.sig === sig && e.stats) return e.stats;
  const stats = computeSessionStats(sessionId, { usagePaths });
  if (!e || e.sig !== sig) e = cache.sessions[sessionId] = { sig };
  e.stats = stats;
  _cacheDirty = true;
  return stats;
}

// Per-session contribution to the all-time cost summary, cached under the same signature
// as the stats. `compute` is the caller's per-session summary builder.
function getSessionSummary(sessionId, mainPath, compute) {
  const usagePaths = sessionUsagePaths(sessionId, mainPath);
  const sig = sessionSig(usagePaths);
  const cache = loadStatsCache();
  let e = cache.sessions[sessionId];
  if (e && e.sig === sig && e.summary) return e.summary;
  const summary = compute(usagePaths);
  if (!e || e.sig !== sig) e = cache.sessions[sessionId] = { sig };
  e.summary = summary;
  _cacheDirty = true;
  return summary;
}

function pruneStatsCache(seenIds) {
  const cache = loadStatsCache();
  for (const id of Object.keys(cache.sessions)) {
    if (!seenIds.has(id)) { delete cache.sessions[id]; _cacheDirty = true; }
  }
}

// ── Live-session registry (from ~/.claude/sessions/<pid>.json sidecars) ───────
// Claude Code writes one sidecar per running process, well before the session has a
// transcript on disk. It is therefore both the liveness signal AND the only way to see a
// session that hasn't written its first message yet — session discovery reads it too.
function pidAlive(pid, procStart) {
  if (!pid) return false;
  let alive;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  if (!alive || !procStart) return alive;
  // Guard against PID reuse: the sidecar records the process start time, so compare it
  // with the live process's. Unreadable /proc (non-Linux) leaves the plain answer.
  const s = procStartTime(pid);
  return s === null ? alive : s === String(procStart);
}

// Field 22 of /proc/<pid>/stat (start time in clock ticks). comm may contain spaces and
// parens, so parse from the last ')'.
function procStartTime(pid) {
  let text;
  try { text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const rest = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return rest[19] || null;
}

// One directory read → sessionId → sidecar record for every live session. When a session
// has several live pids (a resume racing the old process), the most recently updated one
// wins. Records are the raw sidecar plus a normalized `status`.
function liveSessionRecords() {
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');
  const out = new Map();
  let files;
  try { files = fs.readdirSync(sessionsDir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    if (!d || !d.sessionId || !pidAlive(d.pid, d.procStart)) continue;
    const rec = {
      sessionId: d.sessionId, pid: Number(d.pid), cwd: d.cwd || '',
      name: d.name || '', status: d.status || 'unknown',
      statusUpdatedAt: d.statusUpdatedAt || null, updatedAt: d.updatedAt || 0,
      startedAt: d.startedAt || null, tmux: d.tmux || null,
      version: d.version || '', kind: d.kind || '',
    };
    const prev = out.get(rec.sessionId);
    if (!prev || (rec.updatedAt || 0) >= (prev.updatedAt || 0)) out.set(rec.sessionId, rec);
  }
  return out;
}

function sessionLiveness(sessionId) {
  const rec = liveSessionRecords().get(sessionId);
  if (!rec) return { live: false };
  return { live: true, pid: rec.pid, status: rec.status,
    statusUpdatedAt: rec.statusUpdatedAt, cwd: rec.cwd };
}

function liveSessionIds() {
  return new Set(liveSessionRecords().keys());
}

// Every live pid for a session — a resumed session can briefly have more than one, and
// all of them are legitimate injection targets.
function livePidsForSession(sessionId) {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const out = new Set();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (d && d.sessionId === sessionId && d.pid && pidAlive(d.pid, d.procStart)) out.add(Number(d.pid));
  }
  return out;
}

// The one permitted mutation: append a custom-title entry (Claude Code reads custom-title
// over ai-title). Appending is the safe write — it never rewrites the transcript.
function renameSession(sessionId, newTitle) {
  const filePath = findSessionJsonl(sessionId);
  if (!filePath) return { error: 'Session not found' };
  const entry = JSON.stringify({ type: 'custom-title', customTitle: newTitle, sessionId }) + '\n';
  try { fs.appendFileSync(filePath, entry); return { ok: true }; }
  catch (e) { return { error: e.message }; }
}

// ── tmux: locate a session's pane, inject input ───────────────────────────────
// A ccbb session view can drive a Claude session running inside a tmux pane on this host:
// input is pasted into the pane; the permission dialog (drawn only in the TUI, never in
// the JSONL) is scraped from the pane and mirrored to the front-end.
function tmux(args, input) {
  const r = spawnSync('tmux', args, { input, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`tmux ${args.join(' ')}: ${(r.stderr || (r.error && r.error.message) || '').trim()}`);
  return (r.stdout || '').trim();
}

function parentMap() {
  const r = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' });
  const m = new Map();
  for (const line of (r.stdout || '').split('\n')) {
    const mm = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (mm) m.set(Number(mm[1]), Number(mm[2]));
  }
  return m;
}

// Find the tmux pane hosting a running session by climbing each backing pid's ancestry
// until we hit a pane's root pid. Returns { pane, pid } or null.
function paneForSession(sessionId) {
  const pids = livePidsForSession(sessionId);
  if (!pids.size) return null;
  let paneLines;
  try { paneLines = tmux(['list-panes', '-a', '-F', '#{pane_pid} #{pane_id}']); }
  catch { return null; }
  const panePidToId = new Map();
  for (const l of paneLines.split('\n')) {
    const [pp, pid] = l.split(' ');
    if (pp && pid) panePidToId.set(Number(pp), pid);
  }
  const parent = parentMap();
  for (const pid of pids) {
    let cur = pid, guard = 0;
    while (cur && guard++ < 64) {
      if (panePidToId.has(cur)) return { pane: panePidToId.get(cur), pid };
      cur = parent.get(cur);
    }
  }
  return null;
}

// Paste text into the pane (bracketed paste keeps multi-line intact / no early submit),
// then press Enter to submit it to the running agent. `buffer` names the tmux paste
// buffer so concurrent front-ends don't clobber each other's paste.
function injectToPane(pane, text, buffer) {
  const buf = buffer || 'ccbbrelay';
  tmux(['load-buffer', '-b', buf, '-'], text);
  tmux(['paste-buffer', '-t', pane, '-b', buf, '-d', '-p']);
  tmux(['send-keys', '-t', pane, 'Enter']);
}

// ── Transcript / history ──────────────────────────────────────────
// Reduce a raw JSONL entry to a display entry, or null if it isn't a shown turn.
function transcriptEntry(d, opts) {
  if ((d.type !== 'user' && d.type !== 'assistant') || !d.message) return null;
  if (d.isSidechain === true && !(opts && opts.keepSidechain)) return null;
  let content = d.message.content;
  if (typeof content === 'string') content = [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return null;
  const message = {
    role: d.message.role,
    id: d.message.id || d.uuid,
    model: d.message.model || null,
    stop_reason: d.message.stop_reason || (d.type === 'assistant' ? 'end_turn' : null),
    usage: d.message.usage || null,
    content,
  };
  const e = { role: d.message.role, message, uuid: d.uuid, timestamp: d.timestamp || null };
  if (d.isCompactSummary === true) e.compact = true;
  // A completed Agent/Task tool call records its subagent id in toolUseResult. Tag the
  // matching tool_result so the client can lazily nest that subagent's transcript under the
  // tool card. One tool_result per JSONL line (verified), so the block is unambiguous.
  const tur = d.toolUseResult;
  if (tur && tur.agentId) {
    const tr = content.find(b => b && b.type === 'tool_result');
    if (tr && tr.tool_use_id)
      e.subagent = { agentId: String(tur.agentId), agentType: tur.agentType || '', toolUseId: tr.tool_use_id };
  }
  return e;
}

function getSessionCwd(sessionId) {
  const live = sessionLiveness(sessionId);
  if (live.cwd) return live.cwd;
  const filePath = findSessionJsonl(sessionId);
  if (!filePath) return null;
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); if (d.cwd) return d.cwd; } catch {}
  }
  return null;
}

// Full transcript for a session: each user/assistant entry, normalized via transcriptEntry.
function getSessionHistory(sessionId) {
  const filePath = findSessionJsonl(sessionId);
  if (!filePath) return [];
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const e = transcriptEntry(d);
    if (e) entries.push(e);
  }
  return entries;
}

// A window onto the transcript, so a front-end need not download a session's whole life to
// show the end of it. Indices are positions in the SAME array getSessionHistory returns, so
// a client can page around with them and resume from `total` after a dropped socket.
//
//   { head, tail }   the opening and the latest entries, with the gap between them
//   { from, to }     an explicit slice, [from, to)
//
// The file is still read and normalized in full — an entry's index isn't knowable without
// normalizing it, since transcriptEntry drops some lines. The saving is the response body,
// which on a long session is where the megabytes are.
function getSessionHistoryWindow(sessionId, opts = {}) {
  const all = getSessionHistory(sessionId);
  const total = all.length;
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
  if (opts.from != null || opts.to != null) {
    const from = clamp(Number(opts.from) || 0, 0, total);
    const to = clamp(opts.to == null ? total : Number(opts.to), from, total);
    return { total, from, entries: all.slice(from, to) };
  }
  const head = clamp(Number(opts.head) || 0, 0, total);
  const tail = clamp(Number(opts.tail) || 0, 0, total);
  // Overlapping window means the whole thing fits: send it as one run, no gap.
  if (head + tail >= total) return { total, from: 0, entries: all };
  return { total, head: all.slice(0, head), tailFrom: total - tail, tail: all.slice(total - tail) };
}

// Full transcript for one subagent (Agent/Task) run, to nest under its parent tool card.
// The file lives at <sessionDir>/<sessionId>/subagents/agent-<agentId>.jsonl. agentId is
// stripped to alphanumerics so it can't escape that directory. Sidechain entries are the
// whole point here, so they're kept.
function getSubagentHistory(sessionId, agentId) {
  const safe = String(agentId || '').replace(/[^a-zA-Z0-9]/g, '');
  if (!safe) return [];
  const mainPath = findSessionJsonl(sessionId);
  if (!mainPath) return [];
  const filePath = path.join(path.dirname(mainPath), sessionId, 'subagents', 'agent-' + safe + '.jsonl');
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const e = transcriptEntry(d, { keepSidechain: true });
    if (e) entries.push(e);
  }
  return entries;
}

function getSessionInfo(sessionId) {
  const filePath = findSessionJsonl(sessionId);
  const slug = filePath ? path.basename(path.dirname(filePath)) : '';
  const rec = liveSessionRecords().get(sessionId) || null;
  const projectPath = (rec && rec.cwd) || getSessionCwd(sessionId) || slug.replace(/^-+/, '').replace(/-/g, '/');
  const live = rec
    ? { live: true, status: rec.status, statusUpdatedAt: rec.statusUpdatedAt }
    : { live: false };
  const stats = getSessionStats(sessionId, { mainPath: filePath });
  // Before its first message a session has no transcript, hence no title or start time of
  // its own — the registry has both.
  return {
    sessionId,
    title: stats.title || (rec ? rec.name : '') || '',
    projectPath,
    startedAt: stats.startedAt || (rec && rec.startedAt ? new Date(rec.startedAt).toISOString() : null),
    live: live.live,
    liveStatus: live.status || null,
    liveStatusAt: live.statusUpdatedAt || null,
    stats,
  };
}

// ── Session-set watcher: "something in the session list changed" ──────────────
// Push, not poll: the list front-ends subscribe once and are told when a session appears,
// exits, changes status, or grows its transcript. Two sources, one debounced callback:
//   • ~/.claude/sessions      — the live registry (new/exited sessions, idle↔busy)
//   • ~/.claude/projects/*    — transcript appends (cost/tokens/context move)
// fs.watch is not recursive on Linux, so each project slug directory gets its own watcher
// and the parent watch adds them as new slugs appear. inotify can also drop events on
// some filesystems, so a slow re-check fires the same callback — it is a safety net, not
// a poll: subscribers diff before sending anything.
const RECHECK_MS = 30000;
let _watch = null;   // { subs, watchers, slugs, timer, recheck }

function watchSessionChanges(cb) {
  if (!_watch) {
    _watch = { subs: new Set(), watchers: new Map(), timer: null, recheck: null };
    _watchBegin(_watch);
  }
  _watch.subs.add(cb);
  return () => {
    if (!_watch) return;
    _watch.subs.delete(cb);
    if (_watch.subs.size) return;
    _watchEnd(_watch);
    _watch = null;
  };
}

function _watchFire(w) {
  if (w.timer) return;                       // already coalescing this burst
  w.timer = setTimeout(() => {
    w.timer = null;
    _watchSyncProjectDirs(w);
    for (const cb of Array.from(w.subs)) { try { cb(); } catch {} }
  }, 400);
  if (w.timer.unref) w.timer.unref();
}

// Watch a directory, tolerating its absence (a machine with no sessions yet) and swallowing
// the EPERM/ENOSPC that a watcher-starved system throws.
function _watchDir(w, dir) {
  if (w.watchers.has(dir)) return;
  let wa;
  try { wa = fs.watch(dir, () => _watchFire(w)); } catch { return; }
  wa.on('error', () => { try { wa.close(); } catch {} w.watchers.delete(dir); });
  w.watchers.set(dir, wa);
}

// Re-assert every watch: new project slugs, and the two base directories if they did not
// exist when we started (a machine whose first session is only now being created).
function _watchSyncProjectDirs(w) {
  _watchDir(w, path.join(CLAUDE_DIR, 'sessions'));
  _watchDir(w, path.join(CLAUDE_DIR, 'projects'));
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  let slugs = [];
  try { slugs = fs.readdirSync(projectsDir); } catch { return; }
  for (const slug of slugs) {
    const dir = path.join(projectsDir, slug);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    _watchDir(w, dir);
  }
}

function _watchBegin(w) {
  _watchSyncProjectDirs(w);
  w.recheck = setInterval(() => _watchFire(w), RECHECK_MS);
  if (w.recheck.unref) w.recheck.unref();
}

function _watchEnd(w) {
  if (w.timer) clearTimeout(w.timer);
  if (w.recheck) clearInterval(w.recheck);
  for (const wa of w.watchers.values()) { try { wa.close(); } catch {} }
  w.watchers.clear();
}

// ── Transcript tailer: JSONL → per-line callback (push, 400ms poll) ────────────
// Shared by every live front-end. Watches a session's main JSONL and invokes onLine with
// each newly-appended raw parsed entry. Reference-counted per session (multiple viewers
// share one watch). A brand-new session hasn't written its transcript yet, so if the file
// is missing we retry locating it every second until it appears, then tail from the end.
const _tailers = new Map();  // sessionId → { filePath, offset, onLine, onChange, findTimer, clients }

function startTail(sessionId, onLine) {
  const existing = _tailers.get(sessionId);
  if (existing) { existing.clients++; return; }
  const entry = { filePath: null, offset: 0, onLine, onChange: null, findTimer: null, clients: 1 };
  _tailers.set(sessionId, entry);
  _beginTail(sessionId, entry);
}
function _beginTail(sessionId, entry) {
  const filePath = findSessionJsonl(sessionId);
  if (!filePath) {
    entry.findTimer = setTimeout(() => { if (_tailers.get(sessionId) === entry) _beginTail(sessionId, entry); }, 1000);
    return;
  }
  entry.findTimer = null;
  entry.filePath = filePath;
  try { entry.offset = fs.statSync(filePath).size; } catch { entry.offset = 0; }
  entry.onChange = () => _readNewLines(sessionId);
  fs.watchFile(filePath, { interval: 400 }, entry.onChange);
}
function stopTail(sessionId) {
  const entry = _tailers.get(sessionId);
  if (!entry) return;
  if (entry.clients > 1) { entry.clients--; return; }
  if (entry.findTimer) clearTimeout(entry.findTimer);
  if (entry.filePath && entry.onChange) { try { fs.unwatchFile(entry.filePath, entry.onChange); } catch {} }
  _tailers.delete(sessionId);
}
function _readNewLines(sessionId) {
  const entry = _tailers.get(sessionId);
  if (!entry || !entry.filePath) return;
  let size;
  try { size = fs.statSync(entry.filePath).size; } catch { return; }
  if (size < entry.offset) entry.offset = 0;
  if (size === entry.offset) return;
  let buffer;
  try {
    const fd = fs.openSync(entry.filePath, 'r');
    buffer = Buffer.alloc(size - entry.offset);
    fs.readSync(fd, buffer, 0, buffer.length, entry.offset);
    fs.closeSync(fd);
  } catch { return; }
  const text = buffer.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl === -1) return;
  entry.offset += Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
  for (const line of text.slice(0, lastNl).split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    entry.onLine(d);
  }
}

// ── Permission-prompt parsing (shared; each front-end owns its watch/answer loop) ─
// The permission dialog is drawn only in the terminal — it never reaches the JSONL. The
// front-ends scrape it from the pane and mirror it. Detection keys on Claude Code's prompt
// strings; a version bump that rewords them needs these patterns re-tuned.
// Title lines across Claude Code's permission dialogs:
//   "Do you want to proceed?" / "…make this edit to X?" / "…create X?" / "…run X?"   (built-in tools)
//   "Would you like to proceed?"                                                      (plan mode)
//   "<Server> wants to <action>"                    (MCP tools, e.g. "Claude in Chrome wants to open a new browser tab")
//   "Do you trust the files in this folder?"                                          (workspace trust)
// Precision comes from parsePrompt, not the regex: a title only counts when a
// "1. …" option list starts within a few lines below it.
const PROMPT_RE = /Do you want to .+|Would you like to .+|\bwants to\b .+|Do you trust .+\?/i;
const OPTION_RE = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(.*\S)\s*$/;   // "  1. Yes"  /  "❯ 2. Yes, and ..."

function capturePane(pane) {
  try { return tmux(['capture-pane', '-t', pane, '-p']); }
  catch { return ''; }
}

// Parse a permission box out of a pane capture. Returns { title, options } or null.
function parsePrompt(text) {
  const lines = String(text || '').split('\n');
  for (let t = lines.length - 1; t >= 0; t--) {   // scan bottom-up: newest box wins
    if (!PROMPT_RE.test(lines[t])) continue;
    const title = lines[t].replace(/^[\s│|]+/, '').replace(/[\s│|]+$/, '').trim();
    const options = [];
    for (let i = t + 1; i < lines.length; i++) {
      const m = OPTION_RE.exec(lines[i].replace(/[│|]/g, ' '));
      if (m) options.push({ n: Number(m[1]), label: m[2].replace(/\s+/g, ' ').trim() });
      else if (!options.length && i - t > 6) break;   // a real dialog lists options right under its title
      // non-matching lines between/after options are tolerated (wrapped labels, blank rows)
    }
    // Need a real choice list starting at 1 — otherwise this title line was ordinary
    // transcript text (the widened PROMPT_RE matches prose like "X wants to …"), so
    // keep scanning upward for an actual dialog.
    if (options.length >= 2 && options[0].n === 1) return { title, options };
  }
  return null;
}

function promptFingerprint(p) {
  return crypto.createHash('sha1')
    .update(p.title + '|' + p.options.map(o => o.n + o.label).join('|'))
    .digest('hex').slice(0, 12);
}

// ── AskUserQuestion (shared; each front-end renders + answers its own way) ─────
// Like the permission box, the question dialog is drawn in the terminal — but unlike it,
// the questions ride in the JSONL tool_use input, so front-ends render from the
// transcript (no pane scraping) and answer by injecting the option number.
function askQuestions(input) {
  const qs = (input && Array.isArray(input.questions)) ? input.questions : [];
  return qs.map(q => ({
    header: String((q && q.header) || ''),
    question: String((q && q.question) || ''),
    multiSelect: !!(q && q.multiSelect),
    options: (Array.isArray(q && q.options) ? q.options : []).map((o, i) => ({
      n: i + 1,
      label: typeof o === 'string' ? o : String((o && o.label) || ''),
      description: (o && o.description) ? String(o.description) : '',
    })),
  }));
}

// Plain-text rendering of an AskUserQuestion input (tool cards, card fallbacks).
function formatAskText(input) {
  return askQuestions(input).map(q => {
    const head = (q.header ? `[${q.header}] ` : '') + q.question + (q.multiSelect ? ' (multi-select)' : '');
    return head + '\n' + q.options.map(o =>
      `  ${o.n}. ${o.label}${o.description ? ' — ' + o.description : ''}`).join('\n');
  }).join('\n\n');
}

// The AskUserQuestion tool_use whose dialog is open right now, or null. Open means the
// transcript's LAST entry is the assistant line carrying the tool_use: answering appends
// its tool_result, and an interrupt appends a user line, so any later entry closes it.
function openAskEntry(history) {
  const last = history[history.length - 1];
  if (!last || last.role !== 'assistant') return null;
  const arr = (last.message && Array.isArray(last.message.content)) ? last.message.content : [];
  const asks = arr.filter(b => b.type === 'tool_use' && b.name === 'AskUserQuestion');
  return asks.length ? asks[asks.length - 1] : null;
}

// ── Custom "//" commands (shared primitives) ──────────────────────────────────
// A command maps a name (invoked as "//name [args]") to a spec:
//   { "run": "ls -CF", "kind": "console" }   kind ∈ console|markdown|source
//   run may contain "$ARGS" (the raw arg string) and "$1".."$9".
// A few names are handled specially by callers (help/pwd/cd/clear/sh/usage/aws-*).
const BUILTIN_COMMANDS = {
  help:  { kind: 'markdown', builtin: 'help' },
  pwd:   { kind: 'console',  builtin: 'pwd' },
  cd:    { kind: 'console',  builtin: 'cd' },
  clear: { kind: 'console',  builtin: 'clear' },
  ls:    { run: 'ls -CF',    kind: 'console' },
  ll:    { run: 'ls -alF',   kind: 'console' },
  cat:   { run: 'cat $ARGS', kind: 'source' },
  sh:    { kind: 'console',  builtin: 'sh' },
  usage: { kind: 'markdown', builtin: 'usage' },
};

// User commands come from the "commands" object in CLAUDE_DIR/ccbb-config.json, re-read
// each call so edits take effect without a restart.
function loadCommands() {
  const cfg = readConfig();
  const user = (cfg && typeof cfg.commands === 'object' && cfg.commands) || {};
  return { ...BUILTIN_COMMANDS, ...user };
}

function truncTitle(s) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}

// Substitute $ARGS and $1..$9 into a command template. args is the raw string.
function expandRun(run, args) {
  const parts = args.trim().length ? args.trim().split(/\s+/) : [];
  let out = run.replace(/\$ARGS\b/g, args.trim());
  out = out.replace(/\$([1-9])\b/g, (_, i) => parts[i - 1] || '');
  return out;
}

function looksLikeDiff(s) {
  return /^(diff --git |--- |\+\+\+ |@@ )/m.test(s) && /^[+-]/m.test(s);
}

function langForFile(name) {
  const ext = path.extname(name || '').slice(1).toLowerCase();
  const map = { js:'javascript', ts:'typescript', tsx:'typescript', jsx:'javascript', py:'python',
    rb:'ruby', go:'go', rs:'rust', c:'c', h:'c', cpp:'cpp', java:'java', sh:'bash', bash:'bash',
    json:'json', html:'html', css:'css', md:'markdown', yml:'yaml', yaml:'yaml', toml:'toml',
    sql:'sql', diff:'diff', patch:'diff' };
  return map[ext] || '';
}

// ── AWS SSO helpers (shared semantics across front-ends) ──────────────────────
function awsWhoami(cli, profile) {
  const args = ['sts', 'get-caller-identity'];
  if (profile) args.push('--profile', profile);
  const r = spawnSync(cli, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const raw = ((r.stdout || '') + (r.stderr || '')).trim();
  const m = raw.match(/"UserId":\s*"([^"]+)"/);
  if (m) return { loggedIn: true, userId: m[1], raw };
  return { loggedIn: false, userId: null, raw };
}
function awsIdText(cli, profile) {
  const w = awsWhoami(cli, profile);
  return w.loggedIn ? `${w.userId} logged in.\n${w.raw}` : `not logged in\n${w.raw}`;
}
// Spawn `aws sso login --use-device-code` async; URL/code print early then it blocks until
// the browser login completes. onData streams output; onDone(ok, tail) signals end.
function awsLoginStream(cli, profile, onData, onDone) {
  const args = ['sso', 'login', '--use-device-code'];
  if (profile) args.splice(2, 0, '--profile', profile);
  const child = spawn(cli, args);
  let tail = '';
  const feed = buf => { const s = buf.toString('utf8'); tail = (tail + s).slice(-4000); if (onData) onData(s); };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('error', e => { if (onDone) onDone(false, `spawn failed: ${e.message}`); });
  child.on('close', code => { if (onDone) onDone(code === 0, tail.trim()); });
  return child;
}

// ── Session listing (shared by `ls` and `web`) ───────────────────────────────
// Scope a cached all-time stats object to one period (day/week/month) using its byPeriod
// breakdown — same shape the row builder reads, so no per-session re-read.
function periodView(st, kind, key) {
  const b = (((st.byPeriod || {})[kind]) || {})[key] || null;
  const emptyCats = { input: { tokens: 0, cost: 0 }, cacheRead: { tokens: 0, cost: 0 },
    cacheWrite: { tokens: 0, cost: 0 }, cacheMiss: { tokens: 0, cost: 0 }, output: { tokens: 0, cost: 0 } };
  return {
    title: st.title, startedAt: st.startedAt, lastActivity: st.lastActivity,
    hasUsage: st.hasUsage, context: st.context, contextMax: st.contextMax,
    cost: b ? b.cost : 0, totalTokens: b ? b.tokens : 0,
    turns: b ? b.turns : 0, subTurns: b ? b.subTurns : 0,
    categories: b ? b.categories : emptyCats,
    models: b ? b.models : [],
  };
}

// One list row from a session's stats, plus its live-registry record when it has one.
function sessionRow(sessionId, projectPath, stats, rec) {
  const cat = stats.categories;
  return {
    sessionId,
    title: stats.title || (rec ? rec.name : '') || '',
    live: !!rec,
    liveStatus: rec ? rec.status : null,
    liveStatusAt: rec ? rec.statusUpdatedAt : null,
    projectPath,
    startedAt: stats.startedAt || (rec && rec.startedAt ? new Date(rec.startedAt).toISOString() : null),
    lastActivity: stats.lastActivity || null,
    totalCost: stats.cost,
    totalTokens: stats.totalTokens,
    turns: stats.turns,
    subTurns: stats.subTurns,
    context: stats.context,
    contextMax: stats.contextMax,
    inputTokens: cat.input.tokens,
    cacheReadTokens: cat.cacheRead.tokens,
    cacheCreationTokens: cat.cacheWrite.tokens,
    cacheMissTokens: cat.cacheMiss.tokens,
    outputTokens: cat.output.tokens,
    inputCost: cat.input.cost,
    cacheReadCost: cat.cacheRead.cost,
    cacheCreationCost: cat.cacheWrite.cost,
    outputCost: cat.output.cost,
    modelBreakdowns: stats.models
      .filter(m => m.tokens > 0)
      .map(m => ({ modelName: m.model, cost: m.cost, tokens: m.tokens })),
  };
}

// One row per top-level session file, plus every live session the registry knows about —
// a session that has only just started has no transcript yet, so the files alone would
// miss it. Skips sessions with no billable usage in scope (all-time, or the selected
// period) unless includeEmpty is set; a live session is never skipped, since a zero-cost
// row is exactly what a session you're about to talk to looks like.
// periodFilter (optional) scopes each session's cost/tokens to one day/week/month.
function getSessions(periodFilter, includeEmpty) {
  maybeRefreshPricing();
  sessionPathIndex(true);
  const liveRecs = liveSessionRecords();
  const sessions = [];
  const seen = new Set();
  let totalCost = 0, totalTokens = 0;
  for (const filePath of sessionJsonlPaths()) {
    const sessionId = path.basename(filePath, '.jsonl');
    const slug = path.basename(path.dirname(filePath));
    seen.add(sessionId);
    const rec = liveRecs.get(sessionId) || null;
    const stats = periodFilter
      ? periodView(getSessionStats(sessionId, { mainPath: filePath }), periodFilter.period, periodFilter.key)
      : getSessionStats(sessionId, { mainPath: filePath });
    if (!stats.totalTokens && !includeEmpty && !rec) continue;
    totalCost += stats.cost;
    totalTokens += stats.totalTokens;
    sessions.push(sessionRow(sessionId, (rec && rec.cwd) || slug.replace(/^-+/, '').replace(/-/g, '/'), stats, rec));
  }
  // Live sessions with no transcript on disk yet: zero usage, everything else from the
  // registry. They cost nothing, so the totals stay correct under any period filter.
  for (const [sessionId, rec] of liveRecs) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    const all = getSessionStats(sessionId, {});
    const stats = periodFilter ? periodView(all, periodFilter.period, periodFilter.key) : all;
    sessions.push(sessionRow(sessionId, rec.cwd, stats, rec));
  }
  pruneStatsCache(seen);
  saveStatsCache();
  return { sessions, totals: { totalCost, totalTokens } };
}

// One row per session that ever had usage — plus every live session, which may have no
// usage yet — sorted by last activity (desc). The compact listing shape used by the bots'
// /list picker.
function listSessions() {
  maybeRefreshPricing();
  sessionPathIndex(true);
  const liveRecs = liveSessionRecords();
  const rows = [];
  const seen = new Set();
  for (const filePath of sessionJsonlPaths()) {
    const sessionId = path.basename(filePath, '.jsonl');
    seen.add(sessionId);
    const rec = liveRecs.get(sessionId) || null;
    const stats = getSessionStats(sessionId, { mainPath: filePath });
    if (!stats.totalTokens && !rec) continue;
    rows.push({
      sessionId,
      title: stats.title || (rec ? rec.name : '') || '',
      live: !!rec,
      cost: stats.cost,
      totalTokens: stats.totalTokens,
      lastActivity: stats.lastActivity || stats.startedAt || null,
    });
  }
  for (const [sessionId, rec] of liveRecs) {
    if (seen.has(sessionId)) continue;
    seen.add(sessionId);
    rows.push({
      sessionId,
      title: rec.name || '',
      live: true,
      cost: 0,
      totalTokens: 0,
      lastActivity: rec.startedAt ? new Date(rec.startedAt).toISOString() : null,
    });
  }
  pruneStatsCache(seen);
  saveStatsCache();
  rows.sort((a, b) => String(b.lastActivity || '').localeCompare(String(a.lastActivity || '')));
  return rows;
}

// ── Cost summary (all sessions, by provider & model, overall + monthly) ───────
function newBucket() {
  return {
    cost: 0, tokens: 0, turns: 0, subTurns: 0,
    // Response time and the output tokens produced in it, over main-transcript messages
    // only (see sessionContribution). Summed, not averaged, so buckets stay mergeable:
    // the avg and the tok/s rate are derived at render time.
    respMs: 0, respCount: 0, respOut: 0,
    categories: {
      input:      { tokens: 0, cost: 0 },
      cacheRead:  { tokens: 0, cost: 0 },
      cacheWrite: { tokens: 0, cost: 0 },
      cacheMiss:  { tokens: 0, cost: 0 },
      output:     { tokens: 0, cost: 0 },
    },
  };
}
function addToBucket(b, m) {
  b.cost += m.cost; b.tokens += m.tokens;
  b.turns += 1; if (m.sub) b.subTurns += 1;
  if (m.respMs != null) { b.respMs += m.respMs; b.respCount += 1; b.respOut += m.out; }
  b.categories.input.tokens      += m.inp;     b.categories.input.cost      += m.cInp;
  b.categories.cacheRead.tokens  += m.cr;      b.categories.cacheRead.cost  += m.cCr;
  b.categories.cacheWrite.tokens += m.cw;      b.categories.cacheWrite.cost += m.cCw;
  b.categories.cacheMiss.tokens  += m.missTok; b.categories.cacheMiss.cost  += m.missCost;
  b.categories.output.tokens     += m.out;     b.categories.output.cost     += m.cOut;
}
function addBucketInto(d, s) {
  d.cost += s.cost; d.tokens += s.tokens; d.turns += s.turns; d.subTurns += s.subTurns;
  d.respMs += s.respMs || 0; d.respCount += s.respCount || 0; d.respOut += s.respOut || 0;
  for (const k of Object.keys(s.categories)) {
    d.categories[k].tokens += s.categories[k].tokens;
    d.categories[k].cost   += s.categories[k].cost;
  }
}
function mergeScope(dst, src) {
  addBucketInto(dst.all, src.all);
  for (const p of Object.keys(src.byProvider)) addBucketInto(dst.byProvider[p] || (dst.byProvider[p] = newBucket()), src.byProvider[p]);
  for (const m of Object.keys(src.byModel))    addBucketInto(dst.byModel[m]    || (dst.byModel[m]    = newBucket()), src.byModel[m]);
}
function newScope() { return { all: newBucket(), byProvider: {}, byModel: {} }; }
// One session's contribution to the cost summary: `overall` (all-time) plus per-day/week/
// month scope buckets. Cache-miss uses the session's first billable message.
function sessionContribution(usagePaths) {
  const overall = newScope();
  const byPeriod = { day: {}, week: {}, month: {} };
  const seen = new Set();
  const slug = (scope, key) => { if (!scope[key]) scope[key] = newBucket(); return scope[key]; };
  const addScope = (sc, m, prov, model) => { addToBucket(sc.all, m); addToBucket(slug(sc.byProvider, prov), m); addToBucket(slug(sc.byModel, model), m); };
  const mainPath = usagePaths[0];
  const firstSeen = {};
  let lastUserTs = null;
  for (const fp of usagePaths) {
    const isSub = fp !== mainPath;
    let text;
    try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      // Anchor for response time: the last user entry (prompt or tool_result) before an
      // assistant message. Main transcript only — subagent turns are billed but their
      // timings aren't part of the session's measured response. Mirrors computeSessionStats.
      if (!isSub && d.type === 'user' && d.timestamp) {
        const t = Date.parse(d.timestamp);
        if (!isNaN(t)) lastUserTs = t;
      }
      if (d.type !== 'assistant' || !d.message || !d.message.usage) continue;
      const dkey = d.message.id ? d.message.id + '|' + (d.requestId || '') : null;
      if (dkey && seen.has(dkey)) continue;
      if (dkey) seen.add(dkey);
      const u = d.message.usage;
      const inp = u.input_tokens || 0, out = u.output_tokens || 0;
      const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
      const p = priceForModel(d.message.model);
      const cc = u.cache_creation || null;
      const cw5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : cw;
      const cw1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
      const cInp = inp * p.input / 1e6, cOut = out * p.output / 1e6;
      const cCr = cr * p.cacheRead / 1e6;
      const cCw = (cw5 * p.cacheWrite5m + cw1 * p.cacheWrite1h) / 1e6;
      const isFirst = !firstSeen[fp];
      firstSeen[fp] = true;
      const miss = (cr === 0 && !isFirst);
      // null (not 0) when unmeasurable, so addToBucket can tell "no sample" from "0ms".
      let respMs = null;
      if (!isSub && d.timestamp && lastUserTs != null) {
        const r = Date.parse(d.timestamp) - lastUserTs;
        if (r >= 0) respMs = r;
      }
      const m = {
        inp, out, cr, cw, cInp, cOut, cCr, cCw, sub: isSub ? 1 : 0,
        missTok: miss ? cw : 0, missCost: miss ? cCw : 0,
        tokens: inp + out + cr + cw, cost: cInp + cOut + cCr + cCw,
        respMs,
      };
      const prov = String(d.message.id || '').startsWith('msg_bdrk_') ? 'bedrock' : 'anthropic';
      const model = d.message.model || 'unknown';
      addScope(overall, m, prov, model);
      for (const kind of ['day', 'week', 'month']) {
        const pk = periodKey(d.timestamp, kind);
        if (!pk) continue;
        addScope(byPeriod[kind][pk] || (byPeriod[kind][pk] = newScope()), m, prov, model);
      }
    }
  }
  return { overall, byPeriod };
}

// periodFilter (optional): { period, key } — when set, only in-period messages count
// toward `overall`. `months` is always built for the web scope selector.
function getCostSummary(periodFilter) {
  const overall = newScope();
  const months = {};
  for (const filePath of sessionJsonlPaths()) {
    const sid = path.basename(filePath, '.jsonl');
    const full = getSessionSummary(sid, filePath, up => sessionContribution(up));
    const ov = periodFilter ? (full.byPeriod[periodFilter.period] || {})[periodFilter.key] : full.overall;
    if (ov) mergeScope(overall, ov);
    for (const mk of Object.keys(full.byPeriod.month)) mergeScope(months[mk] || (months[mk] = newScope()), full.byPeriod.month[mk]);
  }
  saveStatsCache();
  return { overall, months };
}

// ── Exports ────────────────────────────────────────────────────────────────
module.exports = {
  CLAUDE_DIR, CONFIG_FILE, CACHE_FILE, readConfig,
  // multi-server
  serverIdentity, peerList, peerByName, peerToken,
  // pricing
  PRICING, priceTable: PRICE_TABLE, priceForModel, contextMaxFor,
  loadTable, priceForModelIn, tableSig, normalizeId, convertLiteLLM,
  maybeRefreshPricing, updatePricingNow, LITELLM_URL, LIVE_FILE, MAX_AGE_MS, fileAgeMs,
  // discovery + stats
  periodKey, sessionJsonlPaths, sessionPathIndex, findSessionJsonl,
  collectJsonl, sessionUsagePaths, computeSessionStats, getSessionStats, getSessionSummary,
  buildSkeleton, buildAllSkeletons,
  loadStatsCache, saveStatsCache, sessionSig, pruneStatsCache,
  // listing + cost summary
  getSessions, listSessions, sessionContribution, getCostSummary,
  // subscription usage windows
  getSubscription, subscriptionAccount, maybeRefreshUsage, USAGE_FILE,
  // liveness + mutation
  pidAlive, sessionLiveness, liveSessionIds, liveSessionRecords, livePidsForSession, renameSession,
  // tmux + transcript
  tmux, paneForSession, injectToPane,
  transcriptEntry, getSessionCwd, getSessionHistory, getSessionHistoryWindow,
  getSubagentHistory, getSessionInfo,
  startTail, stopTail, watchSessionChanges,
  // permission parsing
  PROMPT_RE, OPTION_RE, capturePane, parsePrompt, promptFingerprint,
  // AskUserQuestion
  askQuestions, formatAskText, openAskEntry,
  // commands + aws
  BUILTIN_COMMANDS, loadCommands, truncTitle, expandRun, looksLikeDiff, langForFile,
  awsWhoami, awsIdText, awsLoginStream,
};

// CLI: `node ccbb-common.js --update-pricing` (used by maybeRefreshPricing's child).
if (require.main === module && process.argv[2] === '--update-pricing') {
  updatePricingNow()
    .then(o => { console.error(`ccbb pricing: wrote ${Object.keys(o.byId).length} models → ${LIVE_FILE}`); process.exit(0); })
    .catch(e => { console.error('ccbb pricing update failed: ' + e.message); process.exit(1); });
}
