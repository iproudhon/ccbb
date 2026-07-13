#!/usr/bin/env node
'use strict';
// ccbb — a browser and live remote for your Claude Code sessions.
//
//   ccbb ls [options]         column-adaptive session listing for the terminal
//   ccbb web [-p port]        clean web UI (drive live sessions in tmux)
//   ccbb webex                Webex bot front-end (drive a live session from Webex)
//   ccbb confluence           Confluence page front-end (drive a live session there)
//
// All discovery / stats / pricing / transcript reading live in ccbb-common.js so the
// front-ends can't drift. ccbb never rewrites a transcript — the only write it makes is
// appending a custom-title entry on rename.

const common = require('./ccbb-common');
const {
  getSessions, getCostSummary, periodKey, priceTable, maybeRefreshPricing,
} = common;

const DEFAULT_PORT = 8590;

// ── CLI: ls ───────────────────────────────────────────────────────────────────
// ANSI colors, disabled when not a TTY or NO_COLOR is set.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = COLOR ? {
  dim: s => '\x1b[2m' + s + '\x1b[0m',
  bold: s => '\x1b[1m' + s + '\x1b[0m',
  cyan: s => '\x1b[36m' + s + '\x1b[0m',
  green: s => '\x1b[32m' + s + '\x1b[0m',
  yellow: s => '\x1b[33m' + s + '\x1b[0m',
  magenta: s => '\x1b[35m' + s + '\x1b[0m',
  gray: s => '\x1b[90m' + s + '\x1b[0m',
} : new Proxy({}, { get: () => (s => String(s)) });

function fmtCost(v) { return v != null ? '$' + Number(v).toFixed(2) : '—'; }
function fmtTokK(t) {
  t = t || 0;
  if (t >= 1e9) return (t / 1e9).toFixed(1) + 'B';
  if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
  if (t >= 1e3) return (t / 1e3).toFixed(1) + 'K';
  return String(t);
}
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso).slice(0, 16);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const day = String(d.getDate()).padStart(2, ' ');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return sameYear ? `${mon} ${day} ${hh}:${mm}` : `${mon} ${day}  ${d.getFullYear()}`;
}
// strip ANSI for width calc
function visLen(s) { return String(s).replace(/\x1b\[[0-9;]*m/g, '').length; }
function padEnd(s, n) { const pad = n - visLen(s); return pad > 0 ? s + ' '.repeat(pad) : s; }
function padStart(s, n) { const pad = n - visLen(s); return pad > 0 ? ' '.repeat(pad) + s : s; }
function trunc(s, n) {
  s = String(s == null ? '' : s);
  if (visLen(s) <= n) return s;
  if (s.indexOf('\x1b') === -1) return s.slice(0, Math.max(0, n - 1)) + '…';
  let out = '', vis = 0;
  for (let i = 0; i < s.length && vis < n - 1; ) {
    if (s[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    out += s[i]; i++; vis++;
  }
  return out + '…\x1b[0m';
}

const SORT_KEYS = {
  activity: { col: 'lastActivity', dir: 'desc' },
  start:    { col: 'startedAt',    dir: 'desc' },
  cost:     { col: 'totalCost',    dir: 'desc' },
  turns:    { col: 'turns',        dir: 'desc' },
  tokens:   { col: 'totalTokens',  dir: 'desc' },
  name:     { col: 'title',        dir: 'asc'  },
};

const GROUP_ALIAS = { day: 'day', daily: 'day', week: 'week', weekly: 'week', month: 'month', monthly: 'month' };
function parseLsArgs(args) {
  // Default scope is the current month; -a widens to all time. -z keeps empty sessions.
  const opt = { sort: 'activity', dir: null, reverse: false, includeEmpty: false, wide: false, limit: 0, group: 'month' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s' || a === '--sort') { opt.sort = args[++i]; }
    else if (a === '-r' || a === '--reverse') { opt.reverse = true; }
    else if (a === '-a' || a === '--all') { opt.group = null; }
    else if (a === '-z' || a === '--empty') { opt.includeEmpty = true; }
    else if (a === '-x' || a === '--wide') { opt.wide = true; }
    else if (a === '-n' || a === '--limit') { opt.limit = parseInt(args[++i], 10) || 0; }
    else if (a === '-h' || a === '--help') { opt.help = true; }
    else if (a === '-d' || a === '--daily') { opt.group = 'day'; }
    else if (a === '-w' || a === '--weekly') { opt.group = 'week'; }
    else if (a === '-m' || a === '--monthly') { opt.group = 'month'; }
    else if (a === '-g' || a === '--group') { opt.group = GROUP_ALIAS[args[++i]] || 'invalid'; }
    else if (/^--group=/.test(a)) { opt.group = GROUP_ALIAS[a.slice(8)] || 'invalid'; }
    else if (/^--sort=/.test(a)) { opt.sort = a.slice(7); }
    else if (/^-\d+$/.test(a)) { opt.limit = parseInt(a.slice(1), 10) || 0; }
  }
  if (opt.group === 'invalid') {
    console.error('ccbb: --group must be one of: day, week, month');
    process.exit(1);
  }
  return opt;
}

function lsHelp() {
  console.log(`ccbb ls — list Claude Code sessions

Usage: ccbb ls [options]

Sorting (default: activity, descending):
  -s, --sort <key>   activity | start | cost | turns | tokens | name
  -r, --reverse      reverse the sort direction

Scope (default: this month; each session's cost/tokens count only messages in
the period; sessions with no usage in scope are dropped):
  -a, --all          all time (no period scope)
  -d, --daily        only today's usage
  -w, --weekly       only this week's usage (Mon-anchored)
  -m, --monthly      only this month's usage (the default)
  -g, --group <unit> day | week | month   (periods use local time)

Display:
  -x, --wide         force extended columns
  -z, --empty        include sessions with no usage in scope
  -n, --limit <n>    show only the first n rows
  -h, --help         this help

Columns adapt to terminal width. A wide terminal (or -x) adds turns and the
context column: current / largest / would-be cost (largest is shown only when
it differs). Context is all-time, shown even in period-scoped views.`);
}

function sortSessions(sessions, opt) {
  const spec = SORT_KEYS[opt.sort] || SORT_KEYS.activity;
  let dir = spec.dir;
  if (opt.reverse) dir = dir === 'asc' ? 'desc' : 'asc';
  const col = spec.col;
  const sorted = sessions.slice().sort((a, b) => {
    let va = a[col], vb = b[col];
    let cmp;
    if (va == null && vb == null) cmp = 0;
    else if (va == null) cmp = 1;
    else if (vb == null) cmp = -1;
    else if (typeof va === 'number' || typeof vb === 'number') cmp = (va || 0) - (vb || 0);
    else cmp = String(va).toLowerCase() < String(vb).toLowerCase() ? -1
            : String(va).toLowerCase() > String(vb).toLowerCase() ? 1 : 0;
    return dir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

// Resolve flexible widths, then print a header + colored rows for the given column defs.
function printTable(cols, rows, width) {
  const gap = 2;
  const fixedTotal = cols.filter(col => !col.flex).reduce((a, col) => a + col.w, 0);
  const gaps = (cols.length - 1) * gap;
  const flexCols = cols.filter(col => col.flex);
  const avail = width - fixedTotal - gaps;
  if (flexCols.length) {
    if (avail < flexCols.reduce((a, col) => a + col.min, 0)) {
      flexCols.forEach(col => { col.w = col.min; });
    } else {
      const totalWeight = flexCols.reduce((a, col) => a + (col.weight || 1), 0);
      let used = 0;
      flexCols.forEach((col, i) => {
        if (i === flexCols.length - 1) col.w = Math.max(col.min, avail - used);
        else { col.w = Math.max(col.min, Math.floor(avail * (col.weight || 1) / totalWeight)); used += col.w; }
      });
    }
  }
  const renderRow = (cells, colorize) => cols.map((col, i) => {
    let v = trunc(cells[i], col.w);
    if (colorize && col.color) v = col.color(v, colorize);
    return col.align === 'r' ? padStart(v, col.w) : padEnd(v, col.w);
  }).join(' '.repeat(gap));
  console.log(c.bold(renderRow(cols.map(col => col.head), null)));
  for (const r of rows) console.log(renderRow(cols.map(col => col.get(r)), r));
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDay(d) { return `${MON[d.getMonth()]} ${d.getDate()}`; }

// The current local day/week/month: its bucket key (matching periodKey) plus a human label.
function currentPeriod(period) {
  const now = new Date();
  const key = periodKey(now.toISOString(), period);
  if (period === 'day') {
    return { period, key, label: `today (${fmtDay(now)})` };
  }
  if (period === 'month') {
    return { period, key, label: `this month (${MON[now.getMonth()]} ${now.getFullYear()})` };
  }
  const [y, m, d] = key.split('-').map(Number);
  const mon = new Date(y, m - 1, d);
  const sun = new Date(y, m - 1, d + 6);
  return { period, key, label: `this week (${fmtDay(mon)}–${fmtDay(sun)})` };
}

// Print a compact provider cost summary (mirrors the web list page's summary table).
const PROV_LABEL_CLI = { bedrock: 'Bedrock', anthropic: 'Sub' };
function printCostSummary(scope, label, extended) {
  const map = scope.byProvider || {};
  const keys = Object.keys(map).filter(k => map[k].tokens > 0).sort((a, b) => map[b].cost - map[a].cost);
  if (!keys.length) return;
  const pctStr = (cat, rowCost) => {
    if (!cat || !cat.tokens) return '—';
    return (rowCost > 0 ? (cat.cost / rowCost * 100).toFixed(1) : '0.0') + '%';
  };
  const cell = (cat, rowCost) => {
    if (!cat || !cat.tokens) return '—';
    return `${fmtTokK(cat.tokens)} ${c.gray(pctStr(cat, rowCost))}`;
  };
  const catVal = (cat, rowCost) => extended ? cell(cat, rowCost) : pctStr(cat, rowCost);
  const rowFor = (name, b) => ({
    name,
    cost: fmtCost(b.cost),
    tokens: fmtTokK(b.tokens),
    turns: String(b.turns || 0) + (b.subTurns ? '+' + b.subTurns : ''),
    cr: catVal(b.categories.cacheRead, b.cost),
    cw: catVal(b.categories.cacheWrite, b.cost),
    cm: catVal(b.categories.cacheMiss, b.cost),
    out: catVal(b.categories.output, b.cost),
    in: catVal(b.categories.input, b.cost),
  });
  const rows = keys.map(k => rowFor(PROV_LABEL_CLI[k] || k, map[k]));
  if (keys.length > 1) rows.push(rowFor('Total', scope.all));
  const cw = extended ? 13 : 6;
  const nameW = Math.max.apply(null, rows.map(r => r.name.length));
  const cols = [
    { head: '', align: 'l', w: nameW, get: r => r.name, color: c.bold },
    { head: 'USD', align: 'r', w: 8, get: r => r.cost, color: c.green },
    { head: 'TOKENS', align: 'r', w: 7, get: r => r.tokens, color: c.gray },
    { head: 'TURNS', align: 'r', w: extended ? 9 : 8, get: r => r.turns, color: c.gray },
    { head: extended ? 'CACHE READ' : 'CR',  align: 'r', w: cw, get: r => r.cr,  color: extended ? null : c.gray },
    { head: extended ? 'CACHE WRITE' : 'CW', align: 'r', w: cw, get: r => r.cw,  color: extended ? null : c.gray },
    { head: extended ? 'CACHE MISS' : 'CM',  align: 'r', w: cw, get: r => r.cm,  color: extended ? null : c.gray },
    { head: 'OUT', align: 'r', w: extended ? 12 : 6, get: r => r.out, color: extended ? null : c.gray },
    { head: 'IN',  align: 'r', w: extended ? 12 : 6, get: r => r.in,  color: extended ? null : c.gray },
  ];
  console.log(c.bold(`Cost summary${label ? ' — ' + label : ''}`));
  printTable(cols, rows, process.stdout.columns || 80);
  console.log('');
}

function runLs(args) {
  const opt = parseLsArgs(args);
  if (opt.help) return lsHelp();
  if (!SORT_KEYS[opt.sort]) {
    console.error(`ccbb: unknown sort key '${opt.sort}'. Valid: ${Object.keys(SORT_KEYS).join(', ')}`);
    process.exit(1);
  }
  const periodFilter = opt.group ? currentPeriod(opt.group) : null;
  const { sessions, totals } = getSessions(periodFilter, opt.includeEmpty);
  let rows = sortSessions(sessions, opt);
  if (opt.limit > 0) rows = rows.slice(0, opt.limit);
  if (!rows.length) {
    console.log(periodFilter ? `No sessions active ${periodFilter.label}.` : 'No sessions found.');
    return;
  }

  const width = process.stdout.columns || 80;
  const extended = opt.wide || width >= 120;

  const summary = getCostSummary(periodFilter);
  printCostSummary(summary.overall, periodFilter ? periodFilter.label : 'all time', extended);

  const cols = [];
  cols.push({ head: 'ID', align: 'l', w: 8,
    get: s => s.sessionId.slice(0, 8), color: c.gray });
  cols.push({ head: 'TITLE', align: 'l', flex: true, min: 16,
    get: s => s.title || '(no title)',
    color: (v, s) => s.title ? v : c.dim(v) });
  cols.push({ head: 'COST', align: 'r', w: 8,
    get: s => fmtCost(s.totalCost), color: c.green });
  cols.push({ head: 'TOKENS', align: 'r', w: 7,
    get: s => fmtTokK(s.totalTokens), color: c.gray });
  if (extended) {
    cols.push({ head: 'TURNS', align: 'r', w: 6,
      get: s => String(s.turns || 0) + (s.subTurns ? '+' + s.subTurns : ''),
      color: c.gray });
    cols.push({ head: 'CR', align: 'r', w: 7,
      get: s => fmtTokK(s.cacheReadTokens || 0), color: c.gray });
    cols.push({ head: 'CW', align: 'r', w: 7,
      get: s => fmtTokK(s.cacheCreationTokens || 0), color: c.gray });
    cols.push({ head: 'CM', align: 'r', w: 7,
      get: s => fmtTokK(s.cacheMissTokens || 0), color: c.gray });
    cols.push({ head: 'OUT', align: 'r', w: 7,
      get: s => fmtTokK(s.outputTokens || 0), color: c.gray });
    cols.push({ head: 'IN', align: 'r', w: 7,
      get: s => fmtTokK(s.inputTokens || 0), color: c.gray });
    // current [/ largest] / would-be cost. Largest is shown only when it differs from
    // current (after a /compact, or when the last turn was smaller than an earlier peak).
    // Context is an all-time property of the session, so it shows even in period-scoped views.
    cols.push({ head: 'CONTEXT', align: 'r', w: 20, color: c.yellow,
      get: s => {
        const ctx = s.context;
        if (!ctx) return '—';
        const cur = (ctx.postCompact ? '~' : '') + fmtTokK(ctx.tokens);
        const mx = s.contextMax;
        const showMax = mx && fmtTokK(mx.tokens) !== fmtTokK(ctx.tokens);
        return cur + (showMax ? '/' + fmtTokK(mx.tokens) : '') + '/' + fmtCost(ctx.cost);
      } });
  }
  cols.push({ head: 'ACTIVITY', align: 'l', w: 12,
    get: s => fmtDate(s.lastActivity), color: c.cyan });
  if (extended) {
    cols.push({ head: 'STARTED', align: 'l', w: 12,
      get: s => fmtDate(s.startedAt), color: c.cyan });
  }
  cols.push({ head: 'PROJECT', align: 'l', flex: true, min: 12, weight: 0.5,
    get: s => s.projectPath || '', color: c.magenta });

  printTable(cols, rows, width);

  const sortLabel = opt.sort + (opt.reverse ? ' (reversed)' : '');
  const scope = periodFilter ? ` ${periodFilter.label}` : '';
  console.log('');
  console.log(c.dim(`${rows.length} session${rows.length === 1 ? '' : 's'}${scope}` +
    `  ·  total ${fmtCost(totals.totalCost)} / ${fmtTokK(totals.totalTokens)} tokens` +
    `  ·  sorted by ${sortLabel}`));
}

// ── Entry point ───────────────────────────────────────────────────────────────
function topHelp() {
  console.log(`ccbb — Claude Code session browser + live remote

Usage:
  ccbb ls [options]        list sessions in the terminal (see: ccbb ls --help)
  ccbb web [-p port]       start the web UI (default port ${DEFAULT_PORT})
  ccbb confluence          start the Confluence page front-end
  ccbb hooks <cmd>         install/remove Claude Code prompt-capture hooks (see: ccbb hooks)

With no command, 'ls' is assumed.`);
}

function main() {
  const argv = process.argv.slice(2);
  let cmd = argv[0];
  let rest = argv.slice(1);
  if (cmd === 'help' || cmd === '-h' || cmd === '--help') return topHelp();
  if (!cmd || cmd.startsWith('-')) { cmd = 'ls'; rest = argv; } // no command / bare flags → ls
  if (cmd === 'ls') return runLs(rest);
  if (cmd === 'hooks') return require('./ccbb-hooks').runHooks(rest);
  if (cmd === 'web') return require('./ccbb-web').runWeb(rest);
  if (cmd === 'webex') {
    let startWebex;
    try { ({ startWebex } = require('./ccbb-webex')); }
    catch (e) { console.error('ccbb: failed to load ccbb-webex:', e.message); process.exit(1); }
    return startWebex();
  }
  if (cmd === 'confluence') {
    let startConfluence;
    try { ({ startConfluence } = require('./ccbb-confluence')); }
    catch (e) { console.error('ccbb: failed to load ccbb-confluence:', e.message); process.exit(1); }
    return startConfluence();
  }
  console.error(`ccbb: unknown command '${cmd}'. Try: ccbb help`);
  process.exit(1);
}

main();
