// Which way a seat is being driven, said the same way everywhere.
//
// The floor already draws this on the name tag, but the tag is painted on a
// canvas: there is nothing to hover, nothing to read with a screen reader, and a
// narrow phone tag has room for two syllables at most. The cards are where the
// full sentence fits, so the badge is one component rather than four copies of
// the same colours.
//
// Emerald is an outside client the boss opened, violet is a seat Mango is
// driving on that staff member's behalf. Nothing else in the office uses either
// colour for a badge, which is what makes the pair readable at a glance.
import type { OfficeConnectionMode } from '@agent-room/shared';
import { useI18n, type MessageKey } from '../../i18n/index.js';

const STYLE: Record<OfficeConnectionMode, { shell: string; dot: string; label: MessageKey; hint: MessageKey }> = {
  external: {
    shell: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    dot: 'bg-emerald-500',
    label: 'conn.external.full',
    hint: 'conn.external.hint',
  },
  delegated: {
    shell: 'bg-violet-50 text-violet-700 ring-violet-200',
    dot: 'bg-violet-500',
    label: 'conn.delegated.full',
    hint: 'conn.delegated.hint',
  },
};

/**
 * A staff card's connection badge. Unknown (an older heartbeat, or a seat that
 * never reported) renders nothing — a badge that guesses is worse than none.
 */
export function ConnectionBadge({ mode, className = '' }: { mode?: OfficeConnectionMode; className?: string }) {
  const { t } = useI18n();
  if (!mode) return null;
  const style = STYLE[mode];
  return (
    <span
      title={t(style.hint)}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${style.shell} ${className}`}
    >
      <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} />
      {t(style.label)}
    </span>
  );
}
