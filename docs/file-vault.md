# File vault: materials, deliverables, and the path back to them

A room's files used to exist twice, badly: as chat attachments (deleted when the
meeting ended, capped at five per message, no way to search) and as whatever an
agent kept in its own workspace (invisible to everyone else). This document is
how the two vaults work, what is stored where, and what an agent or a browser
must present to read a file.

## Two vaults, one record

| | Materials (`room_files`) | Deliverables (`room_deliverable`) |
|---|---|---|
| What it holds | files people brought in — spreadsheets, PDFs, images, archives | files the room produced — documents, programs, images, video, source |
| Who uploads | anyone joined (web or agent) | anyone joined; usually the producing agent |
| Lifetime | 30 days (`VAULT_MATERIAL_TTL_SECONDS`) | **no TTL** — survives the meeting |
| Versioning | yes, same as deliverables | yes — `v1`, `v2`, … same file id |
| Storage prefix | `vault/material/<code>/…` | `vault/deliverable/<code>/…` |

Both are `VaultFile` records (`packages/shared/src/vault.ts`). A record carries
metadata only — name, size, MIME, category, folder, tags, task link, producer,
version history, and capped extracted text. The bytes live in object storage.

Deliverables getting no TTL is deliberate and is the reason they are not stored
under `rooms/<code>/…`: `api/delete-room-blobs.ts` deletes that whole prefix when
a host ends a meeting, and a deliverable has to survive that.

## Where the bytes live

`api/_blobStore.ts` picks a backend from the environment, in this order:

1. **Vercel Blob** when `BLOB_READ_WRITE_TOKEN` is set (a free store is enough;
   no paid add-on is required). Objects are written with `access: 'private'`.
2. **Cloudflare R2** when `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` and
   `R2_SECRET_ACCESS_KEY` are set (the existing attachment path already uses it).
3. Otherwise the vault answers `503 storage_unavailable` with the list of missing
   variables — it does not silently fall back to something public.

Nothing in either backend is reachable from the internet by URL. There is no
public blob URL in a response, and no signed storage URL in a record.

## Reading: who may, and how

Two ways in, both authorized server-side:

* **Signed file link** — `GET /api/files?token=…`. The token is
  `base64url({c:room, k:kind, f:fileId, e:expiry})` + HMAC-SHA256, valid 15–30
  minutes, minted by the server after it has checked the caller. It names exactly
  one file, so forwarding it does not open the vault. Signing secret:
  `FILES_SIGNING_SECRET` (falls back to a deployment secret that already exists,
  so a fresh install works without extra configuration).
* **Authenticated call** — `POST /api/files` and the MCP tools carry a `seatKey`
  (`room_join`), a `hostKey`, or an `MCP_AUTH_GRANTS` token scoped to the room.
  Every check ends at the room document.

`GET /api/files` streams the object back with the correct `Content-Type`,
`Content-Disposition` (`inline` for previews), `X-Content-Type-Options: nosniff`
and `Cache-Control: private, no-store`.

## MCP surface

| Tool | Actions |
|---|---|
| `room_files` | `list` · `search` · `read` · `upload` · `update` · `link` · `delete` · `folders` · `create_folder` · `delete_folder` · `usage` |
| `room_deliverable` | `list` · `upload` · `update` · `read` · `link` · `delete` · `usage` |

Aliases keep the documented single-verb names working:
`room_files_list`, `room_file_read` (also `room_attachment_read`),
`room_file_search`, `room_deliverable_upload`, `room_deliverable_update`,
`room_deliverable_list`, `room_files_upload`.

`read` returns:

* the file's `text` in a slice (`offset` + `limit`, `totalChars`, `nextOffset`) —
  exact for text/code/CSV/JSON, extracted for `.docx` and `.xlsx` (zip + XML, no
  native dependency), approximate for PDF (text-showing operators, labelled
  `approximate: true`);
* an MCP `image` content part for pictures up to 4 MB, so a vision model sees the
  pixels rather than a filename;
* `downloadUrl` for anything else — a signed link the agent can fetch.

Uploads through a tool argument accept `text` or `contentBase64` up to 1.5 MB.
Anything larger goes through `POST /api/files` with the seat key in an
`Authorization: Bearer` header, or (on R2) a presigned direct upload.

## HTTP surface

```
GET  /api/files?token=…                     stream one file (inline=1 to preview)
POST /api/files   multipart                 upload one or many files
POST /api/files   {"op": "list" | …}        metadata operations
```

JSON ops: `list`, `search`, `folders`, `createFolder`, `deleteFolder`, `update`,
`delete`, `usage`, `mint` (a fresh link for an older version), `sign` + `complete`
(presigned upload).

## Size limits

| Limit | Value | Why |
|---|---|---|
| Per file (inline upload) | 3.5 MB | a Vercel function request body is capped at 4.5 MB |
| Per file (presigned / R2) | 25 MB | `VAULT_MAX_FILE_BYTES` |
| Per MCP tool argument | 1.5 MB | base64 is ~4/3 the size, inside a JSON payload |
| Room total | 1 GB | `VAULT_MAX_ROOM_BYTES`, shown as a usage bar |
| Files per vault | 500 | `VAULT_MAX_FILES_PER_KIND` |
| Versions kept | 20 | older revisions are deleted from storage with the record |

## Task board integration

* `room_task submit` accepts `deliverableIds` and `inputFileIds`; each id is
  attached to the task (`Task.files.deliverables` / `.inputs`) and posted as a
  transcript line (`📤 T-01 submitted — deliverables: "report.md" v2`).
* `room_task verify` with `verdict: "done"` posts `✅ T-01 done — …`. A task that
  reaches `done` with no deliverable attached says so in the response (`gap`) and
  on its board card, because a done task pointing at nothing cannot be re-checked.
* The board card shows "🗂 N deliverables · 📎 N inputs → Open files", which opens
  the vault filtered to that task.

## Redis keys

```
vault:materials:{code}:ids          SET   material ids
vault:materials:{code}:file:{id}    STR   record (JSON, EX 30d)
vault:deliverables:{code}:ids       SET   deliverable ids
vault:deliverables:{code}:file:{id} STR   record (JSON, no TTL)
vault:{code}:folders                SET   folder ids
vault:{code}:folder:{id}            STR   folder (JSON)
vault:{code}:task:{taskId}          SET   "kind:id" links for the board
```

One key per record, and atomic `SADD`/`SREM` for the indexes, so two uploads at
the same time both land — a single JSON array per room would be a
read-modify-write race.

## Failure modes this design refuses

* **A listed file with no bytes.** The record is written only after the object is
  in storage; a presigned upload is recorded only after the server has read the
  object back.
* **A link that opens more than its file.** Tokens name one `(room, kind, id)` and
  expire.
* **A file that outlives its owner by accident.** Materials follow the meeting;
  deliverables follow the work. Nothing else expires silently.
* **A parser bug failing an upload.** Extraction is best-effort and bounded; the
  file is stored regardless, and the record says how faithful the text is.
