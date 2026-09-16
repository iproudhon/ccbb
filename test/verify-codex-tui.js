'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TuiClient } = require('../ccbb-mux-tui');
const { normalizeItem } = require('../ccbb-agent-codex');
function fixture(tty = true) {
  const client = Object.assign(Object.create(TuiClient.prototype), {
    tty, state:{agent:'codex',status:'busy'}, entries:[], codexMessages:new Map(), toolEntries:new Map(),
    streamed:new Set(), bodyShown:new Set(), agents:new Map(), peers:[], collapsed:true,
    width:()=>72, paint(){}, syncBusy(){}, statusLine:{lines:[], update(st){this.last=st;}},
    sink:null, scroll:0, streaming:false,
  });
  return client;
}
function message(c, item, turn = 'turn-1') { c.onEvent({kind:'message',message:normalizeItem(item,turn)}); }
function text(c) { return c.transcriptLines().join('\n').replace(/\x1b\[[0-9;]*m/g,''); }
test('growing Codex prose and reasoning replace one entry and reflow at the current width',()=>{
  const c=fixture();
  for(const value of ['I’ll check','I’ll check the headers','I’ll check the headers, footers, and usage display.']) {
    message(c,{type:'agentMessage',id:'text',text:value});
    assert.equal(c.entries.length,1);
    assert.equal(text(c).match(/I’ll check/g).length,1);
  }
  message(c,{type:'agentMessage',id:'text',text:'I’ll check the headers, footers, and usage display.'});
  assert.equal(c.entries.length,1);
  message(c,{type:'reasoning',id:'thinking',summary:['Inspect']});
  message(c,{type:'reasoning',id:'thinking',summary:['Inspect the renderer']});
  assert.equal(c.entries.length,2);
  assert.equal(text(c).match(/Inspect/g).length,1);
  const wide=text(c);c.width=()=>40;assert(text(c).split('\n').length>wide.split('\n').length);
  message(c,{type:'agentMessage',id:'text',text:'Corrected answer.'});
  assert(!text(c).includes('I’ll check'));assert(text(c).includes('Corrected answer.'));
});
test('Codex init updates state and usage without banners or splitting tool rollups',()=>{
  const c=fixture();
  for(let n=0;n<3;n++) {
    message(c,{type:'commandExecution',id:'cmd'+n,command:'pwd',status:'inProgress'});
    message(c,{type:'commandExecution',id:'cmd'+n,command:'pwd',status:'completed',aggregatedOutput:'/tmp',exitCode:0});
    for(let i=0;i<2;i++)c.onEvent({kind:'init',state:{agent:'codex',model:'gpt-6-astra',status:'idle',turns:n,rateLimits:{primary:{usedPercent:24}}}});
  }
  assert.equal(c.entries.length,3);
  assert(text(c).includes('Ran 3 shell commands'));
  assert(!/manual|0 tools|gpt-6-astra/.test(text(c)));
  assert.equal(c.statusLine.last.rateLimits.primary.usedPercent,24);
});
test('Codex tools retain distinct turn identities and accept authoritative failure updates',()=>{
  const c=fixture();
  const item={type:'commandExecution',id:'cmd',command:'pwd',status:'completed',aggregatedOutput:'/tmp',exitCode:0};
  message(c,item);message(c,item);assert.equal(c.entries.length,1);
  message(c,{...item,aggregatedOutput:'failed',exitCode:1});
  assert.equal(c.entries[0].block.status,'error');assert.equal(c.entries[0].block.result,'failed');
  message(c,item,'turn-2');assert.equal(c.entries.length,2);
});
test('repeated Codex snapshots rebuild the TTY transcript without duplicates',()=>{
  const c=fixture();const snap={state:{agent:'codex',id:'fixture',cwd:'/tmp',status:'idle'},messages:[normalizeItem({type:'agentMessage',id:'text',text:'Hello'},'turn')]};
  c.onSnapshot(snap);const first=text(c);c.onSnapshot(snap);assert.equal(text(c),first);
});
test('pipe output appends only new text and emits completed tools once',()=>{
  const c=fixture(false);let output='';c.raw=s=>{output+=s;};c.out=s=>{if(s!=null)output+=s+'\n';};
  c.endStream=()=>{if(c.streaming)output+='\n';c.streaming=false;};
  for(const value of ['Hello','Hello world','Hello world'])message(c,{type:'agentMessage',id:'text',text:value});
  assert.equal(output.replace(/\x1b\[[0-9;]*m/g,''),'\n⏺ Hello world');
  let calls=0;c.renderToolCall=()=>calls++;
  message(c,{type:'commandExecution',id:'cmd',command:'pwd',status:'inProgress'});
  for(let i=0;i<2;i++)message(c,{type:'commandExecution',id:'cmd',command:'pwd',status:'completed',aggregatedOutput:'/tmp'});
  assert.equal(calls,1);
});
test('Claude init banners and delta final-message suppression retain their existing behavior',()=>{
  const c=fixture();c.state={agent:'claude'};
  c.onEvent({kind:'init',state:{agent:'claude',model:'claude-opus-5',tools:['Bash'],permissionMode:'default'}});
  assert(text(c).includes('1 tools · default'));
  c.streamed.add('api');c.renderMessage({role:'assistant',apiId:'api',blocks:[{type:'text',text:'Already streamed'}]});
  assert(!text(c).includes('Already streamed'));
});
