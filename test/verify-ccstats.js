'use strict';
// End-to-end check: build skeletons for a fixture tree, render a report, then execute the
// report's embedded script against a minimal DOM (test/dom-shim.js) and assert that every
// chart drew and that the in-page filters re-sum to the same totals the build produced.
//
//   node test/verify.js            uses the generated fixture tree
//   node test/verify.js --real     also renders from the real ~/.claude / ~/.codex sessions

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { install } = require('./dom-shim');

const CLI = path.join(__dirname, '..', 'ccstats.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccstats-test-'));
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { failures++; console.log(`FAIL ${name}\n     ${e.message}`); }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────
// Two Claude sessions (subscription + bedrock, one with a subagent transcript) and one Codex
// rollout, with hand-set token numbers so the cache-write attribution has a known answer.
const claudeDir = path.join(tmp, 'claude', 'projects', '-home-u-proj');
const subDir = path.join(claudeDir, '11111111-1111-4111-8111-111111111111', 'subagents');
fs.mkdirSync(subDir, { recursive: true });
const codexDir = path.join(tmp, 'codex', 'sessions', '2026', '09');
fs.mkdirSync(codexDir, { recursive: true });
fs.writeFileSync(path.join(tmp, 'codex', 'config.toml'), 'model = "gpt-5.6"\n');

const T0 = Date.parse('2026-09-20T10:00:00.000Z');
const iso = ms => new Date(ms).toISOString();
function claudeLines(sessionId, msgPrefix, model, rows) {
  const out = [];
  let t = T0;
  rows.forEach((r, i) => {
    t += 5000;
    out.push({ type: 'user', sessionId, version: '2.0.0', timestamp: iso(t),
      message: { role: 'user', content: [{ type: 'text', text: 'x'.repeat(40) }] } });
    t += r.ms;
    out.push({ type: 'assistant', sessionId, timestamp: iso(t), requestId: 'req' + i,
      message: { id: msgPrefix + i, model, role: 'assistant',
        content: [{ type: 'text', text: 'y'.repeat(80) }],
        usage: { input_tokens: r.in, output_tokens: r.out,
          cache_read_input_tokens: r.cr, cache_creation_input_tokens: r.cw } } });
    t += r.gap || 0;
  });
  return out.map(o => JSON.stringify(o)).join('\n') + '\n';
}
// prompt grows by 500 each turn: turn 2 writes exactly the growth, turn 3 writes far more
// than it grew while reading nothing → a re-write (expiry/eviction).
const SUB_ROWS = [
  { in: 10, out: 100, cr: 0, cw: 2000, ms: 3000 },
  { in: 10, out: 120, cr: 2000, cw: 500, ms: 4000, gap: 600000 },
  { in: 10, out: 140, cr: 0, cw: 3000, ms: 9000 },
];
fs.writeFileSync(path.join(claudeDir, '11111111-1111-4111-8111-111111111111.jsonl'),
  claudeLines('11111111-1111-4111-8111-111111111111', 'msg_a', 'claude-opus-5-5-20260101', SUB_ROWS));
fs.writeFileSync(path.join(subDir, 'agent-deadbeef.jsonl'),
  JSON.stringify({ type: 'fork-context-ref', agentId: 'deadbeef',
    parentSessionId: '11111111-1111-4111-8111-111111111111' }) + '\n' +
  claudeLines('11111111-1111-4111-8111-111111111111', 'msg_sub', 'claude-haiku-4-5-20251001',
    [{ in: 5, out: 50, cr: 0, cw: 100, ms: 1000 }]));
fs.writeFileSync(path.join(claudeDir, '22222222-2222-4222-8222-222222222222.jsonl'),
  claudeLines('22222222-2222-4222-8222-222222222222', 'msg_bdrk_b',
    'anthropic.claude-haiku-4-5-20251001-v1:0', [
      { in: 10, out: 60, cr: 0, cw: 800, ms: 2000 },
      { in: 10, out: 70, cr: 800, cw: 200, ms: 2500 },
    ]));
// A local-LLM session: the model id is no Claude family, so it must read as claude-local.
fs.writeFileSync(path.join(claudeDir, '33333333-3333-4333-8333-333333333333.jsonl'),
  claudeLines('33333333-3333-4333-8333-333333333333', 'msg_c', 'qwen3-coder-local',
    [{ in: 20, out: 30, cr: 0, cw: 0, ms: 1500 }]));

// A session with an explicit compaction record: the CLI's own pre/post numbers must be used
// verbatim, and no inference may run alongside them.
{
  const id = '55555555-5555-4555-8555-555555555555';
  const lines = claudeLines(id, 'msg_d', 'claude-opus-5-5-20260101', [
    { in: 10, out: 100, cr: 0, cw: 40000, ms: 3000 },
    { in: 10, out: 110, cr: 40000, cw: 500, ms: 3000 },
  ]).trim().split('\n');
  lines.splice(2, 0, JSON.stringify({ type: 'system', subtype: 'compact_boundary',
    sessionId: id, timestamp: iso(T0 + 20000), content: 'Conversation compacted',
    compactMetadata: { trigger: 'auto', preTokens: 170447, postTokens: 13145, durationMs: 169976 } }));
  fs.writeFileSync(path.join(claudeDir, id + '.jsonl'), lines.join('\n') + '\n');
}

// Codex rollout: session_meta + response items + a token ledger.
{
  const id = '44444444-4444-4444-8444-444444444444';
  const L = [];
  let t = T0;
  L.push({ type: 'session_meta', timestamp: iso(t),
    payload: { id, cli_version: '0.154.0', model_provider: 'openai', model: 'gpt-5.6', timestamp: iso(t) } });
  const push = (usage, cum) => {
    t += 4000;
    L.push({ type: 'response_item', timestamp: iso(t), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q'.repeat(60) }] } });
    t += 6000;
    L.push({ type: 'response_item', timestamp: iso(t), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a'.repeat(200) }] } });
    L.push({ type: 'token_usage_record', timestamp: iso(t), payload: { usage, thread_token_usage: cum } });
  };
  const u1 = { input_tokens: 1200, cached_input_tokens: 0, cache_write_input_tokens: 1000,
    output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 1500 };
  const u2 = { input_tokens: 1800, cached_input_tokens: 1000, cache_write_input_tokens: 600,
    output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 2000 };
  push(u1, u1);
  push(u2, { input_tokens: 3000, cached_input_tokens: 1000, cache_write_input_tokens: 1600,
    output_tokens: 500, reasoning_output_tokens: 150, total_tokens: 3500 });
  fs.writeFileSync(path.join(codexDir, `rollout-${id}.jsonl`), L.map(x => JSON.stringify(x)).join('\n') + '\n');
}

// A Codex rollout whose context collapses 40k → 9k: rollouts record no compaction, so this
// must be picked up by inference.
{
  const id = '66666666-6666-4666-8666-666666666666';
  const L = [];
  let t = T0;
  L.push({ type: 'session_meta', timestamp: iso(t),
    payload: { id, cli_version: '0.154.0', model_provider: 'openai', model: 'gpt-5.6', timestamp: iso(t) } });
  [40000, 9000].forEach(inTok => {
    t += 5000;
    L.push({ type: 'response_item', timestamp: iso(t), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'q'.repeat(20) }] } });
    t += 5000;
    L.push({ type: 'token_usage_record', timestamp: iso(t), payload: { usage: {
      input_tokens: inTok, cached_input_tokens: 0, cache_write_input_tokens: 0,
      output_tokens: 100, reasoning_output_tokens: 0, total_tokens: inTok + 100 } } });
  });
  fs.writeFileSync(path.join(codexDir, `rollout-${id}.jsonl`), L.map(x => JSON.stringify(x)).join('\n') + '\n');
}

const DIRS = ['--dir', path.join(tmp, 'claude'), '--dir', path.join(tmp, 'codex')];
const run = args => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

// ── Skeleton checks ───────────────────────────────────────────────────────────
const skelFile = path.join(tmp, 'skel.json');
const skelOut = run(['skel', ...DIRS, '-o', skelFile]);
const skel = JSON.parse(fs.readFileSync(skelFile, 'utf8'));
const byId = new Map(skel.sessions.map(s => [s.sessionId, s]));

check('discovers every fixture session', () => {
  assert.strictEqual(skel.sessions.length, 6, skelOut.trim());
  assert.ok(byId.has('44444444-4444-4444-8444-444444444444'), 'codex rollout missing');
});
check('sources are auto-detected', () => {
  const src = s => [...new Set(byId.get(s).responses.map(r => r.source))].sort();
  assert.deepStrictEqual(src('11111111-1111-4111-8111-111111111111'), ['claude-sub']);
  assert.deepStrictEqual(src('22222222-2222-4222-8222-222222222222'), ['claude-bedrock']);
  assert.deepStrictEqual(src('33333333-3333-4333-8333-333333333333'), ['claude-local']);
  assert.deepStrictEqual(src('44444444-4444-4444-8444-444444444444'), ['codex']);
});
check('subagent transcript is folded into its parent session', () => {
  const s = byId.get('11111111-1111-4111-8111-111111111111');
  assert.strictEqual(s.responses.length, 4, `got ${s.responses.length}`);
  assert.ok(s.responses.some(r => r.main === false), 'no subagent response marked');
  // message rows are main-transcript only: 3 user + 3 assistant
  assert.strictEqual(s.messages.length, 6, `messages ${s.messages.length}`);
});
check('message rows carry type, token length and unix-ms timestamp', () => {
  const m = byId.get('11111111-1111-4111-8111-111111111111').messages;
  assert.deepStrictEqual(m.map(x => x.type), ['u', 'x', 'u', 'x', 'u', 'x']);
  assert.strictEqual(m[1].tokens, 100, 'assistant row must use exact output_tokens');
  assert.ok(!m[1].est, 'assistant row should not be flagged estimated');
  assert.strictEqual(m[0].est, 1, 'user row must be flagged estimated');
  assert.strictEqual(m[0].tokens, 10, `~4 chars/token of 40 chars, got ${m[0].tokens}`);
  assert.ok(m.every(x => typeof x.ts === 'number' && x.ts > 1e12), 'ts must be unix ms');
});
check('cache writes are split into growth and re-write', () => {
  const r = byId.get('11111111-1111-4111-8111-111111111111').responses.filter(x => x.main);
  assert.strictEqual(r[0].cwKind, 'initial');
  assert.strictEqual(r[0].cwGrowth, 2000);
  assert.strictEqual(r[0].cwExpiry, 0);
  // prompt grew 2010→2510: the 500-token write is exactly growth
  assert.strictEqual(r[1].cwKind, 'growth');
  assert.strictEqual(r[1].cwGrowth, 500);
  assert.strictEqual(r[1].cwExpiry, 0);
  // context grew 2510→3010 but 3000 was written and nothing read: only 500 of that write can
  // be new content, the other 2500 is prefix paid for twice
  assert.strictEqual(r[2].cwKind, 'expiry');
  assert.strictEqual(r[2].cwGrowth, 500);
  assert.strictEqual(r[2].cwExpiry, 2500);
  assert.strictEqual(r[2].gapMs, 600000 + 5000 + 9000, `gap ${r[2].gapMs}`);
});
check('session aggregates are present', () => {
  const s = byId.get('22222222-2222-4222-8222-222222222222');
  assert.strictEqual(s.turns, 2);
  assert.ok(s.durationMs > 0, 'durationMs');
});
check('fingerprints are unique and stable', () => {
  const fps = skel.sessions.map(s => s.fingerprint);
  assert.strictEqual(new Set(fps).size, fps.length, 'collision');
  const again = path.join(tmp, 'skel2.json');
  run(['skel', ...DIRS, '-o', again]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(again, 'utf8')).sessions.map(s => s.fingerprint), fps);
});
check('--model and --source filter', () => {
  const f = path.join(tmp, 'skel-filtered.json');
  run(['skel', ...DIRS, '-m', 'haiku', '-o', f]);
  const only = JSON.parse(fs.readFileSync(f, 'utf8'));
  const models = new Set(only.sessions.flatMap(s => s.responses.map(r => r.model)));
  assert.ok([...models].every(m => /haiku/i.test(m)), [...models].join(','));
  run(['skel', ...DIRS, '-s', 'codex', '-o', f]);
  const codexOnly = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.strictEqual(codexOnly.sessions.length, 2);
});
check('compactions are recorded exactly, or inferred from a context collapse', () => {
  const c = byId.get('55555555-5555-4555-8555-555555555555').compactions;
  assert.strictEqual(c.length, 1, `explicit ${JSON.stringify(c)}`);
  assert.deepStrictEqual([c[0].pre, c[0].post, c[0].trigger, c[0].durMs],
    [170447, 13145, 'auto', 169976]);
  assert.ok(!c[0].inferred, 'explicit record must not be flagged inferred');
  const k = byId.get('66666666-6666-4666-8666-666666666666').compactions;
  assert.strictEqual(k.length, 1, `inferred ${JSON.stringify(k)}`);
  assert.deepStrictEqual([k[0].pre, k[0].post, k[0].inferred], [40000, 9000, 1]);
  // small sessions must not produce phantom compactions
  for (const id of ['11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444'])
    assert.strictEqual(byId.get(id).compactions.length, 0, id);
});
check('skeletons carry no content', () => {
  const text = fs.readFileSync(skelFile, 'utf8');
  for (const needle of ['xxxx', 'yyyy', 'qqqq', 'aaaa', 'proj', tmp]) {
    assert.ok(!text.includes(needle), `leaked ${needle}`);
  }
});

// ── ccstats-skel ──────────────────────────────────────────────────────────────
// The standalone collector: gzipped by default, same sessions and fingerprints as `skel`,
// no session ids, MCP tool names or local model names, and readable by `stats` as-is.
const SKEL_CLI = path.join(__dirname, '..', 'ccstats-skel.js');
const gzFile = path.join(tmp, 'collected.json.gz');
execFileSync(process.execPath, [SKEL_CLI, ...DIRS, '-o', gzFile], { encoding: 'utf8' });
check('ccstats-skel writes sanitized gzip with the same fingerprints', () => {
  const buf = fs.readFileSync(gzFile);
  assert.ok(buf[0] === 0x1f && buf[1] === 0x8b, 'not gzipped');
  const coll = JSON.parse(require('zlib').gunzipSync(buf).toString('utf8'));
  assert.deepStrictEqual(coll.sessions.map(s => s.fingerprint).sort(),
    skel.sessions.map(s => s.fingerprint).sort());
  for (const s of coll.sessions) assert.strictEqual(s.sessionId, s.fingerprint);
  const text = JSON.stringify(coll);
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(text), 'session uuid leaked');
  assert.ok(!text.includes('mcp__'), 'mcp tool name leaked');
  assert.ok(/ccstats stats: \d+ sessions/.test(run(['stats', gzFile, '-o', path.join(tmp, 'gz.html')])));
});
const { sanitize } = require(SKEL_CLI);
check('sanitize strips tool and local-model names', () => {
  const s = sanitize({ fingerprint: 'f', sessionId: 'x',
    messages: [{ type: 't:mcp__corp-wiki__search+t:Bash+x' }, { type: 't:my tool' }],
    responses: [{ model: '/srv/models/Qwen3-32B', provider: 'mylab', source: 'codex-local' },
      { model: 'claude-opus-5', provider: 'anthropic', source: 'claude-sub' }] });
  assert.deepStrictEqual(s.messages.map(m => m.type), ['t:mcp+t:Bash+x', 't:other']);
  assert.deepStrictEqual(s.models, ['local', 'claude-opus-5']);
  assert.deepStrictEqual(s.providers, ['local', 'anthropic']);
});

// ── Report checks ─────────────────────────────────────────────────────────────
// Run the emitted script under the DOM shim and inspect what it drew.
function renderReport(args) {
  const out = path.join(tmp, 'rep.html');
  const log = run(['stats', ...args, '-o', out]);
  const html = fs.readFileSync(out, 'utf8');
  const a = html.indexOf('<script>') + '<script>'.length;
  const b = html.indexOf('</script>', a);
  const { ctx, ids } = install();
  const sandbox = vm.createContext(ctx);
  vm.runInContext(html.slice(a, b), sandbox, { filename: 'report.js' });
  const raw = JSON.parse(/var DATA = (\{[\s\S]*?\});\n/.exec(html.slice(a, b))[1].replace(/\\u003c/g, '<'));
  const data = { meta: raw.meta, views: { keep: expand(raw.views.keep, null) } };
  data.views.drop = expand(raw.views.drop, data.views.keep);
  return { log, html, ids, data, raw, ctx };
}
// The payload is zero-run compressed and the drop view aliases sections identical to keep's;
// mirror the page's decode so the checks below can assert on plain per-group arrays.
function unrle(a, len) {
  const out = [];
  for (const v of a) { if (v < 0) { for (let j = 0; j < -v; j++) out.push(0); } else out.push(v); }
  while (out.length < len) out.push(0);
  return out;
}
function expand(v, base) {
  const o = {};
  for (const [k, s] of Object.entries(v)) {
    if (k === 'pts' && typeof s === 'string') o.pts = base.pts.filter(p => !p[3]);
    else if (typeof s === 'string' && s[0] === '@') o[k] = base[s.slice(1)];
    else if (k === 'hour') o.hour = { sum: s.sum.g.map(r => unrle(r, s.sum.len)), cnt: s.cnt.g.map(r => unrle(r, s.cnt.len)) };
    else if (k === 'tot') o.tot = s.g.map(r => unrle(r, s.len));
    else if (s && s.edges) o[k] = { edges: s.edges, n: s.n, g: s.g.map(r => unrle(r, s.len)) };
    else o[k] = s;
  }
  return o;
}
let rep;
check('report renders without throwing', () => {
  rep = renderReport([skelFile]);
  assert.ok(/source×model groups/.test(rep.log), rep.log.trim());
});
check('every chart drew an svg', () => {
  if (!rep) throw new Error('report did not render');
  for (const id of ['stack-count', 'stack-resp', 'avg-decode', 'avg-cw', 'cw-split', 'gap-cw',
    'scatter', 'hour', 'sess-turns', 'sess-dur', 'comp-count', 'comp-post']) {
    const el = rep.ids.get(id);
    assert.ok(el, `${id} host missing`);
    assert.ok(el.children.some(c => c.tagName === 'svg' && c.children.length > 2),
      `${id} drew nothing`);
  }
});
check('tiles and legends are filled in', () => {
  assert.ok(/sessions/.test(rep.ids.get('tiles').innerHTML), 'tiles empty');
  assert.ok(/cache re-write/.test(rep.ids.get('tiles').innerHTML), 'no cache re-write tile');
  assert.ok(/Prompt Size/.test(rep.ids.get('stack-count-legend').innerHTML), 'legend empty');
  assert.ok(/re-write/.test(rep.ids.get('cw-split-legend').innerHTML), 'split legend empty');
});
check('filters offer every discovered source and model', () => {
  const srcBoxes = rep.ids.get('srcCtrl').children.filter(c => c.tagName === 'label');
  const modBoxes = rep.ids.get('modCtrl').children.filter(c => c.tagName === 'label');
  assert.deepStrictEqual(rep.data.meta.sources.slice().sort(),
    ['claude-bedrock', 'claude-local', 'claude-sub', 'codex']);
  assert.strictEqual(srcBoxes.length, rep.data.meta.sources.length);
  assert.strictEqual(modBoxes.length, rep.data.meta.models.length);
  assert.ok(rep.data.meta.models.includes('claude-haiku-4-5'),
    `bedrock/plain haiku must share a family: ${rep.data.meta.models.join(',')}`);
});
check('per-group aggregates sum to the build-time totals', () => {
  const v = rep.data.views.keep;
  const tot = v.tot.reduce((a, t) => a.map((x, i) => x + t[i]), new Array(16).fill(0));
  assert.strictEqual(tot[0], rep.data.meta.responses, 'response count');
  assert.strictEqual(tot[8], rep.data.meta.sessions, 'session count');
  // the same numbers must be reachable from the binned sections
  for (const key of ['lin', 'log']) {
    const sec = v[key];
    let n = 0, cw = 0, cwg = 0, cwe = 0;
    for (const g of sec.g) for (let i = 0; i < g.length; i += 8) { n += g[i]; cw += g[i + 2]; cwg += g[i + 6]; cwe += g[i + 7]; }
    assert.strictEqual(n, tot[0], `${key} bins lost responses`);
    assert.strictEqual(cw, tot[2], `${key} bins lost cache writes`);
    assert.strictEqual(cwg + cwe, tot[6] + tot[7], `${key} bins lost the cache-write split`);
  }
  for (const key of ['turns', 'turnsLog', 'dur', 'durLog']) {
    const sessions = v[key].g.reduce((a, g) => a + g.reduce((x, y) => x + y, 0), 0);
    assert.strictEqual(sessions, tot[8], `${key} histogram lost sessions`);
  }
  assert.strictEqual(tot[12], 2, 'compaction count');
  for (const key of ['comp', 'compLog']) {
    let n = 0, pre = 0;
    for (const g of v[key].g) for (let i = 0; i < g.length; i += 7) { n += g[i]; pre += g[i + 1]; }
    assert.strictEqual(n, tot[12], `${key} bins lost compactions`);
    assert.strictEqual(pre, tot[13], `${key} bins lost trigger sizes`);
  }
});
check('session and compaction charts are binned finely and offered in both scalings', () => {
  const v = rep.data.views.keep;
  for (const key of ['turns', 'turnsLog', 'dur', 'durLog']) {
    assert.ok(v[key].edges.length - 1 > 24, `${key} has only ${v[key].edges.length - 1} bins`);
  }
  assert.notDeepStrictEqual(v.dur.edges, v.durLog.edges, 'duration scalings are identical');
});
check('session charts come before the response charts', () => {
  const at = s => rep.html.indexOf(s);
  assert.ok(at('Sessions by turn count') < at('Prompt Size Distribution'), 'not moved to the top');
  assert.ok(at('Idle gap') < at('Compaction'), 'compaction should follow the idle-gap chart');
  assert.ok(at('Compaction') < at('id=\\"scatter\\"'), 'compaction should precede the scatter');
});
check('defaults: outliers removed, only the two billable-Claude sources on', () => {
  assert.strictEqual(rep.ids.get('outToggle').checked, true, 'outliers not removed by default');
  const panel = floatPanel();
  const boxes = panel.querySelectorAll('input').slice(1);   // [0] is the log toggle
  const on = rep.data.meta.sources.filter((s, i) => boxes[i].checked);
  assert.deepStrictEqual(on.slice().sort(), ['claude-bedrock', 'claude-sub']);
});
check('the floating panel collapses and expands', () => {
  const panel = floatPanel();
  const head = panel.children.find(c => c.className === 'head');
  const body = panel.children.find(c => c.className === 'body');
  assert.ok(head && body, 'no collapsible header/body');
  assert.strictEqual(body.style.display, 'flex');
  assert.ok(/▾/.test(head.textContent), head.textContent);
  head.listeners.click[0]();
  assert.strictEqual(body.style.display, 'none', 'did not collapse');
  assert.ok(/▸/.test(head.textContent), head.textContent);
  head.listeners.click[0]();
  assert.strictEqual(body.style.display, 'flex', 'did not expand again');
});
// The floating panel is a second copy of the log + source controls, pinned to the viewport
// from its own shadow root on <body>.
function floatPanel() {
  const panels = rep.ctx.document.body.children
    .filter(c => c.shadowRoot)
    .flatMap(c => c.shadowRoot.children.filter(x => x.className === 'float'));
  assert.strictEqual(panels.length, 1, 'expected exactly one floating panel');
  return panels[0];
}
const logged = () => rep.ids.get('sess-turns').querySelectorAll('text')
  .some(t => /log bins/.test(t.textContent));
check('log and source controls exist in both the page and a floating panel', () => {
  assert.ok(/\.float\{position:fixed;top:[^;]*;right:/.test(rep.html), 'not pinned top-right');
  const panel = floatPanel();
  const boxes = panel.querySelectorAll('input');
  // 1 log toggle + one per source
  assert.strictEqual(boxes.length, 1 + rep.data.meta.sources.length, `float has ${boxes.length}`);
  // the outlier toggle is static markup; only the log copy is appended by script
  assert.strictEqual(rep.ids.get('scaleCtrl').querySelectorAll('input').length, 1,
    'no in-page log toggle');
  assert.ok(/outToggle/.test(rep.html), 'outlier toggle disappeared');
  assert.strictEqual(rep.ids.get('srcCtrl').querySelectorAll('input').length,
    rep.data.meta.sources.length, 'page source row lost its checkboxes');
});
check('the two copies stay in sync and both re-draw', () => {
  const panel = floatPanel();
  const floatLog = panel.querySelectorAll('input')[0];
  const pageLog = rep.ids.get('scaleCtrl').querySelectorAll('input')[0];
  assert.ok(!logged(), 'session chart started log-binned');
  floatLog.checked = true;
  floatLog.listeners.change[0]();
  assert.ok(logged(), 'the floating toggle did not re-bin the charts');
  assert.strictEqual(pageLog.checked, true, 'the in-page toggle did not follow');
  pageLog.checked = false;
  pageLog.listeners.change[0]();
  assert.ok(!logged(), 'the in-page toggle did not re-bin the charts');
  assert.strictEqual(floatLog.checked, false, 'the floating toggle did not follow');

  // Same for a source: unchecking it in the floating panel must move the page's copy.
  const floatSrc = panel.querySelectorAll('input')[1];
  const pageSrc = rep.ids.get('srcCtrl').querySelectorAll('input')[0];
  const before = rep.ids.get('tiles').innerHTML;
  floatSrc.checked = false;
  floatSrc.listeners.change[0]();
  assert.strictEqual(pageSrc.checked, false, 'the page source checkbox did not follow');
  assert.notStrictEqual(rep.ids.get('tiles').innerHTML, before, 'tiles did not change');
  pageSrc.checked = true;
  pageSrc.listeners.change[0]();
  assert.strictEqual(floatSrc.checked, true, 'the floating source checkbox did not follow');
});
check('unchecking a source changes what the page draws', () => {
  const before = rep.ids.get('tiles').innerHTML;
  const box = rep.ids.get('srcCtrl').children.find(c => c.tagName === 'label')
    .children.find(c => c.tagName === 'input');
  box.checked = false;
  box.listeners.change[0]();
  const after = rep.ids.get('tiles').innerHTML;
  assert.notStrictEqual(before, after, 'tiles did not change');
});
check('--confluence writes only the macro body', () => {
  const out = path.join(tmp, 'conf.html');
  run(['stats', skelFile, '--confluence=' + out]);
  const body = fs.readFileSync(out, 'utf8').trim();
  assert.ok(body.startsWith('<div id="ccstats-host">'), body.slice(0, 40));
  assert.ok(body.endsWith('</script>'));
  assert.ok(!/<!doctype/i.test(body), 'standalone shell leaked into the macro body');
});
check('the payload is compressed and the drop view shares what it can', () => {
  // zero runs really are encoded (a negative cell), not just dense arrays that happen to fit
  const lin = rep.raw.views.keep.lin;
  assert.ok(lin.len > 0 && lin.g.some(r => r.some(v => v < 0)), 'no zero runs in lin');
  assert.ok(lin.g.some(r => r.length < lin.len), 'rle did not shrink any group');
  // sessions/compactions are identical between views, so they must ship once
  const shared = ['turns', 'turnsLog', 'dur', 'durLog', 'comp', 'compLog', 'pts'];
  for (const k of shared) assert.strictEqual(typeof rep.raw.views.drop[k], 'string', `${k} duplicated`);
  // and the expansion must still agree with the page's own view of the data
  assert.deepStrictEqual(rep.data.views.drop.turns, rep.data.views.keep.turns);
  assert.ok(rep.data.views.drop.pts.length <= rep.data.views.keep.pts.length);
  assert.ok(rep.data.views.drop.pts.every(p => !p[3]), 'trimmed sample kept an outlier');
});
check('report is self-contained', () => {
  assert.ok(!/src\s*=\s*["']http/i.test(rep.html), 'external script/src reference');
  assert.ok(!/@import|link rel=["']stylesheet/i.test(rep.html), 'external stylesheet');
});

if (process.argv.includes('--real')) {
  check('renders from the real session dirs', () => {
    const r = renderReport([]);
    assert.ok(/responses/.test(r.log), r.log);
    assert.ok(r.ids.get('stack-count').children.length, 'nothing drawn');
  });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
