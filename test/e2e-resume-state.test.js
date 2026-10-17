import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startGuild } from './helpers/e2e.js';

// What a resume restores besides the sessions: the Archmage's inbox (reports and human messages it had not taken
// in, and the batch of a turn the stop cut off), the questions agents were blocked on, members that wait for
// others (`after`), and the worktrees of an application of two repositories.

const plan = (agents) => ({ call: 'propose_plan', args: { summary: 's', agents } });
const finish = { call: 'finish_quest', args: { chronicle: 'Finished after the restart.' } };
const report = (percent, message) => ({ call: 'report_progress', args: { percent, message } });
const scout = (key, task, extra = {}) => ({ key, role: 'researcher', title: `Do ${key}`, task, ...extra });

const sessions = [
  // inbox: the Archmage's first turn never ends, so a report and a human message wait in its inbox at the stop
  { match: { archmage: true, message: 'GOAL-INBOX' }, steps: [plan([scout('w', 'TASK-INBOX')]), { hang: true }],
    resume: [{ wait: 'HUMAN-HELLO' }, { say: 'Hello, human.' }, { wait: '\\(a1\\) has returned' }, finish] },
  { match: { task: 'TASK-INBOX' }, steps: [report(30, 'INBOX-REPORT'), { hang: true }], resume: [{ sleep: 400 }, { result: 'Inbox job done.' }] },

  // in flight: the stop cuts off the turn that carries a report
  { match: { archmage: true, message: 'GOAL-FLIGHT' }, steps: [plan([scout('w', 'TASK-FLIGHT')]), { result: 'Proposed.' }, { wait: 'FLIGHT-REPORT' }, { hang: true }],
    resume: [{ wait: ['FLIGHT-REPORT', '\\(a1\\) has returned'] }, finish] },
  { match: { task: 'TASK-FLIGHT' }, steps: [report(30, 'FLIGHT-REPORT'), { hang: true }], resume: [{ result: 'Flight job done.' }] },

  // ask: the agent is blocked on a question when the server stops; the answer after the resume wakes it
  { match: { archmage: true, message: 'GOAL-ASK' }, steps: [plan([scout('w', 'TASK-ASK')]), { result: 'Proposed.' }],
    resume: [{ wait: '\\(a1\\) has returned' }, finish] },
  { match: { task: 'TASK-ASK' }, steps: [{ call: 'ask', args: { question: 'ASK-Q: blue or red?' } }, { result: 'Should not get here.' }],
    resume: [{ result: 'Painted. ${message}' }] },

  // after: a2 waits for a1, which is interrupted; a2 starts once a1 finishes after the resume
  { match: { archmage: true, message: 'GOAL-AFTER' }, steps: [plan([scout('first', 'TASK-FIRST'), scout('second', 'TASK-SECOND', { after: ['first'] })]), { result: 'Proposed.' }],
    resume: [{ wait: '\\(a2\\) has returned' }, finish] },
  { match: { task: 'TASK-FIRST' }, steps: [report(10, 'First started.'), { hang: true }], resume: [{ sleep: 300 }, { result: 'First done.' }] },
  { match: { task: 'TASK-SECOND' }, steps: [{ result: 'Second done.' }] },

  // an application of two repositories, edit mode: one smith commits in both before and after the stop
  { match: { archmage: true, message: 'GOAL-DUO' }, steps: [plan([{ key: 'both', role: 'implementer', title: 'Both', task: 'TASK-DUO' }]), { result: 'Proposed.' }],
    resume: [{ wait: '\\(a1\\) has returned' }, { call: 'merge_party' }, finish] },
  { match: { task: 'TASK-DUO' }, steps: [
    { write: 'api1.txt', repo: 'api', content: 'one\n', commit: 'api one' },
    { write: 'web1.txt', repo: 'web', content: 'one\n', commit: 'web one' },
    report(50, 'Half forged.'), { hang: true }],
    resume: [
      { write: 'api2.txt', repo: 'api', content: 'two\n', commit: 'api two' },
      { write: 'web2.txt', repo: 'web', content: 'two\n', commit: 'web two' },
      { result: 'Forged both, twice.' }] },
];

let h;
before(async () => { h = await startGuild({ scenario: { sessions }, settings: { batchSeconds: 0.1 } }); });
after(() => h?.stop());

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
const ofQuest = (id) => (s) => JSON.stringify(s.mcpServers).includes(id);
const agentStarts = (id, agentId) => h.starts().filter(ofQuest(id)).filter((s) => s.mcpServers.guild?.env.GUILD_AGENT_ID === agentId);
const archStarts = (id) => h.starts().filter(ofQuest(id)).filter((s) => s.mcpServers.council);
/** The messages the Archmage's session that resumed got. */
const resumedArchMessages = (id) => {
  const start = archStarts(id).find((s) => s.args.resume);
  return start ? h.fakeLog({ event: 'message', pid: start.pid }).map((m) => m.text) : [];
};

test('reports and human messages waiting for the Archmage are kept in quest.json and delivered after the resume', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-INBOX', cwd: h.repo() });
  await h.waitAgent(id, 'a1', (a) => a.percent === 30);
  await h.post(`/api/quests/${id}/message`, { text: 'HUMAN-HELLO' });
  await h.waitFor(() => h.live(id).inbox.length === 2, { what: 'the report and the message to wait in the inbox' });

  await h.restart();

  const { pending } = h.questFile(id);
  assert.equal(pending.messages.length, 2);
  assert.match(pending.messages[0], /\[report\] .* \(a1\) 30%: INBOX-REPORT/);
  assert.equal(pending.messages[1], 'Message from the human: HUMAN-HELLO');
  assert.equal(pending.humanWaiting, true);
  assert.deepEqual(h.live(id).inbox, pending.messages, 'the fresh server loaded the inbox');

  await h.post(`/api/quests/${id}/resume`);
  const done = await h.waitQuest(id, 'done');
  assert.equal(done.agents[0].result, 'Inbox job done.');
  const msgs = resumedArchMessages(id);
  assert.match(msgs[0], /the human has now resumed it/);
  const batch = msgs.find((m) => /\[report\] .*INBOX-REPORT/.test(m));
  assert.ok(batch, 'the resumed Archmage got the waiting report');
  assert.match(batch, /Message from the human: HUMAN-HELLO/, 'and the human\'s message, in the same batch');
  assert.equal(done.log.find((e) => e.text === 'Hello, human.')?.to, 'you', 'that turn answered the human');
});

test('the batch of a turn the stop cut off is given to the Archmage again after the resume', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-FLIGHT', cwd: h.repo() });
  await h.waitFor(() => h.fakeLog({ event: 'message' }).some((m) => /FLIGHT-REPORT/.test(m.text)), { what: 'the Archmage to get the report' });
  assert.equal(h.live(id).inbox.length, 0);

  await h.restart();

  const { pending } = h.questFile(id);
  assert.equal(pending.messages.length, 1);
  assert.match(pending.messages[0], /FLIGHT-REPORT/);

  await h.post(`/api/quests/${id}/resume`);
  await h.waitQuest(id, 'done');
  assert.ok(resumedArchMessages(id).some((m) => /FLIGHT-REPORT/.test(m)), 'the resumed Archmage got the report again');
});

test('an agent blocked on a question at the stop is asked again on resume, and woken with the answer', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-ASK', cwd: h.repo() });
  await h.waitAgent(id, 'a1', 'blocked');
  const session = agentStarts(id, 'a1')[0].sessionId;

  await h.restart();

  const saved = h.questFile(id).agents[0];
  assert.equal(saved.status, 'interrupted');
  assert.equal(saved.ask.question, 'ASK-Q: blue or red?', 'the open question is kept in quest.json');
  assert.ok(Date.parse(saved.ask.deadline) > Date.parse(saved.ask.askedAt));

  await h.post(`/api/quests/${id}/resume`);
  const blocked = await h.waitAgent(id, 'a1', (a) => a.status === 'blocked' && a.question === 'ASK-Q: blue or red?');
  assert.equal(blocked.ask.question, 'ASK-Q: blue or red?');
  assert.ok(Date.parse(blocked.ask.deadline) > Date.now(), 'the question has time left');
  // The Archmage hears of it: in its briefing, in the party report there, and as a dispatch.
  await h.waitFor(() => resumedArchMessages(id).some((m) => /\[blocked\] .* \(a1\) asked, before the server stopped, and still waits: ASK-Q/.test(m)), { what: 'the Archmage to be told of the question' });
  const briefing = resumedArchMessages(id)[0];
  assert.match(briefing, /waiting on a question, which is open again .*: .+ \(a1\)\./);
  assert.match(briefing, /open question: ASK-Q: blue or red\?/);
  assert.doesNotMatch(briefing, /interrupted and are resuming/, 'nobody else resumes');
  assert.equal(agentStarts(id, 'a1').length, 1, 'the blocked agent waits for the answer without a session');

  await h.post(`/api/quests/${id}/agents/a1/answer`, { text: 'BLUE' });
  const done = await h.waitQuest(id, 'done');
  const again = agentStarts(id, 'a1');
  assert.equal(again.length, 2);
  assert.equal(again[1].args.resume, session, 'the agent carries on in its own session');
  assert.match(done.agents[0].result, /You were waiting on your question: "ASK-Q: blue or red\?"\nThe reply: \(from the human\) BLUE/);
  assert.equal(done.agents[0].ask, null);
});

test('members waiting for others stay waiting through a resume, and set out once their prerequisite is done', async () => {
  const { id } = await h.createQuest({ goal: 'GOAL-AFTER', cwd: h.repo() });
  await h.waitAgent(id, 'a1', (a) => a.percent === 10);
  assert.equal((await h.quest(id)).agents[1].status, 'waiting');

  await h.restart();

  assert.deepEqual((await h.quest(id)).agents.map((a) => a.status), ['interrupted', 'waiting']);
  await h.post(`/api/quests/${id}/resume`);
  const q = await h.quest(id);
  assert.equal(q.agents[1].status, 'waiting', 'a2 still waits for a1');
  const done = await h.waitQuest(id, 'done');
  assert.deepEqual(done.agents.map((a) => [a.status, a.result]), [['done', 'First done.'], ['done', 'Second done.']]);

  const [first] = agentStarts(id, 'a2');
  assert.equal(agentStarts(id, 'a2').length, 1);
  assert.equal(first.args.resume, undefined, 'a2 never set out, so it starts afresh');
  const log = h.fakeLog();
  const a1Resumed = agentStarts(id, 'a1').find((s) => s.args.resume);
  const a1Done = log.findIndex((e) => e.event === 'result' && e.pid === a1Resumed.pid);
  assert.ok(log.findIndex((e) => e.event === 'start' && e.pid === first.pid) > a1Done, 'a2 started after a1 finished');
  assert.ok(done.log.some((e) => /sets out: .* is done/.test(e.text)));
});

test('an application quest on two repositories: a removed worktree is recreated, and the agent and Archmage carry on', async () => {
  const api = h.repo('duo-api', { 'api.txt': 'api\n' }), web = h.repo('duo-web', { 'web.txt': 'web\n' });
  const app = h.guild.saveApp(null, { name: 'Duo', repos: [{ name: 'api', path: api }, { name: 'web', path: web }] });
  const { id } = await h.createQuest({ goal: 'GOAL-DUO', app: app.id, mode: 'edit', deliver: 'auto' });
  const a1 = await h.waitAgent(id, 'a1', (a) => a.percent === 50);
  const webTree = a1.worktrees.find((w) => w.repo === 'web').dir;
  const archSession = archStarts(id)[0].sessionId;

  await h.restart();

  // The worktrees survive a stop, but one may be removed by hand before the resume; its commit stays on the branch.
  git(web, 'worktree', 'remove', '--force', webTree);
  assert.ok(!fs.existsSync(webTree));

  await h.post(`/api/quests/${id}/resume`);
  const done = await h.waitQuest(id, 'done');
  assert.equal(done.agents[0].status, 'done');
  assert.equal(done.agents[0].result, 'Forged both, twice.');
  assert.deepEqual(done.agents[0].commitsByRepo, { api: 2, web: 2 });
  assert.equal(archStarts(id).at(-1).args.resume, archSession, 'the Archmage was woken from its session');
  const resumed = agentStarts(id, 'a1').at(-1);
  assert.ok(resumed.args.resume, 'the agent was woken from its session');
  assert.equal(resumed.cwd, a1.dir, 'in its own workspace');

  assert.deepEqual(done.delivery.repos.map((r) => [r.name, r.status]), [['api', 'delivered'], ['web', 'delivered']]);
  for (const [repo, name] of [[api, 'api'], [web, 'web']]) {
    const files = git(repo, 'ls-tree', '-r', '--name-only', 'main').split('\n');
    for (const f of [`${name}1.txt`, `${name}2.txt`]) assert.ok(files.includes(f), `${f} reached main in ${name} (${files})`);
  }
  assert.ok(!fs.existsSync(path.join(webTree, 'web2.txt')), 'the worktrees are cleaned up after the quest');
});
