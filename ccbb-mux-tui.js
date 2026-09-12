'use strict';
// ── ccbb-mux-tui.js ──────────────────────────────────────────────────────────
// The terminal client. Attaches to a ccbb-mux session over WebSocket and renders
// it in the terminal, CLI-flavored.
//
// A word on what "faithful to the CLI" can and cannot mean here. The real
// `claude` TUI is a closed, minified Ink app inside a 376MB binary; there is no
// published rendering spec and the layout moves between releases. So this is not
// a reimplementation of that renderer — it's ccbb's own TUI wearing the CLI's
// idiom: the same information architecture, the same message ordering, the same
// "⏺ Tool(args)" / "⎿ result" gutter, converged by eye. Byte-fidelity would be a
// promise to chase a moving target with no source.
//
// Structurally this is append-only scrollback plus a one-line input at the
// bottom, which is what the CLI is too. Every write goes through out(), which
// parks the readline prompt, prints, and redraws — otherwise streaming deltas
// and the line editor fight over the same row.
//
// The glyphs, gutter widths and rollup wording below were converged against a
// same-input capture of the real CLI (v2.1.246) — see tui-fidelity.md.
//
// Under a TTY this is a full-redraw client: it owns the alternate screen, keeps
// the transcript as a MODEL rather than a stream of prints, and repaints it on
// every change. That is what buys the things append-only scrollback could not
// express — a card with a moving cursor that can be erased when another
// controller answers first, a bullet that repaints when its tool settles, a
// spinner, and ctrl+o restating the whole history rather than only what comes
// next. Every renderer still writes through out(); when a sink is installed it
// collects lines instead of printing, so the functions that were byte-matched
// against the real CLI are the same ones the repaint replays.
//
// Without a TTY none of that applies and it degrades to append-only printing.
//
//   ccbb attach <session-id> [--label me@laptop] [--url ws://…]

const readline = require('readline');
const { muxAddress } = require('./ccbb-mux');
const common = require('./ccbb-common');

// ── the configured status line ───────────────────────────────────────────────
// Claude Code runs a script named in settings.json and prints whatever it writes.
// This TUI is a Claude Code client with no Claude Code around it, so it runs that
// script itself — otherwise the one line its user actually configured is the one
// line their own session does not show.
//
// The payload shape is documented (code.claude.com/docs/en/statusline) and real
// scripts read real fields out of it, so a payload that merely LOOKS right is worse
// than none: transcript_path especially, which is where a script goes for turn counts
// and cache state. It is resolved through ccbb-common's index rather than re-derived
// from the cwd slug — the slug rule is not obvious, and a wrong path renders a line
// that is quietly wrong rather than visibly absent.
//
// Two behaviours are copied from the docs rather than invented: updates debounce at
// 300ms, and a trigger that arrives while the script is still running CANCELS it. A
// status line script that outlives its own refresh interval would otherwise pile up
// processes for as long as the session lasts.
const { spawn } = require('child_process');
const STATUS_DEBOUNCE_MS = 300;
function statusLineConfig() {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || common.CLAUDE_DIR;
    const j = JSON.parse(require('fs').readFileSync(require('path').join(dir, 'settings.json'), 'utf8'));
    const sl = j && j.statusLine;
    if (!sl || sl.type !== 'command' || !sl.command) return null;
    return { command: sl.command, padding: Number(sl.padding) || 0,
      refreshMs: sl.refreshInterval ? Math.max(1000, Number(sl.refreshInterval) * 1000) : 0 };
  } catch { return null; }
}
class StatusLine {
  constructor(onLines) {
    this.cfg = statusLineConfig();
    this.onLines = onLines;
    this.lines = [];
    this.child = null; this.timer = null; this.tick = null;
    if (this.cfg && this.cfg.refreshMs) {
      this.tick = setInterval(() => this.refresh(), this.cfg.refreshMs);
      if (this.tick.unref) this.tick.unref();
    }
  }
  get enabled() { return !!this.cfg; }
  stop() {
    clearInterval(this.tick); clearTimeout(this.timer);
    if (this.child) { try { this.child.kill('SIGKILL'); } catch {} this.child = null; }
  }
  // What the script is handed. Everything here is something the mux actually knows;
  // fields it cannot know are left off rather than filled with a plausible zero, so a
  // script that guards on them (the docs say several are null early in a session) takes
  // the branch it would have taken under Claude Code itself.
  payload(st, usage) {
    const id = st.id || '';
    const p = {
      cwd: st.cwd || process.cwd(),
      session_id: id,
      session_name: st.label || undefined,
      transcript_path: (id && common.findSessionJsonl(id)) || undefined,
      model: { id: st.model || '', display_name: st.model || '' },
      workspace: { current_dir: st.cwd || process.cwd(), project_dir: st.cwd || process.cwd(), added_dirs: [] },
      version: st.version || undefined,
      output_style: { name: 'default' },
      cost: { total_cost_usd: st.cost || 0, total_duration_ms: 0, total_api_duration_ms: 0,
        total_lines_added: 0, total_lines_removed: 0 },
    };
    // The plan's rolling windows, as Claude Code hands them to the same script: on a
    // subscription they are the number that actually runs out, and a script that sees
    // rate_limits switches to its subscription layout. Same reader as ccbb web's footer.
    let sub = null;
    try { sub = common.getSubscription(); } catch {}
    if (sub && sub.windows) {
      const w = k => sub.windows[k] ? { used_percentage: sub.windows[k].pct, resets_at: sub.windows[k].resetsAt } : undefined;
      p.rate_limits = { five_hour: w('fiveHour'), seven_day: w('sevenDay') };
    }
    // Context: the mux's own figure first — read from the transcript, so it is right
    // from the moment of attaching, where the last result's usage only exists once a
    // turn has ended under this client and was 0 until then.
    if (!usage && st.contextTokens) usage = { input_tokens: st.contextTokens, output_tokens: 0 };
    if (usage) {
      const inTok = st.contextTokens || ((usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) +
        (usage.cache_creation_input_tokens || 0));
      const size = st.contextMax || 200000;
      p.context_window = {
        total_input_tokens: inTok, total_output_tokens: usage.output_tokens || 0,
        context_window_size: size,
        used_percentage: Math.min(100, Math.round(inTok / size * 100)),
        remaining_percentage: Math.max(0, 100 - Math.round(inTok / size * 100)),
        current_usage: {
          input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: usage.cache_read_input_tokens || 0,
        },
      };
      p.exceeds_200k_tokens = inTok + (usage.output_tokens || 0) > 200000;
    }
    return p;
  }
  update(st, usage) {
    if (st.agent === 'codex') { this.stop(); this.lines = []; this.cfg = null; return; }
    if (!this.cfg) return;
    this.st = st; this.usage = usage;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), STATUS_DEBOUNCE_MS);
    if (this.timer.unref) this.timer.unref();
  }
  refresh() {
    if (!this.cfg || !this.st) return;
    if (this.child) { try { this.child.kill('SIGKILL'); } catch {} this.child = null; }
    let out = '';
    const c = spawn('sh', ['-c', this.cfg.command], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = c;
    c.stdout.setEncoding('utf8');
    c.stdout.on('data', d => { out += d; if (out.length > 64000) c.kill('SIGKILL'); });
    c.on('error', () => { if (this.child === c) this.child = null; });
    c.on('close', () => {
      if (this.child !== c) return;              // superseded; its output is stale
      this.child = null;
      const pad = ' '.repeat(this.cfg.padding);
      const lines = out.replace(/\s+$/, '').split('\n').filter((l, i, a) => l || i < a.length);
      this.lines = out.trim() ? lines.map(l => pad + l) : [];
      this.onLines();
    });
    try { c.stdin.end(JSON.stringify(this.payload(this.st, this.usage))); } catch {}
  }
}

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const A = COLOR ? {
  dim: s => `\x1b[2m${s}\x1b[0m`,       bold: s => `\x1b[1m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,     green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,   red: s => `\x1b[31m${s}\x1b[0m`,
  magenta: s => `\x1b[35m${s}\x1b[0m`,  gray: s => `\x1b[90m${s}\x1b[0m`,
  italic: s => `\x1b[3m${s}\x1b[0m`,
  // The CLI's diff colours: foreground on a dark background band, not bare red
  // and green text. The band is what makes a diff read as a diff at a glance.
  del: s => `\x1b[48;5;52m\x1b[38;5;167m${s}\x1b[0m`,
  add: s => `\x1b[48;5;22m\x1b[38;5;77m${s}\x1b[0m`,
} : new Proxy({}, { get: () => (s => String(s)) });

// The CLI's tool gutter: ⏺ (U+23FA, not the rounder ●) for the bullet, and
// "⎿" with TWO trailing spaces for the result hanging off it. CONT is the
// column that continuation lines align to — the same width as "  ⎿  ".
// The second space after ⎿ is a NON-BREAKING space (U+00A0) in the real CLI —
// that is what keeps the elbow and its first word on one line. Verified by
// codepoint against a capture; a plain space here is a one-byte infidelity.
const DOT = { running: A.yellow('⏺'), done: A.green('⏺'), error: A.red('⏺') };
const ELBOW = A.gray('  ⎿  ');
const CONT = '     ';

function trunc(s, n) { s = String(s == null ? '' : s); return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)) + '…'; }

// Word-wrap to an array of lines. A token longer than the width is cut rather
// than allowed past the edge — long paths in error text are the common case.
function wrapLines(text, width) {
  const out = [];
  const w = Math.max(8, width);
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (let word of para.split(/(\s+)/)) {
      while (word.length > w) {
        if (line.trim()) { out.push(line.trimEnd()); line = ''; }
        out.push(word.slice(0, w)); word = word.slice(w);
      }
      if (line.length + word.length > w && line.trim()) { out.push(line.trimEnd()); line = ''; }
      line += word;
    }
    if (line.trim()) out.push(line.trimEnd());
  }
  return out;
}

function wrap(text, width, indent) {
  const pad = ' '.repeat(indent || 0);
  return wrapLines(text, width).map(l => (l ? pad + l : '')).join('\n');
}

// Tool output and errors are cut at the column, not at a word boundary — the CLI
// breaks a long path mid-token rather than leaving a ragged right edge.
function hardWrapLines(text, width) {
  const out = [];
  const w = Math.max(8, width);
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue; }
    for (let s = para; s.length; s = s.slice(w)) out.push(s.slice(0, w));
  }
  return out;
}

// The "⎿" block: the first line hangs off the elbow, the rest align under it.
function elbowBlock(lines, gutter) {
  const g = gutter || '';
  const ls = lines && lines.length ? lines : [''];
  return g + ELBOW + ls[0] + ls.slice(1).map(l => '\n' + g + CONT + l).join('');
}

function prettyToolName(name, input) {
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name || '');
  if (m) return `${m[1]} - ${m[2]}`;
  // The CLI labels a few tools by what they do rather than by the tool's own
  // name: an edit is an "Update", and a subagent is named by its type.
  if (name === 'Edit') return 'Update';
  if ((name === 'Task' || name === 'Agent') && input && input.subagent_type) return String(input.subagent_type);
  return name;
}
const base = p => String(p || '').split('/').pop() || String(p || '');

// A one-line summary of a tool call's arguments, the way the CLI shows them —
// the identifying argument, not the whole input object.
function toolSummary(name, input) {
  if (!input || typeof input !== 'object') return '';
  const first = (...keys) => { for (const k of keys) if (input[k] != null) return String(input[k]); return null; };
  switch (name) {
    case 'Bash':   return String(input.command || '').split('\n')[0];
    case 'Read':   return String(input.file_path || '') + (input.offset ? ` @${input.offset}` : '');
    case 'Edit':   return base(input.file_path);
    case 'Write':  return base(input.file_path);
    case 'Grep':   return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`;
    case 'Glob':   return String(input.pattern || '');
    case 'WebFetch': return String(input.url || '');
    case 'WebSearch': return String(input.query || '');
    case 'Task': case 'Agent': return String(input.description || input.subagent_type || '');
    case 'TodoWrite': return `${(input.todos || []).length} items`;
    case 'AskUserQuestion': return (input.questions || []).map(q => q.header).filter(Boolean).join(', ')
      || `${(input.questions || []).length} question(s)`;
    case 'ExitPlanMode': return (String(input.plan || '').split('\n').find(l => l.trim()) || 'plan')
      .replace(/^#+\s*/, '').replace(/^[-*]\s*/, '');
    case 'NotebookEdit': return base(input.notebook_path);
    default: return first('url', 'description', 'prompt', 'path', 'file_path', 'command', 'query', 'pattern') || '';
  }
}

function resultText(result) {
  let text = result;
  if (Array.isArray(text)) text = text.map(b => (b && b.text) || '').join('\n');
  if (text && typeof text === 'object') text = JSON.stringify(text);
  return String(text == null ? '' : text);
}

// A tool's output, wrapped. Deliberately NOT dimmed: the CLI greys the elbow but
// prints the output itself at full brightness, and dimming all of it was the most
// visible inversion in the fidelity capture.
function resultLines(result, width, maxLines) {
  const src = resultText(result).split('\n').filter(l => l.trim());
  if (!src.length) return [A.gray('(no output)')];
  const cap = maxLines || 4;
  const out = [];
  for (const l of src.slice(0, cap)) out.push(...hardWrapLines(l, width));
  if (src.length > cap) out.push(A.gray(`… +${src.length - cap} lines`));
  return out;
}

// The canonical string the child injects when a human denies a tool. The CLI
// never shows it — it says "Interrupted" and asks what to do instead — and
// echoing the coaching text leaks plumbing into the transcript.
const REJECTED = /^The user (doesn't want to proceed with this tool use|doesn't want to take this action)/;

// "Added 1 line, removed 1 line", counted off the structuredPatch the child sends
// alongside an edit's result.
function patchStats(meta) {
  const patch = meta && meta.structuredPatch;
  if (!Array.isArray(patch) || !patch.length) return null;
  let add = 0, del = 0;
  for (const h of patch) for (const l of h.lines || []) { if (l[0] === '+') add++; else if (l[0] === '-') del++; }
  const bits = [];
  if (add) bits.push(`Added ${add} line${add === 1 ? '' : 's'}`);
  if (del) bits.push(`${bits.length ? 'r' : 'R'}emoved ${del} line${del === 1 ? '' : 's'}`);
  return bits.length ? bits.join(', ') : 'No changes';
}

// The AskUserQuestion result carries the picks back as "question"="answer" pairs;
// the CLI renders them as one "· Q → A" line each rather than the raw sentence.
function answerLines(result) {
  const out = [];
  const re = /"([^"]+)"\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(resultText(result)))) out.push(A.gray('· ') + m[1] + A.gray(' → ') + m[2]);
  return out.length ? out : null;
}

// What hangs off the elbow once a tool settles. Most tools get their output, but
// a few get a rollup instead, because that is what the CLI shows: Read never
// echoes the bytes back, and Edit's and Task's result strings are plumbing.
// Returning null means "draw nothing" — the body is already on screen.
function toolResultLines(name, result, meta, width) {
  if (REJECTED.test(resultText(result))) return [A.gray('Interrupted · What should Claude do instead?')];
  switch (name) {
    case 'Read': case 'NotebookRead': {
      const f = meta && meta.file;
      const n = f && f.numLines != null ? f.numLines
        : resultText(result).split('\n').filter(l => l.trim()).length;
      return [A.gray(`Read ${n} line${n === 1 ? '' : 's'}`)];
    }
    // The change summary heads the block and the numbered diff hangs under it —
    // the raw "The file … has been updated" string is never shown.
    case 'Edit': case 'Write': case 'NotebookEdit':
      return [A.gray(patchStats(meta) || 'Updated'), ...diffLines(null, meta, width)];
    case 'Task': case 'Agent':
      return [A.gray('Backgrounded agent')];
    case 'AskUserQuestion':
      return answerLines(result) || resultLines(result, width);
    case 'TodoWrite':
      return null;                       // the checklist was drawn from the input
    default:
      return resultLines(result, width);
  }
}

// The CLI shows a todo list as a checklist at the moment it is written, not as
// the string "Todos have been modified successfully." — that string is all the
// tool_result carries, so the list has to come off the tool INPUT.
const TODO_MARK = { completed: A.green('☒'), in_progress: A.yellow('→'), pending: A.gray('☐') };
function renderTodos(todos, width) {
  return (todos || []).map(t => {
    const mark = TODO_MARK[t.status] || TODO_MARK.pending;
    const text = t.status === 'in_progress' ? A.bold(t.activeForm || t.content) : t.content;
    const body = t.status === 'completed' ? A.gray(text) : text;
    return `     ${mark} ${String(body).slice(0, width)}`;
  }).join('\n');
}

// An edit is a diff, not a filename. `structuredPatch` on the tool_result is the
// good source when it arrives; before that, old_string/new_string on the input
// is enough to show the change at the moment it's proposed — which is when a
// permission card needs it most.
// The diff body as an array of un-indented lines, so it can hang off an elbow or
// sit inside a permission card without either owning the indentation.
function diffLines(input, meta, width) {
  const out = [];
  const body = Math.max(20, width - 4);
  // A diff line: dim right-aligned line number, then the ±/context text on a
  // colour band that runs to the edge, the way the CLI draws it.
  const push = (num, sign, text) => {
    const cell = (sign + text).length > body ? (sign + text).slice(0, body - 1) + '…' : sign + text;
    const gutter = A.gray(String(num == null ? '' : num).padStart(2)) + ' ';
    out.push(gutter + (sign === '+' ? A.add(cell.padEnd(body))
                     : sign === '-' ? A.del(cell.padEnd(body))
                     : A.gray(cell)));
  };
  // structuredPatch is the good source: it carries line numbers and the
  // unchanged context around the change, which is what makes an edit readable.
  const patch = meta && meta.structuredPatch;
  if (Array.isArray(patch) && patch.length) {
    for (const h of patch) {
      // newStart is absent on some patches; the two sides start together then.
      let oldN = h.oldStart || 1, newN = h.newStart || h.oldStart || 1;
      for (const l of (h.lines || []).slice(0, 30)) {
        const sign = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
        const text = l.slice(1);
        if (sign === '+') push(newN++, '+', text);
        else if (sign === '-') push(oldN++, '-', text);
        else { push(oldN, ' ', text); oldN++; newN++; }
      }
    }
    return out;
  }
  // Before the edit runs there is no patch — old_string/new_string is enough to
  // show the change at the moment it's proposed, which is when a permission card
  // needs it most. No line numbers are knowable here.
  if (input && input.old_string != null) {
    for (const l of String(input.old_string).split('\n').slice(0, 10)) push(null, '-', l);
    for (const l of String(input.new_string || '').split('\n').slice(0, 10)) push(null, '+', l);
    return out;
  }
  if (input && input.content != null) {
    const lines = String(input.content).split('\n');
    lines.slice(0, 8).forEach((l, i) => push(i + 1, '+', l));
    if (lines.length > 8) out.push(A.gray(`… +${lines.length - 8} lines`));
    return out;
  }
  return out;
}
// The same diff, indented for a permission card.
function renderDiff(input, meta, width) {
  return diffLines(input, meta, width - CONT.length).map(l => CONT + l).join('\n');
}

// A plan is prose the human has to read before deciding, so it gets rendered in
// full rather than summarized to a line.
function renderPlan(plan, width) {
  return String(plan || '').split('\n').map(l => {
    if (/^#{1,6}\s/.test(l)) return '  ' + A.bold(l.replace(/^#+\s*/, ''));
    return '  ' + wrap(l, width - 4, 0).replace(/\n/g, '\n    ');
  }).join('\n');
}

// The CLI closes a turn with one of a rotating set of whimsical past-tense verbs
// ("✻ Baked for 9s · done 2:04 PM"), and spins on their present-tense counterparts.
// Both lists — and the frames — live in ccbb-mux.js now: the web client draws the same
// spinner, and a vocabulary kept in two files is a vocabulary that diverges.
const { TURN_VERBS, SPIN_VERBS, SPIN_FRAMES } = require('./ccbb-mux');

const ALT_ON = '\x1b[?1049h', ALT_OFF = '\x1b[?1049l';
const HIDE = '\x1b[?25l', SHOW = '\x1b[?25h';

// How the CLI names a settled tool when the transcript is collapsed. Only Read,
// Bash and Glob were captured from the real thing; the rest follow its pattern.
const ROLLUP = {
  Read:  n => `Read ${n} file${n === 1 ? '' : 's'}`,
  Bash:  n => `Ran ${n} shell command${n === 1 ? '' : 's'}`,
  Glob:  n => `Listed ${n} director${n === 1 ? 'y' : 'ies'}`,
  Grep:  n => `Searched ${n} pattern${n === 1 ? '' : 's'}`,
  Edit:  n => `Made ${n} edit${n === 1 ? '' : 's'}`,
  Write: n => `Wrote ${n} file${n === 1 ? '' : 's'}`,
  NotebookEdit: n => `Made ${n} edit${n === 1 ? '' : 's'}`,
  TodoWrite: () => 'Updated the todo list',
  WebFetch: n => `Fetched ${n} URL${n === 1 ? '' : 's'}`,
  WebSearch: n => `Ran ${n} web search${n === 1 ? '' : 'es'}`,
  Task: n => `Ran ${n} agent${n === 1 ? '' : 's'}`,
  Agent: n => `Ran ${n} agent${n === 1 ? '' : 's'}`,
};
// Never collapsed: a question is a human interaction and its answer is the point
// of the transcript rather than a detail of it, and a backgrounded agent is a
// live handle — the CLI keeps its call visible with a hint for reaching it.
const NEVER_COLLAPSE = new Set(['AskUserQuestion', 'ExitPlanMode', 'Task', 'Agent']);

// A permission card is headed by the kind of thing being asked for, and closed
// by a question naming the subject — not by the tool's own identifier.
const PERMISSION_HEADING = {
  Bash: 'Bash command', Edit: 'Edit file', Write: 'Create file',
  NotebookEdit: 'Edit notebook', WebFetch: 'Fetch URL', WebSearch: 'Web search',
  ExitPlanMode: 'Ready to code?',
};
const PERMISSION_QUESTION = {
  Edit: f => `Do you want to make this edit to ${f}?`,
  Write: f => `Do you want to create ${f}?`,
  NotebookEdit: f => `Do you want to make this edit to ${f}?`,
  ExitPlanMode: () => 'Would you like to proceed?',
};

function attachHelp() {
  console.log(`ccbb attach — terminal client for a ccbb-mux session

Usage:
  ccbb attach [<name>|<session-id>] [options]

With no name, attaches to the session if exactly one is running.

Options:
  --label <name>    how this controller identifies itself to the others
  --url <ws url>    mux websocket (default: the running mux on this machine)
  -h, --help        this help

In the session:
  <text>            send a turn (queued if one is already running)
  /                 list slash commands (the live list, straight from the child)
  /<partial> Tab    complete a command name
  /<command>        run it — slash commands are interpreted by the child
On an open card:
  ↑ / ↓             move the cursor        Enter        choose
  1, 2, 3 …         jump to an option      Space        toggle (multi-select)
  ← / →             previous / next question in a multi-question card
  "Type something." answer in your own words instead of picking

Anywhere:
  Ctrl-O            collapse / expand the whole transcript
  Ctrl-G            edit the line in $VISUAL / $EDITOR (vim)
  PgUp / PgDn       scroll        End       jump back to following
  Esc, Ctrl-C       interrupt the running turn (Ctrl-C twice to leave)
  //mode <m>        set permission mode      //model <m>  set model
  //who             who else is attached     //snap       redraw from a fresh snapshot

Without a TTY (a pipe, a detached pane) the client falls back to append-only
output and answers cards by number: "1", "1,3", "?your own text".`);
}

async function runAttach(argv) {
  let ref = null, label = `${require('os').userInfo().username}@${require('os').hostname().split('.')[0]}`, url = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return attachHelp();
    else if (a === '--label') label = argv[++i];
    else if (a === '--url') url = argv[++i];
    else if (!a.startsWith('-')) ref = a;
  }

  // --url points at a mux this machine may know nothing about — there is no address
  // file to list, so there is nothing to resolve a name against and the id has to be
  // spelled out. Everywhere else the name IS the address: resolveRef asks the mux, so
  // `ccbb attach` with nothing at all works when exactly one session is running.
  let sessionId = ref;
  if (!url) {
    sessionId = (await require('./ccbb-mux').resolveRef(ref)).id;
    const addr = muxAddress();
    if (!addr) { console.error('ccbb: no mux running — start `ccbb web`'); process.exit(1); }
    url = `ws://${addr.host}:${addr.port}${addr.prefix || ""}/mux`;
  }
  if (!sessionId) { console.error('ccbb: attach --url needs a session id'); process.exit(1); }
  const tok = common.peerToken ? common.peerToken() : null;
  // pid: this process is in a tmux pane more often than not, and telling the mux which
  // process we are is what lets ccbb web's "$>" open THAT pane instead of a fresh one.
  const qs = new URLSearchParams({ session: sessionId, label, kind: 'tui', pid: String(process.pid) });
  if (tok) qs.set('token', tok);

  const WebSocket = require('ws');
  const ws = new WebSocket(`${url}?${qs}`);
  const client = new TuiClient(ws, label);
  ws.on('open', () => client.onOpen());
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } client.onMessage(m); });
  ws.on('close', (c, r) => { client.out(A.red(`\n— disconnected (${c}${r ? ' ' + r : ''}) —`)); process.exit(0); });
  ws.on('error', e => { console.error('ccbb:', e.message); process.exit(1); });
}

class TuiClient {
  constructor(ws, label) {
    this.ws = ws;
    this.label = label;
    this.state = {};
    this.seq = 0;
    this.open = null;          // the request card currently awaiting an answer
    this.streaming = false;    // mid-delta, so a newline is owed before the next block
    this.streamed = new Set(); // API message ids already printed token-by-token
    this.bodyShown = new Set(); // tool_use ids whose body is already on screen
    this.lastCtrlC = 0;
    this.width = () => Math.max(40, (process.stdout.columns || 80));
    this.height = () => Math.max(10, (process.stdout.rows || 24));

    // The transcript is a MODEL, not a stream of prints. Static entries hold the
    // lines they rendered to; tool entries hold the block and re-render on every
    // paint, which is what lets ctrl+o restate history rather than only affecting
    // what comes next.
    this.entries = [];
    this.sink = null;          // when set, out() collects instead of painting
    this.scroll = 0;           // lines scrolled up from the bottom; 0 = following
    this.collapsed = true;     // the CLI's default view; ctrl+o expands
    this.history = []; this.histAt = 0;
    this.line = ''; this.cursor = 0;
    this.toolEntries = new Map();   // tool_use id → its transcript entry
    this.pendingByIndex = new Map(); // "apiId|block index" → entry, while its input streams
    this.agents = new Map();        // backgrounded agent id → its description
    // The user's own status line, if they configured one. Repainting on its callback
    // rather than polling it: the script is a subprocess and its latency is theirs.
    this.statusLine = new StatusLine(() => this.paint());
    this.lastUsage = null;

    this.tty = !!(process.stdout.isTTY && process.stdin.isTTY);
    if (this.tty) this.startScreen(); else this.startPipe();
  }

  // ── screen ownership ─────────────────────────────────────────────────────
  // A full-redraw client owns the terminal: alternate buffer so the shell's
  // scrollback survives, raw keys so ↑/↓ can drive a card, and our own PgUp/PgDn
  // because the terminal's no longer scrolls this.
  startScreen() {
    process.stdout.write(ALT_ON + HIDE);
    process.stdin.setRawMode(true);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', (ch, key) => this.onKey(ch, key || {}));
    process.stdout.on('resize', () => this.paint());
    const restore = () => { try { process.stdout.write(SHOW + ALT_OFF); } catch {} };
    process.on('exit', restore);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
      process.on(sig, () => { restore(); process.exit(0); });
    this.restore = restore;
  }

  // No TTY — a pipe, a detached pane, a test harness. There is no screen to own,
  // so fall back to append-only printing and a plain line reader.
  startPipe() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '' });
    this.rl.on('line', l => this.onInput(l));
    this.rl.on('close', () => { this.rlClosed = true; });
    this.rl.on('SIGINT', () => this.onSigint());
  }

  // ── slash commands ───────────────────────────────────────────────────────
  // The list is whatever the child says it is: `slash_commands` at init, then
  // `commands_changed` as plugins and skills load. Never a hardcoded table.
  commandNames() {
    const raw = (this.state.commands && this.state.commands.length)
      ? this.state.commands : (this.state.slashCommands || []);
    const names = raw.map(c => (typeof c === 'string' ? c : (c && (c.name || c.command)) || ''))
      .map(n => String(n).replace(/^\//, '')).filter(Boolean);
    return [...new Set(names)].sort();
  }
  // Descriptions only exist when commands_changed sent objects; keyed by name so
  // the menu can show them when they're there and stay quiet when they're not.
  commandHelp(name) {
    const c = (this.state.commands || []).find(x => x && typeof x === 'object' &&
      String(x.name || x.command || '').replace(/^\//, '') === name);
    return c ? String(c.description || c.argumentHint || '') : '';
  }

  // Tab completion, scoped to the command word — once there's a space the rest
  // of the line is arguments and none of our business.
  complete(line) {
    const m = /^\/([^/\s]*)$/.exec(line);
    if (!m) return [[], line];
    const all = this.commandNames();
    const hits = all.filter(c => c.startsWith(m[1]));
    return [(hits.length ? hits : all).map(c => '/' + c), line];
  }

  commandHint() {
    const n = this.commandNames().length;
    this.out(A.gray(n ? `  ${n} commands · Tab to complete · Enter on "/" alone to list them`
                      : '  (no slash commands — the child has not sent a list yet)'));
  }

  showCommands(filter) {
    const all = this.commandNames();
    if (!all.length) return this.out(A.gray('  (no slash commands — the child has not sent a list yet)'));
    const names = filter ? all.filter(c => c.startsWith(filter)) : all;
    if (!names.length) return this.out(A.gray(`  no command matches /${filter}`));
    // With descriptions, one per line; without, packed into columns so a
    // fifty-command list doesn't bury the transcript.
    const described = names.filter(n => this.commandHelp(n));
    if (described.length) {
      const pad = Math.min(24, Math.max(...names.map(n => n.length)) + 2);
      return this.out(names.map(n =>
        A.cyan('  /' + n.padEnd(pad)) + A.gray(trunc(this.commandHelp(n), this.width() - pad - 6))).join('\n'));
    }
    const colw = Math.max(...names.map(n => n.length)) + 3;
    const cols = Math.max(1, Math.floor((this.width() - 2) / colw));
    const rows = [];
    for (let i = 0; i < names.length; i += cols)
      rows.push('  ' + names.slice(i, i + cols).map(n => A.cyan(('/' + n).padEnd(colw))).join(''));
    this.out(rows.join('\n') + '\n' + A.gray('  Tab completes · Enter sends'));
  }

  send(o) { try { this.ws.send(JSON.stringify(o)); } catch {} }

  // Every renderer in this file writes through out(). When a sink is installed
  // it collects instead of printing, which is what lets the very same functions
  // that were byte-matched against the real CLI be re-run on every repaint.
  out(s) {
    if (s == null) return;
    if (this.sink) { this.sink.push(...String(s).split('\n')); return; }
    if (!this.tty) { process.stdout.write(s + '\n'); return; }
    this.push({ t: 'lines', lines: String(s).split('\n') });
  }
  // Run a renderer and capture what it drew, instead of letting it reach the
  // screen. Re-entrant: nested captures restore the outer sink.
  capture(fn) {
    const prev = this.sink;
    this.sink = [];
    try { fn(); } finally { var got = this.sink; this.sink = prev; }
    return got;
  }
  push(entry) {
    this.entries.push(entry);
    if (this.scroll === 0) this.paint(); else { this.paint(); }
  }

  // Deltas arrive a token at a time. In a repainting client they can't be
  // written straight to the screen, so they accumulate into a live entry that
  // the paint loop renders like any other.
  raw(s) {
    if (this.sink) { this.sink.push(String(s)); return; }
    if (!this.tty) { process.stdout.write(s); return; }
    this.stream = (this.stream || '') + s;
    this.paint();
  }
  endStream() {
    if (this.streaming) {
      if (!this.tty) process.stdout.write('\n');
      else if (this.stream) { this.push({ t: 'lines', lines: this.stream.split('\n') }); this.stream = ''; }
      this.streaming = false;
    }
    this.lastDeltaKind = null;
  }
  drawPrompt() { this.paint(); }

  // ── the frame ────────────────────────────────────────────────────────────
  // Everything above the live region, re-rendered from the model. Consecutive
  // settled tool calls of the same kind fold into one rollup line when the view
  // is collapsed, which is why this groups rather than mapping one-to-one.
  transcriptLines() {
    const out = [];
    const es = this.entries;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.t !== 'tool') { out.push(...e.lines); continue; }
      if (!this.collapsed || !this.settled(e) || NEVER_COLLAPSE.has(e.block.name) || e.sub) {
        // Re-rendering every tool on every frame costs real CPU once a session
        // is long and the spinner is painting at 8 Hz, so a settled call caches
        // its lines. The key carries everything that changes them; tool_end
        // clears it explicitly, since the block mutates in place.
        const key = `${this.collapsed}:${this.width()}`;
        if (e.cacheKey !== key || !e.cached) {
          e.cached = this.capture(() => this.renderToolCall(e.block, e.sub, e.w, e.gap));
          e.cacheKey = this.settled(e) ? key : null;   // in flight: never cached
        }
        out.push(...e.cached);
        continue;
      }
      // Fold this run of same-kind settled calls into one line.
      const name = e.block.name;
      let n = 0;
      while (i + n < es.length) {
        const x = es[i + n];
        if (x.t !== 'tool' || x.block.name !== name || !this.settled(x) || x.sub) break;
        n++;
      }
      i += n - 1;
      const roll = ROLLUP[name] || (k => `Used ${prettyToolName(name, e.block.input)} ${k} time${k === 1 ? '' : 's'}`);
      if (e.gap) out.push('');
      out.push('  ' + roll(n));
      // A failure never hides behind a rollup — that is the one thing you needed
      // to see. The count line stays, and the error hangs off it.
      for (let k = 0; k < n; k++) {
        const x = es[i - n + 1 + k];
        if (x.block.status === 'error') out.push(...this.capture(() =>
          this.out(elbowBlock(this.toolResult(x.block.name, x.block.result, x.block.resultMeta, 'error'), ''))));
      }
    }
    if (this.stream) out.push(...this.stream.split('\n'));
    return out;
  }
  settled(e) { return e.block && e.block.status && e.block.status !== 'running' && e.block.result != null; }

  // ── the live region ──────────────────────────────────────────────────────
  // Everything that is still changing: the open card, the spinner, the input box
  // and the status footer. It is redrawn every frame and never commits to the
  // transcript, so a card can be dismissed and a bullet can be repainted.
  liveLines() {
    const W = this.width();
    const rule = A.gray('─'.repeat(W));
    const out = [];
    this.cursorRow = null;

    if (this.open) { out.push(...this.cardLines()); out.push(''); }
    else if (this.state.status === 'busy') out.push(this.spinnerLine());

    out.push(rule);
    // The input line, with the cursor tracked so paint() can place it. Long
    // input scrolls horizontally rather than growing the region.
    // One row per line of input: a paragraph pasted or brought back from Ctrl-G's
    // editor shows as it was written, not folded onto one row with ⏎ marks.
    const lead = '❯ ';
    const room = Math.max(8, W - lead.length);
    const rows = this.line.split('\n');
    let at = 0, cr = 0, cc = this.cursor;
    for (let i = 0; i < rows.length; i++) {
      if (this.cursor <= at + rows[i].length) { cr = i; cc = this.cursor - at; break; }
      at += rows[i].length + 1;
    }
    rows.forEach((r, i) => {
      const from = i === cr ? Math.max(0, cc - room + 1) : 0;
      out.push((i ? A.gray('  ') : A.gray(lead)) + r.slice(from, from + room));
      if (i === cr) { this.cursorRow = out.length - 1; this.cursorCol = lead.length + (cc - from); }
    });
    out.push(rule);
    out.push(...this.footerLines());
    return out;
  }

  // The spinner is the one thing that has to redraw with no event behind it, so
  // busy state owns a timer. It stops the moment the turn ends — a ticking
  // frame on an idle session is worse than no spinner at all.
  //
  // The timer follows the STATE, not the event that last mentioned it: a snapshot says
  // busy too — attaching mid-turn used to paint the row once, at 0s, and leave it
  // there, since only a status event started the clock — and the turn's own start
  // comes from the mux, so the count means the same thing on every client.
  setBusy(busy) {
    this.state.status = busy ? 'busy' : 'idle';
    this.syncBusy();
  }
  syncBusy() {
    const busy = this.state.status === 'busy';
    if (busy && !this.spinTimer && this.tty) {
      this.turnStart = this.state.turnStartedAt || Date.now();
      this.spinTimer = setInterval(() => this.paint(), 120);
      if (this.spinTimer.unref) this.spinTimer.unref();
    }
    if (!busy && this.spinTimer) { clearInterval(this.spinTimer); this.spinTimer = null; }
    this.paint();
  }

  // Agents that were launched and have not reported back, the way the CLI
  // keeps a count in its footer.
  agentTally() {
    const n = this.agents.size;
    return n ? A.gray(` · ← ${n} agent${n === 1 ? '' : 's'}`) : '';
  }

  spinnerLine() {
    const t = Date.now();
    const started = this.state.turnStartedAt || this.turnStart;
    const secs = started ? Math.round((t - started) / 1000) : 0;
    // What the child says it is doing beats a whimsical verb — 'Compacting' above all,
    // which runs for half a minute and otherwise looks like a stalled session.
    const act = this.state.activity;
    const verb = (act && act !== 'requesting')
      ? act.charAt(0).toUpperCase() + act.slice(1)
      : SPIN_VERBS[Math.floor(t / 4000) % SPIN_VERBS.length];
    const frame = SPIN_FRAMES[Math.floor(t / 120) % SPIN_FRAMES.length];
    const tok = this.state.outTokens ? ` · ↓ ${this.state.outTokens} tokens` : '';
    return A.yellow(frame) + A.gray(` ${verb}… (${secs}s${tok})`) +
      (this.queued ? A.gray(`  ·  ${this.queued} queued`) : '');
  }

  // The stats row is the user's own status line when they have configured one — it
  // prints the same facts and more, from the same script Claude Code would run, so
  // two rows saying nearly the same thing would just disagree at the edges. The MODE
  // row stays either way: permission mode, the other controllers on this session and
  // the ctrl+o hint are mux facts, and no status-line script can know them.
  footerLines() {
    const st = this.state;
    const cost = st.agent === 'codex' ? (st.cost == null ? 'cost: —' : `~$${Number(st.cost).toFixed(2)}`) : (st.cost ? `$${Number(st.cost).toFixed(2)}` : '$0.00');
    const ctx = st.contextTokens ? `ctx:${Math.round(st.contextTokens / 1000)}k` : null;
    const bits = [st.model || '?', cost, st.turns != null ? `turns:${st.turns}` : null, ctx].filter(Boolean);
    const mode = st.permissionMode || 'manual';
    const mark = mode === 'default' || mode === 'manual' ? '⏸' : '⏵⏵';
    const peers = (this.peers || []).filter(p => p.label !== this.label);
    const who = peers.length ? A.gray(` · ${peers.length} other controller${peers.length === 1 ? '' : 's'}`) : '';
    // A script that has not produced a line yet (first run in flight, or it printed
    // nothing) falls back rather than leaving a blank row where numbers were.
    const sl = this.statusLine.lines;
    const head = sl.length ? sl.map(l => '  ' + l) : [A.gray('  ' + bits.join('  '))];
    return [
      ...head,
      A.gray(st.agent === 'codex' ? '  Codex' : `  ${mark} ${mode} mode`) + who + this.agentTally() +
        A.gray(this.collapsed ? ' · ctrl+o for detail' : ' · ctrl+o to collapse') +
        (this.scroll ? A.yellow(`  ↑${this.scroll} lines up · End to follow`) : ''),
    ];
  }

  paint() {
    // A capture in progress means a renderer is being replayed to collect its
    // lines; painting from inside one would recurse through cardLines().
    if (!this.tty || this.painting || this.sink || this.editing) return;
    this.painting = true;
    try {
      const H = this.height();
      const live = this.liveLines();
      const room = Math.max(1, H - live.length);
      const all = this.transcriptLines();
      const maxUp = Math.max(0, all.length - room);
      if (this.scroll > maxUp) this.scroll = maxUp;
      const start = maxUp - this.scroll;
      const view = all.slice(start, start + room);
      while (view.length < room) view.push('');
      const frame = view.concat(live).map(l => l + '\x1b[K').join('\r\n');
      let seq = '\x1b[H' + frame + '\x1b[J';
      // The cursor lives in the input line, at the column the editor says.
      if (this.cursorRow != null) seq += `\x1b[${room + this.cursorRow + 1};${this.cursorCol + 1}H` + SHOW;
      else seq += HIDE;
      process.stdout.write(seq);
    } finally { this.painting = false; }
  }
  // Subagent output hangs off a gutter, the way the CLI nests a Task's work.
  gut(parentToolUseId) { return parentToolUseId ? A.gray('│ ') : ''; }

  onOpen() { this.out(A.gray('— attaching —')); }

  onSigint() {
    const now = Date.now();
    if (now - this.lastCtrlC < 1500) return this.quit('detached');
    this.lastCtrlC = now;
    this.send({ op: 'interrupt' });
    this.out(A.gray('(interrupt sent — Ctrl-C again to detach)'));
  }

  // ── keys ─────────────────────────────────────────────────────────────────
  // One dispatcher for the whole client. A card, when open, claims navigation
  // and Enter; everything else falls through to the line editor.
  onKey(ch, key) {
    const name = key.name || '';
    if (key.ctrl && name === 'c') return this.onSigint();
    if (key.ctrl && name === 'd' && !this.line) { this.quit('detached'); return; }
    if (key.ctrl && name === 'o') { this.collapsed = !this.collapsed; return this.paint(); }
    if (key.ctrl && name === 'g') return this.editLine();
    if (name === 'pageup')   { this.scroll += Math.max(1, this.height() - 8); return this.paint(); }
    if (name === 'pagedown') { this.scroll = Math.max(0, this.scroll - Math.max(1, this.height() - 8)); return this.paint(); }
    if (name === 'end' && !this.line) { this.scroll = 0; return this.paint(); }

    if (this.open && this.onCardKey(ch, key, name)) return;

    switch (name) {
      case 'return': case 'enter': return this.submitLine();
      case 'escape': this.send({ op: 'interrupt' }); return;
      case 'backspace':
        if (this.cursor > 0) { this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor); this.cursor--; }
        return this.afterEdit();
      case 'delete':
        this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
        return this.afterEdit();
      case 'left':  this.cursor = Math.max(0, this.cursor - 1); return this.paint();
      case 'right': this.cursor = Math.min(this.line.length, this.cursor + 1); return this.paint();
      case 'home':  this.cursor = 0; return this.paint();
      case 'end':   this.cursor = this.line.length; return this.paint();
      case 'up':    return this.recall(-1);
      case 'down':  return this.recall(1);
      case 'tab':   return this.tabComplete();
    }
    if (key.ctrl) {
      if (name === 'a') { this.cursor = 0; return this.paint(); }
      if (name === 'e') { this.cursor = this.line.length; return this.paint(); }
      if (name === 'u') { this.line = this.line.slice(this.cursor); this.cursor = 0; return this.afterEdit(); }
      if (name === 'k') { this.line = this.line.slice(0, this.cursor); return this.afterEdit(); }
      if (name === 'w') {
        const head = this.line.slice(0, this.cursor).replace(/\S+\s*$/, '');
        this.line = head + this.line.slice(this.cursor); this.cursor = head.length;
        return this.afterEdit();
      }
      return;
    }
    if (ch && !key.meta && ch >= ' ' && ch !== '\x7f') {
      this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
      this.cursor += ch.length;
      // "/" on an empty line is the CLI's cue to open its command menu; here the
      // list is one keystroke away rather than always on screen.
      if (ch === '/' && this.line === '/') this.commandHint();
      return this.afterEdit();
    }
  }
  afterEdit() { this.scroll = 0; this.paint(); }
  // Leave the alternate buffer BEFORE saying anything, or the parting line is
  // written to a screen that is about to be discarded.
  quit(why) {
    if (this.restore) this.restore();
    process.stdout.write(A.gray(`— ${why} —`) + '\n');
    process.exit(0);
  }

  // Card navigation. Returns true when the key was consumed.
  onCardKey(ch, key, name) {
    const o = this.open;
    if (o.requestKind === 'dialog') return false;
    const q = this.currentQuestion();
    const count = (o.options || []).length || (q ? q.options.length + 1 : 0);
    // A free-text answer borrows the input line; while it is being typed the
    // card stops claiming keys except Esc, which backs out of it.
    if (o.typing != null) {
      if (name === 'escape') { o.typing = null; this.line = ''; this.cursor = 0; this.paint(); return true; }
      if (name === 'return' || name === 'enter') {
        const text = this.line.trim();
        this.line = ''; this.cursor = 0; o.typing = null;
        if (text) this.pickQuestion([text]); else this.paint();
        return true;
      }
      return false;                       // let the editor have the character
    }
    if (name === 'up')   { o.sel = (o.sel - 1 + count) % count; this.paint(); return true; }
    if (name === 'down') { o.sel = (o.sel + 1) % count; this.paint(); return true; }
    if (q && name === 'left' && !this.line)  { this.stepQuestion(-1); return true; }
    if (q && name === 'right' && !this.line) { this.stepQuestion(1); return true; }
    if (q && q.multiSelect && ch === ' ' && !this.line) {
      o.multi = o.multi || new Set();
      if (o.sel < q.options.length) { o.multi.has(o.sel) ? o.multi.delete(o.sel) : o.multi.add(o.sel); }
      this.paint(); return true;
    }
    // A digit picks directly, the way it always has — but only on an empty line,
    // so a number inside a typed message still reaches the model.
    if (!this.line && /^[1-9]$/.test(ch || '')) { o.sel = Math.min(count - 1, Number(ch) - 1); this.paint(); return true; }
    if (name === 'return' || name === 'enter') { this.confirmCard(); return true; }
    if (name === 'escape') { this.send({ op: 'interrupt' }); return true; }
    return false;
  }

  stepQuestion(d) {
    const o = this.open;
    const qs = o.payload.input.questions || [];
    o.qIndex = Math.max(0, Math.min(qs.length - 1, o.qIndex + d));
    o.sel = 0; o.multi = null;
    this.paint();
  }

  confirmCard() {
    const o = this.open;
    const q = this.currentQuestion();
    if (!q) return this.answerPermission(o.sel + 1);
    if (o.sel === q.options.length) { o.typing = ''; this.line = ''; this.cursor = 0; return this.paint(); }
    if (q.multiSelect) {
      const set = o.multi && o.multi.size ? [...o.multi] : [o.sel];
      return this.pickQuestion(set.map(i => q.options[i].label));
    }
    return this.pickQuestion([q.options[o.sel].label]);
  }

  // Record one question's answer and either walk on or submit the whole card.
  pickQuestion(picks) {
    const o = this.open;
    const q = this.currentQuestion();
    const qs = o.payload.input.questions || [];
    const all = { ...(o.picks || {}) };
    all[q.id || q.question] = q.multiSelect ? picks : picks[0];
    o.picks = all; o.multi = null; o.sel = 0;
    const next = o.qIndex + 1;
    if (next < qs.length) { o.qIndex = next; return this.paint(); }
    this.send({ op: 'answer', requestId: o.requestId, picks: all });
    this.open = null;
    this.paint();
  }

  // ── input ────────────────────────────────────────────────────────────────
  // Ctrl-G, as in the CLI: the line goes to $VISUAL / $EDITOR (vim failing both) and
  // comes back as the line. The editor needs the real terminal, so the screen is
  // handed over — cooked keys, primary buffer — and taken back when it exits; the
  // socket stays up meanwhile, and everything it delivers waits for the repaint
  // rather than being drawn over the editor.
  editLine() {
    if (!this.tty || this.editing) return;
    const fs = require('fs'), os = require('os'), path = require('path');
    const { spawnSync } = require('child_process');
    const file = path.join(os.tmpdir(), `ccbb-mux-${process.pid}-${Date.now()}.md`);
    try { fs.writeFileSync(file, this.line, { mode: 0o600 }); } catch { return; }
    const ed = process.env.VISUAL || process.env.EDITOR || 'vim';
    this.editing = true;
    process.stdin.setRawMode(false); process.stdin.pause();
    process.stdout.write(SHOW + ALT_OFF);
    // Through the shell so an EDITOR with arguments ("code -w") works as it does anywhere.
    const r = spawnSync(`${ed} '${file}'`, { shell: true, stdio: 'inherit' });
    process.stdout.write(ALT_ON + HIDE);
    process.stdin.setRawMode(true); process.stdin.resume();
    this.editing = false;
    if (r.status === 0) {
      try { this.line = fs.readFileSync(file, 'utf8').replace(/\r?\n$/, ''); } catch {}
      this.cursor = this.line.length;
    }
    try { fs.unlinkSync(file); } catch {}
    this.paint();
  }
  submitLine() {
    const t = this.line.trim();
    this.line = ''; this.cursor = 0;
    if (t) { this.history.push(t); this.histAt = this.history.length; }
    this.scroll = 0;
    if (!t) return this.paint();
    this.onInput(t);
    this.paint();
  }
  recall(d) {
    if (!this.history.length) return;
    this.histAt = Math.max(0, Math.min(this.history.length, this.histAt + d));
    this.line = this.history[this.histAt] || '';
    this.cursor = this.line.length;
    this.paint();
  }
  tabComplete() {
    const [hits, line] = this.complete(this.line);
    if (!hits.length) return;
    if (hits.length === 1) { this.line = hits[0]; this.cursor = this.line.length; return this.afterEdit(); }
    // Advance to the longest common prefix, then show what is left to choose.
    let pre = hits[0];
    for (const h of hits) { while (!h.startsWith(pre)) pre = pre.slice(0, -1); }
    if (pre.length > line.length) { this.line = pre; this.cursor = pre.length; }
    this.showCommands(this.line.replace(/^\//, ''));
  }

  onInput(line) {
    const t = line.trim();
    if (!t) return this.drawPrompt();

    if (t.startsWith('//')) return this.localCommand(t.slice(2));
    // A digit while a card is open answers the card, not the model — same as the CLI.
    if (this.open && /^[?\d]/.test(t)) return this.answerOpen(t);
    // A bare "/" — or one that matches nothing — lists instead of sending a turn
    // the child would only reject. Anything that does name a command goes
    // through as ordinary text: slash commands are the child's to interpret.
    if (/^\/[^/\s]*$/.test(t)) {
      const name = t.slice(1);
      if (!name || !this.commandNames().includes(name)) return this.showCommands(name);
    }
    this.send({ op: 'submit', text: t });
    this.drawPrompt();
  }

  localCommand(rest) {
    const [cmd, ...args] = rest.split(/\s+/);
    const arg = args.join(' ');
    if (cmd === 'mode')  { this.send({ op: 'set_mode', mode: arg }); return this.out(A.gray(`→ permission mode ${arg}`)); }
    if (cmd === 'model') { this.send({ op: 'set_model', model: arg }); return this.out(A.gray(`→ model ${arg}`)); }
    if (cmd === 'snap')  { this.send({ op: 'snapshot' }); return; }
    if (cmd === 'who')   { this.send({ op: 'ping' }); return this.out(A.gray('attached: ' + (this.peers || []).map(p => `${p.label} (${p.kind})`).join(', '))); }
    if (cmd === 'help')  { attachHelp(); return this.drawPrompt(); }
    this.out(A.gray(`unknown local command //${cmd}`));
  }

  // Answering a card. "1" / "1,3" for options, "?free text" for an Other pick.
  answerOpen(t) {
    const o = this.open;
    if (o.requestKind === 'question') {
      const q = o.payload.input.questions[o.qIndex || 0];
      // "1", "1,3", "?free text", or a mix: "1,?free text". A free-text part is
      // what the plugin's "Other" box produces — the typed text REPLACES the
      // option label, it doesn't accompany it.
      const picks = [];
      for (const part of t.split(',')) {
        const v = part.trim();
        if (!v) continue;
        if (v.startsWith('?')) { const free = v.slice(1).trim(); if (free) picks.push(free); continue; }
        const n = parseInt(v, 10);
        // The trailing "Type something." entry is a prompt, not an option — it
        // has no label to send, so point at the syntax that does carry text.
        if (n === q.options.length + 1) return this.out(A.gray('  type ?your own text to answer in your own words'));
        const opt = q.options[n - 1];
        if (opt) picks.push(opt.label); else return this.out(A.red(`no option ${v}`));
      }
      if (!picks.length) return this.out(A.red('nothing picked'));
      if (!q.multiSelect && picks.length > 1) return this.out(A.red('this question takes one answer'));
      const all = { ...(o.picks || {}) };
      all[q.id || q.question] = q.multiSelect ? picks : picks[0];
      // Multi-question cards walk one tab at a time, the way the plugin's tabs do.
      const next = (o.qIndex || 0) + 1;
      if (next < o.payload.input.questions.length) {
        this.open = { ...o, qIndex: next, picks: all };
        return this.renderQuestion(this.open);
      }
      this.send({ op: 'answer', requestId: o.requestId, picks: all });
      this.open = null;
      return;
    }
    return this.answerPermission(parseInt(t, 10));
  }

  // Permission card: 1 allow, 2 allow-and-remember, 3 deny. For ExitPlanMode the
  // same three slots mean accept-with-acceptEdits / accept / keep planning.
  answerPermission(n) {
    const o = this.open;
    if (!o) return;
    const isPlan = o.payload.tool_name === 'ExitPlanMode';
    if (n === 1) this.send({ op: 'answer', requestId: o.requestId, allow: true, planMode: isPlan ? 'acceptEdits' : undefined });
    else if (n === 2) this.send({ op: 'answer', requestId: o.requestId, allow: true,
      updatedPermissions: isPlan ? undefined : (o.payload.permission_suggestions || undefined) });
    else if (n === 3) this.send({ op: 'answer', requestId: o.requestId, allow: false,
      message: isPlan ? 'Keep planning' : 'Denied from ccbb' });
    else return this.out(A.red('choose 1, 2 or 3'));
    this.open = null;
    this.paint();
  }

  // ── rendering ────────────────────────────────────────────────────────────
  onMessage(m) {
    if (m.seq) this.seq = m.seq;
    if (m.op === 'snapshot') return this.onSnapshot(m);
    if (m.op === 'resumed') {
      // Behind our own seq: the mux restarted and this transcript belongs to a dead
      // process. Re-attach with no sinceSeq to get a snapshot instead of drifting.
      if (m.seq != null && m.seq < this.seq) {
        this.seq = 0;
        return this.send({ op: 'snapshot' });
      }
      return this.out(A.gray(`— resumed from #${m.from} —`));
    }
    if (m.op === 'presence') { this.peers = m.clients; return this.drawPrompt(); }
    if (m.op === 'ack') { if (m.error) this.out(A.red('! ' + m.error)); return; }
    if (m.op !== 'event') return;
    return this.onEvent(m);
  }

  onSnapshot(m) {
    this.state = m.state || {};
    this.syncBusy();
    this.statusLine.update(this.state, this.lastUsage);
    this.peers = m.clients || [];
    this.out(A.gray(`— ${this.state.title || this.state.label || this.state.id} · ${this.state.cwd} · ${this.state.messages || (m.messages || []).length} messages —`));
    // An exited session stays in the mux so its transcript stays readable, and a name
    // still resolves to it once nothing live holds that name — so `ccbb attach api`
    // can land on a dead session. It renders, it accepts typing, and nothing answers.
    // Say so on the way in rather than let it look like a session that is merely quiet.
    if (this.state.status === 'exited') {
      const ex = this.state.exit || {};
      this.out(A.red(`— this session has exited${ex.code != null ? ` (code ${ex.code})` : ''}; ` +
        'its transcript is readable but nothing will answer. Start a new one with `ccbb new`. —'));
    }
    for (const msg of (m.messages || [])) this.renderMessage(msg);
    for (const p of (m.pending || [])) this.renderRequest(p);
    this.drawPrompt();
  }

  onEvent(e) {
    switch (e.kind) {
      case 'init':
        this.state = e.state || this.state;
        this.syncBusy();
        return this.out(A.gray(`— ${this.state.model} · ${(this.state.tools || []).length} tools · ${this.state.permissionMode || 'manual'} —`));
      case 'message': return this.renderMessage(e.message);
      case 'delta': {
        // Live token stream. Thinking is dimmed; tool-input JSON deltas are noise
        // in a terminal, so they're dropped rather than shown raw. The message id
        // is remembered so the final copy of the same message — which the child
        // sends in full right after — isn't printed a second time.
        if (e.deltaKind === 'input') return this.pendingInput(e);
        if (e.messageId) this.streamed.add(e.messageId);
        // A block boundary inside one message: thinking must not run straight
        // into the prose that follows it on the same line.
        if (this.lastDeltaKind !== e.deltaKind) {
          this.endStream();
          this.lastDeltaKind = e.deltaKind;
          // Streamed prose gets the same blank line and bullet a replayed block
          // does, so a turn doesn't look different depending on how it arrived.
          this.raw('\n' + (e.deltaKind === 'thinking' ? A.gray('✻ ') : DOT.done + ' '));
          this.streaming = true;
        }
        // Through raw(), not straight to stdout: under the repainting renderer a
        // direct write lands on a screen the next paint erases, and because the
        // message id is marked streamed the final copy is suppressed too — the
        // turn's prose would vanish entirely rather than merely flicker.
        return this.raw(e.deltaKind === 'thinking' ? A.gray(e.text) : e.text);
      }
      // The only word a stream-json child gives while a tool actually RUNS. Claude
      // Code's own TUI shows a Bash command's output growing because it runs the tool
      // itself; over stream-json that output does not exist until the result lands, so
      // what is shown instead is that execution has BEGUN and how long ago. Not the
      // same thing, and not pretending to be — but the gap between the tool_use block
      // and the first byte of result was three seconds in the probe, and that gap used
      // to look identical to a hung session.
      case 'tool_run': {
        const te = e.toolUseId && this.toolEntries.get(e.toolUseId);
        if (!te) return;
        if (e.phase === 'started') { te.block.runAt = Date.now(); te.block.runDesc = e.description || ''; }
        else { te.block.runAt = null; }
        te.cacheKey = null; te.cached = null;
        return this.paint();
      }
      case 'tool_end': {
        this.endStream();
        // Fold the result into the call's own entry so the next paint restates
        // the whole call — bullet colour included. Only when there is no entry
        // to fold into (a subagent's nested call) does the elbow stand alone.
        const entry = e.toolUseId && this.toolEntries.get(e.toolUseId);
        if (entry) {
          Object.assign(entry.block, { status: e.status, result: e.result, resultMeta: e.meta });
          entry.cacheKey = null; entry.cached = null;
          return this.paint();
        }
        const lines = this.toolResult(e.name, e.result, e.meta, e.status);
        return lines ? this.out(elbowBlock(lines, this.gut(e.parentToolUseId))) : undefined;
      }
      case 'result': {
        this.endStream();
        this.state.activity = null;
        this.setBusy(false);
        if (e.costUsd != null) this.state.cost = (this.state.cost || 0) + e.costUsd;
        this.state.turns = (this.state.turns || 0) + 1;
        const u = e.usage || {};
        this.state.contextTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
        this.lastUsage = u;
        this.statusLine.update(this.state, u);
        const why = e.isError ? (e.result || (e.errors || []).map(x => x.message || x).join('; ')) : '';
        // The CLI closes a turn with a whimsical verb, the elapsed time and the
        // wall clock — and no inline cost or token count; those live in the
        // status line, not in the scrollback.
        const secs = Math.max(1, Math.round((e.durationMs || 0) / 1000));
        const verb = TURN_VERBS[(this.turns = (this.turns || 0) + 1) % TURN_VERBS.length];
        const clock = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        if (e.isError) return this.out('\n' + A.red(`✻ failed after ${secs}s`) +
          (why ? '\n' + wrapLines(String(why), this.width() - 4).map(l => '  ' + A.red(l)).join('\n') : ''));
        return this.out('\n' + A.gray(`✻ ${verb} for ${secs}s · done ${clock}`));
      }
      case 'request': return this.renderRequest(e);
      // Someone else answered first. With a live card the right move is to ERASE
      // it, not to print a note under a card that is still on screen — so the
      // note only goes to the transcript when the card was ours to lose.
      case 'request_resolved': {
        const mine = this.open && this.open.requestId === e.requestId;
        if (mine) { this.open = null; this.line = ''; this.cursor = 0; }
        if (e.by === this.label) return this.paint();
        return this.out(A.gray(`  (answered ${e.decision} by ${e.by})`));
      }
      case 'request_cancelled':
        if (this.open && this.open.requestId === e.requestId) { this.open = null; this.line = ''; this.cursor = 0; }
        return this.out(A.gray('  (request withdrawn)'));
      case 'submitted':
        // Another controller's turn. Ours comes back as a `message` replay too,
        // so only foreign submissions are announced here.
        if (e.by !== this.label) return this.out(A.gray(`  ${e.by} queued a turn`));
        return;
      case 'interrupted': return this.out(A.yellow(`  ⎿ interrupted by ${e.by}`));
      case 'interrupt_done': {
        const n = (e.stillQueued || []).length;
        return this.out(A.gray(n ? `  ⎿ ${n} queued turn${n === 1 ? '' : 's'} still pending` : '  ⎿ queue cleared'));
      }
      // Both are documented status-line triggers, and both are things the user's
      // script is likely to print.
      case 'mode':  this.state.permissionMode = e.permissionMode;
        this.statusLine.update(this.state, this.lastUsage);
        return this.out(A.gray(`  mode → ${e.permissionMode} (${e.by})`));
      case 'model': this.state.model = e.model;
        this.statusLine.update(this.state, this.lastUsage);
        return this.out(A.gray(`  model → ${e.model} (${e.by})`));
      case 'status':
        this.state.activity = e.activity || null;
        this.state.turnStartedAt = e.turnStartedAt || null;
        if (e.exit) this.state.exit = e.exit;
        return this.setBusy(e.status === 'busy');
      // The transcript-derived figures (cost, turns, context) the web footer runs on;
      // the status-line script gets them too, so the two agree.
      case 'stats':
        for (const k of ['title', 'cost', 'tokens', 'turns', 'subTurns', 'contextTokens', 'contextPeak', 'contextMax'])
          if (e[k] != null) this.state[k] = e[k];
        this.statusLine.update(this.state, this.lastUsage);
        return this.paint();
      case 'compact_done':
        if (e.result === 'success') return this.out(A.gray('\n  — compacted —'));
        return this.out(A.red(`\n  — compaction ${e.result || 'failed'}${e.error ? ': ' + e.error : ''} —`));
      // The counter the spinner has always wanted to print and never had: the mux
      // coalesces the child's thinking-token events and forwards the running total.
      case 'thinking_tokens': this.state.outTokens = e.tokens || 0; return;
      case 'auth':  return this.out(A.yellow(`  auth: ${e.body && e.body.status || 'refreshing credentials…'}`));
      case 'retry': return this.out(A.yellow(`  retrying (${e.body && e.body.error}) attempt ${e.body && e.body.attempt}`));
      case 'hook':  return;                       // too chatty for the terminal; the web UI shows these
      case 'system':
        if (e.subtype === 'compact_boundary') {
          const md = (e.body && e.body.compact_metadata) || {};
          const span = md.pre_tokens
            ? `, ${Math.round(md.pre_tokens / 1000)}k → ${Math.round((md.post_tokens || 0) / 1000)}k` : '';
          const took = md.duration_ms ? `, ${Math.round(md.duration_ms / 1000)}s` : '';
          return this.out(A.gray(`\n  ── compacted (${md.trigger || 'manual'}${span}${took}) ──`));
        }
        return;
      case 'stderr': return this.out(A.red('  ' + String(e.text).trimEnd()));
      // Silent on purpose: the list feeds "/" and Tab, it isn't news.
      case 'commands': this.state.commands = e.commands || []; return;
      case 'rate_limit': case 'goal': case 'autocompact':
      case 'tool_pending': return this.pendingTool(e);
      case 'turn_start': case 'unknown':
        return;
      default: return;
    }
  }

  // A local slash command — /cost, /compact — in the shape the CLI shows it: the
  // command you typed, then its output under it. The child's own ANSI is left in
  // place, because this is a terminal and colour is how /cost tells its columns
  // apart; only the indent is ours. stderr tints red, which is the ONLY thing on the
  // wire that says the command failed.
  renderCommand(msg) {
    const c = msg.command;
    const w = this.width() - 2;
    const who = msg.by && msg.by !== this.label ? A.magenta(` (${msg.by})`) : '';
    if (c.name) this.out('\n' + A.gray('❯ ') + A.bold('/' + c.name + (c.args ? ' ' + c.args : '')) + who);
    if (c.kind !== 'out') return;
    const body = String(c.text || '').replace(/\s+$/, '');
    if (!body) return;
    const tint = c.stream === 'stderr' ? A.red : A.gray;
    this.out(body.split('\n').map(function (l) {
      return l.indexOf('\x1b') >= 0 ? '  ' + l : '  ' + tint(l);
    }).join('\n'));
  }

  renderMessage(msg) {
    this.endStream();
    const w = this.width() - 2;
    // Before the role branch on purpose: a command's result arrives as an assistant
    // message when it succeeds and as a replayed USER message after /compact, and
    // neither is a turn anybody said.
    if (msg.command) return this.renderCommand(msg);
    // The compaction summary — the whole conversation as one synthetic turn. The
    // boundary line above it already said what happened; the text itself is 30k
    // characters of recap nobody typed.
    if (msg.compact) return;
    if (msg.role === 'user') {
      if (msg.isMeta || msg.isSynthetic) return;
      const text = msg.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (!text.trim()) return;
      // A backgrounded agent reports back as a user message carrying the whole
      // task-notification envelope. Echoing that verbatim is the same leak the
      // launch metadata was; the CLI shows one line and so do we.
      // Anchored: the notification IS the message. A turn that merely quotes the tag
      // is a person talking, and printing it as "Task finished" ate the whole turn.
      if (/^<task-notification>[\s\S]*<\/task-notification>$/.test(text.trim())) return this.agentFinished(text);
      const who = msg.by && msg.by !== this.label ? A.magenta(` (${msg.by})`) : '';
      return this.out('\n' + A.gray('❯ ') + A.bold(wrap(text, w - 2, 0).replace(/\n/g, '\n  ')) + who);
    }
    const sub = this.gut(msg.parentToolUseId);
    // Already on screen a token at a time: keep the tool blocks (which never
    // stream usefully) and drop the prose we just printed.
    const wasStreamed = msg.apiId && this.streamed.has(msg.apiId);
    // The CLI separates every top-level block with a blank line; inside a
    // subagent's gutter it does not, so the nesting stays tight.
    const gap = sub ? '' : '\n';
    for (const b of msg.blocks) {
      // Assistant prose carries the same bullet as a tool call, with the
      // continuation lines hanging under the text rather than the bullet.
      if (b.type === 'text' && b.text.trim()) {
        if (!wasStreamed) this.out(gap + sub + DOT.done + ' ' + wrap(b.text, w - 2, 0).replace(/\n/g, '\n  '));
      }
      else if (b.type === 'thinking' && b.text.trim()) { if (!wasStreamed) this.out(gap + A.gray(A.italic(wrap('✻ ' + b.text, w, 0)))); }
      // A tool call is stored, not printed: its bullet has to be repaintable
      // when the result lands, and it has to re-render when ctrl+o flips the
      // view. The block is copied because tool_end mutates it in place.
      else if (b.type === 'tool_use') {
        if (!this.tty || this.sink) { this.renderToolCall(b, sub, w, gap); continue; }
        // Already on screen from the stream (pendingTool): this is the authoritative
        // copy of the same call, so it fills that entry in rather than adding a second.
        // Its result may have landed first — a settled outcome is never regressed.
        const have = b.id && this.toolEntries.get(b.id);
        if (have) {
          const keep = this.settled(have) ? { status: have.block.status, result: have.block.result, resultMeta: have.block.resultMeta } : {};
          const { runAt, runDesc } = have.block;
          have.block = { ...b, ...keep, runAt, runDesc };
          have.sub = sub; have.w = w; have.gap = gap;
          have.cacheKey = null; have.cached = null;
          this.paint();
          continue;
        }
        const entry = { t: 'tool', block: { ...b }, sub, w, gap };
        this.entries.push(entry);
        if (b.id) this.toolEntries.set(b.id, entry);
        this.paint();
      }
      else if (b.type === 'image') this.out(gap + sub + A.gray('  [image]'));
    }
  }

  // "⏺ Agent "Count txt files" finished · 18s", and the agent leaves the footer.
  // A <task-notification> — from an agent, or from a shell command started in the
  // background. The envelope's <status> is what tells the two outcomes apart, and it
  // was being ignored: a background command that FAILED printed the same green bullet
  // as one that succeeded.
  agentFinished(text) {
    const grab = re => (re.exec(text) || [])[1];
    const summary = (grab(/<summary>([\s\S]*?)<\/summary>/) || 'Task finished').trim();
    const ms = Number(grab(/<duration_ms>(\d+)<\/duration_ms>/) || 0);
    const status = (grab(/<status>([\s\S]*?)<\/status>/) || '').trim();
    const id = grab(/<task-id>([\s\S]*?)<\/task-id>/);
    if (id) this.agents.delete(id.trim());
    const bad = status === 'failed' || status === 'error' || /failed/.test(summary);
    this.out('\n' + (bad ? DOT.error : DOT.done) + ' ' +
      (bad ? A.red(summary) : A.bold(summary)) + (ms ? A.gray(` · ${Math.floor(ms / 1000)}s`) : ''));
  }

  // The elbow body for a settled tool, or null when nothing should be drawn.
  // Shared by the live tool_end event and the snapshot replay so a late joiner
  // sees the same rollups as everyone else.
  toolResult(name, result, meta, status) {
    if (name === 'TodoWrite' && status !== 'error') return null;
    const w = this.width() - CONT.length;
    // A denial arrives flagged as an error, so it has to be recognised before the
    // generic error path gets hold of it.
    if (REJECTED.test(resultText(result))) return toolResultLines(name, result, meta, w);
    if (status === 'error') {
      // The CLI labels a failure and wraps it; truncating an error hides the
      // part that says what to do about it.
      const text = resultText(result).replace(/^Error:\s*/, '');
      return hardWrapLines('Error: ' + text, w).slice(0, 8).map(l => A.red(l));
    }
    return toolResultLines(name, result, meta, w);
  }

  // One tool call. Most are a single line; the few whose ARGUMENTS are the thing
  // a human needs to read — a todo list, an edit, a plan — get their body drawn
  // here rather than waiting for a result that only says "done".
  // A tool call the stream has announced but the child has not yet delivered as a
  // message. With a real CLI the message with the tool_use block arrives when the
  // call is over, so waiting for it meant a run showed nothing at all until "Ran 12
  // shell commands" ticked over — the bullet goes up now, from the stream's word,
  // and the message fills it in later (renderMessage). Its arguments arrive as JSON
  // fragments; each is tried as a whole, then as a string cut off mid-value, so the
  // command being typed shows as far as it has got.
  pendingTool(e) {
    if (!this.tty || !e.id || this.toolEntries.has(e.id)) return;
    this.endStream();
    const sub = this.gut(e.parentToolUseId);
    const entry = { t: 'tool', sub, w: this.width() - 2, gap: sub ? '' : '\n',
      block: { type: 'tool_use', id: e.id, name: e.name, input: {}, status: 'running', result: null, parentToolUseId: e.parentToolUseId || null },
      partial: '' };
    this.entries.push(entry);
    this.toolEntries.set(e.id, entry);
    if (e.messageId != null && e.index != null) this.pendingByIndex.set(`${e.messageId}|${e.index}`, entry);
    this.paint();
  }
  pendingInput(e) {
    const entry = this.pendingByIndex.get(`${e.messageId}|${e.index}`);
    if (!entry || this.settled(entry)) return;
    entry.partial += e.text;
    let input = null;
    for (const tail of ['', '"}', '}']) {
      try { input = JSON.parse(entry.partial + tail); break; } catch {}
    }
    if (!input || typeof input !== 'object') return;
    entry.block.input = input;
    entry.cacheKey = null; entry.cached = null;
    this.paint();
  }

  renderToolCall(b, sub, w, gap) {
    const dot = DOT[b.status] || DOT.running;
    // An answered question is not shown as a tool call at all: the CLI reports
    // what the human said, and the call itself is plumbing.
    if (b.name === 'AskUserQuestion') {
      // The CLI puts a non-breaking space after the bullet on this one label —
      // every other bullet uses a plain space. Verified by codepoint.
      this.out(`${gap || ''}${sub}${dot} ${A.bold("User answered Claude's questions:")}`);
      const lines = b.result != null ? this.toolResult(b.name, b.result, b.resultMeta, b.status) : null;
      if (lines) this.out(elbowBlock(lines, sub));
      return;
    }
    const sum = toolSummary(b.name, b.input);
    const label = prettyToolName(b.name, b.input);
    // A long argument wraps with a two-space hang indent rather than being cut.
    // The CLI does the same, and on a path the tail is the part you need.
    let arg = '';
    if (sum) {
      const W = this.width();
      const first = Math.max(8, W - 3 - label.length), rest = Math.max(8, W - 3);
      const segs = [String(sum).slice(0, first)];
      for (let s = String(sum).slice(first); s.length; s = s.slice(rest)) segs.push(s.slice(0, rest));
      arg = A.gray('(') + segs.join('\n' + sub + '  ') + A.gray(')');
    }
    this.out(`${gap || ''}${sub}${dot} ${A.bold(label)}${arg}`);
    if (b.name === 'TodoWrite') { this.out(renderTodos(b.input && b.input.todos, w - 8)); this.bodyShown.add(b.id); }
    else if (b.name === 'Edit' || b.name === 'Write' || b.name === 'NotebookEdit') {
      // Nothing here: an edit's diff belongs to the permission card before the
      // fact and to the result elbow after it, where the patch supplies line
      // numbers and context. Drawing it at call time as well showed it twice.
    } else if (b.name === 'ExitPlanMode') { this.out(renderPlan(b.input && b.input.plan, w)); this.bodyShown.add(b.id); }
    // A backgrounded agent gets TWO elbows in the CLI's expanded view — the
    // launch notice and the prompt it was given — and a "how to reach it" hint
    // in the collapsed one. It is also the only tool whose result is a handle
    // rather than an answer, so it is tracked for the footer until it reports.
    const meta = b.resultMeta || {};
    if ((b.name === 'Task' || b.name === 'Agent') && b.result != null && b.status !== 'error' && meta.isAsync) {
      if (meta.agentId) this.agents.set(meta.agentId, meta.description || toolSummary(b.name, b.input));
      this.out(elbowBlock([A.gray('Backgrounded agent' +
        (this.collapsed ? ' (↓ to manage · ctrl+o to expand)' : ''))], sub));
      if (!this.collapsed && meta.prompt)
        this.out(elbowBlock([A.gray('Prompt:'),
          ...hardWrapLines(String(meta.prompt), w - 9).map(l => '  ' + l)], sub));
      return;
    }
    // In flight, and the child has told us it really started. Never cached: the
    // elapsed second changes under it (renderToolCall's cache key deliberately holds
    // only for settled calls).
    if (b.status === 'running' && b.runAt) {
      const secs = Math.round((Date.now() - b.runAt) / 1000);
      this.out(elbowBlock([A.gray(`running… (${secs}s)` + (b.runDesc ? ' · ' + b.runDesc : ''))], sub));
    }
    if (b.status !== 'running' && b.result != null) {
      const lines = this.toolResult(b.name, b.result, b.resultMeta, b.status);
      if (lines) this.out(elbowBlock(lines, sub));
    }
  }

  // A card is state, not output. It lives in the live region, so it can carry a
  // moving cursor and vanish when another controller answers first — neither of
  // which an append-only transcript can do.
  renderRequest(p) {
    this.endStream();
    this.open = { requestId: p.requestId, requestKind: p.requestKind, payload: p.payload,
      qIndex: 0, picks: {}, sel: 0, typing: null };
    if (this.tty && p.requestKind !== 'dialog') return this.paint();
    return this.printRequest(p);
  }

  // The card as lines, for the live region. Built by capturing the same
  // renderers the append-only path uses, then marking the selected row — so the
  // two paths can never drift apart.
  cardLines() {
    const o = this.open;
    const body = this.capture(() => this.printRequest({
      requestId: o.requestId, requestKind: o.requestKind, payload: o.payload }, o));
    const q = this.currentQuestion();
    const count = (o.options || []).length || (q ? q.options.length + 1 : 0);
    if (!count) return body;
    // The option rows are found by their numbering — the same numbering the
    // append-only path prints — and the cursor is laid over them. Nothing about
    // the card's own text changes, so the two paths cannot drift.
    let n = 0;
    return body.map(l => {
      const m = /^(\s*)(\d+)\. /.exec(l.replace(/\x1b\[[0-9;]*m/g, ''));
      if (!m || Number(m[2]) !== n + 1) return l;
      const i = n++;
      const mark = i === o.sel ? A.cyan('❯') : ' ';
      // A multi-select question carries a checkbox per option; "Type something."
      // is an action, not a choice, so it never gets one.
      const box = q && q.multiSelect && i < q.options.length
        ? (o.multi && o.multi.has(i) ? A.green('[✔] ') : A.gray('[ ] ')) : '';
      // Reclaim leading columns for the cursor and checkbox — the spaces to
      // strip sit AFTER any colour escapes, not at the start of the string.
      const text = l.replace(box ? /^((?:\x1b\[[0-9;]*m)*) +/ : /^((?:\x1b\[[0-9;]*m)*) /, '$1');
      const body = i === o.sel ? A.bold(text) : text;
      return box ? `${mark} ${box}${body}` : mark + body;
    });
  }
  currentQuestion() {
    const o = this.open;
    if (!o || o.requestKind !== 'question') return null;
    const qs = (o.payload.input && o.payload.input.questions) || [];
    return qs[o.qIndex] || qs[0] || null;
  }

  printRequest(p, open) {
    const target = open || this.open;
    if (p.requestKind === 'question') return this.renderQuestion(target);
    if (p.requestKind === 'dialog') {
      // Only two dialog kinds ship, and an unhandled one is parked by the child
      // rather than failed — so showing it and letting it sit is legal.
      return this.out(A.yellow(`\n? dialog: ${p.payload.dialog_kind}`) + A.gray('  (no ccbb handler — leaving it parked)'));
    }
    const inp = p.payload.input || {};
    const name = p.payload.tool_name;
    const w = this.width();
    this.out('');
    // The CLI heads the card with what KIND of thing is being asked for, and the
    // subject on its own line, rather than folding both into a Tool(args) line.
    this.out(' ' + A.bold(PERMISSION_HEADING[name] || `${prettyToolName(p.payload.display_name || name, inp)} tool`));
    this.out('');
    // Whatever the decision actually turns on gets shown in full. A permission
    // card that hides the command, the diff, or the plan is asking the human to
    // approve something they cannot see.
    const drawn = p.payload.tool_use_id && this.bodyShown.has(p.payload.tool_use_id);
    if (drawn) { /* already on screen from the tool call itself */ }
    else if (name === 'Bash' && inp.command) {
      this.out(String(inp.command).split('\n').slice(0, 8).map(l => '   ' + l).join('\n'));
      if (inp.description) this.out(A.gray('   ' + trunc(inp.description, w - 6)));
    }
    else if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit') {
      this.out('   ' + (base(inp.file_path || inp.notebook_path) || ''));
      this.out(A.gray('   ' + '╌'.repeat(Math.max(10, Math.min(60, w - 6)))));
      // Note: nothing is recorded in bodyShown here. A live card is re-rendered
      // on every paint, so marking its own body as "already shown" would make it
      // disappear on the second frame.
      const d = renderDiff(inp, null, w - 8);
      if (d) this.out(d);
    } else if (name === 'ExitPlanMode') this.out(renderPlan(inp.plan, w));
    else if (name === 'WebFetch' || name === 'WebSearch') this.out('   ' + (inp.url || inp.query || ''));
    else { const sum = toolSummary(name, inp); if (sum) this.out('   ' + trunc(sum, w - 6)); }
    this.out('');
    this.out(' ' + A.bold(PERMISSION_QUESTION[name]
      ? PERMISSION_QUESTION[name](base(inp.file_path || inp.notebook_path))
      : 'Do you want to proceed?'));
    // ExitPlanMode's three choices are not yes/yes-always/no — accepting a plan
    // also picks the permission mode the implementation runs under.
    target.options = name === 'ExitPlanMode'
      ? ['Yes, and auto-accept edits', 'Yes, and approve edits manually', 'No, keep planning']
      : ['Yes', `Yes, and always allow ${name === 'Bash' ? 'this command' : 'access'} in this project`, 'No'];
    target.options.forEach((label, i) => this.out(A.gray(` ${i + 1}. `) + label));
    this.out(A.gray(this.tty ? ' Enter to select · ↑/↓ to navigate · Esc to cancel'
                             : ' Type a number to answer · Esc to interrupt'));
    if (!this.tty) this.drawPrompt();
  }

  // One question at a time. The VS Code plugin renders a multi-question card as
  // tabs; a terminal walks them instead, which is the same thing serialized —
  // and the answers are only submitted once the last one is picked, so a
  // half-answered card never reaches the child.
  renderQuestion(o) {
    const qs = o.payload.input.questions || [];
    const q = qs[o.qIndex] || qs[0];
    if (!q) return;
    const w = this.width();
    this.out('');
    // The tab strip, with the CLI's ☐/☒ answered marks and its ✔ Submit stop.
    // A single question still gets its header line — the CLI shows one too.
    const answered = x => o.picks && o.picks[x.id || x.question] != null;
    const tabs = qs.map((x, i) => {
      const label = `${answered(x) ? '☒' : '☐'} ${x.header || `Q${i + 1}`}`;
      return i === o.qIndex ? A.bold(A.cyan(label)) : answered(x) ? A.green(label) : A.gray(label);
    });
    if (qs.length > 1) tabs.push(A.gray('✔ Submit'));
    this.out(' ' + tabs.join('  '));
    this.out('');
    this.out(' ' + A.bold(wrap(q.question, w - 2, 0).replace(/\n/g, '\n ')));
    this.out('');
    // Descriptions go on their own indented line under the label — inline they
    // compete with the label for the same row and get truncated first.
    q.options.forEach((opt, i) => {
      this.out(A.gray(`  ${i + 1}. `) + opt.label);
      if (opt.description) this.out(A.gray(wrap(opt.description, w - 8, 5)));
    });
    this.out(A.gray(`  ${q.options.length + 1}. `) + 'Type something.' +
      (this.tty ? '' : A.gray(`   (answer with ?your own text${q.multiSelect ? ', mixable: 1,?other' : ''})`)));
    if (this.tty) {
      // With a cursor and a real selection, the escape hatch is a live text
      // field rather than a "?" prefix, so the hint changes with it.
      if (o.typing != null) this.out(A.gray(' Type your answer, then Enter · Esc to go back'));
      else this.out(A.gray(' Enter to select · ↑/↓ to navigate' +
        (q.multiSelect ? ' · Space to toggle' : '') +
        (qs.length > 1 ? ' · ←/→ for questions' : '') + ' · Esc to cancel'));
    } else this.out(A.gray(q.multiSelect
      ? ' Type numbers to select · 1,3 for several · Esc to interrupt'
      : ' Type a number to select · Esc to interrupt'));
    if (!this.tty) this.drawPrompt();
  }
}

module.exports = { runAttach };
