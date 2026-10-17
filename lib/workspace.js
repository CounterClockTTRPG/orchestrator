// Edit mode's git side: the quest's repositories, the integration and agent worktrees, merging the party,
// the checks before finishing, delivery to the target branches, and cleanup.

import fs from 'node:fs';
import path from 'node:path';
import * as G from './git.js';
import * as store from './store.js';
import { FINISHED_AGENT, now, within } from './common.js';

/**
 * The repository entry of each quest directory, for an edit quest: its root, the commit the party starts from,
 * the quest branch, the target branch and the branches `sync` names that merge_party brings in.
 */
export async function inspectRepos(dirs, { id, target, sync, deliver }) {
  const repos = [];
  for (const d of dirs) {
    const info = await G.repoInfo(d.path);
    if (!info) throw new Error(`Edit mode needs git repositories; ${d.path} is not in one. Use read-only mode, or run git init first.`);
    const twin = repos.find((r) => r.root === info.root);
    if (twin) throw new Error(`${twin.name} and ${d.name} are in the same git repository (${info.root}); list the repository once.`);
    const r = { name: d.name, root: info.root, base: info.head, dirty: info.dirty, branch: `guild/${id}/party`, deliver };
    const t = target || info.branch;
    if (t) {
      const tip = await G.resolve(info.root, `refs/heads/${t}`);
      if (!tip) throw new Error(`There is no branch "${t}" in ${info.root}.`);
      // The party starts from the target's latest commit, which need not be what the checkout has.
      if (t !== info.branch) Object.assign(r, { base: tip, dirty: false });
    }
    for (const b of sync) if (!(await G.resolve(info.root, b))) throw new Error(`There is no branch or ref "${b}" to merge in${dirs.length > 1 ? ` in ${d.name}` : ''}.`);
    r.sync = [...new Set([t, ...sync].filter(Boolean))];
    r.target = t || null;
    repos.push(r);
  }
  return repos;
}

/** Remove what a quest that failed to begin made in its repositories: integration worktrees and the quest branch. */
export async function discardRepos(repos) {
  for (const r of repos ?? []) {
    if (r.integrationDir) await G.removeWorktree(r.root, r.integrationDir);
    await G.git(r.root, 'branch', '-D', r.branch).catch(() => {});
  }
}

// ── Quest methods (mixed into Quest.prototype) ──

export const workspaceMethods = {
  /** The Archmage's integration worktree (one per repository on an application). Returns its working directory. */
  async openIntegration() {
    const integration = path.join(store.WORKTREES_DIR, this.id, '_archmage');
    for (const r of this.s.repos) {
      r.integrationDir = this.multi ? path.join(integration, r.name) : integration;
      await G.addWorktree(r.root, r.integrationDir, r.branch, r.base);
    }
    return this.multi ? integration : path.join(integration, path.relative(this.s.repos[0].root, this.s.cwd));
  },

  /** Directories outside `workdir` that a session must be allowed into (read mode on an application). */
  extraDirs(workdir) {
    if (this.s.mode === 'edit') return [];
    return this.s.dirs.map((d) => d.path).filter((p) => !within(p, workdir));
  },

  /**
   * An agent's own worktree (or, on several repositories, a workspace with one worktree each). An agent that
   * waited for others builds on their code: in each repository it starts from the first prerequisite's branch
   * that has commits there, and merges in the others. Returns the files such a merge left in conflict.
   */
  async prepareWorkspace(a) {
    if (a.dir) return [];
    const slug = `${a.id}-${a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const ws = path.join(store.WORKTREES_DIR, this.id, slug);
    a.branch = `guild/${this.id}/${slug}`;
    a.worktrees = [];
    a.startRefs = {};
    const conflicts = [];
    const prereqs = (a.after ?? []).map((id) => this.agent(id)).filter((d) => d.status === 'done' && d.branch);
    for (const r of this.s.repos) {
      const dir = this.multi ? path.join(ws, r.name) : ws;
      const from = prereqs.filter((d) => (d.commitsByRepo?.[r.name] ?? d.commits ?? 0) > 0);
      await G.addWorktree(r.root, dir, a.branch, from[0]?.branch ?? r.base);
      for (const d of from.slice(1)) {
        const m = await G.merge(dir, d.branch, `Merge ${d.name} the ${d.title} (${d.branch}) to build on`);
        if (!m.ok) { conflicts.push(...(m.conflicts.length ? m.conflicts.map((f) => (this.multi ? `${r.name}/${f}` : f)) : [`(merge failed${this.multi ? ` in ${r.name}` : ''}: ${m.error})`])); break; }
      }
      a.startRefs[r.name] = await G.git(dir, 'rev-parse', 'HEAD');
      a.worktrees.push({ repo: r.name, dir });
    }
    a.dir = this.multi ? ws : path.join(ws, path.relative(this.s.repos[0].root, this.s.cwd));
    return conflicts;
  },

  /** [{ repo, root, base, dir }] for each worktree of an agent; quests from before applications had one. */
  worktreesOf(a) {
    const list = a.worktrees ?? (a.worktree ? [{ repo: this.s.repos[0].name, dir: a.worktree }] : []);
    return list.map((w) => ({ ...w, ...this.s.repos.find((r) => r.name === w.repo), dir: w.dir }));
  },

  /** Commit what an agent left uncommitted and count its commits per repository. Returns a note for the Archmage. */
  async tallyCommits(a) {
    let note = '';
    try {
      a.commitsByRepo = {};
      for (const w of this.worktreesOf(a)) {
        if (await G.commitLeftovers(w.dir, `${a.name} (${a.title}): uncommitted work`)) note = ' (Guild committed uncommitted leftovers.)';
        // Its own commits: a branch started from a prerequisite's carries theirs too.
        a.commitsByRepo[w.repo] = await G.commitCount(w.root, a.startRefs?.[w.repo] ?? a.startRef ?? w.base, a.branch);
      }
      a.commits = Object.values(a.commitsByRepo).reduce((n, c) => n + c, 0);
    } catch (err) { note = ` (Commit check failed: ${err.message})`; }
    return note;
  },

  /**
   * The repositories where the agent's branch has commits the quest branch lacks. Git decides, not a
   * list of merged agents: an agent woken after its merge may have committed again.
   */
  async unmerged(a) {
    const out = [];
    for (const w of this.worktreesOf(a)) {
      const n = await G.commitCount(w.root, w.branch, a.branch);
      if (n > 0) out.push({ ...w, commits: n });
    }
    return out;
  },

  async mergeInProgress() {
    for (const r of this.s.repos) if (await G.mergeInProgress(r.integrationDir)) return r;
    return null;
  },

  /** `leaveOut`: agent ids whose remaining work the Archmage decides not to merge (say why in the chronicle). */
  async mergeParty({ leaveOut = [] } = {}) {
    if (this.s.mode !== 'edit') throw new Error('merge_party is only for edit-mode quests.');
    const busy = await this.mergeInProgress();
    if (busy) throw new Error(`A merge is still in progress${this.multi ? ` in ${busy.name}/` : ''}: resolve the conflicts, git add, git commit (or git merge --abort and pass leaveOut), then call merge_party again.`);
    for (const id of leaveOut) {
      const a = this.agent(id);
      this.s.leftOut = [...new Set([...(this.s.leftOut ?? []), a.id])];
      this.log('archmage', 'action', `Left ${a.name}'s unmerged work out of the quest branch.`);
    }
    const lines = [];
    const working = this.s.agents.filter((a) => !FINISHED_AGENT.has(a.status));
    const branch = this.s.repos[0].branch;
    const conflict = (await this.mergeAgents(lines)) ?? (await this.mergeSync(lines));
    if (conflict) return conflict;
    this.save();
    this.log('archmage', 'action', `Merged the party into ${branch}${this.multi ? ` in ${this.s.repos.map((r) => r.name).join(', ')}` : ''}.`);
    if (working.length) lines.push(`Still working (not merged): ${working.map((a) => a.name).join(', ')}`);
    return `${lines.join('\n') || 'Nothing new to merge.'}\nQuest branch: ${branch}${this.multi ? ' (in each repository)' : ''}.`;
  },

  /** Merge each finished agent's unmerged work into the integration worktrees. Returns the reply on a conflict. */
  async mergeAgents(lines) {
    for (const a of this.s.agents) {
      if (!a.branch || this.s.leftOut?.includes(a.id)) continue;
      const todo = await this.unmerged(a);
      if (!todo.length) continue;
      if (a.status !== 'done') { if (FINISHED_AGENT.has(a.status)) lines.push(`skipped ${a.name}: ${a.status}`); continue; }
      for (const w of todo) {
        const n = w.commits;
        const where = this.multi ? ` into ${w.repo}` : '';
        const r = await G.merge(w.integrationDir, a.branch, `Merge ${a.name} the ${a.title} (${a.branch})`);
        if (!r.ok && !r.conflicts.length) {
          this.save();
          throw new Error(`Merging ${a.name} (${a.branch})${where} failed without conflicts: ${r.error}. Inspect the working directory and fix it, then call merge_party again.`);
        }
        if (!r.ok) {
          this.log('archmage', 'action', `Merging ${a.name}${where}: conflicts in ${r.conflicts.join(', ')}`);
          this.save();
          return [...lines, `CONFLICT merging ${a.name} (${a.branch})${where} in ${r.conflicts.join(', ')}.`,
            `Resolve the conflicts in ${this.multi ? `${w.repo}/ of ` : ''}your working directory, git add the files and git commit, then call merge_party again. To drop this work instead: git merge --abort, then merge_party with leaveOut: ["${a.id}"].`].join('\n');
        }
        lines.push(`merged ${a.name}${where} (${n} commits)`);
      }
    }
    return null;
  },

  /**
   * Work done outside the quest meanwhile (the target branch, and any the human named): bring its latest in, so
   * clashes with it surface here rather than after delivery. Returns the reply on a conflict.
   */
  async mergeSync(lines) {
    for (const repo of this.s.repos) {
      const dir = repo.integrationDir, where = this.multi ? ` in ${repo.name}` : '';
      for (const ref of repo.sync ?? []) {
        const tip = await G.resolve(dir, ref);
        if (!tip) { lines.push(`${ref}${where}: not found, skipped`); continue; }
        if (await G.contains(dir, 'HEAD', tip)) continue;
        const r = await G.merge(dir, ref, `Merge the latest ${ref} (work outside the quest)`);
        if (!r.ok && !r.conflicts.length) throw new Error(`Merging ${ref}${where} failed without conflicts: ${r.error}. Fix it, then call merge_party again.`);
        if (!r.ok) {
          this.log('archmage', 'action', `Merging the latest ${ref}${where}: conflicts in ${r.conflicts.join(', ')}`);
          return [...lines, `CONFLICT merging the latest ${ref}${where} (work done outside the quest) in ${r.conflicts.join(', ')}.`,
            `Resolve them keeping both sides' intent${this.multi ? ` in ${repo.name}/` : ''}, git add and git commit, then call merge_party again.`].join('\n');
        }
        lines.push(`merged the latest ${ref}${where} (work outside the quest): run the checks again and look at the screens both sides touch`);
      }
    }
    return null;
  },

  /** Before an edit quest finishes: no merge in progress, nothing unmerged, nothing new on the synced branches. */
  async checkFinish() {
    const busy = await this.mergeInProgress();
    if (busy) throw new Error(`Finish the merge in progress${this.multi ? ` in ${busy.name}/` : ''} first (git add, git commit).`);
    for (const r of this.s.repos) await G.commitLeftovers(r.integrationDir, 'Archmage: final touches');
    const unmerged = [];
    for (const a of this.s.agents) {
      if (a.status === 'done' && a.branch && !this.s.leftOut?.includes(a.id) && (await this.unmerged(a)).length) unmerged.push(a);
    }
    if (unmerged.length) throw new Error(`Unmerged work from ${unmerged.map((a) => `${a.name} (${a.id})`).join(', ')}: call merge_party first, or leave it out with merge_party's leaveOut.`);
    const behind = [];
    for (const r of this.s.repos) {
      for (const ref of r.sync ?? []) {
        const tip = await G.resolve(r.integrationDir, ref);
        if (tip && !(await G.contains(r.integrationDir, 'HEAD', tip))) behind.push(this.multi ? `${r.name}:${ref}` : ref);
      }
    }
    if (behind.length) throw new Error(`${behind.join(', ')} ${behind.length > 1 ? 'have' : 'has'} new work from outside the quest: call merge_party to bring it in, resolve any conflicts, run the checks again, then finish_quest.`);
  },

  /**
   * After a successful edit quest: note each repository's final commit, and fast-forward the targets at once when
   * asked to. `delivery` keeps the first repository's fields at the top (target, commit, status), plus `repos`
   * with one entry per repository; its status is the least advanced of them.
   */
  async prepareDelivery() {
    const repos = [];
    for (const { name, root, branch, target } of this.s.repos) {
      const commit = await G.resolve(root, branch);
      const r = { name, target: target ?? null, commit, status: target ? 'ready' : 'none' };
      if (target && !(await G.contains(root, branch, `refs/heads/${target}`))) r.status = 'moved';
      repos.push(r);
    }
    this.s.delivery = { ...repos[0], repos };
    this.summarizeDelivery();
    if (this.s.repos[0].deliver === 'auto' && repos.some((r) => r.status === 'ready')) {
      try { await this.deliver('guild'); } catch (err) { this.s.delivery.error = err.message; }
    }
    for (const r of repos) {
      if (!r.target || r.status === 'delivered') continue;
      const where = this.multi ? ` in ${r.name}` : '';
      this.log('guild', 'system', r.status === 'moved'
        ? `${r.target}${where} moved on after the last merge; merge ${this.s.repos[0].branch} into it yourself.`
        : `The result${where} is ${this.s.repos[0].branch} at ${r.commit.slice(0, 8)}; it can fast-forward ${r.target}.${r.error ? ` (${r.error})` : ''}`);
    }
  },

  /** The delivery's overall status: the least advanced repository's. */
  summarizeDelivery() {
    const d = this.s.delivery, list = d.repos ?? [d];
    const order = ['moved', 'ready', 'delivered', 'none'];
    const live = list.filter((r) => r.status !== 'none');
    d.status = live.length ? order.find((st) => live.some((r) => r.status === st)) : 'none';
    d.error = list.map((r) => r.error).filter(Boolean).join('; ') || null;
    if (list.length > 1) Object.assign(d, { target: list[0].target, commit: list[0].commit });
    return d;
  },

  /** Fast-forward each target branch to the quest's result (the human's Deliver button, or deliver: 'auto'). */
  async deliver(from = 'you') {
    const d = this.s.delivery;
    const list = d?.repos ?? (d ? [{ ...d, name: this.s.repos[0].name }] : []);
    if (this.s.status !== 'done' || !list.some((r) => r.target)) throw new Error('Only a finished edit quest with a target branch can be delivered.');
    if (d.status === 'delivered') return d;
    let failure = null;
    for (const r of list) {
      if (!r.target || r.status === 'delivered') continue;
      const root = this.s.repos.find((x) => x.name === r.name)?.root ?? this.s.repos[0].root;
      try {
        const out = await G.fastForward(root, r.target, r.commit);
        Object.assign(r, { status: 'delivered', at: now(), dir: out.dir ?? null, error: null });
        this.log(from, 'action', `Fast-forwarded ${r.target}${this.multi ? ` in ${r.name}` : ''} to ${r.commit.slice(0, 8)}${out.dir ? ` (checked out at ${out.dir})` : ''}.`);
      } catch (err) {
        if (/moved on/.test(err.message)) r.status = 'moved';
        r.error = err.message;
        failure ??= err;
      }
    }
    if (!d.repos) Object.assign(d, list[0]);
    else if (list.length === 1) Object.assign(d, { ...list[0], repos: list });
    this.summarizeDelivery();
    if (list.length === 1) Object.assign(d, { at: list[0].at, dir: list[0].dir });
    this.emit('chronicle', { chronicle: this.s.chronicle, diffs: this.s.diffs, delivery: d });
    if (failure) throw failure;
    return d;
  },

  async cleanupWorktrees(withDiff) {
    if (withDiff) {
      this.s.diffs = [];
      for (const { name, root, base, branch } of this.s.repos) {
        try {
          this.s.diffs.push({ repo: name, root, base, branch, ...(await G.diff(root, base, branch)) });
        } catch (err) { this.log('guild', 'system', `Could not compute the diff of ${name}: ${err.message}`); }
      }
    }
    for (const a of this.s.agents) {
      for (const w of this.worktreesOf(a)) {
        // Keep whatever a recalled or unfinished agent left behind: commit it to its branch first.
        try { await G.commitLeftovers(w.dir, `${a.name} (${a.title}): work in progress (${a.status})`); } catch { /* nothing to keep */ }
        await G.removeWorktree(w.root, w.dir);
      }
    }
    for (const r of this.s.repos) {
      if (r.integrationDir) await G.removeWorktree(r.root, r.integrationDir);
      try { await G.git(r.root, 'worktree', 'prune'); } catch { /* ignore */ }
    }
    if (this.multi) {
      // The workspaces that held one worktree per repository, if nothing else is left in them.
      const shells = new Set([...this.s.agents.flatMap((a) => this.worktreesOf(a)), ...this.s.repos.map((r) => ({ dir: r.integrationDir }))]
        .filter((w) => w.dir).map((w) => path.dirname(w.dir)));
      for (const d of shells) try { fs.rmdirSync(d); } catch { /* not empty, or gone */ }
    }
  },
};
