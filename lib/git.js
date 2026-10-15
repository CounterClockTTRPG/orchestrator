// Git helpers for edit-mode quests: one worktree per agent, one integration worktree for the Archmage.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

export async function git(cwd, ...args) {
  const { stdout } = await exec('git', ['-C', cwd, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** Returns { root, head } for a git work tree, or null if `dir` is not inside one. */
export async function repoInfo(dir) {
  try {
    const root = await git(dir, 'rev-parse', '--show-toplevel');
    const head = await git(dir, 'rev-parse', 'HEAD');
    const dirty = (await git(dir, 'status', '--porcelain')).length > 0;
    return { root, head, dirty };
  } catch {
    return null;
  }
}

export async function addWorktree(repo, dir, branch, base) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', branch, dir, base);
}

export async function removeWorktree(repo, dir) {
  try { await git(repo, 'worktree', 'remove', '--force', dir); } catch { /* already gone */ }
}

/** Commit anything the agent left uncommitted. Returns true if a commit was made. */
export async function commitLeftovers(dir, message) {
  if (!(await git(dir, 'status', '--porcelain'))) return false;
  await git(dir, 'add', '-A');
  await git(dir, '-c', 'user.name=Guild', '-c', 'user.email=guild@localhost', 'commit', '-q', '-m', message);
  return true;
}

export async function commitCount(repo, base, branch) {
  try { return Number(await git(repo, 'rev-list', '--count', `${base}..${branch}`)); } catch { return 0; }
}

/** Merge `branch` into the worktree at `dir`. Returns { ok } or { ok: false, conflicts: [files] }. */
export async function merge(dir, branch, message) {
  try {
    await git(dir, '-c', 'user.name=Guild', '-c', 'user.email=guild@localhost',
      'merge', '--no-ff', '-m', message, branch);
    return { ok: true };
  } catch (err) {
    const conflicts = (await git(dir, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
    const error = String(err.stderr || err.message).trim().split('\n').slice(-3).join(' ');
    // A failure that left no conflicted files (dirty tree, bad ref…) is not a merge to resolve.
    if (!conflicts.length && (await mergeInProgress(dir))) await git(dir, 'merge', '--abort').catch(() => {});
    return { ok: false, conflicts, error };
  }
}

export async function mergeInProgress(dir) {
  try { await git(dir, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'); return true; } catch { return false; }
}

export async function diff(repo, base, branch, maxBytes = 400_000) {
  const stat = await git(repo, 'diff', '--stat', `${base}..${branch}`);
  let patch = await git(repo, 'diff', `${base}..${branch}`);
  const truncated = patch.length > maxBytes;
  if (truncated) patch = patch.slice(0, maxBytes);
  return { stat, patch, truncated };
}
