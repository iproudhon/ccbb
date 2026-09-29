# Serving ccbb on port 80 without root

## Overview
ccbb runs as you and keeps listening on its own port (8590 by default). The kernel
rewrites the destination port of anything arriving for **:80** to **:8590** before the
packet ever reaches a socket, so nothing in ccbb — and no privilege it holds — has to
change. Binding below 1024 is a capability the process never asks for.

This is the least invasive of the four ways to do it. It touches one table of firewall
rules and nothing else: no `setcap` on the node binary (which would hand port-80 binding
to *every* node script on the box and vanish on the next node upgrade), no
`net.ipv4.ip_unprivileged_port_start` (which lowers the floor for every user on the
machine), no socket-activation code path in `ccbb-web.js`.

## Prerequisite: listen on the interface, not just loopback
`ccbb web` defaults to `--host 127.0.0.1`. That is deliberate — an unlisted ccbb is a
private one — but a redirect from the outside cannot reach it. `REDIRECT` in `PREROUTING`
rewrites the destination to the **primary address of the incoming interface**, not to
127.0.0.1, so a loopback-only ccbb answers the redirect with a connection refused.

For access from other machines:

```bash
ccbb web --host 0.0.0.0
```

If you only ever want `http://localhost/` on this machine, leave the default host and
install just the `OUTPUT` rule below.

## The rules
The system uses the nf_tables backend (`iptables` here is the compatibility shim over
it). Either syntax works; pick one and stay in it.

### nftables

```bash
sudo nft add table ip ccbb
sudo nft 'add chain ip ccbb prerouting { type nat hook prerouting priority dstnat; policy accept; }'
sudo nft 'add chain ip ccbb output     { type nat hook output     priority dstnat; policy accept; }'
sudo nft add rule ip ccbb prerouting tcp dport 80 redirect to :8590
sudo nft add rule ip ccbb output ip daddr 127.0.0.1 tcp dport 80 redirect to :8590
```

### iptables

```bash
sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8590
sudo iptables -t nat -A OUTPUT -d 127.0.0.1 -p tcp --dport 80 -j REDIRECT --to-port 8590
```

**Why two rules.** `PREROUTING` sees packets that arrive on a wire; traffic a process on
this host sends to itself never passes through it. Without the `OUTPUT` rule,
`curl http://localhost/` from the ccbb host itself fails while every other machine works
— a confusing half-broken state. The `OUTPUT` rule is what makes the local case behave.

If you also want `http://<this-host's-lan-ip>/` to work *from this host*, widen the
second rule by dropping the `-d 127.0.0.1` / `ip daddr 127.0.0.1` match. Left as written
it only catches loopback, which is the common case and the narrower blast radius.

## Verifying

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1/       # from this host
curl -sS -o /dev/null -w '%{http_code}\n' http://<host>/          # from another machine
sudo nft list table ip ccbb        # or: sudo iptables -t nat -L PREROUTING -n -v
```

A `401` is a pass, not a failure: it means ccbb answered and `peerToken` is doing its job.
Add `?token=<peerToken>` once in a browser to bank the cookie.

## Making it survive a reboot
Firewall rules live in memory. On this host that is done with a systemd oneshot that adds
**only** the `ccbb` table — `/etc/systemd/system/ccbb-nft.service` running
`/etc/nftables-ccbb.conf`:

```
table ip ccbb        # declare-then-delete: makes re-running idempotent
delete table ip ccbb

table ip ccbb {
	chain prerouting {
		type nat hook prerouting priority dstnat; policy accept;
		tcp dport 80 redirect to :8590
	}
	chain output {
		type nat hook output priority dstnat; policy accept;
		ip daddr 127.0.0.1 tcp dport 80 redirect to :8590
	}
}
```

```bash
sudo systemctl enable --now ccbb-nft.service
```

**Why not `nftables.service`.** The stock `/etc/nftables.conf` opens with `flush ruleset`.
Docker manages `table ip nat` through iptables-nft on this box, and a flush at boot would
take its rules with it. A private table in a private unit cannot do that: no flush, and
`ExecStop` deletes exactly one table.

The two lines above the table body are the idempotence trick — declaring a table that may
already exist is a no-op, and the `delete` that follows then always has something to
remove. Without them a re-run appends a second copy of each rule (harmless, since the
first match wins, but they pile up).

`iptables-persistent` is the equivalent for the iptables syntax, but it saves the *whole*
nat table — Docker's rules included — which is exactly the entanglement this avoids.

## Removing it

```bash
sudo systemctl disable --now ccbb-nft.service    # stops it and deletes the table
sudo rm /etc/systemd/system/ccbb-nft.service /etc/nftables-ccbb.conf
sudo systemctl daemon-reload

# runtime-only teardown, if the unit was never installed:
sudo nft delete table ip ccbb
# iptables equivalent:
sudo iptables -t nat -D PREROUTING -p tcp --dport 80 -j REDIRECT --to-port 8590
sudo iptables -t nat -D OUTPUT -d 127.0.0.1 -p tcp --dport 80 -j REDIRECT --to-port 8590
```

Putting the rules in their own `ccbb` nft table is what makes the one-line delete safe —
it cannot take another service's NAT rules with it.

## Notes
- **The auth cookie is unaffected.** `tokenCookieName()` names the cookie after the port
  in the request's `Host` header, falling back to the listening port when there is none.
  A browser at `http://host/` sends a `Host` with no `:port`, so it falls back to 8590 —
  the same name it would use at `http://host:8590/`. Both doors are the same server, so
  sharing one cookie is the wanted behaviour: log in through either, be logged in on both.
- **Peer hops are unaffected.** The loopback proxy in `ccbb-web.js` dials
  `127.0.0.1:serverPort` directly and never goes near :80.
- **A peer's `url` in `ccbb-config.json`** can now be written without a port
  (`http://box/` rather than `http://box:8590/`). Nothing requires it; the port form
  keeps working and bypasses the redirect entirely.
- **Both ports stay open.** The redirect adds a door, it does not close one — :8590 is
  still reachable. Drop it with a filter rule if that matters.
- **IPv6 needs its own rules.** The table above is `ip` (v4 only). If clients reach this
  host over v6, repeat with an `ip6` table / `ip6tables`.
