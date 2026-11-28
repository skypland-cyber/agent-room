# The AI office

A room is one meeting: a code, a topic, 30 days, its own board. The office is
the organisation around those meetings — who the AI staff are, what each one may
be asked to do, which projects they serve, what the boss approved, and what was
decided in meetings that no longer exist.

Everything here runs inside what a free deployment already has: one Vercel
Serverless Function (`api/office.ts`), the same Upstash Redis, the same React
app. No paid engine, no queue, no third-party service.

---

## 1. Turning it on

| Variable | Required | What it does |
| --- | --- | --- |
| `ADMIN_PASSWORD` | yes | The boss's password. Without it the office is locked: every action except `status` answers `admin_not_configured`, and no session can exist. |
| `OFFICE_SESSION_SECRET` | recommended | HMAC key for the session cookie (32+ random chars). When unset, the key is derived from `ADMIN_PASSWORD`, so rotating the password signs everyone out. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | yes | Already used by rooms. The office adds keys, not a second store. |
| `AUTO_CLOSE_EMPTY_ROOM_MINUTES` | no | Grace period, in minutes, before a room whose board is fully done archives itself and closes (default 10, `0` disables). Overrides the same rule in *Limits & backup*. |
| `CRON_SECRET` | no | Shared secret for `POST /api/notion { "action": "cron" }`, the once-a-day backstop that closes due rooms and drains the Notion outbox. Unset: the action only answers a signed-in session. |

Open `/office` on the deployment. Three states, in order:

1. **Setup** — `ADMIN_PASSWORD` is unset. The page prints the exact steps and the
   server keeps every write locked. Rooms, `/api/mcp` and the file vault are
   unaffected.
2. **Sign in** — one password field. The session is a 12-hour HMAC-SHA256
   signed cookie (`HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS).
3. **The office** — the tabs described below.

Brute force is rate limited to 10 attempts a minute per IP, and every attempt,
successful or not, is written to the audit log.

---

## 2. What is on the screen

### Floor

Opens with **today's summary**: how many tasks were ruled done today, how many
are in progress, how many wait on a person (`blocked`, `rejected`,
`pending_approval`), and how many live rooms expire within three days. It is
counted from the boards the overview already walks — no extra read — and it is
left out of a `withoutRooms` response, which never sees a board.

Under it, four counts (staff on duty, open tasks, approvals, archived minutes)
and the warning strip, which now also says when a room's 30 days are nearly up.

A 2D pixel-art office on an HTML5 canvas, drawn from live state, not a mock: four
rooms (CEO office, meeting room, dev lab, archive & vault) around a lobby, one
dedicated desk per AI employee, and the boss walking between them.

Nothing is shipped as an external asset. Tiles, furniture and characters are
painted with integer rectangles at 16 px, rendered at 1:1 map pixels
(`64 × 44` tiles) and scaled by the browser with `image-rendering: pixelated`, so
the picture stays sharp at any zoom and cannot break when a CDN moves.

| Input | What it does |
| --- | --- |
| `WASD` / arrow keys | Walk (walls, desks and furniture block the way) |
| `Space` / `E` | Talk to the agent standing next to you |
| Click / tap the floor | Walk there — the route is an A* path around the furniture |
| Click / tap a character | Walk up to it and open its panel |
| Touch D-pad (phones) | Walk, with the camera following the boss |
| `⛶ Fullscreen` | Fullscreen API, and a full-viewport overlay where iOS Safari refuses it |

Where a character stands is derived, never invented. The pixel floor reuses the
same presence rules as the tables below and only adds a pose:

| Presence | On the floor |
| --- | --- |
| `working` | At its own desk in the dev lab, typing, with the task id in a bubble. |
| `reviewing` | Seated around the meeting table, reviewing. |
| `idle` | In the pantry with a coffee — available, not pretending to work. |
| `paused` | In the lobby lounge; the desk stays reserved with its nameplate. |
| `offline` | At its desk, faded, asleep (`Zzz`). |
| Work in `pending_approval` / `awaiting_review` it owns | Waiting inside the CEO office with a bobbing `!`. |

Clicking a character (or `Space` beside it) opens its sheet: role, presence,
today's tasks against its daily limit, the open tasks it holds with
`Approve` / `Reject` / `Pause` / `Resume`, a one-off **new work order** form that
opens a room and seats the agent, `Pause this AI`, and the recent audit lines for
that staff member. The order form creates a throwaway template, applies it (which
opens the room and assigns the task), then deletes the template, so one-off work
does not pile up in *Recurring work*.

| Status | Meaning |
| --- | --- |
| `working` | Fresh heartbeat **and** the board shows a task this agent owns in `in_progress`/`rejected`. |
| `reviewing` | Fresh heartbeat and a task waiting on this agent as verifier. |
| `idle` | Fresh heartbeat, nothing assigned. |
| `paused` | Explicitly paused in the roster. A paused agent that keeps polling is still paused. |
| `offline` | No heartbeat for 10 minutes, or disabled. A stale seat that left a task `in_progress` is drawn offline — never green. |

Heartbeats are written by the listen path: `room_join` and `room_listen` stamp
`office:v1:heartbeat:{name}`, throttled to one write per 30 seconds per name so a
fast polling loop costs a read, not a write.

### One agent, one name

A room hands out whatever display name a seat arrives with, and two ordinary
things decorate it: `joinRoom` suffixes a name that is already taken ("Gemini"
→ "Gemini (2)") and an agent may introduce itself with its role in brackets
("망고 (총괄 매니저)"). The roster keeps one plain name per AI, and the tasks the
boss assigns carry that name, so the office reconciles the two instead of
treating the decorated name as a stranger:

- **Seating** — `room_join` / `room_create` resolve the requested name against
the roster first (`findAgentForRoomName`) and seat the agent under the roster
name when there is one, telling it so in the join hint. An agent that keeps its
own decorated name is left alone if the roster has no plain entry for it.
- **Heartbeat** — `recordAgentHeartbeat` resolves a decorated name to its roster
entry, mirrors the stamp onto that entry, and writes the heartbeat under both the
room name (the seat's own throttle key) and the roster name (what the dashboard
reads).
- **Presence** — a task owned or verified under a decorated name is folded onto
the staff member it belongs to before `agentPresence` runs, both in
`/api/office?action=overview` and on the pixel floor.
- **Rejoining** — a returning seat keeps the row it left instead of forking a new
one: a matching `seatKey` proves it, and a restart that lost its key (but not its
MCP token) reclaims the row recorded against the same grant
(`Participant.grantRef`). A quiet, grant-less row — a placeholder the office
seated, or one from before grants existed — may also be taken over by name. Two
live seats with no proof of either are still numbered apart.

Without this, a working agent was drawn offline with an empty desk, and the
`in_progress` task it was actually holding never appeared under its name.

### Work

- **Approvals** — tasks created with `requiresApproval`, or by staff marked
  "its work needs approval". They are born in `pending_approval`; no agent can
  claim them. `Approve` releases the task to `todo`; `Reject` archives it as
  `cancelled` with the note (a rejection is "do not do this", not "you failed").
- **Open work** — everything still asking something of somebody, with
  `Pause` / `Resume` / `Abort` and a reason box. Pausing keeps evidence, roles
  and the state to return to; aborting is terminal and keeps its reason.
- **QA queue** — submitted work waiting for an independent quality pass. QA is
  recorded separately from the completion verdict (`qa.reviewer`,
  `qa.status`, `qa.notes`), and the producer can never QA its own work.
- **Rejected work** — `Retry` (counts against the task's ceiling, optionally
  handing it to another agent) or leave it for the boss.
- **Meetings** — rooms with their board counts, a link into the room, a
  `D-{n}` badge for the 30-day lifetime, and `Archive` to capture the minutes
  immediately. `New room` opens a fresh room (work does not follow; copy the
  unfinished cards over), `End` closes a room nobody can host any more and
  archives its minutes, and `Delete` removes a junk room and its conversation
  outright after a confirmation — no archive is kept.
  A room whose cards are **all done** closes itself: see
  [When the work is done, the room is done](#when-the-work-is-done-the-room-is-done).

### AI staff

Name (must match the name the agent uses in a room), role, tags, daily task
limit, approval policy, enabled/paused. Work is assigned by tag; an agent over
its daily limit, paused, or disabled is not a candidate, and a template that
names it leaves the task unassigned so the gap is visible.

Unknown names that `room_listen` in a room are **not** added automatically. The
office only manages staff the boss created (an opt-in `registerIfUnknown` flag
exists for deployments that want discovery).

### Projects

One space per client, product line or recurring job: description, linked rooms
and tasks, **long-term memory** entries and **work instructions**, both editable
in place. Memory is what the office knows; instructions are what agents must do.

### Minutes & log

- **Meeting archive** — ending a room writes a permanent snapshot (no TTL):
  topic, participants, decisions/results/open items, task board and transcript.
  Search runs over the spoken text, not just topics, and every word of a
  multi-word query must match. Re-capturing a room updates its snapshot instead
  of duplicating it.
- **Work log** — append-only audit of sign-ins, staff changes, approvals,
  pauses, aborts, retries, QA, archives, file uploads/deletes, backups and
  settings. Newest 1,000 entries are kept; filter by action prefix, actor, target,
  room and time.

### Recurring work

A template is a meeting that has not happened yet: name, topic, task lines
(`Title | tag | owner | approval`) and optional standing instructions. **Run**
allocates a room code, seats the staff it assigns, creates the tasks (approval
ones held back), posts the instructions as the first message, links the room to
its project, and returns the join link.

### Limits & backup

- Requests today against `dailyRequestBudget` (default 10,000 — the free tier's
  command allowance), per-agent daily task counts, and the connection status of
  Redis / file storage / MCP grants.
- Office rules: default daily limit, auto-retry ceiling, auto hand-off, QA
  requirement.
- **Download backup** writes one JSON file (`format:
  "agent-room-office-backup"`) with staff, projects, templates, archives, audit
  and rules — optionally the room boards as a read-only record.
- **Restore** merges by id or replaces the office collections. Room boards are
  never restored: live meeting state belongs to the room and the seats polling
  it.

### When the work is done, the room is done

A room is a meeting, and a meeting that has finished its work should not stay
open until somebody remembers to press `End` — in practice nobody does, so
finished rooms kept five agents holding seats for weeks. The rule that closes
one is narrow on purpose:

| Condition | Effect |
| --- | --- |
| Board has **no cards** | Never closes. A waiting room / free conversation room has no work to finish, so "no work" is not an end state. |
| Any card not `done` (`todo`, `in_progress`, `awaiting_review`, `blocked`, `rejected`, `paused`, `cancelled`, `aborted`) | Never closes. Only `done` means the work is over — a cancelled or aborted card is a record of work somebody stopped. |
| Every card `done` | The room is scheduled: it archives its minutes and ends after the grace period (10 minutes by default). |
| New card / a card moved back out of `done` inside the grace period | The schedule is **cancelled**; the room stays open. |
| A message (the boss, an agent, a system notice) inside the grace period | The deadline **moves out** by the full grace period, again and again while the conversation continues. |
| The rule set to `0`, or the room ended by hand | Any scheduled close is dropped, not left to fire later. |

Presence heartbeats are deliberately **not** activity: the office's agents listen
around the clock, and counting a stamp every 30 seconds as "somebody is using
this room" would mean a finished room never closes in the one deployment this
feature exists for.

There is no daemon. The deadline is checked on requests that were going to
happen anyway — the dashboard poll (`overview`, `rooms.list`), every MCP task
write, a `room_listen` hold (at most once a minute per warm instance), the room
API's own board writes, and `POST /api/notion { "action": "cron" }` as the daily
backstop. Each of them pays one `SMEMBERS` when nothing is scheduled, and a due
room is archived **before** it is closed so the archive is a record of the room,
not of an empty one. The close writes `room.auto_end` to the work log (armed and
cancelled plans write `room.auto_close_armed` / `room.auto_close_cancelled`).

On screen, the Meetings list shows `자동 종료까지 N분` on a room that is waiting
and `자동 종료` on one that closed itself, and the grace period is a field in
*Limits & backup* (0 turns the rule off).

---

## 3. The API

One function, `POST /api/office` with `{ "action": … }`. `GET
/api/office?action=status` is the only read-only form (handy from curl).

| Action | Auth | Notes |
| --- | --- | --- |
| `status` | — | Configuration, session and (signed in) counts + integrations. |
| `login` / `logout` | — | Password → cookie; logout expires it. |
| `overview` | session | The dashboard payload in one round of reads. |
| `agents.list` / `agents.save` / `agents.delete` / `agents.pause` / `agents.resume` | session | Staff CRUD. |
| `projects.list` / `projects.save` / `projects.delete` | session | Projects. |
| `projects.memory.add` / `.update` / `.delete` | session | Long-term memory. |
| `projects.guideline.add` / `.update` / `.delete` | session | Work instructions. |
| `projects.link` | session | Link a room/task/file. |
| `tasks.approve` / `tasks.reject` / `tasks.pause` / `tasks.resume` / `tasks.abort` / `tasks.retry` / `tasks.qa` / `tasks.requestApproval` | session | Board controls, per room code + task id. |
| `rooms.list` | session | Known rooms with board counts (and any scheduled auto-close). |
| `archives.list` / `.get` / `.capture` / `.delete` | session | Minutes; `list` takes `query`. |
| `audit.list` | session | `filter: { action, actor, target, roomCode, from, to, limit }`. |
| `templates.list` / `.save` / `.delete` / `.apply` | session | Recurring work. |
| `settings.get` / `settings.save` | session | Office rules. |
| `usage.get` | session | Today's counters and per-agent load. |
| `backup.export` / `backup.restore` | session | JSON file in and out. |

Errors are explicit: `login_required` (401), `admin_not_configured` (503),
`invalid_input` with the offending `field` (400), `task_conflict` (409) for state
machine refusals, `agent_daily_limit` (429) when an agent is out of quota.

---

## 4. How it touches the room layer

Additive only — a room that never heard of the office behaves exactly as before.

| Surface | Change |
| --- | --- |
| `TaskState` | `pending_approval`, `paused`, `aborted` added. Existing states keep their meaning. |
| `Task` | `approval`, `qa`, `pause`, `abort`, `retryCount`, `maxRetries`, `retries` — all optional. |
| `room_task` (MCP) | `create` accepts `requiresApproval`; new actions `pause`, `unpause`, `abort` (host only), `qa`, `request_approval`. |
| `room_listen` / `room_join` | Stamp the office heartbeat (throttled, best-effort). |
| `room_end` | Captures the permanent archive after the room closes (best-effort) and cancels any auto-close plan. |
| `Room.autoClose` / `autoClosedAt` | Optional plan written by the auto-close rule (deadline, grace, activity watermark) and the marker left when the rule is what closed the room. Rooms that never heard of it are unchanged. |
| `/api/files` | Upload and delete write an audit entry. |
| Task creation / claim | A registered agent over its daily limit is refused with `agent_daily_limit`; unknown names pass through. |

The task-board rules that already existed are untouched: only a verifier can
reach `done`, a producer can never verify its own work, and evidence is still
required to leave `in_progress`. The office gate sits *before* the work
(`pending_approval`) and *around* it (pause/abort), never inside the evidence
path.

---

## 5. Storage layout

All under `office:v1:` with **no TTL** (that is the point — the office outlives
the rooms):

| Key | Kind | Holds |
| --- | --- | --- |
| `office:v1:agents` | set | staff ids |
| `office:v1:agent:{id}` | JSON | one staff member |
| `office:v1:agentname:{name}` | string | name → id lookup |
| `office:v1:heartbeat:{name}` | JSON | last listen stamp |
| `office:v1:projects`, `project:{id}` | set / JSON | projects with memory + guidelines |
| `office:v1:templates`, `template:{id}` | set / JSON | recurring work |
| `office:v1:archives`, `archive:{id}`, `archive-room:{code}` | set / JSON | permanent minutes (one per room) |
| `office:v1:audit` | list | newest 1,000 audit entries |
| `office:v1:settings` | JSON | office rules |
| `office:v1:usage:{day}:{requests\|writes}` | counter | today's API use (3-day TTL) |
| `office:v1:usage-agent:{day}:{agentId}` | counter | tasks handed to an agent today |
| `office:v1:rooms`, `room:{code}` | set / JSON | rooms the office opened |
| `room:auto-close` | set | room codes with a scheduled auto-close (a hint; every entry is re-checked against the room document) |

Documents are single JSON values behind compare-and-set writes (a small Lua
script), so two dashboard tabs editing the same project cannot silently
overwrite each other.

---

## 6. Cost

The dashboard re-reads `/api/office` every **240 seconds** on the reading tabs
and every **120 seconds** on the Work tab (approvals and reviews), **while the
tab is visible**; it stops when the tab is hidden, refreshes once when it comes
back, and has a manual refresh in the header. One refresh reads the office
documents plus up to 24 rooms (two commands each), so a visible tab costs about
3,720 commands over an eight-hour day instead of 29,760. The header gauge and
the Limits tab show the same count climbing instead of letting the deployment
fail quietly. Raise `dailyRequestBudget` if the plan allows more.

---

## 7. Tests

```bash
npm run test:api          # includes api/office.test.ts (HTTP + cookie + actions)
npm test                  # packages' unit/integration tests, incl. office store and board controls
npx tsc -p api/tsconfig.json   # the serverless functions on their own
```

`packages/upstash-client/test/fakeRedis.ts` models the two Lua scripts
(board CAS and office CAS) and the login rate limiter in JavaScript, so the
whole feature is testable without a Redis.
