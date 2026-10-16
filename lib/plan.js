// Plans as dependency graphs: each member may name, in `after`, the members whose results it needs.

/**
 * Check and normalise plan members: every member gets a `key` (t1, t2… when none is given) and an `after` list.
 * Throws a message the Archmage can act on for a duplicate key, an unknown or self reference, or a cycle.
 */
export function checkPlan(members) {
  const out = members.map((m, i) => ({
    key: String(m.key ?? '').trim() || `t${i + 1}`,
    role: m.role,
    task: m.task,
    after: [...new Set((m.after ?? []).map((k) => String(k).trim()).filter(Boolean))],
  }));
  const keys = new Map();
  for (const m of out) {
    if (keys.has(m.key)) throw new Error(`Two members share the key "${m.key}"; give each its own.`);
    keys.set(m.key, m);
  }
  for (const m of out) {
    for (const k of m.after) {
      if (k === m.key) throw new Error(`"${m.key}" cannot wait for itself.`);
      if (!keys.has(k)) throw new Error(`"${m.key}" waits for "${k}", which is not in the plan. Keys: ${[...keys.keys()].join(', ')}.`);
    }
  }
  // Depth-first search for a cycle: 1 = on the current path, 2 = done.
  const state = new Map();
  const visit = (m, path) => {
    if (state.get(m.key) === 2) return;
    if (state.get(m.key) === 1) throw new Error(`The plan has a cycle: ${[...path, m.key].join(' → ')}. Members can only wait for work that does not wait for them.`);
    state.set(m.key, 1);
    for (const k of m.after) visit(keys.get(k), [...path, m.key]);
    state.set(m.key, 2);
  };
  for (const m of out) visit(m, []);
  return out;
}

/**
 * How long a chain of work waits on each agent: 1 for an agent nobody waits for, 1 + the longest chain behind it
 * otherwise. The queue starts long chains first, so the slowest path through the plan gets going early.
 */
export function chainLengths(agents) {
  const dependents = new Map(agents.map((a) => [a.id, []]));
  for (const a of agents) for (const d of a.after ?? []) dependents.get(d)?.push(a.id);
  const memo = new Map();
  const len = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return 1; // cannot happen for a checked plan; never loop
    seen.add(id);
    const n = 1 + Math.max(0, ...(dependents.get(id) ?? []).map((d) => len(d, seen)));
    memo.set(id, n);
    return n;
  };
  return new Map(agents.map((a) => [a.id, len(a.id)]));
}
