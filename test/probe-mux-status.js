// Diagnostic: attach to a mux session as a web client and print every status-bearing
// event with a relative timestamp. Run while a session works to see exactly what a
// browser view receives:  node test/probe-mux-status.js <session-id>
const { muxAddress } = require('../ccbb-mux');
const common = require('../ccbb-common');
const WebSocket = require('ws');
const a = muxAddress();
const qs = new URLSearchParams({ session: process.argv[2], label: 'probe', kind: 'web' });
const tok = common.peerToken && common.peerToken(); if (tok) qs.set('token', tok);
const ws = new WebSocket(`ws://${a.host}:${a.port}${a.prefix || ''}/mux?${qs}`);
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
ws.on('message', d => {
  const m = JSON.parse(d);
  const evs = m.op === 'event' ? [m] : m.op === 'snapshot' ? [{ kind: 'SNAPSHOT', status: m.state && m.state.status, activity: m.state && m.state.activity }] : [];
  for (const e of evs) {
    if (['delta', 'thinking_tokens', 'message', 'tool_pending', 'tool_progress', 'hook'].includes(e.kind)) { process.stdout.write(`${ts()} ${e.kind}\n`); continue; }
    if (!['status','SNAPSHOT','result','stats','init','compact_done'].includes(e.kind)) { process.stdout.write(`${ts()} ${e.kind}\n`); continue; }
    process.stdout.write(`${ts()} ${e.kind} status=${e.status} activity=${e.activity} ${e.kind==='init' ? 'state.status='+(e.state&&e.state.status) : ''}\n`);
  }
  if (!['event','snapshot'].includes(m.op)) process.stdout.write(`${ts()} op=${m.op}\n`);
});
ws.on('open', () => process.stdout.write('open\n'));
ws.on('close', (c) => { process.stdout.write('close ' + c + '\n'); process.exit(0); });
setTimeout(() => process.exit(0), 90000);
