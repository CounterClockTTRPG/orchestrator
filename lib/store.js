// Everything Guild keeps on disk lives under GUILD_HOME (default ~/.guild):
//   settings.json, roles.json, quests/<id>/quest.json, quests/<id>/events.jsonl, worktrees/, server.log

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME = process.env.GUILD_HOME || path.join(os.homedir(), '.guild');
export const QUESTS_DIR = path.join(HOME, 'quests');
export const WORKTREES_DIR = path.join(HOME, 'worktrees');
const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

fs.mkdirSync(QUESTS_DIR, { recursive: true });

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
  maxConcurrent: 4,
  maxAgents: 6,
  batchSeconds: 60,
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

export function questDir(id) {
  return path.join(QUESTS_DIR, id);
}
export function saveQuest(state) {
  writeJson(path.join(questDir(state.id), 'quest.json'), state);
}
export function appendEvent(id, event) {
  fs.appendFileSync(path.join(questDir(id), 'events.jsonl'), JSON.stringify(event) + '\n');
}
export function loadAllQuests() {
  return fs.readdirSync(QUESTS_DIR)
    .map((id) => readJson(path.join(questDir(id), 'quest.json'), null))
    .filter(Boolean);
}
