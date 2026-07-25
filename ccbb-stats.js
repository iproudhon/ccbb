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
//
// The report builds ITSELF inside a Shadow DOM at runtime, so the same block of markup
// works both as a standalone file and pasted into a Confluence HTML macro (`--confluence`).
// See confluence.md for why. The embedded data is PRE-AGGREGATED (see buildViews) so the
// page stays a few tens of KB no matter how many sessions went in — a raw row per response
// blew past what Confluence will accept in a macro body.

const fs = require('fs');
const path = require('path');
const common = require('./ccbb-common');

// Only responses from these model families are included in the report. One place to edit.
const MODEL_INCLUDE = [/haiku/i, /sonnet/i, /opus/i, /fable/i];

// Histogram resolution (bars per chart) and the default scatter sample cap.
const NBINS = 96;
const DEFAULT_POINTS = 2000;

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
  let out = 'ccbb-stats.html', log = false, conf = false;
  let points = DEFAULT_POINTS;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return statsHelp();
    else if (a === '-o' || a === '--out') out = argv[++i];
    else if (a.startsWith('--out=')) out = a.slice(6);
    else if (a === '--log') log = true;
    else if (a === '--confluence') conf = true;
    else if (a.startsWith('--confluence=')) { conf = true; out = a.slice(13); }
    else if (a === '--points') points = Number(argv[++i]);
    else if (a.startsWith('--points=')) points = Number(a.slice(9));
    else if (a.startsWith('-')) { console.error(`ccbb stats: unknown option '${a}'`); process.exit(1); }
    else files.push(a);
  }
  if (!isFinite(points) || points < 0) { console.error('ccbb stats: --points must be a non-negative number'); process.exit(1); }

  // Load + dedup sessions by fingerprint (first file wins). With no file arguments the
  // skeletons are built straight from the discoverable sessions — same data `ccbb skel`
  // would have written, without the intermediate file.
  const seen = new Set();
  const sessions = [];
  const inputs = files.length ? files.map(f => {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
      console.error(`ccbb stats: cannot read ${f}: ${e.message}`); process.exit(1);
    }
  }) : [common.buildAllSkeletons()];
  for (const data of inputs) {
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
    generatedAt: new Date().toISOString(),
  };
  // --confluence changes WHAT the output file holds (the macro-body extract), not how many
  // files are written: one run, one file, always the one named by -o.
  const block = reportBlock(buildViews(rows, points), meta);
  const body = conf ? block + '\n' : renderHtml(block);
  fs.writeFileSync(out, body);
  const kb = Math.round(Buffer.byteLength(body) / 1024);
  console.log(`ccbb stats: ${meta.sessions} sessions, ${meta.responses} responses → ${out} (${kb} KB${conf ? ', Confluence HTML-macro body' : ''})`);
}
function statsHelp() {
  console.log(`ccbb stats — render an HTML report from skeleton files

Usage:
  ccbb stats [file.json...] [options]

Writes a self-contained HTML report with token-count histograms and response-time
charts. With no file arguments the skeletons are built from the discoverable sessions;
given files (glob is fine, e.g. *.json) are read instead and deduped by fingerprint.
Only haiku/sonnet/opus/fable models are included.

Chart data is pre-aggregated at build time, so page size does not grow with the
number of sessions (only the scatter plot carries per-response points).

  --log                  start with log-scaled axes/bins (default off; toggleable in the page).
  --points <n>           scatter-plot sample cap (default ${DEFAULT_POINTS}, 0 = every response).
                         The dominant term in page size — lower it if the page is too big.
  --confluence[=file]    write the Confluence HTML-macro body (host <div> + <script> only)
                         instead of a standalone page. With =file, that is the output path.
  -o, --out <file>       output path (default ccbb-stats.html)`);
}

// ── Aggregation (build time) ──────────────────────────────────────────────────
// Every chart is a binned/aggregated view of the rows, so the rows themselves never need
// to reach the browser. We precompute each view the two toggles can select:
//
//   outliers kept / removed   × linear / log bins   → the stacked + average bar charts
//   outliers kept / removed                          → hour means and the scatter points
//
// (the log toggle only rescales the scatter's y axis and the hour axis, so those two are
// computed once per outlier state). Bins are emitted as flat number arrays to keep the
// JSON small; the page decodes them back into objects.
function totalPrompt(r) { return r.cacheRead + r.cacheWrite + r.output; }
function isOutlier(r) {
  const size = r.promptTokens + r.output;
  if (size === 0 && (r.respMs == null || r.respMs === 0)) return true;   // no size, no timing
  if (r.respMs != null && r.respMs > 600000) return true;                // idle-gap artifact
  return false;
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x))); const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
// 24-ish bins by default, linear or log10 spaced (log ignores zeros).
function histBins(vals, log, N) {
  N = N || 24;
  if (log) {
    const pos = vals.filter(v => v > 0);
    if (!pos.length) return { bins: [], log: true };
    const lo = Math.log10(Math.max(1, Math.min(...pos))), hi = Math.log10(Math.max(...pos));
    const span = (hi - lo) || 1, w = span / N;
    const bins = Array.from({ length: N }, (_, i) =>
      ({ lo: Math.pow(10, lo + i * w), hi: Math.pow(10, lo + (i + 1) * w) }));
    return { bins, log: true };
  }
  const max = Math.max(...vals, 1), step = niceStep(max / N) || 1;
  const n = Math.max(1, Math.ceil((max + 1e-9) / step));
  return { bins: Array.from({ length: n }, (_, i) => ({ lo: i * step, hi: (i + 1) * step })), log: false };
}
// One binned aggregate over `src`, keyed on each row's total prompt.
// Emitted per bin: [lo, hi, n, cacheRead, cacheWrite, decode, respMsSum, respCount].
function makeAgg(src, log) {
  const { bins, log: isLog } = histBins(src.map(totalPrompt), log, NBINS);
  if (!bins.length) return { log: isLog, bins: [] };
  const agg = bins.map(b => ({ lo: b.lo, hi: b.hi, n: 0, cr: 0, cw: 0, dec: 0, resp: 0, rc: 0 }));
  const idxOf = v => {
    let i = bins.findIndex(b => v >= b.lo && v < b.hi);
    if (i < 0) i = (v < bins[0].lo) ? 0 : bins.length - 1;
    return i;
  };
  for (const r of src) {
    const a = agg[idxOf(totalPrompt(r))];
    a.n++; a.cr += r.cacheRead; a.cw += r.cacheWrite; a.dec += r.output;
    if (r.respMs != null) { a.resp += r.respMs; a.rc++; }
  }
  const R = Math.round;
  return { log: isLog, bins: agg.map(a => [R(a.lo), R(a.hi), a.n, a.cr, a.cw, a.dec, R(a.resp), a.rc]) };
}
// Even stride sample so a huge run still plots (and still looks like the whole run) without
// shipping one point per response. cap 0 keeps everything.
function samplePoints(src, cap) {
  const pts = src.filter(r => r.respMs != null).map(r => [r.promptTokens + r.output, Math.round(r.respMs)]);
  if (!cap || pts.length <= cap) return { pts, total: pts.length };
  const stride = pts.length / cap;
  const out = [];
  for (let i = 0; i < cap; i++) out.push(pts[Math.floor(i * stride)]);
  return { pts: out, total: pts.length };
}
function buildView(src, cap) {
  const withTiming = src.filter(r => r.respMs != null);
  const sum = Array(24).fill(0), cnt = Array(24).fill(0);
  for (const r of withTiming) { if (r.hour != null) { sum[r.hour] += r.respMs; cnt[r.hour]++; } }
  const s = samplePoints(src, cap);
  return {
    lin: { all: makeAgg(src, false), resp: makeAgg(withTiming, false) },
    log: { all: makeAgg(src, true), resp: makeAgg(withTiming, true) },
    hour: { sum: sum.map(Math.round), cnt },
    pts: s.pts, ptsTotal: s.total,
  };
}
function buildViews(rows, cap) {
  return { keep: buildView(rows, cap), drop: buildView(rows.filter(r => !isOutlier(r)), cap) };
}

// ── HTML rendering ────────────────────────────────────────────────────────────
// Everything the report needs is generated at runtime inside a SHADOW ROOT hung off a
// single host <div>. Confluence's inline HTML macro runs the <script> but our <style>
// never survives — Confluence's own CSS then takes over (full-width charts, wrong colors,
// unresolved var()). Injecting the stylesheet into a shadow root from JS fixes both
// directions: the macro can't strip it and Confluence's styles can't leak in. For the same
// reason every chart color is a concrete hex from PAL — no var() inside SVG attributes.
// So the emitted block is just the host div + one script; see confluence.md.

const HOST_ID = 'ccbb-stats-host';

// Stylesheet template. `__key__` tokens are substituted from the active palette at runtime,
// which is also how the dark/light swap works (re-substitute, re-set textContent).
const CSS_TEMPLATE = `
:host{all:initial;display:block;color:__primary__;background:__plane__;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:14px;line-height:1.5}
*{box-sizing:border-box}
.wrap{max-width:1000px;margin:0 auto;padding:28px 20px 64px}
h1{font-size:20px;font-weight:600;margin:0 0 4px;color:__primary__}
.sub{color:__secondary__;font-size:13px;margin:0 0 20px}
.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 24px}
.tile{background:__surface__;border:1px solid __border__;border-radius:10px;
  padding:12px 16px;min-width:120px}
.tile .v{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums}
.tile .k{color:__muted__;font-size:12px;margin-top:2px}
.ctrl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;margin:0 0 20px;
  color:__secondary__;font-size:13px}
.ctrl label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.ctrl input{accent-color:__series__;margin:0}
.card{background:__surface__;border:1px solid __border__;border-radius:12px;
  padding:16px 16px 8px;margin:0 0 20px;overflow-x:auto}
.card h2{font-size:15px;font-weight:600;margin:0 0 2px;color:__primary__}
.card .desc{color:__muted__;font-size:12px;margin:0 0 8px}
svg{display:block;max-width:100%;height:auto}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 8px;color:__secondary__;font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.sw1{background:__s1__}.sw2{background:__s2__}.sw3{background:__s3__}
.foot{color:__muted__;font-size:12px;margin-top:8px}
.tip{position:fixed;left:0;top:0;pointer-events:none;background:__surface__;color:__primary__;
  border:1px solid __border__;border-radius:8px;padding:6px 9px;font-size:12px;line-height:1.5;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 4px 14px rgba(0,0,0,.18);opacity:0;transition:opacity .08s;white-space:nowrap;
  z-index:2147483647}
.tip b{font-variant-numeric:tabular-nums}
`;

// Static markup for the shadow tree. No <script>/<style> here — innerHTML would not run
// them anyway; the stylesheet is injected separately and all drawing is done in JS.
const MARKUP = `
  <h1>ccbb session stats</h1>
  <p class="sub" id="sub"></p>
  <div class="tiles" id="tiles"></div>
  <div class="ctrl">
    <label><input type="checkbox" id="logToggle"> log scaling (histogram bins &amp; response-time axis)</label>
    <label><input type="checkbox" id="outToggle"> remove outliers (0-size &amp; 0-response, or response &gt; 10&nbsp;min)</label>
  </div>
  <div class="card"><h2>Prompt Size Distribution</h2><p class="desc">responses binned by total prompt (cache-read + cache-write + decode); each bar stacked by token-type share of that bin</p>
    <div class="legend"><span><i class="sw1"></i>cache read</span><span><i class="sw2"></i>cache write</span><span><i class="sw3"></i>decode</span></div><div id="stack-count"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Response Time</h2><p class="desc">avg response time binned by total prompt; each bar stacked by token-type share of that bin</p>
    <div class="legend"><span><i class="sw1"></i>cache read</span><span><i class="sw2"></i>cache write</span><span><i class="sw3"></i>decode</span></div><div id="stack-resp"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Decode</h2><p class="desc">avg decode (output) tokens per response, binned by total prompt</p><div id="avg-decode"></div></div>
  <div class="card"><h2>Prompt Size&nbsp;→&nbsp;Cache Write</h2><p class="desc">avg cache-write tokens per response, binned by total prompt</p><div id="avg-cw"></div></div>
  <div class="card"><h2>Prompt&nbsp;+&nbsp;output size&nbsp;→&nbsp;response time</h2><p class="desc">each dot is one response (main-transcript responses with timing)<span id="pts-note"></span></p><div id="scatter"></div></div>
  <div class="card"><h2>Time of day&nbsp;→&nbsp;avg response time</h2><p class="desc">mean response time by local hour</p><div id="hour"></div></div>
  <p class="foot" id="foot"></p>
`;

// The paste-ready block: host <div> + one <script>. This is BOTH the body of the standalone
// page and, verbatim, the body of the Confluence HTML macro.
function reportBlock(views, meta) {
  const payload = JSON.stringify({ views, meta }).replace(/</g, '\\u003c');
  return `<div id="${HOST_ID}"></div>
<script>
(function(){
var DATA = ${payload};
var CSS_T = ${JSON.stringify(CSS_TEMPLATE)};
var MARKUP = ${JSON.stringify(MARKUP)};
var VIEWS = DATA.views, meta = DATA.meta;

var host = document.getElementById(${JSON.stringify(HOST_ID)});
if(!host) return;
// The macro may re-run the script (live refresh / in-place body swap): reuse the root.
var root = host.shadowRoot || host.attachShadow({mode:'open'});
root.innerHTML = '';

// Concrete hex per theme — never var() inside SVG attributes (Confluence would not resolve it).
var LIGHT = {plane:'#f9f9f7', surface:'#fcfcfb', primary:'#0b0b0b', secondary:'#52514e',
  muted:'#898781', grid:'#e1e0d9', axis:'#c3c2b7', series:'#2a78d6',
  s1:'#2a78d6', s2:'#eb6834', s3:'#1baf7a', border:'rgba(11,11,11,0.10)'};
var DARK = {plane:'#0d0d0d', surface:'#1a1a19', primary:'#ffffff', secondary:'#c3c2b7',
  muted:'#898781', grid:'#2c2c2a', axis:'#383835', series:'#3987e5',
  s1:'#3987e5', s2:'#d95926', s3:'#199e70', border:'rgba(255,255,255,0.10)'};
var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
var PAL = (mq && mq.matches) ? DARK : LIGHT;
function css(P){ return CSS_T.replace(/__(\\w+)__/g, function(_, k){ return P[k]; }); }

var styleEl = document.createElement('style');
var wrap = document.createElement('div');
wrap.className = 'wrap';
wrap.innerHTML = MARKUP;
root.appendChild(styleEl); root.appendChild(wrap);
function $(id){ return root.getElementById(id); }

// The tooltip lives in its OWN shadow root on <body>: position:fixed is relative to the
// nearest transformed ancestor, and Confluence wraps macro output in containers we do not
// control. Hanging it off body keeps it viewport-anchored and out of reach of page CSS.
var tipHost = document.createElement('div');
document.body.appendChild(tipHost);
var tipRoot = tipHost.attachShadow({mode:'open'});
var tipStyle = document.createElement('style');
var tip = document.createElement('div');
tip.className = 'tip';
tipRoot.appendChild(tipStyle); tipRoot.appendChild(tip);

function paint(){ styleEl.textContent = css(PAL); tipStyle.textContent = css(PAL); }
paint();
if(mq && mq.addEventListener) mq.addEventListener('change', function(){
  PAL = mq.matches ? DARK : LIGHT; paint(); render();
});

// The active view — outlier toggle picks which pre-aggregated set the charts read.
var VIEW = VIEWS.keep;
// [lo, hi, n, cacheRead, cacheWrite, decode, respMsSum, respCount] → object.
function decode(b){ return {lo:b[0], hi:b[1], n:b[2], cr:b[3], cw:b[4], dec:b[5], resp:b[6], rc:b[7]}; }
function aggOf(which, log){
  var g = VIEW[log ? 'log' : 'lin'][which];
  return {isLog:g.log, agg:g.bins.map(decode)};
}
function showTip(html, e){ tip.innerHTML = html; tip.style.opacity = 1;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top  = (e.clientY - tip.offsetHeight - 10) + 'px'; }
function hideTip(){ tip.style.opacity = 0; }
var SVGNS = 'http://www.w3.org/2000/svg';
function el(n, a){ var x = document.createElementNS(SVGNS, n); for(var k in a) x.setAttribute(k, a[k]); return x; }
function fmt(n){ n = Math.round(n);
  if(Math.abs(n) >= 1e6) return (n/1e6).toFixed(1)+'M';
  if(Math.abs(n) >= 1e3) return (n/1e3).toFixed(1)+'k'; return String(n); }
function fmtMs(ms){ return ms >= 10000 ? (ms/1000).toFixed(0)+'s' : (ms/1000).toFixed(1)+'s'; }

var W = 920, H = 260, M = {t:14, r:16, b:40, l:52};
var IW = W - M.l - M.r, IH = H - M.t - M.b;

// Chart primitives — every colour comes from PAL as a literal attribute value.
function gridLine(y){ return el('line',{x1:M.l, y1:y, x2:M.l+IW, y2:y, stroke:PAL.grid, 'stroke-width':1}); }
function axisLine(){ return el('line',{x1:M.l, y1:M.t+IH, x2:M.l+IW, y2:M.t+IH, stroke:PAL.axis, 'stroke-width':1}); }
function tickText(x, y, anchor, txt){
  var t = el('text',{x:x, y:y, 'text-anchor':anchor, fill:PAL.muted, 'font-size':11,
    'font-variant-numeric':'tabular-nums'});
  t.textContent = txt; return t; }
function axisLabel(x, y, txt, rot){
  var a = {x:x, y:y, 'text-anchor':'middle', fill:PAL.secondary, 'font-size':12};
  if(rot) a.transform = rot;
  var t = el('text', a); t.textContent = txt; return t; }

function drawScatter(log){
  var hostEl = $('scatter'); hostEl.innerHTML = '';
  var pts = VIEW.pts;
  var svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  if(!pts.length){ hostEl.appendChild(svg); return; }
  var xMax = Math.max.apply(null, pts.map(function(p){ return p[0]; }).concat([1]));
  var yv = function(v){ return log ? Math.log10(Math.max(1, v)) : v; };
  var yMax = Math.max.apply(null, pts.map(function(p){ return yv(p[1]); }).concat([yv(1)]));
  var sx = function(v){ return M.l + IW * v / xMax; };
  var sy = function(v){ return M.t + IH - IH * yv(v) / (yMax || 1); };
  for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
    svg.appendChild(gridLine(y));
    var raw = log ? Math.pow(10, yMax*g/4) : (yMax*g/4);
    svg.appendChild(tickText(M.l-8, y+4, 'end', fmtMs(raw))); }
  svg.appendChild(axisLine());
  for(var g2=0; g2<=4; g2++){
    svg.appendChild(tickText(M.l + IW*g2/4, M.t+IH+16, 'middle', fmt(xMax*g2/4))); }
  pts.forEach(function(p){
    var c = el('circle',{cx:sx(p[0]), cy:sy(p[1]), r:3.5, fill:PAL.series, 'fill-opacity':0.55});
    c.addEventListener('mousemove', function(e){
      showTip('<b>'+fmt(p[0])+'</b> tok in+out<br><b>'+fmtMs(p[1])+'</b> response', e); });
    c.addEventListener('mouseleave', hideTip); svg.appendChild(c);
  });
  svg.appendChild(axisLabel(M.l+IW/2, H-4, 'prompt + output tokens'));
  svg.appendChild(axisLabel(-(M.t+IH/2), 14, 'response time' + (log ? ' (log)' : ''), 'rotate(-90)'));
  hostEl.appendChild(svg);
  $('pts-note').textContent = VIEW.pts.length < VIEW.ptsTotal
    ? ' · showing an even sample of ' + fmt(VIEW.pts.length) + ' of ' + fmt(VIEW.ptsTotal) : '';
}

function drawHour(log){
  var hostEl = $('hour'); hostEl.innerHTML = '';
  var sum = VIEW.hour.sum, cnt = VIEW.hour.cnt;
  var avg = sum.map(function(s,i){ return cnt[i] ? s/cnt[i] : null; });
  var svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  var yv = function(v){ return log ? Math.log10(Math.max(1, v)) : v; };
  var present = avg.filter(function(v){ return v != null; });
  var yMax = present.length ? Math.max.apply(null, present.map(yv)) : 1;
  var sx = function(h){ return M.l + IW * h / 23; };
  var sy = function(v){ return M.t + IH - IH * yv(v) / (yMax || 1); };
  for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
    svg.appendChild(gridLine(y));
    var raw = log ? Math.pow(10, yMax*g/4) : (yMax*g/4);
    svg.appendChild(tickText(M.l-8, y+4, 'end', fmtMs(raw))); }
  svg.appendChild(axisLine());
  for(var h0=0; h0<24; h0+=3){ svg.appendChild(tickText(sx(h0), M.t+IH+16, 'middle', h0)); }
  // line across contiguous present hours
  var d = '', started = false;
  for(var h1=0; h1<24; h1++){ if(avg[h1]==null){ started=false; continue; }
    d += (started?' L':'M') + sx(h1).toFixed(1) + ' ' + sy(avg[h1]).toFixed(1); started=true; }
  if(d) svg.appendChild(el('path',{d:d, fill:'none', stroke:PAL.series, 'stroke-width':2}));
  for(var h=0; h<24; h++){ if(avg[h]==null) continue;
    (function(h){
      var c = el('circle',{cx:sx(h), cy:sy(avg[h]), r:4, fill:PAL.series});
      c.addEventListener('mousemove', function(e){
        showTip('<b>'+String(h).padStart(2,'0')+':00</b><br><b>'+fmtMs(avg[h])+'</b> avg · '+cnt[h]+' resp', e); });
      c.addEventListener('mouseleave', hideTip); svg.appendChild(c);
    })(h); }
  svg.appendChild(axisLabel(M.l+IW/2, H-4, 'hour of day (local)'));
  hostEl.appendChild(svg);
}

// Total-prompt-binned stacked bars. Bar height = the metric ('count' of responses, or
// 'resp' = avg response time in the bin); each bar is split into cache-read / cache-write /
// decode segments by that bin's aggregate token share. x bins follow the log toggle.
function drawStacked(id, metric, log){
  var hostEl = $(id); hostEl.innerHTML = '';
  var got = aggOf(metric === 'resp' ? 'resp' : 'all', log), agg = got.agg;
  var svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  if(!agg.length){ hostEl.appendChild(svg); return; }
  var heightOf = function(a){ return metric === 'count' ? a.n : (a.rc ? a.resp / a.rc : 0); };
  var fmtY = function(v){ return metric === 'count' ? String(Math.round(v)) : fmtMs(v); };
  var maxH = Math.max.apply(null, agg.map(heightOf).concat([1]));
  for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
    svg.appendChild(gridLine(y));
    svg.appendChild(tickText(M.l-8, y+4, 'end', fmtY(maxH*g/4))); }
  svg.appendChild(axisLine());
  var bw = IW / agg.length;
  agg.forEach(function(a, i){
    var h = IH * heightOf(a) / maxH, x = M.l + i*bw, tot = a.cr + a.cw + a.dec || 1;
    var y = M.t + IH;
    [[PAL.s1, a.cr], [PAL.s2, a.cw], [PAL.s3, a.dec]].forEach(function(pair){
      var sh = h * pair[1] / tot; if(sh <= 0) return; y -= sh;
      svg.appendChild(el('rect',{x:x+1, y:y, width:Math.max(1,bw-2), height:sh, fill:pair[0]}));
    });
    if(heightOf(a) > 0){
      var seg = function(v){ return fmt(v / a.n) + ' (' + Math.round(100 * v / tot) + '%)'; };  // avg per response
      var hit = el('rect',{x:x+1, y:M.t+IH-h, width:Math.max(1,bw-2), height:h, fill:'transparent'});
      hit.addEventListener('mousemove', function(e){ showTip('<b>'+fmt(a.lo)+'</b>–<b>'+fmt(a.hi)+'</b> tok<br>'+
        (metric === 'count' ? '<b>'+a.n+'</b> responses' : '<b>'+fmtMs(a.rc?a.resp/a.rc:0)+'</b> avg · '+a.n+' resp')+
        '<br>read '+seg(a.cr)+'<br>write '+seg(a.cw)+'<br>decode '+seg(a.dec), e); });
      hit.addEventListener('mouseleave', hideTip); svg.appendChild(hit);
    }
    if(i % Math.ceil(agg.length/8) === 0) svg.appendChild(tickText(x, M.t+IH+16, 'middle', fmt(a.lo)));
  });
  svg.appendChild(axisLabel(M.l+IW/2, H-4, 'total prompt tokens' + (got.isLog ? ' (log bins)' : '')));
  hostEl.appendChild(svg);
}

// Simple (non-stacked) bar chart: for each total-prompt bin, y = average of the given
// token field per response in that bin.
function drawAvgBar(id, field, colorKey, log){
  var hostEl = $(id); hostEl.innerHTML = '';
  var got = aggOf('all', log), agg = got.agg;
  var svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  if(!agg.length){ hostEl.appendChild(svg); return; }
  var avgOf = function(a){ return a.n ? a[field] / a.n : 0; };
  var maxH = Math.max.apply(null, agg.map(avgOf).concat([1]));
  for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
    svg.appendChild(gridLine(y));
    svg.appendChild(tickText(M.l-8, y+4, 'end', fmt(maxH*g/4))); }
  svg.appendChild(axisLine());
  var bw = IW / agg.length;
  agg.forEach(function(a, i){
    var av = avgOf(a), h = IH * av / maxH, x = M.l + i*bw, y = M.t + IH - h;
    if(a.n > 0){
      var rr = el('rect',{x:x+1, y:y, width:Math.max(1,bw-2), height:h, fill:PAL[colorKey]});
      rr.addEventListener('mousemove', function(e){
        showTip('<b>'+fmt(a.lo)+'</b>–<b>'+fmt(a.hi)+'</b> tok<br><b>'+fmt(av)+'</b> avg · '+a.n+' resp', e); });
      rr.addEventListener('mouseleave', hideTip); svg.appendChild(rr);
    }
    if(i % Math.ceil(agg.length/8) === 0) svg.appendChild(tickText(x, M.t+IH+16, 'middle', fmt(a.lo)));
  });
  svg.appendChild(axisLabel(M.l+IW/2, H-4, 'total prompt tokens' + (got.isLog ? ' (log bins)' : '')));
  hostEl.appendChild(svg);
}

function render(){
  var log = $('logToggle').checked;
  VIEW = $('outToggle').checked ? VIEWS.drop : VIEWS.keep;
  drawStacked('stack-count','count',log);
  drawStacked('stack-resp','resp',log);
  drawAvgBar('avg-decode','dec','s3',log);
  drawAvgBar('avg-cw','cw','s2',log);
  drawScatter(log);
  drawHour(log);
}
function tiles(){
  var t = [['sessions',meta.sessions],['responses',meta.responses],['with timing',meta.withTiming]];
  $('tiles').innerHTML = t.map(function(kv){
    return '<div class="tile"><div class="v">'+kv[1]+'</div><div class="k">'+kv[0]+'</div></div>'; }).join('');
  $('sub').textContent = 'generated ' + meta.generatedAt.replace('T',' ').slice(0,16);
  $('foot').textContent = 'Models included: haiku, sonnet, opus, fable.';
}
$('logToggle').checked = !!meta.log;
$('logToggle').addEventListener('change', render);
$('outToggle').addEventListener('change', render);
tiles(); render();
})();
</script>`;
}

// Standalone page: the same block, wrapped in a minimal document. Everything visible is
// produced by the block itself, so this shell only sets the page background/margins.
function renderHtml(block) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccbb session stats</title>
<style>
html,body{margin:0;padding:0;background:#f9f9f7}
@media (prefers-color-scheme:dark){html,body{background:#0d0d0d}}
</style>
</head>
<body>
${block}
</body>
</html>`;
}

module.exports = { runSkel, runStats };
