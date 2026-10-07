# ccstats-golizer

`ccstats-golizer.js` reports on [golizer](../../mnemo-txf/golizer.md) `histo` and/or `replay`
runs: what the inference servers served, side by side with the skeletons the runs were drawn
from. Give one run or both; both go on one page and are compared against the source and
each other. It stands alone; `ccstats-chart.js` is a copy of `ccstats.js`'s chart code, so
both reports draw the same way.

**1. Collect the source.** Run [`ccstats skel`](ccstats.md) on each machine whose sessions
should shape the load, then gather the files in one place:

```bash
node ccstats.js skel -o cc-$(hostname -s).json
```

**2. Run golizer** (build it once with `go build -o golizer golizer.go`). `-out` writes the
run file, which is all the report needs:

```bash
# histo: -runs N rows in windows of -window L turns, drawn to match the source's histogram
./golizer histo -runs 1000 -window 25 -concurrency 1024 -max-ctx 1048576 \
    -out golizer-histo.json -targets targets.txt \
    http://localhost:30800/v1/completions cc-*.json 600000 1

# replay: whole sessions, every row by default (-runs 0)
./golizer replay -concurrency 256 -max-ctx 1048576 \
    -out golizer-replay.json -targets targets.txt \
    http://localhost:30800/v1/completions cc-*.json 600000 1
```

`targets.txt` lists one base URL per node. With `-targets`, the URL argument gives only the
path. `golizer histo -dryrun -runs 1000 -window 25 cc-*.json` prints the draw without sending
anything.

**3. Render.** Pass the run file(s), the **same** skeleton files golizer was given and the
same `-max-ctx`:

```bash
# both runs on one page → golizer-report.html next to the first run file
node ccstats-golizer.js --max-ctx 1048576 golizer-histo.json golizer-replay.json cc-*.json

# one run → golizer-histo-report.html next to it
node ccstats-golizer.js --max-ctx 1048576 golizer-histo.json cc-*.json

# -o to choose the path, -t the title
node ccstats-golizer.js --max-ctx 1048576 golizer-*.json cc-*.json \
    -t 'GLM-5.3, 7 nodes' -o glm53.html
```

A run file is recognised by its `"tool": "golizer"`, so file order doesn't matter, and each
run file tells `histo` (`golizer-w<id>` windows) apart from `replay` (the source's session
ids). histo always comes first on the page. The source is read the way golizer reads it:
sessions deduped by fingerprint, only haiku/sonnet/opus/fable rows, `cw = cacheWrite + input`,
and rows over `--max-ctx` dropped. The Jensen–Shannon distances use golizer's own bins, so
they match what golizer prints.

**replay** writes every session under the source's own id. So each served row is paired with
the source row it replays: output exact, and total prompt within 1,152 tokens. golizer floors
each turn to a 64-token block and carries the lag, up to 1,024, into a later write. Pairing
gives:

- **fidelity:** the share of rows paired.
- **cache misses**, a paired row that read less than its prefix:
  - *in-chain:* a row continuing an earlier turn of its chain read more than a block short of
    that turn's **served** prompt. This test is exact.
  - *first-turn:* the first row after a cold build (a session's first, or a cr past every
    stream built so far) read short of the source's cr; the cold build was evicted.
  - *branch:* a compaction or a subagent read more than 1,152 short of the source's cr; the
    prefix it branches off was gone.
- **tokens re-prefilled:** the sum of the shortfalls.

Sessions with misses are drawn in red. A **histo** window carries no link back to its source
rows, so a histo run shows the distances, not fidelity or misses.

The page shows, with source in blue, histo in orange and replay in purple:

- A tile row per series: rows, both JS distances with their floors, fidelity and misses
  (replay), headroom, wall time and mean response.
- A prompt-size histogram per series, stacked cache-read / cache-write / decode as in the
  ccstats report, on shared bins and one y scale. A log/linear toggle switches the bins.
- A source-vs-runs overlay, the (cr, cw) bin table with a share and mean column set per
  series, and CDFs of cr, cw and out.
- Per run, the windows or sessions played and the pool over the run (in-flight, resident,
  host tier, busy, live footprint, running / waiting), per node or for the whole fleet, plus a
  per-node summary table.
- Latency per prompt bin, one line per series.

golizer's stdout is not read. `--confluence` works as it does for `ccstats stats` (a Shadow
DOM page in the HTML macro), with one difference: the page script (data and code) ships
gzipped and base64-encoded inside a short ASCII loader, after a `<style>` block (the order
of a body Confluence is known to accept). Confluence's HTML macro rewrote the plain script
text into a SyntaxError, and base64 leaves it nothing to rewrite. The browser unpacks it with
`DecompressionStream` (Chrome 80+, Firefox 113+, Safari 16.4+), still offline. Both runs on
one page come to about 40 KB. The pool charts are the largest part, bucketed to
`--pool-points` (default 240) per run; lower it if a paste is rejected.

## Tests

```bash
node test/verify-golizer.js    # source + histo run + replay run with known misses → each alone, both together
```

`test/dom-shim.js` provides just enough DOM to run the page script in `vm`.
