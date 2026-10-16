import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Task dependencies: plans as graphs, waiting agents, handoffs, held agents and the critical-path queue.

let Guild, Quest, store, checkPlan, chainLengths;
before(async () => {
  process.env.GUILD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  ({ Guild, Quest } = await import('../lib/guild.js'));
  store = await import('../lib/store.js');
  ({ checkPlan, chainLengths } = await import('../lib/plan.js'));
});

const flush = () => new Promise((r) => setImmediate(r));

test('a plan gets keys, and bad graphs are refused with a reason', () => {
  const m = checkPlan([{ role: 'r', task: 'a' }, { role: 'r', task: 'b', after: ['t1', 't1'] }]);
  assert.deepEqual(m.map((x) => [x.key, x.after]), [['t1', []], ['t2', ['t1']]]);
  assert.throws(() => checkPlan([{ key: 'x', role: 'r', task: 'a' }, { key: 'x', role: 'r', task: 'b' }]), /share the key "x"/);
  assert.throws(() => checkPlan([{ key: 'x', role: 'r', task: 'a', after: ['y'] }]), /"y", which is not in the plan/);
  assert.throws(() => checkPlan([{ key: 'x', role: 'r', task: 'a', after: ['x'] }]), /cannot wait for itself/);
  assert.throws(() => checkPlan([
    { key: 'a', role: 'r', task: '1', after: ['c'] }, { key: 'b', role: 'r', task: '2', after: ['a'] }, { key: 'c', role: 'r', task: '3', after: ['b'] },
  ]), /cycle: a → c → b → a/);
});

test('chain lengths count the longest line of work behind each agent', () => {
  const n = chainLengths([{ id: 'a1' }, { id: 'a2', after: ['a1'] }, { id: 'a3', after: ['a2'] }, { id: 'a4' }]);
  assert.deepEqual([...n], [['a1', 3], ['a2', 2], ['a3', 1], ['a4', 1]]);
});

test('the queue starts the longest chain first, then in arrival order', () => {
  const g = new Guild({ port: 0 });
  g.settings.maxConcurrent = 1;
  const order = [];
  g.acquire(() => order.push('running'), 1);
  g.acquire(() => order.push('short'), 1);
  g.acquire(() => order.push('long'), 3);
  g.acquire(() => order.push('short2'), 1);
  g.release(); g.release(); g.release();
  assert.deepEqual(order, ['running', 'long', 'short', 'short2']);
});

function quest(id) {
  fs.mkdirSync(store.questDir(id), { recursive: true });
  const guild = new Guild({ port: 0 });
  const q = new Quest(guild, {
    id, goal: 'g', status: 'planning', planning: 'auto', mode: 'read', theme: 'fantasy', maxAgents: 6,
    agents: [], log: [], roles: {}, merged: [], archmage: { name: 'Velothar', status: 'thinking' },
  });
  const started = [];
  q.schedule = (a) => { started.push(a.id); a.status = 'queued'; };
  return { q, started };
}

test('members with after wait, and start with the reports once their prerequisites are done', async () => {
  const { q, started } = quest('d1');
  q.proposePlan({
    summary: 's',
    agents: [
      { key: 'audit', role: 'auditor', task: 'Audit' },
      { key: 'fix', role: 'implementer', task: 'Fix', after: ['audit'] },
      { key: 'docs', role: 'scribe', task: 'Docs' },
      { key: 'tests', role: 'tester', task: 'Test', after: ['fix', 'audit'] },
    ],
  });
  const [audit, fix, docs, tests] = q.s.agents;
  assert.deepEqual(started, ['a1', 'a3']);
  assert.deepEqual([fix.status, tests.status], ['waiting', 'waiting']);
  assert.deepEqual(tests.after, ['a2', 'a1']);
  assert.match(q.partyReport(), /after: a2 \(waiting\), a1 \(queued\)/);

  q.updateAgent(audit, { status: 'done', result: 'Found two bugs in auth.js:12.' });
  await flush();
  assert.deepEqual(started, ['a1', 'a3', 'a2'], 'fix sets out; tests still waits for fix');
  assert.equal(tests.status, 'waiting');
  assert.match(q.handoff(fix), /Found two bugs in auth\.js:12\./);
  assert.match(q.handoff(fix), new RegExp(`${audit.name} the .*\\(a1\\), done`));
  assert.ok(q.inbox.some((m) => m.startsWith('[started]')), 'the Archmage hears who set out');

  q.updateAgent(fix, { status: 'done', result: 'Fixed.' });
  await flush();
  assert.deepEqual(started, ['a1', 'a3', 'a2', 'a4']);
  assert.equal(docs.after.length, 0);
});

test('a failed prerequisite holds its dependents until the Archmage decides', async () => {
  const { q, started } = quest('d2');
  q.proposePlan({ summary: 's', agents: [{ key: 'a', role: 'auditor', task: 'A' }, { key: 'b', role: 'tester', task: 'B', after: ['a'] }] });
  const [a, b] = q.s.agents;
  q.inbox = [];
  q.updateAgent(a, { status: 'failed', result: 'Crashed.' });
  await flush();
  assert.equal(b.status, 'waiting');
  assert.equal(b.held, true);
  assert.equal(q.urgent, true);
  assert.match(q.inbox.join('\n'), /\[held\].*start_agent/);
  // Nobody works now: after its turn, the Archmage is reminded, and in the end the held agent is recalled.
  for (let i = 0; i < 3; i++) { q.inbox = []; q.afterArchmageTurn(); assert.match(q.inbox.join('\n'), /still wait for work that will not come/); }
  q.inbox = [];
  q.afterArchmageTurn();
  assert.equal(b.status, 'cancelled');

  const { q: q2, started: s2 } = quest('d3');
  q2.proposePlan({ summary: 's', agents: [{ key: 'a', role: 'auditor', task: 'A' }, { key: 'b', role: 'tester', task: 'B', after: ['a'] }] });
  q2.updateAgent(q2.s.agents[0], { status: 'failed' });
  await flush();
  assert.match(q2.council('start_agent', { agentId: 'a2' }), /sets out now/);
  assert.deepEqual(s2, ['a1', 'a2']);
  assert.ok(started.length);
});

test('a recruit can wait for agents already in the party; the human can start a waiting agent', async () => {
  const { q, started } = quest('d4');
  q.proposePlan({ summary: 's', agents: [{ role: 'auditor', task: 'A' }] });
  const msg = q.council('recruit_agent', { role: 'tester', task: 'Follow up', after: ['a1'] });
  assert.match(msg, /waits for a1/);
  assert.equal(q.s.agents[1].status, 'waiting');
  assert.match(q.messageAgent('a2', 'Focus on login', 'archmage'), /when it sets out/);
  assert.match(q.startNow('a2', 'you'), /sets out now/);
  assert.deepEqual(started, ['a1', 'a2']);
  assert.throws(() => q.startNow('a2', 'you'), /not waiting/);
});

test('editing a reviewed plan keeps the graph and drops links to removed members', () => {
  const { q } = quest('d5');
  q.s.planning = 'review';
  q.proposePlan({ summary: 's', agents: [{ key: 'a', role: 'auditor', task: 'A' }, { key: 'b', role: 'tester', task: 'B', after: ['a'] }] });
  q.tell = () => {};
  q.approvePlan([{ key: 'b', role: 'tester', task: 'B', after: ['a'] }]);
  assert.deepEqual(q.s.plan.agents, [{ key: 'b', role: 'tester', task: 'B', after: [] }]);
  assert.equal(q.s.agents[0].status, 'queued');
});

test('the Archmage is offered start_agent and told about after', () => {
  const { q } = quest('d6');
  const prompt = q.archmageSystemPrompt();
  assert.match(prompt, /The plan is a graph/);
  assert.match(prompt, /start_agent/);
});
