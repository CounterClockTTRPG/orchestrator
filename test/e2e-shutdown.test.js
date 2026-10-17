import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRepo } from './helpers/e2e.js';

// The real `node server.js` process stopped by SIGTERM (what systemd and Ctrl-C send) while a quest is under way,
// then a second one started on the same GUILD_HOME. Bug numbers refer to the lifecycle table in
// guild-self-analysis.md (maintainer's notes, not in this repo).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const scenario = { sessions: [
  { match: { archmage: true }, steps: [
    { call: 'propose_plan', args: { summary: 's', agents: [{ role: 'researcher', title: 'Long job', task: 'Scout it.' }] } },
    { result: 'Proposed.' }, { wait: 'never' }] },
  { match: { role: 'Scout' }, steps: [{ call: 'report_progress', args: { percent: 10, message: 'Started.' } }, { hang: true }] },
] };

let root, home, fake, repo, port, servers = [];

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port: p } = s.address(); s.close(() => resolve(p)); }); });

async function startServer() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, GUILD_HOME: home, GUILD_PORT: String(port), GUILD_HOST: '127.0.0.1', GUILD_CLAUDE_BIN: path.join(ROOT, 'test/fixtures/fake-claude.js'),
      FAKE_CLAUDE_SCENARIO: path.join(root, 'scenario.json'), FAKE_CLAUDE_DIR: fake },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise((r) => proc.once('exit', (code, signal) => r({ code, signal })));
  servers.push(proc);
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => { if (/Guild is open/.test(d)) resolve(); });
    proc.once('exit', () => reject(new Error('the server exited before it listened')));
  });
  return { proc, exited };
}

const api = async (method, p, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${json.error}`);
  return json;
};
const fakeLog = () => { try { return fs.readFileSync(path.join(fake, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const events = (id) => fs.readFileSync(path.join(home, 'quests', id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function waitFor(fn, what, timeout = 10_000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(40);
  }
}

let quest, first, stopped;
before(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guild-e2e-')));
  home = path.join(root, 'home'); fake = path.join(root, 'fake');
  fs.mkdirSync(home); fs.mkdirSync(fake);
  fs.writeFileSync(path.join(root, 'scenario.json'), JSON.stringify(scenario));
  repo = makeRepo(path.join(root, 'repo'));
  port = await freePort();

  first = await startServer();
  quest = await api('POST', '/api/quests', { goal: 'Map it', cwd: repo, mode: 'read', planning: 'auto' });
  await waitFor(async () => (await api('GET', `/api/quests/${quest.id}`)).agents[0]?.percent === 10, 'the agent to report');
  first.proc.kill('SIGTERM');
  stopped = await first.exited;
  await sleep(500); // a revived Archmage would have been spawned by now
});

after(() => {
  // Leave nothing running: the servers, and any fake-claude or MCP process still alive (a revived orphan).
  for (const p of servers) p.kill('SIGKILL');
  for (const pid of new Set(fakeLog().map((e) => e.pid))) {
    try { if (/fake-claude\.js|-mcp\.js/.test(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('SIGTERM stops the server', () => {
  assert.equal(stopped.code, 0);
});

test('stopping the server does not revive the Archmage as an orphan (bug 1)', () => {
  const archmages = fakeLog().filter((e) => e.event === 'start' && e.mcpServers.council);
  assert.equal(archmages.length, 1, `the Archmage started ${archmages.length} times`);
});

test('stopping the server does not record the agents as failed (bug 1)', () => {
  const failed = events(quest.id).filter((e) => e.type === 'log' && e.entry?.kind === 'failed');
  assert.deepEqual(failed.map((e) => e.entry.text), []);
});

test('a new server on the same home shows the quest as interrupted, with its agents interrupted', async () => {
  const second = await startServer();
  const q = await api('GET', `/api/quests/${quest.id}`);
  second.proc.kill('SIGTERM');
  await second.exited;
  assert.equal(q.status, 'interrupted', q.log.slice(-4).map((e) => e.text).join(' | '));
  assert.deepEqual(q.agents.map((a) => a.status), ['interrupted']);
});
