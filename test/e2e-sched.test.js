import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGuild } from './helpers/e2e.js';

// The scheduler through the real server with maxConcurrent=1: agents queue and take the slot one at a time, a slot
// is released when a session ends, and a cancelled agent (queued or working) neither runs nor keeps its slot.

const scout = (key, task) => ({ key, role: 'researcher', title: `Scout ${key}`, task });
const plan = (...tasks) => ({ call: 'propose_plan', args: { summary: 'Scouts.', agents: tasks.map((t) => scout(t.toLowerCase(), t)) } });
const quick = (task) => ({ match: { task }, steps: [{ call: 'report_progress', args: { percent: 50, message: `${task} halfway` } }, { sleep: 150 }, { result: `${task} done` }] });

const queueing = {
  match: { archmage: true, message: 'QUEUE-GOAL' },
  steps: [
    plan('Q1', 'Q2', 'Q3'),
    { result: 'Proposed.' },
    { wait: ['\\(a1\\) has returned', '\\(a2\\) has returned', '\\(a3\\) has returned'] },
    { call: 'finish_quest', args: { chronicle: 'All three came back.' } },
    { result: 'Done.' },
  ],
};

const cancelling = {
  match: { archmage: true, message: 'CANCEL-GOAL' },
  steps: [
    plan('C1', 'C2', 'C3'),
    { result: 'Proposed.' },
    { wait: 'GO' },
    { call: 'cancel_agent', args: { agentId: 'a2', reason: 'not needed' }, as: 'queuedCancel' },
    { call: 'cancel_agent', args: { agentId: 'a1', reason: 'stuck' }, as: 'workingCancel' },
    { say: '${queuedCancel} ${workingCancel}' },
    { wait: '\\(a3\\) has returned' },
    { call: 'finish_quest', args: { chronicle: 'Only the third scout reported.' } },
    { result: 'Done.' },
  ],
};

let h, repo;
before(async () => {
  h = await startGuild({
    settings: { maxConcurrent: 1, batchSeconds: 0.1 },
    scenario: {
      sessions: [
        queueing, cancelling,
        quick('Q1'), quick('Q2'), quick('Q3'),
        // The first scout of the cancel quest never finishes by itself; the others would finish at once.
        { match: { task: 'C1' }, steps: [{ call: 'report_progress', args: { percent: 5, message: 'C1 begun' } }, { hang: true }] },
        { match: { task: 'C2' }, steps: [{ write: 'ran.txt', content: 'C2 ran\n' }, { result: 'C2 done' }] },
        { match: { task: 'C3' }, steps: [{ result: 'C3 done' }] },
      ],
    },
  });
  repo = h.repo('hall');
});
after(() => h?.stop());

const agentStarts = (id) => h.starts().filter((s) => s.mcpServers.guild?.env.GUILD_QUEST_ID === id);
const taskOf = (s) => s.mcpServers.guild.env.GUILD_AGENT_ID;

test('maxConcurrent=1: agents queue, run one at a time and each release starts the next', async () => {
  const q0 = await h.createQuest({ goal: 'QUEUE-GOAL', cwd: repo });
  const id = q0.id;

  // One holds the slot; the others wait their turn, and say so.
  const s = await h.waitQuest(id, (st) => st.agents.length === 3 && st.agents.filter((a) => a.status === 'queued').length === 2);
  assert.equal(s.agents[0].status, 'working');
  assert.deepEqual(s.agents.map((a) => a.activity === 'Waiting for a free slot'), [false, true, true]);
  assert.equal(h.guild.running, 1, 'the Archmage does not count; one agent holds the slot');
  assert.equal(h.guild.queue.length, 2);

  const q = await h.waitQuest(id, 'done');
  assert.deepEqual(q.agents.map((a) => a.status), ['done', 'done', 'done']);

  // Never two at once: each session started after the previous one exited (the slot is released on exit).
  const starts = agentStarts(id).sort((a, b) => a.ts - b.ts);
  assert.deepEqual(starts.map(taskOf), ['a1', 'a2', 'a3'], 'in the order of the plan');
  const exitOf = (s) => h.fakeLog({ event: 'exit', pid: s.pid })[0];
  for (let i = 0; i < 2; i++) assert.ok(exitOf(starts[i]).ts <= starts[i + 1].ts, `a${i + 2} started only after a${i + 1} exited`);

  assert.equal(h.guild.running, 0, 'every slot was given back');
  assert.equal(h.guild.queue.length, 0);
});

test('cancelling a queued agent and a working one: neither runs on, and the slots are released', async () => {
  const q0 = await h.createQuest({ goal: 'CANCEL-GOAL', cwd: repo });
  const id = q0.id;
  await h.waitFor(() => h.fakeLog({ event: 'hang' }).length > 0, { what: 'C1 to hang on its slot' });
  const s = await h.waitQuest(id, (st) => st.agents.length === 3 && st.agents[0].status === 'working');
  assert.deepEqual(s.agents.map((a) => a.status), ['working', 'queued', 'queued']);
  assert.equal(h.guild.running, 1);

  await h.post(`/api/quests/${id}/message`, { text: 'GO' });
  const q = await h.waitQuest(id, 'done');

  const [a1, a2, a3] = q.agents;
  assert.deepEqual([a1.status, a2.status, a3.status], ['cancelled', 'cancelled', 'done']);
  assert.match(a1.result, /^Cancelled: stuck/);
  assert.match(a2.result, /^Cancelled: not needed/);
  const calls = h.toolCalls('cancel_agent').slice(-2).map((c) => c.text);
  assert.match(calls[0], /has been recalled/);
  assert.match(calls[1], /has been recalled/);

  // The queued agent never started a session; the working one was killed; the third got the freed slot.
  assert.deepEqual(agentStarts(id).map(taskOf).sort(), ['a1', 'a3']);
  const hung = agentStarts(id).find((st) => taskOf(st) === 'a1');
  await h.waitFor(() => h.fakeLog({ event: 'killed', pid: hung.pid }).length === 1, { what: 'the working agent to be killed' });
  assert.equal(h.live(id).sessions.size, 0, 'no session is left in the quest');

  assert.equal(h.guild.running, 0, 'both slots were released: the working one by its exit, the queued one never took one');
  assert.equal(h.guild.queue.length, 0);
  assert.equal(h.toolCalls('finish_quest').slice(-1)[0].isError, false);
});
