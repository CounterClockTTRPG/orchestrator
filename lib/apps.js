// Applications: a level above quests. An application names one or more repositories that make up one
// system (e.g. a backend and its client), carries standing context for the Archmage, quest defaults,
// and the history of quests run on it, whose chronicles later quests can read.

import fs from 'node:fs';
import path from 'node:path';

const ID = /^[a-z][a-z0-9-]{0,40}$/;
const HISTORY = 12; // earlier quests listed in a briefing

const expand = (p) => path.resolve(String(p ?? '').trim().replace(/^~(?=\/|$)/, process.env.HOME));
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const within = (file, dir) => file === dir || file.startsWith(dir + path.sep);

export const slug = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^(\d)/, 'app-$1').slice(0, 41);

/**
 * Check and clean an application definition. `id` is kept from `prev` on an update.
 * Repos: [{ name?, path }] or plain paths; names default to the directory name and must be unique.
 */
export function normalizeApp(input, prev = null) {
  const name = clip(input.name ?? prev?.name, 80);
  if (!name) throw new Error('An application needs a name.');
  const id = prev?.id ?? (input.id ? String(input.id) : slug(name));
  if (!ID.test(id)) throw new Error(`Application id "${id}": lowercase letters, digits and dashes, starting with a letter.`);
  const given = input.repos ?? prev?.repos ?? [];
  if (!Array.isArray(given) || !given.length) throw new Error('An application needs at least one directory.');
  const repos = given.map((r) => {
    const p = expand(typeof r === 'string' ? r : r.path);
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error(`Not a directory: ${p}`);
    const n = String((typeof r === 'object' && r.name) || path.basename(p)).trim().replace(/[^\w.-]+/g, '-');
    return { name: n, path: p };
  });
  const names = repos.map((r) => r.name);
  const dupe = names.find((n, i) => names.indexOf(n) !== i);
  if (dupe) throw new Error(`Two directories are both called "${dupe}"; give them distinct names.`);
  const nested = repos.find((a) => repos.some((b) => a !== b && within(a.path, b.path)));
  if (nested) throw new Error(`${nested.path} lies inside another directory of the application.`);
  const d = { ...(prev?.defaults ?? {}), ...(input.defaults ?? {}) };
  const defaults = {};
  if (['read', 'edit'].includes(d.mode)) defaults.mode = d.mode;
  if (['review', 'auto'].includes(d.planning)) defaults.planning = d.planning;
  if (Number(d.maxAgents) > 0) defaults.maxAgents = Math.min(20, Math.round(Number(d.maxAgents)));
  const now = new Date().toISOString();
  return {
    id, name, repos, defaults,
    description: String(input.description ?? prev?.description ?? '').trim().slice(0, 2000),
    context: String(input.context ?? prev?.context ?? '').trim().slice(0, 20000),
    createdAt: prev?.createdAt ?? now, updatedAt: now,
  };
}

/** The application whose directories contain `dir`, if exactly one does. */
export function appForDir(apps, dir) {
  const d = expand(dir);
  const hits = Object.values(apps).filter((a) => a.repos.some((r) => within(d, r.path)));
  return hits.length === 1 ? hits[0] : null;
}

/** Where a quest on `app` starts: `cwd` if it lies inside one of its directories, else the first one. */
export function focusDir(app, cwd) {
  if (!cwd) return app.repos[0].path;
  const d = expand(cwd);
  if (!app.repos.some((r) => within(d, r.path))) {
    throw new Error(`${d} is not part of the application ${app.name} (${app.repos.map((r) => r.path).join(', ')}).`);
  }
  return d;
}

/**
 * The part of the Archmage's briefing about the application: what it is, its directories, the
 * standing context, and earlier quests with the files holding their chronicles.
 * `history` is [{ id, goal, status, createdAt, chronicleFile }], newest first.
 */
export function appBriefing(app, history = []) {
  const lines = [
    `Application: ${app.name}${app.description ? ` — ${app.description}` : ''}`,
    `Its directories (the party may work in all of them):`,
    ...app.repos.map((r) => `- ${r.name}: ${r.path}`),
  ];
  if (app.context) lines.push('', 'Standing context for this application (from the human):', app.context);
  const past = history.slice(0, HISTORY);
  if (past.length) {
    lines.push('', 'Earlier quests on this application. Read a chronicle when it bears on this quest, and pass its path to agents who need it:');
    for (const h of past) {
      lines.push(`- ${h.createdAt.slice(0, 10)} ${h.id} (${h.status}): ${clip(h.goal, 160)}${h.chronicleFile ? `\n  chronicle: ${h.chronicleFile}` : ''}`);
    }
    if (history.length > past.length) lines.push(`(${history.length - past.length} older quests not listed.)`);
  }
  return lines.join('\n');
}
