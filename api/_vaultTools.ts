// The vault half of the MCP surface: room_files (what came in) and
// room_deliverable (what went out).
//
// Both are one tool with an `action` enum, matching how the rest of this
// endpoint is shaped — a model picks a tool, and the action picks the verb, so
// the tool list does not grow by a dozen entries. The two names exist because
// the mental model matters: an agent asked to "read the quote we uploaded"
// should not have to reason about which of six tools owns that file.
//
// Reading is the important half. `read` returns the file's text in slices with
// a cursor, plus a signed URL for anything it cannot parse, plus the actual
// pixels for an image — so an agent can answer a question about a screenshot
// without the user describing it.

import type { VaultFile, VaultFileKind } from '@agent-room/shared';
import {
  VAULT_MCP_INLINE_MAX_BYTES,
  VAULT_READ_DEFAULT_CHARS,
  VAULT_READ_MAX_CHARS,
  formatVaultBytes,
  normalizeVaultTags,
  vaultFileSummary,
  vaultMatchSnippet,
  vaultPreviewKind,
  vaultVersionLabel,
} from '@agent-room/shared';
import {
  attachVaultFileToTask,
  deleteVaultFolder,
  createVaultFolder,
  listVaultFiles,
  listVaultFolders,
  searchVaultFiles,
  updateVaultFile,
  vaultFilesForTask,
  vaultUsage,
} from '@agent-room/upstash-client';
import { createRemoteRoomClient, type RemoteRoomClient } from './_mcpRoomClient.js';
import { createBlobStore } from './_blobStore.js';
import { siteUrl } from './_siteUrl.js';
import { canDeleteFile } from './_fileAccess.js';
import {
  VaultRequestError,
  deleteVaultFileWithObjects,
  findVaultFile,
  readVaultFileSlice,
  reviseVaultFile,
  uploadVaultFiles,
  vaultDownloadUrl,
} from './_vault.js';

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface VaultToolResult {
  content: McpContent[];
  isError?: boolean;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

function result(value: unknown, extra: McpContent[] = []): VaultToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }, ...extra] };
}

function fail(error: string, hint: string): VaultToolResult {
  return { ...result({ error, hint }), isError: true };
}

/** The row an agent gets for a file: enough to choose, no text blob. */
function row(file: VaultFile) {
  return {
    ...vaultFileSummary(file),
    version: vaultVersionLabel(file.version),
    sizeLabel: formatVaultBytes(file.size),
    readHint: file.extractedText
      ? `${file.extractedText.length} characters of text available — action "read" with fileId.`
      : 'No text in the record — action "read" returns a download URL for the original bytes.',
    preview: vaultPreviewKind(file.mime, file.name),
  };
}

function inlineBytes(args: Record<string, unknown>): Uint8Array | null {
  const base64 = text(args.contentBase64).trim();
  if (base64) {
    // Accept a data: URL as well as bare base64 — clients paste both.
    const payload = base64.startsWith('data:') ? base64.slice(base64.indexOf(',') + 1) : base64;
    const bytes = Buffer.from(payload, 'base64');
    return bytes.length > 0 ? bytes : null;
  }
  const body = text(args.text);
  return body ? Buffer.from(body, 'utf8') : null;
}

async function resolveFile(client: RemoteRoomClient, code: string, args: Record<string, unknown>): Promise<VaultFile | null> {
  const fileId = text(args.fileId).trim();
  if (fileId) return findVaultFile(client.store, code, fileId);
  const wanted = text(args.fileName).trim().toLowerCase();
  if (!wanted) return null;
  const files = await searchVaultFiles(client.store, code, wanted, { limit: 20 });
  return files.find(file => file.name.toLowerCase() === wanted)
    ?? files.find(file => file.name.toLowerCase().includes(wanted))
    ?? null;
}

export async function runVaultTool(
  kind: VaultFileKind,
  client: RemoteRoomClient,
  args: Record<string, unknown>,
): Promise<VaultToolResult> {
  const code = text(args.code);
  const action = text(args.action) || 'list';
  const caller = text(args.name).trim();
  if (!code) return fail('bad_request', 'code is required.');
  const principal = { name: caller || 'agent', client: 'cc' as const, isHost: false, via: 'seat' as const };

  switch (action) {
    case 'list': {
      const wantsAll = args.all === true;
      const filter = {
        ...(typeof args.folderId === 'string' ? { folderId: args.folderId } : {}),
        ...(typeof args.tag === 'string' ? { tag: args.tag } : {}),
        ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
        ...(typeof args.category === 'string' ? { category: args.category } : {}),
        ...(typeof args.query === 'string' && args.query.trim() ? { query: args.query.trim() } : {}),
        limit: typeof args.limit === 'number' ? Math.min(200, Math.max(1, args.limit)) : 100,
      };
      const files = wantsAll
        ? await searchVaultFiles(client.store, code, text(args.query), filter)
        : await listVaultFiles(client.store, kind, code, filter);
      const [folders, usage] = await Promise.all([listVaultFolders(client.store, code), vaultUsage(client.store, code)]);
      return result({
        vault: kind,
        files: files.map(row),
        folders: folders.map(folder => ({ id: folder.id, name: folder.name })),
        usage: {
          files: kind === 'material' ? usage.materials.files : usage.deliverables.files,
          bytesLabel: formatVaultBytes(usage.bytes),
          limitLabel: formatVaultBytes(usage.limitBytes),
        },
        ...(files.length === 0 ? { hint: kind === 'material' ? 'No materials yet. A person uploads them in the room Files tab; you can also action "upload".' : 'No deliverables yet. Register one with action "upload".' } : {}),
      });
    }

    case 'search': {
      const query = text(args.query).trim();
      if (!query) return fail('bad_request', 'search needs a query.');
      const files = await searchVaultFiles(client.store, code, query, { limit: 50 });
      return result({
        query,
        matches: files.map(file => ({ ...row(file), ...(vaultMatchSnippet(file, query) ? { snippet: vaultMatchSnippet(file, query) } : {}) })),
        ...(files.length === 0 ? { hint: 'Nothing matched by name, tag, description or text content.' } : {}),
      });
    }

    case 'read': {
      const file = await resolveFile(client, code, args);
      if (!file) return fail('file_not_found', 'Pass fileId from action "list", or fileName. Both vaults are searched.');
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const limit = typeof args.limit === 'number' ? Math.min(VAULT_READ_MAX_CHARS, Math.max(1, args.limit)) : VAULT_READ_DEFAULT_CHARS;
      const slice = readVaultFileSlice(file, offset, limit);
      const url = vaultDownloadUrl(file, 30 * 60_000);
      const extra: McpContent[] = [];
      // Pixels, not a description: a vision-capable agent can read a screenshot
      // or a scanned page, which is exactly what "read the uploaded material"
      // means for an image.
      if (file.category === 'image' && /^image\/(png|jpeg|jpg|webp|gif)$/i.test(file.mime) && file.size <= 4 * 1024 * 1024) {
        const blob = createBlobStore();
        if (blob.ok) {
          try {
            const object = await blob.store.get(file.storageKey);
            if (object) extra.push({ type: 'image', data: object.bytes.toString('base64'), mimeType: file.mime });
          } catch { /* the metadata below still stands */ }
        }
      }
      return result({
        file: row(file),
        ...(slice
          ? {
            text: slice.text,
            offset: slice.offset,
            totalChars: slice.total,
            nextOffset: slice.nextOffset,
            extraction: { kind: slice.kind, approximate: slice.approximate },
          }
          : { text: null, note: 'No readable text is stored for this file type; use downloadUrl to fetch the original.' }),
        downloadUrl: url,
        previewUrl: url ? `${url}&inline=1` : null,
        hint: slice?.nextOffset
          ? `More text remains — call read again with offset ${slice.nextOffset}.`
          : 'This is the whole readable text.',
      }, extra);
    }

    case 'upload': {
      const name = text(args.fileName).trim() || text(args.name).trim();
      const bytes = inlineBytes(args);
      if (!name) return fail('bad_request', 'fileName is required (the file\'s name, including its extension).');
      if (!bytes) return fail('bad_request', 'upload needs the content: pass "text" for text/code/markdown, or "contentBase64" for anything binary.');
      if (bytes.length > VAULT_MCP_INLINE_MAX_BYTES) {
        return fail('file_too_large',
          `${formatVaultBytes(bytes.length)} exceeds the ${formatVaultBytes(VAULT_MCP_INLINE_MAX_BYTES)} tool-argument limit. `
          + 'Upload it over HTTP with the seat key: curl -H "Authorization: Bearer $SEAT_KEY" -F "roomCode=..." -F "kind=deliverable" -F "file=@path" '
          + `${siteUrl()}/api/files`);
      }
      const blob = createBlobStore();
      if (!blob.ok) return fail('storage_unavailable', blob.message);
      try {
        const uploaded = await uploadVaultFiles({ store: client.store, blob: blob.store }, {
          code,
          kind,
          principal,
          items: [{
            name,
            mime: text(args.mime) || guessMime(name),
            bytes,
            ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
          }],
          ...(typeof args.folderId === 'string' ? { folderId: args.folderId } : {}),
          ...(Array.isArray(args.tags) || typeof args.tags === 'string' ? { tags: normalizeVaultTags(args.tags) } : {}),
          ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          ...(typeof args.producer === 'string' ? { producer: args.producer } : {}),
        });
        if (uploaded.files.length === 0) return fail(uploaded.failures[0]?.error ?? 'upload_failed', uploaded.failures[0]?.message ?? 'Upload failed.');
        const file = uploaded.files[0]!;
        return result({
          file: row(file),
          downloadUrl: vaultDownloadUrl(file),
          hint: kind === 'deliverable'
            ? 'Registered in the deliverables vault. It survives the meeting; a later revision of the same work is action "update" with this fileId.'
            : 'Stored in the materials vault for this room.',
        });
      } catch (error) {
        if (error instanceof VaultRequestError) return fail(error.code, error.message);
        throw error;
      }
    }

    case 'update': {
      const fileId = text(args.fileId).trim();
      if (!fileId) return fail('bad_request', 'update needs the fileId of the file to revise.');
      const bytes = inlineBytes(args);
      const current = await findVaultFile(client.store, code, fileId);
      if (!current) return fail('file_not_found', 'No such file in this room vault.');
      if (!bytes && !args.description && !args.tags && !args.taskId && !args.folderId) {
        return fail('bad_request', 'update needs new content (text/contentBase64) or a metadata change (description, tags, taskId, folderId).');
      }
      try {
        if (bytes) {
          if (bytes.length > VAULT_MCP_INLINE_MAX_BYTES) {
            return fail('file_too_large', `${formatVaultBytes(bytes.length)} exceeds the ${formatVaultBytes(VAULT_MCP_INLINE_MAX_BYTES)} tool-argument limit.`);
          }
          const blob = createBlobStore();
          if (!blob.ok) return fail('storage_unavailable', blob.message);
          const revised = await reviseVaultFile({ store: client.store, blob: blob.store }, {
            code,
            principal,
            fileId,
            bytes,
            ...(text(args.fileName) ? { name: text(args.fileName) } : {}),
            ...(text(args.mime) ? { mime: text(args.mime) } : {}),
            ...(text(args.note) ? { note: text(args.note) } : {}),
            ...(typeof args.taskId === 'string' ? { taskId: args.taskId } : {}),
            maxBytes: VAULT_MCP_INLINE_MAX_BYTES,
          });
          return result({
            file: row(revised.file),
            downloadUrl: vaultDownloadUrl(revised.file),
            hint: `${vaultVersionLabel(revised.file.version)} registered; earlier versions stay in the history.`,
          });
        }
        const updated = await updateVaultFile(client.store, current.kind, code, fileId, file => ({
          ...file,
          ...(text(args.description) ? { description: text(args.description).slice(0, 2000) } : {}),
          ...(Array.isArray(args.tags) || typeof args.tags === 'string' ? { tags: normalizeVaultTags(args.tags) } : {}),
          ...(typeof args.folderId === 'string' ? { folderId: args.folderId } : {}),
        }));
        if (updated && typeof args.taskId === 'string') await attachVaultFileToTask(client.store, updated.kind, code, fileId, args.taskId || undefined);
        return result({ file: updated ? row(updated) : null });
      } catch (error) {
        if (error instanceof VaultRequestError) return fail(error.code, error.message);
        throw error;
      }
    }

    case 'link': {
      const file = await resolveFile(client, code, args);
      if (!file) return fail('file_not_found', 'Pass fileId or fileName.');
      const taskId = text(args.taskId).trim();
      const updated = await attachVaultFileToTask(client.store, file.kind, code, file.id, taskId || undefined);
      return result({
        file: updated ? row(updated) : null,
        ...(taskId ? { hint: `Linked to ${taskId}. A submit for that task can now list this deliverable.` } : { hint: 'Unlinked from its task.' }),
      });
    }

    case 'delete': {
      const file = await resolveFile(client, code, args);
      if (!file) return fail('file_not_found', 'Pass fileId or fileName.');
      if (!canDeleteFile(principal, file)) {
        return fail('delete_forbidden', 'Only the uploader, the producer or the host can delete this file. Ask the host to remove it.');
      }
      const blob = createBlobStore();
      if (!blob.ok) return fail('storage_unavailable', blob.message);
      await deleteVaultFileWithObjects({ store: client.store, blob: blob.store }, code, file.kind, file.id);
      return result({ deleted: true, id: file.id, name: file.name });
    }

    case 'folders':
      return result({ folders: (await listVaultFolders(client.store, code)).map(folder => ({ id: folder.id, name: folder.name, parentId: folder.parentId ?? null })) });

    case 'create_folder': {
      const name = text(args.folderName).trim() || text(args.query).trim();
      if (!name) return fail('bad_request', 'create_folder needs folderName.');
      try {
        const folder = await createVaultFolder(client.store, code, { name, createdBy: caller || 'agent' });
        return result({ folder });
      } catch (error) {
        return fail('folder_failed', (error as Error).message);
      }
    }

    case 'delete_folder': {
      const folderId = text(args.folderId).trim();
      if (!folderId) return fail('bad_request', 'delete_folder needs folderId.');
      return result(await deleteVaultFolder(client.store, code, folderId));
    }

    case 'usage':
      return result(await vaultUsage(client.store, code));

    default:
      return fail('bad_request', `action must be one of: list, search, read, upload, update, link, delete, folders, create_folder, delete_folder, usage.`);
  }
}

/** Files a task should show, newest revision last. Used by submit/verify. */
export async function taskVaultFiles(client: RemoteRoomClient, code: string, taskId: string): Promise<VaultFile[]> {
  try {
    return await vaultFilesForTask(client.store, code, taskId);
  } catch {
    return [];
  }
}

export function vaultClient(): RemoteRoomClient {
  return createRemoteRoomClient(undefined);
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const table: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html',
    ts: 'text/plain', tsx: 'text/plain', js: 'text/plain', py: 'text/plain', sql: 'text/plain',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf', zip: 'application/zip', mp4: 'video/mp4',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return table[ext] ?? 'text/plain';
}
