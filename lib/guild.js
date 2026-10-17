// The guild: the registry of all quests, the settings and role catalog, posting a quest, and the event stream.
// One quest's life is in quest.js and the modules it gathers; the shared agent queue is in scheduler.js.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as store from './store.js';
import { THEME_IDS } from '../web/themes.js';
import { focusDir, findApp, tooBroad } from './apps.js';
import { Quest } from './quest.js';
import { Scheduler } from './scheduler.js';
import { cleanRole, ROLE_ID } from './roles.js';
import { inspectRepos, discardRepos } from './workspace.js';
import { applicationMethods } from './applications.js';
import { now, mixin } from './common.js';

// Other modules and tests import these from here.
export { tooBroad, cleanRole, Quest };

/**
 * A new quest id: the date (readable, and sorted by it), then 8 random hex digits. One that is `taken` (a quest, its
 * directory or its worktrees exist) is drawn again: a clash would clobber the other quest and its branches.
 */
export function questId(taken, random = () => crypto.randomBytes(4).toString('hex')) {
  const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  for (;;) {
    const id = `${day}-${random()}`;
    if (!taken(id)) return id;
  }
}

export class Guild extends EventEmitter {
  constructor({ port }) {
    super();
    this.port = port;
    this.url = `http://127.0.0.1:${port}`;
    this.settings = store.loadSettings();
    this.roles = store.loadRoles();
    this.apps = store.loadApps();
    this.quests = new Map();
    this.stopping = false; // set by shutdown(): nothing ends, starts or is revived any more
    this.scheduler = new Scheduler(() => this.settings.maxConcurrent);
    for (const state of store.loadAllQuests()) {
      // quest.json is saved a moment after each event, so after a crash the event log may be ahead of it.
      state.seq = Math.max(state.seq ?? 0, store.readEventsSince(state.id, 0).at(-1)?.seq ?? 0);
      const q = new Quest(this, state);
      q.markInterrupted();
      this.quests.set(q.id, q);
    }
  }

  list() {
    return [...this.quests.values()].sort((a, b) => b.state.createdAt.localeCompare(a.state.createdAt));
  }

  /**
   * Post a quest on one directory (`cwd`), or on all the directories of an application (`app`), starting from
   * `cwd` if given. Unset mode, planning and maxAgents come from the application's defaults, then the global ones.
   * Edit mode also takes `target` (the branch to deliver to; default: the one checked out in each repository),
   * `sync` (more branches whose latest work must be merged in before finishing; the target always is) and `deliver`
   * ('offer': fast-forward the target when you say so, 'auto': as soon as the quest is done). `checkIn` is the rule
   * for changes the human approves personally (default: the setting; '' for none).
   */
  async createQuest({ goal, app: appId, cwd, mode, planning, maxAgents, target, sync = [], deliver = 'offer', checkIn }) {
    if (!goal?.trim()) throw new Error('A quest needs a goal.');
    const app = findApp(this.apps, appId);
    if (appId && !app) throw new Error(`No application "${appId}".`);
    mode ??= app?.defaults.mode ?? 'read';
    planning ??= app?.defaults.planning ?? 'review';
    maxAgents = Number(maxAgents) || app?.defaults.maxAgents || this.settings.maxAgents;
    cwd = this.questCwd(app, cwd);
    if (!['read', 'edit'].includes(mode)) throw new Error('mode must be "read" or "edit"');
    if (!['review', 'auto'].includes(planning)) throw new Error('planning must be "review" or "auto"');
    const dirs = app ? app.repos.map(({ name, path: p }) => ({ name, path: p })) : [{ name: path.basename(cwd), path: cwd }];
    if (!['offer', 'auto'].includes(deliver)) throw new Error('deliver must be "offer" or "auto"');
    target = String(target ?? '').trim();
    if (target && dirs.length > 1) throw new Error('target names one branch; on an application with several repositories each delivers to the branch checked out in it.');
    const extra = (Array.isArray(sync) ? sync : String(sync).split(/[\s,]+/)).map((b) => String(b).trim()).filter(Boolean);
    checkIn = String(checkIn ?? this.settings.checkIn ?? '').trim();
    if (this.stopping) throw new Error('The Guild server is stopping.');
    const id = questId((id) => this.quests.has(id) || fs.existsSync(store.questDir(id)) || fs.existsSync(path.join(store.WORKTREES_DIR, id)));
    const repos = mode === 'edit' ? await inspectRepos(dirs, { id, target, sync: extra, deliver }) : null;
    const q = new Quest(this, {
      id, goal: goal.trim(), app: app?.id ?? null, cwd, dirs, mode, planning, theme: this.settings.theme ?? 'fantasy',
      maxAgents: Math.max(1, Math.min(20, maxAgents)),
      status: 'planning', createdAt: now(), updatedAt: now(),
      repos, checkIn,
      archmage: null, plan: null, roles: {}, agents: [], log: [], chronicle: null, diffs: null, costUsd: 0,
    });
    this.quests.set(id, q);
    try {
      await q.begin();
    } catch (err) {
      // Leave no half-made quest behind (in memory, on disk, or as a worktree).
      this.quests.delete(id);
      q.arch?.kill();
      clearInterval(q.timer);
      await discardRepos(repos);
      fs.rmSync(store.questDir(id), { recursive: true, force: true });
      throw err;
    }
    if (!app) {
      this.settings.lastCwd = cwd;
      store.saveSettings(this.settings);
    }
    return q;
  }

  /** The directory a quest starts in: in the application, or the one given (default: the last used). */
  questCwd(app, cwd) {
    if (app) cwd = focusDir(app, cwd);
    else cwd = path.resolve(String(cwd || this.settings.lastCwd || process.cwd()).replace(/^~(?=\/|$)/, process.env.HOME));
    if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`);
    if (tooBroad(cwd)) throw new Error(`${cwd} is too broad for a quest (the agents could read everything under it); choose a project directory.`);
    return cwd;
  }

  /**
   * The server is stopping (SIGINT, SIGTERM): every quest still under way is recorded as interrupted and saved at
   * once, and its sessions are stopped. Resolves once they have exited (or after `ms`) and every quest is saved.
   */
  async shutdown(ms = 5000) {
    this.stopping = true;
    const timeout = () => new Promise((r) => setTimeout(r, ms).unref());
    // A quest that was already ending (finish, cancel) may complete its cleanup, briefly.
    await Promise.all([...this.quests.values()].map((q) => (q.ending ? Promise.race([q.ending, timeout()]) : q.interrupt(ms))));
    for (const q of this.quests.values()) if (q.saveTimer) q.saveNow(); // what the sessions' last events changed
  }

  role(id, quest) {
    return quest?.state.roles[id] ?? this.roles[id];
  }

  // ── the agent queue (scheduler.js), shared by all quests ──

  get running() { return this.scheduler.running; }
  get queue() { return this.scheduler.queue; }
  acquire(start, priority) { this.scheduler.acquire(start, priority); }
  release() { this.scheduler.release(); }
  dequeue(start) { return this.scheduler.dequeue(start); }
  drain() { this.scheduler.drain(); }

  // ── settings and the role catalog ──

  updateSettings(patch) {
    if (patch.theme !== undefined && !THEME_IDS.includes(patch.theme)) throw new Error(`theme must be one of ${THEME_IDS.join(', ')}`);
    for (const k of ['style', 'theme', 'maxConcurrent', 'maxAgents', 'batchSeconds', 'animate', 'checkIn']) if (patch[k] !== undefined) this.settings[k] = patch[k];
    this.settings.checkIn = String(this.settings.checkIn ?? '').trim();
    this.settings.animate = this.settings.animate !== false;
    const clamp = (v, lo, hi, dflt) => Math.max(lo, Math.min(hi, Math.round(Number(v)) || dflt));
    this.settings.maxConcurrent = clamp(this.settings.maxConcurrent, 1, 32, 4);
    this.settings.maxAgents = clamp(this.settings.maxAgents, 1, 20, 6);
    this.settings.batchSeconds = clamp(this.settings.batchSeconds, 5, 600, 60);
    store.saveSettings(this.settings);
    this.drain();
    this.emit('global', { type: 'settings', settings: this.settings });
    return this.settings;
  }

  saveRole(id, role) {
    if (!ROLE_ID.test(id)) throw new Error('Role id: lowercase letters, digits and dashes');
    this.roles[id] = cleanRole(role);
    store.saveRoles(this.roles);
    this.emit('global', { type: 'roles', roles: this.roles });
    return this.roles;
  }

  replaceRoles(roles) {
    if (!roles || typeof roles !== 'object' || !Object.values(roles).some((r) => r?.orchestrator)) throw new Error('The catalog needs an orchestrator role.');
    for (const id of Object.keys(roles)) if (!ROLE_ID.test(id)) throw new Error(`Role id "${id}": lowercase letters, digits and dashes`);
    roles = Object.fromEntries(Object.entries(roles).map(([id, r]) => [id, cleanRole(r)]));
    this.roles = roles;
    store.saveRoles(roles);
    this.emit('global', { type: 'roles', roles });
    return roles;
  }
}

mixin(Guild.prototype, applicationMethods);
