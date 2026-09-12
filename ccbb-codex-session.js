'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const common = require('./ccbb-common');
const { Session } = require('./ccbb-mux');
const { normalizeItem, readHistory, readCodexUsage } = require('./ccbb-agent-codex');

// Persistent socket transport

// Socket control has an independent lifetime from the read-only stdio discovery client.
class CodexSocket extends EventEmitter {
  constructor(endpoint, timeout = 20000) {
    super();
    this.endpoint = endpoint;
    this.timeout = timeout;
    this.pending = new Map();
    this.nextId = 1;
    this.generation = require('crypto').randomUUID();
  }
  async connect() {
    const url = this.endpoint.startsWith('unix://')
      ? 'ws+unix://' + this.endpoint.slice(7) + ':/' : this.endpoint;
    if (!this.endpoint.startsWith('unix://')) {
      const u = new URL(url);
      if (u.username || u.password || u.search || u.hash)
        throw new Error('Codex endpoint must not contain credentials or query parameters');
      if (!['ws:', 'wss:'].includes(u.protocol) || (u.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)))
        throw new Error('Codex endpoint must use a local socket, loopback WebSocket, or TLS');
    }
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 32 * 1024 * 1024, handshakeTimeout: this.timeout });
    this.ws.on('message', raw => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { this.close(); return; }
      if (!m || typeof m !== 'object' || Array.isArray(m)) { this.close(); return; }
      if (m.method) { this.emit('message', m); return; }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'Codex request failed')); else p.resolve(m.result);
    });
    this.ws.on('error', () => {});
    this.ws.on('close', () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex disconnected; operation outcome may be unknown')); }
      this.pending.clear(); this.emit('disconnect');
    });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); });
    try {
      this.info = await this.request('initialize', {
        clientInfo: { name: 'ccbb', version: require('./package.json').version },
        capabilities: { experimentalApi: true },
      });
      this.send({ method: 'initialized', params: {} });
    } catch (e) { this.close(); throw e; }
    return this;
  }
  send(m) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('Codex is disconnected');
    this.ws.send(JSON.stringify(m));
  }
  request(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Codex ' + method + ' timed out; not retried')); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  close() { if (this.ws) this.ws.terminate(); }
}
let launching;
function stateRoot() { return process.env.CCBB_HOME || common.CLAUDE_DIR; }
async function endpoint() {
  if (process.env.CCBB_CODEX_ENDPOINT) return process.env.CCBB_CODEX_ENDPOINT;
  if (launching) return launching;
  launching = (async () => {
    const dir = path.join(stateRoot(), 'mux', 'codex');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const address = 'unix://' + path.join(dir, 'app-server.sock');
    const probe = async () => { const c = new CodexSocket(address, 1500); try { await c.connect(); return true; } catch { return false; } finally { c.close(); } };
    if (await probe()) return address;
    // The server owns its socket. Never unlink a socket that may belong to another runtime.
    const fd = fs.openSync(path.join(dir, 'server.log'), 'a', 0o600);
    const child = spawn('codex', ['app-server', '--listen', address], { detached: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    let failure;
    child.on('error', e => { failure = e; });
    child.unref();
    for (let i = 0; i < 40; i++) {
      if (failure) throw failure;
      if (await probe()) return address;
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error('Codex app-server did not start; inspect ' + path.join(dir, 'server.log'));
  })();
  try { return await launching; } finally { launching = null; }
}
async function loadedThreads(rpc) {
  const ids = new Set(), cursors = new Set(); let cursor;
  do {
    const r = await rpc.request('thread/loaded/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    for (const id of r.data || []) ids.add(id);
    cursor = r.nextCursor;
    if (cursor && cursors.has(cursor)) throw new Error('Repeated Codex loaded-thread cursor');
    cursors.add(cursor);
  } while (cursor);
  return ids;
}

// Attachment persistence

function file() { return path.join(stateRoot(), 'ccbb-mux', 'codex-bindings.json'); }
function socketIdentity(endpoint) {
  if (!endpoint.startsWith('unix://')) return null;
  try { const s = fs.statSync(endpoint.slice(7)); return s.isSocket() ? [s.dev, s.ino, s.ctimeMs].join(':') : null; } catch { return null; }
}
function read() { try { const r = JSON.parse(fs.readFileSync(file(), 'utf8')); return Array.isArray(r) ? r : []; } catch { return []; } }
function write(rows) {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  const tmp = file() + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rows.slice(-100)), { mode: 0o600 });
  fs.renameSync(tmp, file());
}
function save(session) {
  const rows = read().filter(r => r.id !== session.nativeId);
  rows.push({ id: session.nativeId, endpoint: session.rpc.endpoint, identity: socketIdentity(session.rpc.endpoint), label: session.label });
  write(rows);
}
function forget(id) { write(read().filter(r => r.id !== id)); }
async function restore(mux) {
  for (const b of read()) {
    // A new inode is a new server lifetime. Never automatically resume on it.
    if (!b.identity || socketIdentity(b.endpoint) !== b.identity) continue;
    if (process.env.CCBB_CODEX_ENDPOINT && process.env.CCBB_CODEX_ENDPOINT !== b.endpoint) continue;
    try { await mux.create({ agent: 'codex', resume: b.id, label: b.label }); } catch { /* Historical rows remain available. */ }
  }
}

// Live session control

class CodexSession extends Session {
  constructor(mux, opt, rpc, result) {
    const nativeId = result.thread.id;
    super(mux, { ...opt, agent: 'codex', sessionId: 'codex:' + nativeId });
    this.socketIdentity = socketIdentity(rpc.endpoint);
    this.rpc = rpc; this.nativeId = nativeId; this.agent = 'codex';
    this.state = { ...this.state, agent: 'codex', nativeId, endpoint: rpc.endpoint,
      title: result.thread.name || opt.label || result.thread.preview || 'Codex',
      cwd: result.cwd || result.thread.cwd || this.cwd, model: result.model || result.thread.model,
      permissionMode: null, approvalPolicy: result.approvalPolicy, reasoningEffort: result.reasoningEffort,
      cost: null, tokens: null, status: 'idle', capabilities: ['submit', 'steer', 'interrupt', 'approve', 'answerQuestion', 'rename', 'compact', 'terminalAttach'] };
    this.cwd = this.state.cwd;
    this.thread = result.thread;
    this.completedTurns = new Set();
    this.inputAuthors = new Map();
    this.items = new Map(); this.queue = []; this.sending = false;
    this.deltaItems = new Map();
    this._seeding = true;
    this.loadTurns(result.thread.turns || []);
    this._seeding = false;
    this.rpc.on('message', m => {
      try { this.onRpc(m); } catch(e) {
        this.emit('stderr',{text:'Codex event could not be decoded: '+e.message});
        if(m.id != null)this.rpc.send({id:m.id,error:{code:-32602,message:'Unsupported Codex request shape'}});
      }
    });
    this.rpc.on('disconnect', () => {
      this.flushItems();
      this.state.status = 'disconnected'; this.state.activity = null;
      this.queue = []; this.pending.clear();
      this.epoch = crypto.randomUUID(); this.events = []; this.seq = 0;
      this.broadcast(this.snapshot()); this.mux.notifyChange();
      if (!this.closing && this.socketIdentity) {
        this.reconnectTimer = setTimeout(() => {
          if (socketIdentity(rpc.endpoint) !== this.socketIdentity) return;
          this.mux.create({agent:'codex',resume:this.nativeId,label:this.label}).catch(e=>this.emit('stderr',{text:'Codex reconnect: '+e.message}));
        }, 750);
        this.reconnectTimer.unref();
      }
      this.emit('stderr', { text: 'Codex connection lost. Queued inputs were cleared; uncertain operations were not retried. Reattach to the loaded thread to reconnect.' });
    });
  }
  loadTurns(turns) {
    for (const t of turns) {
      for (const item of t.items || []) this.put(item, t.id, true);
      if (t.status !== 'inProgress') this.completedTurns.add(t.id);
      if (t.status === 'inProgress') { this.activeTurn = t.id; this.state.status = 'busy'; }
    }
    this.state.turns = turns.filter(t => t.status !== 'inProgress').length;
  }
  flushItems() {
    clearTimeout(this.deltaTimer); this.deltaTimer = null;
    const items=[...this.deltaItems.values()]; this.deltaItems.clear();
    for (const r of items) this.put(r.item,r.turnId);
  }
  put(item, turnId, hist = false, streaming = false) {
    const key = turnId + ':' + item.id;
    this.items.set(key, { item, turnId });
    if (streaming) {
      this.deltaItems.set(key,{item,turnId});
      if(!this.deltaTimer)this.deltaTimer=setTimeout(()=>this.flushItems(),50);
      return;
    }
    this.deltaItems.delete(key);
    const m = normalizeItem(item, turnId, hist);
    if(item.type === 'userMessage' && item.clientId) {m.by=this.inputAuthors.get(item.clientId) || null;}
    const old = this.messages.findIndex(x => x.id === m.id);
    if (old < 0) this.messages.push(m); else this.messages[old] = m;
    if (this.messages.length > 8000) {
      const removed = this.messages.splice(0, this.messages.length - 8000);
      for (const x of removed) this.items.delete(x.id.slice(6));
    }
    this.emit('message', { message: m, replaced: old >= 0 });
  }
  onRpc(m) {
    const p = m.params || {};
    if (p.threadId && p.threadId !== this.nativeId) return;
    if (m.id != null) return this.requestCard(m);
    if (m.method === 'serverRequest/resolved') {
      const id = this.rpc.generation + ':' + p.requestId;
      this.pending.delete(id); this.emit('request_resolved', { requestId: id, by: 'Codex', decision: 'resolved' }); return;
    }
    if (m.method === 'turn/started') {
      this.activeTurn = p.turn.id; this.beginTurn('working');
      for (const item of p.turn.items || []) this.put(item, p.turn.id);
    } else if (m.method === 'turn/completed') {
      for (const item of p.turn.items || []) this.put(item, p.turn.id);
      if (this.activeTurn === p.turn.id) this.activeTurn = null;
      if (!this.completedTurns.has(p.turn.id)) {this.state.turns++;this.completedTurns.add(p.turn.id);}
      this.turnLive = false; this.state.status = 'idle'; this.state.activity = null;
      this.emitStatus(); this.emit('init', { state: this.state });
      this.refreshUsage().catch(() => {});
      if (p.turn.error) this.emit('stderr', { text: p.turn.error.message || JSON.stringify(p.turn.error) });
      this.drain().catch(e => this.emit('stderr', { text: e.message }));
    } else if (m.method === 'item/started' || m.method === 'item/completed') {
      this.put(p.item, p.turnId);
    } else if (/^item\/.*\/.*delta$/i.test(m.method)) {
      const key = p.turnId + ':' + p.itemId;
      let record = this.items.get(key);
      if (!record) {
        record = { turnId: p.turnId, item: { id: p.itemId, type: m.method.includes('reasoning') ? 'reasoning' : 'agentMessage', text: '' } };
      }
      const item = { ...record.item };
      if (m.method.includes('commandExecution')) item.aggregatedOutput = (item.aggregatedOutput || '') + (p.delta || '');
      else if (m.method.includes('reasoning')) { item.summary = [...(item.summary || [])]; const i = p.summaryIndex || 0; item.summary[i] = (item.summary[i] || '') + (p.delta || ''); }
      else item.text = (item.text || '') + (p.delta || '');
      this.put(item, p.turnId, false, true);
    } else if (m.method === 'thread/tokenUsage/updated') {
      const u = p.tokenUsage || {}, total = u.total || {}, last = u.last || {};
      Object.assign(this.state, { tokens: total.totalTokens ?? null,
        inputTokens: total.inputTokens ?? null, cachedInputTokens: total.cachedInputTokens ?? null,
        cacheWriteInputTokens: total.cacheWriteInputTokens ?? null, outputTokens: total.outputTokens ?? null,
        reasoningOutputTokens: total.reasoningOutputTokens ?? null, contextTokens: last.totalTokens ?? 0,
        contextMax: u.modelContextWindow ?? null });
      this.state.contextPeak = Math.max(this.state.contextPeak || 0, this.state.contextTokens);
      this.emit('init', { state: this.state });
    } else if (m.method === 'thread/settings/updated') {
      const settings=p.threadSettings || {};
      Object.assign(this.state, {model:settings.model || this.state.model, cwd:settings.cwd || this.state.cwd,
        approvalPolicy:settings.approvalPolicy, reasoningEffort:settings.effort});
      if(settings.model) {this.nextModel=null;this.thread.model=settings.model;}
      if(settings.modelProvider)this.thread.modelProvider=settings.modelProvider;
      this.emit('init',{state:this.state});
    } else if (m.method === 'account/rateLimits/updated') {
      this.state.rateLimits=p.rateLimits || p; this.emit('init',{state:this.state});
    } else if (m.method === 'thread/name/updated') {
      this.state.title = p.threadName || p.name || this.state.title; this.emit('init', { state: this.state });
    } else if (m.method === 'turn/plan/updated' || m.method === 'turn/diff/updated') {
      this.put({ id: m.method, type: 'plan', text: p.diff || (p.plan || []).map(x => x.status + ': ' + x.step).join('\n') }, p.turnId);
    } else if (m.method === 'thread/status/changed') {
      this.state.status = p.status.type === 'active' ? 'busy' : p.status.type === 'idle' ? 'idle' : 'disconnected'; this.emitStatus();
    } else if (m.method === 'error') this.emit('stderr', { text: p.error && p.error.message || 'Codex error' });
  }
  requestCard(m) {
    const p = m.params || {};
    const elicitation = m.method === 'mcpServer/elicitation/request';
    const question = m.method === 'item/tool/requestUserInput';
    const permission = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(m.method);
    if (!question && !permission && !elicitation) {
      this.rpc.send({ id: m.id, error: { code: -32601, message: 'CCBB does not yet support ' + m.method } });
      this.emit('stderr', { text: 'Unsupported Codex request: ' + m.method }); return;
    }
    const requestId = this.rpc.generation + ':' + m.id;
    if (this.pending.has(requestId)) return;
    const entry = { requestKind: elicitation ? 'elicitation' : question ? 'question' : 'permission', rpcId: m.id, method: m.method, params: p,
      payload: { codexElicitation: elicitation ? p : null, codexDecisions: p.availableDecisions || null, tool_name: question ? 'AskUserQuestion' : m.method.split('/')[1], input: question
        ? { questions: (p.questions || []).map(q => ({ ...q, multiSelect: false })) } : p } };
    this.pending.set(requestId, entry); this.emit('request', { requestId, ...entry });
  }
  answerRequest(id, result, from) {
    const p = this.pending.get(id);
    if (!p || !id.startsWith(this.rpc.generation + ':')) return { ok: false, reason: 'Unknown or already resolved request' };
    if (p.method === 'mcpServer/elicitation/request') {
      if (result.behavior === 'cancelled') result={action:'cancel'};
      if (!['accept','decline','cancel'].includes(result.action)) return {ok:false, reason:'Unsupported elicitation action'};
    }
    this.rpc.send({ id: p.rpcId, result });
    this.pending.delete(id); this.emit('request_resolved', { requestId: id, by: from, decision: 'answered' }); return { ok: true };
  }
  answerPermission(id, allow, opts, from) {
    const p = this.pending.get(id); if (!p) return { ok: false };
    const result = p.method === 'item/permissions/requestApproval'
      ? { permissions: allow ? p.params.permissions : {}, scope: 'turn' }
      : { decision: opts && opts.decision || (allow ? 'accept' : ((p.params.availableDecisions || []).includes('cancel') ? 'cancel' : 'decline')) };
    if (result.decision && p.params.availableDecisions && !p.params.availableDecisions.some(d => JSON.stringify(d) === JSON.stringify(result.decision))) return {ok:false, reason:'Unsupported approval decision'};
    return this.answerRequest(id, result, from);
  }
  answerQuestion(id, picks, from) {
    const p = this.pending.get(id); if (!p) return { ok: false };
    const answers = {};
    for (const q of p.params.questions || []) {
      const selected = picks[q.id] || picks[q.question];
      answers[q.id] = { answers: Array.isArray(selected) ? selected : selected ? [String(selected)] : [] };
    }
    return this.answerRequest(id, { answers }, from);
  }
  async submit(text, content, from) {
    if (this.state.status === 'disconnected') throw new Error('Reconnect Codex before sending');
    if (content && (!Array.isArray(content) || !content.every(b => b.type === 'text'))) throw new Error('Codex attachments are not supported yet');
    const body = text || (content || []).map(b => b.text).join('\n');
    if (!body || !body.trim()) return false;
    if (body.trim() === '/compact') {await this.compact();return true;}
    if (body.trim().startsWith('/model ')) {await this.setModel(body.trim().slice(7).trim());return true;}
    if (body.trim().startsWith('/steer ')) return this.steer(body.trim().slice(7));
    if (/^\/[^/\s]/.test(body.trim())) throw new Error('Supported Codex commands: /compact, /model <model-id>, /steer <message>');
    if (this.queue.length >= 20) throw new Error('Codex input queue is full');
    this.queue.push({ text: body, from });
    this.emit('submitted', { by: from, text: body, accepted: true });
    await this.drain(); return true;
  }
  async drain() {
    if (this.activeTurn || this.sending || !this.queue.length) return;
    this.sending = true;
    const next = this.queue.shift();
    try {
      // Native clients can start between this check and turn/start. The server is authoritative.
      const clientId=crypto.randomUUID();this.inputAuthors.set(clientId,next.from);
      if(this.inputAuthors.size > 100)this.inputAuthors.delete(this.inputAuthors.keys().next().value);
      const r = await this.rpc.request('turn/start', { threadId: this.nativeId, clientUserMessageId:clientId, input: [{ type: 'text', text: next.text, text_elements: [] }],
        ...(this.nextModel ? { model: this.nextModel } : {}), ...(this.opt.effort ? { effort: this.opt.effort } : {}) });
      if (r.turn && r.turn.status === 'inProgress' && !this.completedTurns.has(r.turn.id)) this.activeTurn = r.turn.id;
    } catch (e) {
      this.queue = []; // An uncertain start must not trigger another queued turn.
      throw e;
    } finally {
      this.sending = false;
      if (!this.activeTurn && this.queue.length && !this.closing && this.state.status !== 'disconnected') {
        this.drain().catch(e => this.emit('stderr', {text:e.message}));
      }
    }
  }
  async steer(text) {
    if (!this.activeTurn) throw new Error('No active turn to steer');
    await this.rpc.request('turn/steer', { threadId: this.nativeId, expectedTurnId: this.activeTurn, input: [{ type: 'text', text, text_elements: [] }] }); return true;
  }
  async interrupt() { this.queue = []; if (this.activeTurn) await this.rpc.request('turn/interrupt', { threadId: this.nativeId, turnId: this.activeTurn }); }
  async setPermissionMode() { throw new Error('Claude permission modes do not apply to Codex'); }
  async setModel(model) {
    const r = await this.rpc.request('model/list', {});
    if (!(r.data || []).some(x => x.model === model)) throw new Error('Unknown Codex model');
    this.nextModel = model; this.state.model = model; this.emit('model', { model });
  }
  async refreshUsage() {
    const u = await readCodexUsage(this.thread, null);
    if (u) { Object.assign(this.state, {cost:u.totalCost, costEstimated:true, tokens:u.totalTokens, turns:u.turns, contextTokens:u.context && u.context.tokens, contextPeak:u.contextMax && u.contextMax.tokens}); this.emit('init', {state:this.state}); }
  }
  async rename(name) { await this.rpc.request('thread/name/set', { threadId: this.nativeId, name }); this.state.title = name; this.emit('init', { state: this.state }); }
  async compact() { await this.rpc.request('thread/compact/start', { threadId: this.nativeId }); }
  // Stop means detach CCBB. Thread shutdown is deliberately unavailable on a shared server.
  async stop() { this.flushItems(); this.closing = true; clearTimeout(this.reconnectTimer); this.queue = []; this.rpc.close(); }
}
async function createCodexSession(mux, opt) {
  if (opt.permissionMode) throw new Error('Use Codex approval/sandbox configuration; Claude permission modes are unsupported');
  const ref = opt.resume && opt.resume.replace(/^codex:/, '');
  if (ref && !opt.fork) {
    const existing = mux.sessions.get('codex:' + ref);
    if (existing && existing.state.status !== 'disconnected') return existing;
  }
  if (opt.fork && !ref) throw new Error('Codex --fork requires --resume <thread-id>');
  const rpc = await new CodexSocket(await endpoint()).connect();
  const buffered = []; const collect = m => buffered.push(m); rpc.on('message', collect);
  try {
    if (ref && !opt.fork && !(await loadedThreads(rpc)).has(ref)) throw new Error('Codex thread ownership is unknown: attach only a thread already loaded on the configured app-server');
    if (!/\/0\.154\./.test(rpc.info.userAgent || '')) throw new Error('Codex socket control requires the tested 0.154.x CLI');
    const prior = ref ? await readHistory(rpc, ref) : null;
    const result = await rpc.request(ref ? (opt.fork ? 'thread/fork' : 'thread/resume') : 'thread/start', ref ? { threadId: ref } : { cwd: opt.cwd || process.cwd(), ...(opt.model ? { model: opt.model } : {}), ...(opt.approvalPolicy ? {approvalPolicy:opt.approvalPolicy} : {}), ...(opt.sandbox ? {sandbox:opt.sandbox} : {}), ...(opt.approvalsReviewer ? {approvalsReviewer:opt.approvalsReviewer} : {}) });
    if (!result.thread || !result.thread.id) throw new Error('Codex returned no thread identity');
    if (opt.fork && result.thread.id === ref) throw new Error('Codex fork did not return a distinct thread ID');
    opt.label = mux.uniqueLabel(opt.label || 'codex');
    if (prior && !opt.fork && prior.turns.length > (result.thread.turns || []).length) {
      const combined = new Map(prior.turns.map(t=>[t.id,t]));
      for(const t of result.thread.turns || [])combined.set(t.id,t);
      result.thread.turns=[...combined.values()];
    }
    const s = new CodexSession(mux, opt, rpc, result);
    rpc.removeListener('message', collect);
    for (const m of buffered) s.onRpc(m);
    await s.refreshUsage();
    const old = mux.sessions.get(s.id);
    mux.sessions.set(s.id, s);
    if (old && old !== s) { for (const client of old.clients) { client.session = s; s.attach(client); } old.clients.clear(); }
    try { save(s); } catch(e) {s.emit('stderr',{text:'Could not save Codex attachment: '+e.message});}
    mux.notifyChange();
    return s;
  } catch (e) { rpc.close(); throw e; }
}

module.exports = { CodexSession, createCodexSession, CodexSocket, endpoint, loadedThreads,
  stateRoot, save, forget, restore, socketIdentity };
