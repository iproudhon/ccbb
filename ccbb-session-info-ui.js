'use strict';
// A session's info panel (the block behind ⋮) and its status line (the foot), drawn the
// same way by every session view: ccbb web's own, the mux view, and both phone panels.
// Browser code, stringified into SHARED_JS through ccbb-newsession-ui's exports. It leans
// on SHARED_JS's formatters (esc, fmtCost, fmtTokShort, fmtDur, fd, prettyModel, footWin,
// subWinTitle, fmtUntil, FOOT_LVL_*) and on nsCopy/nsK from ccbb-newsession-ui.

// What the next turn costs to resend the context. While the prompt cache is warm (the last
// response is younger than its TTL) that is cache-read price; once it has expired it is
// cache-write price, for the whole context. lastAt: a later response the stats object has
// not seen yet (ms), which re-warms the clock.
function siResend(st, lastAt) {
  var c = st && st.context;
  if (!c || !c.tokens) return null;
  var ttl = st.cacheTtl || 300;
  var at = Math.max(Date.parse(st.lastAssistantAt || '') || 0, lastAt || 0);
  var age = at ? Date.now() - at : null;
  var cold = age != null && age > ttl * 1000;
  var cost = c.cost;
  if (cold) {
    cost = c.costWrite;
    if (cost == null && typeof priceFor === 'function') {
      var p = priceFor(c.model, c.provider) || {};
      var w = ttl >= 3600 ? p.cacheWrite1h : p.cacheWrite5m;
      cost = w != null ? c.tokens * w / 1e6 : null;
    }
  }
  return { tokens: c.tokens, cost: cost, cold: cold, ttl: ttl, age: age };
}
function siResendTitle(r) {
  if (!r) return '';
  var ttl = r.ttl >= 3600 ? '1h' : '5m';
  if (r.cold) return 'Prompt cache expired (' + ttl + ' TTL) ' + fmtDur(Math.round((r.age - r.ttl * 1000) / 1000) * 1000) +
    ' ago: the next turn re-writes the whole context at cache-write price.';
  return 'Next turn resends the context at cache-read price' +
    (r.age != null ? '; the cache stays warm for another ' + fmtDur(Math.round((r.ttl * 1000 - r.age) / 1000) * 1000) + ' (' + ttl + ' TTL)' : '') + '.';
}

// The plan's windows only say something about a session whose spend went to that plan:
// a Bedrock or API-key session on a machine that also has a login is not billed to it.
function siOnPlan(st, sub) {
  if (!sub || !sub.windows || !st) return null;
  return (st.providers || []).some(function (p) { return p.provider === 'anthropic' && p.cost > 0; }) ? sub : null;
}

// The status line: cost, plan windows, turns, ctx (now/peak/resend). Nothing else.
// m: {st, sub (an object with .windows, or null when not on a plan), approx, lastAt}.
// lvl is fitFoot's shrink level.
function siFootHtml(m, lvl) {
  var st = m.st || {};
  var out = ['<b class="sl-cost">' + (st.cost == null ? '—' : (m.approx ? '~' : '') + fmtCost(st.cost)) + '</b>'];
  var w = m.sub && m.sub.windows;
  if (w && typeof footWin === 'function') {
    var p = footWin('5h', w.fiveHour, lvl) + footWin('7d', w.sevenDay, lvl);
    if (p) out.push('<span class="fwins" title="' + esc(subWinTitle(m.sub)) + '">' + p + '</span>');
  }
  out.push('<span class="sl-turns" title="Turns (+ sub-agent turns)"><b>' + (st.turns || 0) + '</b>' +
    (st.subTurns ? '<span class="sl-sub">+' + st.subTurns + '</span>' : '') + '</span>');
  var c = st.context;
  if (c && c.tokens) {
    var peak = st.contextMax && st.contextMax.tokens > c.tokens ? st.contextMax.tokens : 0;
    var r = siResend(st, m.lastAt);
    out.push('<span class="sl-ctx" title="' + esc('Context now' + (peak ? ' / peak' : '') + ' / cost to resend it.\n' + siResendTitle(r)) + '">' +
      (lvl >= FOOT_LVL_CTX_LABEL ? '' : 'ctx:') + (c.postCompact ? '~' : '') +
      '<b>' + fmtTokShort(c.tokens) + '</b>' + (peak ? '/' + fmtTokShort(peak) : '') +
      (r && r.cost != null ? '/<span class="sl-rs' + (r.cold ? ' cold' : '') + '">' + fmtCost(r.cost) + '</span>' : '') +
      '</span>');
  }
  return out.join('');
}

// The info panel: a label/value grid in two groups, the session and its usage.
// m: {cwd, sessionId, bin, binNote, model, compactAt (number | 'default' | null = unknown),
//     mode, status (html), startedAt, lastActivity, clients (text), st, sub, approx,
//     lastAt, extra: [[label, html]]}
function siGridHtml(m) {
  var st = m.st || null, rows = [];
  function row(label, html, cls) { if (html) rows.push('<dt>' + label + '</dt><dd' + (cls ? ' class="' + cls + '"' : '') + '>' + html + '</dd>'); }
  function copy(text, what) { return text ? '<button type="button" class="si-copy" data-copy="' + esc(text) + '" title="Copy ' + what + '">&#10697;</button>' : ''; }
  function dim(s) { return '<span class="si-dim">' + s + '</span>'; }
  row('Directory', m.cwd ? '<span class="si-mono">' + esc(m.cwd) + '</span>' + copy(m.cwd, 'directory') : '');
  row('Session', m.sessionId ? '<span class="si-mono">' + esc(m.sessionId) + '</span>' + copy(m.sessionId, 'session id') : '');
  row('Binary', m.bin ? esc(m.bin) + (m.binNote ? ' ' + dim(esc(m.binNote)) : '') : dim('—'));
  var model = m.model || (st && st.context && st.context.model) || (st && st.models && st.models[0] && st.models[0].model) || '';
  row('Model', model ? esc(prettyModel(model)) + (prettyModel(model) !== model ? ' ' + dim(esc(model)) : '') : dim('—'));
  row('Compact at', (typeof m.compactAt === 'number' ? nsK(m.compactAt) : m.compactAt === 'default' ? 'Default' : m.compactAt === 'off' ? 'Off' : dim('—'))
    + (m.compactSource && m.compactAt !== 'default' ? ' ' + dim(esc(m.compactSource)) : ''));
  if (m.mode) row('Mode', esc(m.mode));
  row('Status', m.status || '');
  var started = m.startedAt || (st && st.startedAt), last = (st && st.lastActivity) || m.lastActivity;
  if (started || last) row('Active', esc(fd(started)) + (last ? ' &rarr; ' + esc(fd(last)) : ''));
  if (m.clients) row('Attached', esc(m.clients));
  (m.extra || []).forEach(function (x) { row(x[0], x[1]); });
  if (st) {
    rows.push('<div class="si-hr"></div>');
    var w = m.sub && m.sub.windows, plan = [];
    if (w && w.fiveHour) plan.push('5h ' + subPct(w.fiveHour));
    if (w && w.sevenDay) plan.push('7d ' + subPct(w.sevenDay));
    row('Cost', '<b>' + (m.approx ? '~' : '') + fmtCost(st.cost) + '</b>' +
      (plan.length ? ' ' + dim('<span title="' + esc(subWinTitle(m.sub)) + '">· ' + plan.join(' · ') + '</span>') : ''));
    row('Turns', '<b>' + (st.turns || 0) + '</b>' + (st.subTurns ? ' ' + dim('+' + st.subTurns + ' sub-agent') : ''));
    var c = st.context;
    if (c && c.tokens) {
      var peak = st.contextMax && st.contextMax.tokens > c.tokens ? st.contextMax.tokens : 0;
      var pct = typeof m.compactAt === 'number' && m.compactAt > 0 ? Math.round(100 * c.tokens / m.compactAt) + '% of ' + nsK(m.compactAt) : '';
      row('Context', '<b>' + (c.postCompact ? '~' : '') + fmtTokShort(c.tokens) + '</b>' +
        (peak ? ' ' + dim('/ peak ' + fmtTokShort(peak)) : '') + (pct ? ' ' + dim('· ' + pct) : '') +
        (c.postCompact ? ' ' + dim('· post-compact') : ''));
      var r = siResend(st, m.lastAt);
      if (r && r.cost != null) row('Resend', '<span class="sl-rs' + (r.cold ? ' cold' : '') + '">' + fmtCost(r.cost) + '</span> ' +
        dim(r.cold ? 'cache expired' : r.age != null ? 'cache warm ' + fmtDur(Math.round((r.ttl * 1000 - r.age) / 1000) * 1000) : 'cache-read price'));
    }
    var k = st.categories || {}, tot = st.cost || 0;
    var cats = [['cache read', 'cacheRead'], ['cache write', 'cacheWrite'], ['cache miss', 'cacheMiss'], ['out', 'output'], ['in', 'input']]
      .filter(function (x) { return k[x[1]] && k[x[1]].tokens; })
      .map(function (x) { return '<span class="si-tok">' + dim(x[0]) + ' ' + fmtTokShort(k[x[1]].tokens) + ' ' + dim(fmtPct(k[x[1]].cost, tot)) + '</span>'; });
    if (cats.length) row('Tokens', '<span class="si-toks"><b>' + fmtTokShort(st.totalTokens) + '</b>' + cats.join('') + '</span>');
    var models = (st.models || []).filter(function (x) { return x.cost >= 0.005; });
    if (models.length >= 2) row('By model', models.map(function (x) { return esc(prettyModel(x.model)) + ' ' + fmtCost(x.cost); }).join(dim(' · ')));
    if (fmtDur(st.avgResponseMs)) row('Response', 'avg ' + fmtDur(st.avgResponseMs));
  }
  return '<dl class="si">' + rows.join('') + '</dl>';
}

// A mux session's numbers: the last stats pass (st), brought up to date with what the
// mux has pushed since (cost, turns, context per response). The resend prices scale with
// the context they were computed for.
function siLiveStats(i) {
  i = i || {};
  var st = Object.assign({}, i.stats || {});
  if (i.cost != null) st.cost = i.cost;
  if (i.turns != null) st.turns = i.turns;
  if (i.subTurns != null) st.subTurns = i.subTurns;
  var base = st.context || null;
  if (i.contextTokens) {
    var k = base && base.tokens ? i.contextTokens / base.tokens : null;
    st.context = Object.assign({}, base || {}, {
      tokens: i.contextTokens, postCompact: !!i.contextPostCompact,
      cost: k != null && base.cost != null ? base.cost * k : (base ? base.cost : null),
      costWrite: k != null && base.costWrite != null ? base.costWrite * k : null,
    });
  }
  var peak = Math.max(i.contextPeak || 0, (st.contextMax && st.contextMax.tokens) || 0);
  if (peak) st.contextMax = Object.assign({}, st.contextMax || {}, { tokens: peak });
  return st;
}

// The info panel's model for a mux session, from the chrome object ccbb-mux-web pushes
// (onChrome): ccbb web's mux view and the phone's mux panel draw the same thing.
function siMuxModel(c, sessionId) {
  var i = c.info || {}, codex = i.agent === 'codex';
  var status = '<b>' + esc(c.connected ? (c.status || 'idle') : 'disconnected') + '</b>';
  if (i.exit) status += ' &middot; exited (' + esc(String(i.exit.code == null ? i.exit.signal : i.exit.code)) + ')';
  if (i.auth && i.auth.isAuthenticating) status += ' &middot; refreshing credentials&hellip;';
  var extra = [];
  if (codex && i.endpoint) extra.push(['Native TUI', '<code>' + esc('codex resume --remote ' + i.endpoint + ' ' + i.nativeId) + '</code>']);
  return {
    cwd: c.cwd || i.cwd || '', sessionId: sessionId,
    bin: i.bin || (codex ? 'codex' : 'claude'), model: i.model || null,
    compactAt: i.compactAt || 'default', compactSource: i.compactSource || null, mode: c.permissionMode || null, status: status,
    clients: (c.clients || []).map(function (x) { return x.label + ' (' + x.kind + ')'; }).join(', '),
    startedAt: i.startedAt, lastActivity: i.lastActivity,
    st: c.stats || siLiveStats(i), sub: c.sub || null, approx: codex, lastAt: i.lastResultAt || 0, extra: extra,
  };
}

// Copy buttons in a panel, wired once per container.
function siWire(root) {
  if (!root || root._siWired) return;
  root._siWired = true;
  root.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.si-copy');
    if (!b) return;
    e.stopPropagation();
    nsCopy(b.getAttribute('data-copy')).then(function (ok) {
      b.innerHTML = ok ? '&#10003;' : '!';
      setTimeout(function () { b.innerHTML = '&#10697;'; }, 1200);
    });
  });
}

const CSS = `
.si{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:3px 14px;margin:0;
  font-size:12px;line-height:1.45;color:var(--ink);font-variant-numeric:tabular-nums;text-align:left}
.si dt{color:var(--ink-faint);white-space:nowrap}
.si dd{margin:0;min-width:0;overflow-wrap:anywhere}
.si b{font-weight:600}
.si .si-hr{grid-column:1/-1;border-top:1px solid var(--line);margin:3px 0}
.si .si-mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px}
.si .si-dim{color:var(--ink-faint)}
.si .si-toks{display:flex;flex-wrap:wrap;gap:0 12px}
.si .si-tok{white-space:nowrap}
.si code{font-size:11px}
.si-copy{border:0;background:none;color:var(--ink-faint);cursor:pointer;padding:0 4px;margin-left:2px;font:inherit;line-height:1}
.si-copy:hover{color:var(--accent)}
.sl-rs.cold{color:var(--warn,#bf8700)}
@media (max-width:600px){.si{font-size:12.5px;gap:4px 12px}.si .si-mono{font-size:12px}}
`;

const JS = [siOnPlan, siResend, siResendTitle, siFootHtml, siGridHtml, siLiveStats, siMuxModel, siWire].map(f => f.toString()).join('\n');

module.exports = { CSS, JS, siResend, siFootHtml, siGridHtml };
