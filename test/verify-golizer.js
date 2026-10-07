'use strict';
// End-to-end check for ccstats-golizer: a source skeleton, a golizer `histo` run and a
// `replay` run (with known cache misses) → reports for each alone and both together, each
// executed under the DOM shim.
//
//   node test/verify-golizer.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { install } = require('./dom-shim');
const G = require('../ccstats-golizer.js');

const CLI = path.join(__dirname, '..', 'ccstats-golizer.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstats-golizer-test-'));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Source: three chained sessions (cr grows by the previous cw), one of them duplicated in a
// second file under the same fingerprint, plus a non-Claude row golizer's filter drops.
const resp = (cr, cw, out, ms, model = 'claude-opus-5') =>
  ({ model, input: 2, cacheRead: cr, cacheWrite: cw - 2, output: out, respMs: ms, main: true });
function chain(start, n, cw, out) {
  const rows = [];
  let cr = start;
  for (let i = 0; i < n; i++) { rows.push(resp(cr, cw, out, 2000 + cr / 50)); cr += cw; }
  return rows;
}
const S1 = { sessionId: 'a', fingerprint: 'fa', responses: chain(0, 30, 3000, 400) };
// S2 ends with a compaction-like row (cr drops back), a branch in replay's terms.
const S2 = { sessionId: 'b', fingerprint: 'fb', responses: chain(40000, 20, 900, 200)
  .concat([resp(5000, 1000, 300, 900), resp(5000, 100, 10, 50, 'gpt-5.6')]) };
const S3 = { sessionId: 'c', fingerprint: 'fc', responses: chain(150000, 10, 12000, 1500) };
const srcA = path.join(tmp, 'cc-a.json'), srcB = path.join(tmp, 'cc-b.json');
fs.writeFileSync(srcA, JSON.stringify({ tool: 'ccstats', kind: 'skeleton', schema: 2, sessions: [S1, S2] }));
fs.writeFileSync(srcB, JSON.stringify({ tool: 'ccstats', kind: 'skeleton', schema: 2, sessions: [S3, S1] }));

// A run as golizer's writeSkeletonFile writes it: cw already includes input, input 0.
const runResp = (cr, cw, out, ms) => ({ ts: '2026-10-07T00:00:00Z', hour: 0, model: 'golizer-replay-opus',
  provider: 'golizer', main: true, input: 0, cacheRead: cr, cacheWrite: cw, output: out, promptTokens: cr + cw, respMs: ms });
const runSession = (id, rows) => ({ sessionId: id, fingerprint: id + '-1', models: ['golizer-replay-opus'],
  responses: rows.map(r => runResp(r.cacheRead, r.cacheWrite + r.input, r.output, 900)) });
const samples = [];
for (let t = 0; t < 40; t++) for (let node = 0; node < 2; node++)
  samples.push({ t: t * 5 + 0.01, node, kv_pct: 0.2 + 0.01 * t, kv_res: Math.min(1, 0.05 * t), evict_s: null,
    host_pct: 0, busy: node ? null : 0.5, running: 3 + node, waiting: t % 3, live: 2, foot: 120000 });
const golizer = { pool_tokens: 400000, budget: 0, concurrency: 2, sample_s: 5, headroom: 280000, peak_foot: 120000,
  nodes: ['http://n0:8000', 'http://n1:8000'], samples };
const histoRun = path.join(tmp, 'golizer-histo.json');
fs.writeFileSync(histoRun, JSON.stringify({ tool: 'golizer', kind: 'skeleton', schema: 1, count: 2, golizer,
  sessions: [runSession('golizer-w0', S1.responses.slice(5, 15)), runSession('golizer-w1', S3.responses.slice(0, 8))] }));
// The replay, as played with -max-ctx 200000 (S3's later rows dropped), with three misses:
// S1 row 10 in-chain (5952 short of the block floor of row 9's 30000), S2's compaction row at
// the branch (all 5000), S3's first row (the cold build evicted: all 150000). Prompt and output stay the source's. A session the
// source does not have, and an S1 row with the wrong output, do not pair.
const short = (r, by) => ({ ...r, cacheRead: r.cacheRead - by, cacheWrite: r.cacheWrite + by });
const R1 = S1.responses.map((r, i) => i === 10 ? short(r, 6000) : r).concat([resp(90000, 3000, 7, 900)]);
const R2 = S2.responses.slice(0, 21).map((r, i) => i === 20 ? short(r, 5000) : r);
const R3 = S3.responses.slice(0, 4).map((r, i) => i === 0 ? short(r, 150000) : r);
const replayRun = path.join(tmp, 'golizer-replay.json');
fs.writeFileSync(replayRun, JSON.stringify({ tool: 'golizer', kind: 'skeleton', schema: 1, count: 4,
  sessions: [runSession('a', R1), runSession('b', R2), runSession('c', R3), runSession('zzz', S1.responses.slice(0, 2))] }));

// ── Helpers ───────────────────────────────────────────────────────────────────
function render(args, out) {
  const msg = execFileSync('node', [CLI, ...args, '-o', out], { encoding: 'utf8' });
  const html = fs.readFileSync(out, 'utf8');
  const js = G.unpackScript(html);
  const { ctx, ids } = install('ccstats-golizer-host');
  vm.runInContext(js, vm.createContext(ctx), { filename: 'golizer-report.js' });
  const data = JSON.parse(/var DATA = (\{[\s\S]*?\});\n/.exec(js)[1].replace(/\\u003c/g, '<'));
  return { msg, html, js, ids, data };
}
const svgOf = (ids, id) => (ids.get(id) && ids.get(id).children[0]) || null;
const rects = svg => svg ? svg.querySelectorAll('rect').length : 0;
const paths = svg => svg ? svg.querySelectorAll('path').length : 0;

// ── Checks ────────────────────────────────────────────────────────────────────
check('source is read the way golizer reads it', () => {
  const docs = [srcA, srcB].map(f => ({ file: f, doc: JSON.parse(fs.readFileSync(f, 'utf8')) }));
  const s = G.loadSource(docs, 0);
  assert.strictEqual(s.dups, 1, 'S1 again in the second file is a duplicate');
  assert.strictEqual(s.rows.length, 61, 'the gpt row is filtered out');
  assert.strictEqual(s.rows[1].cw, 3000, 'cw = cacheWrite + input');
  assert.strictEqual(G.loadSource(docs, 100000).dropped, 10, '-max-ctx drops the large session');
});
check('identical source and run are at distance 0', () => {
  const docs = [{ file: srcA, doc: JSON.parse(fs.readFileSync(srcA, 'utf8')) }];
  const s = G.loadSource(docs, 0).rows;
  const d = G.distances(s, s);
  assert.ok(d.crcw < 1e-9 && d.tp < 1e-9, JSON.stringify(d));
});

const sumBins = c => { const t = [0, 0, 0, 0]; for (let i = 0; i < c.length; i++) t[i % 4] += c[i]; return t; };
const topTick = (ids, id) => svgOf(ids, id).querySelectorAll('text').filter(t => /%$/.test(t._text)).map(t => t._text).pop();

let H;
check('histo report renders', () => {
  H = render([histoRun, srcA, srcB], path.join(tmp, 'h.html'));
  assert.ok(/61 source rows\n  histo: 18 rows in 2 windows/.test(H.msg), H.msg);
  assert.deepStrictEqual(H.data.series.map(s => s.name), ['source', 'histo']);
});
check('histo: every chart drew', () => {
  for (const id of ['stack-0', 'stack-1', 'overlay', 'units-1'])
    assert.ok(rects(svgOf(H.ids, id)) > 0, id);
  assert.strictEqual(paths(svgOf(H.ids, 'lat')), 2, 'latency: source and run lines');
  assert.ok(paths(svgOf(H.ids, 'pool-1')) >= 4, 'pool lines');
  assert.strictEqual(H.ids.get('cdf').children.length, 3, 'three CDF panels');
  assert.ok(/<table>/.test(H.ids.get('crcw').innerHTML), 'crcw table');
  assert.ok(/<table>/.test(H.ids.get('pool-stats-1').innerHTML), 'per-node stats from the samples');
});
check('histo: stacked bins carry read / write / decode and sum to the rows', () => {
  for (const s of H.data.series)
    for (const scale of ['lin', 'log'])
      assert.deepStrictEqual(sumBins(s.hist[scale].c), s.tot.slice(0, 4), `${scale} ${s.name}`);
  const segs = svgOf(H.ids, 'stack-1').querySelectorAll('rect').map(r => r.attrs.fill);
  assert.ok(['#2a78d6', '#eb6834', '#1baf7a'].every(c => segs.includes(c)), 'three stacked colours');
});
check('histo: source and run stacks share one y scale', () => {
  assert.strictEqual(topTick(H.ids, 'stack-0'), topTick(H.ids, 'stack-1'));
});
check('histo: tiles come from the JSON alone; no fidelity without a source link', () => {
  const t = H.ids.get('tiles').innerHTML;
  for (const k of ['JS (cr, cw)', 'JS total prompt', 'headroom', 'wall time']) assert.ok(t.includes(k), k);
  assert.ok(!t.includes('fidelity') && !t.includes('cache misses'));
  assert.strictEqual(H.data.series[1].replay, null);
});
check('histo: units are windows; the fleet pool has a node selector', () => {
  assert.strictEqual(H.ids.get('units-h-1')._text, 'Windows played in the histo run (2)');
  assert.deepStrictEqual(H.data.series[1].units.map(u => u[3]), ['w0', 'w1']);
  assert.strictEqual(H.ids.get('pool-ctrl-1').querySelectorAll('option').length, 3);
});

let R;
check('replay rows pair with their source rows', () => {
  const docs = [srcA, srcB].map(f => ({ file: f, doc: JSON.parse(fs.readFileSync(f, 'utf8')) }));
  const m = G.matchReplay(G.loadSource(docs, 200000).bySession, JSON.parse(fs.readFileSync(replayRun, 'utf8')));
  assert.deepStrictEqual([m.sessions, m.unknown, m.rows, m.paired], [3, 1, 30 + 1 + 21 + 4 + 2, 30 + 21 + 4]);
  assert.deepStrictEqual([m.miss, m.first, m.branch, m.tok], [3, 1, 1, 5952 + 5000 + 150000]);
  assert.deepStrictEqual([...m.perSession], [['a', 1], ['b', 1], ['c', 1]]);
});
check('replay pairing tolerates golizer\'s carried block lag', () => {
  // the served prompt 1,000 over the source (a carried lag), the next turn's read 900 under it
  const src = new Map([['x', [{ cr: 0, cw: 20000, out: 5, main: true }, { cr: 20000, cw: 500, out: 6, main: true },
    { cr: 20500, cw: 700, out: 7, main: true }]]]);
  const run = { sessions: [runSession('x', [resp(0, 20000, 5, 1), resp(19968, 1532, 6, 1), resp(21440, 700, 7, 1)])] };
  run.sessions[0].responses.forEach(r => { r.cacheWrite += r.input; r.input = 0; });
  const m = G.matchReplay(src, run);
  assert.deepStrictEqual([m.paired, m.miss], [3, 0]);
});
check('replay report renders', () => {
  R = render([srcA, replayRun, srcB, '--max-ctx', '200000'], path.join(tmp, 'r.html'));
  assert.ok(/replay: 58 rows in 4 sessions;.*55\/58 rows paired, 3 cache misses/.test(R.msg), R.msg);
});
check('replay: sessions with misses stand out; fidelity and misses in the tiles', () => {
  assert.strictEqual(R.ids.get('units-h-1')._text, 'Sessions played in the replay run (4)');
  const fills = svgOf(R.ids, 'units-1').querySelectorAll('rect').map(r => r.attrs.fill);
  assert.deepStrictEqual(fills, ['#d03b3b', '#d03b3b', '#d03b3b', '#7b5bd6']);
  const t = R.ids.get('tiles').innerHTML;
  assert.ok(/94\.8%/.test(t), 'fidelity 55/58');
  assert.ok(t.includes('1 in-chain · 1 first-turn · 1 branch'));
  assert.ok(!R.ids.get('runcards').innerHTML.includes('pool-card-1'), 'no samples in this run');
  assert.ok(R.ids.get('method').innerHTML.includes('1 run sessions not found'));
});

let B;
check('both runs render on one page, histo first whatever the order', () => {
  B = render([replayRun, srcA, histoRun, srcB, '--max-ctx', '200000'], path.join(tmp, 'b.html'));
  assert.deepStrictEqual(B.data.series.map(s => s.name), ['source', 'histo', 'replay']);
  assert.ok(/histo: 18 rows[^\n]*\n  replay: 58 rows/.test(B.msg), B.msg);
  assert.strictEqual(B.data.meta.title, 'golizer histo + replay');
});
check('both: one stack per series on one y scale, every run in every comparison', () => {
  const tops = [0, 1, 2].map(i => topTick(B.ids, 'stack-' + i));
  assert.ok(tops[0] && tops.every(t => t === tops[0]), tops.join(' '));
  for (const s of B.data.series)
    for (const scale of ['lin', 'log'])
      assert.deepStrictEqual(sumBins(s.hist[scale].c), s.tot.slice(0, 4), `${scale} ${s.name}`);
  assert.strictEqual(paths(svgOf(B.ids, 'overlay')), 2, 'an outline per run');
  assert.strictEqual(paths(svgOf(B.ids, 'lat')), 3, 'a latency line per series');
  const cdf = B.ids.get('cdf').children[0].children[0];
  assert.strictEqual(paths(cdf), 3, 'a CDF line per series');
  const tab = B.ids.get('crcw').innerHTML;
  assert.ok(['source', 'histo', 'replay'].every(n => tab.includes(n + ' mean')), 'crcw columns per series');
  assert.ok(B.data.crcw.every(r => r.v.length === 3));
});
check('both: run cards and tiles per run', () => {
  assert.strictEqual(B.ids.get('units-h-1')._text, 'Windows played in the histo run (2)');
  assert.strictEqual(B.ids.get('units-h-2')._text, 'Sessions played in the replay run (4)');
  const cards = B.ids.get('runcards').innerHTML;
  assert.ok(cards.includes('pool-card-1') && !cards.includes('pool-card-2'), 'pool card only for the sampled run');
  const t = B.ids.get('tiles').innerHTML;
  assert.strictEqual((t.match(/class="trow"/g) || []).length, 3);
  assert.strictEqual((t.match(/fidelity/g) || []).length, 1, 'fidelity only for replay');
  assert.ok(B.ids.get('method').innerHTML.includes('histo run:') && B.ids.get('method').innerHTML.includes('replay run:'));
});
check('the script ships packed: base64 in a short ASCII loader', () => {
  const body = B.html.slice(B.html.indexOf('<script>'), B.html.indexOf('</script>'));
  assert.ok(/^[\x20-\x7e\n]*$/.test(body), 'loader is plain ASCII');
  assert.strictEqual(body.replace(/atob\("[A-Za-z0-9+/=]*"\)/, '').length < 500, true, 'loader is a few lines');
  assert.ok(!/new Function|eval\(/.test(body), 'no eval: a page CSP may forbid it');
});
check('report is self-contained and escapes its inputs', () => {
  assert.ok(!/src\s*=\s*["']http/i.test(B.html));
  assert.strictEqual((B.html.match(/<\/script>/g) || []).length, 1);
});
check('--confluence writes only the macro body', () => {
  const out = path.join(tmp, 'c.html');
  execFileSync('node', [CLI, histoRun, srcA, '--confluence=' + out], { encoding: 'utf8' });
  const body = fs.readFileSync(out, 'utf8');
  assert.ok(body.startsWith('<style>') && body.includes('<div id="ccstats-golizer-host">') && !/<html/.test(body));
  assert.ok(!/^\s*\./m.test(body), 'no line starts with "."');
});
check('the pool ships compact and --pool-points caps its buckets', () => {
  const P = H.data.series[1].pool;
  assert.ok(!('t' in P) && P.nb === 40, 'time axis implied, one bucket a sample here');
  assert.ok(P.series[0].kv_pct.every(v => v == null || Number.isInteger(v)), 'shares in permille');
  assert.ok(!('busy' in P.series[1]), 'a gauge a node never reported is left out');
  const small = render([histoRun, srcA, '--pool-points', '8'], path.join(tmp, 'p.html'));
  assert.strictEqual(small.data.series[1].pool.nb, 8);
  assert.ok(paths(svgOf(small.ids, 'pool-1')) >= 4, 'still draws');
});
check('default output path: next to a single run, golizer-report.html for several', () => {
  execFileSync('node', [CLI, histoRun, srcA], { encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(tmp, 'golizer-histo-report.html')));
  execFileSync('node', [CLI, histoRun, replayRun, srcA], { encoding: 'utf8' });
  assert.ok(fs.existsSync(path.join(tmp, 'golizer-report.html')));
});

// The loader itself, as a browser runs it: unpack, append an inline <script>, which draws.
(async () => {
  try {
    const { ctx, ids } = install('ccstats-golizer-host');
    Object.assign(ctx, { atob, Uint8Array, Blob, Response, DecompressionStream });
    const loader = B.html.slice(B.html.indexOf('<script>') + 8, B.html.indexOf('</script>'));
    const sandbox = vm.createContext(ctx);
    vm.runInContext(loader, sandbox);
    let s;
    for (let i = 0; i < 200 && !s; i++) {
      await new Promise(r => setTimeout(r, 10));
      s = ctx.document.body.children.find(c => c.tagName === 'script');
    }
    assert.ok(s, 'the loader appended a script');
    vm.runInContext(s.textContent, sandbox);
    assert.ok(rects(svgOf(ids, 'stack-0')) > 0, 'and it drew');
    console.log('ok   the packed loader unpacks and runs the page');
  } catch (e) { failures++; console.log(`FAIL the packed loader unpacks and runs the page\n     ${e.message}`); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exitCode = failures ? 1 : 0;
})();
