# `ccbb-ls` — Claude Code session listing, as a command

A self-contained `ccbb-ls` command that lists this machine's Claude Code sessions with estimated
cost, token breakdown, turns and the current context, preceded by a per-provider cost summary.

```
> ccbb-ls -d
Cost summary — today (Aug 31)
             USD TOKENS     TURNS     CR     CW     CM    OUT     IN        TIME
Bedrock    $0.27 107.0K         2  13.1%  85.6%      —   1.3%   0.0% 3.3s 21.9/s

TITLE                               COST   TOKENS            CTX  ACTIVITY      PROJECT
ccbb on vscode                     $0.27   107.0K   68.4K/$0.03  Aug 31 10:44  ~/src/ccbb

1 session today (Aug 31)  ·  total $0.27 / 107.0K tokens  ·  sorted by activity
```

Everything it needs is in this one document. There is nothing to clone, nothing to `npm install`,
and it never touches the network. It only reads your Claude Code home directory — no file in it is
modified. It runs on Linux, macOS, WSL and Windows (Command Prompt, PowerShell and Git Bash alike).

> **To install it: paste this whole document into a Claude Code session and say _"set this up"_.**
> Everything Claude Code needs is in *Install* below — it detects the platform, writes the files,
> puts `ccbb-ls` on `PATH`, and runs `ccbb-ls -a` to prove it works.

## Requirements

- **Claude Code** (any recent version) — it reads the session transcripts Claude Code writes.
- **Node.js** on `PATH` as `node`. If you installed Claude Code with npm you already have it;
  otherwise `winget install OpenJS.NodeJS`, your package manager, or https://nodejs.org.

Nothing else. The script uses Node builtins only (`fs`, `os`, `path`) and is a single file.

## Install

The script always goes to the same place — `~/.claude/ccbb-ls.js`, which is
`%USERPROFILE%\.claude\ccbb-ls.js` on Windows. Only the way `ccbb-ls` reaches your `PATH` differs.

### Linux, macOS, WSL

The script carries a `#!/usr/bin/env node` shebang, so it needs no wrapper — make it executable and
symlink it into a directory that is already on `PATH`:

```sh
mkdir -p ~/.claude ~/.local/bin
# write File 1 to ~/.claude/ccbb-ls.js first
chmod +x ~/.claude/ccbb-ls.js
ln -sf ~/.claude/ccbb-ls.js ~/.local/bin/ccbb-ls
```

`~/.local/bin` is on `PATH` by default on most distributions and on macOS with Homebrew. If
`command -v ccbb-ls` comes up empty afterwards, add it once — to `~/.bashrc`, or `~/.zshrc` on a
default macOS shell:

```sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
```

A system-wide install works too: `sudo ln -sf ~/.claude/ccbb-ls.js /usr/local/bin/ccbb-ls`.

### Windows

Two small launchers, because Windows has no shebang. Put both in `%APPDATA%\npm` — npm's global bin
directory, which is **already on your `PATH`** (it is where `claude.cmd` itself lives), so nothing
further has to be configured:

| File | Used by |
|---|---|
| `%USERPROFILE%\.claude\ccbb-ls.js` | — the script itself (File 1) |
| `%APPDATA%\npm\ccbb-ls.cmd` | Command Prompt and PowerShell (File 2) |
| `%APPDATA%\npm\ccbb-ls` | Git Bash / MSYS (File 3) |

The pair mirrors npm's own convention: Windows shells resolve `ccbb-ls` to the `.cmd` through
`PATHEXT`, while Git Bash ignores `PATHEXT` and picks up the extensionless shell script. You need
both only if you use both kinds of shell.

To keep your own scripts out of npm's directory, put the launchers anywhere else —
`%USERPROFILE%\bin` is the usual choice — and add that directory to your user `PATH` once, from
PowerShell:

```powershell
[Environment]::SetEnvironmentVariable('Path',
  [Environment]::GetEnvironmentVariable('Path','User') + ";$env:USERPROFILE\bin", 'User')
```

### Verify

Open a **new** shell — `PATH` is read at startup — and run:

```
ccbb-ls -a
```

A table means you are done. Anything else: see *Troubleshooting* at the end.

> **WSL and Windows are separate installs.** Each has its own Claude Code home and its own sessions,
> and neither can see the other's. Install `ccbb-ls` on both sides if you use Claude Code on both.

## File 1 — `~/.claude/ccbb-ls.js`

The whole command. Save it verbatim; on Unix `chmod +x` it.

````javascript
#!/usr/bin/env node
'use strict';
// ccbb-ls — standalone Claude Code session listing. One file, node builtins only.
//
//   ccbb-ls [options]            (or: node ccbb-ls.js [options])
//
// Reads ~/.claude (or %USERPROFILE%\.claude, or $CLAUDE_CONFIG_DIR) and prints a
// column-adaptive table of sessions with estimated cost, tokens, turns and context,
// preceded by a per-provider cost summary. Nothing is written; nothing is fetched.
//
// This is a self-contained port of `ccbb ls` — no ccbb repo, no node_modules, no network.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PRICING_FILE = path.join(CLAUDE_DIR, 'ccbb-pricing.json');

// ── Pricing ───────────────────────────────────────────────────────────────────
// USD per 1M tokens. Per-id snapshot first, then a family tier fallback for ids that
// aren't listed. If CLAUDE_DIR/ccbb-pricing.json exists (written by the full ccbb) it
// overrides the snapshot; it is never fetched here.
const FALLBACK_TIERS = {
  opus:   { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  sonnet: { input: 3, output: 15, cacheRead: 0.3, cacheWrite5m: 3.75, cacheWrite1h: 6 },
  haiku:  { input: 1, output: 5,  cacheRead: 0.1, cacheWrite5m: 1.25, cacheWrite1h: 2 },
};
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
// AWS Bedrock charges a premium over list price for the regional inference profiles Claude
// Code uses there ("geo and in-region cross-region inference"): +10% on every price component
// for Sonnet 4.5 / Haiku 4.5 / Opus 4.5 and newer, nothing on the older models. Transcripts
// record only the bare model id, never the us./eu./apac. profile it went through, so the
// premium is keyed off the provider instead: a message id starting with `msg_bdrk_` is
// Bedrock. The premium is a uniform scalar per model, so it's a multiplier over the
// first-party price rather than a second table. Ids not listed get BEDROCK_PREMIUM, which is
// the right guess for anything recent.
const BEDROCK_PREMIUM = 1.1;
const SNAPSHOT_BEDROCK_MULT = {
  'claude-3-5-haiku': 1,
  'claude-3-5-sonnet': 1,
  'claude-3-7-sonnet': 1,
  'claude-3-haiku': 1,
  'claude-3-opus': 1,
  'claude-3-sonnet': 1,
  'claude-4-opus': 1,
  'claude-4-sonnet': 1,
  'claude-opus-4': 1,
  'claude-opus-4-1': 1,
  'claude-sonnet-4': 1,
};
const CONTEXT_MAX = 200000;

function pnum(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
function round6(x) { return Math.round(x * 1e6) / 1e6; }
// Bedrock/Vertex decorate the id with a region prefix and a version suffix
// ("us.anthropic.claude-opus-4-8-v1:0"); strip both so one table serves every provider.
function normalizeId(model) {
  let m = String(model || '').toLowerCase().trim();
  m = m.replace(/^(us|eu|apac|au|global)\./, '');
  m = m.replace(/^(anthropic|bedrock)[./]/, '');
  m = m.replace(/[:-]v\d+(:\d+)?$/, '');
  return m;
}
function normalizePrice(p) {
  p = p || {};
  const cw5 = round6(pnum(p.cacheWrite5m, pnum(p.cacheWrite, 0)));
  return {
    input: round6(pnum(p.input, 0)), output: round6(pnum(p.output, 0)),
    cacheRead: round6(pnum(p.cacheRead, 0)),
    cacheWrite5m: cw5, cacheWrite1h: round6(pnum(p.cacheWrite1h, cw5)),
  };
}
const PRICE_TABLE = (() => {
  const t = { byId: {}, tiers: {}, bedrockMult: { ...SNAPSHOT_BEDROCK_MULT }, bedrockPremium: BEDROCK_PREMIUM };
  for (const k of Object.keys(FALLBACK_TIERS)) t.tiers[k] = normalizePrice(FALLBACK_TIERS[k]);
  for (const k of Object.keys(SNAPSHOT_BY_ID)) t.byId[k] = normalizePrice(SNAPSHOT_BY_ID[k]);
  t.default = t.tiers.sonnet;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf8')); } catch {}
  if (j) {
    if (j.byId) for (const k of Object.keys(j.byId)) t.byId[k] = normalizePrice(j.byId[k]);
    if (j.tiers) for (const k of Object.keys(j.tiers)) t.tiers[k] = normalizePrice(j.tiers[k]);
    if (j.default) t.default = normalizePrice(j.default);
    if (j.bedrockMult) for (const k of Object.keys(j.bedrockMult)) t.bedrockMult[k] = pnum(j.bedrockMult[k], 1);
  }
  return t;
})();
const bedrockPrices = new Map();
// provider 'bedrock' applies the regional-inference premium; anything else (a Claude
// subscription or a first-party API key) is list price. Called once per billed message.
function priceForModel(model, provider) {
  const id = normalizeId(model);
  const trimmed = id.replace(/-\d{6,}$/, '');   // dated id → undated family entry
  let base;
  if (PRICE_TABLE.byId[id]) base = PRICE_TABLE.byId[id];
  else if (trimmed !== id && PRICE_TABLE.byId[trimmed]) base = PRICE_TABLE.byId[trimmed];
  else if (id.includes('opus')) base = PRICE_TABLE.tiers.opus;
  else if (id.includes('haiku')) base = PRICE_TABLE.tiers.haiku;
  else if (id.includes('sonnet')) base = PRICE_TABLE.tiers.sonnet;
  else base = PRICE_TABLE.default;
  if (provider !== 'bedrock') return base;
  const mm = PRICE_TABLE.bedrockMult;
  const k = mm[id] != null ? mm[id] : (mm[trimmed] != null ? mm[trimmed] : PRICE_TABLE.bedrockPremium);
  if (!(k > 0) || k === 1) return base;
  const key = id + '@' + k;
  let p = bedrockPrices.get(key);
  if (!p) {
    p = normalizePrice({ input: base.input * k, output: base.output * k, cacheRead: base.cacheRead * k,
      cacheWrite5m: base.cacheWrite5m * k, cacheWrite1h: base.cacheWrite1h * k });
    bedrockPrices.set(key, p);
  }
  return p;
}
// The only provider signal a transcript carries: Bedrock stamps ids with a msg_bdrk_ prefix.
function providerOf(messageId) { return String(messageId || '').startsWith('msg_bdrk_') ? 'bedrock' : 'anthropic'; }

// ── Periods ───────────────────────────────────────────────────────────────────
// A bucket key in LOCAL time: day → YYYY-MM-DD, month → YYYY-MM, week → the Monday's date.
function pad2(n) { return String(n).padStart(2, '0'); }
function periodKey(iso, period) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const y = d.getFullYear(), mo = pad2(d.getMonth() + 1), day = pad2(d.getDate());
  if (period === 'month') return `${y}-${mo}`;
  if (period === 'day') return `${y}-${mo}-${day}`;
  const monday = new Date(y, d.getMonth(), d.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));   // Mon=0 … Sun=6
  return `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
}
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDay(d) { return `${MON[d.getMonth()]} ${d.getDate()}`; }
function currentPeriod(period) {
  const now = new Date();
  const key = periodKey(now.toISOString(), period);
  if (period === 'day') return { period, key, label: `today (${fmtDay(now)})` };
  if (period === 'month') return { period, key, label: `this month (${MON[now.getMonth()]} ${now.getFullYear()})` };
  const [y, m, d] = key.split('-').map(Number);
  return { period, key, label: `this week (${fmtDay(new Date(y, m - 1, d))}–${fmtDay(new Date(y, m - 1, d + 6))})` };
}

// ── Discovery ─────────────────────────────────────────────────────────────────
// One .jsonl per session under CLAUDE_DIR/projects/<slug>/. Subagent transcripts live in
// a <sessionId>/ subdirectory beside the main file and bill to the same session.
function sessionJsonlPaths() {
  const projectsDir = path.join(CLAUDE_DIR, 'projects');
  const out = [];
  let slugs;
  try { slugs = fs.readdirSync(projectsDir); } catch { return out; }
  for (const slug of slugs) {
    let files;
    try { files = fs.readdirSync(path.join(projectsDir, slug)); } catch { continue; }
    for (const f of files) if (f.endsWith('.jsonl')) out.push(path.join(projectsDir, slug, f));
  }
  return out;
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
function usagePathsFor(sessionId, mainPath) {
  const paths = [mainPath];
  collectJsonl(path.join(path.dirname(mainPath), sessionId), paths);
  return paths;
}

// ── Live registry ─────────────────────────────────────────────────────────────
// Claude Code writes CLAUDE_DIR/sessions/<pid>.json for each running process, before the
// session has any transcript — so it is both the liveness signal and the only way to see
// a brand-new session. procStart guards against pid reuse where it can be checked:
// /proc/<pid>/stat field 22 on Linux, and nothing comparable on Windows (the sidecar's
// pidDomain says which host wrote it), so there the plain kill(0) answer stands.
function procStartTime(pid) {
  let text;
  try { text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19] || null;
}
function pidAlive(pid, procStart, pidDomain) {
  if (!pid) return false;
  let alive;
  try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  if (!alive || !procStart) return alive;
  if (process.platform === 'win32' || /^win32:/.test(String(pidDomain || ''))) return alive;
  const s = procStartTime(pid);
  return s === null ? alive : s === String(procStart);
}
function liveSessionRecords() {
  const out = new Map();
  let files;
  try { files = fs.readdirSync(path.join(CLAUDE_DIR, 'sessions')); } catch { return out; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(CLAUDE_DIR, 'sessions', f), 'utf8')); } catch { continue; }
    if (!d || !d.sessionId || !pidAlive(d.pid, d.procStart, d.pidDomain)) continue;
    const rec = { sessionId: d.sessionId, cwd: d.cwd || '', name: d.name || '',
      startedAt: d.startedAt || null, updatedAt: d.updatedAt || 0 };
    const prev = out.get(rec.sessionId);
    if (!prev || rec.updatedAt >= prev.updatedAt) out.set(rec.sessionId, rec);
  }
  return out;
}

// ── One pass per session ──────────────────────────────────────────────────────
// Reads the session's transcripts once and returns both the list row and this session's
// contribution to the per-provider cost summary, for ONE scope (all time, or the selected
// day/week/month). Cost is estimated from recorded usage × pricing.
//
// Scoped fields (cost, tokens, turns, categories) count only in-period messages.
// Unscoped, always all-time: title, startedAt, lastActivity, cwd, and context — context
// is a property of the session as it stands now, not of the period being reported.
function emptyCats() {
  return { input: { tokens: 0, cost: 0 }, cacheRead: { tokens: 0, cost: 0 },
    cacheWrite: { tokens: 0, cost: 0 }, cacheMiss: { tokens: 0, cost: 0 },
    output: { tokens: 0, cost: 0 } };
}
function newBucket() {
  // respMs/respOut are SUMS, not averages, so buckets stay mergeable; the avg and the
  // tok/s rate are derived at render time.
  return { cost: 0, tokens: 0, turns: 0, subTurns: 0,
    respMs: 0, respCount: 0, respOut: 0, categories: emptyCats() };
}
function addToBucket(b, m) {
  b.cost += m.cost; b.tokens += m.tokens;
  b.turns += 1; if (m.sub) b.subTurns += 1;
  if (m.respMs != null) { b.respMs += m.respMs; b.respCount += 1; b.respOut += m.out; }
  const c = b.categories;
  c.input.tokens      += m.inp;     c.input.cost      += m.cInp;
  c.cacheRead.tokens  += m.cr;      c.cacheRead.cost  += m.cCr;
  c.cacheWrite.tokens += m.cw;      c.cacheWrite.cost += m.cCw;
  c.cacheMiss.tokens  += m.missTok; c.cacheMiss.cost  += m.missCost;
  c.output.tokens     += m.out;     c.output.cost     += m.cOut;
}
function addBucketInto(d, s) {
  d.cost += s.cost; d.tokens += s.tokens; d.turns += s.turns; d.subTurns += s.subTurns;
  d.respMs += s.respMs; d.respCount += s.respCount; d.respOut += s.respOut;
  for (const k of Object.keys(s.categories)) {
    d.categories[k].tokens += s.categories[k].tokens;
    d.categories[k].cost   += s.categories[k].cost;
  }
}

const SPIKE_RATIO = 1.8, NEIGHBOR_SYM = 0.7;
function scanSession(sessionId, usagePaths, periodFilter) {
  const inPeriod = ts => !periodFilter || periodKey(ts, periodFilter.period) === periodFilter.key;
  const row = { sessionId, title: '', cwd: null, startedAt: null, lastActivity: null,
    totalCost: 0, totalTokens: 0, turns: 0, subTurns: 0, hasUsage: false,
    categories: emptyCats(), context: null, contextMax: null,
    cacheTtl: null, lastAssistantAt: null };
  const byProvider = {};
  const mainPath = usagePaths[0];
  const firstSeen = {};          // per file: has the first in-scope billable message passed?
  const seenMsgIds = new Set();  // dedup: the same response can be written twice
  const seenTurnIds = new Set();
  const seenCtxIds = new Set();
  const ctxSamples = [];
  let aiTitle, customTitle, firstTs = null, lastUserTs = null;
  let lastCtxTs = null, lastCtx = null, maxCtx = null;
  let lastCompactTs = null, lastCompactTokens = 0;

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
        if (row.cwd === null && d.cwd) row.cwd = d.cwd;
        // A custom title (last one wins) beats the model's auto-title (first one wins).
        if (d.type === 'ai-title' && aiTitle === undefined) aiTitle = d.aiTitle || '';
        else if (d.type === 'custom-title') customTitle = d.customTitle || '';
      }
      if (d.sessionId !== sessionId) continue;
      if (d.timestamp) {
        if (!row.startedAt || d.timestamp < row.startedAt) row.startedAt = d.timestamp;
        if (!row.lastActivity || d.timestamp > row.lastActivity) row.lastActivity = d.timestamp;
      }
      // /compact replaces the context with its summary, so the context after the last
      // compact is the summary's size, not the last response's usage.
      if (d.isCompactSummary === true && d.timestamp && (!lastCompactTs || d.timestamp >= lastCompactTs)) {
        lastCompactTs = d.timestamp;
        const c = d.message && d.message.content;
        const sumStr = typeof c === 'string' ? c : (c ? JSON.stringify(c) : '');
        lastCompactTokens = Math.ceil(sumStr.length / 4);
      }
      // Response-time anchor: the last user entry (prompt OR tool_result) before an
      // assistant message, main transcript only — one response spans several entries.
      if (isMain && d.type === 'user' && d.timestamp) {
        const t = Date.parse(d.timestamp);
        if (!isNaN(t)) lastUserTs = t;
      }
      if (d.type !== 'assistant' || !d.message || !d.message.usage) continue;
      row.hasUsage = true;
      const dkey = d.message.id ? d.message.id + '|' + (d.requestId || '') : null;
      if (dkey && seenMsgIds.has(dkey)) continue;

      const u = d.message.usage;
      const inp = u.input_tokens || 0, out = u.output_tokens || 0;
      const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
      const prov = providerOf(d.message.id);
      const p = priceForModel(d.message.model, prov);
      const cc = u.cache_creation || null;
      const cw5 = cc ? (cc.ephemeral_5m_input_tokens || 0) : cw;
      const cw1 = cc ? (cc.ephemeral_1h_input_tokens || 0) : 0;
      const cInp = inp * p.input / 1e6, cOut = out * p.output / 1e6;
      const cCr = cr * p.cacheRead / 1e6;
      const cCw = (cw5 * p.cacheWrite5m + cw1 * p.cacheWrite1h) / 1e6;
      const ctxTok = inp + cr + cw + out;

      if (isMain && d.timestamp && (!row.lastAssistantAt || d.timestamp > row.lastAssistantAt)) {
        row.lastAssistantAt = d.timestamp;
        if (cw1 > 0) row.cacheTtl = 3600;
        else if (cw5 > 0) row.cacheTtl = 300;
      }

      // Context is all-time: sample every turn, then pick current and peak below.
      if (!(d.message.id && seenCtxIds.has(d.message.id))) {
        if (d.message.id) seenCtxIds.add(d.message.id);
        ctxSamples.push({ tokens: ctxTok, cost: ctxTok * p.cacheRead / 1e6 });
      }
      if (!lastCtxTs || (d.timestamp && d.timestamp >= lastCtxTs)) {
        lastCtxTs = d.timestamp || lastCtxTs;
        lastCtx = { tokens: ctxTok, cost: ctxTok * p.cacheRead / 1e6, model: d.message.model || null, provider: prov };
      }

      if (!inPeriod(d.timestamp)) continue;
      if (dkey) seenMsgIds.add(dkey);
      // Cache MISS: a cache write with no cache read, on anything but the first message —
      // the first write is the unavoidable one, later ones mean the cache went cold.
      const isFirst = !firstSeen[filePath];
      firstSeen[filePath] = true;
      const miss = (cr === 0 && !isFirst);
      let respMs = null;   // null, not 0, so "no sample" differs from "0ms"
      if (isMain && d.timestamp && lastUserTs != null) {
        const r = Date.parse(d.timestamp) - lastUserTs;
        if (r >= 0) respMs = r;
      }
      const m = { inp, out, cr, cw, cInp, cOut, cCr, cCw, sub: isMain ? 0 : 1,
        missTok: miss ? cw : 0, missCost: miss ? cCw : 0,
        tokens: inp + out + cr + cw, cost: cInp + cOut + cCr + cCw, respMs };

      const cat = row.categories;
      cat.input.tokens += inp;      cat.input.cost += cInp;
      cat.cacheRead.tokens += cr;   cat.cacheRead.cost += cCr;
      cat.cacheWrite.tokens += cw;  cat.cacheWrite.cost += cCw;
      cat.output.tokens += out;     cat.output.cost += cOut;
      if (miss) { cat.cacheMiss.tokens += cw; cat.cacheMiss.cost += cCw; }
      row.totalTokens += m.tokens;
      row.totalCost += m.cost;
      // A row's TURNS counts distinct responses; the summary's counts billed messages.
      if (d.message.id && !seenTurnIds.has(d.message.id)) {
        seenTurnIds.add(d.message.id);
        if (isMain) row.turns++; else row.subTurns++;
      }
      addToBucket(byProvider[prov] || (byProvider[prov] = newBucket()), m);
    }
  }

  // Peak context: differs from current after a /compact, or when the last turn was smaller
  // than an earlier one. Discount cache-accounting spikes — on a prompt-cache refresh the
  // usage can double-count the cached prefix, so one turn reads ~2x its neighbours and
  // reverts on the next. Signature: >=1.8x both neighbours AND the neighbours agree with
  // each other (which also rejects a small subagent turn sitting between two main turns).
  for (let i = 0; i < ctxSamples.length; i++) {
    const s = ctxSamples[i], prev = ctxSamples[i - 1], next = ctxSamples[i + 1];
    if (prev && next) {
      const lo = Math.min(prev.tokens, next.tokens), hi = Math.max(prev.tokens, next.tokens);
      if (hi > 0 && s.tokens >= SPIKE_RATIO * hi && lo >= NEIGHBOR_SYM * hi) continue;
    }
    if (!maxCtx || s.tokens > maxCtx.tokens) maxCtx = { tokens: s.tokens, cost: s.cost };
  }
  if (lastCompactTs && (!lastCtxTs || lastCompactTs > lastCtxTs)) {
    const model = lastCtx ? lastCtx.model : null;
    const provider = lastCtx ? lastCtx.provider : null;
    const p = priceForModel(model, provider);
    lastCtx = { tokens: lastCompactTokens, cost: lastCompactTokens * p.cacheRead / 1e6,
      model, provider, postCompact: true };
  }
  // Cost of resending this context once the prompt cache has expired; the render picks
  // between this and the cache-read cost above by how long ago the last turn was.
  if (lastCtx) {
    const p = priceForModel(lastCtx.model, lastCtx.provider);
    const ttl = row.cacheTtl || 300;
    lastCtx.costWrite = lastCtx.tokens * (ttl >= 3600 ? p.cacheWrite1h : p.cacheWrite5m) / 1e6;
  }
  row.context = lastCtx;
  row.contextMax = maxCtx;
  row.title = customTitle !== undefined ? customTitle : (aiTitle || '');
  if (!row.startedAt) row.startedAt = firstTs || null;
  return { row, byProvider };
}

// The slug is a lossy encoding of the cwd (every separator, colon and dot became "-"), so
// it is the last resort: the live sidecar's cwd and the transcript's own cwd field are exact.
function deslug(slug) {
  const m = /^([A-Za-z])--(.*)$/.exec(slug);
  if (m) return m[1].toUpperCase() + ':\\' + m[2].replace(/-/g, '\\');   // C--Users-me → C:\Users\me
  if (slug.startsWith('--')) return '\\\\' + slug.slice(2).replace(/-/g, '\\');   // UNC / \\wsl.localhost
  return '/' + slug.replace(/^-+/, '').replace(/-/g, '/');
}

// Every session with billable usage in scope, plus every live session (a session you are
// about to talk to legitimately has zero cost), plus the per-provider summary.
function collect(periodFilter, includeEmpty) {
  const liveRecs = liveSessionRecords();
  const rows = [];
  const seen = new Set();
  const summary = {};
  let totalCost = 0, totalTokens = 0;
  const addSummary = byProvider => {
    for (const p of Object.keys(byProvider)) addBucketInto(summary[p] || (summary[p] = newBucket()), byProvider[p]);
  };
  for (const filePath of sessionJsonlPaths()) {
    const sessionId = path.basename(filePath, '.jsonl');
    const slug = path.basename(path.dirname(filePath));
    seen.add(sessionId);
    const rec = liveRecs.get(sessionId) || null;
    const { row, byProvider } = scanSession(sessionId, usagePathsFor(sessionId, filePath), periodFilter);
    addSummary(byProvider);
    if (!row.totalTokens && !includeEmpty && !rec) continue;
    row.live = !!rec;
    row.title = row.title || (rec ? rec.name : '') || '';
    row.projectPath = (rec && rec.cwd) || row.cwd || deslug(slug);
    totalCost += row.totalCost;
    totalTokens += row.totalTokens;
    rows.push(row);
  }
  for (const [sessionId, rec] of liveRecs) {   // live, but no transcript on disk yet
    if (seen.has(sessionId)) continue;
    rows.push({ sessionId, title: rec.name || '', live: true, projectPath: rec.cwd,
      startedAt: rec.startedAt ? new Date(rec.startedAt).toISOString() : null,
      lastActivity: null, totalCost: 0, totalTokens: 0, turns: 0, subTurns: 0,
      categories: emptyCats(), context: null, contextMax: null });
  }
  return { rows, summary, totals: { totalCost, totalTokens } };
}

// ── Rendering ─────────────────────────────────────────────────────────────────
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = COLOR ? {
  dim: s => '\x1b[2m' + s + '\x1b[0m',
  bold: s => '\x1b[1m' + s + '\x1b[0m',
  green: s => '\x1b[32m' + s + '\x1b[0m',
  red: s => '\x1b[31m' + s + '\x1b[0m',
  yellow: s => '\x1b[33m' + s + '\x1b[0m',
  cyan: s => '\x1b[36m' + s + '\x1b[0m',
  magenta: s => '\x1b[35m' + s + '\x1b[0m',
  gray: s => '\x1b[90m' + s + '\x1b[0m',
} : new Proxy({}, { get: () => (s => String(s)) });

function fmtCost(v) { return v != null ? '$' + Number(v).toFixed(2) : '—'; }

// Resending the context costs cache-read price while the prompt cache is still warm, and
// cache-write price once it has expired — a wall-clock question, so it is answered here at
// render time rather than baked into the cached stats.
function cacheCold(s) {
  const t = s.lastAssistantAt ? Date.parse(s.lastAssistantAt) : NaN;
  return isNaN(t) || (Date.now() - t) > (s.cacheTtl || 300) * 1000;
}
function ctxResendCost(s) {
  const ctx = s.context;
  if (!ctx) return null;
  return cacheCold(s) && ctx.costWrite != null ? ctx.costWrite : ctx.cost;
}
// Green cost = a cheap cache read; red = the cache went cold and the whole context is rebilled
// at write price. The token count stays yellow either way.
function ctxColor(v, s) {
  const i = v.lastIndexOf('$');
  if (i <= 0) return c.yellow(v);
  return c.yellow(v.slice(0, i)) + (cacheCold(s) ? c.red : c.green)(v.slice(i));
}

function fmtTokK(t) {
  t = t || 0;
  if (t >= 1e9) return (t / 1e9).toFixed(1) + 'B';
  if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
  if (t >= 1e3) return (t / 1e3).toFixed(1) + 'K';
  return String(t);
}
// Avg response time + output tokens/sec for a bucket, e.g. "17s 49.0/s".
function fmtRespRate(b) {
  if (!b || !b.respCount || !(b.respMs > 0)) return '—';
  const avgS = b.respMs / b.respCount / 1000;
  return (avgS < 10 ? avgS.toFixed(1) + 's' : Math.round(avgS) + 's') +
    ' ' + (b.respOut / (b.respMs / 1000)).toFixed(1) + '/s';
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 16);
  const now = new Date();
  const day = String(d.getDate()).padStart(2, ' ');
  return d.getFullYear() === now.getFullYear()
    ? `${MON[d.getMonth()]} ${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    : `${MON[d.getMonth()]} ${day}  ${d.getFullYear()}`;
}
function visLen(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, '').length; }
function padEnd(s, n) { const p = n - visLen(s); return p > 0 ? s + ' '.repeat(p) : s; }
function padStart(s, n) { const p = n - visLen(s); return p > 0 ? ' '.repeat(p) + s : s; }
function trunc(s, n) {
  s = String(s == null ? '' : s);
  if (visLen(s) <= n) return s;
  if (s.indexOf('\x1b') === -1) return s.slice(0, Math.max(0, n - 1)) + '…';
  let out = '', vis = 0;
  for (let i = 0; i < s.length && vis < n - 1; ) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += s[i]; i++; vis++;
  }
  return out + '…\x1b[0m';
}

// Resolve flexible widths, then print a header and one line per row. opts.gap overrides the
// inter-column spacing (default 2) — the summary is all fixed-width columns, so a tighter
// gap is the only lossless way to keep it inside 80.
function printTable(cols, rows, width, opts) {
  const gap = (opts && opts.gap) || 2;
  const fixed = cols.filter(col => !col.flex).reduce((a, col) => a + col.w, 0);
  const flexCols = cols.filter(col => col.flex);
  const avail = width - fixed - (cols.length - 1) * gap;
  if (flexCols.length) {
    if (avail < flexCols.reduce((a, col) => a + col.min, 0)) {
      flexCols.forEach(col => { col.w = col.min; });
    } else {
      const totalWeight = flexCols.reduce((a, col) => a + (col.weight || 1), 0);
      let used = 0;
      flexCols.forEach((col, i) => {
        if (i === flexCols.length - 1) col.w = Math.max(col.min, avail - used);
        else { col.w = Math.max(col.min, Math.floor(avail * (col.weight || 1) / totalWeight)); used += col.w; }
      });
    }
  }
  const renderRow = (cells, r) => cols.map((col, i) => {
    let v = trunc(cells[i], col.w);
    if (r && col.color) v = col.color(v, r);
    return col.align === 'r' ? padStart(v, col.w) : padEnd(v, col.w);
  }).join(' '.repeat(gap));
  console.log(c.bold(renderRow(cols.map(col => col.head), null)));
  for (const r of rows) console.log(renderRow(cols.map(col => col.get(r)), r));
}

const PROV_LABEL = { bedrock: 'Bedrock', anthropic: 'Sub' };
function printCostSummary(summary, label, extended, width) {
  const keys = Object.keys(summary).filter(k => summary[k].tokens > 0).sort((a, b) => summary[b].cost - summary[a].cost);
  if (!keys.length) return;
  const pctStr = (cat, rowCost) => !cat || !cat.tokens ? '—'
    : (rowCost > 0 ? (cat.cost / rowCost * 100).toFixed(1) : '0.0') + '%';
  const catVal = (cat, rowCost) => !extended ? pctStr(cat, rowCost)
    : (!cat || !cat.tokens ? '—' : `${fmtTokK(cat.tokens)} ${c.gray(pctStr(cat, rowCost))}`);
  const rowFor = (name, b) => ({
    name, cost: fmtCost(b.cost), tokens: fmtTokK(b.tokens),
    turns: String(b.turns || 0) + (b.subTurns ? '+' + b.subTurns : ''),
    cr: catVal(b.categories.cacheRead, b.cost), cw: catVal(b.categories.cacheWrite, b.cost),
    cm: catVal(b.categories.cacheMiss, b.cost), out: catVal(b.categories.output, b.cost),
    in: catVal(b.categories.input, b.cost), time: fmtRespRate(b),
  });
  const rows = keys.map(k => rowFor(PROV_LABEL[k] || k, summary[k]));
  if (keys.length > 1) {
    const all = newBucket();
    for (const k of keys) addBucketInto(all, summary[k]);
    rows.push(rowFor('Total', all));
  }
  const cw = extended ? 13 : 6;
  const cols = [
    { head: '', align: 'l', w: Math.max.apply(null, rows.map(r => r.name.length)), get: r => r.name, color: c.bold },
    { head: 'USD', align: 'r', w: 8, get: r => r.cost, color: c.green },
    // fmtTokK never exceeds 6 chars ("999.9M"/"1.0B"), so the spare column goes to TURNS,
    // which would otherwise clip an all-time "10855+882".
    { head: 'TOKENS', align: 'r', w: 6, get: r => r.tokens, color: c.gray },
    { head: 'TURNS', align: 'r', w: 9, get: r => r.turns, color: c.gray },
    { head: extended ? 'CACHE READ' : 'CR',  align: 'r', w: cw, get: r => r.cr, color: extended ? null : c.gray },
    { head: extended ? 'CACHE WRITE' : 'CW', align: 'r', w: cw, get: r => r.cw, color: extended ? null : c.gray },
    { head: extended ? 'CACHE MISS' : 'CM',  align: 'r', w: cw, get: r => r.cm, color: extended ? null : c.gray },
    { head: 'OUT', align: 'r', w: extended ? 12 : 6, get: r => r.out, color: extended ? null : c.gray },
    { head: 'IN',  align: 'r', w: extended ? 12 : 6, get: r => r.in,  color: extended ? null : c.gray },
    { head: 'TIME', align: 'r', w: 11, get: r => r.time, color: c.gray },
  ];
  console.log(c.bold(`Cost summary${label ? ' — ' + label : ''}`));
  printTable(cols, rows, width, { gap: 1 });   // gap 1: with TIME, gap 2 runs to 89 cols
  console.log('');
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const SORT_KEYS = {
  activity: { col: 'lastActivity', dir: 'desc' },
  start:    { col: 'startedAt',    dir: 'desc' },
  cost:     { col: 'totalCost',    dir: 'desc' },
  turns:    { col: 'turns',        dir: 'desc' },
  tokens:   { col: 'totalTokens',  dir: 'desc' },
  name:     { col: 'title',        dir: 'asc'  },
};
const GROUP_ALIAS = { day: 'day', daily: 'day', week: 'week', weekly: 'week', month: 'month', monthly: 'month' };

function parseArgs(args) {
  // Default scope is the current month; -a widens to all time. -z keeps empty sessions.
  const opt = { sort: 'activity', reverse: false, includeEmpty: false, wide: false,
    limit: 0, group: 'month', width: 0, fence: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--sort') opt.sort = args[++i];
    else if (/^--sort=/.test(a)) opt.sort = a.slice(7);
    else if (a === '-r' || a === '--reverse') opt.reverse = true;
    else if (a === '-a' || a === '--all') opt.group = null;
    else if (a === '-z' || a === '--empty') opt.includeEmpty = true;
    else if (a === '-x' || a === '--wide') opt.wide = true;
    else if (a === '-n' || a === '--limit') opt.limit = parseInt(args[++i], 10) || 0;
    else if (a === '-d' || a === '--daily') opt.group = 'day';
    else if (a === '-w' || a === '--weekly') opt.group = 'week';
    else if (a === '-m' || a === '--monthly') opt.group = 'month';
    else if (a === '-g' || a === '--group') opt.group = GROUP_ALIAS[args[++i]] || 'invalid';
    else if (/^--group=/.test(a)) opt.group = GROUP_ALIAS[a.slice(8)] || 'invalid';
    else if (a === '--width') opt.width = parseInt(args[++i], 10) || 0;
    else if (/^--width=/.test(a)) opt.width = parseInt(a.slice(8), 10) || 0;
    else if (a === '--fence') opt.fence = true;
    else if (a === '-h' || a === '--help') opt.help = true;
    else if (/^-\d+$/.test(a)) opt.limit = parseInt(a.slice(1), 10) || 0;
  }
  return opt;
}

function help() {
  console.log(`ccbb-ls — list Claude Code sessions

Usage: ccbb-ls [options]

Sorting (default: activity, descending):
  -s, --sort <key>   activity | start | cost | turns | tokens | name
  -r, --reverse      reverse the sort direction

Scope (default: this month; each session's cost/tokens count only messages in
the period; sessions with no usage in scope are dropped):
  -a, --all          all time (no period scope)
  -d, --daily        only today's usage
  -w, --weekly       only this week's usage (Mon-anchored)
  -m, --monthly      only this month's usage (the default)
  -g, --group <unit> day | week | month   (periods use local time)

Display:
  -x, --wide         force extended columns
  -z, --empty        include sessions with no usage in scope
  -n, --limit <n>    show only the first n rows
      --width <n>    assume n columns (default: terminal width, or 100 when piped)
      --fence        wrap the output in a \`\`\` block (for pasting into markdown)
  -h, --help         this help

Reads $CLAUDE_CONFIG_DIR, else ~/.claude (%USERPROFILE%\\.claude on Windows).
Columns adapt to the width. A wide view (>=120, or -x) adds turns, per-category
tokens, and the context column: current / largest / would-be resend cost
(largest only when it differs). Context is all-time even in a scoped view.`);
}

function main() {
  const opt = parseArgs(process.argv.slice(2));
  if (opt.help) return help();
  if (opt.group === 'invalid') {
    console.error('ccbb-ls: --group must be one of: day, week, month');
    process.exit(1);
  }
  if (!SORT_KEYS[opt.sort]) {
    console.error(`ccbb-ls: unknown sort key '${opt.sort}'. Valid: ${Object.keys(SORT_KEYS).join(', ')}`);
    process.exit(1);
  }
  const periodFilter = opt.group ? currentPeriod(opt.group) : null;
  const { rows: all, summary, totals } = collect(periodFilter, opt.includeEmpty);

  // A just-started session has no activity yet — sort it by when it started, so it lands
  // at the top of the default view instead of the bottom.
  const spec = SORT_KEYS[opt.sort];
  const dir = opt.reverse ? (spec.dir === 'asc' ? 'desc' : 'asc') : spec.dir;
  let rows = all.slice().sort((a, b) => {
    const va = spec.col === 'lastActivity' ? (a.lastActivity || a.startedAt) : a[spec.col];
    const vb = spec.col === 'lastActivity' ? (b.lastActivity || b.startedAt) : b[spec.col];
    let cmp;
    if (va == null && vb == null) cmp = 0;
    else if (va == null) cmp = 1;
    else if (vb == null) cmp = -1;
    else if (typeof va === 'number' || typeof vb === 'number') cmp = (va || 0) - (vb || 0);
    else cmp = String(va).toLowerCase() < String(vb).toLowerCase() ? -1
            : String(va).toLowerCase() > String(vb).toLowerCase() ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
  if (opt.limit > 0) rows = rows.slice(0, opt.limit);

  if (opt.fence) console.log('```');
  if (!rows.length) {
    console.log(periodFilter ? `No sessions active ${periodFilter.label}.` : 'No sessions found.');
    if (opt.fence) console.log('```');
    return;
  }
  const width = opt.width || process.stdout.columns || 100;
  const extended = opt.wide || width >= 120;
  printCostSummary(summary, periodFilter ? periodFilter.label : 'all time', extended, width);

  const cols = [];
  // No ID column: the 8-char session id stands in, dimmed, only when there is no title.
  cols.push({ head: 'TITLE', align: 'l', flex: true, min: 16,
    get: s => s.title || s.sessionId.slice(0, 8),
    color: (v, s) => s.title ? v : c.dim(v) });
  cols.push({ head: 'COST', align: 'r', w: 8, get: s => fmtCost(s.totalCost), color: c.green });
  cols.push({ head: 'TOKENS', align: 'r', w: 7, get: s => fmtTokK(s.totalTokens), color: c.gray });
  if (extended) {
    cols.push({ head: 'TURNS', align: 'r', w: 6, color: c.gray,
      get: s => String(s.turns || 0) + (s.subTurns ? '+' + s.subTurns : '') });
    cols.push({ head: 'CR', align: 'r', w: 7, get: s => fmtTokK(s.categories.cacheRead.tokens), color: c.gray });
    cols.push({ head: 'CW', align: 'r', w: 7, get: s => fmtTokK(s.categories.cacheWrite.tokens), color: c.gray });
    cols.push({ head: 'CM', align: 'r', w: 7, get: s => fmtTokK(s.categories.cacheMiss.tokens), color: c.gray });
    cols.push({ head: 'OUT', align: 'r', w: 7, get: s => fmtTokK(s.categories.output.tokens), color: c.gray });
    cols.push({ head: 'IN', align: 'r', w: 7, get: s => fmtTokK(s.categories.input.tokens), color: c.gray });
    cols.push({ head: 'CONTEXT', align: 'r', w: 20, color: ctxColor,
      get: s => {
        const ctx = s.context;
        if (!ctx) return '—';
        const cur = (ctx.postCompact ? '~' : '') + fmtTokK(ctx.tokens);
        const mx = s.contextMax;
        const showMax = mx && fmtTokK(mx.tokens) !== fmtTokK(ctx.tokens);
        return cur + (showMax ? '/' + fmtTokK(mx.tokens) : '') + '/' + fmtCost(ctxResendCost(s));
      } });
  } else {
    // Narrow view: current context size and what the next turn pays to resend it.
    cols.push({ head: 'CTX', align: 'r', w: 14, color: ctxColor,
      get: s => s.context
        ? (s.context.postCompact ? '~' : '') + fmtTokK(s.context.tokens) + '/' + fmtCost(ctxResendCost(s))
        : '—' });
  }
  cols.push({ head: 'ACTIVITY', align: 'l', w: 12, get: s => fmtDate(s.lastActivity), color: c.cyan });
  if (extended) cols.push({ head: 'STARTED', align: 'l', w: 12, get: s => fmtDate(s.startedAt), color: c.cyan });
  cols.push({ head: 'PROJECT', align: 'l', flex: true, min: 12, weight: 0.5,
    get: s => s.projectPath || '', color: c.magenta });

  printTable(cols, rows, width);
  console.log('');
  console.log(c.dim(`${rows.length} session${rows.length === 1 ? '' : 's'}` +
    `${periodFilter ? ' ' + periodFilter.label : ''}` +
    `  ·  total ${fmtCost(totals.totalCost)} / ${fmtTokK(totals.totalTokens)} tokens` +
    `  ·  sorted by ${opt.sort}${opt.reverse ? ' (reversed)' : ''}`));
  if (opt.fence) console.log('```');
}

main();
````

## File 2 — `%APPDATA%\npm\ccbb-ls.cmd`  *(Windows only)*

The Command Prompt / PowerShell launcher. `%*` forwards whatever you typed after `ccbb-ls`.
Save it with **CRLF** line endings — any Windows editor does this by default, and so does
`Set-Content`.

````bat
@echo off
node "%USERPROFILE%\.claude\ccbb-ls.js" %*
````

## File 3 — `%APPDATA%\npm\ccbb-ls`  *(Windows only, for Git Bash)*

No extension, **LF** line endings, and it must start with the `#!` line:

````sh
#!/bin/sh
exec node "${USERPROFILE:-$HOME}/.claude/ccbb-ls.js" "$@"
````

`$USERPROFILE` is what makes this portable — Git Bash inherits it from Windows, and `node.exe`
happily takes the `C:\Users\you/.claude/...` path that results. The `$HOME` fallback means the same
file also works as a launcher on Linux or macOS, if you would rather install a wrapper there than
symlink the script.

**PowerShell without touching `PATH`.** If you would rather install no launcher at all, append a
function to your profile (`notepad $PROFILE`) instead — it affects only PowerShell:

````powershell
function ccbb-ls { node "$env:USERPROFILE\.claude\ccbb-ls.js" @args }
````

## Usage

```
ccbb-ls                    this month (the default)
ccbb-ls -d                 today only
ccbb-ls -w                 this week (Monday-anchored)
ccbb-ls -a                 all time
ccbb-ls -a -s cost         all time, most expensive first
ccbb-ls -x                 extended columns: turns, per-category tokens, context
ccbb-ls -a -n 10           top 10 rows only
```

Full option list:

| Option | Effect |
|---|---|
| `-s, --sort <key>` | `activity` (default) \| `start` \| `cost` \| `turns` \| `tokens` \| `name` |
| `-r, --reverse` | reverse the sort direction |
| `-a, --all` | all time — no period scope |
| `-d` / `-w` / `-m` | scope to today / this week / this month (`-m` is the default) |
| `-g, --group <unit>` | `day` \| `week` \| `month`, same thing spelled out |
| `-x, --wide` | force the extended columns |
| `-z, --empty` | also show sessions with no billable usage in scope |
| `-n, --limit <n>` | first *n* rows only |
| `--width <n>` | assume *n* columns (default: terminal width, or 100 when piped) |
| `--fence` | wrap the output in a fenced code block, for pasting into markdown or a chat |
| `-h, --help` | the same list, from the script |

Columns adapt to the width. Below 120 you get `TITLE COST TOKENS CTX ACTIVITY PROJECT`; at 120+ (or
with `-x`) it adds `TURNS` and the per-category token columns, widens `CTX` into the full `CONTEXT`
triple, and appends `STARTED`. Piped output has no terminal width to read, so it assumes 100 — pass
`--width` to override.

There is no ID column: sessions are identified by title, and the first 8 characters of the session id
stand in (dimmed in a terminal) only when a session has no title yet.

To hand a listing to Claude, pipe a fenced copy to the clipboard — `ccbb-ls -x --fence | clip` on
Windows, `| pbcopy` on macOS, `| xclip -sel c` on Linux, `| clip.exe` on WSL. It pastes into a
session with its alignment intact.

## Reading the output

**Cost summary** — one row per provider (`Bedrock`, `Sub` for a Claude subscription / API key), plus a
`Total` row when there is more than one:

| Column | Meaning |
|---|---|
| `USD` | estimated spend in scope |
| `TOKENS` | all tokens billed in scope (input + output + cache read + cache write) |
| `TURNS` | billed messages; `+n` counts subagent messages |
| `CR` / `CW` / `CM` | share of **cost** from cache reads / cache writes / cache **misses** |
| `OUT` / `IN` | share of cost from output tokens / uncached input tokens |
| `TIME` | average response time, and output tokens per second of it |

`CR`, `CW`, `CM`, `OUT`, `IN` are percentages of that row's cost, so they show where the money went, not
where the tokens went — with `-x` you get the token counts alongside. `CM` is the one to watch: a cache
**miss** is a cache write with no accompanying cache read, on anything after the first message of a
transcript. It means the prompt cache had gone cold and the whole conversation was re-billed at write
price. A high `CM` is money spent on nothing.

**Session rows** — `CTX` is the session's current context and what the next turn pays to resend it:
`164.4K/$0.08`. The cost is a single figure chosen by whether the prompt cache is still warm — cache
**read** price while it is (green), cache **write** price once it has expired and the whole context
has to be re-sent (red). A cold 165K context costs about twenty times what a warm one does, which is
the entire point of the colour. Warmth is judged from the last turn's timestamp against the cache
TTL that turn used (5 minutes, or an hour when the session writes 1h-cache entries), so it changes
as you read. `—` means no measured context (no billable turn yet).

`CONTEXT` (extended view) is the same figure widened to `current[/peak]/cost`: tokens in the last request,
the largest the context ever got (shown only when it differs from current), and what one more turn
would cost just to resend that context. In both columns a `~` prefix means the value is estimated
from a `/compact` summary rather than measured, and the figure is all-time — it is not scoped to the
selected period the way `COST` and `TOKENS` are. `TURNS` counts distinct responses, `+n` subagent
responses.

## How the numbers are computed

Every session is one `.jsonl` transcript under `<claude-home>/projects/<slug>/`, plus any subagent
transcripts in a `<sessionId>/` directory beside it, which bill to the same session. Each assistant
message records its token usage; cost is that usage multiplied by a built-in price table (USD per 1M
tokens, per model id, with an opus/sonnet/haiku family fallback for ids it doesn't know).

Worth knowing:

- **Cost is an estimate, not a bill.** It is what the recorded usage would cost at list price. It
  ignores subscription plans (a Pro/Max session shows what the same tokens would have cost on the API),
  enterprise discounts, and any provider-side rounding. Treat it as a relative measure.
- **Bedrock costs more.** AWS charges a premium over list price for the regional inference
  profiles Claude Code uses on Bedrock — currently +10% on every price component for Sonnet 4.5 /
  Haiku 4.5 / Opus 4.5 and newer, and nothing on the older models. A transcript records only the
  bare model id, never the `us.`/`eu.`/`apac.` profile it went through, so the premium is applied
  by provider: a message id starting with `msg_bdrk_` is Bedrock. `SNAPSHOT_BEDROCK_MULT` holds
  the per-model multipliers, and any model not listed there gets `BEDROCK_PREMIUM` (1.1).
- **Prices go stale.** The table in the script is a snapshot; new models fall back to their family tier.
  Update `SNAPSHOT_BY_ID` when a model you use is mispriced, or drop a
  `<claude-home>/ccbb-pricing.json` of the form `{"byId":{"claude-...":{"input":3,"output":15,
  "cacheRead":0.3,"cacheWrite5m":3.75,"cacheWrite1h":6}}}` next to it — it overrides the snapshot.
- **Periods are local time**, and a week starts Monday. A session that spans midnight contributes to
  both days; scoped columns count only the messages inside the period, while `TITLE`, `ACTIVITY`,
  `STARTED`, `PROJECT` and `CONTEXT` are always all-time.
- **Duplicates are dropped** on `message.id` + `requestId`, so a response written twice is billed once.
- **`PROJECT` is the real working directory**, taken from the live session record or the transcript's own
  `cwd` field. The directory name under `projects/` is a lossy encoding of the path (every `\`, `:`,
  `.` and `-` became `-`) and is only a last resort.
- **One Claude Code home per run.** It reads `~/.claude` (`%USERPROFILE%\.claude` on Windows).
  Sessions belonging to another machine — or to WSL when you run this from Windows, and vice versa —
  live in a different home and are invisible here. Point `CLAUDE_CONFIG_DIR` at that home to list it
  instead: `CLAUDE_CONFIG_DIR=//wsl.localhost/Ubuntu/home/you/.claude ccbb-ls -a` from Windows, or
  `CLAUDE_CONFIG_DIR=/mnt/c/Users/you/.claude ccbb-ls -a` from WSL.
- **No cache.** Every run re-reads every transcript, which is a few tenths of a second for a 75 MB
  history on a local disk. Across the WSL/Windows boundary (`\\wsl.localhost\…` or `/mnt/c/…`)
  expect it to be several times slower.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ccbb-ls: command not found` (Linux / macOS / WSL) | The symlink's directory isn't on `PATH`, or the shell predates the install — open a new one. Check with `command -v ccbb-ls` and `echo $PATH`. |
| `Permission denied` (Linux / macOS / WSL) | The script isn't executable: `chmod +x ~/.claude/ccbb-ls.js`. |
| `'ccbb-ls' is not recognized` (cmd / PowerShell) | The launcher isn't in a `PATH` directory, or the shell predates the install — open a new one. Check with `where ccbb-ls`. |
| `ccbb-ls: command not found` (Git Bash) | The extensionless launcher is missing — Git Bash ignores `PATHEXT`, so the `.cmd` alone is not enough. Check with `type ccbb-ls`. |
| `bad interpreter` or `\r: No such file` | A launcher, or the script itself, was saved with CRLF line endings where LF is required. |
| `node: command not found` | Node isn't on `PATH`. Use the full path to `node` / `node.exe` in the launcher, or fix `PATH`. |
| `No sessions found.` | Wrong Claude Code home — a common surprise when Windows and WSL both run Claude Code. Check that `~/.claude/projects` exists and holds `.jsonl` files; if `CLAUDE_CONFIG_DIR` is set, the script follows it. |
| Table is squeezed, wrapping, or stuck narrow | Pass `--width <n>`. Piped or redirected output has no terminal width to read and assumes 100. |
| Columns misaligned after pasting somewhere | The `--fence` flag is missing — outside a code block, markdown collapses the padding. |
| Costs look wrong for a new model | Its id isn't in the price table and it fell back to a family tier. See *Prices go stale* above. |

## Provenance

`ccbb-ls.js` is a standalone extract of `ccbb ls` from https://github.com/iproudhon/ccbb — the discovery,
pricing, usage-accounting and table-rendering parts only. Its output was verified line-for-line against
the original across every sort key and period scope, on a 50-session / 583M-token history, over both
Bedrock and subscription providers. The three deliberate differences: no ID column, the real `cwd` for
`PROJECT`, and no on-disk stats cache.
