'use strict';

// Owned Codex sessions: one `codex exec --json` process per turn, not a thread on the
// shared app-server. On app-server a turn's sandbox can be overridden by any client of
// the socket, a loaded thread keeps whatever config it was started with, and
// turn/interrupt leaves the running command alive. Here each turn is a process of ours,
// started with the owner's arguments every time, and stop ends its whole tree.

const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const { Session, lineReader, childEnv } = require('./ccbb-mux');
const { normalizeItem } = require('./ccbb-agent-codex');

const QUEUE_MAX = 20;
const KILL_GRACE_MS = 2000;
const WATCH_MS = 500;

// exec's items are snake_case; the app-server's normalizer reads camelCase. One mapping,
// so a live exec turn renders exactly like a history read of the same rollout.
function appItem(it) {
  const status = it.status === 'in_progress' ? 'inProgress' : it.status === 'failed' ? 'failed' : 'completed';
  switch (it.type) {
    case 'agent_message': return { id: it.id, type: 'agentMessage', text: it.text || '' };
    case 'reasoning': return { id: it.id, type: 'reasoning', summary: [it.text || ''] };
    case 'command_execution': return { id: it.id, type: 'commandExecution', command: it.command, status,
      aggregatedOutput: it.aggregated_output || '', exitCode: it.exit_code ?? null };
    case 'mcp_tool_call': return { id: it.id, type: 'mcpToolCall', server: it.server, tool: it.tool, status,
      arguments: it.arguments || {}, result: it.result || null, error: it.error || null };
    case 'file_change': return { id: it.id, type: 'fileChange', status, changes: it.changes || [] };
    case 'todo_list': return { id: it.id, type: 'plan', text: (it.items || []).map(x => (x.completed ? 'done' : 'todo') + ': ' + x.text).join('\n') };
    default: return { ...it, status };
  }
}

// Every process under `root`, deepest first, read from ppid links while root is alive.
// A command exec runs is not in exec's process group, so killing the group misses it.
// What it backgrounds outlives its parent and is reparented to launchd, out of reach of
// the ppid walk, but keeps the command's process group. So the groups seen in the tree
// are kept in `groups` (a turn's walks add to it), and every live member of one goes too.
function descendants(root, groups = new Set()) {
  let rows;
  try { rows = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid='], { encoding: 'utf8' }); } catch { return []; }
  const kids = new Map(), group = new Map();
  for (const line of rows.split('\n')) {
    const [pid, ppid, pgid] = line.trim().split(/\s+/).map(Number);
    if (!pid) continue;
    group.set(pid, pgid);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(pid);
  }
  const out = [], walk = p => { for (const c of kids.get(p) || []) { walk(c); out.push(c); } };
  walk(root);
  const mine = group.get(process.pid);
  for (const p of out) { const g = group.get(p); if (g > 1 && g !== mine) groups.add(g); }
  const seen = new Set(out);
  for (const [pid, g] of group) if (groups.has(g) && pid !== root && pid !== process.pid && !seen.has(pid)) out.push(pid);
  return out;
}
function signal(pids, sig) { for (const p of pids) { try { process.kill(p, sig); } catch {} } }

class CodexExecSession extends Session {
  constructor(mux, opt) {
    super(mux, { ...opt, agent: 'codex' });
    this.agent = 'codex';
    this.nativeId = opt.resume || null;
    this.queue = []; this.child = null; this.turnSeq = 0;
    this.state = { ...this.state, agent: 'codex', engine: 'exec', nativeId: this.nativeId, permissionMode: null,
      model: null, cost: null, tokens: 0, status: 'idle', capabilities: ['submit', 'interrupt', 'rename'] };
    // A resumed thread shows what came before, read the way its history page reads it.
    // The read is async (an app-server) and a turn does not wait for it: the old messages
    // are put ahead of whatever is there by then, and every attached client gets the
    // whole snapshot again.
    if (this.nativeId) this.seed();
  }
  async seed() {
    try {
      const snap = await CodexExecSession.readHistory(this.nativeId);
      const ids = new Set(this.messages.map(m => m.id));
      this.messages = (snap.messages || []).filter(m => !ids.has(m.id)).concat(this.messages);
      if (snap.state && snap.state.title && !this.state.title) this.setTitle(snap.state.title);
      for (const c of this.clients) c.send(this.snapshot(c.window));
    } catch (e) {
      this.emit('stderr', { text: 'could not read the earlier messages of this Codex thread: ' + e.message });
    }
  }
  args() {
    // The owner's arguments on every turn: a resumed exec keeps nothing of the last one.
    return ['exec', ...(this.nativeId ? ['resume', this.nativeId] : []), '--json',
      ...(this.nativeId ? [] : ['-C', this.cwd]), ...(this.opt.args || []), '-'];
  }
  submit(text, content, from, key) {
    if (this.state.status === 'exited') throw new Error('session has exited');
    if (content && (!Array.isArray(content) || !content.every(b => b && b.type === 'text'))) throw new Error('Codex attachments are not supported');
    const body = typeof (content || text) === 'string' ? (content || text) : content.map(b => b.text || '').join('\n');
    if (!body || !body.trim()) return false;
    // exec has no slash commands; anything shaped like one goes to the model as text,
    // except from a non-owner, who may not send it at all (the locked-session rule).
    if (this.ownerRec && !this.isOwner(key) && /^\/[A-Za-z]/.test(body.replace(/^[\s\p{Cf}]+/u, ''))) {
      const e = new Error('this session is driven by its owner — slash commands need the owner key'); e.code = 'EPERM'; throw e;
    }
    if (this.queue.length >= QUEUE_MAX) throw new Error('Codex input queue is full');
    this.queue.push({ text: body, from });
    this.emit('submitted', { by: from, text: body, accepted: true });
    this.drain();
    return true;
  }
  drain() {
    if (this.child || !this.queue.length || this.state.status === 'exited') return;
    const next = this.queue.shift();
    const turnId = 'exec-' + (++this.turnSeq) + '-' + crypto.randomUUID().slice(0, 8);
    this.turnId = turnId;
    this.put({ id: 'user', type: 'userMessage', content: [{ type: 'text', text: next.text }] }, turnId, next.from);
    this.beginTurn('requesting', true);
    let stderr = '';
    const groups = this.groups = new Set();
    const child = this.child = spawn(this.opt.bin || 'codex', this.args(), {
      cwd: this.cwd, env: childEnv(this.opt.env, this.opt.cleanEnv), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', lineReader(l => { try { this.onEvent(JSON.parse(l), turnId); } catch {} }));
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
    child.stdin.on('error', () => {});
    child.stdin.end(next.text);
    child.on('error', e => this.emit('stderr', { text: 'codex exec failed to start: ' + e.message }));
    // The turn's process groups, learnt while its commands are alive (see descendants).
    const watch = setInterval(() => { if (child.exitCode == null) descendants(child.pid, groups); }, WATCH_MS);
    child.on('close', (code, sig) => {
      clearInterval(watch);
      if (this.child === child) this.child = null;
      if (code && !this.killing && stderr.trim()) this.emit('stderr', { text: stderr.trim().split('\n').slice(-5).join('\n') });
      this.killing = false;
      if (this.state.status !== 'exited') { this.endTurn(); this.state.turns = (this.state.turns || 0) + 1; this.emit('init', { state: this.state }); }
      this.drain();
    });
  }
  put(item, turnId, by) {
    const m = normalizeItem(item, turnId);
    if (by) m.by = by;
    const old = this.messages.findIndex(x => x.id === m.id);
    if (old < 0) this.messages.push(m); else this.messages[old] = m;
    if (this.messages.length > 8000) this.messages.splice(0, this.messages.length - 8000);
    this.emit('message', { message: m, replaced: old >= 0 });
  }
  onEvent(e, turnId) {
    if (e.type === 'thread.started' && e.thread_id) {
      if (!this.nativeId) {
        this.nativeId = this.state.nativeId = e.thread_id;
        // The thread is the owner's from its first event: recorded under both spellings a
        // resume can name it by, so no other path (the app-server, a history page) takes it.
        if (this.ownerRec) for (const id of [e.thread_id, 'codex:' + e.thread_id])
          try { this.mux.recordOwner(id, this.ownerRec); } catch (err) { this.emit('stderr', { text: 'could not record the owner of the Codex thread: ' + err.message }); }
        this.emit('init', { state: this.state }); this.mux.notifyChange();
      }
    } else if (/^item\.(started|updated|completed)$/.test(e.type) && e.item) {
      this.put(appItem(e.item), turnId);
      if (e.type === 'item.started') { this.state.activity = e.item.type === 'command_execution' ? 'running' : 'working'; this.emitStatus(); }
    } else if (e.type === 'turn.completed' && e.usage) {
      const u = e.usage;
      this.state.tokens = (this.state.tokens || 0) + (u.input_tokens || 0) + (u.output_tokens || 0);
      this.state.contextTokens = u.input_tokens || 0;
      this.state.contextPeak = Math.max(this.state.contextPeak || 0, this.state.contextTokens);
    } else if (e.type === 'turn.failed' || e.type === 'error') {
      this.emit('stderr', { text: (e.error && e.error.message) || e.message || 'Codex turn failed' });
    }
  }
  // The running turn and everything it started, by pid: TERM, then KILL what is left.
  killTurn() {
    const child = this.child;
    if (!child || child.exitCode != null || child.signalCode != null) return Promise.resolve();
    this.killing = true;
    const groups = this.groups || new Set();
    const tree = descendants(child.pid, groups);
    signal(tree, 'SIGTERM'); signal([child.pid], 'SIGTERM');
    return new Promise(resolve => {
      const t = setTimeout(() => { signal([...tree, ...descendants(child.pid, groups), child.pid], 'SIGKILL'); }, KILL_GRACE_MS);
      child.once('close', () => { clearTimeout(t); signal(tree, 'SIGKILL'); resolve(); });
    });
  }
  async interrupt(from) {
    this.queue = [];
    this.emit('interrupted', { by: from });
    await this.killTurn();
    this.emit('interrupt_done', { by: from, stillQueued: [] });
  }
  async stop(force, key) {
    if (!this.isOwner(key)) { const e = new Error('this session is driven by its owner — stopping it needs the owner key'); e.code = 'EPERM'; throw e; }
    this.queue = [];
    await this.killTurn();
    this.state.status = 'exited'; this.state.exit = { code: 0, signal: null };
    this._statusLine = 'exited';
    this.emit('status', { status: 'exited', exit: this.state.exit });
  }
  killNow() { const c = this.child; if (c) signal([...descendants(c.pid, this.groups || new Set()), c.pid], 'SIGKILL'); }
  async rename(title) { if (this.setTitle(title)) { this.emit('init', { state: this.state }); this.mux.notifyChange(); } }
  async setModel() { throw new Error('the model of an exec session is set by its owner'); }
  async setPermissionMode() { throw new Error('Claude permission modes do not apply to Codex'); }
  async steer() { throw new Error('steer is not available for exec sessions'); }
  async compact() { throw new Error('compact is not available for exec sessions'); }
  answerRequest() { return { ok: false, reason: 'exec sessions park no requests' }; }
  answerPermission() { return { ok: false, reason: 'exec sessions park no requests' }; }
  answerQuestion() { return { ok: false, reason: 'exec sessions park no requests' }; }
}

CodexExecSession.readHistory = id => require('./ccbb-agent-codex').history(id);

module.exports = { CodexExecSession, appItem, descendants };
