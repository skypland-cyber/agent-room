// The 2D office: who is at their desk, who is in the review room, and who has
// gone quiet — drawn with plain SVG, no engine, no canvas loop.
//
// The picture is derived, never embellished: a desk is blue only while the
// board says that agent is executing something AND its heartbeat is fresh.
// Anything unknown is drawn empty and grey, because a dashboard that guesses
// "probably fine" is worse than one that admits it does not know.
import type { OfficeAgentStatus, OfficeAgentView } from '@agent-room/shared';

export const OFFICE_STATUS_STYLE: Record<OfficeAgentStatus, { label: string; dot: string; ring: string; desk: string; text: string }> = {
  working: { label: 'Working', dot: '#2563EB', ring: '#BFDBFE', desk: '#EFF6FF', text: '#1E40AF' },
  reviewing: { label: 'Reviewing', dot: '#D97706', ring: '#FDE68A', desk: '#FFFBEB', text: '#92400E' },
  idle: { label: 'Available', dot: '#059669', ring: '#A7F3D0', desk: '#ECFDF5', text: '#065F46' },
  paused: { label: 'Paused', dot: '#7C3AED', ring: '#DDD6FE', desk: '#F5F3FF', text: '#5B21B6' },
  offline: { label: 'Offline', dot: '#9CA3AF', ring: '#E5E7EB', desk: '#F9FAFB', text: '#6B7280' },
};

export const DESK_WIDTH = 150;
export const DESK_HEIGHT = 84;
export const DESK_GAP_X = 12;
export const DESK_GAP_Y = 30;
export const DESK_COLUMNS = 4;
export const DESK_ORIGIN = { x: 430, y: 64 };

/** Where the desks go. Pure so the layout can be tested without a DOM. */
export function layoutOfficeDesks(count: number): Array<{ x: number; y: number; column: number; row: number }> {
  return Array.from({ length: Math.max(0, count) }, (_, index) => {
    const column = index % DESK_COLUMNS;
    const row = Math.floor(index / DESK_COLUMNS);
    return {
      x: DESK_ORIGIN.x + column * (DESK_WIDTH + DESK_GAP_X),
      y: DESK_ORIGIN.y + row * (DESK_HEIGHT + DESK_GAP_Y),
      column,
      row,
    };
  });
}

export const MEETING_TABLE = { x: 84, y: 300, width: 290, height: 150 };

/** Seats around the review table. Eight fit comfortably; extras wrap around. */
export function meetingSeats(count: number): Array<{ x: number; y: number }> {
  const seats: Array<{ x: number; y: number }> = [];
  const cx = MEETING_TABLE.x + MEETING_TABLE.width / 2;
  const cy = MEETING_TABLE.y + MEETING_TABLE.height / 2;
  const radiusX = MEETING_TABLE.width / 2 + 26;
  const radiusY = MEETING_TABLE.height / 2 + 24;
  for (let index = 0; index < count; index += 1) {
    const angle = (Math.PI * 2 * index) / Math.max(count, 1) - Math.PI / 2;
    seats.push({ x: cx + Math.cos(angle) * radiusX, y: cy + Math.sin(angle) * radiusY });
  }
  return seats;
}

export function officeDeskHeight(agents: number): number {
  const rows = Math.max(1, Math.ceil(agents / DESK_COLUMNS));
  return Math.max(520, DESK_ORIGIN.y + rows * (DESK_HEIGHT + DESK_GAP_Y) + 40);
}

interface Props {
  agents: OfficeAgentView[];
  pendingApprovals: number;
  selectedId?: string;
  onSelect?: (agentId: string) => void;
  /** Shown instead of desks when the office has no staff yet. */
  onAddStaff?: () => void;
}

function initials(name: string): string {
  return name.split(/\s+/).map(part => part[0] ?? '').join('').slice(0, 2).toUpperCase() || 'AI';
}

export function Office2D({ agents, pendingApprovals, selectedId, onSelect, onAddStaff }: Props) {
  const height = officeDeskHeight(agents.length);
  const desks = layoutOfficeDesks(agents.length);
  const reviewing = agents.filter(agent => agent.presence.status === 'reviewing');
  const seats = meetingSeats(Math.max(reviewing.length, 1));
  const counts = agents.reduce<Record<string, number>>((acc, agent) => {
    acc[agent.presence.status] = (acc[agent.presence.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-white shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-faint px-5 py-3">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">The office floor</h2>
          <p className="text-xs text-ink-soft">Live from each agent&apos;s heartbeat and the work on the boards.</p>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-[11px] font-semibold text-ink-muted">
          {(['working', 'reviewing', 'idle', 'paused', 'offline'] as OfficeAgentStatus[]).map(status => (
            <span key={status} className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: OFFICE_STATUS_STYLE[status].dot }} />
              {OFFICE_STATUS_STYLE[status].label}
              <span className="font-mono text-ink-faint">{counts[status] ?? 0}</span>
            </span>
          ))}
        </div>
      </div>

      <svg
        role="img"
        aria-label={`Office floor plan with ${agents.length} AI staff. ${pendingApprovals} tasks waiting for approval.`}
        viewBox={`0 0 1000 ${height}`}
        className="h-auto w-full"
      >
        <defs>
          <pattern id="office-grid" width="28" height="28" patternUnits="userSpaceOnUse">
            <path d="M 28 0 L 0 0 0 28" fill="none" stroke="#EDEFF3" strokeWidth="1" />
          </pattern>
          <filter id="office-shadow" x="-10%" y="-10%" width="130%" height="140%">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="#101828" floodOpacity="0.06" />
          </filter>
        </defs>

        <rect x="0" y="0" width="1000" height={height} fill="#FAFBFC" />
        <rect x="0" y="0" width="1000" height={height} fill="url(#office-grid)" opacity="0.7" />

        {/* Boss desk — the approval gate lives here. */}
        <g>
          <rect x="40" y="48" width="300" height="120" rx="14" fill="#FFFFFF" stroke="#DCE1FF" strokeWidth="1.5" filter="url(#office-shadow)" />
          <rect x="62" y="132" width="256" height="14" rx="7" fill="#EEF0FF" />
          <circle cx="96" cy="96" r="22" fill="#5B6AFF" />
          <text x="96" y="101" textAnchor="middle" fontSize="14" fontWeight="700" fill="#FFFFFF">YOU</text>
          <text x="132" y="88" fontSize="15" fontWeight="700" fill="#111318">Boss desk</text>
          <text x="132" y="108" fontSize="12" fill="#6B7280">Approvals and stops land here</text>
          <g>
            <rect x="132" y="118" width={pendingApprovals > 0 ? 172 : 120} height="24" rx="12"
              fill={pendingApprovals > 0 ? '#FFFBEB' : '#F4F5F7'} stroke={pendingApprovals > 0 ? '#FDE68A' : '#E5E7EB'} />
            <text x="146" y="134" fontSize="12" fontWeight="700" fill={pendingApprovals > 0 ? '#92400E' : '#6B7280'}>
              {pendingApprovals > 0 ? `${pendingApprovals} waiting for approval` : 'Nothing waiting'}
            </text>
          </g>
        </g>

        {/* Review table. */}
        <g>
          <rect x={MEETING_TABLE.x} y={MEETING_TABLE.y} width={MEETING_TABLE.width} height={MEETING_TABLE.height}
            rx="26" fill="#FFFFFF" stroke="#E5E7EB" strokeWidth="1.5" filter="url(#office-shadow)" />
          <text x={MEETING_TABLE.x + MEETING_TABLE.width / 2} y={MEETING_TABLE.y + MEETING_TABLE.height / 2 - 4}
            textAnchor="middle" fontSize="13" fontWeight="700" fill="#374151">Review room</text>
          <text x={MEETING_TABLE.x + MEETING_TABLE.width / 2} y={MEETING_TABLE.y + MEETING_TABLE.height / 2 + 14}
            textAnchor="middle" fontSize="11" fill="#6B7280">
            {reviewing.length > 0 ? `${reviewing.length} checking someone else's work` : 'empty'}
          </text>
          {reviewing.map((agent, index) => {
            const seat = seats[index] ?? seats[0]!;
            const style = OFFICE_STATUS_STYLE[agent.presence.status];
            return (
              <g key={agent.id} className="cursor-pointer" onClick={() => onSelect?.(agent.id)}>
                <circle cx={seat.x} cy={seat.y} r="19" fill={style.desk} stroke={style.ring} strokeWidth="2" />
                <text x={seat.x} y={seat.y + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill={style.text}>{initials(agent.name)}</text>
                <text x={seat.x} y={seat.y + 32} textAnchor="middle" fontSize="10" fill="#6B7280">{agent.name}</text>
              </g>
            );
          })}
        </g>

        {/* Desks. */}
        {agents.map((agent, index) => {
          const desk = desks[index];
          if (!desk) return null;
          const style = OFFICE_STATUS_STYLE[agent.presence.status];
          const selected = selectedId === agent.id;
          return (
            <g
              key={agent.id}
              role="button"
              tabIndex={0}
              aria-label={`${agent.name}, ${agent.role}, ${style.label}`}
              className="cursor-pointer outline-none"
              onClick={() => onSelect?.(agent.id)}
              onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') onSelect?.(agent.id); }}
            >
              <rect x={desk.x} y={desk.y} width={DESK_WIDTH} height={DESK_HEIGHT} rx="12"
                fill={style.desk} stroke={selected ? '#5B6AFF' : style.ring} strokeWidth={selected ? 2.5 : 1.5}
                filter="url(#office-shadow)" />
              {/* monitor */}
              <rect x={desk.x + 12} y={desk.y + 14} width="52" height="34" rx="4" fill="#FFFFFF" stroke={style.ring} />
              {agent.presence.status === 'working' ? (
                <g>
                  {[0, 1, 2].map(i => (
                    <circle key={i} cx={desk.x + 26 + i * 11} cy={desk.y + 31} r="3" fill={style.dot} opacity={0.9}>
                      <animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin={`${i * 0.2}s`} repeatCount="indefinite" />
                    </circle>
                  ))}
                </g>
              ) : (
                <path d={`M ${desk.x + 18} ${desk.y + 38} L ${desk.x + 58} ${desk.y + 38}`} stroke={style.ring} strokeWidth="2" />
              )}
              {/* chair */}
              <circle cx={desk.x + 104} cy={desk.y + 52} r="17" fill={agent.presence.status === 'offline' ? '#F3F4F6' : style.ring}
                stroke={agent.presence.status === 'offline' ? '#E5E7EB' : style.dot} strokeWidth="1.5" strokeDasharray={agent.presence.status === 'offline' ? '3 3' : undefined} />
              <text x={desk.x + 104} y={desk.y + 56} textAnchor="middle" fontSize="10" fontWeight="700" fill={style.text}>
                {agent.presence.status === 'offline' ? '—' : initials(agent.name)}
              </text>
              {/* name plate */}
              <text x={desk.x + 12} y={desk.y + 68} fontSize="12" fontWeight="700" fill="#111318">{agent.name.slice(0, 16)}</text>
              <text x={desk.x + 12} y={desk.y + 80} fontSize="9.5" fill="#6B7280">{agent.role.slice(0, 24)}</text>
              {/* status dot */}
              <circle cx={desk.x + DESK_WIDTH - 14} cy={desk.y + 14} r="4" fill={style.dot} />
              {agent.presence.status === 'working' ? (
                <circle cx={desk.x + DESK_WIDTH - 14} cy={desk.y + 14} r="4" fill={style.dot}>
                  <animate attributeName="r" values="4;9;4" dur="1.8s" repeatCount="indefinite" />
                  <animate attributeName="opacity" values="0.6;0;0.6" dur="1.8s" repeatCount="indefinite" />
                </circle>
              ) : null}
            </g>
          );
        })}

        {agents.length === 0 ? (
          <g>
            <text x="700" y="110" textAnchor="middle" fontSize="14" fontWeight="600" fill="#6B7280">No AI staff yet</text>
            <text x="700" y="132" textAnchor="middle" fontSize="12" fill="#9CA3AF">Add the first employee on the Staff tab.</text>
            {onAddStaff ? (
              <g className="cursor-pointer" onClick={onAddStaff}>
                <rect x="612" y="150" width="176" height="34" rx="17" fill="#111318" />
                <text x="700" y="172" textAnchor="middle" fontSize="12" fontWeight="700" fill="#FFFFFF">Add AI staff</text>
              </g>
            ) : null}
          </g>
        ) : null}
      </svg>
    </div>
  );
}
