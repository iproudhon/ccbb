'use strict';
// A one-line GFM table splits back into rows; everything else is left alone.
// No user state. Renders through marked when ~/.claude/ccbb-vendor/marked-12.js is cached.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { unjoinTables } = require('../ccbb-common');

const joined = '| Arm | Decode 1 @1k | Prefill 8k | |---|---|---| | SGLang graphs | 8.9 → 9.3 | no data | | vLLM \\| graphs | 23.9 → 22.8 | 489 → 430 |';

test('a table written on one line splits into rows', () => {
  assert.equal(unjoinTables('Step times:\n\n' + joined), 'Step times:\n\n' + [
    '| Arm | Decode 1 @1k | Prefill 8k |', '|---|---|---|',
    '| SGLang graphs | 8.9 → 9.3 | no data |', '| vLLM \\| graphs | 23.9 → 22.8 | 489 → 430 |'].join('\n'));
});

test('proper tables, fenced lines, and uneven rows are left as written', () => {
  const proper = '| a | b |\n|---|---|\n| 1 | 2 |';
  assert.equal(unjoinTables(proper), proper);
  const fenced = '```\n' + joined + '\n```';
  assert.equal(unjoinTables(fenced), fenced);
  const uneven = '| a | b | |---|---| | 1 | 2 | 3 |';
  assert.equal(unjoinTables(uneven), uneven);
  assert.equal(unjoinTables('| | |'), '| | |');
});

const vendored = path.join(os.homedir(), '.claude', 'ccbb-vendor', 'marked-12.js');
test('the page hook makes marked draw it as a table', { skip: !fs.existsSync(vendored) && 'marked not cached' }, () => {
  const { SHARED_JS } = require('../ccbb-web');
  const ctx = { addEventListener() {} };
  ctx.window = ctx; ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(vendored, 'utf8'), ctx);
  vm.runInContext(SHARED_JS, ctx);
  const html = ctx.marked.parse(joined);
  assert.match(html, /<table>/);
  assert.equal((html.match(/<tr>/g) || []).length, 3);
});
