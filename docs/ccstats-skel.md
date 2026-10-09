# ccstats-skel

Collects token/latency stats from your local Claude Code and Codex sessions into one small
file. No message text, prompts, tool arguments, paths, titles or session ids are kept: only
message kinds, token counts and timestamps.

```bash
npx -y -p github:iproudhon/ccbb ccstats-skel      # → ./ccstats-skel.json.gz
# or, without git/npx:
curl -sL https://raw.githubusercontent.com/iproudhon/ccbb/main/ccstats-skel.js | node -
```

Needs node ≥18 (and git for npx). Then send `ccstats-skel.json.gz` back. Options go after
`ccstats-skel`, or after `node -` (e.g. `| node - -o me.json.gz`).

Options: `-o <file>` (plain JSON unless it ends in `.gz`), `-d <dir>` (default `~/.claude`
and `~/.codex`), `-m <model glob>`, `-s <source glob>`. Full details: [ccstats.md](ccstats.md#collecting-from-others-ccstats-skel).
