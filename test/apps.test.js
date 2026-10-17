import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as G from '../lib/git.js';
import { normalizeApp, appForDir, focusDir, appBriefing, findApp, repoNotes, standingContext } from '../lib/apps.js';

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
  for (const name of ['.', '..']) assert.throws(() => normalizeApp({ name: 'x', repos: [{ name, path: a }] }), /can't name/);
  assert.equal(normalizeApp({ name: 'x', repos: [{ name: 'a/b', path: a }] }).repos[0].name, 'a-b');
  assert.throws(() => normalizeApp({ name: 'x', repos: ['/'] }), /too broad/);
  assert.throws(() => normalizeApp({ name: 'x', repos: [os.homedir()] }), /too broad/);
  assert.equal(findApp({ one: app }, '__proto__'), null);
  assert.equal(findApp({ one: app }, 'constructor'), null);
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

test('the briefing carries the directories and earlier chronicles, and says when their work is not merged', () => {
  const app = normalizeApp({ name: 'Platform', description: 'Campaigns and maps', repos: [tmp('a')] });
  const text = appBriefing(app, [
    { id: 'q1', goal: 'Build phase 8', status: 'done', mode: 'edit', createdAt: '2026-10-17T10:00:00Z', chronicleFile: '/x/q1.md', repos: [{ name: 'game', branch: 'guild/q1/party', merged: false }] },
    { id: 'q0', goal: 'Analyse both', status: 'done', mode: 'read', createdAt: '2026-10-17T09:00:00Z', chronicleFile: '/x/q0.md', repos: [] },
  ]);
  assert.match(text, /Application: Platform — Campaigns and maps/);
  assert.match(text, /q1 \(done, edit, branch guild\/q1\/party NOT merged into game: its chronicle describes work that is not in the code there\)/);
  assert.match(text, /2026-10-17 q0 \(done, read-only\): Analyse both\n {2}chronicle: \/x\/q0\.md/);
  assert.match(appBriefing(app, [], { edit: true }), /worktrees of them, never on these checkouts/);
});

test('standing context: the application\'s own, plus a GUILD.md at the top of each directory', () => {
  const a = tmp('a'), b = tmp('b');
  fs.writeFileSync(path.join(b, 'GUILD.md'), 'Run `npm test` before you report.\n');
  const app = normalizeApp({ name: 'Platform', repos: [a, b], context: 'ttrpg2 calls dungml over HTTP.' });
  const notes = repoNotes(app.repos);
  assert.deepEqual(notes.map((n) => n.name), [path.basename(b)]);
  const text = standingContext(app, notes);
  assert.match(text, /Standing context for the application Platform \(from the human\):\nttrpg2 calls dungml over HTTP\./);
  assert.match(text, /Notes for .*GUILD\.md\):\nRun `npm test` before you report\./);
  assert.equal(standingContext(null, []), '');
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
    // Deleting the application keeps its quests, ungrouped; a new one can adopt them by directory.
    guild.deleteApp(app.id);
    assert.equal(q.s.app, null);
    const loose = await guild.createQuest({ goal: 'g', cwd: b });
    guild.saveApp(null, { name: 'Again', repos: [b], adopt: true });
    assert.deepEqual([q.s.app, explicit.s.app, loose.s.app], [null, 'again', 'again']);
    // The Archmage and the agents get the application's context.
    explicit.s.archmage = { name: 'Morgan', workdir: b };
    guild.saveApp('again', { context: 'Keep the public API stable.' });
    assert.match(await explicit.archmageBriefing(), /Keep the public API stable\./);
    assert.match(explicit.agentSystemPrompt({ name: 'Ines' }, { title: 'Scout', tools: 'read' }), /Keep the public API stable\./);
  } finally {
    Quest.prototype.begin = begin;
  }
});

test('a quest from before applications reads as one directory and one repository', () => {
  const q = new Quest({ settings: {}, emit() {} }, {
    id: 'old', goal: 'g', cwd: '/r/sub', mode: 'edit', agents: [{ id: 'a1', worktree: '/w/a1' }],
    repo: { root: '/r', base: 'abc', branch: 'guild/old/party', integrationDir: '/w/_archmage' },
  });
  assert.deepEqual(q.s.dirs, [{ name: 'sub', path: '/r/sub' }]);
  assert.equal(q.s.repos[0].name, 'r');
  assert.equal(q.multi, false);
  assert.deepEqual(q.worktreesOf(q.s.agents[0]).map((w) => [w.repo, w.dir, w.root]), [['r', '/w/a1', '/r']]);
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
    id, goal: 'g', cwd: front, mode: 'edit', status: 'questing', log: [], agents: [],
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
  assert.deepEqual(await q.unmerged(a1), []);
  await assert.rejects(q.mergeParty(), /in progress in back\//);
  fs.writeFileSync(path.join(repos[1].integrationDir, 'README.md'), 'back\none\ntwo\n');
  await G.git(repos[1].integrationDir, 'add', '-A');
  await G.git(repos[1].integrationDir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'resolve');
  assert.match(await q.mergeParty(), /Nothing new to merge/);
  assert.deepEqual(await q.unmerged(a2), []);

  // Woken again after its merge, a1 commits more: git sees it, and finishing waits for it.
  fs.appendFileSync(path.join(a1.dir, 'front', 'README.md'), 'again\n');
  await q.tallyCommits(a1);
  assert.deepEqual((await q.unmerged(a1)).map((w) => [w.repo, w.commits]), [['front', 1]]);
  await assert.rejects(q.finish('done'), /Unmerged work from a1/);
  assert.match(await q.mergeParty(), /merged a1 into front \(1 commits\)/);

  // Work the Archmage chooses to drop is left out explicitly, not lost silently.
  fs.appendFileSync(path.join(a2.dir, 'back', 'README.md'), 'late\n');
  await q.tallyCommits(a2);
  await assert.rejects(q.finish('done'), /Unmerged work from a2/);
  await q.mergeParty({ leaveOut: ['a2'] });
  assert.match(await q.partyReport(), /a2: .*\n[^]*not merged yet, left out/);

  await q.cleanupWorktrees(true);
  assert.deepEqual(q.s.diffs.map((d) => d.repo), ['front', 'back']);
  assert.match(q.s.diffs[0].stat, /README\.md/);
  assert.equal(fs.existsSync(a1.dir), false);
  assert.match(await G.git(back, 'show', `guild/${id}/party:README.md`), /one\ntwo/);
});
