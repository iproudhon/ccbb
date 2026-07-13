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
// The watcher also turns the single root page into a stacked-views app (like `ccbb web`):
// the bridge renders the session LIST plus each attached session's TRANSCRIPT, stacked
// vertically, into the body. Because it's one page (no navigation), every view control is
// an <a href="#ccb-<verb>[-<arg>]"> (attach/detach/max/normal/refresh); the watcher
// intercepts the click and POSTs the matching /command comment same-origin, which the
// bridge reads and answers by rewriting the body. The comment POST needs the Confluence
// XSRF header `X-Atlassian-Token: no-check` (verified) but no token/proxy.
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
  // View-control click → post the matching /command as a comment; the bridge rewrites
  // the body. Delegated on document so it survives body innerHTML swaps. hrefs are
  // "#ccb-<verb>[-<arg>]" (single b — the bridge's markup kept the old ccb prefix):
  //   #ccb-attach-<id> → /attach <id>     #ccb-detach-<id> → /detach <id>
  //   #ccb-max-<id|list> → /max <id>      #ccb-normal → /normal    #ccb-refresh → /refresh
  // Escape text into a storage-format <p> body (the poller decodes entities back to text).
  function escXml(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  // Post a comment carrying text (a slash-command or a typed message). expedite makes the next
  // version bump swap immediately so the page reacts in ~1s instead of waiting out SETTLE.
  function postComment(text,label){
    var s=document.getElementById('ccbbStat');if(s)s.textContent=(label||text)+' …';
    return fetch('/rest/api/content',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','Accept':'application/json','X-Atlassian-Token':'no-check'},
      body:JSON.stringify({type:'comment',container:{id:id,type:'page'},body:{storage:{value:'<p>'+escXml(text)+'</p>',representation:'storage'}}})})
    .then(function(r){
      if(!r.ok){if(s)s.textContent=(label||text)+' failed '+r.status;return false;}
      expedite=true;clearTimeout(expTimer);expTimer=setTimeout(function(){expedite=false;},6000);
      [150,400,800,1400,2200,3200].forEach(function(d){setTimeout(poll,d);});
      return true;
    })
    .catch(function(e){if(s)s.textContent=(label||text)+' err '+e.message;return false;});
  }
  document.addEventListener('click',function(ev){
    // Composer send button → post the textarea's text as a message.
    var sb=ev.target&&ev.target.closest?ev.target.closest('.cbx-send'):null;
    if(sb){ev.preventDefault();var row=sb.closest('.cbx-row');var box=row&&row.querySelector('.cbx-box');if(box&&box.value.trim()){postComment(box.value.trim(),'message');box.value='';box.style.height='auto';}return;}
    var a=ev.target&&ev.target.closest?ev.target.closest('a[href^="#ccb-"]'):null;
    if(!a)return;
    ev.preventDefault();
    var raw=a.getAttribute('href').slice('#ccb-'.length);
    // Local-only control (no server round-trip): minimize/restore the fixed overlay so the
    // Confluence comment box underneath is reachable. Persisted so a body swap re-applies it.
    if(raw==='fs-min'){minimized=!minimized;applyMin();return;}
    // #ccb-ans-<n>-<sessionId> → answer a permission/question card for that session.
    var am=raw.match(/^ans-(\d+)-(.+)$/);
    if(am){postComment('/answer '+am[1]+' '+am[2],'answer '+am[1]);return;}
    var m=raw.match(/^(attach|detach|max)-(.*)$/);
    var cmd=m?('/'+m[1]+(m[2]?' '+m[2]:'')):('/'+raw);
    postComment(cmd);
  });
  // Composer: Enter sends, Shift+Enter makes a newline; auto-grow the textarea.
  document.addEventListener('keydown',function(ev){
    var box=ev.target&&ev.target.classList&&ev.target.classList.contains('cbx-box')?ev.target:null;
    if(!box)return;
    if(ev.key==='Enter'&&!ev.shiftKey){ev.preventDefault();if(box.value.trim()){postComment(box.value.trim(),'message');box.value='';box.style.height='auto';}}
  });
  document.addEventListener('input',function(ev){
    var box=ev.target&&ev.target.classList&&ev.target.classList.contains('cbx-box')?ev.target:null;
    if(!box)return;box.style.height='auto';box.style.height=Math.min(200,box.scrollHeight)+'px';
  });
  // A single Claude turn appends many times (text, tool_use, tool_result…), bumping the
  // version repeatedly. Rather than swap on each bump, we swap once the version has held
  // STEADY for SETTLE ms — one update per burst. shownV is the version currently displayed;
  // lastV is the previous poll's value (to detect ongoing change).
  var SETTLE=Math.max(1500,POLL*2),shownV=null,lastV=null,stableAt=0,busy=false;
  // expedite: set right after a user command POST so the next version bump swaps immediately
  // (no SETTLE wait). Layout clicks want instant feedback; streaming bursts want debouncing.
  var expedite=false,expTimer=null;
  function now(){return (performance&&performance.now)?performance.now():+new Date();}
  // Full-viewport overlay: the app is a fixed flex shell and each view scrolls in its OWN
  // .view-body (the web look). minimized drops it back to normal document flow so the
  // Confluence comment box is reachable; the state survives body swaps (re-applied after each).
  var minimized=false;
  function app(){return document.querySelector('.ccb-app');}
  function applyMin(){var a=app();if(a)a.classList.toggle('min',minimized);}
  // The scrolling container we track is the LAST expanded session's own .view-body — with
  // stacked views the bottom-most transcript is the one that grows. Each session view-body
  // holds a .transcript; the list view-body (.lv-body) does not, so we skip it.
  function scroller(){
    var bodies=document.querySelectorAll('.ccb-app .ccb-view .view-body');
    for(var i=bodies.length-1;i>=0;i--){if(bodies[i].querySelector('.transcript'))return bodies[i];}
    return null;
  }
  function isSession(){return !!scroller();}
  // "Near the bottom" of the tracked scroller (within 200px). If minimized (view-body flows
  // in the document), fall back to the last turn's viewport position.
  function nearBottom(){
    var sc=scroller();if(!sc)return true;
    if(minimized){var t=sc.querySelector('.transcript'),el=t&&t.lastElementChild;if(!el)return true;
      return el.getBoundingClientRect().bottom<=(window.innerHeight||document.documentElement.clientHeight)+200;}
    return sc.scrollHeight-sc.scrollTop-sc.clientHeight<=200;
  }
  // Pin the tracked scroller to its bottom (or scroll the last turn into view when minimized).
  function toBottom(){
    var sc=scroller();if(!sc)return;
    if(minimized){var t=sc.querySelector('.transcript'),el=t&&t.lastElementChild;if(el)el.scrollIntoView({block:'end',inline:'nearest'});}
    else sc.scrollTop=sc.scrollHeight;
  }
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
        applyMin();   // the swapped-in shell defaults to overlay; re-apply the local minimize state
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
      // Expedited (just after a command click): swap on the first newer version, no SETTLE.
      if(expedite&&v>shownV&&!busy){expedite=false;clearTimeout(expTimer);swap(v);return;}
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
