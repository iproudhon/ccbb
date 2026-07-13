#!/usr/bin/env node
'use strict';
// ccbb hooks — wire Claude Code hooks that PEEK at interactive prompts and push their
// content to ccbb, so the web UI can show permission dialogs and AskUserQuestion prompts
// without scraping the tmux pane. The hooks are observe-only (async, fire-and-forget): they
// never answer or block a turn — ccbb still answers by injecting the option digit into the
// pane. Two events:
//   PermissionRequest (all tools) → a permission dialog appeared; payload has tool_name +
//                                   tool_input (+ permission_suggestions).
//   PreToolUse (AskUserQuestion)  → an AskUserQuestion dialog; payload has tool_use_id +
//                                   tool_input.questions (tool_use_id matches the transcript
//                                   block, so the UI dedupes against its inline card).
// Answering, and prompt types the hooks don't cover (plan-mode, trust-folder), still fall
// back to the pane scrape — so ccbb works with or without hooks installed.
//
//   ccbb hooks install [--port N] [--settings PATH]
//   ccbb hooks uninstall [--settings PATH]
//   ccbb hooks status [--settings PATH]

const fs = require('fs');
const path = require('path');
const { CLAUDE_DIR } = require('./ccbb-common');

const DEFAULT_PORT = 8590;
const DEFAULT_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
// The events we register, with their matcher. PermissionRequest fires for every dialog;
// PreToolUse is scoped to AskUserQuestion so it doesn't run on every tool call.
const HOOKS = [
  { event: 'PermissionRequest', matcher: '*' },
  { event: 'PreToolUse', matcher: 'AskUserQuestion' },
];
const MARKER = '#ccbb-hook';   // shell comment tag; identifies ccbb's own hook entries

function hookCommand(port) {
  // Fire-and-forget: post the stdin payload, cap at 2s, swallow all errors so a stopped or
  // slow ccbb never blocks or fails the Claude Code turn. async:true also backgrounds it.
  return `curl -sS -m 2 -X POST http://127.0.0.1:${port}/api/hook ` +
    `-H 'content-type: application/json' --data-binary @- >/dev/null 2>&1 || true ${MARKER}`;
}
function hookEntry(matcher, port) {
  return { matcher, hooks: [{ type: 'command', command: hookCommand(port), timeout: 5, async: true }] };
}
function isCcbbHook(h) { return h && typeof h.command === 'string' && h.command.includes(MARKER); }

function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`cannot read ${file}: ${e.message}`); }
}
function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.ccbb-bak-${Date.now()}`;
  fs.copyFileSync(file, bak);
  return bak;
}
function writeSettings(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
// Remove every ccbb-tagged hook, dropping now-empty matcher groups and event arrays.
// Leaves all non-ccbb hooks in place. Returns the count removed.
function stripCcbb(settings) {
  let removed = 0;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return 0;
  for (const evt of Object.keys(hooks)) {
    const arr = hooks[evt];
    if (!Array.isArray(arr)) continue;
    const cleaned = [];
    for (const group of arr) {
      if (!group || !Array.isArray(group.hooks)) { cleaned.push(group); continue; }
      const kept = group.hooks.filter(h => { if (isCcbbHook(h)) { removed++; return false; } return true; });
      if (kept.length) cleaned.push({ ...group, hooks: kept });
    }
    if (cleaned.length) hooks[evt] = cleaned; else delete hooks[evt];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}
function portOf(settings) {
  const hooks = settings.hooks || {};
  for (const evt of Object.keys(hooks))
    for (const group of hooks[evt] || [])
      for (const h of (group && group.hooks) || []) {
        const mm = isCcbbHook(h) && h.command.match(/:(\d+)\/api\/hook/);
        if (mm) return Number(mm[1]);
      }
  return null;
}

function install(port, file) {
  const settings = readSettings(file);
  const bak = backup(file);
  stripCcbb(settings);                         // clear prior ccbb hooks (re-install / port change)
  settings.hooks = settings.hooks || {};
  for (const { event, matcher } of HOOKS) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push(hookEntry(matcher, port));
  }
  writeSettings(file, settings);
  console.log(`ccbb hooks installed → http://127.0.0.1:${port}/api/hook`);
  console.log(`  ${HOOKS.map(h => h.event + (h.matcher !== '*' ? `(${h.matcher})` : '')).join(', ')}`);
  console.log(`  settings: ${file}${bak ? `  (backup: ${path.basename(bak)})` : ''}`);
  console.log('');
  console.log('Note: hooks load at session start — restart or start NEW Claude Code sessions');
  console.log(`to pick them up. Make sure "ccbb web -p ${port}" is running to receive them.`);
}
function uninstall(file) {
  if (!fs.existsSync(file)) { console.log(`No settings file at ${file} — nothing to remove.`); return; }
  const settings = readSettings(file);
  const bak = backup(file);
  const removed = stripCcbb(settings);
  writeSettings(file, settings);
  console.log(removed ? `Removed ${removed} ccbb hook${removed === 1 ? '' : 's'} from ${file}`
                      : `No ccbb hooks found in ${file}`);
  if (bak) console.log(`  backup: ${path.basename(bak)}`);
}
function status(file) {
  const settings = readSettings(file);
  const hooks = settings.hooks || {};
  const present = HOOKS.map(h => h.event).filter(e => (hooks[e] || []).some(g => (g && g.hooks || []).some(isCcbbHook)));
  if (!present.length) { console.log(`ccbb hooks: NOT installed in ${file}`); console.log('Run: ccbb hooks install'); return; }
  console.log(`ccbb hooks: installed in ${file}`);
  console.log(`  posting to: http://127.0.0.1:${portOf(settings)}/api/hook`);
  console.log(`  events: ${present.join(', ')}`);
}

function hooksHelp() {
  console.log(`ccbb hooks — Claude Code hooks that peek at prompts and push them to ccbb

Usage:
  ccbb hooks install [--port N] [--settings PATH]   wire hooks into settings.json
  ccbb hooks uninstall [--settings PATH]            remove ccbb's hooks
  ccbb hooks status [--settings PATH]               show what's installed

Options:
  --port N         ccbb web port the hooks POST to (default ${DEFAULT_PORT})
  --settings PATH  settings file to edit (default ${DEFAULT_SETTINGS})

Hooks let the web UI show permission and AskUserQuestion prompts from structured data
instead of scraping the tmux pane. They only peek — answering still injects into the pane,
and the pane scrape stays as a fallback, so ccbb works with or without hooks.`);
}

function runHooks(args) {
  const sub = args[0];
  let port = DEFAULT_PORT, settings = DEFAULT_SETTINGS;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--port') port = parseInt(args[++i], 10) || DEFAULT_PORT;
    else if (/^--port=/.test(args[i])) port = parseInt(args[i].slice(7), 10) || DEFAULT_PORT;
    else if (args[i] === '--settings') settings = args[++i];
    else if (/^--settings=/.test(args[i])) settings = args[i].slice(11);
  }
  try {
    if (sub === 'install') return install(port, settings);
    if (sub === 'uninstall' || sub === 'remove') return uninstall(settings);
    if (sub === 'status') return status(settings);
    return hooksHelp();
  } catch (e) { console.error('ccbb hooks:', e.message); process.exit(1); }
}

module.exports = { runHooks, HOOKS, MARKER, hookCommand, hookEntry, stripCcbb };

if (require.main === module) runHooks(process.argv.slice(2));
