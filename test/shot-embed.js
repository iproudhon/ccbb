#!/usr/bin/env node
'use strict';
// A screenshot of the mux client, for the one class of bug the assertions keep
// missing: a page that renders WRONG while every selector still matches. Renaming
// .msg to .msg once cost every user turn its bubble, and the whole suite stayed
// green — the rule since is that a rendering change gets looked at.
//
//   node test/shot.js [out.png]
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const common = require('../ccbb-common');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8596, CDP = 9337;
const TOKEN = common.peerToken ? common.peerToken() : '';
const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'shot.png'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let kids = [], made = [];
function kill() { for (const k of kids) { try { process.kill(-k.pid); } catch {} try { k.kill('SIGKILL'); } catch {} } kids = []; }
process.on('exit', () => { kill(); for (const s of made) { try { fs.unlinkSync(path.join(common.CLAUDE_DIR, 'ccbb-mux', s + '.ndjson')); } catch {} } });

async function until(fn, tries = 80, gap = 150) {
  for (let i = 0; i < tries; i++) { const v = await fn().catch(() => null); if (v) return v; await sleep(gap); }
  return null;
}
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0; const waiting = new Map();
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } const r = waiting.get(m.id); if (r) { waiting.delete(m.id); r(m); } });
  return { ready: new Promise(res => ws.on('open', res)),
    send(method, params) { const n = ++id; ws.send(JSON.stringify({ id: n, method, params: params || {} })); return new Promise(res => waiting.set(n, res)); },
    async evaluate(expression) { const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return (r.result || {}).result && r.result.result.value; },
    close() { try { ws.close(); } catch {} } };
}

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, 'serve.js'), String(PORT)], { detached: true, stdio: 'ignore' });
  kids.push(srv);
  const auth = TOKEN ? { headers: { 'x-ccbb-token': TOKEN } } : undefined;
  const sid = await until(async () => ((await (await fetch(`http://127.0.0.1:${PORT}/mux/api/sessions`, auth)).json()).sessions[0] || {}).id);
  if (!sid) throw new Error('fixture server never came up');
  made.push(sid);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-shot-'));
  kids.push(spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=1100,1500',
    `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, 'about:blank'], { detached: true, stdio: 'ignore' }));
  if (!await until(async () => (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json())) throw new Error('no chrome');
  const url = `http://127.0.0.1:${PORT}/` + (TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '');
  const tgt = await until(async () => (await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json());
  const page = cdp(tgt.webSocketDebuggerUrl);
  await page.ready;
  await page.send('Runtime.enable');
  await until(async () => await page.evaluate('!!window.openSession'));
  await page.evaluate(`openSession(${JSON.stringify(sid)}, null, true, 'fixture')`);
  await until(async () => await page.evaluate('!!document.querySelector(".mx-log")'));

  kids.push(spawn(process.execPath, [path.join(__dirname, 'drive.js'), String(PORT), sid, 'full'], { detached: true, stdio: 'ignore' }));
  await sleep(13000);
  // A slash command and a ccbb command, so the two new card shapes are in frame.
  await page.evaluate('(function(){var i=document.querySelector(".input-box");i.value="/status";document.querySelector(".send-btn").click();})()');
  await sleep(1200);
  await page.evaluate('(function(){var i=document.querySelector(".input-box");i.value="/compact";document.querySelector(".send-btn").click();})()');
  await sleep(1200);
  await page.evaluate('(function(){var i=document.querySelector(".input-box");i.value="//pwd";document.querySelector(".send-btn").click();})()');
  await sleep(1500);
  await page.evaluate('document.querySelector(".mx-log").scrollTop = document.querySelector(".mx-log").scrollHeight');
  await sleep(400);
  const r = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(OUT, Buffer.from(r.result.data, 'base64'));
  console.log(OUT);
  page.close();
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
