'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-native-titles-'));
process.env.CLAUDE_CONFIG_DIR = dir;
process.env.CCBB_HOME = dir;
const { codexTitle, getCodexSessions } = require('../ccbb-agent-codex');
const { CodexSession } = require('../ccbb-codex-session');
const { mergeMuxRows } = require('../ccbb-mux-web');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const preview = '- Busy indicator for claude code sessions';
async function discovery(name) {
  const rows = await getCodexSessions(null, {
    async initialize() {},
    async request() { return { data: [{ id: 'term', name, preview, cwd: '/tmp', createdAt: 1, updatedAt: 2 }], nextCursor: null }; },
    close() {},
  });
  return { sessions: rows.map(row => ({ ...row, sessionId: row.sessionKey })) };
}
function live(thread) {
  const rpc = new EventEmitter(); rpc.endpoint = 'ws://127.0.0.1:1';
  const s = new CodexSession({ notifyChange() {} }, { label: 'ccbb: term' }, rpc,
    { thread: { id: 'term', cwd: '/tmp', turns: [], ...thread } });
  s.emit = () => {};
  return s;
}
function mux(session) {
  return { list: () => [{ id: 'codex:term', agent: 'codex', title: session.state.title, label: session.label, status: 'busy' }] };
}

test('native name, preview, and unnamed fallback never use the mux label', () => {
  for (const [thread, expected] of [
    [{ name: 'Native title', preview }, 'Native title'],
    [{ name: null, preview }, preview],
    [{ name: null, preview: '' }, 'Codex'],
  ]) {
    const s = live(thread);
    assert.equal(s.state.title, expected);
    assert.equal(codexTitle(thread), expected);
    assert.equal(s.label, 'ccbb: term', 'address is independent of title');
  }
});

test('list and page use the same native title before and after discovery refresh', async () => {
  for (const name of [null, 'Native generated title']) {
    const active = mux(live({ name, preview }));
    assert.equal(mergeMuxRows({ sessions: [] }, active).sessions[0].title, name || preview);
    for (let n = 0; n < 3; n++) {
      assert.equal(mergeMuxRows(await discovery(name), active).sessions[0].title, name || preview);
    }
  }
});

test('native first-prompt metadata replaces the unnamed live-page fallback', async () => {
  const s = live({ name: null, preview: '' });
  s.rpc.request = async (method, params) => {
    assert.equal(method, 'thread/read'); assert.equal(params.includeTurns, false);
    return { thread: { id: 'term', name: null, preview } };
  };
  await s.refreshTitle();
  assert.equal(s.state.title, preview);
});

test('native rename events win over older metadata reads; clearing a name uses preview', async () => {
  const s = live({ name: 'Old native name', preview });
  let finish;
  s.rpc.request = () => new Promise(r => { finish = r; });
  const pending = s.refreshTitle();
  s.onRpc({ method: 'thread/name/updated', params: { threadId: 'term', threadName: 'New native name' } });
  finish({ thread: { name: 'Old native name', preview } }); await pending;
  assert.equal(s.state.title, 'New native name');
  s.onRpc({ method: 'thread/name/updated', params: { threadId: 'term', threadName: null } });
  assert.equal(s.state.title, preview);
});

test('a newer native metadata read wins over a slower old read', async () => {
  const s = live({ name: null, preview: '' });
  const replies = [];
  s.rpc.request = () => new Promise(r => replies.push(r));
  const first = s.refreshTitle(), second = s.refreshTitle();
  replies[1]({ thread: { name: 'Native name', preview } }); await second;
  replies[0]({ thread: { name: null, preview: '' } }); await first;
  assert.equal(s.state.title, 'Native name');
});

test('unattached history and Claude transcript title priority are unchanged', async () => {
  assert.equal(mergeMuxRows(await discovery(null), { list: () => [] }).sessions[0].title, preview);
  const payload = { sessions: [{ sessionId: 'claude', agent: 'claude', title: 'Saved Claude title' }] };
  mergeMuxRows(payload, { list: () => [{ id: 'claude', agent: 'claude', title: 'Old mux title' }] });
  assert.equal(payload.sessions[0].title, 'Saved Claude title');
});
