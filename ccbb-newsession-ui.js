'use strict';
// The server chip's ⋮ menu and what it opens — the new-session dialog and the file
// explorer — for both front-ends. Browser code: these functions are never called here,
// only stringified into SHARED_JS (see ccbb-web.js), so the desktop and the phone run
// one copy. Each takes the server's API base ('' or '/peer/<name>') from the caller,
// so a peer's sessions start on that peer, with its PATH, binaries and filesystem.

function nsFolderIcon() {
  return '<svg class="ns-ico" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/></svg>';
}
function nsFileIcon() {
  return '<svg class="ns-ico" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/></svg>';
}

function nsGet(url) {
  return fetch(url).then(function(r){
    return r.json().catch(function(){ return {}; }).then(function(d){
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      return d;
    });
  });
}
function nsStore(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) {}
  return null;
}
function nsAgentOf(bin) {
  var b = String(bin || '').trim().split('/').pop().toLowerCase();
  return b.indexOf('claude') === 0 ? 'claude' : b.indexOf('codex') === 0 ? 'codex' : null;
}
function nsSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' K';
  return (n / 1048576).toFixed(1) + ' M';
}

// A small menu under `anchor`, fixed to the viewport so a scrolling chip row cannot clip
// it. items: [{icon, label, onClick, disabled?, title?, hidden?}]. Any tap outside it (and
// outside opts.inside), Escape or a resize closes it; opts.onClose hears about it.
// Returns the menu element, whose _close() closes it.
function chipMenu(anchor, items, opts) {
  opts = opts || {};
  var old = document.querySelector('.ns-menu');
  if (old) { var same = old._anchor === anchor; old._close(); if (same) return null; }
  var m = document.createElement('div');
  m.className = 'ns-menu';
  m.setAttribute('role', 'menu');
  nsMenuButtons(m, items, function(){ close(); });
  document.body.appendChild(m);
  var r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
  var left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
  var top = r.bottom + 4 + h > window.innerHeight - 8 ? Math.max(8, r.top - 4 - h) : r.bottom + 4;
  m.style.left = left + 'px'; m.style.top = top + 'px';
  function outside(e){
    if (m.contains(e.target) || anchor.contains(e.target)) return;
    if ((opts.inside || []).some(function(x){ return x && x.contains(e.target); })) return;
    close();
  }
  function key(e){ if (e.key === 'Escape') close(); }
  var closed = false;
  function close(){
    if (closed) return; closed = true;
    m.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', close);
    if (opts.onClose) opts.onClose();
  }
  m._anchor = anchor; m._close = close;
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', close);
  return m;
}

// Menu rows into `m`: one button per visible item; picking one calls done() first.
// iconOnly: the label moves to the tooltip and aria-label (the session dock).
function nsMenuButtons(m, items, done, iconOnly) {
  items.forEach(function(it){
    if (it.hidden) return;
    if (it.row) {
      var row = document.createElement('div');
      row.className = 'ns-mrow'; if (it.srv != null) row.dataset.srv = it.srv;
      // Hidden items still get a (hidden) button, so a later repaint can reveal them.
      nsMenuButtons(row, it.row.map(function(x){ return Object.assign({}, x, { hidden: false, _hide: x.hidden }); }), done, true);
      m.appendChild(row);
      return;
    }
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ns-mi' + (it.cls ? ' ' + it.cls : '');
    if (it._hide) b.hidden = true;
    if (!iconOnly) b.setAttribute('role', 'menuitem');
    if (it.disabled) b.disabled = true;
    if (it.k) b.dataset.k = it.k;
    if (iconOnly) {
      // The reason a disabled item is off goes in the label too: a phone shows no tooltip.
      b.title = it.title ? it.label + ' — ' + it.title : it.label;
      b.setAttribute('aria-label', b.title);
      b.innerHTML = '<span class="ns-mic">' + it.icon + '</span>';
    } else {
      if (it.title) b.title = it.title;
      b.innerHTML = '<span class="ns-mic">' + it.icon + '</span><span>' + esc(it.label) + '</span>';
    }
    b.addEventListener('click', function(e){ e.stopPropagation(); done(); it.onClick(); });
    m.appendChild(b);
  });
}
// A session's menu as a row of icon buttons docked on top of its info panel rather than
// a popup over it: the two open together, so one floating over the other hid exactly
// what ⋮ was opened to show. The same row at every width. done() runs when an item is
// picked (the caller folds the panel). A toolbar, not a menu: it stays put and has no
// arrow-key walk.
// o.win: the bar's own window buttons (▶ – □ ✕), mirrored as one right-aligned group at
// the end of the row — a narrow bar hides its own (ns-narrow). A mirror clicks the real
// button, so nothing it does is copied, and follows it live (hidden, glyph, title):
// ▶ comes and goes with the child while the row is open.
function sessionMenuDock(o, done) {
  var m = document.createElement('div');
  m.className = 'ns-dock';
  m.setAttribute('role', 'toolbar');
  nsMenuButtons(m, sessionMenuItems(o), done, true);
  var g = document.createElement('span');
  g.className = 'ns-wbs';
  var obs = [];
  Array.prototype.forEach.call(o.win || [], function(real){
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'ns-mi ns-wb';
    function sync() {
      b.hidden = real.hidden;
      b.innerHTML = '<span class="ns-mic">' + real.innerHTML + '</span>';
      b.title = real.title;
      b.setAttribute('aria-label', real.getAttribute('aria-label') || real.title);
    }
    sync();
    // done() first: a real button that stops the click (▶) never reaches the bar's own
    // fold, and a cancelled restart would leave the row open.
    b.addEventListener('click', function(e){ e.stopPropagation(); done(); real.click(); });
    g.appendChild(b);
    if (typeof MutationObserver === 'function') {
      var mo = new MutationObserver(function(){
        if (!m.isConnected) return obs.forEach(function(x){ x.disconnect(); });
        sync();
      });
      mo.observe(real, { attributes: true, attributeFilter: ['hidden', 'title', 'aria-label'], childList: true, characterData: true, subtree: true });
      obs.push(mo);
    }
  });
  if (g.children.length) m.appendChild(g);
  return m;
}
// Narrow and stacked, by the bar's measured width: under 340px the bar hides its window
// buttons (the ⋮ row carries them), under 480px the desktop's long info lines wrap.
// A ResizeObserver, not a container query — a folded column in horizontal layout is
// sized BY its bar, and inline-size containment would collapse it to nothing.
function nsWatchWidth(target, measure) {
  var stackAt = 480;
  function apply(w) {
    if (!w) return;
    target.classList.toggle('ns-narrow', w < 340);
    target.classList.toggle('ns-stack', w < stackAt);
  }
  if (typeof ResizeObserver === 'function')
    new ResizeObserver(function(){ apply(measure.getBoundingClientRect().width); }).observe(measure);
  apply(measure.getBoundingClientRect().width);
}

// The ⋮ menu every session view opens, on both front-ends. o: {refresh, explore?,
// term?, termOn?, termWin?, terminate?, terminateWhy?}. Absent handlers drop the item,
// except Terminate, which stays — disabled, saying why — so its absence is explained.
function sessionMenuItems(o) {
  var power = '<svg class="ns-ico" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/></svg>';
  return [
    { k: 'refresh', icon: '&#8635;', label: 'Refresh', onClick: o.refresh, hidden: !o.refresh },
    { k: 'explore', icon: nsFolderIcon(), label: 'Explorer', onClick: o.explore, hidden: !o.explore },
    { k: 'term', icon: o.termIcon || '$_', label: o.termOn && o.termOn() ? 'Back to the transcript' : (o.termLabel || 'Terminal in this view'), onClick: o.term, hidden: !o.term },
    { k: 'termwin', icon: '#_', label: 'Floating terminal', onClick: o.termWin, hidden: !o.termWin },
    { k: 'terminate', icon: power, label: 'Terminate', onClick: o.terminate || function(){}, disabled: !o.terminate,
      title: o.terminate ? 'Stop this session' : (o.terminateWhy || ''), hidden: o.terminate === false },
  ];
}

// The chip's actions: a row of login icons, new session, terminal, explorer.
// o: {server, base, onTerm, onOpened(session)}.
function serverChipMenu(anchor, o) {
  nsAuthRefresh(o.server, o.base, false, 60000);
  chipMenu(anchor, [
    { row: NS_AGENTS.map(function(g){ return nsAuthItem(o, g); }), srv: o.server },
    { icon: '+', label: 'New session', onClick: function(){ openNewSession(o); } },
    { icon: '&gt;_', label: 'Terminal', onClick: o.onTerm },
    { icon: nsFolderIcon(), label: 'Explorer', onClick: function(){
      openExplorer({ server: o.server, base: o.base, onNewHere: function(dir){
        openNewSession({ server: o.server, base: o.base, cwd: dir, onOpened: o.onOpened });
      } });
    } },
  ]);
}

// Login status per server: Claude and Codex for the binary last looked at in the login
// dialog there (default the plain `claude` / `codex`), AWS SSO through sso-hlp. Fetched
// ahead of the menu, so its icons open already coloured, and patched in place after.
var NS_AUTH = {};
var NS_AGENTS = [{ a: 'claude', n: 'Claude', bin: 'claude' }, { a: 'codex', n: 'Codex', bin: 'codex' }, { a: 'aws', n: 'AWS SSO', bin: 'sso-hlp.js' }];
function nsAgentGlyph(a) {
  var g = a === 'aws' ? (typeof AWS_GLYPH !== 'undefined' ? AWS_GLYPH : 'aws')
    : a === 'codex' ? (typeof OPENAI_GLYPH !== 'undefined' ? OPENAI_GLYPH : 'X')
    : (typeof CLAUDE_GLYPH !== 'undefined' ? CLAUDE_GLYPH : 'C');
  return g.replace('fill="#fff"', 'fill="currentColor"');
}
function nsAuthBin(srv, agent, set) {
  if (agent === 'aws') return 'sso-hlp.js';
  if (set) nsStore('ccbb.authBin.' + srv + '.' + agent, set);
  return nsStore('ccbb.authBin.' + srv + '.' + agent) || agent;
}
function nsSend(url, method, body) {
  return fetch(url, { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(d){
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status)); return d; }); });
}
function nsAuthText(st) {
  if (!st) return 'checking…';
  if (st.missing) return 'not available on this server';
  if (st.error && !st.loggedIn) return 'error: ' + st.error;
  if (st.agent === 'aws') return (st.loggedIn ? 'logged in' : 'not logged in') + (st.profile ? ' (' + st.profile + ')' : '')
    + (st.detail ? ' — ' + st.detail : '');
  if (!st.loggedIn) return 'not logged in';
  var who = [st.email, st.tier].filter(Boolean).join(' · ');
  var how = st.provider && st.provider !== 'firstParty' ? st.provider : (st.method || '');
  return 'logged in' + (how ? ' (' + how + ')' : '') + (who ? ' — ' + who : '');
}
// One icon of the menu's first row: green logged in, dark gray otherwise. A gray one
// starts the login straight away; a green one opens the dialog (a Codex login signs
// the current account out, so it must never start from a stray tap).
function nsAuthItem(o, g) {
  var st = (NS_AUTH[o.server] || {})[g.a];
  return { k: 'auth-' + g.a, icon: nsAgentGlyph(g.a), cls: 'ns-auic' + (st && st.loggedIn ? ' ok' : ''),
    label: g.n + ' — ' + (st ? st.bin + ': ' : '') + nsAuthText(st), hidden: !!(st && st.missing),
    onClick: function(){
      var cur = (NS_AUTH[o.server] || {})[g.a];
      openLogins({ server: o.server, base: o.base, agent: g.a, autoStart: !(cur && cur.loggedIn) });
    } };
}
function nsAuthPaint(srv) {
  document.querySelectorAll('.ns-mrow').forEach(function(row){
    if (row.dataset.srv !== srv) return;
    NS_AGENTS.forEach(function(g){
      var b = row.querySelector('[data-k="auth-' + g.a + '"]'); if (!b) return;
      var it = nsAuthItem({ server: srv }, g);
      b.className = 'ns-mi ' + it.cls; b.title = it.label; b.setAttribute('aria-label', it.label); b.hidden = it.hidden;
    });
  });
}
// maxAge: how stale a client copy may be (default 5 min: every list redraw calls this,
// and an AWS check is a live GetRoleCredentials). The server caches 30s besides.
function nsAuthRefresh(srv, base, force, maxAge) {
  var cur = NS_AUTH[srv] || (NS_AUTH[srv] = {});
  if (!force && cur._at && Date.now() - cur._at < (maxAge || 300000)) return;
  cur._at = Date.now();
  NS_AGENTS.forEach(function(g){
    var bin = nsAuthBin(srv, g.a);
    nsGet(base + '/mux/api/agent-auth?bin=' + encodeURIComponent(bin) + (force ? '&fresh=1' : '')).then(function(st){
      cur[g.a] = Object.assign({ bin: bin, agent: g.a }, st); nsAuthPaint(srv);
    }).catch(function(e){ cur[g.a] = { bin: bin, agent: g.a, loggedIn: false, error: e.message }; nsAuthPaint(srv); });
  });
}

// Copy text; resolves whether it worked. navigator.clipboard needs a secure context,
// which a phone reaching ccbb over plain http on the LAN is not; iOS then copies only
// from a real, focused, range-selected field, so that is the fallback.
function nsCopy(text) {
  if (navigator.clipboard && window.isSecureContext)
    return navigator.clipboard.writeText(text).then(function(){ return true; }, function(){ return nsCopyFallback(text); });
  return Promise.resolve(nsCopyFallback(text));
}
function nsCopyFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  // Inside the open dialog: a modal makes everything outside it inert, unfocusable.
  (document.querySelector('dialog[open]') || document.body).appendChild(ta);
  ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
  var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
  ta.remove();
  return ok;
}

// Status and login for one agent on a server. Claude and Codex pick a binary (as a new
// session does); AWS SSO is the one sso-hlp profile. o: {server, base, agent, autoStart?}
// autoStart logs in once a fresh check says not logged in — never on an unknown.
function openLogins(o) {
  var srv = o.server, uid = 'nsl' + Math.random().toString(36).slice(2, 8), poll = null, seq = 0;
  var g = NS_AGENTS.filter(function(x){ return x.a === o.agent; })[0] || NS_AGENTS[0], aws = g.a === 'aws';
  var autoStart = !!o.autoStart;
  var d = nsDialog('ns-new');
  d.innerHTML =
    '<form method="dialog">' +
      '<h3><span class="ns-lic"></span>' + g.n + ' login <span class="ns-srv"></span></h3>' +
      '<label class="ns-lbl" for="' + uid + 'b"' + (aws ? ' hidden' : '') + '>Binary</label>' +
      '<input id="' + uid + 'b" name="bin" autocomplete="off" autocapitalize="off" spellcheck="false"' + (aws ? ' hidden' : '') + ' placeholder="' + g.bin + ', ' + g.bin + '.…">' +
      '<div class="ns-bins"' + (aws ? ' hidden' : '') + '></div>' +
      '<div class="ns-row ns-ast"><span class="ns-hint" data-r="st"></span>' +
        '<button type="button" class="ns-ib" data-r="recheck" title="Check again" aria-label="Check again">&#8635;</button></div>' +
      '<div class="ns-lflow" data-r="flow" hidden>' +
        '<div class="ns-hint" data-r="step"></div>' +
        '<a class="ns-llink" data-r="link" target="_blank" rel="noopener noreferrer"></a>' +
        '<div class="ns-row" data-r="ucoderow" hidden><span class="ns-lcode" data-r="ucode"></span>' +
          '<button type="button" class="ns-btn" data-r="copy">Copy</button></div>' +
        '<div class="ns-row" data-r="coderow" hidden><input name="code" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste the code from the page">' +
          '<button type="button" class="ns-btn ns-pri" data-r="submit">Submit</button></div>' +
      '</div>' +
      '<div class="ns-err" data-r="err"></div>' +
      '<div class="ns-btns"><button type="button" class="ns-btn" data-r="cancel" hidden>Cancel login</button>' +
        '<button type="button" class="ns-btn" data-r="close">Close</button>' +
        '<button type="button" class="ns-btn ns-pri" data-r="login">Log in</button></div>' +
    '</form>';
  d.querySelector('.ns-srv').textContent = 'on ' + srv;
  d.querySelector('.ns-lic').innerHTML = nsAgentGlyph(g.a);
  var $ = function(r){ return d.querySelector('[data-r="' + r + '"]'); };
  var binEl = d.querySelector('[name=bin]'), codeEl = d.querySelector('[name=code]'), errEl = $('err'), stEl = $('st');
  var lastSt = null;
  binEl.value = nsAuthBin(srv, g.a);

  function agentOf(bin){ return aws ? 'aws' : nsAgentOf(bin); }
  function check(fresh){
    var bin = binEl.value.trim(), my = ++seq; lastSt = null;
    errEl.textContent = '';
    $('login').textContent = 'Log in';
    if (agentOf(bin) !== g.a) { stEl.className = 'ns-hint bad'; stEl.textContent = bin ? 'The name must start with ' + g.bin : ''; return; }
    stEl.className = 'ns-hint'; stEl.textContent = 'Checking ' + bin + '…';
    nsGet(o.base + '/mux/api/agent-auth?bin=' + encodeURIComponent(bin) + (fresh ? '&fresh=1' : '')).then(function(st){
      if (my !== seq) return;
      lastSt = st;
      stEl.className = 'ns-hint ' + (st.loggedIn ? 'ok' : 'bad');
      stEl.textContent = (st.loggedIn ? '✓ ' : '✗ ') + nsAuthText(st);
      $('login').textContent = st.loggedIn ? 'Log in again' : 'Log in';
      // The menu's icon follows whichever binary was last looked at here.
      nsAuthBin(srv, g.a, bin);
      (NS_AUTH[srv] = NS_AUTH[srv] || {})[g.a] = Object.assign({ bin: bin, agent: g.a }, st); nsAuthPaint(srv);
      if (autoStart && !st.loggedIn && !st.error && !st.missing && $('cancel').hidden) { autoStart = false; login(); }
      autoStart = false;
    }).catch(function(e){ if (my === seq) { autoStart = false; stEl.className = 'ns-hint bad'; stEl.textContent = e.message; } });
    nsGet(o.base + '/mux/api/agent-auth/login?bin=' + encodeURIComponent(bin)).then(function(r){
      if (my === seq) show(r.login);
    }).catch(function(){});
  }
  function show(l){
    var live = l && (l.state === 'waiting' || l.state === 'starting');
    $('flow').hidden = !l || l.state === 'cancelled';
    $('cancel').hidden = !live; $('login').hidden = live;
    clearTimeout(poll);
    if (!l) return;
    var link = $('link'); link.href = l.url || '#'; link.textContent = l.url || '';
    $('ucoderow').hidden = !l.userCode; $('ucode').textContent = l.userCode || '';
    $('coderow').hidden = !(live && l.needsCode);
    $('step').className = 'ns-hint' + (l.state === 'done' ? ' ok' : l.state === 'failed' ? ' bad' : '');
    $('step').textContent = l.state === 'done' ? '✓ Logged in.'
      : l.state === 'failed' ? 'Login failed: ' + (l.error || '')
      : l.needsCode ? '1. Open the link and sign in.  2. Paste the code it shows below.'
      : '1. Open the link and sign in.  2. Check that it shows this code:';
    if (live && !l.needsCode) poll = setTimeout(function(){
      nsGet(o.base + '/mux/api/agent-auth/login?bin=' + encodeURIComponent(l.bin)).then(function(r){ if (d.open) settle(r.login); }).catch(function(){});
    }, 3000);
  }
  function settle(l){
    show(l);
    if (l && l.state !== 'waiting' && l.state !== 'starting') { check(true); nsAuthRefresh(srv, o.base, true); }
  }
  function login(){
    var bin = binEl.value.trim();
    if (agentOf(bin) !== g.a) { errEl.textContent = 'Pick a ' + g.bin + '* binary'; return; }
    if (g.a === 'codex' && !(lastSt && !lastSt.loggedIn && !lastSt.error) &&
        !confirm('Starting a Codex login signs ' + bin + ' out first. Continue?')) return;
    var btn = $('login'); btn.disabled = true; errEl.textContent = '';
    nsAuthBin(srv, g.a, bin);
    $('flow').hidden = false; $('step').className = 'ns-hint'; $('step').textContent = 'Starting login…';
    $('link').textContent = ''; $('ucoderow').hidden = true; $('coderow').hidden = true;
    nsSend(o.base + '/mux/api/agent-auth/login', 'POST', { bin: bin, force: !!(lastSt && lastSt.loggedIn) || undefined }).then(function(r){
      settle(r.login); if (r.login && r.login.needsCode) codeEl.focus();
    }).catch(function(e){ $('flow').hidden = true; errEl.textContent = e.message; }).then(function(){ btn.disabled = false; });
  }

  if (!aws) nsFillBins(o.base, d.querySelector('.ns-bins'), binEl, g.a, null,
    function(e){ errEl.textContent = 'Could not list binaries: ' + e.message; });
  var t = null;
  binEl.addEventListener('input', function(){ clearTimeout(t); show(null); t = setTimeout(function(){ check(false); }, 250); });
  $('recheck').addEventListener('click', function(){ check(true); });
  $('close').addEventListener('click', function(){ d.close(); });
  d.addEventListener('close', function(){ clearTimeout(poll); });
  $('login').addEventListener('click', login);
  $('submit').addEventListener('click', function(){
    var code = codeEl.value.trim(); if (!code) { codeEl.focus(); return; }
    var btn = $('submit'); btn.disabled = true; errEl.textContent = '';
    $('step').textContent = 'Finishing login…';
    nsSend(o.base + '/mux/api/agent-auth/login/code', 'POST', { bin: binEl.value.trim(), code: code })
      .then(function(r){ codeEl.value = ''; settle(r.login); })
      .catch(function(e){ errEl.textContent = e.message; }).then(function(){ btn.disabled = false; });
  });
  function copyCode(){
    nsCopy($('ucode').textContent).then(function(ok){
      $('copy').textContent = ok ? 'Copied' : 'Select it';
      setTimeout(function(){ $('copy').textContent = 'Copy'; }, 1500);
    });
  }
  $('copy').addEventListener('click', copyCode);
  $('ucode').addEventListener('click', copyCode);
  codeEl.addEventListener('keydown', function(e){ if (e.key === 'Enter') { e.preventDefault(); $('submit').click(); } });
  $('cancel').addEventListener('click', function(){
    nsSend(o.base + '/mux/api/agent-auth/login', 'DELETE', { bin: binEl.value.trim() })
      .then(function(r){ show(r.login); }).catch(function(e){ errEl.textContent = e.message; });
  });
  d.querySelector('form').addEventListener('submit', function(e){ e.preventDefault(); });
  d.showModal();
  check(!!o.autoStart);
}

// The last binary, per server and per agent — a restart wants the last claude* or
// codex* used there, the new-session dialog wants whichever was used last at all.
// The old single key (one browser-wide answer) is read as a fallback, never written alone.
function nsLastBin(srv, agent) {
  var v = agent ? nsStore('ccbb.muxBin.' + srv + '.' + agent) : nsStore('ccbb.muxBin.' + srv);
  if (v) return v;
  v = nsStore('ccbb.muxBin');
  return v && (!agent || nsAgentOf(v) === agent) ? v : '';
}
function nsSaveBin(srv, bin) {
  var a = nsAgentOf(bin);
  nsStore('ccbb.muxBin.' + srv, bin);
  if (a) nsStore('ccbb.muxBin.' + srv + '.' + a, bin);
  nsStore('ccbb.muxBin', bin);
}
// The server's claude*/codex* executables (only `agent`'s, when given) as a row of
// buttons under the input. Not a <datalist>: a browser shows only the entries matching
// what is already typed, so a box prefilled with `claude` hid every codex. Tapping one
// fills the input; the one the input names is marked. cb gets the names, so an empty
// input can take the first.
function nsFillBins(base, box, input, agent, cb, onErr) {
  function mark(){
    var v = input.value.trim();
    box.querySelectorAll('.ns-bin').forEach(function(b){
      b.classList.toggle('on', b.dataset.n === v);
      // A one-line chip row scrolls sideways; keep the chosen one in sight.
      if (b.dataset.n === v && box.scrollWidth > box.clientWidth) box.scrollLeft = Math.max(0, b.offsetLeft - box.offsetLeft - 8);
    });
  }
  box.addEventListener('click', function(e){
    var b = e.target.closest('.ns-bin'); if (!b) return;
    input.value = b.dataset.n;
    input.dispatchEvent(new Event('input'));
  });
  input.addEventListener('input', mark);
  nsGet(base + '/mux/api/bins').then(function(r){
    var names = [];
    (r.bins || []).forEach(function(b){
      if (agent && b.agent !== agent) return;
      var el = document.createElement('button');
      el.type = 'button'; el.className = 'ns-bin ' + b.agent; el.dataset.n = b.name; el.title = b.path; el.textContent = b.name;
      box.appendChild(el);
      names.push(b.name);
    });
    if (!names.length) box.innerHTML = '<span class="ns-hint">No ' + (agent || 'claude or codex') + ' binaries on this server\u2019s PATH</span>';
    if (cb) cb(names, (r.bins || []).filter(function(b){ return !agent || b.agent === agent; }));
    mark();
  }).catch(function(e){ if (onErr) onErr(e); });
}

// The binary, model and Compact at to restart a session with. Resolves to
// {bin, model, compactAt} — spread it into the POST — or null when cancelled.
// o: {server, base, agent: 'claude'|'codex', title?}
function pickBinary(o) {
  return new Promise(function(resolve){
    var uid = 'nsp' + Math.random().toString(36).slice(2, 8), done = false;
    var d = nsDialog('ns-new ns-sheet');
    var label = o.agent === 'codex' ? 'Codex' : 'Claude';
    d.innerHTML =
      '<form method="dialog">' +
        '<h3 tabindex="-1" autofocus>Restart ' + label + ' session <span class="ns-srv"></span></h3>' +
        '<div class="ns-body">' +
          '<div class="ns-hint ns-ttl"></div>' +
          '<label class="ns-lbl" for="' + uid + 'b">Binary</label>' +
          '<div class="ns-row ns-binrow"><input id="' + uid + 'b" name="bin" class="ns-binin" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="' + o.agent + '…">' +
            '<div class="ns-bins"></div></div>' +
          nsSettingsHtml(uid) +
          '<div class="ns-hint" data-r="compact"></div>' +
        '</div>' +
        '<div class="ns-err" data-r="err"></div>' +
        '<div class="ns-btns"><button type="button" class="ns-btn" data-r="cancel">Cancel</button>' +
          '<button type="submit" class="ns-btn ns-pri">Restart</button></div>' +
      '</form>';
    d.querySelector('.ns-srv').textContent = 'on ' + o.server;
    var ttl = d.querySelector('.ns-ttl');
    if (o.title) ttl.textContent = o.title; else ttl.remove();
    var f = d.querySelector('form'), binEl = f.elements.bin, errEl = d.querySelector('[data-r="err"]');
    binEl.value = nsLastBin(o.server, o.agent);
    var settings = nsSettings(o.base, f, binEl), cEl = d.querySelector('[data-r="compact"]');
    // Said only while a size is chosen: one under what the session already holds
    // compacts it on its first turn back.
    function compactNote(){ cEl.textContent = settings.get().compactAt !== 'default' ? 'If the session is already past this, it compacts on the next turn.' : ''; }
    f.elements.compact.addEventListener('change', compactNote);
    var binT = null;
    binEl.addEventListener('input', function(){ clearTimeout(binT); binT = setTimeout(function(){ settings.binChanged(); compactNote(); }, 200); });
    nsFillBins(o.base, d.querySelector('.ns-bins'), binEl, o.agent, function(names, bins){
      if (!binEl.value && names.length) binEl.value = names[0];
      settings.bins(bins); compactNote();
    }, function(e){ errEl.textContent = 'Could not list binaries: ' + e.message; });
    function finish(v){ if (done) return; done = true; if (d.open) d.close(); resolve(v); }
    d.addEventListener('close', function(){ finish(null); });
    d.querySelector('[data-r="cancel"]').addEventListener('click', function(){ finish(null); });
    d.querySelector('form').addEventListener('submit', function(e){
      e.preventDefault();
      var bin = binEl.value.trim();
      if (nsAgentOf(bin) !== o.agent) { errEl.textContent = bin ? 'A ' + label + ' session needs a binary whose name starts with ' + o.agent : 'Pick a binary'; binEl.focus(); return; }
      nsSaveBin(o.server, bin);
      var pick = settings.get();
      finish({ bin: bin, model: pick.model, compactAt: pick.compactAt });
    });
    nsFollowViewport(d);
    d.showModal();
    if (!nsNarrow()) { binEl.focus(); binEl.select(); }
  });
}

function nsDialog(cls) {
  var d = document.createElement('dialog');
  d.className = 'ns-dlg ' + cls;
  d.addEventListener('close', function(){ d.remove(); });
  // A tap on the backdrop lands on the dialog element itself. Not on a phone: there a tap
  // outside is how the keyboard gets put away, and it should not take the form with it.
  d.addEventListener('click', function(e){ if (e.target === d && !nsNarrow()) d.close(); });
  document.body.appendChild(d);
  return d;
}

// Size options for Compact at; a remembered or typed value outside these is added.
var NS_COMPACT = [100000, 200000, 300000, 500000, 800000];
function nsK(n) { return n >= 1e6 ? +(n / 1e6).toFixed(2) + 'M' : Math.round(n / 1e3) + 'K'; }
// Follows the visual viewport while a sheet is open: on a phone the keyboard shrinks it
// and Safari pans it, and a dialog centred in the layout viewport ends up under the
// keyboard. Sets --vh/--vtop on the dialog only, so it needs nothing from the page.
function nsFollowViewport(d) {
  var vv = window.visualViewport; if (!vv) return;
  function sync(){ d.style.setProperty('--vh', vv.height + 'px'); d.style.setProperty('--vtop', vv.offsetTop + 'px'); }
  vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync);
  d.addEventListener('close', function(){ vv.removeEventListener('resize', sync); vv.removeEventListener('scroll', sync); });
  sync();
}
// A <select> with an "Other…" entry that reveals a text field. opts: [{v, t}].
// get() is the select's value, or the typed one under Other; set(v) picks v, adding it.
function nsPickField(sel, other, opts) {
  function fill(list){
    sel.innerHTML = '';
    list.concat([{ v: '\u0000other', t: 'Other…' }]).forEach(function(x){
      var op = document.createElement('option'); op.value = x.v; op.textContent = x.t; sel.appendChild(op);
    });
  }
  fill(opts);
  sel.addEventListener('change', function(){
    other.hidden = sel.value !== '\u0000other';
    if (!other.hidden) other.focus();
  });
  return {
    get: function(){ return sel.value === '\u0000other' ? other.value.trim() : sel.value; },
    set: function(v, t){
      v = v == null ? '' : String(v);
      if (![].some.call(sel.options, function(op){ return op.value === v; })) {
        var op = document.createElement('option'); op.value = v; op.textContent = t || v;
        // In order among the sizes, else just before Other….
        var after = [].filter.call(sel.options, function(x){ return +x.value > +v; })[0];
        sel.insertBefore(op, +v && after ? after : sel.lastChild);
      }
      sel.value = v; other.hidden = true;
    },
    fill: function(list){ var cur = sel.value; fill(list); if ([].some.call(sel.options, function(op){ return op.value === cur; })) sel.value = cur; other.hidden = sel.value !== '\u0000other'; },
  };
}

// Model + Compact at, side by side — the new-session and restart dialogs both.
function nsSettingsHtml(uid) {
  var other = function(id, name, ph){ return '<input id="' + uid + id + '" name="' + name + '" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go" placeholder="' + ph + '" hidden>'; };
  return '<div class="ns-pair">' +
      '<div><label class="ns-lbl" for="' + uid + 'm">Model</label><select id="' + uid + 'm" name="model"></select>' +
        other('mo', 'modelOther', 'model id') + '</div>' +
      '<div><label class="ns-lbl" for="' + uid + 'k" title="Auto-compact once the context reaches this many tokens">Compact at</label><select id="' + uid + 'k" name="compact"></select>' +
        other('ko', 'compactOther', '300k, 1.5m') + '</div>' +
    '</div>';
}
// Wires nsSettingsHtml's fields in form f to the binary in binEl: the model list and the
// remembered Compact at follow it. bins(list) takes nsFillBins's entries; binChanged()
// re-reads binEl; get() is what to send — {model, compactAt}, where Default sends
// 'default', which is also what this binary's dialog offers next time.
function nsSettings(base, f, binEl) {
  var model = nsPickField(f.elements.model, f.elements.modelOther, [{ v: '', t: 'Default' }]);
  var compact = nsPickField(f.elements.compact, f.elements.compactOther,
    [{ v: '', t: 'Default' }].concat(NS_COMPACT.map(function(n){ return { v: String(n), t: nsK(n) }; })));
  var remembered = {}, modelsFor = null, binsReady = false;
  function binChanged(){
    var bin = binEl.value.trim(), a = nsAgentOf(bin);
    if (binsReady) { var r = remembered[bin]; compact.set(r ? String(r) : '', r ? nsK(r) : ''); }
    var key = a === 'codex' ? 'codex:' + bin : a;
    if (a && key !== modelsFor) {
      modelsFor = key;
      nsGet(base + '/mux/api/models?bin=' + encodeURIComponent(bin)).then(function(r){
        if (modelsFor !== key) return;
        var def = (r.models || []).filter(function(m){ return m.isDefault; })[0];
        model.fill([{ v: '', t: 'Default' + (def ? ' (' + def.name + ')' : '') }].concat((r.models || []).map(function(m){ return { v: m.id, t: m.name }; })));
      }).catch(function(){ if (modelsFor === key) model.fill([{ v: '', t: 'Default' }]); });
    }
  }
  return {
    bins: function(list){ (list || []).forEach(function(b){ remembered[b.name] = b.compactAt; }); binsReady = true; binChanged(); },
    binChanged: binChanged,
    disable: function(on){ f.elements.model.disabled = f.elements.compact.disabled = !!on; },
    disabled: function(){ return f.elements.compact.disabled; },
    get: function(){ return { model: model.get() || undefined, compactAt: compact.get() || 'default' }; },
  };
}

// o: {server, base, cwd?, onOpened(session)}
function openNewSession(o) {
  var srv = o.server, uid = 'ns' + Math.random().toString(36).slice(2, 8);
  var d = nsDialog('ns-new ns-sheet');
  // enterkeyhint: the phone keyboard's Return reads "Go", and Enter submits the form.
  var inp = function(id, name, ph, extra){
    return '<input id="' + uid + id + '" name="' + name + '" autocomplete="off" spellcheck="false" enterkeyhint="go"' +
      (/autocapitalize/.test(extra || '') ? '' : ' autocapitalize="off"') +
      (ph ? ' placeholder="' + ph + '"' : '') + (extra || '') + '>';
  };
  d.innerHTML =
    '<form method="dialog">' +
      // The heading takes the focus showModal() gives out: on a phone, focusing the first
      // input would put the keyboard over the form before anything is picked.
      '<h3 tabindex="-1" autofocus>New session <span class="ns-srv"></span></h3>' +
      '<div class="ns-body">' +
        '<label class="ns-lbl" for="' + uid + 't">Title</label>' +
        inp('t', 'title', 'Optional — the agent names it otherwise', ' autocapitalize="sentences"') +
        '<label class="ns-lbl" for="' + uid + 'b">Binary</label>' +
        '<div class="ns-row ns-binrow">' + inp('b', 'bin', 'claude…', ' class="ns-binin"') + '<div class="ns-bins"></div></div>' +
        '<div class="ns-hint bad" data-r="agent"></div>' +
        '<label class="ns-lbl" for="' + uid + 'c">Directory</label>' +
        '<div class="ns-row">' + inp('c', 'cwd', '~/src/project') +
          '<button type="button" class="ns-ib" data-r="check" title="Check that it exists" aria-label="Check directory">&#10003;</button>' +
          '<button type="button" class="ns-ib" data-r="browse" title="Browse" aria-label="Browse directories">' + nsFolderIcon() + '</button></div>' +
        '<div class="ns-hint" data-r="cwdmsg"></div>' +
        nsSettingsHtml(uid) +
        '<div class="ns-hint" data-r="setmsg"></div>' +
        '<details class="ns-more"><summary>Resume or fork</summary>' +
          '<label class="ns-lbl" for="' + uid + 'r">Session / thread id</label>' +
          inp('r', 'resume', 'New session when empty', ' list="' + uid + 'rl"') +
          '<datalist id="' + uid + 'rl"></datalist>' +
          '<label class="ns-chk"><input type="checkbox" name="fork"> Fork into a new session</label>' +
        '</details>' +
      '</div>' +
      '<div class="ns-err" data-r="err"></div>' +
      '<div class="ns-btns"><button type="button" class="ns-btn" data-r="cancel">Cancel</button>' +
        '<button type="submit" class="ns-btn ns-pri">Start</button></div>' +
    '</form>';
  d.querySelector('.ns-srv').textContent = 'on ' + srv;
  var f = d.querySelector('form'), binEl = f.elements.bin, cwdEl = f.elements.cwd;
  var $ = function(r){ return d.querySelector('[data-r="' + r + '"]'); };
  var agentEl = $('agent'), cwdMsg = $('cwdmsg'), setMsg = $('setmsg'), errEl = $('err');
  var settings = nsSettings(o.base, f, binEl), loaded = {};

  binEl.value = nsLastBin(srv);
  cwdEl.value = o.cwd || nsStore('ccbb.nsCwd.' + srv) || '';

  nsFillBins(o.base, d.querySelector('.ns-bins'), binEl, null, function(names, bins){
    if (!binEl.value && names.length) binEl.value = names[0];
    settings.bins(bins);
    binChanged();
  }, function(e){ agentEl.textContent = 'Could not list binaries: ' + e.message; });

  // Model list and the remembered Compact at both follow the binary.
  function binChanged(){
    var bin = binEl.value.trim(), a = nsAgentOf(bin);
    agentEl.textContent = bin && !a ? 'The name must start with claude or codex' : '';
    settings.binChanged();
    // Codex can pick up a thread another client already has loaded; offer those.
    if (a === 'codex' && !loaded._asked) {
      loaded._asked = true;
      nsGet(o.base + '/mux/api/codex/loaded').then(function(r){
        var dl = d.querySelector('#' + uid + 'rl'); dl.innerHTML = '';
        (r.threads || []).forEach(function(t){
          loaded[t.id] = true;
          var op = document.createElement('option'); op.value = t.id; op.label = t.title + (t.cwd ? ' — ' + t.cwd : ''); dl.appendChild(op);
        });
        resumeChanged();
      }).catch(function(){});
    }
    resumeChanged();
  }
  // Attaching to a Codex thread something else already has loaded changes nothing about
  // it — the model and Compact at would be silently ignored, so they are switched off.
  function resumeChanged(){
    var ref = f.elements.resume.value.trim().replace(/^codex:/, '');
    var held = nsAgentOf(binEl.value) === 'codex' && ref && !f.elements.fork.checked && loaded[ref];
    settings.disable(held);
    setMsg.textContent = held ? 'Already loaded elsewhere — it keeps its own model and Compact at.' : '';
  }
  var binT = null;
  binEl.addEventListener('input', function(){ clearTimeout(binT); binT = setTimeout(binChanged, 200); });
  f.elements.resume.addEventListener('input', resumeChanged);
  f.elements.fork.addEventListener('change', resumeChanged);

  var checkSeq = 0;
  function check(){
    var p = cwdEl.value.trim(), seq = ++checkSeq;
    if (!p) { cwdMsg.className = 'ns-hint bad'; cwdMsg.textContent = 'A working directory is required'; return; }
    cwdMsg.className = 'ns-hint'; cwdMsg.textContent = 'Checking…';
    nsGet(o.base + '/api/fs/stat?path=' + encodeURIComponent(p)).then(function(r){
      if (seq !== checkSeq) return;
      cwdMsg.className = 'ns-hint ' + (r.dir ? 'ok' : 'bad');
      cwdMsg.textContent = (r.dir ? '✓ ' : r.exists ? 'Not a directory: ' : 'Does not exist: ') + r.path;
    }).catch(function(e){ if (seq === checkSeq) { cwdMsg.className = 'ns-hint bad'; cwdMsg.textContent = e.message; } });
  }
  cwdEl.addEventListener('input', function(){ checkSeq++; cwdMsg.textContent = ''; });
  $('check').addEventListener('click', check);
  $('browse').addEventListener('click', function(){
    openExplorer({ server: srv, base: o.base, start: cwdEl.value.trim() || '~', pick: true,
      onPick: function(p){ cwdEl.value = p; check(); } });
  });
  $('cancel').addEventListener('click', function(){ d.close(); });

  f.addEventListener('submit', function(e){
    e.preventDefault();
    var bin = binEl.value.trim(), agent = nsAgentOf(bin);
    if (!agent) { errEl.textContent = bin ? 'The binary’s name must start with claude or codex' : 'Pick a binary'; binEl.focus(); return; }
    // Required: left empty, the session would start wherever ccbb web itself was
    // launched, which is nobody's project.
    if (!cwdEl.value.trim()) { errEl.textContent = 'Pick a working directory'; check(); cwdEl.focus(); return; }
    var held = settings.disabled(), pick = settings.get();
    var body = { agent: agent, bin: bin, cwd: cwdEl.value.trim(),
      resume: f.elements.resume.value.trim() || undefined, fork: f.elements.fork.checked || undefined,
      name: f.elements.title.value.trim() || undefined,
      model: held ? undefined : pick.model, compactAt: held ? undefined : pick.compactAt };
    var sub = f.querySelector('button[type=submit]');
    sub.disabled = true; errEl.textContent = '';
    fetch(o.base + '/mux/api/sessions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ return { r: r, j: j }; }); })
      .then(function(x){
        if (!x.r.ok && !(x.r.status === 409 && x.j.reason === 'running-in-mux')) throw new Error(x.j.error || 'Could not start the session');
        nsSaveBin(srv, bin);
        nsStore('ccbb.nsCwd.' + srv, body.cwd);
        d.close();
        o.onOpened(x.j.session || { id: (agent === 'codex' && body.resume.indexOf('codex:') !== 0 ? 'codex:' : '') + body.resume, title: '' });
      })
      .catch(function(err){ errEl.textContent = err.message; sub.disabled = false; });
  });
  nsFollowViewport(d);
  d.showModal();
  // A desktop has no keyboard to pop: put the cursor where typing is next useful.
  if (!nsNarrow()) { if (!binEl.value) binEl.focus(); else if (!cwdEl.value) cwdEl.focus(); else f.elements.title.focus(); }
}

// The explorer, three ways. Pick (📁 in the dialog) is a modal, since it has to sit
// above the modal dialog; a phone gets the same modal at full screen. Browse on the
// desktop is a floating window, one per server like the terminal, that keeps its place,
// its size and the directory it was left in.
// o: {server, base, start?, pick?, onPick(path)?, onNewHere(path)?}
var NS_EXP_WINS = {};
function nsNarrow() { return window.matchMedia('(max-width:600px)').matches || typeof floatWin !== 'function'; }
function openExplorer(o) {
  if (o.pick || nsNarrow()) return nsExplorerModal(o);
  var existing = NS_EXP_WINS[o.server];
  if (existing && existing.isConnected) {
    existing.classList.remove('min');
    existing.style.zIndex = ++FLW_Z;
    if (o.start && existing._go) existing._go(o.start);
    return existing;
  }
  var dirKey = 'ccbb.expDir.' + o.server;
  var w = floatWin(o.server + ': explorer', function(host){
    host.classList.add('ns-xwin');
    host._go = explorerBody(host, {
      server: o.server, base: o.base, start: o.start || nsStore(dirKey) || '~', onNewHere: o.onNewHere,
      onDir: function(p){ nsStore(dirKey, p); if (w) w.querySelector('.flw-title').textContent = o.server + ': ' + p; },
      onPop: function(r){
        floatWin(o.server + ': ' + r.path, function(h){ nsFileView(h, r); }, null, null, { reload: function(h){
          nsGet(o.base + '/api/fs/cat?path=' + encodeURIComponent(r.path)).then(function(nr){
            var y = h.scrollTop; h.innerHTML = ''; nsFileView(h, nr); h.scrollTop = y;
          }).catch(function(e){ h.innerHTML = '<div class="ns-xmsg bad"></div>'; h.firstChild.textContent = e.message; });
        } });
      },
    });
  }, null, function(){ delete NS_EXP_WINS[o.server]; }, { persist: 'ccbb.flw.exp.' + o.server });
  w._go = w.querySelector('.flw-body')._go;
  NS_EXP_WINS[o.server] = w;
  return w;
}
function nsExplorerModal(o) {
  var d = nsDialog('ns-exp' + (o.pick ? ' ns-pick' : ''));
  // The picker is resizable; its size (not place: a modal is centred) is remembered.
  var sizeKey = 'ccbb.nsPickSize', sz = null;
  if (o.pick && !nsNarrow()) {
    try { sz = JSON.parse(nsStore(sizeKey) || 'null'); } catch (e) {}
    if (sz && sz.w > 200 && sz.h > 160) {
      d.style.width = Math.min(sz.w, window.innerWidth - 16) + 'px';
      d.style.height = Math.min(sz.h, window.innerHeight - 16) + 'px';
    }
    var t = null;
    if (typeof ResizeObserver === 'function') new ResizeObserver(function(){
      if (!d.open) return;
      clearTimeout(t);
      t = setTimeout(function(){ nsStore(sizeKey, JSON.stringify({ w: d.offsetWidth, h: d.offsetHeight })); }, 300);
    }).observe(d);
  }
  explorerBody(d, {
    server: o.server, base: o.base, start: o.start, pick: o.pick, close: function(){ d.close(); },
    onPick: o.onPick && function(p){ d.close(); o.onPick(p); },
    onNewHere: o.onNewHere && function(p){ d.close(); o.onNewHere(p); },
  });
  d.showModal();
  return d;
}
// A file as the viewer draws it: the //cat renderer, with a note when it was cut short.
// Markdown and HTML have two faces — Preview (rendered; HTML in the sandboxed frame
// //ihtml uses) and Text (the source) — and a switch between them; the last one picked
// is the one every viewer opens in, a popped-out window included. A truncated document
// is Text only: half an HTML page renders as something it never was.
function nsFileView(host, r) {
  var wrap = document.createElement('div');
  wrap.className = 'ns-fv';
  host.appendChild(wrap);
  var dual = (r.kind === 'markdown' || r.kind === 'html') && !r.truncated;
  var bar = null;
  if (r.truncated || dual) {
    bar = document.createElement('div'); bar.className = 'ns-fvbar';
    if (r.truncated) {
      var n = document.createElement('span'); n.className = 'ns-fvnote';
      n.textContent = 'Showing the first ' + nsSize(r.content.length) + ' of ' + nsSize(r.size);
      bar.appendChild(n);
    }
    if (dual) {
      var seg = document.createElement('span'); seg.className = 'ns-seg';
      seg.innerHTML = '<button type="button" data-m="preview">Preview</button><button type="button" data-m="text">Text</button>';
      bar.appendChild(seg);
      seg.addEventListener('click', function(e){
        var b = e.target.closest('[data-m]'); if (!b) return;
        nsStore('ccbb.nsViewMode', b.dataset.m); draw();
      });
    }
    wrap.appendChild(bar);
  }
  var content = null;
  function draw(){
    var mode = dual && nsStore('ccbb.nsViewMode') === 'text' ? 'text' : 'preview';
    if (bar) bar.querySelectorAll('[data-m]').forEach(function(b){ b.classList.toggle('on', b.dataset.m === mode); });
    var d = (mode === 'text' || !dual) && (r.kind === 'markdown' || r.kind === 'html')
      ? { kind: 'source', lang: r.lang, content: r.content } : r;
    var next = typeof renderCmdOutput === 'function' ? renderCmdOutput(d)
      : (function(){ var pre = document.createElement('pre'); pre.textContent = r.content; return pre; })();
    if (content) wrap.replaceChild(next, content); else wrap.appendChild(next);
    content = next;
  }
  draw();
}
// The explorer itself, drawn into `root`. o: {server, base, start?, pick?, close?,
// onPick?, onNewHere?, onDir?(path), onPop?(file)} — close absent means the container
// has its own close; onPop present offers ⧉ on an open file.
function explorerBody(root, o) {
  root.innerHTML =
    '<div class="ns-xhead">' +
      '<button type="button" class="ns-ib" data-r="up" title="Parent directory" aria-label="Parent directory">&#8593;</button>' +
      '<input data-r="path" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Path">' +
      '<button type="button" class="ns-ib" data-r="hid" title="Show hidden files" aria-label="Show hidden files">.*</button>' +
      '<button type="button" class="ns-ib" data-r="reload" title="Reload" aria-label="Reload">&#8635;</button>' +
      (o.onPop ? '<button type="button" class="ns-ib" data-r="pop" title="Detach to a floating window" aria-label="Detach to a floating window" hidden>&#10697;</button>' : '') +
      (o.close ? '<button type="button" class="ns-ib" data-r="x" title="Close" aria-label="Close">&#10005;</button>' : '') +
    '</div>' +
    '<div class="ns-xbody" data-r="body"></div>' +
    '<div class="ns-xfoot"><span class="ns-xsrv"></span>' +
      '<button type="button" class="ns-btn ns-pri" data-r="act"></button></div>';
  var q = function(r){ return root.querySelector('[data-r="' + r + '"]'); };
  var pathEl = q('path'), bodyEl = q('body'), hidBtn = q('hid'), actBtn = q('act'), upBtn = q('up'), popBtn = q('pop');
  root.querySelector('.ns-xsrv').textContent = o.server;
  var showHidden = nsStore('ccbb.nsHidden') === '1';
  var cur = null, viewing = null, seq = 0;
  hidBtn.classList.toggle('on', showHidden);
  actBtn.textContent = o.pick ? 'Use this directory' : 'New session here';
  if (!o.pick && !o.onNewHere) actBtn.hidden = true;

  function listMode(){
    viewing = null; if (popBtn) popBtn.hidden = true;
    pathEl.value = cur.path; upBtn.disabled = !cur.parent; actBtn.disabled = false;
  }
  // keep: a reload, which leaves the old content up until the new arrives and comes
  // back to the same scroll position.
  function ls(p, keep){
    var my = ++seq, y = bodyEl.scrollTop;
    if (!keep) bodyEl.innerHTML = '<div class="ns-xmsg">Loading…</div>';
    nsGet(o.base + '/api/fs/ls?path=' + encodeURIComponent(p)).then(function(r){
      if (my !== seq) return;
      cur = r; listMode(); render();
      if (keep) bodyEl.scrollTop = y;
      if (o.onDir) o.onDir(r.path);
    }).catch(function(e){
      if (my !== seq) return;
      bodyEl.innerHTML = '<div class="ns-xmsg bad"></div>'; bodyEl.firstChild.textContent = e.message;
      // Somewhere remembered that has since gone: fall back home rather than strand it.
      if (!cur && p !== '~') return ls('~');
      if (cur) pathEl.value = p;
    });
  }
  function render(){
    var rows = cur.entries.filter(function(e){
      return (showHidden || e.name.charAt(0) !== '.') && (!o.pick || e.dir);
    });
    if (!rows.length) { bodyEl.innerHTML = '<div class="ns-xmsg">Empty</div>'; return; }
    bodyEl.innerHTML = rows.map(function(e){
      return '<button type="button" class="ns-xrow' + (e.dir ? ' dir' : '') + (e.broken ? ' broken' : '') + '" data-n="' + esc(e.name) + '">' +
        (e.dir ? nsFolderIcon() : nsFileIcon()) + '<span class="ns-xn">' + esc(e.name) + (e.dir ? '/' : '') + '</span>' +
        (e.dir ? '' : '<span class="ns-xs">' + nsSize(e.size) + '</span>') + '</button>';
    }).join('');
    bodyEl.scrollTop = 0;
  }
  function join(dir, name){ return dir.replace(/\/+$/, '') + '/' + name; }
  function cat(p, keep){
    var my = ++seq, y = bodyEl.scrollTop;
    if (!keep) bodyEl.innerHTML = '<div class="ns-xmsg">Loading…</div>';
    nsGet(o.base + '/api/fs/cat?path=' + encodeURIComponent(p)).then(function(r){
      if (my !== seq) return;
      viewing = r; pathEl.value = r.path; upBtn.disabled = false; actBtn.disabled = true;
      if (popBtn) popBtn.hidden = false;
      bodyEl.innerHTML = '';
      nsFileView(bodyEl, r);
      bodyEl.scrollTop = keep ? y : 0;
    }).catch(function(e){
      if (my !== seq) return;
      bodyEl.innerHTML = '<div class="ns-xmsg bad"></div>'; bodyEl.firstChild.textContent = e.message;
    });
  }
  bodyEl.addEventListener('click', function(e){
    var row = e.target.closest('.ns-xrow'); if (!row || !cur) return;
    var p = join(cur.path, row.dataset.n);
    if (row.classList.contains('dir')) ls(p); else cat(p);
  });
  // Up from a file goes back to the listing it was opened from.
  q('reload').addEventListener('click', function(){
    if (viewing) cat(viewing.path, true);
    else if (cur) ls(cur.path, true);
  });
  upBtn.addEventListener('click', function(){
    if (viewing && cur) { listMode(); render(); }
    else if (cur && cur.parent) ls(cur.parent);
  });
  if (popBtn) popBtn.addEventListener('click', function(){
    if (!viewing) return;
    o.onPop(viewing);
    if (cur) { listMode(); render(); }
  });
  pathEl.addEventListener('keydown', function(e){
    if (e.key !== 'Enter') return;
    e.preventDefault();
    // A path the server says is a file opens as one; anything else lists (or errors).
    var p = pathEl.value.trim() || '~';
    nsGet(o.base + '/api/fs/stat?path=' + encodeURIComponent(p)).then(function(r){
      if (r.exists && !r.dir && !o.pick) cat(r.path); else ls(r.path);
    }).catch(function(){ ls(p); });
  });
  hidBtn.addEventListener('click', function(){
    showHidden = !showHidden; nsStore('ccbb.nsHidden', showHidden ? '1' : '0');
    hidBtn.classList.toggle('on', showHidden);
    if (cur && !viewing) render();
  });
  actBtn.addEventListener('click', function(){
    if (!cur) return;
    if (o.pick) o.onPick(cur.path); else o.onNewHere(cur.path);
  });
  if (o.close) q('x').addEventListener('click', o.close);
  ls(o.start || '~');
  return ls;
}

const CSS = `
.ns-menu{position:fixed;z-index:1000;min-width:170px;padding:4px;border:1px solid var(--line);border-radius:10px;
  background:var(--bg);box-shadow:0 6px 24px rgba(0,0,0,.18);display:flex;flex-direction:column}
.ns-mi{display:flex;align-items:center;gap:10px;background:none;border:none;color:var(--ink);font:inherit;font-size:14px;
  text-align:left;padding:8px 10px;border-radius:7px;cursor:pointer;min-height:36px}
.ns-mi:hover:not(:disabled),.ns-mi:active:not(:disabled){background:var(--accent-soft)}
.ns-mi:disabled{opacity:.45;cursor:default}
.ns-dock{flex:none;order:-1;display:flex;flex-wrap:wrap;gap:2px;padding:4px;border-bottom:1px solid var(--line);background:var(--bg)}
.ns-dock>.ns-mi{justify-content:center;padding:0;width:38px;min-height:34px}
.ns-dock .ns-mic{width:auto;font-size:13px}
.ns-wbs{margin-left:auto;display:flex;gap:2px}
.ns-wbs>.ns-mi{justify-content:center;padding:0;width:38px;min-height:34px}
.ns-wbs>.ns-mi[hidden]{display:none}
.ns-wb .ns-mic{font-family:inherit;font-weight:400;font-size:15px}
.vb-head.open.docked{display:flex;flex-direction:column}
.vb-head.docked>:not(.ns-dock){min-width:0}
.subhead.has-menu{display:grid;grid-template-columns:minmax(0,1fr);padding:0 0 7px}
.subhead.has-menu>*{padding-left:12px;padding-right:12px}
.subhead.has-menu>.ns-dock{grid-row:1;padding:4px;margin-bottom:6px}
.ns-narrow .bar-btns>.vb-btn:not(.vb-dots),.ns-narrow .pbtns>.pbtn:not(.pdots),.ns-narrow .phead>.pbtn,
.ns-narrow .srv-badge,.ns-narrow .phead .srv{display:none}
.ns-stack .vb-head .sv-stats,.ns-stack .vb-head .sv-stats *{white-space:normal;overflow-wrap:anywhere}
.ns-mic{width:20px;display:inline-flex;justify-content:center;font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:12px;color:var(--ink-soft)}
.ns-ico{flex:none;display:block}
.ns-dlg{border:1px solid var(--line);border-radius:12px;padding:0;background:var(--bg);color:var(--ink);
  width:min(520px,calc(100vw - 32px));max-height:calc(100dvh - 32px);margin:auto;box-shadow:0 10px 40px rgba(0,0,0,.25)}
.ns-dlg::backdrop{background:rgba(0,0,0,.35)}
.ns-dlg form{display:flex;flex-direction:column;gap:6px;padding:16px}
.ns-dlg h3{font-size:16px;margin-bottom:6px}
.ns-srv{font-weight:400;color:var(--ink-soft)}
.ns-lbl{font-size:12px;color:var(--ink-soft);margin-top:6px}
.ns-dlg input:not([type=checkbox]){width:100%;min-width:0;font:inherit;font-size:14px;color:var(--ink);background:var(--surface,var(--bg));
  border:1px solid var(--line);border-radius:7px;padding:7px 9px}
.ns-dlg input::placeholder{color:var(--ink-faint);opacity:.6}
.ns-dlg input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.ns-row{display:flex;gap:6px;align-items:center}
.ns-bins{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
.ns-bin{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;padding:4px 10px;border-radius:999px;cursor:pointer;
  border:1px solid var(--line);background:var(--bg-alt);color:var(--ink-soft)}
.ns-bin:hover{border-color:var(--accent);color:var(--ink)}
.ns-bin.on{border-color:var(--accent);background:var(--accent-soft);color:var(--ink)}
.ns-ib{flex:none;min-width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;font:inherit;font-size:15px;
  color:var(--ink-soft);background:var(--bg-alt);border:1px solid var(--line);border-radius:7px;cursor:pointer;padding:0 8px}
.ns-ib:hover{color:var(--ink);border-color:var(--accent)}
.ns-ib:disabled{opacity:.4;cursor:default}
.ns-ib.on{color:var(--accent);border-color:var(--accent);background:var(--accent-soft)}
.ns-hint{font-size:12px;color:var(--ink-faint);min-height:16px;word-break:break-all}
.ns-hint.ok{color:var(--ok)} .ns-hint.bad{color:var(--err)}
.ns-more{margin-top:4px;font-size:13px;color:var(--ink-soft)}
.ns-more summary{cursor:pointer;padding:4px 0}
.ns-more[open]{display:flex;flex-direction:column;gap:6px}
.ns-chk{display:flex;align-items:center;gap:6px;font-size:13px}
.ns-err{color:var(--err);font-size:13px;min-height:0;word-break:break-word}
.ns-err:empty{display:none}
.ns-btns{display:flex;justify-content:flex-end;gap:8px;margin-top:10px}
.ns-btn{font:inherit;font-size:14px;padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--bg-alt);color:var(--ink);cursor:pointer}
.ns-btn.ns-pri{background:var(--accent);border-color:var(--accent);color:#fff}
.ns-btn:disabled{opacity:.5;cursor:default}
.ns-btn[hidden]{display:none}
.ns-exp{width:min(760px,calc(100vw - 32px));height:min(680px,calc(100dvh - 32px))}
.ns-pick{resize:both;overflow:hidden;min-width:320px;min-height:240px}
.ns-ttl{color:var(--ink-soft);font-size:13px;margin:-4px 0 4px;word-break:break-word}
.ns-ib[hidden]{display:none}
.flw-body.ns-xwin{overflow:hidden}
.ns-exp[open]{display:flex;flex-direction:column}
.ns-xhead{flex:none;display:flex;gap:6px;align-items:center;padding:10px;border-bottom:1px solid var(--line);background:var(--bg-alt)}
.ns-xhead input{flex:1;font-family:ui-monospace,Menlo,monospace!important;font-size:13px!important}
.ns-xbody{flex:1 1 auto;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch}
.ns-xrow{display:flex;align-items:center;gap:9px;width:100%;background:none;border:none;border-bottom:1px solid var(--line-soft,var(--line));
  color:var(--ink);font:inherit;font-size:14px;text-align:left;padding:8px 12px;cursor:pointer;min-height:38px}
.ns-xrow:hover,.ns-xrow:active{background:var(--accent-soft)}
.ns-xrow.dir .ns-ico{color:var(--accent)}
.ns-xrow:not(.dir) .ns-ico{color:var(--ink-faint)}
.ns-xrow.broken{opacity:.5}
.ns-xn{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ns-xs{flex:none;font-size:11.5px;color:var(--ink-faint);font-variant-numeric:tabular-nums}
.ns-xmsg{padding:14px;color:var(--ink-faint);font-size:13px}
.ns-xmsg.bad{color:var(--err)}
.ns-fv>.cmd-content{padding:0;overflow:visible}
.ns-fv>.cmd-content pre{margin:0;border:none;border-radius:0;background:none;padding:10px 12px;font-size:12.5px;white-space:pre;overflow:visible}
.ns-fv>.cmd-content.md{padding:12px 16px}
.ns-fv>.cmd-content.md pre{background:var(--code-bg,var(--bg-alt));border-radius:6px}
.ns-xbody{display:flex;flex-direction:column}
.ns-xbody>.ns-xrow,.ns-xbody>.ns-xmsg{flex:none}
.ns-fv{display:flex;flex-direction:column;flex:1 0 auto}
.ns-fv>.cmd-content.html{flex:1 1 auto;min-height:320px;padding:0;display:flex;flex-direction:column}
.ns-fv>.cmd-content.html .html-frame{flex:1 1 auto;height:auto}
.ns-fvbar{position:sticky;top:0;z-index:1;flex:none;display:flex;align-items:center;justify-content:flex-end;gap:10px;
  padding:6px 10px;background:var(--bg);border-bottom:1px solid var(--line)}
.ns-fvnote{margin-right:auto;font-size:12px;color:var(--ink-faint)}
.ns-seg{display:inline-flex;border:1px solid var(--line);border-radius:7px;overflow:hidden}
.ns-seg button{font:inherit;font-size:12px;padding:3px 10px;border:none;background:var(--bg-alt);color:var(--ink-soft);cursor:pointer}
.ns-seg button+button{border-left:1px solid var(--line)}
.ns-seg button.on{background:var(--accent-soft);color:var(--ink);font-weight:600}
.ns-xfoot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px;border-top:1px solid var(--line);background:var(--bg-alt)}
.ns-mrow{display:flex;gap:2px;padding:0 0 4px;margin-bottom:4px;border-bottom:1px solid var(--line)}
.ns-mrow>.ns-mi{justify-content:center;padding:0;width:40px;min-height:34px}
.ns-mrow>.ns-mi[hidden]{display:none}
/* Not logged in: a faded gray, far enough from OpenAI's ink (logged in) to tell apart. */
.ns-mi.ns-auic .ns-mic{width:auto;font-size:19px;color:#8c959f;opacity:.45}
.ns-mi.ns-auic.ok .ns-mic{opacity:1}
/* Logged in: each logo in its own colours — Claude's orange, OpenAI's ink, AWS's ink
   wordmark with the orange smile. Not logged in: the gray above. */
.ns-mi.ns-auic.ok[data-k=auth-claude] .ns-mic{color:#d97757}
.ns-mi.ns-auic.ok[data-k=auth-codex] .ns-mic{color:var(--ink)}
.ns-mi.ns-auic.ok[data-k=auth-aws] .ns-mic{color:var(--ink)}
.ns-mi.ns-auic.ok[data-k=auth-aws] .ns-mic svg path:last-child{fill:#f90}
.ns-lic{display:inline-flex;vertical-align:-2px;margin-right:7px;font-size:17px}
.ns-dlg [hidden]{display:none}
.ns-dlg select{width:100%;min-width:0;font:inherit;font-size:14px;color:var(--ink);background:var(--surface,var(--bg));
  border:1px solid var(--line);border-radius:7px;padding:6px 8px}
.ns-dlg select:disabled{opacity:.5}
/* The new-session sheet: heading, a body that scrolls, a footer that stays. */
.ns-sheet{max-height:calc(var(--vh,100dvh) - 32px)}
.ns-sheet[open]{display:flex;flex-direction:column}
.ns-sheet form{flex:1 1 auto;min-height:0;padding:0;gap:0}
.ns-sheet h3{flex:none;padding:14px 16px 4px;margin:0;outline:none}
.ns-sheet .ns-body{flex:1 1 auto;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;
  display:flex;flex-direction:column;gap:4px;padding:0 16px 10px}
.ns-sheet .ns-lbl{margin-top:8px;font-size:11.5px}
.ns-sheet .ns-hint:empty{display:none}
.ns-sheet .ns-err{flex:none;padding:0 16px 4px}
.ns-sheet .ns-btns{flex:none;margin:0;padding:10px 16px;border-top:1px solid var(--line)}
.ns-sheet .ns-more{margin-top:8px}
.ns-sheet .ns-ttl{margin:2px 0 0}
.ns-binrow{gap:6px}
.ns-dlg input.ns-binin{flex:0 0 7.5em;width:7.5em}
.ns-binrow .ns-bins{flex:1 1 auto;min-width:0;flex-wrap:nowrap;overflow-x:auto;scrollbar-width:none;margin:0;padding:2px 0}
.ns-binrow .ns-bins::-webkit-scrollbar{display:none}
.ns-binrow .ns-bin{flex:none}
.ns-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ns-pair>div{display:flex;flex-direction:column;gap:4px;min-width:0}
.ns-ast{justify-content:space-between}
.ns-lflow{display:flex;flex-direction:column;gap:6px;margin-top:6px;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg-alt)}
.ns-lflow[hidden]{display:none}
.ns-lflow .ns-hint{word-break:normal}
.ns-llink{font-size:12.5px;word-break:break-all;color:var(--accent)}
.ns-lcode{flex:1;font:700 20px/1.2 ui-monospace,Menlo,monospace;letter-spacing:2px;-webkit-user-select:all;user-select:all;cursor:pointer}
.ns-lcode[hidden],.ns-row[hidden]{display:none}
.ns-xsrv{font-size:12px;color:var(--ink-faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media (max-width:600px){
  .ns-dlg input:not([type=checkbox]),.ns-dlg select{font-size:16px}
  /* Top-anchored and sized to what the keyboard leaves (--vh/--vtop, nsFollowViewport):
     a centred dialog sits in the layout viewport, which iOS does not shrink for it. */
  .ns-sheet{width:100vw;max-width:none;margin:0;left:0;right:0;top:var(--vtop,0px);bottom:auto;
    max-height:var(--vh,100dvh);border:none;border-bottom:1px solid var(--line);border-radius:0 0 14px 14px;
    padding-top:env(safe-area-inset-top)}
  .ns-sheet h3{padding-top:12px}
  .ns-xhead input{font-size:16px!important}
  .ns-exp{width:100vw;height:var(--app-h,100dvh);max-width:none;max-height:none;border:none;border-radius:0;
    padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}
}
`;

const JS = 'var NS_EXP_WINS = {};\nvar NS_AUTH = {};\nvar NS_COMPACT = ' + JSON.stringify(NS_COMPACT) + ';\nvar NS_AGENTS = ' + JSON.stringify(NS_AGENTS) + ';\n' + [nsCopy, nsCopyFallback, nsAgentGlyph, nsAuthBin, nsSend, nsAuthText, nsAuthItem, nsAuthPaint, nsAuthRefresh, openLogins, nsFolderIcon, nsFileIcon, nsGet, nsStore, nsAgentOf, nsSize, chipMenu,
  serverChipMenu, nsMenuButtons, sessionMenuDock, nsWatchWidth, sessionMenuItems, nsLastBin, nsSaveBin, nsFillBins, pickBinary, nsDialog, nsK, nsFollowViewport, nsPickField, nsSettingsHtml, nsSettings, openNewSession, nsNarrow, openExplorer,
  nsExplorerModal, nsFileView, explorerBody].map(f => f.toString()).join('\n');

module.exports = { CSS, JS };
