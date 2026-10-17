// Everything Guild keeps on disk lives under GUILD_HOME (default ~/.guild):
//   settings.json, roles.json, applications.json, quests/<id>/quest.json, quests/<id>/events.jsonl,
//   quests/<id>/chronicle.md, worktrees/, server.log

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.GUILD_HOME || path.join(os.homedir(), '.guild');
export const QUESTS_DIR = path.join(HOME, 'quests');
export const WORKTREES_DIR = path.join(HOME, 'worktrees');
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

fs.mkdirSync(QUESTS_DIR, { recursive: true });
try { fs.chmodSync(HOME, 0o700); } catch { /* not ours to change */ } // quests hold code, reports and secrets

// A missing file gives the fallback. A corrupt one is moved aside (never silently overwritten) and
// also gives the fallback.
const readJson = (file, fallback) => {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return fallback; }
  try {
    return JSON.parse(text);
  } catch (err) {
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    console.error(`Guild: ${file} is not valid JSON (${err.message}); moved it to ${aside}.`);
    return fallback;
  }
};
const writeJson = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
};

export const DEFAULT_SETTINGS = {
  style: 'painterly',
  theme: 'fantasy',
  maxConcurrent: 4,
  maxAgents: 6,
  batchSeconds: 60,
  animate: true, // portrait emotes (working, thinking, talking, asleep)
  // Changes the human approves personally; the Archmage and the party ask before making them. '' for none.
  checkIn: 'Ask me before changing a design or balance number (a cost, chance, timing, amount or limit) by more than 20%, and before changing anything the brief or the design docs state as decided.',
  lastCwd: '',
};

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(path.join(HOME, 'settings.json'), {}) };
}
export function saveSettings(s) {
  writeJson(path.join(HOME, 'settings.json'), s);
}

/** The role catalog: the user's copy in GUILD_HOME, seeded from roles.default.json on first use. */
export function loadRoles() {
  const file = path.join(HOME, 'roles.json');
  const defaults = path.join(APP_DIR, 'roles.default.json');
  let roles = readJson(file, null)?.roles;
  if (!roles) {
    // First run, or the catalog was corrupt and moved aside: start again from the defaults.
    fs.copyFileSync(defaults, file);
    roles = readJson(file, { roles: {} }).roles;
  }
  return roles;
}
export function saveRoles(roles) {
  writeJson(path.join(HOME, 'roles.json'), { roles });
}

/** Applications: { id: application } (see lib/apps.js). */
export function loadApps() {
  return readJson(path.join(HOME, 'applications.json'), { applications: {} }).applications ?? {};
}
export function saveApps(apps) {
  writeJson(path.join(HOME, 'applications.json'), { applications: apps });
}

export function questDir(id) {
  return path.join(QUESTS_DIR, id);
}
export function saveQuest(state) {
  writeJson(path.join(questDir(state.id), 'quest.json'), state);
}
/** The chronicle as a file of its own, so later quests on the same application can read it. */
export function chronicleFile(state) {
  if (!state.chronicle) return null;
  const file = path.join(questDir(state.id), 'chronicle.md');
  if (!fs.existsSync(file)) fs.writeFileSync(file, `# ${state.goal.split('\n')[0].slice(0, 120)}\n\n${state.chronicle}\n`);
  return file;
}
export function appendEvent(id, event) {
  fs.appendFileSync(path.join(questDir(id), 'events.jsonl'), JSON.stringify(event) + '\n');
}
/** Stored events numbered after `since` (events from before numbering have no seq and are left out). */
export function readEventsSince(id, since) {
  let text;
  try { text = fs.readFileSync(path.join(questDir(id), 'events.jsonl'), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.seq > since) out.push(e);
    } catch { /* a line cut short by a crash */ }
  }
  return out;
}
export function loadAllQuests() {
  return fs.readdirSync(QUESTS_DIR)
    .map((id) => readJson(path.join(questDir(id), 'quest.json'), null))
    .filter(Boolean);
}
