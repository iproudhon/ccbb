'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http'), net = require('net'), crypto = require('crypto');
const { once } = require('events');
const WS = require('ws');
const { ForwardProxy, publicAddress } = require('../ccbb-proxy');
const closed = socket => new Promise(resolve => socket.once('close', resolve));
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
async function fixture(t, reverse = false) {
  const nodes = ['Node1', 'Node2', 'Node3'].map(name => {
    const links = new Map(), cfg = { enabled: true, exitNode: 'Node2', ...(reverse ? { allowInboundExit: true } : {}) };
    const proxy = new ForwardProxy({ config: () => cfg, identity: () => name, findLink: n => links.get(n) });
    const server = http.createServer((req, res) => proxy.handles(req) ? proxy.request(req, res) : res.end('CCBB UI'));
    server.on('connect', (req, s, head) => proxy.connect(req, s, head));
    server.on('upgrade', (req, s, head) => proxy.upgrade(req, s, head));
    return { name, cfg, links, proxy, server };
  });
  for (const n of nodes) n.port = await listen(n.server);
  const connections = [], servers = [];
  async function link(a, b) {
    const server = new WS.Server({ host: '127.0.0.1', port: 0 }); servers.push(server);
    await once(server, 'listening');
    const accepted = once(server, 'connection');
    const client = new WS('ws://127.0.0.1:' + server.address().port); connections.push(client);
    const [incoming] = await accepted; connections.push(incoming);
    await once(client, 'open');
    for (const [node, name, ws] of [[a, b.name, client], [b, a.name, incoming]]) {
      const l = { name, ws, inbound: ws === incoming }; node.links.set(name, l); node.proxy.attachLink(l);
      ws.on('message', raw => node.proxy.handleFrame(l, JSON.parse(raw)));
    }
  }
  await link(...(reverse ? [nodes[1], nodes[0]] : [nodes[0], nodes[1]]));
  await link(nodes[1], nodes[2]);
  t.after(() => {
    for (const n of nodes) { n.proxy.close(); n.server.closeAllConnections(); n.server.close(); }
    for (const ws of connections) ws.terminate();
    for (const s of servers) s.close();
  });
  return nodes;
}
function request(port, url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method: opts.method || 'GET', headers: opts.headers || {}, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    }); req.on('error', reject); req.end(opts.body);
  });
}
async function origin(t, handler) {
  const server = http.createServer(handler); const port = await listen(server);
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { server, port, url: 'http://127.0.0.1:' + port };
}
for (const reverse of [false, true]) test(`shared port, HTTP binary streaming exits Node2 via ${reverse ? 'inbound' : 'outbound'} link`, { timeout: 15000 }, async t => {
  const [a, b, c] = await fixture(t, reverse);
  const data = Buffer.alloc(1024 * 1024); for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const dest = await origin(t, (req, res) => {
    assert.equal(req.headers.host, '127.0.0.1:' + dest.port);
    assert.equal(req.headers['proxy-authorization'], undefined);
    assert.equal(req.headers['x-ccbb-token'], undefined);
    assert.equal(req.headers['x-strip'], undefined);
    assert.equal(req.headers.cookie, 'site=ok');
    res.setHeader('Set-Cookie', 'site=next'); req.pipe(res);
  });
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [dest.port], allowPrivate: true });
  a.cfg.username = 'browser'; a.cfg.password = 'secret';
  let dials = 0; const dial = b.proxy.dial.bind(b.proxy); b.proxy.dial = d => { dials++; return dial(d); };
  assert.equal((await request(a.port, '/')).body.toString(), 'CCBB UI');
  const r = await request(a.port, dest.url + '/upload', { method: 'POST', body: data, headers: {
    host: 'wrong.example', 'proxy-authorization': 'Basic ' + Buffer.from('browser:secret').toString('base64'),
    'x-ccbb-token': 'private', connection: 'close, x-strip', 'x-strip': 'remove', cookie: 'site=ok; ccbb_token_8590=private'
  } });
  assert.equal(r.status, 200); assert.deepEqual(r.body, data); assert.equal(dials, 1);
  assert.equal(c.proxy.active.size, 0); assert.deepEqual(r.headers['set-cookie'], ['site=next']);
});
test('authentication, disabled exit, unknown exit, private-address policy and link failure fail closed', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const dest = await origin(t, (req, res) => res.end('should not reach'));
  a.cfg.username = 'user'; a.cfg.password = 'pass';
  let r = await request(a.port, dest.url);
  assert.equal(r.status, 407); assert.match(r.headers['proxy-authenticate'], /^Basic/);
  delete a.cfg.username; delete a.cfg.password;
  assert.equal((await request(a.port, dest.url)).status, 403);
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [dest.port] });
  assert.equal((await request(a.port, dest.url)).status, 403);
  b.cfg.allowPrivate = true; b.cfg.allowedPorts = [443];
  assert.equal((await request(a.port, dest.url)).status, 403);
  a.cfg.exitNode = 'Node3';
  assert.equal((await request(a.port, dest.url)).status, 503, 'no implicit peers-of-peers route');
  a.cfg.exitNode = 'Node2'; a.links.get('Node2').ws.terminate();
  assert.equal((await request(a.port, dest.url)).status, 503);
});
test('an exit that dialed in is used only with allowInboundExit', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t, true);
  const dest = await origin(t, (req, res) => res.end('inbound exit'));
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [dest.port], allowPrivate: true });
  assert.equal(a.links.get('Node2').inbound, true);
  delete a.cfg.allowInboundExit;
  const r = await request(a.port, dest.url);
  assert.equal(r.status, 403); assert.match(r.body.toString(), /allowInboundExit/);
  a.cfg.allowInboundExit = true;
  assert.equal((await request(a.port, dest.url)).body.toString(), 'inbound exit');
});
test('CONNECT preserves early bytes, binary traffic and half-close', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t, true);
  const echo = net.createServer({ allowHalfOpen: true }, s => s.pipe(s));
  const port = await listen(echo); t.after(() => echo.close());
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [port], allowPrivate: true });
  const s = net.connect(a.port, '127.0.0.1'); t.after(() => s.destroy());
  await once(s, 'connect');
  const chunks = []; s.on('data', c => chunks.push(c));
  const data = Buffer.alloc(200000, 173);
  s.write(Buffer.concat([Buffer.from(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: ignored\r\n\r\n`), data]));
  s.end(); await once(s, 'end');
  const all = Buffer.concat(chunks), split = all.indexOf('\r\n\r\n');
  assert.match(all.subarray(0, split).toString(), /200 Connection Established/);
  assert.deepEqual(all.subarray(split + 4), data);
});
test('plain WebSocket upgrades traverse the exit link', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const origin = new WS.Server({ host: '127.0.0.1', port: 0 }); await once(origin, 'listening');
  t.after(() => origin.close()); origin.on('connection', s => s.on('message', (d, binary) => s.send(d, { binary })));
  const port = origin.address().port;
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [port], allowPrivate: true });
  const agent = new http.Agent();
  agent.createConnection = () => net.connect(a.port, '127.0.0.1');
  const add = agent.addRequest;
  agent.addRequest = function(req, opts) { req.path = `http://127.0.0.1:${port}/echo`; return add.call(this, req, opts); };
  const client = new WS(`ws://127.0.0.1:${port}/echo`, { agent });
  t.after(() => agent.destroy());
  t.after(() => client.terminate());
  await once(client, 'open'); client.send('hello');
  assert.equal((await once(client, 'message'))[0].toString(), 'hello'); client.close();
});
test('address policy covers loopback, LAN, link-local, mapped IPv4 and IPv6', () => {
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2002:7f00:1::', '2001:0:123::1', '2001:db8::1']) assert.equal(publicAddress(ip), false, ip);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicAddress(ip), true, ip);
});

test('HTTPS stays end-to-end through CONNECT with the origin certificate', { timeout: 15000 }, async t => {
  const fs = require('fs'), os = require('os'), path = require('path'), tls = require('tls');
  const { execFileSync } = require('child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-proxy-tls-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost', '-keyout', path.join(dir, 'key'), '-out', path.join(dir, 'cert')], { stdio: 'ignore' });
  const cert = fs.readFileSync(path.join(dir, 'cert'));
  const origin = require('https').createServer({ key: fs.readFileSync(path.join(dir, 'key')), cert }, (req, res) => res.end('TLS origin'));
  const port = await listen(origin); t.after(() => { origin.closeAllConnections(); origin.close(); });
  const [a, b] = await fixture(t);
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [port], allowPrivate: true });
  const req = http.request({ host: '127.0.0.1', port: a.port, method: 'CONNECT', path: '127.0.0.1:' + port });
  req.end(); const [res, socket] = await once(req, 'connect'); assert.equal(res.statusCode, 200);
  const secure = tls.connect({ socket, servername: 'localhost', ca: cert }); t.after(() => secure.destroy());
  await once(secure, 'secureConnect'); assert.equal(secure.authorized, true);
  assert.deepEqual(secure.getPeerCertificate().raw, new (require('crypto').X509Certificate)(cert).raw);
  const chunks = []; secure.on('data', c => chunks.push(c));
  secure.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  await once(secure, 'end'); assert.match(Buffer.concat(chunks).toString(), /TLS origin/);
});

test('actual ccbb web servers share UI/proxy port and use an authenticated reverse peer link', { timeout: 20000 }, async t => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { spawn } = require('child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccbb-proxy-web-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(child => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      child.once('exit', resolve); child.kill();
    })));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dest = await origin(t, (req, res) => res.end('actual relay works'));
  const ports = [];
  for (let i = 0; i < 2; i++) { const s = net.createServer(); ports.push(await listen(s)); await new Promise(r => s.close(r)); }
  const proxyAuth = 'Basic ' + Buffer.from('browser:fixture-proxy').toString('base64');
  const configs = [
    { server: { name: 'Node1' }, peerToken: 'fixture-peer1', readToken: 'fixture-read',
      proxy: { enabled: true, exitNode: 'Node2', allowInboundExit: true, username: 'browser', password: 'fixture-proxy' } },
    { server: { name: 'Node2' }, peerToken: 'fixture-peer2',
      peers: [{ name: 'Node1', url: 'http://127.0.0.1:' + ports[0], token: 'fixture-peer1' }],
      proxy: { allowExit: true, allowedPorts: [dest.port], allowPrivate: true } }
  ];
  for (let i = 0; i < 2; i++) {
    const dir = path.join(root, String(i)); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'ccbb-config.json'), JSON.stringify(configs[i]));
    // No shell/tmux operations or account-backed discovery in this network fixture.
    const preload = path.join(dir, 'preload.js');
    fs.writeFileSync(preload, `const c=require(${JSON.stringify(require.resolve('../ccbb-common'))});c.tmux=()=>'';const a=require(${JSON.stringify(require.resolve('../ccbb-agent-codex'))});a.cached=()=>[];const dns=require('dns').promises,lookup=dns.lookup;dns.lookup=(host,opts)=>host==='exit-only.invalid'?(${i}===1?Promise.resolve([{address:'127.0.0.1',family:4}]):Promise.reject(new Error('DNS must run only on Node2'))):lookup(host,opts);`);
    const child = spawn(process.execPath, ['--require', preload, require.resolve('../ccbb-web'), '-p', String(ports[i])], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CCBB_HOME: dir }, stdio: 'ignore'
    }); children.push(child);
    let ready = false;
    for (let n = 0; n < 100; n++) {
      try { ready = (await request(ports[i], '/api/identity', { headers: { 'x-ccbb-token': configs[i].peerToken } })).status === 200; } catch {}
      if (ready) break; await new Promise(r => setTimeout(r, 50));
    }
    assert(ready, 'fixture server starts');
  }
  let result;
  for (let n = 0; n < 100; n++) {
    result = await request(ports[0], dest.url.replace('127.0.0.1', 'exit-only.invalid'), { headers: { 'proxy-authorization': proxyAuth } });
    if (result.status === 200) break; await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(result.status, 200, result.body.toString()); assert.equal(result.body.toString(), 'actual relay works');
  assert.equal((await request(ports[0], '/', { headers: { 'x-ccbb-token': 'fixture-read' } })).status, 200);
  assert.equal((await request(ports[0], dest.url, { headers: { 'x-ccbb-token': 'fixture-read' } })).status, 407);
  assert.equal((await request(ports[0], '/api/identity', { headers: { 'proxy-authorization': proxyAuth } })).status, 401);
  // Malformed live config must disable proxy access, not become unauthenticated.
  fs.writeFileSync(path.join(root, '0', 'ccbb-config.json'), '{broken');
  assert.equal((await request(ports[0], dest.url, { headers: { 'proxy-authorization': proxyAuth } })).status, 403);
});

test('losing an active relay closes the tunnel and clears connection state', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const sockets = new Set();
  const server = net.createServer(s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); s.resume(); });
  const port = await listen(server);
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [port], allowPrivate: true });
  const req = http.request({ host: '127.0.0.1', port: a.port, method: 'CONNECT', path: '127.0.0.1:' + port });
  req.end(); const [response, socket] = await once(req, 'connect');
  assert.equal(response.statusCode, 200); t.after(() => socket.destroy()); socket.resume();
  socket.on('error', () => {}); const gone = closed(socket); a.links.get('Node2').ws.terminate(); await gone;
  for (let i = 0; i < 100 && (b.proxy.count() || sockets.size); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(a.proxy.count(), 0); assert.equal(b.proxy.count(), 0); assert.equal(sockets.size, 0);
});

async function connectTunnel(t, port, authority) {
  const req = http.request({ host: '127.0.0.1', port, method: 'CONNECT', path: authority });
  req.end(); const [response, socket, head] = await once(req, 'connect');
  assert.equal(response.statusCode, 200); if (head.length) socket.unshift(head);
  socket.on('error', () => {}); t.after(() => socket.destroy()); return socket;
}
function pacedRead(socket) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setInterval(() => { const chunk = socket.read(64 * 1024); if (chunk) chunks.push(chunk); }, 2);
    socket.on('end', () => { clearInterval(timer); resolve(Buffer.concat(chunks)); });
    socket.on('error', reject);
    socket.on('close', () => { clearInterval(timer); if (!socket.readableEnded) reject(new Error('Premature close')); });
  });
}
for (const direction of ['upload', 'download']) test(`paced 16 MiB ${direction} survives graceful half-close without truncation`, { timeout: 20000 }, async t => {
  const [a, b] = await fixture(t);
  const data = Buffer.alloc(16 * 1024 * 1024); for (let i = 0; i < data.length; i++) data[i] = i % 251;
  const sockets = new Set(); let received;
  let connected; const accepted = new Promise(resolve => { connected = resolve; });
  const server = net.createServer({ allowHalfOpen: true }, s => {
    sockets.add(s); s.on('close', () => sockets.delete(s));
    if (direction === 'upload') { received = pacedRead(s); s.end(); }
    else { s.resume(); s.end(data); }
    connected();
  });
  const port = await listen(server); t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [port], allowPrivate: true });
  const client = await connectTunnel(t, a.port, '127.0.0.1:' + port); await accepted;
  if (direction === 'upload') { client.resume(); client.end(data); }
  else { received = pacedRead(client); client.end(); }
  assert.deepEqual(await received, data);
});

test('exit tries every checked address within one open deadline', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const dest = await origin(t, (req, res) => res.end('second address'));
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [dest.port], allowPrivate: true });
  b.proxy.openTimeout = 800; a.proxy.openTimeout = 5000;
  const attempts = [];
  b.proxy.lookup = async () => [{ address: '198.51.100.1', family: 4 }, { address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }];
  b.proxy.connectSocket = opts => { attempts.push(opts.host); return opts.host === '198.51.100.1' ? new net.Socket() : net.connect(opts); };
  const started = Date.now();
  const r = await request(a.port, 'http://multi.invalid:' + dest.port + '/');
  assert.equal(r.status, 200); assert.equal(r.body.toString(), 'second address');
  assert.deepEqual(attempts, ['198.51.100.1', '127.0.0.2', '127.0.0.1'], 'black hole, refused, then success');
  assert(Date.now() - started < 800, 'a black-holed address only spends its share of the budget');
  attempts.length = 0;
  b.proxy.lookup = async () => [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.3', family: 4 }];
  assert.equal((await request(a.port, 'http://dead.invalid:' + dest.port + '/')).status, 502);
  assert.deepEqual(attempts, ['127.0.0.2', '127.0.0.3']);
  assert.equal(b.proxy.count(), 0); assert.equal(b.proxy.active.size, 0);
});

test('a refused WebSocket upgrade relays the origin status and body', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const dest = await origin(t, (req, res) => res.end('plain'));
  dest.server.on('upgrade', (req, socket) => socket.on('error', () => {}).end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Reason: no-ws\r\nContent-Length: 4\r\n\r\nnope'));
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [dest.port], allowPrivate: true });
  const s = net.connect(a.port, '127.0.0.1'); t.after(() => s.destroy()); await once(s, 'connect');
  const chunks = []; s.on('data', c => chunks.push(c));
  s.write(`GET ${dest.url}/ws HTTP/1.1\r\nHost: 127.0.0.1:${dest.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await once(s, 'end');
  const text = Buffer.concat(chunks).toString();
  assert.match(text, /^HTTP\/1\.1 403 Forbidden\r\n/); assert.match(text, /\r\nx-reason: no-ws\r\n/i); assert.match(text, /\r\n\r\nnope$/);
});

test('exitNode naming this server egresses locally without a peer link', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const dest = await origin(t, (req, res) => res.end('local exit'));
  Object.assign(a.cfg, { exitNode: 'Node1', allowedPorts: [dest.port], allowPrivate: true });
  assert.equal((await request(a.port, dest.url)).status, 403, 'local exit still requires allowExit');
  a.cfg.allowExit = true;
  let dials = 0; b.proxy.dial = () => { dials++; throw new Error('Node2 must not be used'); };
  assert.equal((await request(a.port, dest.url)).body.toString(), 'local exit');
  assert.equal(dials, 0); assert.equal(a.proxy.channels.get(a.links.get('Node2')).size, 0);
  for (let i = 0; i < 100 && a.proxy.count(); i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(a.proxy.count(), 0);
});

async function echoServer(t, host = '127.0.0.1') {
  const sockets = new Set();
  const server = net.createServer({ allowHalfOpen: true }, s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); s.pipe(s); });
  server.listen(0, host); await once(server, 'listening');
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  return { port: server.address().port, sockets };
}
async function settled(nodes, extra = () => 0) {
  for (let i = 0; i < 200 && (nodes.some(n => n.proxy.count() || n.proxy.active.size) || extra()); i++) await new Promise(r => setTimeout(r, 10));
  for (const n of nodes) { assert.equal(n.proxy.count(), 0, n.name + ' slots'); assert.equal(n.proxy.active.size, 0, n.name + ' sockets'); }
  assert.equal(extra(), 0);
}
test('unknown or malformed proxy frames are ignored; invalid chunks tear down only that tunnel', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const echo = await echoServer(t);
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [echo.port], allowPrivate: true });
  const ws = a.links.get('Node2').ws, other = crypto.randomUUID();
  const client = await connectTunnel(t, a.port, '127.0.0.1:' + echo.port);
  const [id] = a.proxy.channels.get(a.links.get('Node2')).keys();
  for (const f of [{ t: 'proxy-data', id: 'nope', data: 'AAAA' }, { t: 'proxy-data', id: other, data: 'AAAA' }, { t: 'proxy-ack', id: other },
    { t: 'proxy-end' }, { t: 'proxy-close', id: 42 }, { t: 'proxy-open', id: 'x/../y', host: '127.0.0.1', port: echo.port }, { t: 'proxy-bogus', id }])
    ws.send(JSON.stringify(f));
  client.write('still alive'); const [reply] = await once(client, 'data'); assert.equal(reply.toString(), 'still alive');
  ws.send(JSON.stringify({ t: 'proxy-data', id, data: Buffer.alloc(32 * 1024 + 1).toString('base64') }));
  await closed(client); assert.equal(client.readableEnded, false, 'reset, not a clean end');
  await settled([a, b], () => echo.sockets.size);
  ws.send(JSON.stringify({ t: 'proxy-open', id: other, host: '127.0.0.1', port: echo.port }));
  const opened = new Promise(resolve => ws.once('message', raw => resolve(JSON.parse(raw))));
  assert.deepEqual(await opened, { t: 'proxy-ready', id: other });
  ws.send(JSON.stringify({ t: 'proxy-end', id: other })); ws.send(JSON.stringify({ t: 'proxy-data', id: other, data: 'AAAA' }));
  const aborted = new Promise(resolve => ws.on('message', raw => { const f = JSON.parse(raw); if (f.t === 'proxy-close') resolve(f); }));
  assert.equal((await aborted).id, other, 'data after end aborts the channel');
  await settled([a, b], () => echo.sockets.size);
});

test('client abort and destination close mid-transfer release both ends', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const sockets = new Set(); let accept;
  const server = net.createServer(s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); accept(s); });
  const port = await listen(server); t.after(() => { for (const s of sockets) s.destroy(); server.close(); });
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [port], allowPrivate: true });
  let dest = new Promise(r => { accept = r; });
  let client = await connectTunnel(t, a.port, '127.0.0.1:' + port); let ds = await dest;
  // The destination is not reading, so the abort lands mid-transfer under backpressure.
  client.write(Buffer.alloc(4 * 1024 * 1024)); await new Promise(r => setTimeout(r, 50));
  client.destroy(); ds.resume(); await closed(ds);
  await settled([a, b], () => sockets.size);
  dest = new Promise(r => { accept = r; });
  client = await connectTunnel(t, a.port, '127.0.0.1:' + port); ds = await dest;
  const chunks = []; client.on('data', c => chunks.push(c)); client.on('error', () => {});
  ds.write('bye'); ds.destroy();
  await closed(client); assert.equal(Buffer.concat(chunks).toString(), 'bye');
  await settled([a, b], () => sockets.size);
});

test('concurrent tunnels interleave on one link without mixing streams', { timeout: 20000 }, async t => {
  const [a, b] = await fixture(t);
  const echo = await echoServer(t);
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [echo.port], allowPrivate: true });
  await Promise.all(Array.from({ length: 8 }, async (_, n) => {
    const data = Buffer.alloc(1024 * 1024 + n * 4099, 1 + n);
    const client = await connectTunnel(t, a.port, '127.0.0.1:' + echo.port);
    const chunks = []; client.on('data', c => chunks.push(c)); client.end(data);
    await once(client, 'end'); assert.deepEqual(Buffer.concat(chunks), data, 'tunnel ' + n);
  }));
  await settled([a, b], () => echo.sockets.size);
});

test('CONNECT accepts bracketed IPv6 literals', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const echo = await echoServer(t, '::1');
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [echo.port], allowPrivate: true });
  const client = await connectTunnel(t, a.port, `[::1]:${echo.port}`);
  const chunks = []; client.on('data', c => chunks.push(c)); client.end('v6 echo');
  await once(client, 'end'); assert.equal(Buffer.concat(chunks).toString(), 'v6 echo');
  const bad = http.request({ host: '127.0.0.1', port: a.port, method: 'CONNECT', path: `[::1:${echo.port}` }); bad.end();
  const [refused, refusedSocket] = await once(bad, 'connect'); refusedSocket.destroy(); assert.equal(refused.statusCode, 400);
});

test('open, idle and old-peer timeouts and the exit connection budget fail with 504/503', { timeout: 15000 }, async t => {
  const [a, b] = await fixture(t);
  const echo = await echoServer(t);
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [echo.port], allowPrivate: true });
  const status = async authority => { const req = http.request({ host: '127.0.0.1', port: a.port, method: 'CONNECT', path: authority }); req.end();
    const [r, socket] = await Promise.race([once(req, 'connect'), once(req, 'response')]); socket?.destroy(); return r.statusCode; };
  // An old peer ignores proxy-* frames entirely.
  const handle = b.proxy.handleFrame; b.proxy.handleFrame = (link, f) => String(f.t).startsWith('proxy-') || handle.call(b.proxy, link, f);
  a.proxy.openTimeout = 300; assert.equal(await status('127.0.0.1:' + echo.port), 504);
  b.proxy.handleFrame = handle; a.proxy.openTimeout = 5000;
  b.proxy.connectSocket = () => new net.Socket(); b.proxy.openTimeout = 300;
  assert.equal(await status('127.0.0.1:' + echo.port), 504, 'exit connect deadline');
  b.proxy.connectSocket = net.connect; b.proxy.openTimeout = 5000;
  await settled([a, b], () => echo.sockets.size);
  b.proxy.limit = 1;
  const first = await connectTunnel(t, a.port, '127.0.0.1:' + echo.port);
  assert.equal(await status('127.0.0.1:' + echo.port), 503, 'exit budget counts tunnel and socket as one');
  first.destroy(); await settled([a, b], () => echo.sockets.size);
  b.proxy.limit = 128; a.proxy.idleTimeout = b.proxy.idleTimeout = 200;
  const idle = await connectTunnel(t, a.port, '127.0.0.1:' + echo.port);
  idle.write('ping'); assert.equal((await once(idle, 'data'))[0].toString(), 'ping');
  await closed(idle); await settled([a, b], () => echo.sockets.size);
});

test('HTTP mode carries chunked bodies and Expect: 100-continue', { timeout: 10000 }, async t => {
  const [a, b] = await fixture(t);
  const seen = [];
  const dest = await origin(t, (req, res) => { seen.push(req.headers['transfer-encoding'] || req.headers['content-length']); req.pipe(res); });
  dest.server.on('checkContinue', (req, res) => { seen.push('continue'); res.writeContinue(); req.pipe(res); });
  Object.assign(b.cfg, { allowExit: true, allowedPorts: [dest.port], allowPrivate: true });
  const data = Buffer.alloc(300 * 1024, 7);
  const send = headers => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: a.port, path: dest.url + '/echo', method: 'POST', headers, agent: false }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }); req.on('error', reject);
    for (let i = 0; i < data.length; i += 4096) req.write(data.subarray(i, i + 4096));
    req.end();
  });
  let r = await send({}); assert.equal(r.status, 200); assert.deepEqual(r.body, data);
  r = await send({ expect: '100-continue', 'content-length': data.length }); assert.equal(r.status, 200); assert.deepEqual(r.body, data);
  assert.deepEqual(seen, ['chunked', 'continue']);
});
