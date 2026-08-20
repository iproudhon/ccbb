'use strict';
// ── ccbb mobile web UI ────────────────────────────────────────────────────────
// A second front-end for the same server, built for a phone held in one hand. It is not
// a responsive skin over the desktop app: the desktop app is a tiling window manager
// (split views, floating terminals, drag-resize) and none of that survives a 390px
// screen. This one is a single vertical stack — the session list on top, one panel per
// open session under it, an accordion so exactly one panel is open at a time — plus a
// terminal that is always full screen.
//
// It adds no API. Everything here rides the routes the desktop UI already uses, which is
// also why a peer's session works: prefix every path with /peer/<name> and the same code
// drives a session on another machine.
//
// Page assembly mirrors ccbb-web.js: one HTML template with the client script spliced in,
// and three values substituted (price table, this server's identity, the deep link to
// open on load).

const fs = require('fs');
const path = require('path');
const https = require('https');
const { CLAUDE_DIR } = require('./ccbb-common');

// ── vendored front-end libraries, fetched by the SERVER ───────────────────────
// The desktop UI pulls marked and xterm straight from a CDN, which is fine on a laptop
// that browses the web. A phone reaching ccbb over a tunnel or a VPN often cannot: on a
// network that intercepts TLS the CDN fails certificate validation on iOS (the corporate
// root is in the Mac's trust store, not the phone's), and the page silently loses
// markdown and the terminal.
//
// So the phone asks ccbb for them instead. The server fetches once — it is the machine
// that already trusts whatever is in front of it, and it honours HTTPS_PROXY — caches
// the file, and serves it from there on. If the fetch fails the route 502s and the page
// falls back to the CDN, which is the right order: the CDN works for anyone whose phone
// can reach it.
// The cached FILE carries the version, the URL does not: the page can go on asking for
// /vendor/xterm.js while a version bump here becomes a different file on disk. Sharing
// one name across versions would serve the old library forever.
const VENDOR = {
  'marked.js': { url: 'https://cdn.jsdelivr.net/npm/marked@12/marked.min.js',
                 file: 'marked-12.js', type: 'application/javascript; charset=utf-8' },
  'xterm.js':  { url: 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js',
                 file: 'xterm-5.5.0.js', type: 'application/javascript; charset=utf-8' },
  'xterm.css': { url: 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css',
                 file: 'xterm-5.5.0.css', type: 'text/css; charset=utf-8' },
};
const vendorInflight = new Map();   // name → Promise<Buffer>

// A host with no outbound route does not refuse the connection, it swallows it,
// so the only signal is the clock. Once it has timed out, stop trying for a
// while: the page has a CDN fallback for every one of these, and reaching it a
// second sooner matters more than another attempt that will fail the same way.
const VENDOR_TIMEOUT_MS = 4000;
const VENDOR_RETRY_MS = 10 * 60 * 1000;
const vendorFailedAt = new Map();   // name → Date.now() of last failure

function vendorPath(name) { return path.join(CLAUDE_DIR, 'ccbb-vendor', VENDOR[name].file); }

function vendorFetch(name) {
  const spec = VENDOR[name];
  if (vendorInflight.has(name)) return vendorInflight.get(name);
  const p = new Promise((resolve, reject) => {
    const target = new URL(spec.url);
    const opts = { hostname: target.hostname, port: 443, path: target.pathname, method: 'GET',
      headers: { 'User-Agent': 'ccbb', 'Accept-Encoding': 'identity' } };
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (proxy) {
      try { const { HttpsProxyAgent } = require('https-proxy-agent'); opts.agent = new HttpsProxyAgent(proxy); }
      catch { /* optional dep missing → go direct */ }
    }
    const req = https.request(opts, res => {
      // jsdelivr answers a versioned path directly, but a redirect costs nothing to follow.
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const loc = new URL(res.headers.location, spec.url);
        return https.get(loc, r2 => {
          const cs = [];
          r2.on('data', c => cs.push(c));
          r2.on('end', () => r2.statusCode === 200 ? resolve(Buffer.concat(cs)) : reject(new Error('HTTP ' + r2.statusCode)));
        }).on('error', reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    // Short, because nothing waits politely on this: /vendor/<x> is a blocking
    // <script> in the head, so every second here is a second the page is blank.
    req.setTimeout(VENDOR_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.end();
  }).then(buf => {
    if (!buf.length) throw new Error('empty body');
    const file = vendorPath(name);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + '.' + process.pid;
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);      // atomically, so a reader never sees half a library
    } catch { /* cache is best-effort; the bytes still go out */ }
    return buf;
  }).finally(() => vendorInflight.delete(name));
  vendorInflight.set(name, p);
  return p;
}

// GET /vendor/<name>. Returns false if the path is not ours, so the caller keeps routing.
function serveVendor(pathname, res) {
  const m = pathname.match(/^\/vendor\/([A-Za-z0-9._-]+)$/);
  if (!m || !VENDOR[m[1]]) return false;
  const name = m[1], spec = VENDOR[name];
  const sendBuf = buf => {
    res.writeHead(200, { 'Content-Type': spec.type, 'Content-Length': buf.length,
      'Cache-Control': 'public, max-age=604800' });
    res.end(buf);
  };
  const fail = msg => {
    const body = Buffer.from('/* ccbb: could not fetch ' + name + ': ' + msg + ' */');
    res.writeHead(502, { 'Content-Type': spec.type, 'Content-Length': body.length });
    res.end(body);
  };

  let cached;
  try { cached = fs.readFileSync(vendorPath(name)); } catch {}
  if (cached && cached.length) return sendBuf(cached), true;

  const failedAt = vendorFailedAt.get(name);
  if (failedAt && Date.now() - failedAt < VENDOR_RETRY_MS) {
    fail('no route to the CDN, and no cached copy');   // answer now, let the page fall back
    return true;
  }

  vendorFetch(name).then(sendBuf).catch(e => {
    vendorFailedAt.set(name, Date.now());
    fail(e.message);
  });
  return true;
}

// A phone, not a tablet: an iPad runs the desktop UI fine and asks for a desktop UA
// anyway. iPadOS reports itself as Macintosh, so "Mobile" in the UA is the tell — it is
// present on iPhone Safari and Android phone Chrome, absent on both desktops and iPad.
function isMobileUA(ua) {
  ua = String(ua || '');
  if (/iPad|Tablet/i.test(ua)) return false;
  return /iPhone|iPod/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua)) ||
         /Mobile Safari|Windows Phone|BlackBerry|Opera Mini/i.test(ua);
}

const MOBILE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<!-- black-translucent is the whole of the "use the full screen" story: with default or
     black, iOS reserves the status bar, the page starts below it, and safe-area-inset-top
     is 0 even in standalone — which is why the --safe-t padding below did nothing. Only
     this value puts the page under the clock and makes that inset real. Apple has it
     marked deprecated with nothing to replace it (display:fullscreen and theme_color in
     the manifest are both ignored on iOS), so it stays until it stops working. Note the
     value is read when the icon is added: changing it needs the Home Screen app deleted
     and re-added, not just a reload. Known cost: the clock and battery are drawn white
     regardless of theme, so in light mode they sit on the cream header. -->
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#f0eee6" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1c1b19" media="(prefers-color-scheme: dark)">
<title>ccbb</title>
<link rel="shortcut icon" href="data:image/svg+xml,%3Csvg viewBox='0 0 64 64' xmlns='http://www.w3.org/2000/svg'%3E%3Crect x='16' y='12' width='32' height='28' rx='4' fill='%23FF6B35'/%3E%3Ccircle cx='24' cy='20' r='4' fill='%23fff'/%3E%3Ccircle cx='40' cy='20' r='4' fill='%23fff'/%3E%3Crect x='20' y='28' width='24' height='2' fill='%23fff' rx='1'/%3E%3Crect x='18' y='42' width='28' height='16' rx='2' fill='%23FF6B35'/%3E%3Crect x='8' y='46' width='10' height='8' rx='2' fill='%23FF6B35'/%3E%3Crect x='46' y='46' width='10' height='8' rx='2' fill='%23FF6B35'/%3E%3C/svg%3E" />
<!-- The SVG is what a tab draws. Chrome's app installer wants a raster and a
     manifest, and gets both here — see iconPngFor()/webManifest() in ccbb-web.js. -->
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="icon" type="image/png" sizes="32x32" href="/icon-32.png">
<link rel="apple-touch-icon" sizes="180x180" href="/icon-180.png">
<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials">
<!-- Through ccbb first (a phone on a tunnel often cannot reach a CDN), the CDN second. -->
<script src="/vendor/marked.js" onerror="var s=document.createElement('script');s.src='https://cdn.jsdelivr.net/npm/marked@12/marked.min.js';document.head.appendChild(s)"></script>
<style>
:root{
  --bg:#fff; --bg-alt:#f0eee6; --surface:#fff; --ink:#3d3d3a; --ink-soft:#6e6d66;
  --ink-faint:#9b998f; --line:#e6e3da; --accent:#c96442; --accent-soft:#f5e9e3;
  --code-bg:#f5f3ec; --warn:#bf5b12; --ok:#2da44e; --err:#cf222e;
  --head-h:44px;
  /* Every safe-area inset in this file goes through these two rather than calling env()
     at each site, so that the whole set can be reasoned about — and overridden — in one
     place. Note they are 0 in an ordinary Safari tab, where the page never reaches the
     unsafe areas in the first place; they only become real in standalone (Home Screen),
     which is how this front-end is meant to be run. */
  --safe-t:env(safe-area-inset-top); --safe-b:env(safe-area-inset-bottom);
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#1c1b19; --bg-alt:#262523; --surface:#232220; --ink:#e6e3db; --ink-soft:#a8a49a;
    --ink-faint:#7d7a72; --line:#37352f; --accent:#e08b6b; --accent-soft:#3a2b24;
    --code-bg:#232220; --warn:#e8944a; --ok:#3fb950; --err:#f85149;
  }
}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{overscroll-behavior:none}
body{
  font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
  /* This colour does more work than it looks like. iOS Safari tints its own chrome — the
     status-bar band above the page and the strip under it that holds the floating tab
     bar — with the page's canvas background, and those two bands are most of the screen
     the app does not otherwise get. Keeping them the same colour as the panel headers
     (and as .composer, below) is what makes the app read as running edge to edge instead
     of as a page with a stripe above and below it. In standalone mode, where there is no
     Safari chrome, this same colour fills the safe-area padding, to the same effect. */
  font-size:15px;background:var(--bg-alt);color:var(--ink);
  /* --app-h tracks visualViewport: on iOS the URL bar and the keyboard both change the
     usable height without changing 100dvh, and a stack sized to the wrong number puts
     the composer under the keyboard. Falls back to dvh before the first measurement. */
  height:var(--app-h,100dvh);
  display:flex;flex-direction:column;overflow:hidden;
  padding-top:var(--safe-t);padding-bottom:var(--safe-b);
  -webkit-font-smoothing:antialiased;
}
#stack{flex:1;min-height:0;display:flex;flex-direction:column;background:var(--bg)}
/* ── panels ──
   Vertical only, and an accordion: exactly one panel is expanded, every other is a
   header-height strip you tap to bring forward. On a phone a "split" is two useless
   halves, so the choice is which one panel you are looking at. */
.panel{display:flex;flex-direction:column;min-height:0;border-bottom:1px solid var(--line);background:var(--bg)}
.panel.min{flex:0 0 auto}
.panel.exp,.panel.max{flex:1 1 auto}
.panel.min .pbody{display:none}
body.has-max .panel:not(.max){display:none}
.phead{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;
  min-height:var(--head-h);background:var(--bg-alt);border-bottom:1px solid var(--line)}
.panel.min .phead{border-bottom:none}
.pbody{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden}
.ptitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-weight:600;font-size:14px}
.pbtns{margin-left:auto;display:flex;align-items:center;gap:2px;flex-shrink:0}
/* 40px targets: a 24px icon button is a coin toss with a thumb. */
.pbtn{background:none;border:none;color:var(--ink-soft);font-size:15px;line-height:1;
  min-width:40px;height:40px;border-radius:10px;font-family:inherit;display:flex;
  align-items:center;justify-content:center;cursor:pointer}
.pbtn:active{background:var(--line);color:var(--ink)}
.pbtn[data-k="term"]{font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:13px}
.pbtn.on{color:var(--accent)}
.dot{flex-shrink:0;width:9px;height:9px;border-radius:50%;background:var(--ink-faint)}
.dot.live{background:var(--ok);animation:pulse 2s infinite}
.dot.idle{background:#d4a72c}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}
.ago{font-size:11.5px;color:var(--ink-faint);flex-shrink:0}
/* ── session list ── */
/* Scope and servers share one row. The scope select is pinned and the chips scroll past
   it, so the month you are looking at stays on screen however many servers there are. */
.topbar{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:8px 12px;
  border-bottom:1px solid var(--line);background:var(--bg)}
.srvbar{flex:1 1 auto;min-width:0;display:flex;gap:6px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.srvbar::-webkit-scrollbar{display:none}
/* Cost scope: all time, or one month — the same choice the desktop summary offers. */
.scope{flex:0 0 auto;max-width:45%;font:inherit;font-size:12px;color:var(--ink);
  background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:5px 8px}
.chip{flex-shrink:0;display:flex;align-items:center;gap:6px;border:1px solid var(--line);
  border-radius:999px;padding:6px 12px;font-size:12.5px;color:var(--ink-soft);background:var(--bg-alt)}
.chip.on{border-color:var(--accent);color:var(--ink);background:var(--accent-soft)}
.chip.down{opacity:.5}
.chip .cterm{margin:-4px -6px -4px 2px;padding:4px 6px;font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:11px;border-radius:6px}
.rows{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch}
.srow{display:flex;flex-direction:column;gap:3px;padding:10px 12px;border-bottom:1px solid var(--line);min-height:56px;justify-content:center}
.srow:active{background:var(--bg-alt)}
.srow .r1{display:flex;align-items:center;gap:7px;min-width:0}
.srow .stitle{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14.5px}
.srow .stime{flex-shrink:0;font-size:11.5px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.srv{flex-shrink:0;font-size:10.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;
  color:var(--ink-soft);background:var(--bg-alt);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
.srv.local{color:var(--accent);border-color:var(--accent-soft);background:var(--accent-soft)}
/* direction:rtl puts the ellipsis at the START, so a long path keeps the end — the
   project directory, the part that identifies it — instead of a screen of /Users/…. The
   text itself is wrapped in a left-to-right embedding by ltr() below, without which the
   leading "/" reorders to the far end and the path reads as a lie. */
.sdir{font-size:11.5px;color:var(--ink-faint);font-family:ui-monospace,Menlo,monospace;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.lmsg{padding:20px 14px;color:var(--ink-faint);font-size:13.5px;text-align:center}
.lerr{padding:8px 12px;color:var(--err);font-size:12.5px;border-bottom:1px solid var(--line)}
.foot{flex:0 0 auto;padding:8px 12px;border-top:1px solid var(--line);font-size:11px;
  color:var(--ink-faint);display:flex;gap:8px;align-items:center;background:var(--bg-alt)}
/* Session count, spend and the plan windows on one line that has to fit 393px without
   scrolling. Everything is fixed-width except the account name, so overflow eats the
   name first — it is the one part the pills next to it can imply. */
.foot .tot{flex:1 1 auto;min-width:0;display:flex;align-items:center;gap:6px;
  overflow:hidden;white-space:nowrap;font-variant-numeric:tabular-nums}
.foot .fsep{color:var(--ink-faint);opacity:.6}
.foot .fcnt,.foot .fsub{flex:0 0 auto}
.foot .fsub{color:var(--ink-soft)}
.foot .fgrp{flex:0 1 auto;min-width:0;display:flex;align-items:center;gap:5px}
.foot .fname{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;
  font-weight:600;color:var(--ink)}
/* One window is a single pill: the bar is the pill's own fill and the text sits on top of
   it, so a window costs one object's width instead of three. The fill is translucent so
   the label stays legible over it; amber past 70%, red past 90%, as on the desktop. */
.foot .fwin{position:relative;flex:0 0 auto;display:inline-flex;align-items:baseline;
  gap:4px;padding:2px 6px;border-radius:5px;background:var(--line);overflow:hidden}
.foot .fwin i{position:absolute;left:0;top:0;bottom:0;background:var(--ok);opacity:.42}
.foot .fwin.warm i{background:var(--warn)}
.foot .fwin.hot i{background:var(--err)}
.foot .fwin b{position:relative;font-weight:600;color:var(--ink)}
/* Smaller so the window's name reads first and the numbers stay detail. */
.foot .fwin em{position:relative;font-style:normal;font-size:9px;color:var(--ink-soft)}
/* ── session panel ── */
.subhead{flex:0 0 auto;padding:6px 12px 7px;background:var(--bg-alt);border-bottom:1px solid var(--line);
  font-size:11.5px;color:var(--ink-soft);display:flex;flex-direction:column;gap:3px}
.subhead .sdir{color:var(--ink-soft)}
.subhead .swhen{color:var(--ink-faint)}
/* The status line, in the shape statusline-instructions.md defines: dim monospace, and
   the cache-write half of the resend cost in orange once the prompt cache has gone cold.
   That flip is wall-clock, so it is re-rendered on a timer, not on data arriving. */
.sline{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--ink-faint);
  white-space:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch}
.sline::-webkit-scrollbar{display:none}
.sl-cold{color:var(--warn)}
.transcript{flex:1 1 auto;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;
  padding:10px 12px 4px;overflow-anchor:none}
.msg{margin-bottom:14px}
.msg-label{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;
  color:var(--ink-faint);margin-bottom:4px}
.msg-time{font-weight:500;text-transform:none;letter-spacing:0;color:var(--ink-faint);opacity:.8}
.msg-body{font-size:14.5px;line-height:1.55;word-wrap:break-word;overflow-wrap:anywhere}
.msg-body p{margin:0 0 8px}.msg-body p:last-child{margin-bottom:0}
.msg-body ul,.msg-body ol{margin:0 0 8px 20px}
.msg-body h1,.msg-body h2,.msg-body h3{font-size:15px;margin:10px 0 6px}
.msg-body pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;
  padding:8px 10px;overflow-x:auto;font-size:12px;margin:0 0 8px}
.msg-body code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;background:var(--code-bg);
  border-radius:4px;padding:1px 4px}
.msg-body pre code{background:none;padding:0}
.msg-body table{display:block;overflow-x:auto;border-collapse:collapse;font-size:12.5px;margin-bottom:8px}
.msg-body td,.msg-body th{border:1px solid var(--line);padding:4px 8px}
.msg.you{background:var(--accent-soft);border-radius:12px;padding:8px 12px}
.msg.you .msg-body{white-space:pre-wrap}
/* ── tool / thinking cards ──
   Collapsed by default here (the desktop opens them): on a phone an open Bash card is
   the whole screen, and what you want from the transcript is the shape of what Claude
   did, with the detail one tap away. */
.tool-card,.think-card{border:1px solid var(--line);border-radius:10px;margin-bottom:10px;
  background:var(--surface);overflow:hidden}
.tool-hdr{display:flex;align-items:center;gap:8px;padding:9px 11px;min-height:40px;font-size:12.5px}
.tool-hdr:active{background:var(--bg-alt)}
.tool-name{font-family:ui-monospace,Menlo,monospace;font-weight:700;color:var(--accent);flex-shrink:0}
.tool-brief{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--ink-faint);font-family:ui-monospace,Menlo,monospace;font-size:11.5px}
.tool-meta{flex-shrink:0;display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--ink-faint)}
.tool-status{border-radius:4px;padding:1px 5px;font-weight:600}
.tool-status.running{background:#fff3cd;color:#8a6d1a}
.tool-status.done{background:#e8f5e9;color:#1a7f37}
.tool-status.error{background:#ffebe9;color:var(--err)}
@media (prefers-color-scheme: dark){
  .tool-status.running{background:#3a3320;color:#e8c46a}
  .tool-status.done{background:#1e3324;color:#5fca77}
  .tool-status.error{background:#3a2020;color:#ff7b72}
}
.tool-toggle{flex-shrink:0;color:var(--ink-faint);font-size:10px;width:14px;text-align:center}
.tool-body{display:none;border-top:1px solid var(--line)}
.tool-body.open{display:block}
.tool-input,.tool-output{padding:8px 11px}
.tool-input pre,.tool-output pre{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;
  line-height:1.45;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;
  background:var(--code-bg);border-radius:6px;padding:7px 9px}
.tool-output:empty{display:none}
.think-label{flex:1;color:var(--ink-soft);font-size:12.5px;font-style:italic}
.think-body{padding:8px 11px;font-size:12.5px;line-height:1.5;color:var(--ink-soft);
  white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto}
.subagent-block{border-top:1px solid var(--line);background:var(--bg-alt)}
.subagent-hdr{padding:8px 11px;font-size:12px;color:var(--ink-soft);display:flex;gap:6px;align-items:center}
.subagent-body{padding:4px 8px 8px}
.subagent-loading{padding:8px;color:var(--ink-faint);font-size:12px}
.sub-msg{margin:6px 0;font-size:12.5px;line-height:1.5}
.sub-msg .msg-label{font-size:9.5px}
.compact-marker{margin:12px 0;text-align:center}
.compact-label{font-size:11px;color:var(--ink-faint);background:var(--bg-alt);border:1px solid var(--line);
  border-radius:999px;padding:3px 10px}
.compact-details{margin-top:6px;text-align:left}
.compact-details summary{font-size:11.5px;color:var(--ink-faint)}
.compact-summary{font-size:12px;white-space:pre-wrap;color:var(--ink-soft);margin-top:6px;
  max-height:240px;overflow:auto;background:var(--code-bg);border-radius:8px;padding:8px}
/* ── permission / ask sheets ──
   Sticky to the bottom of the transcript rather than inline: the whole point of ccbb on
   a phone is answering these, and one that scrolled off with the conversation would be
   missed. Sticky (not fixed) keeps it inside the panel, above the composer. */
.perm-card{position:sticky;bottom:0;z-index:5;border:1px solid var(--accent);border-radius:12px;
  background:var(--surface);margin:8px 0 10px;overflow:hidden;box-shadow:0 -6px 20px rgba(0,0,0,.16)}
.perm-card.settled{position:static;box-shadow:none;border-color:var(--line);opacity:.75}
.perm-hdr{padding:9px 12px;background:var(--accent-soft);font-size:12.5px;font-weight:700;color:var(--accent)}
.perm-body{padding:10px 12px;font-size:13.5px;line-height:1.45;word-break:break-word;
  max-height:34vh;overflow:auto}
.perm-acts{display:flex;flex-direction:column;gap:6px;padding:0 12px 10px}
.perm-opt{width:100%;text-align:left;background:var(--bg-alt);border:1px solid var(--line);
  border-radius:10px;padding:11px 12px;font-size:13.5px;font-family:inherit;color:var(--ink);min-height:44px}
.perm-opt:active{background:var(--accent-soft)}
.perm-opt.first{border-color:var(--accent);color:var(--accent);font-weight:600}
.perm-opt.sel{border-color:var(--accent);background:var(--accent-soft);font-weight:600}
.perm-opt:disabled{opacity:.5}
.perm-note{padding:0 12px 10px;font-size:11px;color:var(--ink-faint)}
/* Read-only: the controls go, the content stays. A permission card's options are the
   question being asked, so they stay legible and stop being tappable. */
.ro .composer,.ro .cterm,.ro .pbtn[data-k="term"]{display:none}
.ro .perm-opt{pointer-events:none;opacity:.65}
.ro .ask-text,.ro .ask-submit{display:none}
.ask-opt-desc{display:block;font-size:11px;color:var(--ink-faint);margin-top:2px;white-space:normal}
.ask-multi{color:var(--ink-faint);font-weight:400}
.ask-text{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 12px;
  font-size:16px;font-family:inherit;background:var(--surface);color:var(--ink)}
.ask-submit{background:var(--accent);border:none;color:#fff;border-radius:10px;padding:12px;
  font-size:14px;font-weight:600;font-family:inherit;width:100%;min-height:44px}
.ask-submit:disabled{opacity:.45}
/* ── command output ── */
/* Output takes the whole body, not a share of it: a phone has no room for two scrollers,
   and the answer to a // command is the thing you just asked for. The transcript is not
   resized to nothing but hidden outright — a 0px flex child still renders its jump
   button, and .transcript would keep a scroll position measured against no height. */
.cmd-box{display:none;min-height:0;flex-direction:column;
  border-top:1px solid var(--line);background:var(--bg)}
.cmd-box.show{display:flex;flex:1 1 auto;min-height:0}
.pbody.cmdon .trwrap{display:none}
.cmd-head{flex:0 0 auto;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;min-height:40px;
  background:var(--bg-alt);border-bottom:1px solid var(--line);font-size:12px}
.cmd-title{flex:1;font-family:ui-monospace,Menlo,monospace;font-weight:600;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.cmd-content{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px;font-size:13px;line-height:1.55}
.cmd-content pre{background:var(--code-bg);border:1px solid var(--line);border-radius:8px;padding:9px 10px;
  font-size:11.5px;font-family:ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word;overflow:auto}
.cmd-content.code pre{white-space:pre;word-break:normal}
/* Maximized: out over the panel header and the composer both, on the same --app-h and
   the same z-index as the full-screen editor. Only one of the two may be open at a time
   — see compMaxOwner — so they never stack. The safe-area padding goes on .cmd-head
   rather than on the fixed box, so the strip behind the status bar is the header's
   colour instead of the content's white. */
body.cmd-max .pbody.cmdmax .cmd-box{position:fixed;top:0;left:0;right:0;height:var(--app-h,100dvh);
  z-index:150;border-top:none}
body.cmd-max .pbody.cmdmax .cmd-head{padding-top:var(--safe-t);min-height:calc(40px + var(--safe-t))}
body.cmd-max .pbody.cmdmax .cmd-content{padding-bottom:calc(10px + var(--safe-b))}
/* ── composer ── */
/* --bg-alt, the header colour, not --bg: this is the bottom edge of the app, and Safari
   tints the strip under it with the page's canvas colour (see body). Matching the two
   means the composer runs into Safari's chrome instead of stopping at a seam. The white
   is still there — it is the input card (.cwrap) sitting on this ground. */
.composer{position:relative;flex:0 0 auto;display:flex;flex-direction:column;
  border-top:1px solid var(--line);background:var(--bg-alt);padding:8px 10px}
/* History and maximize sit ABOVE the box and only while it has focus: at rest the
   composer is one line and a send button, which is all a phone should spend on it.
   Floating (absolute, out of flow) rather than a row of its own: appearing and vanishing
   with the focus, an in-flow row would shove the whole transcript up and back down on
   every tap into the box — and on a phone the keyboard is already doing that once.
   Two selectors for the open state, and both are needed. :focus-within is the honest one.
   .cfocus is for iOS, which does not focus a button on tap — it just blurs whatever had
   the focus, so :focus-within alone would fold this row away on pointerdown and the tap
   would land on the transcript behind it. See the pressedOwn flag. */
.cbtns{position:absolute;right:10px;bottom:100%;margin-bottom:8px;z-index:8;
  display:flex;align-items:center;gap:6px;pointer-events:none;
  opacity:0;transform:translateY(4px);transition:opacity .12s ease,transform .12s ease}
.composer:focus-within .cbtns,.composer.cfocus .cbtns,.pbody.cmax .cbtns{opacity:1;transform:none}
/* Only the buttons take taps, never the gaps between them: this thing hovers over the
   transcript — and over the bottom of a sticky permission card — so its dead space must
   not swallow a tap meant for what is underneath. */
.cbtns>*{pointer-events:none}
.composer:focus-within .cbtns>*,.composer.cfocus .cbtns>*,.pbody.cmax .cbtns>*{pointer-events:auto}
.cwrap{position:relative;background:var(--surface);border:1px solid var(--line);
  border-radius:14px;padding:7px 6px 7px 12px}
.cwrap:focus-within{border-color:var(--accent)}
/* A contenteditable, not a textarea, for one reason: the send button sits in a notch cut
   out of the LAST line of the text — the floated ::after below — so every line above it
   runs the full width of the box, and 40 phone columns are too few to give any of them
   away. Nothing flows around a float inside a textarea. See asTextarea().
   16px exactly: anything smaller and iOS Safari zooms the page on focus, which leaves the
   layout scaled and the composer half off-screen after the keyboard closes. */
.cbox{font-size:16px;line-height:1.5;font-family:ui-monospace,Menlo,Consolas,monospace;
  min-height:32px;max-height:38vh;overflow-y:auto;color:var(--ink);outline:none;
  white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word}
/* The notch. overflow-y:auto above is load-bearing twice over: it scrolls a long prompt
   AND makes this box a block formatting context, without which the float would escape
   the box instead of stretching it to fit. */
.cbox::after{content:'';display:block;float:right;width:42px;height:32px}
.cbox.empty::before{content:attr(data-ph);color:var(--ink-faint)}
/* Opaque, and shadowed: floating over the transcript, a transparent button would have
   somebody else's words showing through it. */
.cbtn{background:var(--surface);border:1px solid var(--line);color:var(--ink-soft);width:36px;height:36px;
  border-radius:10px;font-size:12px;font-family:inherit;display:flex;align-items:center;justify-content:center;
  box-shadow:0 1px 5px rgba(0,0,0,.14)}
.cbtn:disabled{opacity:.35}
.cbtn.on{border-color:var(--accent);color:var(--accent);background:var(--accent-soft)}
.send{position:absolute;right:6px;bottom:6px;background:var(--accent);border:none;color:#fff;
  width:32px;height:32px;border-radius:11px;font-size:16px;padding:0;
  display:flex;align-items:center;justify-content:center}
.send:disabled{opacity:.4}
/* Maximized: the composer leaves its panel and takes the whole screen. A phone panel is a
   third of the display, which is not enough to write a prompt in — and the panel is the
   only thing worth looking at while you write anyway.
   Sized from --app-h and never inset:0: the visual viewport shrinks under the keyboard
   while 100vh does not, so a bottom-anchored send button would sit behind the keys. Its
   own safe-area padding, because a fixed box is not inside body's.
   UNVERIFIED against a real on-screen keyboard — the simulator will not raise one
   without a physical tap. If the box turns out to be mispositioned with the keyboard up,
   the thing to look at is visualViewport.offsetTop: iOS anchors position:fixed to the
   LAYOUT viewport, and the keyboard can slide the visual viewport down inside it. */
body.comp-max .pbody.cmax .composer{position:fixed;top:0;left:0;right:0;height:var(--app-h,100dvh);
  z-index:150;border-top:none;
  padding-top:calc(8px + var(--safe-t));
  padding-bottom:calc(8px + var(--safe-b))}
/* Full screen there is no transcript left to float over, and bottom:100% of a composer
   pinned to top:0 would put the row off the top of the screen — so it goes back into the
   flow, above the editor, where the restore button is the way back out. */
body.comp-max .pbody.cmax .cbtns{position:static;margin:0 0 8px;justify-content:flex-end}
body.comp-max .pbody.cmax .cwrap{flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
/* No notch here — the text starts at the top of a full-screen box while the button stays
   in the corner, so a last-line cutout would be nowhere near it. A reserved strip at the
   bottom does the same job. */
body.comp-max .pbody.cmax .cbox{flex:1 1 auto;min-height:0;max-height:none;padding-bottom:38px}
body.comp-max .pbody.cmax .cbox::after{display:none}
.jump{position:absolute;left:50%;transform:translateX(-50%);bottom:8px;display:none;
  background:var(--accent);color:#fff;border:none;border-radius:999px;padding:7px 14px;font-size:12px;
  font-family:inherit;z-index:6;box-shadow:0 2px 10px rgba(0,0,0,.25)}
.jump.show{display:block}
.trwrap{position:relative;flex:1 1 auto;min-height:0;display:flex;flex-direction:column}
/* The unloaded middle of a windowed transcript — fills itself in when scrolled into view. */
.hgap{display:flex;align-items:center;justify-content:center;gap:10px;margin:8px 0;padding:5px 2px;
  font-size:11px;color:var(--ink-faint);border-top:1px dashed var(--line);border-bottom:1px dashed var(--line)}
.hgap button{font:inherit;font-size:11px;color:var(--accent);background:none;border:none;padding:2px 4px}
.hgap.loading{opacity:.5;pointer-events:none}
/* ── terminal ──
   Always full screen, and always 80 columns: Claude Code's own output is laid out for a
   fixed width, so the phone adapts by shrinking the type until 80 columns fit rather
   than by reflowing to 40 and wrapping every box-drawing line. */
#termwrap{position:fixed;inset:0;z-index:200;display:none;flex-direction:column;background:#fff;
  padding-top:var(--safe-t);padding-bottom:var(--safe-b)}
#termwrap.show{display:flex}
#termwrap.dark{background:#000}
.thead{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:0 4px 0 12px;min-height:var(--head-h);
  background:var(--bg-alt);border-bottom:1px solid var(--line);font-size:12px;color:var(--ink-soft)}
.ttitle{flex:1;font-family:ui-monospace,Menlo,monospace;font-weight:600;color:var(--ink);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tgeom{font-family:ui-monospace,Menlo,monospace;font-size:10.5px;color:var(--ink-faint);flex-shrink:0}
.tbody{flex:1 1 auto;min-height:0;overflow:hidden}
.tbody .xterm{padding:2px 0 2px 4px}
.tnote{padding:16px;font-size:13px;color:var(--ink-soft);line-height:1.6}
.tnote code{font-family:ui-monospace,Menlo,monospace;background:var(--code-bg);border-radius:4px;padding:0 4px}
/* The key bar exists because an iOS keyboard has no Esc, Tab, Ctrl or arrows, and buries
   the backtick two layers deep — Claude Code needs all of them. Ctrl is a sticky
   modifier: tap it, then a letter. ^C is its own key because interrupting is the one
   thing you never want to need two taps for. */
/* Ten keys share one row rather than scrolling: a bar you have to swipe hides exactly the
   key you were reaching for. flex:1 with min-width:0 divides whatever the phone is wide —
   about 33px each at 375pt, the narrowest screen worth fitting — and "ctrl", the widest
   label, is what the font size has to stay inside. */
.tkeys{flex:0 0 auto;display:flex;gap:3px;padding:5px 6px;background:var(--bg-alt);
  border-top:1px solid var(--line)}
.tkey{flex:1 1 0;min-width:0;height:38px;border:1px solid var(--line);border-radius:8px;
  background:var(--surface);color:var(--ink);font-family:ui-monospace,Menlo,monospace;font-size:11.5px;
  display:flex;align-items:center;justify-content:center;padding:0 2px;overflow:hidden}
.tkey:active,.tkey.on{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
/* pointer-events:none is not cosmetic: the toast sits over the composer, and a "send
   failed" message that swallowed the next tap on the send button would make the failure
   look permanent. */
#toast{position:fixed;left:12px;right:12px;bottom:calc(14px + var(--safe-b));
  background:#3d3d3a;color:#fff;border-radius:12px;padding:11px 14px;font-size:13px;z-index:300;
  display:none;box-shadow:0 4px 16px rgba(0,0,0,.3);pointer-events:none}
</style>
</head>
<body>
<div id="stack"></div>
<div id="termwrap"></div>
<div id="toast"></div>
<script>
__APP_JS__
</script>
</body>
</html>`;

const MOBILE_JS = `
var PRICE_TABLE = __PRICING__;
var SELF = __SELF__;
// Read-only, baked into the page — see the desktop's RO for why it is not fetched.
// On a phone this matters more than on a laptop: the composer is a fifth of the screen,
// so removing it gives the transcript back the space rather than leaving dead furniture.
var RO = __RO__;
if (RO) document.documentElement.classList.add('ro');
var INIT_OPEN = __INIT_OPEN__;

// ── addressing ────────────────────────────────────────────────────────────────
// Identical to the desktop app: a peer's session is the same routes behind
// /peer/<name>. Note these are absolute — the page lives under /m, the API does not.
function isLocal(server){ return !server || server === SELF.name; }
function apiBase(server){ return isLocal(server) ? '' : '/peer/'+encodeURIComponent(server); }
function mobileHref(sid, server){
  return isLocal(server) ? '/m/session/'+sid : '/m/peer/'+encodeURIComponent(server)+'/session/'+sid;
}

// ── helpers ───────────────────────────────────────────────────────────────────
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// A left-to-right embedding (U+202A … U+202C). Only for text inside a direction:rtl box
// — it is what keeps a path in order while the box still ellipsizes from the left.
function ltr(s){ return '\\u202A' + String(s==null?'':s) + '\\u202C'; }
function fmtCost(c){ return '$'+(+c||0).toFixed(2); }
function fmtTokShort(n){ n=n||0; if(n>=1e6)return (n/1e6).toFixed(n>=1e7?0:1)+'M'; if(n>=1e3)return (n/1e3).toFixed(n>=1e4?0:1)+'K'; return String(n); }
function fmtK(n){ n=n||0; return Math.round(n/1000)+'k'; }
function fmtMonth(mk){ var p=String(mk).split('-'), names=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return (names[+p[1]-1]||mk)+' '+p[0]; }
// Age of the list, counted up between pushes: "12s", "3m", "2h".
function fmtAge(ms){ var s=Math.round(ms/1000); if(s<60)return s+'s'; var m=Math.round(s/60);
  if(m<60)return m+'m'; return Math.round(m/60)+'h'; }
// ── subscription windows ──
// A Claude.ai plan runs out of WINDOW, not money. The two rolling limits come from
// /api/subscription and travel next to the dollars in both panels: "$1.23/5h:22%/w:27%",
// the shape statusline-instructions.md defines. A window the account doesn't report is
// dropped rather than drawn as 0%.
function subPct(w){ return w ? Math.round(w.pct)+'%' : '—'; }
function subWinStr(win){
  if (!win) return '';
  var p = [];
  if (win.fiveHour) p.push('5h:'+subPct(win.fiveHour));
  if (win.sevenDay) p.push('w:'+subPct(win.sevenDay));
  return p.length ? '/'+p.join('/') : '';
}
// Time until a window resets. Whole-ish units — the seconds on a four-hour countdown are
// noise — and unspaced ("4h21m"), so the compound stays one visual token in a foot that
// is already packed. The desktop keeps its spaced form; it has columns to sit in.
function fmtUntil(iso){
  if (!iso) return '—';
  var t = Date.parse(iso); if (isNaN(t)) return '—';
  var s = Math.round((t - Date.now())/1000);
  if (s <= 0) return 'due';
  var m = Math.floor(s/60), h = Math.floor(m/60), d = Math.floor(h/24);
  if (d > 0) return d+'d'+(h%24)+'h';
  if (h > 0) return h+'h'+(m%60)+'m';
  return m+'m';
}
function fmtDur(ms){ if(ms==null||!isFinite(ms)||ms<0)return ''; if(ms<1000)return Math.round(ms)+'ms';
  var s=ms/1000; if(s<60)return (s<10?s.toFixed(1):String(Math.round(s)))+'s';
  var m=Math.floor(s/60); if(m<60)return m+'m'+(Math.round(s%60)?' '+Math.round(s%60)+'s':'');
  var h=Math.floor(m/60); if(h<24)return h+'h'+(m%60?' '+(m%60)+'m':''); return Math.floor(h/24)+'d '+(h%24)+'h'; }
// Relative, always — on a phone "3m ago" is what you want from a list, not a date.
function rel(iso){
  if(!iso) return '—';
  var t = typeof iso==='number'?iso:Date.parse(iso);
  if(isNaN(t)) return '—';
  var s = Math.round((Date.now()-t)/1000);
  if(s<0) s=0;
  if(s<45) return s+'s ago';
  var m=Math.round(s/60); if(m<60) return m+'m ago';
  var h=Math.floor(m/60); if(h<24) return h+'h'+(m%60?' '+(m%60)+'m':'')+' ago';
  var d=Math.floor(h/24); if(d<7) return d+'d ago';
  try{ return new Date(t).toLocaleDateString(undefined,{month:'short',day:'numeric'}); }catch(e){ return d+'d ago'; }
}
function prettyModel(m){ m=String(m||''); if(!m||m==='unknown')return 'Unknown';
  var x=m.replace(/^(us|eu|apac|au|global)\\./,'').replace(/^anthropic\\./,'').replace(/^claude-/,'').replace(/-\\d{6,}$/,'').replace(/[:-]v\\d+(:\\d+)?$/,'');
  var parts=x.split('-'), name=(parts.shift()||'');
  name=name.charAt(0).toUpperCase()+name.slice(1);
  var ver=parts.filter(function(p){ return /^\\d+$/.test(p); }).join('.');
  return ver?name+' '+ver:name; }
function normId(m){ m=String(m||'').toLowerCase().replace(/^\\s+|\\s+$/g,'');
  m=m.replace(/^(us|eu|apac|au|global)\\./,'').replace(/^(anthropic|bedrock)[./]/,'').replace(/[:-]v\\d+(:\\d+)?$/,'');
  return m; }
function priceFor(model){
  var t=PRICE_TABLE||{}, byId=t.byId||{}, tiers=t.tiers||{}, id=normId(model);
  if(byId[id])return byId[id];
  var trimmed=id.replace(/-\\d{6,}$/,''); if(trimmed!==id&&byId[trimmed])return byId[trimmed];
  if(id.indexOf('opus')!==-1)return tiers.opus;
  if(id.indexOf('haiku')!==-1)return tiers.haiku;
  if(id.indexOf('sonnet')!==-1)return tiers.sonnet;
  return t.default||tiers.sonnet;
}
var toastTimer;
function toast(msg){
  var t=document.getElementById('toast');
  t.textContent=msg; t.style.display='block';
  clearTimeout(toastTimer); toastTimer=setTimeout(function(){ t.style.display='none'; }, 4000);
}
function el(tag, cls, html){
  var e=document.createElement(tag);
  if(cls) e.className=cls;
  if(html!=null) e.innerHTML=html;
  return e;
}

// ── the composer's editable ───────────────────────────────────────────────────
// Makes a contenteditable div answer to the two textarea properties the composer code
// uses — value and placeholder — so the swap costs nothing outside this function. It has
// to be a div: the send button sits in a notch cut out of the last line by a floated
// ::after, and a textarea has no inline content for a float to displace. Sizing is CSS
// now (min-height/max-height), so there is no autoGrow: a div is as tall as its text.
function asTextarea(el){
  el.setAttribute('contenteditable', 'plaintext-only');
  el.setAttribute('spellcheck', 'false');
  // Paste is flattened by hand rather than left to plaintext-only: Firefox before 136
  // ignores that value and silently falls back to full rich-text editing. execCommand,
  // deprecated as it is, is the only insert the browser's own undo stack still knows.
  el.addEventListener('paste', function(e){
    var cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    e.preventDefault();
    document.execCommand('insertText', false, cd.getData('text/plain'));
  });
  // :empty is not usable for the placeholder — browsers leave a stray <br> behind in an
  // "empty" editable — so the class is maintained by hand.
  function sync(){ el.classList.toggle('empty', !el.innerText); }
  el.addEventListener('input', sync);
  Object.defineProperty(el, 'value', {
    // innerText, not textContent: it is the one reader that turns however this browser
    // chose to represent the line breaks (<br>, nested divs) back into real newlines.
    // Trailing ones go: an editable keeps a bogus block after the last line, so a prompt
    // ended with Enter would arrive at the pane with a blank line after it — which in a
    // pane that submits on Enter is not a cosmetic difference.
    get: function(){ return el.innerText.replace(/\\n+$/, ''); },
    set: function(v){
      el.textContent = v == null ? '' : String(v);
      sync();
      // The history buttons replace the whole text; leave the caret at the end of it, the
      // way arrowing back through a shell history does.
      var sel = window.getSelection();
      if (sel && document.activeElement === el) {
        var r = document.createRange();
        r.selectNodeContents(el); r.collapse(false);
        sel.removeAllRanges(); sel.addRange(r);
      }
    }
  });
  Object.defineProperty(el, 'placeholder', {
    get: function(){ return el.getAttribute('data-ph') || ''; },
    set: function(v){ el.setAttribute('data-ph', v == null ? '' : String(v)); }
  });
  sync();
  return el;
}

// ── waking up ─────────────────────────────────────────────────────────────────
// iOS suspends a backgrounded page: timers stop and sockets are closed under it. A retry
// scheduled on the way out may therefore not run until long after the app is back — or
// never, if the page returned from the bfcache rather than being resumed. Anything that
// heals itself on a timer needs a nudge on the way in too. pageshow covers the bfcache
// restore, visibilitychange the ordinary app switch; both are cheap and either may be
// the only one that fires.
function onForeground(fn){
  function hit(){ if (!document.hidden) fn(); }
  document.addEventListener('visibilitychange', hit);
  window.addEventListener('pageshow', hit);
  return function(){
    document.removeEventListener('visibilitychange', hit);
    window.removeEventListener('pageshow', hit);
  };
}

// ── viewport ──────────────────────────────────────────────────────────────────
// iOS reports a 100dvh that includes the space the keyboard is covering, so the stack is
// sized from visualViewport instead. The scrollTo(0,0) undoes Safari's habit of scrolling
// the whole document up to reveal a focused field, which would push the panel headers off.
function syncViewport(){
  var vv = window.visualViewport;
  var h = vv ? vv.height : window.innerHeight;
  var doc = document.documentElement;
  doc.style.setProperty('--app-h', Math.round(h)+'px');
  if (window.scrollY !== 0) window.scrollTo(0, 0);
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewport);
  window.visualViewport.addEventListener('scroll', syncViewport);
}
window.addEventListener('resize', syncViewport);
window.addEventListener('orientationchange', function(){ setTimeout(syncViewport, 250); });
syncViewport();

// ── panel stack ───────────────────────────────────────────────────────────────
var stackEl = document.getElementById('stack');
var panels = [];
// A maximized composer — or a maximized // output — covers the whole screen, so at most
// one of them may be open across the whole stack; this is the setter of whichever one
// owns it, or null. Every setter takes (on) and folds the incumbent before claiming it.
// See setComposerMax and setCmdMax.
var compMaxOwner = null;
// Accordion: expanding one panel minimizes the rest. 'max' additionally hides every
// other panel's header, so a maximized session is the whole screen.
function setState(p, st){
  // A full-screen overlay is position:fixed inside its panel's body, so it vanishes the
  // moment that panel is minimized or hidden behind another's maximize. Fold it first.
  if (compMaxOwner) compMaxOwner(false);
  if (st !== 'min') {
    panels.forEach(function(q){ if (q !== p) { q.state='min'; applyState(q); } });
  }
  p.state = st;
  applyState(p);
  document.body.classList.toggle('has-max', panels.some(function(q){ return q.state==='max'; }));
  if (st !== 'min' && p.onShow) p.onShow();
}
function applyState(p){
  p.el.classList.remove('min','exp','max');
  p.el.classList.add(p.state);
  if (p.onState) p.onState();
}
function addPanel(p){
  panels.push(p);
  stackEl.appendChild(p.el);
  applyState(p);
}
function removePanel(p){
  var i = panels.indexOf(p);
  if (i === -1) return;
  panels.splice(i, 1);
  if (p.destroy) p.destroy();
  p.el.remove();
  document.body.classList.toggle('has-max', panels.some(function(q){ return q.state==='max'; }));
  // Something has to be open, and the list is the only panel that is always there.
  if (!panels.some(function(q){ return q.state !== 'min'; })) setState(panels[0], 'exp');
}
function headButtons(specs){
  var wrap = el('div','pbtns');
  specs.forEach(function(s){
    var b = el('button','pbtn', s.html);
    b.title = s.title || '';
    b.dataset.k = s.k;
    wrap.appendChild(b);
  });
  return wrap;
}
var ICON = { refresh:'&#8635;', min:'&#8211;', max:'&#9723;', restore:'&#9724;', term:'&gt;_',
  close:'&#10005;', up:'&#9650;', down:'&#9660;', send:'&#8593;', expand:'&#9633;' };

// ── session list panel ────────────────────────────────────────────────────────
function createListPanel(){
  var p = { kind:'list', state:'exp' };
  var root = el('div','panel');
  p.el = root;
  var head = el('div','phead',
    '<span class="ptitle">ccbb</span><span class="ago" data-r="ago"></span>');
  head.appendChild(headButtons([
    { k:'refresh', html:ICON.refresh, title:'Refresh' },
    { k:'min', html:ICON.min, title:'Minimize' },
    { k:'max', html:ICON.max, title:'Maximize' },
  ]));
  root.appendChild(head);
  var body = el('div','pbody',
    // Scope and servers share the top row; the rest of the height belongs to the sessions.
    '<div class="topbar"><select class="scope" data-r="scope"></select>'+
      '<div class="srvbar" data-r="srv"></div></div>'+
    '<div class="rows" data-r="rows"><div class="lmsg">Loading…</div></div>'+
    // The foot carries the whole summary — count, spend, and each plan's two windows.
    '<div class="foot"><span class="tot" data-r="tot"></span></div>');
  root.appendChild(body);
  var agoEl = head.querySelector('[data-r="ago"]');
  var srvEl = body.querySelector('[data-r="srv"]');
  var scopeEl = body.querySelector('[data-r="scope"]');
  var rowsEl = body.querySelector('[data-r="rows"]');
  var totEl = body.querySelector('[data-r="tot"]');

  var sessions = [], servers = [{ name:SELF.name, self:true, status:'up' }], errors = [];
  var lastLoad = 0;
  // Cost scope: all time, or one month. Remembered, since it is usually "this month".
  var months = [], scopeMonth = null;
  try { scopeMonth = localStorage.getItem('ccbb.m.scope') || null; } catch(e){}

  var selected = null;
  try { var raw = localStorage.getItem('ccbb.m.servers'); if (raw) selected = JSON.parse(raw); } catch(e){}
  if (!Array.isArray(selected)) selected = null;
  function knownNames(){ return servers.map(function(s){ return s.name; }); }
  function selectedServers(){
    var known = knownNames();
    if (!selected) return known;
    var keep = selected.filter(function(n){ return known.indexOf(n) !== -1; });
    return keep.length ? keep : known;
  }
  function toggleServer(name){
    var cur = selectedServers().slice(), i = cur.indexOf(name);
    if (i === -1) cur.push(name); else cur.splice(i, 1);
    selected = cur;
    try { localStorage.setItem('ccbb.m.servers', JSON.stringify(selected)); } catch(e){}
    renderServers(); load();
  }
  function renderServers(){
    var sel = selectedServers();
    srvEl.innerHTML = servers.map(function(s){
      var on = sel.indexOf(s.name) !== -1;
      return '<span class="chip'+(on?' on':'')+(s.status==='down'?' down':'')+'" data-srv="'+esc(s.name)+'">'+
        esc(s.name)+(s.self?'':'')+
        (RO ? '' : '<button class="cterm" data-term="'+esc(s.name)+'" title="Terminal on '+esc(s.name)+'">&gt;_</button>')+'</span>';
    }).join('');
  }
  srvEl.addEventListener('click', function(e){
    var t = e.target.closest('[data-term]');
    if (t) { e.stopPropagation(); return openTerminal(t.dataset.term === SELF.name ? null : t.dataset.term, null); }
    var c = e.target.closest('[data-srv]');
    if (c) toggleServer(c.dataset.srv);
  });

  function renderRows(){
    if (!sessions.length) {
      // A server still opening its socket has not said "no sessions" yet.
      var waiting = selectedServers().some(function(n){ return !srvRows[n] && !srvErr[n]; });
      rowsEl.innerHTML = errors.length ? '' : '<div class="lmsg">'+(waiting ? 'Loading…' : 'No sessions yet.')+'</div>';
    } else {
      rowsEl.innerHTML = sessions.map(function(s){
        var live = s.live ? ' live' : '';
        return '<div class="srow" data-sid="'+esc(s.sessionId)+'" data-srv="'+esc(s.server||'')+'">'+
          '<div class="r1">'+
            '<span class="dot'+live+'"></span>'+
            '<span class="srv'+(isLocal(s.server)?' local':'')+'">'+esc(s.server||SELF.name)+'</span>'+
            '<span class="stitle">'+esc(s.title || '(untitled)')+'</span>'+
            '<span class="stime">'+esc(rel(s.lastActivity || s.startedAt))+'</span>'+
          '</div>'+
          '<div class="sdir">'+esc(ltr(s.projectPath || ''))+'</div>'+
        '</div>';
      }).join('');
    }
    if (errors.length) {
      rowsEl.insertAdjacentHTML('afterbegin', errors.map(function(e){
        return '<div class="lerr">'+esc(e.server)+': '+esc(e.error)+'</div>';
      }).join(''));
    }
    renderFoot();
  }
  // "×164 · $1328.85 · Steve Jung [5h 3% 4h21m] [7d 28% 22h33m]", each window a filled
  // pill. The month is not repeated here — it is the scope select two rows up, and the
  // cost already follows it.
  function renderFoot(){
    var cost = 0;
    for (var n in srvRows) if (selectedServers().indexOf(n) !== -1)
      cost += (srvRows[n].totals && srvRows[n].totals.totalCost) || 0;
    // "×164" rather than "164 sessions": the count sits where a count is expected and the
    // word was the longest thing on the line that carried no information.
    var html = '<span class="fcnt">×'+sessions.length+'</span>'+
      '<span class="fsep">·</span><span class="fsub">'+fmtCost(cost)+'</span>';
    // The plan groups are an account's name and its personal quota, which is the most
    // personal thing on this screen and not what a shared read-only link is for. The
    // count and the spend stay: they are the session list's own total, the same figure
    // the desktop leaves in its footer.
    if (!RO) subGroups().forEach(function(g){
      html += '<span class="fsep">·</span>' + subFootHtml(g);
    });
    totEl.innerHTML = html;
  }
  function subFootHtml(g){
    var w = g.windows || {};
    return '<span class="fgrp"><span class="fname">'+esc(g.account.name)+'</span>'+
      subFootWin('5h', w.fiveHour) + subFootWin('7d', w.sevenDay) + '</span>';
  }
  function subFootWin(label, w){
    if (!w) return '';
    var pc = Math.max(0, Math.min(100, w.pct));
    var cls = pc >= 90 ? ' hot' : pc >= 70 ? ' warm' : '';
    // A few percent of a short pill is a sub-pixel sliver that renders as nothing, which
    // reads as an untouched window. Any nonzero usage gets at least a visible edge.
    var fill = 'width:'+pc.toFixed(1)+'%' + (pc > 0 ? ';min-width:3px' : '');
    return '<span class="fwin'+cls+'"><i style="'+fill+'"></i>'+
      '<b>'+label+'</b><em>'+subPct(w)+' '+esc(fmtUntil(w.resetsAt))+'</em></span>';
  }
  rowsEl.addEventListener('click', function(e){
    var r = e.target.closest('[data-sid]');
    if (r) openSession(r.dataset.sid, r.dataset.srv || null);
  });

  function tickAgo(){
    // Age of the data, not of a request: "3m" means the sessions have been quiet that long.
    agoEl.textContent = lastLoad ? fmtAge(Date.now() - lastLoad) : '';
    // Row times are relative too, and a list left open would otherwise freeze at "2m ago".
    if (lastLoad && Date.now() - lastLoad > 20000) {
      var kids = rowsEl.querySelectorAll('[data-sid]');
      for (var i = 0; i < kids.length && i < sessions.length; i++) {
        var t = kids[i].querySelector('.stime');
        if (t) t.textContent = rel(sessions[i].lastActivity || sessions[i].startedAt);
      }
    }
  }

  function loadServers(){
    return fetch('/api/servers').then(function(r){ return r.json(); }).then(function(d){
      if (d && Array.isArray(d.servers) && d.servers.length) servers = d.servers;
      renderServers();
    }).catch(function(){});
  }
  // Rows arrive over one socket per selected server: a snapshot on connect, and another on
  // refresh or a scope change. Row-level deltas are applied too if the host is pushing them
  // (off by default). A phone in a pocket downloads nothing at all.
  var srvRows = {}, srvErr = {}, socks = {};

  function rebuild(){
    var rows = [], errs = [];
    selectedServers().forEach(function(n){
      if (srvErr[n]) errs.push({ server:n, error:srvErr[n] });
      var e = srvRows[n];
      if (!e) return;
      for (var id in e.rows) { e.rows[id].server = (n === SELF.name ? null : n); rows.push(e.rows[id]); }
    });
    // Fall back to startedAt so a session that has yet to say anything still sorts
    // as the newest thing in the list, not the oldest.
    rows.sort(function(a,b){
      return String(b.lastActivity||b.startedAt||'').localeCompare(String(a.lastActivity||a.startedAt||''));
    });
    sessions = rows; errors = errs;
  }
  function applyMessage(n, d){
    if (d.type === 'list') {
      var rows = {};
      (d.sessions || []).forEach(function(s){ rows[s.sessionId] = s; });
      srvRows[n] = { rows: rows, totals: d.totals || {} };
      return true;
    }
    if (d.type === 'delta') {
      var e = srvRows[n] || (srvRows[n] = { rows:{}, totals:{} });
      (d.upd || []).forEach(function(s){ e.rows[s.sessionId] = s; });
      (d.del || []).forEach(function(id){ delete e.rows[id]; });
      if (d.totals) e.totals = d.totals;
      return true;
    }
    return false;
  }
  function wsUrl(n){
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var base = n === SELF.name ? '' : '/peer/'+encodeURIComponent(n);
    return proto+'//'+location.host+base+'/ws/list'+(scopeMonth ? '?month='+encodeURIComponent(scopeMonth) : '');
  }
  function openSocket(n){
    if (socks[n]) return;
    var st = { ws:null, timer:null, snapTimer:null, pollTimer:null, tries:0, closed:false, opened:false, http:false };
    socks[n] = st;
    function stopSnapTimer(){ if (st.snapTimer) { clearTimeout(st.snapTimer); st.snapTimer = null; } }
    function base(){ return n === SELF.name ? '' : '/peer/'+encodeURIComponent(n); }
    function pull(){
      fetch(base()+'/api/sessions'+(scopeMonth ? '?month='+encodeURIComponent(scopeMonth) : ''))
        .then(function(r){ if (!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(function(d){
          applyMessage(n, { type:'list', sessions: d.sessions || [], totals: d.totals || {} });
          delete srvErr[n]; rebuild(); lastLoad = Date.now(); renderRows(); tickAgo();
        })
        .catch(function(e){ srvErr[n] = e.message || String(e); rebuild(); renderRows(); });
    }
    // A peer on an older ccbb accepts /ws/list as if "list" were a session id and then says
    // nothing — so silence means version mismatch, not outage: poll it over HTTP instead and
    // re-try the socket occasionally.
    function fallback(){
      if (st.closed) return;
      if (st.ws) { try { st.ws.onclose = st.ws.onerror = st.ws.onmessage = null; st.ws.close(); } catch(e){} st.ws = null; }
      stopSnapTimer();
      if (!st.http) { st.http = true; pull(); st.pollTimer = setInterval(pull, 15000); }
      st.timer = setTimeout(connect, 60000);
    }
    function retry(){
      if (st.closed) return;
      stopSnapTimer();
      if (!st.http && (st.opened || st.tries > 0)) { srvErr[n] = 'disconnected'; rebuild(); renderRows(); }
      st.timer = setTimeout(connect, Math.min(15000, 1000 * Math.pow(2, st.tries++)));
    }
    function connect(){
      if (st.closed) return;
      var ws;
      try { ws = new WebSocket(wsUrl(n)); } catch(e) { return retry(); }
      st.ws = ws;
      var done = false;
      ws.onopen = function(){ st.opened = true; st.tries = 0; st.snapTimer = setTimeout(fallback, 5000); };
      ws.onmessage = function(ev){
        var d; try { d = JSON.parse(ev.data); } catch(e){ return; }
        if (!applyMessage(n, d)) return;
        stopSnapTimer();
        if (st.http) { clearInterval(st.pollTimer); st.pollTimer = null; st.http = false; }
        delete srvErr[n];
        rebuild(); lastLoad = Date.now(); renderRows(); tickAgo();
      };
      ws.onclose = ws.onerror = function(){ if (done) return; done = true; st.ws = null; retry(); };
    }
    connect();
  }
  function closeSocket(n){
    var st = socks[n];
    if (!st) return;
    st.closed = true;
    if (st.timer) clearTimeout(st.timer);
    if (st.snapTimer) clearTimeout(st.snapTimer);
    if (st.pollTimer) clearInterval(st.pollTimer);
    if (st.ws) { try { st.ws.close(); } catch(e){} }
    delete socks[n]; delete srvRows[n]; delete srvErr[n];
  }
  function load(){
    var want = selectedServers();
    for (var n in socks) if (want.indexOf(n) === -1) closeSocket(n);
    want.forEach(openSocket);
    rebuild(); renderRows();
    return Promise.resolve();
  }
  // Re-scope in place: the server answers with a fresh snapshot, no reconnect.
  function pushScope(force){
    selectedServers().forEach(function(n){
      var st = socks[n];
      if (!st) return openSocket(n);
      if (st.ws && st.ws.readyState === 1) {
        try { st.ws.send(JSON.stringify({ type:'scope', month: scopeMonth })); } catch(e){}
      } else if (st.http || force) { closeSocket(n); openSocket(n); }
    });
  }
  function loadMonths(){
    return fetch('/api/months').then(function(r){ return r.json(); }).then(function(d){
      months = (d && d.months) || [];
      renderScope();
    }).catch(function(){});
  }
  // ── subscriptions ──
  // Windows only — no ?cost=1. The foot's dollar figure is the session list's own total,
  // which the sockets already deliver under the current scope, so the phone never pays
  // for a cost-summary pass. One request per selected server; a server that fails just
  // drops out, so one dead tunnel can't take the other accounts' windows with it.
  var subs = {};
  function loadSubs(){
    // Read-only draws none of it — see renderFoot — and a request per selected server for
    // something about to be dropped on the floor is worth not making.
    if (RO) return Promise.resolve();
    return Promise.all(selectedServers().map(function(n){
      return fetch(apiBase(n) + '/api/subscription').then(function(r){ return r.ok ? r.json() : null; })
        .then(function(d){ return (d && d.account) ? { name:n, data:d } : null; })
        .catch(function(){ return null; });
    })).then(function(got){
      var next = {};
      got.forEach(function(g){ if (g) next[g.name] = g.data; });
      subs = next;
      renderFoot();
    });
  }
  // One entry per ACCOUNT, not per server: the windows belong to a login, so two machines
  // sharing one would otherwise print the same percentages twice and read as double the
  // usage. The freshest of their readings wins.
  function subGroups(){
    var byAcct = {}, order = [];
    selectedServers().forEach(function(n){
      var s = subs[n];
      if (!s || !s.account) return;
      var k = s.account.accountUuid;
      if (!byAcct[k]) { byAcct[k] = { account:s.account, windows:null, fetchedAt:0 }; order.push(k); }
      var g = byAcct[k];
      if (s.windows && (s.fetchedAt||0) >= g.fetchedAt) { g.windows = s.windows; g.fetchedAt = s.fetchedAt||0; }
    });
    return order.map(function(k){ return byAcct[k]; });
  }
  function renderScope(){
    var prev = scopeEl.value;
    scopeEl.innerHTML = ['<option value="">All time</option>'].concat(months.map(function(mk){
      return '<option value="'+mk+'">'+fmtMonth(mk)+'</option>';
    })).join('');
    scopeEl.value = prev && scopeEl.querySelector('option[value="'+prev+'"]') ? prev : (scopeMonth || '');
  }
  scopeEl.addEventListener('change', function(){
    scopeMonth = scopeEl.value || null;
    try { localStorage.setItem('ccbb.m.scope', scopeMonth || ''); } catch(e){}
    pushScope(false);
  });

  head.addEventListener('click', function(e){
    var b = e.target.closest('.pbtn');
    if (!b) {
      // Tapping the strip of a minimized list brings it back — the whole header is the target.
      if (p.state === 'min') setState(p, 'exp');
      return;
    }
    if (b.dataset.k === 'refresh') { agoEl.textContent = '…'; refresh(); }
    else if (b.dataset.k === 'min') setState(p, p.state==='min' ? 'exp' : 'min');
    else if (b.dataset.k === 'max') setState(p, p.state==='max' ? 'exp' : 'max');
  });
  p.onState = function(){
    var mx = head.querySelector('[data-k="max"]');
    mx.innerHTML = p.state==='max' ? ICON.restore : ICON.max;
    mx.classList.toggle('on', p.state==='max');
  };

  // Pull to refresh: only from a list already at the top, so it can't fight a scroll.
  var pullY = null;
  rowsEl.addEventListener('touchstart', function(e){ pullY = rowsEl.scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive:true });
  rowsEl.addEventListener('touchmove', function(e){
    if (pullY == null) return;
    if (e.touches[0].clientY - pullY > 70) { pullY = null; agoEl.textContent = '…'; refresh(); }
  }, { passive:true });

  // A manual refresh re-reads the server list and the months, then asks each socket for a
  // fresh snapshot — waking any that were sitting out a reconnect backoff.
  function refresh(){
    return loadServers().then(function(){ load(); loadMonths(); loadSubs(); pushScope(true); });
  }

  // The age label counts up, and the same tick moves the windows' reset countdowns —
  // no request involved, the reset times are already in hand.
  var agoTimer = setInterval(function(){ tickAgo(); renderFoot(); }, 10000);
  // Plan windows are account state: no socket carries them, so they are the one thing
  // this panel still polls. Skipped while the screen is off or the list is collapsed —
  // a phone in a pocket must not sit there making requests.
  var subsTimer = setInterval(function(){
    if (document.hidden || p.state === 'min') return;
    loadSubs();
  }, 60000);
  // A phone drops sockets on screen lock. Coming back, reconnect at once rather than
  // waiting out a backoff that started while the screen was off.
  document.addEventListener('visibilitychange', function(){
    if (!document.hidden && p.state !== 'min') { pushScope(true); loadSubs(); }
  });

  p.refresh = refresh;
  p.destroy = function(){
    clearInterval(agoTimer); clearInterval(subsTimer);
    for (var n in socks) closeSocket(n);
  };
  loadServers().then(function(){ load(); loadMonths(); loadSubs(); });
  return p;
}

// ── session panel ─────────────────────────────────────────────────────────────
function openSession(sid, server){
  var existing = panels.filter(function(p){ return p.kind==='session' && p.sessionId===sid && (p.server||null)===(server||null); })[0];
  if (existing) { setState(existing, 'exp'); return existing; }
  var p = createSessionPanel(sid, server || null);
  addPanel(p);
  setState(p, 'exp');
  try { history.replaceState(null, '', mobileHref(sid, server)); } catch(e){}
  return p;
}

function createSessionPanel(sid, server){
  var p = { kind:'session', sessionId:sid, server:server, state:'min' };
  var API = apiBase(server);
  var SRV = server || SELF.name;
  var root = el('div','panel');
  p.el = root;

  var head = el('div','phead',
    '<span class="dot" data-r="dot"></span>'+
    '<span class="srv'+(isLocal(server)?' local':'')+'">'+esc(SRV)+'</span>'+
    '<span class="ptitle" data-r="title">Loading…</span>');
  head.appendChild(headButtons([
    { k:'refresh', html:ICON.refresh, title:'Reload' },
    { k:'max', html:ICON.max, title:'Maximize' },
    { k:'term', html:ICON.term, title:'Terminal' },
    { k:'close', html:ICON.close, title:'Close' },
  ].filter(function(b){ return !(RO && b.k === 'term'); })));
  root.appendChild(head);

  var body = el('div','pbody',
    '<div class="subhead">'+
      '<div class="sdir" data-r="dir"></div>'+
      '<div class="swhen" data-r="when"></div>'+
      '<div class="sline" data-r="sline"></div>'+
    '</div>'+
    '<div class="trwrap">'+
      '<div class="transcript" data-r="tr"></div>'+
      '<button class="jump" data-r="jump">&#8595; new</button>'+
    '</div>'+
    '<div class="cmd-box" data-r="cmd">'+
      '<div class="cmd-head"><span class="cmd-title" data-r="cmdtitle"></span>'+
        '<button class="pbtn" data-c="cmdmax" title="Maximize output">'+ICON.max+'</button>'+
        '<button class="pbtn" data-c="close">'+ICON.close+'</button></div>'+
      '<div class="cmd-content" data-r="cmdbody"></div>'+
    '</div>'+
    '<div class="composer">'+
      '<div class="cbtns">'+
        '<button class="cbtn" data-c="prev" title="Previous prompt">'+ICON.up+'</button>'+
        '<button class="cbtn" data-c="next" title="Next prompt">'+ICON.down+'</button>'+
        '<button class="cbtn" data-c="cmax" title="Maximize editor">'+ICON.max+'</button>'+
      '</div>'+
      '<div class="cwrap">'+
        '<div class="cbox" data-r="box" data-ph="Message the session…"></div>'+
        '<button class="send" data-c="send" title="Send">'+ICON.send+'</button>'+
      '</div>'+
    '</div>');
  root.appendChild(body);

  var dotEl = head.querySelector('[data-r="dot"]');
  var titleEl = head.querySelector('[data-r="title"]');
  var dirEl = body.querySelector('[data-r="dir"]');
  var whenEl = body.querySelector('[data-r="when"]');
  var slineEl = body.querySelector('[data-r="sline"]');
  var transcript = body.querySelector('[data-r="tr"]');
  var jumpEl = body.querySelector('[data-r="jump"]');
  var cmdBox = body.querySelector('[data-r="cmd"]');
  var cmdTitle = body.querySelector('[data-r="cmdtitle"]');
  var cmdBody = body.querySelector('[data-r="cmdbody"]');
  var boxEl = asTextarea(body.querySelector('[data-r="box"]'));

  var INFO = null, STATS = null;
  var destroyed = false, ws = null, reconnectTimer = null, connected = false;
  var historyLoaded = false, pendingTranscript = [], pendingAsk = null;
  // How many history entries we have already taken. /ws/ tails from end-of-file
  // with no resume cursor, so anything written while the socket is down never
  // arrives. The JSONL only grows, so the count is a valid resume point. This
  // matters more here than on the desktop: a screen lock drops the socket every
  // single time.
  var histCount = 0;
  // The phone opens on a window of the transcript, not all of it: the first few entries and
  // the last screenful, with a marker between that fills itself in as you scroll up. On a
  // tunnelled connection this is the difference between a session opening now and a session
  // opening after a megabyte.
  var HIST_HEAD = 5, HIST_TAIL = 10, HIST_CHUNK = 25;
  var gapEl = null, gapFrom = 0, gapTo = 0, gapLoading = false, gapObserver = null;
  var insertAnchor = null;
  var seenUuids = {}, msgEls = {}, toolEls = {}, askCards = {}, permEls = {}, toolStart = {};
  var lastUserTs = null, lastAsstTs = null;
  var canDrive = false, cmdCwd = '';

  function api(path, opts){ return fetch(API + path, opts); }

  // — header —
  function renderHead(){
    titleEl.textContent = (INFO && INFO.title) || '(untitled)';
    dirEl.textContent = ltr((INFO && INFO.projectPath) || '');
    var live = INFO && INFO.live;
    dotEl.className = 'dot' + (live ? (INFO.liveStatus === 'idle' ? ' idle' : ' live') : '');
    renderWhen();
  }
  function renderWhen(){
    if (!STATS) { whenEl.textContent = ''; return; }
    var bits = ['last ' + rel(STATS.lastActivity)];
    if (INFO && INFO.live && INFO.liveStatus === 'idle' && INFO.liveStatusAt)
      bits.push('waiting ' + rel(INFO.liveStatusAt).replace(' ago',''));
    else if (INFO && INFO.live) bits.push('working');
    whenEl.textContent = bits.join('  ·  ');
  }
  // This session's server, when it is on a Claude.ai plan. The two rolling windows hang
  // off the cost as "$1.23/5h:22%/w:27%", exactly as the status line renders them.
  var SUB = null;
  function planWin(){
    if (!SUB || !SUB.windows || !STATS) return '';
    // A Bedrock or API-key session on a machine that also has a login is not billed to
    // that plan, so the plan's windows say nothing about this session.
    var onPlan = (STATS.providers||[]).some(function(x){ return x.provider === 'anthropic' && x.cost > 0; });
    return onPlan ? subWinStr(SUB.windows) : '';
  }
  function loadSub(){
    // No ?cost=1: this panel wants the windows, not a whole-history cost pass.
    return api('/api/subscription').then(function(r){ return r.json(); }).then(function(d){
      if (destroyed) return;
      SUB = (d && d.account) ? d : null;
      renderStatusLine();
    }).catch(function(){});
  }
  // The status line of statusline-instructions.md, minus the one field ccbb cannot know:
  // the month-to-date figure. The cost is ccbb's own list-price estimate rather than
  // Claude Code's reported spend — on a plan the windows beside it are the real limit.
  function renderStatusLine(){
    if (!STATS) { slineEl.innerHTML = ''; return; }
    var st = STATS;
    var model = (st.context && st.context.model) || (st.models && st.models[0] && st.models[0].model) || '';
    var pr = priceFor(model) || { cacheRead:0, cacheWrite5m:0, cacheWrite1h:0 };
    var ctx = st.context ? (st.context.tokens||0) : 0;
    var peak = Math.max(ctx, st.contextMax ? (st.contextMax.tokens||0) : 0);
    var read = ctx * (pr.cacheRead||0) / 1e6;
    var ttl = st.cacheTtl || 300;
    var lastA = st.lastAssistantAt ? Date.parse(st.lastAssistantAt) : NaN;
    var cold = !isNaN(lastA) && (Date.now() - lastA) > ttl * 1000;
    var write = ctx * ((ttl >= 3600 ? pr.cacheWrite1h : pr.cacheWrite5m) || 0) / 1e6;
    var turns = 'turns:' + (st.turns||0) + ((st.subTurns||0) ? '+' + st.subTurns : '');
    var ctxs = 'ctx:' + fmtK(ctx) + '/' + fmtK(peak) + '/' + fmtCost(read) +
      (cold && ctx ? '<span class="sl-cold">-&gt;' + fmtCost(write) + '</span>' : '');
    slineEl.innerHTML = esc(prettyModel(model)) + '  ' + fmtCost(st.cost) + esc(planWin()) +
      '  ' + turns + '  ' + ctxs;
  }
  // Wall-clock, not data: the cache goes cold with nothing written anywhere, so nothing
  // but a timer can notice. 10s, the same cadence the status-line spec asks of the shell.
  var tick = setInterval(function(){
    if (p.state === 'min' || document.hidden) return;
    renderStatusLine(); renderWhen();
  }, 10000);
  // Plan windows belong to the account, not the transcript, so no socket pushes them.
  // Idle while collapsed or backgrounded, for the same reason as the list panel.
  var subTick = setInterval(function(){
    if (p.state === 'min' || document.hidden) return;
    loadSub();
  }, 60000);

  function loadInfo(){
    return api('/api/session-info/'+sid).then(function(r){ return r.json(); }).then(function(d){
      if (destroyed || !d || d.error) return;
      INFO = d; STATS = d.stats || null;
      renderHead(); renderStatusLine();
    }).catch(function(){});
  }
  // Keeps the line honest between reloads: each new response updates cost, turns and
  // context locally, and re-warms the cache clock, without another stats pass on the host.
  function applyUsage(msg, ts){
    if (!STATS || !msg || !msg.usage) return;
    var u = msg.usage;
    var inp = u.input_tokens||0, out = u.output_tokens||0;
    var cr = u.cache_read_input_tokens||0, cw = u.cache_creation_input_tokens||0;
    if (!(inp+out+cr+cw)) return;
    var cc = u.cache_creation || null;
    var cw5 = cc ? (cc.ephemeral_5m_input_tokens||0) : cw;
    var cw1 = cc ? (cc.ephemeral_1h_input_tokens||0) : 0;
    var pr = priceFor(msg.model) || {};
    STATS.cost = (STATS.cost||0) + (inp*(pr.input||0) + out*(pr.output||0) + cr*(pr.cacheRead||0) +
      cw5*(pr.cacheWrite5m||0) + cw1*(pr.cacheWrite1h||0)) / 1e6;
    STATS.totalTokens = (STATS.totalTokens||0) + inp+out+cr+cw;
    if (msg.id && !seenTurnIds[msg.id]) { seenTurnIds[msg.id] = 1; STATS.turns = (STATS.turns||0) + 1; }
    var ctxTok = inp+cr+cw+out;
    STATS.context = { tokens: ctxTok, cost: ctxTok*(pr.cacheRead||0)/1e6, model: msg.model||null };
    if (!STATS.contextMax || ctxTok > (STATS.contextMax.tokens||0)) STATS.contextMax = { tokens: ctxTok };
    if (cw1 > 0) STATS.cacheTtl = 3600; else if (cw5 > 0) STATS.cacheTtl = 300;
    STATS.lastAssistantAt = ts || new Date().toISOString();
    STATS.lastActivity = STATS.lastAssistantAt;
    renderStatusLine(); renderWhen();
  }
  var seenTurnIds = {};


  // — transcript —
  function processEntry(entry, hist){
    if (entry.uuid) { if (seenUuids[entry.uuid]) return; seenUuids[entry.uuid] = true; }
    var msg = entry.message;
    if (!msg) return;
    var ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (entry.role === 'assistant') {
      if (!isNaN(ts)) {
        lastAsstTs = ts;
        for (var i=0;i<(msg.content||[]).length;i++) {
          var b = msg.content[i];
          if (b.type==='tool_use' && b.id) toolStart[b.id] = ts;
        }
      }
      renderAssistant(msg, hist);
      if (!hist && msg.usage) applyUsage(msg, entry.timestamp);
    } else if (entry.role === 'user') {
      var gap = (!isNaN(ts) && lastAsstTs != null) ? ts - lastAsstTs : null;
      if (!isNaN(ts)) lastUserTs = ts;
      if (entry.compact) { renderCompact(msg, hist); return; }
      if ((msg.content||[]).some(function(b){ return b.type==='tool_result'; })) renderToolResults(msg, ts, entry.subagent);
      renderUser(msg, hist, gap);
    }
    repinPrompts();
  }
  function renderAssistant(msg, hist){
    var textParts=[], toolBlocks=[], thinking=[];
    for (var i=0;i<(msg.content||[]).length;i++) {
      var b = msg.content[i];
      if (b.type==='text') textParts.push(b.text);
      else if (b.type==='thinking') thinking.push(b.thinking||'');
      else if (b.type==='tool_use') toolBlocks.push(b);
    }
    var think = thinking.join('').trim();
    if (think) renderThinking(msg.id, think);
    var joined = textParts.join(''), hasText = joined.trim().length > 0;
    if (hasText) {
      var mEl = msgEls[msg.id];
      if (!mEl) {
        mEl = el('div','msg','<div class="msg-label">Claude</div><div class="msg-body"></div>');
        msgEls[msg.id] = mEl;
        tAppend(mEl);
      }
      try { mEl.querySelector('.msg-body').innerHTML = marked.parse(joined); }
      catch(e) { mEl.querySelector('.msg-body').textContent = joined; }
    }
    for (var j=0;j<toolBlocks.length;j++) renderToolUse(toolBlocks[j], hist);
    scrollBottom();
  }
  function renderThinking(msgId, text){
    var id = 'think-'+msgId, card = document.getElementById(id);
    if (!card) {
      card = el('div','think-card');
      card.id = id;
      card.innerHTML = '<div class="tool-hdr" data-toggle="1"><span class="think-label">&#10024; Thinking</span>'+
        '<span class="tool-toggle">&#9654;</span></div><div class="tool-body"><div class="think-body"></div></div>';
      tAppend(card);
    }
    card.querySelector('.think-body').textContent = text;
  }
  // One line of the arguments next to the tool name: on a phone the name alone
  // ("Bash", "Read") is not enough to recognise a turn you scrolled past.
  function briefInput(name, input){
    if (!input) return '';
    var s = input.command || input.file_path || input.path || input.pattern || input.query ||
            input.prompt || input.url || input.description || '';
    if (!s && typeof input === 'object') { try { s = JSON.stringify(input); } catch(e) { s = ''; } }
    s = String(s).replace(/\\s+/g,' ').trim();
    return s.length > 90 ? s.slice(0,89)+'…' : s;
  }
  function fullInput(name, input){
    if (input == null) return '';
    if (typeof input === 'string') return input;
    try { return JSON.stringify(input, null, 2); } catch(e) { return String(input); }
  }
  function renderToolUse(block, hist){
    if (block.name === 'AskUserQuestion') return renderAsk(block);
    var id = block.id;
    if (toolEls[id]) return;
    var card = el('div','tool-card');
    card.id = 'tool-'+id;
    card.innerHTML =
      '<div class="tool-hdr" data-toggle="1"><span class="tool-name">'+esc(block.name)+'</span>'+
        '<span class="tool-brief">'+esc(briefInput(block.name, block.input))+'</span>'+
        '<span class="tool-meta"><span class="tool-time" id="tm-'+id+'"></span>'+
          '<span class="tool-status '+(hist?'done':'running')+'" id="ts-'+id+'">'+(hist?'ok':'…')+'</span></span>'+
        '<span class="tool-toggle">&#9654;</span></div>'+
      '<div class="tool-body"><div class="tool-input"><pre>'+esc(fullInput(block.name, block.input))+'</pre></div>'+
        '<div class="tool-output" id="to-'+id+'"></div></div>';
    toolEls[id] = card;
    tAppend(card);
    scrollBottom();
  }
  function renderToolResults(msg, resultTs, subagent){
    for (var i=0;i<(msg.content||[]).length;i++) {
      var block = msg.content[i];
      if (block.type !== 'tool_result') continue;
      var id = block.tool_use_id;
      var outEl = document.getElementById('to-'+id), stEl = document.getElementById('ts-'+id);
      if (!outEl) continue;
      if (stEl) { stEl.className = 'tool-status '+(block.is_error?'error':'done'); stEl.textContent = block.is_error?'err':'ok'; }
      var tEl = document.getElementById('tm-'+id);
      if (tEl && toolStart[id] != null && !isNaN(resultTs)) tEl.textContent = fmtDur(resultTs - toolStart[id]);
      var content = '';
      if (typeof block.content === 'string') content = block.content;
      else if (Array.isArray(block.content))
        content = block.content.filter(function(b){ return b.type==='text'; }).map(function(b){ return b.text; }).join('');
      outEl.innerHTML = '<pre>'+esc(content)+'</pre>';
      if (subagent && subagent.toolUseId === id && !document.getElementById('sa-'+id)) {
        var sa = el('div','subagent-block');
        sa.id = 'sa-'+id;
        sa.innerHTML = '<div class="subagent-hdr" data-sub="'+esc(id)+'" data-agent="'+esc(subagent.agentId||'')+'">'+
          '<span class="tool-toggle">&#9654;</span> Subagent transcript'+
          (subagent.agentType?' · '+esc(subagent.agentType):'')+'</div>'+
          '<div class="subagent-body" id="sab-'+id+'" hidden></div>';
        outEl.parentNode.appendChild(sa);
      }
      if (askCards[id]) settleAsk(id);
    }
    scrollBottom();
  }
  function toggleSubagent(toolId, agentId){
    var bodyEl2 = document.getElementById('sab-'+toolId), block = document.getElementById('sa-'+toolId);
    if (!bodyEl2 || !block) return;
    var tg = block.querySelector('.tool-toggle');
    var open = bodyEl2.hasAttribute('hidden');
    if (open) bodyEl2.removeAttribute('hidden'); else bodyEl2.setAttribute('hidden','');
    if (tg) tg.innerHTML = open ? '&#9660;' : '&#9654;';
    if (open && bodyEl2.dataset.loaded !== '1') {
      bodyEl2.dataset.loaded = '1';
      bodyEl2.innerHTML = '<div class="subagent-loading">Loading…</div>';
      api('/api/session/'+sid+'/subagent/'+encodeURIComponent(agentId))
        .then(function(r){ return r.json(); })
        .then(function(d){
          var entries = (d && d.history) || [];
          bodyEl2.innerHTML = '';
          if (!entries.length) { bodyEl2.innerHTML = '<div class="subagent-loading">No transcript.</div>'; return; }
          entries.forEach(function(en){
            var m = en.message;
            if (!m) return;
            var text = (m.content||[]).filter(function(b){ return b.type==='text'; })
              .map(function(b){ return b.text; }).join('').trim();
            if (!text) {
              var tools = (m.content||[]).filter(function(b){ return b.type==='tool_use'; });
              if (tools.length) {
                var t = el('div','sub-msg','<div class="msg-label">'+esc(tools.map(function(b){ return b.name; }).join(', '))+'</div>');
                bodyEl2.appendChild(t);
              }
              return;
            }
            var d2 = el('div','sub-msg');
            d2.innerHTML = '<div class="msg-label">'+(en.role==='assistant'?'Subagent':'Input')+'</div>'+
              '<div class="msg-body">'+(en.role==='assistant'?marked.parse(text):esc(text))+'</div>';
            bodyEl2.appendChild(d2);
          });
        })
        .catch(function(e){ bodyEl2.innerHTML = '<div class="subagent-loading">'+esc(String(e))+'</div>'; });
    }
  }
  var NOISE_TAG = /^<(command-name|command-message|command-args|local-command|system-reminder|task-notification|bash-input|bash-stdout|bash-stderr)/;
  function isNoise(text){
    var t = (text||'').trim();
    if (!t) return true;
    if (NOISE_TAG.test(t)) return true;
    if (t.indexOf('<local-command-stdout>') !== -1) return true;
    if (t.indexOf('<task-notification>') !== -1) return true;
    if (t.indexOf('Caveat: The messages below') !== -1) return true;
    if (/^\\[Request interrupted/.test(t)) return true;
    if (/^This session is being continued from a previous conversation/.test(t)) return true;
    return false;
  }
  function renderCompact(msg){
    var summary = (msg.content||[]).filter(function(b){ return b.type==='text'; })
      .map(function(b){ return b.text; }).join('').trim();
    var mk = el('div','compact-marker',
      '<span class="compact-label">&#10719; Context compacted</span>'+
      '<details class="compact-details"><summary>summary</summary>'+
      '<div class="compact-summary">'+esc(summary)+'</div></details>');
    tAppend(mk);
    scrollBottom();
  }
  function renderUser(msg, hist, gap){
    var text = (msg.content||[]).filter(function(b){ return b.type==='text'; })
      .map(function(b){ return b.text; }).join('').trim();
    if (!text || isNoise(text)) return;
    var g = fmtDur(gap);
    var m = el('div','msg you',
      '<div class="msg-label">You'+(g?' <span class="msg-time">'+g+'</span>':'')+'</div>'+
      '<div class="msg-body">'+esc(text)+'</div>');
    histAdd(text);
    tAppend(m);
    scrollBottom();
  }

  // — permission / ask —
  function showPermission(msg){
    clearPermission();
    var card = el('div','perm-card');
    card.id = 'perm-'+msg.fp;
    card.innerHTML =
      '<div class="perm-hdr">&#128274; Permission needed</div>'+
      '<div class="perm-body">'+esc(msg.title)+'</div>'+
      '<div class="perm-acts">'+(msg.options||[]).map(function(o,i){
        return '<button class="perm-opt'+(i===0?' first':'')+'" data-n="'+o.n+'">'+o.n+'. '+esc(o.label)+'</button>';
      }).join('')+'</div>'+
      '<div class="perm-note">'+(RO ? 'Waiting for an answer at the terminal.' : 'Also answerable at the terminal.')+'</div>';
    card.addEventListener('click', function(e){
      var b = e.target.closest('.perm-opt');
      if (!b) return;
      clearPermission(msg.fp);
      api('/api/session/'+sid+'/permission', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ choice: +b.dataset.n }) }).catch(function(){});
    });
    permEls[msg.fp] = card;
    tAppend(card);
    scrollBottom(true);
  }
  function clearPermission(fp){
    if (fp && permEls[fp]) { permEls[fp].remove(); delete permEls[fp]; return; }
    for (var k in permEls) { permEls[k].remove(); delete permEls[k]; }
  }
  function renderAsk(block){
    var id = block.id;
    if (toolEls[id]) return;   // dedup: the open ask arrives twice (WS replay + history)
    var qs = (block.input && block.input.questions) || [];
    var showSubmit = qs.length > 1 || qs.some(function(q){ return q && q.multiSelect; });
    var sel = qs.map(function(q){ return (q && q.multiSelect) ? { choices: [] } : null; });
    function isMulti(qi){ return !!(qs[qi] && qs[qi].multiSelect); }

    var card = el('div','perm-card ask-card');
    card.id = 'tool-'+id;
    var html = '<div class="perm-hdr">&#10067; Claude asks'+(qs.length>1?' · '+qs.length+' questions':'')+'</div>';
    qs.forEach(function(q, qi){
      var ms = !!(q && q.multiSelect);
      html += '<div class="perm-body">'+(qs.length>1?'<b>'+(qi+1)+'.</b> ':'')+
        (q.header?'<b>'+esc(q.header)+'</b> — ':'')+esc(q.question||'')+
        (ms?' <span class="ask-multi">(pick any)</span>':'')+'</div>';
      html += '<div class="perm-acts">'+(q.options||[]).map(function(o,i){
        var lbl = typeof o === 'string' ? o : (o.label||'');
        var desc = (o && o.description) || '';
        return '<button class="perm-opt" data-qi="'+qi+'" data-n="'+(i+1)+'">'+(i+1)+'. '+esc(lbl)+
          (desc?'<span class="ask-opt-desc">'+esc(desc)+'</span>':'')+'</button>';
      }).join('')+'</div>';
      if (!ms) html += '<div class="perm-acts"><input class="ask-text" data-qi="'+qi+'" placeholder="Type an answer…"></div>';
    });
    html += '<div class="perm-acts"><button class="ask-submit"'+(showSubmit?'':' style="display:none"')+' disabled>Submit</button></div>';
    html += '<div class="perm-note" id="an-'+id+'">'+(RO ? 'Waiting for an answer at the terminal.' : 'Also answerable at the terminal.')+'</div>';
    html += '<div class="tool-output" id="to-'+id+'"></div>';
    card.innerHTML = html;

    var submitBtn = card.querySelector('.ask-submit');
    function qReady(qi){
      var s = sel[qi];
      return isMulti(qi) ? !!(s && s.choices && s.choices.length) : s != null;
    }
    function ready(){ return qs.every(function(_, qi){ return qReady(qi); }); }
    function refresh(){ if (submitBtn) submitBtn.disabled = !ready(); }
    function markOpts(qi){
      var s = sel[qi], ms = isMulti(qi);
      card.querySelectorAll('.perm-opt[data-qi="'+qi+'"]').forEach(function(b){
        var n = +b.dataset.n;
        b.classList.toggle('sel', ms ? !!(s && s.choices && s.choices.indexOf(n) !== -1) : !!(s && s.choice === n));
      });
    }
    function doSubmit(){
      if (!ready()) return;
      settleAsk(id);
      api('/api/session/'+sid+'/ask', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ answers: sel.slice() }) })
        .then(function(r){ return r.json(); })
        .then(function(d){ if (!(d && d.ok)) toast((d && d.error) || 'Answer failed'); })
        .catch(function(e){ toast(String(e)); });
    }
    card.addEventListener('click', function(e){
      var b = e.target.closest('.perm-opt');
      if (b) {
        var qi = +b.dataset.qi, n = +b.dataset.n;
        if (isMulti(qi)) {
          var arr = (sel[qi] && sel[qi].choices) || [];
          var ix = arr.indexOf(n);
          if (ix === -1) arr.push(n); else arr.splice(ix, 1);
          sel[qi] = { choices: arr };
        } else {
          sel[qi] = { choice: n };
          var inp = card.querySelector('.ask-text[data-qi="'+qi+'"]');
          if (inp) inp.value = '';
        }
        markOpts(qi); refresh();
        if (!showSubmit) doSubmit();
        return;
      }
      if (e.target.closest('.ask-submit')) doSubmit();
    });
    card.querySelectorAll('.ask-text').forEach(function(inp){
      inp.addEventListener('input', function(){
        var qi = +inp.dataset.qi;
        sel[qi] = inp.value.length ? { text: inp.value } : null;
        markOpts(qi); refresh();
      });
    });
    toolEls[id] = card; askCards[id] = card;
    tAppend(card);
    scrollBottom(true);
  }
  function settleAsk(id){
    var card = askCards[id];
    if (!card) return;
    card.classList.add('settled');
    card.querySelectorAll('button, input').forEach(function(b){ b.disabled = true; });
    var note = document.getElementById('an-'+id);
    if (note) note.textContent = 'Answered.';
  }
  // An open prompt belongs at the bottom: it is sticky, but sticky only works while the
  // element is the last thing in the scroller.
  function repinPrompts(){ for (var k in permEls) transcript.appendChild(permEls[k]); }

  // — scrolling —
  var NEAR = 200, following = true, anchorEl = null, anchorTop = 0;
  function distBottom(){ return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight; }
  function pickAnchor(){
    var kids = transcript.children, top = transcript.scrollTop;
    anchorEl = null;
    for (var i=0;i<kids.length;i++) {
      if (kids[i].offsetTop + kids[i].offsetHeight > top) { anchorEl = kids[i]; anchorTop = kids[i].offsetTop; return; }
    }
  }
  transcript.addEventListener('scroll', function(){
    following = distBottom() <= NEAR;
    if (following) { jumpEl.classList.remove('show'); anchorEl = null; }
    else pickAnchor();
  }, { passive:true });
  var mo = new MutationObserver(function(){
    if (following) { transcript.scrollTop = transcript.scrollHeight; return; }
    if (!anchorEl || anchorEl.parentNode !== transcript) pickAnchor();
    if (anchorEl) {
      var delta = anchorEl.offsetTop - anchorTop;
      if (delta) { transcript.scrollTop += delta; anchorTop = anchorEl.offsetTop; }
    }
    jumpEl.classList.add('show');
  });
  mo.observe(transcript, { childList:true, subtree:true, characterData:true });
  function scrollBottom(force){
    if (force || following) {
      transcript.scrollTop = transcript.scrollHeight;
      following = true;
      jumpEl.classList.remove('show');
    } else jumpEl.classList.add('show');
  }
  jumpEl.addEventListener('click', function(){ scrollBottom(true); });

  // — history + socket —
  // Older entries go where the gap marker is, not at the bottom; the scroll observer below
  // holds the reading position while the page grows above it.
  function tAppend(node){
    if (insertAnchor && insertAnchor.parentNode === transcript) transcript.insertBefore(node, insertAnchor);
    else transcript.appendChild(node);
  }
  function loadHistory(resume){
    var q = resume ? 'from=' + histCount : 'head=' + HIST_HEAD + '&tail=' + HIST_TAIL;
    return api('/api/session/'+sid+'/history?'+q).then(function(r){ return r.json(); }).then(function(d){
      if (d && d.entries) {
        for (var i=0;i<d.entries.length;i++) processEntry(d.entries[i], true);
        if (!resume) { gapFrom = 0; gapTo = 0; }
      } else if (d && (d.head || d.tail)) {
        var head = d.head || [], tail = d.tail || [];
        for (var h=0;h<head.length;h++) processEntry(head[h], true);
        gapTo = head.length;
        gapFrom = d.tailFrom != null ? d.tailFrom : (d.total - tail.length);
        showGap();
        for (var t=0;t<tail.length;t++) processEntry(tail[t], true);
      }
      // Entries the socket delivered mid-fetch already counted; take whichever is further.
      if (d && d.total != null) histCount = Math.max(histCount, d.total);
      historyLoaded = true;
      flushPending();
      // Do not yank the view back if the reader scrolled up to read something.
      if (!resume || following) scrollBottom(true);
    }).catch(function(){ historyLoaded = true; flushPending(); });
  }
  function showGap(){
    var missing = gapFrom - gapTo;
    if (missing <= 0) { hideGap(); return; }
    if (!gapEl) {
      gapEl = document.createElement('div');
      gapEl.className = 'hgap';
      gapEl.addEventListener('click', function(e){
        var b = e.target.closest('button');
        if (b) loadOlder(b.dataset.all ? Infinity : HIST_CHUNK);
      });
      if (gapObserver) gapObserver.observe(gapEl);
    }
    gapEl.innerHTML = '<span>'+missing+' earlier</span>'+
      '<button data-n="1">'+Math.min(HIST_CHUNK, missing)+' more</button>'+
      '<button data-all="1">all</button>';
    if (gapEl.parentNode !== transcript) tAppend(gapEl);
  }
  function hideGap(){
    if (!gapEl) return;
    if (gapObserver) { try { gapObserver.unobserve(gapEl); } catch(e){} }
    gapEl.remove(); gapEl = null;
  }
  function loadOlder(n){
    if (gapLoading || !gapEl) return;
    var to = gapFrom, from = n === Infinity ? gapTo : Math.max(gapTo, gapFrom - n);
    if (to <= from) { hideGap(); return; }
    gapLoading = true;
    gapEl.classList.add('loading');
    return api('/api/session/'+sid+'/history?from='+from+'&to='+to)
      .then(function(r){ return r.json(); })
      .then(function(d){
        insertAnchor = gapEl ? gapEl.nextSibling : null;
        try { ((d && d.entries) || []).forEach(function(e){ processEntry(e, true); }); }
        finally { insertAnchor = null; }
        gapFrom = from;
        gapLoading = false;
        if (gapEl) gapEl.classList.remove('loading');
        if (gapFrom <= gapTo) hideGap(); else showGap();
      })
      .catch(function(){ gapLoading = false; if (gapEl) gapEl.classList.remove('loading'); });
  }
  if (window.IntersectionObserver) {
    gapObserver = new IntersectionObserver(function(ents){
      for (var i=0;i<ents.length;i++) if (ents[i].isIntersecting) loadOlder(HIST_CHUNK);
    }, { root: transcript, rootMargin: '200px 0px 0px 0px' });
  }
  function flushPending(){
    for (var i=0;i<pendingTranscript.length;i++) processEntry(pendingTranscript[i], false);
    pendingTranscript = [];
    if (pendingAsk) { renderAsk(pendingAsk); pendingAsk = null; }
  }
  function connect(){
    if (destroyed) return;
    clearTimeout(reconnectTimer);
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var first = !connected;
    try { ws = new WebSocket(proto+'//'+location.host+API+'/ws/'+sid); }
    catch(e) { reconnectTimer = setTimeout(connect, 3000); return; }
    // Everything below belongs to THIS socket. connect() can run again before a socket
    // the phone left behind has finished dying — waking to the foreground is exactly
    // that race — and a close event arriving late must not be read as the live socket
    // dropping, or it schedules a reconnect on top of a healthy one.
    var mine = ws;
    // The tail starts at end-of-file, so entries written while we were
    // disconnected are gone from this view unless we go back for them.
    ws.onopen = function(){ if (ws !== mine) return; connected = true; if (!first) loadHistory(true); };
    ws.onmessage = function(e){
      if (ws !== mine) return;
      var m; try { m = JSON.parse(e.data); } catch(err) { return; }
      if (m.type === 'transcript') {
        histCount++;   // keep the resume cursor in step with the file being tailed
        if (!historyLoaded) pendingTranscript.push(m.entry);
        else processEntry(m.entry, false);
      } else if (m.type === 'live') {
        // Liveness is pushed by the host's registry watcher — nothing here polls for it.
        if (INFO) {
          INFO.live = !!m.live; INFO.liveStatus = m.status || null; INFO.liveStatusAt = m.statusAt || null;
          renderHead();
        }
      } else if (m.type === 'permission') showPermission(m);
      else if (m.type === 'permission_clear') clearPermission(m.fp);
      else if (m.type === 'command') showCmd(m);
      else if (m.type === 'ask_block') {
        if (!historyLoaded) pendingAsk = m.block;
        else renderAsk(m.block);
      }
    };
    ws.onclose = function(){ if (ws !== mine || destroyed) return; reconnectTimer = setTimeout(connect, 2000); };
  }
  var offWake = onForeground(function(){
    if (destroyed) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    connect();
  });

  // — composer —
  function setDrivable(ok){
    canDrive = ok;
    // Short enough for one line at 393px: a placeholder that wraps is clipped by the
    // one-row composer and reads as a truncated error.
    boxEl.placeholder = ok ? 'Message…  (// commands)' : 'Not attachable · // only';
  }
  function refreshDrivable(){
    api('/api/session/'+sid+'/pane').then(function(r){ return r.json(); })
      .then(function(d){ setDrivable(!!(d && d.pane)); })
      .catch(function(){ setDrivable(false); });
  }
  var composerMax = false;
  // Maximizing takes the whole screen, not just this panel, so at most one composer can
  // own it — a second one would leave the first stranded full-screen behind it.
  function setComposerMax(on){
    on = !!on;
    if (on && compMaxOwner && compMaxOwner !== setComposerMax) compMaxOwner(false);
    composerMax = on;
    compMaxOwner = on ? setComposerMax : (compMaxOwner === setComposerMax ? null : compMaxOwner);
    body.classList.toggle('cmax', on);
    document.body.classList.toggle('comp-max', on);
    var b = body.querySelector('[data-c="cmax"]');
    b.innerHTML = on ? ICON.restore : ICON.max;
    b.title = on ? 'Restore editor' : 'Maximize editor';
    b.classList.toggle('on', on);
    if (on) boxEl.focus();
    else if (following) transcript.scrollTop = transcript.scrollHeight;
  }
  function send(){
    var text = boxEl.value;
    if (!text.trim()) return;
    // A // command answers into .cmd-box, which the maximized editor covers.
    if (text.trim().slice(0,2) === '//') { histAdd(text); runCmd(text.trim()); boxEl.value=''; setComposerMax(false); return; }
    if (!canDrive) { toast('Session is not running in a tmux pane on '+SRV+' — cannot send.'); return; }
    api('/api/session/'+sid+'/input', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ text: text }) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        // Drop back to the transcript once it is sent — the reply is the point.
        if (d && d.ok) { histAdd(text); boxEl.value=''; setComposerMax(false); }
        else toast((d && d.error) || 'Send failed');
      })
      .catch(function(e){ toast(String(e)); });
  }
  function runCmd(raw){
    var cbody = raw.slice(2).trim(), sp = cbody.indexOf(' ');
    var name = sp === -1 ? cbody : cbody.slice(0, sp);
    var args = sp === -1 ? '' : cbody.slice(sp+1);
    if (!name) return;
    api('/api/session/'+sid+'/command', { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name:name, args:args, cwd:cmdCwd }) })
      .then(function(r){ return r.json(); })
      .then(showCmd)
      .catch(function(e){ showCmd({ error:String(e) }); });
  }
  // Full screen, sharing compMaxOwner with the maximized editor: whichever is opened
  // second folds the first, so document.body never wears two overlays at once.
  var cmdMax = false;
  function setCmdMax(on){
    on = !!on;
    if (on && compMaxOwner && compMaxOwner !== setCmdMax) compMaxOwner(false);
    cmdMax = on;
    compMaxOwner = on ? setCmdMax : (compMaxOwner === setCmdMax ? null : compMaxOwner);
    body.classList.toggle('cmdmax', on);
    document.body.classList.toggle('cmd-max', on);
    var b = cmdBox.querySelector('[data-c="cmdmax"]');
    b.innerHTML = on ? ICON.restore : ICON.max;
    b.title = on ? 'Restore output' : 'Maximize output';
    b.classList.toggle('on', on);
  }
  function hideCmd(){
    setCmdMax(false);
    cmdBox.classList.remove('show');
    body.classList.remove('cmdon');
    // The transcript comes back from display:none with its old scrollTop, which is the
    // wrong place if turns landed while it was away.
    if (following) transcript.scrollTop = transcript.scrollHeight;
  }
  function showCmd(d){
    if (d && d.cwd) cmdCwd = d.cwd;
    if (d && d.kind === 'clear') { hideCmd(); return; }
    cmdBox.classList.add('show');
    body.classList.add('cmdon');
    if (d && d.error) {
      cmdTitle.textContent = 'error';
      cmdBody.className = 'cmd-content';
      cmdBody.innerHTML = '<pre style="color:var(--err)">'+esc(d.error)+'</pre>';
    } else if (d && d.kind === 'markdown') {
      cmdTitle.textContent = d.title || '';
      cmdBody.className = 'cmd-content';
      try { cmdBody.innerHTML = marked.parse(d.content||''); }
      catch(e) { cmdBody.textContent = d.content||''; }
    } else {
      cmdTitle.textContent = (d && d.title) || '';
      cmdBody.className = 'cmd-content code';
      cmdBody.innerHTML = '<pre>'+esc((d && d.content) || '')+'</pre>';
    }
  }
  cmdBox.addEventListener('click', function(e){
    if (e.target.closest('[data-c="close"]')) hideCmd();
    else if (e.target.closest('[data-c="cmdmax"]')) setCmdMax(!cmdMax);
  });

  // — prompt history —
  // The transcript IS the history: every rendered user message is appended, so ▲ reaches
  // back past this page load without storing anything.
  var hist = [], histIx = -1, histDraft = '';
  function histAdd(text){
    text = String(text||'');
    if (!text.trim()) return;
    if (hist.length && hist[hist.length-1] === text) return;
    hist.push(text);
    if (hist.length > 200) hist.shift();
    histIx = -1;
    syncHist();
  }
  function syncHist(){
    body.querySelector('[data-c="prev"]').disabled = !hist.length || histIx === 0;
    body.querySelector('[data-c="next"]').disabled = histIx === -1;
  }
  function histWalk(delta){
    if (!hist.length) return;
    if (histIx === -1) { histDraft = boxEl.value; histIx = hist.length; }
    var ix = histIx + delta;
    if (ix < 0) ix = 0;
    if (ix >= hist.length) { histIx = -1; boxEl.value = histDraft; syncHist(); return; }
    histIx = ix;
    boxEl.value = hist[ix];
    syncHist();
  }
  // Bound to .composer, not .cbtns: send lives inside the box now, in the notch on the
  // last line.
  //
  // The focus class is kept by hand rather than with :focus-within, because iOS does not
  // focus a button on tap — it just blurs whatever had the focus. Under :focus-within the
  // tools row would therefore fold away on pointerdown and the tap would land on the
  // transcript behind it. So: remember whether the press started on one of our own
  // buttons, and let that press keep the row open.
  var composerEl = body.querySelector('.composer');
  var pressedOwn = false;
  composerEl.addEventListener('pointerdown', function(e){ pressedOwn = !!e.target.closest('button'); });
  boxEl.addEventListener('focus', function(){ composerEl.classList.add('cfocus'); });
  // The flag is consumed here, not in the click handler: a press that starts on a button
  // and is dragged off never produces a click, and a flag left standing would keep the
  // row open for good.
  boxEl.addEventListener('blur', function(){
    var keep = pressedOwn; pressedOwn = false;
    if (!keep) composerEl.classList.remove('cfocus');
  });
  composerEl.addEventListener('click', function(e){
    // The other consumer of the flag. Blur usually gets there first, but a tap on a
    // button while the box was never focused (full screen, where the row is always up)
    // produces a click and no blur at all, and the flag must not outlive the press.
    pressedOwn = false;
    var b = e.target.closest('button');
    if (!b) return;
    // Send is the one button that means "I am done typing": it lets the keyboard go and
    // the tools row with it, because the reply is what you want the screen for now.
    if (b.dataset.c === 'send') { send(); composerEl.classList.remove('cfocus'); return; }
    if (b.dataset.c === 'cmax') setComposerMax(!composerMax);
    else if (b.dataset.c === 'prev') histWalk(-1);
    else if (b.dataset.c === 'next') histWalk(1);
    boxEl.focus();
  });
  boxEl.addEventListener('keydown', function(e){
    // A hardware keyboard (an iPad case, a Bluetooth one) should send on Enter the way
    // the desktop does; the on-screen keyboard sends with the button.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
  });
  syncHist();

  // — tool card expand, subagent expand —
  transcript.addEventListener('click', function(e){
    var sub = e.target.closest('[data-sub]');
    if (sub) return toggleSubagent(sub.dataset.sub, sub.dataset.agent);
    var hdr = e.target.closest('[data-toggle]');
    if (!hdr) return;
    var bodyEl2 = hdr.parentNode.querySelector('.tool-body');
    if (!bodyEl2) return;
    var open = bodyEl2.classList.toggle('open');
    var tg = hdr.querySelector('.tool-toggle');
    if (tg) tg.innerHTML = open ? '&#9660;' : '&#9654;';
  });

  // — header buttons —
  head.addEventListener('click', function(e){
    var b = e.target.closest('.pbtn');
    if (!b) {
      if (p.state === 'min') setState(p, 'exp');
      else if (e.target === titleEl && !RO) renameTitle();
      return;
    }
    var k = b.dataset.k;
    if (k === 'refresh') { loadInfo(); loadSub(); refreshDrivable(); }
    else if (k === 'max') setState(p, p.state === 'max' ? 'exp' : 'max');
    else if (k === 'term') openTerminal(server, sid);
    else if (k === 'close') removePanel(p);
  });
  p.onState = function(){
    var mx = head.querySelector('[data-k="max"]');
    mx.innerHTML = p.state === 'max' ? ICON.restore : ICON.max;
    mx.classList.toggle('on', p.state === 'max');
  };
  p.onShow = function(){ if (following) transcript.scrollTop = transcript.scrollHeight; };
  // Rename in place — no prompt(), which blocks the page and steals focus.
  function renameTitle(){
    if (head.querySelector('.rename')) return;
    var input = el('input','ask-text rename');
    input.value = (INFO && INFO.title) || '';
    input.style.cssText = 'flex:1;min-width:0;font-size:16px';
    titleEl.style.display = 'none';
    titleEl.parentNode.insertBefore(input, titleEl.nextSibling);
    input.focus();
    function done(save){
      var v = input.value.trim();
      input.remove();
      titleEl.style.display = '';
      if (!save || !v || !INFO || v === INFO.title) return;
      api('/api/session/'+sid, { method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ title: v }) })
        .then(function(r){ return r.json(); })
        .then(function(d){ if (d && d.ok) { INFO.title = v; renderHead(); } else toast((d&&d.error)||'Rename failed'); })
        .catch(function(e){ toast(String(e)); });
    }
    input.addEventListener('keydown', function(e){
      if (e.key === 'Enter') { e.preventDefault(); done(true); }
      else if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', function(){ done(true); });
  }

  p.destroy = function(){
    destroyed = true;
    // Before anything else: a closing panel that still owns a full-screen overlay would
    // leave document.body wearing comp-max or cmd-max with nothing left to fill it.
    if (composerMax) setComposerMax(false);
    if (cmdMax) setCmdMax(false);
    clearInterval(tick); clearInterval(subTick); clearTimeout(reconnectTimer);
    offWake();
    if (gapObserver) { try { gapObserver.disconnect(); } catch(e){} }
    try { mo.disconnect(); } catch(e){}
    if (ws) { try { ws.close(); } catch(e){} }
  };

  // The socket opens FIRST, in parallel with the history fetch — not after it. The
  // server's tailer starts at the current end of the file when the socket subscribes, so
  // anything appended between the /history response and a later subscribe is never
  // delivered: a turn that lands in that window would simply be missing until reload.
  // That gap is two round trips wide (a cold stats pass, then a megabyte of transcript),
  // which is exactly when a live session is worth watching. Entries that arrive before
  // history is in are buffered and replayed by flushPending, and seenUuids drops the
  // overlap.
  connect();
  loadInfo().then(loadHistory);
  loadSub();
  refreshDrivable();
  return p;
}

// ── terminal ──────────────────────────────────────────────────────────────────
var XTERM_BASE = 'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/';
var xtermLoad = null;
function loadScriptTag(src){
  return new Promise(function(ok, fail){
    var s = document.createElement('script');
    s.src = src;
    s.onload = function(){ ok(); };
    s.onerror = function(){ fail(new Error('could not load '+src)); };
    document.head.appendChild(s);
  });
}
// Same order as marked: ccbb first, CDN as the fallback. Fetched on the first terminal
// open, never at page load — the rest of the app must not wait on a library it isn't using.
function loadXterm(){
  if (!xtermLoad) {
    var css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/xterm.css';
    css.onerror = function(){
      var c2 = document.createElement('link');
      c2.rel = 'stylesheet'; c2.href = XTERM_BASE+'css/xterm.css';
      document.head.appendChild(c2);
    };
    document.head.appendChild(css);
    xtermLoad = loadScriptTag('/vendor/xterm.js')
      .catch(function(){ return loadScriptTag(XTERM_BASE+'lib/xterm.js'); });
    xtermLoad.catch(function(){ xtermLoad = null; });
  }
  return xtermLoad;
}
var TERM_THEMES = {
  light: { background:'#ffffff', foreground:'#000000', cursor:'#000000', cursorAccent:'#ffffff',
    selectionBackground:'#cfe3ff', black:'#000000', red:'#c1272d', green:'#1a7f37', yellow:'#8a6d1a',
    blue:'#0969da', magenta:'#8250df', cyan:'#116a72', white:'#57606a', brightBlack:'#8c959f',
    brightRed:'#cf222e', brightGreen:'#2da44e', brightYellow:'#bf8700', brightBlue:'#218bff',
    brightMagenta:'#a475f9', brightCyan:'#1b7c83', brightWhite:'#24292f' },
  dark: { background:'#000000', foreground:'#e6e6e6', cursor:'#e6e6e6', cursorAccent:'#000000',
    selectionBackground:'#3a4a63', black:'#2e3436', red:'#cc0000', green:'#4e9a06', yellow:'#c4a000',
    blue:'#3465a4', magenta:'#75507b', cyan:'#06989a', white:'#d3d7cf', brightBlack:'#555753',
    brightRed:'#ef2929', brightGreen:'#8ae234', brightYellow:'#fce94f', brightBlue:'#729fcf',
    brightMagenta:'#ad7fa8', brightCyan:'#34e2e2', brightWhite:'#eeeeec' }
}
var TERM_COLS = 80;
var termState = null;
function b64FromBytes(u8){ var s=''; for (var i=0;i<u8.length;i++) s += String.fromCharCode(u8[i]); return btoa(s); }
function bytesFromB64(s){ var b=atob(s), u=new Uint8Array(b.length); for (var i=0;i<b.length;i++) u[i]=b.charCodeAt(i); return u; }

function openTerminal(server, sessionId){
  if (termState) termState.destroy();
  var srv = isLocal(server) ? null : server;
  var name = srv || SELF.name;
  var API = apiBase(srv);
  var wrap = document.getElementById('termwrap');
  var t = { id:null, term:null, ws:null, lastSeq:null, dead:false, destroyed:false,
    cols:TERM_COLS, rows:24, pinned:false,
    theme:(localStorage.getItem('ccbb.m.termtheme') === 'dark' ? 'dark' : 'light'), ctrl:false, resyncing:false };
  termState = t;

  wrap.className = 'show' + (t.theme === 'dark' ? ' dark' : '');
  wrap.innerHTML =
    '<div class="thead"><span class="ttitle"></span><span class="tgeom"></span>'+
      '<button class="pbtn" data-t="theme" title="Contrast">&#9681;</button>'+
      '<button class="pbtn" data-t="close" title="Close">&#10005;</button></div>'+
    '<div class="tbody"></div>'+
    '<div class="tkeys">'+
      '<button class="tkey" data-k="esc">esc</button>'+
      '<button class="tkey" data-k="tab">tab</button>'+
      '<button class="tkey" data-k="ctrl">ctrl</button>'+
      '<button class="tkey" data-k="bt">&#96;</button>'+
      '<button class="tkey" data-k="up">&#9650;</button>'+
      '<button class="tkey" data-k="down">&#9660;</button>'+
      '<button class="tkey" data-k="left">&#9664;</button>'+
      '<button class="tkey" data-k="right">&#9654;</button>'+
      '<button class="tkey" data-k="ctrlc">^C</button>'+
      '<button class="tkey" data-k="kbd">&#9000;</button>'+
    '</div>';
  var head = wrap.querySelector('.thead');
  var titleEl = wrap.querySelector('.ttitle');
  var geomEl = wrap.querySelector('.tgeom');
  var bodyEl = wrap.querySelector('.tbody');
  var keysEl = wrap.querySelector('.tkeys');
  titleEl.textContent = name;

  function wsSendJ(o){ if (t.ws && t.ws.readyState === 1) { try { t.ws.send(JSON.stringify(o)); } catch(e){} } }
  function note(html){ bodyEl.innerHTML = '<div class="tnote">'+html+'</div>'; }

  // The grid is fixed and the font size is what gives. Which grid depends on who owns it:
  //   • a session's terminal is PINNED to what tmux already has, because a client of a
  //     different size resizes the window — and with it the TUI in the user's own
  //     terminal — for as long as the phone is looking at it.
  //   • anything else takes 80 columns. Claude Code draws boxes and tables at a fixed
  //     width, so a narrower grid wraps every one of them; on a phone the legible trade
  //     is small type at the width the program expects.
  // Measure the real cell (fonts round to device pixels, so the ratio is not exactly what
  // you asked for), scale the size to fit, and correct: two or three passes land within a
  // pixel. Pinned fits BOTH dimensions, since neither is ours to change; free fits the
  // width and lets the rows follow.
  //
  // The done callback fires once the grid has settled. The shell is opened from there, not
  // before: opening at a guessed 24 rows and correcting afterwards means the program on
  // the other end starts at the wrong size.
  // Two searches running at once — the open finishing while a refit is in flight —
  // would interleave their probes and each conclude from the other's font size.
  var fitRun = 0;
  function fitTermGrid(pass, done, bounds, run){
    if (run == null) run = ++fitRun;
    if (!t.term || t.destroyed) return;    // torn down: the open it gates is moot too
    // Every OTHER exit has to settle the callback. The shell is opened from it, so a
    // search that stands down for a newer one — a viewport resize landing mid-probe is
    // enough, and on a phone the URL bar collapsing does exactly that — or one that finds
    // nothing measurable yet would leave the panel on "Starting a shell…" forever, with
    // no shell ever requested and nothing to show for it.
    var scr = wrap.querySelector('.xterm-screen');
    var r = scr && scr.getBoundingClientRect();
    if (!scr || run !== fitRun || !(r.width > 0 && t.term.cols > 0)) { if (done) done(); return; }
    var cellW = r.width / t.term.cols, cellH = r.height / t.term.rows;
    var availW = bodyEl.clientWidth - 6;   // .xterm padding, kept in sync with the CSS
    var availH = bodyEl.clientHeight;
    var cols = t.pinned ? t.cols : TERM_COLS;
    var cur = t.term.options.fontSize;
    if (t.pinned) {
      // Both dimensions are fixed, and neither is ours to change — so the size has to be
      // searched for rather than computed. A cell rounds to whole device pixels, which
      // makes font→grid a staircase: scaling by how far off you are lands one step too
      // big, then one step too small, forever. bounds[0] is the largest size seen to fit
      // and bounds[1] the smallest seen not to; halving between them settles in six.
      var b = bounds || [3, 24.5];
      if (cols * cellW <= availW + 0.5 && t.rows * cellH <= availH + 0.5) { if (cur > b[0]) b[0] = cur; }
      else if (cur < b[1]) b[1] = cur;
      var next = Math.floor((b[0] + b[1]) / 2 * 2) / 2;
      if (next > b[0] && next < b[1] && (pass||0) < 14) {
        t.term.options.fontSize = next;
        return setTimeout(function(){ fitTermGrid((pass||0)+1, done, b, run); }, 25);
      }
      // Land on the largest size that actually fitted, not on the last one probed.
      if (cur !== b[0]) {
        t.term.options.fontSize = b[0];
        return setTimeout(function(){ fitTermGrid((pass||0)+1, done, b, run); }, 25);
      }
    } else {
      var want = Math.max(3, Math.min(24, Math.floor(cur * (availW / (cols * cellW)) * 2) / 2));
      if (want !== cur && (pass||0) < 6) {
        t.term.options.fontSize = want;
        return setTimeout(function(){ fitTermGrid((pass||0)+1, done, bounds, run); }, 25);
      }
    }
    var rows = t.pinned ? t.rows : Math.max(5, Math.floor(availH / cellH));
    if (t.term.cols !== cols || t.term.rows !== rows) {
      try { t.term.resize(cols, rows); } catch(e){}
    }
    t.cols = t.term.cols; t.rows = t.term.rows;
    geomEl.textContent = t.term.cols + '×' + t.term.rows + ' · ' + t.term.options.fontSize + 'px';
    // Never for a pinned terminal: its size is tmux's, and the server drops the frame.
    if (!t.pinned) wsSendJ({ type:'size', cols:t.cols, rows:t.rows });
    if (done) done();
  }
  var fitTimer = null;
  function refit(){ clearTimeout(fitTimer); fitTimer = setTimeout(function(){ fitTermGrid(0); }, 80); }
  window.addEventListener('resize', refit);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', refit);

  head.addEventListener('click', function(e){
    var b = e.target.closest('.pbtn');
    if (!b) return;
    if (b.dataset.t === 'close') return t.destroy();
    if (b.dataset.t === 'theme') {
      t.theme = t.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('ccbb.m.termtheme', t.theme); } catch(err){}
      wrap.classList.toggle('dark', t.theme === 'dark');
      if (t.term) t.term.options.theme = TERM_THEMES[t.theme];
    }
  });
  // No return key: the software keyboard behind the ⌨ key already has one, and it is
  // the key most likely to be pressed by accident on a bar this narrow. \\x60 is a
  // backtick, spelled as a code so it cannot close the template literal this file is in.
  var KEYS = { esc:'\\x1b', tab:'\\t', bt:'\\x60', ctrlc:'\\x03',
               up:'\\x1b[A', down:'\\x1b[B', right:'\\x1b[C', left:'\\x1b[D' };
  keysEl.addEventListener('click', function(e){
    var b = e.target.closest('.tkey');
    if (!b || !t.term) return;
    var k = b.dataset.k;
    if (k === 'kbd') { t.term.focus(); return; }
    if (k === 'ctrl') { t.ctrl = !t.ctrl; b.classList.toggle('on', t.ctrl); t.term.focus(); return; }
    var s = KEYS[k];
    if (s) { sendData(s); t.term.focus(); }
  });
  function sendData(d){
    wsSendJ({ type:'in', b: b64FromBytes(new TextEncoder().encode(d)) });
  }

  note('Starting a shell on <code>'+esc(name)+'</code>…');
  loadXterm().then(function(){
    if (t.destroyed) return;
    bodyEl.innerHTML = '';
    t.term = new Terminal({
      cols: TERM_COLS, rows: 24, fontSize: 10,
      fontFamily: 'ui-monospace, Menlo, Consolas, "Cascadia Code", monospace',
      cursorBlink: true, scrollback: 4000, theme: TERM_THEMES[t.theme],
      // A phone has no mouse; the alternate scroll keeps two-finger flicks meaningful
      // inside full-screen programs.
      altClickMovesCursor: false,
    });
    t.term.open(bodyEl);
    // Ctrl as a sticky modifier from the key bar: the next printable character becomes
    // its control code, which is the only way to reach ctrl-c from an iOS keyboard.
    t.term.onData(function(d){
      if (t.ctrl && d.length === 1) {
        var c = d.toLowerCase().charCodeAt(0);
        if (c >= 97 && c <= 122) d = String.fromCharCode(c - 96);
        else if (d === '[') d = '\\x1b';
        t.ctrl = false;
        var cb = keysEl.querySelector('[data-k="ctrl"]');
        if (cb) cb.classList.remove('on');
      }
      sendData(d);
    });
    t.term.onBinary(function(d){
      var u = new Uint8Array(d.length);
      for (var i=0;i<d.length;i++) u[i] = d.charCodeAt(i) & 0xff;
      wsSendJ({ type:'in', b: b64FromBytes(u) });
    });
    return new Promise(function(ok){ fitTermGrid(0, ok); }).then(function(){
      return fetch(API+'/api/term/open', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ cols:t.cols, rows:t.rows, sessionId: sessionId || null }) })
        .then(function(r){ return r.json(); })
        .then(function(d){
          if (t.destroyed) return;
          if (!d || d.error) {
            t.term.write('\\r\\n\\x1b[31m'+((d && d.error) || 'could not start a shell')+'\\x1b[0m\\r\\n');
            t.dead = true;
            return;
          }
          t.id = d.id;
          // The grid the server came back with is tmux's own, not the one we asked for.
          if (d.pinned && d.cols && d.rows) {
            t.pinned = true; t.cols = d.cols; t.rows = d.rows;
            try { t.term.resize(d.cols, d.rows); } catch(e){}
          }
          titleEl.textContent = name + (d.where === 'pane' ? ' · session pane'
                                      : d.where === 'window' ? ' · new window' : '');
          connect();
          setTimeout(function(){ fitTermGrid(0); t.term.focus(); }, 150);
        });
    });
  }).catch(function(e){
    if (!t.destroyed) note('Could not load xterm.js from the CDN ('+esc(String(e.message||e))+').');
  });

  var reconnectTimer = null, quietTimer = null;
  function afterResync(){
    t.term.scrollToBottom();
    clearTimeout(quietTimer);
    quietTimer = setTimeout(function(){ t.resyncing = false; }, 400);
  }
  function connect(){
    if (t.destroyed || t.dead || !t.id) return;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto+'//'+location.host+API+'/ws-term/'+t.id+(t.lastSeq!=null?'?from='+t.lastSeq:''));
    t.ws = ws;
    // t.ws !== ws means this socket has been superseded — the usual way being a wake
    // from the background beating the close event of the socket the phone froze. Frames
    // from the loser would be replayed out of sequence and its close would schedule a
    // reconnect the live socket does not need.
    ws.onopen = function(){ if (t.ws !== ws) return; if (!t.pinned) wsSendJ({ type:'size', cols:t.cols, rows:t.rows }); };
    ws.onmessage = function(ev){
      if (t.ws !== ws) return;
      var f; try { f = JSON.parse(ev.data); } catch(e){ return; }
      if (f.type === 'o') {
        if (t.lastSeq != null && f.seq !== t.lastSeq + 1) { t.lastSeq = null; try { ws.close(); } catch(e){} return; }
        t.lastSeq = f.seq;
        t.term.write(bytesFromB64(f.b), t.resyncing ? afterResync : undefined);
      } else if (f.type === 'reset') {
        t.term.reset(); t.lastSeq = null; t.resyncing = true;
      } else if (f.type === 'exit') {
        t.dead = true;
        t.term.write('\\r\\n\\x1b[90m[shell exited'+(f.code!=null?' ('+f.code+')':'')+']\\x1b[0m\\r\\n');
        try { ws.close(); } catch(e){}
      }
    };
    ws.onclose = function(){
      if (t.ws !== ws || t.destroyed || t.dead) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1000);
    };
  }
  // The shell outlives the socket for TERM_GRACE_MS, so coming back inside that window
  // has to actually reconnect — not sit on a retry the phone froze on the way out.
  var offWake = onForeground(function(){
    if (t.destroyed || t.dead || !t.id) return;
    if (t.ws && (t.ws.readyState === 0 || t.ws.readyState === 1)) return;
    clearTimeout(reconnectTimer);
    connect();
  });

  t.destroy = function(){
    t.destroyed = true;
    clearTimeout(reconnectTimer); clearTimeout(fitTimer);
    offWake();
    window.removeEventListener('resize', refit);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', refit);
    if (t.id && !t.dead) {
      if (t.ws && t.ws.readyState === 1) wsSendJ({ type:'close' });
      else fetch(API+'/api/term/'+t.id+'/close', { method:'POST' }).catch(function(){});
    }
    if (t.ws) { try { t.ws.close(); } catch(e){} }
    if (t.term) { try { t.term.dispose(); } catch(e){} }
    wrap.className = '';
    wrap.innerHTML = '';
    if (termState === t) termState = null;
  };
  t.server = name;
  return t;
}
// Closing the tab ends the shell it opened; sendBeacon is the only request that survives.
// Only when the page is really going away, though: on a phone, switching to another app
// fires pagehide with persisted=true and the page comes BACK from the bfcache, where it
// reconnects with ?from=<lastSeq> and carries on. Killing the shell there would mean
// answering a message cost you your terminal. The server's own grace timer covers the
// socket dropping in the meantime.
window.addEventListener('pagehide', function(e){
  if (e && e.persisted) return;
  if (termState && termState.id && !termState.dead && navigator.sendBeacon) {
    var base = isLocal(termState.server) ? '' : '/peer/'+encodeURIComponent(termState.server);
    navigator.sendBeacon(base+'/api/term/'+termState.id+'/close');
  }
});

// ── boot ──────────────────────────────────────────────────────────────────────
var listPanel = createListPanel();
addPanel(listPanel);
setState(listPanel, 'exp');
if (INIT_OPEN) openSession(INIT_OPEN.sessionId, INIT_OPEN.server);
`;

// Same assembly as the desktop page: one substitution per value, each with a function
// replacement so a "$&" or "$1" inside the JSON can never be read as a backreference.
function mobilePageHtml(initOpenSessionId, initOpenServer, self, priceTable, ro) {
  const open = initOpenSessionId
    ? { sessionId: initOpenSessionId, server: initOpenServer || null }
    : null;
  return MOBILE_HTML.replace('__APP_JS__',
    () => MOBILE_JS
      .replace('__PRICING__', () => JSON.stringify(priceTable))
      .replace('__SELF__', () => JSON.stringify(self))
      .replace('__RO__', () => JSON.stringify(!!ro))
      .replace('__INIT_OPEN__', () => JSON.stringify(open)));
}

module.exports = { mobilePageHtml, isMobileUA, serveVendor };
