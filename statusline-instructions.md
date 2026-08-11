# Build my Claude Code status line

You are Claude Code. Build and install the status line described below. Generate every
file yourself from this spec — do not ask me to paste a script. Work through the sections
in order and run the verification at the end before telling me you are done.

Two scripts, both plain POSIX `/bin/sh` (no bash-only syntax), both in
`$CLAUDE_CONFIG_DIR` (default `~/.claude`), both `chmod +x`:

| File | Role |
|---|---|
| `statusline-command.sh` | Renders the line. Runs on every refresh, must stay fast. |
| `statusline-bedrock-prices.sh` | Refreshes the Bedrock price table once a day. |

**Hard requirement: the status line depends on nothing but `jq`, `curl` and coreutils.**
No Node, no npm package, no local service, no other script of mine (in particular nothing
from the `ccbb` project — if you find such a reference, remove it). If `jq` is missing,
tell me the install command for my OS and stop.

## The line

```
Opus 5  $1.23  mo:$162.56  turns:42+7  ctx:78k/145k/$0.04     Bedrock / API key
Opus 5  $1.23/5h:24%/w:41%  turns:42  ctx:78k/145k/$0.04      Claude.ai subscription
```

Fields, separated by two spaces: **model name**, **session cost** (with subscription
window usage appended when present), **monthly estimate** (non-subscription only),
**turn count**, and **context** as `ctx:<current>k/<peak>k/<resend cost>`.

The whole line is dimmed: wrap it in ANSI `\033[2m` … `\033[0m`. The one exception is the
resend cost when the prompt cache has gone cold — that renders in orange
(`\033[38;5;208m`) and then restores dim.

## Input

The script reads one JSON object on **stdin** and writes one line to stdout. Fields used:

- `.model.display_name`, `.model.id`
- `.context_window.total_input_tokens`
- `.cost.total_cost_usd`
- `.session_id`, `.transcript_path`
- `.rate_limits.five_hour.used_percentage`, `.rate_limits.seven_day.used_percentage` —
  present only on a Claude.ai subscription, and only after the first API response. Their
  presence is how you detect a subscription.

Read every field in **one** `jq` call that prints one value per line, and append a final
`"."` sentinel so command substitution cannot swallow a genuinely empty last field. Do not
emit tab-separated fields for `read` to split: tab is IFS whitespace, so runs of empty
fields collapse and every later field shifts by one.

Assume nothing about the payload. Empty stdin, `{}`, and non-JSON must all render a line
and exit 0.

## Fields

**Model** — a human name like `Opus 5`. Start from `.model.display_name`, fall back to
`.model.id`, then `"unknown"`. If it already contains a space, use it verbatim. Otherwise,
if it looks like a raw id (contains `anthropic.` or starts with `claude-`), canonicalize:
strip any `arn:…/` prefix, a region prefix (`us.`/`eu.`/`apac.`/`au.`/`global.`),
`anthropic.`, a leading `claude-`, `-vN`/`-vN:M`/`:M` suffixes, and a trailing 8-digit
date. Of the remaining hyphen-separated tokens, the first non-numeric one is the family and
the numeric ones joined with `.` are the version; render `Family version`. So
`us.anthropic.claude-opus-5` → `Opus 5`, `claude-haiku-4-5-20251001` → `Haiku 4.5`,
`claude-3-5-sonnet-20241022` → `Sonnet 3.5`.

**Session cost** — `$%.2f` of `.cost.total_cost_usd`, or `-` when absent. Take it verbatim;
do not recompute it from the transcript.

**Subscription windows** — when `.rate_limits` is present, append
`/5h:<N>%/w:<N>%` to the cost from the two `used_percentage` values, integer-rounded,
omitting either segment whose field is absent. There is no daily window. On a subscription,
also omit the monthly field entirely: dollar figures are notional there.

**Monthly estimate** (`mo:`) — non-subscription only. A list-price total for the current
calendar month across all my sessions. Show `...` until the first background pass has
written a value. See *Monthly estimate* below.

**Turns** — distinct assistant API responses as `turns:<main>[+<sub>]`. Count **unique**
`.message.id` among lines where `.type=="assistant"`: one response spans several JSONL
lines and retries reuse ids, so line counts are wrong. Subagent turns are the same count
over `<transcript-path-minus-.jsonl>/subagents/agent-*.jsonl`, appended as `+N` only when
nonzero. Print `?` when there is no transcript. Use `jq -n '[inputs | …]'` rather than
`jq -s`, and pass all subagent files to a single `jq` rather than looping one process per
file.

**Context current** — `.context_window.total_input_tokens / 1000`, rounded, suffixed `k`.

**Context peak** — `max(total_input_tokens, cached transcript peak)`, same `k` format. The
transcript peak comes from the background pass: over assistant lines deduped on
`message.id + "|" + requestId`, the maximum of
`input_tokens + cache_read_input_tokens + cache_creation.ephemeral_5m_input_tokens
(or cache_creation_input_tokens) + cache_creation.ephemeral_1h_input_tokens`.

**Resend cost** — what it would cost to send the *current* context one more time, as
`$%.2f`. This is the field that makes idle time visible:

- Find the timestamp of the last `"type":"assistant"` line in the transcript. Read only
  the tail of the file (`tail -c 200000`) — transcripts reach megabytes. If no timestamp
  parses, fall back to the file's mtime.
- If that is **within** the cache TTL, the context is still cached: price it at the
  **cache-read** rate, dimmed.
- If it is **older**, the prompt cache has expired and the next request re-writes it:
  price it at the **cache-write** rate and render it **orange**.
- TTL comes from `$CC_CACHE_TTL`, defaulting to `300` (5 minutes). Validate it as digits
  and fall back to the default on junk — an `[: Illegal number:` error must never leak
  into the line. When the TTL is `>= 3600`, use the 1-hour cache-write rate instead of the
  5-minute one.

Set `"refreshInterval": 10` in the settings so the field flips to orange on its own while
I am idle, without me typing anything.

## Pricing

I use **Bedrock**, so the table must be Bedrock's own list prices — not Anthropic
first-party rates, and not anything a separate tool caches for me. My model ids look like
`us.anthropic.claude-opus-5`, which is the **"Geo and In-region Cross-region Inference"**
tier, 10% above Bedrock's global tier. Use that tier.

Rates are USD per 1M tokens, held as `{"<plain-api-id>": [input, output, cacheRead,
write5m, write1h], …}` plus a `_default` entry so an unknown model prices as mid-tier
rather than free. Look a model up by normalizing its id the same way as the display name
(strip region/vendor prefixes and version suffixes), then falling back to the id minus its
trailing 8-digit date, then to `_default`.

Hardcode a small table in `statusline-command.sh` as the **offline fallback**, and
override it at runtime from `statusline-bedrock-prices.json` whenever that file parses and
looks sane (e.g. `.["claude-opus-5"][0] > 0`). A truncated or zeroed file must be ignored,
never allowed to zero out every rate.

### statusline-bedrock-prices.sh

AWS publishes the numbers in two halves that have to be joined:

1. `https://aws.amazon.com/bedrock/pricing/` — the HTML has the model-name rows, but each
   price cell is a placeholder token, not a number:
   `{priceOf!bedrockfoundationmodels/bedrockfoundationmodels!<hash>[!*!<multiplier>][!opt]}`.
   Cells with no price for that model read `N/A`. Fetching this page through a
   markdown-converting fetch tool loses the tokens — fetch the raw HTML.
2. `https://b0.p.awsstatic.com/pricing/2.0/meteredUnitMaps/bedrockfoundationmodels/USD/current/bedrockfoundationmodels.json`
   — maps hash → price, with **no model names at all**. It is gzipped (use
   `curl --compressed`) and shaped
   `{"regions": {"<Region Display Name>": {"<hash>": {"price": "5.5000000000", …}}}}`.

Do not use the AWS Price List API (`pricing.us-east-1.amazonaws.com/…/index.json`) — it
carries only Claude 2.x/3 era models.

The script must:

- Locate the table by the heading text `Geo and In-region Cross-region Inference` and read
  only that table. The page also contains the global-tier table with the same model names.
- Identify columns from the **header row text** (`input`, `output`, `5m cache write`,
  `1h cache write`, `cache read`, and `batch`, which is skipped), not by column position,
  so an inserted column upstream cannot silently swap input for output. Bail out if the
  input and output columns cannot both be found.
- Parse the placeholder token by splitting on `!`: field 3 is the hash and a `*` field is
  followed by a multiplier to apply to the price.
- Resolve each hash against the price map. Prices are keyed by region, and current models
  cost the same in every region but older ones do not, so prefer `$AWS_REGION`
  (translated from a region code like `us-west-2` to the console display name
  `US West (Oregon)`), then Oregon, then N. Virginia, then any region carrying the hash.
- Map display names to plain API ids the way the status line normalizes model ids: 4.x and
  newer put the family first (`Claude Opus 5` → `claude-opus-5`, `Claude 4.5 Haiku` →
  `claude-haiku-4-5`), 3.x and older put the version first (`Claude 3.7 Sonnet` →
  `claude-3-7-sonnet`). Drop rows with no recognizable family or version, such as
  `Claude Instant`.
- Derive cache columns AWS lists as `N/A` from the input rate at Anthropic's fixed ratios:
  5m write 1.25×, 1h write 2×, read 0.1×. Round to 6 decimals so floating-point noise like
  `0.30000000000000004` does not reach the file.
- Treat "parsed but produced almost nothing" as failure: require a plausible model count
  and a positive `claude-opus-5` input rate before writing.
- Write atomically (write a sibling temp file, then `mv`), so a reader never sees a
  half-written table. On any failure, leave the previous file untouched and exit nonzero.
- Accept a `-v` flag that reports which stage failed, on stderr. Stay silent otherwise.

**TLS note for my machine:** a corporate proxy intercepts TLS, and `b0.p.awsstatic.com`
fails certificate verification with the default trust store. Try the plain fetch first,
then retry with whichever bundle is already configured — `$CURL_CA_BUNDLE`,
`$AWS_CA_BUNDLE`, `$NODE_EXTRA_CA_CERTS` — using `--cacert`. **Never** use `curl -k` or
otherwise disable verification.

## Never block the render

The line must appear immediately on every refresh. Expensive work is read from a cache file
and recomputed in a **detached background subshell** (`( … ) >/dev/null 2>&1 &`) that the
foreground never waits on. Three cached values, each with its own TTL:

| Value | Cache path | TTL |
|---|---|---|
| Session context peak | `/tmp/claude-code-session-peak-<session_id>` | 30 s |
| Monthly estimate | `/tmp/claude-code-month-cost-<YYYY-MM>` | 300 s |
| Bedrock price table | `$CLAUDE_CONFIG_DIR/statusline-bedrock-prices.json` | 86400 s |

Rules:

- Print the cached value immediately, or a placeholder (`...` for the month, `0` for the
  peak) when there is no cache yet.
- Write each cache atomically: `> "$file.$$"` then `mv`.
- `<session_id>` is interpolated into a path, so restrict it to filename-safe characters.
- Skip the monthly pass entirely on a subscription — nothing displays it there.
- Price refresh additionally needs a **failed-attempt throttle**, or every render retries
  the network while I am offline: touch `statusline-bedrock-prices.attempt` **before**
  fetching, delete it on success, and skip the refresh while that stamp is newer than 1
  hour. Writing it first also stops a hung `curl` from spawning a second scraper. When the
  refresh succeeds, reload the table in that same subshell so the monthly total is not one
  refresh behind.
- Prune caches from ended sessions in the same subshell:
  `find /tmp/ -maxdepth 1 -name 'claude-code-session-peak-*' -mtime +3 -delete` and the
  same for `claude-code-month-cost-*` at `-mtime +40`. The trailing slash on `/tmp/` is
  required: on macOS `/tmp` is a symlink and `find` will not follow it otherwise.

## Monthly estimate

Bedrock does not report spend to Claude Code, so `mo:` is a list-price estimate computed
from my transcripts, in the background pass:

- Take `*.jsonl` under `$CLAUDE_CONFIG_DIR/projects`, narrowed with
  `find -newermt "<YYYY-MM>-01"`.
- Keep lines where `.type=="assistant"` and `.message.usage != null`.
- **Deduplicate on `message.id + "|" + requestId`.**
- Filter to the current month using a **local-time epoch range**, not
  `startswith("YYYY-MM")` on the timestamp. Transcript timestamps are UTC; a string test
  misfiles the last hours of the previous month into this one — at UTC−7 that silently
  added several dollars in my case. Compute the bounds with
  `date -d "<YYYY-MM>-01 00:00:00" +%s` and the same `+1 month`, with BSD `date -j -v+1m`
  fallbacks. Note `fromdateiso8601` rejects fractional seconds, so strip `.NNN` before
  `Z`.
- Price **each entry from its own `.message.model`**, not from the currently selected
  model — a month usually spans several models.
- Per entry: `input_tokens × input + output_tokens × output +
  cache_read_input_tokens × cacheRead + cache-5m × write5m + cache-1h × write1h`, over
  1e6. For cache creation prefer the `cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens` breakdown, falling back to treating
  `cache_creation_input_tokens` as the 5m rate.
- Sum across files and format `$%.2f`.

## Install

Wire it into `$CLAUDE_CONFIG_DIR/settings.json`:

```json
"statusLine": {
  "type": "command",
  "command": "sh /absolute/path/to/statusline-command.sh",
  "refreshInterval": 10
}
```

Merge that key in without clobbering my other settings, and refuse if the existing file is
not valid JSON. Do not leave a `settings.json.bak` behind — I use git and Claude Code keeps
its own backups.

## Verify

Run all of these and show me the output. Do not report success on any that fails.

1. **Renders, and fast.** Feed a mock payload; the whole render should be well under a
   second even against a multi-megabyte transcript.
   ```sh
   echo '{"model":{"display_name":"Opus 5","id":"us.anthropic.claude-opus-5"},"context_window":{"total_input_tokens":125000},"session_id":"t","transcript_path":"","cost":{"total_cost_usd":1.2345}}' \
     | sh ~/.claude/statusline-command.sh
   ```
   Expect `Opus 5  $1.23  mo:…  turns:?  ctx:125k/125k/$0.07`.
2. **Model canonicalization** — ids only, no `display_name`: `claude-3-5-sonnet-20241022` →
   `Sonnet 3.5`; `us.anthropic.claude-haiku-4-5-20251001-v1:0` → `Haiku 4.5`;
   `global.anthropic.claude-sonnet-5` → `Sonnet 5`.
3. **Rate lookup** — resend cost at 125k tokens is `$0.07` for Opus (0.55/MTok) and `$0.14`
   for Fable (1.1); an unknown id like `claude-nope-9` falls back to `_default`.
4. **Cold cache** — point `transcript_path` at a one-line fake transcript whose
   `"type":"assistant"` timestamp is years old. Expect the resend figure in orange at the
   cache-write rate (`$0.86` for Opus at 125k), and `$1.38` with `CC_CACHE_TTL=3600`.
5. **TTL validation** — `CC_CACHE_TTL` unset, `300`, `3600`, `0` and `abc` all render
   cleanly with no shell error text in the line.
6. **Subscription** — add
   `"rate_limits":{"five_hour":{"used_percentage":23.5},"seven_day":{"used_percentage":41.2}}`;
   expect `/5h:24%/w:41%` appended and **no** `mo:` field.
7. **Degenerate input** — empty stdin, `{}`, and `not json` each render a line and exit 0.
8. **Turns** — against a real transcript, the count matches
   `jq -n '[inputs|select(.type=="assistant")|.message.id]|unique|length'`, and a session
   with a `subagents/` directory shows `+N`.
9. **Both shells** — identical output under `sh` and `bash`.
10. **Price refresh** — `sh ~/.claude/statusline-bedrock-prices.sh -v` writes the table in
    a couple of seconds; `claude-opus-5` must be `[5.5, 27.5, 0.55, 6.875, 11]`, matching
    the geo tier on the AWS page. Confirm the values against the page rather than trusting
    the parse.
11. **Refresh failure is safe** — run it with the network blocked
    (`HTTPS_PROXY=http://127.0.0.1:1`): it exits nonzero, prints one diagnostic under `-v`,
    and leaves the existing table byte-identical.
12. **Throttle works** — age the table with `touch -d '2 days ago'`, render once, and
    confirm a background refresh ran; then block the network, age it again, render twice,
    and confirm the `.attempt` stamp is created once and not rewritten on the second
    render.
13. **No `jq`** — with `jq` off `PATH`, the status line prints a single short notice and
    exits 0 rather than a line of empty fields.
14. **No litter** — no leftover `*.$$` temp files in `$CLAUDE_CONFIG_DIR` or `ccprice.*`
    directories in `/tmp` after a successful and a failed run.

Then tell me to restart Claude Code.

## Notes for me

- `mo:` and the resend figure are **Bedrock geo-tier list prices**, computed locally from
  transcripts — estimates, not an invoice. The session cost, by contrast, is whatever
  Claude Code reports in `.cost.total_cost_usd`, which is on a different (global-rate)
  basis, so the two will not be exactly proportional.
- The cold-cache rule is wall-clock only. It cannot know whether the server actually
  evicted the entry, and a 1-hour TTL is a per-request property, so `CC_CACHE_TTL` only
  tells the estimate which rate to use — it does not change what Claude Code requests.
- The monthly figure counts every project directory under `~/.claude/projects`, so it will
  exceed any single session's cost.
