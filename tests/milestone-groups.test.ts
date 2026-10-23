import { expect, test } from 'bun:test';
import { groupMilestones } from '../src/App';
import { createBackup, parseBackup, type Task } from '../src/backup';

const task = (id: string, goal: string | null, column: Task['column'] = 'todo'): Task => ({
  id, goal, column, raw: id, title: id, assignee: null, workspace: null,
  priority: null, dueDate: null, createdAt: '2026-10-21T00:00:00Z',
});

test('a restored goal named Ungrouped has a distinct identity from unassigned tasks', () => {
  const restored = parseBackup(createBackup([task('named', 'Ungrouped'), task('unassigned', null)])).tasks;
  const groups = groupMilestones(restored);
  expect(groups.map(g => g.name)).toEqual(['Ungrouped', 'Ungrouped']);
  expect(groups.map(g => g.tasks.map(t => t.id))).toEqual([['named'], ['unassigned']]);
  expect(new Set(groups.map(g => g.key)).size).toBe(2);
});

test('arbitrary accepted goal names cannot collide with the fallback identity', () => {
  const goals = ['Ungrouped', 'unassigned', 'goal:Ungrouped', '__proto__', 'constructor', null];
  const restored = parseBackup(createBackup(goals.map((goal, i) => task(String(i), goal)))).tasks;
  const groups = groupMilestones(restored);
  expect(groups).toHaveLength(goals.length);
  expect(new Set(groups.map(g => g.key)).size).toBe(goals.length);
  expect(groups.flatMap(g => g.tasks.map(t => t.id)).sort()).toEqual(restored.map(t => t.id).sort());
});

test('labels, ordering, membership and completion counts are preserved without changing input', () => {
  const tasks = [task('b', 'Beta', 'done'), task('a1', 'Alpha'), task('u', null), task('a2', 'Alpha', 'done')];
  const before = JSON.stringify(tasks);
  expect(groupMilestones(tasks).map(g => ({ name: g.name, ids: g.tasks.map(t => t.id), done: g.done, total: g.total }))).toEqual([
    { name: 'Alpha', ids: ['a1', 'a2'], done: 1, total: 2 },
    { name: 'Beta', ids: ['b'], done: 1, total: 1 },
    { name: 'Ungrouped', ids: ['u'], done: 0, total: 1 },
  ]);
  expect(JSON.stringify(tasks)).toBe(before);
});

test('identities remain stable as other groups disappear and tasks are added', () => {
  const tasks = [task('a', 'Alpha'), task('named', 'Ungrouped'), task('u', null)];
  const before = groupMilestones(tasks);
  const after = groupMilestones([...tasks.slice(1), task('u2', '')]);
  for (const id of ['named', 'u']) {
    const key = (groups: typeof before) => groups.find(g => g.tasks.some(t => t.id === id))!.key;
    expect(key(after)).toBe(key(before));
  }
  expect(after.find(g => g.tasks.some(t => t.id === 'u'))!.tasks.map(t => t.id)).toEqual(['u', 'u2']);
});

test('an empty board has no milestone groups', () => {
  expect(groupMilestones([])).toEqual([]);
});
