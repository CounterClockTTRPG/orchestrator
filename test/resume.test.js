import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Interrupted quests: marked on load, resumed from their Claude sessions; and event numbering for replay.

let Quest, store;
before(async () => {
  process.env.GUILD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  ({ Quest } = await import('../lib/guild.js'));
  store = await import('../lib/store.js');
});

const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

function interrupted(id) {
  fs.mkdirSync(store.questDir(id), { recursive: true });
  const guild = { settings: { batchSeconds: 60, maxConcurrent: 4 }, emit() {}, running: 0, acquire() {}, release() {}, role: () => ({}) };
  const q = new Quest(guild, {
    id, goal: 'g', status: 'questing', planning: 'auto', mode: 'read', maxAgents: 6, createdAt: ago(600), updatedAt: ago(300),
    plan: { status: 'approved', agents: [] }, log: [], merged: [],
    archmage: { name: 'Velothar', status: 'thinking', sessionId: 'arch-session' },
    agents: [
      { id: 'a1', name: 'Hilda', title: 'Tester', status: 'working', percent: 40, sessionId: 's1', startedAt: ago(500), notes: [] },
      { id: 'a2', name: 'Borin', title: 'Smith', status: 'done', percent: 100, sessionId: 's2', startedAt: ago(500), finishedAt: ago(400), notes: [] },
      { id: 'a3', name: 'Ilse', title: 'Scout', status: 'queued', percent: 0, sessionId: null, notes: [] },
    ],
  });
  q.markInterrupted();
  const started = [], scheduled = [];
  q.startArchmage = (msg, resume) => started.push({ msg, resume });
  q.schedule = (a, msg) => { scheduled.push({ id: a.id, msg }); a.status = 'queued'; };
  return { q, started, scheduled };
}

test('a stopped server leaves the quest and its unfinished agents interrupted', () => {
  const { q } = interrupted('r1');
  assert.equal(q.s.status, 'interrupted');
  assert.equal(q.s.resumeStatus, 'questing');
  assert.deepEqual(q.s.agents.map((a) => a.status), ['interrupted', 'done', 'interrupted']);
  assert.ok(q.s.agents[0].interruptedAt);
});

test('resume restarts the Archmage and the interrupted agents from their sessions', async () => {
  const { q, started, scheduled } = interrupted('r2');
  await q.resume();
  clearInterval(q.timer);
  assert.equal(q.s.status, 'questing');
  assert.equal(q.s.finishedAt, null);
  assert.ok(q.s.pausedMs >= 299_000, 'the downtime is not counted as running time');
  assert.equal(started.length, 1);
  assert.equal(started[0].resume, 'arch-session');
  assert.match(started[0].msg, /Hilda \(a1\), Ilse \(a3\)/);
  assert.deepEqual(scheduled.map((s) => s.id), ['a1', 'a3']);
  assert.match(scheduled[0].msg, /resumed/); // a1 carries on in its session
  assert.equal(scheduled[1].msg, null); // a3 never set out: it starts afresh
  assert.ok(q.s.agents[0].pausedMs > 0);
  assert.equal(q.s.agents[1].status, 'done');
  await assert.rejects(q.resume(), /Only an interrupted quest/);
});

test('a quest whose Archmage never had a session cannot be resumed', async () => {
  const { q } = interrupted('r3');
  q.s.archmage.sessionId = null;
  await assert.rejects(q.resume(), /never got a session/);
});

test('stored events are numbered and can be read back after a given number', () => {
  fs.mkdirSync(store.questDir('e1'), { recursive: true });
  const q = new Quest({ settings: {}, emit() {} }, { id: 'e1', goal: 'g', status: 'questing', agents: [], log: [] });
  q.emit('log', { entry: 1 });
  q.emit('activity', { activity: 'Reading' }); // not stored, not numbered
  q.emit('log', { entry: 2 });
  q.emit('log', { entry: 3 });
  clearTimeout(q.saveTimer);
  assert.equal(q.s.seq, 3);
  assert.deepEqual(store.readEventsSince('e1', 1).map((e) => [e.seq, e.entry]), [[2, 2], [3, 3]]);
  assert.deepEqual(store.readEventsSince('e1', 3), []);
});
