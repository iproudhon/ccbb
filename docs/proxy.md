# Browser forward proxy

CCBB can serve its web UI and an HTTP forward proxy on the same incoming port.
HTTPS sites use CONNECT tunnels: the browser verifies the site's certificate,
without a CCBB CA or TLS interception. The existing CCBB listener is HTTP, so use
an SSH tunnel or other protected transport to reach it remotely. Native TLS to
CCBB's proxy listener (`https://proxy-host`) is not implemented.

The proxy uses the existing persistent `/peer-link` network. Both ends must run
a version with proxy support. A connection opened in either direction works:
Node1 can use Node2 as an exit even when only Node2 can dial Node1, unless Node1
sets `proxy.allowInboundExit` to false (see below). Existing SSH forwards, peer names, tokens,
heartbeat and reconnection behavior are reused.

## Node1 entrance, Node2 exit

For `Node1 <-> Node2 <-> Node3`, point Firefox at Node1's CCBB port and set Node1's
`proxy.exitNode` to `Node2`. Node2 resolves destination names and opens destination
connections. Node3 is not involved. The exit must be a directly linked peer;
CCBB does not discover or forward proxy routes through peers-of-peers. To exit
through Node3, establish a Node1/Node3 peer link first.

Merge these settings into each node's existing `~/.claude/ccbb-config.json`
(or the config under `CLAUDE_CONFIG_DIR`); preserve existing peers and tokens.

Node1:

```json
{
  "server": { "name": "Node1" },
  "peerToken": "node1-peer-secret",
  "peers": [
    { "name": "Node2", "url": "http://127.0.0.1:8591", "token": "node2-peer-secret" }
  ],
  "proxy": {
    "enabled": true,
    "exitNode": "Node2",
    "username": "browser",
    "password": "separate-proxy-secret"
  }
}
```

The example peer URL assumes port 8591 already forwards to Node2's CCBB port.
Use the existing configured URL for Node2. If Node2 already links into Node1,
Node1 can drop the `peers` entry; the inbound link is used by default.
An inbound link is identified only by the name the caller asserts with Node1's
`peerToken`; any holder of that token could link in as "Node2", replace the real
link and receive all proxied traffic, including plaintext HTTP. An outbound
`peers` entry pins the exit to a configured URL and token, so prefer it and set
`"allowInboundExit": false` where inbound trust is unwanted.

Node2:

```json
{
  "server": { "name": "Node2" },
  "peerToken": "node2-peer-secret"
}
```

Keep Node2's existing Node1/Node3 peer settings. `allowExit` (default true) lets
authenticated full-access peers use this node's exit; it does not enable a local
browser proxy listener. Set `"proxy": { "allowExit": false }` on nodes that must
not egress for peers. Set `peerToken` on reachable CCBB servers so peer links authenticate.
As with CCBB's existing network, a full peer token grants trust in the peer;
read-only web tokens cannot establish links.

Run/restart the updated `ccbb web` on both nodes. No separate proxy process or
port is needed. After startup, config changes apply to new requests/connections;
existing tunnels keep their chosen exit. A missing, down, disabled or old exit
fails the request, with no fallback to local/direct egress. Old peers that lack
the protocol time out the open after 10 seconds. Normal link reconnection makes
new proxy connections possible again; interrupted connections are not replayed.

## Firefox and curl

In Firefox Settings → Network Settings → Settings, select Manual proxy
configuration. Set HTTP Proxy to `127.0.0.1`, Port to `8590` (or Node1's actual
CCBB port), and enable using that proxy for HTTPS too. Firefox prompts for the
proxy username/password. Enter a host and port, not a CCBB URL path.

```sh
# curl prompts for the proxy password rather than placing it in shell history.
curl --noproxy '' --proxy http://127.0.0.1:8590 --proxy-user browser https://example.com/
curl --noproxy '' --proxy http://127.0.0.1:8590 --proxy-user browser http://example.com/
```

The normal UI stays at `http://127.0.0.1:8590/` and uses its existing web token.
Proxy credentials do not authenticate the UI; UI cookies/tokens do not authenticate
the proxy. HTTP traffic, HTTPS CONNECT and HTTP WebSocket upgrades are supported.
Firefox bypass rules can send some requests directly, especially localhost; check
“No proxy for” when testing. Browser DNS prefetch, DNS-over-HTTPS, WebRTC and other
non-HTTP traffic are browser settings, not controlled by this proxy. Verify Firefox
behavior on your client before treating it as an all-traffic tunnel.

## Configuration details

All fields below live under `proxy`; proxy functionality is disabled by default.

| Field | Meaning/default |
| --- | --- |
| `enabled` | Accept browser proxy requests on this web port; default false. |
| `exitNode` | Required exact peer name. Use this server's own name for local egress, which also requires `allowExit`. |
| `username`, `password` | Separate Basic proxy credentials. Both must be nonempty when either is set. Without either, only loopback clients are accepted. |
| `allowExit` | Permit destination connections on this node for itself and directly linked full-access peers; default true. Does not relay onward to this node's `exitNode`. |
| `allowedPorts` | Exit-side destination port allowlist, e.g. `[80, 443]`. Unset by default: every port is allowed. |
| `allowPrivate` | Exit-side permission for localhost, private/LAN and other non-public addresses; default false. Enable only when those destinations are intended. |
| `allowInboundExit` | Entrance-side permission to use an exit whose link the exit opened towards this node; default true. See the trust note above. |
| `forwardCcbbAuthTo` | Entrance-side array of origins (for example `["http://127.0.0.1:8590"]`) that keep `x-ccbb-token` and `ccbb_token*` cookies. By default they are stripped from every proxied request, so browsing another CCBB UI through the proxy loses its login unless its origin is listed. |

Public destinations are DNS-resolved and checked on the exit, then connected by
the checked addresses: every resolved address must pass the policy, and the exit
tries them in resolver order until one connects, so an unreachable first IPv6 or
dead A record does not fail the request. Default checks exclude private, link-local,
mapped/transition IPv6 (including `::ffff:` forms of public IPv4) and reserved
ranges. Private access includes the exit host's local services. Each node has a
per-process budget of 128 concurrent proxy connections; on the exit a relay
channel and its destination socket share one slot, and in plain-HTTP mode each
request is one connection, so pages with many assets or several entrance peers
count against the same budget and receive 503 when it is exhausted. The exit
spends at most 10 seconds on DNS plus connecting, shared across the address
attempts; the entrance also waits at most 10 seconds for the exit to answer, and
an idle tunnel closes after two minutes (504 when it fails before opening). An
aborted tunnel resets the TCP peer rather than sending a clean end, so a
browser sees a connection error instead of a silently truncated body. A
WebSocket upgrade the origin refuses is relayed with the origin's status,
headers and body. Acknowledged 32 KiB chunks bound relay buffering and carry
binary traffic, with TCP half-close and link-disconnect cleanup. This initial
stop-and-wait transport favors bounded memory; throughput across high-latency
links is limited.

This release has no separate proxy listener, native TLS listener, third-party
upstream proxy, automatic multi-hop routing, or in-page browsing. The latter is
explicitly deferred.

Validation: `node --test test/verify-proxy.js` uses local HTTP/TCP/WebSocket/TLS
fixtures and actual isolated CCBB web processes. The TLS test requires `openssl`.
No live account or internet connection is needed. Manual Firefox verification
remains a follow-up.

## Review and verification history

Reviewed 2026-09-14 by Claude Code (`--model opus`, session
`ccbb: proxy review`, `76dc549b-c96c-42b9-870b-0525cac26083`), scope: the
uncommitted proxy implementation and its peer-link integration. Findings, all
fixed the same day:

1. HIGH — `splice()` destroyed the peer stream on every `'close'`, dropping
   unflushed writes after a graceful half-close (reproduced: 16 MiB upload lost
   69 KB, download lost 1.6 KB with a clean `'end'`). Now only aborts destroy,
   and aborts reset the TCP peer.
2. MEDIUM — the exit dialed only `addresses[0]`; AAAA-first hosts failed on
   IPv4-only exits. Now every checked address is tried under one deadline. A
   second open timer on the exit tunnel raced the dial and turned 504 into 502;
   removed.
3. LOW — a refused WebSocket upgrade was replaced by a synthetic 502; the origin
   response is now relayed.
4. LOW — exit budget counted a tunnel and its socket as two slots; now one.
5. LOW — CCBB auth stripping was destination-blind; `forwardCcbbAuthTo` added.
6. LOW — inbound links were trusted by self-asserted name; `allowInboundExit`
   added (default true, set false to opt out) and the trust model documented above.
7. LOW — DNS + connect could take 20 s against a 10 s tunnel timer; budgets now
   share one 10 s deadline. `::ffff:` public IPv4 is rejected by design.

Checked and found correct: hop-by-hop header stripping (including
`Connection`-listed tokens and TE re-framing), `Set-Cookie` arrays, CONNECT
`head` and upgrade `early` bytes, 32 KiB base64 bounds, ack-gated backpressure
on all four hops, half-close propagation, link-drop cleanup, frame-type
isolation from the session relay, id/status/host/port validation, exit-only
DNS with no fallback or multi-hop, `timingSafeEqual` proxy auth kept separate
from UI tokens, and fail-closed behavior on unreadable config.

The review's test-gap list (paced reader, local exit, aborts, timeouts, budget,
malformed frames, refused upgrade, IPv6 CONNECT, concurrent tunnels, chunked
and `Expect: 100-continue` bodies) is covered by `test/verify-proxy.js`.

Verified 2026-09-14 with Windows Chrome 152 (`--proxy-server`) against two live
`ccbb web` processes from WSL2: HTTPS page loads, plain HTTP with assets, a
20 MB and a 50 MB CONNECT download intact, `wss://` echo, 407 without and 200
with credentials, and the inbound-link 403 → 200 switch via live config edit.
Proxy throughput matched a direct download on the same uplink. Chrome's
HTTPS-First mode upgrades `http://` navigations itself; that is browser
behavior, not the proxy. A real Firefox run is still pending.

References: [Node CONNECT handling](https://nodejs.org/api/http.html#event-connect),
[Firefox connection settings](https://support.mozilla.org/en-US/kb/connection-settings-firefox).
