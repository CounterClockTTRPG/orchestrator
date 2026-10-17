import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startGuild } from './helpers/e2e.js';

// Edit quests end to end: a merge conflict the scripted Archmage resolves, an application of two repositories with
// delivery to the target branch, and a plan whose members wait for each other (`after`).

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
// The tests run one after another, so a test's tool calls are the ones logged since it began.
const callsSince = (tool, n) => h.toolCalls(tool).slice(n);
const show = (dir, ref, file) => git(dir, 'show', `${ref}:${file}`);

// ── scenarios ──

const smith = (task, steps) => ({ match: { task }, steps });
const member = (key, task, extra = {}) => ({ key, role: 'implementer', title: `Do ${key}`, task, ...extra });

const conflict = {
  match: { archmage: true, message: 'CONFLICT-GOAL' },
  steps: [
    { call: 'propose_plan', args: { summary: 'Two smiths edit one file.', agents: [member('one', 'CONFLICT-ONE'), member('two', 'CONFLICT-TWO')] } },
    { result: 'Proposed.' },
    { wait: ['\\(a1\\) has returned', '\\(a2\\) has returned'] },
    { call: 'merge_party', as: 'first' },
    // The conflict is in the integration worktree, which is the Archmage's cwd.
    { write: 'story.txt', content: 'start\nboth endings\n', commit: 'Resolve: keep both endings' },
    { call: 'merge_party', as: 'second' },
    { call: 'finish_quest', args: { chronicle: 'Merged after resolving the story.' } },
    { result: 'Done.' },
  ],
};

const apps = {
  match: { archmage: true, message: 'APP-GOAL' },
  steps: [
    { call: 'propose_plan', args: { summary: 'One smith in both repositories.', agents: [member('both', 'APP-TASK')] } },
    { result: 'Proposed.' },
    { wait: '\\(a1\\) has returned' },
    { call: 'merge_party', as: 'merged' },
    { call: 'finish_quest', args: { chronicle: 'Both repositories changed.' } },
    { result: 'Done.' },
  ],
};

const chain = {
  match: { archmage: true, message: 'AFTER-GOAL' },
  steps: [
    { call: 'propose_plan', args: { summary: 'Base first, then the roof.', agents: [member('base', 'AFTER-BASE'), member('roof', 'AFTER-ROOF', { after: ['base'] })] } },
    { result: 'Proposed.' },
    { wait: ['\\(a1\\) has returned', '\\(a2\\) has returned'] },
    { call: 'merge_party', as: 'merged' },
    { call: 'finish_quest', args: { chronicle: 'Built.' } },
    { result: 'Done.' },
  ],
};

const edit = (file, content, message) => [
  { call: 'report_progress', args: { percent: 20, message: `Writing ${file}` } },
  { write: file, content, commit: message },
];

let h, repos;
before(async () => {
  h = await startGuild({
    scenario: {
      sessions: [
        conflict, apps, chain,
        smith('CONFLICT-ONE', [...edit('story.txt', 'start\nending one\n', 'Ending one'), { result: 'Wrote ending one.' }]),
        // The second one waits for the first one's commit to be on its way, so both edit the same line.
        smith('CONFLICT-TWO', [...edit('story.txt', 'start\nending two\n', 'Ending two'), { result: 'Wrote ending two.' }]),
        smith('APP-TASK', [
          { call: 'report_progress', args: { percent: 20, message: 'Writing both repositories' } },
          { write: 'api.txt', repo: 'api', content: 'api work\n', commit: 'Work in api' },
          { write: 'web.txt', repo: 'web', content: 'web work\n', commit: 'Work in web' },
          { result: 'Touched both repositories.' },
        ]),
        smith('AFTER-BASE', [{ sleep: 500 }, ...edit('base.txt', 'walls\n', 'Walls'), { result: 'The walls stand in base.txt.' }]),
        smith('AFTER-ROOF', [
          { run: 'cat base.txt', as: 'seen' },
          { write: 'roof.txt', content: 'roof over ${seen}', commit: 'Roof' },
          { result: 'Roof done.' },
        ]),
      ],
    },
  });
  repos = { conflict: h.repo('conflict', { 'story.txt': 'start\n' }), api: h.repo('api', { 'api.txt': 'old\n' }), web: h.repo('web', { 'web.txt': 'old\n' }), chain: h.repo('chain', { 'README.md': 'house\n' }) };
});
after(() => h?.stop());

test('a merge conflict between two agents: merge_party reports it, the Archmage resolves it and merges again', async () => {
  const seen = h.toolCalls('merge_party').length;
  const q0 = await h.createQuest({ goal: 'CONFLICT-GOAL', cwd: repos.conflict, mode: 'edit' });
  const q = await h.waitQuest(q0.id, 'done');

  const [first, second] = callsSince('merge_party', seen).map((c) => c.text);
  assert.match(first, /merged .* \(1 commits\)/, 'the first agent merges cleanly');
  assert.match(first, /CONFLICT merging .*\(guild\/.*\) in story\.txt/);
  assert.match(first, /git merge --abort, then merge_party with leaveOut/);
  assert.match(second, /Quest branch: guild\//);
  assert.doesNotMatch(second, /CONFLICT/);
  assert.equal(h.toolCalls('finish_quest')[0].isError, false);
  assert.equal(callsSince('merge_party', seen).length, 2, 'merge_party was called twice');

  assert.deepEqual(q.agents.map((a) => [a.status, a.commits]), [['done', 1], ['done', 1]]);
  assert.ok(q.log.some((e) => e.who === 'archmage' && /Merging .* conflicts in story\.txt/.test(e.text)));

  // The quest branch outlives the quest: it holds both agents' commits and the resolution.
  const branch = q.repos[0].branch;
  assert.equal(show(repos.conflict, branch, 'story.txt'), 'start\nboth endings\n');
  const log = git(repos.conflict, 'log', '--format=%s', branch);
  for (const s of ['Ending one', 'Ending two', 'Resolve: keep both endings']) assert.match(log, new RegExp(s));
  assert.equal(git(repos.conflict, 'rev-list', '--merges', '--count', branch).trim(), '2', 'both agents were merged');
});

test('an application of two repositories: the work lands in both and is delivered to each target branch', async () => {
  const seen = h.toolCalls('merge_party').length;
  const app = h.guild.saveApp(null, { name: 'Duo', repos: [{ name: 'api', path: repos.api }, { name: 'web', path: repos.web }] });
  const q0 = await h.createQuest({ goal: 'APP-GOAL', app: app.id, mode: 'edit', deliver: 'auto' });
  const q = await h.waitQuest(q0.id, 'done');

  assert.deepEqual(q.repos.map((r) => r.name), ['api', 'web']);
  assert.equal(q.agents[0].commits, 2);
  assert.deepEqual(q.agents[0].commitsByRepo, { api: 1, web: 1 });
  const merged = callsSince('merge_party', seen)[0].text;
  assert.match(merged, /merged .* into api \(1 commits\)/);
  assert.match(merged, /merged .* into web \(1 commits\)/);

  // Delivered: main in each repository moved to the quest's result, files and all.
  assert.equal(q.delivery.status, 'delivered');
  assert.deepEqual(q.delivery.repos.map((r) => [r.name, r.target, r.status]), [['api', 'main', 'delivered'], ['web', 'main', 'delivered']]);
  assert.equal(git(repos.api, 'rev-parse', 'main').trim(), q.delivery.repos[0].commit);
  assert.equal(git(repos.web, 'rev-parse', 'main').trim(), q.delivery.repos[1].commit);
  assert.equal(fs.readFileSync(path.join(repos.api, 'api.txt'), 'utf8'), 'api work\n');
  assert.equal(fs.readFileSync(path.join(repos.web, 'web.txt'), 'utf8'), 'web work\n');
  assert.equal(git(repos.api, 'status', '--porcelain'), '');
});

test('after: the dependent waits, starts once its prerequisite is done with its report, and builds on its branch', async () => {
  const q0 = await h.createQuest({ goal: 'AFTER-GOAL', cwd: repos.chain, mode: 'edit' });
  const id = q0.id;
  const waiting = await h.waitAgent(id, 'a2', 'waiting');
  assert.match(waiting.activity, /^Waiting for /);
  assert.equal(h.starts().filter((s) => s.mcpServers.guild?.env.GUILD_QUEST_ID === id && s.mcpServers.guild.env.GUILD_AGENT_ID === 'a2').length, 0, 'the dependent has not been started');
  await h.waitAgent(id, 'a1', (a) => ['working', 'done'].includes(a.status)); // its worktree may still be in the making

  const q = await h.waitQuest(id, 'done');
  assert.deepEqual(q.agents.map((a) => a.status), ['done', 'done']);
  assert.ok(q.log.some((e) => e.who === 'guild' && /sets out: .* is done/.test(e.text)), 'Guild logs the release');
  assert.ok(q.agents[0].finishedAt <= q.agents[1].startedAt, 'a2 started only after a1 finished');

  // Its first message carries the prerequisite's final report, and its worktree already has the prerequisite's file.
  const start = h.fakeLog({ event: 'message' }).find((m) => /AFTER-ROOF/.test(m.text));
  assert.match(start.text, /Your task builds on work by others/);
  assert.match(start.text, /The walls stand in base\.txt\./);
  assert.match(start.text, /Their branch guild\/.* is merged into yours/);
  const branch = q.repos[0].branch;
  assert.equal(show(repos.chain, q.agents[1].branch, 'base.txt'), 'walls\n');
  assert.equal(show(repos.chain, branch, 'roof.txt'), 'roof over walls', 'the roof was built on the walls');
  assert.equal(q.agents[1].commits, 1, "only a2's own commit counts");
});
