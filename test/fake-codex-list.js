#!/usr/bin/env node
'use strict';

const readline = require('readline');
const mode = process.argv[2];
let initialized = false;
let handshake = false;
const now = Math.floor(Date.now() / 1000);
const thread = (id, name, updatedAt = now) => ({
  id, name, preview: '', cwd: '/fixture/codex', createdAt: now - 60, updatedAt,
});

function send(message) {
  const line = JSON.stringify(message) + '\n';
  // Exercise line framing with a notification and a split response.
  process.stdout.write('{"method":"fixture/notification"}\n' + line.slice(0, 9));
  setTimeout(() => process.stdout.write(line.slice(9)), 5);
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    if (mode === 'hang') return;
    if (mode === 'exit') return process.exit(7);
    if (mode === 'malformed') return process.stdout.write('not json\n');
    handshake = true;
    return send({ id: message.id, result: {} });
  }
  if (message.method === 'initialized') {
    initialized = handshake;
    return;
  }
  if (!initialized || message.method !== 'thread/list') process.exit(8);
  const params = message.params;
  if (params.archived !== false || !params.sourceKinds.includes('appServer') ||
      !params.sourceKinds.includes('exec') || params.modelProviders.length) process.exit(9);
  if (mode === 'error') return send({ id: message.id, error: { code: -32601, message: 'unsupported fixture' } });
  send({ id: message.id, result: params.cursor
    ? { data: [thread('shared-id', 'Codex newest'), thread('old-id', 'Old Codex', 1)], nextCursor: mode === 'loop' ? 'page2' : null }
    : { data: [thread('shared-id', 'Codex newest'), thread('second-id', 'Codex second')], nextCursor: 'page2' } });
});
