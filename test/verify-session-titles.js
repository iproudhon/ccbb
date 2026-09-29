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
const shown = 'Busy indicator for claude code sessions';   // as Codex's own UI shows it
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

test('the placeholder gives way to native name, cleaned preview, or stays when there is neither', () => {
  for (const [thread, expected, native] of [
    [{ name: 'Native title', preview }, 'Native title', 'Native title'],
    [{ name: null, preview }, shown, shown],
    [{ name: null, preview: '' }, 'ccbb: term', 'Codex'],
  ]) {
    const s = live(thread);
    assert.equal(s.state.title, expected);
    assert.equal(codexTitle(thread), native);
    assert.equal(s.label, expected, 'the title is the address');
    assert.equal(s.state.label, expected);
  }
});

test('a rename goes to Codex, and later native titles still replace it', async () => {
  const rpc = new EventEmitter(); rpc.endpoint = 'ws://127.0.0.1:1';
  const s = new CodexSession({ notifyChange() {} }, { label: 'my name' }, rpc,
    { thread: { id: 'term', cwd: '/tmp', turns: [], name: 'Native title', preview } });
  s.emit = () => {};
  assert.equal(s.state.title, 'Native title', 'a placeholder never outranks the native title');
  const calls = [];
  rpc.request = async (method, params) => { calls.push([method, params]); return {}; };
  await s.rename('renamed');
  assert.deepEqual(calls, [['thread/name/set', { threadId: 'term', name: 'renamed' }]]);
  assert.equal(s.label, 'renamed');
  s.onRpc({ method: 'thread/name/updated', params: { threadId: 'term', threadName: 'Renamed in Codex' } });
  assert.equal(s.state.title, 'Renamed in Codex');
});

test('a Claude rename is written to the transcript; before it exists it waits and shows', async () => {
  const { Mux, Session } = require('../ccbb-mux');
  const common = require('../ccbb-common');
  const mux = new Mux({});
  const id = '99999999-8888-4777-8666-555555555555';
  const s = new Session(mux, { agent: 'fake', sessionId: id, cwd: '/tmp/proj', name: 'my name' });
  mux.sessions.set(s.id, s);
  assert.equal(s.state.title, 'my name', '-n shows while the agent has no title');
  await s.rename('renamed early');
  assert.equal(s.state.title, 'renamed early');
  assert.equal(s.pendingName, 'renamed early');
  const file = path.join(dir, 'projects', '-tmp-proj', id + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'Generated', sessionId: id }) + '\n');
  s.refreshStats(0); await new Promise(r => setTimeout(r, 50));
  assert.equal(s.pendingName, '');
  assert.equal(common.getSessionStats(id, {}).title, 'renamed early', 'the pending name reached the transcript');
  assert.equal(s.state.title, 'renamed early');
  // The agent renaming it (Claude's /rename writes the same record) wins from then on.
  fs.appendFileSync(file, JSON.stringify({ type: 'custom-title', customTitle: 'From /rename', sessionId: id }) + '\n');
  s.refreshStats(0); await new Promise(r => setTimeout(r, 50));
  assert.equal(s.state.title, 'From /rename');
  await s.rename('from ccbb');
  assert.equal(common.getSessionStats(id, {}).title, 'from ccbb');
  assert.equal(s.state.title, 'from ccbb');
  s.rawLog && s.rawLog.end();
});

test('the newest ai-title is the one shown', () => {
  const common = require('../ccbb-common');
  const id = '77777777-8888-4777-8666-555555555555';
  const file = path.join(dir, 'projects', '-tmp-proj', id + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [{ type: 'ai-title', aiTitle: 'First' }, { type: 'ai-title', aiTitle: 'Second' }]
    .map(x => JSON.stringify({ ...x, sessionId: id }) + '\n').join(''));
  assert.equal(common.getSessionStats(id, {}).title, 'Second');
});

test('list and page use the same native title before and after discovery refresh', async () => {
  for (const name of [null, 'Native generated title']) {
    const active = mux(live({ name, preview }));
    assert.equal(mergeMuxRows({ sessions: [] }, active).sessions[0].title, name || shown);
    for (let n = 0; n < 3; n++) {
      assert.equal(mergeMuxRows(await discovery(name), active).sessions[0].title, name || shown);
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
  assert.equal(s.state.title, shown);
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
  assert.equal(s.state.title, shown);
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
  assert.equal(mergeMuxRows(await discovery(null), { list: () => [] }).sessions[0].title, shown);
  const payload = { sessions: [{ sessionId: 'claude', agent: 'claude', title: 'Saved Claude title' }] };
  mergeMuxRows(payload, { list: () => [{ id: 'claude', agent: 'claude', title: 'Old mux title' }] });
  assert.equal(payload.sessions[0].title, 'Saved Claude title');
});

test('a title shared by two sessions is refused as an address, never guessed', () => {
  const { Mux, pickSession } = require('../ccbb-mux');
  const mux = new Mux({});
  const mk = id => { const rpc = new EventEmitter(); rpc.endpoint = 'ws://127.0.0.1:1';
    const s = new CodexSession(mux, { label: 'api' }, rpc, { thread: { id, cwd: '/tmp', turns: [], name: 'Same', preview } });
    s.emit = () => {}; mux.sessions.set(s.id, s); return s; };
  const a = mk('aaaa1111'), b = mk('bbbb2222');
  assert.equal(a.label, 'Same'); assert.equal(b.label, 'Same', 'no -2 suffix: the list and the page agree');
  assert.equal(mux.get('Same'), null);
  assert.equal(mux.get('codex:aaaa1111'), a);
  const rows = mux.list();
  assert.match(pickSession(rows, 'Same').error, /aaaa1111.*bbbb2222/);
  b.state.status = 'exited';
  assert.equal(mux.get('Same'), a, 'a live holder is unambiguous');
});
