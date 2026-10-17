// Applications: a level above quests. An application names one or more repositories that make up one
// system (e.g. a backend and its client), carries standing context for the Archmage, quest defaults,
// and the history of quests run on it, whose chronicles later quests can read.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ID = /^[a-z][a-z0-9-]{0,40}$/;
const NAME = /^\w[\w.-]{0,40}$/; // a directory's name in an application: also a folder name in workspaces
const HISTORY = 12; // earlier quests listed in a briefing
const NOTES_LIMIT = 20_000; // characters of GUILD.md per directory

const expand = (p) => path.resolve(String(p ?? '').trim().replace(/^~(?=\/|$)/, process.env.HOME));
const clip = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const within = (file, dir) => file === dir || file.startsWith(dir + path.sep);
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

/** The filesystem root or the home directory itself: no quest may work on all of it. */
export const tooBroad = (dir) => { const d = real(dir); return d === path.parse(d).root || d === real(os.homedir()); };

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
    const raw = expand(typeof r === 'string' ? r : r?.path);
    if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) throw new Error(`Not a directory: ${raw}`);
    const p = real(raw);
    if (tooBroad(p)) throw new Error(`${p} is too broad for an application; choose project directories.`);
    const n = String((typeof r === 'object' && r.name) || path.basename(p)).trim().replace(/[^\w.-]+/g, '-');
    if (!NAME.test(n) || /^\.+$/.test(n)) throw new Error(`"${n}" can't name a directory: use letters, digits, dots and dashes.`);
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

/** Look up an application by id without falling into Object.prototype ("__proto__", "constructor"). */
export const findApp = (apps, id) => (id && Object.hasOwn(apps, id) ? apps[id] : null);

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

/** GUILD.md at the top of each directory, if present: notes kept in the repository, next to the code. */
export function repoNotes(dirs) {
  const notes = [];
  for (const d of dirs) {
    try {
      const text = fs.readFileSync(path.join(d.path, 'GUILD.md'), 'utf8').trim();
      if (text) notes.push({ name: d.name, file: path.join(d.path, 'GUILD.md'), text: text.length > NOTES_LIMIT ? `${text.slice(0, NOTES_LIMIT)}\n…(cut; read the file for the rest)` : text });
    } catch { /* none */ }
  }
  return notes;
}

/** The standing context and GUILD.md notes, as one block for a prompt ('' when there are none). */
export function standingContext(app, notes) {
  const parts = [];
  if (app?.context) parts.push(`Standing context for the application ${app.name} (from the human):\n${app.context}`);
  for (const n of notes) parts.push(`Notes for ${n.name} (${n.file}):\n${n.text}`);
  return parts.join('\n\n');
}

/** How an earlier quest's outcome reads in a briefing: whether its branch reached the human's checkout. */
function outcome(h) {
  if (h.mode !== 'edit') return 'read-only';
  if (h.status !== 'done') return 'edit';
  const unmerged = (h.repos ?? []).filter((r) => r.merged === false);
  if (!unmerged.length) return `edit, merged into the checkout`;
  return `edit, branch ${unmerged[0].branch} NOT merged into ${unmerged.map((r) => r.name).join(', ')}: its chronicle describes work that is not in the code there`;
}

/**
 * The part of the Archmage's briefing about the application: what it is, its directories, and earlier
 * quests with the files holding their chronicles. `history` is [{ id, goal, status, mode, createdAt,
 * chronicleFile, repos: [{ name, branch, merged }] }], newest first. In edit mode the party works on
 * worktrees, so the checkouts are named only for reference.
 */
export function appBriefing(app, history = [], { edit = false } = {}) {
  const lines = [
    `Application: ${app.name}${app.description ? ` — ${app.description}` : ''}`,
    edit ? `Its repositories (the party works on git worktrees of them, never on these checkouts):` : `Its directories (the party may work in all of them):`,
    ...app.repos.map((r) => `- ${r.name}: ${r.path}`),
  ];
  const past = history.slice(0, HISTORY);
  if (past.length) {
    lines.push('', 'Earlier quests on this application. Read a chronicle when it bears on this quest, and pass its path to agents who need it:');
    for (const h of past) {
      lines.push(`- ${h.createdAt.slice(0, 10)} ${h.id} (${h.status}, ${outcome(h)}): ${clip(h.goal, 160)}${h.chronicleFile ? `\n  chronicle: ${h.chronicleFile}` : ''}`);
    }
    if (history.length > past.length) lines.push(`(${history.length - past.length} older quests not listed.)`);
  }
  return lines.join('\n');
}
