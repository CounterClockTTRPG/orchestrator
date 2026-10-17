#!/usr/bin/env node
// A stand-in for `claude -p --input-format stream-json --output-format stream-json --verbose`, for end-to-end tests
// (GUILD_CLAUDE_BIN). It reads user messages from stdin, writes the events Guild reads (system/init, assistant text
// and tool_use blocks, result) to stdout, starts the real MCP servers named in --mcp-config and calls their tools over
// stdio, so the internal routes and the quest's secret are exercised for real. What it does is scripted.
//
// Environment:
//   FAKE_CLAUDE_SCENARIO  path of the scenario (JSON, read at start, so it may change between sessions)
//   FAKE_CLAUDE_DIR       where it keeps log.jsonl (one line per start, tool call, message and exit) and
//                         sessions/<id>.json (how far each session got, for --resume)
//
// Scenario: { "sessions": [ { "match": {…}, "steps": [ … ], "resume": [ … ] }, … ] }
//   The first entry whose match fits the session runs. match fields (all optional, all must fit):
//     archmage: true|false   the system prompt is the Archmage's (or not)
//     name, role             the agent's name or role title, as in "You are <name>, the <role> in a guild party"
//     task, prompt, message  regexes on the task, the system prompt and the first user message
//     agent                  the agent id (GUILD_AGENT_ID of its MCP server), e.g. "a2"
//   On --resume: the entry's "resume" steps if it has them, else the steps after the last one the session began
//   (an exit, a hang or a wait it was killed in is not repeated; the resume message stands in for the wait).
//   A session that matches nothing ends each turn with "(no script)".
//
// Steps run in order once the first user message is in; strings may use ${var} (see below).
//   { "say": "text" }                          an assistant text block
//   { "tool": "Read", "input": {…} }           a built-in tool_use block, for the activity line (not run)
//   { "call": "propose_plan", "args": {…},     an MCP tool (short or mcp__server__tool name), called for real;
//     "as": "plan", "pick": "regex" }          its text is kept as ${plan} (or the first group of pick, or the match)
//   { "write": "f.txt", "content": "…",        write a file in the cwd (or in "repo", relative to the cwd), then
//     "repo": "dir", "commit": "message" }     with commit: git add -A and git commit there
//   { "run": "shell command", "as": "out" }    run sh -c in the cwd (or "repo"); stdout kept as ${out}
//   { "result": "text", "cost": 0.01,          end the turn: a result event (cost is added to total_cost_usd);
//     "isError": false, "subtype": "success" } isError defaults to false, subtype to success/error_during_execution
//   { "wait": "regex" | ["re1", "re2"],        wait for user messages until each regex has matched one of them
//     "as": "msg" }                            (none: the next message). Other messages get a "Noted." result
//   { "sleep": 200 }                           pause, in milliseconds
//   { "exit": 1 }                              exit at once with that code, without a result
//   { "hang": true }                           never go on (until killed)
//   A turn still open when the steps run out ends with the last text said. After that each message gets a
//   "Noted." result, and the session exits once stdin closes, like claude -p.
//
// Variables: cwd, sessionId, agentId, questId, name, message (the last user message), anything kept with "as",
// and env.NAME. A string that is exactly "${x}" is replaced by the value itself.

import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DIR = process.env.FAKE_CLAUDE_DIR || null;
const LOG = DIR && path.join(DIR, 'log.jsonl');
const log = (entry) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, ts: Date.now(), ...entry }) + '\n'); };
const fail = (msg) => { process.stderr.write(`fake-claude: ${msg}\n`); log({ event: 'error', message: msg }); process.exit(2); };

// ── arguments, as lib/claude.js passes them ──

const LISTS = new Set(['--allowedTools', '--disallowedTools', '--add-dir']);
const VALUES = new Set(['--input-format', '--output-format', '--mcp-config', '--model', '--permission-mode', '--append-system-prompt', '--resume']);
const FLAGS = new Set(['-p', '--print', '--verbose', '--strict-mcp-config']);

function parseArgs(argv) {
  const o = { allowedTools: [], disallowedTools: [], addDir: [] };
  const key = (flag) => flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase());
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) o[a === '-p' ? 'print' : key(a)] = true;
    else if (VALUES.has(a)) {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      o[key(a)] = argv[++i];
    } else if (LISTS.has(a)) {
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) o[key(a)].push(argv[++i]);
    } else fail(`unknown option ${a} (teach test/fixtures/fake-claude.js about it)`);
  }
  if (!o.print || o.inputFormat !== 'stream-json' || o.outputFormat !== 'stream-json' || !o.verbose) fail('expected -p --input-format stream-json --output-format stream-json --verbose');
  return o;
}

const args = parseArgs(process.argv.slice(2));
const mcpConfig = args.mcpConfig ? JSON.parse(fs.readFileSync(args.mcpConfig, 'utf8')) : { mcpServers: {} };
const mcpEnv = Object.assign({}, ...Object.values(mcpConfig.mcpServers ?? {}).map((s) => s.env ?? {}));
const sessionId = args.resume ?? crypto.randomUUID();
const sessionFile = DIR && path.join(DIR, 'sessions', `${sessionId}.json`);
const pick = (k) => Object.fromEntries(Object.entries(process.env).filter(([n]) => n === k || n.startsWith(k)));
log({
  event: 'start', argv: process.argv.slice(2), args, cwd: process.cwd(), sessionId,
  env: { ...pick('GUILD_'), ...pick('MCP_'), ...pick('CLAUDE') }, mcpServers: mcpConfig.mcpServers,
});

// ── output ──

const out = (e) => process.stdout.write(JSON.stringify({ session_id: sessionId, ...e }) + '\n');
const assistant = (content) => out({ type: 'assistant', message: { role: 'assistant', content } });
let cost = 0, turns = 0, turnOpen = false, lastText = '';

function result({ text = lastText, addCost = 0, isError = false, subtype } = {}) {
  cost += Number(addCost) || 0;
  turnOpen = false;
  out({ type: 'result', subtype: subtype ?? (isError ? 'error_during_execution' : 'success'), is_error: isError, result: text, total_cost_usd: cost, num_turns: turns, duration_ms: 1 });
  log({ event: 'result', text, isError, cost });
}

// ── MCP client ──

const servers = new Map(); // name -> { proc, tools: Set, call(method, params) }

function startServer(name, cfg) {
  const proc = spawn(cfg.command, cfg.args ?? [], { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let next = 1;
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg.result);
  });
  proc.on('exit', () => { for (const p of pending.values()) p.reject(new Error(`MCP server ${name} exited`)); pending.clear(); });
  const send = (msg) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
  const s = { proc, tools: new Set(), call, notify: (method) => send({ method }) };
  servers.set(name, s);
  log({ event: 'mcp', server: name, pid: proc.pid });
  return s;
}

async function startServers() {
  for (const [name, cfg] of Object.entries(mcpConfig.mcpServers ?? {})) {
    const s = startServer(name, cfg);
    await s.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
    s.notify('notifications/initialized');
    for (const t of (await s.call('tools/list', {})).tools) s.tools.add(t.name);
  }
}

function stopServers() {
  for (const s of servers.values()) { try { s.proc.stdin.end(); s.proc.kill('SIGTERM'); } catch { /* gone */ } }
}

/** 'propose_plan' or 'mcp__council__propose_plan' → [server, tool]. */
function findTool(name) {
  const full = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (full) return [full[1], full[2]];
  for (const [server, s] of servers) if (s.tools.has(name)) return [server, name];
  return [null, name];
}

// ── input ──

const inbox = [];
let waiter = null, stdinClosed = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type !== 'user') return;
  const c = msg.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : '';
  log({ event: 'message', text });
  inbox.push(text);
  waiter?.();
}).on('close', () => { stdinClosed = true; waiter?.(); });

/** The next user message, or null once stdin is closed. Starting on one opens a turn. */
async function nextMessage() {
  while (!inbox.length) {
    if (stdinClosed) return null;
    await new Promise((r) => { waiter = r; });
    waiter = null;
  }
  turns++;
  turnOpen = true;
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: [...args.allowedTools], mcp_servers: [...servers.keys()].map((name) => ({ name, status: 'connected' })), model: args.model ?? 'fake' });
  return inbox.shift();
}

function finish(code) {
  log({ event: 'exit', code });
  stopServers();
  process.exit(code);
}
process.on('SIGTERM', () => { log({ event: 'killed' }); stopServers(); process.exit(143); });

// ── scenario ──

const systemPrompt = args.appendSystemPrompt ?? '';
const who = /^You are (.+?), the (.+?) in a guild party/m.exec(systemPrompt);
const ARCHMAGE = /leader of a guild party/.test(systemPrompt);

function matches(m, first) {
  const re = (pattern, s) => new RegExp(pattern).test(String(s ?? ''));
  if (m.archmage !== undefined && m.archmage !== ARCHMAGE) return false;
  if (m.name !== undefined && who?.[1] !== m.name) return false;
  if (m.role !== undefined && who?.[2] !== m.role) return false;
  if (m.agent !== undefined && mcpEnv.GUILD_AGENT_ID !== m.agent) return false;
  if (m.task !== undefined && !re(m.task, /^Your task:\n([\s\S]*?)\n\n\(For context/.exec(first ?? '')?.[1] ?? first)) return false;
  if (m.prompt !== undefined && !re(m.prompt, systemPrompt)) return false;
  if (m.message !== undefined && !re(m.message, first)) return false;
  return true;
}

const vars = {
  cwd: process.cwd(), sessionId, agentId: mcpEnv.GUILD_AGENT_ID ?? null, questId: mcpEnv.GUILD_QUEST_ID ?? null,
  name: who?.[1] ?? (ARCHMAGE ? /^You are (.+?) the /.exec(systemPrompt)?.[1] : null) ?? null, message: '',
};

function fill(v) {
  if (typeof v === 'string') {
    const whole = /^\$\{([\w.]+)\}$/.exec(v);
    if (whole) return lookup(whole[1]);
    return v.replace(/\$\{([\w.]+)\}/g, (_, k) => String(lookup(k) ?? ''));
  }
  if (Array.isArray(v)) return v.map(fill);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
  return v;
}
const lookup = (k) => (k.startsWith('env.') ? process.env[k.slice(4)] : vars[k]);

const saved = (() => { try { return JSON.parse(fs.readFileSync(sessionFile, 'utf8')); } catch { return null; } })();
const save = (state) => {
  if (!sessionFile) return;
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, JSON.stringify(state));
};

async function runStep(step, where) {
  const dirOf = (repo) => (repo ? path.resolve(process.cwd(), fill(repo)) : process.cwd());
  if (step.say !== undefined) {
    lastText = fill(step.say);
    assistant([{ type: 'text', text: lastText }]);
  } else if (step.tool !== undefined) {
    assistant([{ type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: step.tool, input: fill(step.input ?? {}) }]);
  } else if (step.call !== undefined) {
    const [server, tool] = findTool(fill(step.call));
    const input = fill(step.args ?? {});
    const name = `mcp__${server}__${tool}`;
    const id = `toolu_${crypto.randomUUID()}`;
    assistant([{ type: 'tool_use', id, name, input }]);
    let text, isError = false;
    if (!server || !servers.has(server)) [text, isError] = [`No MCP server has a tool ${tool}`, true];
    else if (!args.allowedTools.includes(name)) [text, isError] = [`Permission to use ${name} has not been granted`, true];
    else {
      try {
        const r = await servers.get(server).call('tools/call', { name: tool, arguments: input });
        text = (r.content ?? []).map((c) => c.text ?? '').join('');
        isError = r.isError === true;
      } catch (err) { [text, isError] = [String(err.message), true]; }
    }
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }] } });
    log({ event: 'tool', server, tool, input, text, isError });
    keep(step, text);
  } else if (step.write !== undefined) {
    const dir = dirOf(step.repo);
    const file = path.resolve(dir, fill(step.write));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, fill(step.content ?? ''));
    assistant([{ type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: 'Write', input: { file_path: file } }]);
    if (step.commit !== undefined) {
      const git = (...a) => execFileSync('git', ['-c', 'user.name=Fake Claude', '-c', 'user.email=fake@guild.test', ...a], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      git('add', '-A');
      git('commit', '-q', '-m', fill(step.commit));
      log({ event: 'commit', dir, file, message: fill(step.commit) });
    }
  } else if (step.run !== undefined) {
    const cmd = fill(step.run);
    assistant([{ type: 'tool_use', id: `toolu_${crypto.randomUUID()}`, name: 'Bash', input: { command: cmd } }]);
    let text;
    try { text = execFileSync('sh', ['-c', cmd], { cwd: dirOf(step.repo), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (err) { text = `${err.stdout ?? ''}${err.stderr ?? ''}`; }
    log({ event: 'run', cmd, text });
    keep(step, text.trim());
  } else if (step.result !== undefined) {
    result({ text: fill(step.result), addCost: step.cost, isError: step.isError === true, subtype: step.subtype });
  } else if (step.wait !== undefined) {
    if (turnOpen) result({ text: lastText }); // waiting ends the turn in progress
    const want = (step.wait === true || step.wait === null ? [] : [].concat(step.wait)).map((p) => new RegExp(fill(p)));
    const seen = new Set();
    for (;;) {
      const text = await nextMessage();
      if (text === null) return finish(0);
      vars.message = text;
      want.forEach((re, i) => { if (re.test(text)) seen.add(i); });
      if (seen.size === want.length) { keep(step, text); break; }
      result({ text: 'Noted.' });
    }
  } else if (step.sleep !== undefined) {
    await new Promise((r) => setTimeout(r, Number(step.sleep)));
  } else if (step.exit !== undefined) {
    return finish(Number(step.exit));
  } else if (step.hang) {
    log({ event: 'hang', where });
    setInterval(() => {}, 1 << 30); // keeps the process alive with nothing else to wait for
    await new Promise(() => {});
  } else {
    fail(`unknown step ${JSON.stringify(step)}`);
  }
}

function keep(step, text) {
  if (!step.as) return;
  const m = step.pick ? new RegExp(step.pick).exec(text) : null;
  vars[step.as] = step.pick ? (m ? m[1] ?? m[0] : null) : text;
}

async function main() {
  await startServers();
  const scenario = process.env.FAKE_CLAUDE_SCENARIO ? JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCENARIO, 'utf8')) : { sessions: [] };
  const first = await nextMessage();
  if (first === null) return finish(0);
  vars.message = first;

  let index = saved?.index ?? scenario.sessions.findIndex((s) => matches(s.match ?? {}, first));
  if (saved && !scenario.sessions[index]) index = -1;
  const entry = scenario.sessions[index];
  let part = 'steps', from = 0;
  if (args.resume && entry?.resume) part = 'resume';
  else if (args.resume && saved) [part, from] = [saved.part, saved.next];
  Object.assign(vars, saved?.vars ?? {}, { message: first, sessionId });
  const steps = entry?.[part] ?? [];
  log({ event: 'script', index, part, from, resumed: Boolean(args.resume), matched: Boolean(entry) });

  for (let i = from; i < steps.length; i++) {
    // Saved before the step runs: a session resumed after an exit, a hang or a kill goes on after it.
    save({ index, part, next: i + 1, vars });
    await runStep(steps[i], { index, part, step: i });
  }
  if (turnOpen) result({ text: entry ? lastText : '(no script)' });
  for (;;) {
    const text = await nextMessage();
    if (text === null) return finish(0);
    result({ text: entry ? 'Noted.' : '(no script)' });
  }
}

main().catch((err) => fail(err.stack ?? String(err)));
