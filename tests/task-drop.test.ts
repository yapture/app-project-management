import { expect, test } from 'bun:test';
import { resolveTaskDropId } from '../src/App';
import { createBackup, parseBackup, type Task } from '../src/backup';

for (const id of ['', 'task-1', 'quote"id', 'line\nid', ' spaced ']) {
  test(`active board drag preserves accepted task ID ${JSON.stringify(id)}`, () => {
    const task: Task = {
      id, title: 'Task', raw: 'Task', column: 'todo', goal: null,
      assignee: null, workspace: null, priority: null, dueDate: null, createdAt: '2026-10-21T00:00:00Z',
    };
    const restored = parseBackup(createBackup([task])).tasks[0];
    expect(resolveTaskDropId(restored.id, restored.id)).toBe(id);
  });
}

for (const [payload, activeId] of [
  ['task-1', null], ['task-1', 'task-2'], ['', 'task-1'], ['task-1', ''], ['task-1', 'task-1 '],
] as const) {
  test(`drop ${JSON.stringify(payload)} with active ID ${JSON.stringify(activeId)} cannot select a task`, () => {
    expect(resolveTaskDropId(payload, activeId)).toBeNull();
  });
}
