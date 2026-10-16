// Running time of agents and quests: wall-clock time since they set out, less the time the server was down
// (pausedMs, added when an interrupted quest is resumed). Shared by the UI and the MCP server.

const FINISHED = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const ms = (ts) => (ts ? Date.parse(ts) : NaN);

/** Milliseconds an agent has been at work, or null if it never set out. */
export function agentElapsed(a, now = Date.now()) {
  if (!a?.startedAt) return null;
  // A finished agent woken by a message is working again: count up to now.
  const end = FINISHED.has(a.status) ? ms(a.finishedAt ?? a.interruptedAt) || now : now;
  return Math.max(0, end - ms(a.startedAt) - (a.pausedMs ?? 0));
}

/** Milliseconds since the quest was posted, up to its end. */
export function questElapsed(q, now = Date.now()) {
  if (!q?.createdAt) return null;
  const end = ms(q.finishedAt) || now;
  return Math.max(0, end - ms(q.createdAt) - (q.pausedMs ?? 0));
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "just now", "10 minutes ago", "2 hours ago", "yesterday". */
export function ago(ts, now = Date.now()) {
  const t = ms(ts);
  if (Number.isNaN(t)) return '';
  const s = Math.round((now - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return RELATIVE.format(-m, 'minute');
  const h = Math.round(m / 60);
  if (h < 24) return RELATIVE.format(-h, 'hour');
  return RELATIVE.format(-Math.round(h / 24), 'day');
}

/** 42s, 3m 05s, 1h 07m. */
export function duration(t) {
  if (t == null || Number.isNaN(t)) return '';
  const s = Math.floor(t / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
