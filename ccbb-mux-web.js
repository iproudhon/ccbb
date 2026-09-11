#!/usr/bin/env node
'use strict';
// ccbb-mux-web — the browser client for a mux session.
//
// This is P3 of ccbb-mux-plan.md, and it is a SECOND renderer over the mux's own
// protocol, not a second copy of ccbb-web.js. Nothing here reads a tmux pane or a
// transcript JSONL; it attaches to `ws /mux` exactly the way ccbb-mux-tui.js does
// and renders the same normalized events. `ccbb-web.js` and `ccbb-mobile.js` (the
// tmux-path clients) are deliberately untouched — the two routes stay separate
// until this one is verified.
//
// Mounting, not serving. The mux already owns an HTTP server, a port and a token;
// standing up a second one would mean a second origin, CORS on the WebSocket and a
// token copied between two places. `mount(mux)` returns one request handler that
// ccbb-mux.js calls for requests its own /api routes did not claim, so the page,
// its assets and the socket all share one origin. That is also the whole of the
// edit to ccbb-mux.js: if the claim "the mux is renderer-agnostic" is true, adding
// a renderer must not cost the mux more than a single delegation.
//
// Fidelity target (plan §5, Amendment 2): the VS Code webview, not the terminal.
// The tool renderer registry below is a port of `nZ()` from
//   ~/.vscode/extensions/anthropic.claude-code-<v>/webview/index.js
// read at 2.1.245 and re-read at 2.1.252 — same 23 named renderers, same
// `Task`→`Agent` alias, same three-step fallback chain, so the shape is stable
// across builds rather than a snapshot of one.
//
// Where this deliberately DIVERGES from the plugin: the plugin's message dispatch
// drops any message carrying `parent_tool_use_id`, so subagent work is invisible.
// ccbb-mux-tui.js nests it under a rule instead, and two ccbb renderers disagreeing
// with each other is worse than one of them disagreeing with the plugin — so this
// nests too.

const ATTACH_PATHS = ['/', '/index.html'];

// ── Theme ────────────────────────────────────────────────────────────────────
// The plugin styles entirely from VS Code's CSS variables. Keeping the variable
// NAMES means a Dark+ mapping and a ccbb mapping are each one block, and a port of
// any further plugin CSS lands without renaming anything.
//
// Every rule is scoped under .muxv — the class the factory puts on its root — for
// one reason: this stylesheet is now loaded into ccbb-web.js's page alongside its
// own, and both files style a transcript. Unscoped, `.msg` and `@keyframes pulse`
// are defined by BOTH, and whichever loads second silently wins for both clients.
// The mux's inner classes that ccbb-web.js also uses (msg, wrap) carry an mx-
// prefix for the same reason: scoping stops this leaking OUT, prefixing stops
// ccbb-web.js's higher-specificity rules (.sv .msg) leaking IN.
//
// The five bare-element rules are hand-translated, not prefixed. `.muxv body`
// matches nothing, so mechanical prefixing would compile clean and drop the
// layout — the flex column that makes the transcript scroll instead of growing.
const APP_CSS = `
.muxv {
  --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --vscode-editor-font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --vscode-font-size: 14px;
  --vscode-editor-background: #ffffff;
  --vscode-editor-foreground: #1f2328;
  --vscode-sideBar-background: #f6f7f9;
  --vscode-panel-border: #d8dbe0;
  --vscode-descriptionForeground: #6a737d;
  --vscode-textLink-foreground: #0a66c2;
  --vscode-textBlockQuote-background: #f2f4f7;
  --vscode-textCodeBlock-background: #f2f4f7;
  --vscode-button-background: #1f6feb;
  --vscode-button-foreground: #ffffff;
  --vscode-button-secondaryBackground: #e6e8eb;
  --vscode-button-secondaryForeground: #1f2328;
  --vscode-input-background: #ffffff;
  --vscode-input-foreground: #1f2328;
  --vscode-input-border: #d8dbe0;
  --vscode-focusBorder: #1f6feb;
  --vscode-charts-green: #1a7f37;
  --vscode-charts-red: #cf222e;
  --vscode-charts-yellow: #9a6700;
  --vscode-diffEditor-insertedTextBackground: #e6ffec;
  --vscode-diffEditor-removedTextBackground: #ffebe9;
  --ccbb-accent: #b95d1f;
}
/* Was a bare  * { box-sizing }  on the page. Scoped to the subtree so embedding the view
   in ccbb-web.js cannot change the box model of anything outside it. */
.muxv, .muxv * { box-sizing: border-box; }
/* Was the html, body pair. The root is the flex column now, and min-height:0 is what lets
   the log scroll rather than push the composer off the bottom of the view. */
.muxv {
  /* Type and ground come from ccbb, not from the vscode vars: this subtree now renders
     ccbb's own .msg / .tool-card / .input-row, and those were drawn for ccbb's 15px
     sans on its warm ground. At 14px on a cool one they read as a foreign panel pasted
     into the page. Inherited rather than restated so the standalone page (which serves
     ccbb's stylesheet too) gets the same thing from body. */
  font-family: inherit; font-size: inherit;
  background: var(--bg); color: var(--ink);
  display: flex; flex-direction: column; min-height: 0; height: 100%;
}
.muxv a { color: var(--vscode-textLink-foreground); }
/* The mux's OWN buttons only — the bar, the permission cards, the question tabs.
   It used to be a bare .muxv button, which at (0,1,1) outranked ccbb's .send-btn,
   .exp-btn and .hist-btn at (0,1,0) and quietly repainted all three: the clay send
   button came out the same grey as everything else. */
.muxv .mx-bar button, .muxv .card button, .muxv .qtabs button {
  font: inherit; border: 1px solid transparent; border-radius: 5px; padding: 5px 11px;
  background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  cursor: pointer;
}
.muxv .card button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.muxv .mx-bar button:disabled, .muxv .card button:disabled { opacity: .5; cursor: default; }

/* ── chrome ─────────────────────────────────────────────────────────────── */
.muxv .mx-bar {
  display: flex; align-items: center; gap: 10px; padding: 7px 12px;
  background: var(--vscode-sideBar-background); border-bottom: 1px solid var(--vscode-panel-border);
  flex: 0 0 auto; font-size: 12px;
}
.muxv .mx-bar .label { font-weight: 600; font-size: 13px; }
.muxv .mx-bar .cwd { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muxv .mx-bar .spacer { flex: 1 1 auto; }
.muxv .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-descriptionForeground); flex: 0 0 auto; display: inline-block; }
.muxv .dot.idle { background: var(--vscode-charts-green); }
.muxv .dot.busy { background: var(--vscode-charts-yellow); animation: mx-pulse 1.1s ease-in-out infinite; }
.muxv .dot.exited, .muxv .dot.gone { background: var(--vscode-charts-red); }
/* mx-pulse, not pulse: ccbb-web.js defines its own @keyframes pulse, and keyframe
   names are global no matter how well the rules that use them are scoped. */
@keyframes mx-pulse { 50% { opacity: .3; } }
.muxv select { font: inherit; font-size: 12px; background: var(--vscode-input-background);
  color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border);
  border-radius: 5px; padding: 3px 6px; }

.muxv .mx-log { flex: 1 1 auto; overflow-y: auto; min-height: 0; padding: 14px 0 8px; }
/* 740 + the padding, because that is the width ccbb gives .msg and .tool-card. At 900
   the column stayed left-aligned inside the wrap and the transcript sat off-centre
   with a gutter down the right-hand side. */
.muxv .mx-wrap { max-width: 772px; margin: 0 auto; padding: 0 16px; }
.muxv .thinking { color: var(--vscode-descriptionForeground); font-style: italic; }
/* A <task-notification> line. Transcript-sized, not footnote-sized: a backgrounded
   command reporting a failure is news, and the bullet is the only thing that says
   which way it went. */
.muxv .task-note { display: flex; gap: 8px; align-items: baseline; margin: 10px 0;
  width: 100%; max-width: 740px; line-height: 1.6; }
.muxv .task-note .bul { flex: 0 0 auto; color: var(--vscode-charts-green); }
.muxv .task-note.err .bul, .muxv .task-note.err .note-text { color: var(--vscode-charts-red); }
.muxv .task-note .dur { color: var(--vscode-descriptionForeground); font-size: 12px; }
.muxv .cseam { display: flex; align-items: center; gap: 10px; margin: 14px 0; }
.muxv .cseam::before, .muxv .cseam::after { content: ''; flex: 1 1 auto;
  border-top: 1px solid var(--vscode-panel-border); }
.muxv .cseam-lab { flex: 0 0 auto; background: none; border: 0; padding: 0; cursor: pointer;
  font: inherit; font-size: 12px; color: var(--vscode-descriptionForeground); }
.muxv .cseam-lab:hover { color: var(--vscode-foreground); }
.muxv .cseam-sum { white-space: pre-wrap; font-size: 12px; margin-bottom: 12px;
  color: var(--vscode-descriptionForeground); }
/* ccbb's stylesheet tints running/done/error; "background" is this client's own. */
.muxv .tool-status.background { background: var(--vscode-textBlockQuote-background);
  color: var(--vscode-descriptionForeground); }
.muxv .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
/* A subagent's own turns. The plugin hides these outright; ccbb nests them, the
   way the terminal client draws them under a rule. */
/* width:auto, because ccbb's .msg is width:100% and a percentage width does not know
   about the 26px of margin and padding this rule adds — on a phone that was four pixels
   of horizontal scroll on the whole transcript. */
.muxv .nested { margin-left: 14px; padding-left: 12px; border-left: 2px solid var(--vscode-panel-border); width: auto; }
.muxv .tool-hdr .secondary { color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family);
  font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muxv .tool-hdr .who { color: var(--vscode-descriptionForeground); font-size: 11px; }
/* The header is one line and three things want it: the argument on the left, the
   outcome on the right. Both may shrink; the tool's NAME may not, because a header
   that has ellipsized its own name says nothing at all. */
.muxv .tool-hdr .secondary { flex: 0 1 auto; min-width: 0; }
.muxv .tool-hdr .tool-meta { min-width: 0; }
.muxv .tool-sum { flex: 0 1 auto; min-width: 0; font-size: 11.5px;
  font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muxv .tool-sum.err { color: var(--vscode-charts-red); }
.muxv .tool-body { padding: 0 10px 9px; font-family: var(--vscode-editor-font-family); font-size: 12.5px; }
.muxv .tool-body pre { margin: 4px 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.muxv .tool-body .row { display: grid; grid-template-columns: 26px 1fr; gap: 6px; margin: 4px 0; }
.muxv .tool-body .rowlabel { color: var(--vscode-descriptionForeground); font-size: 11px; padding-top: 2px; }
.muxv .tool-body .out { max-height: 320px; overflow: auto; }
.muxv .diff { border-radius: 5px; overflow: hidden; }
.muxv .diff div { padding: 0 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.muxv .diff .add { background: var(--vscode-diffEditor-insertedTextBackground); }
.muxv .diff .del { background: var(--vscode-diffEditor-removedTextBackground); }
.muxv .diff .ln { color: var(--vscode-descriptionForeground); display: inline-block;
  width: 3.5em; text-align: right; margin-right: 8px; user-select: none; }
.muxv .todos { list-style: none; padding: 0; margin: 4px 0; }
.muxv .todos li.done { color: var(--vscode-descriptionForeground); text-decoration: line-through; }
.muxv .todos li.active { color: var(--ccbb-accent); font-weight: 600; }

/* ── cards ──────────────────────────────────────────────────────────────── */
/* The spinner. Its own row, not a card: it is transient state, so it sits between the
   transcript and whatever is asking for an answer, and disappears with the turn. */
/* [hidden] is what paintBusy toggles; a bare display:flex here outranks the UA's
   [hidden]{display:none}, which left the row on screen, frozen at its last count, after
   every turn. */
.muxv .mx-busy[hidden] { display: none; }
.muxv .mx-busy { flex: 0 0 auto; display: flex; align-items: baseline; gap: 8px;
  padding: 6px 16px 8px; font-size: 12.5px; color: var(--vscode-descriptionForeground); }
.muxv .mx-busy .mx-spin { color: var(--ccbb-accent); font-size: 13px; }
/* Inside .mx-log now, so it neither scrolls nor sizes itself — the transcript does
   both for it. The bottom padding is what keeps a card clear of the composer. */
.muxv .mx-cards { padding-bottom: 6px; }
.muxv .card { border: 1px solid var(--ccbb-accent); border-radius: 8px; margin: 8px 0;
  background: var(--vscode-sideBar-background); overflow: hidden; }
.muxv .card .head { padding: 9px 12px 4px; font-weight: 600; }
.muxv .card .detail { padding: 0 12px; font-family: var(--vscode-editor-font-family); font-size: 12.5px;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; }
.muxv .card .buttons { display: flex; gap: 8px; padding: 10px 12px; flex-wrap: wrap; }
.muxv .card .claim { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 0 12px 8px; }
.muxv .qtabs { display: flex; gap: 6px; padding: 6px 12px 0; flex-wrap: wrap; }
.muxv .qtabs button.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.muxv .qbody { padding: 6px 12px; }
.muxv .qbody label { display: flex; gap: 8px; align-items: flex-start; padding: 4px 0; cursor: pointer; }
.muxv .qbody .desc { color: var(--vscode-descriptionForeground); font-size: 12px; }
.muxv .qbody input[type=text] { width: 100%; font: inherit; padding: 5px 8px; border-radius: 5px;
  background: var(--vscode-input-background); color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border); }
/* ── ccbb's own components ───────────────────────────────────────────────────
   The composer, the status line, the tool card and the message bubbles are
   ccbb-web.js's, class for class: .input-area/.input-row/.input-box/.send-btn,
   .sv-foot .sl, .tool-card/.tool-hdr/.tool-body, .msg/.msg-body. Those rules
   are UNSCOPED in ccbb's stylesheet, so they reach in here on their own and the
   standalone page serves the same sheet (hostCss()). What is left below is only
   what ccbb has no equivalent for, plus the maximize chain — ccbb keys that on
   .view-body.input-max and this root is .muxv. */
.muxv .tool-hdr .secondary { color: var(--vscode-descriptionForeground);
  font-family: var(--vscode-editor-font-family); font-size: 12px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muxv .tool-hdr .who { color: var(--vscode-descriptionForeground); font-size: 11px; }
/* Dimmed rather than hidden-until-hover: this view is also read on a phone, where there
   is no hover and a button that only appears on one is a button that does not exist. */
.muxv .tool-hdr .tool-btns { flex: 0 0 auto; display: inline-flex; gap: 0; opacity: .35; }
.muxv .tool-hdr .tool-btns .flw-btn { padding: 2px 5px; font-size: 12px; }
.muxv .tool-hdr:hover .tool-btns, .muxv .tool-hdr .tool-btns:hover { opacity: 1; }
/* Typed output on a card: the panel's renderer inside the card's body. The body keeps
   its own padding, so the renderer's is dropped; a long result scrolls inside a cap
   rather than pushing the whole transcript. */
.muxv .tool-body.cmd-out { max-height: 45vh; overflow: auto; }
.muxv .tool-body > .cmd-content { padding: 0; overflow: visible; }
/* The card is the box. A second bordered, padded box inside it is a frame around a
   frame, so the output sits flat on the card. */
.muxv .tool-body > .cmd-content pre { border: none; background: none; border-radius: 0; padding: 0; margin: 0; }
.muxv .tool-body > .cmd-content.md { padding: 2px 0 0; }
.muxv .tool-body > .cmd-content.html { height: 360px; }
/* Maximized: the card leaves the transcript and takes the viewport, the way the
   docked panel does. */
.muxv .tool-card.max { position: fixed; inset: 0; z-index: 50; margin: 0; border-radius: 0;
  max-width: none; width: auto; display: flex; flex-direction: column; background: var(--bg); }
.muxv .tool-card.max .tool-body { flex: 1 1 auto; max-height: none; min-height: 0; overflow: auto; display: block; }
.muxv .tool-card.max .tool-body > .cmd-content.html { height: 100%; }
/* Own line rather than ccbb's .msg-label, which is uppercase and letterspaced for a
   role ("YOU"). This is a person's name, and shouting it would be wrong. */
.muxv .msg .by { font-size: 11px; color: var(--vscode-descriptionForeground); }
.muxv .msg.you .by { align-self: flex-end; }

/* Maximize. ccbb's rules are the same chain against .view-body.input-max; the bug
   this replaces was setting height:auto on the editable, which in a flex column
   left a 40px box at the bottom of an empty panel — the log gone and nothing in
   its place. flex:1 on .input-box is the line that actually makes it fill. */
.muxv.input-max .mx-log, .muxv.input-max .mx-cards, .muxv.input-max .sv-foot { display: none; }
.muxv.input-max .input-area { flex: 1 1 auto; min-height: 0; border-top: none; }
.muxv.input-max .input-inner { max-width: none; height: 100%; display: flex; flex-direction: column; }
.muxv.input-max .input-row { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.muxv.input-max .input-box { flex: 1 1 auto; min-height: 0; max-height: none; padding-bottom: 32px; }
.muxv.input-max .input-box::after { display: none; }
.muxv.input-max .input-tools { position: static; margin: 0 0 5px; justify-content: flex-end;
  opacity: 1; transform: none; pointer-events: auto; }
.muxv.input-max .input-tools > * { pointer-events: auto; }

/* The standalone session index is a .muxv only to inherit the theme: it is a
   document, not a live view, so it must not become the flex column. */
/* ccbb's .sv-foot lays out its own left-hand run of numbers; what is mux-specific —
   who else is attached, a credential refresh, the exit code — rides at the right, and
   .sl has to be able to grow for margin-left:auto to have anywhere to push it. */
.muxv .sv-foot .sl { flex: 1 1 auto; }
.muxv .sv-foot .sl-note { margin-left: auto; padding-left: 12px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }

.muxv.plain { display: block; height: auto; overflow: auto; }

/* ── session list ───────────────────────────────────────────────────────── */
.muxv .sessions { max-width: 760px; margin: 40px auto; padding: 0 16px; }
.muxv .sessions h1 { font-size: 18px; }
.muxv .sessions a.row { display: flex; gap: 10px; align-items: baseline; padding: 10px 12px;
  border: 1px solid var(--vscode-panel-border); border-radius: 7px; margin: 8px 0;
  text-decoration: none; color: inherit; }
.muxv .sessions a.row:hover { border-color: var(--vscode-focusBorder); }
.muxv .sessions .id { font-family: var(--vscode-editor-font-family); font-size: 12px;
  color: var(--vscode-descriptionForeground); }
`;

// The page-level rules the standalone client needs and an embedded view must NOT
// have: inside ccbb-web.js the host owns the body. Served only by mount().
const PAGE_CSS = `
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; }
body > .muxv { flex: 1 1 auto; min-height: 0; }
`;

// ── The client ───────────────────────────────────────────────────────────────
// A FACTORY, not a page script. window.createMuxView(root, opts) mounts one
// session's client into one element and hands back a handle. The standalone page
// is a thin caller of it and ccbb-web.js is another — which is what lets a mux
// session be a VIEW in ccbb web's stack rather than a navigation away from it,
// without a second copy of this renderer existing to drift from the first.
//
// Everything that used to be module state — S, WS, the node index, the socket
// timer — now lives inside this function, so two views on one page are two
// independent clients. Element lookup goes through Q(), scoped to root:
// document.getElementById would have found the FIRST view's log for every view,
// and the failure looks like "the second session renders into the first".
//
// Two house rules, both inherited from ccbb-web.js: this is a template literal, so
// every backslash is doubled and there are no ${...} or backticks in the client
// source (BT below is how the markdown renderer gets one).
const APP_JS_SRC = `
(function () {
'use strict';
var BT = String.fromCharCode(96), BT3 = BT + BT + BT;
// Handed in from ccbb-mux.js at assembly time — see the replace() under APP_JS.
var SPIN_VERBS = __SPIN_VERBS__, SPIN_FRAMES = __SPIN_FRAMES__;

// The shell, built here rather than shipped as HTML: ccbb-web.js would otherwise
// carry a second copy of this markup, and the ids it used to have cannot survive
// more than one view on a page anyway.
function shell(bar) {
  return (bar ? '<div class="mx-bar">' +
      '<span class="dot"></span>' +
      '<span class="label"></span>' +
      '<span class="cwd"></span>' +
      '<span class="spacer"></span>' +
      '<select class="mx-mode" title="permission mode">' +
        '<option value="default">default</option>' +
        '<option value="acceptEdits">acceptEdits</option>' +
        '<option value="plan">plan</option>' +
        '<option value="bypassPermissions">bypassPermissions</option>' +
      '</select>' +
      '<button class="mx-stop" title="interrupt (Esc)">Stop</button>' +
      '<a class="mx-up" href="/">sessions</a>' +
    '</div>' : '') +
    // The cards live INSIDE the log, after the messages, rather than in a pane of their
    // own beneath it. A permission or a question belongs where it happened — that is
    // where the CLI and the plugin put it — and a second scroll region under the first
    // meant the transcript and the thing asking you about it scrolled independently,
    // so reading the tool call a card was about moved the card off screen.
    '<div class="mx-log"><div class="mx-wrap"></div>' +
      '<div class="mx-cards"><div class="mx-wrap"></div></div></div>' +
    // The CLI's spinner, in its own row under the log rather than as the log's last
    // child: it must not scroll away while a turn is in flight, which is the one
    // moment it is worth having.
    '<div class="mx-busy" hidden><span class="mx-spin"></span><span class="mx-verb"></span></div>' +

    // ccbb-web.js's composer, class for class, so its stylesheet dresses this one
    // and asTextarea() (hoisted into ccbb's SHARED_JS) gives the editable the three
    // textarea properties the code below talks to. The tools row is absolute and
    // appears on :focus-within; the send button sits in a notch cut out of the last
    // line. Both are ccbb's behaviour, not an imitation of it.
    '<div class="input-area"><div class="input-inner">' +
      '<div class="input-tools">' +
        '<button class="hist-btn" data-h="prev" title="' + HIST_PREV_TIP + '">&#9650;</button>' +
        '<button class="hist-btn" data-h="next" title="' + HIST_NEXT_TIP + '">&#9660;</button>' +
        '<span class="tool-gap"></span>' +
        '<button class="exp-btn" title="' + EXPAND_TIP + '">&#9633;</button>' +
      '</div>' +
      '<div class="input-row">' +
        '<div class="input-box" data-ph="Message Claude\u2026  (/ for the child, // for ccbb, Ctrl+Enter to send)"></div>' +
        '<button class="send-btn" title="' + SEND_TIP + '">&#8593;</button>' +
        '<button class="stop-btn" title="Stop (Esc)" hidden><i></i></button>' +
      '</div>' +
    '</div></div>' +
    '<div class="sv-foot"><span class="sl"></span></div>';
}

window.createMuxView = function (root, opts) {
opts = opts || {};
// BASE and SESSION are handed in, not parsed from location: embedded in ccbb web
// the page URL is the session LIST, and there may be two views open at once.
var BASE = opts.base || '';
var SESSION = opts.session || '';
var TOKEN = opts.token || '';
var LABEL = opts.label || 'web';
// The ccbb server this session lives on, for titling output that leaves the view.
var MACHINE = opts.machine || '';
// HAS_BAR, not CHROME — the renderer below already binds CHROME to the
// mcp__claude-in-chrome__ tool prefix, and shadowing it would break the fallback
// chain for exactly one family of tools.
var HAS_BAR = opts.bar !== false;
var ON_CHROME = typeof opts.onChrome === 'function' ? opts.onChrome : null;
// The host's header block wants the whole stats object, not the handful of numbers the
// status line prints. Separate from onChrome because it changes on a different clock.
var ON_STATS = typeof opts.onStats === 'function' ? opts.onStats : null;
var ERRORS = [];
var dead = false, reconnectTimer = null;
// Set by wire(); called when a snapshot lands so the composer's ↑ history reaches the
// turns that were sent before this page existed.
var ON_HISTORY = null;
root.className = (root.className ? root.className + ' ' : '') + 'muxv';
root.innerHTML = shell(HAS_BAR);
function Q(sel) { return root.querySelector(sel); }

// ── DOM helpers ────────────────────────────────────────────────────────────
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function txt(v) {
  // Tool results arrive as a string, or as the Anthropic content-block array.
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(function (b) {
    return typeof b === 'string' ? b : (b && b.type === 'text' ? b.text : JSON.stringify(b));
  }).join('\\n');
  if (typeof v === 'object' && v.type === 'text') return v.text || '';
  return JSON.stringify(v, null, 2);
}
function base(p) { return String(p || '').split('/').pop() || String(p || ''); }
// Same rounding ccbb web's footer uses, so a session read in both places shows one
// number rather than two that nearly agree.
function fmtTokShort(t) {
  t = t || 0;
  if (t >= 1e9) return (t / 1e9).toFixed(1) + 'B';
  if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
  if (t >= 1e3) return Math.round(t / 1e3) + 'k';
  return String(t);
}

// ── Markdown ───────────────────────────────────────────────────────────────
// The plugin uses marked; shipping a parser is not worth a dependency for the
// subset a Claude turn actually emits. Everything is escaped BEFORE any markup is
// introduced, so no path here can inject HTML from model output.
function md(src) {
  var lines = String(src == null ? '' : src).split('\\n');
  var out = [], i = 0;
  function inline(s) {
    s = esc(s);
    s = s.replace(new RegExp(BT + '([^' + BT + ']+)' + BT, 'g'), '<code>$1</code>');
    s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\\*([^*\\n]+)\\*/g, '$1<em>$2</em>');
    s = s.replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }
  while (i < lines.length) {
    var l = lines[i];
    if (l.slice(0, 3) === BT3) {
      var lang = l.slice(3).trim(), buf = [];
      i++;
      while (i < lines.length && lines[i].slice(0, 3) !== BT3) { buf.push(lines[i]); i++; }
      i++;
      out.push('<pre><code data-lang="' + esc(lang) + '">' + esc(buf.join('\\n')) + '</code></pre>');
      continue;
    }
    var hm = /^(#{1,6})\\s+(.*)$/.exec(l);
    if (hm) { var lv = Math.min(6, hm[1].length + 2); out.push('<h' + lv + '>' + inline(hm[2]) + '</h' + lv + '>'); i++; continue; }
    if (/^\\s*([-*+]|\\d+\\.)\\s+/.test(l)) {
      var ord = /^\\s*\\d+\\./.test(l), items = [];
      while (i < lines.length && /^\\s*([-*+]|\\d+\\.)\\s+/.test(lines[i])) {
        items.push('<li>' + inline(lines[i].replace(/^\\s*([-*+]|\\d+\\.)\\s+/, '')) + '</li>');
        i++;
      }
      out.push((ord ? '<ol>' : '<ul>') + items.join('') + (ord ? '</ol>' : '</ul>'));
      continue;
    }
    if (/^\\s*>\\s?/.test(l)) {
      var q = [];
      while (i < lines.length && /^\\s*>\\s?/.test(lines[i])) { q.push(lines[i].replace(/^\\s*>\\s?/, '')); i++; }
      out.push('<blockquote>' + inline(q.join('\\n')) + '</blockquote>');
      continue;
    }
    if (!l.trim()) { i++; continue; }
    var para = [];
    while (i < lines.length && lines[i].trim() && lines[i].slice(0, 3) !== BT3 &&
           !/^(#{1,6})\\s|^\\s*([-*+]|\\d+\\.)\\s|^\\s*>/.test(lines[i])) { para.push(lines[i]); i++; }
    out.push('<p>' + inline(para.join('\\n')) + '</p>');
  }
  return out.join('');
}

// ── Tool renderers ─────────────────────────────────────────────────────────
// Ported from nZ() in the extension's webview bundle (read at 2.1.245, re-read at
// 2.1.252 — identical). header() returns [name, secondary] the way the plugin
// splits toolNameText from toolNameTextSecondary; body() returns a node, or null
// to fall through to the generic IN/OUT renderer that the plugin's base class uses.
function row(label, node) {
  var r = el('div', 'row');
  r.appendChild(el('div', 'rowlabel', label));
  var c = el('div');
  c.appendChild(node);
  r.appendChild(c);
  return r;
}
function pre(text, cls) {
  var p = el('pre', cls || null);
  p.textContent = text;
  return p;
}
function diffNode(patch) {
  // structuredPatch, as the child sends it on tool_use_result for Edit/Write.
  var box = el('div', 'diff');
  (patch || []).forEach(function (h) {
    var oldN = h.oldStart || 1, newN = h.newStart || h.oldStart || 1;
    (h.lines || []).forEach(function (line) {
      var sign = line.charAt(0), body = line.slice(1);
      var d = el('div', sign === '+' ? 'add' : sign === '-' ? 'del' : null);
      var n = sign === '+' ? newN++ : sign === '-' ? oldN++ : (oldN++, newN++);
      d.appendChild(el('span', 'ln', String(n)));
      d.appendChild(document.createTextNode((sign === ' ' ? ' ' : sign) + body));
      box.appendChild(d);
    });
  });
  return box;
}
function outBlock(result, isError) {
  var t = txt(result);
  if (!t) return null;
  var p = pre(t);
  p.className = 'out';
  if (isError) p.style.color = 'var(--vscode-charts-red)';
  return p;
}

var REG = {
  // hidden: the plugin renders nothing for these at all.
  AgentOutputTool: { hidden: true },
  ToolSearch: { hidden: true, header: function (i) { return ['Search tools', i && i.query ? '"' + i.query + '"' : '"…"']; } },

  Artifact: { header: function (i) { return ['Artifact', i.file_path]; } },
  Bash: {
    // The description first — it is the one line written to say what the call is FOR —
    // and the command itself when there is none. Claude Code always has something here
    // (it titles the card Bash(<command>)); this used to fall back to an empty string,
    // so every Bash call the model described in no words at all was a card labelled
    // "Bash" and nothing else.
    header: function (i) { return ['Bash', i.description || firstLine(i.command)]; },
    body: function (i, result, meta, isError) {
      var f = document.createDocumentFragment();
      if (i.command) f.appendChild(row('$', pre(i.command)));
      var o = outBlock(result, isError);
      if (o) f.appendChild(row('', o));
      return f;
    },
  },
  PowerShell: { header: function (i) { return ['PowerShell', i.description || firstLine(i.command)]; } },
  TaskOutput: { header: function (i) { return ['TaskOutput', i.task_id ? 'task: "' + i.task_id + '"' : '']; } },
  Agent: {
    // Task is aliased to Agent by the registry lookup, exactly as the plugin does.
    header: function (i) { return ['Agent:', i.description || i.subagent_type || firstLine(i.prompt)]; },
    body: function (i, result, meta, isError) {
      var f = document.createDocumentFragment();
      if (i.prompt) f.appendChild(row('IN', pre(i.prompt)));
      // A backgrounded agent has no result yet — it reports back later as its own
      // user message. Say so rather than showing an empty card.
      if (meta && meta.isAsync) f.appendChild(row('', el('div', 'meta', 'Backgrounded agent' + (meta.agentId ? ' · ' + meta.agentId : ''))));
      var o = outBlock(result, isError);
      if (o) f.appendChild(row('OUT', o));
      return f;
    },
  },
  TodoWrite: {
    header: function () { return ['Update Todos', '']; },
    body: function (i) {
      if (!i || !Array.isArray(i.todos)) return null;
      var ul = el('ul', 'todos');
      i.todos.forEach(function (t) {
        var st = t.status || 'pending';
        var li = el('li', st === 'completed' ? 'done' : st === 'in_progress' ? 'active' : null);
        li.textContent = (st === 'completed' ? '\\u2612 ' : st === 'in_progress' ? '\\u2192 ' : '\\u2610 ') +
          (st === 'in_progress' && t.activeForm ? t.activeForm : t.content || '');
        ul.appendChild(li);
      });
      return ul;
    },
  },
  Read: {
    header: function (i) {
      var extra = '';
      if (i.offset !== undefined && i.limit !== undefined) extra = ' (lines ' + (i.offset + 1) + '-' + (i.offset + i.limit) + ')';
      else if (i.offset !== undefined) extra = ' (from line ' + (i.offset + 1) + ')';
      return ['Read', base(i.file_path) + extra];
    },
    // The line count moved to the header (toolSummary), so the body is the FILE now.
    // It used to be the count and nothing else, which made opening a Read card show
    // you the one thing the collapsed card was already telling you.
    body: function (i, result, meta, isError) {
      return outBlock(result, isError);
    },
  },
  ReadCoalesced: { header: function (i) { return ['Read', base(i.file_path)]; } },
  Write: {
    header: function (i) { return ['Write', base(i.file_path)]; },
    body: function (i, result, meta, isError) {
      if (isError) return outBlock(result, true);
      if (meta && meta.structuredPatch && meta.structuredPatch.length) return diffNode(meta.structuredPatch);
      return i.content ? pre(i.content) : null;
    },
  },
  Edit: {
    header: function (i) { return ['Edit', base(i.file_path)]; },
    body: function (i, result, meta, isError) {
      if (isError) return outBlock(result, true);
      if (meta && meta.structuredPatch && meta.structuredPatch.length) return diffNode(meta.structuredPatch);
      // No patch on the wire: synthesise the two-sided view the plugin draws from
      // old_string/new_string so an edit is never a blank card.
      return diffNode([{ oldStart: 1, newStart: 1, lines:
        String(i.old_string || '').split('\\n').map(function (l) { return '-' + l; })
          .concat(String(i.new_string || '').split('\\n').map(function (l) { return '+' + l; })) }]);
    },
  },
  NotebookEdit: { header: function (i) { return ['NotebookEdit', base(i.notebook_path)]; } },
  Glob: { header: function (i) { return ['Glob', 'pattern: "' + (i.pattern || '') + '"']; } },
  Grep: {
    header: function (i) {
      var bits = [];
      if (i.path) bits.push('in ' + i.path);
      if (i.glob) bits.push('glob: ' + i.glob);
      if (i.type) bits.push('type: ' + i.type);
      return ['Grep', '"' + (i.pattern || '') + '"' + (bits.length ? ' (' + bits.join(', ') + ')' : '')];
    },
  },
  Search: { header: function (i) { return ['Search', 'pattern: "' + (i.pattern || '') + '"']; } },
  WebFetch: { header: function (i) { return ['Web Fetch', i.url || '']; } },
  WebSearch: { header: function (i) { return ['Web Search', i.query || '']; } },
  Skill: {
    header: function (i) { return [String(i.skill || '').replace(/^\\//, ''), ' skill']; },
    body: function () { return null; },
  },
  REPL: { header: function () { return ['REPL', '']; } },
  SandboxNetworkAccess: { header: function () { return ['Sandbox network access', '']; } },
  ExitPlanMode: {
    header: function (i) { return [i && i.plan ? 'Claude\\u2019s Plan' : 'Plan Mode', '']; },
    body: function (i) { var d = el('div', 'text'); d.innerHTML = md(i.plan || ''); return d; },
  },
  AskUserQuestion: { header: function () { return ['Question', '']; } },
};

var MCP = 'mcp__', CHROME = 'mcp__claude-in-chrome__';
var ACRONYM = { Github: 'GitHub', Pubmed: 'PubMed', Ai: 'AI' };
function humanize(s) {
  return String(s).split('_').map(function (w) {
    var t = w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    return ACRONYM[t] || t;
  }).join(' ');
}
// The plugin picks the first present of these as an MCP call's secondary text.
var MCP_HINT = ['query', 'message', 'channel', 'repo', 'url', 'path', 'title', 'search', 'text'];
function mcpHint(input) {
  for (var k = 0; k < MCP_HINT.length; k++) {
    var v = input && input[MCP_HINT[k]];
    if (typeof v !== 'string' || !v) continue;
    if (MCP_HINT[k] === 'channel') return '#' + v;
    if (MCP_HINT[k] === 'url') { try { return new URL(v).hostname; } catch (e) { return v.slice(0, 30); } }
    return v.length > 40 ? v.slice(0, 40) + '\\u2026' : v;
  }
  return '';
}
// The fallback chain, in the plugin's order: named renderer (Task aliased to
// Agent), then chrome, then any MCP tool, then a generic card titled by name.
function rendererFor(name) {
  var key = name === 'Task' ? 'Agent' : name;
  if (REG[key]) return REG[key];
  if (String(name).indexOf(CHROME) === 0) {
    var t = String(name).slice(CHROME.length);
    return { header: function (i) { return ['Chrome [' + t + ']', mcpHint(i)]; } };
  }
  if (String(name).indexOf(MCP) === 0) {
    var rest = String(name).slice(MCP.length);
    var server = humanize(rest.split('__')[0] || '');
    var tool = rest.split('__').slice(1).join('__');
    return { header: function (i) { return [server + ' [' + tool + ']', mcpHint(i)]; } };
  }
  // Named by the tool and by whatever argument identifies the call. A bare tool name
  // says which tool ran and nothing about what it was asked to do, and half the cards in
  // a long session are tools with no renderer of their own.
  return { header: function (i) { return [name, mcpHint(i) || firstLine(i && (i.description || i.path || i.file_path || i.query || i.prompt))]; } };
}

// ── Store ──────────────────────────────────────────────────────────────────
// One reducer over the mux's event stream. The delta path is the one that has
// already broken once (it made the terminal client's prose vanish outright), so
// it is modelled explicitly rather than left to fall out of the render:
// content_block_deltas accumulate into a PROVISIONAL message keyed by the API
// message id, and the authoritative 'message' event REPLACES it — never appends
// beside it. Messages are keyed by the mux's own uuid, deltas reconcile on apiId,
// and an apiId that has already been finalized ignores any late delta.
var S = {
  seq: 0, info: {}, msgs: [], byId: {}, tools: {},
  stream: {}, final: {}, pending: {}, clients: [], notes: [],
  // Which collapsed cards the reader has opened, by tool/command id. Deliberately
  // NOT cleared by reset(): a snapshot replay rebuilds every node, and a card that
  // closed itself because the socket blinked would be the reconnect making itself
  // felt in the one place it should not.
  open: {}, cmds: [],
  // Which cards the reader has actually clicked. A card follows its RUN by default —
  // open while the tool works, shut once it lands, which is where the CLI's attention
  // is — and only stops following it once somebody says otherwise. Without this the
  // two rules fight: an expansion made mid-run would snap shut on the result.
  touched: {},
};
var nodes = {}, REV = 0;

function bump(m) { m._rev = ++REV; }
function indexTools(m) {
  (m.blocks || []).forEach(function (b) {
    if (b.type === 'tool_use') S.tools[b.id] = { block: b, msg: m };
  });
}
function upsert(m) {
  if (S.byId[m.id]) {
    var at = S.msgs.indexOf(S.byId[m.id]);
    S.msgs[at] = m;
  } else S.msgs.push(m);
  S.byId[m.id] = m;
  indexTools(m);
  bump(m);
}
function provisional(apiId, parent) {
  if (!S.stream[apiId]) {
    S.stream[apiId] = { id: 'stream:' + apiId, apiId: apiId, role: 'assistant',
      parentToolUseId: parent || null, blocks: [], provisional: true };
    bump(S.stream[apiId]);
  }
  return S.stream[apiId];
}

function reset(snap) {
  S.seq = snap.seq || 0;
  // Whose count that seq is. Sent back on the next reconnect so the mux can tell a
  // resume that continues THIS session process from one that would splice a new
  // process's events onto a dead one's transcript.
  S.epoch = snap.epoch || null;
  S.info = snap.state || {};
  if (ON_STATS && S.info.stats) ON_STATS(S.info.stats);
  // Attaching to a session that is already working: the spinner starts from the mux's
  // own turn clock, not from the moment this page opened.
  setBusy(S.info.status === 'busy');
  if (S.info.turnStartedAt) turnStart = S.info.turnStartedAt;
  S.msgs = []; S.byId = {}; S.tools = {}; S.stream = {}; S.final = {};
  (snap.messages || []).forEach(function (m) { upsert(m); });
  S.pending = {};
  (snap.pending || []).forEach(function (p) { S.pending[p.requestId] = p; });
  S.clients = snap.clients || [];
  nodes = {};
  Q('.mx-log').firstChild.innerHTML = '';
  // The transcript IS the prompt history, so ↑ reaches past this page's own turns to
  // whatever was sent before it existed. Re-seeded on every snapshot rather than
  // appended to, because a snapshot is the authority on what the session contains.
  if (ON_HISTORY) ON_HISTORY();
  paintAll();
  // A snapshot can carry cards that were opened before this client existed. The
  // whole point of the mux's pending list is that a late joiner can answer a
  // request it never saw arrive, so painting the transcript without also painting
  // the cards silently drops the feature.
  paintCards();
}

function apply(ev) {
  if (ev.seq) S.seq = ev.seq;
  switch (ev.kind) {
    case 'init':
      S.info = ev.state || S.info;
      return paintChrome();

    case 'message': {
      var m = ev.message;
      if (m.apiId) { S.final[m.apiId] = 1; delete S.stream[m.apiId]; }
      upsert(m);
      return paintAll();
    }

    case 'delta': {
      var id = ev.messageId;
      if (!id || S.final[id]) return;             // the real message already landed
      var p = provisional(id, ev.parentToolUseId);
      var type = ev.deltaKind === 'thinking' ? 'thinking' : ev.deltaKind === 'input' ? 'input' : 'text';
      var b = p.blocks[ev.index];
      if (!b || b.type !== type) { b = { type: type, text: '' }; p.blocks[ev.index] = b; }
      b.text += ev.text;
      bump(p);
      return paintAll();
    }

    case 'tool_pending': {
      var pm = provisional(ev.messageId, null);
      if (!pm.blocks.some(function (x) { return x && x.id === ev.id; }))
        pm.blocks.push({ type: 'tool_use', id: ev.id, name: ev.name, input: {}, status: 'running' });
      bump(pm);
      return paintAll();
    }

    case 'tool_start':
      return;                                     // the message event already carried the block

    // The only word the child gives while a tool is actually RUNNING — there is no
    // stdout on the wire until the result lands. What it buys is the difference
    // between "queued" and "executing", which was three seconds in the probe and
    // used to look exactly like a hung session.
    case 'tool_run': {
      var tr = S.tools[ev.toolUseId];
      if (!tr) return;
      // 'started' is the clock's zero. It used to be cleared again on 'finished',
      // which threw away the only start time there is — a finished card could never
      // say how long it took, which is the one thing .tool-time exists to show.
      if (ev.phase === 'started') { tr.block.runAt = Date.now(); tr.block.runDesc = ev.description || ''; }
      else {
        // A BACKGROUNDED tool answered its tool_result the moment it was launched and
        // has been settled for minutes; its notification is not the end of a call that
        // was still open. Stamping endAt again turned a 200ms Bash into "312.0s" —
        // .tool-time measures the call, and the call ended when the result landed.
        if (tr.block.status === 'running') { tr.block.endAt = Date.now(); tr.block.runDesc = ev.description || ''; }
        // What the background run finally did, which is the outcome the card should
        // show in place of the "done" it earned by launching successfully.
        else tr.block.bg = { status: ev.status || 'completed', description: ev.description || '' };
      }
      bump(tr.msg);
      return paintAll();
    }

    case 'tool_end': {
      var t = S.tools[ev.toolUseId];
      if (!t) return;
      t.block.status = ev.status;
      t.block.endAt = t.block.endAt || Date.now();
      t.block.result = ev.result;
      t.block.resultMeta = ev.meta;
      bump(t.msg);
      return paintAll();
    }

    case 'request':
      S.pending[ev.requestId] = { requestId: ev.requestId, requestKind: ev.requestKind, payload: ev.payload };
      return paintCards();

    case 'request_resolved':
      delete S.pending[ev.requestId];
      note((ev.by || 'someone') + ' answered: ' + (ev.decision || 'done'));
      return paintCards();

    case 'request_cancelled':
      delete S.pending[ev.requestId];
      note('request withdrawn');
      return paintCards();

    case 'status':
      // The mux normalizes this to busy/idle and names what the session is DOING
      // separately — 'requesting' for a turn, 'compacting' for a compaction. The word
      // used to land in status itself, where 'compacting' matched neither branch: no
      // spinner, no dot, no sign the session was working at all.
      S.info.status = ev.status;
      S.info.activity = ev.activity || null;
      S.info.turnStartedAt = ev.turnStartedAt || null;
      if (ev.exit) S.info.exit = ev.exit;
      setBusy(S.info.status === 'busy');
      return paintChrome();

    // A compaction that ended. Success is visible on its own (the context figure in the
    // footer drops); a failure said nothing anywhere, which is how a compaction aborted
    // one second in looked exactly like one that never started.
    case 'compact_done':
      if (ev.result !== 'success') {
        S.msgs.push(noticeEntry('Compaction ' + (ev.result || 'failed') +
          (ev.error ? ' \u2014 ' + ev.error : ''), true));
        paintAll();
      }
      return;

    // The counter the CLI prints beside its spinner. The mux coalesces the child's
    // events down to a few a second before any of this is reached.
    case 'thinking_tokens':
      S.info.outTokens = ev.tokens || 0;
      return paintBusy();

    case 'result': {
      S.info.status = 'idle';
      S.info.activity = null;
      setBusy(false);
      if (ev.costUsd) S.info.cost = (S.info.cost || 0) + ev.costUsd;
      // Context is what the last API call actually carried, which is input plus what
      // it read from cache — the same figure ccbb web's own footer shows, computed
      // the same way so the two cannot disagree. The peak is kept because a /compact
      // drops the current figure and the number you want then is what it was.
      var u = ev.usage || {};
      var ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      if (ctx) {
        S.info.contextTokens = ctx;
        S.info.contextPeak = Math.max(S.info.contextPeak || 0, ctx);
      }
      S.info.turns = (S.info.turns || 0) + 1;
      if (ev.isError && ev.result) note('error: ' + txt(ev.result));
      return paintChrome();
    }

    // The event is {permissionMode, by} — NOT {mode}. Reading ev.mode left the
    // selector on 'default' after a plan accept, which looks exactly like the
    // accept not having taken.
    // The transcript's own numbers, recomputed by the mux after each turn. They REPLACE
    // the provisional ones above rather than adding to them — same source as ccbb's
    // session page, so the footer here and the header block there agree.
    case 'stats': {
      S.info.stats = ev.stats || S.info.stats;
      ['title', 'cost', 'tokens', 'turns', 'subTurns', 'contextTokens', 'contextPeak',
       'contextMax', 'contextPostCompact'].forEach(function (k) {
        if (ev[k] != null) S.info[k] = ev[k];
      });
      if (ON_STATS) ON_STATS(S.info.stats);
      return paintChrome();
    }
    case 'mode':   S.info.permissionMode = ev.permissionMode; return paintChrome();
    case 'model':  S.info.model = ev.model; return paintChrome();
    case 'commands': S.info.commands = ev.commands || []; return;
    case 'submitted':
      if (!ev.accepted) note('submission refused — the child is not accepting input');
      return;
    // In the transcript, not only in the status line's transient note: an interrupt is
    // what ends a turn or aborts a compaction, and a 20-second note at the far right of
    // a footer is not where you look for the reason something stopped.
    case 'interrupted':
      note('interrupted by ' + (ev.by || 'someone'));
      S.msgs.push(noticeEntry('Interrupted by ' + (ev.by || 'someone'), true));
      return paintAll();
    case 'auth':
      // A credential refresh mid-turn is indistinguishable from a hang unless the
      // UI says so — the reason the mux forwards auth_status at all.
      S.info.auth = ev.body;
      return paintChrome();
    case 'retry':  note('retrying the API call'); return paintChrome();
    case 'rate_limit': note('rate limited', true); return paintChrome();
    case 'stderr': note(String(ev.text || '').trim()); return;
    case 'hook': case 'goal': case 'autocompact': case 'system': case 'unknown': case 'turn_start':
      return;
    default: return;
  }
}

// pinned means the note outranks whatever transient thing happened after it. Only rate
// limiting qualifies: it is the one note that explains a session sitting still, and it
// was being pushed out of the line by the retry message it causes.
function note(text, pinned) {
  if (!text) return;
  S.notes.push({ text: text, at: Date.now(), pinned: !!pinned });
  if (S.notes.length > 5) S.notes.shift();
  paintChrome();
}

// ── Rendering ──────────────────────────────────────────────────────────────
function toolNode(b) {
  var r = rendererFor(b.name);
  if (r.hidden) return null;
  var input = b.input || {};
  var head = (r.header || function () { return [b.name, '']; })(input);
  var isError = b.status === 'error';

  // ccbb-web.js's card: .tool-card > .tool-hdr + .tool-body, toggled by its own
  // toggleTool(). Collapsed by default — a turn that reads twenty files used to open
  // twenty cards and bury the prose between them; what a reader wants at a glance is
  // WHICH tools ran and how they went, with the body one click away. Which ones are
  // open is remembered per tool id, because a card is rebuilt when its result lands
  // and an expansion made while waiting would otherwise snap shut as it filled.
  // .hist goes on the CARD, not on the message around it: ccbb dims a seeded turn with
  // '.msg.hist .msg-body, .tool-card.hist' — the card is named on its own, so a class
  // left on the wrapper dims the prose and leaves the cards at full strength.
  var d = el('div', 'tool-card' + (b.hist ? ' hist' : ''));
  d.dataset.tid = b.id;                          // refold() matches old card to new by this
  var hdr = el('div', 'tool-hdr');
  var tw = el('span', 'tool-toggle');
  tw.innerHTML = '&#9654;';
  hdr.appendChild(tw);
  hdr.appendChild(el('span', 'tool-name', head[0]));
  // While the tool RUNS the child's own one-line description of the run is the most
  // informative thing there is about it (the tool_use input is what the model asked
  // for; runDesc is what is actually happening), so it takes the secondary slot and
  // the argument stands down. It used to sit in a RUN row inside the body, where a
  // collapsed card hid it exactly while it mattered.
  var sec = (b.status === 'running' && b.runDesc) ? b.runDesc : head[1];
  if (sec) hdr.appendChild(el('span', 'secondary', sec));
  var meta = el('div', 'tool-meta');
  // What the call actually did, on the header, the way the CLI writes it under a
  // finished tool ("Read 12 lines", "+18 -4", "3 matches"). A collapsed card said only
  // that something had finished; the outcome was a click away for every one of them.
  var sum = toolSummary(b, input, isError);
  if (sum) meta.appendChild(el('span', 'tool-sum' + (isError ? ' err' : ''), sum));
  var ela = elapsed(b);
  if (ela) meta.appendChild(el('span', 'tool-time', ela));
  // The word, not just the pill's tint: a colour alone is invisible to a reader who
  // cannot separate the hues, and "running" is the state somebody is waiting on.
  // "background" is a fourth state, not a shade of done: the call succeeded, the WORK
  // has not finished, and until its task_notification lands there is nothing to report.
  // Once it does, the card takes the background run's outcome rather than the launch's.
  var st = b.status === 'running' ? 'running' : isError ? 'error' : 'done';
  if (isBackgrounded(b)) {
    st = !b.bg ? 'background'
      : (b.bg.status === 'failed' || b.bg.status === 'error') ? 'error' : 'done';
  }
  meta.appendChild(el('span', 'tool-status ' + st, st));
  hdr.appendChild(meta);
  hdr.addEventListener('click', function () {
    toggleTool(hdr);
    S.open[b.id] = body.classList.contains('open');
    S.touched[b.id] = true;
  });
  d.appendChild(hdr);

  var body = el('div', 'tool-body');
  var made = r.body ? r.body(input, b.result, b.resultMeta, isError) : null;
  if (made) body.appendChild(made);
  else {
    // The plugin's base renderer: the input as pretty JSON, then the output.
    if (Object.keys(input).length) body.appendChild(row('IN', pre(JSON.stringify(input, null, 2))));
    var o = outBlock(b.result, isError);
    if (o) body.appendChild(row('OUT', o));
  }
  // Always appended, even empty: toggleTool() reaches the body through the header's
  // nextElementSibling, and a card without one is a header that cannot open.
  if (!body.firstChild) body.appendChild(el('div', 'meta', b.status === 'running' ? 'running\u2026' : '(no output)'));
  d.appendChild(body);
  // Open while it runs, shut when it lands — unless the reader has taken the card over.
  var open = S.touched[b.id] ? !!S.open[b.id] : b.status === 'running';
  if (open) { body.classList.add('open'); tw.innerHTML = '&#9660;'; }
  return d;
}

// The line the CLI prints under a settled tool call. Per-renderer where the tool has a
// natural unit (lines read, hunks written, matches found) and the result's own first
// line otherwise, which is what the CLI falls back to as well. Nothing while it runs:
// the status pill already says running, and a summary of a result that does not exist
// yet would only be a guess.
var SUM_MAX = 60;
function clip(s) {
  s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  return s.length > SUM_MAX ? s.slice(0, SUM_MAX - 1) + '\u2026' : s;
}
function firstLine(v) {
  var t = txt(v).split('\\n');
  for (var i = 0; i < t.length; i++) if (t[i].trim()) return clip(t[i]);
  return '';
}
function countLines(v) {
  return txt(v).split('\\n').filter(function (x) { return x.trim(); }).length;
}
// Launched, not finished. Two carriers say so: an async agent's own result metadata,
// and the sentence a backgrounded Bash answers with. DERIVED rather than stamped on the
// block when the result lands, because a client that attaches later is handed the mux's
// normalized messages and never sees that moment — the two must read the same block the
// same way or a reattach quietly changes what the card says.
function isBackgrounded(b) {
  return !!(b.resultMeta && b.resultMeta.isAsync) ||
    /^Command running in background/.test(txt(b.result));
}
function toolSummary(b, input, isError) {
  if (b.status === 'running') return '';
  // A backgrounded call's summary is the news it eventually sent back, not the
  // "Command running in background with ID: bzxsnq2zc" it answered with at launch.
  if (isBackgrounded(b)) return b.bg ? clip(b.bg.description) : 'running in background\u2026';
  if (isError) return firstLine(b.result) || 'failed';
  var meta = b.resultMeta || {};
  var name = b.name === 'Task' ? 'Agent' : b.name;
  switch (name) {
    case 'Read': {
      var n = meta.file && meta.file.numLines != null ? meta.file.numLines : countLines(b.result);
      return n + ' line' + (n === 1 ? '' : 's');
    }
    case 'Write': case 'Edit': case 'NotebookEdit': {
      var add = 0, del = 0;
      (meta.structuredPatch || []).forEach(function (h) {
        (h.lines || []).forEach(function (l) {
          if (l.charAt(0) === '+') add++; else if (l.charAt(0) === '-') del++;
        });
      });
      if (add || del) return '+' + add + ' \u2212' + del;
      return name === 'Write' ? countLines(input.content) + ' lines' : '';
    }
    case 'Grep': case 'Search': {
      // The tool answers in one of three shapes depending on output_mode; counting the
      // non-empty lines is the one reading that is right for all of them.
      var t = txt(b.result);
      if (/^No (matches|files) found/i.test(t.trim())) return 'no matches';
      var n = countLines(t);
      return n + ' match' + (n === 1 ? '' : 'es');
    }
    case 'Glob': {
      var t2 = txt(b.result);
      if (/^No files found/i.test(t2.trim())) return 'no files';
      var g = countLines(t2);
      return g + ' path' + (g === 1 ? '' : 's');
    }
    case 'TodoWrite': {
      var todos = input.todos || [];
      var done = todos.filter(function (t3) { return t3.status === 'completed'; }).length;
      return done + '/' + todos.length + ' done';
    }
    // A shell command's output is not a summary of itself. One line is worth showing —
    // that is the whole answer — but the first line of forty is a fragment ("PID STARTED
    // ELAPSED CMD", "{", "8"), which is worse than saying how much there is.
    case 'Bash': case 'PowerShell': {
      var n2 = countLines(b.result);
      return n2 <= 1 ? firstLine(b.result) : n2 + ' lines';
    }
    // These render their whole point in the body; a one-line echo of it on the header
    // would be the same words twice.
    case 'ExitPlanMode': case 'AskUserQuestion': case 'Skill': return '';
    default: return firstLine(b.result);
  }
}

// How long the tool took, for .tool-time. Only the child's task_started /
// task_notification pair can say — a tool_use block is written when the model asks,
// which in the probe was three seconds before execution began — so a card whose run
// was never announced (a seeded history entry, say) simply has no time to show.
function elapsed(b) {
  if (b.status === 'running') return b.runAt ? Math.max(0, Math.round((Date.now() - b.runAt) / 1000)) + 's' : '';
  if (!b.runAt || !b.endAt || b.endAt <= b.runAt) return '';
  var ms = b.endAt - b.runAt;
  return ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's';
}

// Backgrounded work — an agent, or a shell command started with run_in_background —
// reports back as an ordinary user message carrying the whole <task-notification>
// envelope. Rendering it verbatim leaks harness plumbing into the transcript, which is
// the leak the terminal client had to fix too.
//
// It is drawn the way the CLI draws it: the bullet, then the summary, at the size of
// everything else in the transcript. It used to be a .meta line — 12px, grey, no
// spacing, wedged under the card above it — which reads as a footnote, and a background
// command reporting that it FAILED is not a footnote. The envelope's <status> says which
// way it went, and the bullet carries that.
// Elapsed time is TRUNCATED, not rounded — 18625ms reads 18s.
function taskNotice(text) {
  var grab = function (re) { var m = re.exec(text); return m ? m[1] : null; };
  var summary = (grab(/<summary>([\\s\\S]*?)<\\/summary>/) || 'Task finished').trim();
  var ms = Number(grab(/<duration_ms>(\\d+)<\\/duration_ms>/) || 0);
  var status = (grab(/<status>([\\s\\S]*?)<\\/status>/) || '').trim();
  var bad = status === 'failed' || status === 'error' || /failed/.test(summary);
  var d = el('div', 'task-note' + (bad ? ' err' : ''));
  d.appendChild(el('span', 'bul', '⏺'));
  var body = el('span', 'note-text', summary);
  if (ms) body.appendChild(el('span', 'dur', ' · ' + Math.floor(ms / 1000) + 's'));
  d.appendChild(body);
  return d;
}
// A line the CLIENT puts in the transcript — an interrupt, a failed compaction. Shaped
// like a message so it takes its place in the flow and survives a repaint, and rendered
// by the same .task-note the child's own notifications use, because to a reader they are
// the same kind of thing: something happened to this session that nobody typed.
var NOTICE_SEQ = 0;
function noticeEntry(text, bad) {
  return { id: 'notice-' + (++NOTICE_SEQ), _rev: ++REV, role: 'notice', notice: { text: text, bad: !!bad } };
}

// The child injects this paragraph as the tool result when a permission is
// denied. It is coaching aimed at the model, not at the person who just clicked
// No, and echoing it back reads as the model scolding them.
var REJECTED = /^The user (doesn't want to proceed with this tool use|doesn't want to take this action)/;

// A local command and its output, collapsed like a tool card. Both kinds land here:
// the child's own /cost and /compact (normalized by the mux, whichever carrier they
// arrived in) and ccbb's // commands, which are synthesized locally. To a reader they
// are the same act, so they get the same shape rather than two.
function cmdNode(c) {
  var key = 'cmd:' + (c.id || c.name);
  var d = el('div', 'tool-card');
  d.dataset.tid = key;
  var hdr = el('div', 'tool-hdr');
  var tw = el('span', 'tool-toggle');
  tw.innerHTML = '&#9654;';
  hdr.appendChild(tw);
  // Output whose invocation this client never saw — attaching to a session mid-command,
  // most often — has no name to print, and a bare "/" is not a command anybody typed.
  hdr.appendChild(el('span', 'tool-name', c.name
    ? (c.local ? '//' : '/') + c.name + (c.args ? ' ' + c.args : '')
    : 'local command'));
  // Only when it was somebody else: your own label beside every command you ran is
  // noise, and the terminal client makes the same distinction.
  if (c.by && c.by !== LABEL) hdr.appendChild(el('span', 'who', c.by));
  // The docked panel's controls, on the card: minimize (the title bar alone), maximize
  // (the card takes the viewport), and detach (a window of its own, so a long //ihtml
  // report or a wall of //sh output stays up while the transcript scrolls underneath).
  var label = (c.local ? '//' : '/') + (c.name || 'command') + (c.args ? ' ' + c.args : '');
  var out = c.out || { kind: c.html ? 'html' : 'console', content: c.text || '' };
  if (c.state !== 'running') {
    var btns = el('span', 'tool-btns');
    btns.innerHTML = '<button class="flw-btn" data-c="min" title="Minimize">&#8211;</button>'+
      '<button class="flw-btn" data-c="max" title="Maximize">&#9633;</button>'+
      '<button class="flw-btn" data-c="pop" title="Detach to a floating window">&#10697;</button>';
    btns.addEventListener('click', function (e) {
      var b = e.target.closest('.flw-btn');
      if (!b) return;
      e.stopPropagation();
      if (b.dataset.c === 'pop') {
        floatWin((MACHINE ? MACHINE + ' ' : '') + sessionName(S.info) + ': ' + label,
          function (host) { host.appendChild(renderCmdOutput(out)); }, root);
      } else if (b.dataset.c === 'max') {
        var on = !d.classList.contains('max');
        d.classList.toggle('max', on);
        b.innerHTML = on ? '&#10064;' : '&#9633;'; b.title = on ? 'Restore' : 'Maximize';
        if (on && !body.classList.contains('open')) { body.classList.add('open'); tw.innerHTML = '&#9660;'; S.open[key] = true; }
      } else {
        d.classList.remove('max');
        if (body.classList.contains('open')) { toggleTool(hdr); S.open[key] = false; }
      }
    });
    hdr.appendChild(btns);
  }
  var meta = el('div', 'tool-meta');
  // ccbb has three pills — running, done, error. A command that worked says "ok"
  // rather than "done" because that is the word the state list asked for; the class
  // stays 'done' so it is ccbb's pill and not a fourth colour invented here.
  var word = c.noOutput ? 'local' : c.state;
  meta.appendChild(el('span', 'tool-status ' + (c.state === 'ok' ? 'done' : c.state), word));
  hdr.appendChild(meta);
  hdr.addEventListener('click', function () {
    toggleTool(hdr);
    S.open[key] = body.classList.contains('open');
  });
  d.appendChild(hdr);
  var body = el('div', 'tool-body');
  // The child's output carries real ANSI (that is how /cost colours its columns) and
  // a browser has nowhere to put it, so it is stripped rather than shown as literal
  // escape bytes. Nothing is lost that a reader could have used: the colour was the
  // only carrier, and the words are all still here.
  var t = String(c.text == null ? '' : c.text).replace(/\\u001b\\[[0-9;]*[A-Za-z]/g, '');
  // A ccbb // command came back typed — markdown, source, a document — and is drawn by
  // the same renderer as the docked panel. The child's own /commands are plain text.
  if (c.out && c.state !== 'running') { body.className += ' cmd-out'; body.appendChild(renderCmdOutput(c.out)); }
  else if (t.trim()) body.appendChild(pre(t.replace(/\\s+$/, '')));
  else body.appendChild(el('div', 'meta', c.state === 'running' ? 'running\u2026'
    : c.noOutput ? 'ran in the terminal \u2014 its output is not on the wire' : '(no output)'));
  d.appendChild(body);
  if (S.open[key]) { body.classList.add('open'); tw.innerHTML = '&#9660;'; }
  return d;
}

function msgNode(m) {
  // ccbb-web.js's message shape. .msg.you right-aligns and gives .msg-body the
  // bubble; a plain .msg is the model's prose at full width. .hist dims a turn that
  // came from the transcript on disk rather than from this run of the child.
  var wrap = el('div', 'msg' + (m.hist ? ' hist' : '') + (m.parentToolUseId ? ' nested' : ''));
  // Before the role branch on purpose: a command's result arrives as an assistant
  // message when it succeeds and as a replayed USER message after /compact, and
  // neither is a turn anybody said. Rendering it as one is what produced
  // "<local-command-stdout>Compacted </local-command-stdout>" in a speech bubble.
  if (m.notice) {
    var nd = el('div', 'task-note' + (m.notice.bad ? ' err' : ''));
    nd.appendChild(el('span', 'bul', '⏺'));
    nd.appendChild(el('span', 'note-text', m.notice.text));
    wrap.appendChild(nd);
    return wrap;
  }
  // The seam a compaction leaves. The summary behind it is the whole conversation and
  // nobody typed it, so it reads as a rule across the transcript with the numbers on it
  // — what went in, what came out, how long it took — and the text folded away behind a
  // click for when you want to see what was kept.
  if (m.compact) {
    var k = m.compact;
    var bits = [k.trigger === 'auto' ? 'auto' : 'manual'];
    if (k.preTokens) bits.push(fmtTokShort(k.preTokens) + ' \u2192 ' + fmtTokShort(k.postTokens) + ' tokens');
    if (k.durationMs) bits.push(Math.round(k.durationMs / 1000) + 's');
    var seam = el('div', 'cseam');
    var lab = el('button', 'cseam-lab', 'compacted \u00b7 ' + bits.join(' \u00b7 '));
    var sum = el('div', 'cseam-sum');
    sum.hidden = true;
    (m.blocks || []).forEach(function (blk) {
      if (blk && blk.type === 'text') sum.appendChild(document.createTextNode(blk.text || ''));
    });
    lab.onclick = function () { sum.hidden = !sum.hidden; };
    seam.appendChild(lab);
    wrap.appendChild(seam);
    wrap.appendChild(sum);
    return wrap;
  }
  if (m.command) {
    var c = m.command;
    wrap.appendChild(cmdNode({ id: m.id, name: c.name || '', args: c.args || '', by: m.by || '',
      local: !!c.local,
      // 'run' is the invocation with no result yet (a replayed <command-name> block);
      // stderr is the ONLY thing on the wire that says a command failed.
      state: c.kind === 'running' || c.kind === 'run' ? 'running'
        : c.stream === 'stderr' ? 'error' : 'ok',
      // A command the CLI answers in its OWN terminal (/usage, /context and their kind)
      // sends nothing back over stream-json. The mux settles the card when the next
      // message arrives and says so here, rather than leaving it spinning for output
      // that will never come.
      noOutput: !!c.noOutput,
      out: c.out || null,
      text: c.text || '' }));
    return wrap;
  }
  if (m.role === 'user') {
    var whole = (m.blocks || []).map(function (b) { return b && b.type === 'text' ? b.text || '' : ''; }).join('');
    // Anchored: a notification IS the message. Matching the tag anywhere in the text
    // swallowed any turn that quoted it — a 30k-character compaction summary of a
    // conversation about this very code rendered as the two words "Task finished".
    if (/^<task-notification>[\\s\\S]*<\\/task-notification>$/.test(whole.trim())) {
      wrap.appendChild(taskNotice(whole)); return wrap; }
    if (REJECTED.test(whole)) {
      wrap.appendChild(el('div', 'meta', 'Interrupted \u00b7 What should Claude do instead?'));
      return wrap;
    }
    // A synthetic user turn is the harness talking to the model, not a person.
    wrap.className += ' you';
    if (m.by) wrap.appendChild(el('div', 'by', m.by));
    var b = el('div', 'msg-body');
    (m.blocks || []).forEach(function (blk) {
      if (blk && blk.type === 'text') b.appendChild(document.createTextNode(blk.text || ''));
    });
    wrap.appendChild(b);
    return wrap;
  }
  (m.blocks || []).forEach(function (blk) {
    if (!blk) return;
    if (blk.type === 'text') {
      var t = el('div', 'msg-body');
      t.innerHTML = md(blk.text || '');
      wrap.appendChild(t);
    } else if (blk.type === 'thinking') {
      if (!(blk.text || '').trim()) return;
      var th = el('div', 'msg-body thinking');
      th.innerHTML = md(blk.text);
      wrap.appendChild(th);
    } else if (blk.type === 'tool_use') {
      var n = toolNode(blk);
      if (n) wrap.appendChild(n);
    } else if (blk.type === 'input') {
      return;                                  // partial tool JSON; the card shows it
    } else if (blk.type === 'image') {
      wrap.appendChild(el('div', 'meta', '[image]'));
    }
  });
  return wrap.firstChild ? wrap : null;
}

function displayList() {
  var extra = [];
  for (var k in S.stream) extra.push(S.stream[k]);
  // ccbb's own // commands, which the child never sees and the mux never stores. Each
  // one is pinned to the message that was last on screen when it was run, so it stays
  // where you ran it: parked at the end, every later turn slid in above them and the
  // transcript read as if the model had answered a command it never saw. One with no
  // message before it leads; one whose anchor is gone (a /clear, a shorter snapshot)
  // trails. They survive reset() either way, so a reconnect does not swallow an answer.
  // One run while a reply was still streaming is pinned to the reply's API id (the
  // only id it has before it lands), so it follows the whole reply once every piece
  // of it has arrived: text and tool calls from one API message land as several
  // entries sharing that id, and the command belongs after the last of them, not
  // between them — which is where it went when it was pinned to whatever was last
  // FINISHED, with the words the reader had just watched sliding in underneath it.
  var byAfter = {}, lead = [], orphan = [], hold = null, heldApi = null;
  S.cmds.forEach(function (c) {
    if (!c.after) lead.push(c);
    else (byAfter[c.after] = byAfter[c.after] || []).push(c);
  });
  var out = lead;
  function flush() { if (hold) { out = out.concat(hold); hold = null; heldApi = null; } }
  S.msgs.concat(extra).forEach(function (m) {
    if (hold && m.apiId !== heldApi) flush();
    out.push(m);
    if (byAfter[m.id]) { out = out.concat(byAfter[m.id]); delete byAfter[m.id]; }
    var ak = m.apiId ? 'api:' + m.apiId : null;
    if (ak && byAfter[ak]) { hold = (hold || []).concat(byAfter[ak]); heldApi = m.apiId; delete byAfter[ak]; }
  });
  flush();
  for (var id in byAfter) orphan = orphan.concat(byAfter[id]);
  return out.concat(orphan);
}

function paintAll() {
  var host = Q('.mx-log').firstChild;
  var list = displayList();
  var atBottom = nearBottom();
  var prev = null;
  list.forEach(function (m) {
    var n = nodes[m.id];
    if (!n || n._rev !== m._rev) {
      var made = msgNode(m);
      if (!made) { if (n && n.parentNode) n.parentNode.removeChild(n); delete nodes[m.id]; return; }
      made._rev = m._rev;
      if (n && n.parentNode) { host.replaceChild(made, n); refold(n, made); } else host.appendChild(made);
      nodes[m.id] = made;
      n = made;
    }
    // Keep DOM order in step with the model without rebuilding untouched nodes.
    if (prev ? prev.nextSibling !== n : host.firstChild !== n) host.insertBefore(n, prev ? prev.nextSibling : host.firstChild);
    prev = n;
  });
  var live = {};
  list.forEach(function (m) { live[m.id] = 1; });
  Object.keys(nodes).forEach(function (id) {
    if (!live[id]) { if (nodes[id].parentNode) nodes[id].parentNode.removeChild(nodes[id]); delete nodes[id]; }
  });
  if (atBottom) scrollDown();
  paintChrome();
}

// A card is rebuilt from scratch on every change to its message, and a rebuilt card
// starts in whatever fold state the model says — open while it runs, shut once it lands.
// So the moment a tool finished, a card the reader was looking into snapped shut in one
// frame and everything under it jumped up. The same fold the reader would have made by
// clicking slides; this makes the one the code makes slide too: the fresh card is put
// back into the state the old one showed, then toggled the way a click would be.
function refold(oldNode, newNode) {
  var was = {};
  var olds = oldNode.querySelectorAll('.tool-card[data-tid]');
  for (var i = 0; i < olds.length; i++) {
    var ob = olds[i].querySelector('.tool-body');
    if (ob) was[olds[i].dataset.tid] = ob.classList.contains('open');
  }
  var news = newNode.querySelectorAll('.tool-card[data-tid]');
  for (var j = 0; j < news.length; j++) {
    var card = news[j], tid = card.dataset.tid;
    if (!(tid in was)) continue;
    var hdr = card.querySelector('.tool-hdr'), body = hdr && hdr.nextElementSibling;
    if (!body || !body.classList.contains('tool-body')) continue;
    var open = body.classList.contains('open');
    if (was[tid] === open) continue;
    body.classList.toggle('open', was[tid]);
    toggleTool(hdr);
  }
}

function nearBottom() {
  var l = Q('.mx-log');
  return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
}
function scrollDown() {
  var l = Q('.mx-log');
  l.scrollTop = l.scrollHeight;
}

// ── The spinner ────────────────────────────────────────────────────────────
// "\u273b Mulling\u2026 (12s \u00b7 \u2193 1.2k tokens)" — the CLI's own line, from the CLI's own
// vocabulary (SPIN_VERBS/SPIN_FRAMES, handed in from ccbb-mux.js so the terminal
// client and this one spin on one list). The verb turns over every four seconds and
// the frame at 8Hz, both keyed off wall-clock rather than a counter, so two clients
// watching one session animate together.
var busyTimer = null, turnStart = 0;
function setBusy(busy) {
  if (busy && !busyTimer) {
    turnStart = Date.now();
    busyTimer = setInterval(paintBusy, 120);
  }
  if (!busy && busyTimer) { clearInterval(busyTimer); busyTimer = null; }
  paintBusy();
}
// The spinner's animation must follow the STATE, never the arrival of an event. It used
// to start on a status message and stop on another, which worked only because the child
// repeated 'requesting' several times a second — remove that flood (the mux dedupes it
// now) or attach to a turn already in flight, and the row would sit there frozen on the
// first verb it ever painted, at 0s, for the rest of the turn. Called from paintChrome,
// which every event reaches.
function syncBusy() {
  // Same test paintBusy paints from, so the timer and the row can never disagree — a
  // page with no socket cannot know a session is working, and must not animate as if it did.
  var want = (S.info || {}).status === 'busy' && !!(WS && WS.readyState === 1);
  if (want !== !!busyTimer) setBusy(want);
}
function paintBusy() {
  var row = Q('.mx-busy');
  if (!row) return;
  // A spinner says the session is working RIGHT NOW, which a page with no socket
  // cannot know. Left running while the connection is gone it ticks on forever with
  // whatever verb the session had when the wire went quiet.
  var busy = (S.info || {}).status === 'busy' && !!(WS && WS.readyState === 1);
  row.hidden = !busy;
  // Stop replaces send for as long as the turn runs. Before the composer's own control
  // said so, interrupting meant knowing about Esc or finding the button in the bar the
  // phone does not draw.
  var sb = Q('.send-btn'), kb = Q('.stop-btn');
  if (sb) sb.hidden = busy;
  if (kb) kb.hidden = !busy;
  if (!busy) return;
  var t = Date.now();
  // The mux's own turn clock wins: this page may have opened halfway through the turn.
  var started = (S.info || {}).turnStartedAt || turnStart;
  var secs = started ? Math.max(0, Math.round((t - started) / 1000)) : 0;
  row.querySelector('.mx-spin').textContent = SPIN_FRAMES[Math.floor(t / 120) % SPIN_FRAMES.length];
  var tok = (S.info || {}).outTokens;
  // The whimsical verbs are for an ordinary turn, where the CLI has nothing better to
  // say. When the child DOES name what it is doing — compacting, most of all, which
  // takes half a minute and used to look like a hung session — that word wins.
  var act = (S.info || {}).activity;
  var verb = (act && act !== 'requesting')
    ? act.charAt(0).toUpperCase() + act.slice(1)
    : SPIN_VERBS[Math.floor(t / 4000) % SPIN_VERBS.length];
  row.querySelector('.mx-verb').textContent =
    verb + '\u2026 (' + secs + 's' +
    (tok ? ' \u00b7 \u2193 ' + fmtTokShort(tok) + ' tokens' : '') + ')';
}

// One name for this session, everywhere it is drawn. The transcript's title is what
// ccbb's session list shows and what every non-mux session page shows; the mux's label
// is an ADDRESS (the name ccbb attach takes), and it stood in as the page's heading
// only because the title was not on the wire. It is now, so the label is not a name
// anything displays — it is only the fallback for a session too new to have a title.
function sessionName(i) {
  return (i && (i.title || i.label)) || SESSION.slice(0, 8);
}

// The shrink ladder's rungs, from ccbb's SHARED_JS. A host that did not include that
// file still gets a footer — one that never shrinks, which is what it did before.
var LVL = (typeof FOOT_LVL_CTX_LABEL === 'number')
  ? { pct: FOOT_LVL_PCT, clients: FOOT_LVL_CLIENTS, ctx: FOOT_LVL_CTX_LABEL }
  : { pct: 99, clients: 99, ctx: 99 };

// The status line, in ccbb web's own shape: money first, then turns, then context as
// current/peak. What is mux-specific — who else is attached, a credential refresh, the
// exit code, the last transient note — goes to the right, out of the way of the numbers
// people actually scan for. lvl is the shrink level fitFoot is trying; see the ladder in
// ccbb web's SHARED_JS, which both footers share so they give up detail in one order.
function footHtml(i, lvl) {
  var money = '<b>$' + Number(i.cost || 0).toFixed(2) + '</b>';
  // The plan windows, as ccbb's own pills. On a Claude.ai plan the dollars are notional
  // list price and these are the figure that actually runs out, so a status line without
  // them is missing the number people are really watching. footWin/subWinTitle come from
  // ccbb's SHARED_JS — the pill is one object, drawn by one function, in both clients.
  var pills = SUB && SUB.windows && typeof footWin === 'function'
    ? (function () {
        var w = SUB.windows, p = footWin('5h', w.fiveHour, lvl) + footWin('7d', w.sevenDay, lvl);
        return p ? '<span class="fwins" title="' + esc(subWinTitle(SUB)) + '">' + p + '</span>' : '';
      })()
    : '';
  var turns = '<span><b>' + (i.turns || 0) + '</b>' +
    (i.subTurns ? '<span class="sl-sub">+' + i.subTurns + '</span>' : '') + '</span>';
  var ctxStr = '';
  if (i.contextTokens) {
    // Only a peak the session has actually been above is worth a slot: at the high-water
    // mark "45K/45K" is the same number twice, crowding out figures that differ.
    var peak = (i.contextPeak || 0) > i.contextTokens ? i.contextPeak : 0;
    var ctxCost = i.stats && i.stats.context ? i.stats.context.cost : null;
    ctxStr = '<span class="sl-ctx">' + (lvl >= LVL.ctx ? '' : 'ctx:') +
      (i.contextPostCompact ? '~' : '') +
      '<b>' + fmtTokShort(i.contextTokens) + '</b>' + (peak ? '/' + fmtTokShort(peak) : '') +
      (ctxCost != null ? '/$' + Number(ctxCost).toFixed(2) : '') + '</span>';
  }
  var right = [];
  // "2 controllers" spelled out is four times the width of the fact it carries, and the
  // fact is only ever a small number of people.
  if (S.clients.length > 1 && lvl < LVL.clients) right.push(S.clients.length + 'x');
  if (i.auth && i.auth.isAuthenticating) right.push('refreshing credentials\u2026');
  if (i.exit) right.push('exited (' + (i.exit.code == null ? i.exit.signal : i.exit.code) + ')');
  var fresh = S.notes.filter(function (n) { return Date.now() - n.at < 20000; });
  var pin = fresh.filter(function (n) { return n.pinned; }).pop();
  var last = fresh[fresh.length - 1];
  if (pin) right.push(pin.text);
  if (last && last !== pin) right.push(last.text);
  return [money, pills, turns, ctxStr,
    right.length ? '<span class="sl-note">' + esc(right.join(' \u00b7 ')) + '</span>' : ''
  ].filter(Boolean).join('');
}

function paintChrome() {
  var i = S.info || {};
  var connected = !!(WS && WS.readyState === 1);
  syncBusy();
  // Guarded, not assumed: mounted inside ccbb web the bar belongs to the host view,
  // so none of these elements exist. Unguarded this threw on the first paint and
  // took the whole transcript with it.
  var bar = Q('.mx-bar');
  if (bar) {
    bar.querySelector('.label').textContent = sessionName(i);
    bar.querySelector('.cwd').textContent = i.cwd || '';
    var dot = bar.querySelector('.dot');
    dot.className = 'dot ' + (connected ? (i.status || 'idle') : 'gone');
    dot.title = connected ? (i.status || '') : 'disconnected';
  }
  var mode = Q('.mx-mode');
  if (mode && mode.value !== (i.permissionMode || 'default')) mode.value = i.permissionMode || 'default';

  var sl = Q('.sv-foot .sl');
  if (sl && typeof fitFoot === 'function') fitFoot(sl, function (lvl) { sl.innerHTML = footHtml(i, lvl); });
  else if (sl) sl.innerHTML = footHtml(i, 0);
  // Pushed OUT through one callback rather than letting the host reach into this
  // instance for it. One seam to keep correct, and the standalone page just does
  // not pass onChrome.
  if (ON_CHROME) ON_CHROME({
    title: sessionName(i), label: i.label || '', cwd: i.cwd || '',
    status: connected ? (i.status || 'idle') : 'gone', activity: i.activity || null,
    permissionMode: i.permissionMode || 'default',
    connected: connected, clients: S.clients.slice(), info: i, stats: i.stats || null,
  });
}

// ── Request cards ──────────────────────────────────────────────────────────
// Three kinds arrive on one 'request' event and are told apart by requestKind,
// because the mux gives clients one answer op rather than the child's three
// response envelopes. Getting the branch wrong is the one place a card can look
// right and answer the wrong thing.
function send(obj) { if (WS && WS.readyState === 1) WS.send(JSON.stringify(obj)); }

function permissionCard(p) {
  var input = p.payload.input || {};
  var name = p.payload.tool_name || 'tool';
  var isPlan = name === 'ExitPlanMode';
  var r = rendererFor(name);
  var head = (r.header || function () { return [name, '']; })(input);

  var c = el('div', 'card');
  c.appendChild(el('div', 'head', isPlan ? 'Ready to code?' : 'Allow ' + head[0] + (head[1] ? ' ' + head[1] : '') + '?'));
  var detail = el('div', 'detail');
  var made = r.body ? r.body(input, null, null, false) : null;
  if (made) detail.appendChild(made);
  else detail.appendChild(pre(JSON.stringify(input, null, 2)));
  c.appendChild(detail);

  var suggestions = p.payload.permission_suggestions || p.payload.permissionSuggestions;
  var bs = el('div', 'buttons');
  var yes = el('button', 'primary', isPlan ? 'Yes, and auto-accept' : 'Yes');
  yes.onclick = function () {
    // A plan accept is two actions, not one: allow the tool AND put the session
    // into acceptEdits. The mux does the second half only if planMode is sent,
    // and without it the next edit prompts again — the accept reads as not taken.
    send({ op: 'answer', requestId: p.requestId, allow: true, planMode: isPlan ? 'acceptEdits' : undefined });
  };
  bs.appendChild(yes);
  if (suggestions && suggestions.length) {
    var always = el('button', null, "Yes, and don't ask again");
    always.onclick = function () {
      send({ op: 'answer', requestId: p.requestId, allow: true, updatedPermissions: suggestions });
    };
    bs.appendChild(always);
  }
  var no = el('button', null, isPlan ? 'No, keep planning' : 'No');
  no.onclick = function () {
    send({ op: 'answer', requestId: p.requestId, allow: false, message: 'Denied from ccbb web' });
  };
  bs.appendChild(no);
  c.appendChild(bs);
  if (p.claimedBy) c.appendChild(el('div', 'claim', 'claimed by ' + p.claimedBy));
  return c;
}

function questionCard(p) {
  // AskUserQuestion is a tool, not a dialog: one tab per question, radio or
  // checkbox from multiSelect, plus the synthetic "Other" the plugin always adds.
  var input = p.payload.input || {};
  var qs2 = input.questions || [];
  var picks = {};
  qs2.forEach(function (q) { picks[q.question] = { set: {}, other: '' }; });
  var tab = 0;

  var c = el('div', 'card');
  c.appendChild(el('div', 'head', 'Claude has a question'));
  var tabs = el('div', 'qtabs'), body = el('div', 'qbody');
  var submit = el('button', 'primary', 'Submit answers');

  function chosen(q) {
    var st = picks[q.question];
    var out = Object.keys(st.set).filter(function (k) { return st.set[k]; });
    // An "Other" pick is REPLACED by the typed text, not accompanied by it.
    var i = out.indexOf('__other__');
    if (i >= 0) { out.splice(i, 1); if (st.other.trim()) out.push(st.other.trim()); }
    return out;
  }
  function valid() { return qs2.every(function (q) { return chosen(q).length > 0; }); }
  function drawBody() {
    body.innerHTML = '';
    var q = qs2[tab];
    if (!q) return;
    body.appendChild(el('div', null, q.question));
    var multi = !!q.multiSelect;
    (q.options || []).concat([{ label: '__other__', description: 'Other (type your own)' }]).forEach(function (o) {
      var lab = el('label');
      var inp = document.createElement('input');
      inp.type = multi ? 'checkbox' : 'radio';
      inp.name = 'q' + tab;
      inp.checked = !!picks[q.question].set[o.label];
      inp.onchange = function () {
        if (!multi) picks[q.question].set = {};
        picks[q.question].set[o.label] = inp.checked;
        drawBody(); redraw();
      };
      lab.appendChild(inp);
      var t = el('div');
      t.appendChild(el('div', null, o.label === '__other__' ? 'Other' : o.label));
      if (o.description) t.appendChild(el('div', 'desc', o.description));
      lab.appendChild(t);
      body.appendChild(lab);
      if (o.label === '__other__' && picks[q.question].set['__other__']) {
        var free = document.createElement('input');
        free.type = 'text';
        free.value = picks[q.question].other;
        free.placeholder = 'Your answer';
        free.oninput = function () { picks[q.question].other = free.value; redraw(); };
        body.appendChild(free);
        free.focus();
      }
    });
  }
  function redraw() {
    tabs.innerHTML = '';
    qs2.forEach(function (q, n) {
      var b = el('button', n === tab ? 'on' : null, (q.header || 'Q' + (n + 1)) + (chosen(q).length ? ' \\u2713' : ''));
      b.onclick = function () { tab = n; drawBody(); redraw(); };
      tabs.appendChild(b);
    });
    submit.disabled = !valid();
  }
  submit.onclick = function () {
    var out = {};
    qs2.forEach(function (q) { out[q.question] = chosen(q); });
    send({ op: 'answer', requestId: p.requestId, picks: out });
  };

  c.appendChild(tabs); c.appendChild(body);
  var bs = el('div', 'buttons');
  bs.appendChild(submit);
  c.appendChild(bs);
  drawBody(); redraw();
  return c;
}

function dialogCard(p) {
  // Only two dialog kinds ship today, and an unhandled one is PARKED by the child
  // rather than failed — so a wrong answer is worse than none. ccbb shows it and
  // offers only cancel; a more capable client can still settle it.
  var c = el('div', 'card');
  c.appendChild(el('div', 'head', 'Dialog: ' + (p.payload.kind || p.payload.dialog_kind || 'unknown')));
  c.appendChild(pre(JSON.stringify(p.payload, null, 2)));
  var bs = el('div', 'buttons');
  var x = el('button', null, 'Cancel');
  x.onclick = function () { send({ op: 'answer', requestId: p.requestId, payload: { behavior: 'cancelled' } }); };
  bs.appendChild(x);
  c.appendChild(bs);
  return c;
}

function paintCards() {
  var host = Q('.mx-cards').firstChild;
  host.innerHTML = '';
  Object.keys(S.pending).forEach(function (id) {
    var p = S.pending[id];
    host.appendChild(p.requestKind === 'question' ? questionCard(p)
      : p.requestKind === 'dialog' ? dialogCard(p) : permissionCard(p));
  });
  if (host.firstChild) scrollDown();
}

// ── Socket ─────────────────────────────────────────────────────────────────
var WS = null, retry = 0;
function connect() {
  if (dead) return;
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  var u = proto + '//' + location.host + BASE + '/mux?session=' + encodeURIComponent(SESSION) +
    '&label=' + encodeURIComponent(LABEL) + '&kind=web';
  // sinceSeq is what makes a backgrounded phone cheap to bring back: the mux
  // replays only what was missed, or falls back to a snapshot if the ring moved on.
  if (S.seq && S.epoch) u += '&since=' + S.seq + '&epoch=' + encodeURIComponent(S.epoch);
  if (TOKEN) u += '&token=' + encodeURIComponent(TOKEN);
  var ws = new WebSocket(u);
  WS = ws;
  ws.onopen = function () { retry = 0; paintChrome(); paintBusy(); };
  ws.onmessage = function (e) {
    var m;
    try { m = JSON.parse(e.data); } catch (err) { return; }
    if (m.op === 'snapshot') return reset(m);
    if (m.op === 'resumed') {
      // A resume that hands back a seq BEHIND this page's own means the mux restarted
      // under us: our transcript is from a process that no longer exists. Ask for a
      // snapshot outright rather than sit on it.
      if (m.seq != null && m.seq < S.seq) { S.seq = 0; send({ op: 'snapshot' }); return; }
      S.epoch = m.epoch || S.epoch;
      S.seq = m.from || S.seq; return paintChrome();
    }
    if (m.op === 'presence') { S.clients = m.clients || []; return paintChrome(); }
    if (m.op === 'ack') { if (m.error) note(m.error); return; }
    if (m.op === 'event') return apply(m);
  };
  ws.onclose = function () {
    WS = null; paintChrome(); paintBusy();
    if (dead) return;
    retry = Math.min(retry + 1, 6);
    reconnectTimer = setTimeout(connect, 250 * retry * retry);
  };
  ws.onerror = function () { try { ws.close(); } catch (e) {} };
}
// iOS freezes timers in a backgrounded tab, so the reconnect must also be driven
// by coming back to the foreground, not only by the socket's own close event.
function onVisible() { if (!document.hidden && !WS && !dead) connect(); }
document.addEventListener('visibilitychange', onVisible);

// ── Composer ───────────────────────────────────────────────────────────────
// ── ccbb's own commands ──────────────────────────────────────────────────────
// // runs against the ccbb server, not the child: //pwd, //cd, //help and whatever
// the install has configured. The route is ccbb web's, one level above the mux —
// BASE ends in /mux, so stripping that suffix reaches it from BOTH hosts, the tab
// inside ccbb web (where BASE may be /peer/<name>/mux) and the standalone page
// (where it is just /mux). Passing an explicit option instead would mean BOOT_JS
// had to compute the same thing and could compute it differently.
function ccbbBase() { return BASE.replace(/\\/mux$/, ''); }
var CMD_SEQ = 0;
// The plan windows. Read from ccbb rather than from the mux: it is a whole-account
// fact, ccbb already computes it, and ccbbBase() reaches it from both hosts. Failure is
// silent and the pills simply do not appear — a machine on an API key has no windows,
// and neither does a ccbb that is not answering.
var SUB = null;
function loadSub() {
  fetch(ccbbBase() + '/api/subscription', { headers: TOKEN ? { 'x-ccbb-token': TOKEN } : {} })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { if (d && d.account) { SUB = d; paintChrome(); } })
    .catch(function () {});
}

function runLocal(raw) {
  var b = raw.slice(2).trim();
  var sp = b.indexOf(' ');
  var name = sp === -1 ? b : b.slice(0, sp);
  var args = sp === -1 ? '' : b.slice(sp + 1);
  if (!name) return;
  // Everything the renderer needs lives inside .command, exactly as it does for a
  // command the child answered — one shape, one renderer, and no second path that
  // can be styled differently by accident.
  // Anchored to a message the mux numbered, not a page-local notice: a notice's id is
  // reissued after a reconnect, and a card pinned to one would drift.
  // A reply still streaming is the last thing on screen, so the card goes under it —
  // by API id, since the streamed entry is replaced by the real message when it lands.
  var after = null, sk = Object.keys(S.stream);
  if (sk.length) after = 'api:' + S.stream[sk[sk.length - 1]].apiId;
  for (var i = S.msgs.length - 1; i >= 0 && !after; i--) if (S.msgs[i].role !== 'notice') after = S.msgs[i].id;
  var entry = { id: 'local-' + (++CMD_SEQ), _rev: ++REV, after: after,
    command: { kind: 'running', name: name, args: args, local: true, stream: 'stdout', text: '' } };
  // The pseudo-message the transcript renders. It is its own shape rather than a
  // faked child message: nothing downstream should mistake this for something the
  // session said.
  S.cmds.push(entry);
  S.open['cmd:' + entry.id] = true;              // you just asked for it; show it
  paintAll();
  var h = { 'content-type': 'application/json' };
  if (TOKEN) h['x-ccbb-token'] = TOKEN;
  fetch(ccbbBase() + '/api/session/' + encodeURIComponent(SESSION) + '/command',
    { method: 'POST', headers: h, credentials: 'same-origin',
      body: JSON.stringify({ name: name, args: args, cwd: (S.info && S.info.cwd) || '' }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.kind === 'clear') { S.cmds = []; nodes = {}; return paintAll(); }
      entry.command.kind = 'out';
      entry.command.stream = d && d.error ? 'stderr' : 'stdout';
      // The whole typed result rides along: kind and lang decide how the card draws it.
      entry.command.out = d && !d.error ? { kind: d.kind, lang: d.lang, content: d.content || '' } : null;
      entry.command.text = d && d.error ? d.error : (d && d.content) || '';
      entry._rev = ++REV;
      paintAll();
    })
    .catch(function (e) {
      entry.command.kind = 'out'; entry.command.stream = 'stderr';
      entry.command.text = String(e); entry._rev = ++REV; paintAll();
    });
}

function wire() {
  // asTextarea() comes from ccbb-web.js's SHARED_JS — the same call its own composer
  // makes. It is a contenteditable, not a textarea: the send button sits in a notch
  // cut out of the last line by a floated ::after, and nothing flows around a float
  // inside a textarea. Sizing is CSS (min-height/max-height), so the autoGrow this
  // used to call is gone — a div is exactly as tall as its text.
  var input = asTextarea(Q('.input-box'));
  var sendBtn = Q('.send-btn');
  var expBtn = Q('.exp-btn');
  var histPrev = Q('.hist-btn[data-h="prev"]');
  var histNext = Q('.hist-btn[data-h="next"]');
  function submit() {
    var text = input.value;
    if (!text.trim()) return;
    histAdd(text);
    // // is ccbb's; everything else, / included, is the child's to interpret.
    if (text.trim().slice(0, 2) === '//') runLocal(text.trim());
    else send({ op: 'submit', text: text });
    input.value = '';
    setMax(false);
    input.focus();
  }
  sendBtn.addEventListener('click', submit);

  // — history —
  // Seeded from the turns already in the transcript, so the first ▲ reaches what was
  // sent before this page was opened rather than nothing. histDraft holds what you
  // had typed when you started walking back, so ▼ past the end returns it.
  var hist = [], histAt = -1, histDraft = '';
  function histAdd(t) {
    t = String(t || '').trim();
    if (!t) return;
    if (hist[hist.length - 1] !== t) hist.push(t);
    if (hist.length > 200) hist.shift();          // ccbb's cap, so both walk the same depth
    histAt = -1;
    syncHist();
  }
  function seedHistory() {
    hist = [];
    (S.msgs || []).forEach(function (m) {
      if (m.role !== 'user' || m.command) return;
      var t = (m.blocks || []).filter(function (b) { return b && b.type === 'text'; })
        .map(function (b) { return b.text || ''; }).join('').trim();
      if (t && t.charAt(0) !== '<' && hist[hist.length - 1] !== t) hist.push(t);
    });
    histAt = -1;
    syncHist();
  }
  function syncHist() {
    histPrev.disabled = !hist.length || histAt === 0;
    histNext.disabled = !hist.length || histAt === -1;
  }
  function histWalk(d) {
    if (!hist.length) return;
    if (histAt === -1) {
      if (d > 0) return;
      histDraft = input.value;
      histAt = hist.length - 1;
    } else {
      var next = histAt + d;
      if (next >= hist.length) { histAt = -1; input.value = histDraft; syncHist(); return; }
      histAt = Math.max(0, next);
    }
    input.value = hist[histAt];
    syncHist();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) {}
  }
  // mousedown is where the focus moves, so that is where it is refused: the caret stays
  // in the editable instead of being parked on the button, which is what makes a walk
  // back through the history leave you able to type. ccbb refuses it the same way.
  // (The row itself survives either way — these buttons are inside .input-inner, so
  // :focus-within still holds. Removing this handler fails nothing in the suite; it is
  // here because the caret is the point, not because the row would vanish.)
  Q('.input-tools').addEventListener('mousedown', function (e) {
    if (e.target.closest('.hist-btn,.exp-btn')) e.preventDefault();
  });
  // Clicking anywhere in the composer's frame — the padding, the gap beside the button —
  // means "I want to type here". Without this those pixels just drop the focus.
  Q('.input-row').addEventListener('mousedown', function (e) {
    if (e.target === input || e.target.closest('button')) return;
    e.preventDefault();
    input.focus();
  });
  histPrev.addEventListener('click', function () { histWalk(-1); input.focus(); });
  histNext.addEventListener('click', function () { histWalk(1); input.focus(); });
  ON_HISTORY = seedHistory;

  // — maximize —
  function setMax(on) {
    root.classList.toggle('input-max', !!on);
    expBtn.innerHTML = on ? '&#10063;' : '&#9633;';
    expBtn.title = on ? 'Shrink the composer back' : 'Expand the composer';
    input.focus();
  }
  expBtn.addEventListener('click', function () { setMax(!root.classList.contains('input-max')); });

  input.addEventListener('keydown', function (e) {
    // Ctrl/Cmd+Enter sends and Enter is a newline — the binding ccbb web's own
    // composer uses. Enter-sends costs you the message every time you reach for a
    // second line, and this is where long prompts get written.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      return submit();
    }
    // ccbb binds no arrow key here, with or without a modifier: the composer is a
    // multi-line editor — maximized it is the whole view — and up/down belong to the
    // caret. History is on the buttons in both clients.
    if (e.key === 'Escape' && !e.isComposing) {
      e.preventDefault();
      // Escape backs out of the maximized composer first; only from the normal one
      // does it reach the session and interrupt the turn.
      if (root.classList.contains('input-max')) return setMax(false);
      send({ op: 'interrupt' });
    }
  });
  syncHist();
  var modeSel = Q('.mx-mode');
  if (modeSel) modeSel.addEventListener('change', function (e) {
    send({ op: 'set_mode', mode: e.target.value });
  });
  var stopBtn = Q('.mx-stop');
  if (stopBtn) stopBtn.addEventListener('click', function () { send({ op: 'interrupt' }); });
  var killBtn = Q('.stop-btn');
  if (killBtn) killBtn.addEventListener('click', function () { send({ op: 'interrupt' }); });
  // A pane dragged narrower changes what fits with no session event behind it, and
  // nothing else would repaint the row.
  if (typeof onFootResize === 'function') onFootResize(Q('.sv-foot .sl'), paintChrome);
  connect();
  loadSub();
  input.focus();
}
// A deliberate debug surface. The terminal client could be watched through tmux;
// a page cannot, so socket state and the event sequence are published here rather
// than dug out of closures by whatever is inspecting it — the reconnect test in
// test/verify.js drives the client through exactly this. Per instance now, because
// two views on one page are two sockets and two sequences.
var handle = {
  seq: function () { return S.seq; },
  live: function () { return !!(WS && WS.readyState === 1); },
  drop: function () { if (WS) WS.close(); },
  errors: ERRORS,
  state: function () { return S; },
  session: SESSION,
  // Closing a view must take the socket AND the reconnect timer with it. The timer
  // is the one that bites: left running it re-opens a socket for a view that no
  // longer exists, so the mux goes on counting a client nobody can see and the
  // session never looks idle again.
  // closeSession says the VIEW was closed, not that the page went away — the mux
  // ends the session if that leaves nobody attached. Off by default, and the
  // standalone page never passes it: a reload there is a reload, and a session that
  // died because you refreshed its page would be worse than no auto-stop at all.
  destroy: function (o) {
    if (o && o.closeSession) send({ op: 'close' });
    dead = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (busyTimer) { clearInterval(busyTimer); busyTimer = null; }
    document.removeEventListener('visibilitychange', onVisible);
    if (WS) { try { WS.onclose = null; WS.close(); } catch (e) {} WS = null; }
    root.innerHTML = '';
  },
};
wire();
return handle;
};
})();
`;

// The CLI's spinner vocabulary, baked in at assembly time. ccbb-mux.js owns the lists —
// the terminal client reads them straight out of the same export — so the two clients
// cannot spin on different words, and neither file has to be edited twice to add one.
const APP_JS = APP_JS_SRC
  .replace('__SPIN_VERBS__', () => JSON.stringify(require('./ccbb-mux').SPIN_VERBS))
  .replace('__SPIN_FRAMES__', () => JSON.stringify(require('./ccbb-mux').SPIN_FRAMES));

// The standalone page. A thin caller of the factory — it parses the session out of
// its own URL, mounts one view, and republishes that view's debug handle as
// window.ccbb so the suites can drive it the way they always have. The two global
// error listeners stay HERE rather than in the factory: a syntax error in the page
// bundle happens outside any view, and inside the factory it would land nowhere.
const BOOT_JS = `
(function () {
'use strict';
var qs = new URLSearchParams(location.search);
var HERE = location.pathname.match(/^(.*)\\/s\\/([^/]+)/) || [];
var view = window.createMuxView(document.getElementById('app'), {
  base: HERE[1] || '',
  session: HERE[2] || '',
  token: qs.get('token') || '',
  label: qs.get('label') || 'web',
  machine: __MACHINE__,
  bar: true,
});
window.ccbb = view;
window.addEventListener('error', function (e) { view.errors.push(String(e.message)); });
window.addEventListener('unhandledrejection', function (e) { view.errors.push(String(e.reason)); });
})();
`;

// ccbb-web.js owns the stylesheet and the two page helpers (asTextarea, toggleTool)
// that this client's composer and tool cards are built out of. Required LAZILY: the
// dependency runs the other way at load time — ccbb-web.js requires this file for
// mount() — and a top-level require here would be a cycle that hands back a
// half-built module. Embedded, the host already put both on the page; only the
// standalone page needs them, and only when it is actually served.
// ccbb-web.js HANDS these over (setHostAssets, at the bottom of its module) rather
// than being required back for them. A lazy require looked like it broke the cycle and
// did not: ccbb-web.js requires this file while it is still evaluating, so a require
// that runs any earlier than the first HTTP request gets an exports object with
// neither constant on it yet — which is how the standalone page shipped with no
// stylesheet and no asTextarea, and the client threw on its first line.
var HOST = {};
function setHostAssets(a) { HOST = a || {}; }
function host() {
  if (HOST.APP_CSS) return HOST;
  try { return require('./ccbb-web'); } catch (e) { return {}; }
}
function hostCss() { return host().APP_CSS || ''; }
// The ccbb server's name, for titling output that leaves the page. The mux has no
// identity of its own; standalone it borrows ccbb's, and without that it is nameless.
function machineName() {
  try { return require('./ccbb-common').serverIdentity().name || ''; } catch (e) { return ''; }
}
function hostJs() { return host().SHARED_JS || ''; }

// The standalone page: the shell the factory mounts into, plus the two
// stylesheets. PAGE_CSS is the half an embedded view must NOT have — inside
// ccbb-web.js the host owns the body.
const APP_HTML = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light">
<title>ccbb mux</title>
<script src="https://cdn.jsdelivr.net/npm/marked@12/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11/highlight.min.js"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11/styles/github.min.css">
<style>__CCBB_CSS__</style>
<style>__APP_CSS__</style>
<style>__PAGE_CSS__</style>
</head><body>
<div id="app"></div>
<script>__SHARED_JS__</script>
<script>__APP_JS__</script>
<script>__BOOT_JS__</script>
</body></html>`;

// The index. Deliberately server-rendered and static: it is a list of links, and
// giving it the client's socket machinery would mean a second protocol consumer
// to keep correct for no gain.
function listPage(sessions, token) {
  const q = token ? `?token=${encodeURIComponent(token)}` : '';
  const rows = sessions.length ? sessions.map(s => {
    const esc = t => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const bits = [s.status, s.model, `${s.messages} msg`, s.clients ? `${s.clients} client${s.clients === 1 ? '' : 's'}` : null]
      .filter(Boolean).join(' · ');
    return `<a class="row" href="s/${encodeURIComponent(s.id)}${q}">
      <span>${esc(s.label || s.id.slice(0, 8))}</span>
      <span class="id">${esc(s.cwd)}</span>
      <span style="margin-left:auto" class="id">${esc(bits)}</span></a>`;
  }).join('') : '<p class="id">No sessions. Start one with <code>ccbb new</code>.</p>';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light"><title>ccbb mux</title>
<style>${hostCss()}</style><style>${APP_CSS}</style><style>${PAGE_CSS}</style></head><body>
<div class="muxv plain"><div class="sessions"><h1>ccbb mux</h1>${rows}</div></div></body></html>`;
}

// ── Mounting ─────────────────────────────────────────────────────────────────
// Returns a handler for the requests the mux's own /api routes did not claim.
// Truthy return means "handled"; falsy lets the mux fall through to its 404, so
// adding the UI cannot change the behaviour of the API.
function mount(mux) {
  // Built on the first request, not here: mount() runs from the Mux constructor, which
  // can be reached while ccbb-web.js is still loading, and the host assets are not on
  // its exports until it finishes. Memoized after that.
  let page = null;
  const pageHtml = () => page || (page = APP_HTML
    .replace('__CCBB_CSS__', () => hostCss()).replace('__SHARED_JS__', () => hostJs())
    .replace('__APP_CSS__', () => APP_CSS).replace('__PAGE_CSS__', () => PAGE_CSS)
    .replace('__APP_JS__', () => APP_JS).replace('__BOOT_JS__', () => BOOT_JS)
    // After BOOT_JS is in, since that is where the placeholder lives.
    .replace('__MACHINE__', () => JSON.stringify(machineName())));
  // subPath is the path with the host's prefix already stripped. Standalone there is
  // no prefix and req.url is the whole of it; under ccbb web it is /mux/... and only
  // the caller knows how much to remove.
  return function (req, res, subPath) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let p = subPath;
    if (!p) { try { p = new URL(req.url, 'http://x').pathname; } catch { return false; } }
    const html = body => {
      const b = Buffer.from(body);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length,
        'cache-control': 'no-store' });
      res.end(req.method === 'HEAD' ? undefined : b);
      return true;
    };
    if (ATTACH_PATHS.includes(p)) return html(listPage(mux.list(), mux.token));
    if (/^\/s\/[^/]+$/.test(p)) return html(pageHtml());
    return false;
  };
}

// ── Mux sessions in ccbb web's list ──────────────────────────────────────────
// The mux runs inside `ccbb web` — same process, same port — so this is a shape
// conversion and nothing more. It used to be a client: an address file, a token
// header, an HTTP hop with a timeout, a 2s poll and a cache to hide the latency.
// All of it existed to reach another process, and none of it survived that process
// going away.
// The mux's sessions, shaped like ccbb's own rows so the two can be merged into one
// list. A plain synchronous map over mux.list() — the mux is in this process now, so
// the HTTP hop, the 1.5s timeout, the poll and the cache that stood between this and
// the truth are all gone, and with them the window where the list was stale.
function muxRows(mux) {
  if (!mux) return [];
  return mux.list().map(x => ({
    sessionId: x.id,
    title: x.title || x.label || '',
    live: x.status !== 'exited',
    liveStatus: x.status || null,
    projectPath: x.cwd || '',
    startedAt: x.startedAt || null,
    lastActivity: x.lastActivity || null,
    totalCost: x.cost || 0,
    totalTokens: x.tokens || 0,
    turns: x.turns || 0,
    mux: true,
    muxClients: x.clients || 0,
    muxPending: x.pending || 0,
  }));
}

// Merge those rows into a getSessions() payload, in place.
//
// A mux session runs a real child with --session-id, or resumes one in place under
// its existing id, so it writes an ordinary transcript and the disk scan may already
// have found it — from DISK, and so without knowing that it is live or how to open
// it. Merging on the session id is what keeps that from becoming two rows for one
// session.
function mergeMuxRows(payload, mux) {
  const rows = muxRows(mux);
  if (!rows.length || !payload || !Array.isArray(payload.sessions)) return payload;
  const at = new Map(payload.sessions.map((x, i) => [x.sessionId, i]));
  for (const r of rows) {
    const i = at.get(r.sessionId);
    if (i == null) { payload.sessions.push(r); continue; }
    Object.assign(payload.sessions[i], {
      mux: true, live: r.live, liveStatus: r.liveStatus,
      muxClients: r.muxClients, muxPending: r.muxPending,
      title: payload.sessions[i].title || r.title,
      lastActivity: r.lastActivity || payload.sessions[i].lastActivity,
    });
  }
  return payload;
}

module.exports = { setHostAssets, mount, APP_CSS, PAGE_CSS, APP_JS, BOOT_JS, APP_HTML, listPage,
  muxRows, mergeMuxRows };
