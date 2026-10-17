# Guild — a fantasy-themed Claude agent orchestrator

Guild runs a *quest* (a goal on a directory) with a live orchestrator agent, the **Archmage**, who recruits a
party of Claude Code subagents. Every subagent reports back to the Archmage, and the browser shows the whole
council live, with portraitgen portraits.

## Decisions

| Topic | Decision |
|---|---|
| Agent runtime | Headless Claude Code: each agent is a `claude -p` process with `--input-format stream-json --output-format stream-json`. It uses your existing Claude Code login. |
| Work type | Per quest: **read-only** (research/analysis) or **edit** (code changes in per-agent git worktrees). |
| Planning | Per quest toggle: **review** (Archmage proposes the party and tasks, you edit and approve in the browser) or **auto** (dispatch at once). |
| Orchestrator | A **live** Claude session that receives reports, steers (messages, recruits, cancels) and finally synthesizes. |
| Wake-ups | Routine progress reports are batched and delivered about every 60 s. `blocked`, `done` and `failed` wake the Archmage at once. |
| Party shape | **Flat**: only the Archmage recruits. Subagents have the built-in Task/Agent tool disabled. The plan is a **dependency graph**: a member may wait for others (`after`) and starts by itself when they are done. |
| Edit output | Agents commit on `guild/<quest>/<agent>`. The Archmage merges them into `guild/<quest>/party` and resolves conflicts. The quest then **stops for your review**; nothing touches your main branch. |
| Non-git dir | Edit mode is refused. Read-only works anywhere. |
| Applications | An optional, **explicit** level above quests: a named set of directories (one system across repos), standing context, quest defaults. Not inferred from paths in the core, because one system often spans several repos; only the MCP client picks the application that contains `cwd` as a convenience. Quests on an application see all its directories, and edit mode gives one worktree per repo inside each agent's workspace, merged per repo. Earlier chronicles reach the Archmage as file paths in its briefing (not inlined), so it reads only the ones that matter. |
| Browser controls | Cancel an agent or the quest, message a running agent, answer a blocked agent (your answer wins over the Archmage's). |
| Roles | `roles.json` catalog (look, prompt, tools, model). The planner may **invent** a role; it gets a derived look and the UI offers *Save to catalog*. |
| Look | Same race, outfit, colours and props per role; **distinct face and name** per agent (seeded by agent name). |
| Art | portraitgen vendored in `vendor/portraitgen/` (no dependency). Render style is configurable; the default is **painterly**. |
| Interfaces | **REST + SSE** (the core; the UI uses it) and an **MCP server** for Claude Code sessions in other projects. |
| Persistence | Several quests at once, all saved to disk and browsable after a restart. |
| Guardrails | Max agents per quest (default 6), a model per role, a global concurrency cap (default 4 running agents; the rest queue). No cost budget, but cost is shown. |
| Access | Binds `0.0.0.0` on the LAN. Other machines need a **token** (`~/.guild/token`, handed out as a `#token=` link and kept in a SameSite cookie). Same-machine requests are exempt, but every write must be JSON from the server's own origin, and the Host must be one of the server's names (CSRF and DNS rebinding). `/internal` takes a per-quest secret from loopback only. |
| Hosting | Long-running service (`npm start` / systemd user unit). The MCP server auto-starts it when it isn't running. |
| Layout | **Council table**: the Archmage at the top centre, the party in an arc below, glowing threads with a dispatch orb flying up on each report, the Dispatch scroll (all reports), and the Chronicle (final result). |

## Processes

```
browser ──REST/SSE──┐                      ┌── claude -p  (Archmage)  ◄─ stdin: reports, your notes
other Claude Code ──MCP (guild-mcp)──REST──┤        └─ MCP "council": recruit / message / cancel / propose_plan / merge_party / finish_quest
                                   server.js ┤
                                           └── claude -p  (agent ×N)  ◄─ stdin: messages, answers
                                                    └─ MCP "guild": report_progress / ask
```

- **server.js** (plain Node, no dependencies) owns quests, the agent processes, the queue, the event log and
  the SSE fan-out. It serves the UI and the vendored portraitgen as static files.
- **Archmage**: one long-lived stream-json session per quest. Its MCP tools (served by `lib/council-mcp.js`, which
  forwards them to server.js over HTTP):
  - `propose_plan(agents[])` stores the plan. In review mode the quest waits for your approval and edits; in auto
    mode it dispatches at once. Each member is `{ key?, role, task, after? }`, where `after` lists the keys of the
    members whose results it needs. Duplicate keys, unknown keys and cycles are refused with the reason.
  - `recruit_agent(role, task, after?)` (`after`: agent ids), `start_agent(id)` (start a waiting agent now), `message_agent(id, text)`, `cancel_agent(id)`, `list_party()`
  - `answer_agent(id, text)` replies to a blocked agent.
  - `merge_party()` (edit mode) merges the agent branches into `guild/<quest>/party` in an integration worktree and
    returns the conflicts. The Archmage resolves them with Bash/Edit in that worktree.
  - `finish_quest(chronicle)` writes the final markdown result and ends the quest.
- **Subagents**: MCP tools from `lib/report-mcp.js`:
  - `report_progress(percent, phase, message)`, at start, after each step, and at 100 at the end.
  - `ask(question)` marks the agent *blocked* and **waits** for an answer from you or the Archmage. The answer is
    the tool result. One question is open at a time; after 4 h without an answer the agent is told to decide itself.
  - Their final message (the stream's `result` event) is their report; the server forwards it to the Archmage as `done`.
- **Live messages** to a running agent are written to its stdin as a stream-json user message and are seen at its
  next turn. If it has already finished, the session is resumed (`--resume <session_id>`) with the message.
- **Activity** (tool calls, text) is parsed from each agent's stream-json output and shown in the UI as the agent's
  current action, separate from its explicit reports.

## Edit mode and git

- Quest start: verify the target is a git repo; record `base = HEAD`.
- Each agent: `git worktree add ~/.guild/worktrees/<quest>/<agent> -b guild/<quest>/<agent> <base>`. The agent runs
  there with Edit/Write/Bash allowed and is told to commit its work.
- `merge_party`: integration worktree on `guild/<quest>/party` from `base`, merging each agent branch in order.
- End: the UI shows the combined diff (`base..guild/<quest>/party`) and the branch name. Agent worktrees are removed and
  their branches kept. Your checkout is never modified.

## Roles and looks (`roles.json`)

```jsonc
{
  "style": "painterly",
  "roles": {
    "archmage":    { "title": "Archmage",  "describe": "ancient human wizard with a long white beard, robe, circlet", "model": "opus",   "orchestrator": true },
    "researcher":  { "title": "Scout",     "describe": "tabaxi rogue with a hood",        "colors": { "clothing": "#3b4a3a" }, "tools": "read",  "model": "sonnet" },
    "auditor":     { "title": "Auditor",   "describe": "elf with a hood and a monocle",   "colors": { "clothing": "#2f3b5c" }, "tools": "read",  "model": "opus" },
    "tester":      { "title": "Tester",    "describe": "orc warrior with war paint",      "colors": { "clothing": "#5a3a2a" }, "tools": "edit",  "model": "sonnet" },
    "implementer": { "title": "Smith",     "describe": "stout dwarf with a braided beard","colors": { "clothing": "#6b4b2b" }, "tools": "edit",  "model": "opus" },
    "reviewer":    { "title": "Inquisitor","describe": "tiefling warlock with horns",     "colors": { "clothing": "#4a2a4a" }, "tools": "read",  "model": "opus" },
    "scribe":      { "title": "Bard",      "describe": "satyr bard, smiling",             "colors": { "clothing": "#7a5a2a" }, "tools": "edit",  "model": "sonnet" }
  }
}
```

- Each role also has a `prompt` (its standing instructions). `tools` is `read`, `edit` or an explicit list; in a
  read-only quest, edit tools are removed whatever the role says.
- Portrait = `generate({ theme: 'fantasy', seed: agentName, describe: role.describe, colors: role.colors, style })`, so
  the race, outfit and colours come from the role and the face from the name. Names come from per-race syllable tables.
- Expression follows state (only brows and mouth change, so the face stays recognisable): queued *neutral*,
  working *stern*, blocked *surprised*, done *smile*, failed *sad*, cancelled *tired*.
- **Motion** (portraitgen emotes, on the large portraits; `web/motion.js`): working agents read down the page (Guild's
  own `work` emote), blocked agents and a thinking Archmage ponder (`thinking`), agents waiting for others,
  interrupted ones and a resting Archmage sleep (`sleep`, snoring), the rest blink and breathe. When the Archmage
  says something or an agent reports, its portrait lip-syncs the line (`talk` with `say`) for a few seconds. Each
  animated variant gets its own SVG id prefix, since the animation CSS is page-wide. Settings: *Animated portraits*;
  viewers who prefer reduced motion see still portraits.
- **Task titles:** each plan member has a `title` (two to six words, required in `propose_plan`, optional in
  `recruit_agent`), stored on the agent as `taskTitle` and shown in bold on its card, in its details, in the quest
  summary and in `list_party`. Without one, the first sentence of the task is used (`web/titles.js`).
- Invented role: the archetype and palette are hashed from the role name, so the same name always looks the same.

## REST + SSE (port 7777)

| Method | Path | |
|---|---|---|
| POST | `/api/quests` | `{ goal, cwd, mode: "read"\|"edit", planning: "review"\|"auto", maxAgents? }` returns the quest |
| GET | `/api/quests` / `/api/quests/:id` | list / full state |
| GET | `/api/quests/:id/events` | SSE: `snapshot`, then `agent`, `report`, `activity`, `plan`, `chronicle`, `quest` events. Stored events carry an id (`seq`); `?since=<seq>` or `Last-Event-ID` replays the ones after it instead of the snapshot |
| GET | `/api/events` | SSE for all quests (the list view) |
| POST | `/api/quests/:id/plan/approve` | `{ agents[] }` (edited plan, with `key` and `after`) dispatches |
| POST | `/api/quests/:id/agents/:aid/start` | start a waiting agent now |
| POST | `/api/quests/:id/cancel` · `/agents/:aid/cancel` | cancel |
| POST | `/api/quests/:id/resume` | resume an *interrupted* quest |
| POST | `/api/quests/:id/agents/:aid/message` · `/answer` | `{ text }` |
| POST | `/api/quests/:id/message` | a note to the Archmage |
| GET/PUT | `/api/roles` | role catalog; `POST /api/roles/:id` saves an invented role |
| GET/PUT | `/api/settings` | concurrency cap, default style, default models |

Internal (MCP tools to server, the same HTTP): `/internal/quests/:id/...`.

## MCP server for other projects (`bin/guild-mcp.js`)

Add it once with `claude mcp add guild -- node ~/claude/orchestrator/bin/guild-mcp.js`. Tools:
`start_quest(goal, cwd?, mode?, planning?, maxAgents?)` (cwd defaults to the caller's directory) returns the id and
the browser URL; also `quest_status(id)`, `wait_for_quest(id, timeoutSec?)` (returns the chronicle when done),
`list_quests()`, `message_quest(id, text)`, `resume_quest(id)` and `cancel_quest(id)`. If the server isn't reachable, it starts it
detached and retries.

## Storage

`~/.guild/quests/<id>/` holds `quest.json` (the state), `events.jsonl` (append-only; the SSE replay source) and the
MCP configs; worktrees live under `~/.guild/worktrees/<id>/`. Quest ids are the date plus 8 random hex digits
(`20261017-1a2b3c4d`), drawn again if a quest, its directory or its worktrees already use one.

**What `quest.json` holds:** the goal, mode and directories, the repositories and branches (edit mode), the plan, the
Archmage (session id, cost, its open question to you) and every agent (status, task, reports, session id, branch and
worktrees, notes not yet delivered, and its open question `ask`: `{ id, question, human, askedAt, deadline }`), the
log, the chronicle and delivery, and `pending`: what the Archmage has not taken in yet:
- `messages`: its inbox (reports, dispatches and your messages waiting for the next batch), with in front the batch of
  a turn that had not ended (the process may die before it does; its first message is already in its session),
- `humanWaiting`: one of them is from you, so the turn that gets them answers you,
- `nudges`: how often it was reminded, per kind (`plan`, `waiting`, `finish`).

**Saves:** a change is saved 300 ms after the last event (one write for a burst), and at once where it matters
(interrupting, the end of a quest). Each write goes to its own temp file (`quest.json.<pid>-<random>.tmp`), then is
renamed over the old one, so a crash leaves the old file or the new one, never half of one. A failed write (a full
disk) is logged and the quest goes on. quest.json may lag the event log after a crash, so `seq` is taken from
`events.jsonl` on load.

**Shutdown** (SIGINT, SIGTERM): `guild.stopping` is set, so nothing starts, ends or is revived any more, and no
quest can be posted. Each running quest logs that the server is stopping, is marked **interrupted** (its status
before is kept as `resumeStatus`), its working, queued and blocked agents too (waiting ones stay `waiting`), and is
saved at once. Only then are its sessions killed and awaited, so their exits revive nobody and fail nobody. A quest
that was already ending gets 5 s to finish. Pending saves are written, and the process exits (after 10 s whatever
happens; a second signal is ignored). A server that died without this finds its running quests on the next start and
marks them interrupted the same way.

**Resume** (`POST /api/quests/:id/resume`, the *Resume* button, MCP `resume_quest`), only for an *interrupted* quest:
- restores the status it had and checks the worktrees: one removed meanwhile is made again from its branch, commits
  and all (the integration worktree of each repository, and each interrupted agent's),
- revives the Archmage with `claude --resume` and a briefing: who is resuming, who is waiting on a question, its own
  open question to you, and the party report,
- then delivers the restored inbox to it as one urgent batch (answering you if `humanWaiting`), and keeps the nudge
  counts; the retry count of failed turns starts afresh,
- restarts each interrupted agent with `--resume` in its worktree, told that it was interrupted; an agent that never
  set out starts afresh,
- re-asks open questions: an agent that was blocked on one is `blocked` again with the same question, shown on its
  card, in the party report and to the Archmage (`[blocked]` or `[check-in]`). Its session is not started (it holds no
  slot); the answer from you or the Archmage, or the deadline, wakes it with `--resume` and the reply. The downtime
  does not count against its deadline,
- leaves waiting agents waiting: they set out when their prerequisites finish, as before,
- keeps the downtime in `pausedMs`, left out of running times.

## Lifecycle safeguards

Fixed after the self-analysis (lifecycle bugs 1–15 in `guild-self-analysis.md`):
- **Processes:** every claude process is spawned in its own process group (`detached`), and a kill signals the group
  (SIGTERM, then SIGKILL after 3 s), so background commands an agent started through Bash die with it. A quest's
  worktrees are removed only once every process in them has exited (the Archmage gets a minute to finish its turn).
- **Sessions:** only an agent's current session speaks for it. Waking an agent retires its old session; that one's
  late exit only gives back its slot, and the new `--resume` process waits for it to be gone, so one session id never
  has two processes. An agent recalled, or a quest ended or interrupted, while it was being set up does not start.
- **Asks:** an agent has one open question at a time (a new one withdraws the old), with a deadline of 4 h after which
  it is told to decide for itself. Its question is settled when its session ends, and only a `blocked` agent can be
  answered.
- **Nudges** are counted per kind (no plan: 2, waiting agents nobody will release: 3, party finished: 3) and reset
  after a turn that moves the quest on or answers you, so talking with you after the party finishes cannot fail it.
- **Failed turns:** an `is_error` result (rate limit, credit, overload) is not a stall: the same batch is sent again
  after 5 s, doubling up to 5 min, 8 times; then the quest fails with the reason. A batch written into a dead pipe, or
  given in a turn whose process died, goes back into the inbox for the revived Archmage.
- **Errors:** each session event handler is guarded: an error fails that agent (or is logged, for the Archmage), never
  the server. The process logs unhandled rejections and exceptions and keeps serving. `end()` runs once.
- **SSE:** a client with more than 4 MB unread is dropped; it reconnects and replays from its last event id.

## UI

- Header: the quest list (status pills and portraits of the party) and *New quest* (goal, directory, mode, planning,
  party size).
- Council table: the Archmage card (portrait, current thought, cost) at the top; the party arc below. Each card shows
  the portrait, name, role, task, progress rune-bar, phase, current tool activity and controls (message, cancel,
  answer when blocked). SVG threads link the cards to the Archmage; an orb travels up on each report.
- Review mode: before dispatch, the cards appear as *unsigned contracts* with editable tasks and roles, add/remove,
  and **Dispatch**.
- Dispatch scroll: a timeline of every report and Archmage action. Chronicle: the final markdown, plus the diff and
  branch name in edit mode.
- Settings: render style (default painterly), concurrency cap, the role catalog with portrait previews.

## Refinements made while building v1

- **The quest branch is `guild/<quest>/party`,** not `guild/<quest>`: git cannot hold both a branch `guild/<quest>` and
  branches under `guild/<quest>/…`.
- **Live messages to a working agent** arrive in the reply to its next `report_progress` call. A stream-json message
  written to a busy session is only read after the whole turn, and for a subagent that is the entire task. Messages
  still undelivered when its turn ends start a new turn; a finished agent is resumed with `--resume`.
- **Edit-mode agents and the Archmage run with `--permission-mode acceptEdits`,** with Edit, Write and Bash in their
  allowed tools.
- **Invented roles are sanitised:** only title, describe, tools and prompt are kept. The id must be a slug, and the
  colours are generated as hex.

## Delivering into work outside the quest

- **Target branch** (edit mode): `target`, by default the branch checked out in `cwd`. The party starts from its
  latest commit. When the quest is done, Guild records the final commit (`delivery`) and fast-forwards the target to it
  on request (*Fast-forward* in the Chronicle, `POST /api/quests/:id/deliver`, MCP `deliver_quest`), or at once with
  `deliver: 'auto'`. Only fast-forwards: if the target moved on after the last merge, Guild says so and leaves the
  merge to you. A target checked out in a worktree is fast-forwarded there (its files follow), and never over
  uncommitted changes.
- **Outside work** (`sync`: the target plus any branches you name): `merge_party` also merges their latest commits
  into the quest branch, so clashes with work done meanwhile surface as conflicts for the Archmage, who then re-runs
  the checks. `finish_quest` refuses while any of them has commits the quest branch does not contain.
- **Check-ins** (`checkIn`, default from Settings, `''` for none): the rule is in the Archmage's and every agent's
  instructions. Agents ask with `ask(question, human: true)`; such a question waits for the human, and
  `answer_agent` refuses it. The Archmage asks with `ask_human`. Agents list every design number they changed in
  their final report.

## Task dependencies

- On dispatch the whole party is recruited. Members with unfinished prerequisites are `waiting`: they hold no
  concurrency slot and are not queued.
- When an agent finishes `done`, every waiting agent whose prerequisites are all done is scheduled. No Archmage turn
  is needed; it is told `[started]` in its next batch.
- **Handoff:** a dependent's first message carries each prerequisite's final report and the names of their attached
  files.
- **Edit mode:** a dependent's branch starts from its first prerequisite's branch, and the others are merged in. Merge
  conflicts become the agent's first step. Its `commits` count only its own work (from `startRef`).
- **A failed or recalled prerequisite** holds its dependents, and the Archmage is woken (`[held]`) to `start_agent`,
  `message_agent` or `cancel_agent`. If nobody is working and agents still wait, the Archmage is reminded three
  times, then the waiting agents are recalled.
- **Queue order:** agents whose chain of dependents is longest start first; equal ones in arrival order.
- **Interruptions:** waiting agents stay waiting when the server stops and through a resume; they set out once their
  prerequisites (resumed themselves) are done.

## Code layout (`lib/`)

`guild.js` was one 1500-line file; it is now split by concern. `Quest` stays one class, with its state on
`quest.s`, but its methods live in several files: each module exports a group of methods that `quest.js` copies
onto `Quest.prototype` (`mixin` in `common.js`, which refuses a name defined twice). The methods still call each
other through `this`, so a test can replace one on an instance, and no module imports another's methods, so there
are no import cycles.

| Module | What it holds |
|---|---|
| `guild.js` | `Guild`: the quest registry, settings, the role catalog, `createQuest`. Re-exports `Quest`, `cleanRole` and `tooBroad` |
| `quest.js` | `Quest`: state, events and saving, the log, agents and cost; lifecycle (interrupt, resume, finish, cancel, fail, end) |
| `archmage.js` | the Archmage's session, inbox and flushing, nudges, revival, talk with the human, the council tool dispatch |
| `party.js` | plan and approval, recruiting, `after` dependencies, scheduling and agent sessions, reports, asks, answers, messages, recalls, the party report |
| `workspace.js` | repositories of a new quest, integration and agent worktrees, commit tallies, merging the party, finish checks, delivery, cleanup |
| `roles.js` | `cleanRole`, invented roles, the tool tiers and permissions of the Archmage and of members |
| `prompts.js` | pure builders of the system prompts, briefings and first messages (no I/O: callers pass files and history in) |
| `attachments.js` | file types and size limit, path checks, attaching and serving files |
| `scheduler.js` | `Scheduler`: the global slots and the priority queue; `Guild` delegates `acquire`, `release` and `dequeue` to it |
| `applications.js` | the `Guild` methods for applications (list, save, adopt, delete, history); `apps.js` keeps the pure helpers |
| `common.js` | constants and helpers the quest modules share (`ACTIVE`, `FINISHED_AGENT`, `now`, `clip`, `mixin`) |

## End-to-end tests

- `server.js` exports `createServer(guild, { token, hosts })` and listens only when run as the main module, so a
  test runs the real server in its own process on port 0. `node server.js` and the systemd unit are unchanged.
- `GUILD_HOME` (lib/store.js) and `GUILD_CLAUDE_BIN` (lib/claude.js) are read at import, so `test/helpers/e2e.js`
  sets them and then imports the server: one Guild per test file, which `node --test` runs in its own process.
- `test/fixtures/fake-claude.js` replaces `claude`, not Guild's code: it parses the same flags (an unknown one fails
  loudly), speaks stream-json, and starts the MCP servers from `--mcp-config`, so `/internal` and the quest secrets
  are exercised for real. Each session follows a script chosen from a JSON scenario by matching its system prompt
  and first message; `--resume` goes on from where the session stopped, or runs the entry's `resume` steps.
- Teardown marks the quests interrupted before killing the sessions, so no Archmage is revived (lifecycle bug 1),
  waits for them to exit, and only then removes the scratch home. `h.restart()` does the same, then loads a fresh
  Guild on the same home, for resume tests; `test/e2e-shutdown.test.js` stops the real `node server.js` with SIGTERM.

## Out of scope for v1

Auth, cost budgets, nested recruiting, pushing or opening PRs. (Resuming interrupted quests, and the API token with
per-quest secrets for `/internal`, were added after v1.)
