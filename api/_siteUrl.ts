// Public base URL of this deployment. Every link the server hands out is built
// from it: room join URLs, exported report URLs, and the commands printed by
// /install (which mirror the web UI's copy-paste blocks).
//
// Order of resolution:
//   1. SITE_URL      — set this on a self-hosted/custom-domain deployment.
//   2. PUBLIC_URL    — accepted as an alias for the same meaning.
//   3. DEFAULT_SITE_URL — the hosted instance this repo is deployed at.
//
// Kept dependency-free and inside `api/` on purpose: Vercel functions load it
// as plain Node at runtime, and the workspace packages ship TypeScript source
// that Node cannot execute (see the note at the top of api/report-page.ts).

export const DEFAULT_SITE_URL = 'https://agent-room-henna.vercel.app';

export function siteUrl(): string {
  const configured = (process.env.SITE_URL ?? process.env.PUBLIC_URL ?? '').trim();
  if (!configured) return DEFAULT_SITE_URL;
  const withScheme = /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
  return withScheme.replace(/\/+$/, '');
}
