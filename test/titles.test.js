import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanTitle, titleFromTask, memberTitle, agentTitle, sameAsTitle } from '../web/titles.js';
import { motionFor, WORK_EMOTE } from '../web/motion.js';
import { registerEmote, generate, render } from '../vendor/portraitgen/index.js';

// Task titles name what each agent works on; portrait motion follows the agent's state.

let Guild, Quest, store;
before(async () => {
  process.env.GUILD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  ({ Guild, Quest } = await import('../lib/guild.js'));
  store = await import('../lib/store.js');
});

test('titles are short, single-line and free of markdown', () => {
  assert.equal(cleanTitle('  **Fix**   session\nexpiry '), 'Fix session expiry');
  const long = cleanTitle('Audit every endpoint of the payments service for missing authorisation checks');
  assert.ok(long.length <= 48, long);
  assert.match(long, /…$/);
  assert.equal(titleFromTask('## Goal\nFind the memory leak in the parser. Then report.'), 'Find the memory leak in the parser');
  assert.equal(titleFromTask('Audit lib/auth: look for injection'), 'Audit lib/auth');
  assert.equal(sameAsTitle('Fix the bugs the audit found.', 'Fix the bugs the audit found'), true);
  assert.equal(sameAsTitle('Audit lib/auth for injection.', 'Audit auth module'), false);
});

test('a member without a title gets one from its task; an agent never shows its role as one', () => {
  assert.equal(memberTitle({ title: 'Write tests', task: 'x' }), 'Write tests');
  assert.equal(memberTitle({ title: ' ', task: 'Document the API.' }), 'Document the API');
  assert.equal(agentTitle({ title: 'Smith', task: 'Fix the login bug.' }), 'Fix the login bug');
});

test('plan titles reach the agents, the party report and the quest summary', async () => {
  fs.mkdirSync(store.questDir('t1'), { recursive: true });
  const q = new Quest(new Guild({ port: 0 }), {
    id: 't1', goal: 'g', status: 'planning', planning: 'auto', mode: 'read', theme: 'fantasy', maxAgents: 6,
    agents: [], log: [], roles: {}, merged: [], archmage: { name: 'Velothar', status: 'thinking' },
  });
  q.schedule = (a) => { a.status = 'queued'; };
  q.proposePlan({ summary: 's', agents: [{ role: 'auditor', title: 'Audit auth', task: 'Audit lib/auth.' }, { role: 'scribe', task: 'Write the docs.' }] });
  assert.deepEqual(q.s.plan.agents.map((m) => m.title), ['Audit auth', 'Write the docs']);
  assert.deepEqual(q.s.agents.map((a) => a.taskTitle), ['Audit auth', 'Write the docs']);
  assert.match(await q.partyReport(), /“Audit auth”/);
  q.council('recruit_agent', { role: 'tester', title: 'Test the fix', task: 'Test it.' });
  assert.equal(q.s.agents[2].taskTitle, 'Test the fix');
  assert.deepEqual(q.summary().party.map((a) => a.taskTitle), ['Audit auth', 'Write the docs', 'Test the fix']);
  assert.match(q.archmageSystemPrompt(), /Give each member a title/);
});

test('portraits move with the state', () => {
  assert.deepEqual(motionFor('agent', 'working'), ['blink', 'breathe', 'work']);
  assert.deepEqual(motionFor('agent', 'waiting'), ['sleep']);
  assert.deepEqual(motionFor('agent', 'working', 'Two bugs found'), ['blink', 'talk']);
  assert.deepEqual(motionFor('leader', 'thinking'), ['blink', 'breathe', 'thinking']);
  assert.deepEqual(motionFor('leader', 'idle'), ['sleep']);
  assert.deepEqual(motionFor('agent', 'failed'), ['blink']);
  registerEmote('work', WORK_EMOTE); // valid for portraitgen
  const svg = render(generate({ seed: 'Hilda', style: 'illustrated' }), { emotes: motionFor('agent', 'working'), idPrefix: 'w' });
  assert.match(svg, /@keyframes/);
});
