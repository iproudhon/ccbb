# ccbb-mux-tui.js vs real `claude` CLI (v2.1.246) — rendering fidelity

> **Status.** Everything below is the *first* pass, kept as written so the
> before/after is legible. Closed in the fidelity pass — see "Fidelity pass
> against the real CLI" in `ccbb-mux-plan.md` §11 — are table rows 1, 3, 5, 10,
> 11, 12, 13, 14, 15 and 17, plus global notes G1 and G3. The Edit block, the
> answered-questions block and the wrapped `Read` call line are now
> byte-identical to the captures quoted here.
>
> Rows 8, 9, 16 and 18, and global note G2, were closed by P5 (the full-redraw
> renderer): the permission card is a live region with an arrow-key `❯` cursor,
> the ruled input box and status footer are permanent, the spinner runs on its
> own timer, and ctrl+o is a real toggle over the whole transcript with the
> collapsed rollup view as the default. Nothing in the first pass is still open.

Method: the real CLI was driven in tmux (100 cols) against a scratch dir; every scenario's exact
`tool_use` inputs and `tool_result` payloads were pulled from that session's transcript JSONL
(`b33f5b99-a88b-4af4-9ad7-7d21c0110bcc.jsonl`) and replayed byte-for-byte through a fake-child mux
into `ccbb-mux-tui.js` in a second 100-col tmux pane. Every difference below is rendering, not model
variance. Captures live in the session scratchpad under `fid/` (`cap*.txt` = real, `tui-*.txt` = TUI).

Deliberate divergences (multi-question walk vs simultaneous tabs, append-only status bullets, no
slash menu, no queue depth) are excluded per the task brief.

## Global observations (apply to most rows)

- **G1 — bullet/elbow glyphs**: real uses `⏺` (U+23FA) for every bullet and `⎿␣␣` (two spaces);
  the TUI uses `●` (U+25CF) and `⎿␣` (one space). Same idiom, different codepoint and spacing.
- **G2 — no collapsed mode**: the real CLI's *default* view collapses settled tool calls into
  rollup lines (`Read 1 file`, `Ran 1 shell command`, `Listed 1 directory`) and expands them only
  under ctrl+o ("Showing detailed transcript"). The TUI renders everything permanently in the
  expanded form. Rows below compare against the expanded (ctrl+o) form, which is the closer target.
- **G3 — long values**: real wraps long paths/lines to the next line at full width; the TUI
  truncates with `…`.

| # | Display type | Real CLI (excerpt) | ccbb-mux-tui (excerpt) | Verdict |
|---|---|---|---|---|
| 1 | Assistant prose | `⏺ No — 289 = 17², so it's not prime.` | `No — 289 = 17², so it's not prime.` (no bullet) | structural |
| 2 | Thinking | (nothing rendered — Fable 5 emitted an empty thinking block) | (nothing rendered) | not compared |
| 3 | `Read` | collapsed: `  Read 1 file`; expanded: `⏺ Read(/…/work/a.txt)` + `⎿  Read 3 lines` | `● Read(/…/scr…)` + `⎿ 1→hello` `2→world` (dumps content) | structural |
| 4 | `Bash` + output | `⏺ Bash(wc -l a.txt b.txt)` + `⎿         2 a.txt` `2 b.txt` `4 total` | `● Bash(wc -l a.txt b.txt)` + `⎿        2 a.txt` `2 b.txt` `4 total` | cosmetic |
| 5 | `Edit` diff | `⏺ Update(a.txt)` + `⎿  Added 1 line, removed 1 line` + ` 1  hello` ` 2 -world` ` 2 +World` | `● Edit(/full/path…)` + `-world` `+World` + `⎿ The file /…/a.txt has been up…` | structural |
| 6 | `TodoWrite` | (tool absent from session — could not capture) | `☒ / → / ☐` checklist from input | not compared |
| 7 | `Glob`/`Grep` | (tools absent from session — could not capture) | — | not compared |
| 8 | Permission prompt (Bash) | boxed dialog: `Bash command` / `touch c.txt` + dim desc / `Do you want to proceed?` / `❯ 1. Yes …` / `Esc to cancel · Tab to amend · ctrl+e to explain` | `? Bash(touch c.txt)` / `touch c.txt` / `1. Yes  2. Yes, and don't ask again  3. No` | structural |
| 9 | Permission prompt (Edit) | `Edit file` / `a.txt` / `╌╌╌` rule / numbered ± diff w/ context / `Do you want to make this edit to a.txt?` | `? Edit(/full/path…)` / `-world` `+World` / generic `1. Yes …` | structural |
| 10 | Denied-tool result | `  Ran 1 shell command` + `⎿  Interrupted · What should Claude do instead?` | `● Bash(touch c.txt)` + `⎿ The user doesn't want to proceed with this tool use. The tool use was rejected (eg. …` (raw injected string, 2 lines) | structural |
| 11 | AskUserQuestion (single) | rule / ` ☐ Color` / question / `❯ 1. Red` + desc on own indented line / `4. Type something.` / `5. Chat about this` / `Enter to select · ↑/↓ · Esc` | `? Which color do you prefer?` / `1. Red  Warm, bold color` (desc inline) / `(?your own text answers "Other")` | structural |
| 12 | AskUserQuestion (multi tab strip) | `←  ☐ Fruit  ☐ Drink  ☐ Season  ✔ Submit  →`; multiSelect shows `[✔] Tea` checkboxes | `Fruit · Drink · Season   1/3` walk (deliberate) — but no ☐/☒ marks, no Submit stop | cosmetic |
| 13 | AskUserQuestion answered summary | `⏺ User answered Claude's questions:` + `⎿  · Which fruit do you prefer? → Apple` (one line per Q) | `● AskUserQuestion(Color)` + `⎿ Your questions have been answered: "Which color do you prefer?"="Red". You can now cont…` | structural |
| 14 | `Task`/`Agent` subagent | `⏺ Explore(Count txt files)` + `⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)`; later `⏺ Agent "Count txt files" finished · 18s`; footer lists `◯ Explore  Count txt files  5s` | `● Agent(Count txt files)` + `│ Listing files…` + `⎿ Async agent launched successfully. (This tool result is internal metadata — never quote…` +5 lines | structural |
| 15 | Error result (Read miss) | `⎿  Error: File does not exist. Note: your current working directory is /private/tmp/…` (wrapped, full) | `⎿ File does not exist. Note: your current working directory is /private/tmp/claude-501/-Users…` (truncated, no `Error:` label) | structural |
| 16 | Spinner / in-flight status | `✽ Meandering… (10s · ↓ 92 tokens)` (verb cycles: Puzzling…, Mustering…); pending tool shows desc first: `⏺ Counting lines in a.txt and b.txt` + `⎿  $ wc -l a.txt b.txt` | (none — prompt marker flips `›`→`…` while busy) | structural |
| 17 | Turn summary line | `✻ Baked for 9s · done 2:04 PM` | `  done · 9.0s · 60 out · $0.3500` | structural |
| 18 | Prompt box / footer | `❯ user text` echo on shaded strip w/ 2-space hang indent; input between two full-width `────` rules; status footer `Fable 5  $0.44/5h:41%/w:8%  turns:3  ctx:40k/40k/$0.04` + `⏸ manual mode on · ← 1 agent` | `> user text` (ASCII `>`, bold); single-line prompt `[fid · claude-fable-5 · default · $0.530] › ` | structural |

**Colour notes (cosmetic, all rows)**: real diff lines are fg 167/77 *on dark red/green backgrounds*
(48;5;52 / 48;5;22) with dimmed line numbers; the TUI colours the whole ± line plain red/green fg, no
bg. Real errors are soft red 256-colour 211 after a grey `⎿`; the TUI uses ANSI 31 red for the whole
elbow body. Real greys are 246/239; TUI uses `\x1b[2m`/`\x1b[90m` — close enough. Real's active
question tab is black-on-light-blue (38;5;16 on 48;5;153); TUI's is bold yellow. Real result previews
under `⎿` are *not* dimmed (full-brightness output); the TUI greys every result preview line — the
most visible brightness inversion. Real tool bullets stay `⏺` white/green; the TUI's `●` is
yellow-while-running (never repainted — deliberate), which reads differently at a glance.

## Structural mismatches

### 1. Assistant prose has no `⏺` bullet
```
# real
⏺ No — 289 = 17², so it's not prime.
```
```
# tui
No — 289 = 17², so it's not prime.
```
Prefix each assistant text block with the bullet (and wrap with a 2-space hang indent).

### 2. `Read` dumps file content instead of a line-count summary
```
# real (expanded)
⏺ Read(/…/fid/work/a.txt)
  ⎿  Read 3 lines
```
```
# tui
● Read(/…/scratchpad/fid/work/a…)
  ⎿ 1	hello
     2	world
```
`Read` results need a `Read N lines` rollup, not a content preview; the real CLI never shows the
bytes. (Default-collapsed mode would say just `Read 1 file` — see G2.)

### 3. `Edit` rendering: label, summary line, and diff shape
```
# real
⏺ Update(a.txt)
  ⎿  Added 1 line, removed 1 line
      1  hello
      2 -world
      2 +World
```
```
# tui
● Edit(/private/tmp/claude-501/…/a.txt…)
     -world
     +World
  ⎿ The file /private/tmp/…/a.txt has been up…
```
Needs: label `Update(basename)` not `Edit(fullpath)`; an `Added X, removed Y` summary as the elbow
line (computable from `tool_use_result.structuredPatch`, which the mux already forwards); line
numbers + unchanged context lines in the diff; suppress the raw "The file … has been updated" string.

### 4. Permission dialogs are line-lists, not the CLI's boxed card
```
# real (Bash)
 Bash command

   touch c.txt
   Create empty c.txt

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /…/work from this project
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```
```
# tui
? Bash(touch c.txt)
  touch c.txt
  1. Yes
  2. Yes, and don't ask again
  3. No
```
Divergences beyond the (understandable) lack of arrow-key selection: no `<Tool> command` heading, no
dim description line, no `Do you want to proceed?` question, option-2 wording differs, no key-hint
footer. The Edit dialog additionally lacks the `Edit file` / filename header, `╌╌╌` rules, and the
numbered diff (same fix as #3).

### 5. Denied tool: raw rejection string instead of `Interrupted`
```
# real
  Ran 1 shell command
  ⎿  Interrupted · What should Claude do instead?
```
```
# tui
● Bash(touch c.txt)
  ⎿ The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it w…
     Note: The user's next message may contain a correction or preference. Pay close attention —…
```
Detect the canonical rejection `tool_result` and render `⎿  Interrupted · What should Claude do
instead?` instead of echoing the injected coaching text.

### 6. AskUserQuestion card layout
```
# real (single)
 ☐ Color

Which color do you prefer?

❯ 1. Red
     Warm, bold color
…
  4. Type something.
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
```
```
# tui
? Which color do you prefer?
  1. Red  Warm, bold color
  (?your own text answers "Other")
```
To converge: show the `☐ Header` line even for one question, put option descriptions on their own
indented line, and name the free-text escape `Type something.` (the real card also offers `Chat
about this`, which the TUI has no equivalent for). The multi-question tab strip should carry
`☐/☒` marks and a `✔ Submit` terminal stop even in walk mode.

### 7. AskUserQuestion answered summary
```
# real
⏺ User answered Claude's questions:
  ⎿  · Which fruit do you prefer? → Apple
     · Which drinks do you like? → Tea
```
```
# tui
● AskUserQuestion(Color)
  ⎿ Your questions have been answered: "Which color do you prefer?"="Red". You can now continue…
```
Render one `· question → answer` line per question (parseable from the result string or the answer
op itself) instead of the raw result sentence.

### 8. Agent/Task leaks internal launch metadata
```
# real
⏺ Explore(Count txt files)
  ⎿  Backgrounded agent (↓ to manage · ctrl+o to expand)
…
⏺ Agent "Count txt files" finished · 18s
```
```
# tui
● Agent(Count txt files)
│ Listing files…
  ⎿ Async agent launched successfully. (This tool result is internal metadata — never quote or …
     agentId: a4a1dff75a79b4e36 (internal ID - do not mention to user. Use SendMessage with to: …
```
Suppress the "Async agent launched…internal metadata" result body and show a `Backgrounded agent`
line; announce completion. (The `│` gutter itself matches the CLI's older nested idiom and is fine
for synchronous subagents.)

### 9. Error results lose the `Error:` label and get truncated
```
# real
  ⎿  Error: File does not exist. Note: your current working directory is /private/tmp/claude-501/-Us
     ers-sh5-jung-src-ccbb/…/fid/work.
```
```
# tui
  ⎿ File does not exist. Note: your current working directory is /private/tmp/claude-501/-Users…
```
Prefix `Error: `, and wrap instead of truncating.

### 10. No spinner / in-flight line
```
# real
✽ Meandering… (10s · ↓ 92 tokens)      # and pending tools show description-first:
⏺ Counting lines in a.txt and b.txt
  ⎿  $ wc -l a.txt b.txt
```
The TUI's only busy signal is the prompt marker flipping to `…`. A cycling-verb spinner line with
elapsed time / token count, and a description-first pending-tool line (`⎿  $ command`), would close
the most visible gap during a running turn.

### 11. Turn summary line
```
# real
✻ Baked for 9s · done 2:04 PM
```
```
# tui
  done · 9.0s · 60 out · $0.3500
```
Real leads with `✻ <verb> for Ns · done <clock>` and shows no per-turn cost/token counts inline.

### 12. User echo and footer
```
# real
❯ using the Edit tool, change the word world to World in a.txt   # ❯, shaded strip, 2-space hang
────────────────────────────────────────
❯                                        # input between two full-width rules
────────────────────────────────────────
  Fable 5  $0.67/5h:42%/w:8%  turns:7  ctx:41k/41k/$0.04
```
```
# tui
> using the Edit tool, change the word world to World in a.txt   # ASCII '>', bold
[fid · claude-fable-5 · default · $0.530] ›                      # one-line bracket prompt
```
User echo should use `❯`; the bracket status-prompt is a different idiom from the CLI's ruled
input box + status footer (context %, limits, turn count).

## Not compared

- **TodoWrite** — CONFIRMED UNAVAILABLE, not merely unattempted: TodoWrite is absent from this
  build's `system/init.tools`, absent in plan mode, and `ToolSearch select:TodoWrite` returns
  "No matching deferred tools found". No capture can be made on this machine. The TUI side renders `☒ / → / ☐` from the tool input, which matches the CLI's known
  glyph set, but no same-input capture exists to verify layout.
- **Glob / Grep** — same reason; the model substituted Bash (`ls *.txt; grep -rn hello .`), whose
  rendering is covered by row 4. Real collapsed rollup for it read `Listed 1 directory`.
- **Thinking content** — Fable 5 emitted only empty thinking blocks in this session, so neither
  side rendered any thinking text; the real CLI's thinking display (and the TUI's `✻ `-prefixed grey
  stream) went unexercised.
- **ExitPlanMode / plan card** — out of the requested minimum set; not driven.
