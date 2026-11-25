import type * as storage from '@agent-room/upstash-client';
import { HostNameTakenError, RoomNotFoundError } from '@agent-room/upstash-client';

export { HostNameTakenError, RoomNotFoundError };
export type { TurnState } from '@agent-room/upstash-client';

export function roomProof(code: string) {
  return {
    hostKey: localStorage.getItem(`room:${code}:hostKey`) ?? sessionStorage.getItem(`room:${code}:hostKey`),
    seatKey: sessionStorage.getItem(`room:${code}:seatKey`),
  };
}

export function createClient() {
  return async function request<Result>(action: string, code: string, ...args: unknown[]): Promise<Result> {
    const response = await fetch('/api/room', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, code, ...roomProof(code), args }),
      cache: 'no-store',
    });
    const payload = await response.json();
    if (!response.ok) {
      if (payload.error === 'RoomNotFoundError') throw new RoomNotFoundError(code);
      if (payload.error === 'HostNameTakenError') throw new HostNameTakenError('');
      throw new Error(payload.message ?? 'Room request failed.');
    }
    return payload.result as Result;
  };
}

type RoomClient = ReturnType<typeof createClient>;
type StorageOperation<T> = T extends (store: storage.UpstashClient, code: string, ...args: infer Args) => Promise<infer Result>
  ? (client: RoomClient, code: string, ...args: Args) => Promise<Result>
  : never;

function operation<Name extends keyof typeof storage>(action: Name) {
  return ((client: RoomClient, code: string, ...args: unknown[]) =>
    client(action, code, ...args)) as StorageOperation<(typeof storage)[Name]>;
}

export function createRoom(client: RoomClient, input: storage.CreateRoomInput) {
  return client<storage.CreateRoomResult>('createRoom', input.code, input);
}

export async function joinRoom(client: RoomClient, code: string, participant: storage.JoinRoomResult['participant']) {
  const result = await client<storage.JoinRoomResult>('joinRoom', code, participant);
  if (result.seatKey) sessionStorage.setItem(`room:${code}:seatKey`, result.seatKey);
  return result;
}

export function createRoomReport(client: RoomClient, code: string) {
  return client<Awaited<ReturnType<typeof storage.createRoomReport>>>('createRoomReport', code);
}

export const appendMessage = operation('appendMessage');
export const appendSystemMessage = operation('appendSystemMessage');
export const blockTask = operation('blockTask');
export const cancelTask = operation('cancelTask');
export const createTask = operation('createTask');
export const directInvoke = operation('directInvoke');
export const endRoom = operation('endRoom');
export const getMessageTotalCount = operation('getMessageTotalCount');
export const getRoom = operation('getRoom');
export const getRoomReport = operation('getRoomReport');
export const getTaskBoard = operation('getTaskBoard');
export const getTurnState = operation('getTurnState');
export const hostSkipCurrent = operation('hostSkipCurrent');
export const listMessages = operation('listMessages');
export const publishTaskNotifications = operation('publishTaskNotifications');
export const reactivateRoom = operation('reactivateRoom');
export const reassignTaskRoles = operation('reassignTaskRoles');
export const removeParticipant = operation('removeParticipant');
export const resumeTask = operation('resumeTask');
export const setMuted = operation('setMuted');
export const setReplyMode = operation('setReplyMode');
export const updatePresence = operation('updatePresence');
export const updateTask = operation('updateTask');
export const verifyTask = operation('verifyTask');
