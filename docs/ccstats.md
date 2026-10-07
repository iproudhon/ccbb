# ccstats

Privacy-safe token/latency stats reports for local Claude Code and Codex sessions. A single
file, no dependencies — copy `ccstats.js` anywhere and run it with `node`. It shares no code
with ccbb; [ccstats-golizer](ccstats-golizer.md) renders golizer runs against its skeletons.

```bash
node ccstats.js                      # usage
node ccstats.js stats -o out.html    # report from the sessions on this machine
node ccstats.js skel -o skel.json    # just the skeletons (share these, not transcripts)
node ccstats.js stats *.json         # report over collected skeleton files (deduped)
node ccstats.js stats -s codex -m 'gpt-*'
```

## Discovery and sources

By default both `~/.claude` (`CLAUDE_CONFIG_DIR`) and `~/.codex` (`CODEX_HOME`) are scanned;
`--dir` replaces that list and is repeatable, and may name a directory or a single `.jsonl`.
Each file is sniffed for its format, so Claude transcripts and Codex rollouts can share a
root. Codex sessions are found by walking `sessions/`/`archived_sessions/`; if a root has no
rollout files, `codex app-server` is asked for its thread list instead.

Claude subagent transcripts (`<sessionId>/subagents/*.jsonl`) are folded into their parent
session and kept out of the message rows, so they add responses without inventing turns.

The source of every response is auto-detected, not configured:

| source | detected by |
| --- | --- |
| `claude-sub` | Claude model, plain `msg_` id |
| `claude-bedrock` | `msg_bdrk_` id prefix |
| `claude-local` | a model id in no Claude family |
| `codex` / `codex-local` | Codex rollout, by `model_provider` |

`--source` and `--model` take repeatable globs (`*`/`?`; a bare word is a case-insensitive
substring) and apply to both `stats` and `skel`. Models are grouped into families
(`us.anthropic.claude-haiku-4-5-20251001-v1:0` → `claude-haiku-4-5`) so the same model billed
two ways lands in one bucket. Both filters are also available as checkbox rows in the report.

## What a skeleton contains

Structure and numbers only. **No** message text, tool arguments or results, prompts, file
paths, cwd, git branches, titles — and no scan paths. Per session: a structural fingerprint
(SHA over the per-message `type:tokens:ts` sequence, used to dedup identical sessions across
machines), CLI version, start/last-activity timestamps, turn count and duration. Per message:
kind (`u`ser, assistant te`x`t, thin`k`ing, `t:<tool>`, tool `r`esult), token length and unix-ms
timestamp — exact when the provider reported `output_tokens`, else a ~4-chars/token estimate
flagged `est`. Per billable response: model, source, token counts (input, cache read, cache
write, output), the cache-write split, response time, idle gap and local hour. Per compaction:
context size before and after, trigger, duration, and whether it was inferred.

Safe to hand to someone else; that is the point of the `skel`/`stats` split.

## Cache-write attribution

A cache write is either new context or a prefix being paid for twice. Each response's write is
compared against how much the prompt grew since the previous request in that session: the
growth, bounded by the write, is *growth*; the remainder is *re-write* (TTL expiry or
eviction — the 5-minute idle TTL is why the report also bins writes by idle gap). The first
request of a session is *initial*. The report shows the split as its own chart plus a
"cache re-write" tile, so a session pattern that keeps re-paying for its prefix is visible.

## Compaction

Claude Code records each compaction itself (`compact_boundary`: context size before and after,
`auto` vs manual, how long it took) and those numbers are used verbatim. Codex rollouts publish
no such marker, so for a session without one a compaction is *inferred* from the shape it
leaves in the numbers — the context collapsing to under half of a ≥8k prefix between two
consecutive requests. Inferred rows are flagged and the report says how many there were.

## The report

Self-contained HTML, inline SVG, opens offline. Session-level charts first — sessions by turn
count and by duration — then the response-level ones: prompt-size histograms (count and
response time), prompt-size → decode and cache-write bars, the growth/re-write split, idle gap
→ cache write, compactions by the context size that triggered them and by the result size they
left, a prompt+output → response-time scatter with a binned trend line, and mean response time
by hour. Light/dark via `prefers-color-scheme`, hover tooltips, an outlier toggle,
source/model checkboxes, and a log-scaling switch that re-bins every histogram (both scalings
are shipped, so it costs no rebuild). Log scaling and the source filter appear twice — in the
control rows at the top and in a collapsible panel pinned to the top-right corner — and the two
copies stay in sync whichever one is clicked. The page opens with outliers removed and with only
`claude-sub` + `claude-bedrock` selected (everything, if neither is present), so a mixed report
starts on one comparable slice rather than stacking four billing models together.

Chart data is pre-aggregated at build time per source×model group over shared bin edges, so
page size grows with the number of groups rather than sessions, and the checkboxes re-sum in
the page without shipping rows. Only the scatter carries per-response points (`--points`,
default 2000; `0` keeps every response).

## Confluence

`--confluence` writes just the host `<div>` + `<script>` — paste it into Confluence's inline
**HTML** macro (Insert → Other macros → "HTML", not "HTML Include") and publish.

The report builds itself inside a **Shadow DOM** at runtime because a pasted `<style>` does
not survive the macro: Confluence's own CSS then takes over (full-width charts, wrong colors,
unresolved `var()`). Injecting the stylesheet from JS into a shadow root fixes both directions
— the macro can't strip it and Confluence's styles can't leak in. For the same reason every
chart color is a concrete hex, never `var()` inside an SVG attribute. The tooltip lives in a
second shadow root on `<body>` so `position:fixed` stays viewport-anchored inside
Confluence's transformed containers.

Confluence rejects oversized macro bodies, which is why the data is pre-aggregated. Lower
`--points` if a paste is rejected. Size is printed after each run.

`reportBlock()` is the single source for both the standalone page and the macro body, so the
two can't drift.

## Tests

```bash
node test/verify-ccstats.js         # fixture tree → skeletons → report, executed under a DOM shim
node test/verify-ccstats.js --real  # also render from the real session dirs
```

There is no browser in CI, so `test/dom-shim.js` provides just enough DOM to run the report's
embedded script in `vm` and assert that every chart drew and that the in-page filters re-sum
to the build-time totals.

## License

MIT
