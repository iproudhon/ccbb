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
//     "confluence": { "baseUrl": "…", "token": "…", "rootPageId": "…", "allow": […] } }
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; }
  catch { return {}; }
}

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
  const s = { startedAt: null, lastActivity: null, totalTokens: 0, cost: 0, turns: 0,
    categories, models: [], providers: [], context: null, subTurns: 0, hasUsage: false, title: '' };
  let lastCtxTs = null, lastCtx = null;
  let lastCompactTs = null, lastCompactTokens = 0;
  let aiTitle, customTitle, firstTs = null;
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
      if (d.type === 'assistant' && d.message && d.message.usage) s.hasUsage = true;
      const dkey = (d.message && d.message.id) ? d.message.id + '|' + (d.requestId || '') : null;
      if (d.type === 'assistant' && d.message && d.message.usage &&
          inPeriod(d.timestamp) && !(dkey && seenMsgIds.has(dkey))) {
        if (dkey) seenMsgIds.add(dkey);
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
        if (!lastCtxTs || (d.timestamp && d.timestamp >= lastCtxTs)) {
          lastCtxTs = d.timestamp || lastCtxTs;
          const ctxTok = inp + cr + cw + out;
          lastCtx = { tokens: ctxTok, cost: ctxTok * p.cacheRead / 1e6, model: d.message.model || null, max: contextMaxFor(d.message.model) };
        }
      }
    }
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
    if (d && d.version === 2 && d.sessions && d.pricingSig === PRICING_SIG) _statsCache = d;
  } catch { /* missing/corrupt → start fresh */ }
  if (!_statsCache) _statsCache = { version: 2, pricingSig: PRICING_SIG, sessions: {} };
  return _statsCache;
}
function saveStatsCache() {
  if (!_cacheDirty) return;
  const c = loadStatsCache();
  const tmp = CACHE_FILE + '.tmp.' + process.pid;
  try { fs.writeFileSync(tmp, JSON.stringify(c)); fs.renameSync(tmp, CACHE_FILE); }
  catch { /* cache is best-effort */ }
  _cacheDirty = false;
}
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

// ── Live-session liveness (from ~/.claude/sessions/<pid>.json sidecars) ────────
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function sessionLiveness(sessionId) {
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');
  if (!fs.existsSync(sessionsDir)) return { live: false };
  let files;
  try { files = fs.readdirSync(sessionsDir); } catch { return { live: false }; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    if (d.sessionId !== sessionId) continue;
    if (!pidAlive(d.pid)) continue;
    return { live: true, pid: d.pid, status: d.status || 'unknown', cwd: d.cwd || '' };
  }
  return { live: false };
}

function liveSessionIds() {
  const sessionsDir = path.join(CLAUDE_DIR, 'sessions');
  const out = new Set();
  let files;
  try { files = fs.readdirSync(sessionsDir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
    if (d && d.sessionId && pidAlive(d.pid)) out.add(d.sessionId);
  }
  return out;
}

function livePidsForSession(sessionId) {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const out = new Set();
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (d && d.sessionId === sessionId && d.pid && pidAlive(d.pid)) out.add(Number(d.pid));
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
function transcriptEntry(d) {
  if ((d.type !== 'user' && d.type !== 'assistant') || !d.message) return null;
  if (d.isSidechain === true) return null;
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

function getSessionInfo(sessionId) {
  const filePath = findSessionJsonl(sessionId);
  const slug = filePath ? path.basename(path.dirname(filePath)) : '';
  const projectPath = getSessionCwd(sessionId) || slug.replace(/^-+/, '').replace(/-/g, '/');
  const live = sessionLiveness(sessionId);
  const stats = getSessionStats(sessionId, { mainPath: filePath });
  return {
    sessionId,
    title: stats.title || '',
    projectPath,
    startedAt: stats.startedAt || null,
    live: live.live,
    liveStatus: live.status || null,
    stats,
  };
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
const PROMPT_RE = /Do you want to (?:proceed\?|make this edit|create|run|.+\?)/i;
const OPTION_RE = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(.*\S)\s*$/;   // "  1. Yes"  /  "❯ 2. Yes, and ..."

function capturePane(pane) {
  try { return tmux(['capture-pane', '-t', pane, '-p']); }
  catch { return ''; }
}

// Parse a permission box out of a pane capture. Returns { title, options } or null.
function parsePrompt(text) {
  const lines = String(text || '').split('\n');
  let titleIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {   // scan bottom-up: newest box wins
    if (PROMPT_RE.test(lines[i])) { titleIdx = i; break; }
  }
  if (titleIdx === -1) return null;
  const title = lines[titleIdx].replace(/^[\s│|]+/, '').replace(/[\s│|]+$/, '').trim();
  const options = [];
  for (let i = titleIdx + 1; i < lines.length; i++) {
    const m = OPTION_RE.exec(lines[i].replace(/[│|]/g, ' '));
    if (m) options.push({ n: Number(m[1]), label: m[2].replace(/\s+/g, ' ').trim() });
    else if (options.length && !lines[i].trim()) continue;  // tolerate blank lines between options
  }
  if (options.length < 2) return null;   // need a real choice list
  return { title, options };
}

function promptFingerprint(p) {
  return crypto.createHash('sha1')
    .update(p.title + '|' + p.options.map(o => o.n + o.label).join('|'))
    .digest('hex').slice(0, 12);
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
    hasUsage: st.hasUsage, context: null,
    cost: b ? b.cost : 0, totalTokens: b ? b.tokens : 0,
    turns: b ? b.turns : 0, subTurns: b ? b.subTurns : 0,
    categories: b ? b.categories : emptyCats,
    models: b ? b.models : [],
  };
}

// One row per top-level session file. Skips sessions that never had billable usage.
// periodFilter (optional) scopes each session's cost/tokens to one day/week/month.
function getSessions(periodFilter) {
  maybeRefreshPricing();
  sessionPathIndex(true);
  const live = liveSessionIds();
  const sessions = [];
  const seen = new Set();
  let totalCost = 0, totalTokens = 0;
  for (const filePath of sessionJsonlPaths()) {
    const sessionId = path.basename(filePath, '.jsonl');
    const slug = path.basename(path.dirname(filePath));
    seen.add(sessionId);
    const stats = periodFilter
      ? periodView(getSessionStats(sessionId, { mainPath: filePath }), periodFilter.period, periodFilter.key)
      : getSessionStats(sessionId, { mainPath: filePath });
    if (periodFilter ? !stats.hasUsage : !stats.totalTokens) continue;
    const cat = stats.categories;
    const modelBreakdowns = stats.models
      .filter(m => m.tokens > 0)
      .map(m => ({ modelName: m.model, cost: m.cost, tokens: m.tokens }));
    totalCost += stats.cost;
    totalTokens += stats.totalTokens;
    sessions.push({
      sessionId,
      title: stats.title || '',
      live: live.has(sessionId),
      projectPath: slug.replace(/^-+/, '').replace(/-/g, '/'),
      startedAt: stats.startedAt || null,
      lastActivity: stats.lastActivity || null,
      totalCost: stats.cost,
      totalTokens: stats.totalTokens,
      turns: stats.turns,
      subTurns: stats.subTurns,
      context: stats.context,
      inputTokens: cat.input.tokens,
      cacheReadTokens: cat.cacheRead.tokens,
      cacheCreationTokens: cat.cacheWrite.tokens,
      cacheMissTokens: cat.cacheMiss.tokens,
      outputTokens: cat.output.tokens,
      inputCost: cat.input.cost,
      cacheReadCost: cat.cacheRead.cost,
      cacheCreationCost: cat.cacheWrite.cost,
      outputCost: cat.output.cost,
      modelBreakdowns,
    });
  }
  pruneStatsCache(seen);
  saveStatsCache();
  return { sessions, totals: { totalCost, totalTokens } };
}

// One row per session that ever had usage, sorted by last activity (desc). The compact
// listing shape used by the bots' /list picker.
function listSessions() {
  maybeRefreshPricing();
  sessionPathIndex(true);
  const rows = [];
  const seen = new Set();
  for (const filePath of sessionJsonlPaths()) {
    const sessionId = path.basename(filePath, '.jsonl');
    seen.add(sessionId);
    const stats = getSessionStats(sessionId, { mainPath: filePath });
    if (!stats.totalTokens) continue;
    rows.push({
      sessionId,
      title: stats.title || '',
      cost: stats.cost,
      totalTokens: stats.totalTokens,
      lastActivity: stats.lastActivity || stats.startedAt || null,
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
  b.categories.input.tokens      += m.inp;     b.categories.input.cost      += m.cInp;
  b.categories.cacheRead.tokens  += m.cr;      b.categories.cacheRead.cost  += m.cCr;
  b.categories.cacheWrite.tokens += m.cw;      b.categories.cacheWrite.cost += m.cCw;
  b.categories.cacheMiss.tokens  += m.missTok; b.categories.cacheMiss.cost  += m.missCost;
  b.categories.output.tokens     += m.out;     b.categories.output.cost     += m.cOut;
}
function addBucketInto(d, s) {
  d.cost += s.cost; d.tokens += s.tokens; d.turns += s.turns; d.subTurns += s.subTurns;
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
  for (const fp of usagePaths) {
    const isSub = fp !== mainPath;
    let text;
    try { text = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
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
      const m = {
        inp, out, cr, cw, cInp, cOut, cCr, cCw, sub: isSub ? 1 : 0,
        missTok: miss ? cw : 0, missCost: miss ? cCw : 0,
        tokens: inp + out + cr + cw, cost: cInp + cOut + cCr + cCw,
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
  // pricing
  PRICING, priceTable: PRICE_TABLE, priceForModel, contextMaxFor,
  loadTable, priceForModelIn, tableSig, normalizeId, convertLiteLLM,
  maybeRefreshPricing, updatePricingNow, LITELLM_URL, LIVE_FILE, MAX_AGE_MS, fileAgeMs,
  // discovery + stats
  periodKey, sessionJsonlPaths, sessionPathIndex, findSessionJsonl,
  collectJsonl, sessionUsagePaths, computeSessionStats, getSessionStats, getSessionSummary,
  loadStatsCache, saveStatsCache, sessionSig, pruneStatsCache,
  // listing + cost summary
  getSessions, listSessions, sessionContribution, getCostSummary,
  // liveness + mutation
  pidAlive, sessionLiveness, liveSessionIds, livePidsForSession, renameSession,
  // tmux + transcript
  tmux, paneForSession, injectToPane,
  transcriptEntry, getSessionCwd, getSessionHistory, getSessionInfo,
  startTail, stopTail,
  // permission parsing
  PROMPT_RE, OPTION_RE, capturePane, parsePrompt, promptFingerprint,
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
