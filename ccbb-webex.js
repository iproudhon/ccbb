#!/usr/bin/env node
'use strict';
// Webex front-end for a LIVE Claude Code session.
//
// Reads Claude Code's own data directly (via ccbb-common); no external service state.
//   • Display (Claude → Webex): tails the session JSONL (~/.claude/projects/.../ID.jsonl)
//     and mirrors each new entry — assistant text AND every tool call — to the attached
//     Webex space. Per-entry granularity: one request/response logged → one Webex update.
//   • Input (Webex → Claude): types your Webex message straight into the running
//     `claude` process by pasting it into that session's tmux pane (bracketed paste,
//     then Enter). No detached agent is spawned; the bot drives the session you're
//     already running.
//
// Requirement: the target `claude` session must be running inside a tmux pane on this host.
//
// Run:  ccbb webex   (reads token + allow-list from CLAUDE_DIR/ccbb-config.json)
//
// Commands (1:1 space: just type; group space: @mention the bot):
//   /list             list sessions (click a card to attach)
//   /attach <id>      attach this space to a running session (must be live in a tmux pane)
//   /detach           detach this space
//   /stop             send Esc to the session's pane (interrupt the running turn)
//   /compact          run Claude Code's /compact in the session
//   /help             show help
//   //name [args]     run a custom command (see .commands / //help)
//   <anything else>   pasted into the attached session's tmux pane as your prompt

// Node ≥21 exposes `globalThis.navigator` as a read-only getter; @webex/internal-media-core
// (pulled in transitively) assigns to it on load and crashes. Pre-define it writable.
Object.defineProperty(globalThis, 'navigator',
  { value: globalThis.navigator || { userAgent: 'node' }, writable: true, configurable: true });

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Session discovery, stats, pricing, tmux, transcript reading, permission parsing and the
// custom-command primitives are all shared via ccbb-common.js (one shape, one cache).
const common = require('./ccbb-common');
const {
  CONFIG_FILE, readConfig, findSessionJsonl, getSessionStats,
  listSessions, getSessionHistory, getSessionCwd,
  paneForSession, injectToPane, tmux, capturePane, parsePrompt, promptFingerprint,
  startTail, stopTail, loadCommands, expandRun, truncTitle, langForFile,
  awsIdText, awsLoginStream, priceForModel,
} = common;

const CONFIG = readConfig();
const TOKEN = CONFIG.token || null;
const ALLOW = new Set((Array.isArray(CONFIG.allow) ? CONFIG.allow : [])
  .map(e => String(e || '').trim().toLowerCase()).filter(Boolean));
// A person object's primary email, lowercased, or null.
function emailOf(person) {
  if (!person) return null;
  const e = (Array.isArray(person.emails) && person.emails[0]) || person.emailAddress || null;
  return e ? String(e).toLowerCase() : null;
}
function personEmail(trigger) { return emailOf(trigger && trigger.person); }
function isAllowed(email) { return !!email && ALLOW.has(email); }
const MAX_MSG = 7000;        // Webex hard limit is 7439 bytes; stay under it
const SYNC_TURNS = 6;        // how many recent transcript entries to replay on /attach

// Verbose diagnostics for the transcript pipeline. Enable with DEBUG=1 (or DEBUG_WEBEX=1)
// to trace every JSONL line read → whether it was emitted, deduped, or skipped.
const DEBUG = !!(process.env.DEBUG || process.env.DEBUG_WEBEX);
function dbg(...args) { if (DEBUG) console.log(...args); }

// ── Transport seam ──────────────────────────────────────────────────────────────
// All Webex I/O funnels through one injectable object so the whole app can run
// against either the real Webex service or a recording mock (see mock-webex.js).
//   say(spaceId, markdown)          → Promise<messageId|null>
//   sendCard(spaceId, card, text)   → Promise<messageId|null>   (text = fallback)
//   remove(messageId)               → Promise<void>
// The default is a no-op transport so importing this module never touches Webex.
const nullTransport = {
  say: () => Promise.resolve(null),
  sendCard: () => Promise.resolve(null),
  remove: () => Promise.resolve(),
};
let tx = nullTransport;
function setTransport(t) { tx = t || nullTransport; }

// ── Subscription registry (many Webex spaces → one Claude session) ──────────────
const spaceSession = new Map();   // spaceId  → sessionId
const sessionSpaces = new Map();  // sessionId → Set<spaceId>
const emitted = new Map();        // sessionId → Set<msg.id> already posted (assistant + user)
const sentByBot = new Map();      // sessionId → string[] of prompts injected FROM Webex (echo suppression)
const sessionCwd = new Map();     // sessionId → cwd for // commands (persisted across //cd)

function subscribe(spaceId, sessionId) {
  unsubscribe(spaceId); // a space attaches to at most one session
  spaceSession.set(spaceId, sessionId);
  if (!sessionSpaces.has(sessionId)) sessionSpaces.set(sessionId, new Set());
  sessionSpaces.get(sessionId).add(spaceId);
}
function unsubscribe(spaceId) {
  const sessionId = spaceSession.get(spaceId);
  if (!sessionId) return;
  spaceSession.delete(spaceId);
  const set = sessionSpaces.get(sessionId);
  if (set) {
    set.delete(spaceId);
    if (set.size === 0) {
      const buf = turnBuffers.get(sessionId);   // drop any half-buffered turn
      if (buf && buf.timer) clearTimeout(buf.timer);
      turnBuffers.delete(sessionId);
      sessionSpaces.delete(sessionId);
      emitted.delete(sessionId);
      sentByBot.delete(sessionId);
      sessionCwd.delete(sessionId);
      stopWatching(sessionId);
      stopPaneWatch(sessionId);
    }
  }
}

// tmux/pane location + keystroke injection now come from ccbb-common (paneForSession,
// injectToPane, tmux). Session discovery, stats and pricing are shared there too.
function prettyModel(m) {
  m = String(m || '');
  if (!m || m === 'unknown') return 'Unknown';
  const x = m.replace(/^claude-/, '').replace(/-\d{6,}$/, '');
  const parts = x.split('-');
  let name = parts.shift() || '';
  name = name.charAt(0).toUpperCase() + name.slice(1);
  const ver = parts.join('.');
  return ver ? name + ' ' + ver : name;
}

function fmtTok(n) {
  n = n || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}
function fmtPct(part, whole) {
  if (!whole) return '0%';
  return (100 * part / whole).toFixed(1) + '%';
}

// Markdown for //usage — the session-page header, one Webex message:
//   <title>
//   <turns> (+<sub>) turns · $<cost> (models) · <totalTok>
//   cr <tok> <%>  cw <tok> <%>  cm <tok> <%>  out <tok> <%>  in <tok> <%>
//   ctx <tok> / $<cost>
// Each category's % is its share of total USD; cache-miss is an overlay (already in
// the total), shown only to reveal how much spend was wasted cache re-writes.
function usageText(sessionId) {
  const st = getSessionStats(sessionId);
  const title = st.title || `(untitled — ${sessionId.slice(0, 8)})`;
  if (!st.hasUsage) return `**${title}**\n_No usage recorded yet._`;
  const c = st.categories, tot = st.cost || 0;
  const cat = (label, k) => { const x = c[k] || { tokens: 0, cost: 0 }; return `${label} ${fmtTok(x.tokens)} _${fmtPct(x.cost, tot)}_`; };
  const models = (st.models || []).filter(m => m.cost >= 0.005);
  const modelStr = models.length ? ' (' + models.map(m => `${prettyModel(m.model)}: ${fmtCost(m.cost)}`).join(' · ') + ')' : '';
  const subStr = st.subTurns > 0 ? ` +${st.subTurns}` : '';
  const ctxStr = st.context ? `\nctx ${fmtTok(st.context.tokens)} / ${fmtCost(st.context.cost)}` : '';
  return `**${title}**\n` +
    `**${st.turns}**${subStr} turn${st.turns === 1 ? '' : 's'} · **${fmtCost(st.cost)}**${modelStr} · **${fmtTok(st.totalTokens)}** tok\n` +
    `${cat('cr', 'cacheRead')}  ${cat('cw', 'cacheWrite')}  ${cat('cm', 'cacheMiss')}  ${cat('out', 'output')}  ${cat('in', 'input')}` +
    ctxStr;
}

// listSessions, getSessionCwd and getSessionHistory now come from ccbb-common. The live
// transcript tailer is common's startTail/stopTail; we adapt its raw-line callback to the
// { role, message, uuid } entries this bridge's emit path expects.
function startWatching(sessionId, onEntry) {
  startTail(sessionId, d => {
    if ((d.type === 'user' || d.type === 'assistant') && d.message && d.isSidechain !== true) {
      onEntry({ role: d.message.role, message: d.message, uuid: d.uuid });
    }
  });
}
function stopWatching(sessionId) { stopTail(sessionId); }

// ── Custom "//" commands (webex-flavored: markdown help, shared primitives) ────
function commandsHelp(commands) {
  const lines = ['**Custom commands** — type `//name [args]`:', ''];
  for (const name of Object.keys(commands).sort()) {
    const spec = commands[name] || {};
    const what = spec.builtin ? `_(built-in ${spec.builtin})_` : '`' + (spec.run || '') + '`';
    lines.push(`- **//${name}** — ${what}`);
  }
  return lines.join('\n');
}

// ── AWS SSO helpers ────────────────────────────────────────────────────────────
// awsIdText / awsLoginStream come from ccbb-common; this bridge only adds the Webex
// streaming wrapper below.
const awsLogins = new Map();   // sessionId → running `aws sso login` child

// Stream an AWS SSO login to a Webex space: post the URL/code as they print, then a
// final logged-in/failed message. Returns immediately.
function awsLoginToWebex(spaceId, sessionId, cli, profile) {
  if (awsLogins.has(sessionId)) return sayToSpace(spaceId, '_AWS login already in progress…_');
  sayToSpace(spaceId, '🔐 _Starting AWS SSO login…_');
  let buf = '', timer = null;
  const flush = () => { timer = null; const t = buf.trim(); buf = ''; if (t) sayToSpace(spaceId, `\`\`\`\n${truncate(t, 3000)}\n\`\`\``); };
  const child = awsLoginStream(
    cli, profile,
    chunk => { buf += chunk; if (!timer) timer = setTimeout(flush, 400); },   // debounce chunks into one post
    (ok) => {
      awsLogins.delete(sessionId);
      if (timer) { clearTimeout(timer); flush(); }
      sayToSpace(spaceId, ok ? `✅ **Logged in.**\n\`\`\`\n${truncate(awsIdText(cli, profile), 3000)}\n\`\`\`` : '❌ **AWS login failed.**');
    });
  awsLogins.set(sessionId, child);
  return Promise.resolve();
}

// Run a "//" command for a session; returns markdown to post to Webex.
function runCommand(sessionId, name, args) {
  const commands = loadCommands();
  const spec = commands[name];
  if (!spec) return `⚠️ Unknown command: \`//${name}\`. Try \`//help\``;
  const baseCwd = sessionCwd.get(sessionId) || getSessionCwd(sessionId) || process.cwd();

  if (spec.builtin === 'help')  return commandsHelp(commands);
  if (spec.builtin === 'pwd')   return '`' + baseCwd + '`';
  if (spec.builtin === 'clear') return '_(nothing to clear here)_';
  if (spec.builtin === 'usage') return sessionId
    ? usageText(sessionId)
    : '_Not attached — `/attach ID` first, or `/list`._';
  if (spec.builtin === 'aws-id') return '```\n' + awsIdText(spec.cli || 'aws', spec.profile) + '\n```';
  // aws-login streams; it is handled in onText before reaching here.
  if (spec.builtin === 'aws-login') return '_Run `//aws-login` directly to start the device-code flow._';
  if (spec.builtin === 'cd') {
    const target = args.trim() || os.homedir();
    const next = path.resolve(baseCwd, target);
    let ok = false;
    try { ok = fs.statSync(next).isDirectory(); } catch {}
    if (!ok) return `⚠️ cd: no such directory: \`${target}\``;
    sessionCwd.set(sessionId, next);
    return '📁 `' + next + '`';
  }

  let cmd, srcName = '';
  if (spec.builtin === 'sh') {
    if (!args.trim()) return 'Usage: `//sh <shell-script>`';
    cmd = args;  // raw script, no substitution
  } else {
    cmd = expandRun(spec.run || '', args);
    if ((spec.kind || 'console') === 'source') srcName = args.trim().split(/\s+/).pop() || '';
  }
  const r = spawnSync('bash', ['-lc', cmd], { cwd: baseCwd, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const out = ((r.stdout || '') + (r.stderr ? (r.stdout ? '\n' : '') + r.stderr : '')).replace(/\s+$/, '') || '(no output)';
  const title = `//${name}${args.trim() ? ' ' + truncTitle(args) : ''}`;
  const lang = srcName ? langForFile(srcName) : '';
  return `**${title}**\n\`\`\`${lang}\n${truncate(out, 5500)}\n\`\`\``;
}

// ── Permission prompt mirroring (scrape the pane's TUI) ─────────────────────────
// The permission dialog is drawn only in the terminal — it never reaches the JSONL.
// While a space is attached we poll the pane (capture-pane), detect the box, mirror
// it to Webex as a card, and inject the chosen option back into the pane. Detection
// keys on Claude Code's prompt strings; a version bump that rewords them needs these
// patterns re-tuned (see ccbb-common: PROMPT_RE/OPTION_RE/parsePrompt/promptFingerprint).
const activePrompts = new Map();  // sessionId → { fp, title, options:[{n,label}], pane }

// A permission box needs several rows to render; Claude's TUI draws nothing extra
// when the pane is collapsed (e.g. 80x1 next to a tall neighbor). Below this height
// we can't scrape a prompt from a plain capture.
const MIN_PROMPT_ROWS = 8;
const GROW_ROWS = 24;      // transient height that always fits a permission box

function paneHeight(pane) {
  const h = Number(tmux(['display', '-t', pane, '-p', '#{pane_height}']));
  return Number.isFinite(h) ? h : 0;
}

// Block the event loop for ms — used to let the TUI finish redrawing after a resize
// (SIGWINCH → repaint is async). Kept tiny so it never noticeably stalls the bot.
function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

// Run `fn` with the pane guaranteed tall enough to render a permission box. If it's
// already tall, just run fn. Otherwise transiently grow it, wait for the repaint,
// run fn, then restore the window's exact layout — the terminal flickers for a frame
// but ends up exactly as it was. Claude's TUI only draws (and accepts selection input
// for) the permission menu when the pane has height, so both scraping the box and
// injecting the answer must happen while grown.
function withPromptHeight(pane, fn) {
  if (paneHeight(pane) >= MIN_PROMPT_ROWS) return fn();
  let layout = null, win = null;
  try {
    win = tmux(['display', '-t', pane, '-p', '#{window_id}']);
    layout = tmux(['display', '-t', pane, '-p', '#{window_layout}']);
    tmux(['resize-pane', '-t', pane, '-y', String(GROW_ROWS)]);
    sleepSync(450);                       // give Claude's TUI time to redraw the box
    return fn();
  } catch (e) {
    dbg(`[perm] withPromptHeight failed: ${e.message}`);
    return fn();
  } finally {
    if (win && layout) { try { tmux(['select-layout', '-t', win, layout]); } catch {} }
  }
}

function captureForPrompt(pane) {
  return withPromptHeight(pane, () => capturePane(pane));
}

// Poll-based prompt detection. A permission box appears exactly when the pane STOPS
// producing output, so an edge-triggered watch (fs.watch on a pipe-pane log) is the
// wrong tool — its one debounced check races the half-drawn box and then never
// retries, so the card is missed (and unrelated output causes duplicate posts). A
// steady poll reliably catches a settled prompt; checkPrompt is idempotent
// (fingerprint dedup), so re-checking the same box is a no-op.
const paneWatchers = new Map();  // sessionId → { pane, timer }
const POLL_MS = 600;

// Last fingerprint each poll observed, to gate on stability (below).
const lastSeenFp = new Map();  // sessionId → fingerprint string | null

// Inspect the pane now: mirror a new box, or clear a vanished one.
function checkPrompt(sessionId, pane) {
  // A permission prompt is only present when the pane sits idle waiting for input,
  // so a cheap plain capture usually decides it. Only pay the grow-and-restore cost
  // (captureForPrompt) when the pane is too short to render a box AND its tail hints
  // that a prompt may be there.
  let text = capturePane(pane);
  if (!PROMPT_RE.test(text) && paneHeight(pane) < MIN_PROMPT_ROWS) {
    text = captureForPrompt(pane);   // collapsed pane: grow, capture, restore
  }
  const parsed = parsePrompt(text);
  const prev = activePrompts.get(sessionId);
  const fp = parsed ? promptFingerprint(parsed) : null;

  // Stability gate: the TUI draws the box over a few frames, so an in-progress draw
  // yields a transient, partial fingerprint. Only act once the SAME fingerprint has
  // been seen on two consecutive polls — partial frames never survive that.
  const stable = fp !== null && fp === lastSeenFp.get(sessionId);
  lastSeenFp.set(sessionId, fp);

  if (!parsed) {                        // box gone (answered here or at the terminal)
    if (prev) { clearPromptMessages(sessionId, prev, '✔️ Answered.'); activePrompts.delete(sessionId); }
    return;
  }
  if (prev && prev.fp === fp) return;   // already mirrored this exact box
  if (!stable) return;                  // wait for one more poll to confirm the box
  if (prev) clearPromptMessages(sessionId, prev);   // a different, now-stable box replaced the old one
  const rec = { fp, title: parsed.title, options: parsed.options, pane, msgIds: [] };
  activePrompts.set(sessionId, rec);
  sendPermissionCard(sessionId, parsed, rec);
}

// Delete the card + waiting message for a prompt; optionally post a short closing note.
function clearPromptMessages(sessionId, rec, note) {
  for (const id of rec.msgIds || []) tx.remove(id).catch(() => {});
  rec.msgIds = [];
  if (note) sayToSession(sessionId, note);
}

function startPaneWatch(sessionId, pane) {
  const existing = paneWatchers.get(sessionId);
  if (existing) { if (existing.pane === pane) return; stopPaneWatch(sessionId); }  // re-target if pane changed
  const rec = { pane, timer: null };
  rec.timer = setInterval(() => {
    try { checkPrompt(sessionId, pane); } catch (e) { console.error('[perm] check:', e.message); }
  }, POLL_MS);
  paneWatchers.set(sessionId, rec);
  checkPrompt(sessionId, pane);   // catch a prompt already on screen at attach time
  console.log(`[perm] polling pane ${pane} for ${sessionId.slice(0,8)}`);
}

function stopPaneWatch(sessionId) {
  const rec = paneWatchers.get(sessionId);
  if (!rec) return;
  paneWatchers.delete(sessionId);
  if (rec.timer) clearInterval(rec.timer);
  activePrompts.delete(sessionId);
  lastSeenFp.delete(sessionId);
}

// Render the prompt as an Adaptive Card (button per option + typed 1/2/3), then a
// "waiting" line. Both message ids are recorded on rec so they can be cleared once
// the prompt is answered.
function sendPermissionCard(sessionId, parsed, rec) {
  console.log(`[perm] ${sessionId.slice(0,8)} prompt: ${parsed.title}`);
  flushNow(sessionId);   // land the tool call/context above the permission card
  const actions = parsed.options.map(o => ({
    type: 'Action.Submit',
    title: `${o.n}. ${truncate(o.label, 60)}`,
    data: { action: 'perm', choice: o.n, sessionId },
  }));
  const card = {
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    type: 'AdaptiveCard',
    version: '1.2',
    body: [
      { type: 'TextBlock', text: '🔐 Permission needed', weight: 'Bolder', size: 'Medium' },
      { type: 'TextBlock', text: parsed.title, wrap: true },
    ],
    actions,
  };
  const fallback = `🔐 **${parsed.title}**\n` +
    parsed.options.map(o => `${o.n}. ${o.label}`).join('\n') +
    `\n\n_Tap a button or reply with the number._`;
  const track = id => { if (rec && id) rec.msgIds.push(id); };
  for (const spaceId of spacesFor(sessionId)) {
    tx.sendCard(spaceId, card, fallback)
      .then(track, () => {})
      .then(() => sayToSpace(spaceId, '⌛ _waiting for your answer…_').then(track, () => {}));
  }
}

// Answer the currently-open prompt for a session by injecting the option number.
// Returns true if a prompt was open and the choice was valid.
function answerPrompt(sessionId, choice) {
  const p = activePrompts.get(sessionId);
  if (!p) return false;
  if (!p.options.some(o => o.n === choice)) return false;
  try {
    withPromptHeight(p.pane, () => {
      tmux(['send-keys', '-t', p.pane, String(choice)]);
      tmux(['send-keys', '-t', p.pane, 'Enter']);
      sleepSync(150);                     // let the keystrokes register before we restore
    });
  } catch (e) { console.error('[perm] inject failed:', e.message); return false; }
  clearPromptMessages(sessionId, p);   // drop the card/waiting msg; the box will vanish too
  activePrompts.delete(sessionId);
  return true;
}

// ── Fan-out to all spaces attached to a session ─────────────────────────────────
function spacesFor(sessionId) { return [...(sessionSpaces.get(sessionId) || [])]; }

let saySeq = 0;
// Post markdown to one space; returns Promise<messageId|null> so callers that need
// to later delete the message (permission cards) can track its id.
function sayToSpace(spaceId, markdown) {
  const n = ++saySeq;
  dbg(`[say#${n}] → ${spaceId.slice(-6)} (${markdown.length}B): ${truncate(markdown.replace(/\n/g,' '), 80)}`);
  return tx.say(spaceId, truncate(markdown))
    .then(id => { dbg(`[say#${n}] ok id=${id}`); return id; })
    .catch(e => { console.error(`[say#${n}] failed:`, e.message); return null; });
}
function sayToSession(sessionId, markdown) {
  const spaces = spacesFor(sessionId);
  if (!spaces.length) console.warn(`[bridge] ${sessionId.slice(0,8)}: no spaces attached, dropping update`);
  for (const spaceId of spaces) sayToSpace(spaceId, markdown);
}
function cardToSession(sessionId, card, fallback) {
  const spaces = spacesFor(sessionId);
  if (!spaces.length) console.warn(`[bridge] ${sessionId.slice(0,8)}: no spaces attached, dropping card`);
  for (const spaceId of spaces) {
    tx.sendCard(spaceId, card, fallback).catch(e => console.error('[card] failed:', e.message));
  }
}

// ── Turn coalescing ─────────────────────────────────────────────────────────────
// A single Claude turn arrives as several JSONL lines (text, then tool_use, then
// tool_result on the next user line, …). Rather than post one Webex message per
// piece, buffer the pieces and flush them as ONE card after a short quiet gap. A
// max-hold guards long turns so they still stream periodically instead of going
// silent. A pure-text turn (no tool activity) flushes as a plain message, not a card.
const COALESCE_MS = 500;      // quiet gap before flushing a buffered turn
const COALESCE_MAX_MS = 4000; // force a flush at least this often during a long turn
const turnBuffers = new Map();  // sessionId → { sections:[{header,content,mono}], timer, firstAt }

function bufferSection(sessionId, section) {
  if (!spacesFor(sessionId).length) return;   // nobody attached
  let buf = turnBuffers.get(sessionId);
  if (!buf) { buf = { sections: [], timer: null, firstAt: Date.now() }; turnBuffers.set(sessionId, buf); }
  buf.sections.push(section);
  scheduleFlush(sessionId);
}

function scheduleFlush(sessionId) {
  const buf = turnBuffers.get(sessionId);
  if (!buf) return;
  if (buf.timer) clearTimeout(buf.timer);
  const held = Date.now() - buf.firstAt;
  const wait = Math.max(0, Math.min(COALESCE_MS, COALESCE_MAX_MS - held));
  buf.timer = setTimeout(() => flushTurn(sessionId), wait);
}

function flushTurn(sessionId) {
  const buf = turnBuffers.get(sessionId);
  if (!buf) return;
  if (buf.timer) clearTimeout(buf.timer);
  turnBuffers.delete(sessionId);
  const sections = buf.sections;
  if (!sections.length) return;
  // Pure-text turn (single non-mono section, no header): keep it a plain message.
  if (sections.length === 1 && !sections[0].mono && !sections[0].header) {
    sayToSession(sessionId, sections[0].content);
    return;
  }
  const { card, fallback } = buildSectionsCard(sections);
  cardToSession(sessionId, card, fallback);
}

// Flush any pending buffer immediately (e.g. before posting a permission card so the
// turn's content lands above it, or on detach).
function flushNow(sessionId) {
  if (turnBuffers.has(sessionId)) flushTurn(sessionId);
}

const PREVIEW_LINES = 3;

// Build ONE Adaptive Card from an ordered list of sections, so a whole turn's worth
// of pieces (assistant text, tool calls, tool results) lands as a single Webex
// message instead of many. Each section is { header?, content, mono? }; long content
// shows PREVIEW_LINES then a per-section client-side expand toggle
// (Action.ToggleVisibility — no server round-trip). Returns { card, fallback }.
function buildSectionsCard(sections) {
  const body = [];
  const actions = [];
  const fallbackParts = [];
  sections.forEach((s, i) => {
    if (s.header) body.push({ type: 'TextBlock', text: s.header, weight: 'Bolder', wrap: true, spacing: i ? 'Medium' : 'Default' });
    const lines = String(s.content == null ? '' : s.content).replace(/\s+$/, '').split('\n');
    const preview = lines.slice(0, PREVIEW_LINES).join('\n') || '(empty)';
    const rest = lines.slice(PREVIEW_LINES);
    const font = s.mono ? 'Monospace' : 'Default';
    body.push({ type: 'TextBlock', id: `prev${i}`, text: preview, wrap: true, fontType: font, spacing: s.header ? 'None' : (i ? 'Medium' : 'Default') });
    if (rest.length) {
      body.push({ type: 'TextBlock', id: `full${i}`, text: lines.join('\n'), wrap: true, fontType: font, isVisible: false, spacing: 'None' });
      const what = (s.header || 'text').replace(/^[^\w]+/, '').trim() || 'more';
      actions.push({ type: 'Action.ToggleVisibility', title: `⤢ ${what}: ${rest.length} more line${rest.length === 1 ? '' : 's'}`, targetElements: [`prev${i}`, `full${i}`] });
    }
    const more = rest.length ? `\n_…(+${rest.length} more line${rest.length === 1 ? '' : 's'}; tap to expand)_` : '';
    if (s.mono) fallbackParts.push(`${s.header ? s.header + '\n' : ''}\`\`\`\n${truncate(preview, 1200)}\n\`\`\`${more}`);
    else        fallbackParts.push(`${s.header ? '**' + s.header + '**\n' : ''}${truncate(preview, 1200)}${more}`);
  });
  const card = { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.2', body, actions };
  return { card, fallback: fallbackParts.join('\n\n') };
}

// A single-section card (used where one block is emitted on its own).
function collapsibleCard(header, content) {
  return buildSectionsCard([{ header, content, mono: true }]);
}

function truncate(s, n = MAX_MSG) {
  s = String(s == null ? '' : s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function blocksText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(b => b.type === 'text').map(b => b.text).join('');
}

// ── Local JSONL tailer → Webex ───────────────────────────────────────────────
// One new transcript entry (a single request/response logged to the session JSONL)
// → one Webex update. Wired on /attach via startWatching.
function ensureBridge(sessionId) {
  if (!emitted.has(sessionId)) emitted.set(sessionId, new Set());
  startWatching(sessionId, entry => handleTranscript(sessionId, entry));
}

function handleTranscript(sessionId, entry) {
  if (!entry || !entry.message) return;
  if (entry.role === 'assistant') emitAssistant(sessionId, entry.message, entry.uuid);
  else if (entry.role === 'user') emitUserPrompt(sessionId, entry.message, entry.uuid);
  // Any new content pushes an open permission card back to the bottom (ccbb.js repin).
  repinPrompt(sessionId);
}

// Per-LINE dedup key: the JSONL uuid is unique per physical line, so it never
// collapses the multiple lines Claude Code writes for one turn (e.g. a thinking
// line then a text line share one msg.id but have distinct uuids). Fall back to
// msg.id only when a line somehow lacks a uuid.
function dedupKey(msg, uuid) { return uuid || (msg && msg.id) || null; }

// Re-post the open permission card below the latest content so it stays at the bottom.
function repinPrompt(sessionId) {
  const rec = activePrompts.get(sessionId);
  if (!rec) return;
  clearPromptMessages(sessionId, rec);   // remove the old card/waiting msg
  sendPermissionCard(sessionId, { title: rec.title, options: rec.options }, rec);
}

// Mirror a user turn. A role-'user' entry is either a real prompt OR tool results
// (the output of the tools Claude just ran) — we now show both. Prompts the bot itself
// injected are suppressed so they don't echo back to the sender.
function emitUserPrompt(sessionId, msg, uuid) {
  const content = msg.content;
  const seen = emitted.get(sessionId);
  const key = dedupKey(msg, uuid);
  if (Array.isArray(content) && content.some(b => b.type === 'tool_result')) {
    if (seen && key) { if (seen.has(key)) { dbg(`[emit] ${sessionId.slice(0,8)} DUP tool_result key=${key}`); return; } seen.add(key); }
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const out = toolResultText(b.content).trim();
      const head = b.is_error ? '⚠️ tool error' : '📤 result';
      dbg(`[emit] ${sessionId.slice(0,8)} POST tool_result key=${key} len=${out.length}`);
      bufferSection(sessionId, { header: head, content: out || '(no output)', mono: true });
    }
    return;
  }
  const text = blocksText(content).trim();
  if (!text) { dbg(`[emit] ${sessionId.slice(0,8)} skip user (no text) key=${key}`); return; }
  if (consumeSent(sessionId, text)) { dbg(`[emit] ${sessionId.slice(0,8)} suppress echo key=${key}`); return; }
  if (seen && key) { if (seen.has(key)) { dbg(`[emit] ${sessionId.slice(0,8)} DUP user key=${key}`); return; } seen.add(key); }
  dbg(`[emit] ${sessionId.slice(0,8)} POST user key=${key} len=${text.length}`);
  flushNow(sessionId);   // close any prior turn's card before the new prompt
  sayToSession(sessionId, `🧑 **${text}**`);
}

// tool_result.content is a string or an array of text/content blocks.
function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map(b => {
    if (typeof b === 'string') return b;
    if (b && b.type === 'text') return b.text;
    if (b && b.type === 'image') return '[image]';
    return b && b.text ? b.text : '';
  }).join('');
}

// Echo-suppression: remember prompts the bot injected, so the transcript entry they
// produce isn't mirrored back out as if it were typed at the terminal.
function recordSent(sessionId, text) {
  if (!sentByBot.has(sessionId)) sentByBot.set(sessionId, []);
  sentByBot.get(sessionId).push((text || '').trim());
}
function consumeSent(sessionId, text) {
  const arr = sentByBot.get(sessionId);
  if (!arr) return false;
  const i = arr.indexOf((text || '').trim());
  if (i === -1) return false;
  arr.splice(i, 1);
  return true;
}

// Post an assistant message: its text AND every tool call. Deduped per physical line
// (uuid) so the multiple lines of one turn each get mirrored. Thinking blocks are
// internal and never shown; token/USD usage is intentionally not mirrored.
function emitAssistant(sessionId, msg, uuid) {
  if (!msg) return;
  const seen = emitted.get(sessionId);
  const key = dedupKey(msg, uuid);
  if (seen && key) { if (seen.has(key)) { dbg(`[emit] ${sessionId.slice(0,8)} DUP assistant key=${key}`); return; } seen.add(key); }

  const text = blocksText(msg.content).trim();
  const tools = (msg.content || []).filter(b => b.type === 'tool_use').map(b => b.name);
  dbg(`[emit] ${sessionId.slice(0,8)} POST assistant key=${key} textLen=${text.length} tools=[${tools.join(',')}]`);
  if (text) bufferSection(sessionId, { content: text, mono: false });

  for (const b of msg.content || []) {
    if (b.type === 'tool_use') emitToolCall(sessionId, b);
  }
}

// Buffer one tool call: header names the tool, body is its key arg (command/path/…).
function emitToolCall(sessionId, b) {
  const name = b.name || 'tool';
  const arg = toolCallArg(name, b.input || {});
  bufferSection(sessionId, { header: `🔧 ${name}`, content: arg, mono: true });
}

// The one argument worth showing for a tool call: the command, path, pattern, etc.
// Falls back to pretty-printed JSON of the whole input for unknown tools.
function toolCallArg(name, inp) {
  switch (name) {
    case 'Bash':        return inp.command || '';
    case 'Read':        return inp.file_path || '';
    case 'Write':       return inp.file_path || '';
    case 'Edit':        return inp.file_path || '';
    case 'Glob':        return inp.pattern || '';
    case 'Grep':        return inp.pattern + (inp.path ? '\nin ' + inp.path : '');
    case 'TodoWrite':   return '(updated task list)';
    case 'WebFetch':    return inp.url || '';
    case 'WebSearch':   return inp.query || '';
    default:            return JSON.stringify(inp, null, 2);
  }
}

// Reduce a transcript entry to a one-line sync summary, or null if it has nothing
// worth showing (a thinking-only line, an empty user echo). Tool calls and tool
// results are summarized rather than dumped.
function summarizeEntry(e) {
  const content = e.message && e.message.content;
  const arr = Array.isArray(content) ? content : [];
  if (e.role === 'user') {
    if (arr.some(b => b.type === 'tool_result')) {
      const err = arr.some(b => b.type === 'tool_result' && b.is_error);
      return `**📤 result:** ${err ? '_(tool error)_' : '_(tool output)_'}`;
    }
    const text = blocksText(content).trim();
    return text ? `**🧑 You:** ${truncate(text.replace(/\n+/g, ' '), 300)}` : null;
  }
  // assistant
  const text = blocksText(content).trim();
  if (text) return `**🤖 Claude:** ${truncate(text.replace(/\n+/g, ' '), 300)}`;
  const tools = arr.filter(b => b.type === 'tool_use').map(b => b.name);
  if (tools.length) return `**🤖 Claude:** _used ${tools.join(', ')}_`;
  return null;   // thinking-only or otherwise empty
}

// ── Sync on attach: replay recent transcript ────────────────────────────────────
async function syncHistory(spaceId, sessionId) {
  const history = getSessionHistory(sessionId);
  if (!history.length) { await sayToSpace(spaceId, '_(no history yet — send a message to begin)_'); return; }
  const lines = [];
  for (let i = history.length - 1; i >= 0 && lines.length < SYNC_TURNS; i--) {
    const s = summarizeEntry(history[i]);
    if (s) lines.unshift(s);
  }
  if (!lines.length) { await sayToSpace(spaceId, `_Attached to \`${sessionId.slice(0, 8)}\` — no readable history yet._`); return; }
  await sayToSpace(spaceId, `**↩︎ Recent activity in \`${sessionId.slice(0, 8)}\`:**\n\n` + lines.join('\n\n'));
}

// ── Command + message handling ───────────────────────────────────────────────────
const HELP = [
  '**ccbb ⇄ Webex** — drive a live Claude Code session',
  '`/list` — list sessions (tap a card to attach)',
  '`/attach ID` — attach this space to a running session (must be live in a tmux pane)',
  '`/detach` — detach this space',
  '`/stop` — interrupt the running turn (sends Esc)',
  '`/compact` — compact the session context (runs Claude Code `/compact`)',
  '`//name [args]` — run a custom command (`//help` lists them)',
  '`/help` — this help',
  '',
  'Anything else you type is pasted into the attached session and submitted.',
  'When Claude asks permission, tap a button on the card or reply with the option number.',
].join('\n');

function fmtCost(v) { return v != null ? '$' + Number(v).toFixed(2) : '$0.00'; }

// Attach a space to a running session: wire the tailer, pane watcher, and sync history.
async function attachSession(spaceId, id) {
  const loc = paneForSession(id);
  if (!loc) { await sayToSpace(spaceId, `⚠️ \`${id.slice(0,8)}\` isn't running in a tmux pane on this host. Start it in tmux, then attach.`); return; }
  subscribe(spaceId, id);
  ensureBridge(id);
  startPaneWatch(id, loc.pane);
  await sayToSpace(spaceId, `🔗 Attached to \`${id.slice(0, 8)}\` (pane \`${loc.pane}\`).`);
  return syncHistory(spaceId, id).catch(() => {});
}

// Render the /list session picker as an Adaptive Card (+ markdown fallback).
function listCard() {
  const sessions = listSessions().slice(0, 20);
  if (!sessions.length) return null;
  const body = [{ type: 'TextBlock', text: '🟢 = running (tap to attach)', wrap: true, isSubtle: true, size: 'Small' }];
  const actions = [];
  for (const s of sessions) {
    const title = truncate(s.title || '(untitled)', 50);
    const live = paneForSession(s.sessionId);
    const meta = `${s.sessionId.slice(0, 8)} · ${fmtCost(s.cost)}`;
    body.push({ type: 'TextBlock', text: `${live ? '🟢 ' : ''}**${title}**`, wrap: true });
    body.push({ type: 'TextBlock', text: meta, wrap: true, isSubtle: true, size: 'Small', spacing: 'None' });
    if (live) actions.push({ type: 'Action.Submit', title: `Attach ${title}`, data: { action: 'attach', sessionId: s.sessionId } });
  }
  const card = { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.2', body, actions };
  const fallback = sessions.map(s => `• **${truncate(s.title || '(untitled)', 50)}**${paneForSession(s.sessionId) ? ' 🟢' : ''}\n  \`${s.sessionId}\` · ${fmtCost(s.cost)}`).join('\n');
  return { card, fallback };
}

// The one entry point: a text message arrived in `spaceId`. All output goes through
// the transport (tx / sayToSpace), so this runs identically under real Webex or mock.
async function onText(spaceId, text) {
  text = (text || '').trim();
  if (text === '/help' || text === '/start') return sayToSpace(spaceId, HELP);

  if (text === '/list') {
    const lc = listCard();
    if (!lc) return sayToSpace(spaceId, '_No sessions found._');
    return tx.sendCard(spaceId, lc.card, lc.fallback).catch(() => sayToSpace(spaceId, lc.fallback));
  }

  if (text.startsWith('/attach')) {
    const id = text.slice(7).trim();
    if (!id) return sayToSpace(spaceId, 'Usage: `/attach ID`  (see `/list`)');
    return attachSession(spaceId, id);
  }

  if (text === '/detach') {
    const sessionId = spaceSession.get(spaceId);
    unsubscribe(spaceId);
    return sayToSpace(spaceId, sessionId ? `🔌 Detached from \`${sessionId.slice(0, 8)}\`.` : 'Not attached.');
  }

  if (text === '/stop') {
    const sessionId = spaceSession.get(spaceId);
    if (!sessionId) return sayToSpace(spaceId, 'Not attached. `/attach ID` first.');
    const loc = paneForSession(sessionId);
    if (!loc) return sayToSpace(spaceId, '⚠️ Session pane not found (did it exit?).');
    try { tmux(['send-keys', '-t', loc.pane, 'Escape']); return sayToSpace(spaceId, '🛑 Sent Esc.'); }
    catch (e) { return sayToSpace(spaceId, `⚠️ ${e.message}`); }
  }

  // Run Claude Code's own /compact slash command in the session (inject + submit).
  if (text === '/compact') {
    const sessionId = spaceSession.get(spaceId);
    if (!sessionId) return sayToSpace(spaceId, 'Not attached. `/attach ID` first.');
    const loc = paneForSession(sessionId);
    if (!loc) return sayToSpace(spaceId, `⚠️ \`${sessionId.slice(0,8)}\` is no longer running in a tmux pane.`);
    ensureBridge(sessionId);
    try { injectToPane(loc.pane, '/compact'); return sayToSpace(spaceId, '🗜️ Sent `/compact`.'); }
    catch (e) { return sayToSpace(spaceId, `⚠️ ${e.message}`); }
  }

  // Custom "//" command — runs locally, output posted to this space.
  if (text.startsWith('//')) {
    const sessionId = spaceSession.get(spaceId);
    const rest = text.slice(2).trim();
    const sp = rest.indexOf(' ');
    const name = (sp === -1 ? rest : rest.slice(0, sp)).trim();
    const args = sp === -1 ? '' : rest.slice(sp + 1);
    if (!name) return sayToSpace(spaceId, 'Usage: `//name [args]` — see `//help`');
    // //aws-login streams (URL/code now, result later).
    const spec = loadCommands()[name];
    if (spec && spec.builtin === 'aws-login')
      return awsLoginToWebex(spaceId, sessionId || spaceId, spec.cli || 'aws', spec.profile);
    return sayToSpace(spaceId, runCommand(sessionId || '', name, args));
  }

  if (text.startsWith('/')) return sayToSpace(spaceId, `Unknown command.\n\n${HELP}`);

  const sessionId = spaceSession.get(spaceId);
  if (!sessionId) return sayToSpace(spaceId, 'Not attached. Use `/attach ID` first. `/help` for more.');

  // Typed permission answer: a bare number while a prompt is open.
  const numMatch = /^\s*(\d+)\s*$/.exec(text);
  if (numMatch && activePrompts.has(sessionId)) {
    const ok = answerPrompt(sessionId, Number(numMatch[1]));
    return sayToSpace(spaceId, ok ? `✅ Chose option ${numMatch[1]}.` : `⚠️ Not a valid option.`);
  }

  // Normal message → paste into the attached session's tmux pane.
  const loc = paneForSession(sessionId);
  if (!loc) return sayToSpace(spaceId, `⚠️ \`${sessionId.slice(0,8)}\` is no longer running in a tmux pane.`);

  ensureBridge(sessionId);
  recordSent(sessionId, text);
  try { injectToPane(loc.pane, text); }
  catch (e) { sayToSpace(spaceId, `⚠️ inject failed: ${e.message}`); }
}

// Adaptive Card button press → attach from /list, or answer a permission prompt.
// spaceId is the room the button was pressed in; inputs is the button's data payload.
async function onAction(spaceId, inputs, who) {
  inputs = inputs || {};
  who = who || 'someone';
  if (inputs.action === 'attach') {
    return attachSession(spaceId, inputs.sessionId).catch(e => sayToSpace(spaceId, `⚠️ ${e.message}`));
  }
  if (inputs.action !== 'perm') return;
  const { choice, sessionId } = inputs;
  const ok = answerPrompt(sessionId, Number(choice));
  sayToSession(sessionId, ok ? `✅ Option ${choice} chosen by ${who}` : `_(prompt already answered)_`);
}

function stopWatchers() {
  for (const sid of [...paneWatchers.keys()]) stopPaneWatch(sid);
  for (const sid of [...transcriptWatchers.keys()]) stopWatching(sid);
}

// ── Real Webex transport + framework wiring ─────────────────────────────────────
// A framework-backed transport. getBotByRoomId gives us a per-space sender; message
// removal goes through the shared webex client. Only built when run as a program.
function makeWebexTransport(framework) {
  return {
    say(spaceId, markdown) {
      const bot = framework.getBotByRoomId(spaceId);
      if (!bot) return Promise.resolve(null);
      return bot.say('markdown', markdown).then(m => (m && m.id) || null);
    },
    sendCard(spaceId, card, fallback) {
      const bot = framework.getBotByRoomId(spaceId);
      if (!bot) return Promise.resolve(null);
      return bot.sendCard(card, fallback).then(m => (m && m.id) || null);
    },
    remove(messageId) {
      return framework.webex.messages.remove(messageId);
    },
  };
}

function startWebex() {
  if (!TOKEN) {
    console.error(`Missing bot token. Add {"token": "...", "allow": ["you@example.com"]} to ${CONFIG_FILE}. Create a bot at https://developer.webex.com/my-apps/new/bot`);
    process.exit(1);
  }
  if (!ALLOW.size) {
    console.warn(`[webex] WARNING: no "allow" list in ${CONFIG_FILE} — every sender will be refused. Add {"allow": ["you@example.com"]}.`);
  } else {
    console.log(`[webex] allow-list: ${[...ALLOW].join(', ')}`);
  }
  const Framework = require('webex-node-bot-framework');
  const framework = new Framework({ token: TOKEN, removeDeviceRegistrationsOnStart: true });
  setTransport(makeWebexTransport(framework));

  framework.on('initialized', () => console.log('[webex] initialized — listening'));
  framework.on('spawn', (bot, _id, actorId) => {
    if (!actorId) return;   // pre-existing space at startup, not an interactive add
    // actorId is a person id — resolve to an email and greet only if allowed.
    framework.webex.people.get(actorId)
      .then(p => {
        const email = emailOf(p);
        if (isAllowed(email)) return bot.say('markdown', HELP).catch(() => {});
        console.warn(`[webex] DENY greeting to ${email || actorId} — not in allow list`);
      })
      .catch(() => {});
  });
  framework.hears(/.*/, (bot, trigger) => {
    const text = (trigger.text || '').trim();
    const spaceId = trigger.message.roomId;
    const email = personEmail(trigger);
    console.log(`[webex] <${email || 'unknown'}> ${text}`);
    if (!isAllowed(email)) {
      console.warn(`[webex] DENY ${email || 'unknown'} — not in allow list`);
      sayToSpace(spaceId, '⛔ You are not authorized to use this bot.');
      return;
    }
    Promise.resolve(onText(spaceId, text)).catch(err => {
      console.error('[webex] handler error:', err.message);
      sayToSpace(spaceId, `⚠️ ${err.message}`);
    });
  });
  framework.on('attachmentAction', (bot, trigger) => {
    const inputs = (trigger.attachmentAction && trigger.attachmentAction.inputs) || {};
    const spaceId = (trigger.attachmentAction && trigger.attachmentAction.roomId) ||
      (bot && bot.room && bot.room.id) ||
      (trigger.message && trigger.message.roomId);
    const who = (trigger.person && trigger.person.displayName) || 'someone';
    const email = personEmail(trigger);
    if (!isAllowed(email)) {
      console.warn(`[webex] DENY action from ${email || 'unknown'} — not in allow list`);
      sayToSpace(spaceId, '⛔ You are not authorized to use this bot.');
      return;
    }
    Promise.resolve(onAction(spaceId, inputs, who)).catch(err => {
      console.error('[webex] action error:', err.message);
    });
  });

  framework.start()
    .then(() => console.log('[webex] started — reads Claude JSONL directly, input via tmux'))
    .catch(err => { console.error('[webex] start failed:', err.message); process.exit(1); });

  const shutdown = () => {
    console.log('\n[webex] stopping…');
    stopWatchers();
    framework.stop().then(() => process.exit(0)).catch(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return framework;
}

// ── Exports (reused by ccbb-confluence and the mock harness / tests) ─────────────
module.exports = {
  setTransport, onText, onAction, attachSession, listSessions, listCard,
  paneForSession, getSessionHistory, runCommand,
  // permission internals (so tests can drive the scraper without a live prompt)
  parsePrompt, checkPrompt, activePrompts, capturePane,
  handleTranscript, collapsibleCard,
  subscribe, unsubscribe, spaceSession, sessionSpaces,
  startWebex, stopWatchers,
};

// Run as a program → connect to real Webex. Imported as a module → stays inert
// (nullTransport) until the caller injects its own transport.
if (require.main === module) startWebex();
