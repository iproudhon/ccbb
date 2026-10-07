'use strict';
// Minimal DOM good enough to execute the report's embedded script in Node, so the page's
// aggregation/drawing code can be exercised without a browser. It records the SVG elements
// each chart host receives and the text/HTML the page sets, which is what the checks assert.
function mkEl(tag) {
  const el = {
    tagName: tag, children: [], attrs: {}, style: {}, listeners: {},
    _text: '', _html: '', className: '', type: '', checked: false,
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
    getAttribute(k) { return this.attrs[k]; },
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); },
    removeEventListener() {},
    querySelectorAll(sel) {
      const out = [];
      const walk = n => { for (const c of n.children) { if (c.tagName === sel) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; if (v === '') this.children = []; },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v); },
    get offsetWidth() { return 100; },
    get offsetHeight() { return 40; },
  };
  return el;
}
function install(hostId = 'ccstats-host') {
  const byId = new Map();
  const get = id => { if (!byId.has(id)) byId.set(id, mkEl('div')); return byId.get(id); };
  const body = mkEl('body');
  const host = mkEl('div');
  const shadow = mkEl('#shadow');
  shadow.getElementById = get;
  host.shadowRoot = null;
  host.attachShadow = () => { host.shadowRoot = shadow; return shadow; };
  const document = {
    body,
    getElementById: id => (id === hostId ? host : get(id)),
    createElement: tag => {
      const el = mkEl(tag);
      // Every created host keeps its shadow root reachable, so a test can look inside the
      // tooltip / floating-control roots the report hangs off <body>.
      el.attachShadow = () => { const s = mkEl('#shadow'); s.getElementById = get; el.shadowRoot = s; return s; };
      return el;
    },
    createElementNS: (ns, tag) => mkEl(tag),
    createTextNode: text => { const t = mkEl('#text'); t.textContent = text; return t; },
  };
  const ctx = {
    document,
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }) },
    innerWidth: 1200,
    console,
  };
  ctx.window.document = document;
  ctx.matchMedia = ctx.window.matchMedia;
  return { ctx, ids: byId, host, shadow };
}
module.exports = { install, mkEl };
