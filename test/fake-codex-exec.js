'use strict';
// A stand-in for `codex exec --json`: records its argv and env, reads the prompt from
// stdin, and prints exec's JSONL. A prompt starting SLEEP runs `sleep` in its own process
// group, as Codex runs a shell command, and waits on it.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { spawn } = require('child_process');

const runs = process.env.FAKE_RUNS;
const argv = process.argv.slice(2);
const stamp = Date.now() + '-' + process.pid;
// `codex app-server`, which ccbb starts to read a resumed thread's earlier messages: one
// turn per thread, recorded apart from exec's runs.
if (argv[0] === 'app-server') {
  fs.writeFileSync(path.join(runs, 'appserver.' + stamp), JSON.stringify(argv));
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.id == null) continue;
      const result = m.method !== 'thread/read' ? {} : { thread: { id: m.params.threadId, cwd: '/tmp', model: 'fake', historyMode: 'full',
        turns: [{ id: 'turn-old', items: [{ id: 'old-1', type: 'agentMessage', text: 'before resume' }] }] } };
      process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
    }
  });
  return;
}
fs.writeFileSync(path.join(runs, 'args.' + stamp), JSON.stringify(argv));
if (!fs.readdirSync(runs).some(f => f.startsWith('env.'))) fs.writeFileSync(path.join(runs, 'env.' + stamp), JSON.stringify(process.env));
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { prompt += d; });
process.stdin.on('end', () => {
  const r = argv.indexOf('resume');
  emit({ type: 'thread.started', thread_id: r >= 0 ? argv[r + 1] : crypto.randomUUID() });
  emit({ type: 'turn.started' });
  if (prompt.startsWith('SLEEP')) {
    emit({ type: 'item.started', item: { id: 'item_0', type: 'command_execution', command: 'sleep 60', aggregated_output: '', exit_code: null, status: 'in_progress' } });
    const c = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    fs.writeFileSync(path.join(runs, 'sleep.' + stamp), String(c.pid));
    c.on('exit', () => finish());
    return;
  }
  if (prompt.startsWith('ORPHAN')) {
    // A command that backgrounds a child and exits a moment later: the child is
    // reparented to launchd, in the command's process group.
    const f = path.join(runs, 'orphan.' + stamp);
    spawn('/bin/sh', ['-c', `sleep 60 & echo $! > ${JSON.stringify(f)}; sleep 1; exit 0`], { detached: true, stdio: 'ignore' });
    setTimeout(finish, 60000);
    return;
  }
  finish();
});
function finish() {
  emit({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'echo: ' + prompt.trim() } });
  emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
  process.exit(0);
}
