// Server values → Korean labels, in one place.
//
// The API keeps its English enum values (`pending_approval`, `working`,
// `failed`) — those are protocol, matched by tests and by the MCP tools — so the
// translation happens here, on the last step before the pixels.
import { t, type MessageKey } from './index.js';

const TASK_STATE_KEYS: Record<string, MessageKey> = {
  todo: 'state.todo',
  pending_approval: 'state.pending_approval',
  in_progress: 'state.in_progress',
  paused: 'state.paused',
  awaiting_review: 'state.awaiting_review',
  blocked: 'state.blocked',
  rejected: 'state.rejected',
  done: 'state.done',
  cancelled: 'state.cancelled',
  aborted: 'state.aborted',
};

const PRESENCE_KEYS: Record<string, MessageKey> = {
  working: 'presence.working',
  reviewing: 'presence.reviewing',
  idle: 'presence.idle',
  paused: 'presence.paused',
  offline: 'presence.offline',
};

const QA_KEYS: Record<string, MessageKey> = {
  pending: 'qa.pending',
  passed: 'qa.passed',
  failed: 'qa.failed',
};

const ROOM_STATUS_KEYS: Record<string, MessageKey> = {
  active: 'roomStatus.active',
  ended: 'roomStatus.ended',
};

/** The link states the office reports next to a seat's presence. */
const LINK_KEYS: Record<string, MessageKey> = {
  grace: 'staff.link.grace',
  recovering: 'staff.link.recovering',
  offline: 'staff.link.offline',
};

/**
 * How a seat is being driven, in the two lengths the floor needs.
 *
 * The name tag has room for a short chip; a card can carry the full words. Both
 * come from the same table so the canvas and the panels can never disagree, and
 * an unknown mode yields '' — the canvas and the cards then draw nothing rather
 * than claiming one of the two.
 */
const CONNECTION_KEYS: Record<string, { short: MessageKey; full: MessageKey; hint: MessageKey }> = {
  external: { short: 'conn.external', full: 'conn.external.full', hint: 'conn.external.hint' },
  delegated: { short: 'conn.delegated', full: 'conn.delegated.full', hint: 'conn.delegated.hint' },
};

/** '외부' / '대행' — the chip on a name tag. */
export function connectionModeChip(mode: string | undefined): string {
  const key = mode ? CONNECTION_KEYS[mode] : undefined;
  return key ? t(key.short) : '';
}

/** '외부 접속' / '망고 대행' — the badge on a card. */
export function connectionModeLabel(mode: string | undefined): string {
  const key = mode ? CONNECTION_KEYS[mode] : undefined;
  return key ? t(key.full) : '';
}

/** 'pending_approval' → '승인 대기'. Unknown states pass through untouched. */
export function taskStateLabel(state: string): string {
  const key = TASK_STATE_KEYS[state];
  return key ? t(key) : state.replace(/_/g, ' ');
}

/**
 * A staff member's presence. The shared package's `presence.label` is English
 * ('Available', 'Disabled'), so the status — plus `enabled` for the disabled
 * case — is what gets translated.
 */
export function presenceLabel(presence: { status: string }, enabled = true): string {
  if (!enabled) return t('presence.disabled');
  const key = PRESENCE_KEYS[presence.status];
  return key ? t(key) : presence.status;
}

export function qaStatusLabel(status: string): string {
  const key = QA_KEYS[status];
  return key ? t(key) : status;
}

export function roomStatusLabel(status: string): string {
  const key = ROOM_STATUS_KEYS[status];
  return key ? t(key) : status;
}

/**
 * A seat's link state, but only when it is worth saying.
 *
 * `live` and `unknown` return '' — a connected seat needs no badge, and the
 * presence badge beside it already says what it is doing. The two quiet states
 * are the ones a person acts on, so only those get words.
 */
export function linkStateLabel(state: string | undefined): string {
  const key = state ? LINK_KEYS[state] : undefined;
  return key ? t(key) : '';
}

/** The compact "1 working · 1 reviewing" legend under the floor title. */export function presenceCounts(counts: Map<string, number>): string {
  const order = ['working', 'reviewing', 'idle', 'paused', 'offline'];
  return order
    .filter(status => (counts.get(status) ?? 0) > 0)
    .map(status => {
      const key = PRESENCE_KEYS[status];
      return t('pixel.count', { count: counts.get(status) ?? 0, status: key ? t(key) : status });
    })
    .join(' · ');
}

/**
 * An audit entry's action code, read as a sentence: `task.approve` is
 * "업무 · 승인", `project.memory.add` is "프로젝트 · 기억 추가". The code itself
 * stays the record (it is what the filter buttons match on); only the badge
 * text is translated, and an unknown code keeps its own words.
 */
const AUDIT_PREFIX_KEYS: Record<string, MessageKey> = {
  login: 'audit.prefix.login',
  logout: 'audit.prefix.logout',
  agent: 'audit.prefix.agent',
  task: 'audit.prefix.task',
  project: 'audit.prefix.project',
  template: 'audit.prefix.template',
  archive: 'audit.prefix.archive',
  backup: 'audit.prefix.backup',
  settings: 'audit.prefix.settings',
  meeting: 'audit.prefix.meeting',
};

const AUDIT_NOUN_KEYS: Record<string, MessageKey> = {
  memory: 'audit.noun.memory',
  guideline: 'audit.noun.guideline',
  link: 'audit.noun.link',
};

const AUDIT_VERB_KEYS: Record<string, MessageKey> = {
  create: 'audit.verb.create',
  update: 'audit.verb.update',
  delete: 'audit.verb.delete',
  pause: 'audit.verb.pause',
  resume: 'audit.verb.resume',
  approve: 'audit.verb.approve',
  reject: 'audit.verb.reject',
  abort: 'audit.verb.abort',
  retry: 'audit.verb.retry',
  handoff: 'audit.verb.handoff',
  qa: 'audit.verb.qa',
  add: 'audit.verb.add',
  link: 'audit.verb.link',
  export: 'audit.verb.export',
  restore: 'audit.verb.restore',
  apply: 'audit.verb.apply',
  read: 'audit.verb.read',
  archive: 'audit.verb.archive',
  save: 'audit.verb.save',
  defaults: 'audit.verb.defaults',
  get: 'audit.verb.get',
};

export function auditActionLabel(action: string): string {
  const parts = action.split('.');
  const prefix = parts[0] ?? action;
  const prefixKey = AUDIT_PREFIX_KEYS[prefix];
  if (!prefixKey) return action;
  const head = t(prefixKey);
  if (parts.length === 1) return head;
  const verb = parts[parts.length - 1] ?? '';
  const noun = parts.length > 2 ? parts[1] : undefined;
  const nounKey = noun ? AUDIT_NOUN_KEYS[noun] : undefined;
  const verbKey = AUDIT_VERB_KEYS[verb];
  const tail = [nounKey ? t(nounKey) : noun, verbKey ? t(verbKey) : verb].filter(Boolean).join(' ');
  return tail ? `${head} · ${tail}` : head;
}
