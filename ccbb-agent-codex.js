'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const readline = require('readline');
const { periodKey } = require('./ccbb-common');
const path = require('path');

// Native clients own writable rollout descriptors even when CCBB is not attached.
// A separate discovery app-server cannot report another process's loaded threads.
function nativeRollouts(procRoot = '/proc') {
  const result = new Map();
  let pids;
  try { pids = fs.readdirSync(procRoot); } catch { return result; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    const base = path.join(procRoot, pid);
    try {
      if (path.basename(fs.readlinkSync(path.join(base, 'exe'))) !== 'codex') continue;
      for (const fd of fs.readdirSync(path.join(base, 'fd'))) {
        try {
          const file = fs.readlinkSync(path.join(base, 'fd', fd));
          const match = path.basename(file).match(/^rollout-.*-([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i);
          if (!match) continue;
          const flags = fs.readFileSync(path.join(base, 'fdinfo', fd), 'utf8').match(/^flags:\s*([0-7]+)/m);
          if (flags && (parseInt(flags[1], 8) & 3)) result.set(match[1], file);
        } catch { /* A thread or descriptor closed during the scan. */ }
      }
    } catch { /* Processes owned by other users may not be inspectable. */ }
  }
  return result;
}

const nativeStatuses = new Map();
let nativeOwners = new Map(), nativeCheckedAt = 0;
function nativeActivity(id, owners) {
  if (!owners && Date.now() - nativeCheckedAt > 2000) {
    nativeOwners = nativeRollouts(); nativeCheckedAt = Date.now();
  }
  const file = (owners || nativeOwners).get(id);
  if (!file) return { live: false, liveStatus: null };
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 1024 * 1024);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    if (size > length) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const r = JSON.parse(lines[i]);
        if (r.type !== 'event_msg') continue;
        const type = r.payload && r.payload.type;
        if (!['task_started', 'task_complete', 'turn_aborted'].includes(type)) continue;
        nativeStatuses.set(id, type === 'task_started' ? 'busy' : 'idle'); break;
      } catch { /* A writer may be in the middle of its last line. */ }
    }
  } catch { /* Keep the last observed turn state while the owner is alive. */ }
  finally { if (fd != null) fs.closeSync(fd); }
  return { live: true, liveStatus: nativeStatuses.get(id) || 'idle' };
}

// Read-only stdio transport

// Short-lived stdio client for discovery. It never starts or resumes a thread.
class CodexRpc {
  constructor({ command = 'codex', args = ['app-server', '--listen', 'stdio://'], timeout = 15000 } = {}) {
    this.pending = new Map();
    this.nextId = 1;
    this.timeout = timeout;
    this.buffer = '';
    this.child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    // Drain diagnostics separately; they may contain private configuration details.
    this.child.stderr.resume();
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal || code})`)));
  }

  fail(error) {
    if (!this.error) this.error = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 32 * 1024 * 1024) { this.fail(new Error('Codex response exceeds 32 MiB limit')); this.close(); return; }
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { this.fail(new Error('Invalid JSON from Codex app-server')); return; }
      if (!message || typeof message !== 'object') {
        this.fail(new Error('Invalid response from Codex app-server')); return;
      }
      if (message.method) {
        if (message.id != null) this.send({ id: message.id, error: { code: -32601, message: 'Unsupported by CCBB discovery client' } });
        continue;
      }
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`Codex ${request.method}: ${message.error.message || 'request failed'}`));
      else request.resolve(message.result);
    }
  }

  send(message) {
    if (!this.error) this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params) {
    if (this.error) return Promise.reject(this.error);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Codex ${method} timed out`));
        this.close();
      }, this.timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ id, method, params });
    });
  }

  async initialize() {
    await this.request('initialize', { clientInfo: { name: 'ccbb', version: require('./package.json').version } });
    this.send({ method: 'initialized', params: {} });
  }

  close() {
    this.fail(new Error('Codex discovery client closed'));
    this.child.stdin.destroy();
    this.child.kill();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 1000);
    timer.unref();
    this.child.once('close', () => clearTimeout(timer));
  }
}

// Usage accounting

// Standard API-equivalent USD per million tokens, verified 2026-09-11.
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-5.5
// https://developers.openai.com/api/docs/models/gpt-5.6-sol
// These are estimates, not Codex subscription charges or service-tier invoices.
const PRICES = {
  'gpt-6-astra': [10, 1, 12.5, 50],
  'gpt-5.5': [5, 0.5, null, 30],
  'gpt-5.6-sol': [4, 0.4, 5, 20],
  'gpt-5.6': [4, 0.4, 5, 20],
};
const FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens', 'total_tokens'];

function counters(raw) {
  if (!raw) return null;
  const result = {};
  for (const field of FIELDS) {
    const value = raw[field] ?? (field === 'cache_write_input_tokens' ? 0 : NaN);
    if (!Number.isSafeInteger(value) || value < 0) return null;
    result[field] = value;
  }
  if (result.cached_input_tokens + result.cache_write_input_tokens > result.input_tokens ||
      result.reasoning_output_tokens > result.output_tokens ||
      result.total_tokens !== result.input_tokens + result.output_tokens) return null;
  return result;
}

function priceUsage(usage, model, provider, requestInput = usage.input_tokens) {
  const rates = provider === 'openai' && PRICES[String(model).replace(/-\d{4}-\d{2}-\d{2}$/, '')];
  if (!rates || (usage.cache_write_input_tokens && rates[2] == null)) return null;
  const long = requestInput > 272000;
  const inputScale = long ? 2 : 1;
  const outputScale = long ? 1.5 : 1;
  const input = usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens;
  return {
    input: input * rates[0] * inputScale / 1e6,
    cacheRead: usage.cached_input_tokens * rates[1] * inputScale / 1e6,
    cacheWrite: usage.cache_write_input_tokens * (rates[2] || 0) * inputScale / 1e6,
    output: usage.output_tokens * rates[3] * outputScale / 1e6,
  };
}

function bucket() {
  return { cost: 0, tokens: 0, turns: 0, categories: Object.fromEntries(
    ['input', 'cacheRead', 'cacheWrite', 'cacheMiss', 'output'].map(k => [k, { tokens: 0, cost: 0 }])) };
}

// Versioned read-only fallback: app-server list/read history does not expose historic
// token counters. Read only the rollout selected by app-server, never scan credentials
// or resume a session to obtain usage. Stream large histories with bounded memory.
async function readCodexUsage(thread, periodFilter) {
  if (!thread.path) return null;
  const input = fs.createReadStream(thread.path, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let summary = bucket();
  const ledger = bucket();
  let ledgerSeen = false, ledgerValid = true, ledgerReasoning = 0;
  let ledgerPrevious = Object.fromEntries(FIELDS.map(k => [k, 0]));
  let meta = null, model = thread.model, provider = thread.modelProvider;
  let previous = Object.fromEntries(FIELDS.map(k => [k, 0]));
  let observed = false, context = null, contextMax = null, contextWindow = null;
  let reasoning = 0, lastAssistantAt = null, forkStart = null, forkBaseline = false;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); }
      catch {
        return null; // never present a partial/corrupt read as complete usage
      }
      const payload = record.payload || {};
      if (record.type === 'event_msg' && ['task_started', 'task_complete', 'turn_aborted'].includes(payload.type)) {
        nativeStatuses.set(thread.id, payload.type === 'task_started' ? 'busy' : 'idle');
      }
      if (!meta) {
        if (record.type !== 'session_meta' || payload.id !== thread.id ||
            !/^0\.(135|153|154)\./.test(payload.cli_version || '')) return null;
        meta = payload;
        provider = payload.model_provider || provider;
        if (payload.forked_from_id) {
          forkStart = Date.parse(payload.timestamp);
          if (!Number.isFinite(forkStart)) return null;
        }
      }
      if (record.type === 'turn_context') model = payload.model || model;
      // Newer rollouts include per-response accounting, including compaction calls
      // omitted from token_count. Prefer it only when its cumulative chain is complete.
      if (record.type === 'token_usage_record') {
        ledgerSeen = true;
        const u = counters(payload.usage), cumulative = counters(payload.thread_token_usage);
        const at = Date.parse(record.timestamp);
        if (!u || !cumulative || !Number.isFinite(at)) { ledgerValid = false; continue; }
        const delta = Object.fromEntries(FIELDS.map(k => [k, cumulative[k] - ledgerPrevious[k]]));
        if (FIELDS.every(k => delta[k] === 0)) continue;
        if (!FIELDS.every(k => delta[k] === u[k])) ledgerValid = false;
        ledgerPrevious = cumulative;
        if (forkStart != null && at < forkStart) continue;
        if (periodFilter && periodKey(record.timestamp, periodFilter.period) !== periodFilter.key) continue;
        const costs = priceUsage(u, model, provider, u.input_tokens);
        const quantities = {input:u.input_tokens-u.cached_input_tokens-u.cache_write_input_tokens,
          cacheRead:u.cached_input_tokens,cacheWrite:u.cache_write_input_tokens,output:u.output_tokens};
        ledger.tokens += u.total_tokens; ledger.turns++; ledgerReasoning += u.reasoning_output_tokens;
        if (!costs) ledger.cost = null;
        else if (ledger.cost != null) ledger.cost += Object.values(costs).reduce((a,b)=>a+b,0);
        for (const [key,tokens] of Object.entries(quantities)) {
          ledger.categories[key].tokens += tokens;
          if (!costs) ledger.categories[key].cost = null;
          else if (ledger.categories[key].cost != null) ledger.categories[key].cost += costs[key];
        }
        continue;
      }
      if (record.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info) continue;
      const info = payload.info;
      const total = counters(info.total_token_usage);
      if (!total) return null;
      observed = true;
      const delta = Object.fromEntries(FIELDS.map(k => [k, total[k] - previous[k]]));
      previous = total;
      // Counter resets/compaction must not silently produce fabricated deltas.
      if (Object.values(delta).some(v => v < 0)) return null;
      if (!counters(delta)) return null;
      const rawLast = info.last_token_usage;
      const last = counters(rawLast);
      // Compaction publishes a context-only snapshot: all usage categories are
      // zero, total_tokens is the new context size, cumulative spending unchanged.
      const contextOnly = !delta.total_tokens && rawLast &&
        Number.isSafeInteger(rawLast.total_tokens) && rawLast.total_tokens >= 0 &&
        FIELDS.filter(k => k !== 'total_tokens').every(k =>
          (rawLast[k] ?? (k === 'cache_write_input_tokens' ? 0 : NaN)) === 0);
      if (!last && !contextOnly) return null;
      const at = Date.parse(record.timestamp);
      if (!Number.isFinite(at)) return null;
      if (forkStart != null && at < forkStart) { forkBaseline = true; continue; } // inherited spending
      contextWindow = Number.isFinite(info.model_context_window) ? info.model_context_window : null;
      // Match Claude's current-context convention: last request input + output.
      // No Claude cache expiry or speculative resend price is applied to Codex.
      context = { tokens: rawLast.total_tokens, cost: null };
      if (!contextMax || context.tokens > contextMax.tokens) contextMax = context;
      if (!delta.total_tokens) continue; // context/rate-limit updates aren't spending
      lastAssistantAt = record.timestamp;
      if (periodFilter && periodKey(record.timestamp, periodFilter.period) !== periodFilter.key) continue;
      const costs = priceUsage(delta, model, provider, last.input_tokens);
      const quantities = {
        input: delta.input_tokens - delta.cached_input_tokens - delta.cache_write_input_tokens,
        cacheRead: delta.cached_input_tokens, cacheWrite: delta.cache_write_input_tokens,
        output: delta.output_tokens,
      };
      summary.tokens += delta.total_tokens;
      summary.turns++;
      reasoning += delta.reasoning_output_tokens; // already included in output
      if (!costs) summary.cost = null;
      else if (summary.cost != null) summary.cost += Object.values(costs).reduce((a, b) => a + b, 0);
      for (const [key, tokens] of Object.entries(quantities)) {
        summary.categories[key].tokens += tokens;
        if (!costs) summary.categories[key].cost = null;
        else if (summary.categories[key].cost != null) summary.categories[key].cost += costs[key];
      }
    }
    if (ledgerSeen && ledgerValid && ledgerPrevious.total_tokens >= previous.total_tokens) {
      summary = ledger; reasoning = ledgerReasoning; observed = true;
    } else if (forkStart != null && !forkBaseline) {
      return null; // No baseline separates inherited usage from this fork’s spending.
    } else if (ledgerSeen) {
      // A partial ledger cannot establish a complete price. Keep known token counts.
      summary.cost = null;
      for (const category of Object.values(summary.categories)) category.cost = null;
    }
    if (!observed) return null;
    // CM is a Claude cache-expiry heuristic, not a reported Codex category.
    summary.categories.cacheMiss = { tokens: 0, cost: null };
    return {
      totalCost: summary.cost, totalTokens: summary.tokens, turns: summary.turns,
      inputTokens: summary.categories.input.tokens,
      cacheReadTokens: summary.categories.cacheRead.tokens,
      cacheCreationTokens: summary.categories.cacheWrite.tokens,
      cacheMissTokens: null, outputTokens: summary.categories.output.tokens,
      reasoningOutputTokens: reasoning, context, contextMax, contextWindow,
      lastAssistantAt, usageSummary: summary,
    };
  } catch {
    return null; // missing/unreadable logs leave the discovered session visible
  } finally {
    lines.close();
    input.destroy();
  }
}

function summarizeCodex(sessions) {
  const result = bucket();
  let incomplete = false, knownUsage = false, knownCost = false;
  for (const session of sessions) {
    const value = session.usageSummary;
    if (!value) { incomplete = true; continue; }
    knownUsage = true;
    result.tokens += value.tokens;
    result.turns += value.turns;
    if (value.cost == null) incomplete = true;
    else { knownCost = true; result.cost += value.cost; }
    for (const key of Object.keys(result.categories)) {
      result.categories[key].tokens += value.categories[key].tokens;
      if (value.categories[key].cost == null) result.categories[key].cost = null;
      else if (result.categories[key].cost != null) result.categories[key].cost += value.categories[key].cost;
    }
  }
  return { ...result, incomplete, knownUsage, knownCost };
}

// Session discovery

function timestamp(seconds) {
  if (!Number.isFinite(seconds)) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function getCodexSessions(periodFilter, rpc = new CodexRpc(), includeEmpty = false) {
  const sessions = new Map();
  const cursors = new Set();
  try {
    await rpc.initialize();
    let cursor = null;
    do {
      const page = await rpc.request('thread/list', {
        cursor, limit: 100, sortKey: 'updated_at', archived: false,
        // An omitted or empty source filter excludes app-server and exec sessions.
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
        modelProviders: [],
      });
      if (!page || !Array.isArray(page.data)) throw new Error('Invalid Codex thread/list response');
      for (const thread of page.data) {
        if (typeof thread.id !== 'string' || !thread.id) throw new Error('Codex thread is missing its ID');
        if (thread.parentThreadId) continue;
        const startedAt = timestamp(thread.createdAt);
        const lastActivity = timestamp(thread.updatedAt) || startedAt;
        const usage = await readCodexUsage(thread, periodFilter);
        if (periodFilter && !includeEmpty && (usage ? !usage.totalTokens :
          (!lastActivity || periodKey(lastActivity, periodFilter.period) !== periodFilter.key))) continue;
        sessions.set(thread.id, {
          agent: 'codex', sessionId: thread.id, sessionKey: `codex:${thread.id}`,
          title: thread.name || thread.preview || '', projectPath: thread.cwd || '',
          startedAt, lastActivity, totalCost: null, totalTokens: null, turns: null,
          cacheReadTokens: null, cacheCreationTokens: null, cacheMissTokens: null,
          outputTokens: null, inputTokens: null,
          ...usage,
        });
      }
      cursor = page.nextCursor;
      if (cursor != null) {
        if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('Invalid Codex pagination cursor');
        cursors.add(cursor);
      }
    } while (cursor != null);
    return [...sessions.values()];
  } finally {
    rpc.close();
  }
}

// History normalization

// Both history and live events use this semantic normalizer. No Claude wire envelopes.
function normalizeItem(item, turnId, hist = false) {
  const m = { id: 'codex:' + turnId + ':' + item.id, apiId: null, role: 'assistant',
    ts: null, model: null, parentToolUseId: null, hist, blocks: [], codexType: item.type };
  const text = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  switch (item.type) {
    case 'userMessage':
      m.role = 'user';
      m.blocks = (item.content || []).map(x => x.type === 'text' ? { type: 'text', text: x.text } : { type: 'text', text: '[' + x.type + ']' }); break;
    case 'agentMessage': case 'plan': m.blocks = [{ type: 'text', text: item.text || '' }]; break;
    case 'reasoning': m.blocks = [{ type: 'thinking', text: (item.summary || item.content || []).map(text).join('\n') }]; break;
    case 'commandExecution':
      m.blocks = [{ type: 'tool_use', id: item.id, name: 'Codex command', input: { command: item.command, cwd: item.cwd },
        status: item.status === 'inProgress' ? 'running' : 'done', result: item.aggregatedOutput || '', isError: item.exitCode != null && item.exitCode !== 0 }]; break;
    case 'fileChange':
      m.blocks = [{ type: 'tool_use', id: item.id, name: 'Codex file changes', input: { changes: item.changes },
        status: item.status === 'inProgress' ? 'running' : 'done', result: (item.changes || []).map(c => c.path + '\n' + (c.diff || '')).join('\n'), isError: item.status === 'failed' }]; break;
    case 'mcpToolCall': case 'dynamicToolCall':
      m.blocks = [{ type: 'tool_use', id: item.id, name: item.server ? 'mcp__' + item.server + '__' + item.tool : item.tool || item.type,
        input: item.arguments || {}, status: item.status === 'inProgress' ? 'running' : 'done', result: text(item.result || item.contentItems || item.error || ''), isError: !!item.error }]; break;
    default: m.blocks = [{ type: 'tool_use', id: item.id, name: 'Codex ' + item.type,
      input: item, status: item.status === 'inProgress' ? 'running' : 'done', result: null }];
  }
  for (const b of m.blocks) if (b.type === 'tool_use' && b.isError) b.status = 'error';
  return m;
}
async function readHistory(rpc, id) {
  let result = await rpc.request('thread/read', { threadId: id, includeTurns: false });
  if (result.thread.historyMode !== 'paginated') result = await rpc.request('thread/read', { threadId: id, includeTurns: true });
  let turns = result.thread.turns || [];
  // Newer servers can return only a tail. Read explicit pages when they advertise cursors.
  if (result.thread.historyMode === 'paginated' || result.turnsBackwardsCursor || result.thread.turnsBackwardsCursor) {
    turns = []; let cursor; const seen = new Set();
    do {
      const page = await rpc.request('thread/turns/list', { threadId: id, limit: 100, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}) });
      turns.push(...(page.data || [])); cursor = page.nextCursor;
      if (seen.has(cursor) && cursor) throw new Error('Repeated Codex history cursor');
      seen.add(cursor);
      if (turns.length > 8000) throw new Error('Codex history exceeds supported window');
    } while (cursor);
    turns.reverse();
  }
  return { thread: result.thread, turns };
}

// Browser cache and snapshots

const caches = new Map();
function entry(month) {
  const key = month || '';
  if (!caches.has(key)) { if (caches.size >= 6) caches.delete(caches.keys().next().value); caches.set(key, {rows:[], refreshed:0}); }
  return caches.get(key);
}
function refresh(changed, month) {
  const c = entry(month);
  if (c.pending || Date.now() - c.refreshed < 30000) return c.pending;
  c.pending = getCodexSessions(month ? {period:'month', key:month} : null, undefined, false).then(data => {
    c.rows = data.map(x => ({...x, nativeId:x.sessionId, sessionId:x.sessionKey, live:false, mux:false})); c.error=null;
  }).catch(e => {c.error=e.message;}).finally(() => {c.refreshed=Date.now();c.pending=null;if(changed)changed();});
  return c.pending;
}
function cached(month, changed) { refresh(changed,month); return entry(month).rows.map(x=>({...x, ...nativeActivity(x.nativeId)})); }
async function history(id) {
  const rpc = new CodexRpc();
  try {
    await rpc.initialize();
    const { thread, turns } = await readHistory(rpc, id);
    const messages = turns.flatMap(t => (t.items || []).map(i => normalizeItem(i, t.id, true)));
    const usage = await readCodexUsage(thread, null);
    return { op: 'snapshot', seq: 0, epoch: 'history', pending: [], clients: [], messages,
      state: { id: 'codex:' + id, agent: 'codex', nativeId: id, title: thread.name || thread.preview || 'Codex',
        cwd: thread.cwd, model: thread.model, status: 'history', ...nativeActivity(id), capabilities: [], cost: usage && usage.totalCost,
        tokens: usage && usage.totalTokens, turns: usage && usage.turns,
        contextTokens: usage && usage.context && usage.context.tokens, contextPeak: usage && usage.contextMax && usage.contextMax.tokens, costEstimated: true } };
  } finally { rpc.close(); }
}

async function renameCodexThread(id, name, rpc = new CodexRpc()) {
  try {
    await rpc.initialize();
    await rpc.request('thread/name/set', { threadId: id, name });
    for (const cache of caches.values()) cache.refreshed = 0;
  } finally { rpc.close(); }
}

module.exports = { CodexRpc, readCodexUsage, priceUsage, summarizeCodex, getCodexSessions, renameCodexThread, nativeActivity, nativeRollouts,
  normalizeItem, readHistory, cached, refresh, history, error: month => entry(month).error };
