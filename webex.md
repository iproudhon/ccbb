# Webex Integration (Archived)

## Overview
Webex front-end for a LIVE Claude Code session. Reads Claude Code's own data directly via `ccbb-common`; no external service state required.

## Features
- **Display (Claude → Webex)**: Tails the session JSONL (`~/.claude/projects/.../ID.jsonl`) and mirrors each new entry (assistant text + every tool call) to the attached Webex space. Per-entry granularity: one request/response logged → one Webex update.
- **Input (Webex → Claude)**: Types your Webex message straight into the running `claude` process by pasting it into that session's tmux pane (bracketed paste, then Enter). No detached agent spawned; the bot drives the session you're already running.

## Requirements
- Target `claude` session must be running inside a tmux pane on the host.
- Webex bot token configured in `CLAUDE_DIR/ccbb-config.json`

## Configuration
Config shape (add to `~/.claude/ccbb-config.json`):
```json
{
  "token": "<webex bot token>",
  "allow": ["you@example.com"]
}
```

## Commands
(1:1 space: just type; group space: @mention the bot)
- `/list` — list sessions (click a card to attach)
- `/attach <id>` — attach this space to a running session (must be live in tmux)
- `/detach` — detach this space
- `/stop` — send Esc to the session's pane (interrupt the running turn)
- `/compact` — run Claude Code's `/compact` in the session
- `/help` — show help
- `//name [args]` — run a custom command (see `.commands` / `//help`)
- `<anything else>` — pasted into the attached session's tmux pane as your prompt

## Implementation Details
- Entry point: `ccbb-webex.js`
- Dependency: `webex-node-bot-framework@2.5.1`
- Note: Node ≥21 requires `globalThis.navigator` to be writable; @webex/internal-media-core transitively assigns to it on load.
  ```js
  Object.defineProperty(globalThis, 'navigator',
    { value: globalThis.navigator || { userAgent: 'node' }, writable: true, configurable: true });
  ```

## To Reinstate
1. Add to `package.json`:
   ```json
   "optionalDependencies": {
     "webex-node-bot-framework": "^2.5.1"
   }
   ```
2. Run `npm install`
3. Ensure Webex config exists in `~/.claude/ccbb-config.json`
4. Run: `ccbb webex`
