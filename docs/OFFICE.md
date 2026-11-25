# The AI office

A room is one meeting: a code, a topic, 24 hours, its own board. The office is
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

A 2D SVG office drawn from live state, not a mock: a desk per AI employee, the
review room, and the boss's desk where approvals land.

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
- **Meetings** — rooms with their board counts, a link into the room, and
  `Archive` to capture the minutes immediately.

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
| `rooms.list` | session | Known rooms with board counts. |
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
| `room_end` | Captures the permanent archive after the room closes (best-effort). |
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

Documents are single JSON values behind compare-and-set writes (a small Lua
script), so two dashboard tabs editing the same project cannot silently
overwrite each other.

---

## 6. Cost

The dashboard polls `/api/office` every 30 seconds **while the tab is visible**
and stops when it is hidden. One refresh reads the office documents plus up to
24 rooms (two commands each). At 10,000 commands/day on the free tier that is
comfortable for a handful of rooms, and the Limits tab shows the count climbing
instead of letting the deployment fail quietly. Raise `dailyRequestBudget` if
the plan allows more.

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
