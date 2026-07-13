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
  var st=document.createElement('style');
  st.textContent='@keyframes ccbbspin{to{transform:rotate(360deg)}}'+
    '@keyframes ccbbpulse{0%,100%{opacity:1}50%{opacity:.45}}'+
    '.ccbb-spin{display:inline-block;width:9px;height:9px;border:2px solid #d0c7bd;border-top-color:#c96442;border-radius:50%;animation:ccbbspin .7s linear infinite;vertical-align:-1px;margin-right:2px}'+
    '#ccbbPill.busy{border-color:#c96442;box-shadow:0 2px 10px rgba(201,100,66,.35)}'+
    '#ccbbPill.ok{border-color:#2da44e}'+
    // The clicked control shows it is working in-place: pulsing + a trailing mini-spinner,
    // pointer disabled so a second click cannot queue a duplicate command mid-flight.
    '.ccbb-busy{position:relative;animation:ccbbpulse 1s ease-in-out infinite;pointer-events:none}'+
    '.ccbb-busy::after{content:"";display:inline-block;width:9px;height:9px;margin-left:6px;border:2px solid rgba(201,100,66,.35);border-top-color:#c96442;border-radius:50%;animation:ccbbspin .7s linear infinite;vertical-align:-1px}'+
    // A whole-view working veil (dims the target view-body while its rewrite is pending), so
    // the wait reads even for clicks whose element vanishes on swap (e.g. attach → new view).
    '.ccbb-working{position:relative}'+
    '.ccbb-working::before{content:"";position:absolute;inset:0;background:rgba(250,249,245,.35);z-index:5;pointer-events:none}';
  document.head.appendChild(st);
  var pill=document.createElement('div');
  pill.id='ccbbPill';
  pill.style.cssText='position:fixed;right:12px;bottom:12px;z-index:2147483647;background:#fff;border:1px solid #ccc;border-radius:6px;padding:4px 10px;font:12px/1.4 monospace;color:#666;box-shadow:0 2px 8px rgba(0,0,0,.2)';
  pill.innerHTML='<b>ccbb live</b> <span id=ccbbStat></span>';
  document.body.appendChild(pill);
  // Pill status helper: html body + a phase class ('busy' while a command is in flight /
  // awaiting the server rewrite, 'ok' briefly after it lands, '' for idle watching).
  function setStat(html,phase){
    var s=document.getElementById('ccbbStat');if(s)s.innerHTML=html;
    var p=document.getElementById('ccbbPill');if(p)p.className=phase||'';
  }
  var spin='<span class=ccbb-spin></span>';
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
  // pending tracks a command in flight: from POST until the server's body rewrite lands
  // (a version bump we swap in). A ticking timer shows elapsed ms so the wait is visible.
  var pending=null,pendTimer=null,busyEl=null;
  // Mark the clicked control (and its enclosing view-body) as working; cleared when the
  // rewrite lands. Cleared defensively too — a body swap may replace the element outright.
  function markBusy(el){
    clearBusy();
    if(!el)return;
    busyEl=el;el.classList.add('ccbb-busy');
    var vb=el.closest?el.closest('.view-body'):null;if(vb)vb.classList.add('ccbb-working');
  }
  function clearBusy(){
    if(busyEl){try{busyEl.classList.remove('ccbb-busy');}catch(e){}}
    var vs=document.querySelectorAll('.ccbb-working');for(var i=0;i<vs.length;i++)vs[i].classList.remove('ccbb-working');
    busyEl=null;
  }
  function pendTick(){
    if(!pending)return;
    var secs=((now()-pending.t0)/1000).toFixed(1);
    setStat(spin+pending.label+' · waiting for ccbb… '+secs+'s','busy');
  }
  function startPending(label){
    pending={label:label,t0:now()};
    clearInterval(pendTimer);pendTimer=setInterval(pendTick,100);pendTick();
  }
  function endPending(v){
    if(!pending)return;
    var secs=((now()-pending.t0)/1000).toFixed(1);
    clearInterval(pendTimer);pending=null;clearBusy();
    setStat('✓ updated v'+v+' · '+secs+'s','ok');
    setTimeout(function(){if(!pending)setStat('v'+v+' · watching','');},2500);
  }
  function postComment(text,label,srcEl){
    var lbl=label||text;
    markBusy(srcEl);
    setStat(spin+'sending '+lbl+'…','busy');
    return fetch('/rest/api/content',{method:'POST',credentials:'same-origin',
      headers:{'Content-Type':'application/json','Accept':'application/json','X-Atlassian-Token':'no-check'},
      body:JSON.stringify({type:'comment',container:{id:id,type:'page'},body:{storage:{value:'<p>'+escXml(text)+'</p>',representation:'storage'}}})})
    .then(function(r){
      if(!r.ok){setStat(lbl+' failed '+r.status,'');clearBusy();return false;}
      startPending(lbl);
      expedite=true;clearTimeout(expTimer);expTimer=setTimeout(function(){expedite=false;},8000);
      // Fast re-polls: the server discovers the comment on its own hot-loop tick (~150ms),
      // rewrites the body, and one of these polls catches the version bump and swaps.
      [120,260,420,650,900,1300,1800,2500,3400].forEach(function(d){setTimeout(poll,d);});
      return true;
    })
    .catch(function(e){setStat(lbl+' err '+e.message,'');clearBusy();return false;});
  }
  document.addEventListener('click',function(ev){
    // Composer send button → post the textarea's text as a message.
    var sb=ev.target&&ev.target.closest?ev.target.closest('.cbx-send'):null;
    if(sb){ev.preventDefault();var row=sb.closest('.cbx-row');var box=row&&row.querySelector('.cbx-box');if(box&&box.value.trim()){postComment(box.value.trim(),'message',sb);box.value='';box.style.height='auto';}return;}
    var a=ev.target&&ev.target.closest?ev.target.closest('a[href^="#ccb-"]'):null;
    if(!a)return;
    ev.preventDefault();
    var raw=a.getAttribute('href').slice('#ccb-'.length);
    // ── Local-only controls (no server round-trip): layout is owned client-side. ──
    if(raw==='fs-min'){minimized=!minimized;applyMin();return;}   // full-screen ↔ inline
    if(raw==='orient'){toggleOrient();return;}                    // vertical ↔ horizontal
    if(raw==='normal'){maxed=null;applyLayout();return;}          // restore all
    var mm=raw.match(/^max-(.+)$/);if(mm){toggleMax(mm[1]);return;}
    var cm=raw.match(/^close-(.+)$/);if(cm){closeView(cm[1]);return;}
    // ── Server-backed controls (need a comment round-trip). ──
    // #ccb-ans-<n>-<sessionId> → answer a permission/question card for that session.
    var am=raw.match(/^ans-(\d+)-(.+)$/);
    if(am){postComment('/answer '+am[1]+' '+am[2],'answer '+am[1],a);return;}
    // attach/detach start/stop server-side transcript watching, so they still post a comment.
    var m=raw.match(/^(attach|detach)-(.*)$/);
    var cmd=m?('/'+m[1]+(m[2]?' '+m[2]:'')):('/'+raw);
    postComment(cmd,null,a);
  });
  // Composer: Enter sends, Shift+Enter makes a newline; auto-grow the textarea.
  document.addEventListener('keydown',function(ev){
    var box=ev.target&&ev.target.classList&&ev.target.classList.contains('cbx-box')?ev.target:null;
    if(!box)return;
    if(ev.key==='Enter'&&!ev.shiftKey){ev.preventDefault();if(box.value.trim()){var sbtn=box.closest('.cbx-row');sbtn=sbtn&&sbtn.querySelector('.cbx-send');postComment(box.value.trim(),'message',sbtn||box);box.value='';box.style.height='auto';}}
  });
  document.addEventListener('input',function(ev){
    var box=ev.target&&ev.target.classList&&ev.target.classList.contains('cbx-box')?ev.target:null;
    if(!box)return;box.style.height='auto';box.style.height=Math.min(200,box.scrollHeight)+'px';
  });
  // Cost-summary period selector: purely local (every period's table is pre-rendered into a
  // hidden .sum-pane). Switching shows the chosen pane + updates the scope cost. sumScope
  // persists so a body swap re-applies the selection (applyLayout re-runs applySumScope).
  var sumScope=null;
  function applySumScope(){
    var sum=document.querySelector('.summary');if(!sum)return;
    var sel=sum.querySelector('.sum-scope');if(!sel)return;
    if(sumScope&&sel.querySelector('option[value="'+(window.CSS&&CSS.escape?CSS.escape(sumScope):sumScope)+'"]'))sel.value=sumScope;
    else sumScope=sel.value;
    var panes=sum.querySelectorAll('.sum-pane');
    for(var i=0;i<panes.length;i++)panes[i].style.display=(panes[i].getAttribute('data-scope')===sel.value)?'':'none';
    var cost=sum.querySelector('.scope-cost');
    if(cost){try{var m=JSON.parse(sum.getAttribute('data-scope-costs')||'{}');if(m[sel.value]!=null)cost.textContent=m[sel.value];}catch(e){}}
  }
  document.addEventListener('change',function(ev){
    var sel=ev.target&&ev.target.classList&&ev.target.classList.contains('sum-scope')?ev.target:null;
    if(!sel)return;sumScope=sel.value;applySumScope();
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
  // ── Client-side layout (no server round-trip) ──────────────────────────────────
  // The server renders a canonical baseline (every view expanded, vertical, none maxed). The
  // watcher owns the layout: orient ('vertical'|'horizontal'), maxed (a view's data-id | null),
  // and hidden (a set of closed session data-ids). applyLayout() re-applies this to the DOM and
  // runs after every body swap so the layout survives server re-renders. Mirrors ccbb web's
  // relayout(): in horizontal, .ccb-views is a 2-row grid, columns sized here; a maxed view's
  // body spans the whole row while peers collapse to their (abbreviated) tab bars.
  var orient='vertical',maxed=null,hidden={};
  function views(){return [].slice.call(document.querySelectorAll('.ccb-app .ccb-view'));}
  function abbrev(t){t=(t||'').trim();return t.length>10?t.slice(0,9)+'…':t;}
  function applyLayout(){
    var vs=document.querySelector('.ccb-app .ccb-views');if(!vs)return;
    var horiz=orient==='horizontal';
    vs.classList.toggle('horizontal',horiz);
    var list=views(),shown=[];
    // If the maxed view was closed/gone, drop the maxed state.
    if(maxed&&!document.querySelector('.ccb-app .ccb-view[data-id="'+cssEsc(maxed)+'"]'))maxed=null;
    for(var i=0;i<list.length;i++){
      var v=list[i],vid=v.getAttribute('data-id');
      var isHidden=vid!=='list'&&hidden[vid];
      v.style.display=isHidden?'none':'';
      var collapsed=!!(maxed&&vid!==maxed)&&!isHidden;
      v.classList.toggle('collapsed',collapsed);
      // Max button glyph + title reflect this view's state.
      var mx=v.querySelector('.vb-max');
      if(mx){var on=maxed===vid;mx.innerHTML=on?'❐':'□';mx.title=on?'Restore (show all)':'Maximize';}
      // Horizontal collapsed tabs shrink to an abbreviated title so the row fits.
      var ttl=v.querySelector('.vb-title .vb-tgl');
      if(ttl){var full=ttl.getAttribute('data-full')||ttl.textContent;ttl.setAttribute('data-full',full);
        ttl.textContent=(horiz&&collapsed)?abbrev(full):full;}
      if(!isHidden)shown.push(v);
    }
    // Horizontal grid column sizing (mirror web): equal columns normally; maxed → that column
    // takes the row (1fr) and the rest shrink to their tab width (auto).
    if(horiz){
      vs.style.gridTemplateColumns=maxed
        ?shown.map(function(v){return v.getAttribute('data-id')===maxed?'1fr':'auto';}).join(' ')
        :'repeat('+shown.length+',1fr)';
      shown.forEach(function(v){var b=v.querySelector('.view-body');if(b)b.style.gridColumn=(maxed&&v.getAttribute('data-id')===maxed)?'1 / -1':'';});
    }else{
      vs.style.gridTemplateColumns='';
      shown.forEach(function(v){var b=v.querySelector('.view-body');if(b)b.style.gridColumn='';});
    }
  }
  function cssEsc(s){return (window.CSS&&CSS.escape)?CSS.escape(s):String(s).replace(/["\\\]]/g,'\\$&');}
  function toggleMax(vid){maxed=(maxed===vid)?null:vid;applyLayout();}
  function toggleOrient(){orient=(orient==='horizontal')?'vertical':'horizontal';applyLayout();}
  function closeView(vid){if(vid==='list')return;hidden[vid]=true;if(maxed===vid)maxed=null;applyLayout();}
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
        applyMin();      // the swapped-in shell defaults to overlay; re-apply local minimize
        applyLayout();   // re-apply local orient/maxed/hidden (server rendered the baseline)
        applySumScope(); // re-apply the locally-chosen cost-summary period
        // Re-pin to bottom across a couple frames so it lands after layout settles.
        if(follow&&isSession()){requestAnimationFrame(function(){toBottom();requestAnimationFrame(toBottom);});}
      }
      shownV=j.version&&j.version.number;
      // A command in flight is done the moment its rewrite is on screen — report elapsed.
      if(pending)endPending(shownV);
      else setStat('v'+shownV+' · '+new Date().toLocaleTimeString(),'');
    })
    .catch(function(e){setStat('err '+e.message,pending?'busy':'');})
    .then(function(){busy=false;});
  }
  function poll(){
    fetch('/rest/api/content/'+id+'?expand=version',{headers:{Accept:'application/json'},credentials:'same-origin'})
    .then(function(r){if(!r.ok)throw new Error(r.status);return r.json();})
    .then(function(j){
      var v=j.version&&j.version.number;
      if(shownV===null){shownV=lastV=v;setStat('v'+v+' · watching','');return;}
      // Expedited (just after a command click): swap on the first newer version, no SETTLE.
      if(expedite&&v>shownV&&!busy){expedite=false;clearTimeout(expTimer);swap(v);return;}
      if(v!==lastV){lastV=v;stableAt=now();if(!pending)setStat('v'+v+' · updating…','');return;}
      // v has held steady since stableAt. Swap once it's been stable long enough AND it's
      // newer than what's on screen. Don't yank the body mid text-selection.
      if(v>shownV&&!busy&&now()-stableAt>=SETTLE){
        if(window.getSelection&&String(window.getSelection())){if(!pending)setStat('v'+v+' · update paused (selection)','');return;}
        swap(v);
      }
    })
    .catch(function(e){setStat('err '+e.message,pending?'busy':'');});
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
  applyLayout();   // baseline is already server-rendered; this is a no-op until layout changes
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
