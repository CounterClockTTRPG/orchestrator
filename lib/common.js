// Small helpers and constants shared by the quest modules (kept here so none of them imports another's).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LIB = path.dirname(fileURLToPath(import.meta.url));
export const ACTIVE = new Set(['planning', 'awaiting-approval', 'questing']);
export const FINISHED_AGENT = new Set(['done', 'failed', 'cancelled', 'interrupted']);

export const now = () => new Date().toISOString();
export const clip = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const realOrNull = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
export const within = (file, dir) => file === dir || file.startsWith(dir + path.sep);

/**
 * Copy method groups onto a class prototype. The Quest is one object split over several files; its methods keep
 * calling each other through `this`, so tests and callers can still replace one on an instance.
 */
export function mixin(target, ...groups) {
  for (const group of groups) {
    for (const name of Object.keys(group)) {
      if (Object.hasOwn(target, name)) throw new Error(`mixin: ${name} is defined twice`);
      target[name] = group[name];
    }
  }
}
