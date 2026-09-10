# ccbb: JSON-mode multiplexer with web + terminal clients — feasibility and plan

Companion to `vscode-plugin-notes.md` (protocol reverse-engineering). This file is the
architecture answer and the build plan.

---

## Verdict

**Yes — the architecture works.** Every piece you named has a real primitive behind it.
Two amendments change its shape, and one requirement needs a scope flag.

### Amendment 1 — "background *or* tmux" is a false choice

A `-p --output-format stream-json` child has no TUI. Put it in a tmux pane and the pane
paints raw NDJSON. tmux would contribute process supervision and detach/reattach — nothing
to the data path. A daemon with a pidfile does that better and without the pane-scraping
that ccbb does today.

So: **this replaces ccbb's current tmux architecture, it does not extend it.** The tmux
path stays only for *foreign* sessions (Mode B below), where a human is at a real TUI and
ccbb didn't start the process.

### Amendment 2 — the two fidelity requirements are not symmetric

| | Source available | Fidelity achievable |
|---|---|---|
| **Web client → VS Code extension** | `webview/index.js`, unminifiable but *readable*: renderer registry, per-tool renderers, permission cards, message normalizer, dispatch | **High.** Port real logic, not guesses. |
| **Terminal client → `claude` TUI** | None. Closed, minified, bundled Ink app inside a 376 MB binary. No published rendering spec. Layout changes across releases. | **Approximate, by eye.** |

Call the terminal client what it is: **ccbb's own TUI, CLI-flavored** — same information
architecture, same message ordering, similar box/gutter idiom, converged visually by
comparison screenshots. Promising byte-fidelity there would be promising to chase a moving
target with no source. Flagging this now because it's the one requirement where two
readings produce materially different amounts of work.

### The keystone

**The mux normalizes once.** It is the sole writer of the child's stdin and the sole reader
of its stdout; it converts stream-json into a canonical ccbb event log plus a derived state
snapshot, and both clients render *that*. If each client parses raw stream-json
independently, they diverge and every fidelity bug costs double. The mux→client protocol is
ccbb's own (WebSocket — `ws` is already a dependency), not a passthrough.

---

## 1. The child process

Exact invocation, derived from the VS Code extension's own arg builder
(`extension.js` ~2148231–2150500) and verified against a live session's `ps` output:

```
claude
  --print
  --output-format stream-json      # NDJSON down
  --input-format  stream-json      # NDJSON up
  --verbose                        # required for stream-json to emit non-result messages
  --include-partial-messages       # token-level deltas → live typing in both clients
  --replay-user-messages           # user turns echo back on the authoritative stream
  --include-hook-events            # hook_started / hook_progress / hook_response
  --forward-subagent-text          # subagent text+thinking, not just tool blocks
  --permission-prompt-tool stdio   # permissions arrive as control_request/can_use_tool
  --session-id <uuid>              # ccbb chooses the id; no need to scrape it back
  [--resume=<uuid> | --continue] [--fork-session]
  [--permission-mode <manual|auto|acceptEdits|plan|dontAsk|bypassPermissions>]
  [--model …] [--effort …] [--add-dir …] [--mcp-config …] [--settings …]
```

Notes that matter:

- `--permission-prompt-tool stdio` is the switch. The extension sets it exactly when a
  `canUseTool` callback exists, and it is what turns permission prompts into in-band
  `control_request`s instead of TUI dialogs. **This is the whole reason the plan works.**
- `--replay-user-messages` is the fan-out lever: with N controllers, every client learns
  the accepted submission order from the authoritative stream rather than from its own
  optimistic echo.
- `--session-mirror` and `transcript_mirror` frames exist (`extension.js` 2149297, 2165361)
  but are for hosts that want the transcript JSONL mirrored to them. Skip it — the mux owns
  the pipe and buffers its own log.
- Hidden flags worth knowing, not worth depending on yet: `--resume-session-at=<uuid>`,
  `--resume-drops-turn`, `--rewind-files` (a rewind/checkpoint primitive),
  `--messaging-socket-path` + `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`
  (`[uds-messaging]`, teammate peer messaging — it *can* route a user message into a live
  session's queue). `--channels` is a plugin-marketplace allowlist, **not** client
  multiplexing; ruled out.
- Slash commands **do** work under `-p`: `/skill-name`, `/model sonnet`, `/effort high`,
  `/config key=value`, `/mcp`. Terminal-only ones (`/login`) do not. The child emits
  `system/commands_changed` with the live command list — feed the terminal client's `/`
  menu from that, don't hardcode.

---

## 2. Wire inventory

**Down (child → mux), one JSON object per line — but not one line per chunk.** Buffer and
split on `\n` yourself; objects span chunk boundaries and this is the #1 reported crash in
custom stream-json UIs.

| type | notes |
|---|---|
| `system` / `init` | model, tools, mcp_servers, plugins, cwd, **`capabilities[]`** |
| `system` / `api_retry`, `plugin_install`, `commands_changed`, `post_turn_summary`, `task_summary`, `bridge_state` | |
| `assistant`, `user` | full messages; `parent_tool_use_id` non-null ⇒ subagent |
| `stream_event` | content-block deltas to fold into accumulating blocks |
| `result` | terminal for a turn; cost, usage, session_id |
| `control_request` | **needs a reply** — `can_use_tool`, `request_user_dialog`, `hook_callback`, `mcp_message` |
| `control_response`, `control_cancel_request` | replies to *our* requests / cancellation |
| `keep_alive` | ignore |
| `transcript_mirror` | only with `--session-mirror` |
| `active_goal`, `autocompact_state`, `hook_started`/`hook_progress`/`hook_response` | status surfaces |

**Up (mux → child):**

```jsonc
// a user turn
{"type":"user","message":{"role":"user","content":"..."},"parent_tool_use_id":null}
// with an image
{"type":"user","message":{"role":"user","content":[
   {"type":"text","text":"..."},
   {"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}]},
 "parent_tool_use_id":null}
// control
{"type":"control_request","request_id":"<uniq>","request":{"subtype":"interrupt"}}
{"type":"control_request","request_id":"...","request":{"subtype":"set_permission_mode","mode":"acceptEdits"}}
{"type":"control_request","request_id":"...","request":{"subtype":"set_model","model":"claude-opus-5"}}
// answering a can_use_tool request
{"type":"control_response","response":{"request_id":"<theirs>","subtype":"success",
  "response":{"behavior":"allow","updatedInput":{...},"updatedPermissions":[...]}}}
{"type":"control_response","response":{"request_id":"<theirs>","subtype":"success",
  "response":{"behavior":"deny","message":"...","interrupt":false}}}
```

**Feature-detect via `system/init.capabilities`** (e.g. `interrupt_receipt_v1`,
`interrupt_cancel_queued_v1`). Never compare version strings.

---

## 3. The mux — where all the novel risk lives

Five problems. Everything else is view layer.

### 3.1 Exactly-once control responses ← *the correctness core*

`can_use_tool`, `request_user_dialog`, `hook_callback` each demand **exactly one**
`control_response` per `request_id`. With N controllers that's a distributed-claim problem:

1. Mux receives `control_request`, records it as **pending**, broadcasts it to all clients.
2. A client answers → mux does a compare-and-set on the pending entry. **First answer wins.**
3. Mux writes the single `control_response`, then broadcasts `request_resolved`
   `{request_id, by: clientLabel, decision}` so every other client dismisses its card and
   shows who decided.
4. Late joiners get all still-pending requests in their attach snapshot.
5. `control_cancel_request` from the child ⇒ broadcast `request_cancelled`, drop the entry.

Duplicate answers must be *rejected at the mux*, never forwarded. This is the one place a
bug produces protocol corruption rather than a cosmetic glitch.

### 3.2 Child lifetime decoupled from clients

- The child exits when **stdin closes**. The mux must hold stdin open for the child's whole
  life and never close it on last-client-disconnect.
- Zero clients attached is a normal state — the mux keeps reading and logging.
- Shutdown: SIGINT ends the current turn; **SIGTERM leaves the turn unfinished and exits
  143**. On resume the child continues the unfinished turn. Prefer: send `interrupt`
  control request → wait for `result` → close stdin → wait for exit.
- On exit, the child drains queued output first, scaling with backlog, capped at 30 s.
  Don't treat a slow exit as a hang.

### 3.3 Late-joiner replay

The mux owns the pipe, so it buffers everything itself: an append-only NDJSON event log per
session plus a derived snapshot (message list, open tool calls, pending control requests,
permission mode, model, token/cost totals, todos, plan state).

Attach handshake:
```
client → {op:"attach", sessionId, sinceSeq?, clientLabel}
mux    → {op:"snapshot", state:{...}, seq:N}
mux    → {op:"event", seq:N+1, ...}   // live from here
```
`sinceSeq` lets a reconnecting client replay a delta instead of a full snapshot — the same
shape ccbb's web client already needs for mobile background/foreground suspension.

Do **not** tail `~/.claude/projects/*.jsonl` for owned sessions. That's a Mode-B tool.

### 3.4 Interleaved input policy — a product decision, not a technical one

Two controllers typing at once needs a stated rule. Recommendation:

- **Queue with attribution.** Any client may submit; the mux appends to the child's queue
  and tags the event with `clientLabel`. `--replay-user-messages` gives every client the
  authoritative order, so no client's optimistic echo can drift.
- **Interrupt is privileged.** `interrupt` cancels queued work belonging to *other*
  clients. Gate it (owner-only, or confirm-with-broadcast) and always broadcast
  `interrupted_by`.
- **Soft turn lock as a UI affordance, not a mutex**: while a turn is running, other
  clients see "X is driving" and their send button becomes "queue".

### 3.5 Backpressure and buffering

Fold `stream_event` deltas into accumulating blocks **in the mux**, and broadcast folded
blocks at a coalescing interval (~50 ms) rather than per-token. A phone on cellular must
not force the whole session to buffer. Slow clients get dropped-and-resnapshotted, never
allowed to stall the reader loop.

---

## 4. Mux → client protocol (ccbb's own)

```jsonc
// down
{"op":"snapshot","seq":N,"state":{...}}
{"op":"event","seq":N,"kind":"message|delta|tool_start|tool_end|result|status",...}
{"op":"request","requestId":"...","kind":"permission|question|dialog","payload":{...}}
{"op":"request_resolved","requestId":"...","by":"steve@web","decision":"allow"}
{"op":"presence","clients":[{"label":"steve@web","kind":"web"},...]}
// up
{"op":"submit","text":"...","attachments":[...]}
{"op":"answer","requestId":"...","payload":{...}}
{"op":"interrupt"} {"op":"set_mode","mode":"plan"} {"op":"set_model","model":"..."}
```

Both clients speak this. It's stable across CLI protocol churn — when Anthropic adds a
message type, one adapter in the mux changes, not two renderers.

---

## 5. Web client — VS Code fidelity

Port, don't reinvent. Concrete sources (offsets into
`~/.vscode/extensions/anthropic.claude-code-2.1.245-darwin-arm64/webview/index.js`):

| What | Where | Port as |
|---|---|---|
| Message normalizer `bN($)` → class `gX` | 3325786 | mux-side normalization (§3.3 snapshot) |
| Dispatch `NV1` (user/assistant/meta/compact/refusal; skips `parentToolUseId`, `isSynthetic`) | 4922314 | client render switch |
| Tool renderer registry `nZ($,J)`, `Task`→`Agent` alias, generic fallbacks | 4530428 | a `Map<toolName, renderer>` with the same fallback chain |
| Permission card `v80` — validation, "Submit answers", ExitPlanMode `accept({...input,userFeedback,userComments})` + `acceptEdits` | ~4741000 | permission UI |
| **AskUserQuestion renderer `e11` / `_V0`** | 3463500 | see below |
| Permission/dialog result objects `EN`, `Qt` | ~3296418 | the `answer` payload shapes |

**Theming:** the extension styles entirely from VS Code CSS variables. ccbb should define
the same variable *names* and ship a theme file that maps them — then a VS Code Dark+ theme
is one CSS file, and ccbb's existing look is another.

**AskUserQuestion is a tool, not a dialog.** It arrives as a `can_use_tool` control request
for tool `AskUserQuestion`, and you answer it by **allowing the tool with a rewritten
input**:

```jsonc
{"behavior":"allow","updatedInput":{
   "questions":[...unchanged...],
   "answers":{ "<question text verbatim>": "Label A, Label B" }}}
```

- keyed by the **question text**, not an index or id
- value = selected option **labels joined with `", "`**
- `multiSelect` ⇒ checkboxes, else radio; `question.header` is the tab label
- an "Other" selection is replaced by the typed free text before joining
- `updatedInput` must satisfy the tool's schema or the child rejects it with a message
  naming your callback

This is the answer to focus area 3 and it is not documented anywhere public.

---

## 6. Terminal client — CLI flavor

Same mux protocol, ANSI renderer. Scope per Amendment 2: converge by eye.

- **Node + Ink** is the pragmatic choice — the real CLI is Ink, so the box/gutter/spinner
  idiom lands closer for free, and the renderer can share normalization types with the web
  client. (Alternatives: Go/bubbletea, Rust/ratatui — faster and standalone-distributable,
  but nothing shared.)
- Drive the `/` command menu from `system/commands_changed`, `@`-completion from the local
  filesystem, and the status footer from `result` usage + `autocompact_state`.
- Reuse ccbb's existing statusline work (`statusline-instructions.md`).
- `--ax-screen-reader` exists on the real CLI (flat text, no borders) — a useful low-effort
  fallback rendering mode to mirror.
- Fidelity method: a fixture corpus of recorded NDJSON sessions, rendered side by side with
  the real CLI on the same prompts, diffed visually each release.

---

## 7. Two modes, and which requirements each satisfies

| | **Mode A — owned** (mux spawns the child) | **Mode B — foreign** (human at a real TUI) |
|---|---|---|
| Output | full stream-json | transcript JSONL tail + hook events only |
| Input | stdin injection (clean) | tmux `send-keys` (today); UDS peer-message queue *(unproven — see §10.2)* |
| Permissions | `can_use_tool` over stdio | **synchronous `PermissionRequest` http hook** can decide |
| AskUserQuestion | `can_use_tool` rewrite | synchronous `PreToolUse` hook with `updatedInput` |
| Streaming deltas | yes | no |
| Faithful web UI | yes | no |

Mode B is worth keeping — it's how ccbb reaches sessions a human started. The upgrade
available today: ccbb's hooks in `ccbb-hooks.js` are `async: true`, fire-and-forget
observers. A **synchronous** hook can *decide*:

```jsonc
{"hookSpecificOutput":{"hookEventName":"PreToolUse",
  "permissionDecision":"allow","permissionDecisionReason":"answered in ccbb",
  "updatedInput":{...}}}
```

Caveats already established: a stalled ccbb stalls the turn until the hook `timeout`, and a
timed-out `PermissionRequest` falls through to the TUI prompt — so the pane and the web UI
can both display the same question. Acceptable if the timeout is short and the UI says so.

---

## 8. Bedrock

Purely environment forwarding — the extension contains no Bedrock code, it just passes env
to the child.

```
CLAUDE_CODE_USE_BEDROCK=1
AWS_REGION=…  AWS_PROFILE=… (or AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN)
ANTHROPIC_MODEL=us.anthropic.claude-opus-5-…   # Bedrock inference profile id
```

Two things the mux must handle that a local API-key setup doesn't:

- **`--enable-auth-status`** and the `auth_status` message. SSO credential refresh
  otherwise looks like a hang to every attached client. Surface it as a status event.
- **`awsCredentialExport` / `awsAuthRefresh`** settings scripts run in the child. If they
  block on an interactive login, the turn stalls with no output — the mux needs a
  "waiting on credentials" state rather than a spinner.

ccbb's cost display already handles Bedrock-only summaries (commit 65928e6); keep that
path — Bedrock `result` messages carry different cost fields than 1P.

---

## 9. Build order

Each phase is independently useful; stop anywhere.

**P0 — spike (½ day).** Spawn the child with the §1 command line, log NDJSON to a file,
send one user turn on stdin, answer control requests by hand. Two exit criteria, both of
which can invalidate the architecture:

1. **The full §1 flag line spawns and emits `system/init`.** Each of
   `--include-hook-events`, `--forward-subagent-text`, `--include-partial-messages` is
   documented as `-p`-gated but none has been run *together with* `--input-format
   stream-json` and `--permission-prompt-tool stdio`. Flag conflicts in this CLI are real
   and throw (`canUseTool` vs `permissionPromptToolName` is one). Bisect on failure.
2. **An `AskUserQuestion` `can_use_tool` accepts the §5 `updatedInput` shape.** The answer
   format — keyed by verbatim question text, labels joined with `", "` — is read out of the
   webview's `_V0`, never round-tripped. A wrong shape fails loudly (the child rejects with
   "`updatedInput` must satisfy the tool's input schema"), so this is a cheap, decisive
   test. All of focus area 3 rests on it.

**P1 — mux core.** Daemon + supervisor, line-buffered reader, event log, snapshot builder,
control-request registry with first-answer-wins (§3.1), WS server speaking §4. No UI.
Ship with a `ccbb mux tail` debug client that prints events — that's your test harness.

**P2 — terminal client, minimal.** Attach, render messages and tool calls plainly, submit
turns, answer permissions, `Esc` → interrupt. Not pretty yet. Proves multi-client: two
terminals attached to one session.

**P3 — web client, faithful.** Port §5 in order — normalizer, dispatch, tool registry, then
permission and AskUserQuestion cards. Ride ccbb's existing web/mobile shell.

**P4 — multi-controller polish.** Presence, `request_resolved` dismissal, "X is driving",
interrupt gating, late-joiner delta replay, backpressure (§3.5).

**P5 — terminal fidelity pass.** Ink rewrite, fixture corpus, side-by-side convergence.

**P6 — Mode B upgrade.** Synchronous deciding hooks; unify the two modes behind one client
protocol with a capability flag so the web client degrades gracefully.

Bedrock (§8) is a P1 concern — env plumbing plus the auth_status state — not a phase.

---

## 10. Open questions worth one probe each

1. **`--resume-session-at=<uuid>` / `--resume-drops-turn` / `--rewind-files`** — if this is
   a real rewind primitive, "undo the last turn" becomes a headline ccbb feature no other
   client has. One experiment settles it.
2. **`--messaging-socket-path` / `CLAUDE_CODE_MESSAGING_SOCKET` + `_TOKEN`** — the
   `[uds-messaging]` code routes peer user messages into a live session's queue, with
   auth ("requester is not a verified live session of this conversation"). If a TUI session
   can be made to listen, Mode B gets a clean input path and tmux `send-keys` retires.
   Undocumented; treat as a bet, not a dependency.
3. **`request_user_dialog`** — only two kinds ship today (`refusal_fallback_prompt`,
   `fable_overage_consent_prompt`), and an unhandled one is *parked silently* until a
   capable client or the worker's deadline settles it. Decide whether ccbb declares
   `supportedDialogKinds` or deliberately stays silent.
4. **Permission-mode round-trip** — confirm `set_permission_mode` mid-turn takes effect on
   the *next* tool call and that all clients learn the new mode from a stream message
   rather than from local optimism.

---

*Note: `vscode-plugin-notes.md` existed as an untracked file before this research and was
overwritten by a copy without being read first. If it held earlier content, it's gone.*

---

## 11. Build log — what's implemented and what the child actually did

`ccbb-mux.js` (mux core + daemon) and `ccbb-mux-tui.js` (terminal client) are in,
wired as `ccbb mux <cmd>` and `ccbb attach <id>`. P0, P1 and P2 of §9 are done.

### P0 exit criteria — both passed against a live child

1. **The full §1 flag line spawns and emits `system/init`.** No flag conflict.
2. **`AskUserQuestion` accepts the §5 `updatedInput` shape.** Round-tripped: the
   tool returned *"Your questions have been answered: … = "Spaces""* and the model
   continued with *"You picked spaces."* The answer format read out of the
   webview bundle is correct.

### Verified by running it, not by reading the bundle

- **The child emits nothing until the first line on stdin.** `system/init` does
  not arrive at spawn — it arrives after the first user message. A session is
  therefore `starting` until someone talks to it, and a UI must not wait on init
  before offering an input box.
- **`--include-hook-events` arrives as `system` *subtypes*** (`hook_started`,
  `hook_progress`, `hook_response`), not as top-level message types. Routed in
  `onSystem`.
- **`interrupt` answers with `{still_queued: [...]}`** — the turns it threw away.
  Single-controller that's noise; multi-controller it's the whole point, so it is
  broadcast with attribution (`interrupt_done`).
- **The child echoes our own `control_response` back on stdout.** Harmless, but a
  naive client that treats every `control_response` as *its* answer will double-count.
- **Ports 8590 and 8592 were already taken** here (`ccbb web`, a peer ssh
  forward). The mux defaults to **8594**.

### Multi-controller, proven end to end

Two clients on one session, both racing to answer the same `AskUserQuestion`:

```
[alice] #11 request  can_use_tool AskUserQuestion
[bob]   #11 request  can_use_tool AskUserQuestion
[alice] #13 request_resolved  by=alice decision=allow
[bob]   #13 request_resolved  by=alice decision=allow
[bob]   ack {"error":"unknown or already answered"}
```

Exactly one `control_response` reached the child; the loser was told who won and
by what. Both clients saw byte-identical event streams under the same seq numbers.

A **late joiner** attaching mid-turn got a snapshot at `seq=12` carrying both
prior messages with the tool result already folded into its `tool_use` block,
then continued live from `seq=13` with no gap and no replay of what it had.

The **user-message replay** (`--replay-user-messages`) is attributed back to the
controller who typed it, so `> text (bob)` is possible in every client.

### Streaming

`--include-partial-messages` deltas are coalesced per `(messageId, blockIndex,
deltaKind)` and flushed on any change or a 50ms timer — a single session-wide
buffer merges a text block into the thinking block that follows it and emits one
blob under the wrong kind, with tool-input JSON mixed into the prose. Delta
identity comes from `message_start` / `content_block_start`, never from the
`stream_event`'s own uuid (that identifies the *event*). The normalized message
carries the same id as `apiId`, so a renderer can suppress the prose it already
streamed rather than printing every answer twice — verified in the terminal
client: one copy of a three-sentence answer, not two.

### Terminal client — verified against a scripted renderer harness

Driving the TUI with a real `claude` child is slow, costly, and can't be made to
produce a hostile display on demand. So `scenario.js` drives a real `Session`
with `spawn()` stubbed, feeding hand-written stream-json and capturing what the
client would have written to the child's stdin. The full normalize → emit →
render → answer path runs; only the child is fake. Covered: streamed thinking
and prose, Bash/Read/Edit/Write/Grep/TodoWrite/Task, an MCP tool, a subagent with
nested output, an error result, a permission card, a 3-question card, a plan
card, a withdrawn request, a second controller, compaction, CJK + emoji, a
600-character line with no newlines, and an image block.

Nine defects it found, all fixed:

1. **Every request rendered as a permission card.** The event envelope applies
   its own `kind` last so a body can't clobber it — and the request's
   `kind` (permission/question/dialog) was exactly such a body key, so it
   became the string `"request"`. Questions rendered as yes/no prompts and their
   answers reached the child with `answers: {}`. Renamed to `requestKind`.
2. **Streamed thinking ran into the prose that followed it** on one line with no
   marker — the client only broke a line when streaming stopped, not when the
   block kind changed.
3. **TodoWrite showed no list.** The tool_result is only the string "Todos have
   been modified successfully."; the list lives on the tool INPUT.
4. **Edit/Write showed no diff**, then showed it twice once one was added — the
   call rendered `old_string`/`new_string` and the result rendered
   `structuredPatch`. The call wins: it lands when the edit is proposed, which is
   when a permission card needs it.
5. **ExitPlanMode showed no plan**, and its card offered "Yes / Yes, don't ask
   again / No" — but accepting a plan also picks the permission mode the work
   runs under. Now three plan-specific choices, and accepting sends
   `set_permission_mode` after the allow, the way the VS Code plugin does.
6. **A tool body was drawn twice** when a permission card followed the call that
   already rendered it. The client tracks which tool_use ids it has already
   drawn, which is why the plugin's AskUserQuestion renderer returns `null` from
   `renderInput()`.
7. **Subagent tool results weren't indented** under the `│` gutter of the call
   that produced them — `tool_end` carried no parent.
8. **`interrupt_done` rendered nothing** and mis-read `still_queued` as "who was
   dropped". It reports what SURVIVED.
9. **MCP tools showed as `mcp__chrome__navigate` with no argument**, long option
   descriptions were cut mid-word with no ellipsis, and a long question wrapped
   to column 0 instead of hanging.

### Multi-step questions — the walk, and the wire format

A multi-question card is tabs in the plugin and a walk in the terminal: one
question at a time, a tab strip showing which are answered, and nothing sent to
the child until the last one is picked — a half-answered card never reaches it.
`1` picks, `1,3` multi-selects, `?text` answers Other, and `1,?text` mixes them.

Verified synthetically across three questions (single / multi-select / Other),
then **end to end against a live child**:

```
? Which colour?  → ?Ultraviolet
? Which sides?   → 1,3
⎿ The user answered: "Which colour?"="Ultraviolet", "Which sides?"="Fries, Soup"
→ "Colour: Ultraviolet (custom, not one of the listed options). Sides: Fries and Soup."
```

Free text replaces the option label rather than accompanying it, and multi-select
joins with `", "` — the format read out of the webview bundle is confirmed by the
CLI's own behaviour, not just by it not erroring.

### Two controllers on one card

Both clients render the card; the first answer wins; the loser's card is dismissed
with `(answered allow by late)` and its later keystroke falls through as ordinary
text. A client attaching while a card is open renders it from the snapshot's
`pending` list, so a late joiner can answer a question it never saw arrive.

### Still open

In the terminal client specifically: no `/` command menu or completion (the live
list arrives via `commands_changed` but nothing consumes it yet), no repaint of a
tool's `●` once it settles (the display is append-only, so status shows on the
result line instead), and no queue-depth indicator.

P3 (web client), P4 (multi-controller polish: presence UI, interrupt gating,
`sinceSeq` delta reconnect is implemented but untested against a real
disconnect), P5 (Ink rewrite of the terminal client), P6 (Mode B deciding hooks).
The `mcp_message` and `hook_callback` control requests are explicitly refused
rather than implemented — they expect an SDK-side host, and hanging is worse than
a clean error.

### Fidelity pass against the real CLI (v2.1.246)

The terminal client was compared display-type by display-type against the real
`claude` TUI under same-input discipline: the real CLI was driven in tmux at 100
columns, the exact `tool_use` inputs and `tool_use_result` payloads were pulled
from that session's transcript JSONL, and those same bytes were replayed through
the fake-child mux into `ccbb-mux-tui.js` in a second 100-column pane. Every
remaining difference is rendering, not model variance. Full table, with excerpts
from both sides, is in `tui-fidelity.md`.

The first pass scored 0 match / 2 cosmetic / 12 structural — the client had been
converged by eye against an older mental model of a display that has since moved.
Closed in this pass:

* **Glyphs.** `⏺` (U+23FA) not `●`, and `⎿` followed by *two* spaces, with
  continuation lines aligned to that five-column gutter.
* **Assistant prose** carries the same `⏺` bullet as a tool call, hanging its
  wrapped lines under the text.
* **`Read`** shows `Read N lines` off `tool_use_result.file.numLines` — the CLI
  never echoes the bytes back, and the old content preview was pure noise.
* **`Edit`** is `Update(basename)`, an `Added X, removed Y` elbow counted off
  `structuredPatch`, then the line-numbered diff with its unchanged context, on
  the CLI's dark red/green bands. The raw "The file … has been updated" string is
  suppressed. This block is now byte-identical to the real one.
* **A denied tool** renders `Interrupted · What should Claude do instead?`
  instead of echoing the coaching paragraph the child injects — which is
  plumbing, and was leaking into the transcript. The denial arrives flagged as an
  error, so it has to be matched before the generic error path sees it.
* **`Task`/`Agent`** is labelled by subagent type and settles to `Backgrounded
  agent`, rather than dumping the launch metadata block.
* **Errors** get the `Error:` label and wrap; truncating one hides the part that
  says what to do about it.
* **Permission cards** lead with the kind of thing being asked for (`Bash
  command`, `Edit file`), show the subject, and close with the CLI's question
  (`Do you want to make this edit to a.txt?`) and a key-hint line.
* **Question cards** show the `☐ Header` line even for a single question, put
  option descriptions on their own indented line, and offer `Type something.` as
  the numbered free-text entry. The walk's tab strip carries `☐`/`☒` marks and a
  `✔ Submit` stop.
* **The answered summary** is `⏺ User answered Claude's questions:` with one
  `· question → answer` line each — also byte-identical to the real one.
* **Turn summary** is `✻ <verb> for Ns · done H:MM AM/PM` at column 0, with no
  inline cost or token count; those belong in the status line.
* **Spacing and wrapping.** Top-level blocks are separated by a blank line (but
  not inside a subagent's gutter), the user echo uses `❯`, and a long tool
  argument wraps with a two-space hang indent instead of being cut — the `Read`
  call line now matches the real one to the byte, wrap point included.

Deliberately NOT closed, because append-only scrollback cannot express them.
These need the full-redraw renderer and belong to **P5**, not to this pass:

* the boxed permission card with an arrow-key `❯` cursor;
* the ruled input box and the status footer (context %, limits, turn count);
* the cycling spinner line (`✽ Meandering… (10s · ↓ 92 tokens)`) and
  description-first pending tools;
* the CLI's *default* collapsed-rollup view (`Read 1 file`, `Ran 1 shell
  command`) with ctrl+o to expand — everything here renders in the expanded form,
  which is the closer of the two targets.

Two findings only a codepoint comparison could have produced, both now matched:
the space between `⎿` and its text is a **non-breaking space** (U+00A0), which is
what stops the elbow separating from its first word; and the bullet on `User
answered Claude's questions:` uses one too, while every other bullet in the CLI
uses a plain space. Result and error bodies are also cut at the column rather
than at a word boundary — the CLI breaks a long path mid-token.

Six blocks were then compared byte-for-byte against the real captures and are
identical, trailing pane padding aside: the Edit call line with its elbow and
three numbered diff lines, the answered-questions block, the wrapped `Read` call
line with its rollup, the wrapped error, the denied-tool elbow, and the Bash
result block.

A late joiner was checked against the same replay: `resultMeta` survives snapshot
serialization, so rendering from `msg.blocks` produces the same numbered diff and
the same rollups as the live event path.

One known limitation, deliberately not chased: the hard wrap counts JavaScript
string length, so `⏺`, `⎿`, `☒` and any SGR codes already in a line count as
characters. Plain-ASCII bodies — which is what the captures compared — wrap
exactly; a coloured or glyph-bearing result body will break a few columns early.

Not exercised, so unverified either way: TodoWrite and Glob/Grep (absent from the
captured session's tool roster), thinking content (the model emitted only empty
thinking blocks), and ExitPlanMode.

Nothing outside `ccbb-mux-tui.js` changed in this pass — the tmux path,
`ccbb-web.js` and `ccbb-mobile.js` are untouched until this route is verified.

### The slash-command menu

The live list was already arriving (`slash_commands` at init, then
`commands_changed` as plugins and skills load) and nothing consumed it. Now
`/` on an empty line prints a one-line hint, `/` alone submits to list every
command, Tab completes and double-Tab shows the candidates, and a `/name` that
matches nothing lists instead of sending a turn the child would only reject.
Anything that does name a command goes through as ordinary text — slash commands
stay the child's to interpret. Commands arrive as bare strings today; when
`commands_changed` sends objects the menu shows their descriptions one per line
instead of packing names into columns. Nothing is hardcoded, so plugins and
skills appear for free.

### P5 — the full-redraw renderer

Under a TTY the client now owns the alternate screen. The change that made this
tractable without losing the byte-exact work: the transcript became a **model**
rather than a stream of prints, and `out()` grew a sink. When a sink is
installed the renderers collect lines instead of printing, so the very functions
that were byte-matched against the real CLI are the ones the repaint replays —
fidelity holds by construction rather than by re-verification. Static entries
cache their lines; tool entries keep the block and re-render every paint.

What that bought, in the order it was built:

* **Status footer and ruled input box.** Model, cost, turn count and context on
  one line; permission mode, other controllers, and the ctrl+o hint on the next.
* **The permission and question cards moved into a live region.** They carry a
  `❯` cursor driven by ↑/↓, Enter to choose, digits to jump, Space to toggle a
  multi-select, and ←/→ to walk a multi-question card's tabs. "Type something."
  is now a real text field rather than the `?text` prefix. Verified on the wire:
  a multi-select sends `"Tea, Water"` and free text replaces the option label.
* **The `⏺` repaint fell out for free.** `tool_end` folds the result into the
  call's own entry instead of printing an elbow, so the next paint restates the
  whole call, bullet colour included. This is the item that append-only could
  never do.
* **The spinner**, on its own 120 ms timer — the one thing that must redraw with
  no event behind it. It stops the moment the turn ends.
* **ctrl+o**, a real toggle over the whole history. The collapsed view is the
  default, as it is in the real CLI: consecutive settled calls of the same kind
  fold into one rollup (`Read 1 file`, `Ran 1 shell command`). A failure is never
  folded away — the rollup stays and the error hangs off it.

Two correctness cases the append-only client could not get right, now verified:
a card is **erased** when another controller answers first (rather than a note
printed under a card still on screen), and the winner gets no redundant note
about their own answer.

The cost, accepted deliberately: the terminal's own scrollback and copy/paste no
longer apply to the transcript, so the client provides PgUp/PgDn and End itself.
Without a TTY none of this engages — pipes and detached panes degrade to the
append-only printing, answering by number, which is what the harnesses use.

`fid/verify.js` in the session scratchpad is the regression: it replays the
captured payloads, checks the collapsed rollups, presses ctrl+o, and byte-compares
six blocks against the real captures. It exits non-zero on any drift.

### The agent lifecycle, and what cannot be captured

Going back to the existing captures closed four more items with real reference
behind them, and fixed a leak of the same class as the launch metadata:

* A **backgrounded agent is never collapsed** — it is a live handle, not a
  settled detail. Collapsed it reads `⎿  Backgrounded agent (↓ to manage · ctrl+o
  to expand)`; expanded it gains a second elbow, `⎿  Prompt:` with the prompt the
  agent was given, off `tool_use_result.prompt`.
* The agent **reports back as a user message** carrying the whole
  `<task-notification>` envelope. Echoing that verbatim was the same leak the
  launch metadata was — it now renders the CLI's single line,
  `⏺ Agent "Count txt files" finished · 18s`. The elapsed time is **truncated,
  not rounded**: 18625 ms reads 18s.
* Running agents are counted in the footer (`· ← 1 agent`) until they report.
* Two more turn verbs observed: `Crunched`, `Cogitated`.

**Four display types cannot be verified on this machine, and this is a hard
blocker rather than an untried path.** `Glob`, `Grep`, `TodoWrite` and
`ExitPlanMode` are not in this build's tool set at all — not present in
`system/init.tools`, not in plan mode either, and `ToolSearch select:` on all
four returns "No matching deferred tools found". No prompt can make the real CLI
render them here, so no capture can exist to diff against. Separately, thinking
blocks arrive with **empty content** in this configuration: the block is there,
its text is not. Both the real CLI and this client therefore render nothing for
it, which is a match by absence rather than a verified rendering.

What those five get instead is `fid/verify-synthetic.js` — structural assertions
that pin the shape (the checklist glyphs come off the tool INPUT, the plan body
renders in full, ExitPlanMode offers plan-mode choices rather than
yes/no/always, an MCP name is prettified with its argument, a subagent nests
under the `│` gutter) and ban the failure signatures (`undefined`, `NaN`,
`[object Object]`, a raw `@@` hunk header). That is not fidelity and is not
claimed as such; it only means these cannot silently break. Anything they assert
is inferred from the CLI's idiom, not measured against it.

Two regressions now, both exiting non-zero on drift:
`fid/verify.js` (12 checks: 4 collapsed rollups, 8 blocks byte-compared to the
real captures) and `fid/verify-synthetic.js` (11 structural checks).

### One bug the harnesses could not see

Both replays fed whole `assistant` messages, so the **delta path was entirely
unexercised** under the repainting renderer — even though
`--include-partial-messages` makes it the normal live path. Under it, streamed
token text was written straight to stdout rather than through `raw()`, so it
landed on a screen the next paint erased; and because the handler marks the
message id as streamed, the final full copy was suppressed too. The turn's prose
did not flicker — it disappeared. One line, but it would have been the first
thing anyone noticed running this against a real child.

`replay.js` now streams turn 2 as real `stream_event`s (`message_start` →
`content_block_delta` × N → `content_block_stop`) followed by the same message in
full with the same api id, and `verify.js` asserts the prose is rendered
**exactly once**. Reverting the fix takes that assertion from 1 to 0, so the test
is load-bearing rather than decorative.

Also fixed alongside it: the non-TTY path had lost its `SIGINT` binding when the
constructor split, so Ctrl-C there no longer sent an interrupt; and settled tool
entries now cache their rendered lines keyed by `(collapsed, width)`, invalidated
on `tool_end`, because re-rendering every tool on every frame at the spinner's
8 Hz does not scale to a long session.

**What "byte-identical" does and does not cover.** Every comparison runs on
`tmux capture-pane` output *without* `-e`, so tmux has stripped the SGR codes:
the suites verify glyphs, spacing, wrapping and wording, and verify no colour at
all. The colour choices — the diff bands, the green prose bullet where the real
CLI's is plain — are converged by eye and unverified.

### P3 — the web client

`ccbb-mux-web.js` is in. It is a **second renderer over the mux's protocol**, not a
second copy of `ccbb-web.js`: nothing in it reads a tmux pane or a transcript
JSONL, and the tmux-path clients (`ccbb-web.js`, `ccbb-mobile.js`) are untouched.

**Mounted, not served.** The mux already owns an HTTP server, a port and a token.
A second server would mean a second origin, CORS on the WebSocket, and the token
copied into two places. `mount(mux)` returns one request handler that `onHttp`
calls for what its `/api` routes did not claim — and that delegation, plus a lazy
`require` and one line in the startup banner, is the **entire** edit to
`ccbb-mux.js`. The claim that the mux is renderer-agnostic is only worth making if
adding a renderer costs it that little.

**What was ported, and from where.** The tool renderer registry is `nZ()` out of
`webview/index.js`, read at 2.1.245 and re-read at 2.1.252: same 23 named
renderers, same `Task`→`Agent` alias, same fallback chain
(`mcp__claude-in-chrome__` → Chrome, `mcp__` → humanized `Server [tool]` with the
first of `query/message/channel/repo/url/path/title/search/text` as its secondary
text, else a generic card by name). Identical across two builds eleven patches
apart, so it is the stable shape rather than one build's snapshot. Header/body
semantics came from the classes themselves — `Bash` shows its `description`,
`Grep` appends `(in <path>, glob: <glob>)`, `Read` reports a line count off
`tool_use_result.file.numLines`, `Update Todos` draws the checklist from the tool
INPUT, `WebFetch` is titled "Web Fetch" — not from guessing at the CLI's output.

**Two deliberate divergences, both recorded rather than silent:**

* **Subagents nest.** The plugin's dispatch drops every message carrying
  `parent_tool_use_id`, so subagent work is invisible in the webview. The terminal
  client nests it under a rule; two ccbb renderers disagreeing with each other is
  worse than one disagreeing with the plugin, so the web client nests too.
* **Tool cards can collapse.** The plugin's card is not collapsible at all — its
  renderer emits a `<summary>` inside a plain `<div>`, so the body always shows.
  The default view here is identical (`<details open>`); the collapse affordance is
  additive.

Also carried over from the terminal client, because they are protocol facts rather
than terminal ones: the `<task-notification>` envelope collapses to
`⏺ Agent "…" finished · 18s` with the elapsed time **truncated**, and the injected
"The user doesn't want to proceed…" paragraph is replaced with
`Interrupted · What should Claude do instead?` rather than echoed at the person who
just clicked No.

**Accepting a plan is two actions.** `answer` carries `planMode: 'acceptEdits'`
alongside the allow, because the mux performs the second half only if asked. Sent
without it, the next edit prompts again and the accept reads as not having taken.

#### Verification — `test/verify.js`, 42 checks

The harness drives a **real mux** whose child is `test/fake-claude.js` instead of
the CLI, so `buildArgs`, the line reader, the normalizer, the `tool_result`
folding and the first-answer-wins registry are all the shipping code. Only the
model is fake, which also means the harness cannot drift from the mux.
`test/drive.js` attaches as a *second controller* over the same socket, so every
run is also a multi-controller test: the turns it submits and the cards it answers
appear in the browser without the browser doing anything.

Five bugs it caught, none of which reading the code would have surfaced:

1. **A snapshot painted messages but not cards.** A client attaching while a
   permission card was open rendered nothing — silently deleting the one feature
   the mux's `pending` list exists for.
2. **The plan card's body never rendered** in the pass that could see it.
3. **Tool bodies were collapsed by default**, which is not what the plugin does.
4. **The `mode` event was read as `ev.mode`; it carries `{permissionMode, by}`.**
   So the mode selector stayed on `default` after a plan accept — which reads to
   the person who just clicked as *the accept not having taken*, the precise
   failure the `planMode` plumbing exists to prevent.
5. **The token path had never run.** `peerToken` is set in ccbb's config on this
   machine, so the shipping mux serves **every** route behind it — the page
   included, behind a 401 that fires before the UI delegation is reached. The
   harness had `mux.token = null` hardcoded, so a suite that was green end to end
   would have said nothing about whether the page opens at all in real use. It now
   runs a token-gated pass: 401 without, 200 with, the index carries the token into
   its links, the socket attaches with it, and a turn round-trips over it.

And one methodological one, which matters more than the three. The first harness
used Chrome's `--dump-dom`: it renders once and exits, so the browser only ever
saw a *finished* transcript delivered as a snapshot — **the delta path was never
exercised at all.** That is the identical blind spot that let the terminal client's
prose-vanishing bug through, reproduced in a new harness within a day of writing
about it. Proof it was blind rather than merely untested: breaking the delta
reconciliation on purpose left the old harness fully green. The suite now drives
Chrome over the DevTools protocol, attaches the page **before** the first turn, and
the same deliberate break takes the "renders exactly once" assertion from 1 to 2.

The reconnect path the build log listed as "implemented but untested against a real
disconnect" is now tested: the page's socket is dropped from inside the page, a
turn is driven while it is away, and the client is asserted to reconnect on its
own, receive the missed turn exactly once, and not duplicate anything replayed.

`ccbb-mux.js` was edited to mount the UI, and the terminal client's own fixtures
are gone, so the last section of the suite attaches `ccbb-mux-tui.js` to the same
fixture session in a tmux pane and checks it still renders the transcript. That is
now the only evidence the edit did not disturb the terminal route — and it doubles
as the two-renderers-on-one-session claim, demonstrated rather than asserted.

**What the suite does not check.** There is no byte-exact reference for a DOM the
way there was for the terminal — the plugin's output is preact inside a VS Code
webview, and diffing against it is not available. So this verifies structure,
wording, reconnection, visibility and the absence of the failure signatures
(`undefined`/`NaN`/`[object Object]`). It verifies **no colour and no layout**.
The visibility distinction is worth keeping crisp: two checks measure
`getClientRects()`, because a closed `<details>` keeps its children in the DOM and
every string assertion would otherwise pass on content no reader can see — which is
exactly how the collapsed-cards bug was caught.

#### Note: the terminal client's fixtures were lost

`/private/tmp` was reaped between sessions, taking `fid/replay.js`, both terminal
verify suites and all eight real-CLI captures with them. The TUI's byte-fidelity
claims in the section above stand on this document, not on a runnable suite, until
they are re-captured — which also wants doing anyway, since they were taken against
2.1.246 and the installed CLI is now 2.1.257. The new harness lives in the worktree
under `test/` for exactly this reason.

### Hooking the mux into `ccbb web`'s session list

Mux sessions now appear in the existing web session list, badged `mux`, and open
in the mux client — served through `ccbb web`'s own port rather than the mux's.

**Why proxy rather than link out.** A link to `http://host:8594/s/<id>` is three
lines and wrong for how ccbb is actually reached: a phone, or an ssh forward,
reaches `ccbb web` and nothing else. A second origin means a second forward, a
second token in a second place, and a session that is listed but not openable from
the machine you are on. So `ccbb web` proxies `/mux/*` — both the HTTP hop and the
WebSocket upgrade — adding the mux's token on the server side, which also means the
browser never holds it. It mirrors the `/peer/<name>` proxy that was already there,
including its upgrade splice.

**The client learns where it is mounted.** `BASE` comes from the page's own path
(`/s/<id>` direct, `/mux/s/<id>` proxied) and every URL it builds hangs off that,
so one bundle serves both with nothing told to it at build or load time. Proxied,
the socket lands on `/mux/mux`: the outer segment is ccbb web's prefix, the inner
one the mux's own WebSocket path.

**Read-only is refused outright.** A mux client submits turns and answers
permission prompts, so `/mux/*` is a write surface. A `readToken` caller gets a 403
rather than a page whose every control fails.

**The edit is 75 lines in `ccbb-web.js` and 20 in `ccbb-mobile.js`**, and the merge
happens at exactly one place. `listSnapshot()` is the choke point that feeds the HTTP route,
the socket's opening snapshot and every delta push alike, so merging there is what
puts mux sessions in the *live* list rather than only in a reload of it.

**One thing worth recording, because it is the shape of the whole session.** The
first version merged in the `/api/sessions` handler — and every HTTP check passed.
The list still showed nothing, because the page does not get its rows from
`/api/sessions` at all: it gets them over a WebSocket from `listSnapshot()`. The
route I patched was the fallback. This is the same failure as the `--dump-dom`
harness and the `mux.token = null` fixture: **a green suite that tests a path
nobody uses.** `test/verify-web.js` now renders ccbb web's own page and looks for
the row in it; reverting the merge takes that check from pass to fail.

Merging is on the session id, and it has to be: a mux session runs a real child
with `--session-id`, so it writes an ordinary transcript, and the disk scan finds
it too — from disk, and therefore without knowing it is live or how to open it. The
mux's view wins on liveness; there is never a second row.

Polled rather than watched, every 2s, because the mux is a separate process with no
file for the transcript watcher to notice. With no mux running, `muxAddress()`
returns null after one stat — the address file records a pid, and a dead one is
treated as no mux at all, which is what keeps a stale address from costing the
session list a connect timeout on every load.

**The phone was the client the design was justified by, and the one that broke
twice.** The argument for proxying rather than linking out was that a phone reaches
`ccbb web` and nothing else — and then the phone was the only client where the row
went nowhere. Both faults came from touching the desktop bundle and stopping:

* Marking a mux page a "desktop page" put it under the redirect to `/m`, which
  rewrote it to `/m/mux/s/<id>` — not a route. Mux pages are their own predicate
  now: still a *page* (so the token hand-off applies), never a *desktop page*. The
  mux client is responsive; both form factors get the same one.
* The phone's list opens an in-page panel that tails a tmux pane, which a mux
  session does not have. A mux row now carries `data-mux` and navigates to the
  proxied client instead.

**Ordering in the request handler turned out to be load-bearing.** The proxy first
sat above the `?token=…` hand-off, so it answered before a cookie could be banked:
open a mux page once with a token, add it to a home screen, come back without
one — 401. On the client the proxy exists for. It now sits below every page-level
redirect. This was found by trying to make the phone-redirect check *fail* and
watching it stay green: the check was passing for the wrong reason, because the
proxy was intercepting before the redirect it was meant to be testing.

**A peer's mux row goes through that peer.** `mergeMuxRows` runs inside each
server's own `listSnapshot`, so a peer that runs a mux returns rows flagged `mux`
— and an href of `/mux/s/<id>` would have pointed at the *local* mux, which has no
such session. It is `apiBase(server) + '/mux/s/' + id` now: the peer proxy already
forwards arbitrary subpaths and splices upgrades, and since the client derives its
base from the page path, the socket lands on `/peer/<name>/mux/mux` and rides that
same splice. **Untested** — it needs a second ccbb with its own mux, which no
fixture here builds. The local path is what the suite covers.

**Read-only sees the rows but not the client.** `/mux/*` is a write surface and
403s, so rather than dead-ending a viewer on raw JSON, a read-only browser's mux
row points at the ordinary transcript view — a mux session writes a normal
transcript, so there is something real to read. The badge stays: it is true, and it
explains why that row behaves differently.

`test/verify-web.js` — 25 checks: the row is present, badged, live, deduped and
rendered in the live list; the page, the API and the redirect all serve through the
proxy and sit behind ccbb web's auth; and a browser pointed **only** at ccbb web's
port loads the client, attaches its socket through the proxy, and renders a turn
driven from somewhere else; and the phone gets the page rather than a redirect,
sees the badged row, and leaves for the client when it is tapped. The fixture
restores the mux address file and removes the raw logs it wrote, so running the
suite leaves `~/.claude` as it found it.

### The mux client as a view in `ccbb web`'s stack

`ccbb web` does not have tabs; it has a **view stack** — `views[]`, where `views[0]` is
the session list and every other entry is a pane with its own bar that folds, maximizes
and closes. Making a mux session "open in a tab like the prior web client" therefore
means making it one of those views, and the honest options were an iframe on
`/mux/s/<id>` or a real port. The iframe was ~40 lines and would have shown two headers
and two status lines stacked inside one view. We took the port.

**The client became a factory.** `ccbb-mux-web.js` used to be a page script: module-level
`S`, `WS`, `nodes`, and `document.getElementById('log' | 'cards' | 'input' | 'mode' |
'stop' | 'foot' | 'label' | 'cwd' | 'dot')`. Every one of those is a single-instance
assumption, and the failure they produce when a page holds two views is not an error —
it is the second session rendering into the first. So the whole body moved inside

    window.createMuxView(root, opts) -> { seq, live, drop, errors, state, destroy }

with element lookup through a `Q()` scoped to `root`. State is per-instance because it is
now function-local; nothing had to be threaded by hand. The standalone `/mux/s/<id>` page
is a thin caller of the same factory (`BOOT_JS`), which is the entire point: there is one
renderer for mux sessions, not two that drift.

`base` and `session` are passed in rather than parsed from `location`, because embedded
the page URL is the session *list* — and there may be two views open at once.

**The bar belongs to the host.** `bar: false` suppresses the client's own chrome, and
`paintChrome()` pushes label, cwd, status, permission mode and client list out through a
single `onChrome(info)` callback. One seam, pushed rather than pulled: `ccbb-web.js` never
reaches into the instance. The standalone page simply does not pass `onChrome`. A mux view
gets no `$_`/`#_` terminal buttons — a mux session has no tmux pane to attach one to, and
offering the button would open an empty window.

**The stylesheet was the dangerous half.** Two files now style a transcript in one
document. `.msg` and `@keyframes pulse` were defined by *both*, and a keyframe name is
global no matter how well the rules using it are scoped. Every rule moved under `.muxv`,
`pulse` became `mx-pulse`, and the ids became classes. The five bare-element rules —
`* { box-sizing }`, `html, body`, `body`, `a`, `button` — were hand-translated, because
mechanically prefixing `body` yields `.muxv body`, a selector that matches nothing: the
stylesheet would have compiled clean and dropped the flex column that makes the transcript
scroll instead of grow.

Renaming a class in the stylesheet without renaming the JS that emits it is the mistake
this invites, and it is the one that happened: `.msg` became `.mx-msg` in CSS only, so the
messages were styled by *ccbb web's* `.msg` rule and user turns silently lost their
bubble. Every assertion stayed green — the text was all present and correct — and it was
caught by looking at a screenshot. `test/verify-web.js` now asserts that the mux body
contains no class ccbb web also styles, and that a user turn has a painted background.

**What the suite covers, and how it was trusted.** Clicking a mux row opens a view rather
than navigating; the client mounts inside the view body with no second bar; its socket
attaches through the proxy; the log and composer have real height (a broken flex chain
does not throw — it grows the view and stops auto-scrolling); the bar shows the badge and
the pushed-up permission mode; a turn driven by another controller renders in the view;
and closing one view drops THAT view's client from the mux without reconnecting.

Each was falsified before being believed: breaking `destroy()` costs 2 checks,
`onChrome` 5, the flex sizing 1, and the click-handler href match 26.

One view proves nothing about per-instance state — the old page script would have passed
every check above it. So a second session is created through the mux's own create API
(which takes the fixture binary, so no second daemon is needed) and opened beside the
first: two live sockets, two session ids, two bodies, a turn driven into the second
landing in the second view and not leaking into the first, and closing one leaving the
other live with its client still attached.

The row's href stays `/mux/s/<id>`, so middle-click and "open in new tab" still reach the
standalone page; only the left-click is intercepted. Read-only browsers never see a mux
href at all, and the phone still navigates — it has no view stack to open into.

### Resuming an existing Claude Code session

`ccbb mux new --resume <uuid>` was broken, and the way it failed is worth recording:
the child died before writing a byte, so the session sat in `starting` with an empty
log and no visible error. `buildArgs` passed `--session-id` and `--resume` together,
and Claude Code refuses that pair:

    Error: --session-id can only be used with --continue or --resume if
    --fork-session is also specified.

The fix follows the semantics rather than just silencing the error. **Resuming in place
is not a new session** — the child goes on writing the *original* transcript — so the
mux passes no `--session-id` at all and files the session under the resumed uuid. That
is also what keeps the mux's row, ccbb web's disk row and the file on disk naming one
thing, which is precisely what `mergeMuxRows` dedupes on. **A fork is** a new session,
so it keeps its own `--session-id` and gets a fresh id; verified empirically — the
original's transcript stopped at 31 lines while the fork's grew to 35.

Two ways to corrupt a transcript are now refused with a 409 rather than discovered
later. The docs are explicit that resuming a session that is already open elsewhere
interleaves both conversations into one file, so `create()` refuses to resume in place
a session this mux is already running, or one that is live in a terminal, and names
`--fork` in the message. "Already running" means status is not `exited`: a stopped
session stays in the map so its transcript stays browsable, and refusing to resume that
would make the mux the one place a session cannot be picked back up.

`test/verify.js` now asserts the argv for all three shapes and the id the mux files each
under, against the fixture binary — the flags cost a real child process each to
discover and cost nothing to check.

### The mux moves inside `ccbb web`

The mux no longer has a port, a daemon, or a TCP server. `Mux.serve()` is gone — with
it `http.createServer`, its own `WebSocketServer`, its `listen()`, and the
`ccbb mux serve` subcommand. The mux is a library; `ccbb web` constructs one at startup
and hosts it under `/mux`.

**What that deleted is the interesting part.** `/mux/*` was a proxy: an address file, a
token header added server-side, an HTTP hop with a 15s timeout, and a WebSocket
handshake replayed and spliced. The session list was worse — ccbb web builds its list
synchronously, so the mux's rows could not be awaited, and the fix had been a 2s poll
into a cache with a pid-liveness guard on the address file so a dead mux cost a stat
rather than a connect timeout. Every one of those existed to reach another process.
`proxyHttp`, `proxyUpgrade`, `muxRequest`, `muxSessions`, `startMuxPoll`, `stopMuxPoll`
and the cache are all gone; what survives is the shape conversion, `muxRows(mux)`, a
plain synchronous map over `mux.list()`. The list is no longer up to two seconds stale.

**Auth is single-gated now.** `authOk()` went with `serve()`. ccbb web owns the port and
has already decided by the time it calls in; a second check reading the same token would
be one more thing to keep in step, and the failure it invites is the quiet one where the
two disagree.

**Two things had to be pushed rather than polled.** The list used to learn about the mux
by asking every two seconds. Now `Session.emit()` rings `mux.notifyChange()` — but only
for `ROW_KINDS`, the events that actually move a field a row displays. Deltas are
excluded deliberately: a token arriving changes nothing in the list, and ringing the bell
per token would turn one busy session into a broadcast storm across every open browser.
ccbb web coalesces on a 120ms timer, because several row-moving events land together at
the end of a turn.

Breaking that hook fails **nine** checks, which is the measure of how load-bearing it is:
a new session never reaches the list, so every view check downstream of clicking its row
goes with it.

**Paths are passed, not rewritten.** `onHttp(req, res, subUrl)` takes the path with the
host's prefix already stripped rather than having `req.url` mutated underneath it —
mutating it would leave every later handler, logging and error paths included, seeing a
URL that was never requested.

**ccbb web owns real `claude` children now.** Standalone, the daemon dying reaped them
because it was their parent; here nothing else would. `killAll()` is synchronous
(`process.on('exit')` cannot await a graceful drain) and runs beside `closeAllTerms`,
along with removing the address file.

**The address file survives, inverted.** ccbb web writes it — its own port, its pid, and
`prefix: "/mux"` — so `ccbb mux ls`, `ccbb mux new`, `ccbb mux stop` and `ccbb attach`
keep working through the same `muxAddress()` they always used, each needing only to
honour the prefix. The pid check that used to catch a dead daemon now catches a dead web
server, unchanged.

**The fixture had to move too**, and it is better for it. `test/serve.js` used to call
`mux.serve()`; it now starts a real `ccbb web` and creates its fixture session through
`POST /mux/api/sessions` with `bin: fake-claude.js` — so the suites exercise the shipping
path rather than a fixture-only one. `verify-web.js` dropped its second server entirely.
`verify.js`'s token section no longer invents a token through an env var: ccbb web's gate
is the machine's own `peerToken`, so the section runs against whatever is really
configured and skips with a note when nothing is.

### `ccbb new` / `attach` / `stop`, and names

The mux had grown a CLI shaped like the thing it used to be — a daemon with a
subcommand group, `ccbb mux new|ls|stop`. It is not that any more; it is the way you
start a session. So the verbs moved to the top level and the group went away:

```
ccbb new [-n name] [-m model] [...]   start a session in the mux, attach a terminal
ccbb attach [<name>|<id>]             attach a terminal to one that is running
ccbb stop [<name>|<id>] [--force]     end one
ccbb ls --mux                         what the mux is holding
```

`ccbb new` attaches on purpose. The point of the verb is to start working, and a
session you have to look up an id for before you can type into it is not started. It
runs the same client `ccbb attach` runs — nothing about the session knows which verb
created it, and `--detach` prints the name and id for the case where you want the
process without the terminal.

`ccbb ls --mux` is a different question from `ccbb ls`, not a filter on it. The disk
listing has these sessions too — a mux session writes an ordinary transcript — but not
the facts that only exist while a child is running: its status, how many controllers
are attached, whether it is blocked on a request nobody has answered. So it branches
before sorting, period scoping and the cost summary rather than teaching all three
about a live child they have nothing to say about.

**Names are addresses, so they have to be unique.** `ccbb attach api-work` has to
reach one session or none, never "one of these two". A new session takes the
directory's basename, and a `-2`, `-3` suffix if that name is already **running**.
Running, not present: an exited session stays in the map so its transcript stays
browsable, and counting those would walk the name up by one every time you restarted
in the same directory — `ccbb-mux`, `-2`, `-3`, forever, with nothing running.

Resolution is deliberately narrow. Full id, exact name, or the short id `ccbb ls`
prints; a live holder beats an exited one, because "attach to foo" means the foo that
is running. There is **no name-prefix matching**. An id prefix is unambiguous by
construction and a name prefix is not — `ccbb stop alph` quietly hitting `alphabet` is
a footgun with no undo, and the check that it resolves to nothing is in the suite.

The rules live twice, which is not duplication: `Mux.get()` runs over the live map
inside `ccbb web`, and `pickSession()` runs over the JSON list in the CLI process,
which has only ever seen HTTP. Both are checked against the same fixtures. The bare
form — `ccbb attach` with no argument — resolves when exactly one session is
**running**, for the same reason the suffix ignores exited ones: one live session and
three remembered ones failing with "several sessions" reads as a bug.

### Clicking a session that isn't running: resume, but ask first

The session list opens a mux session in a mux view and everything else in the
transcript view. The gap was the session that is neither — not running in a tmux pane
here, not in the mux, just a transcript. You can read it and you can do nothing with
it.

The obvious move is to have the click start it. It was rejected: clicking a row is how
you *browse*, and browsing an old session should not spawn a `claude` process and bill
a resume. So the transcript view grew a **▶mux** button instead, driven by the same
fact the composer already reads — `setDrivable`, which asks whether the session has a
pane on this host. A pane means it is being worked on and this view can drive it, so
there is nothing to resume. No pane means it is inert, and the mux is the only way to
make it answer.

Resuming **in place** keeps the session id, which is what makes the swap coherent: the
row, the file on disk, the transcript view and the mux view all go on naming one
thing. It is also why the transcript view has to close before the mux view opens —
`openSession` dedupes on (server, id) and would otherwise just re-focus the view you
were trying to replace.

The ordering around the POST is the part that had to be got right. Close-then-post
loses the user's transcript to any refusal, and refusals are normal here: the mux
rejects a resume when the session is live in a terminal (two writers, one transcript,
interleaved). So the view closes only once the response says there is somewhere to go.
And the two refusals are told apart by a **code, not by their prose** — both are 409s,
but "already running in this mux" means the thing the button would have made already
exists, and the right response to that is to open it, not to report an error. That is
`reason: 'running-in-mux'` vs `'live-in-terminal'`, and the suite pins it.

### Closing the tab ends the session — when it leaves nobody attached

A mux session is a real `claude` process. One nobody is looking at is one nobody asked
for, so closing its view stops it. Two things keep that from being destructive.

**It is on an explicit close op, never on the socket's close event.** The web client
reconnects; a dropped socket empties the client set for a moment, so stopping there
would end a session over a network blip, a suspended laptop, or a page refresh. Only
`{op:'close'}` — sent by `destroy({closeSession:true})`, which only `closeView` passes
— says "I am done with this". The standalone `/mux/s/<id>` page never passes it: a
reload there is a reload, and a session that died because you refreshed its page would
be worse than no auto-stop at all. This is the one to watch in a later refactor,
because wiring it to `ws.on('close')` "for symmetry" looks like a simplification and is
a data-loss bug.

**And only when the room is empty.** The mux stops the session if that close left zero
clients — another browser, or a terminal on `ccbb attach`, keeps it alive. The reply
goes out before the stop, because draining a child can take half a minute and the
client is already leaving.

Both halves needed their own case in the suite or one of them would never have run.
The "somebody is still watching" half is a second view of the *same* session, built by
hand because `openSession` refuses to open one twice; the "last one out" half is a
session created for it, because the others carry leftover drivers from earlier checks
and "the last client left" is a claim about all of them. The assertions are on the
session's **status**, not on its client count: a stopped session keeps its attached
clients until they notice, so counting them says the same thing either way — a check
that would have passed against a broken implementation.

Falsification: dropping the close op fails 1 check; stopping regardless of who is left
fails 8; hiding the resume button fails 1; treating the 409 as a plain failure fails 2.

One consequence of keeping exited sessions in the map: their name stays reachable once
nothing live claims it, so `ccbb attach api` can land on a dead session. That is worth
keeping — reading a finished session's transcript is why it is still there — but the
TUI now says so on the way in, with the exit code, rather than rendering a transcript
nothing will ever add to and looking merely quiet.

### Slash commands, and what the wire actually carries

`/compact` rendered as `❯ <local-command-stdout>Compacted </local-command-stdout>
(web-d4a0)` — a person's turn, in raw markup, attributed to whoever typed it. Fixing
that meant finding out what a local command actually looks like coming out of a
stream-json child, and **the on-disk transcript and the wire do not agree**. Building
against the file shape would have produced a renderer nothing ever reaches.

On disk, a slash command is two user messages:

```
<command-name>/compact</command-name>
            <command-message>compact</command-message>
            <command-args></command-args>
<local-command-stdout>…</local-command-stdout>
```

On the wire it is neither of those. Probed against a live child:

```json
{"type":"assistant","is_meta":true,
 "local_command_source":"<local-command-stderr>Error: No messages to compact</local-command-stderr>",
 "message":{"model":"<synthetic>","content":[{"type":"text","text":"Error: No messages to compact"}]}}
```

A **synthetic assistant message**. The output is already unwrapped in `content`; the
envelope survives only in `local_command_source`, and **that envelope is the only
thing on the wire that says whether the command worked** — `stdout` vs `stderr`.
There is no user echo and no `<command-name>` block. `num_turns` is 0.

Three things fell out of that:

- **`is_meta`, not `isMeta`.** The wire uses snake_case and the transcript file uses
  camelCase; the normalizer read only the second, so every synthetic message was
  arriving untagged. Both are read now.
- **The attribution FIFO leaked.** `submit()` pairs a turn with whoever typed it and
  the replay echo claims the pairing back. A slash command produces no replay, so its
  entry sat at the head of the queue forever and was handed to the *next* turn
  somebody typed. The synthetic result claims it instead — which is also where the
  command's own name comes from, since the wire does not carry it.
- **The replayed-user carrier is real too.** A successful `/compact` does leave a
  replayed user message whose whole text is the envelope; that is the one the bug
  report showed. Both carriers normalize to one `command` tag in the mux, so neither
  renderer knows there were two and neither can drift.

The renderers then agree by construction. The terminal client prints the command and
its output under it, keeping the child's own ANSI — this is a terminal, and colour is
how `/cost` tells its columns apart. The browser strips the ANSI (nothing is lost that
a reader could use; the words are all still there) and draws the same collapsed card a
tool gets, with `ok` or `error` taken from the stream.

### `//` commands in the browser

`//` is ccbb's own — `//pwd`, `//cd`, `//help` — and it now works from the mux client
as well. The route is ccbb web's, one level above the mux: `BASE` ends in `/mux`, so
stripping that suffix reaches it from **both** hosts, the tab inside ccbb web (where
`BASE` may be `/peer/<name>/mux`) and the standalone page (where it is just `/mux`).
An explicit option would have meant `BOOT_JS` computing the same thing and being able
to compute it differently.

`runCommand` resolves its cwd from the transcript, not from a tmux pane, so a mux
session — which has no pane and never will — works unchanged. The client passes the
session's own cwd anyway, so it also works before the transcript exists.

Local command output rides at the end of the transcript rather than in it: it is this
page talking to this server, not part of the conversation. It survives `reset()`, so a
reconnect does not silently swallow the answer you just asked for.

### What a tool is doing while it runs

Claude Code's TUI shows a Bash command's output growing line by line. **A stream-json
child does not emit that**, and the probe is unambiguous — between the `tool_use`
block and the `tool_result` there is exactly this and nothing else:

```
 4.0 assistant:tool_use(Bash)
 7.1 system/task_started      {tool_use_id, description:"Echo six lines", task_type:"local_bash"}
10.2 system/task_notification {tool_use_id, status:"completed"}
10.2 user:tool_result
```

The output does not exist anywhere a client could reach until the result lands, because
Claude Code runs the tool in-process and only reports the outcome. So what the clients
show instead is **that execution has begun, and how long ago** — which is not the same
thing and is not pretending to be, but note the three seconds between the tool_use
block and `task_started`. That gap used to be indistinguishable from a hung session.

`task_started` / `task_notification` are normalized to one `tool_run` event. The
terminal client prints `⎿ running… (Ns)` under the bullet; the browser puts
`RUNNING · Ns` in the card's state badge.

### Tool cards: collapsed, with an arrow and a state

A turn that reads twenty files used to open twenty cards and bury the prose between
them. Cards are collapsed by default now, with a drawn disclosure arrow (the native
`<details>` marker is a platform glyph that changes shape between browsers and sits
where this layout does not want it) and the state as a **word** — `RUNNING`, `DONE`,
`ERROR`. A border tint alone is invisible to a reader who cannot separate the hues,
and "running" is the state somebody is actually waiting on.

Which cards are open is remembered per tool id and is deliberately **not** cleared by
`reset()`. A card is rebuilt when its result lands, so without that memory an
expansion made while waiting would snap shut at the exact moment it finally had
something to show — and a card that closed itself because the socket blinked would be
the reconnect making itself felt in the one place it must not.

### The composer, and the configured status line

The composer is ccbb web's, rebuilt inside the mux client so the standalone page gets
it too: auto-grow, a maximize button that gives the composer the whole view, history
back/forward seeded from the transcript (so the first ▲ reaches a turn sent before the
page existed), and a send button. **Enter is a newline and Ctrl/Cmd+Enter sends.** That
is not a preference: Enter-sends costs you the message every time you reach for a
second line, and this is where long prompts get written.

The footer is ccbb web's status line — money, turns, context as current/peak — in the
client rather than in the host view, because the standalone page needs it too. What is
mux-specific (other controllers, a credential refresh, the exit code, the last
transient note) goes to the right, out of the way of the numbers people scan for.

The **terminal** client's footer is different, and deliberately: it runs the user's own
`statusLine` command from `settings.json` and prints what that writes, replacing the
built-in stats row. The row said model / cost / turns / ctx; the user's script says the
same and more, from the same program Claude Code would have run, so keeping both would
only have given them somewhere to disagree. The **mode** row stays either way —
permission mode, the other controllers on this session and the ctrl+o hint are mux
facts that no status-line script can know.

Two details are copied from the documentation rather than invented: updates debounce at
300ms, and a trigger arriving while the script is still running cancels it (otherwise a
`refreshInterval` shorter than the script's runtime piles up processes for the life of
the session). And `transcript_path` is resolved through ccbb-common's index rather than
re-derived from the cwd slug — the slug rule is not obvious, and a wrong path renders a
line that is quietly wrong rather than visibly absent. Verified end to end: the real
script, given a real session, printed
`Opus 5  $1.23  mo:$164.53  turns:848+44  ctx:134k/694k/$0.07`, and the turn count only
comes out right if the path did.

### Looking at it

`test/shot.js` is new: it stands the fixture up, drives a full walk, runs a `/`
command, a failing `/` command and a `//` command, and writes a PNG. It exists because
of the `.msg`/`.mx-msg` rename that cost every user turn its bubble with a fully green
suite. A rendering change gets looked at.

## The web client renders ccbb's components, not its own

The mux client began as a port of the VS Code webview and kept that stylesheet's
vocabulary — a full `--vscode-*` palette, its own `.tool`, `.cmd`, `.mx-composer`,
`.mx-foot`. Dropped into a ccbb tab that reads as a foreign panel: GitHub grey/blue
against ccbb's warm clay, 14px against 15px, a 900px column against 740, and a
`@media (prefers-color-scheme: dark)` block inside a page that has no dark mode at
all — on a dark-mode Mac the panel went dark and the page around it stayed light.

It renders ccbb's own classes now:

| was | is |
| --- | --- |
| `<details class="tool">` + `summary` | `.tool-card` > `.tool-hdr` + `.tool-body`, ccbb's `toggleTool()` |
| `.status` (a bare word) | `.tool-status` pill, plus `.tool-time` |
| `<details class="cmd">` | the same `.tool-card` — `/` and `//` are tool-shaped acts |
| `.mx-msg.user .bubble` | `.msg.you .msg-body` |
| `.mx-composer` + `<textarea>` | `.input-area` > `.input-row` > `.input-box` + `.send-btn` |
| `.mx-foot` | `.sv-foot .sl` |

Both pages serve one copy of those rules. ccbb-web.js's page stylesheet is hoisted
out of `APP_HTML` into an exported `APP_CSS`, and `asTextarea` / `edCaret` /
`toggleTool` into `SHARED_JS`; the standalone `/mux/s/<id>` page includes both.
ccbb-web.js **hands** them over (`muxWeb.setHostAssets`) at the bottom of its module
rather than being required back for them — it requires this file for `mount()`, so a
require in the other direction lands mid-evaluation and gets an exports object
neither constant is on yet. That is not hypothetical: it shipped that way for one
run, and the standalone page came up with no stylesheet and no `asTextarea`.

Two specificity traps, both found in the pixels and now asserted:

* `.muxv button` is (0,1,1) and outranked ccbb's `.send-btn` at (0,1,0), repainting
  the clay send button the same grey as everything else while every selector still
  matched. Scoped to the mux's own buttons — the bar, the permission cards, the
  question tabs. The check compares the computed background against `var(--accent)`
  resolved on the page, not against a literal.
* `.mx-wrap` was 900px around a 740px `.msg`, which left the transcript
  left-aligned in it with a gutter down the right. 772px = 740 + the padding.

Maximize keys on `.muxv.input-max` (ccbb keys its own on `.view-body.input-max`) and
mirrors the same chain. The bug it replaces set `height:auto` on the editable: the
log did hide, the composer did claim the height, and the box stayed 40px tall at the
bottom of an empty panel. `flex:1` on `.input-box` is the line that does the work,
and the check measures the box — 30px → 603px → 30px — because asserting the class
passed against the broken build.

What is deliberately NOT done: the palette behind the leftovers (the bar, the
permission cards, diffs, todos, the session list) is still the `--vscode-*` set. Only
the dark-mode block is gone. Those bits have no ccbb equivalent to reuse, and
remapping the variables is a separate change.

## History for a resumed session

`--resume` gives back nothing. In `--print --output-format stream-json` the child
loads the transcript into its own context and emits only the new turns; retrieving
prior messages is an open feature request, not a flag we missed
(anthropics/claude-agent-sdk-typescript#14, -python#109). A resumed session therefore
opened as a blank page next to a $70 history. The comment in this file that said "a
resumed session's replayed history" was simply wrong.

`Session.seedHistory()` reads `findSessionJsonl(opt.resume)` and pushes every turn
through the **same** `onModelMessage` the wire goes through — one normalizer, so the
two shapes cannot drift. Four things it has to get right:

* **Before `spawn()`.** Resuming in place, the child appends to that very file;
  reading afterwards races its own writes and replays turns it just made.
* **`this._seeding` makes `emit()` a no-op.** Seq stays 0 and the ring stays empty,
  so a first attach gets the history in `snapshot().messages` and a reconnect still
  takes its `sinceSeq` delta — it already has them. It also keeps the attribution
  FIFO untouched: those turns were typed in the previous run, by nobody here.
* **The file is not the wire.** `toolUseResult` on disk, `tool_use_result` on the
  socket; both are read now. And the file carries a dozen record types the wire never
  sends — `attachment`, `mode`, `file-history-snapshot`. Skipped, along with
  `isSidechain` (a subagent's own thread) and `isCompactSummary`, which is a user
  message whose content is the entire prior conversation.
* **`HISTORY_SEED = 1200`, newest-last**, against a `this.messages` cap raised to
  8000: a 6000-line transcript seeded whole would leave the live turns evicting the
  history they were meant to continue.

Seeded turns carry `hist: true` and the clients dim them through ccbb's existing
`.msg.hist`, so "what was already here" reads differently from "what just happened".

The wiring has its own check, and it earned it: deleting the `seedHistory()` call
from the constructor failed **nothing** while the tests drove the reader directly.
A real `Mux.create({ resume })` is now asserted to come back already carrying its
transcript.

### The composer's behaviour, not only its markup

Matching ccbb's classes made the composer look right and left three things that made
it act differently. All three are ccbb's, copied rather than reinvented:

* **The four tooltips** (`SEND_TIP`, `EXPAND_TIP`, `HIST_PREV_TIP`, `HIST_NEXT_TIP`)
  moved into `SHARED_JS`. They are the only place the key bindings are written down
  for a reader, so a private copy is a private set of promises.
* **No arrow-key binding.** The mux bound `Ctrl/Cmd+↑/↓` to the history; ccbb binds
  no arrow at all — "the composer is a multi-line editor, maximized it is the whole
  view, and up/down belong to the caret. History is on the buttons." Removed.
* **`mousedown` handlers** on `.input-tools` (keep the caret in the editable) and on
  `.input-row` (a click in the padding means "type here"), plus ccbb's 200-entry cap.

Escape is the one deliberate divergence left: in the mux it exits the maximized
composer and then interrupts the turn, where ccbb only exits. A mux client is
driving a live child and Esc is the interrupt everywhere else it appears.

The plan windows are back in the footer too. `footWin` / `subWinTitle` and the
formatters they need moved to `SHARED_JS`, and the client reads `/api/subscription`
through `ccbbBase()` — one pill, one function, both clients. It does not repeat
ccbb's `onPlan` provider test: the mux has no per-provider cost breakdown, and a
machine with no plan reports no windows anyway.

### What the falsification actually showed

Bitten: max mode without `flex:1` on the editable (2), `.muxv button` unscoped (1),
cards open by default (3), seeding on the wire (1), `seedHistory()` deleted from the
constructor (2, but only once a check drove the real POST route — the unit checks
passed happily without it), `.hist` on the wrapper but not the card (1, and only
once the fixture transcript contained a tool call).

Not bitten: removing the `.input-tools` mousedown guard. The comment there used to
claim the row would fade out from under the pointer; it does not, because those
buttons are inside `.input-inner` and `:focus-within` still holds. The handler earns
its place by keeping the caret in the editable, which is a smaller claim than the one
it was carrying.
