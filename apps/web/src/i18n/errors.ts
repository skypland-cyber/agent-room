// Turning a failed request into a sentence the boss can act on.
//
// The API answers every refusal with a stable `error` code and an English
// `message` (`invalid_password`, `agent_daily_limit`, …). Those codes are
// protocol — API tests assert them, and an agent's tool result carries them — so
// the UI translates by code and only falls back to the server's own wording for
// a code it has never seen (a newer server, a new vault refusal).
import { OfficeApiError } from '../lib/officeApi.js';
import { VaultError } from '../lib/vaultApi.js';
import { format, t, type MessageKey, type Vars } from './index.js';

const OFFICE_ERROR_KEYS: Record<string, MessageKey> = {
  network: 'error.network',
  office_error: 'error.office_error',
  invalid_input: 'error.invalid_input',
  bad_request: 'error.bad_request',
  method_not_allowed: 'error.method_not_allowed',
  not_configured: 'error.not_configured',
  storage_unavailable: 'error.storage_unavailable',
  login_required: 'error.login_required',
  invalid_password: 'error.invalid_password',
  rate_limited: 'error.rate_limited',
  admin_not_configured: 'error.admin_not_configured',
  room_not_found: 'error.room_not_found',
  room_code_unavailable: 'error.room_code_unavailable',
  agent_not_found: 'error.agent_not_found',
  agent_daily_limit: 'error.agent_daily_limit',
  project_not_found: 'error.project_not_found',
  archive_not_found: 'error.archive_not_found',
  template_not_found: 'error.template_not_found',
};

/** Vault codes this client itself raises; server codes fall back to its message. */
const VAULT_ERROR_KEYS: Record<string, MessageKey> = {
  vault_failed: 'error.office_error',
  upload_failed: 'vault.uploadFailed',
  preview_failed: 'vault.preview.textFailed',
};

/** A message written in this app: a key, so it follows the language toggle. */
export interface LocalizedMessage {
  key: MessageKey;
  vars?: Vars;
}

export function message(key: MessageKey, vars?: Vars): LocalizedMessage {
  return { key, ...(vars ? { vars } : {}) };
}

function isLocalizedMessage(value: unknown): value is LocalizedMessage {
  return Boolean(value) && typeof value === 'object' && typeof (value as LocalizedMessage).key === 'string';
}

/**
 * Anything caught in a panel: an OfficeApiError/VaultError (translated by code),
 * a LocalizedMessage, a plain Error, or a string already chosen by the caller.
 */
export function errorText(cause: unknown): string | null {
  if (cause === null || cause === undefined || cause === '') return null;
  if (typeof cause === 'string') return cause;
  if (isLocalizedMessage(cause)) return format(cause.key, cause.vars);
  if (cause instanceof OfficeApiError) {
    if (cause.status === 401 && cause.code === 'login_required') return t('error.login_required');
    const key = OFFICE_ERROR_KEYS[cause.code];
    return key ? t(key) : cause.message;
  }
  if (cause instanceof VaultError) {
    const key = VAULT_ERROR_KEYS[cause.code];
    return key ? t(key) : cause.message;
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return t('common.failed');
}

/**
 * The floor's warning strip. The server writes these as English sentences for
 * any client, so the shapes it can produce are recognised and rewritten; a shape
 * this client does not know passes through as it arrived.
 */
export function warningText(warning: string): string {
  const usage = warning.match(/Office API usage today is at (\d+)% of the ([\d,]+) request budget\./);
  if (usage) return t('warning.usage', { percent: usage[1] ?? '', budget: usage[2] ?? '' });
  if (/Some AI staff are disabled/.test(warning)) return t('warning.disabledStaff');
  const approvals = warning.match(/(\d+) tasks? waiting for approval\./);
  if (approvals) return t('warning.approvals', { count: approvals[1] ?? '0' });
  // A room is about to vanish: the one warning that asks for an action today.
  const expiring = warning.match(/Room ([A-Z0-9-]+) expires in (\d+) days?\./);
  if (expiring) {
    const count = expiring[2] ?? '0';
    return t(count === '1' ? 'warning.roomExpiringOne' : 'warning.roomExpiring', { code: expiring[1] ?? '', count });
  }
  const expired = warning.match(/Room ([A-Z0-9-]+) has expired\./);
  if (expired) return t('warning.roomExpired', { code: expired[1] ?? '' });
  return warning;
}

/**
 * The setup card's steps. They come from `setupInstructions()` on the server so
 * the API and the card cannot drift; this client owns their Korean wording, in
 * the same fixed order, and shows the server's line for any step it does not
 * recognise (a future step, or a reworded one).
 */
const SETUP_STEP_KEYS: MessageKey[] = [
  'office.setup.step1',
  'office.setup.step2',
  'office.setup.step3',
  'office.setup.step4',
  'office.setup.step5',
];

export function setupStepsText(steps: string[], passwordMinLength: number): string[] {
  return steps.map((step, index) => {
    const key = SETUP_STEP_KEYS[index];
    return key ? format(key, { min: passwordMinLength }) : step;
  });
}

/**
 * The two usage notes the overview ships (cost measurement, midnight reset).
 * Same contract as the setup steps: fixed order, unknown lines pass through.
 */
const USAGE_NOTE_KEYS: MessageKey[] = ['limits.notes.cost', 'limits.notes.reset'];

export function usageNotesText(notes: string[], day: string): string[] {
  return notes.map((note, index) => {
    const key = USAGE_NOTE_KEYS[index];
    return key ? format(key, { day }) : note;
  });
}
