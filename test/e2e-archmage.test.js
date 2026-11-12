import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGuild } from './helpers/e2e.js';

// The Archmage's turns through the real server with fake-claude: turns that end in an API error are retried with a
// backoff (bug 13), a batch sent into a dead or dying pipe is delivered to the revived Archmage (bug 12), and an
// error in its handlers is logged instead of thrown (bug 8). Bug numbers refer to the lifecycle table in
// the maintainer's lifecycle notes (guild-self-analysis.md, not in this repo).

// Short backoffs (20, 40, 80 ms…), and three retries before the quest fails.
Object.assign(process.env, { GUILD_RETRY_MS: '20', GUILD_RETRY_MAX_MS: '200', GUILD_RETRIES: '3' });

const plan = (task) => ({ call: 'propose_plan', args: { summary: 's', agents: [{ key: 'a', role: 'researcher', title: 'Do it', task }] } });
const finish = { call: 'finish_quest', args: { chronicle: 'Done.' } };
const rateLimited = { result: 'API Error: 429 rate_limit_error', isError: true };

const sessions = [
  // ── errors from the API (bug 13) ──
  // The first turn is rate limited; the briefing comes again and the quest goes on.
  { match: { archmage: true, message: 'GOAL-RATE-ONCE' }, steps: [
    rateLimited, { wait: 'GOAL-RATE-ONCE' }, plan('TASK-QUICK'), { result: 'Proposed.' },
    { wait: '\\(a1\\) has returned' }, finish] },
  // Every turn fails.
  { match: { archmage: true, message: 'GOAL-RATE-ALWAYS' }, steps: [
    { result: 'Credit balance is too low', isError: true },
    ...Array.from({ length: 10 }, () => [{ wait: null }, { result: 'Credit balance is too low', isError: true }]).flat()] },

  // ── batches into a dead pipe (bug 12) ──
  // The test closes the Archmage's stdin while it waits, then tells it something.
  { match: { archmage: true, message: 'GOAL-PIPE' }, steps: [plan('TASK-HANG'), { result: 'Proposed.' }, { wait: 'PING-PIPE' }],
    resume: [{ wait: 'PING-PIPE' }, finish] },
  // The Archmage dies in the turn that carries the party's report.
  { match: { archmage: true, message: 'GOAL-MIDTURN' }, steps: [plan('TASK-QUICK'), { result: 'Proposed.' }, { wait: '\\(a1\\) has returned' }, { exit: 1 }],
    resume: [{ wait: '\\(a1\\) has returned' }, finish] },

  // ── errors in the handlers (bug 8) ──
  // A pause before the first turn ends, so the test can break a method of the quest first.
  { match: { archmage: true, message: 'GOAL-CRASH-TURN' }, steps: [{ sleep: 300 }, { say: 'Thinking.' }, { result: 'No plan.' }, { wait: 'never' }] },
  { match: { archmage: true, message: 'GOAL-CRASH-COUNCIL' }, steps: [{ sleep: 300 }, plan('TASK-QUICK'), { result: 'Tried.' }] },

  { match: { role: 'Scout', task: 'TASK-QUICK' }, steps: [{ result: 'Quick.' }] },
  { match: { role: 'Scout', task: 'TASK-HANG' }, steps: [{ hang: true }] },
];

let h, repo;
before(async () => {
  h = await startGuild({ scenario: { sessions }, settings: { batchSeconds: 0.1 } });
  repo = h.repo('lore');
});
after(() => h?.stop());

const settled = (id, opts) => h.waitQuest(id, (s) => ['done', 'failed', 'cancelled'].includes(s.status) && s.log.some((e) => e.who === 'guild' && /^The quest (is complete|ended)/.test(e.text)), opts);
const startsOf = (id) => h.starts().filter((s) => Object.values(s.mcpServers).some((m) => m.env.GUILD_QUEST_ID === id));
const archmageStarts = (id) => startsOf(id).filter((s) => s.mcpServers.council);
const messagesTo = (id, needle) => {
  const pids = new Set(archmageStarts(id).map((s) => s.pid));
  return h.fakeLog({ event: 'message' }).filter((m) => pids.has(m.pid) && needle.test(m.text));
};
const guildSays = (q, re) => q.log.filter((e) => e.who === 'guild' && re.test(e.text));

// ── errors from the API (bug 13) ──

test('a rate-limited turn is retried after a pause instead of counting as a nudge (bug 13)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-RATE-ONCE', cwd: repo });
  const q = await h.waitQuest(id, 'done');
  assert.equal(guildSays(q, /turn ended in an error: API Error: 429.*Trying again in 20 ms \(retry 1 of 3\)/).length, 1);
  assert.equal(messagesTo(id, /You have not proposed a plan yet/).length, 0, 'no nudge for a failed turn');
  assert.equal(messagesTo(id, /^Your last turn ended in an error, so what it was given comes again\.[\s\S]*GOAL-RATE-ONCE/).length, 1, 'the briefing is sent again');
  assert.equal(q.agents[0].status, 'done');
});

test('turns that keep failing are retried with a growing pause, then the quest fails with the reason (bug 13)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-RATE-ALWAYS', cwd: repo });
  const q = await settled(id);
  assert.equal(q.status, 'failed');
  const delays = guildSays(q, /Trying again in/).map((e) => /in (\d+ ms)/.exec(e.text)[1]);
  assert.deepEqual(delays, ['20 ms', '40 ms', '80 ms']);
  assert.match(q.chronicle, /kept failing \(Credit balance is too low\), 3 retries in a row/);
  assert.equal(messagesTo(id, /You have not proposed a plan yet/).length, 0);
  assert.equal(messagesTo(id, /GOAL-RATE-ALWAYS/).length, 4, 'the briefing, then three retries');
});

// ── batches into a dead pipe (bug 12) ──

test('a message for an Archmage whose pipe has closed is kept and delivered to the revived one (bug 12)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-PIPE', cwd: repo });
  await h.waitAgent(id, 'a1', 'working');
  const q = h.live(id);
  await h.waitFor(() => q.arch && !q.arch.busy && q.s.archmage.status === 'waiting', { what: 'the Archmage to wait' });
  const arch = q.arch;
  arch.proc.stdin.destroy();
  assert.equal(arch.send('lost?'), false, 'send() says the pipe is closed');
  assert.equal(arch.busy, false);
  q.tell('PING-PIPE', true);
  assert.deepEqual(q.inbox, ['PING-PIPE'], 'the batch went back into the inbox');
  const done = await h.waitQuest(id, 'done');
  assert.equal(archmageStarts(id).length, 2, 'the Archmage was revived');
  assert.equal(messagesTo(id, /PING-PIPE/).length, 1, 'the revived Archmage got the message');
  assert.equal(done.agents[0].status, 'cancelled');
});

test('a batch in flight when the Archmage dies goes to the revived one (bug 12)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-MIDTURN', cwd: repo });
  const q = await h.waitQuest(id, 'done');
  const [first, revived] = archmageStarts(id);
  assert.ok(revived, 'the Archmage was revived');
  const reports = messagesTo(id, /\(a1\) has returned/);
  assert.deepEqual(reports.map((m) => m.pid), [first.pid, revived.pid], 'the report reached both sessions');
  assert.equal(messagesTo(id, /The whole party has finished/).length, 0);
  assert.equal(q.agents[0].status, 'done');
});

// ── errors in the handlers (bug 8) ──

test('an error after the Archmage\'s turn is logged to the quest and the server carries on (bug 8)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-CRASH-TURN', cwd: repo });
  const q = h.live(id);
  q.tell = () => { throw new Error('boom in tell'); };
  const s = await h.waitQuest(id, (st) => guildSays(st, /Guild hit an error in the check after the Archmage's turn: boom in tell/).length);
  assert.equal(s.status, 'planning');
  delete q.tell;
  assert.ok((await h.get('/api/quests')).some((x) => x.id === id), 'the server still answers');
  await h.post(`/api/quests/${id}/cancel`);
  assert.equal((await settled(id)).status, 'cancelled');
});

test('a council tool that throws answers the Archmage with the error and logs it (bug 8)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-CRASH-COUNCIL', cwd: repo });
  h.live(id).proposePlan = async () => { throw new Error('boom in plan'); };
  const q = await settled(id);
  const pid = archmageStarts(id)[0].pid;
  const call = h.toolCalls('propose_plan').find((c) => c.pid === pid);
  assert.equal(call.isError, true);
  assert.match(call.text, /boom in plan/);
  assert.equal(guildSays(q, /The Archmage's propose_plan failed: boom in plan/).length, 1);
  assert.equal(messagesTo(id, /You have not proposed a plan yet/).length, 2, 'a failed tool call is no progress');
  assert.equal(q.status, 'failed');
});
