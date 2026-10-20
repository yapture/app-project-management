export type Col = 'todo' | 'in-progress' | 'review' | 'done';

export interface Task {
  id: string; raw: string; title: string;
  assignee: string | null; workspace: string | null;
  priority: string | null; goal: string | null;
  dueDate: string | null; column: Col; createdAt: string;
}

export const MAX_BACKUP_BYTES = 1024 * 1024;

export function isTask(value: unknown): value is Task {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  const nullableString = (field: string) => task[field] === null || typeof task[field] === 'string';
  return typeof task.id === 'string'
    && typeof task.raw === 'string'
    && typeof task.title === 'string'
    && typeof task.createdAt === 'string'
    && (task.column === 'todo' || task.column === 'in-progress' || task.column === 'review' || task.column === 'done')
    && nullableString('assignee')
    && nullableString('workspace')
    && nullableString('priority')
    && nullableString('goal')
    && nullableString('dueDate');
}

export interface ProjectManagementBackup {
  app: 'yapture-project-management';
  schemaVersion: 1;
  exportedAt: string;
  tasks: Task[];
}

export function createBackup(tasks: Task[]): string {
  const serialized = JSON.stringify({
    app: 'yapture-project-management', schemaVersion: 1,
    exportedAt: new Date().toISOString(), tasks,
  } satisfies ProjectManagementBackup, null, 2);
  if (new TextEncoder().encode(serialized).length > MAX_BACKUP_BYTES) throw new Error('Backup exceeds 1 MiB');
  return serialized;
}

export function parseBackup(text: string): ProjectManagementBackup {
  if (new TextEncoder().encode(text).length > MAX_BACKUP_BYTES) throw new Error('Backup exceeds 1 MiB');
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error('Backup is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid backup');
  const backup = value as Record<string, unknown>;
  if (backup.app !== 'yapture-project-management' || backup.schemaVersion !== 1
    || typeof backup.exportedAt !== 'string' || Number.isNaN(Date.parse(backup.exportedAt))
    || !Array.isArray(backup.tasks) || !backup.tasks.every(isTask)) {
    throw new Error('Invalid or unsupported Project Management backup');
  }
  const ids = new Set((backup.tasks as Task[]).map((task) => task.id));
  if (ids.size !== backup.tasks.length) throw new Error('Backup contains duplicate task IDs');
  createBackup(backup.tasks as Task[]);
  return backup as unknown as ProjectManagementBackup;
}
