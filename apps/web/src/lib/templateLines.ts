// Template tasks in one textarea.
//
// A recurring job is a handful of lines, and a form with a title/tag/owner row
// per task is more UI than the job is worth. The format is
//   Title | tag | owner | approval
// with everything after the title optional. Parsing lives here, not in the
// panel, so the same rules can be tested and reused.
import type { OfficeTemplateTask } from '@agent-room/shared';

export function parseTaskLines(text: string): OfficeTemplateTask[] {
  return text.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 30)
    .map(line => {
      const [title = '', tag = '', owner = '', ...flags] = line.split('|').map(part => part.trim());
      const lower = flags.join('|').toLowerCase();
      return {
        title,
        ...(tag ? { tag: tag.toLowerCase() } : {}),
        ...(owner ? { owner } : {}),
        ...(lower.includes('approval') ? { requiresApproval: true } : {}),
      };
    })
    .filter(task => task.title.length > 0);
}

export function formatTaskLines(tasks: OfficeTemplateTask[]): string {
  return tasks.map(task => {
    const parts = [task.title, task.tag ?? '', task.owner ?? '', task.requiresApproval ? 'approval' : ''];
    while (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    return parts.join(' | ');
  }).join('\n');
}
