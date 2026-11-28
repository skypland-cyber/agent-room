// The 3D office, with the meeting it is a picture of beside it.
//
// The artwork answers "is everyone all right?" at a glance; the team chat answers
// "what are they saying, and what did they decide?" — and the speech bubbles over
// the name tags are the one line that ties the two together. All three read the
// same room from the same hook, so the panel cannot show one moment while the
// staff show another.
//
// Which room is "the meeting": the one most of the staff are sitting in right now,
// then the one with the most open work, then the newest. The boss can pick another
// from the panel's header, and the bubbles follow.
import { useCallback, useMemo, useState } from 'react';
import type { OfficeAgentView, OfficeOverview, OfficeRoomSummary } from '@agent-room/shared';
import { useI18n } from '../../../i18n/index.js';
import { useRoomChat } from '../../../hooks/useRoomChat.js';
import { OfficeDiorama } from './OfficeDiorama.js';
import { dioramaSpeech, SPEECH_WINDOW_MS } from './dioramaBubbles.js';
import { TeamChat } from '../TeamChat.js';

/** The room the floor is a picture of, in the order a person would look for it. */
export function defaultChatRoom(overview: Pick<OfficeOverview, 'rooms'>, agents: OfficeAgentView[]): OfficeRoomSummary | undefined {
  const active = overview.rooms.filter(room => room.status === 'active');
  const seated = (room: OfficeRoomSummary) => agents.filter(agent => agent.presence.roomCode === room.code).length;
  return [...active].sort((a, b) =>
    (seated(b) - seated(a)) || (b.openTasks - a.openTasks) || (b.createdAt - a.createdAt))[0];
}

export function DioramaView({ overview, agents, now, onOpenRoom }: {
  overview: OfficeOverview;
  agents: OfficeAgentView[];
  now: number;
  onOpenRoom?: (code: string) => void;
}) {
  const { t } = useI18n();
  // A desk has the room for the panel beside the artwork; a phone does not, so
  // the chat starts collapsed there and opens as a sheet over the floor.
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return true;
    return window.matchMedia('(min-width: 640px)').matches;
  });
  const auto = useMemo(() => defaultChatRoom(overview, agents), [overview, agents]);
  const [picked, setPicked] = useState<string | undefined>();
  const code = picked && overview.rooms.some(room => room.code === picked) ? picked : auto?.code;

  // The bubbles need the conversation even while the panel is closed, so the room
  // is polled either way — slowly when nobody is reading it, and at the panel's
  // own pace while it is open. Both stop while the tab is in the background.
  const chat = useRoomChat(code, { pollMs: open ? 8_000 : 20_000 });

  const speech = useMemo(() => dioramaSpeech({
    agents,
    messages: chat.messages,
    now,
    roomCode: code,
    labels: { answering: t('diorama.answering'), reviewing: t('diorama.reviewing') },
  }), [agents, chat.messages, now, code, t]);

  const room = chat.room;
  const answeringNow = agents.filter(agent => agent.enabled && code && agent.presence.roomCode === code
    && (agent.presence.status === 'working' || agent.presence.status === 'reviewing'));
  // "회의 중" is a claim about the room, so it is only made when the room says so:
  // a seat is working in it, or somebody spoke in it recently.
  const live = room?.status === 'active' && (
    answeringNow.length > 0
    || chat.messages.some(message => message.time > now - SPEECH_WINDOW_MS)
  );
  const meeting = live
    ? {
      label: answeringNow.length > 0 ? t('diorama.meetingCount', { count: answeringNow.length }) : t('diorama.meeting'),
      count: answeringNow.length,
    }
    : null;

  const onSent = useCallback(() => { chat.refresh(); }, [chat]);

  return (
    <div className={open ? 'grid gap-3 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]' : 'grid gap-3'}>
      {open ? (
        <>
          {/* Desk: a column of the same screen, left of the floor. Phone: a sheet
              over the floor, with a backdrop that closes it. */}
          <div aria-hidden="true" className="fixed inset-0 z-30 bg-ink/20 sm:hidden" onClick={() => setOpen(false)} />
          <TeamChat
            chat={chat}
            rooms={overview.rooms}
            code={code}
            onCode={setPicked}
            agents={agents}
            onClose={() => setOpen(false)}
            onOpenRoom={onOpenRoom}
            onSent={onSent}
            className="fixed inset-x-0 bottom-0 z-40 max-h-[72dvh] rounded-b-none sm:static sm:z-auto sm:max-h-none sm:self-start sm:rounded-b-2xl sm:h-[min(560px,calc(100dvh-220px))] lg:h-[min(660px,calc(100dvh-200px))]"
          />
        </>
      ) : null}

      <div className="relative">
        <OfficeDiorama
          agents={agents}
          generatedAt={overview.generatedAt}
          speech={speech}
          meeting={meeting}
          onToggleChat={() => setOpen(current => !current)}
          chatOpen={open}
        />
      </div>
    </div>
  );
}
