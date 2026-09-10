#!/usr/bin/env node
'use strict';
// A stand-in for the `claude` child, speaking the same stream-json protocol.
//
// The point of driving the REAL mux with a fake child, rather than writing a fake
// mux, is that everything under test stays real: buildArgs, the line reader, the
// normalizer, the tool_result folding, the control-request registry and the
// first-answer-wins arbitration all run exactly as they do against a live CLI.
// Only the model is fake. It also means this harness cannot drift from the mux —
// if the normalizer changes, this exercises the change.
//
// It walks one scene per user turn, so the browser drives it by sending messages.
// Scenes cover the display types a live session would take an hour to provoke and
// the four that this machine's build cannot produce at all (Glob, Grep, TodoWrite,
// ExitPlanMode are absent from its tool set — see ccbb-mux-plan.md).
//
//   node test/serve.js        start a mux + this child + the web UI

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
let uuidN = 0;
const uid = () => 'u' + (++uuidN);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const assistant = (id, content) => out({
  type: 'assistant', uuid: uid(), timestamp: new Date().toISOString(),
  message: { id, role: 'assistant', model: 'claude-opus-5', content },
});
const result = () => out({
  type: 'result', subtype: 'success', is_error: false, num_turns: 1,
  total_cost_usd: 0.0123, duration_api_ms: 1200,
  usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 4000 },
});
const toolResult = (id, content, meta, isError) => out({
  type: 'user', uuid: uid(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: !!isError }] },
  ...(meta ? { tool_use_result: meta } : {}),
});

// A control_request blocks until the mux answers, which is the whole point of the
// card: the scene must not continue until a human (or another client) has decided.
const waiting = new Map();
function ask(requestId, request) {
  out({ type: 'control_request', request_id: requestId, request });
  return new Promise(res => waiting.set(requestId, res));
}

async function stream(id, text) {
  // The delta path. Everything else in a session can be exercised with whole
  // messages; this is the one that only appears with --include-partial-messages,
  // and it is the path that has already broken once undetected.
  out({ type: 'stream_event', uuid: uid(), event: { type: 'message_start', message: { id, role: 'assistant', model: 'claude-opus-5' } } });
  out({ type: 'stream_event', uuid: uid(), event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
  for (const chunk of text.match(/.{1,12}/gs) || []) {
    out({ type: 'stream_event', uuid: uid(), event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } });
    await sleep(40);
  }
  out({ type: 'stream_event', uuid: uid(), event: { type: 'content_block_stop', index: 0 } });
  // …and then the same message in full, with the same api id. A client that
  // appends instead of replacing renders the turn twice; one that suppresses the
  // final copy without drawing the deltas renders it zero times.
  assistant(id, [{ type: 'text', text: text }]);
}

const SCENES = [
  // 1 — streamed prose, then a Read whose rollup comes off the result metadata.
  async () => {
    await stream('msg_1', 'No — 289 = 17², so it is not prime.\n\nLet me look at the file.');
    assistant('msg_2', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/tmp/a.txt' } }]);
    await sleep(200);
    toolResult('t1', '     1\thello\n     2\tworld', { file: { filePath: '/tmp/a.txt', numLines: 2, totalLines: 2 } });
    result();
  },

  // 2 — a permission card, then the Edit it was guarding, with a real patch.
  async () => {
    assistant('msg_3', [{ type: 'text', text: 'I will fix the typo.' }]);
    const input = { file_path: '/tmp/a.txt', old_string: 'world', new_string: 'there' };
    const r = await ask('req-edit', {
      subtype: 'can_use_tool', tool_name: 'Edit', input,
      permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Edit', ruleContent: '/tmp/**' }] }],
    });
    if (r && r.behavior === 'deny') {
      assistant('msg_4', [{ type: 'text', text: 'Understood — leaving it alone.' }]);
      return result();
    }
    assistant('msg_4', [{ type: 'tool_use', id: 't2', name: 'Edit', input }]);
    await sleep(200);
    toolResult('t2', 'The file /tmp/a.txt has been updated.', {
      filePath: '/tmp/a.txt',
      structuredPatch: [{ oldStart: 1, newStart: 1, oldLines: 2, newLines: 2,
        lines: [' hello', '-world', '+there'] }],
    });
    result();
  },

  // 3 — AskUserQuestion: a tool, not a dialog. Single- and multi-select, and the
  //     synthetic "Other" that the answer format replaces rather than accompanies.
  async () => {
    const input = { questions: [
      { question: 'Which colour?', header: 'Colour', multiSelect: false,
        options: [{ label: 'Red', description: 'The warm one' }, { label: 'Blue', description: 'The cool one' }] },
      { question: 'Which sides?', header: 'Sides', multiSelect: true,
        options: [{ label: 'Fries' }, { label: 'Soup' }, { label: 'Salad' }] },
    ] };
    const r = await ask('req-q', { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input });
    const a = (r && r.updatedInput && r.updatedInput.answers) || {};
    assistant('msg_5', [{ type: 'text', text: 'Noted: ' + JSON.stringify(a) }]);
    result();
  },

  // 4 — the display types this machine's real CLI cannot produce, plus an MCP
  //     tool and a subagent turn (which the plugin hides and ccbb nests).
  async () => {
    assistant('msg_6', [{ type: 'tool_use', id: 't3', name: 'TodoWrite', input: { todos: [
      { content: 'Read the bundle', status: 'completed', activeForm: 'Reading the bundle' },
      { content: 'Port the registry', status: 'in_progress', activeForm: 'Porting the registry' },
      { content: 'Verify in a browser', status: 'pending', activeForm: 'Verifying in a browser' },
    ] } }]);
    toolResult('t3', 'Todos updated');
    assistant('msg_7', [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'wc -l *.js', description: 'Count lines' } }]);
    await sleep(150);
    toolResult('t4', '     998 ccbb-mux-web.js\n    1357 ccbb-mux-tui.js');
    assistant('msg_8', [{ type: 'tool_use', id: 't5', name: 'Grep', input: { pattern: 'TODO', path: 'src', glob: '*.js' } }]);
    toolResult('t5', 'src/a.js:12:// TODO');
    assistant('msg_9', [{ type: 'tool_use', id: 't6', name: 'mcp__claude-in-chrome__navigate', input: { url: 'https://example.com/deep/path' } }]);
    toolResult('t6', 'Navigated');
    assistant('msg_10', [{ type: 'tool_use', id: 't7', name: 'Glob', input: { pattern: '**/*.md' } }]);
    toolResult('t7', 'README.md\nplan.md', null, false);
    // A subagent's own turn: parent_tool_use_id is what marks it.
    out({ type: 'assistant', uuid: uid(), parent_tool_use_id: 't8',
      message: { id: 'msg_sub', role: 'assistant', model: 'claude-opus-5',
        content: [{ type: 'text', text: 'Subagent here — counted 3 files.' }] } });
    // An error result, so the failure styling has a case.
    assistant('msg_11', [{ type: 'tool_use', id: 't9', name: 'Read', input: { file_path: '/nope.txt' } }]);
    toolResult('t9', 'Error: File does not exist.', null, true);
    result();
  },

  // 5 — plan mode. Accepting is two actions, not one; the client must send
  //     planMode alongside the allow or the next edit prompts again.
  async () => {
    const plan = '## Port the webview renderer\n\n1. Normalizer (already server-side)\n2. Tool registry\n3. Permission and question cards\n\nThe `nZ()` fallback chain is the part worth copying exactly.';
    const r = await ask('req-plan', { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', input: { plan } });
    assistant('msg_12', [{ type: 'text', text: r && r.behavior === 'allow' ? 'Starting on it.' : 'Still planning.' }]);
    result();
  },

  // 6 — a backgrounded agent, and the <task-notification> it reports back with.
  async () => {
    assistant('msg_13', [{ type: 'tool_use', id: 't10', name: 'Task',
      input: { description: 'Count txt files', prompt: 'Count the .txt files under /tmp and report the number.' } }]);
    toolResult('t10', 'Agent started', { isAsync: true, agentId: 'agent-1', description: 'Count txt files',
      prompt: 'Count the .txt files under /tmp and report the number.' });
    result();
    await sleep(1500);
    out({ type: 'user', uuid: uid(), message: { role: 'user', content:
      '<task-notification><task-id>agent-1</task-id><summary>Agent "Count txt files" finished</summary><duration_ms>18625</duration_ms></task-notification>' } });
    result();
  },
];

const extra = async () => {
  assistant('msg_x' + scene, [{ type: 'text', text: 'Extra turn ' + scene + ' \u2014 reconnect check.' }]);
  result();
};

let scene = 0;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type === 'control_response') {
      const id = m.response && m.response.request_id;
      const res = waiting.get(id);
      if (res) { waiting.delete(id); res(m.response && m.response.response); }
      continue;
    }
    if (m.type === 'control_request') {
      // The mux asks us things too (interrupt, set_permission_mode). Say yes.
      out({ type: 'control_response', response: { request_id: m.request_id, subtype: 'success', response: {} } });
      continue;
    }
    if (m.type === 'user') {
      // A local slash command never reaches the API and never replays. The real
      // child answers it with a SYNTHETIC assistant message — is_meta, model
      // "<synthetic>", the output already unwrapped in content, and the original
      // envelope kept in local_command_source. Copied from a live child's wire
      // output (see ccbb-mux-plan.md), stderr case included, because the on-disk
      // transcript shape and the wire shape do not agree and building against the
      // wrong one produces a renderer nothing reaches.
      const typed = typeof m.message.content === 'string' ? m.message.content.trim() : '';
      if (/^\/[^/\s]/.test(typed)) {
        const name = typed.slice(1).split(/\s+/)[0];
        const bad = name === 'compact';
        const tag = bad ? 'local-command-stderr' : 'local-command-stdout';
        const body = bad ? 'Error: No messages to compact' : 'ccbb fixture: ran /' + name;
        out({ type: 'assistant', uuid: uid(), is_meta: true,
          local_command_source: '<' + tag + '>' + body + '</' + tag + '>',
          message: { id: 'msg_cmd', role: 'assistant', model: '<synthetic>',
            content: [{ type: 'text', text: body }] } });
        out({ type: 'result', subtype: 'success', is_error: false, num_turns: 0,
          total_cost_usd: 0, duration_api_ms: 0, usage: {} });
        continue;
      }
      // --replay-user-messages: the accepted turn echoes back, and that echo is
      // where every client learns the real submission order.
      out({ type: 'user', uuid: uid(), isReplay: true, message: m.message });
      // Past the scripted scenes each turn gets a uniquely numbered reply rather
      // than wrapping back to scene 1 — a wrapped scene would re-emit the same
      // prose and make a legitimate second rendering look like a duplicate.
      const fn = SCENES[scene] || extra;
      scene++;
      Promise.resolve().then(fn).catch(e => out({ type: 'system', subtype: 'error', error: String(e) }));
    }
  }
});

out({
  type: 'system', subtype: 'init', cwd: process.cwd(), model: 'claude-opus-5',
  permissionMode: 'default',
  tools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Task', 'TodoWrite', 'ExitPlanMode', 'WebFetch'],
  slash_commands: ['clear', 'compact', 'model'], mcp_servers: [{ name: 'claude-in-chrome', status: 'connected' }],
  capabilities: [], plugins: [],
});
