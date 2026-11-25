// Vercel Function: the room's file vault over HTTP.
//
//   GET  /api/files?token=…            → stream one file (signed grant)
//   POST /api/files  (multipart)       → upload one or more files
//   POST /api/files  (JSON { op })     → list, search, folders, update, delete,
//                                        usage, mint, sign, complete
//
// Nothing here ever hands out a public object URL. A browser or an agent asks
// for bytes and this function decides, from the seatKey / hostKey / MCP grant,
// whether those bytes are theirs to read — then streams them. The signed GET
// form exists because an <a href> cannot send an Authorization header; the token
// names exactly one file and expires in minutes.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'node:buffer';
import { isValidCode, normalizeVaultTags, vaultFileSummary, VAULT_INLINE_MAX_BYTES } from '@agent-room/shared';
import type { VaultFile, VaultFileKind } from '@agent-room/shared';
import {
  attachVaultFileToTask,
  createVaultFolder,
  deleteVaultFolder,
  listVaultFiles,
  listVaultFolders,
  searchVaultFiles,
  updateVaultFile,
  vaultFilesForTask,
  vaultUsage,
} from '@agent-room/upstash-client';
import { createRemoteRoomClient } from './_mcpRoomClient.js';
import { bearerToken, canDeleteFile, authorizeVault, verifyVaultToken } from './_fileAccess.js';
import { fieldValue, multipartBoundary, parseMultipart, readRequestBody } from './_multipart.js';
import {
  deleteVaultFileWithObjects,
  findVaultFile,
  reviseVaultFile,
  uploadVaultFiles,
  vaultDownloadPath,
  VaultRequestError,
} from './_vault.js';
import { createBlobStore, vaultStorageKey } from './_blobStore.js';

export const config = { api: { bodyParser: false }, maxDuration: 60 };

// A browser uploads one file per request (the client loops), so this only has
// to cover a batch someone posts by hand. It is small on purpose: the body is
// buffered in memory, and Vercel caps it at 4.5 MB anyway.
const MAX_MULTIPART_BYTES = VAULT_INLINE_MAX_BYTES * 4;

function applyCors(res: VercelResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Host-Key');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  applyCors(res);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    await handleDownload(req, res);
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const contentType = String(req.headers['content-type'] ?? '');
  try {
    if (contentType.startsWith('multipart/form-data')) {
      await handleMultipartUpload(req, res);
      return;
    }
    if (!contentType.startsWith('application/json')) {
      res.status(400).json({ error: 'bad_request', message: 'Send multipart/form-data for an upload, or JSON { op } for everything else.' });
      return;
    }
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Record<string, unknown>;
    await handleAction(body, req, res);
  } catch (error) {
    sendError(res, error);
  }
}

function sendError(res: VercelResponse, error: unknown): void {
  if (error instanceof VaultRequestError) {
    res.status(error.status).json({ error: error.code, message: error.message });
    return;
  }
  const name = (error as { name?: string }).name;
  if (name === 'RoomNotFoundError') {
    res.status(404).json({ error: 'room_not_found', message: 'That room no longer exists (rooms expire 24h after creation).' });
    return;
  }
  res.status(500).json({ error: 'vault_error', message: error instanceof Error ? error.message : 'File request failed.' });
}

// ─── Download ────────────────────────────────────────────────────────────

async function handleDownload(req: VercelRequest, res: VercelResponse): Promise<void> {
  const token = (Array.isArray(req.query.token) ? req.query.token[0] : req.query.token) ?? undefined;
  const payload = verifyVaultToken(token);
  if (!payload) {
    res.status(403).json({ error: 'invalid_token', message: 'This file link has expired. Refresh the room and try again.' });
    return;
  }
  const { store } = createRemoteRoomClient(undefined);
  const file = await findVaultFile(store, payload.c, payload.f);
  if (!file || file.kind !== payload.k) {
    res.status(404).json({ error: 'file_not_found' });
    return;
  }
  const blob = createBlobStore();
  if (!blob.ok) {
    res.status(503).json({ error: 'storage_unavailable', message: blob.message });
    return;
  }
  const versionParam = Array.isArray(req.query.version) ? req.query.version[0] : req.query.version;
  const version = versionParam ? Number(versionParam) : file.version;
  const revision = file.versions.find(item => item.version === version) ?? (version === file.version ? { storageKey: file.storageKey, mime: file.mime, name: file.name, size: file.size } : null);
  if (!revision) {
    res.status(404).json({ error: 'version_not_found', message: 'That version is no longer retained.' });
    return;
  }
  const object = await blob.store.get(revision.storageKey);
  if (!object) {
    res.status(404).json({ error: 'object_missing', message: 'The file record exists but its bytes are gone.' });
    return;
  }
  const inline = req.query.inline === '1' || req.query.preview === '1';
  const name = String(req.query.name ?? revision.name ?? file.name).replace(/[\r\n"]/g, '');
  res.setHeader('Content-Type', object.contentType || revision.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(object.bytes.length));
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // A signed URL is a per-read capability, not a cache entry: another seat
  // must not be served this body from a shared proxy.
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }
  res.status(200).send(object.bytes);
}

// ─── Upload (multipart) ──────────────────────────────────────────────────

async function handleMultipartUpload(req: VercelRequest, res: VercelResponse): Promise<void> {
  const boundary = multipartBoundary(String(req.headers['content-type'] ?? ''));
  if (!boundary) {
    res.status(400).json({ error: 'invalid_multipart', message: 'Body must be multipart/form-data with a boundary.' });
    return;
  }
  let body: Buffer;
  try {
    body = await readRequestBody(req, MAX_MULTIPART_BYTES);
  } catch (error) {
    res.status(413).json({ error: 'body_too_large', message: error instanceof Error ? error.message : 'Request body too large.' });
    return;
  }
  const parts = parseMultipart(body, boundary);
  const roomCode = fieldValue(parts, 'roomCode') ?? '';
  if (!isValidCode(roomCode)) {
    res.status(400).json({ error: 'bad_room_code', message: 'Missing or malformed roomCode.' });
    return;
  }
  const seatKey = bearerToken(req.headers.authorization) ?? fieldValue(parts, 'seatKey');
  const hostKey = (typeof req.headers['x-host-key'] === 'string' ? req.headers['x-host-key'] : undefined) ?? fieldValue(parts, 'hostKey');
  const { store } = createRemoteRoomClient(undefined);
  const principal = await authorizeVault({ store, code: roomCode, seatKey, hostKey, authorization: req.headers.authorization });
  if (!principal) {
    res.status(403).json({ error: 'vault_unauthorized', message: 'Join the room (or present the host key) before uploading.' });
    return;
  }
  const blob = createBlobStore();
  if (!blob.ok) {
    res.status(503).json({ error: 'storage_unavailable', message: blob.message });
    return;
  }
  const kind: VaultFileKind = fieldValue(parts, 'kind') === 'deliverable' ? 'deliverable' : 'material';
  const fileParts = parts.filter(part => part.name === 'file' && part.filename !== undefined);
  if (fileParts.length === 0) {
    res.status(400).json({ error: 'missing_file', message: 'No file part in the form data.' });
    return;
  }
  const requestedId = fieldValue(parts, 'versionOf');
  const tags = normalizeVaultTags(fieldValue(parts, 'tags') ?? '');
  if (requestedId) {
    // "Upload a new version of this file" — same record, next revision.
    const part = fileParts[0]!;
    const { file } = await reviseVaultFile({ store, blob: blob.store }, {
      code: roomCode,
      principal,
      fileId: requestedId,
      name: part.filename,
      mime: part.contentType ?? 'application/octet-stream',
      bytes: part.data,
      ...(fieldValue(parts, 'note') ? { note: fieldValue(parts, 'note') } : {}),
      ...(fieldValue(parts, 'description') ? { description: fieldValue(parts, 'description') } : {}),
      maxBytes: VAULT_INLINE_MAX_BYTES,
    });
    const usage = await vaultUsage(store, roomCode);
    res.status(201).json({ file: withLinks(file), usage });
    return;
  }
  const result = await uploadVaultFiles({ store, blob: blob.store }, {
    code: roomCode,
    kind,
    principal,
    items: fileParts.map(part => ({
      name: part.filename!,
      mime: part.contentType ?? 'application/octet-stream',
      bytes: part.data,
    })),
    ...(fieldValue(parts, 'folderId') ? { folderId: fieldValue(parts, 'folderId') } : {}),
    ...(tags.length > 0 ? { tags } : {}),
    ...(fieldValue(parts, 'taskId') ? { taskId: fieldValue(parts, 'taskId') } : {}),
    ...(fieldValue(parts, 'description') ? { description: fieldValue(parts, 'description') } : {}),
    ...(fieldValue(parts, 'producer') ? { producer: fieldValue(parts, 'producer') } : {}),
    maxBytes: VAULT_INLINE_MAX_BYTES,
  });
  const usage = await vaultUsage(store, roomCode);
  const status = result.files.length > 0 ? 201 : 400;
  res.status(status).json({
    files: result.files.map(withLinks),
    failures: result.failures,
    usage,
  });
}

/** Every listing row carries its own short-lived links. */
function withLinks(file: VaultFile) {
  const path = vaultDownloadPath(file);
  return {
    ...file,
    // The text is available through room_file_read / the preview pane; putting
    // 100 KB of spreadsheet into every list response would make the vault tab
    // unusable on a phone.
    extractedText: undefined,
    url: path,
    previewUrl: path ? `${path}&inline=1` : null,
  };
}

// ─── JSON actions ────────────────────────────────────────────────────────

async function handleAction(body: Record<string, unknown>, req: VercelRequest, res: VercelResponse): Promise<void> {
  const op = String(body.op ?? 'list');
  const roomCode = String(body.roomCode ?? '');
  if (!isValidCode(roomCode)) {
    res.status(400).json({ error: 'bad_room_code', message: 'Missing or malformed roomCode.' });
    return;
  }
  const { store } = createRemoteRoomClient(undefined);
  const seatKey = bearerToken(req.headers.authorization) ?? (typeof body.seatKey === 'string' ? body.seatKey : undefined);
  const hostKey = (typeof req.headers['x-host-key'] === 'string' ? req.headers['x-host-key'] : undefined)
    ?? (typeof body.hostKey === 'string' ? body.hostKey : undefined);
  const principal = await authorizeVault({ store, code: roomCode, seatKey, hostKey, authorization: req.headers.authorization });
  if (!principal) {
    res.status(403).json({ error: 'vault_unauthorized', message: 'Join the room (or present the host key) before using its vault.' });
    return;
  }
  const kind: VaultFileKind = body.kind === 'deliverable' ? 'deliverable' : 'material';

  switch (op) {
    case 'list': {
      const filter = {
        ...(typeof body.folderId === 'string' ? { folderId: body.folderId } : {}),
        ...(body.folderId === null ? { folderId: null } : {}),
        ...(typeof body.tag === 'string' ? { tag: body.tag } : {}),
        ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
        ...(typeof body.category === 'string' ? { category: body.category } : {}),
        ...(typeof body.query === 'string' && body.query.trim() ? { query: body.query.trim() } : {}),
        ...(typeof body.projectId === 'string' ? { projectId: body.projectId } : {}),
        ...(body.starred === true ? { starred: true } : {}),
        limit: typeof body.limit === 'number' ? Math.min(500, Math.max(1, body.limit)) : 200,
      };
      const files = body.all === true
        ? await searchVaultFiles(store, roomCode, String(body.query ?? ''), filter)
        : await listVaultFiles(store, kind, roomCode, filter);
      const [usage, folders, tasks] = await Promise.all([
        vaultUsage(store, roomCode),
        listVaultFolders(store, roomCode),
        typeof body.taskId === 'string' ? vaultFilesForTask(store, roomCode, body.taskId) : Promise.resolve([]),
      ]);
      res.status(200).json({
        files: files.map(withLinks),
        folders,
        usage,
        ...(tasks.length > 0 ? { taskFiles: tasks.map(withLinks) } : {}),
      });
      return;
    }
    case 'search': {
      const query = String(body.query ?? '').trim();
      if (!query) {
        res.status(400).json({ error: 'bad_request', message: 'search needs a query.' });
        return;
      }
      const files = await searchVaultFiles(store, roomCode, query, { limit: 100 });
      res.status(200).json({ files: files.map(withLinks) });
      return;
    }
    case 'folders': {
      res.status(200).json({ folders: await listVaultFolders(store, roomCode) });
      return;
    }
    case 'createFolder': {
      const name = String(body.name ?? '').trim();
      if (!name || name.length > 60) {
        res.status(400).json({ error: 'bad_request', message: 'Folder name is required (max 60 characters).' });
        return;
      }
      const folder = await createVaultFolder(store, roomCode, {
        name,
        createdBy: principal.name || 'host',
        ...(typeof body.parentId === 'string' ? { parentId: body.parentId } : {}),
      });
      res.status(201).json({ folder });
      return;
    }
    case 'deleteFolder': {
      const folderId = String(body.folderId ?? '');
      if (!folderId) {
        res.status(400).json({ error: 'bad_request', message: 'folderId is required.' });
        return;
      }
      const result = await deleteVaultFolder(store, roomCode, folderId);
      res.status(200).json(result);
      return;
    }
    case 'update': {
      const fileId = String(body.fileId ?? '');
      const file = await findVaultFile(store, roomCode, fileId);
      if (!file) {
        res.status(404).json({ error: 'file_not_found' });
        return;
      }
      const movedToTask = typeof body.taskId === 'string' ? body.taskId : undefined;
      let updated = await updateVaultFile(store, file.kind, roomCode, file.id, current => {
        const next: VaultFile = { ...current };
        if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim().slice(0, 160);
        if (body.folderId === null) delete next.folderId;
        else if (typeof body.folderId === 'string') next.folderId = body.folderId;
        if (Array.isArray(body.tags) || typeof body.tags === 'string') next.tags = normalizeVaultTags(body.tags);
        if (typeof body.description === 'string') {
          if (body.description.trim()) next.description = body.description.slice(0, 2000);
          else delete next.description;
        }
        if (typeof body.starred === 'boolean') {
          if (body.starred) next.starred = true;
          else delete next.starred;
        }
        return next;
      });
      if (updated && movedToTask !== undefined) {
        updated = await attachVaultFileToTask(store, file.kind, roomCode, file.id, movedToTask || undefined) ?? updated;
      }
      res.status(200).json({ file: updated ? withLinks(updated) : null });
      return;
    }
    case 'delete': {
      const fileId = String(body.fileId ?? '');
      const file = await findVaultFile(store, roomCode, fileId);
      if (!file) {
        res.status(404).json({ error: 'file_not_found' });
        return;
      }
      if (!canDeleteFile(principal, file)) {
        res.status(403).json({ error: 'delete_forbidden', message: 'Only the uploader, the producer or the host can delete this file.' });
        return;
      }
      const blob = createBlobStore();
      if (!blob.ok) {
        res.status(503).json({ error: 'storage_unavailable', message: blob.message });
        return;
      }
      await deleteVaultFileWithObjects({ store, blob: blob.store }, roomCode, file.kind, file.id);
      res.status(200).json({ deleted: true, id: file.id, usage: await vaultUsage(store, roomCode) });
      return;
    }
    case 'usage': {
      res.status(200).json({ usage: await vaultUsage(store, roomCode) });
      return;
    }
    case 'mint': {
      const fileId = String(body.fileId ?? '');
      const file = await findVaultFile(store, roomCode, fileId);
      if (!file) {
        res.status(404).json({ error: 'file_not_found' });
        return;
      }
      res.status(200).json({ url: vaultDownloadPath(file), summary: vaultFileSummary(file) });
      return;
    }
    case 'sign': {
      // A file too large for a serverless request body goes straight from the
      // browser to the object store; the record is created only after the
      // server has seen the object.
      const blob = createBlobStore();
      if (!blob.ok) {
        res.status(503).json({ error: 'storage_unavailable', message: blob.message });
        return;
      }
      if (!blob.store.presignPut) {
        res.status(501).json({
          error: 'direct_upload_unavailable',
          message: `This deployment stores files in ${blob.store.backend}, which has no direct upload; use a file under `
            + `${(VAULT_INLINE_MAX_BYTES / 1024 / 1024).toFixed(1)} MB.`,
        });
        return;
      }
      const name = String(body.name ?? '').trim();
      if (!name) {
        res.status(400).json({ error: 'bad_request', message: 'name is required.' });
        return;
      }
      const size = Number(body.size);
      const mime = String(body.mime ?? 'application/octet-stream');
      const id = String(body.fileId ?? '');
      if (!/^vf_[a-f0-9]{16}$/.test(id)) {
        res.status(400).json({ error: 'bad_request', message: 'fileId must be minted by the client as vf_<16 hex>.' });
        return;
      }
      const key = vaultStorageKey(kind, roomCode, id, 1, name);
      const presigned = await blob.store.presignPut(key, mime, 900);
      res.status(200).json({ fileId: id, storageKey: key, upload: presigned, maxBytes: blob.store.maxBytes, size: Number.isFinite(size) ? size : 0 });
      return;
    }
    case 'complete': {
      const blob = createBlobStore();
      if (!blob.ok) {
        res.status(503).json({ error: 'storage_unavailable', message: blob.message });
        return;
      }
      const fileId = String(body.fileId ?? '');
      const storageKey = String(body.storageKey ?? '');
      const name = String(body.name ?? '');
      // The key must belong to THIS room and vault: otherwise a seat in one room
      // could register a record pointing at another room's object and read it
      // back through its own signed link.
      if (!/^vf_[a-f0-9]{16}$/.test(fileId) || !storageKey.startsWith(`vault/${kind}/${roomCode}/${fileId}/`) || !name) {
        res.status(400).json({ error: 'bad_request', message: 'complete needs the fileId, storageKey and name that sign returned.' });
        return;
      }
      const stat = await blob.store.stat(storageKey);
      if (!stat) {
        res.status(404).json({ error: 'upload_not_found', message: 'The uploaded object was not found.' });
        return;
      }
      const result = await uploadVaultFiles({ store, blob: blob.store }, {
        code: roomCode,
        kind,
        principal,
        items: [{
          name,
          mime: String(body.mime ?? 'application/octet-stream'),
          bytes: new Uint8Array(0),
          preassignedId: fileId,
          preassignedKey: storageKey,
          alreadyStored: true,
        }],
        ...(typeof body.folderId === 'string' ? { folderId: body.folderId } : {}),
        ...(Array.isArray(body.tags) ? { tags: normalizeVaultTags(body.tags) } : {}),
        ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
        ...(typeof body.description === 'string' ? { description: body.description } : {}),
        ...(typeof body.producer === 'string' ? { producer: body.producer } : {}),
        maxBytes: blob.store.maxBytes,
      });
      if (result.files.length === 0) {
        res.status(400).json({ error: 'upload_failed', failures: result.failures });
        return;
      }
      res.status(201).json({ file: withLinks(result.files[0]!), usage: await vaultUsage(store, roomCode) });
      return;
    }
    default:
      res.status(400).json({ error: 'bad_request', message: `Unknown op "${op}".` });
  }
}

