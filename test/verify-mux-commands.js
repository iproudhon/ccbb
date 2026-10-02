'use strict';
// /exit and /term in the mux clients: the TUI (ccbb attach), and the web client hosted on
// the desktop, on the phone and standalone. Backed by test/serve.js's fake-claude fixture.
// CHROME=/path/to/chrome node test/verify-mux-commands.js
const {spawn}=require('child_process');const fs=require('fs');const path=require('path');const crypto=require('crypto');
const WebSocket=require('ws');
const os=require('os');const R=path.join(__dirname,'..');const CH=process.env.CHROME;
if(!CH)throw new Error('Set CHROME to a Chromium executable');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));const TOK=require(R+'/ccbb-common').peerToken();
const PORT=8603, B='http://127.0.0.1:'+PORT, H={'content-type':'application/json','x-ccbb-token':TOK};
const srv=spawn(process.execPath,[R+'/test/serve.js',String(PORT)],{stdio:['ignore','pipe','inherit']});
let ch, prof; process.on('exit',()=>{try{srv.kill('SIGTERM')}catch{};try{ch&&ch.kill('SIGKILL')}catch{};try{prof&&fs.rmSync(prof,{recursive:true,force:true})}catch{}});
const list=async()=>(await (await fetch(B+'/mux/api/sessions',{headers:H})).json()).sessions.map(s=>s.id);
const mk=async()=>(await (await fetch(B+'/mux/api/sessions',{method:'POST',headers:H,body:JSON.stringify({bin:R+'/test/fake-claude.js',cwd:'/tmp',label:'t'})})).json()).session.id;
const gone=async id=>{for(let i=0;i<60;i++){if(!(await list()).includes(id))return true;await sleep(250)}return false};
const alive=async id=>{await sleep(1500);return (await list()).includes(id)};
let pass=0,fail=0;const check=(n,ok,d)=>{ok?pass++:fail++;console.log((ok?'  OK   ':'  FAIL ')+n+(ok||d===undefined?'':'  '+JSON.stringify(d)))};
function tui(id,line){return new Promise(res=>{const p=spawn(process.execPath,[R+'/ccbb.js','attach','--url','ws://127.0.0.1:'+PORT+'/mux/mux',id],{stdio:['pipe','pipe','pipe']});
  let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);setTimeout(()=>p.stdin.write(line+'\n'),1500);
  const t=setTimeout(()=>{p.kill();res({code:'timeout',out})},15000);p.on('exit',c=>{clearTimeout(t);res({code:c,out})});});}
(async()=>{
 await new Promise(r=>srv.stdout.on('data',d=>{if(/fixture session/.test(d))r()}));
 // TUI
 let a=await mk(); let r=await tui(a,'/exit');
 check('tui /exit leaves the client',r.code===0&&/detached/.test(r.out),r);
 check('tui /exit leaves the session running',await alive(a));
 r=await tui(a,'/term');
 check('tui /term leaves the client',r.code===0&&/terminated/.test(r.out),r);
 check('tui /term ends the session',await gone(a));
 // browser
 prof=fs.mkdtempSync(path.join(os.tmpdir(),'ccbb-mux-cmd-'));
 ch=spawn(CH,['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port=9353','--user-data-dir='+prof,'about:blank'],{stdio:'ignore'});
 let tabs;for(let i=0;i<100;i++){try{tabs=await(await fetch('http://127.0.0.1:9353/json')).json();break}catch{await sleep(100)}}
 const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));
 let n=0;const w=new Map();ws.on('message',b=>{const m=JSON.parse(b);if(w.has(m.id)){w.get(m.id)(m);w.delete(m.id)}});
 const send=(method,params={})=>new Promise(r=>{const k=++n;w.set(k,r);ws.send(JSON.stringify({id:k,method,params}))});
 const ev=async e=>{const x=await send('Runtime.evaluate',{expression:e,returnByValue:true,awaitPromise:true});if(x.result.exceptionDetails)throw new Error(JSON.stringify(x.result.exceptionDetails).slice(0,300));return x.result.result.value};
 // No network in a fixture: the CDN scripts fail fast instead of hanging the page.
 ws.on('message',b=>{const m=JSON.parse(b);if(m.method==='Fetch.requestPaused')send('Fetch.failRequest',{requestId:m.params.requestId,errorReason:'Failed'});});
 await send('Page.enable');await send('Fetch.enable',{patterns:[{urlPattern:'https://*'}]});
 const wait=async(c,k=80)=>{for(let i=0;i<k;i++){if(await ev(c).catch(()=>false))return true;await sleep(150)}return false};
 const type=async t=>ev(`(function(){var i=[...document.querySelectorAll(".input-box")].pop();i.value=${JSON.stringify(t)};[...document.querySelectorAll(".send-btn")].pop().click();})()`);
 const go=async u=>{await send('Page.navigate',{url:B+u+(u.includes('?')?'&':'?')+'token='+TOK});await sleep(1500)};
 // desktop /exit
 a=await mk(); await go('/'); await ev(`openSession(${JSON.stringify(a)},null,true)`);
 check('desktop view opens',await wait('document.querySelectorAll(".view .input-box").length>0'));
 const views=await ev('document.querySelectorAll(".view").length');
 await type('/exit');
 check('desktop /exit closes the view like X',await wait(`document.querySelectorAll(".view").length===${views-1}`));
 check('desktop /exit as the only client ends the session (X semantics)',await gone(a));
 // desktop /term with a TUI also attached
 a=await mk(); const bystander=spawn(process.execPath,[R+'/ccbb.js','attach','--url','ws://127.0.0.1:'+PORT+'/mux/mux',a],{stdio:['pipe','ignore','ignore']});
 await sleep(1000); await ev(`openSession(${JSON.stringify(a)},null,true)`); await wait('document.querySelectorAll(".view .input-box").length>0');
 await type('/exit'); await sleep(500);
 check('desktop /exit with another client attached keeps the session',await alive(a));
 await ev(`openSession(${JSON.stringify(a)},null,true)`); await wait('document.querySelectorAll(".view .input-box").length>0'); await sleep(800);
 await type('/term');
 check('desktop /term ends the session despite another client',await gone(a));
 try{bystander.kill()}catch{}
 // mobile
 a=await mk(); await send('Emulation.setDeviceMetricsOverride',{width:393,height:852,deviceScaleFactor:2,mobile:true});
 await go('/m'); await ev(`openMuxSession(${JSON.stringify(a)},null)`);
 check('mobile panel opens',await wait('document.querySelectorAll(".muxv .input-box").length>0'));
 await type('/term');
 check('mobile /term closes the panel',await wait('document.querySelectorAll(".muxv").length===0'));
 check('mobile /term ends the session',await gone(a));
 // standalone
 await send('Emulation.clearDeviceMetricsOverride');
 a=await mk(); await go('/mux/s/'+a); await wait('document.querySelectorAll(".input-box").length>0');
 await type('/exit');
 check('standalone /exit says so',await wait('!!document.querySelector(".mx-closed")'));
 check('standalone /exit as only client ends the session',await gone(a));
 // other slash commands still reach the child
 a=await mk(); await go('/mux/s/'+a); await wait('document.querySelectorAll(".input-box").length>0'); await sleep(800);
 await type('/exits'); await sleep(1500);
 check('a non-mux slash command is still the child\'s',await alive(a) && !(await ev('!!document.querySelector(".mx-closed")')));
 console.log(`pass ${pass} fail ${fail}`); process.exit(fail?1:0);
})().catch(e=>{console.error(e);process.exit(2)});
