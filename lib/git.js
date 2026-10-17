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

/** Returns { root, head, dirty, branch } for a git work tree (branch: null when detached), or null if `dir` is not inside one. */
export async function repoInfo(dir) {
  try {
    const root = await git(dir, 'rev-parse', '--show-toplevel');
    const head = await git(dir, 'rev-parse', 'HEAD');
    const dirty = (await git(dir, 'status', '--porcelain')).length > 0;
    const branch = await git(dir, 'symbolic-ref', '-q', '--short', 'HEAD').catch(() => null);
    return { root, head, dirty, branch: branch || null };
  } catch {
    return null;
  }
}

/** The commit a ref names, or null if it names none. */
export async function resolve(repo, ref) {
  try { return await git(repo, 'rev-parse', '-q', '--verify', `${ref}^{commit}`); } catch { return null; }
}

/** True when `ancestor` is already contained in `ref`. */
export async function contains(repo, ref, ancestor) {
  try { await git(repo, 'merge-base', '--is-ancestor', ancestor, ref); return true; } catch { return false; }
}

/** The worktree that has `branch` checked out, or null. */
export async function checkedOutAt(repo, branch) {
  const list = await git(repo, 'worktree', 'list', '--porcelain');
  let dir = null;
  for (const line of list.split('\n')) {
    if (line.startsWith('worktree ')) dir = line.slice(9);
    else if (line === `branch refs/heads/${branch}`) return dir;
  }
  return null;
}

/**
 * Fast-forward `target` to `to`. Refuses when that is not a fast-forward. If `target` is checked out somewhere, the
 * fast-forward runs there (its files follow) and refuses over uncommitted changes; otherwise only the ref moves.
 */
export async function fastForward(repo, target, to) {
  const from = await resolve(repo, `refs/heads/${target}`);
  if (!from) throw new Error(`There is no branch ${target}.`);
  const tip = await resolve(repo, to);
  if (from === tip) return { from, to: tip, already: true };
  if (!(await contains(repo, tip, from))) throw new Error(`${target} has moved on since the quest last merged it, so this is not a fast-forward. Merge ${to} into ${target} yourself.`);
  const dir = await checkedOutAt(repo, target);
  if (dir) {
    if ((await git(dir, 'status', '--porcelain', '--untracked-files=no')).length) throw new Error(`${target} is checked out at ${dir} with uncommitted changes; commit or stash them first.`);
    await git(dir, 'merge', '--ff-only', '-q', tip);
  } else {
    await git(repo, 'update-ref', `refs/heads/${target}`, tip, from);
  }
  return { from, to: tip, dir };
}

export async function addWorktree(repo, dir, branch, base) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', '-b', branch, dir, base);
}

/** Put back the worktree of an existing branch if its directory is gone. Returns true if it was re-created. */
export async function restoreWorktree(repo, dir, branch) {
  if (!dir || fs.existsSync(dir)) return false;
  await git(repo, 'worktree', 'prune');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', dir, branch);
  return true;
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

/** Is `ancestor` contained in `ref`? null if either is missing. */
export async function isAncestor(repo, ancestor, ref) {
  try { await git(repo, 'rev-parse', '-q', '--verify', `${ancestor}^{commit}`); } catch { return null; }
  try { await git(repo, 'merge-base', '--is-ancestor', ancestor, ref); return true; } catch { return false; }
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
