#!/usr/bin/env node
'use strict';
// Regression for the web client. Drives headless Chrome over the DevTools
// protocol against a real mux backed by test/fake-claude.js.
//
// Why CDP and not `--dump-dom`: --dump-dom renders once and exits, so the browser
// only ever sees the finished transcript in a snapshot. That skips the delta path
// entirely — the client is never attached while tokens are streaming — and the
// delta path is precisely the one that has already broken silently once (it made
// the terminal client's prose vanish). Here the page attaches FIRST and the turns
// are driven afterwards, so what is asserted is what a live session does.
//
// This checks rendering and reconnection, not fidelity: there is no byte-exact
// reference to diff a DOM against, unlike the terminal client's captures.
//
//   node test/verify.js [--keep]
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8597, CDP = 9333;
const KEEP = process.argv.includes('--keep');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The fixture writes one raw log per session into the same directory a real mux
// uses, and republishes its address file. Both are put back: a suite that leaves
// debris in ~/.claude is a suite people stop running.
const common = require('../ccbb-common');
const MUX_DIR = require('path').join(common.CLAUDE_DIR, 'ccbb-mux');
const ADDR = path.join(MUX_DIR, 'address');
let savedAddr = null;
try { savedAddr = fs.readFileSync(ADDR, 'utf8'); } catch {}

let failed = 0, kids = [], made = [];
function check(name, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}     ${name}`);
  if (!ok) { failed++; if (detail) console.log('           ' + detail); }
}
function kill() {
  for (const k of kids) { try { process.kill(-k.pid); } catch {} try { k.kill('SIGKILL'); } catch {} }
  kids = [];
}
function cleanup() {
  kill();
  for (const sid of made) { try { fs.unlinkSync(path.join(MUX_DIR, sid + '.ndjson')); } catch {} }
  made = [];
  try {
    if (savedAddr != null) fs.writeFileSync(ADDR, savedAddr);
    else fs.unlinkSync(ADDR);
  } catch {}
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

async function until(fn, tries = 80, gap = 150) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(gap);
  }
  return null;
}

// ── a minimal DevTools client ──────────────────────────────────────────────
function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const waiting = new Map();
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const r = waiting.get(m.id);
    if (r) { waiting.delete(m.id); r(m); }
  });
  const ready = new Promise(res => ws.on('open', res));
  return {
    ready,
    send(method, params) {
      const n = ++id;
      ws.send(JSON.stringify({ id: n, method, params: params || {} }));
      return new Promise(res => waiting.set(n, res));
    },
    async evaluate(expression) {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      const res = r.result || {};
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.text + ' ' +
        JSON.stringify(res.exceptionDetails.exception && res.exceptionDetails.exception.description || ''));
      return res.result && res.result.value;
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function startFixture() {
  kill();
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(PORT)],
    { detached: true, stdio: 'ignore' });
  kids.push(srv);
  const auth = TOKEN ? { headers: { 'x-ccbb-token': TOKEN } } : undefined;
  const sid = await until(async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/mux/api/sessions`, auth);
    const j = await r.json();
    return (j.sessions[0] || {}).id;
  });
  if (!sid) throw new Error('the fixture server never came up on ' + PORT);
  made.push(sid);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'],
    { detached: true, stdio: 'ignore' });
  kids.push(chrome);
  const ver = await until(async () => (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json());
  if (!ver) throw new Error('headless Chrome never opened a debugging port');

  const url = `http://127.0.0.1:${PORT}/mux/s/${sid}` + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
  const tgt = await until(async () =>
    (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json());
  if (!tgt || !tgt.webSocketDebuggerUrl) throw new Error('could not open a page');
  const page = cdpConnect(tgt.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  // The page must be attached and settled BEFORE any turn is driven.
  await until(async () => await page.evaluate('!!document.querySelector(".mx-log")'));
  await sleep(600);
  return { sid, page };
}

function drive(sid, mode, token) {
  const d = spawn(process.execPath,
    [path.join(__dirname, 'drive.js'), String(PORT), sid, mode, token || ''],
    { detached: true, stdio: 'ignore' });
  kids.push(d);
  return d;
}
const dom = page => page.evaluate('document.documentElement.outerHTML');

const TOKEN = common.peerToken ? common.peerToken() : '';
const RESUMED_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function main() {
  // The client is a template literal inside ccbb-mux-web.js, so every backslash in
  // it is doubled. Getting that wrong yields a page that loads and silently does
  // nothing, so the emitted script is parsed before anything else runs.
  console.log('client bundle:');
  const web = require('../ccbb-mux-web');
  let parses = true, perr = '';
  try { new (require('vm').Script)(web.APP_JS); } catch (e) { parses = false; perr = e.message; }
  check('APP_JS parses after template-literal escaping', parses, perr);

  // The resume flags. These cost a real child process each to discover — Claude Code
  // refuses "--session-id can only be used with --continue or --resume if
  // --fork-session is also specified", and passing all three killed the child before
  // it wrote a byte, which showed up as a session stuck in 'starting' with an empty
  // log rather than as an error. Checking the argv costs nothing.
  console.log('\nthe resume flags:');
  const { buildArgs } = require('../ccbb-mux');
  const at = (a, flag) => a[a.indexOf(flag) + 1];
  const plain = buildArgs({ sessionId: 'SID' });
  check('a fresh session is launched under the id the mux picked',
    plain.includes('--session-id') && at(plain, '--session-id') === 'SID');
  const res = buildArgs({ sessionId: 'SID', resume: 'OLD' });
  check('resuming in place passes --resume', res.includes('--resume=OLD'));
  check('resuming in place passes no --session-id, which Claude Code refuses there',
    !res.includes('--session-id'), res.join(' '));
  check('resuming in place does not fork', !res.includes('--fork-session'));
  const fork = buildArgs({ sessionId: 'NEW', resume: 'OLD', fork: true });
  check('a fork passes --fork-session', fork.includes('--fork-session'));
  check('a fork does carry --session-id, being a genuinely new session',
    fork.includes('--session-id') && at(fork, '--session-id') === 'NEW');

  // And the id the mux files the session under has to agree with that argv: resumed in
  // place the child writes on into the ORIGINAL transcript, so a fresh id would leave
  // the mux's row, ccbb web's disk row and the file on disk naming three different
  // things — and mergeMuxRows dedupes on exactly that id. Run against the fixture
  // binary, so no real child and no API call.
  const { Mux } = require('../ccbb-mux');
  const probe = new Mux({});
  const fake = { cwd: '/tmp', bin: path.join(__dirname, 'fake-claude.js') };
  const rs = probe.create(Object.assign({ resume: RESUMED_ID }, fake));
  made.push(rs.id);
  check('a session resumed in place is filed under the resumed id', rs.id === RESUMED_ID, rs.id);
  const fs2 = probe.create(Object.assign({ resume: RESUMED_ID, fork: true }, fake));
  made.push(fs2.id);
  check('a forked session is filed under a new id', fs2.id !== RESUMED_ID);
  check('the mux refuses to resume a session it is already running',
    (function(){ try { probe.create(Object.assign({ resume: rs.id }, fake)); return 'allowed'; }
      catch (e) { return e.code === 'EBUSY' ? true : 'wrong error: ' + e.message; } })() === true);
  rs.stop(); fs2.stop();

  // ── names ─────────────────────────────────────────────────────────────────
  // A name is an ADDRESS: `ccbb attach api-work` has to reach one session or none,
  // never "one of these two". Everything here is about that being true — uniqueness
  // when the name is minted, and resolution that refuses rather than guesses.
  console.log('\nnames (how `ccbb attach <name>` finds a session):');
  const { pickSession } = require('../ccbb-mux');
  const nx = new Mux({});
  const mk = o => { const s = nx.create(Object.assign({}, fake, o)); made.push(s.id); return s; };
  const a1 = mk({});
  const a2 = mk({});
  check('a session is named after its directory', a1.label === 'tmp', a1.label);
  check('a second session in that directory takes a suffix', a2.label === 'tmp-2', a2.label);
  // The suffix must not ratchet. Exited sessions stay in the map so their transcript
  // stays browsable, and counting those would walk the name up by one every time you
  // restarted in the same directory, forever, with nothing running.
  a1.state.status = 'exited';
  const a3 = mk({});
  check('a name is reclaimed once its holder has exited', a3.label === 'tmp', a3.label);

  const named = mk({ label: 'alpha' });
  const longer = mk({ label: 'alphabet' });
  check('a session resolves by its exact name', nx.get('alpha') === named);
  check('and by its full id', nx.get(named.id) === named);
  check('and by the short id `ccbb ls` prints', nx.get(named.id.slice(0, 8)) === named);
  // No name-PREFIX matching. An id prefix is unambiguous by construction; a name
  // prefix is not, and `ccbb stop alph` hitting one of these at random is a footgun
  // with no undo.
  check('a name prefix resolves to nothing rather than to a guess',
    nx.get('alph') === null, String(nx.get('alph') && nx.get('alph').label));
  check('the longer name is still reachable by its own name', nx.get('alphabet') === longer);
  check('a name nobody has resolves to nothing', nx.get('nope') === null);

  // The CLI's half, over the JSON list rather than the live map — same rules, and the
  // bare `ccbb attach` form on top of them.
  const rows = nx.list();
  check('the CLI resolver agrees with the mux on a name',
    pickSession(rows, 'alpha').id === named.id);
  check('the CLI resolver refuses a name prefix too', !!pickSession(rows, 'alph').error);
  check('bare attach refuses while several sessions are running',
    /several/.test(pickSession(rows, null).error || ''));
  const one = [{ id: 'x', label: 'only', status: 'idle' }, { id: 'y', label: 'old', status: 'exited' }];
  check('bare attach ignores exited sessions when counting',
    pickSession(one, null).id === 'x');
  check('bare attach says so when nothing is running',
    /no sessions running/.test(pickSession([one[1]], null).error || ''));

  // An exited session keeps its name when nothing live claims it — its transcript is
  // still worth reaching, which is the whole reason it stays in the map. That means
  // `ccbb attach <name>` can land on a dead session, so the TUI has to SAY it is dead
  // rather than sit there rendering a transcript nothing will ever add to.
  named.state.status = 'exited';
  check('an exited session is still reachable by its name', nx.get('alpha') === named);
  const revived = mk({ label: 'alpha' });
  check('the name is free again for a live session, which then wins',
    revived.label === 'alpha' && nx.get('alpha') === revived);
  check('the CLI resolver keeps the exited fallback too',
    pickSession([{ id: 'z', label: 'gone', status: 'exited' }], 'gone').id === 'z');
  revived.stop(true);
  for (const s of [a1, a2, a3, named, longer]) s.stop(true);

  // ── local slash commands ───────────────────────────────────────────────────
  // The wire shapes here were captured from a live child, not read off a transcript
  // file — the two do NOT agree, and building against the file shape would have
  // produced a renderer nothing ever reaches. /cost and /compact below are verbatim.
  console.log('\nlocal slash commands (/cost, /compact — never reach the API):');
  const { parseCommand } = require('../ccbb-mux');
  check('a stdout envelope parses as command output',
    JSON.stringify(parseCommand('<local-command-stdout>hi</local-command-stdout>')) ===
    JSON.stringify({ kind: 'out', stream: 'stdout', text: 'hi' }));
  check('a stderr envelope carries the stream that says it failed',
    (parseCommand('<local-command-stderr>Error: No messages to compact</local-command-stderr>') || {}).stream === 'stderr');
  check('a <command-name> block parses as the invocation',
    JSON.stringify(parseCommand('<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>fable</command-args>')) ===
    JSON.stringify({ kind: 'run', name: 'model', args: 'fable' }));
  check('ordinary prose is not a command', parseCommand('just some text </b>') === null);

  const cs = probe.create(Object.assign({ label: 'cmds' }, fake));
  made.push(cs.id);
  cs.submit('/cost', null, 'tester');
  // Verbatim from the probe: a synthetic assistant message, is_meta, the output already
  // unwrapped in content, the envelope kept in local_command_source.
  cs.onMessage({ type: 'assistant', is_meta: true, local_command_source:
      '<local-command-stdout>You are currently using your subscription</local-command-stdout>',
    message: { model: '<synthetic>', role: 'assistant',
      content: [{ type: 'text', text: 'You are currently using your subscription' }] } });
  const cm = cs.messages[cs.messages.length - 1];
  check('a synthetic command result is tagged as command output',
    !!(cm && cm.command && cm.command.kind === 'out'), JSON.stringify(cm && cm.command));
  // One card, not two: the answer folds into the invocation the mux drew when the
  // command was submitted, so what is left is that card — a command entry — and not a
  // synthetic assistant turn sitting under an invocation still saying "running".
  check('and it is not left looking like ordinary assistant prose',
    cm.role === 'user' && cm.isSynthetic === true && cm.command.kind === 'out');
  check('the answer folded into the invocation instead of making a second card',
    cs.messages.filter(x => x.command).length === 1,
    String(cs.messages.filter(x => x.command).length));
  check('the command name is recovered from what was submitted',
    cm.command.name === 'cost', String(cm.command.name));
  check('and so is who ran it', cm.by === 'tester', String(cm.by));
  // The attribution FIFO is the trap: a slash command gets no replay, so its entry
  // would sit at the head forever and be handed to the next turn somebody typed.
  check('the command released its attribution slot', cs.attribution.length === 0,
    JSON.stringify(cs.attribution));
  cs.submit('what is 2+2?', null, 'tester');
  cs.onMessage({ type: 'user', isReplay: true,
    message: { role: 'user', content: 'what is 2+2?' } });
  check('the turn after a slash command is still attributed correctly',
    cs.messages[cs.messages.length - 1].by === 'tester');

  // The other carrier: a successful /compact replays a USER message whose whole text
  // is the envelope. Rendered as a turn it read as a person saying raw markup.
  cs.submit('/compact', null, 'tester');
  cs.onMessage({ type: 'user', isReplay: true, message: { role: 'user',
    content: '<local-command-stdout>Compacted (ctrl+o to see full summary)</local-command-stdout>' } });
  const cm2 = cs.messages[cs.messages.length - 1];
  check('a replayed command envelope is command output, not a user turn',
    !!(cm2.command && cm2.command.kind === 'out'), JSON.stringify(cm2.command));
  check('its text is unwrapped', cm2.command.text === 'Compacted (ctrl+o to see full summary)',
    String(cm2.command.text));

  // What a client can show while a tool RUNS. There is no stdout on the wire; these
  // two events are the whole of it.
  const runs = [];
  cs.clients.add({ send: e => { if (e.op === 'event' && e.kind === 'tool_run') runs.push(e); } });
  cs.onMessage({ type: 'system', subtype: 'task_started', tool_use_id: 'toolu_1',
    task_id: 't1', description: 'Echo six lines', task_type: 'local_bash', is_backgrounded: false });
  cs.onMessage({ type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_1',
    task_id: 't1', status: 'completed', summary: 'Echo six lines' });
  check('task_started reaches clients as a tool_run event',
    runs.length === 2 && runs[0].phase === 'started' && runs[0].toolUseId === 'toolu_1',
    JSON.stringify(runs));
  check('and it carries the description the child gave it',
    runs[0].description === 'Echo six lines');
  check('task_notification closes it', runs[1].phase === 'finished');
  cs.stop(true);

  // ── the full walk, with the browser attached the whole time ──────────────
  let f = await startFixture();
  drive(f.sid, 'full');
  await sleep(13000);
  const html = await dom(f.page);
  if (KEEP) fs.writeFileSync(path.join(__dirname, 'verify-dom.html'), html);
  const has = s => html.includes(s);
  const count = s => html.split(s).length - 1;

  console.log('\ntranscript (browser attached before the first turn):');
  check('a streamed turn renders exactly once', count('so it is not prime') === 1,
    'saw ' + count('so it is not prime'));
  check('Read rolls up to its line count', has('Read 2 lines'));
  check('Edit renders a two-sided diff', has('class="del"') && has('class="add"') && has('there'));
  // A collapsed card keeps its children in the DOM, so every has() check above would
  // pass on content nobody can see. These measure instead — and they measure the
  // requirement in both directions: a card is SHUT until somebody opens it, and what
  // was in it is really there when they do. Asserting only the second half is how a
  // renderer that silently stopped collapsing would go unnoticed.
  const rects = sel => f.page.evaluate(
    'var n=document.querySelector(' + JSON.stringify(sel) + '); !!(n && n.getClientRects().length)');
  check('a tool body is hidden until the card is opened',
    (await rects('.diff .del')) === false && (await rects('.todos li')) === false);
  await f.page.evaluate(
    '[].slice.call(document.querySelectorAll(".tool-card")).forEach(function(c){' +
    'if (c.querySelector(".diff .del") || c.querySelector(".todos li")) c.querySelector(".tool-hdr").click();})');
  await sleep(150);
  check('and the diff is really there when it is', (await rects('.diff .del')) === true);
  check('as is a settled tool\'s body', (await rects('.todos li')) === true);
  // Shut again, and not merely for tidiness: which cards are open is remembered per
  // tool id across repaints, so leaving these two open would hand the collapse check
  // further down two cards this section opened by hand.
  await f.page.evaluate(
    '[].slice.call(document.querySelectorAll(".tool-card .tool-body.open")).forEach(function(b){' +
    'b.previousElementSibling.click();})');
  await sleep(150);
  check('a diff line carries its line number', /class="ln">\s*\d+\s*</.test(html));
  check('the answered question round-tripped labels', has('Red') && has('Fries, Soup'));
  check('TodoWrite draws a checklist off the tool input', has('☒') && has('→') && has('☐'));
  check('TodoWrite shows activeForm for the running item', has('Porting the registry'));
  check('Bash shows its description, not its name alone', has('Count lines'));
  check('Grep header carries path and glob', has('in src, glob: *.js'));
  check('an MCP tool name is prettified with its server', has('Chrome [navigate]'));
  check('an MCP url is reduced to a hostname', has('example.com'));
  check('a subagent turn is nested rather than dropped', has('msg nested'));
  // ccbb's pill carries the state now — a word on a coloured ground, not a tinted
  // border on the card, which said nothing to a reader who cannot separate the hues.
  check('a failed tool is marked with ccbb\'s error pill', has('tool-status error'));
  check('a backgrounded agent shows its prompt', has('Count the .txt files'));
  check('the task-notification collapses to one line',
    has('Agent "Count txt files" finished') || has('Agent &quot;Count txt files&quot; finished'));
  check('elapsed time is truncated, not rounded', has('18s'));
  check('the raw task-notification envelope never reaches the page', !has('&lt;task-notification&gt;'));

  console.log('\nfailure signatures:');
  for (const bad of ['undefined', 'NaN', '[object Object]'])
    check('no ' + bad + ' in the rendered page', !html.includes('>' + bad) && !html.includes(bad + '<'));

  console.log('\nconsole:');
  const errs = await f.page.evaluate('JSON.stringify(window.ccbb.errors)');
  check('the page raised no uncaught errors', errs === '[]', errs);

  // ── reconnect: the sinceSeq path the plan flags as implemented-but-untested ──
  console.log('\nreconnect (socket dropped, turns missed, client resumes):');
  const before = await f.page.evaluate('document.querySelectorAll(".msg").length');
  const seqBefore = await f.page.evaluate('window.ccbb.seq()');
  // Read liveness in the SAME evaluation as the drop: the client's first
  // reconnect attempt is 250ms away, so a separate round trip races it and would
  // be asserting on the reconnect rather than on the disconnect.
  const dead = await f.page.evaluate('window.ccbb.drop(), window.ccbb.live()');
  check('the client notices the socket is gone', dead === false);
  drive(f.sid, 'one');                                  // one more turn while it is away
  await sleep(6000);
  const live = await until(async () => await f.page.evaluate('window.ccbb.live()'), 40, 250);
  check('the client reconnects on its own', live === true);
  const after = await f.page.evaluate('document.querySelectorAll(".msg").length');
  const seqAfter = await f.page.evaluate('window.ccbb.seq()');
  check('the missed turn arrives after reconnect', after > before, `${before} → ${after}`);
  check('the event sequence advanced', seqAfter > seqBefore, `${seqBefore} → ${seqAfter}`);
  const html2 = await dom(f.page);
  check('the turn missed while away is rendered exactly once',
    html2.split('reconnect check').length - 1 === 1,
    'saw ' + (html2.split('reconnect check').length - 1));
  check('replayed events did not duplicate the earlier streamed turn',
    html2.split('so it is not prime').length - 1 === 1,
    'saw ' + (html2.split('so it is not prime').length - 1));

  // ── the composer, the cards and the commands, in the browser ──────────────
  // None of this is reachable over the socket, which is how it stayed unchecked
  // while the protocol was covered twice over: the composer's keys, whether a tool
  // card opens or stays shut, and what a command's output looks like are DOM facts.
  console.log('\ntool cards (collapsed, with an arrow and a state):');
  const cards = await f.page.evaluate(
    'JSON.stringify([].slice.call(document.querySelectorAll(".tool-card")).map(function(d){' +
    'return {open:!!d.querySelector(".tool-body.open"), tw:!!d.querySelector(".tool-hdr .tool-toggle"),' +
    ' st:(d.querySelector(".tool-hdr .tool-status")||{}).textContent||"",' +
    ' pill:(function(){var p=d.querySelector(".tool-status");' +
    '  return p ? getComputedStyle(p).backgroundColor : "none";})()};}))');
  const cardList = JSON.parse(cards || '[]');
  check('the walk produced tool cards', cardList.length > 0, String(cardList.length));
  check('every tool card is collapsed by default',
    cardList.every(c => !c.open), JSON.stringify(cardList.filter(c => c.open)));
  check('every one shows a disclosure arrow', cardList.every(c => c.tw));
  check('and a state word, not just a border tint',
    cardList.every(c => /^(running|done|error)/.test(c.st)), JSON.stringify(cardList.map(c => c.st)));
  check('a finished tool reads "done"', cardList.some(c => /^done/.test(c.st)));
  // Opening one must survive the next repaint — a card rebuilt when its result lands
  // would otherwise snap shut at the moment it finally had something to show.
  // The pill is ccbb's, not a bare word in the mux's own style: a transparent
  // background means the class matched nothing and the card is unstyled.
  check('the state is ccbb\'s pill, not a bare word',
    cardList.every(c => c.pill && c.pill !== 'none' && c.pill !== 'rgba(0, 0, 0, 0)'),
    JSON.stringify(cardList.map(c => c.pill).slice(0, 3)));
  await f.page.evaluate('document.querySelector(".tool-card .tool-hdr").click()');
  await sleep(150);
  await f.page.evaluate('window.ccbb.state().msgs.forEach(function(m){m._rev=-1;});' +
    'document.querySelector(".mx-log") && window.dispatchEvent(new Event("resize"))');
  check('a card the reader opened stays open',
    await f.page.evaluate('!!document.querySelector(".tool-card .tool-body.open")'));

  console.log('\nthe composer:');
  const before2 = await f.page.evaluate('document.querySelectorAll(".msg").length');
  // Enter must NOT send. A synthetic keydown cannot type a newline, so what is
  // asserted is the half that matters: nothing left the page.
  await f.page.evaluate('(function(){var i=document.querySelector(".input-box");' +
    'i.value="typed but not sent";' +
    'i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}));})()');
  await sleep(400);
  check('Enter does not send', (await f.page.evaluate('document.querySelector(".input-box").value')) ===
    'typed but not sent');
  check('and nothing reached the session',
    (await f.page.evaluate('document.querySelectorAll(".msg").length')) === before2);
  // The expand button, before the send clears it.
  // Asserting the CLASS is what let this ship broken: input-max was set, the log did
  // hide, and the editable stayed 40px tall at the bottom of an empty panel. So the
  // check is on the pixels — the box must actually grow into the space the log left.
  const boxH = () => f.page.evaluate('document.querySelector(".input-box").getBoundingClientRect().height');
  const small = await boxH();
  await f.page.evaluate('document.querySelector(".exp-btn").click()');
  await sleep(200);
  const big = await boxH();
  check('the max button expands the composer',
    await f.page.evaluate('!!document.querySelector(".muxv.input-max, .input-max")'));
  check('and the editable actually fills the space', big > small * 3,
    'was ' + small + 'px, became ' + big + 'px');
  await f.page.evaluate('document.querySelector(".exp-btn").click()');
  await sleep(200);
  check('and collapses it again',
    !(await f.page.evaluate('!!document.querySelector(".input-max")')) && (await boxH()) < big / 2);

  await f.page.evaluate('(function(){var i=document.querySelector(".input-box");' +
    'i.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,bubbles:true}));})()');
  const sent = await until(async () => await f.page.evaluate(
    'document.body.innerHTML.indexOf("typed but not sent") >= 0 ? "y" : ""'), 40, 250);
  check('Ctrl+Enter sends', sent === 'y');
  check('and the box is cleared',
    (await f.page.evaluate('document.querySelector(".input-box").value')) === '');
  // History: the transcript IS the history, so the first ▲ reaches the turn just sent.
  await f.page.evaluate('document.querySelector(\'.hist-btn[data-h="prev"]\').click()');
  check('the history button recalls the last prompt',
    (await f.page.evaluate('document.querySelector(".input-box").value')) === 'typed but not sent',
    await f.page.evaluate('document.querySelector(".input-box").value'));
  // With a REAL mouse, not a scripted .click(). The tools row is revealed by
  // :focus-within and every other press in this file is synthetic, so this is the only
  // check that exercises the path a person actually takes — the button being reachable
  // at all, once the row has had to appear on its own.
  await f.page.evaluate('document.querySelector(".input-box").focus()');
  const btnAt = JSON.parse(await f.page.evaluate(
    '(function(){var r=document.querySelector(\'.hist-btn[data-h="prev"]\').getBoundingClientRect();' +
    'return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});})()'));
  for (const type of ['mousePressed', 'mouseReleased'])
    await f.page.send('Input.dispatchMouseEvent',
      { type, x: btnAt.x, y: btnAt.y, button: "left", clickCount: 1 });
  await sleep(200);
  check('the history button works under a real mouse, not just a scripted click',
    (await f.page.evaluate('document.querySelector(".input-box").value')) === 'typed but not sent',
    JSON.stringify(await f.page.evaluate('document.querySelector(".input-box").value')));
  await f.page.evaluate('document.querySelector(".input-box").value=""');
  const sendable = await f.page.evaluate('!!document.querySelector(".send-btn")');
  check('there is a send button', sendable);
  // And it is ccbb's, painted by ccbb's rule. Matching the CLASS is not enough: a
  // bare `.muxv button` in this file outranked .send-btn on specificity and repainted
  // the clay button the same grey as everything else, with every selector still
  // matching. So the assertion is against the token, resolved on this page.
  const sendPaint = await f.page.evaluate(
    '(function(){var p=document.createElement("div");p.style.background="var(--accent)";' +
    'document.body.appendChild(p);var want=getComputedStyle(p).backgroundColor;p.remove();' +
    'return want + "|" + getComputedStyle(document.querySelector(".send-btn")).backgroundColor;})()');
  check('and it is painted with ccbb\'s accent, not overridden by a mux rule',
    sendPaint.split("|")[0] === sendPaint.split("|")[1], sendPaint);

  console.log('\nslash commands (/) and ccbb commands (//):');
  await f.page.evaluate('(function(){var i=document.querySelector(".input-box");' +
    'i.value="/status";document.querySelector(".send-btn").click();})()');
  const okCard = await until(async () => await f.page.evaluate(
    'var d=[].slice.call(document.querySelectorAll(".tool-card")).filter(function(x){' +
    'return (x.querySelector(".tool-name")||{}).textContent==="/status";})[0];' +
    'd ? JSON.stringify({open:!!d.querySelector(".tool-body.open"), st:(d.querySelector(".tool-status")||{}).textContent,' +
    ' tw:!!d.querySelector(".tool-toggle"), body:(d.querySelector(".tool-body")||{}).textContent||""}) : ""'), 60, 250);
  check('a slash command renders as a command card, not a speech bubble', !!okCard, String(okCard));
  const okc = JSON.parse(okCard || '{}');
  check('it is collapsed by default with an arrow', okc.open === false && okc.tw === true);
  check('a command that succeeded reads ok', okc.st === 'ok', String(okc.st));
  check('and its output is unwrapped, with no markup left in it',
    okc.body.indexOf('local-command') === -1 && okc.body.indexOf('ran /status') >= 0, okc.body);

  await f.page.evaluate('(function(){var i=document.querySelector(".input-box");' +
    'i.value="/compact";document.querySelector(".send-btn").click();})()');
  const errSt = await until(async () => await f.page.evaluate(
    'var d=[].slice.call(document.querySelectorAll(".tool-card")).filter(function(x){' +
    'return (x.querySelector(".tool-name")||{}).textContent==="/compact";})[0];' +
    'd ? (d.querySelector(".tool-status")||{}).textContent : ""'), 60, 250);
  check('a command that failed reads error — the stream is the only thing that says so',
    errSt === 'error', String(errSt));

  await f.page.evaluate('(function(){var i=document.querySelector(".input-box");' +
    'i.value="//pwd";document.querySelector(".send-btn").click();})()');
  const local = await until(async () => await f.page.evaluate(
    '(function(){var d=[].slice.call(document.querySelectorAll(".tool-card")).filter(function(x){' +
    'return ((x.querySelector(".tool-name")||{}).textContent||"").indexOf("//pwd")===0;})[0];' +
    'if(!d) return ""; var st=(d.querySelector(".tool-status")||{}).textContent;' +
    'return st==="running" ? "" : JSON.stringify({st:st,' +
    ' body:(d.querySelector(".tool-body")||{}).textContent||""});})()'), 60, 250);
  check('// reaches ccbb rather than the child', !!local, String(local));
  const loc = JSON.parse(local || '{}');
  check('and its answer lands in the same card shape', loc.st === 'ok', String(loc.st));
  check('//pwd answered with a path', /^\//.test((loc.body || '').trim()), String(loc.body));

  console.log('\nthe status line at the foot:');
  const foot = await f.page.evaluate('(document.querySelector(".sv-foot .sl")||{}).innerHTML||""');
  check('the footer leads with the money', /^<b>\$\d/.test(foot), foot.slice(0, 80));
  check('and carries context as current/peak', foot.indexOf('sl-ctx') >= 0, foot.slice(0, 200));

  // ── an open permission card ──────────────────────────────────────────────
  f.page.close(); kill();
  f = await startFixture();
  drive(f.sid, 'hold');
  await sleep(6000);
  const held = await dom(f.page);
  console.log('\nopen permission card (left unanswered by the driver):');
  const h = s => held.includes(s);
  check('the card names the tool and its target', h('Allow Edit') && h('a.txt'));
  check('the card shows the diff it is guarding', h('class="diff"'));
  check('Yes / dont-ask-again / No are all offered',
    h('>Yes<') && h('>No<') && /don(&#039;|')t ask again/.test(held));
  check('the card is not also drawn in the transcript', held.split('Allow Edit').length - 1 === 1);

  // A card opened before this client existed must still be answerable — that is
  // the whole point of the mux's pending list, and it only works if a snapshot
  // paints cards as well as messages.
  const late = await startLateJoiner(f.sid);
  check('a client attaching mid-card renders it from the snapshot', late.includes('Allow Edit'));

  // ── the plan card ────────────────────────────────────────────────────────
  f.page.close(); kill();
  f = await startFixture();
  drive(f.sid, 'plan');
  await sleep(11000);
  const plan = await dom(f.page);
  console.log('\nplan-mode card:');
  check('plan mode offers auto-accept rather than a bare Yes', plan.includes('Yes, and auto-accept'));
  check('plan mode offers "No, keep planning"', plan.includes('No, keep planning'));
  check('the plan body renders in the card', plan.includes('Port the webview renderer'));
  check('the plan renders as markdown, not raw hashes',
    plan.includes('<h4>') && !plan.includes('## Port the webview'));
  check('markdown inline code became <code>', plan.includes('<code>nZ()</code>'));

  f.page.close(); kill();

  // ── the token path ───────────────────────────────────────────────────────
  // ccbb's own config sets peerToken on this machine, so ccbb web gates
  // EVERY route behind it — the page included, and behind the 401 that fires
  // before the UI delegation is ever reached. A suite that only ever ran
  // token-less would be green on a build nobody can open.
  console.log('\ntoken (ccbb web gates the mux in real use):');
  f = await startFixture();
  if (TOKEN) {
    // ?token= on a page is answered with the cookie hand-off, not the page, so the
    // 200 is checked with the header instead — the redirect IS the success here.
    const bare = await fetch(`http://127.0.0.1:${PORT}/mux/s/${f.sid}`, { redirect: 'manual' });
    check('the page 401s without a token', bare.status === 401, 'got ' + bare.status);
    const withTok = await fetch(`http://127.0.0.1:${PORT}/mux/s/${f.sid}`,
      { headers: { 'x-ccbb-token': TOKEN } });
    check('the page is served with a token', withTok.status === 200, 'got ' + withTok.status);
    const index = await (await fetch(`http://127.0.0.1:${PORT}/mux/`,
      { headers: { 'x-ccbb-token': TOKEN } })).text();
    check('the index lists the session', index.includes(f.sid));
  } else {
    check('no peerToken configured — the gate cannot be exercised here', true, 'skipped');
  }
  const attached = await until(async () => await f.page.evaluate('window.ccbb.live()'), 40, 250);
  check('the socket attaches from the page URL', attached === true);
  drive(f.sid, 'one');
  await sleep(4000);
  const tokDom = await dom(f.page);
  // A fresh fixture starts at scene 1, so this is that scene's turn, not the
  // numbered extra one the reconnect section drives.
  check('a turn renders over the token-gated socket',
    tokDom.includes('is 289 prime?') && tokDom.includes('not prime'));

  // ── the terminal client still attaches to the same mux ───────────────────
  // ccbb-mux.js was edited to mount the UI. The terminal client's own fixtures
  // were lost, so this is the only remaining evidence that the edit did not
  // disturb it — and it doubles as the two-renderers-on-one-session claim.
  console.log('\nthe terminal client, on the same session:');
  f.page.close(); kill();
  f = await startFixture();
  drive(f.sid, 'one');
  await sleep(3000);
  // A slash command, so the pane shows what the TUI does with one. Sent over the
  // protocol rather than typed into the pane: what is under test is the RENDERING,
  // and driving it through the keyboard would make a stuck key look like a bad
  // renderer.
  await new Promise(res => {
    const q = new URLSearchParams({ session: f.sid, label: 'cmd', kind: 'test' });
    if (TOKEN) q.set('token', TOKEN);
    const w = new WebSocket(`ws://127.0.0.1:${PORT}/mux/mux?${q}`);
    w.on('open', () => { w.send(JSON.stringify({ op: 'submit', text: '/status' })); setTimeout(() => { w.close(); res(); }, 1200); });
    w.on('error', () => res());
  });
  await sleep(800);
  const pane = 'ccbbmuxweb';
  spawnSync('tmux', ['kill-session', '-t', pane]);
  spawnSync('tmux', ['new-session', '-d', '-s', pane, '-x', '100', '-y', '60',
    '-c', path.join(__dirname, '..'),
    `node -e "require('./ccbb-mux-tui').runAttach(['${f.sid}','--label','tui','--url','ws://127.0.0.1:${PORT}/mux/mux'])" ; sleep 60`]);
  await sleep(4000);
  const paneText = spawnSync('tmux', ['capture-pane', '-t', pane, '-p', '-S', '-200'],
    { encoding: 'utf8' }).stdout || '';
  spawnSync('tmux', ['kill-session', '-t', pane]);
  check('the TUI attaches to the same mux and renders the transcript',
    /reconnect check|289|not prime/.test(paneText),
    JSON.stringify(paneText.replace(/\n+/g, ' ').slice(0, 160)));
  // The bug this fixes, in the shape the user reported it: the envelope rendered as
  // a person's turn — "❯ <local-command-stdout>Compacted </local-command-stdout>".
  check('a slash command shows the command, not raw markup',
    paneText.indexOf('/status') >= 0 && paneText.indexOf('local-command') === -1,
    JSON.stringify((/.{0,60}local-command.{0,60}/.exec(paneText) || ['no markup'])[0]));
  check('and its output is printed under it',
    paneText.indexOf('ran /status') >= 0);
  // The configured status line, if this machine has one. Skipped rather than faked
  // where it does not: a check that passes by not looking is worse than no check.
  const slCfg = (function () {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(common.CLAUDE_DIR, 'settings.json'), 'utf8'));
      return j.statusLine && j.statusLine.type === 'command' ? j.statusLine : null;
    } catch { return null; }
  })();
  if (!slCfg) console.log('  SKIP     no statusLine configured on this machine');
  else {
    const own = spawnSync('sh', ['-c', slCfg.command], { encoding: 'utf8',
      input: JSON.stringify({ cwd: process.cwd(), session_id: f.sid, transcript_path: '',
        model: { id: 'claude-opus-5', display_name: 'Opus 5' }, cost: { total_cost_usd: 0 } }) });
    // The script's own first word — whatever it chose to lead with — has to be on the
    // footer row. Comparing the whole line would compare against a moving cost.
    const word = String(own.stdout || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim().split(/\s+/)[0];
    check('the configured status line runs and reaches the footer',
      !!word && paneText.indexOf(word) >= 0, 'looked for ' + JSON.stringify(word));
  }

  f.page.close(); kill();
  seedHistoryChecks();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks pass');
  process.exit(failed ? 1 : 0);
}

// ── history for a resumed session ────────────────────────────────────────────
// --resume replays NOTHING in print/stream-json: the child loads the transcript
// into its own context and emits only new turns, so a resumed session used to open
// as a blank page beside a long history. seedHistory() reads the file instead.
//
// Driven against Session.prototype directly rather than through a live mux: a real
// resume would need a real transcript in ~/.claude/projects and would leave a raw
// log behind, and what is under test here is the reader, not the spawn.
function seedHistoryChecks() {
  console.log('\nhistory for a resumed session:');
  const { Session } = require('../ccbb-mux');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-hist-'));
  const file = path.join(dir, 'h.jsonl');
  const line = o => JSON.stringify(o);
  fs.writeFileSync(file, [
    line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'first thing I asked' } }),
    line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'the answer' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a.txt' } }] } }),
    line({ type: 'user', uuid: 'u2', toolUseResult: { file: { numLines: 3 } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'aaa' }] } }),
    // Everything below must be skipped.
    line({ type: 'attachment', uuid: 'x1', attachment: {} }),
    line({ type: 'assistant', uuid: 'x2', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'SUBAGENT' }] } }),
    line({ type: 'user', uuid: 'x3', isCompactSummary: true, message: { role: 'user', content: 'WALL OF SUMMARY' } }),
    line({ type: 'file-history-snapshot', uuid: 'x4' }),
  ].join('\n') + '\n');

  const orig = common.findSessionJsonl;
  common.findSessionJsonl = () => file;
  const sess = {
    messages: [], byToolUseId: new Map(), attribution: [], state: {}, seq: 0, events: [],
    clients: new Set(), _seeding: false, historyCount: 0,
    flushDelta() {},
    emit: Session.prototype.emit,
    onModelMessage: Session.prototype.onModelMessage,
    seedHistory: Session.prototype.seedHistory,
  };
  try { sess.seedHistory('some-id'); } finally { common.findSessionJsonl = orig; }

  const texts = sess.messages.map(m => (m.blocks || [])
    .filter(b => b.type === 'text').map(b => b.text).join(' ')).join(' | ');
  check('a resumed session gets its transcript back', sess.messages.length === 2,
    sess.messages.length + ' messages: ' + texts);
  check('the turns are the ones on disk',
    texts.indexOf('first thing I asked') >= 0 && texts.indexOf('the answer') >= 0, texts);
  check('a tool_result on disk folds into its call, toolUseResult and all', (() => {
    const blk = sess.messages[1] && sess.messages[1].blocks.filter(b => b.type === 'tool_use')[0];
    return !!blk && blk.status === 'done' && !!blk.resultMeta;
  })());
  check('a compact summary is not replayed as a turn', texts.indexOf('WALL OF SUMMARY') === -1);
  check('nor is a subagent thread', texts.indexOf('SUBAGENT') === -1);
  check('every seeded turn is marked history, so a client can dim it',
    sess.messages.every(m => m.hist === true));
  // The load-bearing one: seeding must not enter the wire. A seq bumped here means
  // the first client's sinceSeq is already past turns it never received.
  check('seeding emitted nothing on the wire', sess.seq === 0 && sess.events.length === 0,
    'seq ' + sess.seq + ', ' + sess.events.length + ' events');
  check('and left the attribution FIFO alone', sess.attribution.length === 0);

  // And the wiring, which everything above would pass without: a REAL session,
  // created the way a resume creates one. Deleting the seedHistory() call from the
  // constructor failed nothing until this existed — the checks above drove the
  // reader directly, which is the shape of green suite that tests a path nobody
  // takes. fake-claude stands in for the child; what is asserted is that the
  // transcript was already in this.messages before it said anything.
  const { Mux } = require('../ccbb-mux');
  common.findSessionJsonl = () => file;
  let live = null;
  try {
    const wired = new Mux({});
    live = wired.create({ bin: path.join(__dirname, 'fake-claude.js'), cwd: '/tmp',
      resume: 'some-id', label: 'resumed' });
    made.push(live.id);
  } catch (e) {} finally { common.findSessionJsonl = orig; }
  check('creating a session with --resume seeds it',
    !!live && live.messages.length === 2 && live.historyCount === 2,
    live ? live.messages.length + ' messages' : 'no session');
  check('and its first snapshot carries them, which is all a client ever gets',
    !!live && live.snapshot().messages.length === 2 && live.snapshot().seq === 0);
  if (live) try { live.stop(false); } catch (e) {}
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

async function startLateJoiner(sid) {
  const url = `http://127.0.0.1:${PORT}/mux/s/${sid}`;
  const tgt = await (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
  const p = cdpConnect(tgt.webSocketDebuggerUrl);
  await p.ready;
  await p.send('Runtime.enable');
  await sleep(2500);
  const out = await dom(p);
  p.close();
  return out;
}

main().catch(e => { console.error(e); kill(); process.exit(1); });
