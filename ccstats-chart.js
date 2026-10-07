'use strict';
// Shared with ccstats.js: its bin edges, page stylesheet and client-side chart library,
// copied here so the golizer report stands on its own and draws the way ccstats does.

// Histogram resolution (bars per chart).
const NBINS = 96;
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x))); const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
// Edge arrays: n+1 numbers, ascending. linEdges snaps to a round step; logEdges is
// log10-spaced and ignores zeros (they fall into the first bin).
function linEdges(vals, N) {
  const max = Math.max(...vals, 1), step = niceStep(max / N) || 1;
  const n = Math.max(1, Math.ceil((max + 1e-9) / step));
  return Array.from({ length: n + 1 }, (_, i) => Math.round(i * step));
}
function logEdges(vals, N, floor) {
  const pos = vals.filter(v => v > 0);
  if (!pos.length) return [0, 1];
  const lo = Math.log10(Math.max(floor || 1, Math.min(...pos))), hi = Math.log10(Math.max(...pos));
  const span = (hi - lo) || 1;
  return Array.from({ length: N + 1 }, (_, i) => Math.round(Math.pow(10, lo + span * i / N)));
}
function binOf(edges, v) {
  if (!(v > edges[0])) return 0;
  let lo = 0, hi = edges.length - 1;
  while (lo < hi - 1) { const mid = (lo + hi) >> 1; if (v < edges[mid]) hi = mid; else lo = mid; }
  return Math.min(lo, edges.length - 2);
}

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
.ctrl{display:flex;flex-wrap:wrap;align-items:center;gap:8px 20px;margin:0 0 12px;
  color:__secondary__;font-size:13px}
.ctrl label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}
.ctrl input{accent-color:__series__;margin:0}
.ctrl .lbl{color:__muted__;font-size:12px;text-transform:uppercase;letter-spacing:.04em;
  min-width:58px}
.ctrl .n{color:__muted__;font-variant-numeric:tabular-nums}
.ctrl a{color:__series__;cursor:pointer;text-decoration:none;font-size:12px}
.card{background:__surface__;border:1px solid __border__;border-radius:12px;
  padding:16px 16px 8px;margin:0 0 20px;overflow-x:auto}
.card h2{font-size:15px;font-weight:600;margin:0 0 2px;color:__primary__}
.card .desc{color:__muted__;font-size:12px;margin:0 0 8px}
svg{display:block;max-width:100%;height:auto}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin:0 0 8px;color:__secondary__;font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.sw0{background:__primary__}.sw1{background:__s1__}.sw2{background:__s2__}.sw3{background:__s3__}
.foot{color:__muted__;font-size:12px;margin-top:8px}
.float{position:fixed;top:14px;right:14px;z-index:2147483646;display:flex;
  flex-direction:column;gap:5px;background:__surface__;color:__secondary__;
  border:1px solid __border__;border-radius:12px;padding:10px 13px;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;line-height:1.35;
  box-shadow:0 4px 14px rgba(0,0,0,.18);max-height:80vh;overflow:auto}
.float .head{cursor:pointer;user-select:none;color:__secondary__;font-size:12px;
  font-variant-numeric:tabular-nums}
.float .body{flex-direction:column;gap:5px}
.float .hd{color:__muted__;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.float .rows{display:flex;flex-direction:column;gap:4px}
.float label{display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap}
.float a{color:__series__;cursor:pointer;text-decoration:none;font-size:12px}
.float .n{color:__muted__;font-variant-numeric:tabular-nums}
.float input{accent-color:__series__;margin:0}
.tip{position:fixed;left:0;top:0;pointer-events:none;background:__surface__;color:__primary__;
  border:1px solid __border__;border-radius:8px;padding:6px 9px;font-size:12px;line-height:1.5;
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  box-shadow:0 4px 14px rgba(0,0,0,.18);opacity:0;transition:opacity .08s;white-space:nowrap;
  z-index:2147483647}
.tip b{font-variant-numeric:tabular-nums}
`;

// Client-side chart library: the palettes, formatters and SVG primitives every report page
// draws with. Spliced verbatim into the page script (by ccstats-golizer.js), so it
// expects the page to define root-scoped `$`, `tip` and `PAL` before anything is drawn.
const CHART_LIB = `
// Concrete hex per theme — never var() inside SVG attributes (Confluence would not resolve it).
var LIGHT = {plane:'#f9f9f7', surface:'#fcfcfb', primary:'#0b0b0b', secondary:'#52514e',
  muted:'#898781', grid:'#e1e0d9', axis:'#c3c2b7', series:'#2a78d6',
  s1:'#2a78d6', s2:'#eb6834', s3:'#1baf7a', border:'rgba(11,11,11,0.10)'};
var DARK = {plane:'#0d0d0d', surface:'#1a1a19', primary:'#ffffff', secondary:'#c3c2b7',
  muted:'#898781', grid:'#2c2c2a', axis:'#383835', series:'#3987e5',
  s1:'#3987e5', s2:'#d95926', s3:'#199e70', border:'rgba(255,255,255,0.10)'};

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
function fmtDur(ms){
  if(ms < 60000) return (ms/1000).toFixed(0)+'s';
  if(ms < 3600000) return (ms/60000).toFixed(ms < 600000 ? 1 : 0)+'m';
  if(ms < 86400000) return (ms/3600000).toFixed(1)+'h';
  return (ms/86400000).toFixed(1)+'d';
}
function pct(a, b){ return b > 0 ? Math.round(100*a/b)+'%' : '0%'; }

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
// x pixel for a value on the binned axis: find the bin that contains it and interpolate
// inside that bin's slot, the same way the bars are laid out.
function binX(bins, isLog, v, bw){
  if(!(v > 0)) return M.l;
  if(v <= bins[0].lo) return M.l;
  if(v >= bins[bins.length-1].hi) return M.l + IW;
  for(var i=0; i<bins.length; i++){
    var a = bins[i];
    if(v < a.lo || v >= a.hi) continue;
    var f = (isLog && a.lo > 0)
      ? (Math.log(v) - Math.log(a.lo)) / (Math.log(a.hi) - Math.log(a.lo))
      : (v - a.lo) / (a.hi - a.lo);
    if(!isFinite(f)) f = 0;
    return M.l + (i + f) * bw;
  }
  return M.l + IW;
}
// Dashed horizontal reference line at data value val on a 0-to-maxH y-scale, labelled at right.
function meanLine(svg, val, maxH, label){
  if(!(val > 0) || !(maxH > 0)) return;
  var y = M.t + IH - IH * Math.min(val, maxH) / maxH;
  svg.appendChild(el('line',{x1:M.l, y1:y, x2:M.l+IW, y2:y, stroke:PAL.secondary,
    'stroke-width':1.5, 'stroke-dasharray':'5 4'}));
  var t = el('text',{x:M.l+IW-2, y:y-4, 'text-anchor':'end', fill:PAL.secondary,
    'font-size':11, 'font-variant-numeric':'tabular-nums'});
  t.textContent = label; svg.appendChild(t);
}
function blankSvg(hostEl){
  var svg = el('svg', {viewBox:'0 0 '+W+' '+H, width:W, height:H, role:'img'});
  hostEl.innerHTML = ''; hostEl.appendChild(svg); return svg;
}

// Generic binned bar chart. opts: height(bin) -> bar height in data units,
// segs(bin) -> [[color, value], …] stacked shares (optional; one solid bar otherwise),
// fmtY, fmtX, tip(bin), xlabel, mean (value for the dashed reference line), meanLabel,
// maxH (fixed y-scale top, so two charts can share one scale).
function drawBins(id, bins, isLog, opts){
  var hostEl = $(id); if(!hostEl) return;
  var svg = blankSvg(hostEl);
  if(!bins.length) return;
  var fmtY = opts.fmtY || fmt, fmtX = opts.fmtX || fmt;
  var maxH = 1;
  for(var i=0; i<bins.length; i++) maxH = Math.max(maxH, opts.height(bins[i]));
  if(opts.maxH > 0) maxH = opts.maxH;
  for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
    svg.appendChild(gridLine(y));
    svg.appendChild(tickText(M.l-8, y+4, 'end', fmtY(maxH*g/4))); }
  svg.appendChild(axisLine());
  var bw = IW / bins.length;
  var step = Math.ceil(bins.length/8);
  bins.forEach(function(b, i){
    var h = IH * opts.height(b) / maxH, x = M.l + i*bw, w = Math.max(1, bw-2);
    if(h > 0){
      var segs = opts.segs ? opts.segs(b) : [[PAL.series, 1]];
      var tot = 0;
      segs.forEach(function(s){ tot += s[1]; });
      if(tot <= 0) segs = [[PAL.series, 1]], tot = 1;
      var y = M.t + IH;
      segs.forEach(function(s){
        var sh = h * s[1] / tot; if(sh <= 0) return; y -= sh;
        svg.appendChild(el('rect',{x:x+1, y:y, width:w, height:sh, fill:s[0]}));
      });
      var hit = el('rect',{x:x+1, y:M.t+IH-h, width:w, height:h, fill:'transparent'});
      hit.addEventListener('mousemove', function(e){ showTip(opts.tip(b), e); });
      hit.addEventListener('mouseleave', hideTip);
      svg.appendChild(hit);
    }
    if(i % step === 0) svg.appendChild(tickText(x, M.t+IH+16, 'middle', fmtX(b.lo)));
  });
  if(opts.mean != null) meanLine(svg, opts.mean, maxH, opts.meanLabel);
  if(opts.marks) opts.marks(svg, bins, bw, maxH);
  svg.appendChild(axisLabel(M.l+IW/2, H-4, opts.xlabel + (isLog ? ' (log bins)' : '')));
  return svg;
}
`;

module.exports = { NBINS, linEdges, logEdges, binOf, CSS_TEMPLATE, CHART_LIB };
