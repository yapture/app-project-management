import { expect, test } from 'bun:test';
import { groupMilestones, prioColor, resolveTaskDropId } from '../src/App';

const task = (id: string, goal: string | null, column: 'todo' | 'done' = 'todo') => ({
  id, goal, column, raw: id, title: id, assignee: null, workspace: null,
  priority: null, dueDate: null, createdAt: '2026-10-21T00:00:00Z',
});

test('named Ungrouped and absent milestones have distinct keys and membership', () => {
  const groups = groupMilestones([task('named', 'Ungrouped'), task('absent', null)]);
  expect(groups.map(g => g.name)).toEqual(['Ungrouped', 'Ungrouped']);
  expect(groups.map(g => g.tasks.map(t => t.id))).toEqual([['named'], ['absent']]);
  expect(new Set(groups.map(g => g.key)).size).toBe(2);
});

test('opaque goal labels cannot collide with the fallback key', () => {
  const goals = ['Ungrouped', 'unassigned', 'goal:Ungrouped', '__proto__', 'constructor', null];
  const groups = groupMilestones(goals.map((goal, i) => task(String(i), goal)));
  expect(groups).toHaveLength(goals.length);
  expect(new Set(groups.map(g => g.key)).size).toBe(goals.length);
  expect(groups.flatMap(g => g.tasks.map(t => t.id)).sort()).toEqual(goals.map((_, i) => String(i)));
});

test('milestones preserve order, completion counts and input records', () => {
  const tasks = [task('b', 'Beta', 'done'), task('a1', 'Alpha'), task('u', null), task('a2', 'Alpha', 'done')];
  const before = JSON.stringify(tasks);
  expect(groupMilestones(tasks).map(g => ({ name: g.name, done: g.done, total: g.total }))).toEqual([
    { name: 'Alpha', done: 1, total: 2 }, { name: 'Beta', done: 1, total: 1 }, { name: 'Ungrouped', done: 0, total: 1 },
  ]);
  expect(JSON.stringify(tasks)).toBe(before);
  expect(groupMilestones([])).toEqual([]);
});

test('milestone identity survives other groups disappearing', () => {
  const tasks = [task('a', 'Alpha'), task('named', 'Ungrouped'), task('u', null)];
  const before = groupMilestones(tasks);
  const after = groupMilestones([...tasks.slice(1), task('u2', '')]);
  for (const id of ['named', 'u']) {
    expect(after.find(g => g.tasks.some(t => t.id === id))?.key).toBe(before.find(g => g.tasks.some(t => t.id === id))?.key);
  }
});

test('only own priority keys select colors; unknown and absent values keep fallbacks', () => {
  for (const [priority, token] of [['urgent', 'danger'], ['high', 'priority-high'], ['medium', 'warning'], ['low', 'success']]) {
    expect(prioColor(priority)).toBe(`var(--yap-${token})`);
    expect(prioColor(priority.toUpperCase())).toBe(`var(--yap-${token})`);
  }
  for (const priority of ['constructor', '__proto__', 'other', ' high ']) expect(prioColor(priority)).toBe('var(--yap-fg-muted)');
  for (const priority of [null, '']) expect(prioColor(priority)).toBe('var(--yap-fg-faint)');
});

test('local drops preserve exact opaque IDs and reject external or mismatched payloads', () => {
  for (const id of ['', 'task-1', 'quote"id', 'line\nid', ' spaced ']) expect(resolveTaskDropId(id, id)).toBe(id);
  for (const [payload, activeId] of [['task-1', null], ['task-1', 'task-2'], ['', 'task-1'], ['task-1', ''], ['task-1', 'task-1 ']] as const) {
    expect(resolveTaskDropId(payload, activeId)).toBeNull();
  }
});
