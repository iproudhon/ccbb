'use strict';
// The session info grid and status line (ccbb-session-info-ui), and sessionProc's read of
// a live terminal session's process. node test/verify-session-info.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { spawn } = require('child_process');
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-si-'));
process.env.CLAUDE_CONFIG_DIR = cfg; process.env.CCBB_HOME = cfg;
const { sessionProc } = require('../ccbb-common');
const { SHARED_JS } = require('../ccbb-web');

const ctx = vm.createContext({});
vm.runInContext(SHARED_JS, ctx);
const now = Date.now();
const stats = (agoMs, extra) => Object.assign({
  cost: 12.345, turns: 7, subTurns: 2, totalTokens: 1.5e6, cacheTtl: 300,
  lastAssistantAt: new Date(now - agoMs).toISOString(),
  categories: { cacheRead: { tokens: 1e6, cost: 1.5 }, cacheWrite: { tokens: 2e5, cost: 3 }, output: { tokens: 1e4, cost: 0.75 } },
  context: { tokens: 120000, cost: 0.06, costWrite: 0.75, model: 'claude-opus-5', provider: 'anthropic' },
  contextMax: { tokens: 150000 }, providers: [{ provider: 'anthropic', cost: 12.3 }],
  models: [{ model: 'claude-opus-5', cost: 12.3 }], startedAt: '2026-11-01T10:00:00Z', lastActivity: '2026-11-01T11:00:00Z', avgResponseMs: 4200, avgOutTps: 55,
}, extra);
const sub = { account: {}, windows: { fiveHour: { pct: 24, resetsAt: new Date(now + 3600e3).toISOString() }, sevenDay: { pct: 41 } } };

test('footer: cost, plan, turns, ctx, warm resend; no gen speed', () => {
  const h = ctx.siFootHtml({ st: stats(60e3), sub }, 0);
  assert.match(h, /\$12\.35/);
  assert.match(h, /class="fwins"/);
  assert.match(h, /<b>7<\/b><span class="sl-sub">\+2<\/span>/);
  assert.match(h, /ctx:<b>120K<\/b>\/150K\/<span class="sl-rs">\$0\.06<\/span>/);
  assert.doesNotMatch(h, /ttft|tok\/s|out\/s/);
});

test('footer: cache past its TTL resends at cache-write price, marked cold', () => {
  const h = ctx.siFootHtml({ st: stats(400e3), sub: null }, 0);
  assert.match(h, /<span class="sl-rs cold">\$0\.75<\/span>/);
  assert.doesNotMatch(h, /fwins/);
  // A later response the stats have not seen re-warms it.
  assert.match(ctx.siFootHtml({ st: stats(400e3), lastAt: now - 5e3 }, 0), /class="sl-rs">\$0\.06/);
  // 1h TTL keeps it warm at 400s.
  assert.match(ctx.siFootHtml({ st: stats(400e3, { cacheTtl: 3600 }) }, 0), /class="sl-rs">/);
});

test('footer: the ctx label goes at the last shrink level', () => {
  assert.doesNotMatch(ctx.siFootHtml({ st: stats(0) }, ctx.FOOT_LVL_CTX_LABEL), /ctx:/);
});

test('plan windows only for a session billed to the plan', () => {
  assert.equal(ctx.siOnPlan(stats(0), sub), sub);
  assert.equal(ctx.siOnPlan(stats(0, { providers: [{ provider: 'bedrock', cost: 5 }] }), sub), null);
});

test('grid: session rows then usage rows', () => {
  const h = ctx.siGridHtml({ cwd: '/w/p', sessionId: 'abc-123', bin: 'claude.exe', binNote: 'Bedrock',
    model: 'claude-opus-5', compactAt: 200000, mode: 'plan', status: '<b>idle</b>', st: stats(60e3), sub });
  const labels = [...h.matchAll(/<dt>([^<]+)<\/dt>/g)].map(m => m[1]);
  assert.deepEqual(labels, ['Directory', 'Session', 'Binary', 'Model', 'Compact at', 'Mode', 'Status', 'Active',
    'Cost', 'Turns', 'Context', 'Resend', 'Tokens', 'Response']);
  assert.match(h, /data-copy="abc-123"/);
  assert.match(h, /data-copy="\/w\/p"/);
  assert.match(h, /claude\.exe <span class="si-dim">Bedrock<\/span>/);
  assert.match(h, /200K/);
  assert.match(h, /60% of 200K/);
  assert.match(h, /5h 24% · 7d 41%/);
  assert.doesNotMatch(ctx.siGridHtml({ compactAt: 'default' }), /<dt>Cost/);
  assert.match(ctx.siGridHtml({ compactAt: 'default' }), /<dd>Default<\/dd>/);
});

test('mux: live numbers override the last stats pass, resend scales with context', () => {
  const st = ctx.siLiveStats({ stats: stats(0), cost: 20, turns: 9, contextTokens: 240000, contextPeak: 260000 });
  assert.equal(st.cost, 20); assert.equal(st.turns, 9);
  assert.equal(st.context.tokens, 240000);
  assert.ok(Math.abs(st.context.cost - 0.12) < 1e-9);
  assert.ok(Math.abs(st.context.costWrite - 1.5) < 1e-9);
  assert.equal(st.contextMax.tokens, 260000);
  const m = ctx.siMuxModel({ connected: true, status: 'busy', permissionMode: 'acceptEdits', cwd: '/x',
    clients: [{ label: 'web-1', kind: 'web' }], info: { agent: 'claude', bin: 'claude.dsa', compactAt: 300000, exit: { code: 1 } } }, 'sid');
  assert.equal(m.bin, 'claude.dsa'); assert.equal(m.compactAt, 300000); assert.equal(m.clients, 'web-1 (web)');
  assert.match(m.status, /busy.*exited \(1\)/);
});

test('sessionProc reads only the binary and the named env of a live session', async () => {
  fs.mkdirSync(path.join(cfg, 'sessions'), { recursive: true });
  const script = path.join(cfg, 'fake-claude.js');
  fs.writeFileSync(script, 'setTimeout(()=>{}, 30000)');
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, CLAUDE_CODE_AUTO_COMPACT_WINDOW: '180000', ANTHROPIC_BASE_URL: 'https://gw.example:8443/v1?k=secret', SECRET_TOKEN: 'nope' },
    stdio: 'ignore',
  });
  try {
    await new Promise(r => setTimeout(r, 200));
    fs.writeFileSync(path.join(cfg, 'sessions', child.pid + '.json'), JSON.stringify({ sessionId: 'live-1', pid: child.pid, cwd: '/tmp' }));
    const p = sessionProc('live-1');
    assert.deepEqual(p, { bin: 'fake-claude.js', via: 'gateway gw.example:8443', compactAt: 180000, model: null });
    assert.doesNotMatch(JSON.stringify(p), /secret|nope/);
    assert.equal(sessionProc('nope'), null);
  } finally { child.kill('SIGKILL'); }
});

test.after(() => fs.rmSync(cfg, { recursive: true, force: true }));
