import { expect, test } from 'bun:test';
import { prioColor } from '../src/App';
import { createBackup, parseBackup, type Task } from '../src/backup';

for (const [priority, token] of [
  ['urgent', 'var(--yap-danger)'], ['high', 'var(--yap-priority-high)'],
  ['medium', 'var(--yap-warning)'], ['low', 'var(--yap-success)'],
] as const) {
  test(`known priority ${priority} keeps its color in either case`, () => {
    expect(prioColor(priority)).toBe(token);
    expect(prioColor(priority.toUpperCase())).toBe(token);
  });
}

for (const priority of ['constructor', '__proto__', 'other', ' high ']) {
  test(`restored priority ${JSON.stringify(priority)} uses the unknown-priority color`, () => {
    const task: Task = {
      id: 'restored', title: 'Task', raw: 'Task', column: 'todo', goal: null,
      assignee: null, workspace: null, priority, dueDate: null, createdAt: '2026-10-21T00:00:00Z',
    };
    const restored = parseBackup(createBackup([task])).tasks[0];
    expect(prioColor(restored.priority)).toBe('var(--yap-fg-muted)');
  });
}

for (const priority of [null, '']) {
  test(`missing priority ${JSON.stringify(priority)} keeps the faint color`, () => {
    expect(prioColor(priority)).toBe('var(--yap-fg-faint)');
  });
}
