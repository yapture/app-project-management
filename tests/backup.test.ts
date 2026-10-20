import { describe, expect, test } from 'bun:test';
import { createBackup, MAX_BACKUP_BYTES, parseBackup, type Task } from '../src/backup';

const task: Task = {
  id: 'task-1', raw: 'Ship feature #+alex #@launch #^q4 due:friday',
  title: 'Ship feature', assignee: 'alex', workspace: 'launch',
  priority: null, goal: 'q4', dueDate: 'friday', column: 'in-progress',
  createdAt: '2026-10-19T00:00:00.000Z',
};

describe('Project Management backup', () => {
  test('round trips every stored task field', () => {
    const backup = parseBackup(createBackup([task]));
    expect(backup.app).toBe('yapture-project-management');
    expect(backup.schemaVersion).toBe(1);
    expect(backup.tasks).toEqual([task]);
  });

  test('rejects foreign, future, malformed and duplicate records', () => {
    const valid = JSON.parse(createBackup([task]));
    for (const changed of [
      { ...valid, app: 'other' },
      { ...valid, schemaVersion: 2 },
      { ...valid, tasks: [{ ...task, column: 'unknown' }] },
      { ...valid, tasks: [task, task] },
      { ...valid, tasks: [{ ...task, dueDate: 42 }] },
    ]) expect(() => parseBackup(JSON.stringify(changed))).toThrow();
    expect(() => parseBackup('{')).toThrow();
  });

  test('rejects minified input that cannot be downloaded again within the backup cap', () => {
    const payload = JSON.parse(createBackup([task]));
    payload.tasks[0].title = '';
    const baseBytes = new TextEncoder().encode(JSON.stringify(payload)).length;
    payload.tasks[0].title = 'x'.repeat(MAX_BACKUP_BYTES - baseBytes - 1);
    const minified = JSON.stringify(payload);
    expect(new TextEncoder().encode(minified).length).toBe(MAX_BACKUP_BYTES - 1);
    expect(() => parseBackup(minified)).toThrow('1 MiB');
  });

  test('caps import and export size', () => {
    expect(() => parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1))).toThrow('1 MiB');
    expect(() => createBackup([{ ...task, raw: 'x'.repeat(MAX_BACKUP_BYTES) }])).toThrow('1 MiB');
  });
});
