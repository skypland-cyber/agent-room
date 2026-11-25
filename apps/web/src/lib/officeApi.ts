// Browser client for /api/office.
//
// One POST per action, same-origin so the session cookie rides along. Errors
// keep the server's code and message: the office screens show exactly what the
// server refused ("login_required", "agent_daily_limit"), never a generic
// "something went wrong", because the boss is the one who has to fix it.
import type {
  OfficeAgent,
  OfficeArchive,
  OfficeAuditEntry,
  OfficeOverview,
  OfficeProject,
  OfficeSettings,
  OfficeTemplate,
} from '@agent-room/shared';

export interface OfficeStatus {
  configured: boolean;
  authenticated: boolean;
  needsSetup: boolean;
  weakPassword: boolean;
  usingSessionSecret: boolean;
  siteUrl: string;
  setup?: { env: string; steps: string[] };
  counts?: { agents: number; projects: number; templates: number; archives: number };
  settings?: OfficeSettings;
  integrations?: { redis: boolean; storage: boolean; mcpGrants: number };
}

export class OfficeApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly setup?: { env: string; steps: string[] }) {
    super(message);
    this.name = 'OfficeApiError';
  }
}

async function request<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch('/api/office', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...body }),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new OfficeApiError('network', 'Could not reach the office. Check the connection and try again.', 0);
  }
  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch { /* an empty body is still an error we can describe */ }
  if (!response.ok) {
    throw new OfficeApiError(
      String(payload.error ?? 'office_error'),
      String(payload.message ?? `The office refused that request (${response.status}).`),
      response.status,
      payload.setup as OfficeStatus['setup'],
    );
  }
  return payload as T;
}

export const officeStatus = () => request<OfficeStatus>('status');

export const officeLogin = (password: string) =>
  request<{ authenticated: boolean }>('login', { password });

export const officeLogout = () => request<{ authenticated: boolean }>('logout');

export const officeOverview = (options: { withoutRooms?: boolean } = {}) =>
  request<{ overview: OfficeOverview }>('overview', options).then(payload => payload.overview);

export const listAgents = () => request<{ agents: OfficeAgent[] }>('agents.list').then(payload => payload.agents);
export const saveAgent = (agent: Partial<OfficeAgent> & { name: string; role: string }) =>
  request<{ agent: OfficeAgent }>('agents.save', { agent }).then(payload => payload.agent);
export const deleteAgent = (id: string) => request<{ removed: boolean }>('agents.delete', { id });
export const pauseAgent = (id: string, paused: boolean) =>
  request<{ agent: OfficeAgent }>(paused ? 'agents.pause' : 'agents.resume', { id }).then(payload => payload.agent);

export const listProjects = () => request<{ projects: OfficeProject[] }>('projects.list').then(payload => payload.projects);
export const saveProject = (project: { id?: string; name: string; description?: string; status?: string; agentIds?: string[] }) =>
  request<{ project: OfficeProject }>('projects.save', { project }).then(payload => payload.project);
export const deleteProject = (id: string) => request<{ removed: boolean }>('projects.delete', { id });
export const addMemory = (projectId: string, memory: { title?: string; body: string; tags?: string; pinned?: boolean }) =>
  request<{ project: OfficeProject }>('projects.memory.add', { projectId, memory }).then(payload => payload.project);
export const updateMemory = (projectId: string, memoryId: string, memory: { title?: string; body: string; tags?: string; pinned?: boolean }) =>
  request<{ project: OfficeProject }>('projects.memory.update', { projectId, memoryId, memory }).then(payload => payload.project);
export const deleteMemory = (projectId: string, memoryId: string) =>
  request<{ project: OfficeProject }>('projects.memory.delete', { projectId, memoryId }).then(payload => payload.project);
export const addGuideline = (projectId: string, guideline: { title?: string; body: string }) =>
  request<{ project: OfficeProject }>('projects.guideline.add', { projectId, guideline }).then(payload => payload.project);
export const updateGuideline = (projectId: string, guidelineId: string, guideline: { title?: string; body: string }) =>
  request<{ project: OfficeProject }>('projects.guideline.update', { projectId, guidelineId, guideline }).then(payload => payload.project);
export const deleteGuideline = (projectId: string, guidelineId: string) =>
  request<{ project: OfficeProject }>('projects.guideline.delete', { projectId, guidelineId }).then(payload => payload.project);

export const pauseTask = (code: string, id: string, reason?: string) =>
  request<{ task: unknown }>('tasks.pause', { code, id, reason });
export const resumeTask = (code: string, id: string) => request<{ task: unknown }>('tasks.resume', { code, id });
export const abortTask = (code: string, id: string, reason?: string) => request<{ task: unknown }>('tasks.abort', { code, id, reason });
export const approveTask = (code: string, id: string, note?: string) => request<{ task: unknown }>('tasks.approve', { code, id, note });
export const rejectTask = (code: string, id: string, note?: string) => request<{ task: unknown }>('tasks.reject', { code, id, note });
export const retryTask = (code: string, id: string, options: { reason?: string; to?: string } = {}) =>
  request<{ task: unknown }>('tasks.retry', { code, id, ...options });
export const requestApproval = (code: string, id: string, reason?: string) =>
  request<{ task: unknown }>('tasks.requestApproval', { code, id, reason });
export const recordQa = (code: string, id: string, status: 'pending' | 'passed' | 'failed', notes?: string, reviewer?: string) =>
  request<{ task: unknown }>('tasks.qa', { code, id, status, notes, reviewer });

export interface ArchiveSummary {
  id: string;
  roomCode: string;
  topic: string;
  archivedAt: number;
  summary: string;
  messageCount: number;
  participants: string[];
  tags: string[];
  projectId?: string;
  snippet: string;
  matched: boolean;
}

export const listArchives = (query = '', limit = 50) =>
  request<{ archives: ArchiveSummary[]; query: string }>('archives.list', { query, limit }).then(payload => payload.archives);
export const getArchive = (id: string) => request<{ archive: OfficeArchive }>('archives.get', { id }).then(payload => payload.archive);
export const captureArchive = (code: string) =>
  request<{ id: string; roomCode: string; topic: string; messageCount: number }>('archives.capture', { code });
export const archiveRoomNow = captureArchive;
export const deleteArchive = (id: string) => request<{ removed: boolean }>('archives.delete', { id });

export const listAudit = (filter: Record<string, unknown> = {}) =>
  request<{ entries: OfficeAuditEntry[] }>('audit.list', { filter }).then(payload => payload.entries);

export const listTemplates = () => request<{ templates: OfficeTemplate[] }>('templates.list').then(payload => payload.templates);
export const saveTemplate = (template: Partial<OfficeTemplate> & { name: string; tasks: OfficeTemplate['tasks'] }) =>
  request<{ template: OfficeTemplate }>('templates.save', { template }).then(payload => payload.template);
export const deleteTemplate = (id: string) => request<{ removed: boolean }>('templates.delete', { id });
export const applyTemplate = (id: string) =>
  request<{ roomCode: string; joinUrl: string; roomUrl: string; tasks: unknown[]; skipped: string[]; seated: string[] }>('templates.apply', { id });

export const saveSettings = (settings: Partial<OfficeSettings>) =>
  request<{ settings: OfficeSettings }>('settings.save', { settings }).then(payload => payload.settings);

export const getUsage = () =>
  request<{
    settings: OfficeSettings;
    day: string;
    requests: number;
    writes: number;
    requestBudget: number;
    level: 'ok' | 'warn' | 'critical';
    agents: Array<{ id: string; name: string; tasksToday: number; limit: number; paused: boolean; enabled: boolean; level: string }>;
  }>('usage.get');

export const exportBackup = (includeBoards = false) =>
  request<{ backup: unknown }>('backup.export', { includeBoards }).then(payload => payload.backup);
export const restoreBackup = (backup: unknown, mode: 'merge' | 'replace') =>
  request<{ restored: Record<string, unknown>; mode: string }>('backup.restore', { backup, mode });
