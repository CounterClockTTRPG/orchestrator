// Task titles: a few words naming what an agent works on ("Fix session expiry"), shown on its card.
// The Archmage gives one per task; tasks without one (older quests, a blank title) get one from the task text.
// Shared by the server and the UI.

const MAX = 48;

/** A clean title: one line, no markdown, at most 48 characters. */
export function cleanTitle(text) {
  const t = String(text ?? '').replace(/[#*`_>[\]]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= MAX) return t;
  const cut = t.slice(0, MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : cut.length).replace(/[,;:.\s-]+$/, '')}…`;
}

/** A title from the task itself: its first sentence or line, shortened. */
export function titleFromTask(task) {
  // The first line of text, skipping headings ("## Goal") unless there is nothing else.
  const lines = String(task ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l) => !/^#/.test(l)) ?? lines[0] ?? '';
  return cleanTitle(first.replace(/^#+\s*/, '').replace(/^[-*]\s+/, '').split(/(?<=[.!?])\s|:\s/)[0].replace(/\.$/, ''));
}

/** True when the task says no more than its title (so a card need not show both). */
export const sameAsTitle = (task, title) => {
  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return norm(task) === norm(title);
};

/** A plan member's task title (`title` in the plan). */
export const memberTitle = (m) => cleanTitle(m?.title) || titleFromTask(m?.task);
/** An agent's task title (`taskTitle`; an agent's `title` is its role's). */
export const agentTitle = (a) => cleanTitle(a?.taskTitle) || titleFromTask(a?.task);
