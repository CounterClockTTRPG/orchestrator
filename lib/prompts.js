// What the Archmage and the party are told. Pure builders: they read a quest (`q`: its state `q.s`, `q.multi`,
// `q.guild.roles`, `q.agent(id)`) and what the caller gathered (files, history), and return text. No I/O, no changes.

import { themedRole, theme } from '../web/themes.js';
import { appBriefing } from './apps.js';
import { clip } from './common.js';

/** The Archmage's system prompt: its role, the quest's mode, the role catalog and how a quest goes. */
export function archmageSystemPrompt(q) {
  const s = q.s, a = s.archmage;
  const roles = Object.entries(q.guild.roles)
    .filter(([, r]) => !r.orchestrator)
    .map(([id, r]) => `- ${id}: ${themedRole(s.theme, id, r).title} — ${r.blurb ?? ''} (tools: ${r.tools ?? 'read'}${r.model ? `, model ${r.model}` : ''})`)
    .join('\n');
  const edit = s.mode === 'edit';
  return [
    `You are ${a.name} the ${a.title}, leader of a guild party of Claude Code agents. You orchestrate; the party does the work.`,
    ``,
    `Quest mode: ${edit ? 'EDIT — party members change code, each in its own git worktree and branch' : 'READ-ONLY — nobody modifies files'}.`,
    `Planning: ${s.planning === 'review' ? 'REVIEW — the human approves your plan before dispatch' : 'AUTO — your plan is dispatched at once'}.`,
    `Party limit: at most ${s.maxAgents} agents in total for this quest.`,
    ``,
    `Role catalog:`,
    roles,
    ``,
    `How a quest goes:`,
    `1. Look around briefly if it helps you plan (Read/Glob/Grep). Keep it short; the party does the deep work.`,
    `2. Call propose_plan once. Each member gets a role and a complete, self-contained task: they do not see the quest or each other's work unless you tell them. Prefer parallel tasks that do not overlap${edit ? ' (in edit mode, avoid two agents editing the same files)' : ''}. Invent a role (newRoles) only if no catalog role fits. Then end your turn.`,
    `   Give each member a title: two to six words naming its task ("Fix session expiry"), shown on its card so the human sees who works on what.`,
    `   The plan is a graph: give each member a short key, and list in its after the keys of the members whose results it needs. A member with after waits, then starts by itself once all of those are done, with their final reports handed to it${edit ? ' and its branch starting from their work' : ''}; you need not relay anything. Plan wide: use after only where a task truly needs another's findings or code, so that everything else runs at once.`,
    `   If a member's prerequisite fails or is recalled, it is held and you are told: start_agent to send it anyway, message_agent to change its task first, or cancel_agent. recruit_agent also takes after (agent ids) for follow-up work.`,
    `3. You then receive dispatches as messages: progress reports, questions from blocked agents, and final reports. React only when it helps: answer_agent for questions, message_agent to correct course, recruit_agent for follow-up work, cancel_agent for a stuck or redundant agent. Otherwise end your turn at once with a one-line remark; every turn costs tokens.`,
    edit
      ? `4. When everyone is finished, call merge_party. ${q.multi
        ? `Your working directory holds one integration worktree per repository (${s.repos.map((r) => `${r.name}/`).join(', ')}), each on branch ${s.repos[0].branch}. Resolve any conflicts in the repository merge_party names (edit, git add, git commit there)`
        : `Your working directory is the integration worktree on branch ${s.repos[0].branch}. Resolve any conflicts there (edit, git add, git commit)`} and call merge_party again until all is merged.${syncNote(q)} Run the build and checks there after the last merge. Then call finish_quest; it refuses while there is unmerged work.`
      : `4. When everyone is finished, call finish_quest.`,
    `   The chronicle is the deliverable: a complete markdown answer to the quest for the human, synthesised from the reports (not a list of who did what), crediting agents by name where useful.`,
    ``,
    `Voice: your visible text is shown on the council table, so keep it to one or two lines, in character as ${theme(s.theme).leader.voice}. Write tasks and the chronicle in plain, precise language.`,
    `Messages from "the human" come from the person overseeing the quest; their instructions override yours.`,
    s.checkIn
      ? `Check-ins: the human approves these changes personally: "${s.checkIn}" Do not make or approve such a change yourself, even in automatic planning: if your plan or a decision needs one, call ask_human with the current and proposed values and why. Party members ask the human directly (a [check-in]); never answer those for them. Tell members in their tasks when their work is likely to touch such a change.`
      : '',
    ``,
    `Talking with the human: they can message you at any time, to give guidance, ask you questions or make requests ("add a tester", "explain the plan").`,
    `- When a message comes from the human, answer them directly. That reply may be as long as it needs to be and may use markdown; the one-or-two-line rule is for your other remarks.`,
    `- Act on their requests with your tools: in review mode before approval, call propose_plan again with the revised party; once the party is dispatched, use recruit_agent, message_agent or cancel_agent. Say what you did.`,
    `- To show the human a file (a screenshot, a page, a report), call attach_file; your party attaches their own files the same way.`,
    `- When you need a decision only the human can make (an install or download, spending, a change of scope, anything risky), call ask_human instead of writing the question in your text, then end your turn. Do not wait idle: the party keeps working meanwhile.`,
  ].join('\n');
}

/** For the Archmage's instructions: merge_party also brings in work done outside the quest. */
export function syncNote(q) {
  const synced = (q.s.repos ?? []).filter((r) => r.sync?.length);
  if (!synced.length) return '';
  const what = synced.map((r) => `${r.sync.join(', ')}${q.multi ? ` (${r.name})` : ''}`).join('; ');
  const targets = synced.filter((r) => r.target).map((r) => `${r.target}${q.multi ? ` in ${r.name}` : ''}`);
  return ` merge_party also brings in the latest of ${what}: work done outside the quest meanwhile${targets.length ? ` (${targets.join(', ')} ${targets.length > 1 ? 'are' : 'is'} where the result is delivered)` : ''}. Resolve clashes with it keeping both sides' intent, then check the screens and code both sides touch.`;
}

/**
 * The Archmage's first message: the goal, the standing `context`, and for an application its briefing with the
 * earlier quests (`history`).
 */
export function archmageBriefing(q, { app, history, context }) {
  const s = q.s, edit = s.mode === 'edit';
  const lines = [`The quest: ${s.goal}`, ``];
  if (context) lines.push(context, ``, `Agents get this context too; you need not repeat it in their tasks.`, ``);
  if (app) {
    lines.push(appBriefing(app, history, { edit }), ``,
      `Start directory: ${s.cwd}${edit ? ` (you work in ${s.archmage.workdir}, which holds ${q.multi ? 'an integration worktree of each repository' : 'the integration worktree'})` : ''}`);
  } else {
    lines.push(`Directory: ${s.cwd}${edit ? ` (you work in the integration worktree ${s.archmage.workdir})` : ''}`);
  }
  for (const r of s.repos ?? []) {
    if (r.dirty) lines.push(`Note: the human's checkout of ${r.name} has uncommitted changes; the party works from the last commit (${r.base.slice(0, 8)}).`);
  }
  lines.push(``, `Plan the party and call propose_plan.`);
  return lines.join('\n');
}

/** What the Archmage is told when the human resumes an interrupted quest. `party` is the party report. */
export function resumeBriefing({ resumed, party, status }) {
  const next = {
    planning: 'You had not proposed a plan yet: call propose_plan.',
    'awaiting-approval': 'Your plan still awaits the human\'s approval. End your turn.',
    questing: 'Carry on leading the quest; dispatches will follow.',
  }[status];
  return [
    `The Guild server stopped and interrupted the quest; the human has now resumed it.`,
    resumed ? `These agents were interrupted and are resuming: ${resumed}.` : '',
    `The party now:\n${party}`,
    next,
  ].filter(Boolean).join('\n\n');
}

/** A party member's system prompt: who it is, how to report, and where it works. */
export function agentSystemPrompt(q, a, role, context) {
  const s = q.s, edit = s.mode === 'edit';
  const canEdit = edit && role.tools !== 'read';
  const lines = [
    `You are ${a.name}, the ${role.title} in a guild party of Claude Code agents led by ${s.archmage.name} the Archmage.`,
    role.prompt ?? '',
    ``,
    `Reporting: call mcp__guild__report_progress when you start (a low percent and your plan in one sentence), after each meaningful step, and with percent 100 at the end. Its reply may carry messages from the Archmage or the human: follow them.`,
    `If you are blocked on a decision you cannot reasonably make yourself, call mcp__guild__ask; it waits for the answer. Do not ask about things you can find out.`,
    s.checkIn
      ? `Check-ins: the human approves these changes personally: "${s.checkIn}" Before making a change this covers, call mcp__guild__ask with human: true, giving what you want to change, the current and proposed values, and why; then do what they decide. In your final report, list every design or balance number you changed, with old and new values.`
      : '',
    `When you make something the human should look at (screenshots, rendered pages, charts, a PDF or a written report), call mcp__guild__attach_file with its path and a one-line caption; it is shown in the interface. Mention attached files in your report.`,
    `Your final message is your report to the Archmage: concise but complete and concrete (paths with line numbers, commands, results, open questions).`,
    canEdit && q.multi
      ? `You work in your own workspace at ${a.dir}: it holds a git worktree of each repository (${s.repos.map((r) => `${r.name}/`).join(', ')}), all on branch ${a.branch}; other agents work in parallel on their own branches. Stay inside that directory. Commit your work in each repository you change, with clear messages, before your final report. Do not push and do not switch branches.`
      : canEdit
        ? `You work in your own git worktree at ${a.dir} on branch ${a.branch}; other agents work in parallel on their own branches. Stay inside that directory. Commit your work with clear messages before your final report. Do not push and do not switch branches.`
        : `This is a read-only task: do not modify any files.`,
  ];
  if (!edit && s.dirs.length > 1) lines.push(`The quest's directories: ${s.dirs.map((d) => `${d.name} (${d.path})`).join(', ')}.`);
  if (context) lines.push(``, context);
  return lines.join('\n');
}

/** A party member's first message: its task, the quest, its prerequisites' reports, conflicts and waiting notes. */
export function agentFirstMessage(q, a, { conflicts = [], notes = [] } = {}) {
  return [
    `Your task:\n${a.task}`,
    ``,
    `(For context, the party's quest: ${q.s.goal})`,
    handoff(q, a),
    conflicts.length ? `\nFirst: combining your prerequisites' branches left merge conflicts in ${conflicts.join(', ')}. Resolve them in your worktree (edit, git add, git commit), then do your task.` : '',
    notes.length ? `\nMessages for you:\n${notes.map((n) => `- ${n}`).join('\n')}` : '',
  ].join('\n');
}

/** What a dependent agent is handed when it sets out: its prerequisites' final reports and files. */
export function handoff(q, a) {
  if (!a.after?.length) return '';
  const parts = a.after.map((id) => {
    const d = q.agent(id);
    const files = (q.s.attachments ?? []).filter((f) => f.who === d.id).map((f) => f.name);
    return [
      `### ${d.name} the ${d.title} (${d.id}), ${d.status}`,
      clip(d.result ?? '(no final report)', 6000),
      files.length ? `Files they attached: ${files.join(', ')}` : '',
      d.status === 'done' && d.commits && a.branch ? `Their branch ${d.branch} is merged into yours.` : '',
    ].filter(Boolean).join('\n');
  });
  return `\n\nYour task builds on work by others in the party. Their final reports:\n\n${parts.join('\n\n')}`;
}
