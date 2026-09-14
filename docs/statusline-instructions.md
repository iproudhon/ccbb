# Build a Claude Code status line

Build and install the status line described below. Generate every file from this spec — do
not ask for a script to paste in. Work through the sections in order and run the
verification at the end before reporting done.

Two scripts, both plain POSIX `/bin/sh` (no bash-only syntax), both in
`$CLAUDE_CONFIG_DIR` (default `~/.claude`), both `chmod +x`:

| File | Role |
|---|---|
| `statusline-command.sh` | Renders the line. Runs on every refresh, must stay fast. |
| `statusline-bedrock-prices.sh` | Refreshes the Bedrock price table once a day. |

**Hard requirement: the status line depends on nothing but `jq`, `curl` and coreutils.**
No Node, no npm package, no local service, no other script. If `jq` is missing, report the
install command for the host OS and stop.

## The line

```
Opus 5  $1.23  mo:$162.56  turns:42+7  ctx:78k/145k/$0.04        Bedrock / API key
Opus 5  $1.23/5h:24%/w:41%  turns:42  ctx:78k/145k/$0.04         Claude.ai subscription
Opus 5  $1.23  mo:$162.56  turns:42  ctx:78k/145k/$0.04->$0.54   cache gone cold
```

Fields, separated by two spaces: **model name**, **session cost** (with subscription
window usage appended when present), **monthly estimate** (non-subscription only),
**turn count**, and **context** as `ctx:<current>k/<peak>k/<resend cost>`, where the resend
cost becomes `<cache-read cost>-><cache-write cost>` once the cache has gone cold.

The whole line is dimmed: wrap it in ANSI `\033[2m` … `\033[0m`. The one exception is the
cache-write half of the resend cost, shown only when the prompt cache has gone cold — that
renders in orange (`\033[38;5;208m`) and then restores dim. The cache-read half stays dim.

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
calendar month across every session. Show `...` until the first background pass has written
a value. See *Monthly estimate* below.

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
+ cache_creation.ephemeral_1h_input_tokens`, taking a bare `cache_creation_input_tokens` as
the 5m figure when a line carries no breakdown.

**Resend cost** — what it would cost to send the *current* context one more time, as
`$%.2f`. This is the field that makes idle time visible:

- Find the timestamp of the last `"type":"assistant"` line in the transcript. Read only
  the tail of the file (`tail -c 200000`) — transcripts reach megabytes. If no timestamp
  parses, fall back to the file's mtime.
- If that is **within** the cache TTL, the context is still cached: show one figure, the
  **cache-read** cost, dimmed.
- If it is **older**, the prompt cache has expired and the next request re-writes it: show
  **both**, as `<cache-read cost>-><cache-write cost>`, the read half dimmed and the write
  half **orange**. Seeing what the resend used to cost next to what it now costs is the
  point of the field.
- **Do not guess which TTL is in force — read it off the last request.** Take the last
  assistant line in that same tail whose `message.usage.cache_creation` is present:
  `ephemeral_1h_input_tokens > 0` means the client asked for a 1-hour cache (TTL 3600,
  1-hour write rate); otherwise `ephemeral_5m_input_tokens > 0` means 5 minutes (TTL 300,
  5-minute write rate). `tail -c` can cut the first line in half, so drop unparsable lines
  (`fromjson?`) rather than letting one abort the pass. Get the timestamp and the TTL from
  a single `tail | jq`, not two passes over the file.
- `$CC_CACHE_TTL` is only the **fallback** for when the transcript says nothing — no
  transcript, a brand-new session, or no `cache_creation` in any of the tailed lines. It
  defaults to `300` (5 minutes) and never overrides a detected TTL. Validate it as digits
  and fall back to the default on junk — an `[: Illegal number:` error must never leak
  into the line. Whichever TTL wins, `>= 3600` selects the 1-hour cache-write rate instead
  of the 5-minute one.

Set `"refreshInterval": 10` in the settings so the field flips to orange on its own during
idle time, with no keystroke needed.

## Pricing

The table must be **Bedrock's** own list prices, not Anthropic first-party rates. Model ids
of the form `us.anthropic.claude-opus-5` bill at the **"Geo and In-region Cross-region
Inference"** tier, 10% above Bedrock's global tier; use that tier.

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

**TLS note:** on networks that intercept TLS, `b0.p.awsstatic.com` can fail certificate
verification with the default trust store. Try the plain fetch first, then retry with
whichever bundle is already configured in the environment — `$CURL_CA_BUNDLE`,
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
  the network while the host is offline: touch `statusline-bedrock-prices.attempt`
  **before** fetching, delete it on success, and skip the refresh while that stamp is newer
  than 1 hour. Writing it first also stops a hung `curl` from spawning a second scraper.
  When the refresh succeeds, reload the table in that same subshell so the monthly total is
  not one refresh behind.
- Prune caches from ended sessions in the same subshell:
  `find /tmp/ -maxdepth 1 -name 'claude-code-session-peak-*' -mtime +3 -delete` and the
  same for `claude-code-month-cost-*` at `-mtime +40`. The trailing slash on `/tmp/` is
  required: on macOS `/tmp` is a symlink and `find` will not follow it otherwise.

## Monthly estimate

Bedrock does not report spend to Claude Code, so `mo:` is a list-price estimate computed
from the transcripts, in the background pass:

- Take `*.jsonl` under `$CLAUDE_CONFIG_DIR/projects`, narrowed with
  `find -newermt "<YYYY-MM>-01"`.
- Keep lines where `.type=="assistant"` and `.message.usage != null`.
- **Deduplicate on `message.id + "|" + requestId`.**
- Filter to the current month using a **local-time epoch range**, not
  `startswith("YYYY-MM")` on the timestamp. Transcript timestamps are UTC, so a string test
  misfiles the last hours of the previous month into this one — a whole UTC-offset's worth
  of spend attributed to the wrong month. Compute the bounds with
  `date -d "<YYYY-MM>-01 00:00:00" +%s` and the same `+1 month`, with BSD `date -j -v+1m`
  fallbacks. Note `fromdateiso8601` rejects fractional seconds, so strip `.NNN` before
  `Z`.
- Price **each entry from its own `.message.model`**, not from the currently selected
  model — a month usually spans several models.
- Per entry: `input_tokens × input + output_tokens × output +
  cache_read_input_tokens × cacheRead + cache-5m × write5m + cache-1h × write1h`, over
  1e6. For cache creation prefer the `cache_creation.ephemeral_5m_input_tokens` /
  `ephemeral_1h_input_tokens` breakdown, taking a bare `cache_creation_input_tokens` at the
  5m rate when a line carries no breakdown.
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

Merge that key in without clobbering the other settings, and refuse if the existing file is
not valid JSON. Leave no `settings.json.bak` behind.

## Verify

Run all of these and show the output. Do not report success on any that fails.

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
   `"type":"assistant"` timestamp is years old. Expect `$0.07->$0.86` for Opus at 125k,
   with only the `$0.86` in orange.
5. **TTL detection** — same fake transcript, three variants:
   - `cache_creation.ephemeral_5m_input_tokens > 0` → `$0.07->$0.86`, and still that with
     `CC_CACHE_TTL=3600` (a detected TTL wins over the env var).
   - `ephemeral_1h_input_tokens > 0` → `$0.07->$1.38`, and still that with
     `CC_CACHE_TTL=300`.
   - no `cache_creation` at all → falls back to `CC_CACHE_TTL`: `$0.86` by default,
     `$1.38` at `3600`.
   Also confirm a 1h transcript whose last response is 20 minutes old renders **warm** (one
   dim figure). Check the detection against a real transcript containing
   `ephemeral_1h_input_tokens`, not only a fixture.
6. **TTL validation** — `CC_CACHE_TTL` unset, `300`, `3600`, `0` and `abc` all render
   cleanly with no shell error text in the line.
7. **Subscription** — add
   `"rate_limits":{"five_hour":{"used_percentage":23.5},"seven_day":{"used_percentage":41.2}}`;
   expect `/5h:24%/w:41%` appended and **no** `mo:` field.
8. **Degenerate input** — empty stdin, `{}`, and `not json` each render a line and exit 0.
9. **Turns** — against a real transcript, the count matches
   `jq -n '[inputs|select(.type=="assistant")|.message.id]|unique|length'`, and a session
   with a `subagents/` directory shows `+N`.
10. **Both shells** — identical output under `sh` and `bash`.
11. **Price refresh** — `sh ~/.claude/statusline-bedrock-prices.sh -v` writes the table in
    a couple of seconds; `claude-opus-5` must be `[5.5, 27.5, 0.55, 6.875, 11]`, matching
    the geo tier on the AWS page. Confirm the values against the page rather than trusting
    the parse.
12. **Refresh failure is safe** — run it with the network blocked
    (`HTTPS_PROXY=http://127.0.0.1:1`): it exits nonzero, prints one diagnostic under `-v`,
    and leaves the existing table byte-identical.
13. **Throttle works** — age the table with `touch -d '2 days ago'`, render once, and
    confirm a background refresh ran; then block the network, age it again, render twice,
    and confirm the `.attempt` stamp is created once and not rewritten on the second
    render.
14. **No `jq`** — with `jq` off `PATH`, the status line prints a single short notice and
    exits 0 rather than a line of empty fields.
15. **No litter** — no leftover `*.$$` temp files in `$CLAUDE_CONFIG_DIR` or `ccprice.*`
    directories in `/tmp` after a successful and a failed run.

Then report that Claude Code has to be restarted to pick the status line up.

## Notes

- `mo:` and the resend figure are **Bedrock geo-tier list prices**, computed locally from
  transcripts — estimates, not an invoice. The session cost, by contrast, is whatever
  Claude Code reports in `.cost.total_cost_usd`, which is on a different (global-rate)
  basis, so the two will not be exactly proportional.
- The cold-cache rule is wall-clock only. It cannot know whether the server actually
  evicted the entry — it only knows how long ago the last response was and which TTL that
  response's `cache_creation` shows. That TTL is a per-request property, so the detection
  is retrospective: it reports what the previous request asked for, and neither it nor
  `CC_CACHE_TTL` changes what Claude Code asks for next.
- The monthly figure counts every project directory under `$CLAUDE_CONFIG_DIR/projects`, so
  it will exceed any single session's cost.
