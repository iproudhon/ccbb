#!/usr/bin/env node
'use strict';
// Integration check for the hook into `ccbb web`'s session list.
//
// What this proves, and the plain HTTP checks cannot: a mux session is reachable
// entirely through ccbb web's own port — page AND socket — so anything that
// already reaches ccbb (a phone, an ssh forward) reaches the mux with no second
// route, port or token. The browser here is pointed at the ccbb web port only; it
// never learns the mux exists.
//
//   node test/verify-web.js
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const common = require('../ccbb-common');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WEB_PORT = 8599, CDP = 9335;
const TOKEN = common.peerToken ? common.peerToken() : '';
const MUX_DIR = path.join(common.CLAUDE_DIR, 'ccbb-mux');
const ADDR = path.join(MUX_DIR, 'address');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';

let failed = 0, kids = [], made = [], tempFiles = [], savedAddr = null;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}     ${name}`);
  if (!ok) { failed++; if (detail) console.log('           ' + detail); }
}
function kill() {
  for (const k of kids) { try { process.kill(-k.pid); } catch {} try { k.kill('SIGKILL'); } catch {} }
  kids = [];
}
// The fixture writes into the same directory a real mux uses: its address file,
// which is restored, and one raw log per session, which is removed. A test that
// leaves debris in ~/.claude is a test people stop running.
function cleanup() {
  for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
  try { fs.rmdirSync(path.join(common.CLAUDE_DIR, 'projects', '-tmp-ccbb-verify')); } catch {}
  tempFiles = [];
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

async function muxClientCount(sid) {
  try {
    const r = await fetch('http://127.0.0.1:' + WEB_PORT + '/mux/api/sessions',
      TOKEN ? { headers: { 'x-ccbb-token': TOKEN } } : undefined);
    const j = await r.json();
    const s = (j.sessions || []).find(x => x.id === sid);
    return s ? s.clients : -1;
  } catch { return -1; }
}
// One more fixture session in the running mux. Goes through the shipping API — the
// same route `ccbb new` posts to — so the fixtures cannot drift from the path.
async function newFixtureSession(label) {
  const r = await fetch('http://127.0.0.1:' + WEB_PORT + '/mux/api/sessions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
      TOKEN ? { 'x-ccbb-token': TOKEN } : {}),
    body: JSON.stringify({ bin: path.join(__dirname, 'fake-claude.js'), cwd: '/tmp', label }),
  });
  const id = ((await r.json()).session || {}).id;
  if (!id) throw new Error('could not create fixture session ' + label);
  made.push(id);
  return id;
}

// The session's own status, not how many sockets it has. Auto-stop is a claim about
// the CHILD, and client count cannot see it: a stopped session keeps its attached
// clients until they notice, so counting them says the same thing either way.
async function muxStatus(sid) {
  try {
    const r = await fetch('http://127.0.0.1:' + WEB_PORT + '/mux/api/sessions',
      TOKEN ? { headers: { 'x-ccbb-token': TOKEN } } : undefined);
    const s = ((await r.json()).sessions || []).find(x => x.id === sid);
    return s ? s.status : null;
  } catch { return null; }
}

async function until(fn, tries = 80, gap = 150) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch {}
    await sleep(gap);
  }
  return null;
}
const get = (port, p) => fetch(`http://127.0.0.1:${port}${p}`, { redirect: 'manual' });

function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const waiting = new Map();
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; }
    const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m); } });
  return {
    ready: new Promise(res => ws.on('open', res)),
    send(method, params) { const n = ++id; ws.send(JSON.stringify({ id: n, method, params: params || {} }));
      return new Promise(res => waiting.set(n, res)); },
    async evaluate(expression) {
      const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      return r.result && r.result.result && r.result.result.value;
    },
    close() { try { ws.close(); } catch {} },
  };
}

async function main() {
  try { savedAddr = fs.readFileSync(ADDR, 'utf8'); } catch { savedAddr = null; }

  // One server. The mux runs inside ccbb web, so there is no second process to start
  // and no address to publish between them — the fixture session is created through
  // the mux's own API, which takes the fixture binary.
  const web = spawn(process.execPath, [path.join(__dirname, '..', 'ccbb-web.js'), '-p', String(WEB_PORT)],
    { detached: true, stdio: 'ignore' });
  kids.push(web);
  const up = await until(async () => (await get(WEB_PORT, '/api/identity' + q)).ok);
  if (!up) throw new Error('ccbb web never came up on ' + WEB_PORT);

  const first = await fetch('http://127.0.0.1:' + WEB_PORT + '/mux/api/sessions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
      TOKEN ? { 'x-ccbb-token': TOKEN } : {}),
    body: JSON.stringify({ bin: path.join(__dirname, 'fake-claude.js'), cwd: '/tmp', label: 'fixture' }),
  });
  const sid = ((await first.json()).session || {}).id;
  if (!sid) throw new Error('the fixture session was not created');
  made.push(sid);

  console.log('the session list:');
  const list = await (await get(WEB_PORT, '/api/sessions' + q)).json();
  const rows = list.sessions.filter(r => r.sessionId === sid);
  check('the mux session appears in ccbb web’s list', rows.length === 1,
    'found ' + rows.length + ' row(s)');
  check('it is marked as a mux session', !!(rows[0] && rows[0].mux));
  check('it reports live, from the mux rather than from disk', !!(rows[0] && rows[0].live));
  check('the row carries the mux’s cwd', !!(rows[0] && rows[0].projectPath));
  // A mux session writes an ordinary transcript, so the disk scan can find it too.
  // One row, not two, is the whole point of merging on the session id.
  const ids = list.sessions.map(r => r.sessionId);
  check('no duplicate row for the same session',
    ids.filter(x => x === sid).length === 1);

  console.log('\nthe proxy:');
  // ?token=… on a page is answered with the cookie hand-off, not the page — so the
  // token is banked once here and the page checks below use the cookie, the way a
  // browser does after its first visit.
  const handoff = await fetch(`http://127.0.0.1:${WEB_PORT}/mux/s/${sid}${q}`, { redirect: 'manual' });
  const jar = String(handoff.headers.get('set-cookie') || '').split(';')[0] || '';
  const page = await fetch(`http://127.0.0.1:${WEB_PORT}/mux/s/${sid}`,
    { redirect: 'manual', headers: jar ? { cookie: jar } : {} });
  const body = page.status === 200 ? await page.text() : '';
  check('the mux page is served through ccbb web', page.status === 200, 'got ' + page.status);
  check('it is the mux client, not ccbb web’s own page', body.includes('Message Claude'));
  const bare = await get(WEB_PORT, '/mux' + q);
  check('/mux redirects to /mux/ so relative links resolve',
    bare.status === 302 && (bare.headers.get('location') || '').startsWith('/mux/'),
    bare.status + ' ' + bare.headers.get('location'));
  const api = await get(WEB_PORT, `/mux/api/sessions${q}`);
  check('the mux API is reachable through the proxy too', api.status === 200);
  if (TOKEN) {
    const noTok = await get(WEB_PORT, `/mux/s/${sid}`);
    check('the proxy is behind ccbb web’s own auth', noTok.status === 401,
      'got ' + noTok.status);
  }

  // ── the socket, end to end through one port ──────────────────────────────
  console.log('\nthe socket, through ccbb web’s port only:');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-webchrome-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'],
    { detached: true, stdio: 'ignore' });
  kids.push(chrome);
  if (!await until(async () => (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()))
    throw new Error('headless Chrome never opened a debugging port');
  const url = `http://127.0.0.1:${WEB_PORT}/mux/s/${sid}${q}`;
  const tgt = await until(async () =>
    (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json());
  const p = cdpConnect(tgt.webSocketDebuggerUrl);
  await p.ready;
  await p.send('Runtime.enable');
  await until(async () => await p.evaluate('!!document.querySelector(".mx-log")'));
  const base = await p.evaluate('window.ccbb ? "loaded" : "no client"');
  check('the client bundle runs under the /mux prefix', base === 'loaded', String(base));
  const live = await until(async () => await p.evaluate('window.ccbb.live()'), 60, 250);
  check('its socket attaches through the proxy', live === true);

  // ── the row, in the live list ────────────────────────────────────────────
  // The checks above all went through /api/sessions, and the page does NOT get its
  // rows from there — it gets them over a WebSocket, from listSnapshot(). Merging
  // in the HTTP route alone left every one of those green while the actual list
  // showed nothing, so this renders ccbb web's own page and looks at the row.
  console.log('\nthe row, in the list the page actually renders:');
  const lt = await until(async () =>
    (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent('http://127.0.0.1:' + WEB_PORT + '/' + q)}`,
      { method: 'PUT' })).json());
  const lp = cdpConnect(lt.webSocketDebuggerUrl);
  await lp.ready;
  await lp.send('Runtime.enable');
  const row = await until(async () => await lp.evaluate(
    'var a=document.querySelector(\'a.sid[href="/mux/s/' + sid + '"]\');' +
    'a ? a.closest("tr").outerHTML : ""'), 60, 400);
  check('the mux row is rendered in the live list', !!row, 'no row found for ' + sid.slice(0, 8));
  check('the row is badged as a mux session', !!(row && row.includes('mux-tag')));
  check('the row links to the proxied client, not a tmux session view',
    !!(row && row.includes('/mux/s/' + sid) && !row.includes('/session/' + sid)));

  // The 2s poll is gone — the mux now says when a row moved, and ccbb web coalesces.
  // A row that appears once and then never changes again is the same bug in a new
  // place, and nothing above would notice: the row IS there. So drive a turn and watch
  // the rendered row change with no reload and no second page load.
  const rowBefore = await lp.evaluate(
    'document.querySelector(\'a.sid[href="/mux/s/' + sid + '"]\').closest("tr").outerHTML');
  const drv0 = spawn(process.execPath,
    [path.join(__dirname, 'drive.js'), String(WEB_PORT), sid, 'one'], { detached: true, stdio: 'ignore' });
  kids.push(drv0);
  const rowMoved = await until(async () => {
    const now = await lp.evaluate(
      'document.querySelector(\'a.sid[href="/mux/s/' + sid + '"]\').closest("tr").outerHTML');
    return now && now !== rowBefore ? 'y' : '';
  }, 60, 400);
  check('a running session updates its existing row, with no poll', rowMoved === 'y');

  // ── the mux client as a VIEW, which is the point of the factory refactor ──
  // Clicking a mux row must open a view in the stack, exactly like a tmux session,
  // rather than navigating away to the standalone page. Everything below is driven
  // through the list page's own click handler, not by calling openSession directly:
  // the handler's href match is half the feature and calling past it would test
  // nothing.
  console.log('\nthe mux client, as a view in the stack:');
  await lp.evaluate('document.querySelector(\'a.sid[href="/mux/s/' + sid + '"]\').click()');
  const opened = await until(async () => await lp.evaluate(
    'views.length === 2 && views[1].mux ? "yes" : ""'), 40, 250);
  check('clicking a mux row opens a view instead of navigating', opened === 'yes', String(opened));
  check('the page did not navigate away from the list',
    (await lp.evaluate('location.pathname')) === '/');
  check('the client mounted inside the view body',
    await lp.evaluate('!!document.querySelector(".mux-body > .muxv > .mx-log")'));
  check('the view has no second bar of its own',
    await lp.evaluate('!document.querySelector(".mux-body .mx-bar")'));
  const vlive = await until(async () => await lp.evaluate('views[1].client.live()'), 60, 250);
  check('its socket attached through the proxy', vlive === true);

  // The transcript has to have real height inside the view: .muxv used to be sized by
  // the page body, and a flex chain that silently fails here does not throw, it just
  // grows the view instead of scrolling inside it.
  const boxes = await lp.evaluate(
    'JSON.stringify({log: document.querySelector(".mux-body .mx-log").getBoundingClientRect().height,' +
    ' comp: document.querySelector(".mux-body .input-area").getBoundingClientRect().height})');
  const box = JSON.parse(boxes);
  check('the transcript area has height inside the view', box.log > 80, boxes);
  check('the composer is visible inside the view', box.comp > 20, boxes);

  // The bar is ccbb web's, fed by the client through onChrome. If that callback is
  // never wired the bar keeps its placeholder and looks merely unpopulated.
  const bar = await until(async () => await lp.evaluate(
    'var b=views[1].barEl; b.querySelector(".mux-mode").textContent ? b.outerHTML : ""'), 40, 250);
  check('the bar is badged as a mux session', !!(bar && bar.includes('mux-tag')));
  check('the client pushed its permission mode up to the bar',
    !!(bar && /class="mux-mode">(default|acceptEdits|plan|bypassPermissions)</.test(bar)), bar && bar.slice(0, 300));
  check('a mux view offers no terminal button, having no pane to attach to',
    !!(bar && !bar.includes('data-act="term"')));

  // The mux client renders ccbb-web.js's OWN classes now — .msg, .msg-body,
  // .tool-card, .input-row, .sv-foot — instead of a private imitation of them, so
  // the assertion here is the inverse of what it used to be: the mux body must
  // contain ccbb's classes, and they must be picking up ccbb's rules rather than
  // merely matching a selector. The bubble check below is the one that proves the
  // second half, and it is why this pair exists: an earlier rename left the JS
  // emitting a class nothing styled, and every text assertion still passed.
  check('the client renders ccbb web components',
    (await lp.evaluate('document.querySelectorAll(".mux-body .input-row .input-box").length')) === 1 &&
    (await lp.evaluate('document.querySelectorAll(".mux-body .sv-foot .sl").length')) === 1);

  const drv2 = spawn(process.execPath,
    [path.join(__dirname, 'drive.js'), String(WEB_PORT), sid, 'one'], { detached: true, stdio: 'ignore' });
  kids.push(drv2);
  const painted = await until(async () => await lp.evaluate(
    'var h=document.querySelector(".mux-body .mx-log").textContent;' +
    'h.indexOf("is 289 prime?") >= 0 && h.indexOf("not prime") >= 0 ? "yes" : ""'), 60, 400);
  check('a turn driven elsewhere renders inside the view', painted === 'yes', String(painted));

  const bubble = await lp.evaluate(
    'var b=document.querySelector(".mux-body .msg.you .msg-body");' +
    'b ? getComputedStyle(b).backgroundColor : "none"');
  check('a user turn keeps its own bubble',
    bubble !== 'none' && bubble !== 'rgba(0, 0, 0, 0)', String(bubble));

  // ── two at once, which is the case the factory refactor exists for ──────────
  // One view proves nothing about per-instance state: the old page script would pass
  // every check above. A second session opened beside the first is what catches a
  // shared S, a shared socket, or a destroy() that reaches past its own instance.
  // The mux's create API takes the fixture binary, so this needs no second daemon.
  const sid2 = await newFixtureSession('second');

  const row2 = await until(async () => await lp.evaluate(
    'document.querySelector(\'a.sid[href="/mux/s/' + sid2 + '"]\') ? "y" : ""'), 60, 400);
  check('a second mux session reaches the live list', row2 === 'y');
  await lp.evaluate('document.querySelector(\'a.sid[href="/mux/s/' + sid2 + '"]\').click()');
  const both = await until(async () => await lp.evaluate(
    'views.length === 3 && views[1].client.live() && views[2].client.live() ? "y" : ""'), 60, 250);
  check('two mux views hold two independent live sockets', both === 'y', String(both));
  check('each view knows its own session',
    await lp.evaluate('views[1].client.session !== views[2].client.session'));
  check('each view renders into its own body',
    (await lp.evaluate('document.querySelectorAll(".mux-body > .muxv > .mx-log").length')) === 2);

  // A turn driven into the SECOND session must land in the second view and nowhere
  // else. Counting the first view's messages rather than looking for the text: both
  // fixtures reply to the same prompts, so the text alone cannot tell them apart.
  const n1 = await lp.evaluate('views[1].el.querySelectorAll(".msg").length');
  const drv3 = spawn(process.execPath,
    [path.join(__dirname, 'drive.js'), String(WEB_PORT), sid2, 'one'], { detached: true, stdio: 'ignore' });
  kids.push(drv3);
  const landed = await until(async () => await lp.evaluate(
    'views[2].el.querySelectorAll(".msg").length >= 2 ? "y" : ""'), 60, 400);
  check('a turn driven into the second session renders in the second view', landed === 'y');
  check('and does not leak into the first',
    (await lp.evaluate('views[1].el.querySelectorAll(".msg").length')) === n1);

  // ── closing a view: the socket, and now the session ─────────────────────────
  // Closing must take that view's socket with it — and only that one. The reconnect
  // timer is the failure that hides: the view is gone from the DOM while its client
  // keeps reattaching, so the mux counts a controller nobody can see.
  //
  // Closing also STOPS the session — but only when it leaves nobody attached, and
  // the two halves of that rule need separate cases or one of them is never run. A
  // second view of the SAME session is the "somebody is still watching" half: it is
  // built by hand because openSession deliberately refuses to open a session twice.
  await lp.evaluate('(function(){var v=createMuxSessionView({sessionId:"' + sid2 + '",' +
    'server:null,title:"dup"});views.push(v);viewsEl.appendChild(v.el);relayout();})()');
  const twoOnOne = await until(async () => (await muxClientCount(sid2)) >= 2 ? 'y' : '', 40, 250);
  check('a second view of one session attaches its own client', twoOnOne === 'y');
  await lp.evaluate('closeView(views[3])');
  const stillThere = await until(async () => (await muxClientCount(sid2)) === 1 ? 'y' : '', 40, 250);
  check('closing a view drops that view\'s client from the mux', stillThere === 'y',
    'clients: ' + await muxClientCount(sid2));
  // Long enough to outlive the first reconnect backoff (250ms), which is what a
  // torn-down-but-still-timing client would use to come back.
  await sleep(1500);
  check('and it does not reconnect afterwards',
    (await muxClientCount(sid2)) === 1, 'crept back up');
  const survivor = await muxStatus(sid2);
  check('a session someone else is still watching is not stopped',
    survivor !== null && survivor !== 'exited', 'status ' + survivor);

  await lp.evaluate('closeView(views[1])');
  check('closing one view removes it from the stack',
    (await lp.evaluate('views.length')) === 2);
  check('the other mux view is untouched by the close',
    await lp.evaluate('views[1].client.live() && views[1].client.session === "' + sid2 + '"'));
  check('while the surviving view keeps its own client attached',
    (await muxClientCount(sid2)) >= 1);

  // The other half of the rule, on a session of its own. The earlier two carry
  // leftover drivers from the checks above, and "the last client left" is a claim
  // about ALL of them — so this one is created here, watched only by its own view,
  // and closed. A mux session is a real claude process; one nobody is looking at is
  // one nobody asked for, and it goes.
  const sid3 = await newFixtureSession('lastout');
  await until(async () => await lp.evaluate(
    'document.querySelector(\'a.sid[href="/mux/s/' + sid3 + '"]\') ? "y" : ""'), 60, 400);
  await lp.evaluate('document.querySelector(\'a.sid[href="/mux/s/' + sid3 + '"]\').click()');
  const alone = await until(async () => (await muxClientCount(sid3)) === 1 ? 'y' : '', 60, 250);
  check('the only view of a fresh mux session is its only client', alone === 'y');
  await lp.evaluate('closeView(views[2])');
  const stopped = await until(async () => {
    const st = await muxStatus(sid3);
    return (st === null || st === 'exited') ? 'y' : '';
  }, 60, 250);
  check('closing the last view of a mux session stops it', stopped === 'y',
    'status ' + await muxStatus(sid3));

  // ── resume in the mux, from the transcript view ─────────────────────────────
  // Clicking a session that is NOT running here opens its transcript, and that view
  // offers to resume it in the mux. The button is driven by the same fact the composer
  // is: no pane on this host means nothing to drive, and the mux is the only way to
  // make the session answer.
  //
  // The click is exercised against a session the mux is ALREADY running, which is the
  // one branch that starts no child: the mux answers 409 running-in-mux, and the right
  // response to "the thing you asked for already exists" is to open it, not to report
  // an error. It also pins the ordering — the transcript view must not be torn down
  // until there is somewhere to go, or a refusal would cost the user their view.
  console.log('\nresume in the mux:');
  const sid4 = await newFixtureSession('resumable');
  await lp.evaluate('openSession("' + sid4 + '", null, false, "resumable")');
  const asPlain = await until(async () => await lp.evaluate(
    'views.length === 3 && !views[2].mux ? "y" : ""'), 60, 250);
  check('a mux session opens as a plain transcript view when asked for one', asPlain === 'y');
  const offered = await until(async () => await lp.evaluate(
    'var b = views[2].el.querySelector(".vb-resume"); b && !b.hidden ? "y" : ""'), 60, 250);
  check('a session with no pane here offers to resume in the mux', offered === 'y');
  await lp.evaluate('views[2].el.querySelector(".vb-resume").click()');
  const swapped = await until(async () => await lp.evaluate(
    'views.length === 3 && views[2].mux && views[2].sessionId === "' + sid4 + '" ? "y" : ""'), 60, 250);
  check('resuming swaps the transcript view for a mux view of the same session',
    swapped === 'y', await lp.evaluate('views.map(function(v){return v.kind+(v.mux?":mux":"")}).join()'));
  check('and that view attached a client to the session',
    (await until(async () => (await muxClientCount(sid4)) >= 1 ? 'y' : '', 40, 250)) === 'y');
  // The discriminator the button branches on. Both refusals are 409s and only the
  // reason tells them apart — one means "open it", the other means "report it" — so a
  // shared code with different prose would leave the client matching on a sentence.
  const busy = await fetch('http://127.0.0.1:' + WEB_PORT + '/mux/api/sessions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
      TOKEN ? { 'x-ccbb-token': TOKEN } : {}),
    body: JSON.stringify({ resume: sid4 }),
  });
  const busyBody = await busy.json();
  check('resuming a session the mux already runs is a 409 the client can act on',
    busy.status === 409 && busyBody.reason === 'running-in-mux',
    busy.status + ' ' + JSON.stringify(busyBody));

  // The other resume branch, and the one the complaint was about: a session the mux is
  // NOT already running. --resume replays nothing over stream-json, so unless the mux
  // reads the transcript off disk this opens as a blank page. Driven through the real
  // POST route, not through create() in-process — the unit checks in verify.js passed
  // with the seedHistory() call deleted from the constructor, and they would pass again
  // if the route dropped the field on the way through.
  const histId = '11111111-2222-3333-4444-555555555555';
  const projDir = path.join(common.CLAUDE_DIR, 'projects', '-tmp-ccbb-verify');
  const histFile = path.join(projDir, histId + '.jsonl');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(histFile, [
    JSON.stringify({ type: 'user', uuid: 'h1', message: { role: 'user', content: 'ASKED BEFORE THE RESUME' } }),
    JSON.stringify({ type: 'assistant', uuid: 'h2', message: { role: 'assistant', model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ANSWERED BEFORE THE RESUME' },
                 { type: 'tool_use', id: 'ht1', name: 'Read', input: { file_path: '/before.txt' } }] } }),
    JSON.stringify({ type: 'user', uuid: 'h3', toolUseResult: { file: { numLines: 2 } },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ht1', content: 'xx' }] } }),
  ].join('\n') + '\n');
  tempFiles.push(histFile);

  const res = await fetch('http://127.0.0.1:' + WEB_PORT + '/mux/api/sessions', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
      TOKEN ? { 'x-ccbb-token': TOKEN } : {}),
    body: JSON.stringify({ bin: path.join(__dirname, 'fake-claude.js'), cwd: '/tmp',
      resume: histId, label: 'resumed' }),
  });
  const resumed = ((await res.json()).session || {}).id;
  if (resumed) made.push(resumed);
  check('resuming an idle session keeps its id', resumed === histId, String(resumed));
  await lp.evaluate('openSession("' + histId + '", null, true, "resumed")');
  const seen = await until(async () => await lp.evaluate(
    'var v = views[views.length-1]; var t = v && v.el.textContent || "";' +
    't.indexOf("ASKED BEFORE THE RESUME") >= 0 && t.indexOf("ANSWERED BEFORE THE RESUME") >= 0 ? "y" : ""'), 60, 250);
  check('and its transcript is on the page before the child says a word', seen === 'y');
  // Both, and separately: ccbb dims a seeded turn with '.msg.hist .msg-body,
  // .tool-card.hist' — the card is named on its own there, so a flag left on the
  // wrapper dims the prose and leaves every card inside it at full strength.
  check('the seeded prose is dimmed as history', (await lp.evaluate(
    'var v = views[views.length-1]; !!(v && v.el.querySelector(".msg.hist"))')) === true);
  check('and so are the tool cards inside it', (await lp.evaluate(
    'var v = views[views.length-1]; !!(v && v.el.querySelector(".tool-card.hist"))')) === true);

  lp.close();

  // ── the phone ────────────────────────────────────────────────────────────
  // The proxy was justified BY the phone — it reaches ccbb and nothing else — so
  // the phone is the one client that must not dead-end. Two ways it did: the mux
  // page counted as a "desktop page" and got redirected to /m/mux/s/<id>, which is
  // not a route; and the mobile list opens an in-page panel that tails a tmux pane
  // a mux session does not have.
  console.log('\nthe phone:');
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const muxOnPhone = await fetch(`http://127.0.0.1:${WEB_PORT}/mux/s/${sid}${q}`,
    { redirect: 'manual', headers: { 'user-agent': IPHONE } });
  // With a token in the URL the honest answer is the hand-off redirect, not the
  // page — so what matters here is only that the phone is never sent into /m,
  // where /m/mux/s/<id> is not a route.
  const wentTo = String(muxOnPhone.headers.get('location') || '');
  check('a phone is never redirected into the phone UI',
    muxOnPhone.status === 200 || !wentTo.startsWith('/m/'),
    muxOnPhone.status + ' → ' + wentTo);

  if (TOKEN) {
    // The token hand-off: ?token=… must bank a cookie and reload clean, or a page
    // added to a home screen and reopened later has no credential at all. This only
    // works if the proxy sits BELOW the hand-off — above it, the proxy answers first
    // and no cookie is ever set.
    const hand = await fetch(`http://127.0.0.1:${WEB_PORT}/mux/s/${sid}?token=${encodeURIComponent(TOKEN)}`,
      { redirect: 'manual', headers: { 'user-agent': IPHONE } });
    const cookie = String(hand.headers.get('set-cookie') || '');
    check('opening with ?token= banks a cookie and drops the token from the URL',
      hand.status === 302 && cookie.includes(TOKEN) &&
      !String(hand.headers.get('location') || '').includes('token='),
      hand.status + ' ' + hand.headers.get('location'));
    const jar = (cookie.split(';')[0] || '');
    const back = await fetch(`http://127.0.0.1:${WEB_PORT}/mux/s/${sid}`,
      { redirect: 'manual', headers: { 'user-agent': IPHONE, cookie: jar } });
    check('coming back with only that cookie still serves the page',
      back.status === 200, 'got ' + back.status);
  }

  const mt = await until(async () =>
    (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(
      'http://127.0.0.1:' + WEB_PORT + '/m' + q)}`, { method: 'PUT' })).json());
  const mp = cdpConnect(mt.webSocketDebuggerUrl);
  await mp.ready;
  await mp.send('Runtime.enable');
  const mrow = await until(async () => await mp.evaluate(
    'var d=document.querySelector(\'.srow[data-sid="' + sid + '"]\'); d ? d.outerHTML : ""'), 60, 400);
  check('the mux row reaches the phone list', !!mrow, 'no row for ' + sid.slice(0, 8));
  check('the phone row is badged', !!(mrow && mrow.includes('mux-tag')));
  check('the phone row is tagged as mux for the click handler',
    !!(mrow && mrow.includes('data-mux')));
  await mp.evaluate('document.querySelector(\'.srow[data-sid="' + sid + '"]\').click()');
  const went = await until(async () => {
    const href = await mp.evaluate('location.pathname');
    return href && href.indexOf('/mux/s/') === 0 ? href : null;
  }, 30, 300);
  check('tapping it leaves for the mux client rather than opening a pane panel',
    went === '/mux/s/' + sid, String(went));
  mp.close();

  const drv = spawn(process.execPath,
    [path.join(__dirname, 'drive.js'), String(WEB_PORT), sid, 'one'], { detached: true, stdio: 'ignore' });
  kids.push(drv);
  await sleep(6000);
  const html = await p.evaluate('document.documentElement.outerHTML');
  check('a turn driven elsewhere renders in the proxied page',
    html.includes('is 289 prime?') && html.includes('not prime'));
  const errs = await p.evaluate('JSON.stringify(window.ccbb.errors)');
  check('the proxied page raised no uncaught errors', errs === '[]', errs);
  p.close();

  // A mux child writes the same ~/.claude/sessions record an interactive session does, so
  // without the entrypoint filter ccbb climbs its pid to the pane the MUX DAEMON runs in and
  // adopts that as the session's terminal — it pipe-panes it, and injectToPane types the
  // user's message into the daemon's own shell. That is not a hypothetical: it is what
  // happened, and the evidence was the prompt sitting in ccbb-pane-<id>.log.
  // (common is already required at the top of the file)
  const rec = { pid: process.pid, sessionId: 'fake-mux-session', entrypoint: 'ccbb-mux' };
  const sdir = path.join(require('os').homedir(), '.claude', 'sessions');
  const sfile = path.join(sdir, 'ccbb-mux-verify.json');
  let wrote = false;
  try { fs.writeFileSync(sfile, JSON.stringify(rec)); wrote = true; } catch {}
  if (wrote) {
    check('a mux child is not mistaken for a tmux session',
      common.sessionLiveness('fake-mux-session').live === false);
    check('a mux child never resolves to a pane',
      common.paneForSession('fake-mux-session') === null);
    try { fs.unlinkSync(sfile); } catch {}
  }

  cleanup();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks pass');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); cleanup(); process.exit(1); });
