// The boss's door into the office.
//
// One password (`ADMIN_PASSWORD`) and one signed cookie. There is no user
// table and no session store: the cookie carries a short-lived HMAC-signed
// payload, so a restart or a cold serverless instance cannot log the boss out
// and a stolen Redis key cannot mint a session. The signing key is derived
// from the password (or from `OFFICE_SESSION_SECRET` when the deployment sets
// one), which means rotating the password invalidates every open session —
// the behaviour you want from a single shared secret.
//
// Everything here is deliberately boring: constant-time comparison, HttpOnly +
// SameSite=Lax, `Secure` whenever the request arrived over HTTPS (Vercel
// always), and a hard lock on every write while `ADMIN_PASSWORD` is unset.
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const OFFICE_COOKIE = 'ar_office_session';
export const OFFICE_SESSION_TTL_SECONDS = 12 * 60 * 60;
const CLOCK_SKEW_SECONDS = 60;

export interface OfficeSession {
  sub: 'owner';
  iat: number;
  exp: number;
}

export interface OfficeAuthState {
  configured: boolean;
  /** True when the password looks weak — shown in the setup card, never blocks. */
  weakPassword: boolean;
  usingSessionSecret: boolean;
  passwordMinLength: number;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const b64url = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const fromB64url = (value: string) => Buffer.from(value, 'base64url');

export function adminPassword(): string {
  return (process.env.ADMIN_PASSWORD ?? '').trim();
}

export function officeAuthState(): OfficeAuthState {
  const password = adminPassword();
  const explicitSecret = (process.env.OFFICE_SESSION_SECRET ?? '').trim();
  return {
    configured: password.length > 0,
    weakPassword: password.length > 0 && password.length < 12,
    usingSessionSecret: explicitSecret.length >= 16,
    passwordMinLength: 12,
  };
}

/** The HMAC key. Never returned to a client; nothing here is logged. */
function signingKey(): string | null {
  const explicit = (process.env.OFFICE_SESSION_SECRET ?? '').trim();
  if (explicit.length >= 16) return explicit;
  const password = adminPassword();
  if (!password) return null;
  return createHmac('sha256', 'agent-room-office-session')
    .update(`v1:${password}`)
    .digest('hex');
}

export function verifyPassword(input: unknown): boolean {
  const expected = adminPassword();
  if (!expected) return false;
  if (typeof input !== 'string' || input.length === 0 || input.length > 200) return false;
  // Hash both sides so the comparison is length-independent and constant time.
  return timingSafeEqual(sha256(input), sha256(expected));
}

export function signSession(nowSeconds: number = Math.floor(Date.now() / 1000)): string | null {
  const key = signingKey();
  if (!key) return null;
  const payload: OfficeSession = { sub: 'owner', iat: nowSeconds, exp: nowSeconds + OFFICE_SESSION_TTL_SECONDS };
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${signature}`;
}

export function verifySessionToken(
  token: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): OfficeSession | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 4096) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) return null;
  const key = signingKey();
  if (!key) return null;
  let expected: Buffer;
  try {
    expected = fromB64url(createHmac('sha256', key).update(body).digest('base64url'));
  } catch {
    return null;
  }
  let presented: Buffer;
  try {
    presented = fromB64url(signature);
  } catch {
    return null;
  }
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  let payload: OfficeSession;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8')) as OfficeSession;
  } catch {
    return null;
  }
  if (!payload || payload.sub !== 'owner' || !Number.isFinite(payload.exp) || !Number.isFinite(payload.iat)) return null;
  if (payload.exp + CLOCK_SKEW_SECONDS < nowSeconds) return null;
  if (payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  return payload;
}

export function parseCookies(header: unknown): Record<string, string> {
  if (typeof header !== 'string' || !header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function sessionFromRequest(req: VercelRequest): OfficeSession | null {
  const cookies = parseCookies(req.headers?.cookie);
  return verifySessionToken(cookies[OFFICE_COOKIE]);
}

function isSecureRequest(req: VercelRequest): boolean {
  const proto = String(req.headers?.['x-forwarded-proto'] ?? '').split(',')[0]?.trim() ?? '';
  return proto === 'https' || Boolean(req.headers?.['x-vercel-id']);
}

export function setSessionCookie(req: VercelRequest, res: VercelResponse, token: string): void {
  const flags = [
    `${OFFICE_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${OFFICE_SESSION_TTL_SECONDS}`,
  ];
  if (isSecureRequest(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

export function clearSessionCookie(req: VercelRequest, res: VercelResponse): void {
  const flags = [`${OFFICE_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) flags.push('Secure');
  res.setHeader('Set-Cookie', flags.join('; '));
}

/**
 * The setup card's instructions. Kept here so the API and the UI cannot drift:
 * the dashboard prints exactly what the server says it needs.
 */
export function setupInstructions(state: OfficeAuthState): { env: string; steps: string[] } {
  return {
    env: 'ADMIN_PASSWORD',
    steps: [
      'Open the Vercel project → Settings → Environment Variables.',
      `Add ADMIN_PASSWORD with a value of at least ${state.passwordMinLength} characters (60+ random characters recommended).`,
      'Optionally add OFFICE_SESSION_SECRET (32+ random characters) so rotating the password does not have to be the only way to revoke sessions.',
      'Redeploy (or wait for the next deployment) so the new variable reaches the serverless functions.',
      'Reload this page and sign in.',
    ],
  };
}
