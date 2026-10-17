# Guild

A fantasy-themed orchestrator for Claude Code agents. You post a quest (a goal on a directory). A live
orchestrator agent, **the Archmage**, plans a party of subagents (scouts, auditors, smiths, testers…) and
dispatches them. It reads their reports as they arrive and steers them, then writes the **chronicle**, which is the
final result. The browser shows the whole council live, with a procedurally generated portrait for every agent.

- **Headless Claude Code:** every agent is a `claude -p` process using your existing Claude Code login. There is
  nothing to install: no npm dependencies, Node ≥ 20.
- **Read-only or edit quests:** in edit mode each agent works in its own git worktree and branch. The Archmage merges
  them into `guild/<quest>/party` and resolves conflicts. You review that branch; your checkout is never touched.
- **Applications:** group the quests on one system. An application names one or more directories (say a backend
  and its client), standing context for the Archmage, and quest defaults. A quest on it works on all its directories,
  and the Archmage is briefed with the chronicles of earlier quests on it. See [Applications](#applications).
- **Reviewed or automatic planning:** review the proposed party and its tasks in the browser (edit, add, remove) before
  dispatch, or let it go at once.
- **Task dependencies:** the plan is a graph. A member can wait for others (`after`); it starts by itself once they
  are done, with their final reports handed over, and in edit mode on a branch that already holds their work. The
  council table draws these links. If a prerequisite fails, the dependent is *held* until the Archmage (or you)
  starts it anyway, changes its task or recalls it. The queue starts the agents with the longest chain of work behind
  them first.
- **Live control:** message any agent, answer an agent that is blocked on a question, recall an agent, or abandon the
  quest.
- **Role catalog with looks:** every role has its own race, outfit and colours (auditors are hooded elves, testers are
  orcs, smiths are dwarves…). Each agent has its own face and name. The Archmage may invent new roles; you can save
  them to the catalog. Portraits come from [portraitgen](https://github.com/CounterClockTTRPG/portraitgen), vendored in
  `vendor/portraitgen/`. The art style is configurable (default: painterly). Portraits move with their state: agents
  read while they work, ponder when blocked, doze while they wait, and lip-sync what they report (*Animated portraits*
  in Settings).
- **Delivery and outside work** (edit mode): name the branch the result is for (default: the one checked out). The
  party starts from it, merges its latest work (and any other branches you name) before finishing, so clashes with
  work done meanwhile are resolved inside the quest, and then fast-forwards it on a click, or at once if you ask.
- **Check-ins:** a rule (default in Settings, e.g. "ask me before changing a balance number by more than 20%") that
  the Archmage and every agent follow: such changes wait for your answer, even with automatic planning.
- **Task titles:** every card names what that agent works on ("Fix session expiry"), set by the Archmage and editable
  in the plan review.
- **REST + SSE API and an MCP server,** so other projects and Claude Code sessions can start and follow quests.

## Running it

```bash
npm start                 # http://localhost:7777/  (listens on 0.0.0.0:7777; other machines need the token)
```

| Variable | Default | |
|---|---|---|
| `GUILD_PORT` | `7777` | HTTP port |
| `GUILD_HOST` | `0.0.0.0` | Bind address. Use `127.0.0.1` to keep it off the LAN. |
| `GUILD_TOKEN` | `GUILD_HOME/token` | Access token for other machines (made on first start). The MCP client sends it too. |
| `GUILD_ALLOWED_HOSTS` | | Extra host names the server answers to (comma-separated), e.g. a DNS name pointing at it |
| `GUILD_HOME` | `~/.guild` | Quests, settings, the role catalog, worktrees, server log |
| `GUILD_CLAUDE_BIN` | `claude` | The Claude Code executable |
| `GUILD_ALLOWED_HOSTS` | | Extra host names the server answers to, comma-separated (e.g. a reverse proxy's). Its own name, `localhost` and its IP addresses are always allowed. |

**Access.** Agents run shell commands in edit mode, so the server guards its API.
- **Token.** Requests from other machines need the token in `~/.guild/token`. At start the server prints a link for
  each LAN address (`http://<ip>:7777/#token=…`). Open it once in each browser: the page keeps the token in a cookie
  and removes it from the address bar. Clients send it as `x-guild-token`. Requests from the server's own machine
  need no token.
- **Same origin.** Writes must be JSON, and must not come from another web page (`Origin` check). The server answers
  only to its own host names and addresses, which blocks DNS rebinding.
- **Internal routes.** `/internal/*` is for the agents' MCP servers only: loopback, with a per-quest secret.
- **Directories.** A quest on `/` or on your whole home directory is refused.

The edit-mode shell itself is not sandboxed: an agent can do what you can, so post edit quests only on code you
trust Claude Code with.

To run it as a service, use a systemd user unit:

```ini
# ~/.config/systemd/user/guild.service
[Unit]
Description=Guild agent orchestrator

[Service]
ExecStart=/usr/bin/env node %h/claude/orchestrator/server.js
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload && systemctl --user enable --now guild
```

## Using it from other projects

### From Claude Code (MCP)

```bash
claude mcp add guild -- node ~/claude/orchestrator/bin/guild-mcp.js
```

Tools: `start_quest(goal, cwd?, app?, mode?, planning?, maxAgents?)`, `quest_status(id)`, `wait_for_quest(id, timeoutSec?)`,
`list_quests()`, `list_applications()`, `message_quest(id, text, agentId?)`, `resume_quest(id)`, `deliver_quest(id)` and
`cancel_quest(id)`. `start_quest` also takes `target`, `sync`, `deliver` and `checkIn`. `cwd` defaults to the session's
project. If `app` is omitted and `cwd` lies in exactly one application, the quest runs on that application
(`app: "none"` opts out). MCP quests default to automatic planning unless the application sets it. If the server isn't
running, the MCP server starts it in the background. Set `GUILD_URL` to use a server elsewhere, with `GUILD_TOKEN` set
to that server's token. A remote server is never auto-started.

### Over HTTP

An agent given only the URL can find its way: `GET /llms.txt` (plain text) and `GET /api` (JSON) describe the
API below, and the page itself points to them for clients that don't run JavaScript.

```bash
curl -s localhost:7777/api/quests -H 'content-type: application/json' \
  -d '{"goal":"Audit the auth module for security issues","cwd":"/home/me/app","mode":"read","planning":"auto"}'
curl -N localhost:7777/api/quests/<id>/events        # live events (SSE)
curl -s localhost:7777/api/quests/<id>               # full state, including the chronicle when done
```

| Method | Path | |
|---|---|---|
| POST | `/api/quests` | `{ goal, cwd?, app?, mode?: "read"\|"edit", planning?: "review"\|"auto", maxAgents?, target?, sync?, deliver?: "offer"\|"auto", checkIn? }` |
| POST | `/api/quests/:id/deliver` | fast-forward the target branch (each repository's, on an application) to a finished edit quest's result |
| GET | `/api/quests`, `/api/quests/:id` | list / full state |
| GET | `/api/quests/:id/events` | SSE: `snapshot`, then `quest`, `archmage`, `agent`, `activity`, `log`, `report`, `plan`, `roles`, `chronicle` |
| GET | `/api/events` | SSE: `state`, then `summary` (one per quest change), `settings`, `roles` |
| POST | `/api/quests/:id/plan/approve` | `{ agents?: [{ key?, role, task, after? }] }`, the plan, optionally edited |
| POST | `/api/quests/:id/message` | `{ text }` to the Archmage |
| POST | `/api/quests/:id/cancel` | abandon the quest |
| POST | `/api/quests/:id/resume` | carry on with a quest a server restart *interrupted* |
| PUT | `/api/quests/:id/app` | `{ app: id\|null }`, file the quest under an application |
| GET/POST | `/api/applications` | list / create `{ name, repos: [path \| { name, path }], description?, context?, defaults? }` |
| GET/PUT/DELETE | `/api/applications/:aid` | one application with its quests / update / delete (its quests stay) |
| POST | `/api/quests/:id/agents/:aid/message` · `/answer` · `/cancel` | `{ text }` |
| POST | `/api/quests/:id/agents/:aid/start` | start a *waiting* agent now, without the rest of its prerequisites |
| GET/PUT | `/api/roles` · POST `/api/roles/:id` | the role catalog; save an invented role with `{ quest }` |
| GET/PUT | `/api/settings` | `style`, `maxConcurrent`, `maxAgents`, `batchSeconds` |

## How it works

```
browser ─ REST/SSE ─┐                          ┌─ claude -p  the Archmage ─ MCP "council": propose_plan, recruit_agent,
other Claude Code ─ MCP (bin/guild-mcp.js) ────┤                              message_agent, answer_agent, cancel_agent,
                                    server.js ─┤                              list_party, merge_party, finish_quest
                                               └─ claude -p  agents × N  ─── MCP "guild": report_progress, ask
```

- `server.js` and `lib/guild.js` own the quests, the agent processes, the global queue (`maxConcurrent` running agents
  across all quests) and the event log; a quest's parts are split over `lib/` by concern (see DESIGN.md, "Code
  layout"). The two MCP servers (`lib/council-mcp.js`, `lib/report-mcp.js`) are tiny
  stdio processes that forward tool calls to the server's `/internal/…` routes.
- **Timestamps** in the Dispatch scroll show the clock time and how long ago it was ("10 minutes ago").
- **Reports** reach the UI at once. The Archmage gets routine progress in batches (every `batchSeconds`, default 60);
  `blocked`, `done` and `failed` wake it immediately.
- **Messages to a working agent** come back in the reply to its next `report_progress` call (agents report often).
  A finished agent is resumed with `claude --resume`.
- **`ask`** blocks the agent until you or the Archmage answer. The browser card shows the question with an answer box.
- **Edit mode:** worktrees live in `~/.guild/worktrees/<quest>/`. Agent branches are `guild/<quest>/<agent>`, the
  merged result is `guild/<quest>/party`, and leftover uncommitted work is committed before worktrees are removed.
- **Persistence:** `~/.guild/quests/<id>/quest.json` and `events.jsonl`. Quests that were running when the server
  stopped come back as *interrupted*; **Resume** restarts the Archmage and the interrupted agents from their sessions
  (`claude --resume`).
- **Replay:** stored events are numbered. A client that reconnects to `/api/quests/:id/events` with `?since=<seq>` or
  `Last-Event-ID` (EventSource sends it by itself) gets the events it missed instead of a fresh snapshot.
- **Running time** is shown for the quest and every agent (wall-clock time, less any time the server was down).

See [DESIGN.md](DESIGN.md) for the decisions behind it.

## Applications

An application is a level above quests: one system, possibly spread over several repositories.

```bash
curl -s localhost:7777/api/applications -H 'content-type: application/json' -d '{
  "name": "TTRPG platform", "description": "Campaign system and its map backend",
  "repos": ["/home/me/ttrpg2", "/home/me/dungml"],
  "context": "ttrpg2 calls dungml over HTTP (/api/dsl/render, /maps/…). Never change those routes without checking ttrpg2.",
  "defaults": { "planning": "auto" } }'
```

- **Directories.** A quest on an application may work in all of its directories. Its `cwd` (optional, inside one of
  them) is where the Archmage starts. In read-only mode the others are added with `--add-dir`.
- **Edit mode on several repositories.** Each agent gets a workspace `~/.guild/worktrees/<quest>/<agent>/` holding one
  worktree per repository (`ttrpg2/`, `dungml/`), all on branch `guild/<quest>/<agent>`. The Archmage's integration
  workspace is the same shape. `merge_party` merges repository by repository, and the result is
  `guild/<quest>/party` in each repository. With a single repository nothing changes.
- **Briefing.** The Archmage is told the application's description, its directories, and the last twelve finished
  quests on it, each with the path of its chronicle (`~/.guild/quests/<id>/chronicle.md`). For an edit quest the
  line also says whether its branch has reached your checkout, so an unmerged chronicle isn't taken as fact.
- **Standing context.** The application's context, plus a `GUILD.md` at the top of any of its directories (notes
  that are versioned with the code), goes to the Archmage and to every agent. Quests on a plain directory read its
  `GUILD.md` too.
- **Defaults.** `mode`, `planning` and `maxAgents` that a quest doesn't set come from the application, then from
  the global settings.
- **Grouping.** The hall lists applications, then the quests that belong to none. A new application can adopt the
  existing quests on its directories (`adopt: true`, a checkbox in the UI). A quest can be moved to another
  application, or to none, from its page or with `PUT /api/quests/:id/app`. That changes only the grouping (and
  later briefings), not the directories of a running quest.

Applications are stored in `~/.guild/applications.json`.

### Merging

Git decides what is merged: an agent's work counts as merged when its branch is contained in the quest branch. An
agent woken after its merge that commits again is merged again, and `finish_quest` refuses while any finished
agent has unmerged commits. To drop work on purpose (say, after `git merge --abort` on a conflict), the Archmage
calls `merge_party` with `leaveOut: [agentId]`, and should say why in the chronicle.

## Roles

The catalog is `~/.guild/roles.json`, seeded from `roles.default.json` and editable in Settings. Each role has:
`title`, `describe` (a portraitgen description: race and look), `colors`, `tools` (`read`, `edit` or an explicit tool
list), `model` (`opus`, `sonnet`, `haiku` or a model id), `blurb`, and `prompt` (standing instructions). The
orchestrator role has `orchestrator: true` and a fixed `name`.

## Development

```bash
npm test
```

The end-to-end tests (`test/e2e-*.test.js`) run whole quests in seconds without Claude: `test/helpers/e2e.js` starts
the server in the test process (`createServer` from `server.js`) on a random port with a scratch `GUILD_HOME` and
scratch git repositories, and `test/fixtures/fake-claude.js` stands in for `claude`. It speaks the same stream-json
protocol, starts the real MCP servers and calls their tools, and follows a JSON scenario: what the Archmage and each
agent say, call, commit and report. The step types are listed at the top of `fake-claude.js`.

portraitgen is vendored from `raf/portraitgen` (see `vendor/portraitgen/VENDORED.md`). To update it, copy its `src/`
again.
