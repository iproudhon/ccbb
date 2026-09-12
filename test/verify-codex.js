'use strict';

// Live control and transport
{
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
process.env.CCBB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-control-'));
process.env.CLAUDE_CONFIG_DIR = process.env.CCBB_HOME;
const { WebSocketServer } = require('ws');
const { Mux } = require('../ccbb-mux');
const { CodexSocket } = require('../ccbb-codex-session');
const { normalizeItem } = require('../ccbb-agent-codex');
const tick = () => new Promise(r => setTimeout(r, 65));

test('shared socket control, ownership, arbitration, external input, and safe detach', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(r => server.once('listening', r));
  process.env.CCBB_CODEX_ENDPOINT = 'ws://127.0.0.1:' + server.address().port;
  let n = 0, requestN = 100, turns = 0;
  const threads = new Map(), mutations = [], answers = [];
  function publish(id, method, params) { for (const ws of server.clients) if (ws.thread === id) ws.send(JSON.stringify({ method, params: { threadId: id, ...params } })); }
  server.on('connection', ws => ws.on('message', raw => {
    const m = JSON.parse(raw); const p = m.params || {};
    const reply = result => ws.send(JSON.stringify({ id: m.id, result }));
    if (!m.method) { answers.push(m); return; }
    if (m.method === 'initialized') return;
    if (m.method === 'initialize') return reply({ userAgent: 'codex/0.154.0' });
    if (m.method === 'thread/loaded/list') return reply({ data: [...threads.keys()], nextCursor: null });
    if (m.method === 'thread/start') { const id = 'thread-' + ++n; threads.set(id, { id, cwd: '/tmp', turns: [] }); ws.thread = id; mutations.push(m.method); return reply({ thread: threads.get(id), model: 'test-model' }); }
    if (m.method === 'thread/resume') { ws.thread = p.threadId; return reply({ thread: threads.get(p.threadId), model: 'test-model' }); }
    if (m.method === 'thread/read') return reply({ thread: threads.get(p.threadId) });
    if (m.method === 'turn/start') {
      mutations.push(m.method); const turn = { id: 'turn-' + ++turns, items: [], status: 'inProgress' };
      publish(p.threadId, 'turn/started', { turn });
      publish(p.threadId, 'item/started', { turnId: turn.id, item: { id:'msg-'+turn.id, type:'agentMessage', text:'' } });
      publish(p.threadId, 'item/agentMessage/delta', { turnId:turn.id,itemId:'msg-'+turn.id,delta:'hello' });
      reply({ turn }); return;
    }
    if (m.method === 'turn/interrupt') { publish(p.threadId, 'turn/completed', { turn: { id:p.turnId,status:'interrupted',items:[] } }); return reply({}); }
    if (m.method === 'model/list') return reply({data:[{model:'test-model'}]});
    if (m.method === 'thread/name/set' || m.method === 'thread/compact/start') return reply({});
    ws.send(JSON.stringify({id:m.id,error:{code:-32601,message:'unsupported'}}));
  }));
  t.after(async () => { for (const ws of server.clients) ws.terminate(); await new Promise(r=>server.close(r)); fs.rmSync(process.env.CCBB_HOME,{recursive:true,force:true}); });
  const mux = new Mux();
  await assert.rejects(mux.create({ agent:'codex', resume:'unknown' }), /ownership/);
  assert.equal(mux.sessions.size, 0); assert.equal(mutations.length, 0);
  const session = await mux.create({agent:'codex'});
  assert.equal(session.id,'codex:thread-1');
  assert.equal(mux.get('thread-1'),session);
  assert.equal(require('../ccbb-mux').pickSession(mux.list(),'thread-1').id,session.id);
  const again = await mux.create({agent:'codex',resume:session.id}); assert.equal(again,session);
  const native = await new CodexSocket(process.env.CCBB_CODEX_ENDPOINT).connect();
  await native.request('thread/resume',{threadId:session.nativeId});
  await native.request('turn/start',{threadId:session.nativeId,input:[{type:'text',text:'native'}]});
  await tick(); assert.equal(session.state.status,'busy'); assert.equal(session.messages[0].blocks[0].text,'hello');
  const turnId = session.activeTurn;
  publish(session.nativeId,'item/completed',{turnId,item:{id:'msg-'+turnId,type:'agentMessage',text:'hello final'}});
  await tick(); assert.equal(session.messages.length,1); assert.equal(session.messages[0].blocks[0].text,'hello final');
  const controller = { label:'web', kind:'web', send(){} }; session.attach(controller); controller.session=session;
  await mux.onClientOp(controller,{op:'close'}); assert.equal(session.state.status,'busy'); assert.equal(session.rpc.ws.readyState,1);
  function ask(method,params={}) { const id=++requestN; for(const ws of server.clients) if(ws.thread===session.nativeId) ws.send(JSON.stringify({id,method,params:{threadId:session.nativeId,itemId:'same-tool',...params}}));return session.rpc.generation+':'+id; }
  const first=ask('item/commandExecution/requestApproval',{command:'echo hello'}); await tick();
  assert.equal(session.answerPermission(first,true,{},'a').ok,true); assert.equal(session.answerPermission(first,true,{},'b').ok,false);
  await tick(); assert.equal(answers.length,1); assert.deepEqual(answers[0].result,{decision:'accept'});
  const second=ask('item/commandExecution/requestApproval'); await tick();
  publish(session.nativeId,'serverRequest/resolved',{requestId:requestN}); await tick();
  assert.equal(session.answerPermission(second,true,{},'late').ok,false);
  const question=ask('item/tool/requestUserInput',{questions:[{id:'q1',question:'Pick',options:[]}]}); await tick();
  session.answerQuestion(question,{Pick:['A']},'web'); await tick(); assert.deepEqual(answers.at(-1).result,{answers:{q1:{answers:['A']}}});
  ask('unknown/request'); await tick(); assert.equal(answers.at(-1).error.code,-32601);
  await session.interrupt(); await tick(); assert.equal(session.state.status,'idle');
  await session.submit('hello',null,'web'); await tick(); assert.equal(session.state.status,'busy');
  const other = await mux.create({agent:'codex'});
  await session.stop(); await tick(); assert.equal(other.rpc.ws.readyState,1); assert.equal(native.ws.readyState,1);
  assert.equal(session.state.status,'disconnected'); assert.equal(session.pending.size,0);
  await assert.rejects(session.submit('uncertain',null,'web'),/Reconnect/);
  await other.stop(); native.close();
});

test('semantic normalization preserves tools, supplied reasoning, and unknown items', () => {
  assert.equal(normalizeItem({id:'x',type:'commandExecution',command:'false',exitCode:1,status:'completed'},'t').blocks[0].isError,true);
  assert.equal(normalizeItem({id:'x',type:'reasoning',summary:['visible']},'t').blocks[0].text,'visible');
  assert.equal(normalizeItem({id:'x',type:'futureItem',value:'kept'},'t').blocks[0].input.value,'kept');
});

test('generated mux browser JavaScript parses', () => {
  new (require('vm').Script)(require('../ccbb-mux-web').APP_JS);
});

test('attachment restoration requires the original Unix socket identity', async () => {
  const net = require('net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-binding-'));
  const address = path.join(dir, 'server.sock');
  const endpoint = 'unix://' + address;
  const bindings = require('../ccbb-codex-session');
  const oldEndpoint = process.env.CCBB_CODEX_ENDPOINT;
  process.env.CCBB_CODEX_ENDPOINT = endpoint;
  let server = net.createServer();
  await new Promise(r => server.listen(address, r));
  bindings.save({nativeId:'restore-me',rpc:{endpoint},label:'restored'});
  const restored=[];
  await bindings.restore({create:async o=>restored.push(o)});
  assert.equal(restored.length,1);
  await new Promise(r=>server.close(r));
  server=net.createServer();await new Promise(r=>server.listen(address,r));
  await bindings.restore({create:async o=>restored.push(o)});
  assert.equal(restored.length,1,'new server must not silently resume old thread');
  await new Promise(r=>server.close(r));
  process.env.CCBB_CODEX_ENDPOINT=oldEndpoint;
  bindings.forget('restore-me');fs.rmSync(dir,{recursive:true,force:true});
});
}

// Discovery and CLI
{

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CodexRpc } = require('../ccbb-agent-codex');
const { getCodexSessions } = require('../ccbb-agent-codex');
const { periodKey } = require('../ccbb-common');

const fake = path.join(__dirname, 'fake-codex-list.js');
function rpc(mode) {
  return new CodexRpc({ command: process.execPath, args: [fake, mode || 'normal'], timeout: mode === 'hang' ? 100 : 2000 });
}

test('discovery handshakes, pages, deduplicates and preserves unknown usage', async () => {
  const rows = await getCodexSessions(null, rpc());
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sessionKey, 'codex:shared-id');
  assert.equal(rows[0].totalTokens, null);
  assert.equal(rows[0].totalCost, null);
});

test('period scope uses Codex last activity', async () => {
  const period = 'day';
  const rows = await getCodexSessions({ period, key: periodKey(new Date().toISOString(), period) }, rpc());
  assert.equal(rows.length, 2);
});

for (const [mode, error] of [['hang', /timed out/], ['exit', /exited/], ['malformed', /Invalid JSON/], ['error', /unsupported fixture/], ['loop', /pagination cursor/]]) {
  test(`discovery handles ${mode} and closes child`, async () => {
    const client = rpc(mode);
    await assert.rejects(getCodexSessions(null, client), error);
    assert.equal(client.pending.size, 0);
    assert.ok(client.child.killed || client.child.exitCode != null);
  });
}

test('CLI mixed listing, filters, unknown sorting and failure isolation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-list-test-'));
  try {
    const executable = path.join(dir, 'codex');
    fs.copyFileSync(fake, executable);
    fs.chmodSync(executable, 0o755);
    const preload = path.join(dir, 'common-fixture.js');
    const commonPath = require.resolve('../ccbb-common');
    fs.writeFileSync(preload, `
      const common = require(${JSON.stringify(commonPath)});
      common.getSessions = () => {
        if (process.env.FIXTURE_NO_CLAUDE) throw new Error('Claude should not be read');
        return { sessions: [{sessionId:'shared-id', title:'Claude fixture', totalCost:2, totalTokens:100,
          lastActivity:new Date().toISOString(), startedAt:new Date().toISOString()}],
          totals:{totalCost:2,totalTokens:100} };
      };
      common.getCostSummary = () => ({overall:{}});
    `);
    const cli = (args, extra = {}) => spawnSync(process.execPath, ['--require', preload, path.join(__dirname, '../ccbb.js'), 'ls', ...args], {
      env: { ...process.env, PATH: dir + path.delimiter + process.env.PATH, NO_COLOR: '1', ...extra },
      encoding: 'utf8', timeout: 10000,
    });
    let result = cli(['-a', '--sort', 'cost']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Claude fixture/);
    assert.match(result.stdout, /Codex newest/);
    assert.match(result.stdout, /known total \(incomplete\)/);
    assert.ok(result.stdout.indexOf('Claude fixture') < result.stdout.indexOf('Codex newest'));
    result = cli(['--agent=codex', '-a', '-x'], { FIXTURE_NO_CLAUDE: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Claude fixture|\$0\.00/);
    assert.match(result.stdout, /3 sessions/);
    assert.match(result.stdout, /Some Codex usage or prices are unavailable/);
    result = cli(['--agent', 'claude'], { PATH: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /Codex|AGENT/);
    result = cli(['--agent', 'wrong']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--agent must be/);
    result = cli(['--agent']);
    assert.equal(result.status, 1);
    fs.unlinkSync(executable);
    result = cli(['-a'], { PATH: dir });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Claude fixture/);
    assert.match(result.stderr, /Codex sessions unavailable/);
    result = cli(['--agent', 'codex'], { PATH: dir });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ENOENT/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
}

// Usage accounting
{

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCodexUsage, priceUsage, summarizeCodex } = require('../ccbb-agent-codex');
const { periodKey } = require('../ccbb-common');

const before = '2026-08-10T12:00:00Z', after = '2026-09-10T12:00:00Z';
const meta = (extra = {}) => ({ type: 'session_meta', payload: {
  id: 'fixture', cli_version: '0.154.0-alpha.6.1', model_provider: 'openai', ...extra,
} });
const context = model => ({ type: 'turn_context', payload: { model } });
const usage = (input, cached, output, reasoning = 0, write = 0) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write,
  output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
});
const event = (timestamp, total, last = total) => ({ timestamp, type: 'event_msg', payload: {
  type: 'token_count', info: { total_token_usage: total, last_token_usage: last, model_context_window: 258400 },
} });
const first = usage(1000, 800, 100, 40);
const second = usage(1500, 1100, 150, 60);
const last = usage(500, 300, 50, 20);

async function read(records, filter = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-usage-'));
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, records.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  try { return await readCodexUsage({ id: 'fixture', path: file }, filter); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('cumulative usage is counted once, with cache and reasoning included correctly', async () => {
  const result = await read([meta(), context('gpt-6-astra'), event(before, first),
    event(before, first), event(after, second, last)]);
  assert.equal(result.totalTokens, 1650);
  assert.equal(result.inputTokens, 400);
  assert.equal(result.cacheReadTokens, 1100);
  assert.equal(result.outputTokens, 150);
  assert.equal(result.reasoningOutputTokens, 60);
  assert.equal(result.turns, 2);
  assert.ok(Math.abs(result.totalCost - 0.0126) < 1e-10);
  assert.equal(result.context.tokens, 550);
  assert.equal(result.contextMax.tokens, 1100);
  assert.equal(result.contextWindow, 258400);
  assert.equal(result.cacheMissTokens, null);
});

test('period totals use deltas across the boundary and the model for each request', async () => {
  const result = await read([meta(), context('gpt-6-astra'), event(before, first),
    context('gpt-5.5'), event(after, second, last)], { period: 'month', key: periodKey(after, 'month') });
  assert.equal(result.totalTokens, 550);
  assert.equal(result.turns, 1);
  assert.ok(Math.abs(result.totalCost - 0.00265) < 1e-10);
});

test('compaction context-only snapshots preserve spending and update context', async () => {
  const compacted = { ...usage(0, 0, 0), total_tokens: 120 };
  const records = [meta(), context('gpt-6-astra'), event(before, first),
    { type: 'compacted', payload: {} }, event(after, first, compacted)];
  const result = await read(records);
  assert.equal(result.totalTokens, 1100);
  assert.equal(result.turns, 1);
  assert.equal(result.context.tokens, 120);
  assert.equal(result.contextMax.tokens, 1100);
  assert.equal(result.lastAssistantAt, before);
  assert.ok(result.totalCost > 0);
  const continued = await read([...records, event(after, second, last)]);
  assert.equal(continued.totalTokens, 1650);
  assert.equal(continued.turns, 2);
  assert.equal(continued.context.tokens, 550);
  // Context-only counters cannot explain an increase in cumulative spending.
  assert.equal(await read([meta(), event(before, first), event(after, second, compacted)]), null);
});

test('fork excludes copied spending before its creation', async () => {
  assert.equal(await read([meta({ forked_from_id: 'parent', timestamp: after }), context('gpt-6-astra'), event(after, second, last)]), null, 'unknown inherited baseline is not billed to the fork');
  const result = await read([meta({ forked_from_id: 'parent', timestamp: after }),
    context('gpt-6-astra'), event(before, first), event(after, second, last)]);
  assert.equal(result.totalTokens, 550);
  assert.equal(result.turns, 1);
});

test('unknown models and custom providers retain tokens without inventing cost', async () => {
  for (const [provider, model] of [['openai', 'future-model'], ['local', 'gpt-6-astra']]) {
    const result = await read([meta({ model_provider: provider }), context(model), event(after, first)]);
    assert.equal(result.totalTokens, 1100);
    assert.equal(result.totalCost, null);
    const total = summarizeCodex([result]);
    assert.equal(total.incomplete, true);
    assert.equal(total.knownCost, false);
    assert.equal(total.tokens, 1100);
  }
});

test('unreadable, mismatched, unsupported and reset histories stay unknown', async () => {
  assert.equal(await readCodexUsage({ path: '/nonexistent/ccbb-rollout' }), null);
  for (const records of [
    [meta({ id: 'different' }), event(after, first)],
    [meta({ cli_version: '0.999.0' }), event(after, first)],
    [meta(), event(before, second), event(after, first)],
    [meta(), 'broken record', event(after, first)],
    [meta()],
  ]) assert.equal(await read(records), null);
});

test('complete response ledger includes compaction once and respects period boundaries', async () => {
  const entry = (timestamp,u,total) => ({timestamp,type:'token_usage_record',payload:{usage:u,thread_token_usage:total}});
  const result = await read([meta(),context('gpt-6-astra'),entry(before,first,first),event(before,first),
    entry(after,last,second),entry(after,last,second),{type:'compacted',payload:{}},
    event(after,first,{...usage(0,0,0),total_tokens:120})]);
  assert.equal(result.totalTokens,1650);
  assert.equal(result.turns,2);
  assert.equal(result.context.tokens,120);
  assert.ok(Math.abs(result.totalCost-0.0126)<1e-10);
  const scoped=await read([meta(),context('gpt-6-astra'),entry(before,first,first),event(before,first),entry(after,last,second)],
    {period:'month',key:periodKey(after,'month')});
  assert.equal(scoped.totalTokens,550);
  const partial=await read([meta(),context('gpt-6-astra'),event(before,first),entry(after,last,second),event(after,second,last)]);
  assert.equal(partial.totalTokens,1650);
  assert.equal(partial.totalCost,null,'partial accounting is never priced as complete');
});

test('standard API estimate handles cache writes and long context', () => {
  const costs = priceUsage(usage(300000, 100000, 1000, 300, 10000), 'gpt-6-astra', 'openai');
  assert.deepEqual(costs, { input: 3.8, cacheRead: 0.2, cacheWrite: 0.25, output: 0.075 });
});

test('known aggregates remain marked incomplete when another row has no records', async () => {
  const result = await read([meta(), context('gpt-6-astra'), event(after, first)]);
  const total = summarizeCodex([result, {}]);
  assert.equal(total.tokens, 1100);
  assert.equal(total.incomplete, true);
  assert.equal(total.knownCost, true);
});
}

// HTTP and WebSocket authorization
{
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const { spawn } = require('child_process');
const WebSocket = require('ws');

test('read-only users can browse Codex history but cannot create or control sessions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-codex-auth-'));
  fs.writeFileSync(path.join(dir, 'ccbb-config.json'), JSON.stringify({peerToken:'fixture-write',readToken:'fixture-read'}));
  const browserModule = require.resolve('../ccbb-agent-codex');
  const preload = path.join(dir, 'preload.js');
  fs.writeFileSync(preload, `require.cache[${JSON.stringify(browserModule)}]={exports:{...require(${JSON.stringify(browserModule)}),cached:()=>[],renameCodexThread:async(id,name)=>{if(id!=='example'||name!=='Renamed')throw new Error('Wrong rename parameters');},history:async()=>({state:{agent:'codex'},messages:[]})}};`);
  const listener = net.createServer(); await new Promise(r=>listener.listen(0,'127.0.0.1',r));
  const port=listener.address().port; await new Promise(r=>listener.close(r));
  const child=spawn(process.execPath,['--require',preload,require.resolve('../ccbb-web'),'-p',String(port)],{env:{...process.env,CLAUDE_CONFIG_DIR:dir,CCBB_HOME:dir},stdio:'ignore'});
  t.after(async()=>{child.kill();await new Promise(r=>child.once('exit',r));fs.rmSync(dir,{recursive:true,force:true});});
  const url='http://127.0.0.1:'+port, headers={'x-ccbb-token':'fixture-read'};
  for(let i=0;i<100;i++){try{await fetch(url+'/api/identity',{headers});break;}catch{await new Promise(r=>setTimeout(r,50));}}
  assert.equal((await fetch(url+'/api/codex/history/example',{headers})).status,200);
  const rename = {method:'PATCH',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({title:'Renamed'})};
  assert.equal((await fetch(url+'/api/session/codex:example',rename)).status,403);
  assert.equal((await fetch(url+'/api/session/codex:example',{...rename,headers:{...rename.headers,'x-ccbb-token':'fixture-write'}})).status,200);

  assert.equal((await fetch(url+'/mux/api/sessions',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({agent:'codex'})})).status,403);
  const socket=new WebSocket('ws://127.0.0.1:'+port+'/mux/mux?session=codex:example',{headers});
  const refused=await new Promise(resolve=>{socket.on('open',()=>resolve(false));socket.on('error',()=>resolve(true));socket.on('unexpected-response',(_,res)=>{res.resume();resolve(true);});});
  assert.equal(refused,true);socket.terminate();
});
}

{
const test = require('node:test');
const assert = require('node:assert/strict');
const { renameCodexThread } = require('../ccbb-agent-codex');
test('saved Codex rename sets the name without resuming a thread and closes RPC', async () => {
  const calls = [];
  const rpc = {initialize:async()=>calls.push('initialize'), request:async(method,params)=>calls.push([method,params]),close:()=>calls.push('close')};
  await renameCodexThread('saved-thread','New title',rpc);
  assert.deepEqual(calls,['initialize',['thread/name/set',{threadId:'saved-thread',name:'New title'}],'close']);
  rpc.request=async()=>{throw new Error('Rename refused');};
  await assert.rejects(renameCodexThread('saved-thread','New title',rpc),/Rename refused/);
  assert.equal(calls.at(-1),'close');
});
}

{
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { nativeRollouts, nativeActivity } = require('../ccbb-agent-codex');
test('native Codex activity requires a writable owner and follows turn lifecycle', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-native-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const id = '01a08f8a-37fe-7492-a82c-f5480b18874c';
  const rollout = path.join(dir, 'rollout-2026-09-11T01-16-35-'+id+'.jsonl');
  const base = path.join(dir,'123');
  fs.mkdirSync(path.join(base,'fd'),{recursive:true});
  fs.mkdirSync(path.join(base,'fdinfo'));
  fs.symlinkSync('/vendor/codex',path.join(base,'exe'));
  fs.symlinkSync(rollout,path.join(base,'fd','7'));
  fs.writeFileSync(path.join(base,'fdinfo','7'),'flags:\t0100000\n');
  const event = type => JSON.stringify({type:'event_msg',payload:{type}})+'\n';
  fs.writeFileSync(rollout,event('task_started'));
  assert.equal(nativeRollouts(dir).size,0,'read-only viewers do not establish ownership');
  fs.writeFileSync(path.join(base,'fdinfo','7'),'flags:\t0102001\n');
  const owners = nativeRollouts(dir);
  assert.equal(owners.get(id),rollout);
  assert.deepEqual(nativeActivity(id,owners),{live:true,liveStatus:'busy'});
  fs.appendFileSync(rollout,event('task_complete'));
  assert.deepEqual(nativeActivity(id,owners),{live:true,liveStatus:'idle'});
  fs.appendFileSync(rollout,event('task_started')+'{"partial":');
  assert.equal(nativeActivity(id,owners).liveStatus,'busy');
  assert.deepEqual(nativeActivity(id,new Map()),{live:false,liveStatus:null},'stale logs cannot prove liveness');
  fs.unlinkSync(path.join(base,'exe'));fs.symlinkSync('/vendor/editor',path.join(base,'exe'));
  assert.equal(nativeRollouts(dir).size,0,'non-Codex processes are excluded');
});
}

{
const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexSession } = require('../ccbb-codex-session');
test('early turn completion does not strand queued input or resurrect a finished turn', async () => {
  const session = Object.create(CodexSession.prototype);
  Object.assign(session,{queue:[{text:'first'},{text:'second'}],inputAuthors:new Map(),completedTurns:new Set(),opt:{},state:{status:'idle'},nativeId:'fixture',emit:()=>{}});
  let starts=0;
  session.rpc={request:async()=>{const id='turn-'+ ++starts;session.completedTurns.add(id);return {turn:{id,status:'inProgress'}};}};
  await session.drain(); await new Promise(r=>setImmediate(r));
  assert.equal(starts,2); assert.equal(session.queue.length,0);assert.ok(!session.activeTurn);
  session.queue=[{text:'uncertain'},{text:'must not follow'}];
  session.rpc.request=async()=>{throw new Error('Timed out');};
  await assert.rejects(session.drain(),/Timed out/);assert.equal(session.queue.length,0);
});
}
