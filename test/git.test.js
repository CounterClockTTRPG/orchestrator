import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as G from '../lib/git.js';

async function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guild-git-'));
  await G.git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  await G.git(dir, 'add', '-A');
  await G.git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  return { dir, base: await G.git(dir, 'rev-parse', 'HEAD') };
}

async function branchWith(dir, base, name, text) {
  const wt = path.join(dir, '..', `${path.basename(dir)}-${name}`);
  await G.addWorktree(dir, wt, name, base);
  fs.appendFileSync(path.join(wt, 'README.md'), text);
  assert.equal(await G.commitLeftovers(wt, `${name} work`), true);
  assert.equal(await G.commitLeftovers(wt, 'nothing'), false);
  await G.removeWorktree(dir, wt);
}

test('merge reports conflicted files, and a clean merge succeeds', async () => {
  const { dir, base } = await repo();
  await branchWith(dir, base, 'one', 'one\n');
  await branchWith(dir, base, 'two', 'two\n');
  assert.equal(await G.commitCount(dir, base, 'one'), 1);
  assert.deepEqual(await G.merge(dir, 'one', 'merge one'), { ok: true });
  const r = await G.merge(dir, 'two', 'merge two');
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, ['README.md']);
  assert.equal(await G.mergeInProgress(dir), true);
});

test('a failed merge without conflicts is reported as an error, not a conflict', async () => {
  const { dir } = await repo();
  const r = await G.merge(dir, 'no-such-branch', 'merge');
  assert.equal(r.ok, false);
  assert.deepEqual(r.conflicts, []);
  assert.ok(r.error);
  assert.equal(await G.mergeInProgress(dir), false);
});

test('repoInfo tells git work trees from plain directories', async () => {
  const { dir, base } = await repo();
  const info = await G.repoInfo(dir);
  assert.equal(info.head, base);
  assert.equal(info.dirty, false);
  assert.equal(await G.repoInfo(fs.mkdtempSync(path.join(os.tmpdir(), 'guild-plain-'))), null);
});
