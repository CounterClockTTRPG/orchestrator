// Themes: the same orchestrator dressed as a fantasy guild, a present-day team or a starship crew.
// Shared by the browser (wording, role looks, portraits) and the server (names, the leader's voice).
// A theme only changes how things look and read; roles, tools and behaviour stay the same.

const FANTASY_WORDS = {
  brand: 'Guild', sigil: '✦',
  hallTitle: 'The Guild Hall',
  hallLead: 'Post a quest; the Archmage gathers a party of agents and reports back.',
  hallEmpty: 'No quests yet. The Archmage waits.',
  app: 'Realm', apps: 'Realms', newApp: 'Found a realm', otherQuests: 'Quests in no realm',
  appLead: 'A realm gathers the lands (directories) of one system. Its quests work on all of them, and the Archmage remembers their chronicles.',
  appEmpty: 'No quests in this realm yet.', appNone: 'No realm',
  post: 'Post a quest', summon: 'Summon the Archmage',
  goalHint: 'What should the party achieve? Give the context they need.',
  partySize: 'Party size', defaultPartySize: 'Default party size',
  opening: 'Opening the quest…', notFound: 'This quest could not be found.',
  fullGoal: 'Show the full quest', abandon: 'Abandon quest', abandonConfirm: 'Abandon this quest and recall the whole party?',
  inParty: 'in the party', afield: 'afield', agentsAfield: 'agents afield',
  leaderOf: 'Leader of the party', council: 'Council',
  speak: 'Speak to the Archmage: a question, guidance, or a request such as “add a tester”',
  threadEmpty: 'No words exchanged yet. Ask the Archmage anything, or ask for changes to the party.',
  pondering: 'is pondering your words…', thinking: 'Pondering…', listening: 'Awaiting dispatches',
  proposes: 'The Archmage proposes a party', dispatch: 'Dispatch the party', replan: 'Ask for a different plan',
  replanHint: 'Tell the Archmage what to change; it will propose again.', addMember: '+ Add a member',
  scroll: 'Dispatch scroll', chronicle: 'The Chronicle', guildName: 'The Guild',
  recall: 'Recall', recallTitle: 'Recall this agent',
  questStatus: { planning: 'Planning', 'awaiting-approval': 'Awaiting your approval', questing: 'On the quest', done: 'Complete', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' },
  agentStatus: { queued: 'Waiting', working: 'Questing', blocked: 'Blocked', done: 'Returned', failed: 'Fallen', cancelled: 'Recalled', interrupted: 'Interrupted' },
  leaderStatus: { thinking: 'Thinking', waiting: 'Listening', done: 'At rest', idle: 'At rest' },
  verbs: { done: 'returns', failed: 'falls' },
};

export const THEMES = {
  fantasy: {
    label: 'Fantasy', portrait: 'fantasy',
    leader: { name: 'Velothar', voice: 'a wise old archmage' },
    fullName: (name, title) => `${name} the ${title}`,
    words: FANTASY_WORDS,
    roles: {},
    // Fantasy names come from the race in the role's look (lib/names.js).
  },
  modern: {
    label: 'Present day', portrait: 'modern',
    leader: { name: 'Morgan', voice: 'a calm, experienced engineering lead' },
    fullName: (name, title) => `${name}, ${title}`,
    words: {
      ...FANTASY_WORDS,
      brand: 'Guild', sigil: '◆',
      hallTitle: 'Projects',
      hallLead: 'Start a project; the lead puts a team of agents together and reports back.',
      hallEmpty: 'No projects yet. The lead is ready.',
      app: 'Application', apps: 'Applications', newApp: 'New application', otherQuests: 'Projects outside an application',
      appLead: 'An application groups the repositories of one system. Its projects work on all of them, and the lead is briefed with earlier reports.',
      appEmpty: 'No projects in this application yet.', appNone: 'No application',
      post: 'New project', summon: 'Brief the lead',
      goalHint: 'What should the team deliver? Give the context they need.',
      partySize: 'Team size', defaultPartySize: 'Default team size',
      opening: 'Opening the project…', notFound: 'This project could not be found.',
      fullGoal: 'Show the full brief', abandon: 'Cancel project', abandonConfirm: 'Cancel this project and stop the whole team?',
      inParty: 'on the team', afield: 'working', agentsAfield: 'agents working',
      leaderOf: 'Team lead', council: 'Chat',
      speak: 'Message the lead: a question, guidance, or a request such as “add a tester”',
      threadEmpty: 'No messages yet. Ask the lead anything, or ask for changes to the team.',
      pondering: 'is typing…', thinking: 'Thinking…', listening: 'Waiting for updates',
      proposes: 'The lead proposes a team', dispatch: 'Start the team', replan: 'Ask for a different plan',
      replanHint: 'Tell the lead what to change; they will propose again.', addMember: '+ Add someone',
      scroll: 'Activity', chronicle: 'Final report', guildName: 'System',
      recall: 'Stop', recallTitle: 'Stop this agent',
      questStatus: { ...FANTASY_WORDS.questStatus, questing: 'In progress' },
      agentStatus: { queued: 'Queued', working: 'Working', blocked: 'Blocked', done: 'Done', failed: 'Failed', cancelled: 'Stopped', interrupted: 'Interrupted' },
      leaderStatus: { thinking: 'Thinking', waiting: 'Available', done: 'Done', idle: 'Idle' },
      verbs: { done: 'finishes', failed: 'fails' },
    },
    roles: {
      archmage: { title: 'Lead', describe: 'middle-aged human with short grey hair and glasses, blazer' },
      researcher: { title: 'Researcher', describe: 'young human in a hoodie' },
      auditor: { title: 'Auditor', describe: 'human with glasses in a turtleneck' },
      tester: { title: 'Tester', describe: 'human in a t-shirt' },
      implementer: { title: 'Engineer', describe: 'human with a beard in a sweater' },
      reviewer: { title: 'Reviewer', describe: 'stern human in a suit' },
      scribe: { title: 'Writer', describe: 'smiling human in a jacket' },
    },
    looks: ['human professional', 'young human in a hoodie', 'human in a jacket', 'human in a sweater'],
    names: ['Alex', 'Sam', 'Jordan', 'Priya', 'Lena', 'Tom', 'Noor', 'Mateo', 'Yuki', 'Ines', 'Femi', 'Clara', 'Ravi', 'Sofie', 'Jonas', 'Amara', 'Lucas', 'Hana', 'Omar', 'Elif', 'Bram', 'Zoe', 'Kenji', 'Maya', 'Pieter', 'Aisha', 'Daniel', 'Lotte', 'Wei', 'Nadia'],
  },
  scifi: {
    label: 'Sci-fi', portrait: 'scifi',
    leader: { name: 'Vega', voice: 'a composed starship commander' },
    fullName: (name, title) => `${title} ${name}`,
    words: {
      ...FANTASY_WORDS,
      brand: 'Guild', sigil: '✧',
      hallTitle: 'Mission control',
      hallLead: 'Launch a mission; the commander assembles a crew of agents and reports back.',
      hallEmpty: 'No missions yet. The commander stands by.',
      app: 'Sector', apps: 'Sectors', newApp: 'Chart a sector', otherQuests: 'Missions outside a sector',
      appLead: 'A sector groups the repositories of one system. Its missions cover all of them, and the commander is briefed with earlier mission reports.',
      appEmpty: 'No missions in this sector yet.', appNone: 'No sector',
      post: 'Launch a mission', summon: 'Hail the commander',
      goalHint: 'What should the crew achieve? Give the context they need.',
      partySize: 'Crew size', defaultPartySize: 'Default crew size',
      opening: 'Opening the mission…', notFound: 'This mission could not be found.',
      fullGoal: 'Show the full briefing', abandon: 'Abort mission', abandonConfirm: 'Abort this mission and recall the whole crew?',
      inParty: 'in the crew', afield: 'deployed', agentsAfield: 'agents deployed',
      leaderOf: 'Commanding the crew', council: 'Comms',
      speak: 'Hail the commander: a question, orders, or a request such as “add a tester”',
      threadEmpty: 'Channel open. Ask the commander anything, or ask for changes to the crew.',
      pondering: 'is composing a reply…', thinking: 'Computing…', listening: 'Awaiting transmissions',
      proposes: 'The commander proposes a crew', dispatch: 'Deploy the crew', replan: 'Ask for a different plan',
      replanHint: 'Tell the commander what to change; they will propose again.', addMember: '+ Add a crew member',
      scroll: 'Transmission log', chronicle: 'Mission report', guildName: 'Ship computer',
      recall: 'Recall', recallTitle: 'Recall this agent',
      questStatus: { ...FANTASY_WORDS.questStatus, questing: 'Mission under way' },
      agentStatus: { queued: 'Standing by', working: 'Deployed', blocked: 'Blocked', done: 'Returned', failed: 'Lost', cancelled: 'Recalled', interrupted: 'Interrupted' },
      leaderStatus: { thinking: 'Computing', waiting: 'On the bridge', done: 'Off duty', idle: 'Off duty' },
      verbs: { done: 'returns', failed: 'is lost' },
    },
    roles: {
      archmage: { title: 'Commander', describe: 'old human starship commander with a grey beard, high collar' },
      researcher: { title: 'Scout', describe: 'alien scout' },
      auditor: { title: 'Analyst', describe: 'android analyst' },
      tester: { title: 'Tester', describe: 'human pilot with goggles' },
      implementer: { title: 'Engineer', describe: 'stout human engineer in an exosuit' },
      reviewer: { title: 'Inspector', describe: 'stern android inspector' },
      scribe: { title: 'Archivist', describe: 'smiling alien archivist' },
    },
    looks: ['human crew member in a jumpsuit', 'android', 'alien', 'human pilot'],
    names: ['Vex', 'Orin', 'Kestrel', 'Nova', 'Juno', 'Talon', 'Lyra', 'Cass', 'Rook', 'Sable', 'Zephyr', 'Ixa', 'Corin', 'Halley', 'Tycho', 'Rhea', 'Kade', 'Mira', 'Solen', 'Quill', 'Astra', 'Dax', 'Wren', 'Ceres', 'Pax', 'Io', 'Riven', 'Echo', 'Saren', 'Calix'],
  },
};

export const THEME_IDS = Object.keys(THEMES);
export const theme = (id) => THEMES[id] ?? THEMES.fantasy;

function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return h >>> 0;
}

/** A role as it looks in a theme: its title and portrait description. Behaviour is untouched. */
export function themedRole(themeId, roleId, role) {
  const t = THEMES[themeId];
  if (!t?.looks || !role) return role; // fantasy, or a quest from before themes
  const look = t.roles[roleId];
  if (look) return { ...role, ...look };
  return { ...role, describe: t.looks[hash(roleId) % t.looks.length] };
}

/** A name from the theme's list, unique among `taken`; null for fantasy (named by race instead). */
export function themedName(themeId, taken, salt = '') {
  const list = theme(themeId).names;
  if (!list) return null;
  for (let i = 0; i < list.length * 3; i++) {
    const base = list[hash(`${salt}:${i}`) % list.length];
    const name = i < list.length ? base : `${base} ${String.fromCharCode(65 + (i % 26))}.`;
    if (!taken.has(name)) return name;
  }
  return `${list[0]} ${taken.size + 1}`;
}
