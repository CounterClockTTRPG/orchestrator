import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startGuild } from './helpers/e2e.js';

// The end of a quest and of the server: processes are stopped (process groups included) before worktrees go,
// end() runs once, saves are flushed, quest ids do not clash, a failing event log or a stalled SSE client does not
// break the server. Bug numbers refer to the lifecycle table in the maintainer's lifecycle notes (guild-self-analysis.md, not in this repo).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plan = (task, role = 'researcher') => ({ call: 'propose_plan', args: { summary: 's', agents: [{ key: 'a', role, title: 'Do it', task }] } });
// A process that ignores SIGTERM, started in the background as through the Bash tool; its pid is kept as ${bg}.
const background = { run: `sh -c 'trap "" TERM; exec sleep 300' >/dev/null 2>&1 & echo $!`, as: 'bg' };

const sessions = [
  { match: { archmage: true, message: 'GOAL-BG' }, steps: [plan('TASK-BG', 'implementer'), { result: 'Proposed.' }, { wait: 'never' }] },
  { match: { task: 'TASK-BG' }, steps: [background, { call: 'report_progress', args: { percent: 10, message: 'bg ${bg}' } }, { hang: true }] },
  { match: { archmage: true, message: 'GOAL-HANG' }, steps: [plan('TASK-HANG'), { result: 'Proposed.' }, { wait: 'never' }] },
  { match: { task: 'TASK-HANG' }, steps: [{ call: 'report_progress', args: { percent: 10, message: 'Started.' } }, { hang: true }] },
];

let h, repo;
before(async () => {
  h = await startGuild({ scenario: { sessions }, settings: { batchSeconds: 0.1 } });
  repo = h.repo('lore');
});
after(() => h.stop());

const alive = (pid) => {
  try { return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } // a zombie is dead
};

async function hangingQuest(goal, opts = {}) {
  const q = await h.createQuest({ goal, cwd: repo, ...opts });
  await h.waitAgent(q.id, 'a1', (a) => a.percent === 10);
  return q;
}

test('ending a quest stops the agents and their background children before the worktrees are removed (bug 10)', async () => {
  const q0 = await hangingQuest('GOAL-BG', { mode: 'edit' });
  const bg = Number((await h.quest(q0.id)).agents[0].lastReport.match(/bg (\d+)/)[1]);
  assert.ok(alive(bg), 'the background child runs');

  const q = h.live(q0.id);
  const sessions = [q.arch, ...q.sessions.values()];
  let atCleanup;
  const cleanup = q.cleanupWorktrees;
  q.cleanupWorktrees = function (...a) {
    atCleanup = { exited: sessions.map((s) => s.exited), bg: alive(bg), dir: fs.existsSync(this.s.agents[0].dir) };
    return cleanup.apply(this, a);
  };
  await h.post(`/api/quests/${q0.id}/cancel`);
  const s = await h.waitQuest(q0.id, 'cancelled', { timeout: 15_000 });

  assert.deepEqual(atCleanup, { exited: [true, true], bg: false, dir: true }, 'every process was gone when the worktrees were removed');
  assert.equal(fs.existsSync(s.agents[0].dir), false, 'the worktree is removed');
  assert.equal(alive(bg), false);
});

test('end() runs once: a second call gets the same promise, and the save timer is cleared (bug 15)', async () => {
  const q0 = await hangingQuest('GOAL-HANG');
  const q = h.live(q0.id);
  const first = q.cancel();
  const second = q.end('failed');
  assert.equal(first, second);
  await first;
  const s = await h.waitQuest(q0.id, 'cancelled');
  assert.equal(s.log.filter((e) => e.who === 'guild' && /^The quest ended/.test(e.text)).length, 1);
  assert.equal(q.saveTimer, null, 'no save is left pending');
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'quests', q0.id, 'quest.json'), 'utf8'));
  assert.equal(saved.status, 'cancelled');
  assert.deepEqual(fs.readdirSync(path.join(h.home, 'quests', q0.id)).filter((f) => f.includes('.tmp')), [], 'no temp file is left');
});

test('quest ids do not clash: a taken one is drawn again (bug 11)', async () => {
  const { questId } = await import('../lib/guild.js');
  const draws = ['aaaa0000', 'aaaa0000', 'bbbb1111'];
  const id = questId((x) => x.endsWith('aaaa0000'), () => draws.shift());
  assert.match(id, /^\d{8}-bbbb1111$/);
  // A real one: the date, then 8 random hex digits; one whose directory exists (from a quest not loaded) is skipped.
  assert.match(questId(() => false), /^\d{8}-[0-9a-f]{8}$/);
  const q = await h.createQuest({ goal: 'GOAL-HANG' });
  assert.match(q.id, /^\d{8}-[0-9a-f]{8}$/);
  await h.post(`/api/quests/${q.id}/cancel`);
  await h.waitQuest(q.id, 'cancelled');
});

test('an event log that cannot be written is logged, and the quest goes on (bug 8)', async () => {
  const q0 = await hangingQuest('GOAL-HANG');
  const q = h.live(q0.id);
  const file = path.join(h.home, 'quests', q0.id, 'events.jsonl');
  fs.rmSync(file);
  fs.mkdirSync(file); // appending to it now fails, as on a full disk
  const errors = [];
  const orig = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    q.log('guild', 'system', 'Still here.');
  } finally { console.error = orig; }
  assert.match(errors.join('\n'), /could not log an event/);
  assert.equal((await h.quest(q0.id)).log.at(-1).text, 'Still here.');
  fs.rmdirSync(file);
  await h.post(`/api/quests/${q0.id}/cancel`);
  await h.waitQuest(q0.id, 'cancelled');
});

test('an SSE client that stops reading is dropped once its buffer is full (bug 14)', async () => {
  const { createServer } = await import('../server.js');
  const server = createServer(h.guild, { token: 'test-token', sseBuffer: 64_000 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const before = h.guild.listenerCount('global');
  const sock = net.connect(server.address().port, '127.0.0.1');
  sock.write(`GET /api/events HTTP/1.1\r\nhost: 127.0.0.1:${server.address().port}\r\n\r\n`);
  sock.pause(); // a tab that never reads
  await h.waitFor(() => h.guild.listenerCount('global') === before + 1, { what: 'the client to subscribe' });
  // Far more than the kernel's socket buffers hold, so the response's own buffer fills.
  const blob = 'x'.repeat(200_000);
  for (let i = 0; i < 200 && h.guild.listenerCount('global') > before; i++) {
    h.guild.emit('global', { type: 'noise', blob });
    await sleep(1);
  }
  await h.waitFor(() => h.guild.listenerCount('global') === before, { what: 'the stalled client to be dropped' });
  sock.destroy();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

// Last: it stops the guild.
test('shutdown records running quests as interrupted, saves at once and stops every session (bug 1, 15)', async () => {
  const q0 = await hangingQuest('GOAL-HANG');
  const q = h.live(q0.id);
  const sessions = [q.arch, ...q.sessions.values()];
  q.s.notes = 'pending'; q.save(); // a debounced save still pending
  await h.guild.shutdown();
  assert.ok(sessions.every((s) => s.exited));
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'quests', q0.id, 'quest.json'), 'utf8'));
  assert.equal(saved.notes, 'pending');
  assert.equal(saved.status, 'interrupted');
  assert.equal(saved.resumeStatus, 'questing');
  assert.deepEqual(saved.agents.map((a) => a.status), ['interrupted']);
  assert.equal(h.starts().filter((s) => s.mcpServers.council?.env.GUILD_QUEST_ID === q0.id).length, 1, 'the Archmage was not revived');
  assert.ok(!saved.log.some((e) => e.kind === 'failed'));
  assert.match(saved.log.at(-1).text, /server is stopping/);
  await assert.rejects(h.createQuest({ goal: 'GOAL-HANG' }), /stopping/);
});
