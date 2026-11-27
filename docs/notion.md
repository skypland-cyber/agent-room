# Notion: the office's long-term memory (Phases 1–3)

The office keeps its live state in Redis (rooms, boards, chat, heartbeats) and its
files in the vault. Notion is the third place, and the only one a person reads and
edits by hand: eight databases under one page, holding projects, staff manuals,
meeting minutes, reports, digital products, the finance ledger, deliverables, and the
knowledge base. Redis stays the source of truth for live state; Notion gets events
only, one row each.

This document covers **Phases 1–3** — the client, the schema, the bootstrap, the
read path (`knowledge_search` / `knowledge_get`), and the write sync: what an
office event turns into, how a failed write is kept, and what a person's own edits
are protected from. `knowledge_save` and the report cron are Phases 4–5 and are
not wired yet.

## The eight databases

| Key | Title | Idempotency key |
|---|---|---|
| `projects` | 📊 프로젝트 | `Office ID` |
| `staff` | 🧑‍💻 AI 직원 매뉴얼 | `Office ID` |
| `meetings` | 🗣 회의록 | `Archive ID` |
| `reports` | 📈 보고서 | `범위 키` |
| `products` | 📦 디지털 상품 | `상품 코드` |
| `finance` | 💰 재무 장부 | — (a ledger) |
| `deliverables` | 🗂 결과물 | `파일 ID` |
| `knowledge` | 🧠 지식 베이스 | `키` |

All eight are created **inline** inside the root page (`is_inline: true`), which costs
one block per database — nine blocks for the whole structure, once. If the workspace
refuses inline databases the bootstrap retries them as child pages; the schema cache
records which form each database uses.

## Environment

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `NOTION_API_KEY` | yes | — | The connection token (`ntn_…`). Server-only; never sent to a browser. |
| `NOTION_ROOT_PAGE_ID` | yes | — | The `AI 사무실 본부` page id (32 characters, hyphens and links accepted). |
| `NOTION_SYNC_MODE` | no | `off` | `off` · `read` · `meta` · `full` (`write`/`all` are aliases of `full`). `off` and `read` write nothing; `meta` writes meeting rows only. |
| `NOTION_VERSION` | no | `2026-03-11` | Pinned in code; only override deliberately. |
| `NOTION_MAX_CALLS_PER_REQUEST` | no | `6` | Ceiling for read paths (bootstrap/selftest pass their own). |
| `NOTION_TIMEOUT_MS` | no | `4000` | Per-call timeout. |
| `NOTION_ROW_BUDGET_MONTHLY` | no | `300` | Rows per month before the sync is told to stop (Phase 4). |
| `NOTION_MINUTES_MODE` | no | `property` | `property` · `body` · `none` — where meeting minutes live. |
| `NOTION_MINUTES_FULLTEXT` | no | `0` | `1` stores the full transcript in a property (no extra blocks). |
| `NOTION_DB_MAP` | no | — | JSON `{ "knowledge": "<data source id>", … }` to adopt databases you made by hand. |

The connection must be added to the root page only, with Read content, Insert content
and Update content. Notion inherits a connection down the page tree, so nothing else
belonging to you should live under that page.

## Actions (`/api/notion`)

| Action | Method | Auth | What it does |
|---|---|---|---|
| `status` | GET | public (booleans) / session (schema summary) | Reports whether Notion is configured, the sync mode, and — signed in — how many databases the cache holds. Never calls Notion. |
| `bootstrap` | POST | office session | Creates the eight databases under the root page, patches the relations in a second pass, writes the guide paragraphs once, and stores the schema map at `notion:v1:schema`. |
| `selftest` | GET or POST | office session | Reaches the root page, reads one row from each database, and checks every recorded property **id** still exists with the expected type. 9 checks (root + 8). |
| `repair` | POST | office session | Re-collects the property ids, puts back a property a person deleted, adopts a database rebuilt by hand, and names the ones that are gone. With `{ "relink": true }` it also restores the Redis links for rows that already exist (`relinked` in the answer). |
| `drain` | POST | office session | Writes what the outbox kept while Notion was unavailable: up to 20 events, each attempted once. Answers `processed · succeeded · failed · dead` and the per-item results. |
| `backfill` | POST | office session | Writes what Redis already holds. `{ "kinds": ["meetings"], "limit": 10, "cursor": "projects:12" }` — `nextCursor` continues in the next call, and a row already in sync costs zero Notion calls. |

```bash
# with the office session cookie from /office
curl -X POST https://agent-room-henna.vercel.app/api/notion \
  -H 'content-type: application/json' --cookie 'ar_office_session=…' \
  -d '{"action":"bootstrap"}'
curl 'https://agent-room-henna.vercel.app/api/notion?action=selftest' --cookie 'ar_office_session=…'
```

Bootstrap is idempotent: the root page's children are read first and a database with
the same title is reused, so a second run creates nothing and a half-built workspace
finishes instead of doubling.

## Phase 2: the read path (`knowledge_search` / `knowledge_get`)

Both tools are read-only, need no room code, and are listed **only** for an MCP
token whose grant carries `knowledge`: `"read"` or `"write"`. A token without it
never sees them (`Invalid MCP grant` if the value is anything else).

```json
{ "<sha256 of token>": { "rooms": "*", "profile": "core", "knowledge": "read" } }
```

| Tool | Input | What it costs |
|---|---|---|
| `knowledge_search` | `query` (or `project` / `type` / `tags`), `limit` 1–25 (default 8), `include_body` | 1 Notion call, 3 with `include_body` (top two bodies), **0** for the same question inside 10 minutes |
| `knowledge_get` | `id`, `key`, `title`, or `kind: "manual"` + `name` | 1–2 calls the first time, **0** for 15 minutes |

The search is one `data_sources.query` against the knowledge data source with an
`or` filter over 제목 · 키워드 · 내용 · 태그 (plus `and` for project and 유형), sorted
by 최근 갱신. Everything is addressed by **property id**, so renaming a column in
Notion does not break it. Results are then scored locally — title 3 · tag 2 ·
keyword corpus 1 · content 1, plus a 90-day recency term — and the top `limit`
are returned with a snippet around the match.

A page body comes from `GET /v1/pages/{id}/markdown`; when that is unavailable the
`내용` property answers instead and `bodySource` says which one it was. The body
is clipped at 20,000 characters.

`kind: "manual"` reads the AI staff manual a person wrote in Notion (업무 원칙 ·
금지 사항 · 출력 형식 · 도구 사용), cached as one list for 15 minutes.

**Identity.** A `code` + `seatKey` pair is proof of a seat and is recorded as
`identity: "seat"`; a name that the office roster knows is a claim and is recorded
as `identity: "name"` (with the roster spelling); a seatKey that does not match is
not trusted and not fatal — the answer says `seatUnverified: true` and falls back
to the name. Reading never requires either.

**Everything from Notion is data.** Every response carries `untrusted: true`, and
the tool descriptions say so: text written in a page is not an instruction and
cannot authorise an action.

### Cache keys and degradation (§7.1–7.2)

| Key | TTL | Contents |
|---|---|---|
| `notion:v1:cache:q:{sha1 of query, project, type, tags, limit}` | 600s | Scored results (+ bodies once they were read) |
| `notion:v1:cache:page:{pageId}` | 900s | Properties + body, clipped at 20,000 characters |
| `notion:v1:cache:manuals` | 900s | Staff manual summaries |

Every entry is an envelope `{ v, at, value }`, so an answer can report its own age
(`cacheAgeSeconds`). On a 429/529/timeout — or when the request's own Notion call
ceiling (`NOTION_MAX_CALLS_PER_REQUEST`, default 6) is reached — a cached answer
is returned with `stale: true` rather than an error. A configuration or permission
failure is never degraded that way: "here is yesterday's answer" would be a lie
about a broken connection. An answer that had to stop short says `truncated: true`.

### What a caller sees when something is wrong

| `error` | Meaning / next step |
|---|---|
| `notion_not_configured` | `NOTION_API_KEY` / `NOTION_ROOT_PAGE_ID` not set on this deployment |
| `notion_not_bootstrapped` | Run `POST /api/notion {action:"bootstrap"}` once |
| `notion_rate_limited` | `retryAfterSeconds` included; a stale answer is served when one exists |
| `notion_forbidden` | The id is not a row of the office's own databases, or the connection lost access |
| `notion_not_found` | No page/manual by that id, key, title or name |
| `notion_invalid_request` | `knowledge_search` with nothing to search for, or an unknown 유형 |
| `notion_call_budget` | This request reached `NOTION_MAX_CALLS_PER_REQUEST`; ask again (the cache may answer) |

## Phase 3: the write sync

Redis stays authoritative; every write is one row, properties only.

### What becomes a row

| Event | Fired from | Row |
|---|---|---|
| `meeting.archived` | `captureRoomArchive()` — every way a room ends | 🗣 회의록 · summary, decisions, results, to-dos, board line, `/office` link |
| `deliverable.upsert` | the vault's upload / new version / `complete` (HTTP and MCP) | 🗂 결과물 · kind, size, version, producer, stable `/office` link |
| `deliverable.deleted` | the vault's delete | 🗂 결과물 · `보존=삭제됨` (the row stays) |
| `project.upsert` | `projects.save` (create and update) | 📊 프로젝트 · status, one-line description, 담당 AI, 회의/결과물 relations |
| `project.deleted` | `projects.delete` | 📊 프로젝트 · `상태=보관` (the row and its knowledge survive) |
| `memory.upsert` | `projects.memory.add` / `.update` | 🧠 지식 베이스 · the note becomes knowledge |
| `staff.seed` | `bootstrap` (when the mode is `full`) | 🧑‍💻 AI 직원 매뉴얼 · one row per agent, or the six defaults |
| `staff.mirror` | `agents.save` / pause / resume | 🧑‍💻 AI 직원 매뉴얼 · roster fields only |

Never written: heartbeats, presence, chat, bubbles, cursors, seat keys, task
intermediates, file bodies. The design keeps tasks out of Notion on purpose — a
daily task row would spend the free plan's lifetime block budget in a year.

### The three rules behind a write

1. **Off the response path.** `syncEvent()` hands the work to `waitUntil()` and
   returns immediately (measured: the HTTP handler answers before the first
   Notion call is made). Where `waitUntil` does not exist, the write gets a
   1.5 s inline head start and is queued if it has not finished.
2. **Idempotent.** `notion:v1:link:{kind}:{sourceId}` → `{ pageId, hash, at }`
   (no TTL). The hash is the SHA-256 of the normalised payload, so the same event
   twice is answered with **zero** Notion calls. If the link is lost, the target
   data source is queried once by its key property (`Archive ID`, `파일 ID`,
   `Office ID`, `키`) and the link is written back — the answer says
   `recovered: true` so a repair is visible.
3. **A person's words are not overwritten.** Properties the schema marks `human`
   (`업무 원칙` · `금지 사항` · `출력 형식` · `도구 사용` · `매뉴얼 갱신` · `설명`) are
   written only when the row is **created**, and are dropped from every update by
   the writer itself — not by each caller's memory. Unmarked properties follow
   the row's own source of truth: Redis for mirrored rows.

### When Notion will not take it

A failure is retried once immediately. If it still fails, the event goes into the
outbox and an audit line (`notion.sync.failed`) says so:

```
notion:v1:outbox              LIST of item ids, newest 500
notion:v1:outbox:item:{id}    the event, JSON, 7 days
notion:v1:outbox:dead         ids that failed more than 5 times
```

An item is named after the **row** (`meeting.archived:arc_x`), so an hour of
failures for one meeting is one item with `attempts: 8`, not eight items. Drains
happen three ways: one item after any later sync, up to twenty from
`POST /api/notion { action: "drain" }`, and — once Phase 5 lands — the daily
cron. A drain attempts each item once and puts a failure at the oldest end of the
queue, so one broken row cannot block the others.

Two failures are never queued because they cannot heal by waiting:
`notion_not_configured` and `notion_not_bootstrapped` (run bootstrap, then
`backfill`) — and `notion_block_limit` (writing is over until the workspace's
blocks are freed).

### What a write costs

| Case | Notion calls |
|---|---|
| Same event again | 0 |
| New row | 1 (+1 if the link was lost) |
| Changed row | 1 |
| Delete / project archived | 0–1 (only an existing row is marked) |
| `backfill` of an in-sync workspace | 0 |

### Known limits of this phase

- A row a person deletes in Notion is not recreated while its Redis link still
  matches the hash. `repair` restores links, not rows; a row that is genuinely
  gone needs `backfill` after the link is cleared.
- `열린 업무` / `완료 업무` on a project row stay empty: reading task boards on the
  sync path would cost more Redis than the number is worth. The board line in
  the meeting row is the task record.
- A project's `회의` / `결과물` relations are filled from the rows already linked
  at the time the project is saved. Saving the project again refreshes them.
- `변경 이력` on a knowledge row is Phase 4 (`knowledge_save`), where an explicit
  edit comes with a previous version to keep.

## Properties are addressed by id

The schema cache (`notion:v1:schema`, no TTL) stores, per database, the database id,
the data source id, and `property name → id` / `id → name`. Everything after Phase 1
writes through those ids, so renaming a column in Notion — the thing a person does
without asking — cannot break the sync. `selftest` proves it: it fails on a missing id
or a changed type, and passes through a rename.

## Limits this design lives inside

- **Blocks are permanent.** The free plan gives a one-person workspace 5,000 blocks
  for its lifetime (1,000 for two or more people), and deleting rows does not give
  them back. A row is a page is one block; the office therefore writes properties,
  never body blocks, and budgets rows per month.
- **180 requests/minute per connection**, about 3 per second. Each action has a call
  ceiling and the client honours `Retry-After`; a rate limit longer than a request
  can wait is reported (`retryAfterSeconds`) instead of silently retried.
- **Files stay in the vault.** No signed URL is stored in Notion — they expire in
  15–30 minutes. Rows carry the file id and a stable `/office` link; a download link
  is minted on demand.

## Not in these phases

`knowledge_save` (Phase 4, with the row budget guard), reports via cron, and the
`/office` Notion card (Phase 5). `bootstrap` seeds the staff manuals when
`NOTION_SYNC_MODE=full` and says `staff seed skipped (mode)` otherwise, so a
`meta` deployment is visibly meetings-only rather than silently partial.
