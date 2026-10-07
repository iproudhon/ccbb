#!/usr/bin/env node
'use strict';
// ── ccstats-golizer ──────────────────────────────────────────────────────────
// HTML report for golizer `histo` and/or `replay` runs: what the servers served, side by side
// with the ccstats skeletons the runs were drawn from — one run, or both on one page.
//
//   ccstats-golizer [-o report.html] <run.json>... <skel.json>...
//
// A run file is golizer's `-out` (tool "golizer": one skeleton session per window or
// replayed session, plus a top-level `golizer` object with the sampled pool gauges). Every
// other file is a source skeleton, read the way golizer reads it: sessions deduped by
// fingerprint across files, only haiku/sonnet/opus/fable rows, a row's shape is
// (cr = cacheRead, cw = cacheWrite + input, out = output), rows over -max-ctx dropped.
// Binning and the Jensen–Shannon distances are golizer's own (log2 × log2 on (cr, cw), 96
// log10 bins of total prompt), so the page's numbers match the run's summary.
//
// Everything comes from the JSON files; golizer's stdout is not read. A `replay` run writes
// each session under the source's own id with its rows in source order, so its served rows
// are paired with the source rows they replay (matchReplay): that gives fidelity, cache
// misses and tokens re-prefilled. A `histo` window carries no link back to its source rows,
// so a histo run has the distributions, the distances and the pool, not those.
//
// Charting comes from ccstats-chart.js, a copy of ccstats.js's (CHART_LIB, CSS_TEMPLATE, bin
// edges), so both reports draw the same way. The page builds itself in a Shadow DOM like the
// ccstats report, so --confluence works here too.

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { linEdges, logEdges, binOf, NBINS, CSS_TEMPLATE, CHART_LIB } = require('./ccstats-chart.js');

const HOST_ID = 'ccstats-golizer-host';
const MODEL_INCLUDE = /haiku|sonnet|opus|fable/i;   // golizer's modelInclude
const TP_BINS = 96;                                  // golizer's tpBins
const CRCW_ROWS = 24;                                // (cr, cw) bins the table shows
const POOL_POINTS = 240;                             // default time buckets per pool series

// ── Inputs ────────────────────────────────────────────────────────────────────
function readJson(f) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
    console.error(`ccstats-golizer: cannot read ${f}: ${e.message}`); process.exit(1);
  }
}
function sessionsOf(doc) { return Array.isArray(doc) ? doc : (doc.sessions || []); }
function shapeOf(r) {
  return { cr: r.cacheRead || 0, cw: (r.cacheWrite || 0) + (r.input || 0), out: r.output || 0,
    ms: typeof r.respMs === 'number' ? r.respMs : null, main: r.main !== false };
}
const total = s => s.cr + s.cw + s.out;

// Source skeletons, as golizer's loadShapes: a fingerprint an EARLIER file had drops the
// session; within one file nothing is dropped.
function loadSource(docs, maxCtx) {
  const seen = new Set(), files = [], bySession = new Map();
  let rows = [], dups = 0, sessions = 0, dropped = 0;
  for (const { file, doc } of docs) {
    const mine = new Set();
    let n = 0, ns = 0;
    for (const s of sessionsOf(doc)) {
      if (s.fingerprint) {
        if (seen.has(s.fingerprint)) { dups++; continue; }
        mine.add(s.fingerprint);
      }
      const mineRows = [];
      for (const r of (s.responses || [])) {
        if (!MODEL_INCLUDE.test(String(r.model || ''))) continue;
        const sh = shapeOf(r);
        if (sh.cr + sh.cw === 0) continue;
        if (maxCtx > 0 && total(sh) > maxCtx) { dropped++; continue; }
        mineRows.push(sh);
      }
      if (mineRows.length) { ns++; n += mineRows.length; rows.push(...mineRows); }
      if (s.sessionId != null && !bySession.has(String(s.sessionId))) bySession.set(String(s.sessionId), mineRows);
    }
    for (const fp of mine) seen.add(fp);
    files.push({ file: path.basename(file), rows: n, sessions: ns });
    sessions += ns;
  }
  return { rows, files, dups, sessions, dropped, bySession };
}

// The run: one skeleton session per window (`golizer-w<id>`) or per replayed session (the
// source's own id). A unit's context span runs from its first cache read to its largest
// prompt + output.
function loadRun(doc) {
  const rows = [], units = [];
  const ss = sessionsOf(doc);
  for (const s of ss) {
    const rs = (s.responses || []).map(shapeOf);
    if (!rs.length) continue;
    rows.push(...rs);
    units.push([rs[0].cr, Math.max(...rs.map(total)), rs.length, String(s.sessionId || '')]);
  }
  const mode = ss.length && ss.every(s => /^golizer-w\d+$/.test(s.sessionId || '')) ? 'window' : 'session';
  return { rows, units, mode };
}

// ── Replay against its source ─────────────────────────────────────────────────
// replay writes every played session under the source's session id, so each served row can be
// paired with the source row it replays. Not by position: a session's chains (main,
// subagents) can be in flight together, and the run lists rows as they completed. A pair
// agrees on the output exactly and on the total prompt — which a cache miss does not change,
// only how it splits — within PAIR; among candidates the closest prompt nearest the session's
// last paired position wins. Source rows the run left out (over golizer's -max-ctx) stay
// unpaired.
//
// PAIR is golizer's lag bound: each turn's stream is floored to a 64-token block, and the
// lag is carried into a later write once it reaches a block — into any write once it reaches
// 1,024 (golizer.md §2.8) — so a served prompt sits up to that much from its source row.
//
// A miss is a paired row that read less than its prefix, golizer's own test:
//   in-chain   the row continues an earlier source row of its kind (main / subagent) whose tip
//              (cr + cw) is within a block of its cr; the server should have read the full
//              blocks of that turn's SERVED prompt, so the test is exact — short by more than
//              a block is a miss;
//   first-turn the first row after a cold build — a session's first row, or one whose cr is
//              past every earlier tip — against the source's cr (the cold build built it);
//   branch     anything else (compaction, a subagent starting on the main transcript),
//              against the source's cr within PAIR, the lag of the stream it branches off.
const BLOCK = 64, SLACK = 3 * BLOCK, PAIR = 1024 + 2 * BLOCK;
const floorBlock = v => Math.floor(v / BLOCK) * BLOCK;
function matchReplay(bySession, runDoc) {
  const m = { sessions: 0, unknown: 0, rows: 0, paired: 0, miss: 0, first: 0, branch: 0, tok: 0 };
  const perSession = new Map();
  for (const s of sessionsOf(runDoc)) {
    const rs = (s.responses || []).map(shapeOf);
    m.rows += rs.length;
    const src = bySession.get(String(s.sessionId));
    if (!src) { m.unknown++; continue; }
    m.sessions++;
    const at = new Int32Array(src.length).fill(-1);   // source row → run row
    let pos = 0;
    rs.forEach((r, j) => {
      const P = r.cr + r.cw;
      let k = -1, best = 0;
      for (let i = 0; i < src.length; i++) {
        if (at[i] >= 0 || src[i].out !== r.out) continue;
        const d = Math.abs(src[i].cr + src[i].cw - P);
        if (d > PAIR) continue;
        const score = d + BLOCK * Math.abs(i - pos);
        if (k < 0 || score < best) { k = i; best = score; }
      }
      if (k < 0) return;
      at[k] = j; pos = k + 1; m.paired++;
    });
    let miss = 0;
    for (let k = 0; k < src.length; k++) {
      if (at[k] < 0) continue;
      const r = rs[at[k]], sr = src[k];
      let parent = -1;
      for (let q = k - 1; q >= 0; q--)
        if (src[q].main === sr.main && Math.abs(sr.cr - src[q].cr - src[q].cw) <= BLOCK) { parent = q; break; }
      let short;
      if (parent >= 0 && at[parent] >= 0) {
        const p = rs[at[parent]];
        short = floorBlock(p.cr + p.cw) - r.cr;
        if (short <= BLOCK) continue;
      } else {
        // golizer cold-builds a session's first prefix and any cr past every stream built so
        // far; a miss there is the cold build evicted. Anything else branches off a stream.
        let cold = true;
        for (let q = 0; q < k && cold; q++) if (src[q].cr + src[q].cw + BLOCK >= sr.cr) cold = false;
        short = sr.cr - r.cr;
        if (short <= (cold ? SLACK : PAIR)) continue;
        if (cold) m.first++; else m.branch++;
      }
      miss++; m.miss++; m.tok += short;
    }
    perSession.set(String(s.sessionId), miss);
  }
  return { ...m, perSession };
}

// ── golizer's binning and distances ──────────────────────────────────────────
function log2bin(v) { return v <= 0 ? 0 : 1 + Math.floor(Math.log2(v)); }
function binLo(b) { return b === 0 ? 0 : 2 ** (b - 1); }
function kfmt(v) { return v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : v.toFixed(0); }
function binRange(b) { return b === 0 ? '0' : kfmt(binLo(b)) + '–' + kfmt(binLo(b + 1)); }
function hist2(rows) {
  const h = new Map();
  for (const s of rows) {
    const k = log2bin(s.cr) + ',' + log2bin(s.cw);
    let a = h.get(k);
    if (!a) h.set(k, a = { n: 0, cr: 0, cw: 0, out: 0 });
    a.n++; a.cr += s.cr; a.cw += s.cw; a.out += s.out;
  }
  return h;
}
// Jensen–Shannon distance, base 2, in [0, 1], between two mass vectors.
function jsArr(p, q) {
  let d = 0;
  for (let i = 0; i < p.length; i++) {
    const m = (p[i] + q[i]) / 2;
    if (p[i] > 0) d += p[i] * Math.log2(p[i] / m) / 2;
    if (q[i] > 0) d += q[i] * Math.log2(q[i] / m) / 2;
  }
  return Math.sqrt(Math.max(0, d));
}
// The closest n rows can get to a mass: largest-remainder quotas, as golizer's floorJS.
function floorJS(mass, n) {
  const counts = mass.map(q => Math.floor(q * n));
  const order = mass.map((q, i) => i).sort((a, b) => (mass[b] * n - counts[b]) - (mass[a] * n - counts[a]));
  let left = n - counts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < order.length && left > 0; i++, left--) counts[order[i]]++;
  return jsArr(counts.map(c => c / n), mass);
}
function tpBinner(src) {
  let lo = Infinity, hi = 0;
  for (const s of src) { const v = Math.log10(total(s)); lo = Math.min(lo, v); hi = Math.max(hi, v); }
  hi += 1e-9;
  return s => Math.min(TP_BINS - 1, Math.max(0, Math.floor((Math.log10(total(s)) - lo) / (hi - lo) * TP_BINS)));
}
function massOf(rows, nb, bin) {
  const m = new Array(nb).fill(0);
  for (const s of rows) m[bin(s)] += 1 / rows.length;
  return m;
}
function distances(src, run) {
  const hs = hist2(src), hr = hist2(run);
  const keys = [...new Set([...hs.keys(), ...hr.keys()])];
  const p = keys.map(k => (hs.get(k) || { n: 0 }).n / src.length);
  const q = keys.map(k => (hr.get(k) || { n: 0 }).n / run.length);
  const tb = tpBinner(src);
  const tpS = massOf(src, TP_BINS, tb), tpR = massOf(run, TP_BINS, tb);
  return {
    crcw: jsArr(p, q), crcwFloor: floorJS([...hs.values()].map(a => a.n / src.length), run.length),
    tp: jsArr(tpS, tpR), tpFloor: floorJS(tpS, run.length),
  };
}
// Every (cr, cw) bin any series has, heaviest in the source first (as compareHist). Per bin
// and series: its share of that series' rows and its mean cr / cw / out (null where empty).
// series[0] is the source.
function crcwTable(series) {
  const hs = series.map(hist2);
  const keys = [...new Set(hs.flatMap(h => [...h.keys()]))];
  const share = (i, k) => (hs[i].get(k) || { n: 0 }).n / series[i].length;
  const rest = k => hs.reduce((a, h, i) => a + (i ? share(i, k) : 0), 0);
  const num = k => k.split(',').map(Number);
  keys.sort((a, b) => share(0, b) - share(0, a) || rest(b) - rest(a) ||
    num(a)[0] - num(b)[0] || num(a)[1] - num(b)[1]);
  return keys.map(k => {
    const [cr, cw] = num(k);
    return { cr: binRange(cr), cw: binRange(cw), v: hs.map((h, i) => {
      const a = h.get(k);
      return a ? [a.n / series[i].length, Math.round(a.cr / a.n), Math.round(a.cw / a.n), Math.round(a.out / a.n)]
        : [0, null, null, null];
    }) };
  });
}

// ── Chart data ────────────────────────────────────────────────────────────────
// Prompt-size bins, shared by every series, in both scalings (the page toggles them).
// c: [n, cacheRead, cacheWrite, decode] per bin; med: median response ms per bin (null = none).
function promptSeries(edges, rows) {
  const nb = edges.length - 1;
  const c = new Array(nb * 4).fill(0), ms = Array.from({ length: nb }, () => []);
  for (const s of rows) {
    const b = binOf(edges, total(s)), o = b * 4;
    c[o]++; c[o + 1] += s.cr; c[o + 2] += s.cw; c[o + 3] += s.out;
    if (s.ms != null) ms[b].push(s.ms);
  }
  return { c, med: ms.map(a => a.length ? Math.round(quantile(a.sort((x, y) => x - y), 0.5)) : null) };
}
function quantile(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0; }
function cdfOf(rows, get) {
  const v = rows.map(get).sort((a, b) => a - b);
  return { q: Array.from({ length: 101 }, (_, i) => quantile(v, i / 100)),
    marks: [0.1, 0.5, 0.9, 0.99].map(q => quantile(v, q)).concat([v[v.length - 1] || 0]) };
}
function totals(rows) {
  const t = [rows.length, 0, 0, 0, 0, 0];
  for (const s of rows) { t[1] += s.cr; t[2] += s.cw; t[3] += s.out; if (s.ms != null) { t[4] += s.ms; t[5]++; } }
  return t.map(Math.round);
}
// Sampled gauges, bucketed in time per node (mean of what landed in the bucket), so the page
// size depends on the bucket count, not the run's length. Fleet = mean share over nodes,
// summed requests. On the wire: shares in integer permille, requests to one decimal, the
// footprint in k tokens, the time axis implied by tMax and the bucket count, and a gauge a
// node never reported left out. The page decodes it (unpackPool).
function poolSeries(g, points = POOL_POINTS) {
  const S = (g && g.samples) || [];
  if (!S.length) return null;
  const nodes = (g.nodes && g.nodes.length) ? g.nodes : [...new Set(S.map(s => s.node))].map(String);
  let nn = nodes.length, tMax = 0;
  for (const s of S) { nn = Math.max(nn, (s.node || 0) + 1); tMax = Math.max(tMax, s.t || 0); }
  tMax = tMax || 1;
  const nb = Math.min(points, Math.max(1, Math.ceil(S.length / nn)));
  const KEYS = ['kv_pct', 'kv_res', 'host_pct', 'busy', 'running', 'waiting'];
  const acc = () => ({ sum: new Array(nb).fill(0), n: new Array(nb).fill(0) });
  const per = Array.from({ length: nn }, () => Object.fromEntries(KEYS.map(k => [k, acc()])));
  const foot = acc(), live = acc();
  const bucket = t => Math.min(nb - 1, Math.floor((t || 0) / tMax * nb));
  for (const s of S) {
    const b = bucket(s.t), p = per[s.node || 0];
    for (const k of KEYS) if (typeof s[k] === 'number' && isFinite(s[k])) { p[k].sum[b] += s[k]; p[k].n[b]++; }
    if ((s.node || 0) === 0) {
      if (typeof s.foot === 'number') { foot.sum[b] += s.foot; foot.n[b]++; }
      if (typeof s.live === 'number') { live.sum[b] += s.live; live.n[b]++; }
    }
  }
  const mean = a => a.sum.map((v, i) => a.n[i] ? +(v / a.n[i]).toPrecision(4) : null);
  // Per-node summary over the raw samples: mean / p95 / max of every gauge present.
  const stats = Array.from({ length: nn }, (_, node) => {
    const o = {};
    for (const k of KEYS) {
      const v = [];
      for (const s of S) if ((s.node || 0) === node && typeof s[k] === 'number' && isFinite(s[k])) v.push(s[k]);
      if (!v.length) continue;
      v.sort((x, y) => x - y);
      o[k] = [v.reduce((x, y) => x + y, 0) / v.length, quantile(v, 0.95), v[v.length - 1]].map(x => +x.toPrecision(4));
    }
    return o;
  });
  const SHARE = { kv_pct: 1, kv_res: 1, host_pct: 1, busy: 1 };
  const q = (k, v) => v == null ? null : SHARE[k] ? Math.round(v * 1000) : Math.round(v * 10) / 10;
  const series = per.map(p => {
    const o = {};
    for (const k of KEYS) { const m = mean(p[k]); if (m.some(v => v != null)) o[k] = m.map(v => q(k, v)); }
    return o;
  });
  const has = k => series.some(s => s[k]);
  return {
    nodes: nodes.map(String), nb, series, stats, tMax: Math.round(tMax),
    foot: mean(foot).map(v => v == null ? null : Math.round(v / 1000)),
    live: mean(live).map(v => v == null ? null : Math.round(v * 10) / 10),
    has: Object.fromEntries(KEYS.map(k => [k, has(k)])),
    busySrc: (S.find(s => s.busy_src) || {}).busy_src || null,
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────
const EXTRA_CSS = `
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}
table{border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums;width:100%}
th,td{padding:3px 6px;text-align:right;border-bottom:1px solid __border__;white-space:nowrap}
th{color:__muted__;font-weight:500}
th.g{text-align:center;border-bottom:none;padding-bottom:0}
td.l,th.l{text-align:left}
td .bar{display:inline-block;height:8px;border-radius:2px;vertical-align:middle;margin-right:6px}
.trow{display:flex;flex-wrap:wrap;align-items:stretch;gap:12px;margin:0 0 12px}
.trow .th{min-width:72px;display:flex;align-items:center;font-size:12px;font-weight:600;
  text-transform:uppercase;letter-spacing:.04em}
.tiles{display:block}
.tile.bad .v{color:__s2__}.tile.good .v{color:__s3__}
.tile .s{color:__muted__;font-size:11px;font-variant-numeric:tabular-nums}
select{font:inherit;font-size:12px;color:__primary__;background:__surface__;border:1px solid __border__;
  border-radius:6px;padding:2px 6px}
.method{color:__secondary__;font-size:13px}
.method p{margin:0 0 8px}.method code{font-size:12px}
`;
const MARKUP = `
  <h1 id="title"></h1>
  <p class="sub" id="sub"></p>
  <div class="tiles" id="tiles"></div>
  <div class="ctrl" id="scaleCtrl"></div>
  <div id="stacks"></div>
  <div class="card"><h2>Prompt size: source vs run</h2><p class="desc" id="overlay-desc"></p>
    <div class="legend" id="overlay-legend"></div><div id="overlay"></div></div>
  <div class="card"><h2>(cache read, cache write) bins</h2><p class="desc">the histogram golizer matches: log2 bins on both axes, share of responses, heaviest source bins first, with the per-bin mean cr / cw / out of each series<span id="crcw-note"></span></p><div id="crcw"></div></div>
  <div class="card"><h2>Marginals</h2><p class="desc">cumulative distribution of each token count, the source against each run, log x; p10 / p50 / p90 / p99 / max below each panel</p>
    <div class="legend" id="cdf-legend"></div><div class="grid3" id="cdf"></div></div>
  <div id="runcards"></div>
  <div class="card"><h2>Latency</h2><p class="desc">median response time per prompt-size bin: each run (server-reported total where the engine gave one, else client time) against the source (the real service, not comparable; shown faintly for scale)</p>
    <div class="legend" id="lat-legend"></div><div id="lat"></div></div>
  <div class="card"><h2>Method</h2><div class="method" id="method"></div></div>
`;

// Client code. Written as a real function so it is plain JS here; its source text is spliced
// into the page with CHART_LIB in place of the marker. DATA, CSS_T and MARKUP are the page's.
// DATA.series[0] is the source, the rest are runs (histo first); every per-series id below is
// suffixed with the series index.
function page() {
  var D = DATA, meta = D.meta, SER = D.series, RUNS = SER.slice(1);
  var host = document.getElementById(HOST);
  if(!host) return;
  var root = host.shadowRoot || host.attachShadow({mode:'open'});
  root.innerHTML = '';
  /*CHART_LIB*/
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var PAL = (mq && mq.matches) ? DARK : LIGHT;
  function css(P){ return CSS_T.replace(/__(\w+)__/g, function(_, k){ return P[k]; }); }
  var styleEl = document.createElement('style');
  var wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = MARKUP;
  root.appendChild(styleEl); root.appendChild(wrap);
  function $(id){ return root.getElementById(id); }
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

  function esc(s){ return String(s).replace(/[&<>"']/g, function(c){
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }
  function pc(v, d){ return (100*v).toFixed(d == null ? 1 : d) + '%'; }
  function js3(v){ return v == null ? '—' : v.toFixed(3); }
  // Series colours: the source blue, histo orange, replay purple — fixed by kind, so the same
  // run reads the same colour on every chart and in every report.
  var PURPLE = {light:'#7b5bd6', dark:'#9a7ff0'};
  function col(s){
    if(s.key === 'src') return PAL.s1;
    return s.mode === 'window' ? PAL.s2 : (PAL === DARK ? PURPLE.dark : PURPLE.light);
  }
  function unit(s){ return s.mode === 'window' ? 'window' : 'session'; }
  // Undo poolSeries' wire format: the time axis, shares from permille, tokens from k.
  function unpackPool(P){
    var K = ['kv_pct','kv_res','host_pct','busy','running','waiting'], SH = {kv_pct:1, kv_res:1, host_pct:1, busy:1};
    P.t = []; for(var i=0; i<P.nb; i++) P.t.push((i + 0.5) * P.tMax / P.nb);
    var none = P.t.map(function(){ return null; });
    P.series = P.series.map(function(o){
      var out = {};
      K.forEach(function(k){ out[k] = o[k] ? o[k].map(function(v){ return v == null ? null : SH[k] ? v/1000 : v; }) : none; });
      return out;
    });
    P.foot = P.foot.map(function(v){ return v == null ? null : v * 1000; });
  }
  RUNS.forEach(function(s){ if(s.pool) unpackPool(s.pool); });
  function swatch(s){ return '<span><i style="background:'+col(s)+'"></i>'+esc(s.name)+'</span>'; }

  // Prompt bins for one series: [{lo, hi, c:[n, cr, cw, out], med}].
  function bins(s, log){
    var e = log ? D.edges.log : D.edges.lin, h = log ? s.hist.log : s.hist.lin, out = [];
    for(var b=0; b<e.length-1; b++)
      out.push({lo: e[b], hi: e[b+1], c: h.c.slice(b*4, b*4+4), med: h.med[b]});
    return out;
  }
  function meansOf(t){ var n = t[0] || 1;
    return {cr: t[1]/n, cw: t[2]/n, dec: t[3]/n, total: (t[1]+t[2]+t[3])/n}; }

  // ── Static per-series markup ───────────────────────────────────────────────
  (function(){
    var h = '';
    SER.forEach(function(s, i){
      var desc = i === 0
        ? 'share of responses binned by total prompt (cache read + cache write + decode), each bar stacked by the token share of that bin; dashed lines mark the average composition, cumulative on the token axis. Every stack below shares this y scale.'
        : 'the same bins for what the server served in the ' + esc(s.name) + ' run (<code>' + esc(s.file) + '</code>): cache read = cached_tokens, cache write = prompt − cached, decode = completion' +
          (s.mode === 'window' ? '; a window contributes up to ' + s.maxTurns + ' nearly identical sizes, so the run spreads only as finely as its ' + s.units.length + ' windows' : '');
      h += '<div class="card"><h2>Prompt Size Distribution — ' + (i === 0 ? 'source' : esc(s.name) + ' run') + '</h2><p class="desc">' + desc + '</p>' +
        '<div class="legend" id="stack-leg-'+i+'"></div><div id="stack-'+i+'"></div></div>';
    });
    $('stacks').innerHTML = h;
    var r = '';
    RUNS.forEach(function(s, j){
      var i = j + 1;
      r += '<div class="card"><h2 id="units-h-'+i+'"></h2><p class="desc" id="units-desc-'+i+'"></p><div id="units-'+i+'"></div></div>';
      if(s.pool) r += '<div class="card" id="pool-card-'+i+'"><h2>Pool over the ' + esc(s.name) + ' run</h2><p class="desc">sampled from the servers while the run played: KV pool in-flight share (blocks held by running requests), resident share (in-flight plus cached prefixes; a warm cache sits near 100%), host tier, engine busy, and golizer’s own live footprint as a share of the fleet pool; running and waiting requests on the right axis</p>' +
        '<div class="ctrl" id="pool-ctrl-'+i+'"></div><div class="legend" id="pool-legend-'+i+'"></div><div id="pool-'+i+'"></div><div id="pool-stats-'+i+'"></div></div>';
    });
    $('runcards').innerHTML = r;
    var leg = SER.map(swatch).join('');
    $('overlay-legend').innerHTML = leg; $('cdf-legend').innerHTML = leg; $('lat-legend').innerHTML = leg;
    $('overlay-desc').textContent = 'share of responses per prompt-size bin, the source as filled bars, ' +
      (RUNS.length > 1 ? 'each run as an outline' : 'the run as an outline') + ' on the same bins';
  })();

  function drawStack(id, bs, N, log, maxH, mean){
    drawBins(id, bs, log, {
      maxH: maxH,
      height: function(b){ return 100*b.c[0]/N; },
      segs: function(b){ return [[PAL.s1, b.c[1]], [PAL.s2, b.c[2]], [PAL.s3, b.c[3]]]; },
      fmtY: function(v){ return (v > 0 && v < 0.1 ? v.toFixed(2) : v.toFixed(1)) + '%'; },
      xlabel: 'total prompt tokens',
      tip: function(b){
        var tot = b.c[1]+b.c[2]+b.c[3] || 1, n = b.c[0] || 1;
        var seg = function(v){ return fmt(v/n) + ' (' + pct(v, tot) + ')'; };
        return '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok<br><b>'+b.c[0]+'</b> responses ('+
          pc(b.c[0]/N, 2)+')<br>read '+seg(b.c[1])+'<br>write '+seg(b.c[2])+'<br>decode '+seg(b.c[3]);
      },
      marks: function(svg, bs2, bw){
        [[mean.cr, PAL.s1], [mean.cr+mean.cw, PAL.s2], [mean.total, PAL.s3]].forEach(function(m){
          if(!(m[0] > 0)) return;
          var x = binX(bs2, log, m[0], bw);
          svg.appendChild(el('line',{x1:x, y1:M.t, x2:x, y2:M.t+IH, stroke:m[1],
            'stroke-width':1.5, 'stroke-dasharray':'5 4'}));
        });
      }
    });
  }
  function stackLegend(id, mean){
    $(id).innerHTML =
      '<span><i class="sw0"></i>Prompt Size: <b>'+fmt(mean.total)+'</b></span>'+
      '<span><i class="sw1"></i>Cache Read: <b>'+fmt(mean.cr)+'</b></span>'+
      '<span><i class="sw2"></i>Cache Write: <b>'+fmt(mean.cw)+'</b></span>'+
      '<span><i class="sw3"></i>Decode: <b>'+fmt(mean.dec)+'</b></span>';
  }

  // The source as filled bars, each run as an outlined step on the same bins and scale.
  function drawOverlay(B, log){
    var svg = blankSvg($('overlay'));
    var N = SER.map(function(s){ return s.tot[0] || 1; }), maxH = 1e-9;
    B.forEach(function(bs, k){ bs.forEach(function(b){ maxH = Math.max(maxH, b.c[0]/N[k]); }); });
    for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
      svg.appendChild(gridLine(y)); svg.appendChild(tickText(M.l-8, y+4, 'end', pc(maxH*g/4))); }
    svg.appendChild(axisLine());
    var bs = B[0], bw = IW / bs.length, step = Math.ceil(bs.length/8), d = SER.map(function(){ return ''; });
    bs.forEach(function(b, i){
      var x = M.l + i*bw, hs = IH*(b.c[0]/N[0])/maxH;
      if(hs > 0) svg.appendChild(el('rect',{x:x+1, y:M.t+IH-hs, width:Math.max(1,bw-2), height:hs,
        fill:col(SER[0]), 'fill-opacity':0.45}));
      for(var k=1; k<SER.length; k++){
        var hr = IH*(B[k][i].c[0]/N[k])/maxH;
        d[k] += (i ? ' L' : 'M') + x.toFixed(1) + ' ' + (M.t+IH-hr).toFixed(1) + ' L' + (x+bw).toFixed(1) + ' ' + (M.t+IH-hr).toFixed(1);
      }
      var hit = el('rect',{x:x, y:M.t, width:bw, height:IH, fill:'transparent'});
      hit.addEventListener('mousemove', function(e){
        var t = '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok';
        SER.forEach(function(s, k){ t += '<br>'+esc(s.name)+' '+pc(B[k][i].c[0]/N[k], 2)+' ('+B[k][i].c[0]+')'; });
        showTip(t, e); });
      hit.addEventListener('mouseleave', hideTip);
      svg.appendChild(hit);
      if(i % step === 0) svg.appendChild(tickText(x, M.t+IH+16, 'middle', fmt(b.lo)));
    });
    for(var k=1; k<SER.length; k++)
      svg.appendChild(el('path',{d:d[k], fill:'none', stroke:col(SER[k]), 'stroke-width':1.75, 'pointer-events':'none'}));
    svg.appendChild(axisLabel(M.l+IW/2, H-4, 'total prompt tokens' + (log ? ' (log bins)' : '')));
  }

  function drawCrcw(){
    var show = D.crcw, max = 1e-9, S = SER.length;
    show.forEach(function(r){ r.v.forEach(function(v){ max = Math.max(max, v[0]); }); });
    var bar = function(v, c){ return '<span class="bar" style="width:'+Math.round(48*v/max)+'px;background:'+c+'"></span>'; };
    var h = '<table><tr><th></th><th></th>';
    SER.forEach(function(s){ h += '<th class="l">share</th>'; });
    SER.forEach(function(s){ h += '<th class="g" colspan="3" style="color:'+col(s)+'">'+esc(s.name)+' mean</th>'; });
    h += '</tr><tr><th class="l">cache read</th><th class="l">cache write</th>';
    SER.forEach(function(s){ h += '<th class="l" style="color:'+col(s)+'">'+esc(s.name)+'</th>'; });
    for(var k=0; k<S; k++) h += '<th>cr</th><th>cw</th><th>out</th>';
    h += '</tr>';
    var m = function(v){ return v == null ? '–' : fmt(v); };
    show.forEach(function(r){
      h += '<tr><td class="l">'+r.cr+'</td><td class="l">'+r.cw+'</td>';
      r.v.forEach(function(v, k){ h += '<td class="l">'+bar(v[0], col(SER[k]))+pc(v[0])+'</td>'; });
      r.v.forEach(function(v){ h += '<td>'+m(v[1])+'</td><td>'+m(v[2])+'</td><td>'+m(v[3])+'</td>'; });
      h += '</tr>';
    });
    $('crcw').innerHTML = h + '</table>';
    $('crcw-note').textContent = RUNS.map(function(s){ return ' · ' + s.name + ' JS ' + js3(s.js.crcw) + ' (floor ' +
      js3(s.js.crcwFloor) + ' for ' + fmt(s.tot[0]) + ' rows)'; }).join('') +
      (D.crcwMore ? ' · ' + D.crcwMore + ' lighter bins not shown' : '');
  }

  function drawCdf(){
    var hostEl = $('cdf'); hostEl.innerHTML = '';
    var w = 300, h = 190, m = {t:10, r:10, b:34, l:36}, iw = w-m.l-m.r, ih = h-m.t-m.b;
    [['cr','cache read'], ['cw','cache write'], ['out','decode']].forEach(function(k){
      var box = document.createElement('div');
      var svg = el('svg', {viewBox:'0 0 '+w+' '+h, width:w, height:h, role:'img'});
      var all = [];
      SER.forEach(function(s){ s.cdf[k[0]].q.forEach(function(v){ if(v > 0) all.push(v); }); });
      var lo = Math.log10(Math.max(1, Math.min.apply(null, all.length ? all : [1])));
      var hi = Math.log10(Math.max.apply(null, all.length ? all : [10]));
      if(hi <= lo) hi = lo + 1;
      var sx = function(v){ return m.l + iw * (Math.log10(Math.max(1, v)) - lo) / (hi - lo); };
      var sy = function(p){ return m.t + ih - ih * p; };
      for(var g=0; g<=4; g++){ var y = sy(g/4);
        svg.appendChild(el('line',{x1:m.l, y1:y, x2:m.l+iw, y2:y, stroke:PAL.grid, 'stroke-width':1}));
        var t = el('text',{x:m.l-4, y:y+4, 'text-anchor':'end', fill:PAL.muted, 'font-size':10}); t.textContent = (25*g)+'%'; svg.appendChild(t); }
      for(var e=Math.ceil(lo); e<=Math.floor(hi); e++){
        if(sx(Math.pow(10,e)) < m.l + 14) continue;
        var tx = el('text',{x:sx(Math.pow(10,e)), y:m.t+ih+14, 'text-anchor':'middle', fill:PAL.muted, 'font-size':10});
        tx.textContent = fmt(Math.pow(10,e)); svg.appendChild(tx); }
      SER.forEach(function(s){
        var d = '';
        s.cdf[k[0]].q.forEach(function(v, i){ d += (i ? ' L' : 'M') + sx(v).toFixed(1) + ' ' + sy(i/100).toFixed(1); });
        svg.appendChild(el('path',{d:d, fill:'none', stroke:col(s), 'stroke-width':1.75}));
      });
      var lab = el('text',{x:m.l+iw/2, y:h-4, 'text-anchor':'middle', fill:PAL.secondary, 'font-size':11});
      lab.textContent = k[1] + ' tokens (log)'; svg.appendChild(lab);
      box.appendChild(svg);
      var q = document.createElement('div'); q.className = 'foot';
      var qs = function(a){ return a.map(fmt).join(' / '); };
      q.innerHTML = SER.map(function(s){ return '<span style="color:'+col(s)+'">'+esc(s.name)+'</span> '+qs(s.cdf[k[0]].marks); }).join('<br>');
      box.appendChild(q);
      hostEl.appendChild(box);
    });
  }

  // One horizontal bar per window / session: its context span, in play order.
  function drawUnits(s, i){
    var U = s.units, n = U.length, c = col(s);
    $('units-h-'+i).textContent = (s.mode === 'window' ? 'Windows' : 'Sessions') + ' played in the ' + s.name + ' run (' + n + ')';
    $('units-desc-'+i).textContent = s.mode === 'window'
      ? 'each bar is one window: its context from the first turn’s cache read to the largest prompt + output, in play order. A window is up to '+s.maxTurns+' consecutive turns of one real session on its own token stream, after one untallied cold build of the starting prefix.'
      : 'each bar is one replayed session: its context from the first turn’s cache read to the largest prompt + output, in play order; whole sessions, main and subagent chains alike. Sessions with cache misses are drawn in red.';
    var hostEl = $('units-'+i);
    var rowH = Math.max(1.5, Math.min(10, 520 / Math.max(1, n))), h = Math.round(M.t + M.b + rowH * n + 4);
    var svg = el('svg', {viewBox:'0 0 '+W+' '+h, width:W, height:h, role:'img'});
    hostEl.innerHTML = ''; hostEl.appendChild(svg);
    var xMax = 1, tMax = 1;
    U.forEach(function(u){ xMax = Math.max(xMax, u[1]); tMax = Math.max(tMax, u[2]); });
    var ih = h - M.t - M.b, sx = function(v){ return M.l + IW * v / xMax; };
    for(var g=0; g<=4; g++){ var x = M.l + IW*g/4;
      svg.appendChild(el('line',{x1:x, y1:M.t, x2:x, y2:M.t+ih, stroke:PAL.grid, 'stroke-width':1}));
      svg.appendChild(tickText(x, M.t+ih+16, g === 4 ? 'end' : 'middle', fmt(xMax*g/4))); }
    U.forEach(function(u, k){
      var y = M.t + k*rowH, x0 = sx(u[0]), w = Math.max(1.5, sx(u[1]) - x0);
      var r = el('rect',{x:x0, y:y+0.15*rowH, width:w, height:Math.max(1, 0.7*rowH), fill:u[4] ? MISS : c,
        'fill-opacity':(0.35 + 0.65*u[2]/tMax).toFixed(2)});
      r.addEventListener('mousemove', function(e){ showTip('<b>'+esc(u[3])+'</b><br>'+fmt(u[0])+' → '+fmt(u[1])+
        ' tok<br>'+u[2]+' turns'+(u[4] != null ? '<br>'+u[4]+' cache miss'+(u[4] === 1 ? '' : 'es') : ''), e); });
      r.addEventListener('mouseleave', hideTip);
      svg.appendChild(r);
    });
    var l = el('text',{x:M.l+IW/2, y:h-4, 'text-anchor':'middle', fill:PAL.secondary, 'font-size':12});
    l.textContent = 'context tokens (opacity = turns, max ' + tMax + ')'; svg.appendChild(l);
  }
  var MISS = '#d03b3b';

  // Pool gauges for one node or the fleet: shares on the left axis, requests on the right.
  var poolSel = {};
  function poolPick(P, sel){
    var nn = P.series.length;
    if(sel !== 'fleet') return P.series[+sel];
    var out = {};
    ['kv_pct','kv_res','host_pct','busy','running','waiting'].forEach(function(k){
      out[k] = P.t.map(function(_, i){
        var s = 0, n = 0;
        for(var j=0; j<nn; j++){ var v = P.series[j][k][i]; if(v != null){ s += v; n++; } }
        if(!n) return null;
        return (k === 'running' || k === 'waiting') ? s : s/n;
      });
    });
    return out;
  }
  function drawPool(s, i){
    var P = s.pool;
    if(!P) return;
    var sel = poolSel[i] || 'fleet', S = poolPick(P, sel), svg = blankSvg($('pool-'+i));
    var g0 = s.golizer || {};
    var tMax = P.t[P.t.length-1] || 1, sx = function(t){ return M.l + IW * t / tMax; };
    var footShare = (sel === 'fleet' && g0.pool_tokens > 0)
      ? P.foot.map(function(v){ return v == null ? null : v / g0.pool_tokens; }) : null;
    var lines = [['kv_pct', 'in-flight', PAL.s1, ''], ['kv_res', 'resident', PAL.s1, '5 3'],
      ['host_pct', 'host tier', PAL.s3, ''], ['busy', 'busy', PAL.secondary, '2 3']];
    var yMax = 1;
    lines.forEach(function(l){ (S[l[0]] || []).forEach(function(v){ if(v != null) yMax = Math.max(yMax, v); }); });
    if(footShare) footShare.forEach(function(v){ if(v != null) yMax = Math.max(yMax, v); });
    var rMax = 1;
    ['running','waiting'].forEach(function(k){ S[k].forEach(function(v){ if(v != null) rMax = Math.max(rMax, v); }); });
    var sy = function(v){ return M.t + IH - IH * v / yMax; }, sr = function(v){ return M.t + IH - IH * v / rMax; };
    for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
      svg.appendChild(gridLine(y));
      svg.appendChild(tickText(M.l-8, y+4, 'end', pc(yMax*g/4, 0)));
      svg.appendChild(tickText(W-1, y-3, 'end', rMax < 8 ? (rMax*g/4).toFixed(1) : String(Math.round(rMax*g/4)))); }
    svg.appendChild(axisLine());
    for(var g2=0; g2<=4; g2++) svg.appendChild(tickText(M.l + IW*g2/4, M.t+IH+16, g2 === 4 ? 'end' : 'middle', fmtDur(1000*tMax*g2/4)));
    var path = function(arr, f, attrs){
      var d = '', on = false;
      arr.forEach(function(v, k){ if(v == null){ on = false; return; }
        d += (on ? ' L' : 'M') + sx(P.t[k]).toFixed(1) + ' ' + f(v).toFixed(1); on = true; });
      if(d){ attrs.d = d; attrs.fill = 'none'; svg.appendChild(el('path', attrs)); }
    };
    // requests as a faint area behind the shares
    var area = 'M' + sx(P.t[0]).toFixed(1) + ' ' + (M.t+IH);
    S.running.forEach(function(v, k){ area += ' L' + sx(P.t[k]).toFixed(1) + ' ' + sr(v || 0).toFixed(1); });
    area += ' L' + sx(P.t[P.t.length-1]).toFixed(1) + ' ' + (M.t+IH) + ' Z';
    svg.appendChild(el('path',{d:area, fill:PAL.muted, 'fill-opacity':0.18, stroke:'none'}));
    path(S.waiting, sr, {stroke:PAL.muted, 'stroke-width':1, 'stroke-dasharray':'1 2'});
    var legend = '';
    lines.forEach(function(l){
      if(!P.has[l[0]]) return;
      path(S[l[0]], sy, {stroke:l[2], 'stroke-width':1.5, 'stroke-dasharray':l[3]});
      legend += '<span><i style="background:'+l[2]+'"></i>'+l[1]+(l[0]==='busy' && P.busySrc ? ' ('+esc(P.busySrc)+')' : '')+'</span>';
    });
    if(footShare){ path(footShare, sy, {stroke:PAL.s2, 'stroke-width':1.5});
      legend += '<span><i class="sw2"></i>live footprint / pool</span>'; }
    legend += '<span><i style="background:'+PAL.muted+';opacity:.4"></i>running (right)</span><span>⋯ waiting (right)</span>';
    $('pool-legend-'+i).innerHTML = legend;
    var hit = el('rect',{x:M.l, y:M.t, width:IW, height:IH, fill:'transparent'});
    hit.addEventListener('mousemove', function(e){
      var r = hit.getBoundingClientRect ? hit.getBoundingClientRect() : {left:0, width:IW};
      var k = Math.max(0, Math.min(P.t.length-1, Math.round((e.clientX - r.left) / (r.width || IW) * (P.t.length-1))));
      var f = function(v){ return v == null ? '–' : pc(v); };
      showTip('<b>'+fmtDur(1000*P.t[k])+'</b><br>in-flight '+f(S.kv_pct[k])+'<br>resident '+f(S.kv_res[k])+
        (P.has.host_pct ? '<br>host tier '+f(S.host_pct[k]) : '')+(P.has.busy ? '<br>busy '+f(S.busy[k]) : '')+
        (footShare ? '<br>footprint '+fmt(P.foot[k] || 0)+' ('+f(footShare[k])+')' : '')+
        '<br>running '+(S.running[k] == null ? '–' : fmt(S.running[k]))+' · waiting '+(S.waiting[k] == null ? '–' : fmt(S.waiting[k]))+
        (P.live[k] != null ? '<br>live '+unit(s)+'s '+fmt(P.live[k]) : ''), e);
    });
    hit.addEventListener('mouseleave', hideTip);
    svg.appendChild(hit);
    svg.appendChild(axisLabel(M.l+IW/2, H-4, 'time into the run'));
  }
  function poolControls(s, i){
    var P = s.pool;
    if(!P || P.series.length < 2) return;
    var lab = document.createElement('label'), sel = document.createElement('select');
    var opt = function(v, t){ var o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
    opt('fleet', 'fleet (' + P.series.length + ' nodes: mean share, summed requests)');
    P.nodes.forEach(function(n, k){ opt(String(k), 'node ' + k + ' ' + n); });
    sel.addEventListener('change', function(){ poolSel[i] = sel.value; drawPool(s, i); });
    var sp = document.createElement('span'); sp.className = 'lbl'; sp.textContent = 'node';
    lab.appendChild(sp); lab.appendChild(sel);
    $('pool-ctrl-'+i).appendChild(lab);
  }
  function poolStats(s, i){
    var P = s.pool;
    if(!P) return;
    var f = function(st, k, all){ var v = st[k]; if(!v) return '–';
      return all ? pc(v[0])+' / '+pc(v[1])+' / '+pc(v[2]) : pc(v[0])+' / '+pc(v[2]); };
    var n = function(st, k){ var v = st[k]; return v ? v[0].toFixed(1)+' / '+fmt(v[2]) : '–'; };
    var h = '<table><tr><th class="l">node</th><th>in-flight mean / p95 / max</th><th>resident mean / max</th>'+
      (P.has.host_pct ? '<th>host tier mean / max</th>' : '')+(P.has.busy ? '<th>busy mean / max</th>' : '')+
      '<th>running mean / max</th><th>waiting mean / max</th></tr>';
    P.stats.forEach(function(st, k){
      h += '<tr><td class="l">'+k+' '+esc(P.nodes[k] || '')+'</td><td>'+f(st, 'kv_pct', 1)+'</td><td>'+f(st, 'kv_res')+'</td>'+
        (P.has.host_pct ? '<td>'+f(st, 'host_pct')+'</td>' : '')+(P.has.busy ? '<td>'+f(st, 'busy')+'</td>' : '')+
        '<td>'+n(st, 'running')+'</td><td>'+n(st, 'waiting')+'</td></tr>';
    });
    $('pool-stats-'+i).innerHTML = '<p class="foot">per node over every sample</p>' + h + '</table>';
  }

  function drawLatency(B, log){
    var svg = blankSvg($('lat'));
    var yMax = 1;
    B.forEach(function(bs){ bs.forEach(function(b){ if(b.med != null) yMax = Math.max(yMax, b.med); }); });
    for(var g=0; g<=4; g++){ var y = M.t + IH - IH*g/4;
      svg.appendChild(gridLine(y)); svg.appendChild(tickText(M.l-8, y+4, 'end', fmtMs(yMax*g/4))); }
    svg.appendChild(axisLine());
    var bw = IW / B[0].length, step = Math.ceil(B[0].length/8);
    var sy = function(v){ return M.t + IH - IH * v / yMax; };
    SER.forEach(function(s, k){
      var d = '', on = false;
      B[k].forEach(function(b, i){ if(b.med == null){ on = false; return; }
        d += (on ? ' L' : 'M') + (M.l + (i+0.5)*bw).toFixed(1) + ' ' + sy(b.med).toFixed(1); on = true; });
      if(d) svg.appendChild(el('path',{d:d, fill:'none', stroke:col(s), 'stroke-width':1.75, 'stroke-opacity':k ? 1 : 0.5}));
      if(!k) return;
      B[k].forEach(function(b, i){
        if(b.med == null) return;
        var c = el('circle',{cx:M.l + (i+0.5)*bw, cy:sy(b.med), r:3, fill:col(s)});
        c.addEventListener('mousemove', function(e){
          var t = '<b>'+fmt(b.lo)+'</b>–<b>'+fmt(b.hi)+'</b> tok';
          SER.forEach(function(s2, k2){ var m = B[k2][i].med;
            if(m != null) t += '<br>'+esc(s2.name)+' median <b>'+fmtMs(m)+'</b> · '+B[k2][i].c[0]+' resp'; });
          showTip(t, e); });
        c.addEventListener('mouseleave', hideTip);
        svg.appendChild(c);
      });
    });
    B[0].forEach(function(b, i){ if(i % step === 0) svg.appendChild(tickText(M.l + i*bw, M.t+IH+16, 'middle', fmt(b.lo))); });
    svg.appendChild(axisLabel(M.l+IW/2, H-4, 'total prompt tokens' + (log ? ' (log bins)' : '')));
  }

  // One tile row per series: the source's size, then each run's verdict.
  function tiles(){
    var h = '';
    SER.forEach(function(s, i){
      var t = [], g = s.golizer || {};
      var add = function(v, k, sub, cls){ t.push([v, k, sub || '', cls || '']); };
      if(i === 0){
        add(fmt(s.tot[0]), 'rows', meta.srcSessions + ' sessions');
        add(fmt(meansOf(s.tot).total), 'mean prompt', 'cache read + write + decode');
        if(s.tot[5]) add(fmtMs(s.tot[4]/s.tot[5]), 'mean response', 'the real service');
      } else {
        add(fmt(s.tot[0]), 'rows', s.units.length + ' ' + unit(s) + 's');
        add(js3(s.js.crcw), 'JS (cr, cw)', 'floor ' + js3(s.js.crcwFloor), s.js.crcw < 0.05 ? 'good' : 'bad');
        add(js3(s.js.tp), 'JS total prompt', 'floor ' + js3(s.js.tpFloor), s.js.tp < 0.05 ? 'good' : 'bad');
        var R = s.replay;
        if(R){
          add(pc(R.paired / (R.rows || 1)), 'fidelity', R.paired + ' of ' + R.rows + ' rows match their source row',
            R.paired === R.rows ? 'good' : 'bad');
          add(fmt(R.miss), 'cache misses', (R.miss - R.first - R.branch) + ' in-chain · ' + R.first + ' first-turn · ' + R.branch + ' branch · ' + fmt(R.tok) + ' tok re-prefilled',
            R.miss ? 'bad' : 'good');
        }
        if(g.pool_tokens > 0) add(fmt(g.headroom), 'headroom', 'pool ' + fmt(g.pool_tokens) + ' − peak ' + fmt(g.peak_foot), g.headroom < 0 ? 'bad' : 'good');
        if(s.pool) add(fmtDur(1000*s.pool.tMax), 'wall time', 'first to last sample');
        if(s.tot[5]) add(fmtMs(s.tot[4]/s.tot[5]), 'mean response', fmt(s.tot[5]) + ' timed');
      }
      h += '<div class="trow"><div class="th" style="color:'+col(s)+'">'+esc(s.name)+'</div>' + t.map(function(x){
        return '<div class="tile '+x[3]+'"><div class="v">'+esc(x[0])+'</div><div class="k">'+esc(x[1])+'</div><div class="s">'+esc(x[2])+'</div></div>'; }).join('') + '</div>';
    });
    $('tiles').innerHTML = h;
  }

  function method(){
    var p = [];
    var files = meta.files.map(function(f){ return '<code>'+esc(f.file)+'</code> ('+fmt(f.rows)+' rows, '+f.sessions+' sessions)'; }).join(', ');
    p.push('<b>Source:</b> ' + files + '. Read as golizer reads it: sessions deduped by fingerprint across files' +
      (meta.dups ? ' (' + meta.dups + ' dropped)' : '') + ', haiku/sonnet/opus/fable rows only, a row is ' +
      '(cr = cache read, cw = cache write + input, out = output)' +
      (meta.maxCtx ? ', rows over -max-ctx ' + fmt(meta.maxCtx) + ' dropped (' + meta.dropped + ')' : '') + '.');
    RUNS.forEach(function(s){
      var g = s.golizer || {};
      p.push('<b>' + esc(s.name) + ' run:</b> <code>' + esc(s.file) + '</code>, golizer ' + (s.mode === 'window'
        ? '<code>histo</code> (window replay, up to ' + s.maxTurns + ' turns a window)' : '<code>replay</code> (session replay)') +
        (g.concurrency ? ', concurrency ' + g.concurrency : '') + (g.budget ? ', budget ' + fmt(g.budget) : '') +
        (g.nodes && g.nodes.length ? ', ' + g.nodes.length + ' target' + (g.nodes.length === 1 ? '' : 's') + ': ' +
          g.nodes.map(function(n){ return '<code>'+esc(n)+'</code>'; }).join(', ') : '') +
        (s.replay && s.replay.unknown ? '; ' + s.replay.unknown + ' run sessions not found in the source' : '') + '.');
    });
    p.push('Each tallied request is the server’s own accounting (cached, prompt − cached, completion); cold builds are not in it. ' +
      '<b>Distances:</b> Jensen–Shannon (base 2, 0 = identical, &lt;0.05 good) over golizer’s log2 × log2 (cr, cw) bins and over ' +
      '96 log10 bins of total prompt spanning the source; the floor is the closest the run’s row count could get.');
    if(RUNS.some(function(s){ return s.replay; })) p.push('<b>Fidelity and misses (replay):</b> each served row is paired with the source row of the same session it replays ' +
      '(output exact, total prompt within 1,152 tokens: golizer floors each turn to a 64-token block and carries the lag, up to 1,024, into a later write). ' +
      'A miss is a paired row that read less than its prefix: <i>in-chain</i>, a row continuing an earlier turn of its chain read more than a block short of that turn’s served prompt; ' +
      '<i>first-turn</i>, the first row after a cold build (a session’s first, or a cr past every stream built so far) read short of the source’s cr (the cold build was evicted); <i>branch</i>, a compaction or a subagent read more than 1,152 short of the source’s cr ' +
      '(the prefix it branches off was gone). Tokens re-prefilled is the sum of the shortfalls.');
    if(RUNS.some(function(s){ return s.mode === 'window'; })) p.push('A histo window carries no link back to the source rows it plays, so a histo run has no fidelity or cache-miss tiles; the distances are its acceptance test.');
    $('method').innerHTML = p.map(function(x){ return '<p>'+x+'</p>'; }).join('');
  }

  var logOn = !!meta.log;
  function render(){
    var B = SER.map(function(s){ return bins(s, logOn); });
    var maxH = 0;
    B.forEach(function(bs, k){ bs.forEach(function(b){ maxH = Math.max(maxH, 100*b.c[0]/(SER[k].tot[0] || 1)); }); });
    SER.forEach(function(s, i){
      var m = meansOf(s.tot);
      drawStack('stack-'+i, B[i], s.tot[0] || 1, logOn, maxH, m); stackLegend('stack-leg-'+i, m);
    });
    drawOverlay(B, logOn);
    drawCrcw(); drawCdf();
    RUNS.forEach(function(s, j){ drawUnits(s, j+1); drawPool(s, j+1); });
    drawLatency(B, logOn);
  }

  var lab = document.createElement('label'), cb = document.createElement('input');
  cb.type = 'checkbox'; cb.checked = logOn;
  cb.addEventListener('change', function(){ logOn = cb.checked; render(); });
  lab.appendChild(cb); lab.appendChild(document.createTextNode('log scaling (prompt-size bins)'));
  $('scaleCtrl').appendChild(lab);
  $('title').textContent = meta.title;
  $('sub').textContent = RUNS.map(function(s){ return 'golizer ' + (s.mode === 'window' ? 'histo' : 'replay') +
      (s.golizer && s.golizer.nodes ? ' on ' + s.golizer.nodes.length + ' node' + (s.golizer.nodes.length === 1 ? '' : 's') : ''); }).join(' · ') +
    ' · generated ' + meta.generatedAt.replace('T', ' ').slice(0, 16);
  RUNS.forEach(function(s, j){ poolControls(s, j+1); poolStats(s, j+1); });
  tiles(); method();
  render();
}

// The page script — data, stylesheet, markup and client code — ships gzipped and base64'd
// inside a loader of a few plain ASCII lines. Confluence's HTML macro rewrites script text it
// is given (a pasted report failed with a SyntaxError that the same text does not raise
// anywhere else), and base64 leaves it nothing to rewrite; gzip also makes the paste a third
// of its plain size. The browser unpacks it with DecompressionStream and runs it as an inline
// <script> (not eval, which a page's CSP may forbid), so it still needs no network and no
// library. unpackScript() is the inverse, for tests and debugging.
function pageScript(data) {
  const payload = JSON.stringify(data).replace(/</g, '\\u003c');
  const body = page.toString().replace('/*CHART_LIB*/', () => CHART_LIB);
  return `(function(){
var DATA = ${payload};
var CSS_T = ${JSON.stringify(CSS_TEMPLATE + EXTRA_CSS)};
var MARKUP = ${JSON.stringify(MARKUP)};
var HOST = ${JSON.stringify(HOST_ID)};
(${body})();
})();`;
}
function reportBlock(data) {
  const packed = zlib.gzipSync(pageScript(data), { level: 9 }).toString('base64');
  // Same shape as a block Confluence is known to accept: a <style> first, then the host, then
  // the script. A body opening with the empty host <div> straight into <script> broke.
  return `<style>
#${HOST_ID}{display:block;min-height:120px}
</style>
<div id="${HOST_ID}"></div>
<script>
(function(){
var b = atob("${packed}"), u = new Uint8Array(b.length);
for (var i = b.length; i--;) u[i] = b.charCodeAt(i);
var z = new Response(new Blob([u]).stream().pipeThrough(new DecompressionStream("gzip")));
z.text().then(function(js){ var s = document.createElement("script"); s.textContent = js; document.body.appendChild(s); });
})();
</script>`;
}
function unpackScript(html) {
  const m = /atob\("([A-Za-z0-9+/=]*)"\)/.exec(html);
  return m ? zlib.gunzipSync(Buffer.from(m[1], 'base64')).toString('utf8') : null;
}
function renderHtml(block, title) {
  const t = String(title).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
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

// ── CLI ───────────────────────────────────────────────────────────────────────
function help() {
  console.log(`ccstats-golizer — HTML report for golizer histo and/or replay runs against their source

Usage:
  ccstats-golizer [options] <run.json>... <skel.json>...

Each <run.json> is a golizer -out file (recognised by "tool": "golizer"; give a histo run, a
replay run, or both — they are compared on one page). Every other file is a source skeleton
(ccstats skel / ccbb skel), the same list golizer was given. The file order does not matter;
histo and replay runs are told apart by the run files themselves.

  -o, --out <file>       output path (default: <run>-report.html next to a single run file,
                         golizer-report.html next to the first of several)
  --max-ctx <n>          drop source rows with cr+cw+out over n — pass golizer's -max-ctx
                         so the distances compare like with like (default: no limit)
  -t, --title <text>     page title (default: golizer <histo|replay|histo + replay>)
  --lin                  open with linear prompt-size bins (default log; toggleable)
  --pool-points <n>      time buckets per pool chart (default ${POOL_POINTS}); the largest share of
                         the page, so lower it if Confluence rejects the paste
  --confluence[=file]    write the Confluence HTML-macro body instead of a standalone page`);
}

function main(argv) {
  const files = [];
  let out = null, maxCtx = null, title = null, lin = false, conf = false, poolPoints = POOL_POINTS;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => { if (i + 1 >= argv.length) { console.error(`ccstats-golizer: ${a} needs a value`); process.exit(1); } return argv[++i]; };
    if (a === '-h' || a === '--help') return help();
    else if (a === '-o' || a === '--out') out = val();
    else if (a === '--max-ctx') maxCtx = Number(val());
    else if (a === '-t' || a === '--title') title = val();
    else if (a === '--lin') lin = true;
    else if (a === '--pool-points') poolPoints = Number(val());
    else if (a === '--confluence') conf = true;
    else if (a.startsWith('--confluence=')) { conf = true; out = a.slice(13); }
    else if (a.startsWith('-')) { console.error(`ccstats-golizer: unknown option '${a}'`); process.exit(1); }
    else files.push(a);
  }
  if (!files.length) return help();
  if (!(poolPoints >= 1)) { console.error('ccstats-golizer: --pool-points must be at least 1'); process.exit(1); }

  const docs = files.map(file => ({ file, doc: readJson(file) }));
  const runDocs = docs.filter(d => d.doc && d.doc.tool === 'golizer');
  const srcDocs = docs.filter(d => !runDocs.includes(d));
  if (!runDocs.length) { console.error('ccstats-golizer: no golizer run file given (tool "golizer")'); process.exit(1); }
  if (!srcDocs.length) { console.error('ccstats-golizer: no source skeleton files given'); process.exit(1); }

  const src = loadSource(srcDocs, maxCtx || 0);
  if (!src.rows.length) { console.error('ccstats-golizer: no source rows matched (haiku/sonnet/opus/fable)'); process.exit(1); }
  const runs = runDocs.map(d => ({ d, ...loadRun(d.doc) }));
  for (const r of runs) if (!r.rows.length) { console.error(`ccstats-golizer: ${r.d.file} has no responses`); process.exit(1); }
  runs.sort((a, b) => (a.mode === 'window' ? 0 : 1) - (b.mode === 'window' ? 0 : 1));   // histo first
  const kind = r => r.mode === 'window' ? 'histo' : 'replay';
  const dupKind = k => runs.filter(r => kind(r) === k).length > 1;
  for (const r of runs) r.name = dupKind(kind(r)) ? `${kind(r)} ${path.basename(r.d.file, '.json')}` : kind(r);

  // Prompt-size edges over the source and every run; logEdges/linEdges only use the extremes.
  let lo = Infinity, hi = 0;
  for (const rows of [src.rows, ...runs.map(r => r.rows)])
    for (const s of rows) { const v = total(s); if (v > 0) lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const ext = [lo === Infinity ? 1 : lo, hi || 1];
  const edges = { lin: linEdges(ext, NBINS), log: logEdges(ext, NBINS) };
  const series = rows => ({
    tot: totals(rows),
    hist: { lin: promptSeries(edges.lin, rows), log: promptSeries(edges.log, rows) },
    cdf: Object.fromEntries(['cr', 'cw', 'out'].map(k => [k, cdfOf(rows, s => s[k])])),
  });

  const crcwAll = crcwTable([src.rows, ...runs.map(r => r.rows)]);
  const data = {
    meta: {
      title: title || `golizer ${[...new Set(runs.map(kind))].join(' + ')}`,
      log: !lin, generatedAt: new Date().toISOString(),
      files: src.files, srcSessions: src.sessions, dups: src.dups, maxCtx: maxCtx || 0, dropped: src.dropped,
    },
    edges,
    series: [{ key: 'src', name: 'source', ...series(src.rows) }].concat(runs.map((r, i) => {
      const rm = r.mode === 'session' ? matchReplay(src.bySession, r.d.doc) : null;
      const g = r.d.doc.golizer;
      r.rm = rm;
      return {
        key: 'run' + i, name: r.name, mode: r.mode, file: path.basename(r.d.file),
        maxTurns: Math.max(...r.units.map(u => u[2])),
        golizer: g ? Object.fromEntries(Object.entries(g).filter(([k]) => k !== 'samples')) : null,
        js: distances(src.rows, r.rows),
        ...series(r.rows),
        units: r.units.map(u => r.mode === 'window' ? [u[0], u[1], u[2], u[3].replace(/^golizer-/, '')]
          : [u[0], u[1], u[2], u[3].slice(0, 8), rm.perSession.has(u[3]) ? rm.perSession.get(u[3]) : null]),
        pool: poolSeries(g, poolPoints),
        replay: rm && { sessions: rm.sessions, unknown: rm.unknown, rows: rm.rows, paired: rm.paired,
          miss: rm.miss, first: rm.first, branch: rm.branch, tok: rm.tok },
      };
    })),
    crcw: crcwAll.slice(0, CRCW_ROWS), crcwMore: Math.max(0, crcwAll.length - CRCW_ROWS),
  };
  if (!out) {
    const base = runs.length === 1 ? runs[0].d.file.replace(/\.json$/, '') + '-report'
      : path.join(path.dirname(runDocs[0].file), 'golizer-report');
    out = base + (conf ? '.confluence.html' : '.html');
  }
  const block = reportBlock(data);
  const body = conf ? block + '\n' : renderHtml(block, data.meta.title);
  fs.writeFileSync(out, body);
  const kb = Math.round(Buffer.byteLength(body) / 1024);
  console.log(`ccstats-golizer: ${src.rows.length} source rows`);
  data.series.slice(1).forEach((s, i) => {
    const r = runs[i];
    console.log(`  ${s.name}: ${r.rows.length} rows in ${r.units.length} ${r.mode}s; JS (cr,cw) ${s.js.crcw.toFixed(3)}, ` +
      `total prompt ${s.js.tp.toFixed(3)}${r.rm ? `; ${r.rm.paired}/${r.rm.rows} rows paired, ${r.rm.miss} cache misses` : ''}`);
  });
  console.log(`→ ${out} (${kb} KB)`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { loadSource, loadRun, matchReplay, distances, crcwTable, poolSeries, reportBlock, unpackScript };
