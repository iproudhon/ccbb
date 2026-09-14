# Multi-server ccbb (peers)

## Overview
Run `ccbb web` on every machine you work on and let each instance reach the others. The
session list then spans all of them, and any peer can drive any other peer's sessions —
same composer, same permission cards, same `//commands`. There is no master: every server
is a full front-end that happens to know how to reach its neighbours.

## How it works
Each server serves its own sessions under `/api/…` and every peer's under
`/peer/<name>/api/…` — the *same routes*, reverse-proxied by name. WebSocket upgrades
(`/peer/<name>/ws/<id>`) are proxied too, so live transcript tailing and permission
prompts work identically for a remote session. The browser only ever talks to the server
it loaded from; the browser never needs to reach a peer directly.

Peers are addressed **by name**, resolved against this host's config and nothing else —
a browser cannot ask a ccbb server to proxy to an arbitrary URL.

Proxying is **one hop**. A request that arrived through a peer's proxy carries
`X-Ccbb-Via` and will not be forwarded again, so a peers-of-peers cycle can't loop.

### Inbound peers need no configuration
Configuring peers on both sides would demand a route each way, which an ssh tunnel rarely
gives you — the side that dials out has no listening address in the other's namespace.

So the caller also holds a WebSocket open to every peer it knows (`/peer-link`), and the
callee sends requests back **down that socket**. One direction of connectivity is enough
for a two-way mesh: a server you never configured shows up as an ordinary peer, with its
sessions listed and drivable, as soon as it calls you.

A link is simply a tunnel to the caller's own server: on receiving a request it replays it
against its own `127.0.0.1:<port>` and pipes the answer back. Every route works over a
link exactly as over HTTP — including the live-tailing WebSocket — with no second
implementation to keep in step. Links are one hop too, and reconnect on their own.

A configured URL always wins over a link, so a peer you *did* configure keeps talking
direct HTTP.

### Liveness
Peer health is probed every 15s (`/api/identity`, 5s timeout), and the same tick redials
any link that is not up. What makes that work is refusing to take a socket's word for it,
because both ways a tunnel dies leave one looking perfectly healthy:

- **The handshake never finishes.** An ssh forward whose far end is gone still *accepts*,
  so TCP connects and the upgrade response never arrives — no error, no close, and the
  socket sits in `CONNECTING` indefinitely. The redial check saw "already connecting" and
  skipped, every poll, forever: a link that failed this way was dialled once at startup
  and never again. There is now a 10s handshake deadline.
- **The socket is half-open.** The tunnel died without a FIN, which is the ordinary way a
  tunnel dies. The socket stays `OPEN` and nothing errors. Both ends now ping every 30s
  and require a pong before the next one; a missed answer destroys the socket rather than
  closing it politely, since the far end has already stopped replying.

Either way the socket ends up destroyed, which is what lets the ordinary poll dial again.
Both ends ping because only the caller redials, but only the callee can notice the caller
is gone — and an inbound link is listed as an ordinary peer, so a dead one left in the map
is a machine reported `up` that nobody can reach.

Removing a peer from the config closes its link on the next poll, so peers can be added
and removed without a restart in both directions.

Measured on a simulated tunnel: a half-open link is dropped within ~60s (two ping
intervals) and recovers ~20s after the tunnel returns; a stale forward is redialled every
poll instead of never; a peer restart reconnects within ~20s.

## Requirements
- A route from each host to its peers' ccbb ports. `ccbb web` binds `127.0.0.1`, so the
  normal answer is an ssh tunnel and a `127.0.0.1:<port>` peer URL:
  ```sh
  ssh -N -L 8591:127.0.0.1:8590 laptop      # laptop's ccbb → local port 8591
  ```
- Nothing else. Peers need no shared filesystem; each reads its own `~/.claude`.

## Configuration
Add to `~/.claude/ccbb-config.json` on **each** machine:
```json
{
  "server": { "name": "workbox" },
  "peerToken": "long-random-string",
  "readToken": "another-long-random-string",
  "peers": [
    { "name": "laptop",  "url": "http://127.0.0.1:8591", "token": "laptops-peerToken" },
    { "name": "builder", "url": "http://127.0.0.1:8592", "token": "builders-peerToken" }
  ]
}
```
- `server.name` — how this machine identifies itself. Defaults to the hostname.
- `peers[]` — who this machine can reach. `url` is whatever the tunnel exposes locally.
  Entries naming this server, and duplicates, are ignored. The config is re-read per
  request, so peers can be added or removed without a restart.
- `peers[].token` — the *peer's* `peerToken`. Falls back to this file's `peerToken` if
  every machine shares one secret.
- `peerToken` — what **this** server demands of its callers. Omit it and there is no
  auth at all, which is the original single-host behavior.
- `readToken` — a second, weaker secret: a **view-only** pass to this one machine. See
  below. Omit it and the feature is off, which is the default.

### Token auth
With `peerToken` set, every request needs the token as an `X-Ccbb-Token` header, a
`ccbb_token_<port>` cookie, or a `?token=` query param:
- **Peers** send the header automatically (from `peers[].token`).
- **Your browser** — open the UI once as `http://127.0.0.1:8590/?token=<token>`. It banks
  the token in an HttpOnly cookie and redirects to a clean URL, so the secret stops riding
  in the address bar. Later visits just work.

  The cookie is named per port — `ccbb_token_8590`, `ccbb_token_8591`, … — because cookies
  are scoped to the HOST and ignore the port. Without that, every ccbb you reach as
  `127.0.0.1:<port>` (your own, plus each peer you tunnel to a local port) would share one
  cookie, and logging into one would log you out of the next. As named, each server keeps
  its own token and you can hold several open at once, each with a different secret.
- **Prompt-capture hooks** — re-run `ccbb hooks install` after setting the token;
  the generated curl picks it up.

A token mismatch shows up in the UI as `unauthorized (token mismatch)` on that server's chip.

### Read-only token
`readToken` is what you hand someone who should *watch* a machine without being able to
touch it — or paste into a link you are about to share. It is banked in the same cookie as
the full token and opens the same UI, minus everything that acts:

- **No peers.** `/api/servers` returns this server alone, and any `/peer/<name>/…` request
  — HTTP or WebSocket — is refused with 403. The chip bar shows one machine. (A peer deep
  link opened with the read token redirects to the local list rather than erroring.)
- **No terminal.** The launchers are gone from the server chips and from a session's ⋮
  menu, and `/api/term/open` and the `/ws-term/…` socket are refused.
- **No writing.** The composer is not rendered; a session cannot be messaged, renamed,
  answered (permission or AskUserQuestion), or sent `//commands`, and `/api/hook` is
  closed. Every one of those routes 403s on its own, so the missing buttons are a
  courtesy, not the enforcement.
- **No subscription in the cost summary.** That block shows the **Bedrock row alone** —
  no `Sub` row, no `Total` (which would give the subscription figure back by subtraction),
  no `SUBSCRIPTIONS` table, and no `/5h:…/w:…` quota badge beside the scope cost. The
  subscriptions table is an account holder's name, email, org, plan and quota, which is
  the most personal thing on the page and not what a shared link is for.

  This last one is presentation rather than enforcement, and the difference is worth
  stating: a read-only caller still reads `/api/cost-summary` and `/api/subscription`,
  because the session list and the session view are built from them. What it removes is a
  figure nobody sharing a link means to share — not a secret. The quota badges elsewhere
  (a session view's header, its stats line, the phone's summary bar) are left alone.

What it *does* get is the whole picture: the session list, live transcripts and their
sockets, per-session costs, session stats. Permission and question cards still render —
their options are the question being asked — but read as text, above a note saying the
answer has to come from the terminal.

`readToken` needs `peerToken` set to mean anything: without one, this server has no auth
at all and everyone already has full access. Setting it equal to `peerToken` is likewise
ignored. Both cases are called out on startup.

## Using it
- **Session list** — the bar shows this server's identity. A chip per known server with a
  health dot toggles whether its sessions are listed; the selection is remembered across
  reloads. The table gains a sortable **Server** column, and the cost summary is the sum
  over the selected servers. Sessions come from two places: the transcripts under
  `~/.claude/projects`, and the live registry in `~/.claude/sessions` — so a session that
  has only just started, and has written nothing yet, is listed (and drivable) at once.
- **No polling** — the table is fed by one WebSocket per selected server (`/ws/list`,
  proxied for peers), which sends the whole list on connect and again on refresh or a
  scope change. Nothing refreshes on a timer. The header shows the age of the data —
  `12s`, `3m`, `2h` — next to the refresh button. The cost summary is fetched over HTTP at
  the same three moments.
- **Live row updates** — the server can push row-level deltas from a filesystem watch on
  `~/.claude`, so a row moves the moment a session starts, exits or bills a turn. This is
  **off by default**; start the server with `CCBB_LIST_WATCH=1` to enable it. Session
  liveness (the dot, `working` / `waiting for input`) is pushed either way.
- **Older peers** — a peer running a ccbb without `/ws/list` accepts the socket and then
  says nothing, so silence for 5s is taken as a version mismatch: that server falls back
  to polling `/api/sessions` every 15s, and the socket is retried every minute. Its
  sessions stay listed either way.
- **Hiding the list** — the `▾` chevron on the list header folds it away to a bare
  chevron strip, leaving the open sessions to fill the space; click the strip to bring it
  back. It is offered only once something else is open, and the last session closing
  unfolds it, so you can never be left on a blank page.
- **Unreachable peers** — reported as a line above the table. The sessions that did load
  stay usable; one dead tunnel never blanks the list.
- **Session view** — a badge names the machine the session actually runs on (muted when
  it's this one). Everything else behaves exactly as for a local session: typing into the
  composer injects into that machine's tmux pane, permission dialogs answer there, and
  `//commands` run there.
- **Deep links** — `/session/<id>` for local, `/peer/<name>/session/<id>` for remote.

## Endpoints
- `GET /api/identity` — `{name, hostname, port, version}`.
- `GET /api/servers` — this server plus every configured peer with its last health probe
  (`status`, `rttMs`, `lastSeen`, `error`). Peers are probed every 15s in the background,
  so this never blocks on a dead tunnel.
- `GET|POST /peer/<name>/api/…` — reverse-proxied to that peer, over its configured URL
  if there is one, otherwise back down the link it opened to us.
- `GET /ws/list[?month=YYYY-MM]` — WebSocket. Sends `{type:"list", sessions, totals}` on
  connect. Send `{type:"scope", month}` to re-scope, or `{type:"refresh"}` to ask again;
  both are answered with a fresh `list`. With `CCBB_LIST_WATCH=1` the server also pushes
  `{type:"delta", upd, del, totals}` as the session set changes.
- `GET /ws/<sessionId>` — the session socket. Besides `transcript`, `permission` and
  `ask_block` it now pushes `{type:"live", live, status, statusAt}` when the session's
  registry entry changes, so an open view never polls for liveness.
- `GET /api/session/<id>/history?head=&tail=` — the two ends of a transcript with the
  gap left out (`{total, head, tail, tailFrom}`); `?from=&to=` returns a slice
  (`{total, from, entries}`), which is also how a reconnected view asks for only what was
  appended. No parameters still returns the whole transcript.
- `GET /api/months` — `{months:[…]}`, the month keys for a scope selector.
- `GET /peer-link?name=<caller>` — WebSocket upgrade; the caller's reverse channel.
- `GET /peer/<name>/session/<id>` — served locally as this app's page, deep-linked to a
  remote session. (Proxying it would return the peer's whole app.)

## Limitations
- The CLI (`ccbb ls`) and the Webex/Confluence front-ends are local-only.
- A read-only token is per server. It grants nothing on your peers — but neither does it
  stop a peer of yours from being reached with ITS own full token by someone else.
- One hop: your machine sees the peers *it* configures plus those that link in to it —
  not its peers' peers.

## Remembered per server
Two settings are stored in cookies keyed by server name, so each machine keeps its own:
- `ccbb_ui_<server>` — vertical or horizontal view stacking, for the server serving the
  page. Applied before the first layout, so a page restored as columns does not flash
  stacked and reflow.
- `ccbb_term_<server>` — that server's terminal window: position, size, text size, theme
  and grid. See terminal.md.
