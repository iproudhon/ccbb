'use strict';
// Local browser fixture: no model turns or real session data.
// CHROME=/path/to/chrome node test/verify-session-chrome.js
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn } = require('child_process');
const { WebSocket, WebSocketServer } = require('ws');
const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-chrome-fixture-'));
process.env.CLAUDE_CONFIG_DIR = cfg; process.env.CCBB_HOME = cfg;
const { appPageHtml, SHARED_JS } = require('../ccbb-web');
const { mobilePageHtml } = require('../ccbb-mobile');
const { codexWindows } = require('../ccbb-common');
const chrome = process.env.CHROME;
if (!chrome) throw new Error('Set CHROME to a Chromium executable');
const vendor = process.env.CCBB_TEST_VENDOR || path.join(os.homedir(), '.claude', 'ccbb-vendor');
const assets = { 'marked.js': 'marked-12.js', 'xterm.js': 'xterm-5.5.0.js', 'xterm.css': 'xterm-5.5.0.css' };
const limits = { primary: { usedPercent:24,windowDurationMins:300,resetsAt:1800000000 }, secondary:{usedPercent:41,windowDurationMins:10080,resetsAt:1800500000} };
const snapshot = {op:'snapshot',seq:0,epoch:'fixture',clients:[],pending:[],messages:[],state:{id:'codex:fixture',nativeId:'fixture',agent:'codex',model:'gpt-6-astra',title:'Saved session',status:'history',live:false,cost:null,turns:3,cwd:'/tmp',capabilities:[]}};
let live = false, posts = [], cdp, child;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) { for(let i=0;i<100;i++){if(await fn())return;await sleep(50);}throw new Error('Timed out: '+label); }
const server = http.createServer(async (req,res) => {
  const u = new URL(req.url,'http://fixture');
  const json = value => {res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if (u.pathname.startsWith('/vendor/')) {
    res.setHeader('Content-Type',u.pathname.endsWith('.css')?'text/css':'application/javascript');
    const file=assets[u.pathname.slice(8)];return res.end(file?fs.readFileSync(path.join(vendor,file)):'');
  }
  if (u.pathname === '/api/codex/subscription') return json({rateLimits:limits});
  if (u.pathname === '/api/subscription') return json({account:{},windows:{fiveHour:{pct:99},sevenDay:{pct:98}}});
  if (u.pathname === '/api/codex/history/fixture') return json(snapshot);
  if (u.pathname === '/api/codex/activity/fixture') return json({live,liveStatus:live?'idle':null});
  if (u.pathname === '/mux/api/sessions' && req.method === 'POST') {
    let body='';for await(const chunk of req)body+=chunk;posts.push(JSON.parse(body));return json({session:{...snapshot.state,status:'idle'}});
  }
  if (u.pathname.startsWith('/api/')) return json({sessions:[],servers:[],errors:[],peers:[]});
  res.setHeader('Content-Type','text/html');
  res.end(u.pathname==='/m' ? mobilePageHtml(null,null,{name:'fixture'},{},false,false) : appPageHtml(null,null,u.searchParams.has('ro')));
});
const wss = new WebSocketServer({server});
wss.on('connection',(ws,req)=>ws.send(JSON.stringify(req.url.includes('/mux/mux') ? {...snapshot,state:{...snapshot.state,status:'idle',rateLimits:limits}} : {type:'snapshot',sessions:[]})));
(async()=>{
  // Unknown quota windows must not become fabricated zero-percent readings.
  assert.deepEqual(codexWindows(null),{});
  assert.deepEqual(codexWindows({primary:{usedPercent:0,windowDurationMins:60}}),{});
  assert.equal(codexWindows(limits).fiveHour.pct,24);
  const { TuiClient } = require('../ccbb-mux-tui');
  const tui = {state:{...snapshot.state,rateLimits:limits},peers:[],statusLine:{lines:[]},agentTally:()=>''};
  const status = TuiClient.prototype.footerLines.call(tui).join(' ');
  assert(status.includes('5h:24%') && status.includes('7d:41%'),status);
  assert(!/Codex|gpt-6/.test(status),status);
  tui.state.rateLimits = null;
  assert(!/5h:|7d:/.test(TuiClient.prototype.footerLines.call(tui).join(' ')));
  const vm=require('vm'), context=vm.createContext({});vm.runInContext(SHARED_JS,context);
  assert.equal(context.prettyModel('gpt-6-astra'),'GPT 6 Astra');
  assert.equal(context.prettyModel('gpt-5.4'),'GPT 5.4');
  assert.equal(context.prettyModel('claude-opus-5'),'Opus 5');
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port=0','--user-data-dir='+path.join(cfg,'browser'),'about:blank'],{stdio:'ignore',detached:true});
  const devtools=path.join(cfg,'browser','DevToolsActivePort');await until(()=>fs.existsSync(devtools),'DevTools');
  const port=fs.readFileSync(devtools,'utf8').split('\n')[0];
  const tabs=await(await fetch('http://127.0.0.1:'+port+'/json')).json();
  cdp=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await new Promise(r=>cdp.once('open',r));
  let id=0;const pending=new Map();cdp.on('message',raw=>{const m=JSON.parse(raw);if(pending.has(m.id)){pending.get(m.id)(m);pending.delete(m.id);}});
  const send=(method,params={})=>new Promise(r=>{const n=++id;pending.set(n,r);cdp.send(JSON.stringify({id:n,method,params}));});
  const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.error||r.result.exceptionDetails)throw new Error(JSON.stringify(r));return r.result.result.value;};
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.testErrors=[];addEventListener("error",e=>testErrors.push(e.message));addEventListener("unhandledrejection",e=>testErrors.push(String(e.reason)));'});
  for(const mobile of [false,true]) {
    live=false;posts=[];
    await send('Emulation.setDeviceMetricsOverride',{width:mobile?390:1280,height:844,deviceScaleFactor:1,mobile});
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port+(mobile?'/m':'/')});
    await until(()=>evaluate('typeof openSession === "function"'),'page');
    if (mobile) {
      assert.equal(await evaluate(`(()=>{var h=document.createElement('div');muxStartButton(h,'claude-fixture',null,'claude',function(){});return h.querySelector('button').textContent;})()`),'▶');
    } else {
      assert.equal(await evaluate(`(()=>{var h=document.createElement('div');h.innerHTML=viewBtnsHtml({resume:true});return h.querySelector('.vb-resume').textContent;})()`),'▶');
    }
    await evaluate('openSession("codex:fixture",null,false,"Saved session")');
    await until(()=>evaluate('!!document.querySelector(".muxv .sv-foot")'),'history');
    await until(()=>evaluate('document.querySelector(".muxv .sv-foot").textContent.includes("24%")'),'Codex windows');
    const footer=await evaluate('document.querySelector(".muxv .sv-foot").textContent');
    assert(footer.includes('5h')&&footer.includes('7d')&&footer.includes('41%'),footer);
    assert(!/Codex|gpt|GPT|99%|98%/.test(footer),footer);
    assert(await evaluate('document.body.textContent.includes("GPT 6 Astra")'),'model in info header');
    const button=mobile?'[aria-label="Start mux session"]':'.vb-resume';
    assert.equal(await evaluate(`document.querySelector('${button}').textContent`),'▶');
    assert.equal(await evaluate(`document.querySelector('${button}').hidden`),false);
    live=true;await until(()=>evaluate(`document.querySelector('${button}').hidden`),'live session hides start');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('${button}')).display`),'none');
    live=false;await until(()=>evaluate(`!document.querySelector('${button}').hidden`),'inactive session offers start');
    await evaluate(`document.querySelector('${button}').click()`);
    await until(()=>evaluate('!!document.querySelector("dialog.ns-new[open]")'),'binary picker');
    await evaluate(`(()=>{var d=document.querySelector('dialog.ns-new[open]');d.querySelector('[name=bin]').value='codex';d.querySelector('form').requestSubmit();})()`);
    await until(()=>posts.length===1,'resume request');
    assert.deepEqual(posts[0],{agent:'codex',bin:'codex',resume:'codex:fixture',startInactive:true});
    await until(()=>evaluate('getComputedStyle(document.querySelector(".muxv .input-area")).display !== "none"'),'live composer');
    assert.deepEqual((await evaluate('testErrors')).filter(e=>!e.startsWith('ResizeObserver loop')),[]);
    console.log('OK: '+(mobile?'mobile':'desktop')+' Codex footer, model, activity and mux start');
  }
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  if(cdp)cdp.terminate();
  if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));process.kill(-child.pid,'SIGKILL');await done;}
  for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));server.closeAllConnections();await new Promise(r=>server.close(r));
  fs.rmSync(cfg,{recursive:true,force:true,maxRetries:5,retryDelay:100});process.exit(process.exitCode||0);
});
