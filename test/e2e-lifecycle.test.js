import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startGuild } from './helpers/e2e.js';

// Lifecycle paths through the real server with fake-claude as every session: asks and answers, nudges, and the
// revival of an Archmage whose process dies. Bug numbers refer to the lifecycle table in
// guild-self-analysis.md (maintainer's notes, not in this repo); a { todo } test is one that exposes a bug still present.

const plan = (task, extra = {}) => ({ call: 'propose_plan', args: { summary: 's', agents: [{ key: 'a', role: 'researcher', title: 'Do it', task, ...extra }] } });
const finish = { call: 'finish_quest', args: { chronicle: 'Done.' } };

const sessions = [
  // ── ask and answer ──
  { match: { archmage: true, message: 'GOAL-ASK-ARCH' }, steps: [
    plan('TASK-ASK-ARCH'), { result: 'Proposed.' },
    { wait: '\\[blocked\\].*Which colour' },
    { call: 'answer_agent', args: { agentId: 'a1', text: 'Blue.' } },
    { wait: '\\(a1\\) has returned' }, finish] },
  { match: { role: 'Scout', task: 'TASK-ASK-ARCH' }, steps: [
    { call: 'ask', args: { question: 'Which colour?' }, as: 'answer' },
    { result: 'Painted it. ${answer}' }] },

  { match: { archmage: true, message: 'GOAL-ASK-HUMAN' }, steps: [
    plan('TASK-ASK-HUMAN'), { result: 'Proposed.' },
    { wait: '\\[blocked\\]' }, { result: 'The human may answer.' },
    { wait: '\\(a1\\) has returned' }, finish] },
  { match: { role: 'Scout', task: 'TASK-ASK-HUMAN' }, steps: [
    { call: 'ask', args: { question: 'Which size?' }, as: 'answer' },
    { result: 'Sized it. ${answer}' }] },

  // An agent that asks and is then killed from outside; the Archmage only waits.
  { match: { archmage: true, message: 'GOAL-ASK-DEAD' }, steps: [plan('TASK-ASK-DEAD'), { result: 'Proposed.' }, { wait: 'fell' }, { sleep: 5000 }] },
  { match: { role: 'Scout', task: 'TASK-ASK-DEAD' }, steps: [{ call: 'ask', args: { question: 'Still there?' } }, { result: 'Never reached.' }] },

  // An agent that hangs, so a test can post asks for it by hand.
  { match: { archmage: true, message: 'GOAL-ASK-TWO' }, steps: [plan('TASK-ASK-TWO'), { result: 'Proposed.' }, { wait: 'never' }] },
  { match: { role: 'Scout', task: 'TASK-ASK-TWO' }, steps: [{ hang: true }] },

  // An agent whose question nobody answers: the test shortens the deadline before it asks.
  { match: { archmage: true, message: 'GOAL-ASK-LATE' }, steps: [
    plan('TASK-ASK-LATE'), { result: 'Proposed.' },
    { wait: '\\[unanswered\\]' }, { wait: '\\(a1\\) has returned' }, finish] },
  { match: { role: 'Scout', task: 'TASK-ASK-LATE' }, steps: [
    { sleep: 400 }, { call: 'ask', args: { question: 'Anyone?' }, as: 'answer' },
    { result: 'Decided myself. ${answer}' }] },

  // ── starting and waking (bugs 2 and 6) ──
  // The test recalls the agent, or ends the quest, while its worktree is being made; the Archmage only waits.
  { match: { archmage: true, message: 'GOAL-START-CANCEL' }, steps: [{ sleep: 300 }, plan('TASK-START'), { result: 'Proposed.' }, { wait: 'never' }] },
  { match: { archmage: true, message: 'GOAL-START-STOP' }, steps: [{ sleep: 300 }, plan('TASK-START'), { result: 'Proposed.' }, { wait: 'never' }] },
  { match: { archmage: true, message: 'GOAL-START-END' }, steps: [{ sleep: 300 }, plan('TASK-START'), { result: 'Proposed.' }, { wait: 'never' }] },
  { match: { role: 'Scout', task: 'TASK-START' }, steps: [{ result: 'Should never have started.' }] },
  // The agent's process lingers after its final report, and the human wakes it meanwhile.
  // The Archmage wakes it in the same turn it hears of the report, so the finished party is not nudged meanwhile.
  { match: { archmage: true, message: 'GOAL-WAKE' }, steps: [
    plan('TASK-WAKE'), { result: 'Proposed.' },
    { wait: '\\(a1\\) has returned' }, { call: 'message_agent', args: { agentId: 'a1', text: 'One more thing.' } }, { result: 'Woke it.' },
    { wait: '\\(a1\\) has returned' }, finish] },
  { match: { role: 'Scout', task: 'TASK-WAKE' }, steps: [{ result: 'First report.' }, { sleep: 1500 }], resume: [{ result: 'Woken: ${message}' }] },

  // ── a handler that throws (bug 8) ──
  { match: { archmage: true, message: 'GOAL-THROW' }, steps: [plan('TASK-THROW'), { result: 'Proposed.' }, { wait: '\\[failed\\]' }, finish] },
  { match: { role: 'Scout', task: 'TASK-THROW' }, steps: [{ result: 'Fine.' }] },

  // ── nudges ──
  // The Archmage ends each turn with nothing proposed; after the nudges the quest fails.
  { match: { archmage: true, message: 'GOAL-NUDGE-PLAN' }, steps: [{ say: 'Hmm.' }, { result: 'No plan yet.' }] },
  // The party finishes and the Archmage never calls finish_quest.
  { match: { archmage: true, message: 'GOAL-NUDGE-FINISH' }, steps: [plan('TASK-QUICK'), { result: 'Proposed.' }, { say: 'Resting.' }] },
  // Post-party chats (bug 7): after the party has returned, each turn takes one message (the nudges and the human's
  // chats) and keeps a turn open for a moment, so the test can chat in between; it finishes after nine messages.
  { match: { archmage: true, message: 'GOAL-NUDGE-CHAT' }, steps: [
    plan('TASK-QUICK'), { result: 'Proposed.' }, { wait: '\\(a1\\) has returned' },
    ...Array.from({ length: 9 }, () => [{ wait: null }, { sleep: 150 }]).flat(), finish] },
  { match: { role: 'Scout', task: 'TASK-QUICK' }, steps: [{ result: 'Quick.' }] },

  // ── revival ──
  { match: { archmage: true, message: 'GOAL-REVIVE-ONCE' }, steps: [plan('TASK-QUICK'), { result: 'Proposed.' }, { exit: 1 }], resume: [{ wait: '\\(a1\\) has returned' }, finish] },
  { match: { archmage: true, message: 'GOAL-REVIVE-LIMIT' }, steps: [{ exit: 1 }], resume: [{ exit: 1 }] },
];

let h, repo;
before(async () => {
  h = await startGuild({ scenario: { sessions }, settings: { batchSeconds: 0.1 } });
  repo = h.repo('lore');
});
after(() => h?.stop());

const settled = (id, opts) => h.waitQuest(id, (s) => ['done', 'failed', 'cancelled'].includes(s.status) && s.log.some((e) => e.who === 'guild' && /^The quest (is complete|ended)/.test(e.text)), opts);
// fake-claude's logged messages to the sessions of one quest (the log is shared by all of them).
const startsOf = (id) => h.starts().filter((s) => Object.values(s.mcpServers).some((m) => m.env.GUILD_QUEST_ID === id));
const archmageStarts = (id) => startsOf(id).filter((s) => s.mcpServers.council);
const messagesTo = (id, needle) => {
  const pids = new Set(startsOf(id).map((s) => s.pid));
  return h.fakeLog({ event: 'message' }).filter((m) => pids.has(m.pid) && needle.test(m.text));
};

// ── ask and answer ──

test('an agent asks, the Archmage answers with answer_agent, and the agent finishes with the answer', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-ASK-ARCH', cwd: repo });
  const q = await h.waitQuest(id, 'done');
  assert.equal(q.agents[0].status, 'done');
  assert.equal(q.agents[0].result, 'Painted it. Answer: Blue.', 'the long-poll returned the answer to the agent');
  assert.equal(q.agents[0].question, null);
  assert.equal(h.toolCalls('ask')[0].text, 'Answer: Blue.');
  assert.match(h.toolCalls('answer_agent')[0].text, /^Answered /);
  assert.ok(q.log.some((e) => e.who === 'a1' && e.kind === 'question' && e.text === 'Which colour?'));
  assert.ok(q.log.some((e) => e.who === 'archmage' && e.kind === 'answer' && e.text === 'Blue.'));
});

test('the human can answer an agent through the route, and the agent carries on', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-ASK-HUMAN', cwd: repo });
  const blocked = await h.waitAgent(id, 'a1', 'blocked');
  assert.equal(blocked.question, 'Which size?');
  assert.ok(blocked.askId);
  await h.post(`/api/quests/${id}/agents/a1/answer`, { text: 'Large.' });
  const q = await h.waitQuest(id, 'done');
  assert.equal(q.agents[0].result, 'Sized it. Answer: (from the human) Large.');
  assert.ok(messagesTo(id, /The human answered .* \(a1\): Large\./).length >= 1, 'the Archmage is told what the human said');
});

test('answering an agent that has died does not bring it back to life (bug 3)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-ASK-DEAD', cwd: repo });
  await h.waitAgent(id, 'a1', 'blocked');
  h.live(id).sessions.get('a1').kill();
  await h.waitAgent(id, 'a1', 'failed');
  await h.waitFor(() => messagesTo(id, /fell/).length, { what: 'the Archmage to hear of the fall' });

  let answered;
  try { answered = await h.post(`/api/quests/${id}/agents/a1/answer`, { text: 'Too late.' }); } catch (err) { answered = err; }
  const after = (await h.quest(id)).agents[0].status;
  // Clean up first, so a failed assertion leaves nothing running.
  await h.post(`/api/quests/${id}/cancel`);
  await settled(id);
  assert.equal(after, 'failed', `a dead agent stays dead (the answer said: ${answered.message ?? answered.text})`);
  assert.equal(answered.status, 400, 'the human is told there is no open question');
  const a = (await h.quest(id)).agents[0];
  assert.equal(a.question, null, 'its question died with its session');
  assert.equal(a.ask, null);
});

test('two asks from one agent are both settled by the answer (bug 9)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-ASK-TWO', cwd: repo });
  await h.waitAgent(id, 'a1', 'working');
  const secret = { 'x-guild-secret': h.live(id).secret };
  const askUrl = `/internal/quests/${id}/agents/a1/ask`;
  const accepted = [];
  for (const question of ['First?', 'Second?']) {
    const r = await h.request('POST', askUrl, { body: { question }, headers: secret });
    if (r.status < 400) accepted.push(r.body.askId);
  }
  // The human answers until the agent has no open question left.
  for (let i = 0; i < accepted.length; i++) await h.request('POST', `/api/quests/${id}/agents/a1/answer`, { body: { text: `Reply ${i + 1}.` } });
  const polls = await Promise.all(accepted.map((askId) => h.request('GET', `${askUrl}/${askId}?wait=1`, { headers: secret })));
  const stuck = polls.filter((r) => r.body.pending).length;
  await h.post(`/api/quests/${id}/cancel`);
  await settled(id);
  assert.equal(stuck, 0, `${stuck} of ${accepted.length} accepted asks still wait for an answer`);
  assert.match(polls[0].body.answer, /You asked another question since \("Second\?"\), so this one is withdrawn/);
  assert.equal(polls[1].body.answer, '(from the human) Reply 1.', 'the first answer goes to the latest question');
});

test('a question that passes its deadline is settled, and the agent decides for itself (bug 9)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-ASK-LATE', cwd: repo });
  h.live(id).askDeadlineMs = 300; // the agent asks after 400 ms
  const blocked = await h.waitAgent(id, 'a1', 'blocked');
  assert.deepEqual(Object.keys(blocked.ask).sort(), ['askedAt', 'deadline', 'human', 'id', 'question'], 'the open question is plain data');
  assert.equal(blocked.ask.question, 'Anyone?');
  assert.equal(Date.parse(blocked.ask.deadline) - Date.parse(blocked.ask.askedAt), 300);
  const q = await h.waitQuest(id, 'done');
  assert.match(q.agents[0].result, /^Decided myself\. Answer: No answer came within 1 min\. Decide for yourself/);
  assert.equal(q.agents[0].ask, null);
  assert.ok(messagesTo(id, /\[unanswered\] .* \(a1\) had no answer within 1 min to: Anyone\?/).length >= 1, 'the Archmage hears of it');
});

// ── starting and waking ──

const startsOfAgent = (id, agentId) => startsOf(id).filter((s) => s.mcpServers.guild?.env.GUILD_AGENT_ID === agentId);

test('an agent recalled while its worktree is being made does not start, and gives back its slot (bug 2)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-START-CANCEL', cwd: repo, mode: 'edit' });
  const q = h.live(id);
  let worktreeMade;
  q.startHook = async (a) => {
    worktreeMade = a.dir;
    await h.post(`/api/quests/${id}/agents/${a.id}/cancel`);
  };
  const a = await h.waitAgent(id, 'a1', 'cancelled');
  await h.waitFor(() => (q.s.log.some((e) => /did not set out: recalled/.test(e.text)) ? true : null), { what: 'the start to be called off' });
  assert.ok(worktreeMade, 'it was cancelled after its worktree was made');
  assert.equal(a.status, 'cancelled');
  assert.equal(startsOfAgent(id, 'a1').length, 0, 'no session was started');
  assert.equal(q.sessions.size, 0);
  assert.equal(h.guild.running, 0, 'its slot is free again');
  // With its only member recalled the party is finished, and the Archmage (which only waits) may already have
  // been nudged out of the quest.
  await h.post(`/api/quests/${id}/cancel`).catch(() => {});
  await settled(id);
  assert.equal((await h.quest(id)).agents[0].status, 'cancelled');
});

test('an agent being set up when the quest ends does not start (bug 2)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-START-END', cwd: repo, mode: 'edit' });
  const q = h.live(id);
  q.startHook = () => h.post(`/api/quests/${id}/cancel`);
  const s = await settled(id);
  await h.waitFor(() => (q.s.log.some((e) => /did not set out: the quest is cancelled/.test(e.text)) ? true : null), { what: 'the start to be called off' });
  assert.equal(s.status, 'cancelled');
  assert.equal(s.agents[0].status, 'cancelled');
  assert.equal(startsOfAgent(id, 'a1').length, 0, 'no session was started');
  assert.equal(h.guild.running, 0, 'its slot is free again');
});

test('an agent being set up when the server starts stopping does not start (bug 2)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-START-STOP', cwd: repo, mode: 'edit' });
  const q = h.live(id);
  q.startHook = () => { h.guild.stopping = true; };
  try {
    await h.waitFor(() => (q.s.log.some((e) => /did not set out: the server is stopping/.test(e.text)) ? true : null), { what: 'the start to be called off' });
  } finally {
    h.guild.stopping = false;
  }
  assert.equal(startsOfAgent(id, 'a1').length, 0, 'no session was started');
  assert.equal(h.guild.running, 0, 'its slot is free again');
  await h.post(`/api/quests/${id}/cancel`);
  await settled(id);
});

test('an agent woken while its last process is still closing waits for it, and that exit does not fail it (bug 6)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-WAKE', cwd: repo });
  const q = await h.waitQuest(id, 'done');
  const [first, second] = startsOfAgent(id, 'a1');
  assert.ok(second, 'it was woken in a second process');
  assert.equal(second.args.resume, first.sessionId);
  const firstExit = h.fakeLog({ event: 'exit' }).find((e) => e.pid === first.pid);
  assert.ok(firstExit && firstExit.ts <= second.ts, 'the second process started only after the first had exited');
  assert.equal(q.agents[0].status, 'done');
  assert.match(q.agents[0].result, /^Woken: A message from the Archmage:\nOne more thing\./);
  assert.ok(!q.log.some((e) => e.who === 'a1' && e.kind === 'failed'), 'the old exit did not fail the woken agent');
  assert.equal(h.guild.running, 0);
});

// ── a handler that throws ──

test('an error in an agent\'s result handler fails only that agent, and the quest carries on (bug 8)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-THROW', cwd: repo });
  h.live(id).onAgentResult = async () => { throw new Error('boom'); };
  const q = await h.waitQuest(id, 'done');
  assert.equal(q.agents[0].status, 'failed');
  assert.match(q.agents[0].result, /The Guild failed on its turn result: boom/);
  assert.ok(messagesTo(id, /\[failed\] .* \(a1\) fell: the Guild failed on its turn result \(boom\)/).length >= 1);
  assert.equal(h.guild.running, 0, 'its session was ended and its slot given back');
});

// ── nudges ──

test('an Archmage that ends its turn without a plan is nudged twice, then the quest fails', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-NUDGE-PLAN', cwd: repo });
  const q = await h.waitQuest(id, 'failed');
  assert.equal(messagesTo(id, /You have not proposed a plan yet/).length, 2);
  assert.match(q.chronicle, /did not propose a plan/);
  assert.equal(q.agents.length, 0);
  assert.equal(h.toolCalls('propose_plan').filter((c) => c.pid === archmageStarts(id)[0].pid).length, 0);
});

test('an Archmage that never finishes after the party returned is nudged three times, then the quest fails', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-NUDGE-FINISH', cwd: repo });
  const q = await h.waitQuest(id, 'failed');
  assert.equal(q.agents[0].status, 'done');
  assert.equal(messagesTo(id, /The whole party has finished/).length, 3);
  assert.match(q.chronicle, /did not finish the quest/);
});

test('chats with the human after the party returned do not use up the nudges (bug 7)', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-NUDGE-CHAT', cwd: repo });
  // Chat once after each of the first three nudges.
  for (let i = 1; i <= 3; i++) {
    const seen = await h.waitFor(() => messagesTo(id, /The whole party has finished/).length >= i || h.live(id).status === 'failed', { what: `nudge ${i}`, timeout: 5000 });
    if (!seen || h.live(id).s.status !== 'questing') break; // already failed: the assertion below says so
    await h.post(`/api/quests/${id}/message`, { text: `chat ${i}` });
  }
  const q = await settled(id, { timeout: 8000 });
  assert.equal(q.status, 'done', `the quest ended ${q.status}: ${q.chronicle}`);
  assert.equal(messagesTo(id, /Message from the human: chat \d/).length, 3);
  assert.ok(messagesTo(id, /The whole party has finished/).length > 3, 'each chat started the finish nudges afresh');
});

// ── revival ──

test('an Archmage whose process dies is revived with --resume and carries on to the end', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-REVIVE-ONCE', cwd: repo });
  const q = await h.waitQuest(id, 'done');
  const mine = archmageStarts(id);
  assert.equal(mine.length, 2, 'the Archmage started twice');
  assert.equal(mine[0].args.resume, undefined);
  assert.equal(mine[1].args.resume, mine[0].sessionId, 'the revived one resumes the same Claude session');
  assert.ok(q.log.some((e) => e.who === 'guild' && /ended unexpectedly \(exit 1\); reviving/.test(e.text)));
  assert.equal(messagesTo(id, /Your session was restarted/).length >= 1, true);
  assert.equal(q.agents[0].status, 'done');
});

test('an Archmage that keeps dying is revived twice and then the quest fails', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-REVIVE-LIMIT', cwd: repo });
  const q = await h.waitQuest(id, 'failed');
  const mine = archmageStarts(id);
  assert.equal(mine.length, 3, 'one start and two revivals');
  assert.ok(mine.slice(1).every((s) => s.args.resume === mine[0].sessionId));
  assert.ok(q.log.some((e) => e.who === 'guild' && /The Archmage is gone \(exit 1\)/.test(e.text)));
  assert.match(q.chronicle, /Archmage session ended before the quest was finished/);
});
