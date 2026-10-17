import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startGuild } from './helpers/e2e.js';

// Interrupt, reload and resume, end to end: a quest is stopped in the middle (the server stops: its quests are
// marked interrupted and its sessions killed), a fresh Guild on the same GUILD_HOME loads it as interrupted, and the
// resume route carries it on: the Archmage and the interrupted agents start again with --resume.

const plan = (agents) => ({ call: 'propose_plan', args: { summary: 's', agents } });
const finish = { call: 'finish_quest', args: { chronicle: 'Finished after the restart.' } };

const sessions = [
  // read quest: a2 returns before the stop; a1 is still working (it hangs, as if cut off) when the server stops
  { match: { archmage: true, message: 'GOAL-READ' }, steps: [
    plan([{ key: 'long', role: 'researcher', title: 'Long job', task: 'TASK-LONG' }, { key: 'short', role: 'researcher', title: 'Short job', task: 'TASK-SHORT' }]),
    { result: 'Proposed.' }, { wait: '\\(a2\\) has returned' }, { wait: '\\(a1\\) has returned' }, finish],
    resume: [{ wait: '\\(a1\\) has returned' }, finish] },
  { match: { role: 'Scout', task: 'TASK-LONG' }, steps: [{ call: 'report_progress', args: { percent: 10, message: 'Started.' } }, { hang: true }],
    resume: [{ call: 'report_progress', args: { percent: 60, message: 'Carrying on.' } }, { result: 'Finished after the restart.', cost: 0.1 }] },
  { match: { role: 'Scout', task: 'TASK-SHORT' }, steps: [{ result: 'Short job done.' }] },

  // edit quest: the smith has committed once when the server stops, and commits again after the resume
  { match: { archmage: true, message: 'GOAL-EDIT' }, steps: [
    plan([{ key: 'smith', role: 'implementer', title: 'Forge', task: 'TASK-FORGE' }]),
    { result: 'Proposed.' }, { wait: '\\(a1\\) has returned' }, { call: 'merge_party' }, finish],
    resume: [{ wait: '\\(a1\\) has returned' }, { call: 'merge_party' }, finish] },
  { match: { role: 'Smith', task: 'TASK-FORGE' }, steps: [
    { write: 'one.txt', content: 'one\n', commit: 'Add one' },
    { call: 'report_progress', args: { percent: 40, message: 'One forged.' } }, { hang: true }],
    resume: [{ write: 'two.txt', content: 'two\n', commit: 'Add two' }, { result: 'Forged both.', cost: 0.1 }] },
];

let h, repo;
before(async () => {
  h = await startGuild({ scenario: { sessions }, settings: { batchSeconds: 0.1 } });
  repo = h.repo('forge', { 'README.md': '# Forge\n' });
});
after(() => h?.stop());

const restart = () => h.restart();
const startOf = (starts, agentId) => starts.find((s) => s.mcpServers.guild?.env.GUILD_AGENT_ID === agentId);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();

test('an interrupted read quest is recorded as interrupted by a fresh server, and resumes to the end', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-READ', cwd: repo });
  await h.waitAgent(id, 'a2', 'done');
  await h.waitAgent(id, 'a1', (a) => a.percent === 10);
  await h.waitFor(() => h.live(id).s.archmage.status === 'waiting', { what: 'the Archmage to wait' });
  const before = h.starts().filter((s) => JSON.stringify(s.mcpServers).includes(id));
  assert.equal(before.length, 3);
  const archSession = before.find((s) => s.mcpServers.council).sessionId;
  const longSession = startOf(before, 'a1').sessionId;

  await restart();

  // The fresh server's view of the quest: interrupted, with the agents that were at work interrupted too.
  const q = await h.quest(id);
  assert.equal(q.status, 'interrupted');
  assert.deepEqual(q.agents.map((a) => [a.id, a.status]), [['a1', 'interrupted'], ['a2', 'done']]);
  assert.equal(q.archmage.status, 'idle');
  assert.equal(q.agents[0].sessionId, longSession, 'the session ids were kept for the resume');
  assert.equal(q.archmage.sessionId, archSession);
  assert.equal(h.fakeLog({ event: 'start' }).length, 3, 'nothing was revived by the stop');
  assert.equal((await h.get('/api/quests')).find((x) => x.id === id).status, 'interrupted');

  await h.post(`/api/quests/${id}/resume`);
  const done = await h.waitQuest(id, 'done');
  assert.equal(done.agents[0].status, 'done');
  assert.equal(done.agents[0].result, 'Finished after the restart.');
  assert.equal(done.agents[1].result, 'Short job done.', 'a finished agent is not started again');
  assert.equal(done.chronicle, 'Finished after the restart.');
  assert.ok(done.log.some((e) => e.who === 'you' && e.text === 'Resumed the quest.'));

  const after = h.starts().filter((s) => JSON.stringify(s.mcpServers).includes(id)).slice(3);
  assert.equal(after.length, 2, 'only the Archmage and the interrupted agent started again');
  assert.equal(after.find((s) => s.mcpServers.council).args.resume, archSession);
  assert.equal(startOf(after, 'a1').args.resume, longSession);
  assert.equal(startOf(after, 'a2'), undefined);
  assert.equal(after.find((s) => s.mcpServers.council).mcpServers.council.env.GUILD_URL, h.url, 'the new sessions reach the new server');
});

test('the Archmage is told who is resuming, and what the party looks like now', async () => {
  const msg = h.fakeLog({ event: 'message' }).find((m) => /the human has now resumed it/.test(m.text));
  assert.ok(msg, 'the Archmage got a resume message');
  assert.match(msg.text, /These agents were interrupted and are resuming: .+ \(a1\)\./);
  assert.match(msg.text, /The party now:\na1: /);
});

test('only an interrupted quest can be resumed', async () => {
  const [q] = (await h.get('/api/quests')).filter((x) => x.status === 'done');
  const r = await h.request('POST', `/api/quests/${q.id}/resume`, { body: {} });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Only an interrupted quest can be resumed/);
});

test('an interrupted edit quest keeps its worktree and commits, and resumes to a merged result', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-EDIT', cwd: repo, mode: 'edit' });
  await h.waitAgent(id, 'a1', (a) => a.percent === 40);
  const worktree = (await h.quest(id)).agents[0].dir;
  assert.ok(fs.existsSync(path.join(worktree, 'one.txt')));

  await restart();

  const q = await h.quest(id);
  assert.equal(q.status, 'interrupted');
  assert.equal(q.agents[0].status, 'interrupted');
  assert.ok(fs.existsSync(path.join(worktree, 'one.txt')), 'the worktree survived the stop');

  await h.post(`/api/quests/${id}/resume`);
  const done = await h.waitQuest(id, 'done');
  assert.equal(done.agents[0].result, 'Forged both.');
  assert.equal(done.agents[0].dir, worktree, 'the agent resumed in the same worktree');
  assert.equal(h.starts().filter((s) => startOf([s], 'a1') && s.mcpServers.guild.env.GUILD_QUEST_ID === id).at(-1).cwd, worktree);
  assert.ok(done.delivery?.commit, 'the finished quest has a commit to deliver');
  const files = git(repo, 'ls-tree', '-r', '--name-only', done.delivery.commit).split('\n');
  assert.ok(files.includes('one.txt') && files.includes('two.txt'), `both commits were merged (${files})`);
});
