#!/usr/bin/env node
'use strict';
// Embed a self-refreshing live-view into a Confluence page's BODY (no bookmarklet).
//
// Confluence Server strips raw <script> from page content, but the HTML macro is enabled
// on this instance and renders script verbatim. So we inject an HTML macro containing a
// small watcher: when anyone opens the page, it polls that page's version number
// same-origin (rides the viewer's session cookie — no token, no proxy) every few seconds.
// When the version increments (the bridge rewrote the body), it fetches the freshly
// rendered body (?expand=body.view) and swaps it into the content container's innerHTML —
// NO full-page reload, so scroll position and page chrome are untouched. The watcher's own
// <script> is inside that fetched HTML but innerHTML-inserted scripts don't execute, so the
// original watcher keeps running and never spawns a duplicate.
//
// The watcher also turns the single root page into a two-view app (like `ccbb web`): the
// bridge renders either a session LIST or one session's TRANSCRIPT into the body. Because
// it's one page (no navigation), a session row is an <a href="#ccbb-attach-<id>">; the
// watcher intercepts that click and POSTs a `/attach <id>` comment same-origin, which the
// bridge reads and answers by rewriting the body to that session. The comment POST needs
// the Confluence XSRF header `X-Atlassian-Token: no-check` (verified) but no token/proxy.
//
// liveMacro() is exported so the bridge can re-embed the watcher on every body rewrite;
// running this file directly still embeds it into one page as a CLI.
//
// Usage:  node ccbb-embed.js <pageId>        # defaults to rootPageId from config
//         node ccbb-embed.js                 # embeds into the root page

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { readConfig } = require('./ccbb-common');

const cf = readConfig().confluence || {};
const BASE = String(cf.baseUrl || '').replace(/\/+$/, '');
const PROXY = cf.proxy || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || null;

function api(method, rel, body) {
  return new Promise((resolve, reject) => {
    const t = new URL(BASE + '/rest/api' + rel);
    const transport = t.protocol === 'https:' ? https : http;
    const headers = { Authorization: `Bearer ${cf.token}`, Accept: 'application/json' };
    let payload;
    if (body !== undefined) { payload = Buffer.from(JSON.stringify(body), 'utf8'); headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    const opts = { hostname: t.hostname, port: t.port, path: t.pathname + t.search, method, headers };
    if (PROXY) opts.agent = new HttpsProxyAgent(PROXY);
    const req = transport.request(opts, res => {
      let d = ''; res.setEncoding('utf8'); res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`${method} ${rel} → ${res.statusCode} ${d.slice(0, 200)}`));
        resolve(d ? JSON.parse(d) : null);
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

// The live watcher, as it will run in the viewer's browser. Claude's transcript is
// appended to the page BODY (rendered natively as markdown), which is static HTML that
// only changes on reload. So this doesn't fetch/append anything itself: it polls the
// page's version number same-origin and reloads the page when it increments, preserving
// scroll position across the reload so a live session reads continuously. A small status
// pill (fixed, bottom-right) shows it's watching without disturbing the body content.
function liveJs(pollMs) { return `
(function(){
  var POLL=` + (Number(pollMs) > 0 ? Number(pollMs) : 3000) + `;
  function pid(){var m=document.querySelector('meta[name=ajs-page-id]');if(m&&m.content)return m.content;if(window.AJS&&AJS.params&&AJS.params.pageId)return AJS.params.pageId;var q=location.search.match(/pageId=(\\\\d+)/);return q?q[1]:null;}
  var id=pid();
  var pill=document.createElement('div');
  pill.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#fff;border:1px solid #ccc;border-radius:6px;padding:4px 10px;font:12px/1.4 monospace;color:#666;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  pill.innerHTML='<b>ccbb live</b> <span id=ccbbStat></span>';
  document.body.appendChild(pill);
  if(!id){document.getElementById('ccbbStat').textContent='no page id';return;}
  // The container Confluence renders the page body into.
  function bodyEl(){return document.getElementById('main-content')||document.querySelector('.wiki-content');}
  // Session-row click → post "/attach <id>" as a comment; the bridge rewrites the body.
  // Delegated on document so it survives body innerHTML swaps. href is "#ccbb-attach-<id>".
  document.addEventListener('click',function(ev){
    var a=ev.target&&ev.target.closest?ev.target.closest('a[href^="#ccbb-attach-"]'):null;
    if(!a)return;
    ev.preventDefault();
    var sid=a.getAttribute('href').slice('#ccbb-attach-'.length);
    var s=document.getElementById('ccbbStat');if(s)s.textContent='opening '+sid.slice(0,8)+'…';
    fetch('/rest/api/content',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','Accept':'application/json','X-Atlassian-Token':'no-check'},
      body:JSON.stringify({type:'comment',container:{id:id,type:'page'},body:{storage:{value:'<p>/attach '+sid+'</p>',representation:'storage'}}})})
    .then(function(r){if(!r.ok&&s)s.textContent='open failed '+r.status;})
    .catch(function(e){if(s)s.textContent='open err '+e.message;});
  });
  // A single Claude turn appends many times (text, tool_use, tool_result…), bumping the
  // version repeatedly. Rather than swap on each bump, we swap once the version has held
  // STEADY for SETTLE ms — one update per burst. shownV is the version currently displayed;
  // lastV is the previous poll's value (to detect ongoing change).
  var SETTLE=Math.max(1500,POLL*2),shownV=null,lastV=null,stableAt=0,busy=false;
  function now(){return (performance&&performance.now)?performance.now():+new Date();}
  // Scroll handling is container-agnostic: we don't assume the window is the scroller
  // (Confluence may put the scrollbar on an inner wrapper). Instead we act on the LAST
  // transcript element. Only the session view has a .transcript; the list view doesn't
  // auto-scroll.
  function transcript(){return document.querySelector('.ccbb-app .transcript');}
  function isSession(){return !!transcript();}
  function lastTurn(){var t=transcript();return t&&t.lastElementChild;}
  // "Near the bottom" = the last turn's bottom edge is at or just past the viewport
  // bottom (within 200px). True regardless of which element actually scrolls.
  function nearBottom(){
    var el=lastTurn();
    if(!el)return true;
    var b=el.getBoundingClientRect().bottom;
    return b<=(window.innerHeight||document.documentElement.clientHeight)+200;
  }
  // Bring the last turn fully into view — scrolls every scrollable ancestor as needed, so
  // it works whether the window or an inner wrapper is the scroll container.
  function toBottom(){var el=lastTurn();if(el)el.scrollIntoView({block:'end',inline:'nearest'});}
  function swap(v){
    busy=true;
    // Was the user near the bottom BEFORE the swap? If they've scrolled up to review, leave
    // their position alone; otherwise follow the new content down.
    var follow=nearBottom();
    fetch('/rest/api/content/'+id+'?expand=body.view,version',{headers:{Accept:'application/json'},credentials:'same-origin'})
    .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
    .then(function(j){
      var el=bodyEl(),html=j.body&&j.body.view&&j.body.view.value;
      if(el&&html!=null){
        el.innerHTML=html;
        // Re-pin to bottom across a couple frames so it lands after layout settles.
        if(follow&&isSession()){requestAnimationFrame(function(){toBottom();requestAnimationFrame(toBottom);});}
      }
      shownV=j.version&&j.version.number;
      var s=document.getElementById('ccbbStat');if(s)s.textContent='v'+shownV+' · '+new Date().toLocaleTimeString();
    })
    .catch(function(e){var s=document.getElementById('ccbbStat');if(s)s.textContent='err '+e.message;})
    .then(function(){busy=false;});
  }
  function poll(){
    fetch('/rest/api/content/'+id+'?expand=version',{headers:{Accept:'application/json'},credentials:'same-origin'})
    .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
    .then(function(j){
      var v=j.version&&j.version.number,s=document.getElementById('ccbbStat');
      if(shownV===null){shownV=lastV=v;if(s)s.textContent='v'+v+' · watching';return;}
      if(v!==lastV){lastV=v;stableAt=now();if(s)s.textContent='v'+v+' · updating…';return;}
      // v has held steady since stableAt. Swap once it's been stable long enough AND it's
      // newer than what's on screen. Don't yank the body mid text-selection.
      if(v>shownV&&!busy&&now()-stableAt>=SETTLE){
        if(window.getSelection&&String(window.getSelection())){if(s)s.textContent='v'+v+' · update paused (selection)';return;}
        swap(v);
      }
    })
    .catch(function(e){var s=document.getElementById('ccbbStat');if(s)s.textContent='err '+e.message;});
  }
  // On first load of a session, reveal the latest turns. Confluence keeps reflowing during a
  // real page load (comments, sidebars, fonts, images), each reflow pushing the bottom down,
  // so a one-shot scroll lands too high. Re-pin to the bottom on an interval for ~4s, then a
  // few more times, until the page has settled.
  (function initBottom(){
    var n=0;
    var iv=setInterval(function(){
      n++;
      if(isSession())toBottom();
      if(n>=20)clearInterval(iv);   // 20 × 200ms = 4s of settling
    },200);
  })();
  poll();setInterval(poll,POLL);
})();`; }

// The live-view HTML macro, ready to append to a page body. Exported so the bridge can
// re-embed it on every body rewrite (each render drops the old macro and appends this).
function liveMacro(pollMs) {
  return '<ac:structured-macro ac:name="html"><ac:plain-text-body><![CDATA[<script>' +
    liveJs(pollMs != null ? pollMs : cf.pollMs) + '</script>]]></ac:plain-text-body></ac:structured-macro>';
}

async function main() {
  const pageId = process.argv[2] || cf.rootPageId;
  if (!pageId) { console.error('no pageId (pass one or set confluence.rootPageId)'); process.exit(1); }

  const page = await api('GET', `/content/${pageId}?expand=body.storage,version`);
  const cur = page.body.storage.value || '';
  const macro = liveMacro();
  // Keep any non-macro intro text, drop a previously-embedded live macro, then append fresh.
  const withoutOld = cur.replace(/<ac:structured-macro ac:name="html"[\s\S]*?<\/ac:structured-macro>/g, '');
  const intro = withoutOld.trim() || '<p>ccbb live session view.</p>';
  const body = intro + macro;

  await api('PUT', `/content/${pageId}`, {
    type: 'page',
    title: page.title,
    version: { number: page.version.number + 1 },
    body: { storage: { value: body, representation: 'storage' } },
  });
  console.log(`embedded live-view into page ${pageId} (v${page.version.number + 1}) — reload it in the browser`);
  console.log(`${BASE}/pages/viewpage.action?pageId=${pageId}`);
}

module.exports = { liveMacro, liveJs };

if (require.main === module) main().catch(e => { console.error('embed failed:', e.message); process.exit(1); });
