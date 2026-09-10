'use strict';
// ── ccbb-mux.js ──────────────────────────────────────────────────────────────
// The multiplexer: one `claude` child per session, N controllers attached to it.
//
// Claude Code has exactly two output personalities and you get one of them: the
// interactive TUI, or `--print --output-format stream-json`. They are mutually
// exclusive — under a TTY the stream-json flag is silently ignored and the TUI
// takes stdout with no tee. So a session ccbb wants to *render itself* has to be
// a session ccbb *started* in JSON mode. That's what lives here.
//
// The shape:
//
//     claude child  ←NDJSON→  Session  ←ccbb protocol/WS→  web client
//                                 ↑                    ↘   terminal client
//                             event log                 …
//
// The Session is the SOLE writer of the child's stdin and the SOLE reader of its
// stdout. It normalizes the CLI's stream-json into one canonical event log + a
// derived snapshot, and every client renders that. Clients never see raw
// stream-json. This is deliberate: if each client parsed the CLI protocol on its
// own they would drift, and every rendering bug would cost two fixes.
//
// Three things here are load-bearing and easy to get wrong:
//
//   1. Control requests need EXACTLY ONE response. `can_use_tool` (permissions
//      and AskUserQuestion) and `request_user_dialog` each carry a request_id the
//      child is blocked on. With N controllers that's a claim race — see
//      answerRequest(): compare-and-set, first answer wins, everyone else is told
//      who won so their card can dismiss.
//   2. The child exits when stdin closes. Zero attached clients is a NORMAL
//      state, so stdin stays open for the child's whole life regardless of who is
//      watching.
//   3. Late joiners must not see a half-session. Every client event is numbered,
//      so an attach is either a full snapshot or a delta replay from `sinceSeq`.
//
// Protocol notes that came out of reading the VS Code extension's own bundle and
// then verifying against a live child (see ccbb-mux-plan.md):
//   • `--permission-prompt-tool stdio` is the switch that turns permission
//     prompts into in-band control_requests instead of TUI dialogs. Without it
//     none of this works.
//   • AskUserQuestion is a TOOL, not a dialog. You answer it by ALLOWING the tool
//     with a rewritten input — see answersToUpdatedInput().
//   • `--replay-user-messages` echoes accepted user turns back on stdout, so all
//     clients learn the real submission order from the child rather than from
//     their own optimistic echo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const common = require('./ccbb-common');
const { CLAUDE_DIR } = common;

const MUX_DIR = path.join(CLAUDE_DIR, 'ccbb-mux');       // logs + the daemon's address file
// 8590/8592 are already spoken for by `ccbb web` and the peer ssh forwards.
const DELTA_COALESCE_MS = 50;      // token deltas are batched to this cadence per client
const LOG_RING = 5000;             // client events kept in memory for sinceSeq replay
const HISTORY_SEED = 1200;         // transcript turns replayed into a --resume, newest-last

function uuid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function ensureDir(d) { try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch {} }

// ── The child's command line ──────────────────────────────────────────────────
// Every flag here was checked against a live child; the whole line spawns and
// emits system/init together, which is not a given (the CLI does reject some flag
// pairs outright — `canUseTool` alongside `permissionPromptToolName` throws).
//
//   --verbose                   stream-json emits only `result` without it
//   --include-partial-messages  token deltas → live typing in every client
//   --replay-user-messages      accepted user turns echo back (ordering authority)
//   --include-hook-events       hook_started / hook_progress / hook_response
//   --forward-subagent-text     subagent text+thinking, not just tool blocks
//   --permission-prompt-tool stdio   permissions arrive as control_request
function buildArgs(opt) {
  const a = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--include-hook-events',
    '--forward-subagent-text',
    '--permission-prompt-tool', 'stdio',
  ];
  // --session-id is REFUSED alongside --resume unless --fork-session comes with it:
  //   Error: --session-id can only be used with --continue or --resume if
  //   --fork-session is also specified.
  // Passing all three killed the child before it wrote a byte, which surfaced as a
  // session stuck in 'starting' with an empty log rather than as an error. Resuming
  // in place keeps the original id — the child goes on writing the original
  // transcript, so there is no new id to assign. Forking mints a new session, so
  // there is, and Claude Code takes ours for it.
  if (!opt.resume || opt.fork) a.push('--session-id', opt.sessionId);
  if (opt.resume) { a.push(`--resume=${opt.resume}`); if (opt.fork) a.push('--fork-session'); }
  if (opt.permissionMode) a.push('--permission-mode', opt.permissionMode);
  if (opt.model) a.push('--model', opt.model);
  if (opt.effort) a.push('--effort', opt.effort);
  for (const d of opt.addDir || []) a.push('--add-dir', d);
  for (const x of opt.extraArgs || []) a.push(x);
  return a;
}

// Bedrock and the other third-party providers are pure environment forwarding —
// the VS Code extension contains no provider code either, it just hands env to
// the child. The one thing that differs operationally is credentials: an SSO
// refresh in the middle of a turn looks exactly like a hang to every attached
// client unless the session surfaces it, so `auth_status` is wired through as a
// status event (see onMessage).
const PROVIDER_ENV = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_API_KEY',
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'GOOGLE_APPLICATION_CREDENTIALS', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID',
];
function childEnv(extra) {
  const env = { ...process.env };
  for (const k of PROVIDER_ENV) if (process.env[k] != null) env[k] = process.env[k];
  // Identify ccbb to the CLI the way the SDK identifies itself; some telemetry
  // and a couple of behavioural switches key off it.
  // Unconditional, not a default. This marker is what tells ccbb's pane discovery that the
  // child is a mux subprocess rather than a tmux session (see isMuxRecord in ccbb-common).
  // Start ccbb web from inside a Claude Code session's shell and the inherited value
  // would be 'cli' — the filter misses, and the pane gets adopted again with no sign why.
  env.CLAUDE_CODE_ENTRYPOINT = 'ccbb-mux';
  return Object.assign(env, extra || {});
}

// ── AskUserQuestion ──────────────────────────────────────────────────────────
// The answer format is not documented anywhere public. It was read out of the VS
// Code webview's own renderer and then confirmed by round-trip against a live
// child: the tool is ALLOWED with a rewritten input carrying an `answers` object
//   • keyed by the question's VERBATIM text — not an index, not an id
//   • valued with the selected option LABELS joined by ", "
//   • an "Other" pick is replaced by the typed free text before joining
// A wrong shape fails loudly ("updatedInput must satisfy the tool's input
// schema"), which is the good outcome — it can't silently answer the wrong thing.
function answersToUpdatedInput(input, picks) {
  const answers = {};
  for (const q of (input.questions || [])) {
    const p = picks[q.question];
    if (p == null) continue;
    const list = Array.isArray(p) ? p : [p];
    answers[q.question] = list.map(v => String(v)).filter(Boolean).join(', ');
  }
  return { ...input, answers };
}

// ── Line-oriented NDJSON reader ──────────────────────────────────────────────
// stream-json is newline-delimited but NOT chunk-delimited: a single JSON object
// routinely spans two 'data' events. Assuming one chunk == one object is the
// single most common way a custom stream-json UI breaks.
function lineReader(onLine) {
  let buf = '';
  return chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
    // A pathological producer with no newlines must not grow this forever.
    if (buf.length > 64 * 1024 * 1024) buf = '';
  };
}

// The kinds that move a field on the SESSION LIST — status, the end of a turn, the
// mode and model selectors, and a card opening or closing. Deltas are deliberately
// not here: a token arriving changes nothing a list row shows, and ringing the bell
// for each one would turn one busy session into a broadcast storm over every open
// browser. The host that owns the list decides how to coalesce these.
const ROW_KINDS = new Set(['init', 'status', 'result', 'mode', 'model',
  'request', 'request_resolved', 'request_cancelled']);

// ── Local slash commands ─────────────────────────────────────────────────────
// /cost, /compact, /model and friends never reach the API: the child runs them and
// reports back. Two carriers, both verified against a live child rather than read off
// a transcript file — the on-disk JSONL and the wire do NOT agree here:
//
//   • a SYNTHETIC assistant message: is_meta true, model "<synthetic>", the output
//     already unwrapped in content, and the original envelope kept in
//     `local_command_source`. That envelope is the only thing that says whether the
//     command worked — <local-command-stdout> vs <local-command-stderr>.
//   • a replayed USER message whose entire text IS the envelope, which is what a
//     successful /compact leaves behind. This is the one that used to render as
//     "❯ <local-command-stdout>Compacted </local-command-stdout> (web-d4a0)" —
//     a person's turn, in raw markup, attributed to whoever typed the command.
//
// There is no <command-name> block on the wire (that shape is written to the
// transcript file only), but it is matched anyway: it costs one regex and it is what
// a resumed session's replayed history carries.
//
// Both carriers normalize to ONE tag, so neither renderer has to know there were two
// and neither can drift from the other.
const CMD_OUT = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/;
const CMD_RUN = /<command-name>\s*\/?([^<\s]*)[^<]*<\/command-name>(?:[\s\S]*?<command-args>([\s\S]*?)<\/command-args>)?/;
function parseCommand(text) {
  if (!text || text.indexOf('<') === -1) return null;
  const o = CMD_OUT.exec(text);
  if (o) return { kind: 'out', stream: o[1], text: o[2] };
  const r = CMD_RUN.exec(text);
  if (r) return { kind: 'run', name: r[1] || '', args: (r[2] || '').trim() };
  return null;
}

// ── Session ──────────────────────────────────────────────────────────────────
class Session {
  constructor(mux, opt) {
    this.mux = mux;
  // Resuming in place, this session IS the one being resumed: the child continues the
  // original transcript, so taking its id is what keeps the mux's row, ccbb web's disk
  // row and the file on disk all naming the same thing. A fork is a genuinely new
  // session and gets a fresh id.
    this.id = opt.sessionId || (opt.resume && !opt.fork ? opt.resume : uuid());
    this.cwd = opt.cwd || process.cwd();
    this.opt = opt;
    this.label = opt.label || path.basename(this.cwd);

    this.seq = 0;
    this.events = [];                 // ring of client events, for sinceSeq replay
    this.clients = new Set();
    this.pending = new Map();         // requestId → { kind, payload, claimedBy }
    this.outstanding = new Map();     // our own control_requests → resolver
    this.attribution = [];            // FIFO of {text,label} awaiting their replay echo

    this.messages = [];               // normalized, render-ready
    this.byToolUseId = new Map();     // tool_use id → its block, for result folding
    this.state = {
      id: this.id, cwd: this.cwd, label: this.label, status: 'starting',
      model: null, permissionMode: opt.permissionMode || null,
      tools: [], mcpServers: [], plugins: [], commands: [], slashCommands: [],
      capabilities: [], auth: null, cost: 0, tokens: 0, turns: 0,
      startedAt: nowIso(), lastActivity: nowIso(), exit: null,
    };

    ensureDir(MUX_DIR);
    this.rawLog = fs.createWriteStream(path.join(MUX_DIR, this.id + '.ndjson'), { flags: 'a' });
    // BEFORE spawn, deliberately: resuming in place the child appends to this very
    // file, so reading it afterwards races its own writes and replays turns it just
    // made. A fork reads the parent's file, which is exactly what it branched from.
    if (opt.resume) this.seedHistory(opt.resume);
    this.spawn();
  }

  // What --resume does NOT give back. In print/stream-json the child replays nothing:
  // it loads the transcript into its own context and emits only the new turns, so a
  // resumed session opened in a client showed an empty page next to a $70 history.
  // (Confirmed against anthropics/claude-agent-sdk-typescript#14 and -python#109 —
  // retrieving prior messages is an open feature request, not a flag we missed.)
  // So the history is read off disk and pushed through the SAME normalizer the wire
  // goes through, which is the only way the two can't drift.
  seedHistory(resumeId) {
    let file = null;
    try { file = common.findSessionJsonl(resumeId); } catch (e) {}
    if (!file) return;
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch (e) { return; }

    const keep = [];
    for (const line of lines) {
      if (!line) continue;
      let j;
      try { j = JSON.parse(line); } catch (e) { continue; }
      // The file holds a dozen record types the wire never sends — attachment,
      // file-history-snapshot, mode, custom-title. Only the two that are turns.
      if (j.type !== 'user' && j.type !== 'assistant') continue;
      if (j.isSidechain) continue;              // a subagent's own thread, not this one's
      // A compact summary is a user message whose content is the ENTIRE prior
      // conversation. Rendered as a turn it is a wall of text nobody wrote; the
      // turns it summarizes are still in this same file, above it.
      if (j.isCompactSummary) continue;
      if (j.isVisibleInTranscriptOnly) continue;
      keep.push(j);
    }
    // The tail, not the whole thing: this.messages is capped, and a 6000-line
    // transcript seeded whole would leave the live turns evicting the history they
    // were meant to continue. What a person opening a resumed session wants is the
    // end of it.
    const seed = keep.length > HISTORY_SEED ? keep.slice(keep.length - HISTORY_SEED) : keep;

    this._seeding = true;
    try {
      for (const j of seed) {
        try { this.onModelMessage(j, j.type); } catch (e) {}
      }
    } finally { this._seeding = false; }
    // Nothing was emitted (emit() is a no-op while seeding), so seq is still 0 and
    // the ring is empty: a client's FIRST attach gets these in snapshot().messages,
    // and a RECONNECT still takes the sinceSeq delta because it already has them.
    // Rendered turns, not lines read: a tool_result folds into the call above it, so
    // the file always has more entries than the transcript has messages.
    this.historyCount = this.messages.length;
  }

  spawn() {
    const args = buildArgs({ ...this.opt, sessionId: this.id });
    this.child = spawn(this.opt.bin || 'claude', args, {
      cwd: this.cwd, env: childEnv(this.opt.env), stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', lineReader(l => this.onLine(l)));
    this.child.stderr.on('data', d => this.emit('stderr', { text: String(d) }));
    this.child.on('exit', (code, sig) => {
      this.state.status = 'exited';
      this.state.exit = { code, signal: sig };
      this.emit('status', { status: 'exited', exit: this.state.exit });
      try { this.rawLog.end(); } catch {}
    });
    this.child.on('error', e => this.emit('stderr', { text: `spawn failed: ${e.message}` }));
  }

  // ── writing to the child ───────────────────────────────────────────────────
  // The only place anything is written to stdin. Note what is NOT here: any path
  // that ends stdin. The child exits when stdin closes, and clients come and go,
  // so only stop() is allowed to close it.
  write(obj) {
    if (!this.child || this.child.exitCode != null || !this.child.stdin.writable) return false;
    try { this.child.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; }
  }

  control(subtype, extra) {
    const requestId = uuid();
    this.write({ type: 'control_request', request_id: requestId, request: { subtype, ...(extra || {}) } });
    return new Promise(res => {
      this.outstanding.set(requestId, res);
      setTimeout(() => { if (this.outstanding.delete(requestId)) res(null); }, 30000);
    });
  }

  // ── client events ──────────────────────────────────────────────────────────
  emit(kind, body) {
    // Seeding history off disk builds this.messages and must not touch the wire:
    // no seq, no ring, no notifyChange, and no attribution — those turns were typed
    // by whoever typed them in the previous run, not by anyone attached now.
    if (this._seeding) return null;
    const ev = { op: 'event', seq: ++this.seq, ts: nowIso(), ...body, kind };  // kind last: body must not clobber it
    this.events.push(ev);
    if (this.events.length > LOG_RING) this.events.splice(0, this.events.length - LOG_RING);
    this.state.lastActivity = ev.ts;
    for (const c of this.clients) c.send(ev);
    if (ROW_KINDS.has(kind)) this.mux.notifyChange();
    return ev;
  }

  snapshot() {
    return {
      op: 'snapshot', seq: this.seq,
      state: this.state,
      messages: this.messages,
      pending: [...this.pending.entries()].map(([requestId, p]) => ({ requestId, ...p })),
      clients: [...this.clients].map(c => ({ label: c.label, kind: c.kind })),
    };
  }

  broadcast(msg) { for (const c of this.clients) c.send(msg); }

  attach(client, sinceSeq) {
    this.clients.add(client);
    // A reconnecting client that still holds the tail of the log gets a delta —
    // this is the same shape the mobile web client needs after iOS suspends it.
    if (sinceSeq != null && this.events.length && this.events[0].seq <= sinceSeq + 1) {
      client.send({ op: 'resumed', seq: this.seq, from: sinceSeq });
      for (const ev of this.events) if (ev.seq > sinceSeq) client.send(ev);
    } else {
      client.send(this.snapshot());
    }
    this.presence();
  }

  detach(client) {
    this.clients.delete(client);
    this.presence();                 // the child keeps running with zero clients
  }

  presence() {
    this.broadcast({ op: 'presence', clients: [...this.clients].map(c => ({ label: c.label, kind: c.kind })) });
    this.mux.notifyChange();
  }

  // ── client → child ─────────────────────────────────────────────────────────
  submit(text, content, from) {
    const body = content || text;
    // Attribution: the replay echo carries no idea who typed it, so remember the
    // pairing and reattach the label when the child hands the turn back.
    // A slash command produces no replay at all (the child answers it synthetically),
    // so its attribution entry would sit at the head of the FIFO forever and be handed
    // to the NEXT turn somebody typed. Marked here and claimed by the synthetic result.
    const isSlash = typeof body === 'string' && /^\/[^/\s]/.test(body.trim());
    this.attribution.push({ text: typeof body === 'string' ? body : null, label: from, slash: isSlash });
    if (this.attribution.length > 64) this.attribution.shift();
    const ok = this.write({ type: 'user', message: { role: 'user', content: body }, parent_tool_use_id: null });
    this.emit('submitted', { by: from, text: typeof body === 'string' ? body : '[attachments]', accepted: ok });
    return ok;
  }

  // The claim race. Exactly one control_response per request_id ever reaches the
  // child; a second answer is rejected HERE rather than forwarded, because a
  // duplicate corrupts the protocol rather than merely looking wrong.
  answerRequest(requestId, payload, from) {
    const p = this.pending.get(requestId);
    if (!p) return { ok: false, reason: 'unknown or already answered' };
    this.pending.delete(requestId);                       // compare-and-set: first wins
    this.write({ type: 'control_response', response: { request_id: requestId, subtype: 'success', response: payload } });
    this.emit('request_resolved', { requestId, by: from, decision: payload.behavior || 'completed' });
    return { ok: true };
  }

  // Convenience wrappers so a client never has to know the CLI's response shapes.
  answerPermission(requestId, allow, opts, from) {
    const p = this.pending.get(requestId);
    if (!p) return { ok: false, reason: 'unknown or already answered' };
    const o = opts || {};
    const payload = allow
      ? { behavior: 'allow', updatedInput: o.updatedInput || p.payload.input, ...(o.updatedPermissions ? { updatedPermissions: o.updatedPermissions } : {}) }
      : { behavior: 'deny', message: o.message || 'Denied from ccbb', interrupt: !!o.interrupt };
    return this.answerRequest(requestId, payload, from);
  }

  answerQuestion(requestId, picks, from) {
    const p = this.pending.get(requestId);
    if (!p) return { ok: false, reason: 'unknown or already answered' };
    return this.answerRequest(requestId, { behavior: 'allow', updatedInput: answersToUpdatedInput(p.payload.input, picks) }, from);
  }

  // The child answers an interrupt with `still_queued` — what SURVIVED, not what
  // was dropped. With one controller that's noise; with N it tells everyone whose
  // queued work is still coming. The attribution FIFO is deliberately left alone:
  // the replay echo lags submission by seconds, so clearing it here would strip
  // the owner off a turn that is still in flight.
  async interrupt(from) {
    this.emit('interrupted', { by: from });
    const r = await this.control('interrupt');
    const stillQueued = (r && r.response && r.response.still_queued) || [];
    this.state.status = 'idle';
    this.emit('interrupt_done', { by: from, stillQueued });
    return r;
  }
  async setPermissionMode(mode, from) {
    const r = await this.control('set_permission_mode', { mode });
    this.state.permissionMode = mode;
    this.emit('mode', { permissionMode: mode, by: from });
    return r;
  }
  async setModel(model, from) {
    const r = await this.control('set_model', { model });
    this.state.model = model;
    this.emit('model', { model, by: from });
    return r;
  }

  // Graceful close: end the turn first, then let the child drain. A SIGTERM here
  // would exit 143 and leave the turn recorded as unfinished, which resurfaces on
  // the next --resume; SIGINT/interrupt ends it cleanly. The drain scales with
  // backlog up to ~30s, so a slow exit is not a hang.
  async stop(force) {
    if (!this.child || this.child.exitCode != null) return;
    if (!force) { try { await this.interrupt('mux'); } catch {} }
    try { this.child.stdin.end(); } catch {}
    const t = setTimeout(() => { try { this.child.kill('SIGTERM'); } catch {} }, force ? 0 : 32000);
    await new Promise(res => this.child.once('exit', res));
    clearTimeout(t);
  }

  // ── child → normalized events ──────────────────────────────────────────────
  onLine(line) {
    this.rawLog.write(line + '\n');
    let m;
    try { m = JSON.parse(line); } catch { return this.emit('stderr', { text: 'unparsable line from child' }); }
    try { this.onMessage(m); } catch (e) { this.emit('stderr', { text: 'normalize failed: ' + e.message }); }
  }

  onMessage(m) {
    switch (m.type) {
      case 'keep_alive': return;

      // A control_request is the child BLOCKING on us. Park it in `pending` and
      // fan it out; whoever answers first settles it (see answerRequest).
      case 'control_request': return this.onControlRequest(m);

      // Our own responses echo back on stdout. We already broadcast the
      // resolution when we sent it, so the echo is noise — but a response to a
      // request WE made (interrupt, set_model) resolves its promise.
      case 'control_response': {
        const id = m.response && m.response.request_id;
        const res = this.outstanding.get(id);
        if (res) { this.outstanding.delete(id); res(m.response); }
        return;
      }

      // The child withdrew a request — the human answered it elsewhere, or the
      // turn was interrupted. Every client must drop the card.
      case 'control_cancel_request': {
        const id = m.request_id;
        if (this.pending.delete(id)) this.emit('request_cancelled', { requestId: id });
        return;
      }

      case 'system': return this.onSystem(m);

      case 'assistant': return this.onModelMessage(m, 'assistant');
      case 'user': return this.onModelMessage(m, 'user');

      case 'stream_event': return this.onStreamEvent(m);

      case 'result': {
        this.state.status = 'idle';
        this.state.cost = (this.state.cost || 0) + (m.total_cost_usd || 0);
        this.state.turns += (m.num_turns || 0);
        const u = m.usage || {};
        this.state.tokens += (u.input_tokens || 0) + (u.output_tokens || 0) +
          (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        return this.emit('result', {
          isError: !!m.is_error, subtype: m.subtype, stopReason: m.stop_reason,
          costUsd: m.total_cost_usd, usage: u, durationMs: m.duration_api_ms,
          result: m.result, errors: m.errors,
        });
      }

      case 'rate_limit_event':
        return this.emit('rate_limit', { info: m.rate_limit_info });

      // --include-hook-events. Useful in its own right, and the only way a client
      // can tell "a hook is thinking" from "the model is thinking".
      case 'hook_started': case 'hook_progress': case 'hook_response':
        return this.emit('hook', { phase: m.type.slice(5), event: m.hook_event_name, body: m });

      case 'active_goal':      return this.emit('goal', { goal: m });
      case 'autocompact_state': return this.emit('autocompact', { body: m });
      case 'transcript_mirror': return;   // only with --session-mirror; unused here

      default:
        return this.emit('unknown', { childType: m.type, body: m });
    }
  }

  onControlRequest(m) {
    const r = m.request || {};
    const requestId = m.request_id;
    if (r.subtype === 'can_use_tool') {
      // AskUserQuestion is a tool that happens to be a question. Split it out so
      // clients can render a question card instead of a permission card — the
      // child flags it for us with requires_user_interaction.
      const requestKind = r.tool_name === 'AskUserQuestion' ? 'question' : 'permission';
      const p = { requestKind, payload: r, claimedBy: null };
      this.pending.set(requestId, p);
      return this.emit('request', { requestId, ...p });
    }
    if (r.subtype === 'request_user_dialog') {
      // Only two kinds ship today (refusal_fallback / fable overage consent). An
      // unhandled kind is PARKED by the child, not failed — so staying silent is
      // a legal answer, and a wrong one is worse than none.
      const p = { requestKind: 'dialog', payload: r, claimedBy: null };
      this.pending.set(requestId, p);
      return this.emit('request', { requestId, ...p });
    }
    if (r.subtype === 'mcp_message' || r.subtype === 'hook_callback') {
      // Not ours to answer; the child expects an SDK-side implementation. Refuse
      // explicitly rather than letting it hang forever.
      return this.write({ type: 'control_response', response: { request_id: requestId,
        subtype: 'error', error: `ccbb-mux does not implement ${r.subtype}` } });
    }
    return this.emit('unknown', { childType: 'control_request/' + r.subtype, body: m });
  }

  onSystem(m) {
    if (m.subtype === 'init') {
      Object.assign(this.state, {
        status: 'idle',
        model: m.model || this.state.model,
        tools: m.tools || [],
        mcpServers: m.mcp_servers || [],
        plugins: m.plugins || [],
        capabilities: m.capabilities || [],     // feature-detect, never version-compare
        permissionMode: m.permissionMode || this.state.permissionMode,
        slashCommands: m.slash_commands || this.state.slashCommands,
        cwd: m.cwd || this.cwd,
      });
      return this.emit('init', { state: this.state, errors: {
        plugins: m.plugin_errors, mcp: m.mcp_server_errors } });
    }
    // The live slash-command list. The terminal client's "/" menu is driven from
    // this rather than a hardcoded table, so plugins and skills show up for free.
    if (m.subtype === 'commands_changed') {
      this.state.commands = m.commands || [];
      return this.emit('commands', { commands: this.state.commands });
    }
    if (m.subtype === 'status') {
      if (m.status === 'requesting') this.state.status = 'busy';
      return this.emit('status', { status: m.status });
    }
    // Bedrock/SSO: a credential refresh mid-turn is indistinguishable from a hang
    // unless the session says so out loud.
    if (m.subtype === 'auth_status') {
      this.state.auth = m;
      return this.emit('auth', { body: m });
    }
    if (m.subtype === 'api_retry') return this.emit('retry', { body: m });
    // --include-hook-events arrives as system subtypes, not as top-level message
    // types. Routed here so a client can tell "a hook is thinking" from "the model
    // is thinking" — the two are indistinguishable otherwise, and a synchronous
    // deciding hook can hold a turn for its whole timeout.
    if (m.subtype === 'hook_started' || m.subtype === 'hook_progress' || m.subtype === 'hook_response')
      return this.emit('hook', { phase: m.subtype.slice(5), event: m.hook_name || m.hook_event_name, hookId: m.hook_id, body: m });
    // The only two events a stream-json child emits while a tool is actually RUNNING.
    // Probed against a live child: between the tool_use block and its tool_result there
    // is task_started and then task_notification, and nothing else — no stdout, no
    // progress. Claude Code's own TUI can show a Bash command's output growing because
    // it runs the tool in-process; over stream-json that output does not exist until
    // the result lands. So this is what a client gets to show instead: the moment
    // execution really began (which is NOT when the tool_use block arrived — there were
    // three seconds between them in the probe) and a one-line description of it.
    if (m.subtype === 'task_started' || m.subtype === 'task_notification')
      return this.emit('tool_run', { toolUseId: m.tool_use_id || null, taskId: m.task_id || null,
        phase: m.subtype === 'task_started' ? 'started' : 'finished',
        description: m.description || m.summary || '', taskType: m.task_type || null,
        status: m.status || null, backgrounded: !!m.is_backgrounded });
    return this.emit('system', { subtype: m.subtype, body: m });
  }

  // Normalize an assistant/user message into the render-ready shape both clients
  // share. Two foldings happen here, both copied from what the VS Code webview
  // does rather than invented:
  //   • tool_result blocks are folded INTO the tool_use block they answer, so a
  //     tool call is one card with a status, not two disconnected messages.
  //   • parent_tool_use_id ≠ null means a subagent — kept, tagged, and left for
  //     the client to nest or collapse.
  onModelMessage(m, role) {
    const msg = m.message || {};
    const content = Array.isArray(msg.content) ? msg.content
      : (msg.content != null ? [{ type: 'text', text: String(msg.content) }] : []);

    // A user message that is only tool_results is not a turn — it's the answer to
    // tool calls already on screen. Fold and emit updates instead of a message.
    if (role === 'user' && content.length && content.every(b => b.type === 'tool_result')) {
      for (const b of content) {
        const blk = this.byToolUseId.get(b.tool_use_id);
        if (blk) {
          blk.status = b.is_error ? 'error' : 'done';
          blk.result = b.content;
          // tool_use_result on the wire, toolUseResult in the transcript file. Read
          // both or a seeded card loses the rich result the renderers key off.
          blk.resultMeta = m.tool_use_result || m.toolUseResult || null;
          this.emit('tool_end', { toolUseId: b.tool_use_id, name: blk.name, status: blk.status,
            result: blk.result, meta: blk.resultMeta, parentToolUseId: blk.parentToolUseId || null });
        }
      }
      return;
    }

    const entry = {
      id: m.uuid || uuid(), apiId: msg.id || null, role, ts: m.timestamp || nowIso(),
      model: msg.model || null,
      parentToolUseId: m.parent_tool_use_id || null,
      // is_meta is what the WIRE sends; isMeta is what the transcript file uses. Read
      // both or every synthetic message looks like an ordinary one.
      isMeta: !!(m.isMeta || m.is_meta), isSynthetic: !!m.isSynthetic,
      // Seeded from the transcript rather than from this run of the child. Clients
      // dim it, so "what was already here" is distinguishable from "what just
      // happened" without a second renderer.
      hist: !!this._seeding,
      by: null, blocks: [], command: null,
    };

    // A local command's result, in whichever carrier it arrived. Tagged, not rendered
    // as a turn: it is output, and the thing that produced it was a command.
    const text0 = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
    const cmd = parseCommand(m.local_command_source || '') ||
      (role === 'user' || entry.isMeta ? parseCommand(text0) : null);
    if (cmd) {
      // content is authoritative for the OUTPUT — the child unwraps it there already —
      // and the envelope only for whether it is stdout or stderr. Re-extracting the
      // text from the envelope would lose whatever the child chose to normalize.
      entry.command = cmd.kind === 'out'
        ? { kind: 'out', stream: cmd.stream, text: (m.local_command_source && text0) || cmd.text }
        : cmd;
      // Who ran it. The synthetic result is the only echo a slash command ever gets,
      // so this is also where its attribution entry is reclaimed.
      const i = this.attribution.findIndex(a => a.slash);
      if (i >= 0) {
        const a = this.attribution[i];
        entry.by = a.label;
        if (entry.command.kind === 'run' || !entry.command.name) {
          const mm = /^\/([^\s]*)\s*([\s\S]*)$/.exec(String(a.text || '').trim());
          if (mm) { entry.command.name = entry.command.name || mm[1]; entry.command.args = entry.command.args || mm[2]; }
        }
        this.attribution.splice(i, 1);
      }
    }
    // The replay of a turn we submitted: reattach who typed it. Matching on text
    // is enough — the child preserves content verbatim and submissions are FIFO.
    // A command's echo is not a turn somebody typed, and its attribution was already
    // claimed above — falling through here would shift a SECOND entry off the FIFO and
    // hand the next real turn the wrong name.
    if (role === 'user' && m.isReplay && !entry.command) {
      const i = this.attribution.findIndex(a => a.text != null && a.text === msg.content);
      if (i >= 0) { entry.by = this.attribution[i].label; this.attribution.splice(i, 1); }
      else if (this.attribution.length) entry.by = this.attribution.shift().label;
    }

    for (const b of content) {
      if (b.type === 'text') entry.blocks.push({ type: 'text', text: b.text });
      else if (b.type === 'thinking') entry.blocks.push({ type: 'thinking', text: b.thinking || b.text || '' });
      else if (b.type === 'image') entry.blocks.push({ type: 'image', source: b.source });
      else if (b.type === 'tool_use') {
        const blk = { type: 'tool_use', id: b.id, name: b.name, input: b.input, status: 'running', result: null,
          // Carried onto the block as well as the message: the clients dim a seeded turn
          // with ccbb's '.msg.hist .msg-body, .tool-card.hist', and the card is named on
          // its own there — a flag only on the wrapper leaves every card at full strength.
          hist: !!this._seeding,
          parentToolUseId: entry.parentToolUseId };
        this.byToolUseId.set(b.id, blk);
        entry.blocks.push(blk);
      } else entry.blocks.push({ type: b.type, raw: b });
    }

    // The streaming path already built this message block-by-block; replace it in
    // place so the final, authoritative copy wins over the accumulated deltas.
    const at = this.messages.findIndex(x => x.id === entry.id);
    if (at >= 0) this.messages[at] = entry; else this.messages.push(entry);
    // Roomy enough that a seeded history (HISTORY_SEED) plus a long live session do
    // not push each other out: the cap exists to bound memory, not to age turns out.
    if (this.messages.length > 8000) this.messages.splice(0, this.messages.length - 8000);

    this.flushDelta();
    this.emit('message', { message: entry, replaced: at >= 0 });
    for (const b of entry.blocks) if (b.type === 'tool_use') this.emit('tool_start', { toolUseId: b.id, name: b.name,
      input: b.input, messageId: entry.id, parentToolUseId: entry.parentToolUseId });
  }

  // Token deltas. Coalesced on a ~50ms timer rather than emitted per token — a
  // phone on cellular must not be able to make the session's reader loop wait on
  // it — but coalescing only within ONE (message, block, kind). A single buffer
  // for the whole session would merge a text block into the thinking block that
  // follows it inside the same window and emit one blob under whichever kind
  // happened to arrive last, with tool-input JSON mixed into the prose.
  //
  // The identity comes from message_start / content_block_start, NOT from the
  // stream_event's own uuid — that uuid identifies the event, not the message, so
  // a client keying on it could never match a delta to the final message that
  // supersedes it. `messageId` here is the API message id, echoed on the
  // normalized message as `apiId` so a renderer can suppress the text it already
  // streamed instead of printing it twice.
  flushDelta() {
    if (this._deltaTimer) { clearTimeout(this._deltaTimer); this._deltaTimer = null; }
    const text = this._deltaBuf; this._deltaBuf = ''; this._deltaKey = null;
    if (text) this.emit('delta', { ...this._deltaMeta, text });
  }

  onStreamEvent(m) {
    const e = m.event || {};
    if (e.type === 'message_start') {
      this.flushDelta();
      this.state.status = 'busy';
      this._streamMsgId = (e.message && e.message.id) || null;
      return this.emit('turn_start', { messageId: this._streamMsgId, parentToolUseId: m.parent_tool_use_id || null });
    }
    if (e.type === 'content_block_start') {
      this.flushDelta();
      const cb = e.content_block || {};
      if (cb.type === 'tool_use') this.emit('tool_pending', { name: cb.name, id: cb.id, messageId: this._streamMsgId });
      return;
    }
    if (e.type === 'content_block_stop' || e.type === 'message_stop') return this.flushDelta();
    if (e.type === 'content_block_delta' && e.delta) {
      const d = e.delta;
      const text = d.text || d.thinking || d.partial_json || '';
      if (!text) return;
      const deltaKind = d.type === 'thinking_delta' ? 'thinking'
        : d.type === 'input_json_delta' ? 'input' : 'text';
      const key = `${this._streamMsgId}|${e.index}|${deltaKind}`;
      if (this._deltaKey && this._deltaKey !== key) this.flushDelta();
      this._deltaKey = key;
      this._deltaMeta = { deltaKind, index: e.index, messageId: this._streamMsgId,
        parentToolUseId: m.parent_tool_use_id || null };
      this._deltaBuf = (this._deltaBuf || '') + text;
      if (!this._deltaTimer) this._deltaTimer = setTimeout(() => this.flushDelta(), DELTA_COALESCE_MS);
    }
  }
}

// ── Mux server ───────────────────────────────────────────────────────────────
// HTTP for the control surface (list / new / stop), WebSocket for attach. The
// mux→client protocol is ccbb's own, not a passthrough of the CLI's: when
// Anthropic adds a message type, one adapter above changes and neither renderer
// has to.
class Mux {
  constructor(opt) {
    this.sessions = new Map();
    this.opt = opt || {};
    this.token = common.peerToken ? common.peerToken() : null;
    // Optional: a mux with no UI file still serves its API and sockets.
    try { this.ui = require('./ccbb-mux-web').mount(this); } catch (e) { this.ui = null; }
  }

  // Shut every child down. ccbb web owns real `claude` processes now, where the
  // standalone daemon used to — and a daemon dying took its children with it only
  // because it was their parent and nothing else was left to reap them.
  async stopAll() {
    await Promise.all([...this.sessions.values()].map(s => s.stop(true).catch(() => {})));
  }

  // For the way out. process.on('exit') runs synchronously, so there is no awaiting a
  // graceful drain there — and a claude child left behind by its dying parent keeps a
  // session id, a socket and an API bill alive with nothing attached to it.
  killAll() {
    for (const s of this.sessions.values()) { try { if (s.child) s.child.kill('SIGKILL'); } catch {} }
  }

  // The host's "a row changed" hook. Set by ccbb web; absent everywhere else, which
  // is why every caller goes through here rather than testing for it.
  notifyChange() { if (this.onChange) { try { this.onChange(); } catch {} } }

  create(o) {
    o = o || {};
    // Resuming in place while the session is ALREADY running means two writers on one
    // transcript — the docs are explicit that the messages interleave. Forking is the
    // supported way to work from a live session, so say so rather than corrupt it.
    if (o.resume && !o.fork) {
      // Still in the map is not the same as still running — a stopped session stays
      // there so its transcript stays browsable, and refusing to resume THAT would
      // make the mux the one place you cannot pick a session back up.
      const held = this.sessions.get(o.resume);
      if (held && held.state.status !== 'exited') {
        const e = new Error('session ' + o.resume.slice(0, 8) + ' is already running in this mux — use --fork to branch it');
        // Two very different situations share the 409, and the caller acts on them
        // differently — the web UI OPENS the session it was told is already running,
        // and only reports the other. Carry a code for that, not prose to match on.
        e.code = 'EBUSY'; e.reason = 'running-in-mux'; throw e;
      }
      let live = false;
      try { live = !!common.sessionLiveness(o.resume).live; } catch {}
      if (live) {
        const e = new Error('session ' + o.resume.slice(0, 8) + ' is live in a terminal — resuming it here would interleave both into one transcript; use --fork to branch it');
        e.code = 'EBUSY'; e.reason = 'live-in-terminal'; throw e;
      }
    }
    o.label = this.uniqueLabel(o.label || path.basename(o.cwd || process.cwd()));
    const s = new Session(this, o);
    this.sessions.set(s.id, s);
    this.notifyChange();
    return s;
  }
  // Names are how a person addresses a session — `ccbb attach api-work` — so they have
  // to be unique or the address is ambiguous. Uniqueness is checked against LIVE
  // sessions only: an exited session stays in the map so its transcript stays
  // browsable, and counting those would ratchet the suffix up every time you restart
  // in the same directory (ccbb-mux, then -2, then -3, forever, with nothing running).
  uniqueLabel(want) {
    const taken = new Set([...this.sessions.values()]
      .filter(s => s.state.status !== 'exited').map(s => s.label));
    if (!taken.has(want)) return want;
    for (let n = 2; ; n++) if (!taken.has(`${want}-${n}`)) return `${want}-${n}`;
  }

  // Resolve a session the way a person names one: full id, name, or the short id
  // `ccbb ls` prints. Names beat short ids because a name is what the user chose, and
  // a live holder beats an exited one because "attach to foo" means the foo that is
  // running. There is deliberately NO name-prefix matching: an id prefix is
  // unambiguous by construction, but `ccbb stop foo` quietly hitting `foo-bar` is a
  // footgun with no undo.
  get(ref) {
    if (!ref) return null;
    if (this.sessions.has(ref)) return this.sessions.get(ref);
    const all = [...this.sessions.values()];
    const live = all.filter(s => s.state.status !== 'exited');
    const named = live.find(s => s.label === ref) || all.find(s => s.label === ref);
    if (named) return named;
    const hits = all.filter(s => s.id.startsWith(ref));
    return hits.length === 1 ? hits[0] : null;
  }
  list() {
    return [...this.sessions.values()].map(s => ({
      ...s.state, clients: s.clients.size, pending: s.pending.size, messages: s.messages.length,
    }));
  }

  // subUrl is the request path with the host's /mux prefix already stripped. Passed
  // rather than taken from req.url: mutating the request under the host would leave
  // every later handler — logging, error paths — seeing a URL that was never asked for.
  //
  // No auth check here. ccbb web owns the port and has already decided; a second gate
  // reading the same token would be one more thing to keep in step, and the failure it
  // invites is the quiet one where they disagree.
  onHttp(req, res, subUrl) {
    const send = (code, obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length });
      res.end(b);
    };
    const url = new URL(subUrl || req.url, 'http://x');
    const p = url.pathname;

    if (p === '/api/sessions' && req.method === 'GET') return send(200, { sessions: this.list() });
    if (p === '/api/sessions' && req.method === 'POST') {
      let body = '';
      req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
      return req.on('end', () => {
        let o = {}; try { o = JSON.parse(body || '{}'); } catch { return send(400, { error: 'bad json' }); }
        let s;
        try { s = this.create(o); }
        catch (e) { return send(e.code === 'EBUSY' ? 409 : 500, { error: e.message, reason: e.reason || null }); }
        send(200, { session: s.state });
      });
    }
    const mStop = /^\/api\/sessions\/([^/]+)\/stop$/.exec(p);
    if (mStop && req.method === 'POST') {
      const s = this.get(mStop[1]); if (!s) return send(404, { error: 'no such session' });
      s.stop(url.searchParams.get('force') === '1').then(() => {
        this.sessions.delete(s.id); send(200, { ok: true });
      });
      return;
    }
    const mGet = /^\/api\/sessions\/([^/]+)$/.exec(p);
    if (mGet && req.method === 'GET') {
      const s = this.get(mGet[1]); if (!s) return send(404, { error: 'no such session' });
      return send(200, s.snapshot());
    }
    if (p === '/api/health') return send(200, { ok: true, sessions: this.sessions.size, pid: process.pid });
    // The browser client. It is MOUNTED rather than given its own server so the
    // page, its assets and the WebSocket share one origin and one token — and so
    // that adding a second renderer costs the mux exactly this one delegation. It
    // runs last and only claims what /api did not, so it cannot shadow the API.
    if (this.ui && this.ui(req, res, p)) return;
    return send(404, { error: 'not found' });
  }

  // Same as onHttp: the host authenticated the upgrade before handing it over.
  onWs(ws, req) {
    const url = new URL(req.url, 'http://x');
    const client = {
      id: uuid(),
      label: url.searchParams.get('label') || 'anon',
      kind: url.searchParams.get('kind') || 'unknown',
      session: null,
      send: obj => { if (ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } },
    };
    ws.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      this.onClientOp(client, m);
    });
    ws.on('close', () => { if (client.session) client.session.detach(client); });
    // Attach eagerly when the URL names a session, so a client can be a one-liner.
    const want = url.searchParams.get('session');
    if (want) this.onClientOp(client, { op: 'attach', sessionId: want,
      sinceSeq: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined });
  }

  onClientOp(client, m) {
    const reply = (o) => client.send({ op: 'ack', id: m.id, ...o });
    if (m.op === 'attach') {
      const s = this.get(m.sessionId);
      if (!s) return reply({ error: 'no such session' });
      if (client.session) client.session.detach(client);
      if (m.label) client.label = m.label;
      if (m.kind) client.kind = m.kind;
      client.session = s;
      return s.attach(client, m.sinceSeq);
    }
    if (m.op === 'list') return reply({ sessions: this.list() });
    if (m.op === 'new') { const s = this.create(m.options || {}); return reply({ session: s.state }); }

    const s = client.session;
    if (!s) return reply({ error: 'not attached' });
    switch (m.op) {
      case 'submit':   return reply({ ok: s.submit(m.text, m.content, client.label) });
      case 'answer': {
        // One entry point for all three request kinds so a client never has to
        // know the CLI's response envelopes.
        const p = s.pending.get(m.requestId);
        if (!p) return reply({ error: 'unknown or already answered' });
        if (p.requestKind === 'question') return reply(s.answerQuestion(m.requestId, m.picks || {}, client.label));
        if (p.requestKind === 'permission') {
          const r = s.answerPermission(m.requestId, m.allow !== false, m, client.label);
          // Accepting a plan is two actions, not one — the VS Code plugin allows
          // the ExitPlanMode tool and THEN switches the session to acceptEdits.
          // Doing only the first leaves the next edit prompting again, which
          // reads as the accept not having taken.
          if (r.ok && m.planMode) s.setPermissionMode(m.planMode, client.label);
          return reply(r);
        }
        return reply(s.answerRequest(m.requestId, m.payload || { behavior: 'cancelled' }, client.label));
      }
      // The last client leaving BY CHOICE ends the session. Deliberately not wired to
      // the socket's close event: the web client reconnects, so a dropped socket empties
      // the client set for a moment, and stopping there would end a session over a
      // network blip or a page refresh. Only an explicit close says "I am done with
      // this" — and only then does an empty room mean nobody wants it. Reply first:
      // stop() drains the child and can take half a minute, and the client is leaving.
      case 'close': {
        s.detach(client);
        client.session = null;
        const last = s.clients.size === 0;
        reply({ ok: true, stopped: last });
        if (last) s.stop(false).then(() => { this.sessions.delete(s.id); this.notifyChange(); }, () => {});
        return;
      }
      case 'interrupt': s.interrupt(client.label); return reply({ ok: true });
      case 'set_mode':  s.setPermissionMode(m.mode, client.label); return reply({ ok: true });
      case 'set_model': s.setModel(m.model, client.label); return reply({ ok: true });
      case 'snapshot':  return client.send(s.snapshot());
      case 'ping':      return reply({ pong: true });
      default:          return reply({ error: 'unknown op ' + m.op });
    }
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function muxAddress() {
  try { return JSON.parse(fs.readFileSync(path.join(MUX_DIR, 'address'), 'utf8')); }
  catch { return null; }
}

async function api(pathname, method, body) {
  const a = muxAddress();
  if (!a) { console.error('ccbb: no mux running — start `ccbb web`'); process.exit(1); }
  const tok = common.peerToken ? common.peerToken() : null;
  const res = await fetch(`http://${a.host}:${a.port}${a.prefix || ''}${pathname}`, {
    method: method || 'GET',
    headers: { 'content-type': 'application/json', ...(tok ? { 'x-ccbb-token': tok } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(e => { console.error('ccbb: mux unreachable:', e.message); process.exit(1); });
  return res.json();
}

// The CLI's half of Mux.get: same rules, applied to the JSON list instead of the live
// map, because the CLI is a separate process reaching ccbb web over HTTP. The bare
// form — `ccbb attach` with no argument — resolves only when exactly one session is
// RUNNING. Counting exited ones would make "attach" fail with "several sessions" on a
// machine with one live session and three remembered ones, which reads as a bug.
function pickSession(list, ref) {
  const live = list.filter(s => s.status !== 'exited');
  if (!ref) {
    if (live.length === 1) return live[0];
    return { error: live.length
      ? `several sessions running — name one: ${live.map(s => s.label).join(', ')}`
      : 'no sessions running — start one with `ccbb new`' };
  }
  const byId = list.find(s => s.id === ref);
  if (byId) return byId;
  const named = live.find(s => s.label === ref) || list.find(s => s.label === ref);
  if (named) return named;
  const hits = list.filter(s => s.id.startsWith(ref));
  if (hits.length === 1) return hits[0];
  return { error: hits.length ? `'${ref}' matches ${hits.length} sessions` : `no session named '${ref}'` };
}

// Resolve a name/id/short-id against the running mux, or exit with the reason.
async function resolveRef(ref) {
  const r = await api('/api/sessions');
  const hit = pickSession(r.sessions || [], ref);
  if (hit.error) { console.error('ccbb:', hit.error); process.exit(1); }
  return hit;
}

// ── ccbb new / stop / ls --mux ───────────────────────────────────────────────
function newHelp() {
  console.log(`ccbb new — start a Claude Code session in the mux and attach a terminal to it

Usage: ccbb new [-n name] [-m model] [options]

Options:
  -n, --name <name>      name for the session (default: this directory's basename;
                         a -2, -3 … suffix is added if that name is already running)
  -m, --model <model>    model alias or full name
  -C, --cwd <dir>        working directory for the session (default: here)
  --permission-mode <m>  manual | auto | acceptEdits | plan | dontAsk | bypassPermissions
  --resume <id>          resume an existing Claude Code session, in place
  --fork                 with --resume, branch instead of continuing in place
  --effort <level>       low | medium | high | xhigh | max
  --add-dir <dir>        extra allowed directory (repeatable)
  --detach               create the session but do not attach a terminal

The session runs inside \`ccbb web\` — start that first. It shows up in the web UI as a
tab and in \`ccbb ls --mux\`; the terminal here is just one more attached client, so
closing it leaves the session running.`);
}

function parseNew(args) {
  const o = { cwd: process.cwd(), addDir: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-C' || a === '--cwd') o.cwd = path.resolve(args[++i]);
    else if (a === '-m' || a === '--model') o.model = args[++i];
    else if (a === '-n' || a === '--name' || a === '--label') o.label = args[++i];
    else if (a === '--permission-mode') o.permissionMode = args[++i];
    else if (a === '--resume') o.resume = args[++i];
    else if (a === '--fork') o.fork = true;
    else if (a === '--effort') o.effort = args[++i];
    else if (a === '--detach') o.detach = true;
    else if (a === '--add-dir') o.addDir.push(path.resolve(args[++i]));
  }
  return o;
}

async function runNew(args) {
  const o = parseNew(args);
  if (o.help) return newHelp();
  const detach = o.detach; delete o.detach;
  const r = await api('/api/sessions', 'POST', o);
  if (r.error) { console.error('ccbb:', r.error); process.exit(1); }
  if (detach) return console.log(`${r.session.label}  ${r.session.id}`);
  // The point of `new` is to start working, so it hands the terminal straight to the
  // session it just made. Same client `ccbb attach` runs — nothing about the session
  // knows which verb created it.
  return require('./ccbb-mux-tui').runAttach([r.session.id]);
}

async function runStop(args) {
  if (args[0] === '-h' || args[0] === '--help') {
    return console.log(`ccbb stop — end a mux session

Usage: ccbb stop [<name>|<id>] [--force]

With no name, stops the session if exactly one is running. --force skips the
interrupt-and-drain and closes the child's stdin immediately.`);
  }
  const force = args.includes('--force');
  const s = await resolveRef(args.find(a => !a.startsWith('-')));
  const r = await api(`/api/sessions/${encodeURIComponent(s.id)}/stop${force ? '?force=1' : ''}`, 'POST');
  if (r.error) { console.error('ccbb:', r.error); process.exit(1); }
  console.log(`stopped ${s.label}`);
}

// `ccbb ls --mux`. The disk listing has these sessions too — they write ordinary
// transcripts — but not the things that are only true of a running child: its status,
// how many clients are attached, and whether it is blocked on a request nobody has
// answered. Those are what this view is for.
async function runMuxLs() {
  const r = await api('/api/sessions');
  const list = r.sessions || [];
  if (!list.length) return console.log('No mux sessions. Start one with `ccbb new`.');
  const w = Math.max(4, ...list.map(s => (s.label || '').length));
  // cwd last and clipped to what's left: it is the only unbounded column, and a home
  // directory deep enough to wrap takes every column above it out of alignment.
  const left = w + 34;
  const room = Math.max(12, (process.stdout.columns || 80) - left);
  const clip = t => (t = String(t || '')).length <= room ? t : '…' + t.slice(t.length - room + 1);
  console.log(`${'NAME'.padEnd(w)}  ID        STATUS    CLI  ASK  MSGS  CWD`);
  for (const s of list) {
    console.log(`${String(s.label || '').padEnd(w)}  ${s.id.slice(0, 8)}  ` +
      `${String(s.status).padEnd(8)}  ${String(s.clients).padStart(3)}  ` +
      `${String(s.pending).padStart(3)}  ${String(s.messages).padStart(4)}  ${clip(s.cwd)}`);
  }
}

module.exports = { runNew, runStop, runMuxLs, resolveRef, pickSession, parseCommand, Mux, Session, buildArgs, answersToUpdatedInput, lineReader,
  muxAddress, MUX_DIR };
