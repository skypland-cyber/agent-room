// Vercel Function: receives a multipart upload, validates size + mime,
// stores in Cloudflare R2 (S3-compatible) under
// `rooms/{code}/{uuid}/{filename}`, returns the MessageAttachment shape
// Codex's web composer can drop straight into a Message's `attachments`
// array.
//
// Storage backend: R2 instead of Vercel Blob, because the host's Vercel
// account hit a 2FA recovery wall that locks the Storage tab. R2 has
// no analogous gate and gives us zero egress as a bonus. R2 is S3-
// compatible, so we use @aws-sdk/client-s3 with a custom endpoint.
//
// Uploads require an active browser seat in the target room.

import { createRemoteRoomClient } from './_mcpRoomClient.js';
import { findSeat } from './_roomAccess.js';
import { getRoom, RoomNotFoundError } from '@agent-room/upstash-client';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { fieldValue, multipartBoundary, parseMultipart, readRequestBody, type ParsedPart } from './_multipart.js';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
  'application/json',
  'application/zip',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

export const config = { api: { bodyParser: false } };

interface R2Env {
  accountId: string;
  bucket: string;
  publicUrl: string;
  accessKeyId: string;
  secretAccessKey: string;
}

// Read every R2 var up front so we can return one clean 503 listing what's
// missing instead of crashing inside the SDK with a cryptic message.
function readR2Env(): R2Env | { missing: string[] } {
  const env = {
    accountId: process.env.R2_ACCOUNT_ID,
    bucket: process.env.R2_BUCKET,
    publicUrl: process.env.R2_PUBLIC_URL,
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  };
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) return { missing };
  return env as R2Env;
}

let cachedClient: S3Client | null = null;
function getR2Client(env: R2Env): S3Client {
  if (cachedClient) return cachedClient;
  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${env.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
  });
  return cachedClient;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', message: 'Use POST.' });
    return;
  }

  const env = readR2Env();
  if ('missing' in env) {
    res.status(503).json({
      error: 'r2_not_configured',
      message: `R2 credentials not set. Vercel project Settings → Environment Variables: missing ${env.missing.join(', ')}.`,
    });
    return;
  }

  const boundary = multipartBoundary(String(req.headers['content-type'] ?? ''));
  if (!boundary) {
    res.status(400).json({ error: 'invalid_multipart', message: 'Body must be multipart/form-data with a boundary.' });
    return;
  }

  let body: Buffer;
  try {
    body = await readRequestBody(req, MAX_BYTES + 1 * 1024 * 1024);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'read failed';
    res.status(413).json({ error: 'body_too_large', message: msg });
    return;
  }

  let parts: ParsedPart[];
  try {
    parts = parseMultipart(body, boundary);
  } catch (e) {
    res.status(400).json({ error: 'invalid_multipart', message: e instanceof Error ? e.message : 'parse failed' });
    return;
  }

  const fileParts: ParsedPart[] = parts.filter(p => p.name === 'file' && p.filename !== undefined);
  const filePart = fileParts[0];
  const roomCodePart = fieldValue(parts, 'roomCode');
  const widthPart = fieldValue(parts, 'width');
  const heightPart = fieldValue(parts, 'height');

  if (!filePart) {
    res.status(400).json({ error: 'missing_file', message: 'No file field in form data.' });
    return;
  }
  const roomCode = roomCodePart ?? '';
  if (!/^[A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(roomCode)) {
    res.status(400).json({ error: 'bad_room_code', message: 'Missing or malformed roomCode.' });
    return;
  }

  try {
    const { store } = createRemoteRoomClient(undefined);
    const room = await getRoom(store, roomCode);
    const seatKey = /^Bearer ([a-f0-9]{64})$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const seat = findSeat(room, 'web', seatKey);
    if (!seat || seat.canSpeak === false || room.status !== 'active') {
      res.status(403).json({ error: 'room_authorization_failed', message: 'Join an active room before uploading.' });
      return;
    }
  } catch (error) {
    res.status(error instanceof RoomNotFoundError ? 404 : 503).json({ error: 'room_authorization_failed' });
    return;
  }

  if (filePart.data.length === 0) {
    res.status(400).json({ error: 'empty_file', message: 'File is empty.' });
    return;
  }
  if (filePart.data.length > MAX_BYTES) {
    res.status(413).json({ error: 'file_too_large', message: `File exceeds ${MAX_BYTES} bytes (10 MB).` });
    return;
  }
  const mime = filePart.contentType ?? 'application/octet-stream';
  if (!ALLOWED_MIMES.has(mime)) {
    res.status(415).json({ error: 'mime_not_allowed', message: `Unsupported MIME type: ${mime}` });
    return;
  }

  const id = randomUUID();
  const safeName = (filePart.filename ?? 'file').replace(/[/\\]/g, '_').slice(0, 200) || 'file';
  const key = `rooms/${roomCode}/${id}/${safeName}`;

  try {
    await getR2Client(env).send(new PutObjectCommand({
      Bucket: env.bucket,
      Key: key,
      Body: filePart.data,
      ContentType: mime,
      // Cache aggressively: object keys are content-addressable
      // (uuid in path) so an attachment's bytes never change.
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    res.status(500).json({ error: 'r2_put_failed', message: `R2 upload failed: ${msg}` });
    return;
  }

  // Public URL via the R2.dev subdomain (or custom domain if you swap it
  // later — we just env-var the prefix so the swap is one variable change).
  const publicUrl = `${env.publicUrl.replace(/\/$/, '')}/${key}`;

  const isImage = mime.startsWith('image/');
  const widthNum = widthPart ? Number(widthPart) : NaN;
  const heightNum = heightPart ? Number(heightPart) : NaN;

  const attachment = {
    id,
    type: isImage ? 'image' : 'file',
    url: publicUrl,
    storageKey: key,
    name: filePart.filename ?? 'file',
    size: filePart.data.length,
    mime,
    uploadedAt: Date.now(),
    ...(isImage && Number.isFinite(widthNum) && widthNum > 0 ? { width: widthNum } : {}),
    ...(isImage && Number.isFinite(heightNum) && heightNum > 0 ? { height: heightNum } : {}),
  };

  res.status(201).json(attachment);
}
