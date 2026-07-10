# Set up the clauderem Claude Code status line

You are Claude Code. Build and install a custom status line for me by following
this spec exactly. Do not ask me to paste a script — generate it yourself from
this spec, then install it.

## Goal

A single-line status that renders:

```
Opus 4.8  $1.23  turns:42+7  ctx:78k/145k/$0.04              (Bedrock / API key)
Fable 5  $1.23/5h:24%/w:41%  turns:42  ctx:78k/145k/$0.04    (subscription)
```

That is, space-separated: **canonical model name**, **session cost in USD**
(with subscription limit usage appended when available), **turn count** (with
subagent turns as `+N`), then **context info** as
`ctx:<current>k/<session-peak>k/<resend-cost>`.
Render every field dimmed (ANSI `\033[2m` … `\033[0m`).

## Steps

1. **Dependency:** the script uses `jq`. Verify `jq` is installed; if not, stop
   and tell me the install command for my OS.

2. **Write the script** to `$CLAUDE_CONFIG_DIR/statusline-command.sh` (default
   `~/.claude/statusline-command.sh`), `chmod +x` it. Use `/bin/sh`, not bash
   features. The script reads one JSON object on **stdin** (the Claude Code
   status-line payload) and prints the line to stdout. Relevant input fields:
   - `.model.display_name`, `.model.id`
   - `.context_window.total_input_tokens`
   - `.rate_limits.five_hour.used_percentage`,
     `.rate_limits.seven_day.used_percentage` (present only on Claude.ai
     subscriptions, after the first API response)
   - `.session_id`
   - `.transcript_path` (path to the session JSONL transcript)

3. **Wire it into** `$CLAUDE_CONFIG_DIR/settings.json` as:
   ```json
   "statusLine": { "type": "command", "command": "bash <abs-path-to-script>" }
   ```
   Merge this key in **without** clobbering my other settings. Back up
   `settings.json` first. Refuse if the existing file isn't valid JSON.

## Field computation

**Model** — canonical human name, e.g. `Opus 4.8`. Start from
`.model.display_name` (fall back to `.model.id`, then `"unknown"`). If the name
already contains a space, keep it as-is. Otherwise, if it looks like a raw
model id (contains `anthropic.` or starts with `claude-`, e.g. the Bedrock id
`us.anthropic.claude-opus-4-8`), canonicalize it:
- strip any `arn:…/` prefix, region prefix (`us.`/`eu.`/`apac.`/`global.`),
  `anthropic.`, and leading `claude-`;
- strip version suffixes `-vN`/`-vN:M`/`:M` and trailing 8-digit dates;
- of the remaining hyphenated tokens, the first alphabetic token is the family
  and the numeric tokens joined with `.` are the version;
- render as `Capitalized-family version`. Examples:
  `us.anthropic.claude-opus-4-8` → `Opus 4.8`;
  `claude-haiku-4-5-20251001` → `Haiku 4.5`;
  `claude-3-5-sonnet-20241022` → `Sonnet 3.5`.

**Session cost + limits** — the cost figure (below); when `.rate_limits` is
present in the payload (i.e. a Claude.ai subscription), append
`/5h:<NN>%/w:<NN>%` using `five_hour.used_percentage` and
`seven_day.used_percentage`, each integer-rounded; omit either segment whose
field is absent. (The payload exposes only 5-hour and 7-day windows — there is
no daily window.) On Bedrock/API-key sessions there is no `rate_limits`, so
just the dollar figure.

**Turn count** — distinct assistant API responses, as `turns:<main>+<sub>`.
Main: read the transcript JSONL and count **unique** `.message.id` values among
lines where `.type=="assistant"`. (One response spans multiple JSONL lines;
retries may share a requestId — so dedup on `message.id`, not line count.)
Subagent turns: the same count over
`<transcript-path-minus-.jsonl>/subagents/agent-*.jsonl`; render as `+N` only
when nonzero. Print `?` if no transcript.

**Context current** — `.context_window.total_input_tokens` divided by 1000,
rounded (displayed with a trailing `k`).

**Context peak** — the largest context used in this session, `k`-formatted the
same way: `max(cached transcript peak, total_input_tokens)`, where the
transcript peak is computed in the background pass (below) as the max over
deduped assistant lines of `input_tokens + cache_read_input_tokens +
cache-creation tokens`.

**Resend cost** (`ctx_cost`) — hypothetical USD to resend the *current* context
once, all served from cache. Compute `total_input_tokens * rate / 1_000_000`
where `rate` is the cache-read price per 1M tokens by model family:
fable/mythos `1.0`, opus `0.5`, haiku `0.1`, sonnet/other `0.3`. Format as
`$%.2f`.

**Session cost** — total USD computed from the transcript (do NOT shell out to
ccusage). Algorithm:
- Take lines where `.type=="assistant"` and `.message.usage != null`.
- Deduplicate on the key `message.id + "|" + requestId`.
- For each, price per 1M tokens by model family `(.message.model)`:
  - fable/mythos: input 10, output 50, cacheRead 1.0, cacheWrite-5m 12.5, cacheWrite-1h 20
  - opus:  input 5, output 25, cacheRead 0.5, cacheWrite-5m 6.25, cacheWrite-1h 10
  - haiku: input 1, output 5,  cacheRead 0.1, cacheWrite-5m 1.25, cacheWrite-1h 2
  - sonnet/other: input 3, output 15, cacheRead 0.3, cacheWrite-5m 3.75, cacheWrite-1h 6
  - Token fields from `.message.usage`: `input_tokens`, `output_tokens`,
    `cache_read_input_tokens`. For cache-creation, prefer the breakdown
    `cache_creation.ephemeral_5m_input_tokens` /
    `cache_creation.ephemeral_1h_input_tokens` when present; otherwise treat
    `cache_creation_input_tokens` as 5m-rate.
  - line cost = `(inp*in + out*out + cr*cacheRead + cw5*cw5rate + cw1*cw1rate)/1e6`
- Sum all lines; format `$%.2f`.

**Cost must never block the render.** Cache cost and transcript peak (one line,
tab-separated: `$1.23<TAB>145000`) at `/tmp/claude-code-session-cost-<session_id>`:
- On each render, print the cached cost immediately (or `...` if no cache yet)
  and use the cached peak (0 if none) for the peak computation.
- If the cache file is missing or older than 30s, recompute **in a background
  subshell** (`( … ) &`) that writes the new values to the cache file. Never
  wait on it.
- In that same background subshell, prune stale caches from ended sessions:
  `find /tmp/ -maxdepth 1 -name 'claude-code-session-cost-*' -mtime +3 -delete`.
  (Trailing slash required: on macOS `/tmp` is a symlink to `/private/tmp` and
  `find` won't follow it otherwise.)

## Verify

After installing, feed mock input to confirm it renders without error, e.g.:
```
echo '{"model":{"id":"us.anthropic.claude-opus-4-8","display_name":"us.anthropic.claude-opus-4-8"},"context_window":{"total_input_tokens":78000},"session_id":"test","transcript_path":""}' | sh ~/.claude/statusline-command.sh
```
Expect a dimmed line starting `Opus 4.8` and ending `ctx:78k/78k/$0.04` with
`turns:?` and cost `...` (no transcript in the mock). Also test a payload with
`"rate_limits":{"five_hour":{"used_percentage":23.5},"seven_day":{"used_percentage":41.2}}`
and expect `/5h:24%/w:41%` appended to the cost. Then tell me to restart
Claude Code.

## Note for me (the user)

The dollar figures use Anthropic API list pricing for the opus/sonnet/haiku
families; on Bedrock/Vertex or a subscription plan they're estimates, not billed
amounts. The 5h/weekly percentages are the subscription's 5-hour and 7-day
rate-limit windows as reported by Claude Code (there is no daily window).
