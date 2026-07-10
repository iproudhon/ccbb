# Claude Code: global terse output setup

Instructions for setting up a global "terse" output style in Claude Code, so responses are compact and waste fewer tokens. Give this file to Claude Code on any machine and ask it to apply the setup.

## What to do

### 1. Create `~/.claude/output-styles/terse.md`

Create the directory if it doesn't exist, then write this file exactly:

```markdown
---
name: terse
description: Extremely compact responses to minimize context and token usage
keep-coding-instructions: true
---

# Terse output

Minimize output tokens ruthlessly while keeping answers correct and complete.

- Answer first, in the first sentence. No preamble ("Sure", "Great question", "I'll now..."), no restating the question, no sign-off.
- Don't narrate what you're about to do or recap what you just did unless the result is surprising or the user must act on it.
- Prefer one short paragraph or a tight bullet list over headers, tables, and sections. Use structure only when the content genuinely needs it.
- Omit caveats, alternatives, and background unless they change what the user should do.
- In code: no explanatory comments, no "here's the code" framing. Show only the changed/relevant lines with enough context to locate them, not whole files.
- When reporting command/test results, give the verdict and only the failing/relevant lines, not full output.
- One clarifying question max, and only when genuinely blocked; otherwise pick the reasonable default and note it in a clause.
- If a longer explanation would help, offer it in one short sentence ("Ask if you want the reasoning") instead of including it.
```

### 2. Set it as the active style in `~/.claude/settings.json`

Read the existing file first and **merge** — do not overwrite other settings. Add this top-level key:

```json
{
  "outputStyle": "terse"
}
```

Validate afterwards with `jq -e . ~/.claude/settings.json` (a malformed settings.json silently disables everything in it). Restart Claude Code or start a new session for the style to take effect. You can confirm/change it later via `/config` → Output style.

## Reasoning

- **Why an output style instead of `~/.claude/CLAUDE.md`?** An output style is injected into the system prompt itself, so adherence is stronger and survives long sessions and context compaction better. CLAUDE.md instructions are loaded as user memory alongside everything else and can drift in long sessions. Setting both is redundant — pick the output style and keep CLAUDE.md for actual preferences/facts.
- **Why `keep-coding-instructions: true`?** Without it, a custom output style *replaces* Claude Code's built-in coding behavior instructions rather than adding to them. This flag keeps the default software-engineering behavior and only layers the style on top.
- **Why user-level (`~/.claude/`) not project-level?** User-level applies globally to every project. Project-level (`.claude/output-styles/` + `.claude/settings.json`) would need to be repeated per repo and would impose the preference on teammates if committed.
- **Why "answer-first / no narration / no full output" rules specifically?** Most wasted tokens in assistant replies come from preamble, restating the task, narrating steps, and pasting full command output. The rules target those directly while explicitly preserving correctness ("keeping answers correct and complete") so terseness doesn't degrade into unhelpfulness.
- **Note (2026): the `/output-style` command was removed** (deprecated v2.1.73, removed v2.1.91). The current mechanisms are the `outputStyle` settings key or `/config`. There is no built-in "concise" style, hence the custom one.

## Optional: reduce context usage too (bigger win than terse replies)

Terse replies only shrink Claude's own text, which is a small slice of the context window — tool output (file reads, bash results) dominates. If context size is the goal, also consider adding to `"env"` in `~/.claude/settings.json`:

- `"BASH_MAX_OUTPUT_LENGTH": "10000"` — cap bash output kept in context (default is 30,000 characters; overflow is saved to a file Claude can read on demand, so nothing is lost).
- `"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "50"` — trigger auto-compaction earlier.
- `"ENABLE_TOOL_SEARCH": "auto"` — defer MCP tool schemas instead of loading all upfront.

These are optional and independent of the output style; apply only if asked.
