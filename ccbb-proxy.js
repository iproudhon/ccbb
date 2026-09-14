'use strict';
// Forward proxy on the web listener; TCP streams ride authenticated peer links.
// Existing session relay frames and their one-hop policy are unchanged.
const http = require('http');
const net = require('net');
const dns = require('dns').promises;
const crypto = require('crypto');
const { Duplex } = require('stream');
const { performance } = require('perf_hooks');
const CHUNK = 32 * 1024, LIMIT = 128, OPEN_MS = 10000, IDLE_MS = 120000;
const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const loopback = ip => ip === '::1' || /^127\./.test(ip) || /^::ffff:127\./.test(ip);
function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  // Only global unicast; exclude transition mechanisms that can encode private IPv4.
  return net.isIP(ip) === 6 && /^[23]/i.test(ip) && !/^2002:/i.test(ip) && !/^2001:(?:0{0,4}|db8):/i.test(ip);
}
function target(host, port) {
  host = String(host || '').replace(/^\[|\]$/g, '');
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host) ||
      (host.includes(':') && !net.isIP(host)) || !Number.isInteger(port) || port < 1 || port > 65535)
    throw fail('Invalid proxy destination', 400);
  return { host, port };
}
function headersFor(headers, upgrade = false, keepCcbbAuth = false) {
  const skip = new Set(['connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
    'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'x-ccbb-via']);
  if (!keepCcbbAuth) skip.add('x-ccbb-token');
  for (const k of String(headers.connection || '').split(',')) skip.add(k.trim().toLowerCase());
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!skip.has(k)) out[k] = v;
  if (out.cookie && !keepCcbbAuth) {
    out.cookie = String(out.cookie).split(';').filter(c => !/^\s*ccbb_token(?:_\d+)?=/.test(c)).join(';');
    if (!out.cookie) delete out.cookie;
  }
  if (upgrade) { out.connection = 'Upgrade'; out.upgrade = 'websocket'; }
  return out;
}

// One acknowledged chunk in each direction bounds buffering per tunnel. ACK is
// delayed when the readable buffer fills, propagating backpressure across the link.
class Tunnel extends Duplex {
  constructor(owner, link, id) {
    super({ allowHalfOpen: true });
    this.owner = owner; this.link = link; this.id = id; this.pendingWrite = null;
    this.blocked = false; this.opened = false; this.remoteEnded = false; this.remoteClosed = false;
    this.on('error', () => {});
    this.timer = setTimeout(() => this.destroy(fail('Proxy tunnel timed out', 504)), owner.openTimeout);
  }
  touch() { clearTimeout(this.timer); this.timer = setTimeout(() => this.destroy(fail('Proxy tunnel idle timeout', 504)), this.owner.idleTimeout); }
  send(t, extra = {}) {
    if (this.link.ws.readyState !== 1) { this.destroy(fail('Proxy peer link is down')); return false; }
    try { this.link.ws.send(JSON.stringify({ t: 'proxy-' + t, id: this.id, ...extra })); return true; }
    catch { this.destroy(fail('Proxy peer link is down')); return false; }
  }
  _read() { if (this.blocked) { this.blocked = false; this.send('ack'); } }
  _write(buf, enc, done) {
    let offset = 0;
    const next = err => {
      if (err) return done(err);
      if (offset === buf.length) return done();
      const part = buf.subarray(offset, offset + CHUNK); offset += part.length;
      this.pendingWrite = next;
      this.send('data', { data: part.toString('base64') });
    };
    next();
  }
  _final(done) { this.send('end'); done(); }
  _destroy(err, done) {
    clearTimeout(this.timer);
    this.owner.channels.get(this.link)?.delete(this.id);
    if (!this.remoteClosed && !(this.readableEnded && this.writableFinished) && this.link.ws.readyState === 1) {
      try { this.link.ws.send(JSON.stringify({ t: 'proxy-close', id: this.id })); } catch {}
    }
    const cb = this.pendingWrite; this.pendingWrite = null;
    if (cb) cb(err || fail('Proxy tunnel closed'));
    done(err);
  }
  frame(f) {
    if (!this.opened && !['proxy-ready', 'proxy-error', 'proxy-close'].includes(f.t))
      return this.destroy(fail('Proxy stream is not ready'));
    this.touch();
    if (f.t === 'proxy-ready') { this.opened = true; this.emit('ready'); }
    else if (f.t === 'proxy-error') this.destroy(fail(String(f.error || 'Proxy exit failed'), [400, 403, 503, 504].includes(f.status) ? f.status : 502));
    else if (f.t === 'proxy-close') { this.remoteClosed = true; this.destroy(fail('Proxy tunnel aborted by peer')); }
    else if (f.t === 'proxy-ack') { const cb = this.pendingWrite; this.pendingWrite = null; if (cb) cb(); }
    else if (f.t === 'proxy-end') { this.remoteEnded = true; this.push(null); }
    else if (f.t === 'proxy-data') {
      if (this.remoteEnded || this.blocked || typeof f.data !== 'string' || f.data.length > Math.ceil(CHUNK / 3) * 4)
        return this.destroy(fail('Invalid proxy stream frame'));
      const bytes = Buffer.from(f.data, 'base64');
      if (!bytes.length || bytes.length > CHUNK) return this.destroy(fail('Invalid proxy stream chunk'));
      this.blocked = !this.push(bytes);
      if (!this.blocked) this.send('ack');
    }
  }
}
// An abort resets a TCP peer so the far end sees an error, not a clean EOF.
const abort = s => { if (!s.destroyed) (s.resetAndDestroy || s.destroy).call(s); };
function splice(a, b) {
  const close = () => { abort(a); abort(b); };
  a.on('error', close); b.on('error', close);
  // pipe() propagates FIN after queued writes. Only aborts may discard buffers.
  a.on('close', () => { if (!a.readableEnded || !a.writableFinished) abort(b); });
  b.on('close', () => { if (!b.readableEnded || !b.writableFinished) abort(a); });
  a.pipe(b); b.pipe(a);
}

class ForwardProxy {
  constructor({ config, identity, findLink, lookup = dns.lookup.bind(dns),
    connect = net.connect, openTimeout = OPEN_MS, idleTimeout = IDLE_MS, limit = LIMIT }) {
    this.lookup = lookup; this.connectSocket = connect; this.openTimeout = openTimeout;
    this.idleTimeout = idleTimeout; this.limit = limit; this.slots = new Map();
    this.getConfig = config; this.identity = identity; this.findLink = findLink;
    this.channels = new Map(); this.active = new Set(); this.resolving = 0; this.generation = 0;
  }
  config() {
    const c = this.getConfig();
    if (!c || typeof c !== 'object' || Array.isArray(c)) return {};
    return c;
  }
  attachLink(link) {
    this.channels.set(link, new Map());
    const drop = () => {
      for (const s of this.channels.get(link)?.values() || []) s.destroy(fail('Proxy peer disconnected'));
      this.channels.delete(link);
    };
    link.ws.on('close', drop); link.ws.on('error', drop);
  }
  reserve(slot) {
    if (slot) { this.slots.set(slot, (this.slots.get(slot) || 0) + 1); return slot; }
    if (this.count() >= this.limit) throw fail('Proxy connection limit reached', 503);
    slot = Symbol('proxy connection'); this.slots.set(slot, 1); return slot;
  }
  release(slot) {
    const refs = this.slots.get(slot);
    if (refs > 1) this.slots.set(slot, refs - 1); else this.slots.delete(slot);
  }
  newTunnel(link, id = crypto.randomUUID()) {
    const channels = this.channels.get(link);
    if (!channels) throw fail('Proxy peer link is down', 503);
    const slot = this.reserve();
    const stream = new Tunnel(this, link, id); stream.slot = slot;
    stream.on('close', () => this.release(slot));
    channels.set(id, stream); return stream;
  }
  count() { return this.slots.size; }
  track(socket) {
    this.active.add(socket); socket.on('close', () => this.active.delete(socket));
    socket.on('error', () => {}); return socket;
  }
  async dial(dest, { signal, slot, deadline = performance.now() + this.openTimeout } = {}) {
    const generation = this.generation;
    const cfg = this.config();
    if (cfg.allowExit !== true) throw fail('Proxy exit is disabled on this node', 403);
    const ports = cfg.allowedPorts === undefined ? [80, 443] : cfg.allowedPorts;
    if (!Array.isArray(ports) || !ports.includes(dest.port)) throw fail('Proxy destination port is not allowed', 403);
    slot = this.reserve(slot);
    let connected = false;
    const check = () => {
      if (signal?.aborted || generation !== this.generation) throw fail('Proxy connection cancelled');
      if (performance.now() >= deadline) throw fail('Proxy open timed out', 504);
    };
    const wait = (promise, until = deadline) => new Promise((resolve, reject) => {
      const abort = () => reject(fail('Proxy connection cancelled'));
      const timer = setTimeout(() => reject(fail('Proxy open timed out', 504)), Math.max(0, until - performance.now()));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      promise.then(resolve, reject).finally(() => {});
      // Cleanup when this wait settles, including timeout/cancellation before promise.
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      // Wrapped resolve/reject above must also clean up the losing timers/listeners.
      const originalResolve = resolve, originalReject = reject;
      resolve = value => { cleanup(); originalResolve(value); };
      reject = error => { cleanup(); originalReject(error); };
    });
    try {
      check();
      this.resolving++;
      let addresses;
      try { addresses = await wait(this.lookup(dest.host, { all: true })); }
      finally { this.resolving--; }
      check();
      if (!addresses.length || (cfg.allowPrivate !== true && addresses.some(a => !publicAddress(a.address))))
        throw fail('Proxy destination address is not allowed', 403);
      // Each attempt uses a checked literal address, never a second DNS lookup.
      // Share the remaining budget so a black-holed first address cannot starve others.
      let lastError;
      for (let i = 0; i < addresses.length; i++) {
        check();
        const until = performance.now() + (deadline - performance.now()) / (addresses.length - i);
        const socket = this.track(this.connectSocket({ host: addresses[i].address, port: dest.port, allowHalfOpen: true }));
        let onConnect, onError, onClose;
        try {
          await wait(new Promise((resolve, reject) => {
            onConnect = resolve; onError = reject;
            onClose = () => reject(fail('Proxy connection closed before ready'));
            socket.once('connect', onConnect); socket.once('error', onError); socket.once('close', onClose);
          }), until);
          check();
          socket.setTimeout(this.idleTimeout, () => socket.destroy(fail('Proxy idle timeout', 504)));
          socket.on('close', () => this.release(slot));
          connected = true; return socket;
        } catch (e) { lastError = e; socket.destroy(); }
        finally {
          socket.removeListener('connect', onConnect); socket.removeListener('error', onError); socket.removeListener('close', onClose);
        }
      }
      check(); throw lastError || fail('Proxy destination unreachable');
    } finally { if (!connected) this.release(slot); }
  }
  async open(dest, signal) {
    const node = this.config().exitNode;
    if (typeof node !== 'string' || !node.trim()) throw fail('Configure proxy.exitNode explicitly', 503);
    if (node === this.identity()) return this.dial(dest, { signal });
    const link = this.findLink(node);
    if (!link || link.ws.readyState !== 1) throw fail(`Proxy exit "${node}" has no live peer link`, 503);
    if (link.inbound && this.config().allowInboundExit !== true)
      throw fail('Set proxy.allowInboundExit to trust this inbound exit link', 403);
    const s = this.newTunnel(link);
    const abort = () => s.destroy(fail('Proxy connection cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    try { await new Promise((resolve, reject) => {
      s.once('ready', resolve); s.once('error', reject);
      s.once('close', () => reject(fail('Proxy tunnel closed before ready')));
      if (signal?.aborted) abort(); else s.send('open', dest);
    }); } finally { signal?.removeEventListener('abort', abort); }
    return s;
  }
  handleFrame(link, f) {
    if (!String(f.t).startsWith('proxy-')) return false;
    const channels = this.channels.get(link);
    if (!channels || typeof f.id !== 'string' || !/^[a-f0-9-]{36}$/.test(f.id)) return true;
    if (f.t !== 'proxy-open') { channels.get(f.id)?.frame(f); return true; }
    if (channels.has(f.id)) { channels.get(f.id).destroy(fail('Duplicate proxy channel')); return true; }
    let s;
    try { s = this.newTunnel(link, f.id); }
    catch (e) { link.ws.send(JSON.stringify({ t: 'proxy-error', id: f.id, error: e.message, status: e.status })); return true; }
    const controller = new AbortController();
    s.once('close', () => controller.abort());
    clearTimeout(s.timer);   // dial() enforces the open deadline and reports it as 504
    (async () => {
      try {
        const dest = target(f.host, f.port);
        const outbound = await this.dial(dest, { signal: controller.signal, slot: s.slot });
        if (s.destroyed) return outbound.destroy();
        s.opened = true; s.touch(); s.send('ready'); splice(s, outbound);
      } catch (e) { s.send('error', { error: e.message, status: e.status }); s.destroy(); }
    })();
    return true;
  }
  authorize(req) {
    const cfg = this.config();
    if (cfg.enabled !== true) throw fail('Forward proxy is disabled', 403);
    if (cfg.username || cfg.password) {
      if (typeof cfg.username !== 'string' || !cfg.username || typeof cfg.password !== 'string' || !cfg.password)
        throw fail('Proxy credentials are incomplete', 503);
      const expected = Buffer.from('Basic ' + Buffer.from(cfg.username + ':' + cfg.password).toString('base64'));
      const supplied = Buffer.from(String(req.headers['proxy-authorization'] || ''));
      if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) throw fail('Proxy authentication required', 407);
    } else if (!loopback(req.socket.remoteAddress || '')) throw fail('Remote proxy access requires credentials', 407);
  }
  reject(res, error) {
    if (res.headersSent) return res.destroy();
    res.writeHead(error.status || 502, { 'Content-Type': 'text/plain', 'Connection': 'close',
      ...(error.status === 407 ? { 'Proxy-Authenticate': 'Basic realm="ccbb proxy"' } : {}) });
    res.end(error.message + '\n');
  }
  rejectSocket(socket, error) {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${error.status || 502} ${http.STATUS_CODES[error.status || 502]}\r\nConnection: close\r\n${error.status === 407 ? 'Proxy-Authenticate: Basic realm="ccbb proxy"\r\n' : ''}Content-Length: 0\r\n\r\n`);
  }
  handles(req) { return /^[a-z][a-z\d+.-]*:\/\//i.test(req.url || ''); }
  destination(req) {
    let u;
    try { u = new URL(req.url); } catch { throw fail('Invalid proxy URL', 400); }
    if (u.protocol !== 'http:' || u.username || u.password || u.hash) throw fail('Use HTTP requests or HTTPS CONNECT', 400);
    return { url: u, dest: target(u.hostname, Number(u.port || 80)) };
  }
  requestHeaders(req, url, upgrade = false) {
    const trusted = this.config().forwardCcbbAuthTo;
    const keepAuth = Array.isArray(trusted) && trusted.includes(url.origin);
    const headers = headersFor(req.headers, upgrade, keepAuth); headers.host = url.host;
    return headers;
  }
  async request(req, res) {
    const controller = new AbortController();
    let stream, outgoing;
    const cancel = () => { controller.abort(); stream?.destroy(); outgoing?.destroy(); };
    req.on('aborted', cancel); res.on('close', cancel);
    try {
      this.authorize(req);
      const { url, dest } = this.destination(req);
      stream = await this.open(dest, controller.signal);
      if (req.aborted || res.destroyed) return stream.destroy();
      const headers = this.requestHeaders(req, url);
      const agent = new http.Agent(); agent.createConnection = () => stream;
      // One destination stream per request; Node manages HTTP framing on both sides.
      outgoing = http.request({ method: req.method, host: dest.host, port: dest.port,
        path: url.pathname + url.search, headers, agent }, pres => {
        res.writeHead(pres.statusCode, headersFor(pres.headers));
        pres.on('error', () => res.destroy()); pres.pipe(res);
      });
      outgoing.on('error', e => this.reject(res, e));
      req.pipe(outgoing);
    } catch (e) { cancel(); this.reject(res, e); }
  }
  async connect(req, socket, head) {
    socket.on('error', () => {});
    const controller = new AbortController();
    let stream;
    const cancel = () => { controller.abort(); stream?.destroy(); };
    socket.once('close', cancel);
    try {
      this.authorize(req);
      const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url);
      if (!match) throw fail('Invalid CONNECT authority', 400);
      stream = await this.open(target(match[1], Number(match[2])), controller.signal);
      if (socket.destroyed) return stream.destroy();
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) stream.write(head);
      socket.removeListener('close', cancel);
      splice(socket, stream);
    } catch (e) { stream?.destroy(); this.rejectSocket(socket, e); }
  }
  async upgrade(req, socket, head) {
    socket.on('error', () => {});
    const controller = new AbortController();
    let stream, outgoing, responded = false;
    const cancel = () => { controller.abort(); stream?.destroy(); outgoing?.destroy(); };
    socket.once('close', cancel);
    try {
      this.authorize(req);
      if (String(req.headers.upgrade).toLowerCase() !== 'websocket') throw fail('Only WebSocket upgrades are supported', 400);
      const { url, dest } = this.destination(req);
      stream = await this.open(dest, controller.signal);
      if (socket.destroyed) return stream.destroy();
      const headers = this.requestHeaders(req, url, true);
      const agent = new http.Agent(); agent.createConnection = () => stream;
      outgoing = http.request({ host: dest.host, port: dest.port, path: url.pathname + url.search,
        headers, agent });
      outgoing.on('upgrade', (response, upstream, early) => {
        responded = true;
        socket.removeListener('close', cancel);
        let text = 'HTTP/1.1 101 Switching Protocols\r\n';
        for (const [k, v] of Object.entries(headersFor(response.headers, true))) text += `${k}: ${v}\r\n`;
        socket.write(text + '\r\n'); if (early.length) socket.write(early);
        if (head.length) upstream.write(head); splice(socket, upstream);
      });
      outgoing.on('response', response => {
        responded = true;
        const headers = headersFor(response.headers); headers.connection = 'close';
        let text = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
        for (const [key, value] of Object.entries(headers)) {
          for (const item of Array.isArray(value) ? value : [value]) text += `${key}: ${item}\r\n`;
        }
        socket.write(text + '\r\n');
        response.on('error', () => socket.destroy()); response.pipe(socket);
      });
      outgoing.on('error', e => { if (responded) socket.destroy(); else this.rejectSocket(socket, e); }); outgoing.end();
    } catch (e) { stream?.destroy(); this.rejectSocket(socket, e); }
  }
  close() {
    this.generation++;
    for (const s of this.active) s.destroy();
    for (const map of this.channels.values()) for (const s of map.values()) s.destroy();
  }
}
module.exports = { ForwardProxy, publicAddress, headersFor };
