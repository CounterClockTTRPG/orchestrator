// The guild's applications: the registry methods (list, save, adopt, delete) and the history of earlier quests on
// one, for briefings. The applications themselves (validation, briefing text, context) are in apps.js.

import * as G from './git.js';
import * as store from './store.js';
import { normalizeApp, appForDir, findApp } from './apps.js';
import { ACTIVE } from './common.js';

// ── Guild methods (mixed into Guild.prototype) ──

export const applicationMethods = {
  listApps() {
    return Object.values(this.apps).sort((a, b) => a.name.localeCompare(b.name));
  },

  app(id) {
    const a = findApp(this.apps, id);
    if (!a) throw new Error(`No application "${id}".`);
    return a;
  },

  /** Create an application (no `id`) or update one. */
  saveApp(id, input) {
    const prev = id ? this.app(id) : null;
    const app = normalizeApp(input ?? {}, prev);
    if (!prev && findApp(this.apps, app.id)) throw new Error(`There is already an application "${app.id}".`);
    this.apps[app.id] = app;
    if (input?.adopt) this.adopt(app);
    this.appsChanged();
    return app;
  },

  /** File the quests in no application whose directory lies in this one's under it. */
  adopt(app) {
    for (const q of this.quests.values()) {
      if (!findApp(this.apps, q.s.app) && appForDir({ [app.id]: app }, q.s.cwd)) q.setApp(app.id);
    }
  },

  /** Delete an application. Its quests stay, ungrouped. */
  deleteApp(id) {
    this.app(id);
    delete this.apps[id];
    for (const q of this.quests.values()) if (q.s.app === id) q.setApp(null);
    this.appsChanged();
  },

  appsChanged() {
    store.saveApps(this.apps);
    this.emit('global', { type: 'apps', apps: this.listApps() });
  },

  /**
   * Earlier quests on an application, newest first, with their chronicle files and, for edit quests,
   * whether their branch has reached the human's checkout (for briefings).
   */
  async appHistory(appId, except) {
    const out = [];
    for (const q of this.list()) {
      if (q.s.app !== appId || q.id === except || ACTIVE.has(q.s.status)) continue;
      const repos = [];
      if (q.s.mode === 'edit' && q.s.status === 'done') {
        for (const r of q.s.repos ?? []) repos.push({ name: r.name, branch: r.branch, merged: await G.isAncestor(r.root, r.branch, 'HEAD') });
      }
      out.push({ id: q.id, goal: q.s.goal, status: q.s.status, mode: q.s.mode, createdAt: q.s.createdAt, chronicleFile: store.chronicleFile(q.s), repos });
    }
    return out;
  },
};
