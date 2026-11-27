# Notion: the office's long-term memory (Phase 1)

The office keeps its live state in Redis (rooms, boards, chat, heartbeats) and its
files in the vault. Notion is the third place, and the only one a person reads and
edits by hand: eight databases under one page, holding projects, staff manuals,
meeting minutes, reports, digital products, the finance ledger, deliverables, and the
knowledge base. Redis stays the source of truth for live state; Notion gets events
only, one row each.

This document covers **Phase 1** — the client, the schema, and the bootstrap. Sync,
search, and reports are later phases and are not wired yet (`NOTION_SYNC_MODE` is
read but nothing writes to Notion outside bootstrap/repair).

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
| `NOTION_SYNC_MODE` | no | `off` | `off` · `meta` · `full`. Phase 1 reads it; nothing syncs yet. |
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
| `repair` | POST | office session | Re-collects the property ids, puts back a property a person deleted, adopts a database rebuilt by hand, and names the ones that are gone. |

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

## Not in this phase

Row seeding (staff manuals, the first product), event sync, the knowledge MCP tools,
reports via cron, and the dashboard card are Phases 2–5 of the design. `bootstrap`
returns `rowsSeed: "deferred"` so this is visible in its own output.
