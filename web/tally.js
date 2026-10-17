// How many quests are in each state, for the compact badges on applications. Shared by the browser and tests.

// In the order the badges show; quests needing the human come first.
export const TALLY_GROUPS = [
  { key: 'awaiting-approval', statuses: ['awaiting-approval'] },
  { key: 'questing', statuses: ['planning', 'questing'] },
  { key: 'interrupted', statuses: ['interrupted'] },
  { key: 'done', statuses: ['done'] },
  { key: 'failed', statuses: ['failed'] },
  { key: 'cancelled', statuses: ['cancelled'] },
];

/** [{ key, n }] for the groups that have quests, in badge order. */
export function questTally(quests) {
  return TALLY_GROUPS
    .map(({ key, statuses }) => ({ key, n: quests.filter((q) => statuses.includes(q.status)).length }))
    .filter((g) => g.n > 0);
}
