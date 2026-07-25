'use strict';
// ── ccbb-stats.js ────────────────────────────────────────────────────────────
// The `skel` and `stats` subcommands.
//
//   ccbb skel [-o file.json]              extract privacy-safe skeletons for every
//                                         discoverable session into one JSON file.
//   ccbb stats <file.json...> [options]   read one or more skeleton files, dedup by
//                                         fingerprint, and render a self-contained
//                                         HTML report (histograms + response-time charts).
//
// Skeletons carry NO content — only structure + token/timing numbers. See
// buildSkeleton in ccbb-common.js. All charting is inline SVG in the emitted page;
// the page opens offline with zero dependencies.

const fs = require('fs');
const path = require('path');
const common = require('./ccbb-common');

// Only responses from these model families are included in the report. One place to edit.
const MODEL_INCLUDE = [/haiku/i, /sonnet/i, /opus/i, /fable/i];

// ── ccbb skel ─────────────────────────────────────────────────────────────────
function runSkel(argv) {
  let out = 'ccbb-skeleton.json';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return skelHelp();
    else if (a === '-o' || a === '--out') out = argv[++i];
    else if (a.startsWith('--out=')) out = a.slice(6);
    else { console.error(`ccbb skel: unexpected argument '${a}'`); process.exit(1); }
  }
  const coll = common.buildAllSkeletons();
  fs.writeFileSync(out, JSON.stringify(coll));
  const responses = coll.sessions.reduce((n, s) => n + s.responses.length, 0);
  console.log(`ccbb skel: ${coll.count} sessions, ${responses} responses → ${out}`);
}
function skelHelp() {
  console.log(`ccbb skel — extract privacy-safe session skeletons

Usage:
  ccbb skel [-o file.json]

Writes one JSON file holding a structural fingerprint + numeric response rows for
every discoverable session. No message content, prompts, paths, or titles are kept.

  -o, --out <file>   output path (default ccbb-skeleton.json)`);
}

// ── ccbb stats ──────────────────────────────────────────────────────────────
function runStats(argv) {
  let out = 'ccbb-stats.html', log = false;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return statsHelp();
    else if (a === '-o' || a === '--out') out = argv[++i];
    else if (a.startsWith('--out=')) out = a.slice(6);
    else if (a === '--log') log = true;
    else if (a.startsWith('-')) { console.error(`ccbb stats: unknown option '${a}'`); process.exit(1); }
    else files.push(a);
  }
  if (!files.length) { console.error('ccbb stats: no input files. Try: ccbb stats *.json'); process.exit(1); }

  // Load + dedup sessions by fingerprint (first file wins).
  const seen = new Set();
  const sessions = [];
  for (const f of files) {
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
      console.error(`ccbb stats: cannot read ${f}: ${e.message}`); process.exit(1);
    }
    const arr = Array.isArray(data) ? data : (data.sessions || []);
    for (const s of arr) {
      const key = s.fingerprint || s.sessionId;
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      sessions.push(s);
    }
  }

  // Flatten + filter responses to the allow-listed models.
  const rows = [];
  for (const s of sessions) {
    for (const r of (s.responses || [])) {
      if (!MODEL_INCLUDE.some(re => re.test(r.model || ''))) continue;
      rows.push({
        promptTokens: r.promptTokens || 0,
        output: r.output || 0,
        cacheRead: r.cacheRead || 0,
        cacheWrite: r.cacheWrite || 0,
        respMs: (typeof r.respMs === 'number') ? r.respMs : null,
        hour: (typeof r.hour === 'number') ? r.hour : null,
      });
    }
  }
  if (!rows.length) { console.error('ccbb stats: no responses matched the filter.'); process.exit(1); }

  const meta = {
    log,
    sessions: sessions.length,
    responses: rows.length,
    withTiming: rows.filter(r => r.respMs != null).length,
    files: files.map(f => path.basename(f)),
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(out, renderHtml(rows, meta));
  console.log(`ccbb stats: ${meta.sessions} sessions, ${meta.responses} responses → ${out}`);
}
function statsHelp() {
  console.log(`ccbb stats — render an HTML report from skeleton files

Usage:
  ccbb stats <file.json...> [options]

Reads one or more skeleton JSON files (glob is fine, e.g. *.json), dedups sessions
by fingerprint, and writes a self-contained HTML report with token-count histograms
and response-time charts. Only haiku/sonnet/opus/fable models are included.

  --log              start with log-scaled axes/bins (default off; toggleable in the page).
  -o, --out <file>   output path (default ccbb-stats.html)`);
}

// ── HTML rendering ────────────────────────────────────────────────────────────
// One self-contained page. Data + config are embedded as JSON; all binning and SVG
// drawing happen client-side so the log toggle recomputes without a rebuild.
function renderHtml(rows, meta) {
  const payload = JSON.stringify({ rows, meta }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccbb session stats</title>
<style>
:root{
  --plane:#f9f9f7; --surface:#fcfcfb; --primary:#0b0b0b; --secondary:#52514e;
  --muted:#898781; --grid:#e1e0d9; --axis:#c3c2b7; --series:#2a78d6; --series-soft:#9ec5f4;
  --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a;
  --border:rgba(11,11,11,0.10);
}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])){
  --plane:#0d0d0d; --surface:#1a1a19; --primary:#fff; --secondary:#c3c2b7;
  --muted:#898781; --grid:#2c2c2a; --axis:#383835; --series:#3987e5; --series-soft:#184f95;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70;
  --border:rgba(255,255,255,0.10);
}}
:root[data-theme="dark"]{
  --plane:#0d0d0d; --surface:#1a1a19; --primary:#fff; --secondary:#c3c2b7;
  --muted:#898781; --grid:#2c2c2a; --axis:#383835; --series:#3987e5; --series-soft:#184f95;
  --s1:#3987e5; --s2:#d95926; --s3:#199e70;
  --border:rgba(255,255,255,0.10);
}
*{box-sizing:border-box}
body{margin:0;background:var(--plane);color:var(--primary);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5}
.wrap{max-width:1000px;margin:0 auto;padding:28px 20px 64px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--secondary);font-size:13px;margin:0 0 20px}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 24px}
.tile{background:var(--surface);border:1px solid var(--border);border-radius:10px;
  padding:12px 16px;min-width:120px}
.tile .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.tile .k{color:var(--muted);font-size:12px;margin-top:2px}
.ctrl{display:flex;align-items:center;gap:8px;margin:0 0 20px;color:var(--secondary);font-size:13px}
.ctrl input{accent-color:var(--series)}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;
  padding:16px 16px 8px;margin:0 0 20px;overflow-x:auto}
.card h2{font-size:15px;margin:0 0 2px}
.card .desc{color:var(--muted);font-size:12px;margin:0 0 8px}
svg{display:block;max-width:100%;height:auto}
.tick{fill:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}
.axl{fill:var(--secondary);font-size:12px}
.grid{stroke:var(--grid);stroke-width:1}
.axis{stroke:var(--axis);stroke-width:1}
.bar{fill:var(--series)}
.seg1{fill:var(--s1)}.seg2{fill:var(--s2)}.seg3{fill:var(--s3)}
.dot{fill:var(--series);fill-opacity:.55}
.line{fill:none;stroke:var(--series);stroke-width:2}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 8px;color:var(--secondary);font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.tip{position:fixed;pointer-events:none;background:var(--surface);color:var(--primary);
  border:1px solid var(--border);border-radius:8px;padding:6px 9px;font-size:12px;
  box-shadow:0 4px 14px rgba(0,0,0,.18);opacity:0;transition:opacity .08s;white-space:nowrap;z-index:9}
.tip b{font-variant-numeric:tabular-nums}
.foot{color:var(--muted);font-size:12px;margin-top:8px}
</style>
</head>
<body>
<div class="wrap">
  <h1>ccbb session stats</h1>
  <p class="sub" id="sub"></p>
  <div class="tiles" id="tiles"></div>
  <div class="ctrl">
    <label><input type="checkbox" id="logToggle"> log scaling (histogram bins &amp; response-time axis)</label>
    <label style="margin-left:20px"><input type="checkbox" id="outToggle"> remove outliers (0-size &amp; 0-response, or response &gt; 10&nbsp;min)</label>
  </div>
  <div class="card"><h2>Prompt Size Distribution</h2><p class="desc">responses binned by total prompt (cache-read + cache-write + decode); each bar stacked by token-type share of that bin</p>
    <div class="legend"><span><i style="background:var(--s1)"></i>cache read</span><span><i style="background:var(--s2)"></i>cache write</span><span><i style="background:var(--s3)"></i>decode</span></div><div id="stack-count"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Response Time</h2><p class="desc">avg response time binned by total prompt; each bar stacked by token-type share of that bin</p>
    <div class="legend"><span><i style="background:var(--s1)"></i>cache read</span><span><i style="background:var(--s2)"></i>cache write</span><span><i style="background:var(--s3)"></i>decode</span></div><div id="stack-resp"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Decode</h2><p class="desc">avg decode (output) tokens per response, binned by total prompt</p><div id="avg-decode"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Cache Write</h2><p class="desc">avg cache-write tokens per response, binned by total prompt</p><div id="avg-cw"></div></div>
  <div class="card"><h2>Prompt&nbsp;+&nbsp;output size&nbsp;→&nbsp;response time</h2><p class="desc">each dot is one response (main-transcript responses with timing)</p><div id="scatter"></div></div>
  <div class="card"><h2>Time of day&nbsp;→&nbsp;avg response time</h2><p class="desc">mean response time by local hour</p><div id="hour"></div></div>
  <p class="foot" id="foot"></p>
</div>
<div class="tip" id="tip"></div>
<script>
const DATA = ${payload};
const rows = DATA.rows, meta = DATA.meta;
// Outlier removal (toggle): drop responses with no size and no timing, or a response
// time over 10 minutes (idle-gap / resumed-session artifacts). ACTIVE feeds every chart.
function isOutlier(r){
  const size = r.promptTokens + r.output;
  if(size === 0 && (r.respMs == null || r.respMs === 0)) return true;
  if(r.respMs != null && r.respMs > 600000) return true;
  return false;
}
let ACTIVE = rows;
function totalPrompt(r){ return r.cacheRead + r.cacheWrite + r.output; }
const tip = document.getElementById('tip');
function showTip(html, e){ tip.innerHTML = html; tip.style.opacity = 1;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top  = (e.clientY - tip.offsetHeight - 10) + 'px'; }
function hideTip(){ tip.style.opacity = 0; }
const SVGNS = 'http://www.w3.org/2000/svg';
function el(n, a){ const x = document.createElementNS(SVGNS, n); for(const k in a) x.setAttribute(k, a[k]); return x; }
function fmt(n){ n = Math.round(n);
  if(Math.abs(n) >= 1e6) return (n/1e6).toFixed(1)+'M';
  if(Math.abs(n) >= 1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function fmtMs(ms){ return ms >= 10000 ? (ms/1000).toFixed(0)+'s' : (ms/1000).toFixed(1)+'s'; }

const W = 920, H = 260, M = {t:14, r:16, b:40, l:52};
const IW = W - M.l - M.r, IH = H - M.t - M.b;

// Histogram: 24 bins, linear or log10 spaced (log ignores zeros, shown as a separate note).
function niceStep(x){ const p = Math.pow(10, Math.floor(Math.log10(x))); const f = x/p;
  return (f<=1?1:f<=2?2:f<=5?5:10)*p; }
function histBins(vals, log, N){
  N = N || 24;
  if(log){
    const pos = vals.filter(v => v > 0);
    if(!pos.length) return {bins:[], zeros:vals.length, log:true};
    const lo = Math.log10(Math.max(1, Math.min(...pos))), hi = Math.log10(Math.max(...pos));
    const span = (hi - lo) || 1, w = span / N;
    const bins = Array.from({length:N}, (_,i) => ({lo:Math.pow(10,lo+i*w), hi:Math.pow(10,lo+(i+1)*w), c:0}));
    for(const v of pos){ let i = Math.floor((Math.log10(v)-lo)/w); if(i<0)i=0; if(i>=N)i=N-1; bins[i].c++; }
    return {bins, zeros:vals.length-pos.length, log:true};
  }
  const max = Math.max(...vals, 1), step = niceStep(max / N) || 1;
  const n = Math.max(1, Math.ceil((max + 1e-9) / step));
  const bins = Array.from({length:n}, (_,i) => ({lo:i*step, hi:(i+1)*step, c:0}));
  for(const v of vals){ let i = Math.floor(v/step); if(i>=n)i=n-1; if(i<0)i=0; bins[i].c++; }
  return {bins, zeros:0, log:false};
}
function drawScatter(log){
  const host = document.getElementById('scatter'); host.innerHTML = '';
  const pts = ACTIVE.filter(r => r.respMs != null).map(r => ({x:r.promptTokens + r.output, y:r.respMs}));
  const svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  if(!pts.length){ host.appendChild(svg); return; }
  const xMax = Math.max(...pts.map(p => p.x), 1);
  const yv = v => log ? Math.log10(Math.max(1, v)) : v;
  const yMax = Math.max(...pts.map(p => yv(p.y)), yv(1));
  const yMin = log ? 0 : 0;
  const sx = v => M.l + IW * v / xMax;
  const sy = v => M.t + IH - IH * (yv(v) - yMin) / ((yMax - yMin) || 1);
  for(let g=0; g<=4; g++){ const y = M.t + IH - IH*g/4;
    svg.appendChild(el('line',{class:'grid',x1:M.l,y1:y,x2:M.l+IW,y2:y}));
    const raw = log ? Math.pow(10, yMin + (yMax-yMin)*g/4) : (yMax*g/4);
    const t = el('text',{class:'tick',x:M.l-8,y:y+4,'text-anchor':'end'}); t.textContent = fmtMs(raw); svg.appendChild(t); }
  svg.appendChild(el('line',{class:'axis',x1:M.l,y1:M.t+IH,x2:M.l+IW,y2:M.t+IH}));
  for(let g=0; g<=4; g++){ const x = M.l + IW*g/4;
    const t = el('text',{class:'tick',x,y:M.t+IH+16,'text-anchor':'middle'}); t.textContent = fmt(xMax*g/4); svg.appendChild(t); }
  for(const p of pts){
    const c = el('circle',{class:'dot',cx:sx(p.x),cy:sy(p.y),r:3.5});
    c.addEventListener('mousemove', e => showTip('<b>'+fmt(p.x)+'</b> tok in+out<br><b>'+fmtMs(p.y)+'</b> response', e));
    c.addEventListener('mouseleave', hideTip); svg.appendChild(c);
  }
  const xl = el('text',{class:'axl',x:M.l+IW/2,y:H-4,'text-anchor':'middle'});
  xl.textContent = 'prompt + output tokens'; svg.appendChild(xl);
  const yl = el('text',{class:'axl',x:-(M.t+IH/2),y:14,'text-anchor':'middle',transform:'rotate(-90)'});
  yl.textContent = 'response time' + (log ? ' (log)' : ''); svg.appendChild(yl);
  host.appendChild(svg);
}

function drawHour(log){
  const host = document.getElementById('hour'); host.innerHTML = '';
  const sum = Array(24).fill(0), cnt = Array(24).fill(0);
  for(const r of ACTIVE){ if(r.respMs != null && r.hour != null){ sum[r.hour]+=r.respMs; cnt[r.hour]++; } }
  const avg = sum.map((s,i) => cnt[i] ? s/cnt[i] : null);
  const svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  const yv = v => log ? Math.log10(Math.max(1, v)) : v;
  const present = avg.filter(v => v != null);
  const yMax = present.length ? Math.max(...present.map(yv)) : 1;
  const sx = h => M.l + IW * h / 23;
  const sy = v => M.t + IH - IH * (yv(v)) / (yMax || 1);
  for(let g=0; g<=4; g++){ const y = M.t + IH - IH*g/4;
    svg.appendChild(el('line',{class:'grid',x1:M.l,y1:y,x2:M.l+IW,y2:y}));
    const raw = log ? Math.pow(10, yMax*g/4) : (yMax*g/4);
    const t = el('text',{class:'tick',x:M.l-8,y:y+4,'text-anchor':'end'}); t.textContent = fmtMs(raw); svg.appendChild(t); }
  svg.appendChild(el('line',{class:'axis',x1:M.l,y1:M.t+IH,x2:M.l+IW,y2:M.t+IH}));
  for(let h=0; h<24; h+=3){ const t = el('text',{class:'tick',x:sx(h),y:M.t+IH+16,'text-anchor':'middle'});
    t.textContent = h; svg.appendChild(t); }
  // line across contiguous present hours
  let d = '', started = false;
  for(let h=0; h<24; h++){ if(avg[h]==null){ started=false; continue; }
    d += (started?' L':'M') + sx(h).toFixed(1) + ' ' + sy(avg[h]).toFixed(1); started=true; }
  if(d) svg.appendChild(el('path',{class:'line',d}));
  for(let h=0; h<24; h++){ if(avg[h]==null) continue;
    const c = el('circle',{class:'dot',cx:sx(h),cy:sy(avg[h]),r:4,'fill-opacity':1});
    c.addEventListener('mousemove', e => showTip('<b>'+String(h).padStart(2,'0')+':00</b><br><b>'+fmtMs(avg[h])+'</b> avg · '+cnt[h]+' resp', e));
    c.addEventListener('mouseleave', hideTip); svg.appendChild(c); }
  const xl = el('text',{class:'axl',x:M.l+IW/2,y:H-4,'text-anchor':'middle'}); xl.textContent = 'hour of day (local)'; svg.appendChild(xl);
  host.appendChild(svg);
}

// Total-prompt-binned stacked bars. Bar height = the metric ('count' of responses, or
// 'resp' = avg response time in the bin); each bar is split into cache-read / cache-write /
// decode segments by that bin's aggregate token share. x bins follow the log toggle.
function drawStacked(id, metric, log){
  const host = document.getElementById(id); host.innerHTML = '';
  const src = metric === 'resp' ? ACTIVE.filter(r => r.respMs != null) : ACTIVE;
  const svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  if(!src.length){ host.appendChild(svg); return; }
  const {bins, log:isLog} = histBins(src.map(totalPrompt), log, 96);
  const agg = bins.map(b => ({lo:b.lo, hi:b.hi, n:0, resp:0, rc:0, cr:0, cw:0, dec:0}));
  const idxOf = v => { let i = bins.findIndex(b => v >= b.lo && v < b.hi);
    if(i < 0) i = (v < bins[0].lo) ? 0 : bins.length - 1; return i; };
  for(const r of src){ const a = agg[idxOf(totalPrompt(r))];
    a.n++; a.cr += r.cacheRead; a.cw += r.cacheWrite; a.dec += r.output;
    if(r.respMs != null){ a.resp += r.respMs; a.rc++; } }
  const heightOf = a => metric === 'count' ? a.n : (a.rc ? a.resp / a.rc : 0);
  const fmtY = v => metric === 'count' ? String(Math.round(v)) : fmtMs(v);
  const maxH = Math.max(1, ...agg.map(heightOf));
  for(let g=0; g<=4; g++){ const y = M.t + IH - IH*g/4;
    svg.appendChild(el('line',{class:'grid',x1:M.l,y1:y,x2:M.l+IW,y2:y}));
    const t = el('text',{class:'tick',x:M.l-8,y:y+4,'text-anchor':'end'}); t.textContent = fmtY(maxH*g/4); svg.appendChild(t); }
  svg.appendChild(el('line',{class:'axis',x1:M.l,y1:M.t+IH,x2:M.l+IW,y2:M.t+IH}));
  const bw = IW / agg.length;
  agg.forEach((a,i) => {
    const h = IH * heightOf(a) / maxH, x = M.l + i*bw, tot = a.cr + a.cw + a.dec || 1;
    let y = M.t + IH;
    for(const [cls,val] of [['seg1',a.cr],['seg2',a.cw],['seg3',a.dec]]){
      const sh = h * val / tot; if(sh <= 0) continue; y -= sh;
      svg.appendChild(el('rect',{class:cls, x:x+1, y, width:Math.max(1,bw-2), height:sh}));
    }
    if(heightOf(a) > 0){
      const seg = (v) => fmt(v / a.n) + ' (' + Math.round(100 * v / tot) + '%)';  // avg per response
      const hit = el('rect',{x:x+1, y:M.t+IH-h, width:Math.max(1,bw-2), height:h, fill:'transparent'});
      hit.addEventListener('mousemove', e => showTip('<b>'+fmt(a.lo)+'</b>–<b>'+fmt(a.hi)+'</b> tok<br>'+
        (metric === 'count' ? '<b>'+a.n+'</b> responses' : '<b>'+fmtMs(a.rc?a.resp/a.rc:0)+'</b> avg · '+a.n+' resp')+
        '<br>read '+seg(a.cr)+'<br>write '+seg(a.cw)+'<br>decode '+seg(a.dec), e));
      hit.addEventListener('mouseleave', hideTip); svg.appendChild(hit);
    }
    if(i % Math.ceil(agg.length/8) === 0){
      const t = el('text',{class:'tick',x,y:M.t+IH+16,'text-anchor':'middle'}); t.textContent = fmt(a.lo); svg.appendChild(t); }
  });
  const xl = el('text',{class:'axl',x:M.l+IW/2,y:H-4,'text-anchor':'middle'});
  xl.textContent = 'total prompt tokens' + (isLog ? ' (log bins)' : ''); svg.appendChild(xl);
  host.appendChild(svg);
}

// Simple (non-stacked) bar chart: for each total-prompt bin, y = average of the given
// token field per response in that bin.
function drawAvgBar(id, field, colorClass, log){
  const host = document.getElementById(id); host.innerHTML = '';
  const src = ACTIVE;
  const svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  if(!src.length){ host.appendChild(svg); return; }
  const {bins, log:isLog} = histBins(src.map(totalPrompt), log, 96);
  const agg = bins.map(b => ({lo:b.lo, hi:b.hi, n:0, sum:0}));
  const idxOf = v => { let i = bins.findIndex(b => v >= b.lo && v < b.hi);
    if(i < 0) i = (v < bins[0].lo) ? 0 : bins.length - 1; return i; };
  for(const r of src){ const a = agg[idxOf(totalPrompt(r))]; a.n++; a.sum += r[field]; }
  const avgOf = a => a.n ? a.sum / a.n : 0;
  const maxH = Math.max(1, ...agg.map(avgOf));
  for(let g=0; g<=4; g++){ const y = M.t + IH - IH*g/4;
    svg.appendChild(el('line',{class:'grid',x1:M.l,y1:y,x2:M.l+IW,y2:y}));
    const t = el('text',{class:'tick',x:M.l-8,y:y+4,'text-anchor':'end'}); t.textContent = fmt(maxH*g/4); svg.appendChild(t); }
  svg.appendChild(el('line',{class:'axis',x1:M.l,y1:M.t+IH,x2:M.l+IW,y2:M.t+IH}));
  const bw = IW / agg.length;
  agg.forEach((a,i) => {
    const av = avgOf(a), h = IH * av / maxH, x = M.l + i*bw, y = M.t + IH - h;
    if(a.n > 0){
      const rr = el('rect',{class:colorClass, x:x+1, y, width:Math.max(1,bw-2), height:h});
      rr.addEventListener('mousemove', e => showTip('<b>'+fmt(a.lo)+'</b>–<b>'+fmt(a.hi)+'</b> tok<br><b>'+fmt(av)+'</b> avg · '+a.n+' resp', e));
      rr.addEventListener('mouseleave', hideTip); svg.appendChild(rr);
    }
    if(i % Math.ceil(agg.length/8) === 0){
      const t = el('text',{class:'tick',x,y:M.t+IH+16,'text-anchor':'middle'}); t.textContent = fmt(a.lo); svg.appendChild(t); }
  });
  const xl = el('text',{class:'axl',x:M.l+IW/2,y:H-4,'text-anchor':'middle'});
  xl.textContent = 'total prompt tokens' + (isLog ? ' (log bins)' : ''); svg.appendChild(xl);
  host.appendChild(svg);
}

function render(){
  const log = document.getElementById('logToggle').checked;
  ACTIVE = document.getElementById('outToggle').checked ? rows.filter(r => !isOutlier(r)) : rows;
  drawStacked('stack-count','count',log);
  drawStacked('stack-resp','resp',log);
  drawAvgBar('avg-decode','output','seg3',log);
  drawAvgBar('avg-cw','cacheWrite','seg2',log);
  drawScatter(log);
  drawHour(log);
}
function tiles(){
  const t = [['sessions',meta.sessions],['responses',meta.responses],['with timing',meta.withTiming]];
  document.getElementById('tiles').innerHTML = t.map(([k,v]) =>
    '<div class="tile"><div class="v">'+v+'</div><div class="k">'+k+'</div></div>').join('');
  document.getElementById('sub').textContent =
    meta.files.join(', ') + ' · generated ' + meta.generatedAt.replace('T',' ').slice(0,16);
  document.getElementById('foot').textContent = 'Models included: haiku, sonnet, opus, fable.';
}
document.getElementById('logToggle').checked = !!meta.log;
document.getElementById('logToggle').addEventListener('change', render);
document.getElementById('outToggle').addEventListener('change', render);
tiles(); render();
</script>
</body>
</html>`;
}

module.exports = { runSkel, runStats };
