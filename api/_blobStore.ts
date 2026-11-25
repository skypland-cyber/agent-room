// Where the vault's bytes live.
//
// Two backends, one interface, chosen by what the deployment actually has:
//
//   BLOB_READ_WRITE_TOKEN set  → Vercel Blob (a free store is enough; the
//                                account needs no paid add-on)
//   R2_* set                   → Cloudflare R2 through the S3 API
//
// Both are private by construction: nothing here ever returns a URL a browser
// or an agent can use without going back through /api/files, which re-checks
// the seat, the host key or the MCP grant and then streams the bytes. That is
// the difference between "files in a room" and "files on the public internet
// with an unguessable path".
//
// The adapter is intentionally tiny — put / get / delete / list / stat, plus
// an optional presigned PUT. Anything a backend cannot do is reported as
// undefined rather than emulated badly.

import type { BlobAccessType } from '@vercel/blob';

export type BlobBackendKind = 'vercel-blob' | 'r2';

export interface BlobReadResult {
  bytes: Buffer;
  contentType?: string;
  size: number;
}

export interface PresignedPut {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: number;
}

export interface BlobStore {
  readonly backend: BlobBackendKind;
  /** Hard ceiling this backend can accept in one object. */
  readonly maxBytes: number;
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<BlobReadResult | null>;
  delete(keys: string[]): Promise<number>;
  list(prefix: string): Promise<Array<{ key: string; size: number }>>;
  /** Object size, or null when the object is absent. */
  stat(key: string): Promise<{ size: number } | null>;
  /** Present only on backends that can hand a browser a time-limited PUT. */
  presignPut?(key: string, contentType: string, expiresInSeconds: number): Promise<PresignedPut>;
}

export const BLOB_MAX_BYTES = 25 * 1024 * 1024;

interface R2Env {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function readR2Env(env: NodeJS.ProcessEnv): R2Env | { missing: string[] } {
  const values = {
    R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
    R2_BUCKET: env.R2_BUCKET,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
  };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) return { missing };
  return {
    accountId: values.R2_ACCOUNT_ID!,
    bucket: values.R2_BUCKET!,
    accessKeyId: values.R2_ACCESS_KEY_ID!,
    secretAccessKey: values.R2_SECRET_ACCESS_KEY!,
  };
}

export type BlobStoreSuccess = { ok: true; store: BlobStore };

export type BlobStoreFailure = { ok: false; missing: string[]; message: string };

export type BlobStoreResult = BlobStoreSuccess | BlobStoreFailure;

/**
 * Narrow a lookup result to its failure branch.
 *
 * A plain `if (!result.ok)` narrows this union only while `strictNullChecks` is
 * on. Vercel compiles the API functions without it, so a call site that reads
 * `result.message` after a bare truthiness check fails there even though the
 * project's own `tsc` accepts it. The predicate narrows the same way under
 * either setting.
 */
export function blobStoreFailed(result: BlobStoreResult): result is BlobStoreFailure {
  return result.ok === false;
}

// The S3 client builds a credential provider chain on construction, which is
// slow and pointless per request; one client per lambda warm start is right.
let cachedR2: { key: string; store: BlobStore } | null = null;
let cachedBlob: { key: string; store: BlobStore } | null = null;

/**
 * Resolve the backend for this deployment.
 *
 * Vercel Blob wins when its token exists — it is the one store a free Vercel
 * account can create without a paid add-on. R2 stays fully supported because
 * that is what a deployment without a Blob store has been using.
 */
export function createBlobStore(env: NodeJS.ProcessEnv = process.env): BlobStoreResult {
  const blobToken = env.BLOB_READ_WRITE_TOKEN;
  if (blobToken) {
    if (cachedBlob && cachedBlob.key === blobToken) return { ok: true, store: cachedBlob.store };
    const store = createVercelBlobStore(blobToken);
    cachedBlob = { key: blobToken, store };
    return { ok: true, store };
  }
  const r2 = readR2Env(env);
  if ('missing' in r2) {
    return {
      ok: false,
      missing: r2.missing,
      message: 'No file storage is configured. Set BLOB_READ_WRITE_TOKEN (Vercel Blob) or '
        + 'R2_ACCOUNT_ID / R2_BUCKET / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY (Cloudflare R2).',
    };
  }
  const cacheKey = `${r2.accountId}:${r2.bucket}:${r2.accessKeyId}`;
  if (cachedR2 && cachedR2.key === cacheKey) return { ok: true, store: cachedR2.store };
  const store = createR2Store(r2);
  cachedR2 = { key: cacheKey, store };
  return { ok: true, store };
}

/** For tests and for a deployment that swaps credentials in-process. */
export function resetBlobStoreCache(): void {
  cachedBlob = null;
  cachedR2 = null;
}

function createVercelBlobStore(token: string): BlobStore {
  const access: BlobAccessType = 'private';
  return {
    backend: 'vercel-blob',
    maxBytes: BLOB_MAX_BYTES,
    async put(key, bytes, contentType) {
      const { put } = await import('@vercel/blob');
      await put(key, Buffer.from(bytes), {
        access,
        token,
        contentType,
        addRandomSuffix: false,
        allowOverwrite: true,
      });
    },
    async get(key) {
      const { get } = await import('@vercel/blob');
      const result = await get(key, { access, token, useCache: false });
      if (!result || result.statusCode !== 200 || !result.stream) return null;
      const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
      return {
        bytes,
        size: bytes.length,
        ...(result.blob.contentType ? { contentType: result.blob.contentType } : {}),
      };
    },
    async delete(keys) {
      if (keys.length === 0) return 0;
      const { del } = await import('@vercel/blob');
      await del(keys, { token });
      return keys.length;
    },
    async list(prefix) {
      const { list } = await import('@vercel/blob');
      const out: Array<{ key: string; size: number }> = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await list({ prefix, token, limit: 1000, ...(cursor ? { cursor } : {}) });
        for (const blob of result.blobs) out.push({ key: blob.pathname, size: blob.size });
        if (!result.hasMore || !result.cursor) break;
        cursor = result.cursor;
      }
      return out;
    },
    async stat(key) {
      const { head } = await import('@vercel/blob');
      try {
        const info = await head(key, { token });
        return { size: info.size };
      } catch {
        return null;
      }
    },
    // Vercel Blob has no presigned PUT in this SDK surface. Files above the
    // inline cap go through the server on R2 only, and the room UI says so.
  };
}

function createR2Store(r2: R2Env): BlobStore {
  let clientPromise: Promise<typeof import('@aws-sdk/client-s3')> | null = null;
  const sdk = () => {
    clientPromise ??= import('@aws-sdk/client-s3');
    return clientPromise;
  };
  let s3: import('@aws-sdk/client-s3').S3Client | null = null;
  const getClient = async () => {
    if (s3) return s3;
    const { S3Client } = await sdk();
    s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${r2.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: r2.accessKeyId, secretAccessKey: r2.secretAccessKey },
    });
    return s3;
  };

  return {
    backend: 'r2',
    maxBytes: BLOB_MAX_BYTES,
    async put(key, bytes, contentType) {
      const { PutObjectCommand } = await sdk();
      await (await getClient()).send(new PutObjectCommand({
        Bucket: r2.bucket,
        Key: key,
        Body: Buffer.from(bytes),
        ContentType: contentType,
      }));
    },
    async get(key) {
      const { GetObjectCommand } = await sdk();
      try {
        const out = await (await getClient()).send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
        const bytes = Buffer.from(await out.Body!.transformToByteArray());
        return {
          bytes,
          size: bytes.length,
          ...(out.ContentType ? { contentType: out.ContentType } : {}),
        };
      } catch (error) {
        const name = (error as { name?: string }).name;
        if (name === 'NoSuchKey' || name === 'NotFound') return null;
        throw error;
      }
    },
    async delete(keys) {
      if (keys.length === 0) return 0;
      const { DeleteObjectsCommand } = await sdk();
      const client = await getClient();
      let deleted = 0;
      // R2 caps DeleteObjects at 1000 keys per call.
      for (let i = 0; i < keys.length; i += 1000) {
        const slice = keys.slice(i, i + 1000);
        await client.send(new DeleteObjectsCommand({
          Bucket: r2.bucket,
          Delete: { Objects: slice.map(key => ({ Key: key })), Quiet: true },
        }));
        deleted += slice.length;
      }
      return deleted;
    },
    async list(prefix) {
      const { ListObjectsV2Command } = await sdk();
      const client = await getClient();
      const out: Array<{ key: string; size: number }> = [];
      let token: string | undefined;
      for (let page = 0; page < 20; page++) {
        const result = await client.send(new ListObjectsV2Command({
          Bucket: r2.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }));
        for (const item of result.Contents ?? []) out.push({ key: item.Key!, size: item.Size ?? 0 });
        if (!result.IsTruncated) break;
        token = result.NextContinuationToken;
      }
      return out;
    },
    async stat(key) {
      const { HeadObjectCommand } = await sdk();
      try {
        const out = await (await getClient()).send(new HeadObjectCommand({ Bucket: r2.bucket, Key: key }));
        return { size: out.ContentLength ?? 0 };
      } catch {
        return null;
      }
    },
    async presignPut(key, contentType, expiresInSeconds) {
      const { PutObjectCommand } = await sdk();
      const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
      const url = await getSignedUrl(
        await getClient(),
        new PutObjectCommand({ Bucket: r2.bucket, Key: key, ContentType: contentType }),
        { expiresIn: Math.max(60, Math.min(3600, expiresInSeconds)) },
      );
      return {
        url,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        expiresAt: Date.now() + expiresInSeconds * 1000,
      };
    },
  };
}

/**
 * Storage key for one revision of a file.
 *
 * The prefix is deliberately NOT `rooms/{code}/…`: ending a meeting deletes
 * that whole prefix (api/delete-room-blobs), and a deliverable has to survive
 * the meeting. The id and version make every key immutable, so a browser cache
 * or a signed URL can never blur two revisions together.
 */
export function vaultStorageKey(kind: 'material' | 'deliverable', code: string, id: string, version: number, name: string): string {
  const safe = name.replace(/[^\w.\-()\s]/g, '_').slice(0, 120) || 'file';
  return `vault/${kind}/${code}/${id}/v${version}/${safe}`;
}
