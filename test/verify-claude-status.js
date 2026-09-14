'use strict';
// No child process or user state: exercise the shipping Claude protocol reducer.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Session } = require('../ccbb-mux');

function fixture() {
  const events = [];
  const s = Object.assign(Object.create(Session.prototype), {
    state: { status: 'idle', activity: null, turns: 0, tokens: 0 },
    turnLive: false, _statusLine: null,
    emit(kind, payload) { events.push({ kind, ...payload }); },
    settlePendingCmd() {}, refreshStats() {},
  });
  return { s, events, statuses: () => events.filter(e => e.kind === 'status').map(e => e.status) };
}

test('each completed Claude turn publishes busy then idle, despite repeated status events', () => {
  const { s, statuses } = fixture();
  for (let n = 0; n < 3; n++) {
    s.beginTurn();
    s.onSystem({ subtype: 'status', status: 'requesting' });
    s.onMessage({ type: 'result', num_turns: 1 });
    s.onSystem({ subtype: 'status', status: 'requesting' });
    assert.equal(s.turnLive, false);
    assert.equal(s.state.activity, null);
  }
  assert.deepEqual(statuses(), ['busy', 'idle', 'busy', 'idle', 'busy', 'idle']);
});

test('interrupt without a child result publishes idle and the next prompt publishes busy', async () => {
  const { s, statuses } = fixture();
  s.control = async () => ({ response: { still_queued: [] } });
  s.beginTurn();
  await s.interrupt('phone');
  assert.equal(s.turnLive, false);
  assert.equal(s.state.activity, null);
  s.beginTurn();
  assert.deepEqual(statuses(), ['busy', 'idle', 'busy']);
});

test('late interrupt acknowledgement cannot clear newer work or resurrect an exited child', async () => {
  for (const transition of ['submission', 'queued submission', 'compaction', 'exit']) {
    const { s, statuses } = fixture();
    let reply;
    s.control = () => new Promise(r => { reply = r; });
    s.beginTurn();
    const pending = s.interrupt('phone');
    if (transition === 'submission') { s.onMessage({ type: 'result' }); s.beginTurn(); }
    if (transition === 'queued submission') s.beginTurn(null, true);
    if (transition === 'compaction') { s.endTurn(); s.onSystem({ subtype: 'status', status: 'compacting' }); }
    if (transition === 'exit') s.state.status = 'exited';
    const before = statuses().slice();
    reply({ response: { still_queued: [] } });
    await pending;
    assert.equal(s.state.status, transition === 'exit' ? 'exited' : 'busy', transition);
    assert.deepEqual(statuses(), before, transition);
  }
});

test('surviving queued work stays busy until the child completes it', async () => {
  const { s, statuses } = fixture();
  s.control = async () => ({ response: { still_queued: ['next prompt'] } });
  s.beginTurn();
  await s.interrupt('phone');
  assert.equal(s.state.status, 'busy');
  s.onMessage({ type: 'result' });
  assert.deepEqual(statuses(), ['busy', 'idle']);
});

test('result before interrupt acknowledgement produces only one idle transition', async () => {
  const { s, statuses } = fixture();
  let reply;
  s.control = () => new Promise(r => { reply = r; });
  s.beginTurn();
  const pending = s.interrupt('phone');
  s.onMessage({ type: 'result' });
  reply({ response: {} });
  await pending;
  assert.deepEqual(statuses(), ['busy', 'idle']);
});

test('compaction and explicit idle status use the same end transition', () => {
  const { s, statuses } = fixture();
  s.beginTurn('compacting');
  s.onSystem({ subtype: 'status', compact_result: 'success' });
  assert.equal(s.state.activity, null);
  s.beginTurn();
  s.onSystem({ subtype: 'status', status: null });
  assert.equal(s.turnLive, false);
  s.beginTurn();
  assert.deepEqual(statuses(), ['busy', 'idle', 'busy', 'idle', 'busy']);
});

test('same-turn message and activity changes do not defeat an interrupt', async () => {
  const { s, statuses } = fixture();
  let reply, settled = false;
  s.control = () => new Promise(r => { reply = r; });
  s.settlePendingCmd = () => { settled = true; };
  s.beginTurn();
  const pending = s.interrupt('phone');
  s.beginTurn(); // another assistant message after a tool result
  s.onSystem({ subtype: 'status', status: 'compacting' });
  reply({ subtype: 'success', response: {} });
  await pending;
  assert.equal(s.state.status, 'idle');
  assert.equal(statuses().at(-1), 'idle');
  assert(settled, 'interrupt settles command cards without waiting for result');
});

test('missing or failed interrupt acknowledgement does not claim the child stopped', async () => {
  for (const response of [null, { subtype: 'error', error: 'failed' }]) {
    const { s } = fixture();
    s.control = async () => response;
    s.beginTurn();
    await s.interrupt('phone');
    assert.equal(s.state.status, 'busy');
  }
});

test('control handles failed writes immediately and removes resolved requests', async () => {
  const { s } = fixture();
  s.outstanding = new Map();
  s.write = () => false;
  assert.equal(await s.control('interrupt'), null);
  assert.equal(s.outstanding.size, 0);
  s.write = m => {
    s.onMessage({ type: 'control_response', response: { request_id: m.request_id, subtype: 'success' } });
    return true;
  };
  assert.equal((await s.control('interrupt')).subtype, 'success');
  assert.equal(s.outstanding.size, 0);
});


test('a turn starting during automatic compaction supersedes its pending interrupt', async () => {
  const { s } = fixture();
  let reply;
  s.control = () => new Promise(r => { reply = r; });
  s.onSystem({ subtype: 'status', status: 'compacting' });
  assert.equal(s.turnLive, false);
  const pending = s.interrupt('phone');
  s.beginTurn();
  reply({ subtype: 'success', response: {} });
  await pending;
  assert.equal(s.state.status, 'busy');
  assert.equal(s.turnLive, true);
});
