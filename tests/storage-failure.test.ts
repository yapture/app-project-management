import { afterEach, describe, expect, test } from 'bun:test';
import { loadTasks, saveTasks } from '../src/App';

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe('browser storage failures', () => {
  test('a blocked read starts with an empty board', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => { throw new DOMException('blocked', 'SecurityError'); } },
    });
    expect(loadTasks()).toEqual([]);
  });

  test('a valid JSON value with the wrong shape cannot crash the board', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => '{"tasks":[]}' },
    });
    expect(loadTasks()).toEqual([]);
  });

  test('malformed entries are discarded while valid tasks remain', () => {
    const valid = {
      id: 'one', raw: 'Ship #+alex', title: 'Ship', assignee: 'alex',
      workspace: null, priority: null, goal: null, dueDate: null,
      column: 'todo', createdAt: '2026-10-19T00:00:00.000Z',
    };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => JSON.stringify([null, { ...valid, column: 'invalid' }, valid]) },
    });
    expect(loadTasks()).toEqual([valid]);
  });

  test('a blocked write reports failure without throwing', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } },
    });
    expect(saveTasks([])).toBe(false);
  });

  test('a successful write reports success', () => {
    let written = '';
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => null, setItem: (_key: string, value: string) => { written = value; } },
    });
    expect(saveTasks([])).toBe(true);
    expect(written).toBe('[]');
  });

  test('a malformed saved board is never overwritten', () => {
    let writes = 0;
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: () => '{"tasks":[]}', setItem: () => { writes++; } },
    });
    expect(saveTasks([])).toBe(false);
    expect(writes).toBe(0);
  });
});
