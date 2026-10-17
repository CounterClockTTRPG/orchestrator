// Files an agent or the Archmage shows the human: checked against the quest's directories, copied into the quest.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { now, realOrNull, within } from './common.js';

const ATTACH_LIMIT = 20 * 1024 * 1024;
const FILE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
  md: 'text/markdown; charset=utf-8', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8',
  json: 'application/json', csv: 'text/csv; charset=utf-8', mp4: 'video/mp4', webm: 'video/webm',
};

/** The content type served for an attachment, by its extension. */
export const fileType = (name) => FILE_TYPES[path.extname(name).slice(1).toLowerCase()] ?? 'application/octet-stream';

/** The real path of a file the attacher may share: under its own directory, the quest's, or the temp folder. */
function checkedFile(q, base, given) {
  const wanted = path.resolve(base, String(given).replace(/^~(?=\/|$)/, os.homedir()));
  const file = realOrNull(wanted);
  if (!file || !fs.statSync(file).isFile()) throw new Error(`There is no file at ${wanted}.`);
  const roots = [base, q.s.cwd, ...q.s.dirs.map((d) => d.path), ...(q.s.repos ?? []).map((r) => r.root), os.tmpdir()].filter(Boolean).map(realOrNull).filter(Boolean);
  if (!roots.some((r) => within(file, r))) throw new Error(`${wanted} is outside your working directory and the temp folder; copy it into one of them first.`);
  const size = fs.statSync(file).size;
  if (size > ATTACH_LIMIT) throw new Error(`${path.basename(file)} is ${(size / 1048576).toFixed(1)} MB; the limit is 20 MB.`);
  return { wanted, file, size };
}

// ── Quest methods (mixed into Quest.prototype) ──

export const attachmentMethods = {
  /** Keep a copy of a file an agent or the Archmage wants the human to see (a screenshot, a report). */
  attach(who, { path: given, caption } = {}) {
    const agent = who === 'archmage' ? null : this.s.agents.find((x) => x.id === who);
    if (who !== 'archmage' && !agent) throw new Error(`Unknown agent ${who}`);
    if (!String(given ?? '').trim()) throw new Error('Give the path of the file to attach.');
    const base = agent ? agent.dir ?? this.s.cwd : this.s.archmage.workdir ?? this.s.cwd;
    const { wanted, file, size } = checkedFile(this, base, given);
    this.s.attachments ??= [];
    const name = path.basename(wanted).replace(/[^\w.-]+/g, '_').slice(-120) || 'file';
    const f = { id: `f${this.s.attachments.length + 1}`, who, name, caption: caption?.trim() || null, size, ts: now(), type: fileType(name) };
    const dir = path.join(this.dir, 'files');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(file, path.join(dir, `${f.id}-${name}`));
    this.s.attachments.push(f);
    this.emit('attachment', { attachment: f });
    this.log(who, 'attach', f.caption ?? name, { attachment: f.id });
    return `Attached ${name} (${f.type}); the human can see it in the interface.`;
  },

  attachmentFile(fid) {
    const f = this.s.attachments?.find((x) => x.id === fid);
    if (!f) return null;
    return { ...f, path: path.join(this.dir, 'files', `${f.id}-${f.name}`) };
  },
};
