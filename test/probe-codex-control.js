'use strict';
// Opt-in real-account probe: sends two short prompts in a fresh scratch thread.
// Leaves its app-server and history available for native-TUI/browser inspection.
const fs = require('fs'), os = require('os'), path = require('path');
const assert = require('node:assert/strict');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-codex-probe-'));
process.env.CCBB_HOME = process.env.CCBB_HOME || path.join(scratch, 'ccbb');
process.env.CLAUDE_CONFIG_DIR = path.join(scratch, 'claude');
const { Mux } = require('../ccbb-mux');
const { CodexSocket } = require('../ccbb-codex-session');
const pause = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 120; i++) { if (fn()) return; await pause(500); }
  throw new Error('Timed out waiting for the real Codex turn');
}
(async () => {
  const mux = new Mux();
  let other;
  try {
    const s = await mux.create({agent:'codex',cwd:scratch,label:'Codex compatibility probe'});
    console.log('Codex:', s.rpc.info.userAgent);
    console.log('Endpoint:', s.rpc.endpoint);
    await s.submit('Reply exactly: CCBB Codex web is connected. Do not use tools.', null, 'probe');
    await until(() => s.messages.some(m => m.role === 'assistant') && s.state.status === 'idle');
    other = await new CodexSocket(s.rpc.endpoint).connect();
    await other.request('thread/resume', {threadId:s.nativeId});
    await other.request('turn/start', {threadId:s.nativeId,input:[{type:'text',text:'Reply exactly: Shared client works. Do not use tools.'}]});
    await until(() => s.messages.some(m => m.blocks.some(b => b.text === 'Shared client works.')) && s.state.status === 'idle');
    const fork = await mux.create({agent:'codex',resume:s.nativeId,fork:true});
    assert.notEqual(fork.nativeId, s.nativeId);
    assert(fork.messages.length >= 4);
    await s.stop();
    assert.equal((await other.request('thread/read', {threadId:s.nativeId})).thread.id, s.nativeId);
    console.log('PASS: streaming, external submission, distinct fork, and shared-server detach');
    console.log('CCBB_TEST_THREAD=' + s.nativeId);
    console.log('Native attach: codex resume --remote ' + s.rpc.endpoint + ' ' + s.nativeId);
  } finally { await mux.stopAll(); if (other) other.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
