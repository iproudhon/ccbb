#!/usr/bin/env node
'use strict';
// ── ccstats-skel ─────────────────────────────────────────────────────────────
// Extract privacy-safe, sanitized skeletons of local Claude Code and Codex sessions into one
// gzipped JSON file, for `ccstats stats` to report on. Zero dependencies.
//
//   npx -y -p github:iproudhon/ccbb ccstats-skel [-o file.json.gz] [options]
//
// The extraction is ccstats.js's `skel`, cut down to what a collector needs and with the
// identifying bits removed (see sanitize): no session ids, no MCP/custom tool names, no local
// model names or provider names. The output keeps ccstats's skeleton schema, so `ccstats
// stats` and ccstats-golizer read it as-is.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

// ── Discovery and extraction ──────────────────────────────────────────────────
// Transcript reading and skeleton extraction for every supported source.
// No content ever leaves a transcript: see buildClaudeSkeleton / buildCodexSkeleton.
//
// Sources are AUTO-DETECTED per response, never configured:
//   claude-sub       Claude Code against the subscription / Anthropic API
//   claude-bedrock   Claude Code against Bedrock (msg_bdrk_ message-id prefix)
//   claude-local     Claude Code against a local/other model (model id is no Claude family)
//   codex            Codex against OpenAI
//   codex-local      Codex against a non-OpenAI provider (`oss`, a local server, …)

const SOURCES = ['claude-sub', 'claude-bedrock', 'claude-local', 'codex', 'codex-local'];

// Default roots: Claude Code's config dir and Codex's home, honoring their env overrides.
function defaultDirs() {
  return [
    process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  ];
}

// ── Model naming ──────────────────────────────────────────────────────────────
// A model "family" drops the things that split one model across many ids: the Bedrock
// vendor prefix/suffix and trailing snapshot dates. It is what the report groups by, so
// claude-haiku-4-5-20251001 and anthropic.claude-haiku-4-5-20251001-v1:0 land together.
function familyOf(model) {
  let m = String(model || 'unknown').toLowerCase();
  m = m.replace(/^(us|eu|apac)\./, '').replace(/^(anthropic|openai)\./, '');
  m = m.replace(/-v\d+:\d+$/, '');
  m = m.replace(/[-@](\d{8}|\d{4}-\d{2}-\d{2})$/, '');
  return m;
}
// Glob matcher for --model / --source: '*' and '?' wildcards, case-insensitive, and a bare
// term also matches as a substring so `--model opus` does what it looks like.
function globMatcher(patterns) {
  if (!patterns || !patterns.length) return () => true;
  const res = patterns.map(p => {
    const esc = String(p).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    return new RegExp(/[*?]/.test(p) ? `^${esc}$` : esc, 'i');
  });
  return v => res.some(re => re.test(String(v || '')));
}

// ── File discovery ────────────────────────────────────────────────────────────
function walkJsonl(dir, out, depth = 0) {
  if (depth > 8) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      // Caches, temp copies and vendored fixtures are not session history.
      if (/^(node_modules|\.tmp|cache|caches|plugins|shell_snapshots|tmp)$/.test(e.name)) continue;
      walkJsonl(full, out, depth + 1);
    } else if (e.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}
// What kind of transcript a file holds, from its leading records. Cheap enough to do for every
// file and far more reliable than the directory layout, which differs by version. Several
// records are inspected, not just the first: a subagent transcript opens with a
// fork-context-ref, and a rollout can open with records that say nothing about either format.
function sniffKind(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const lines = buf.slice(0, n).toString('utf8').split('\n');
    for (let i = 0; i < lines.length - 1; i++) {   // the last line may be cut mid-record
      if (!lines[i].trim()) continue;
      let d;
      try { d = JSON.parse(lines[i]); } catch { continue; }
      if (d.type === 'session_meta' || d.type === 'turn_context' || d.type === 'token_usage_record' ||
          d.type === 'response_item' || (d.payload && d.payload.cli_version)) return 'codex';
      if (d.sessionId || d.parentSessionId || d.type === 'user' || d.type === 'assistant' ||
          d.type === 'summary' || d.type === 'fork-context-ref') return 'claude';
    }
  } catch {} finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  return null;
}
// Claude keeps sessions under <dir>/projects; Codex under <dir>/sessions (+ archived).
// Scan those when present and the whole root otherwise, so a directory of collected
// transcripts also works.
function scanRoots(dir) {
  const subs = ['projects', 'sessions', 'archived_sessions'].map(s => path.join(dir, s))
    .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
  return subs.length ? subs : [dir];
}
function discover(dirs) {
  const files = { claude: [], codex: [] };
  for (const dir of dirs) {
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    const found = [];
    if (stat.isFile()) found.push(dir);
    else for (const root of scanRoots(dir)) walkJsonl(root, found);
    for (const f of found) {
      const kind = sniffKind(f);
      if (kind) files[kind].push(f);
    }
  }
  return files;
}

// ── Shared message-row helpers ────────────────────────────────────────────────
// Characters of actual payload in a content block. Sizes only — the text is never kept.
// Tool calls count their serialized arguments, tool results their returned text, which is
// what the model paid for.
function blockChars(b) {
  if (typeof b === 'string') return b.length;
  if (!b || typeof b !== 'object') return 0;
  if (typeof b.text === 'string') return b.text.length;
  if (typeof b.thinking === 'string') return b.thinking.length;
  if (b.type === 'tool_use' || b.type === 'function_call')
    { try { return JSON.stringify(b.input ?? b.arguments ?? '').length; } catch { return 0; } }
  if (b.type === 'tool_result' || b.type === 'function_call_output') {
    const c = b.content ?? b.output;
    return Array.isArray(c) ? c.reduce((n, x) => n + blockChars(x), 0) : (typeof c === 'string' ? c.length : 0);
  }
  try { return JSON.stringify(b).length; } catch { return 0; }
}
function contentChars(content) {
  if (typeof content === 'string') return content.length;
  return Array.isArray(content) ? content.reduce((n, b) => n + blockChars(b), 0) : 0;
}
const estTokens = chars => Math.ceil(chars / 4);   // the usual ~4 chars/token, for unbilled messages

// ── Cache-write attribution ───────────────────────────────────────────────────
// A cache write is either (a) the new part of the prompt being added to the cache — the
// unavoidable cost of the conversation growing — or (b) a prefix that was already cached
// having to be written AGAIN because the cache entry expired (TTL) or was evicted.
//
// Telling them apart is arithmetic on consecutive requests in one session: the growth part
// can be at most how much the prompt grew since the previous request; anything beyond that
// is a rewrite of ground already paid for. A request that reads nothing from cache while a
// prompt of real size was already established is a full re-write, which is what an expired
// entry looks like. The idle gap is carried alongside (Claude's default TTL is 5 min, 1 h
// with extended TTL), so the page can show the write against the gap that caused it.
const CACHE_TTL_MS = 300000;
function attributeCacheWrites(responses) {
  let prev = null;
  for (const r of responses) {
    const t = r.ts ? Date.parse(r.ts) : NaN;
    const pt = prev && prev.ts ? Date.parse(prev.ts) : NaN;
    r.gapMs = (!isNaN(t) && !isNaN(pt) && t >= pt) ? t - pt : null;
    const cw = r.cacheWrite || 0;
    r.cwGrowth = 0; r.cwExpiry = 0; r.cwKind = null;
    if (cw > 0) {
      if (!prev) { r.cwGrowth = cw; r.cwKind = 'initial'; }   // cold session: the whole prefix is new
      else {
        const grew = Math.max(0, (r.promptTokens || 0) - (prev.promptTokens || 0));
        const growth = Math.min(cw, grew);
        r.cwGrowth = growth;
        r.cwExpiry = cw - growth;
        r.cwKind = r.cwExpiry > r.cwGrowth ? 'expiry' : 'growth';
      }
    }
    prev = r;
  }
  return responses;
}

// ── Compaction ────────────────────────────────────────────────────────────────
// Claude Code records a compaction exactly (`system`/`compact_boundary`, with the context
// size before and after). Nothing equivalent is published in Codex rollouts, so when a
// session has no explicit record we fall back to the shape a compaction leaves in the
// numbers: the context collapsing to a fraction of what it was between two consecutive
// requests. Inferred rows are flagged so the report can say so.
const INFER_DROP = 0.5;        // post must be under half of pre
const INFER_FLOOR = 8000;      // …and pre must be a real context, not a warm-up turn
function inferCompactions(responses) {
  const out = [];
  let prev = null;
  for (const r of responses) {
    if (r.main === false) continue;
    const pre = prev ? (prev.promptTokens || 0) : 0, post = r.promptTokens || 0;
    if (prev && pre >= INFER_FLOOR && post < pre * INFER_DROP) {
      out.push({ pre, post, trigger: null, durMs: null, inferred: 1,
        ts: r.ts ? Date.parse(r.ts) : null });
    }
    prev = r;
  }
  return out;
}

// ── Claude Code transcripts ───────────────────────────────────────────────────
// Everything a session bills for: its own transcript plus the subagent transcripts nested
// under <projectDir>/<sessionId>/… (a `subagents/` level deep in current versions). Group the
// discovered files by owning session the same way ccusage does — the nearest ancestor
// directory named like a session id owns the file; anything else is a session of its own.
const UUIDISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function claudeGroups(files) {
  const mains = new Map();       // sessionId → main transcript path
  const subs = new Map();        // sessionId → [subagent transcript paths]
  for (const f of files) {
    let owner = null;
    for (let dir = path.dirname(f); ; ) {
      const base = path.basename(dir);
      if (UUIDISH.test(base)) { owner = base; break; }
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
    if (owner) {
      if (!subs.has(owner)) subs.set(owner, []);
      subs.get(owner).push(f);
    } else if (!mains.has(path.basename(f, '.jsonl'))) {
      mains.set(path.basename(f, '.jsonl'), f);
    }
  }
  return { mains, subs };
}
function claudeSourceOf(msg) {
  if (String(msg.id || '').startsWith('msg_bdrk_')) return 'claude-bedrock';
  const m = String(msg.model || '');
  if (!m || m === '<synthetic>') return 'claude-sub';
  return /claude|haiku|sonnet|opus|fable/i.test(m) ? 'claude-sub' : 'claude-local';
}
// Compact type tag: 'u' user prompt, 'r' tool results, and for an assistant message the
// blocks it holds joined with '+' — 'k' thinking, 'x' text, 't:<name>' tool call.
function claudeMessageType(d) {
  const c = d.message && d.message.content;
  if (d.type === 'user') return (Array.isArray(c) && c.some(b => b && b.type === 'tool_result')) ? 'r' : 'u';
  if (d.type !== 'assistant') return d.type || '?';
  if (!Array.isArray(c)) return 'x';
  const parts = [];
  for (const b of c) {
    if (!b) continue;
    if (b.type === 'tool_use') parts.push('t:' + (b.name || ''));
    else if (b.type === 'text') parts.push('x');
    else if (b.type === 'thinking') parts.push('k');
    else parts.push(b.type || '?');
  }
  return parts.join('+') || 'x';
}
function buildClaudeSkeleton(sessionId, usagePaths) {
  const mainPath = usagePaths[0];
  const responses = [], messages = [], compactions = [];
  const models = new Set(), providers = new Set(), sources = new Set();
  const seenUsage = new Set(), seenTok = new Set();
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
      // Message rows — main transcript only, in file order: the shape of the conversation
      // (turn kinds + tool names) plus each message's token length and unix-ms timestamp.
      if (isMain && d.message && (d.type === 'user' || d.type === 'assistant')) {
        const t = d.timestamp ? Date.parse(d.timestamp) : NaN;
        const mid = (d.message.id || '') + '|' + (d.requestId || '');
        // A streamed assistant message is several records sharing one id, each repeating the
        // SAME usage, so only the first may claim it; the rest fall back to the estimate.
        const first = !d.message.id || !seenTok.has(mid);
        if (d.message.id) seenTok.add(mid);
        const u = d.message.usage;
        const exact = first && d.type === 'assistant' && u && typeof u.output_tokens === 'number';
        const row = {
          type: claudeMessageType(d),
          tokens: exact ? u.output_tokens : estTokens(contentChars(d.message.content)),
          ts: isNaN(t) ? null : t,
        };
        if (!exact) row.est = 1;
        messages.push(row);
      }
      // Compaction, as the CLI itself measured it: context before and after, why, how long.
      if (isMain && d.type === 'system' && d.subtype === 'compact_boundary') {
        const cm = d.compactMetadata || {};
        const t = d.timestamp ? Date.parse(d.timestamp) : NaN;
        compactions.push({
          pre: cm.preTokens || 0, post: cm.postTokens || 0,
          trigger: cm.trigger || null,
          durMs: typeof cm.durationMs === 'number' ? cm.durationMs : null,
          ts: isNaN(t) ? null : t,
        });
      }
      if (isMain && d.type === 'user' && d.timestamp) {
        const t = Date.parse(d.timestamp); if (!isNaN(t)) lastUserTs = t;
      }
      const key = (d.message && d.message.id) ? d.message.id + '|' + (d.requestId || '') : null;
      if (d.type === 'assistant' && d.message && d.message.usage && !(key && seenUsage.has(key))) {
        if (key) seenUsage.add(key);
        const u = d.message.usage;
        const input = u.input_tokens || 0, output = u.output_tokens || 0;
        const cacheRead = u.cache_read_input_tokens || 0, cacheWrite = u.cache_creation_input_tokens || 0;
        const provider = String(d.message.id || '').startsWith('msg_bdrk_') ? 'bedrock' : 'anthropic';
        const model = d.message.model || 'unknown';
        const source = claudeSourceOf(d.message);
        models.add(model); providers.add(provider); sources.add(source);
        let respMs = null;
        if (isMain && d.timestamp && lastUserTs != null) {
          const r = Date.parse(d.timestamp) - lastUserTs;
          if (r >= 0) respMs = r;
        }
        const ts = d.timestamp || null;
        responses.push({
          ts, hour: ts ? new Date(ts).getHours() : null,   // local hour at extraction time
          model, provider, source, main: isMain,
          input, cacheRead, cacheWrite, output,
          promptTokens: input + cacheRead + cacheWrite,    // context fed in
          respMs,
        });
      }
    }
  }
  if (!responses.length) return null;
  return finishSkeleton({
    agent: 'claude', sessionId, version, startedAt, lastActivity,
    models: [...models], providers: [...providers], sources: [...sources],
    messages, responses, compactions,
  });
}

// ── Codex rollouts ────────────────────────────────────────────────────────────
// Rollouts report cumulative counters. `token_usage_record` carries a per-response usage
// object and is preferred; older rollouts only publish `event_msg/token_count`, where the
// per-response numbers are the delta of `total_token_usage` between records. Context-only
// updates (compaction, rate-limit refreshes) have a zero delta and are not requests.
const CODEX_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
function codexCounters(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const f of CODEX_FIELDS) {
    const v = raw[f] ?? ((f === 'cache_write_input_tokens' || f === 'reasoning_output_tokens') ? 0 : NaN);
    if (!Number.isSafeInteger(v) || v < 0) return null;
    out[f] = v;
  }
  return out;
}
function codexMessageRow(payload, ts) {
  const p = payload || {};
  const kind = p.type || '';
  let type = null, chars = 0;
  if (kind === 'message' || kind === 'user_message' || kind === 'agent_message') {
    const role = p.role || (kind === 'user_message' ? 'user' : 'assistant');
    type = role === 'user' ? 'u' : 'x';
    chars = contentChars(p.content ?? p.message ?? p.text);
  } else if (kind === 'reasoning' || kind === 'agent_reasoning') {
    type = 'k'; chars = contentChars(p.summary ?? p.content ?? p.text);
  } else if (kind === 'function_call' || kind === 'local_shell_call' || kind === 'custom_tool_call') {
    type = 't:' + (p.name || p.tool_name || (kind === 'local_shell_call' ? 'shell' : ''));
    chars = blockChars(p);
  } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
    type = 'r'; chars = blockChars(p);
  }
  if (!type) return null;
  return { type, tokens: estTokens(chars), ts: isNaN(ts) ? null : ts, est: 1 };
}
function buildCodexSkeleton(filePath) {
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch { return null; }
  const responses = [], messages = [];
  const models = new Set(), sources = new Set();
  let sessionId = path.basename(filePath, '.jsonl');
  let version = null, startedAt = null, lastActivity = null;
  let model = null, provider = null;
  let ledgerSeen = false;
  let prevTotal = null, lastUserTs = null;
  const push = (usage, ts, requestTotal) => {
    const cacheRead = usage.cached_input_tokens, cacheWrite = usage.cache_write_input_tokens;
    const input = Math.max(0, usage.input_tokens - cacheRead - cacheWrite);
    const source = (!provider || provider === 'openai') ? 'codex' : 'codex-local';
    const m = model || 'unknown';
    models.add(m); sources.add(source);
    const at = ts ? Date.parse(ts) : NaN;
    let respMs = null;
    if (!isNaN(at) && lastUserTs != null && at >= lastUserTs) respMs = at - lastUserTs;
    responses.push({
      ts: ts || null, hour: ts && !isNaN(at) ? new Date(at).getHours() : null,
      model: m, provider: provider || 'openai', source, main: true,
      input, cacheRead, cacheWrite, output: usage.output_tokens,
      reasoning: usage.reasoning_output_tokens,
      promptTokens: requestTotal != null ? requestTotal : usage.input_tokens,
      respMs,
    });
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.timestamp) {
      if (!startedAt || d.timestamp < startedAt) startedAt = d.timestamp;
      if (!lastActivity || d.timestamp > lastActivity) lastActivity = d.timestamp;
    }
    if (d.type === 'session_meta') {
      if (p.id) sessionId = p.id;
      version = p.cli_version || version;
      provider = p.model_provider || provider;
      model = p.model || model;
      if (p.timestamp && (!startedAt || p.timestamp < startedAt)) startedAt = p.timestamp;
      continue;
    }
    if (d.type === 'turn_context') { model = p.model || model; provider = p.model_provider || provider; continue; }
    if (d.type === 'response_item' || d.type === 'event_msg') {
      const row = codexMessageRow(p, d.timestamp ? Date.parse(d.timestamp) : NaN);
      if (row) {
        messages.push(row);
        if (row.type === 'u' && row.ts != null) lastUserTs = row.ts;
      }
    }
    if (d.type === 'token_usage_record') {
      const u = codexCounters(p.usage);
      if (!u) continue;
      ledgerSeen = true;
      push(u, d.timestamp, u.input_tokens);
      continue;
    }
    if (ledgerSeen) continue;   // the ledger is authoritative; ignore the cumulative stream
    if (d.type === 'event_msg' && p.type === 'token_count' && p.info) {
      const total = codexCounters(p.info.total_token_usage);
      if (!total) continue;
      if (!prevTotal) { prevTotal = total; if (!total.total_tokens) continue; }
      const delta = {};
      let bad = false;
      for (const f of CODEX_FIELDS) {
        delta[f] = total[f] - (prevTotal === total ? 0 : prevTotal[f]);
        if (delta[f] < 0) bad = true;
      }
      prevTotal = total;
      if (bad || !delta.total_tokens) continue;   // counter reset, or a context-only update
      const last = codexCounters(p.info.last_token_usage);
      push(delta, d.timestamp, last ? last.input_tokens : delta.input_tokens);
    }
  }
  if (!responses.length) return null;
  return finishSkeleton({
    agent: 'codex', sessionId, version, startedAt, lastActivity,
    models: [...models], providers: [provider || 'openai'], sources: [...sources],
    messages, responses,   // compactions are inferred in finishSkeleton: rollouts record none
  });
}

// ── Assembly ──────────────────────────────────────────────────────────────────
// Cache-write attribution, session-level aggregates, and the fingerprint. The fingerprint
// hashes the message rows (type + token length + timestamp) so structurally identical but
// genuinely different sessions don't collide, while the same session collected from two
// machines still fingerprints identically — which is what the dedup in `stats` needs.
function finishSkeleton(s) {
  attributeCacheWrites(s.responses);
  if (!s.compactions || !s.compactions.length) s.compactions = inferCompactions(s.responses);
  const rows = s.messages.length ? s.messages.map(m => `${m.type}:${m.tokens}:${m.ts}`)
    : s.responses.map(r => `${r.model}:${r.promptTokens}:${r.output}:${r.ts}`);
  s.fingerprint = crypto.createHash('sha256').update([rows.length, ...rows].join('|'))
    .digest('hex').slice(0, 16);
  s.turns = s.responses.length;
  const a = Date.parse(s.startedAt), b = Date.parse(s.lastActivity);
  s.durationMs = (!isNaN(a) && !isNaN(b) && b >= a) ? b - a : null;
  return s;
}

// Build skeletons for every session discoverable under `dirs`. Unlike ccstats.js there is no
// `codex app-server` fallback: a collector run on someone else's machine spawns nothing.
function buildAllSkeletons(dirs) {
  dirs = (dirs && dirs.length) ? dirs : defaultDirs();
  const files = discover(dirs);
  const sessions = [];

  // Claude: one skeleton per main transcript, with its subagent transcripts attached.
  const { mains, subs } = claudeGroups(files.claude);
  for (const [id, main] of mains) {
    let sk = null;
    try { sk = buildClaudeSkeleton(id, [main, ...(subs.get(id) || [])]); } catch {}
    if (sk) sessions.push(sk);
  }

  // Codex: one skeleton per rollout file.
  for (const f of files.codex) {
    let sk = null;
    try { sk = buildCodexSkeleton(f); } catch {}
    if (sk) sessions.push(sk);
  }

  return {
    tool: 'ccstats', kind: 'skeleton', schema: 2,
    generatedAt: new Date().toISOString(),
    count: sessions.length, sessions,
  };
}

// ── Shared option parsing ─────────────────────────────────────────────────────
// --dir / --model / --source are repeatable and also accept comma-separated lists.
function addList(target, value) {
  for (const v of String(value == null ? '' : value).split(',')) if (v.trim()) target.push(v.trim());
}
function takeCommon(a, argv, i, o) {
  const eat = () => argv[++i.v];
  if (a === '-d' || a === '--dir') addList(o.dirs, eat());
  else if (a.startsWith('--dir=')) addList(o.dirs, a.slice(6));
  else if (a === '-m' || a === '--model') addList(o.models, eat());
  else if (a.startsWith('--model=')) addList(o.models, a.slice(8));
  else if (a === '-s' || a === '--source') addList(o.sources, eat());
  else if (a.startsWith('--source=')) addList(o.sources, a.slice(9));
  else return false;
  return true;
}
const COMMON_HELP = `  -d, --dir <path>       session root to scan, repeatable (default ~/.claude and ~/.codex;
                         CLAUDE_CONFIG_DIR / CODEX_HOME are honored). A single .jsonl works.
  -m, --model <glob>     keep only matching models, repeatable (e.g. -m opus -m 'gpt-*')
  -s, --source <glob>    keep only matching sources, repeatable. Sources are auto-detected:
                         ${SOURCES.join(', ')}`;

// Drop responses whose model/source don't match, then sessions left with nothing. Session
// aggregates (turns, duration) are recomputed so they describe what survived.
function filterSessions(sessions, o) {
  const okModel = globMatcher(o.models), okSource = globMatcher(o.sources);
  if (!o.models.length && !o.sources.length) return sessions;
  const out = [];
  for (const s of sessions) {
    const kept = (s.responses || []).filter(r =>
      (okModel(r.model) || okModel(familyOf(r.model))) && okSource(r.source || s.agent));
    if (!kept.length) continue;
    out.push({ ...s, responses: kept, turns: kept.length,
      models: [...new Set(kept.map(r => r.model))], sources: [...new Set(kept.map(r => r.source))] });
  }
  return out;
}


// ── Sanitizing ────────────────────────────────────────────────────────────────
// What a ccstats skeleton still says about the machine it came from, removed after filtering
// (so -m/-s match the real names) and after the fingerprint (so dedup across collections
// still works):
//   sessionId     the transcript's UUID → the fingerprint
//   tool names    MCP tools (mcp__<server>__<tool>) → 't:mcp'; any other name that isn't a
//                 plain identifier → 't:other'. Built-in names (Bash, Read, shell, …) stay.
//   local models  a *-local response's model id (internal names, paths) and provider (a
//                 custom Codex model_provider, say) both become 'local'.
const PLAIN_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
function cleanType(type) {
  return String(type).split('+').map(p => {
    if (!p.startsWith('t:')) return p;
    const name = p.slice(2);
    return name.startsWith('mcp__') ? 't:mcp' : PLAIN_TOOL.test(name) ? p : 't:other';
  }).join('+');
}
function sanitize(s) {
  s.sessionId = s.fingerprint;
  for (const m of s.messages || []) m.type = cleanType(m.type);
  for (const r of s.responses) {
    if (!/-local$/.test(r.source || '')) continue;
    r.model = 'local'; r.provider = 'local';
  }
  s.models = [...new Set(s.responses.map(r => r.model))];
  s.providers = [...new Set(s.responses.map(r => r.provider))];
  return s;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// Output is gzipped when its name ends in .gz, which the default does; -o x.json writes plain.
function main(argv) {
  const o = { dirs: [], models: [], sources: [] };
  let out = 'ccstats-skel.json.gz';
  const i = { v: 0 };
  for (; i.v < argv.length; i.v++) {
    const a = argv[i.v];
    if (a === '-h' || a === '--help') return help();
    if (takeCommon(a, argv, i, o)) continue;
    if (a === '-o' || a === '--out') out = argv[++i.v];
    else if (a.startsWith('--out=')) out = a.slice(6);
    else { console.error(`ccstats-skel: unexpected argument '${a}'. Try: ccstats-skel -h`); process.exit(1); }
  }
  if (!out) { console.error('ccstats-skel: -o needs a file name'); process.exit(1); }
  const coll = buildAllSkeletons(o.dirs);
  coll.sessions = filterSessions(coll.sessions, o).map(sanitize);
  coll.count = coll.sessions.length;
  const json = JSON.stringify(coll);
  const body = out.endsWith('.gz') ? zlib.gzipSync(json, { level: 9 }) : json;
  fs.writeFileSync(out, body);
  const responses = coll.sessions.reduce((n, s) => n + s.responses.length, 0);
  const kb = Math.round(Buffer.byteLength(body) / 1024);
  console.log(`ccstats-skel: ${coll.count} sessions, ${responses} responses → ${out} (${kb} KB)`);
}
function help() {
  console.log(`ccstats-skel — extract sanitized, privacy-safe session skeletons

Usage:
  npx -y -p github:iproudhon/ccbb ccstats-skel [-o file.json.gz] [options]

Writes one gzipped JSON file holding, per discoverable Claude Code / Codex session, a
structural fingerprint, one row per message (type, token length, timestamp) and one numeric
row per billable response. No message content, prompts, paths, titles, session ids, MCP tool
names or local model names are kept. Timestamps are.

  -o, --out <file>       output path (default ccstats-skel.json.gz; gzipped iff it ends in .gz)
${COMMON_HELP}`);
}

if (require.main === module || process.argv[1] === '-') {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`ccstats-skel: ${e.message}`); process.exitCode = 1; }
}

module.exports = { buildAllSkeletons, filterSessions, sanitize };
