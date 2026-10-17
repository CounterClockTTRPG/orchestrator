import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as G from '../lib/git.js';
import { normalizeApp, appForDir, focusDir, appBriefing } from '../lib/apps.js';

// Applications: a named group of directories above quests. Quests on one get all its directories,
// its defaults and a briefing with its context and earlier chronicles; edit mode gives every agent a
// worktree per repository and merges them repository by repository.

let Guild, Quest;
before(async () => {
  process.env.GUILD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-test-'));
  ({ Guild, Quest } = await import('../lib/guild.js'));
});

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `guild-${name}-`));

async function repo(name) {
  const dir = path.join(tmp('app'), name);
  fs.mkdirSync(dir);
  await G.git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), `${name}\n`);
  await G.git(dir, 'add', '-A');
  await G.git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return dir;
}

test('an application needs distinct, existing, non-nested directories; updates keep id and creation date', () => {
  const a = tmp('a'), b = tmp('b');
  const app = normalizeApp({ name: 'TTRPG platform', repos: [a, { name: 'maps', path: b }], defaults: { mode: 'edit', planning: 'bogus', maxAgents: '40' } });
  assert.equal(app.id, 'ttrpg-platform');
  assert.deepEqual(app.repos.map((r) => r.name), [path.basename(a), 'maps']);
  assert.deepEqual(app.defaults, { mode: 'edit', maxAgents: 20 });
  assert.throws(() => normalizeApp({ name: 'x', repos: [] }), /at least one directory/);
  assert.throws(() => normalizeApp({ name: 'x', repos: [path.join(a, 'missing')] }), /Not a directory/);
  assert.throws(() => normalizeApp({ name: 'x', repos: [{ name: 'same', path: a }, { name: 'same', path: b }] }), /distinct names/);
  fs.mkdirSync(path.join(a, 'sub'));
  assert.throws(() => normalizeApp({ name: 'x', repos: [a, path.join(a, 'sub')] }), /inside another directory/);
  const upd = normalizeApp({ name: 'Renamed', context: 'Never break /maps.' }, app);
  assert.equal(upd.id, 'ttrpg-platform');
  assert.equal(upd.createdAt, app.createdAt);
  assert.equal(upd.context, 'Never break /maps.');
  assert.equal(upd.repos.length, 2);
});

test('a directory belongs to the one application that contains it; quests start inside it', () => {
  const a = tmp('a'), b = tmp('b');
  fs.mkdirSync(path.join(a, 'lib'));
  const app = normalizeApp({ name: 'one', repos: [a, b] });
  const apps = { one: app, two: normalizeApp({ name: 'two', repos: [tmp('c')] }) };
  assert.equal(appForDir(apps, path.join(a, 'lib')).id, 'one');
  assert.equal(appForDir(apps, os.tmpdir()), null);
  assert.equal(focusDir(app), a);
  assert.equal(focusDir(app, path.join(a, 'lib')), path.join(a, 'lib'));
  assert.throws(() => focusDir(app, os.tmpdir()), /not part of the application/);
});

test('the briefing carries the directories, the standing context and earlier chronicles', () => {
  const app = normalizeApp({ name: 'Platform', description: 'Campaigns and maps', repos: [tmp('a')], context: 'ttrpg2 calls dungml over HTTP.' });
  const text = appBriefing(app, [{ id: 'q0', goal: 'Analyse both', status: 'done', createdAt: '2026-10-17T09:00:00Z', chronicleFile: '/x/chronicle.md' }]);
  assert.match(text, /Application: Platform — Campaigns and maps/);
  assert.match(text, /ttrpg2 calls dungml over HTTP\./);
  assert.match(text, /2026-10-17 q0 \(done\): Analyse both\n {2}chronicle: \/x\/chronicle\.md/);
});

test('a quest on an application gets all its directories and its defaults', async () => {
  const guild = new Guild({ port: 0 });
  const begin = Quest.prototype.begin;
  Quest.prototype.begin = async function () { fs.mkdirSync(this.dir, { recursive: true }); }; // no Archmage process in tests
  try {
    const a = tmp('a'), b = tmp('b');
    const app = guild.saveApp(null, { name: 'Pair', repos: [a, b], defaults: { planning: 'auto', maxAgents: 3 } });
    const q = await guild.createQuest({ goal: 'g', app: app.id });
    assert.equal(q.s.app, 'pair');
    assert.equal(q.s.cwd, a);
    assert.deepEqual(q.s.dirs.map((d) => d.path), [a, b]);
    assert.deepEqual([q.s.mode, q.s.planning, q.s.maxAgents], ['read', 'auto', 3]);
    assert.deepEqual(q.extraDirs(a), [b]);
    const explicit = await guild.createQuest({ goal: 'g', app: app.id, cwd: b, planning: 'review', maxAgents: 5 });
    assert.deepEqual([explicit.s.cwd, explicit.s.planning, explicit.s.maxAgents], [b, 'review', 5]);
    await assert.rejects(guild.createQuest({ goal: 'g', app: 'nope' }), /No application/);
    await assert.rejects(guild.createQuest({ goal: 'g', app: app.id, mode: 'edit' }), /not in one/);
    // Deleting the application keeps its quests, ungrouped.
    guild.deleteApp(app.id);
    assert.equal(q.s.app, null);
  } finally {
    Quest.prototype.begin = begin;
  }
});

test('a quest from before applications reads as one directory and one repository', () => {
  const q = new Quest({ settings: {}, emit() {} }, {
    id: 'old', goal: 'g', cwd: '/r/sub', mode: 'edit', merged: ['a1'], agents: [{ id: 'a1', worktree: '/w/a1' }],
    repo: { root: '/r', base: 'abc', branch: 'guild/old/party', integrationDir: '/w/_archmage' },
  });
  assert.deepEqual(q.s.dirs, [{ name: 'sub', path: '/r/sub' }]);
  assert.equal(q.s.repos[0].name, 'r');
  assert.equal(q.multi, false);
  assert.deepEqual(q.worktreesOf(q.s.agents[0]).map((w) => [w.repo, w.dir, w.root]), [['r', '/w/a1', '/r']]);
  assert.equal(q.isMerged(q.s.agents[0]), true);
});

test('edit mode on two repositories: a worktree per repository, merged one repository at a time', async () => {
  const front = await repo('front'), back = await repo('back');
  const id = 'multi1';
  const ws = tmp('ws');
  const repos = [];
  for (const [name, root] of [['front', front], ['back', back]]) {
    const base = await G.git(root, 'rev-parse', 'HEAD');
    const r = { name, root, base, branch: `guild/${id}/party`, integrationDir: path.join(ws, '_archmage', name) };
    await G.addWorktree(root, r.integrationDir, r.branch, base);
    repos.push(r);
  }
  fs.mkdirSync(path.join(process.env.GUILD_HOME, 'quests', id), { recursive: true });
  const q = new Quest({ settings: {}, emit() {} }, {
    id, goal: 'g', cwd: front, mode: 'edit', status: 'questing', log: [], merged: [], agents: [],
    dirs: [{ name: 'front', path: front }, { name: 'back', path: back }], repos,
  });
  assert.equal(q.multi, true);
  const agent = async (aid, files) => {
    const a = { id: aid, name: aid, title: 'Smith', status: 'done' };
    await q.prepareWorkspace(a);
    assert.deepEqual(fs.readdirSync(a.dir).sort(), ['back', 'front']);
    for (const [repoName, text] of Object.entries(files)) fs.appendFileSync(path.join(a.dir, repoName, 'README.md'), text);
    await q.tallyCommits(a);
    q.s.agents.push(a);
    return a;
  };
  const a1 = await agent('a1', { front: 'one\n', back: 'one\n' });
  assert.deepEqual(a1.commitsByRepo, { front: 1, back: 1 });
  const a2 = await agent('a2', { back: 'two\n' }); // conflicts with a1 in back only
  assert.deepEqual(a2.commitsByRepo, { front: 0, back: 1 });

  const out = await q.mergeParty();
  assert.match(out, /CONFLICT merging a2 \(guild\/multi1\/a2-a2\) into back in README\.md/);
  assert.equal(q.isMerged(a1), true);
  await assert.rejects(q.mergeParty(), /in progress in back\//);
  fs.writeFileSync(path.join(repos[1].integrationDir, 'README.md'), 'back\none\ntwo\n');
  await G.git(repos[1].integrationDir, 'add', '-A');
  await G.git(repos[1].integrationDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'resolve');
  assert.match(await q.mergeParty(), /Nothing new to merge/);
  assert.equal(q.isMerged(a2), true);

  await q.cleanupWorktrees(true);
  assert.deepEqual(q.s.diffs.map((d) => d.repo), ['front', 'back']);
  assert.match(q.s.diffs[0].stat, /README\.md/);
  assert.equal(fs.existsSync(a1.dir), false);
  assert.match(await G.git(back, 'show', `guild/${id}/party:README.md`), /one\ntwo/);
});
