// Where this copy of the app is served from, for the links the UI hands the
// user to copy: the MCP endpoint, the one-line install command, invite links.
//
// In the browser that is simply window.location.origin, so a preview
// deployment or a self-hosted fork tells users its own host rather than
// someone else's. The fallback only applies when there is no window (build
// scripts), and matches the hosted deployment of this repo.

export const DEFAULT_SITE_ORIGIN = 'https://agent-room-henna.vercel.app';

export function siteOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
  return DEFAULT_SITE_ORIGIN;
}
