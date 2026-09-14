# Host terminals

## Overview
There are three ways in, and two places a terminal is drawn.

A **server chip** in the session list opens a *host* terminal: a floating window with a
login shell **on that machine** — a real pty, colours, `vim`, `htop`, resize and all.

A session view's **⋮** offers the same session two ways. **`$_`** draws its terminal in
the view's own **content area**: the transcript and composer step aside while it is open
and come back when it closes. **`#_`** puts it in the **floating window** instead — the
very window the server chip opens, with the place, text size and grid you last left it
at. See "The session's terminal" below; the rest of this file describes the window.

The two differ in one thing beyond where they are drawn: **who owns the size**. `$_` takes
tmux's grid and never touches it — see "Never resize tmux". `#_` is a window you sized,
with a grid remembered in a cookie, so it behaves like every other tmux client and
**resizes the session to fit itself**, exactly as a second `tmux attach` from another
terminal would. Both are deliberate; pick by whether you are watching that session
elsewhere.

There is **one floating terminal per server**, however it was opened. Opening a second
replaces the first, in place: the old shell ends and the new one takes over its position,
size, text size and theme. That is what makes the remembered layout coherent — two
windows on one server would be two writers of one cookie, fighting over it. So `#_` on a
session re-points that server's window at the session's pane rather than adding a window.
The in-view terminal is separate from all of this: it is per session, keeps no cookie,
and several can be open at once.

No ssh is involved. A peer's terminal rides the connection ccbb already holds to that
peer: `/peer/<name>/ws-term/<id>` is spliced by the same proxy that carries session
tailing, over the peer's configured URL if there is one, otherwise back down the link it
opened to us. A server you never configured — reachable only because it called you — is
as drivable as your own.

The window floats rather than joining the view stack on purpose: a terminal is something
you want *over* whatever you are reading, at whatever size, and still open when you
switch sessions.

## The window
- **Drag** by the header, **resize** by the bottom-right grip. Minimum 340×150, and both
  are clamped so the window can never leave the screen.
- **⚙** opens settings: text size (A−/A+), theme (black on white, or white on black), and
  an explicit **columns × rows**.
- **–** minimizes to the title bar, **□** maximizes, **✕** closes (which ends the shell).
- The dot in the title bar is the connection lamp: grey connecting, green live, red
  exited.
- One window per server, several servers at once; clicking one brings it to the front.

### Columns and rows
The grid is what you ask for and the window wraps it, so the two can never disagree:
typing a size resizes the window to fit it exactly, and dragging the window edge updates
the numbers. A grid larger than the screen is clamped, and the fields then show what it
actually got. Changing the text size reflows the grid, and the far end gets a real
`SIGWINCH`, so full-screen programs redraw at the new size.

### What is remembered
Position, size, text size, theme and grid are saved in a cookie **per server** —
`ccbb_term_<server>` — so each machine's terminal comes back where you left it, looking
how you left it. Two servers keep two independent layouts.

A remembered rect is sanity-checked before it is used: a window saved on a larger screen,
or on a monitor that is no longer attached, would otherwise come back somewhere it could
never be grabbed from. Size is clamped to the viewport first (it bounds the position),
then position, so the whole window is always visible. Missing or corrupt values fall back
to defaults rather than to zero.

Maximized and minimized are deliberately *not* saved: restoring into either would hide
where the window really lives.

## The session's terminal
**`$_`** under a session view's **⋮** fills that view's **content area** with a terminal
on the machine the session runs on, and toggles back to the transcript. It is not a window:
you are already looking at the session there, and the grid it has to draw is not one it
may choose, so half the area would only mean half the font.

### Never resize tmux
This is the in-view terminal's rule, and the floating window's opposite number: `#_` may
resize tmux, `$_` may not.

A browser terminal is a tmux *client*, and tmux sizes a session to its clients. A pty even
one row off from what tmux already has therefore reflows the TUI in your own terminal, and
leaves it reflowed for as long as the browser is open — which is a strange price to pay
for glancing at a session from a laptop.

So this terminal does not get to pick: it opens with `pin: true` and the server measures
tmux (`window_width`, and `window_height` **plus the status lines**, which belong to the
client and not to the window) and builds the pty to exactly that. The size the page asked
for is a hint that tmux overrules, the answer comes back as `pinned`, and from then on the
page never sends a `size` frame — the server drops one anyway. The floating window sends
`pin: false` and is sized the ordinary way, which is what the next section is about.

What gives instead is the **font**. The grid is fixed and the type is scaled until it fits
the content area, anchored top-left, with the leftover space showing on the far edges. A
badge in the corner reads `80×48 · 5.75px · session pane` so it is never a mystery what
you are looking at.

Fitting cannot be solved for. xterm rounds a cell to whole device pixels, so font size →
grid size is a *staircase*: 5.5pt and 5.75pt can draw the identical screen, and a quarter
point more can cost a whole pixel per row. Scaling by how far off you are lands one step
too big, then one step too small, forever. It is a binary search on the quarter-point grid
instead — the largest size seen to fit against the smallest seen not to — which settles in
about seven measurements and then stays still. Maximizing the view re-runs it, so the same
80×48 that reads at 5.75px in a stacked view reads at 13.75px full-screen.

### One tmux client per session page
Every browser terminal is its own tmux client, but a tmux *session* has ONE current window
shared by all of its clients — so with two session pages open, the second terminal dragged
the first, and your own terminal, onto its window.

Sessions in a **group** share the window list but each keeps its own current window, so
each session page gets a grouped session of its own: `ccbb-<first 8 of the session id>`,
made against whichever tmux session the pane lives in. Two pages, two clients, two current
windows, one set of real windows underneath. It shows up in `tmux ls`, which is the point —
you can see whose it is.

The name is also on the window made for a session that was not running, so the pair reads
together, and the window is found by that name rather than remembered in memory: a restart
would otherwise make a second window for a session that already had one.

What grouping does **not** isolate: a window's active pane belongs to the window, so
selecting Claude's pane still moves it for everyone. Only the window jump stops leaking.

If the grouped session cannot be made — an old tmux, a name that cannot be claimed — the
terminal attaches to the base session exactly as it used to. The failure mode is the old
behaviour, not a broken terminal.

### Landing on Claude's pane
If the session is live in a tmux pane, the terminal **attaches to that pane** — you get the
running Claude Code TUI itself, not a shell beside it — and the badge says `session pane`.
The window is selected on the grouped session and the pane by id, before the attach, so a
window whose focus was left on some other pane lands on Claude's anyway.

### When the session is not running
There is nothing to attach to, so one is made: a **new window in the tmux session that
already holds the most Claude Codes**, `cd`'d to the session's working directory. Ties
break on the most recently updated Claude session in each, then on the name, so the answer
is the same twice running rather than a matter of listing order.

No `claude` is started in it. Resuming a session is a decision, not something that should
happen as a side effect of opening a terminal — the directory is set up and the prompt is
yours. The badge says `new window`.

The window is remembered per session, so opening the terminal again returns to it instead
of littering tmux with one window per click. It is made with `-d` and outlives the browser
terminal: it is a window in *your* tmux, not a temporary.

If there is no tmux on that host at all, you get an ordinary login shell in the session's
directory, sized to the box like any other terminal.

### Cleaning up after itself
`destroy-unattached` is set on the grouped session, so **tmux** removes it once its last
client leaves — no bookkeeping in ccbb, and two terminals sharing one session need no
"is anyone else still here" question answered. It is armed only *after* a client has
attached: set on a still-detached session, tmux destroys it inside the second and the
attach that was moments away finds nothing left.

That covers every exit except one. `kill -9` on ccbb cannot be caught, so its ptys are
reparented to init and keep running — and a pty running `tmux attach` is a client that
holds its session *attached*, which means `destroy-unattached` will not fire for it either.
Nothing tmux or the OS does clears it.

So ccbb sweeps at startup, and two independent facts have to agree before it ends anything:

- the **pts file**. Every terminal writes its pty device to `$TMPDIR/ccbb-pts-<pid>-<id>`
  and unlinks it only on a clean close, so the files whose `<pid>` is dead name exactly the
  ttys left behind.
- the **client list**. A pts number is recycled, so a stale file can name a tty that now
  belongs to a real terminal of yours. A tty is only ended if it is *also*, right now, a
  client of one of ccbb's own `ccbb-*` sessions.

Detaching the client ends its `tmux attach`, which ends the `script(1)` holding the pty —
the whole tree. Any `ccbb-*` session still left unattached is then removed too, unless it
is the last session in its group: that means the base session was killed out from under it
and the windows, a running Claude among them, live there now. Those are left alone and said
so on startup.

### On the phone
The phone front-end keeps its full-screen terminal — there is no content area to share on
a 390px screen — but it obeys the same pin. It used to force 80 columns and scale the font
to that, which resized tmux for as long as the phone was looking; a session's terminal now
takes tmux's grid instead and scales both dimensions to it. Anything that is not a session
(a server chip) still gets the 80 columns, since nothing there owns a size worth keeping.

## Access
**Anyone who can reach the ccbb UI gets a shell on that machine, and on every peer it can
reach.** Set `peerToken` (see peers.md) on any server whose port is reachable by more
than you. This is the trust level ccbb already had — it can type into your tmux panes —
but a terminal makes it plain.

## How it works
Node cannot open a pty without a native module, so `script(1)` opens one. That name
covers two different programs: util-linux takes the command with `-c` and flushes with
`-f`, while the BSD one on macOS takes it as trailing arguments and flushes with `-F`.
On macOS there is a further catch: BSD script calls `tcgetattr()` on its own stdin and
only forgives the errnos meaning "not a terminal". Node's `stdio:'pipe'` is a socketpair,
which answers `EOPNOTSUPP` instead, so script dies at birth; only an anonymous pipe
answers `ENOTTY`, and a `cat |` pipeline is what supplies one.

That pipeline is *not* used everywhere. It puts an asynchronous command in a pipeline,
and on WSL2 that construct forwards nothing — the fds are wired correctly, but no byte
crosses them, so the shell prints its prompt and then ignores every keystroke. So ccbb
probes: it runs each shape, writes a marker into stdin and waits to see it come back,
and takes the simplest one that actually moves data. Checking an exit status is what hid
the WSL2 break, exactly as probing with `/dev/null` on stdin hid the macOS one — both
prove the arguments parse, neither proves anything flows. The chosen shape is logged.

```
script -q -f -c 'stty rows R cols C; exec $SHELL -l' /dev/null

# or, for a live session's pane:
script -q -f -c 'stty …; tmux select-window -t %9; tmux select-pane -t %9;
                 exec tmux attach -t <session>' /dev/null
```

`stty` runs inside the pty before the shell starts, so the first prompt is drawn at the
right geometry instead of at 80×24 and then redrawn.

Resizing afterwards is the interesting part. `script` owns the pty *master* and we have
no handle on it — but the shell it forked holds the *slave* as its stdin, and setting the
window size there is what makes the kernel raise `SIGWINCH` on the foreground process
group. So ccbb finds that shell with `pgrep -P`, asks `ps -o tty=` for its terminal, and
runs `stty` against the device. That is the whole resize mechanism.

Neither half is spelled the same everywhere: `ps` reports `pts/3`, `ttys003` or a bare
`s003` depending on the system, so the candidate paths are tried against the filesystem
instead of assumed; and the device flag is `-F` for GNU stty but `-f` for BSD, so that is
probed and remembered too. The size itself is set as `columns`, which both spell out,
rather than `cols`, which only GNU accepts.

### Why a WebSocket
`proxyHttpOverLink` buffers a whole response before returning it, so a streaming response
would never reach a browser through an inbound link — while `proxyUpgradeOverLink`
splices sockets both ways. A WebSocket is therefore the only transport that behaves
identically for a local server, a configured peer, and a peer that merely linked in.

### Ordering
One socket is one ordered stream, so bytes cannot arrive out of order in either
direction, and keystrokes need no sequencing of their own. Output chunks still carry a
sequence number, but it is an *assertion* and a resume cursor, not the input to a
reordering buffer: a number that isn't `last + 1` means bytes were lost, not shuffled, and
no amount of buffering would make the screen correct. The client drops the socket, and
the reconnect replays.

The server keeps 256 KB of recent output per terminal. A reconnect asks to resume with
`?from=<seq>`; if the gap is wider than the backlog, the server says `reset` and replays
what it still holds, and the client clears the screen and follows the tail down.

### Front end
`xterm.js` and its fit addon are fetched from jsDelivr the first time you open a terminal,
never at page load — the rest of ccbb neither pays for that round trip nor depends on it.
If the CDN is unreachable the window says so and everything else keeps working.

### Lifetime
The window owns the shell. Closing it ends the session, and so does closing the tab (a
`pagehide` beacon — which is why one HTTP close route exists alongside the socket). A
socket that merely drops gets a 60s grace period to reconnect, so a reload of the tunnel
or a network blip does not cost you the shell. A browser that vanishes without either is
collected after that grace expires.

Terminals do not survive a ccbb restart: a pty is a child process, not something the OS
reclaims with the server, so ccbb kills them on `exit`, `SIGINT`, `SIGTERM` and `SIGHUP`
rather than stranding one shell per open terminal. `kill -9` on ccbb itself cannot be
caught; what it strands is swept on the next start — see "Cleaning up after itself".

The kill is a `SIGKILL`, deliberately: `script(1)` absorbs SIGHUP and SIGTERM without
dying and without passing them on, so anything gentler leaves the pty running forever.
It is not abrupt for the shell — closing the pty master hangs up the terminal, which
delivers SIGHUP to the foreground process group exactly as closing a terminal window
does, and the shell (or tmux client) exits with it.

## Endpoints
- `POST /api/term/open` — `{cols, rows, sessionId?, pin?}` →
  `{id, cols, rows, shell, attached, where, pinned}`. `where` is `pane` (attached to the
  session's own pane), `window` (a window made for it) or `shell` (no tmux here), and
  `attached` stays as the boolean for `pane`. `pin` says whether tmux's grid rules this
  terminal or the other way round; it defaults to **true**, which is what an older
  front-end that never sends it means. With `pinned`, `cols`/`rows` are tmux's
  measurements rather than the ones asked for, and the caller must draw that grid and
  send no `size`; without it they are the ones asked for, and tmux resizes to match.
- `GET /ws-term/<id>` — WebSocket. Resume with `?from=<seq>`.
  - down: `{type:'o', seq, b}` (base64 bytes), `{type:'reset'}`, `{type:'exit', code}`
  - up: `{type:'in', b}`, `{type:'size', cols, rows}`, `{type:'close'}`
- `POST /api/term/<id>/close` — end the session (the one route that is not the socket, so
  `sendBeacon` can use it on unload).

All three work under `/peer/<name>/…` as well, which is how a peer's terminal is reached.

## Limitations
- Unix only: the pty comes from `script(1)`, and resize shells out to `pgrep`, `ps` and
  `stty`. Linux and macOS are both handled; Windows is not.
- Every server in the mesh needs a ccbb new enough to have these routes. An older peer
  answers `/api/identity` normally and 404s `/api/term/open`, so its chip looks healthy
  but its terminal will not open.
- No reattach: a terminal is bound to the window that opened it, so a reload starts a
  fresh shell rather than picking the old one back up.
- Selecting Claude's pane is window-scoped in tmux, not client-scoped, so your own
  terminal follows the browser onto that pane. The window jump does not follow — that is
  what the grouped session buys.
- A window made for a session that was not running stays after the browser terminal
  closes. Nothing cleans it up but you; it is a window in *your* tmux, not a temporary.
- `kill -9` on ccbb types a **Ctrl-D into the pane the terminal was focused on**. It is
  `script(1)`: the stdin pipe it is reading closes with ccbb, and script answers EOF by
  writing the pty's EOF character into the master, which `tmux attach` relays as a
  keystroke. Observed with `remain-on-exit`: the pane exited with status 0, unsignalled,
  one second after the kill. `stty eof undef` does not help — tmux sets its own termios on
  attach. The fix is to give script a stdin that cannot reach EOF (a FIFO the pty command
  holds open read-write), which is a change to the spawn path and its platform probing, so
  it is not done here. A clean stop is unaffected: there ccbb SIGKILLs the pty first, so
  script never gets to forward anything.
