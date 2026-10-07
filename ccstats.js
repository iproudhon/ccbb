#!/usr/bin/env node
'use strict';
// ── ccstats ──────────────────────────────────────────────────────────────────
// Privacy-safe stats for local Claude Code and Codex sessions. Zero dependencies.
//
//   ccstats skel  [-o file.json]             extract privacy-safe skeletons for every
//                                            discoverable session into one JSON file.
//   ccstats stats [file.json...] [options]   read zero or more skeleton files, dedup by
//                                            fingerprint, and render a self-contained
//                                            HTML report.
//
// ONE self-contained file on purpose: discovery, transcript parsing, skeleton extraction,
// aggregation and the report generator all live here, so it can be handed to someone else
// and run as-is (`node ccstats.js skel`) with nothing to install.
//
// All charting is inline SVG in the emitted page; it opens offline with no dependencies.
// The report builds ITSELF inside a Shadow DOM at runtime, so the same block of markup works
// both as a standalone file and pasted into a Confluence HTML macro (`--confluence`); see
// README.md for why. The embedded data is PRE-AGGREGATED (see buildViews) so the page stays a
// few tens of KB no matter how many sessions went in — a raw row per response blew past what
// Confluence will accept in a macro body. Aggregates are kept PER (source × model family)
// over SHARED bin edges, which is what lets the page's source/model checkboxes re-sum them
// client-side without shipping the rows.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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
  const codexHomes = [];
  for (const dir of dirs) {
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    const found = [];
    if (stat.isFile()) found.push(dir);
    else for (const root of scanRoots(dir)) walkJsonl(root, found);
    let sawCodex = false;
    for (const f of found) {
      const kind = sniffKind(f);
      if (kind) files[kind].push(f);
      if (kind === 'codex') sawCodex = true;
    }
    // A Codex home with no rollout files on disk: newer CLIs keep them elsewhere and only
    // the app-server knows where. Remember it for the RPC fallback.
    const isCodexHome = /codex/i.test(path.basename(dir)) || fs.existsSync(path.join(dir, 'config.toml'));
    if (!sawCodex && isCodexHome) codexHomes.push(dir);
  }
  return { files, codexHomes };
}

// ── Codex app-server fallback (read-only thread/list) ─────────────────────────
// Only used when a Codex home yields no rollout files. Short-lived stdio client; it lists
// threads and takes their rollout paths, never starts or resumes a thread.
class CodexRpc {
  constructor({ command = 'codex', args = ['app-server', '--listen', 'stdio://'], timeout = 15000, env } = {}) {
    this.pending = new Map(); this.nextId = 1; this.timeout = timeout; this.buffer = '';
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env || process.env });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', c => this.receive(c));
    this.child.stderr.resume();       // diagnostics may hold private config; drain, don't read
    this.child.on('error', e => this.fail(e));
    this.child.stdin.on('error', e => this.fail(e));
    this.child.on('exit', (code, sig) => this.fail(new Error(`codex app-server exited (${sig || code})`)));
  }
  fail(error) {
    if (!this.error) this.error = error;
    for (const r of this.pending.values()) { clearTimeout(r.timer); r.reject(error); }
    this.pending.clear();
  }
  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 32 * 1024 * 1024) { this.fail(new Error('codex response too large')); this.close(); return; }
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl); this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { this.fail(new Error('invalid JSON from codex app-server')); return; }
      if (!msg || typeof msg !== 'object') { this.fail(new Error('invalid codex response')); return; }
      if (msg.method) {   // server-initiated request: we implement nothing
        if (msg.id != null) this.send({ id: msg.id, error: { code: -32601, message: 'unsupported' } });
        continue;
      }
      const req = this.pending.get(msg.id);
      if (!req) continue;
      this.pending.delete(msg.id); clearTimeout(req.timer);
      if (msg.error) req.reject(new Error(`codex ${req.method}: ${msg.error.message || 'failed'}`));
      else req.resolve(msg.result);
    }
  }
  send(msg) { if (!this.error) this.child.stdin.write(JSON.stringify(msg) + '\n'); }
  request(method, params) {
    if (this.error) return Promise.reject(this.error);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(new Error(`codex ${method} timed out`)); this.close(); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params });
    });
  }
  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'ccstats', version: require('./package.json').version } });
    this.send({ method: 'initialized', params: {} });
  }
  close() {
    this.fail(new Error('closed'));
    this.child.stdin.destroy(); this.child.kill();
    const t = setTimeout(() => this.child.kill('SIGKILL'), 1000); t.unref();
    this.child.once('close', () => clearTimeout(t));
  }
}
async function codexRolloutPaths(home) {
  const rpc = new CodexRpc({ env: { ...process.env, CODEX_HOME: home } });
  const paths = [];
  try {
    await rpc.initialize();
    let cursor = null; const seen = new Set();
    do {
      const page = await rpc.request('thread/list', {
        cursor, limit: 100, sortKey: 'updated_at', archived: false,
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], modelProviders: [],
      });
      if (!page || !Array.isArray(page.data)) break;
      for (const t of page.data) if (t && typeof t.path === 'string' && t.path) paths.push(t.path);
      cursor = typeof page.nextCursor === 'string' && page.nextCursor && !seen.has(page.nextCursor)
        ? (seen.add(page.nextCursor), page.nextCursor) : null;
    } while (cursor);
  } catch {} finally { rpc.close(); }
  return paths;
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

// Build skeletons for every session discoverable under `dirs`. Async only because of the
// Codex app-server fallback; with rollouts on disk nothing is spawned.
async function buildAllSkeletons(dirs) {
  dirs = (dirs && dirs.length) ? dirs : defaultDirs();
  const { files, codexHomes } = discover(dirs);
  const sessions = [];

  // Claude: one skeleton per main transcript, with its subagent transcripts attached.
  const { mains, subs } = claudeGroups(files.claude);
  for (const [id, main] of mains) {
    let sk = null;
    try { sk = buildClaudeSkeleton(id, [main, ...(subs.get(id) || [])]); } catch {}
    if (sk) sessions.push(sk);
  }

  // Codex: rollout files found on disk, plus whatever the app-server points at for a Codex
  // home that had none.
  const codexFiles = new Set(files.codex);
  for (const home of codexHomes) {
    let paths = [];
    try { paths = await codexRolloutPaths(home); } catch {}
    for (const p of paths) if (sniffKind(p) === 'codex') codexFiles.add(p);
  }
  for (const f of codexFiles) {
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

// ── Report build ──────────────────────────────────────────────────────────────
// Histogram resolution (bars per chart) and the default scatter sample cap.
const NBINS = 96;
const SBINS = 24;             // secondary charts (idle gap)
const SESS_BINS = 48;         // per-session distributions (turn count, duration)
const CBINS = 32;             // compactions
const DEFAULT_POINTS = 2000;

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

// ── ccstats skel ──────────────────────────────────────────────────────────────
async function runSkel(argv) {
  const o = { dirs: [], models: [], sources: [] };
  let out = 'ccstats-skeleton.json';
  const i = { v: 0 };
  for (; i.v < argv.length; i.v++) {
    const a = argv[i.v];
    if (a === '-h' || a === '--help') return skelHelp();
    if (takeCommon(a, argv, i, o)) continue;
    if (a === '-o' || a === '--out') out = argv[++i.v];
    else if (a.startsWith('--out=')) out = a.slice(6);
    else { console.error(`ccstats skel: unexpected argument '${a}'`); process.exit(1); }
  }
  const coll = await buildAllSkeletons(o.dirs);
  coll.sessions = filterSessions(coll.sessions, o);
  coll.count = coll.sessions.length;
  fs.writeFileSync(out, JSON.stringify(coll));
  const responses = coll.sessions.reduce((n, s) => n + s.responses.length, 0);
  console.log(`ccstats skel: ${coll.count} sessions, ${responses} responses → ${out}`);
}
function skelHelp() {
  console.log(`ccstats skel — extract privacy-safe session skeletons

Usage:
  ccstats skel [-o file.json] [options]

Writes one JSON file holding, per discoverable session, a structural fingerprint, one row
per message (type, token length, timestamp) and one numeric row per billable response. No
message content, prompts, paths or titles are kept.

  -o, --out <file>       output path (default ccstats-skeleton.json)
${COMMON_HELP}`);
}

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

// ── ccstats stats ─────────────────────────────────────────────────────────────
async function runStats(argv) {
  const o = { dirs: [], models: [], sources: [] };
  let out = 'ccstats.html', log = false, conf = false, points = DEFAULT_POINTS;
  const files = [];
  const i = { v: 0 };
  for (; i.v < argv.length; i.v++) {
    const a = argv[i.v];
    if (a === '-h' || a === '--help') return statsHelp();
    if (takeCommon(a, argv, i, o)) continue;
    if (a === '-o' || a === '--out') out = argv[++i.v];
    else if (a.startsWith('--out=')) out = a.slice(6);
    else if (a === '--log') log = true;
    else if (a === '--confluence') conf = true;
    else if (a.startsWith('--confluence=')) { conf = true; out = a.slice(13); }
    else if (a === '--points') points = Number(argv[++i.v]);
    else if (a.startsWith('--points=')) points = Number(a.slice(9));
    else if (a.startsWith('-')) { console.error(`ccstats stats: unknown option '${a}'`); process.exit(1); }
    else files.push(a);
  }
  if (!isFinite(points) || points < 0) { console.error('ccstats stats: --points must be a non-negative number'); process.exit(1); }

  // Load + dedup sessions by fingerprint (first file wins). With no file arguments the
  // skeletons are built straight from the discoverable sessions — same data `ccstats skel`
  // would have written, without the intermediate file.
  const inputs = files.length ? files.map(f => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
      console.error(`ccstats stats: cannot read ${f}: ${e.message}`); process.exit(1);
    }
  }) : [await buildAllSkeletons(o.dirs)];
  const seen = new Set();
  let sessions = [];
  for (const data of inputs) {
    for (const s of (Array.isArray(data) ? data : (data.sessions || []))) {
      const key = s.fingerprint || s.sessionId;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      sessions.push(s);
    }
  }
  sessions = filterSessions(sessions, o);
  if (!sessions.length) { console.error('ccstats stats: no sessions matched the filter.'); process.exit(1); }

  const model = buildModel(sessions);
  if (!model.rows.length) { console.error('ccstats stats: no responses matched the filter.'); process.exit(1); }
  const meta = {
    log,
    sessions: model.sessionRows.length,
    responses: model.rows.length,
    withTiming: model.rows.filter(r => r.respMs != null).length,
    sources: model.sources, models: model.families, groups: model.groups,
    generatedAt: new Date().toISOString(),
  };
  // --confluence changes WHAT the output file holds (the macro-body extract), not how many
  // files are written: one run, one file, always the one named by -o.
  const block = reportBlock(buildViews(model, points), meta);
  const body = conf ? block + '\n' : renderHtml(block);
  fs.writeFileSync(out, body);
  const kb = Math.round(Buffer.byteLength(body) / 1024);
  console.log(`ccstats stats: ${meta.sessions} sessions, ${meta.responses} responses, ` +
    `${meta.groups.length} source×model groups → ${out} (${kb} KB` +
    `${conf ? ', Confluence HTML-macro body' : ''})`);
}
function statsHelp() {
  console.log(`ccstats stats — render an HTML report from sessions or skeleton files

Usage:
  ccstats stats [file.json...] [options]

Writes a self-contained HTML report: token histograms, response-time charts, cache-write
attribution and per-session distributions. With no file arguments the skeletons are built
from the discoverable sessions; given files (glob is fine, e.g. *.json) are read instead and
deduped by fingerprint. Sources and models are selectable in the page as well as here.

Chart data is pre-aggregated at build time per source×model group, so page size grows with
the number of groups, not the number of sessions (only the scatter carries per-response
points).

  -o, --out <file>       output path (default ccstats.html)
  --log                  start with log-scaled axes/bins (default off; toggleable in the page)
  --points <n>           scatter-plot sample cap (default ${DEFAULT_POINTS}, 0 = every response).
                         The dominant term in page size — lower it if the page is too big.
  --confluence[=file]    write the Confluence HTML-macro body (host <div> + <script> only)
                         instead of a standalone page. With =file, that is the output path.
${COMMON_HELP}`);
}

// ── Build-time model ──────────────────────────────────────────────────────────
// Flatten sessions into response rows + session rows, each tagged with a group index.
// A group is one (source, model family) pair: the finest cut the page's two checkbox rows
// can select, and the unit every aggregate is kept in.
function buildModel(sessions) {
  const sources = [], families = [], groups = [], groupIndex = new Map();
  const idx = (arr, v) => { let i = arr.indexOf(v); if (i < 0) { arr.push(v); i = arr.length - 1; } return i; };
  const groupOf = (source, model) => {
    const key = source + '\u0000' + model;
    if (groupIndex.has(key)) return groupIndex.get(key);
    const g = groups.length;
    groups.push([idx(sources, source), idx(families, model)]);
    groupIndex.set(key, g);
    return g;
  };
  const rows = [], sessionRows = [], compactRows = [];
  for (const s of sessions) {
    let sessionGroup = null;
    for (const r of (s.responses || [])) {
      const g = groupOf(r.source || s.agent || 'unknown', familyOf(r.model));
      if (sessionGroup == null) sessionGroup = g;
      rows.push({
        promptTokens: r.promptTokens || 0,
        output: r.output || 0,
        cacheRead: r.cacheRead || 0,
        cacheWrite: r.cacheWrite || 0,
        cwGrowth: r.cwGrowth || 0,
        cwExpiry: r.cwExpiry || 0,
        gapMs: (typeof r.gapMs === 'number') ? r.gapMs : null,
        respMs: (typeof r.respMs === 'number') ? r.respMs : null,
        hour: (typeof r.hour === 'number') ? r.hour : null,
        g,
      });
    }
    if (sessionGroup == null) continue;
    sessionRows.push({
      turns: s.turns || (s.responses || []).length,
      durMs: (typeof s.durationMs === 'number') ? s.durationMs : null,
      g: sessionGroup,
    });
    // A compaction belongs to its session, so it follows the session's group through the
    // page's filters. `inferred` rows came from a context collapse, not an explicit record.
    for (const c of (s.compactions || [])) {
      if (!(c.pre > 0)) continue;
      compactRows.push({
        pre: c.pre, post: c.post || 0,
        durMs: (typeof c.durMs === 'number') ? c.durMs : null,
        inferred: c.inferred ? 1 : 0,
        auto: c.trigger === 'auto' ? 1 : 0,
        g: sessionGroup,
      });
    }
  }
  return { rows, sessionRows, compactRows, sources, families, groups };
}

// ── Aggregation ───────────────────────────────────────────────────────────────
// Every chart is a binned view. Bin EDGES are computed once over all rows so that a per-group
// aggregate can be summed with any other group's — that is what makes the in-page filters
// possible. Cells are flat number arrays to keep the JSON small; the page decodes them.
function totalPrompt(r) { return r.cacheRead + r.cacheWrite + r.output; }
function isOutlier(r) {
  const size = r.promptTokens + r.output;
  if (size === 0 && (r.respMs == null || r.respMs === 0)) return true;   // no size, no timing
  if (r.respMs != null && r.respMs > 600000) return true;                // idle-gap artifact
  return false;
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x))); const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
// Edge arrays: n+1 numbers, ascending. linEdges snaps to a round step; logEdges is
// log10-spaced and ignores zeros (they fall into the first bin).
function linEdges(vals, N) {
  const max = Math.max(...vals, 1), step = niceStep(max / N) || 1;
  const n = Math.max(1, Math.ceil((max + 1e-9) / step));
  return Array.from({ length: n + 1 }, (_, i) => Math.round(i * step));
}
function logEdges(vals, N, floor) {
  const pos = vals.filter(v => v > 0);
  if (!pos.length) return [0, 1];
  const lo = Math.log10(Math.max(floor || 1, Math.min(...pos))), hi = Math.log10(Math.max(...pos));
  const span = (hi - lo) || 1;
  return Array.from({ length: N + 1 }, (_, i) => Math.round(Math.pow(10, lo + span * i / N)));
}
function binOf(edges, v) {
  if (!(v > edges[0])) return 0;
  let lo = 0, hi = edges.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (v < edges[mid]) hi = mid; else lo = mid; }
  return Math.min(lo, edges.length - 2);
}
// Every cell is a count or a sum of non-negative numbers, so a negative value is free to mean
// "this many zeros". Splitting the aggregates per (source, model) group leaves ~90% of cells
// empty, and that is most of the payload; the page expands this once at startup.
function rle(a) {
  const out = [];
  let z = 0;
  for (const v of a) {
    if (v === 0) { z++; continue; }
    if (z) { out.push(-z); z = 0; }
    out.push(v);
  }
  return out;                       // a trailing run of zeros is implied by `len`
}
function packRows(rows) { return { len: rows.length ? rows[0].length : 0, g: rows.map(rle) }; }
function packSection(s) { return { edges: s.edges, n: s.n, len: s.g[0] ? s.g[0].length : 0, g: s.g.map(rle) }; }
// One aggregate section: edges + per-group flat cells. `cell` writes a row's contribution.
function section(edges, nCell, nGroups, items, valueOf, cell) {
  const nb = edges.length - 1;
  const g = Array.from({ length: nGroups }, () => new Array(nb * nCell).fill(0));
  for (const it of items) {
    const v = valueOf(it);
    if (v == null) continue;
    cell(g[it.g], binOf(edges, v) * nCell, it);
  }
  return { edges, n: nCell, g };
}
// prompt-binned cell: [n, cacheRead, cacheWrite, decode, respSum, respCount, cwGrowth, cwExpiry]
function promptCell(a, o, r) {
  a[o]++; a[o + 1] += r.cacheRead; a[o + 2] += r.cacheWrite; a[o + 3] += r.output;
  if (r.respMs != null) { a[o + 4] += r.respMs; a[o + 5]++; }
  a[o + 6] += r.cwGrowth; a[o + 7] += r.cwExpiry;
}
function buildView(rows, sessionRows, compactRows, nGroups, cap) {
  const prompts = rows.map(totalPrompt);
  const gaps = rows.filter(r => r.gapMs != null).map(r => r.gapMs);
  const lin = section(linEdges(prompts, NBINS), 8, nGroups, rows, totalPrompt, promptCell);
  const log = section(logEdges(prompts, NBINS), 8, nGroups, rows, totalPrompt, promptCell);
  // gap cell: [n, cacheWrite, cwGrowth, cwExpiry, respSum, respCount]
  const gap = section(gaps.length ? logEdges(gaps, SBINS, 1000) : [0, 1], 6, nGroups, rows,
    r => r.gapMs, (a, o, r) => {
      a[o]++; a[o + 1] += r.cacheWrite; a[o + 2] += r.cwGrowth; a[o + 3] += r.cwExpiry;
      if (r.respMs != null) { a[o + 4] += r.respMs; a[o + 5]++; }
    });
  // Session distributions, in both scalings so the page's log toggle can switch bins.
  const tv = sessionRows.map(s => s.turns), count1 = (a, o) => { a[o]++; };
  const turns = section(linEdges(tv, SESS_BINS), 1, nGroups, sessionRows, s => s.turns, count1);
  const turnsLog = section(tv.length ? logEdges(tv, SESS_BINS, 1) : [0, 1], 1, nGroups,
    sessionRows, s => s.turns, count1);
  const durs = sessionRows.filter(s => s.durMs != null).map(s => s.durMs);
  const dur = section(durs.length ? linEdges(durs, SESS_BINS) : [0, 1], 1, nGroups, sessionRows,
    s => s.durMs, count1);
  const durLog = section(durs.length ? logEdges(durs, SESS_BINS, 1000) : [0, 1], 1, nGroups,
    sessionRows, s => s.durMs, count1);

  // Compactions, binned by the context size that triggered them.
  // cell: [n, preSum, postSum, durSum, durN, inferred, auto]
  const pres = compactRows.map(c => c.pre);
  const compCell = (a, o, c) => {
    a[o]++; a[o + 1] += c.pre; a[o + 2] += c.post;
    if (c.durMs != null) { a[o + 3] += c.durMs; a[o + 4]++; }
    a[o + 5] += c.inferred; a[o + 6] += c.auto;
  };
  const comp = section(pres.length ? linEdges(pres, CBINS) : [0, 1], 7, nGroups, compactRows,
    c => c.pre, compCell);
  const compLog = section(pres.length ? logEdges(pres, CBINS, 1000) : [0, 1], 7, nGroups,
    compactRows, c => c.pre, compCell);

  // Hour-of-day response-time means, per group.
  const hsum = Array.from({ length: nGroups }, () => new Array(24).fill(0));
  const hcnt = Array.from({ length: nGroups }, () => new Array(24).fill(0));
  for (const r of rows) if (r.respMs != null && r.hour != null) { hsum[r.g][r.hour] += r.respMs; hcnt[r.g][r.hour]++; }

  // Per-group totals — true per-response means come from these, independent of any binning,
  // so the reference lines don't move when the log toggle changes the bins.
  // [n, cr, cw, dec, respSum, respN, cwGrowth, cwExpiry, sessions, turns, durSum, durN,
  //  compactions, cPreSum, cPostSum, cInferred]
  const tot = Array.from({ length: nGroups }, () => new Array(16).fill(0));
  for (const r of rows) {
    const t = tot[r.g];
    t[0]++; t[1] += r.cacheRead; t[2] += r.cacheWrite; t[3] += r.output;
    if (r.respMs != null) { t[4] += r.respMs; t[5]++; }
    t[6] += r.cwGrowth; t[7] += r.cwExpiry;
  }
  for (const s of sessionRows) {
    const t = tot[s.g];
    t[8]++; t[9] += s.turns;
    if (s.durMs != null) { t[10] += s.durMs; t[11]++; }
  }
  for (const c of compactRows) {
    const t = tot[c.g];
    t[12]++; t[13] += c.pre; t[14] += c.post; t[15] += c.inferred;
  }

  // Even stride sample so a huge run still plots (and still looks like the whole run) without
  // shipping one point per response. cap 0 keeps everything.
  const timed = rows.filter(r => r.respMs != null);
  // A 4th element flags an outlier (present only when it is one), so the two views can share
  // one sample instead of shipping two — see buildViews.
  const all = timed.map(r => {
    const p = [r.promptTokens + r.output, Math.round(r.respMs), r.g];
    if (isOutlier(r)) p.push(1);
    return p;
  });
  let pts = all;
  if (cap && all.length > cap) {
    const stride = all.length / cap;
    pts = [];
    for (let i = 0; i < cap; i++) pts.push(all[Math.floor(i * stride)]);
  }
  const R = Math.round;
  const out = {
    hour: { sum: packRows(hsum.map(a => a.map(R))), cnt: packRows(hcnt) },
    tot: packRows(tot.map(a => a.map(R))),
    pts, ptsTotal: all.length,
  };
  for (const [k, s] of Object.entries({ lin, log, gap, turns, turnsLog, dur, durLog, comp, compLog }))
    out[k] = packSection(s);
  return out;
}
function buildViews(model, cap) {
  const n = model.groups.length;
  const keepRows = model.rows, dropRows = model.rows.filter(r => !isOutlier(r));
  const keep = buildView(keepRows, model.sessionRows, model.compactRows, n, cap);
  const drop = buildView(dropRows, model.sessionRows, model.compactRows, n, cap);
  // Only the response-derived sections differ between the two outlier states; sessions and
  // compactions come out byte-identical, so ship them once and let the page alias them.
  for (const k of Object.keys(drop))
    if (JSON.stringify(drop[k]) === JSON.stringify(keep[k])) drop[k] = '@' + k;
  // The scatter sample is shipped once, flagged; the page derives the trimmed one from it.
  drop.pts = '@pts';
  return { keep, drop };
}

// ── HTML rendering ────────────────────────────────────────────────────────────
// Everything the report needs is generated at runtime inside a SHADOW ROOT hung off a
// single host <div>. Confluence's inline HTML macro runs the <script> but our <style>
// never survives — Confluence's own CSS then takes over (full-width charts, wrong colors,
// unresolved var()). Injecting the stylesheet into a shadow root from JS fixes both
// directions: the macro can't strip it and Confluence's styles can't leak in. For the same
// reason every chart color is a concrete hex from PAL — no var() inside SVG attributes.
// So the emitted block is just the host div + one script; see README.md.

const HOST_ID = 'ccstats-host';

// Stylesheet template. `__key__` tokens are substituted from the active palette at runtime,
// which is also how the dark/light swap works (re-substitute, re-set textContent).
const CSS_TEMPLATE = `
:host{all:initial;display:block;color:__primary__;background:__plane__;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5}
*{box-sizing:border-box}
.wrap{max-width:1000px;margin:0 auto;padding:28px 20px 64px}
h1{font-size:20px;font-weight:600;margin:0 0 4px;color:__primary__}
.sub{color:__secondary__;font-size:13px;margin:0 0 20px}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 24px}
.tile{background:__surface__;border:1px solid __border__;border-radius:10px;
  padding:12px 16px;min-width:120px}
.tile .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.tile .k{color:__muted__;font-size:12px;margin-top:2px}
.ctrl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;margin:0 0 12px;
  color:__secondary__;font-size:13px}
.ctrl label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.ctrl input{accent-color:__series__;margin:0}
.ctrl .lbl{color:__muted__;font-size:12px;text-transform:uppercase;letter-spacing:.04em;
  min-width:58px}
.ctrl .n{color:__muted__;font-variant-numeric:tabular-nums}
.ctrl a{color:__series__;cursor:pointer;text-decoration:none;font-size:12px}
.card{background:__surface__;border:1px solid __border__;border-radius:12px;
  padding:16px 16px 8px;margin:0 0 20px;overflow-x:auto}
.card h2{font-size:15px;font-weight:600;margin:0 0 2px;color:__primary__}
.card .desc{color:__muted__;font-size:12px;margin:0 0 8px}
svg{display:block;max-width:100%;height:auto}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 8px;color:__secondary__;font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.sw0{background:__primary__}.sw1{background:__s1__}.sw2{background:__s2__}.sw3{background:__s3__}
.foot{color:__muted__;font-size:12px;margin-top:8px}
.float{position:fixed;top:14px;right:14px;z-index:2147483646;display:flex;
  flex-direction:column;gap:5px;background:__surface__;color:__secondary__;
  border:1px solid __border__;border-radius:12px;padding:10px 13px;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.35;
  box-shadow:0 4px 14px rgba(0,0,0,.18);max-height:80vh;overflow:auto}
.float .head{cursor:pointer;user-select:none;color:__secondary__;font-size:12px;
  font-variant-numeric:tabular-nums}
.float .body{flex-direction:column;gap:5px}
.float .hd{color:__muted__;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.float .rows{display:flex;flex-direction:column;gap:4px}
.float label{display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
.float a{color:__series__;cursor:pointer;text-decoration:none;font-size:12px}
.float .n{color:__muted__;font-variant-numeric:tabular-nums}
.float input{accent-color:__series__;margin:0}
.tip{position:fixed;left:0;top:0;pointer-events:none;background:__surface__;color:__primary__;
  border:1px solid __border__;border-radius:8px;padding:6px 9px;font-size:12px;line-height:1.5;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 4px 14px rgba(0,0,0,.18);opacity:0;transition:opacity .08s;white-space:nowrap;
  z-index:2147483647}
.tip b{font-variant-numeric:tabular-nums}
`;

// Static markup for the shadow tree. No <script>/<style> here — innerHTML would not run
// them anyway; the stylesheet is injected separately and all drawing is done in JS.
const MARKUP = `
  <h1>session stats</h1>
  <p class="sub" id="sub"></p>
  <div class="tiles" id="tiles"></div>
  <div class="ctrl" id="scaleCtrl">
    <label><input type="checkbox" id="outToggle" checked> remove outliers (0-size &amp; 0-response, or response &gt; 10&nbsp;min)</label>
  </div>
  <div class="ctrl" id="srcCtrl"><span class="lbl">source</span></div>
  <div class="ctrl" id="modCtrl"><span class="lbl">model</span></div>
  <div class="card"><h2>Sessions by turn count</h2><p class="desc">how many sessions had how many billable responses</p><div id="sess-turns"></div></div>
  <div class="card"><h2>Sessions by duration</h2><p class="desc">wall-clock first-to-last activity per session</p><div id="sess-dur"></div></div>
  <div class="card"><h2>Prompt Size Distribution</h2><p class="desc">responses binned by total prompt (cache-read + cache-write + decode); vertical dashed lines mark the average prompt composition, cumulative on the token axis (cache read, +cache write, +decode = avg total) — values in the legend</p>
    <div class="legend" id="stack-count-legend"></div><div id="stack-count"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Response Time</h2><p class="desc">avg response time binned by total prompt; each bar stacked by token-type share of that bin</p>
    <div class="legend"><span><i class="sw1"></i>cache read</span><span><i class="sw2"></i>cache write</span><span><i class="sw3"></i>decode</span></div><div id="stack-resp"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Decode</h2><p class="desc">avg decode (output) tokens per response, binned by total prompt</p><div id="avg-decode"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Cache Write</h2><p class="desc">avg cache-write tokens per response, binned by total prompt</p><div id="avg-cw"></div></div>
  <div class="card"><h2>Cache Write: growth vs re-write</h2><p class="desc">avg cache-write tokens per response split by cause — <b>growth</b> is the part that fits what the prompt gained since the previous request, <b>re-write</b> is prefix that was already cached and had to be written again (TTL expiry or eviction)</p>
    <div class="legend" id="cw-split-legend"></div><div id="cw-split"></div></div>
  <div class="card"><h2>Idle gap&nbsp;→&nbsp;Cache Write</h2><p class="desc">avg cache-write tokens per response against the gap since the previous request in the same session; the re-write share climbing past the cache TTL is what expiry looks like</p>
    <div class="legend"><span><i class="sw1"></i>growth</span><span><i class="sw2"></i>re-write</span></div><div id="gap-cw"></div></div>
  <div class="card"><h2>Compaction&nbsp;→&nbsp;context size at trigger</h2><p class="desc">how many compactions were issued at which context size<span id="comp-note"></span></p><div id="comp-count"></div></div>
  <div class="card"><h2>Compaction&nbsp;→&nbsp;result size</h2><p class="desc">avg context size left after compacting, against the size it was issued at; the dashed line is the average result, the blue segment the share that survived</p>
    <div class="legend" id="comp-post-legend"></div><div id="comp-post"></div></div>
  <div class="card"><h2>Prompt&nbsp;+&nbsp;output size&nbsp;→&nbsp;response time</h2><p class="desc">each dot is one response (responses with timing); orange line = mean response time per x-slot (12 slots)<span id="pts-note"></span></p><div id="scatter"></div></div>
  <div class="card"><h2>Time of day&nbsp;→&nbsp;avg response time</h2><p class="desc">mean response time by local hour</p><div id="hour"></div></div>
  <p class="foot" id="foot"></p>
`;

// The paste-ready block: host <div> + one <script>. This is BOTH the body of the standalone
// page and, verbatim, the body of the Confluence HTML macro.
function reportBlock(views, meta) {
  const payload = JSON.stringify({ views, meta }).replace(/</g, '\\u003c');
  return `<div id="${HOST_ID}"></div>
<script>
(function(){
var DATA = ${payload};
var CSS_T = ${JSON.stringify(CSS_TEMPLATE)};
var MARKUP = ${JSON.stringify(MARKUP)};
var VIEWS = DATA.views, meta = DATA.meta;

// The payload ships zero-run compressed (a negative number is a run of that many zeros, a
// trailing run is implied by len), and the outlier views alias any section that came out
// identical. Expand both once here so nothing downstream has to know.
function unrle(a, len){
  var out = new Array(len), i = 0;
  for(var k=0; k<a.length; k++){
    var v = a[k];
    if(v < 0){ for(var j=0; j<-v; j++) out[i++] = 0; } else out[i++] = v;
  }
  while(i < len) out[i++] = 0;
  return out;
}
function unpack(p){
  var g = [];
  for(var i=0; i<p.g.length; i++) g.push(unrle(p.g[i], p.len));
  return g;
}
function expand(v, base){
  Object.keys(v).forEach(function(k){
    var s = v[k];
    if(k === 'pts' && typeof s === 'string'){
      v.pts = base.pts.filter(function(p){ return !p[3]; });
      return;
    }
    if(typeof s === 'string' && s.charAt(0) === '@'){ v[k] = base[s.slice(1)]; return; }
    if(k === 'hour'){ v.hour = {sum: unpack(s.sum), cnt: unpack(s.cnt)}; return; }
    if(k === 'tot'){ v.tot = unpack(s); return; }
    if(s && s.edges){ s.g = unpack(s); delete s.len; }
  });
}
expand(VIEWS.keep, null); expand(VIEWS.drop, VIEWS.keep);

var host = document.getElementById(${JSON.stringify(HOST_ID)});
if(!host) return;
// The macro may re-run the script (live refresh / in-place body swap): reuse the root.
var root = host.shadowRoot || host.attachShadow({mode:'open'});
root.innerHTML = '';

// Concrete hex per theme — never var() inside SVG attributes (Confluence would not resolve it).
var LIGHT = {plane:'#f9f9f7', surface:'#fcfcfb', primary:'#0b0b0b', secondary:'#52514e',
  muted:'#898781', grid:'#e1e0d9', axis:'#c3c2b7', series:'#2a78d6',
  s1:'#2a78d6', s2:'#eb6834', s3:'#1baf7a', border:'rgba(11,11,11,0.10)'};
var DARK = {plane:'#0d0d0d', surface:'#1a1a19', primary:'#ffffff', secondary:'#c3c2b7',
  muted:'#898781', grid:'#2c2c2a', axis:'#383835', series:'#3987e5',
  s1:'#3987e5', s2:'#d95926', s3:'#199e70', border:'rgba(255,255,255,0.10)'};
var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
var PAL = (mq && mq.matches) ? DARK : LIGHT;
function css(P){ return CSS_T.replace(/__(\\w+)__/g, function(_, k){ return P[k]; }); }

var styleEl = document.createElement('style');
var wrap = document.createElement('div');
wrap.className = 'wrap';
wrap.innerHTML = MARKUP;
root.appendChild(styleEl); root.appendChild(wrap);
function $(id){ return root.getElementById(id); }

// The tooltip lives in its OWN shadow root on <body>: position:fixed is relative to the
// nearest transformed ancestor, and Confluence wraps macro output in containers we do not
// control. Hanging it off body keeps it viewport-anchored and out of reach of page CSS.
var tipHost = document.createElement('div');
document.body.appendChild(tipHost);
var tipRoot = tipHost.attachShadow({mode:'open'});
var tipStyle = document.createElement('style');
var tip = document.createElement('div');
tip.className = 'tip';
tipRoot.appendChild(tipStyle); tipRoot.appendChild(tip);

// The floating panel (log scaling + sources, the two controls worth reaching without
// scrolling) gets its own shadow root on <body> for the same reason as the tooltip:
// position:fixed inside the macro's containers would anchor to a transformed ancestor
// instead of the viewport. It mirrors the in-flow controls, both ways.
var barHost = document.createElement('div');
document.body.appendChild(barHost);
var barRoot = barHost.attachShadow({mode:'open'});
var barStyle = document.createElement('style');
var bar = document.createElement('div');
bar.className = 'float';
barRoot.appendChild(barStyle); barRoot.appendChild(bar);

function paint(){ styleEl.textContent = css(PAL); tipStyle.textContent = css(PAL);
  barStyle.textContent = css(PAL); }
paint();
if(mq && mq.addEventListener) mq.addEventListener('change', function(){
  PAL = mq.matches ? DARK : LIGHT; paint(); render();
});

// ── Selection ───────────────────────────────────────────────────────────────
// Aggregates are stored per (source, model) group over SHARED bin edges, so any subset of
// groups is just an element-wise sum. VIEW is the active outlier state; SEL the group list.
var VIEW = VIEWS.keep, SEL = [];
// Default sources: the two that bill the same way, so a mixed report opens on a comparable
// slice instead of stacking subscription, Bedrock, local and Codex numbers together. If
// neither is present, everything starts on — an empty page is worse than a mixed one.
var DEFAULT_SOURCES = ['claude-sub', 'claude-bedrock'];
var srcOn = meta.sources.map(function(s){ return DEFAULT_SOURCES.indexOf(s) >= 0; });
if(!srcOn.some(function(v){ return v; })) srcOn = meta.sources.map(function(){ return true; });
var modOn = meta.models.map(function(){ return true; });
function refreshSel(){
  SEL = [];
  for(var g=0; g<meta.groups.length; g++){
    if(srcOn[meta.groups[g][0]] && modOn[meta.groups[g][1]]) SEL.push(g);
  }
}
// Sum one section's per-group cells over SEL, decoded into per-bin objects.
function sumSection(sec){
  var nb = sec.edges.length - 1, n = sec.n;
  var out = [];
  for(var b=0; b<nb; b++){
    var c = new Array(n);
    for(var k=0; k<n; k++) c[k] = 0;
    for(var i=0; i<SEL.length; i++){
      var arr = sec.g[SEL[i]];
      for(var k2=0; k2<n; k2++) c[k2] += arr[b*n + k2];
    }
    out.push({lo: sec.edges[b], hi: sec.edges[b+1], c: c});
  }
  return out;
}
function sumTotals(){
  var NT = 16, t = new Array(NT);
  for(var k=0; k<NT; k++) t[k] = 0;
  for(var i=0; i<SEL.length; i++){
    var a = VIEW.tot[SEL[i]];
    for(var k2=0; k2<NT; k2++) t[k2] += a[k2];
  }
  return {n:t[0], cr:t[1], cw:t[2], dec:t[3], respSum:t[4], respN:t[5],
    cwG:t[6], cwE:t[7], sessions:t[8], turns:t[9], durSum:t[10], durN:t[11],
    comp:t[12], cPre:t[13], cPost:t[14], cInf:t[15]};
}
function sumHour(){
  var sum = [], cnt = [];
  for(var h=0; h<24; h++){ sum.push(0); cnt.push(0); }
  for(var i=0; i<SEL.length; i++){
    var s = VIEW.hour.sum[SEL[i]], c = VIEW.hour.cnt[SEL[i]];
    for(var h2=0; h2<24; h2++){ sum[h2] += s[h2]; cnt[h2] += c[h2]; }
  }
  return {sum:sum, cnt:cnt};
}
function selPoints(){
  var on = {};
  for(var i=0; i<SEL.length; i++) on[SEL[i]] = 1;
  return VIEW.pts.filter(function(p){ return on[p[2]]; });
}

function showTip(html, e){ tip.innerHTML = html; tip.style.opacity = 1;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top  = (e.clientY - tip.offsetHeight - 10) + 'px'; }
function hideTip(){ tip.style.opacity = 0; }
var SVGNS = 'http://www.w3.org/2000/svg';
function el(n, a){ var x = document.createElementNS(SVGNS, n); for(var k in a) x.setAttribute(k, a[k]); return x; }
function fmt(n){ n = Math.round(n);
  if(Math.abs(n) >= 1e6) return (n/1e6).toFixed(1)+'M';
  if(Math.abs(n) >= 1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function fmtMs(ms){ return ms >= 10000 ? (ms/1000).toFixed(0)+'s' : (ms/1000).toFixed(1)+'s'; }
function fmtDur(ms){
  if(ms < 60000) return (ms/1000).toFixed(0)+'s';
  if(ms < 3600000) return (ms/60000).toFixed(ms < 600000 ? 1 : 0)+'m';
  if(ms < 86400000) return (ms/3600000).toFixed(1)+'h';
  return (ms/86400000).toFixed(1)+'d';
}
function pct(a, b){ return b > 0 ? Math.round(100*a/b)+'%' : '0%'; }

var W = 920, H = 260, M = {t:14, r:16, b:40, l:52};
var IW = W - M.l - M.r, IH = H - M.t - M.b;

// Chart primitives — every colour comes from PAL as a literal attribute value.
function gridLine(y){ return el('line',{x1:M.l, y1:y, x2:M.l+IW, y2:y, stroke:PAL.grid, 'stroke-width':1}); }
function axisLine(){ return el('line',{x1:M.l, y1:M.t+IH, x2:M.l+IW, y2:M.t+IH, stroke:PAL.axis, 'stroke-width':1}); }
function tickText(x, y, anchor, txt){
  var t = el('text',{x:x, y:y, 'text-anchor':anchor, fill:PAL.muted, 'font-size':11,
    'font-variant-numeric':'tabular-nums'});
  t.textContent = txt; return t; }
function axisLabel(x, y, txt, rot){
  var a = {x:x, y:y, 'text-anchor':'middle', fill:PAL.secondary, 'font-size':12};
  if(rot) a.transform = rot;
  var t = el('text', a); t.textContent = txt; return t; }
// x pixel for a value on the binned axis: find the bin that contains it and interpolate
// inside that bin's slot, the same way the bars are laid out.
function binX(bins, isLog, v, bw){
  if(!(v > 0)) return M.l;
  if(v <= bins[0].lo) return M.l;
  if(v >= bins[bins.length-1].hi) return M.l + IW;
  for(var i=0; i<bins.length; i++){
    var a = bins[i];
    if(v < a.lo || v >= a.hi) continue;
    var f = (isLog && a.lo > 0)
      ? (Math.log(v) - Math.log(a.lo)) / (Math.log(a.hi) - Math.log(a.lo))
      : (v - a.lo) / (a.hi - a.lo);
    if(!isFinite(f)) f = 0;
    return M.l + (i + f) * bw;
  }
  return M.l + IW;
}
// Dashed horizontal reference line at data value val on a 0-to-maxH y-scale, labelled at right.
function meanLine(svg, val, maxH, label){
  if(!(val > 0) || !(maxH > 0)) return;
  var y = M.t + IH - IH * Math.min(val, maxH) / maxH;
  svg.appendChild(el('line',{x1:M.l, y1:y, x2:M.l+IW, y2:y, stroke:PAL.secondary,
    'stroke-width':1.5, 'stroke-dasharray':'5 4'}));
  var t = el('text',{x:M.l+IW-2, y:y-4, 'text-anchor':'end', fill:PAL.secondary,
    'font-size':11, 'font-variant-numeric':'tabular-nums'});
  t.textContent = label; svg.appendChild(t);
}
function blankSvg(hostEl){
  var svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  hostEl.innerHTML = ''; hostEl.appendChild(svg); return svg;
}

// Generic binned bar chart. opts: height(bin) -> bar height in data units,
// segs(bin) -> [[color, value], …] stacked shares (optional; one solid bar otherwise),
// fmtY, fmtX, tip(bin), xlabel, mean (value for the dashed reference line), meanLabel.
function drawBins(id, bins, isLog, opts){
  var hostEl = $(id); if(!hostEl) return;
  var svg = blankSvg(hostEl);
  if(!bins.length) return;
  var fmtY = opts.fmtY || fmt, fmtX = opts.fmtX || fmt;
  var maxH = 1;
  for(var i=0; i<bins.length; i++) maxH = Math.max(maxH, opts.height(bins[i]));
  for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
    svg.appendChild(gridLine(y));
    svg.appendChild(tickText(M.l-8, y+4, 'end', fmtY(maxH*g/4))); }
  svg.appendChild(axisLine());
  var bw = IW / bins.length;
  var step = Math.ceil(bins.length/8);
  bins.forEach(function(b, i){
    var h = IH * opts.height(b) / maxH, x = M.l + i*bw, w = Math.max(1, bw-2);
    if(h > 0){
      var segs = opts.segs ? opts.segs(b) : [[PAL.series, 1]];
      var tot = 0;
      segs.forEach(function(s){ tot += s[1]; });
      if(tot <= 0) segs = [[PAL.series, 1]], tot = 1;
      var y = M.t + IH;
      segs.forEach(function(s){
        var sh = h * s[1] / tot; if(sh <= 0) return; y -= sh;
        svg.appendChild(el('rect',{x:x+1, y:y, width:w, height:sh, fill:s[0]}));
      });
      var hit = el('rect',{x:x+1, y:M.t+IH-h, width:w, height:h, fill:'transparent'});
      hit.addEventListener('mousemove', function(e){ showTip(opts.tip(b), e); });
      hit.addEventListener('mouseleave', hideTip);
      svg.appendChild(hit);
    }
    if(i % step === 0) svg.appendChild(tickText(x, M.t+IH+16, 'middle', fmtX(b.lo)));
  });
  if(opts.mean != null) meanLine(svg, opts.mean, maxH, opts.meanLabel);
  if(opts.marks) opts.marks(svg, bins, bw, maxH);
  svg.appendChild(axisLabel(M.l+IW/2, H-4, opts.xlabel + (isLog ? ' (log bins)' : '')));
  return svg;
}

function drawScatter(log){
  var hostEl = $('scatter');
  var pts = selPoints();
  var svg = blankSvg(hostEl);
  if(!pts.length){ $('pts-note').textContent = ''; return; }
  var xMax = Math.max.apply(null, pts.map(function(p){ return p[0]; }).concat([1]));
  var yv = function(v){ return log ? Math.log10(Math.max(1, v)) : v; };
  var yMax = Math.max.apply(null, pts.map(function(p){ return yv(p[1]); }).concat([yv(1)]));
  var sx = function(v){ return M.l + IW * v / xMax; };
  var sy = function(v){ return M.t + IH - IH * yv(v) / (yMax || 1); };
  for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
    svg.appendChild(gridLine(y));
    var raw = log ? Math.pow(10, yMax*g/4) : (yMax*g/4);
    svg.appendChild(tickText(M.l-8, y+4, 'end', fmtMs(raw))); }
  svg.appendChild(axisLine());
  for(var g2=0; g2<=4; g2++){
    svg.appendChild(tickText(M.l + IW*g2/4, M.t+IH+16, 'middle', fmt(xMax*g2/4))); }
  pts.forEach(function(p){
    var c = el('circle',{cx:sx(p[0]), cy:sy(p[1]), r:3.5, fill:PAL.series, 'fill-opacity':0.55});
    c.addEventListener('mousemove', function(e){
      showTip('<b>'+fmt(p[0])+'</b> tok in+out<br><b>'+fmtMs(p[1])+'</b> response', e); });
    c.addEventListener('mouseleave', hideTip); svg.appendChild(c);
  });
  // Binned trend: split x into 12 slots, connect each slot's mean response time.
  var SLOTS = 12, sw = xMax / SLOTS;
  var ss = [], sc = [];
  for(var s=0; s<SLOTS; s++){ ss.push(0); sc.push(0); }
  pts.forEach(function(p){ var i = Math.min(SLOTS-1, Math.floor(p[0]/sw)); ss[i]+=p[1]; sc[i]++; });
  var d = '', started = false, dots = [];
  for(var s2=0; s2<SLOTS; s2++){
    if(!sc[s2]){ started = false; continue; }
    var av = ss[s2]/sc[s2], cx = sx((s2+0.5)*sw), cy = sy(av);
    d += (started?' L':'M') + cx.toFixed(1) + ' ' + cy.toFixed(1); started = true;
    dots.push([cx, cy, av, sc[s2]]);
  }
  if(d) svg.appendChild(el('path',{d:d, fill:'none', stroke:PAL.s2, 'stroke-width':2}));
  dots.forEach(function(pt){
    var c = el('circle',{cx:pt[0], cy:pt[1], r:4, fill:PAL.s2});
    c.addEventListener('mousemove', function(e){
      showTip('slot avg<br><b>'+fmtMs(pt[2])+'</b> · '+pt[3]+' resp', e); });
    c.addEventListener('mouseleave', hideTip); svg.appendChild(c);
  });
  svg.appendChild(axisLabel(M.l+IW/2, H-4, 'prompt + output tokens'));
  svg.appendChild(axisLabel(-(M.t+IH/2), 14, 'response time' + (log ? ' (log)' : ''), 'rotate(-90)'));
  $('pts-note').textContent = pts.length < VIEW.ptsTotal
    ? ' · showing an even sample of ' + fmt(pts.length) + ' of ' + fmt(VIEW.ptsTotal) : '';
}

function drawHour(log){
  var hostEl = $('hour');
  var h = sumHour(), sum = h.sum, cnt = h.cnt;
  var avg = sum.map(function(s,i){ return cnt[i] ? s/cnt[i] : null; });
  var svg = blankSvg(hostEl);
  var yv = function(v){ return log ? Math.log10(Math.max(1, v)) : v; };
  var present = avg.filter(function(v){ return v != null; });
  if(!present.length) return;
  var yMax = Math.max.apply(null, present.map(yv));
  var sx = function(h){ return M.l + IW * h / 23; };
  var sy = function(v){ return M.t + IH - IH * yv(v) / (yMax || 1); };
  for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
    svg.appendChild(gridLine(y));
    var raw = log ? Math.pow(10, yMax*g/4) : (yMax*g/4);
    svg.appendChild(tickText(M.l-8, y+4, 'end', fmtMs(raw))); }
  svg.appendChild(axisLine());
  for(var h0=0; h0<24; h0+=3){ svg.appendChild(tickText(sx(h0), M.t+IH+16, 'middle', h0)); }
  var d = '', started = false;
  for(var h1=0; h1<24; h1++){ if(avg[h1]==null){ started=false; continue; }
    d += (started?' L':'M') + sx(h1).toFixed(1) + ' ' + sy(avg[h1]).toFixed(1); started=true; }
  if(d) svg.appendChild(el('path',{d:d, fill:'none', stroke:PAL.series, 'stroke-width':2}));
  for(var h2=0; h2<24; h2++){ if(avg[h2]==null) continue;
    (function(h){
      var c = el('circle',{cx:sx(h), cy:sy(avg[h]), r:4, fill:PAL.series});
      c.addEventListener('mousemove', function(e){
        showTip('<b>'+String(h).padStart(2,'0')+':00</b><br><b>'+fmtMs(avg[h])+'</b> avg · '+cnt[h]+' resp', e); });
      c.addEventListener('mouseleave', hideTip); svg.appendChild(c);
    })(h2); }
  svg.appendChild(axisLabel(M.l+IW/2, H-4, 'hour of day (local)'));
}

// ── Charts ──────────────────────────────────────────────────────────────────
// Prompt cell: [n, cacheRead, cacheWrite, decode, respSum, respCount, cwGrowth, cwExpiry]
function render(){
  var log = logOn;
  VIEW = $('outToggle').checked ? VIEWS.drop : VIEWS.keep;
  refreshSel();
  var T = sumTotals();
  var mean = {cr: T.n?T.cr/T.n:0, cw: T.n?T.cw/T.n:0, dec: T.n?T.dec/T.n:0,
    resp: T.respN?T.respSum/T.respN:0, cwG: T.n?T.cwG/T.n:0, cwE: T.n?T.cwE/T.n:0};
  mean.total = mean.cr + mean.cw + mean.dec;
  mean.cPre = T.comp ? T.cPre/T.comp : 0;
  mean.cPost = T.comp ? T.cPost/T.comp : 0;
  var sec = log ? VIEW.log : VIEW.lin;
  var bins = sumSection(sec);
  var promptX = 'total prompt tokens';

  // Session-level charts first: they frame everything below them.
  var tb = sumSection(log ? VIEW.turnsLog : VIEW.turns);
  drawBins('sess-turns', tb, log, {
    height: function(b){ return b.c[0]; },
    segs: function(b){ return [[PAL.series, 1]]; },
    fmtY: function(v){ return String(Math.round(v)); },
    fmtX: function(v){ return String(Math.round(v)); },
    xlabel: 'billable responses per session',
    mean: null,
    tip: function(b){ return '<b>'+Math.round(b.lo)+'</b>–<b>'+Math.round(b.hi)+'</b> turns<br><b>'+
      b.c[0]+'</b> sessions'; }
  });
  var db = sumSection(log ? VIEW.durLog : VIEW.dur);
  drawBins('sess-dur', db, log, {
    height: function(b){ return b.c[0]; },
    segs: function(b){ return [[PAL.s3, 1]]; },
    fmtY: function(v){ return String(Math.round(v)); }, fmtX: fmtDur,
    xlabel: 'session duration',
    tip: function(b){ return '<b>'+fmtDur(b.lo)+'</b>–<b>'+fmtDur(b.hi)+'</b><br><b>'+
      b.c[0]+'</b> sessions'; }
  });

  // Compaction: count by the context size that triggered it, and what it left behind.
  var cb = sumSection(log ? VIEW.compLog : VIEW.comp);
  var compX = 'context tokens when compaction was issued';
  drawBins('comp-count', cb, log, {
    height: function(b){ return b.c[0]; },
    segs: function(b){ return [[PAL.s2, 1]]; },
    fmtY: function(v){ return String(Math.round(v)); },
    xlabel: compX,
    tip: function(b){
      var n = b.c[0] || 1;
      return '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok<br><b>'+b.c[0]+'</b> compactions'+
        '<br>avg result '+fmt(b.c[2]/n)+' ('+pct(b.c[2], b.c[1])+' kept)'+
        (b.c[4] ? '<br>avg '+fmtMs(b.c[3]/b.c[4])+' to compact' : '')+
        (b.c[6] ? '<br>'+b.c[6]+' auto-triggered' : '');
    }
  });
  drawBins('comp-post', cb, log, {
    height: function(b){ return b.c[0] ? b.c[1]/b.c[0] : 0; },
    segs: function(b){ return [[PAL.s1, b.c[2]], [PAL.s2, Math.max(0, b.c[1]-b.c[2])]]; },
    xlabel: compX, mean: mean.cPost, meanLabel: 'avg result ' + fmt(mean.cPost),
    tip: function(b){
      var n = b.c[0] || 1;
      return '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok<br><b>'+fmt(b.c[1]/n)+
        '</b> avg at trigger<br><b>'+fmt(b.c[2]/n)+'</b> avg result ('+pct(b.c[2], b.c[1])+
        ' kept)<br>'+b.c[0]+' compactions';
    }
  });
  $('comp-post-legend').innerHTML =
    '<span><i class="sw1"></i>kept: <b>'+fmt(mean.cPost)+'</b> avg</span>'+
    '<span><i class="sw2"></i>dropped: <b>'+fmt(Math.max(0, mean.cPre-mean.cPost))+'</b> avg ('+
    pct(T.cPre-T.cPost, T.cPre)+')</span>';
  $('comp-note').textContent = T.comp
    ? ' · ' + T.comp + ' compaction' + (T.comp===1?'':'s') +
      (T.cInf ? ', ' + T.cInf + ' inferred from a context drop (no explicit record)' : '')
    : ' · none found';

  drawBins('stack-count', bins, log, {
    height: function(b){ return b.c[0]; },
    segs: function(b){ return [[PAL.s1, b.c[1]], [PAL.s2, b.c[2]], [PAL.s3, b.c[3]]]; },
    fmtY: function(v){ return String(Math.round(v)); },
    xlabel: promptX,
    tip: function(b){
      var tot = b.c[1]+b.c[2]+b.c[3] || 1;
      var seg = function(v){ return fmt(v/b.c[0]) + ' (' + pct(v, tot) + ')'; };
      return '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok<br><b>'+b.c[0]+'</b> responses'+
        '<br>read '+seg(b.c[1])+'<br>write '+seg(b.c[2])+'<br>decode '+seg(b.c[3]);
    },
    // Mark the AVERAGE prompt composition on the token (x) axis: cumulative cache read,
    // +cache write, +decode — the last is the average total prompt size. Vertical because
    // these are token values, which is what x measures. Values are shown in the legend.
    marks: function(svg, bs, bw){
      [[mean.cr, PAL.s1], [mean.cr+mean.cw, PAL.s2], [mean.total, PAL.s3]].forEach(function(m){
        if(!(m[0] > 0)) return;
        var x = binX(bs, log, m[0], bw);
        svg.appendChild(el('line',{x1:x, y1:M.t, x2:x, y2:M.t+IH, stroke:m[1],
          'stroke-width':1.5, 'stroke-dasharray':'5 4'}));
      });
    }
  });
  $('stack-count-legend').innerHTML =
    '<span><i class="sw0"></i>Prompt Size: <b>'+fmt(mean.total)+'</b></span>'+
    '<span><i class="sw1"></i>Cache Read: <b>'+fmt(mean.cr)+'</b></span>'+
    '<span><i class="sw2"></i>Cache Write: <b>'+fmt(mean.cw)+'</b></span>'+
    '<span><i class="sw3"></i>Decode: <b>'+fmt(mean.dec)+'</b></span>';

  drawBins('stack-resp', bins, log, {
    height: function(b){ return b.c[5] ? b.c[4]/b.c[5] : 0; },
    segs: function(b){ return [[PAL.s1, b.c[1]], [PAL.s2, b.c[2]], [PAL.s3, b.c[3]]]; },
    fmtY: fmtMs, xlabel: promptX, mean: mean.resp, meanLabel: 'avg ' + fmtMs(mean.resp),
    tip: function(b){
      return '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok<br><b>'+
        fmtMs(b.c[5]?b.c[4]/b.c[5]:0)+'</b> avg · '+b.c[0]+' resp';
    }
  });
  drawBins('avg-decode', bins, log, {
    height: function(b){ return b.c[0] ? b.c[3]/b.c[0] : 0; },
    segs: function(b){ return [[PAL.s3, 1]]; },
    xlabel: promptX, mean: mean.dec, meanLabel: 'avg ' + fmt(mean.dec),
    tip: function(b){ return '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok<br><b>'+
      fmt(b.c[0]?b.c[3]/b.c[0]:0)+'</b> avg · '+b.c[0]+' resp'; }
  });
  drawBins('avg-cw', bins, log, {
    height: function(b){ return b.c[0] ? b.c[2]/b.c[0] : 0; },
    segs: function(b){ return [[PAL.s2, 1]]; },
    xlabel: promptX, mean: mean.cw, meanLabel: 'avg ' + fmt(mean.cw),
    tip: function(b){ return '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok<br><b>'+
      fmt(b.c[0]?b.c[2]/b.c[0]:0)+'</b> avg · '+b.c[0]+' resp'; }
  });
  drawBins('cw-split', bins, log, {
    height: function(b){ return b.c[0] ? (b.c[6]+b.c[7])/b.c[0] : 0; },
    segs: function(b){ return [[PAL.s1, b.c[6]], [PAL.s2, b.c[7]]]; },
    xlabel: promptX, mean: mean.cwG + mean.cwE,
    meanLabel: 'avg ' + fmt(mean.cwG + mean.cwE),
    tip: function(b){
      var n = b.c[0] || 1, all = b.c[6]+b.c[7];
      return '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok<br><b>'+fmt(all/n)+'</b> write avg'+
        '<br>growth '+fmt(b.c[6]/n)+' ('+pct(b.c[6], all)+')'+
        '<br>re-write '+fmt(b.c[7]/n)+' ('+pct(b.c[7], all)+')';
    }
  });
  $('cw-split-legend').innerHTML =
    '<span><i class="sw1"></i>growth: <b>'+fmt(mean.cwG)+'</b> avg</span>'+
    '<span><i class="sw2"></i>re-write: <b>'+fmt(mean.cwE)+'</b> avg ('+pct(T.cwE, T.cwG+T.cwE)+' of cache write)</span>';

  var gaps = sumSection(VIEW.gap);
  drawBins('gap-cw', gaps, true, {
    height: function(b){ return b.c[0] ? b.c[1]/b.c[0] : 0; },
    segs: function(b){ return [[PAL.s1, b.c[2]], [PAL.s2, b.c[3]]]; },
    xlabel: 'gap since previous request', fmtX: fmtDur,
    tip: function(b){
      var n = b.c[0] || 1, all = b.c[2]+b.c[3];
      return 'gap <b>'+fmtDur(b.lo)+'</b>–<b>'+fmtDur(b.hi)+'</b><br><b>'+fmt(b.c[1]/n)+
        '</b> write avg · '+b.c[0]+' resp<br>re-write share '+pct(b.c[3], all);
    }
  });

  drawScatter(log);
  drawHour(log);

  tiles(T);
}

function tiles(T){
  var avgTurns = T.sessions ? (T.turns/T.sessions) : 0;
  var t = [['sessions', T.sessions], ['responses', T.n], ['with timing', T.respN],
    ['avg turns/session', avgTurns.toFixed(1)],
    ['median-ish session', T.durN ? fmtDur(T.durSum/T.durN) : '—'],
    ['cache re-write', pct(T.cwE, T.cwG + T.cwE)],
    ['compactions', T.comp],
    ['avg compaction', T.comp ? fmt(T.cPre/T.comp)+'→'+fmt(T.cPost/T.comp) : '—']];
  $('tiles').innerHTML = t.map(function(kv){
    return '<div class="tile"><div class="v">'+kv[1]+'</div><div class="k">'+kv[0]+'</div></div>'; }).join('');
}

// ── Filter UI ───────────────────────────────────────────────────────────────
// The log toggle and the source filter exist TWICE — in the page and in the floating panel —
// so every checkbox is registered here and re-read from the state after any change. That
// keeps the two copies in sync whichever one was clicked.
var BOXES = [];                       // {box, get} for every checkbox bound to state
function bind(box, get){ BOXES.push({box:box, get:get}); }
function syncBoxes(){ BOXES.forEach(function(b){ b.box.checked = b.get(); }); }
function apply(){ syncBoxes(); render(); }
function checkbox(labelText, checked, onChange, countText){
  var lab = document.createElement('label');
  var cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = checked;
  cb.addEventListener('change', function(){ onChange(cb.checked); });
  lab.appendChild(cb);
  var span = document.createElement('span');
  span.textContent = labelText;
  lab.appendChild(span);
  if(countText){
    var n = document.createElement('span');
    n.className = 'n'; n.textContent = countText;
    lab.appendChild(n);
  }
  return {lab:lab, box:cb};
}
// One checkbox row per facet. A group is included when BOTH its source and its model are on,
// which is exactly how the build-time groups were formed.
function facet(hostEl, names, state, counts){
  names.forEach(function(name, i){
    var c = checkbox(name, state[i], function(on){ state[i] = on; apply(); },
      counts[i] != null ? '('+fmt(counts[i])+')' : '');
    bind(c.box, function(){ return state[i]; });
    hostEl.appendChild(c.lab);
  });
  if(names.length > 1){
    var all = document.createElement('a');
    all.textContent = 'all / none';
    all.addEventListener('click', function(){
      var anyOff = state.some(function(v){ return !v; });
      for(var i=0; i<state.length; i++) state[i] = anyOff;
      apply();
    });
    hostEl.appendChild(all);
  }
}
// The log toggle, wherever it lives.
var logOn = !!meta.log;
function logCheckbox(labelText){
  var c = checkbox(labelText, logOn, function(on){ logOn = on; apply(); });
  c.lab.setAttribute('title', 'log scaling: all histogram x bins & the response-time axis');
  bind(c.box, function(){ return logOn; });
  return c.lab;
}
// Response counts per facet entry, for the labels.
function facetCounts(which){
  var out = [];
  var names = which === 0 ? meta.sources : meta.models;
  for(var i=0; i<names.length; i++) out.push(0);
  for(var g=0; g<meta.groups.length; g++) out[meta.groups[g][which]] += VIEWS.keep.tot[g][0];
  return out;
}
$('scaleCtrl').appendChild(logCheckbox('log scaling (all histogram x bins & response-time axis)'));
var srcCounts = facetCounts(0);
facet($('srcCtrl'), meta.sources, srcOn, srcCounts);
facet($('modCtrl'), meta.models, modOn, facetCounts(1));

// The floating panel: the same two controls, one click away wherever the page is scrolled.
function floatRow(text){
  var h = document.createElement('div');
  h.className = 'hd'; h.textContent = text;
  return h;
}
// Collapsible: the panel sits over the charts, so it can be folded down to its header.
var barHead = document.createElement('div');
barHead.className = 'head';
var barBody = document.createElement('div');
barBody.className = 'body';
var barOpen = true;
function barPaint(){
  barHead.textContent = (barOpen ? '▾' : '▸') + ' filters';
  barBody.style.display = barOpen ? 'flex' : 'none';
}
barHead.addEventListener('click', function(){ barOpen = !barOpen; barPaint(); });
barHead.setAttribute('title', 'collapse / expand');
bar.appendChild(barHead); bar.appendChild(barBody);
barPaint();

barBody.appendChild(floatRow('scale'));
barBody.appendChild(logCheckbox('log x'));
barBody.appendChild(floatRow('source'));
var barSrc = document.createElement('div');
barSrc.className = 'rows';
barBody.appendChild(barSrc);
facet(barSrc, meta.sources, srcOn, srcCounts);

$('sub').textContent = 'generated ' + meta.generatedAt.replace('T',' ').slice(0,16) +
  ' · ' + meta.sources.length + ' source' + (meta.sources.length===1?'':'s') +
  ' · ' + meta.models.length + ' model' + (meta.models.length===1?'':'s');
$('foot').textContent = 'Sources and models are auto-detected per response. Cache-write ' +
  'attribution: growth is bounded by how much the prompt grew since the previous request in ' +
  'the same session; the remainder is a re-write of already-cached prefix (TTL expiry or ' +
  'eviction). Compactions come from the CLI’s own record where there is one, otherwise ' +
  'from a context collapse between consecutive requests (flagged as inferred).';
$('outToggle').checked = true;   // outliers off by default: 0-size and idle-gap artifacts
$('outToggle').addEventListener('change', render);
render();
})();
</script>`;
}

// Standalone page: the same block, wrapped in a minimal document. Everything visible is
// produced by the block itself, so this shell only sets the page background/margins.
function renderHtml(block) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccstats — session stats</title>
<style>
html,body{margin:0;padding:0;background:#f9f9f7}
@media (prefers-color-scheme:dark){html,body{background:#0d0d0d}}
</style>
</head>
<body>
${block}
</body>
</html>`;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
function topHelp() {
  console.log(`ccstats — privacy-safe stats for local Claude Code and Codex sessions

Usage:
  ccstats stats [file.json...]   render a self-contained HTML report (ccstats stats -h)
  ccstats skel [-o file]         extract privacy-safe session skeletons (ccstats skel -h)

Sessions are discovered under ~/.claude and ~/.codex by default; pass --dir to change or add
roots. Sources (${SOURCES.join(', ')}) and models are
auto-detected, and selectable both on the command line and in the report.`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0], rest = argv.slice(1);
  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') return topHelp();
  if (cmd === 'stats') return runStats(rest);
  if (cmd === 'skel') return runSkel(rest);
  console.error(`ccstats: unknown command '${cmd}'. Try: ccstats help`);
  process.exit(1);
}

if (require.main === module) {
  main().catch(e => { console.error(`ccstats: ${e.message}`); process.exitCode = 1; });
}

module.exports = { runSkel, runStats, buildModel, buildViews };
