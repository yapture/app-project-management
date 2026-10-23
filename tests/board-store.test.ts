import { describe, expect, test } from 'bun:test';
import { BoardStore, readLegacyBoard } from '../src/board-store';
import { createBackup, parseBackup } from '../src/backup';

const LEGACY = 'yapture.app-pm.tasks.v1';
const task = {
  id: 'task-1', raw: 'Review launch blockers #+alex', title: 'Review launch blockers',
  assignee: 'alex', priority: null, workspace: null,
  goal: null, dueDate: null, column: 'todo',
  createdAt: '2026-10-19T00:00:00.000Z',
} as const;

function storage(values: Record<string, string | null>) {
  return { getItem(key: string) { return values[key] ?? null; } };
}

describe('legacy Project Management migration', () => {
  test('preserves every validated task field', () => {
    expect(readLegacyBoard(storage({ [LEGACY]: JSON.stringify([task]) })))
      .toEqual({ revision: 0, tasks: [task] });
  });

  test('an empty legacy collection receives an initial revision', () => {
    expect(readLegacyBoard(storage({}))).toEqual({ revision: 0, tasks: [] });
  });

  test('malformed or inaccessible legacy bytes stop migration', () => {
    for (const raw of ['{', '{"tasks":[]}', '[{"title":"hidden"}]']) {
      expect(() => readLegacyBoard(storage({ [LEGACY]: raw }))).toThrow();
    }
    expect(() => readLegacyBoard(storage({ [LEGACY]: JSON.stringify([task, task]) }))).toThrow();
    expect(() => readLegacyBoard({ getItem() { throw new DOMException('blocked', 'SecurityError'); } })).toThrow();
  });
});

/** Serialized transaction model; real-browser acceptance remains a separate gate. */
function fakeIndexedDb() {
  let row: unknown;
  let writeTail: Promise<void> = Promise.resolve();
  const database = {
    createObjectStore() { return {}; },
    close() {},
    transaction(_name: string, mode: IDBTransactionMode) {
      let nextRow: unknown;
      let aborted = false;
      const tx = {
        oncomplete: null as null | (() => void),
        onabort: null as null | (() => void),
        onerror: null as null | (() => void),
        abort() { aborted = true; },
        objectStore() {
          return {
            get() {
              const request = { result: undefined as unknown, onsuccess: null as null | (() => void) };
              const run = async () => {
                let release: (() => void) | undefined;
                if (mode === 'readwrite') {
                  const prior = writeTail;
                  writeTail = new Promise<void>((resolve) => { release = resolve; });
                  await prior;
                }
                request.result = structuredClone(row);
                request.onsuccess?.();
                queueMicrotask(() => {
                  if (aborted) tx.onabort?.();
                  else {
                    if (nextRow !== undefined) row = structuredClone(nextRow);
                    tx.oncomplete?.();
                  }
                  release?.();
                });
              };
              queueMicrotask(() => { void run(); });
              return request;
            },
            put(value: unknown) { nextRow = value; },
          };
        },
      };
      return tx;
    },
  };
  return {
    open() {
      const request = { result: database, onupgradeneeded: null as null | (() => void), onsuccess: null as null | (() => void), onerror: null, onblocked: null };
      queueMicrotask(() => { request.onupgradeneeded?.(); request.onsuccess?.(); });
      return request;
    },
  } as unknown as IDBFactory;
}

test('two tabs cannot both commit from the same revision', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({ [LEGACY]: JSON.stringify([task]) });
  const [left, right] = await Promise.all([BoardStore.open(factory, legacy), BoardStore.open(factory, legacy)]);
  expect(left.board).toEqual(right.board);
  const outcomes = await Promise.all([
    left.store.commit(left.board.revision, [{ ...task, column: 'done' }]),
    right.store.commit(right.board.revision, []),
  ]);
  expect(outcomes.filter((outcome) => outcome.state === 'saved')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome.state === 'conflict')).toHaveLength(1);
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board.revision).toBe(1);
  left.store.close(); right.store.close(); latest.store.close();
});

test('a stale empty tab cannot restore over another tab’s new task', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({});
  const [restoreTab, writerTab] = await Promise.all([
    BoardStore.open(factory, legacy), BoardStore.open(factory, legacy),
  ]);
  expect(restoreTab.board).toEqual({ revision: 0, tasks: [] });
  expect(await writerTab.store.commit(writerTab.board.revision, [task]))
    .toEqual({ state: 'saved', revision: 1 });
  expect(await restoreTab.store.commit(restoreTab.board.revision, []))
    .toEqual({ state: 'conflict' });
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board).toEqual({ revision: 1, tasks: [task] });
  restoreTab.store.close(); writerTab.store.close(); latest.store.close();
});

test('parsed backup restores every task field in one version-checked commit', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({});
  const { store, board } = await BoardStore.open(factory, legacy);
  const imported = parseBackup(createBackup([{ ...task, column: 'done' }])).tasks;
  expect(await store.commit(board.revision, imported)).toEqual({ state: 'saved', revision: 1 });
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board).toEqual({ revision: 1, tasks: imported });
  store.close(); latest.store.close();
});

test('oversized legacy data remains untouched for original-byte recovery', () => {
  const raw = JSON.stringify([{ ...task, title: 'x'.repeat(1024 * 1024) }]);
  const values: Record<string, string | null> = { [LEGACY]: raw };
  expect(() => readLegacyBoard(storage(values))).toThrow('restorable backup size');
  expect(values[LEGACY]).toBe(raw);
});

test('oversized board cannot save when its backup would be un-restorable', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({});
  const { store, board } = await BoardStore.open(factory, legacy);
  const oversized = { ...task, title: 'x'.repeat(1024 * 1024) };
  await expect(store.commit(board.revision, [oversized])).rejects.toThrow('restorable backup size');
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board).toEqual({ revision: 0, tasks: [] });
  store.close(); latest.store.close();
});

test('duplicate task IDs cannot create a durable board that backup restore rejects', async () => {
  const factory = fakeIndexedDb();
  const legacy = () => storage({});
  const { store, board } = await BoardStore.open(factory, legacy);
  await expect(store.commit(board.revision, [task, task])).rejects.toThrow('Invalid Project Management change');
  const latest = await BoardStore.open(factory, legacy);
  expect(latest.board).toEqual({ revision: 0, tasks: [] });
  store.close(); latest.store.close();
});


test('reopening detects a legacy tab edit made while the database app was closed', async () => {
  const factory = fakeIndexedDb();
  const values: Record<string, string | null> = { [LEGACY]: JSON.stringify([task]) };
  const original = await BoardStore.open(factory, () => storage(values));
  original.store.close();
  values[LEGACY] = JSON.stringify([task, { ...task, id: 'task-2' }]);
  const diverged = await BoardStore.open(factory, () => storage(values));
  expect(diverged.legacyChanged).toBe(true);
  expect(diverged.board.tasks.map((entry) => entry.id)).toEqual(['task-1']);
  diverged.store.close();
  values[LEGACY] = '{';
  const malformed = await BoardStore.open(factory, () => storage(values));
  expect(malformed.legacyChanged).toBe(true);
  expect(malformed.board.tasks.map((entry) => entry.id)).toEqual(['task-1']);
  malformed.store.close();
  const blocked = await BoardStore.open(factory, () => ({ getItem() { throw new DOMException('blocked', 'SecurityError'); } }));
  expect(blocked.legacyChanged).toBe(true);
  expect(blocked.board.tasks.map((entry) => entry.id)).toEqual(['task-1']);
  blocked.store.close();
  values[LEGACY] = JSON.stringify([task]);
  const reopened = await BoardStore.open(factory, () => storage(values));
  expect(reopened.legacyChanged).toBe(false);
  expect(reopened.board.tasks.map((entry) => entry.id)).toEqual(['task-1']);
  reopened.store.close();
});

test('a legacy write after opening blocks a database commit before the storage event', async () => {
  const factory = fakeIndexedDb();
  const values: Record<string, string | null> = { [LEGACY]: JSON.stringify([task]) };
  let denied = false;
  const access = () => denied
    ? { getItem(): string | null { throw new DOMException('blocked', 'SecurityError'); } }
    : storage(values);
  const opened = await BoardStore.open(factory, access);
  values[LEGACY] = JSON.stringify([task, { ...task, id: 'task-2' }]);
  expect(await opened.store.commit(opened.board.revision, [task]))
    .toEqual({ state: 'conflict' });
  const afterWrite = await BoardStore.open(factory, access);
  expect(afterWrite.board.revision).toBe(0);
  expect(afterWrite.legacyChanged).toBe(true);
  afterWrite.store.close();
  values[LEGACY] = JSON.stringify([task]);
  denied = true;
  expect(await opened.store.commit(opened.board.revision, [task]))
    .toEqual({ state: 'conflict' });
  denied = false;
  const afterDenial = await BoardStore.open(factory, access);
  expect(afterDenial.board.revision).toBe(0);
  opened.store.close(); afterDenial.store.close();
});

/** Connection lifecycle port over the serialized storage fixture, not browser acceptance. */
function versionChangeConnection() {
  const backing = fakeIndexedDb();
  let database: IDBDatabase;
  let closed = false;
  let closeCalls = 0;
  let transactions = 0;
  const factory = {
    open() {
      const request = backing.open('lifecycle-fixture', 1);
      database = request.result;
      const transaction = database.transaction.bind(database);
      database.close = () => { closed = true; closeCalls++; };
      database.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
        if (closed) throw new DOMException('The connection is closing', 'InvalidStateError');
        transactions++;
        return transaction(...args);
      }) as IDBDatabase['transaction'];
      return request;
    },
  } as unknown as IDBFactory;
  return {
    factory,
    state: () => ({ closed, closeCalls, transactions }),
    versionChange(newVersion: number | null) {
      database.onversionchange?.call(database, { oldVersion: 1, newVersion } as IDBVersionChangeEvent);
    },
  };
}

describe('Project Management version change:', () => {
  test('ordinary migration and commits remain usable until explicitly closed', async () => {
    const connection = versionChangeConnection();
    const opened = await BoardStore.open(connection.factory, () => storage({ [LEGACY]: JSON.stringify([task]) }));
    expect(opened.board).toEqual({ revision: 0, tasks: [task] });
    expect(connection.state().closed).toBe(false);
    expect(await opened.store.commit(0, [task])).toEqual({ state: 'saved', revision: 1 });
    opened.store.close();
    expect(connection.state().closeCalls).toBe(1);
  });

  test('a blocked open closes a later successful connection without reading storage', async () => {
    let closeCalls = 0;
    const request = {
      result: { close() { closeCalls++; }, transaction() { throw new Error('unexpected transaction'); } },
      onblocked: null as null | (() => void), onsuccess: null as null | (() => void),
    };
    const factory = { open() {
      queueMicrotask(() => { request.onblocked?.(); request.onsuccess?.(); });
      return request;
    } } as unknown as IDBFactory;
    await expect(BoardStore.open(factory, () => { throw new Error('unexpected legacy read'); }))
      .rejects.toThrow('Close older Project Management tabs and reload');
    expect(closeCalls).toBe(1);
  });

  test('an upgrade request closes the connection and rejects later writes', async () => {
    const connection = versionChangeConnection();
    const opened = await BoardStore.open(connection.factory, () => storage({ [LEGACY]: JSON.stringify([task]) }));
    const before = structuredClone(opened.board);
    const transactions = connection.state().transactions;
    connection.versionChange(2);
    expect(connection.state()).toEqual({ closed: true, closeCalls: 1, transactions });
    await expect(opened.store.commit(0, [])).rejects.toThrow('The connection is closing');
    expect(connection.state().transactions).toBe(transactions);
    expect(opened.board).toEqual(before);
  });

  test('a deletion request closes only the notified connection', async () => {
    const notified = versionChangeConnection();
    const unrelated = versionChangeConnection();
    const left = await BoardStore.open(notified.factory, () => storage({}));
    const right = await BoardStore.open(unrelated.factory, () => storage({}));
    notified.versionChange(null);
    expect(notified.state().closed).toBe(true);
    expect(unrelated.state().closed).toBe(false);
    await expect(left.store.commit(0, [task])).rejects.toThrow('The connection is closing');
    expect(await right.store.commit(0, [task])).toEqual({ state: 'saved', revision: 1 });
    right.store.close();
  });
});
