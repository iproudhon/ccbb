'use strict';
// Real-browser smoke against an already-running preview; no model turn is submitted.
// CCBB_TEST_URL=http://127.0.0.1:8610 CHROME=/path/to/chrome node test/verify-codex-web.js
const {spawn}=require('child_process');
const fs=require('fs'),os=require('os'),path=require('path');
const assert=require('node:assert/strict');
const WebSocket=require('ws');
const base=process.env.CCBB_TEST_URL || 'http://127.0.0.1:8610';
const chrome=process.env.CHROME;
if(!chrome) throw new Error('Set CHROME to the browser executable');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'ccbb-codex-chrome-'));
const historyId=process.env.CCBB_TEST_THREAD;
if(!historyId)throw new Error('Set CCBB_TEST_THREAD to a saved Codex thread containing Shared client works. (the compatibility probe fixture)');
const token=require('../ccbb-common').peerToken();
const q=token?'?token='+encodeURIComponent(token):'';
const child=spawn(chrome,['--headless=new','--no-sandbox','--disable-gpu','--remote-debugging-port=9348','--user-data-dir='+profile,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws;
(async()=>{
 let tabs;
 for(let i=0;i<80;i++){try{tabs=await(await fetch('http://127.0.0.1:9348/json')).json();break;}catch{await sleep(100);}}
 ws=new WebSocket(tabs[0].webSocketDebuggerUrl);await new Promise(r=>ws.once('open',r));
 let id=0;const waiting=new Map();
 ws.on('message',b=>{const m=JSON.parse(b);if(waiting.has(m.id)){waiting.get(m.id)(m);waiting.delete(m.id);}});
 const send=(method,params={})=>new Promise(r=>{const n=++id;waiting.set(n,r);ws.send(JSON.stringify({id:n,method,params}));});
 const evaluate=async expression=>{const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.result.exceptionDetails)throw new Error(JSON.stringify(r.result.exceptionDetails));return r.result.result.value;};
 await send('Page.enable');await send('Page.addScriptToEvaluateOnNewDocument',{source:'window.testErrors=[];window.addEventListener("error",e=>window.testErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.testErrors.push(String(e.reason)));'});await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:base+'/'+q});
 for(let i=0;i<100;i++){if(await evaluate('!!Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="New session")'))break;await sleep(100);}
 assert(await evaluate('!document.querySelector("#agentFilter")'),'agent filter removed');
 assert(await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="New session").textContent==="+"'),'new-session button is just plus');
 assert.equal(await evaluate('shortSessionId("codex:01a08f8a-37fe-7492-a82c-f5480b18874c")'),'01a08f8a','native Codex ID is displayed');
 async function checkHistoryWindow(tail) {
   for (const agent of ['codex','claude']) {
     await evaluate(`window.fixtureRoot=document.createElement('div');fixtureRoot.style.cssText='position:fixed;inset:20px;z-index:99999;height:400px;display:none';document.body.appendChild(fixtureRoot);
       window.fixtureView=createMuxView(fixtureRoot,{bar:false,historyTail:${tail},session:'fixture',snapshot:{state:{agent:${JSON.stringify(agent)},nativeId:'fixture',status:'history'},messages:Array.from({length:100},(_,n)=>({id:'fixture-'+n,role:n%2?'assistant':'user',blocks:[{type:'text',text:'History message '+n+' — '+('test text '.repeat(20))}]}))}});
       fixtureRoot.style.display='flex';fixtureView.onVisible();`);
     await sleep(250);
     assert.equal(await evaluate('fixtureRoot.querySelectorAll(".mx-wrap > .msg").length'),5+tail,'only head and tail rendered for '+agent);
     assert(await evaluate('!!fixtureRoot.querySelector(".hist-gap")'),'older-history controls shown');
     assert(await evaluate('(()=>{var l=fixtureRoot.querySelector(".mx-log");return l.clientHeight>0 && l.scrollHeight-l.clientHeight-l.scrollTop<3})()'),'hidden panel opens at bottom');
     await evaluate('fixtureRoot.querySelector(".mx-wrap").lastElementChild.style.minHeight="500px"');await sleep(150);
     assert(await evaluate('(()=>{var l=fixtureRoot.querySelector(".mx-log");return l.scrollHeight-l.clientHeight-l.scrollTop<3})()'),'late layout growth stays at bottom');
     await evaluate('var fl=fixtureRoot.querySelector(".mx-log");fl.dispatchEvent(new WheelEvent("wheel",{deltaY:-200}));fl.scrollTop-=200;window.readingTop=fl.scrollTop');await sleep(100);
     await evaluate('fixtureRoot.querySelector(".mx-wrap").lastElementChild.style.minHeight="700px"');await sleep(150);
     assert(Math.abs(await evaluate('fixtureRoot.querySelector(".mx-log").scrollTop-readingTop'))<3,'reading position is not pulled down');
     await evaluate('fixtureRoot.querySelector(".hist-gap button").click()');
     assert.equal(await evaluate('fixtureRoot.querySelectorAll(".mx-wrap > .msg").length'),30+tail,'show more reveals 25 messages');
     await evaluate('fixtureRoot.querySelector(".hist-gap button:last-child").click()');
     assert.equal(await evaluate('fixtureRoot.querySelectorAll(".mx-wrap > .msg").length'),100,'show all reveals full history');
     await evaluate('fixtureView.destroy();fixtureRoot.remove()');
   }
 }
 await checkHistoryWindow(25);
 await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.getAttribute("aria-label")==="New session").click()');
 assert(await evaluate('!!document.querySelector("dialog[open]")'),'creation dialog opens');
 await evaluate('document.querySelector("dialog select[name=agent]").value="codex";document.querySelector("dialog input[name=cwd]").value="/tmp/ccbb-codex-control-smoke";document.querySelector("dialog form").requestSubmit()');
 for(let i=0;i<200;i++){if(await evaluate('!document.querySelector("dialog") && !!document.querySelector(".muxv .input-box")'))break;await sleep(100);}
 assert(await evaluate('!document.querySelector("dialog")'),'Codex creation succeeds');
 for(let i=0;i<100;i++){if(await evaluate('document.querySelector(".muxv .sv-foot")?.textContent.includes("Codex")'))break;await sleep(100);}
 assert.deepEqual((await evaluate('window.testErrors')).filter(e=>!e.startsWith('ResizeObserver loop')),[], 'no browser JavaScript errors');
 assert(await evaluate('document.querySelector(".muxv .input-box").dataset.ph.includes("Codex")'),'composer identifies Codex');
 assert(await evaluate('document.querySelector(".muxv .sv-foot").textContent.includes("cost: —")'),'unknown cost is not zero');
 console.log('OK: browser creates Codex thread, connects socket, shows Codex composer and unknown cost');
 // Open real history through the same desktop panel without resuming its runtime.
 await evaluate('openSession('+JSON.stringify('codex:'+historyId)+',null,false,"Codex smoke history")');
 for(let i=0;i<150;i++){if(await evaluate('document.body?.textContent.includes("Shared client works.")'))break;await sleep(100);}
 assert(await evaluate('document.body?.textContent.includes("Shared client works.")'),'saved Codex history renders');
 assert(await evaluate('Array.from(document.querySelectorAll(".muxv .input-area")).some(e=>getComputedStyle(e).display==="none")'),'history composer hidden');
 assert(await evaluate('Array.from(document.querySelectorAll(".status-dot svg")).every(e=>e.getAttribute("fill")==="#fff")'),'Codex marks are white');
 const rename = 'Codex title edit smoke';
 await evaluate('views[views.length-1].el.querySelector(".hdr-title").click()');
 assert(await evaluate('!!document.querySelector(".hdr-title-input")'),'saved Codex title is editable');
 await evaluate('var renameInput=document.querySelector(".hdr-title-input");renameInput.value='+JSON.stringify(rename)+';renameInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
 await sleep(500);
 assert(await evaluate('views[views.length-1].el.querySelector(".hdr-title").textContent==='+JSON.stringify(rename)),'desktop rename succeeds');
 assert.equal((await (await fetch(base+'/api/codex/history/'+historyId)).json()).state.title,rename,'desktop rename persisted');
 await evaluate('toggleMax(views[views.length-1])'); await sleep(200);
 const shot=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('/tmp/ccbb-codex-web.png',Buffer.from(shot.result.data,'base64'));
 console.log('OK: Codex history renders read-only; screenshot /tmp/ccbb-codex-web.png');
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
 await send('Page.navigate',{url:base+'/m/session/'+encodeURIComponent('codex:'+historyId)+q});
 for(let i=0;i<150;i++){if(await evaluate('document.body?.textContent.includes("Shared client works.")'))break;await sleep(100);}
 assert(await evaluate('document.body?.textContent.includes("Shared client works.")'),'mobile Codex history renders');
 assert(await evaluate('getComputedStyle(document.querySelector(".muxv .input-area")).display==="none"'),'mobile history has no composer');
 assert(await evaluate('getComputedStyle(document.querySelector(".phead .dot")).width==="14px"'),'activity circle is 14px');
 assert(await evaluate('!!Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="+ Codex")'),'phone offers Codex creation');
 assert(await evaluate('!document.querySelector("select[data-r=agent]")'),'mobile agent filter removed');
 assert(await evaluate('document.querySelector(".phead .dot svg").getAttribute("fill")==="#fff"'),'mobile Codex mark is white');
 await evaluate('document.querySelector(".phead [data-r=title]").click()');
 assert(await evaluate('!!document.querySelector("input.rename")'),'mobile Codex title is editable');
 await evaluate('var mobileRename=document.querySelector("input.rename");mobileRename.value="Codex web demo";mobileRename.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
 await sleep(500);
 assert.deepEqual((await evaluate('window.testErrors')).filter(e=>!e.startsWith('ResizeObserver loop')),[], 'no mobile JavaScript errors');
 assert.equal((await (await fetch(base+'/api/codex/history/'+historyId)).json()).state.title,'Codex web demo','mobile rename persisted');
 await checkHistoryWindow(10);
 const mobile=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync('/tmp/ccbb-codex-mobile.png',Buffer.from(mobile.result.data,'base64'));
 console.log('OK: phone renders Codex history and offers session creation');
 await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await send('Page.navigate',{url:base+'/mux/s/'+encodeURIComponent('codex:'+historyId)+q});
 for(let i=0;i<100;i++){if(await evaluate('document.querySelector(".mx-bar .label")?.textContent==="Codex web demo"'))break;await sleep(100);}
 await evaluate('document.querySelector(".mx-bar .label").click()');
 assert(await evaluate('!!document.querySelector(".mx-title-input")'),'standalone Codex title is editable');
 await evaluate('var titleInput=document.querySelector(".mx-title-input");titleInput.value="Codex standalone rename";titleInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
 for(let i=0;i<100;i++){if(await evaluate('document.querySelector(".mx-bar .label")?.textContent==="Codex standalone rename"'))break;await sleep(100);}
 assert(await evaluate('document.querySelector(".mx-bar .label").textContent==="Codex standalone rename"'),'standalone rename confirmed');
 await fetch(base+'/api/session/codex:'+historyId,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({title:'Codex web demo'})});
 console.log('OK: desktop, mobile, and standalone Codex title edits persist');
 if(process.env.CCBB_TEST_NATIVE_THREAD){
   const native=process.env.CCBB_TEST_NATIVE_THREAD;
   await send('Page.navigate',{url:base+'/'+q});
   for(let i=0;i<150;i++){if(await evaluate('document.body?.textContent.includes("Review codex.md")'))break;await sleep(100);}
   assert(await evaluate('Array.from(document.querySelectorAll("tr")).some(r=>r.textContent.includes("Review codex.md") && r.querySelector(".live-dot:not(.off)"))'),'native session list shows live');
   await evaluate('openSession('+JSON.stringify('codex:'+native)+',null,false,"Review codex.md")');
   for(let i=0;i<150;i++){if(await evaluate('!!document.querySelector(".status-dot.live")'))break;await sleep(100);}
   assert(await evaluate('!!document.querySelector(".status-dot.live")'),'native session page shows working');
   await sleep(3500);
   assert(await evaluate('!!document.querySelector(".status-dot.live")'),'native activity polling preserves working status');
   assert(await evaluate('getComputedStyle(document.querySelector(".status-dot.live")).width==="14px"'),'desktop activity circle is 14px');
   console.log('OK: native session activity is live in the list and session page');
 }


})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{if(ws)ws.close();child.kill();setTimeout(()=>fs.rmSync(profile,{recursive:true,force:true}),500).unref();});
