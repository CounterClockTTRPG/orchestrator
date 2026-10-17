import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FAKE_CLAUDE, makeRepo } from './helpers/e2e.js';

// The fake claude on its own: the stream-json protocol, the step types, and --resume.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-fake-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const BASE = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
let n = 0;

/** Run the fake with a scenario; returns { events, send(text), end(), exited: Promise<code>, proc }. */
function fake(scenario, { args = [], cwd = root, system = 'You are Hilda, the Tester in a guild party of Claude Code agents.' } = {}) {
  const file = path.join(root, `scenario${++n}.json`);
  fs.writeFileSync(file, JSON.stringify(scenario));
  const proc = spawn(process.execPath, [FAKE_CLAUDE, ...BASE, '--append-system-prompt', system, ...args], {
    cwd, env: { ...process.env, FAKE_CLAUDE_SCENARIO: file, FAKE_CLAUDE_DIR: root }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  proc.stdin.on('error', () => {}); // writing to a session that already exited
  const events = [];
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr += d; });
  createInterface({ input: proc.stdout }).on('line', (l) => events.push(JSON.parse(l)));
  const exited = new Promise((r) => proc.on('close', (code) => r({ code, stderr })));
  const send = (text) => proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n');
  const until = async (pred, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred(events)) {
      if (Date.now() > end) throw new Error(`timed out; events: ${JSON.stringify(events)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { proc, events, send, end: () => proc.stdin.end(), exited, until };
}
const results = (events) => events.filter((e) => e.type === 'result');

test('turns: init, text, result with cumulative cost; waits; exits when stdin closes', async () => {
  const f = fake({ sessions: [{ match: { role: 'Tester', name: 'Hilda' }, steps: [
    { say: 'Hello ${name}' }, { result: 'one', cost: 0.5 },
    { wait: 'go on', as: 'm' }, { say: 'got ${m}' }, { result: 'two', cost: 0.25, isError: true },
  ] }] });
  f.send('start');
  await f.until((ev) => results(ev).length === 1);
  const [init, text, r1] = f.events;
  assert.equal(init.type, 'system');
  assert.equal(init.subtype, 'init');
  assert.match(init.session_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(text.message.content, [{ type: 'text', text: 'Hello Hilda' }]);
  assert.deepEqual([r1.subtype, r1.is_error, r1.result, r1.total_cost_usd], ['success', false, 'one', 0.5]);
  f.send('something else');
  f.send('please go on');
  await f.until((ev) => results(ev).length === 3);
  const [noted, r2] = results(f.events).slice(1);
  assert.equal(noted.result, 'Noted.', 'a message the wait does not want still ends its turn');
  assert.deepEqual([r2.subtype, r2.is_error, r2.result, r2.total_cost_usd], ['error_during_execution', true, 'two', 0.75]);
  assert.ok(f.events.some((e) => e.message?.content?.[0]?.text === 'got please go on'));
  f.end();
  assert.equal((await f.exited).code, 0);
});

test('write and commit, run, and the turn closed by itself when the steps run out', async () => {
  const repo = makeRepo(path.join(root, 'repo'));
  const f = fake({ sessions: [{ steps: [
    { write: 'notes/a.txt', content: 'by ${name}\n', commit: 'Add a' },
    { run: 'git log --format=%s -1', as: 'subject' },
    { say: 'last commit: ${subject}' },
  ] }] }, { cwd: repo });
  f.send('go');
  await f.until((ev) => results(ev).length === 1);
  assert.equal(results(f.events)[0].result, 'last commit: Add a');
  assert.equal(fs.readFileSync(path.join(repo, 'notes/a.txt'), 'utf8'), 'by Hilda\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
  assert.ok(f.events.some((e) => e.message?.content?.[0]?.name === 'Write'), 'a tool_use block for the activity line');
  f.send('more?');
  await f.until((ev) => results(ev).length === 2);
  assert.equal(results(f.events)[1].result, 'Noted.');
  f.end();
  assert.equal((await f.exited).code, 0);
});

test('--resume: the same session id, and the resume steps or the rest of the script', async () => {
  const scenario = { sessions: [
    { match: { role: 'Tester' }, steps: [{ result: 'first' }, { exit: 3 }, { result: 'after the crash' }] },
    { match: { role: 'Smith' }, steps: [{ result: 'smith' }], resume: [{ result: 'smith again' }] },
  ] };
  const a = fake(scenario);
  a.send('go');
  await a.until((ev) => results(ev).length === 1);
  a.send('next');
  assert.equal((await a.exited).code, 3, 'exit: a crash without a result');
  const id = a.events[0].session_id;

  const b = fake(scenario, { args: ['--resume', id] });
  b.send('you were restarted');
  await b.until((ev) => results(ev).length === 1);
  assert.equal(b.events[0].session_id, id);
  assert.equal(results(b.events)[0].result, 'after the crash', 'carries on after the step it stopped at');
  b.end();
  await b.exited;

  const c = fake(scenario, { system: 'You are Borin, the Smith in a guild party.' });
  c.send('go');
  await c.until((ev) => results(ev).length === 1);
  c.end();
  await c.exited;
  const d = fake(scenario, { system: 'You are Borin, the Smith in a guild party.', args: ['--resume', c.events[0].session_id] });
  d.send('wake up');
  await d.until((ev) => results(ev).length === 1);
  assert.equal(results(d.events)[0].result, 'smith again');
  d.end();
  await d.exited;
});

test('hang until killed; unknown options and unmatched sessions', async () => {
  const f = fake({ sessions: [{ steps: [{ say: 'stuck' }, { hang: true }] }] });
  f.send('go');
  await f.until((ev) => ev.some((e) => e.type === 'assistant'));
  f.end();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(f.proc.exitCode, null, 'a hung session ignores a closed stdin');
  f.proc.kill('SIGTERM');
  assert.equal((await f.exited).code, 143);

  const bad = fake({ sessions: [] }, { args: ['--frobnicate'] });
  const out = await bad.exited;
  assert.equal(out.code, 2);
  assert.match(out.stderr, /unknown option --frobnicate/);

  const none = fake({ sessions: [{ match: { archmage: true }, steps: [{ result: 'no' }] }] });
  none.send('hello');
  await none.until((ev) => results(ev).length === 1);
  assert.equal(results(none.events)[0].result, '(no script)');
  none.end();
  assert.equal((await none.exited).code, 0);
});

test('MCP tools outside --allowedTools are refused, as claude would', async () => {
  const cfg = path.join(root, 'mcp.json');
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { guild: { command: process.execPath, args: [path.resolve('lib/report-mcp.js')], env: { GUILD_URL: 'http://127.0.0.1:9', GUILD_QUEST_ID: 'q', GUILD_AGENT_ID: 'a1', GUILD_SECRET: 's' } } } }));
  const f = fake({ sessions: [{ match: { agent: 'a1' }, steps: [
    { call: 'report_progress', args: { percent: 1, message: 'x' }, as: 'r' }, { result: '${r}' },
  ] }] }, { args: ['--mcp-config', cfg, '--allowedTools', 'Read'] });
  f.send('go');
  await f.until((ev) => results(ev).length === 1);
  assert.match(results(f.events)[0].result, /Permission to use mcp__guild__report_progress has not been granted/);
  f.end();
  await f.exited;
});
