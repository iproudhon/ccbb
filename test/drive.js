#!/usr/bin/env node
'use strict';
// A second controller. It attaches over the same WebSocket the browser uses, so
// running it while a browser is attached is also the multi-controller test: the
// turns it submits and the cards it answers must appear in the browser without
// the browser having done anything.
//
//   node test/drive.js <port> <sessionId> full   walk every scene, answering cards
//   node test/drive.js <port> <sessionId> hold   stop on the first open card
//   node test/drive.js <port> <sessionId> plan   walk to the plan card and stop
const WebSocket = require('ws');

const port = process.argv[2], sid = process.argv[3], mode = process.argv[4] || 'full';
// Defaults to the machine's own peerToken: the mux is behind ccbb web's auth now, so
// a driver with no token is refused rather than merely unlucky.
const common = require('../ccbb-common');
const token = process.argv[5] || (common.peerToken ? common.peerToken() : '') || '';
const TURNS = ['is 289 prime?', 'fix the typo', 'ask me something', 'show me the tools', 'plan it', 'run an agent'];
const STOP_AT = mode === 'hold' ? 2 : mode === 'plan' ? 5 : mode === 'one' ? 1 : TURNS.length;

// /mux/mux: the outer /mux is ccbb web's prefix for the multiplexer, the inner one is
// the mux's own socket path. There is no other port to reach it on any more.
const ws = new WebSocket(`ws://127.0.0.1:${port}/mux/mux?session=${sid}&label=driver&kind=test` +
  (token ? `&token=${encodeURIComponent(token)}` : ''));
const send = o => ws.send(JSON.stringify(o));
let turn = 0, done = false;

function next() {
  if (turn >= STOP_AT) return finish();
  send({ op: 'submit', text: TURNS[turn++] });
}
function finish() {
  if (done) return;
  done = true;
  // Let the last scene's trailing events (the agent's task-notification) land.
  setTimeout(() => { ws.close(); process.exit(0); }, 2500);
}

ws.on('open', () => setTimeout(next, 400));
ws.on('message', raw => {
  let m; try { m = JSON.parse(raw); } catch { return; }
  if (m.op !== 'event') return;
  if (m.kind === 'request') {
    const isPlanCard = m.payload && m.payload.tool_name === 'ExitPlanMode';
    // 'hold' stops on the first card; 'plan' has to answer its way past the
    // earlier ones to reach the plan card, then leave THAT one open.
    if (mode === 'hold' || (mode === 'plan' && isPlanCard)) return finish();
    setTimeout(() => {
      if (m.requestKind === 'question') {
        return send({ op: 'answer', requestId: m.requestId,
          picks: { 'Which colour?': ['Red'], 'Which sides?': ['Fries', 'Soup'] } });
      }
      const isPlan = m.payload && m.payload.tool_name === 'ExitPlanMode';
      send({ op: 'answer', requestId: m.requestId, allow: true,
        planMode: isPlan ? 'acceptEdits' : undefined });
    }, 300);
    return;
  }
  if (m.kind === 'result') setTimeout(next, 400);
});
ws.on('error', e => { console.error('drive:', e.message); process.exit(1); });
