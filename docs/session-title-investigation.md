# Native title investigation — 2026-09-13

Thread: `01a096ac-3297-7aa3-9f4a-273f3d2d8f1f`.

The previous mux-label override was incorrect. A CCBB label is an address, not
the native Codex title. The corrected code uses native name/preview data in
discovery, history and live pages, and never writes a mux label as a native name.

## History reviewed

Times below are America/Los_Angeles (PDT), September 12 unless specified.

| Time | Recorded event |
| --- | --- |
| 10:31:02 | Thread creation timestamp; originator `ccbb`. |
| 10:36:29 | Opening prompt begins `- Busy indicator for claude code sessions`. |
| 10:39:46 | User requests Claude review with `--model opus -n 'ccbb: term - review'`. |
| 10:40:00 onward | Claude launch attempts; all named review sessions are separate from this Codex thread. |
| 10:49:50 | Retried review launch that produces Claude session `b221550f-c3b9-412c-acae-f987c74d757d`. |
| 11:13:49 | Implementation review launched in `ccbb-term`; Claude session `5bb7700c-1482-4881-b3d2-555650c9829f`. |
| September 13 | User reports the changed list title. |

Sources inspected:

- Native rollout: `~/.codex/sessions/2026/09/12/rollout-2026-09-12T10-31-02-01a096ac-3297-7aa3-9f4a-273f3d2d8f1f.jsonl`.
  Opening prompt at line 9; initial review request at line 65; corresponding
  tool calls at lines 74, 81, 160 and 202.
- The two named Claude review histories in `~/.claude/projects/`.
  Their `custom-title` entries target their own Claude session IDs.
- Native SQLite thread row and a read-only `thread/read` request to this
  thread's running Codex app-server. Both report `name: null` and the opening
  prompt as `preview`; SQLite's legacy `title` field also contains that prompt.
- Current Claude hook configuration has permission/pre-tool hooks only; no
  session-start/title hook was configured. The configured CCBB hook endpoint
  handles permission notifications, not native Codex names.
- Retained Codex runtime logs and `session_index.jsonl`. No native rename for
  this thread was found. Retained thread-specific runtime logs begin at
  10:42:41, after the first review request; they are not a complete title audit.
- Installed Codex UI bundle
  `openai.chatgpt-26.908.40401/webview/assets/app-initial-bca4f920746a.js`:
  `zYt` chooses the native name, otherwise a cleaned preview; `KZ`/`TYt`
  convert Markdown to plain text; `qZ` truncates fallback titles to 60 characters.
  This explains `Busy …` without the opening Markdown list marker.

## Conclusions and limits

Confirmed: this thread currently has no saved native name. Codex's `Busy …`
display is consistent with its normal first-prompt fallback. The Claude review
commands name their own sessions; none of the recorded commands renames this
Codex thread. CCBB's page previously preferred `opt.label` over native preview,
which explained why it kept showing `ccbb: term` while the list showed native
prompt text. The earlier workaround would have concealed this disagreement.

Not established: the exact moment or cause of a change to an earlier native
Codex display title. No earlier native name value or transition was recovered.
A list refresh replacing a provisional/cached title is consistent with the
available state, but timing alone does not prove the Claude launch caused it.
The previous exact native title would help distinguish this from a failed or
lost generated-name write. The user has been asked for that value.

No native title, SQLite row, or transcript was modified by this investigation.
