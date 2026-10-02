'use strict';
// Usage stats off a transcript, for a model behind a gateway that streams the way a
// LiteLLM-fronted local model does: one entry per content block, output_tokens 0 on all
// but the one carrying stop_reason, and no requestId. No user state: a temp file only.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const common = require('../ccbb-common');

const SID = '00000000-0000-4000-8000-0000000000aa';
function transcript(model, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-stats-'));
  const file = path.join(dir, SID + '.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify({ sessionId: SID, ...e })).join('\n') + '\n');
  return file;
}
const user = ts => ({ type: 'user', timestamp: ts, message: { role: 'user', content: 'go' } });
const block = (ts, id, model, type, usage, stop) => ({ type: 'assistant', timestamp: ts,
  message: { id, model, role: 'assistant', content: [{ type }], usage, stop_reason: stop || null } });

test('a response is counted by its final block, and ends when that block was written', () => {
  const m = 'DSA-Max-CODE';
  const file = transcript(m, [
    user('2026-10-01T00:00:00.000Z'),
    block('2026-10-01T00:00:20.000Z', 'msg_a', m, 'thinking', { input_tokens: 1000, output_tokens: 0 }),
    block('2026-10-01T00:00:21.000Z', 'msg_a', m, 'text', { input_tokens: 1000, output_tokens: 0 }),
    block('2026-10-01T00:00:30.000Z', 'msg_a', m, 'tool_use',
      { input_tokens: 1000, output_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, 'tool_use'),
  ]);
  const s = common.computeSessionStats(SID, { usagePaths: [file] });
  assert.equal(s.categories.output.tokens, 600);
  assert.equal(s.turns, 1);
  assert.equal(s.avgResponseMs, 30000);
  assert.equal(s.avgOutTps, 20);
  assert.equal(s.context.tokens, 1600);
  const c = common.sessionContribution([file]).overall.all;
  assert.equal(c.respMs, 30000);
  assert.equal(c.respOut, 600);
  assert.equal(c.categories.output.tokens, 600);
  assert.deepEqual(s.providers.map(p => p.provider), ['local']);
  assert.deepEqual(Object.keys(common.sessionContribution([file]).overall.byProvider), ['local']);
});

test('local is a model that is not Claude; Bedrock ids and Claude Code placeholders are not', () => {
  assert.equal(common.providerOf('msg_696774dd', 'DSA-Max-CODE'), 'local');
  assert.equal(common.providerOf('msg_01abc', 'claude-opus-5-5'), 'anthropic');
  assert.equal(common.providerOf('msg_01abc', '<synthetic>'), 'anthropic');
  assert.equal(common.providerOf('msg_bdrk_01abc', 'arn:aws:bedrock:us-west-2:1:application-inference-profile/x'), 'bedrock');
});

test('a model that is not Claude costs nothing; Claude and opaque Bedrock ids keep a price', () => {
  assert.equal(common.priceForModel('DSA-Max-CODE', 'anthropic').output, 0);
  assert.equal(common.priceForModel('glm-5.3', 'anthropic').input, 0);
  assert.ok(common.priceForModel('claude-sonnet-5', 'anthropic').output > 0);
  assert.ok(common.priceForModel('arn:aws:bedrock:us-west-2:1:application-inference-profile/x', 'bedrock').output > 0);
});
