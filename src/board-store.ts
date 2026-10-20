import { createBackup, isTask, type Task } from './backup';

const DATABASE = 'yapture.app-pm.board.v2';
const STORE = 'boards';
const KEY = 'main';
const LEGACY = 'yapture.app-pm.tasks.v1';

export interface BoardSnapshot {
  revision: number;
  tasks: Task[];
}

type StoredBoard = BoardSnapshot & { legacyBaseline: string | null };

function validStoredBoard(value: unknown): value is StoredBoard {
  return validBoard(value) && ((value as unknown as Record<string, unknown>).legacyBaseline === null
    || typeof (value as unknown as Record<string, unknown>).legacyBaseline === 'string');
}

function snapshot(value: StoredBoard): BoardSnapshot {
  return { revision: value.revision, tasks: value.tasks };
}

function readLegacyBaseline(storage: Pick<Storage, 'getItem'>): string | null {
  return storage.getItem(LEGACY);
}

function validBoard(value: unknown): value is BoardSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const board = value as Record<string, unknown>;
  return Number.isSafeInteger(board.revision) && (board.revision as number) >= 0
    && Array.isArray(board.tasks) && board.tasks.every(isTask)
    && new Set((board.tasks as Task[]).map((task) => task.id)).size === board.tasks.length;
}

/** Invalid or inaccessible legacy bytes remain untouched for recovery. */
export function readLegacyBoard(storage: Pick<Storage, 'getItem'>): BoardSnapshot {
  return snapshot(readLegacyRecord(storage));
}

function readLegacyRecord(storage: Pick<Storage, 'getItem'>): StoredBoard {
  return parseLegacyBaseline(readLegacyBaseline(storage));
}

function parseLegacyBaseline(raw: string | null): StoredBoard {
  const tasks: unknown = raw === null ? [] : JSON.parse(raw);
  const board = { revision: 0, tasks, legacyBaseline: raw };
  if (!validBoard(board)) throw new Error('Legacy Project Management data needs recovery before migration');
  try { createBackup(board.tasks); }
  catch { throw new Error('Legacy Project Management data exceeds the restorable backup size'); }
  return board;
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    let blocked = false;
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not open Project Management storage'));
    request.onblocked = () => {
      blocked = true;
      reject(new Error('Close older Project Management tabs and reload'));
    };
  });
}

function readRow(db: IDBDatabase): Promise<StoredBoard | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(KEY);
    let value: unknown;
    request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => {
      if (value !== undefined && !validStoredBoard(value)) reject(new Error('Project Management database needs recovery'));
      else resolve(value as StoredBoard | undefined);
    };
    tx.onabort = () => reject(tx.error ?? new Error('Could not read Project Management storage'));
    tx.onerror = () => reject(tx.error ?? new Error('Could not read Project Management storage'));
  });
}

function initializeRow(db: IDBDatabase, legacy: StoredBoard): Promise<StoredBoard> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let chosen: StoredBoard | undefined;
    const request = store.get(KEY);
    request.onsuccess = () => {
      const existing: unknown = request.result;
      if (existing !== undefined) {
        if (!validStoredBoard(existing)) { tx.abort(); return; }
        chosen = existing;
      } else {
        chosen = legacy;
        store.put(legacy, KEY);
      }
    };
    tx.oncomplete = () => resolve(chosen!);
    tx.onabort = () => reject(tx.error ?? new Error('Could not migrate Project Management storage'));
    tx.onerror = () => reject(tx.error ?? new Error('Could not migrate Project Management storage'));
  });
}

export type CommitResult = { state: 'saved'; revision: number } | { state: 'conflict' };

export class BoardStore {
  private constructor(private readonly db: IDBDatabase, private readonly storage: () => Pick<Storage, 'getItem'>) {}

  static async open(factory: IDBFactory, storage: () => Pick<Storage, 'getItem'>): Promise<{ store: BoardStore; board: BoardSnapshot; legacyChanged: boolean }> {
    const db = await openDatabase(factory);
    try {
      let board = await readRow(db);
      if (board === undefined) board = await initializeRow(db, parseLegacyBaseline(readLegacyBaseline(storage())));
      let legacyChanged = false;
      try { legacyChanged = board.legacyBaseline !== readLegacyBaseline(storage()); }
      catch { legacyChanged = true; }
      return { store: new BoardStore(db, storage), board: snapshot(board), legacyChanged };
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  /** One readwrite transaction serializes competing tabs before the compare. */
  commit(expectedRevision: number, tasks: Task[]): Promise<CommitResult> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0
      || !Array.isArray(tasks) || !tasks.every(isTask)
      || new Set(tasks.map((task) => task.id)).size !== tasks.length) {
      return Promise.reject(new Error('Invalid Project Management change'));
    }
    try { createBackup(tasks); }
    catch { return Promise.reject(new Error('Change exceeds the restorable backup size')); }
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(KEY);
      let result: CommitResult | undefined;
      request.onsuccess = () => {
        const current: unknown = request.result;
        if (!validStoredBoard(current)) { tx.abort(); return; }
        if (current.revision !== expectedRevision) {
          result = { state: 'conflict' };
          return;
        }
        let legacyChanged = false;
        try { legacyChanged = current.legacyBaseline !== readLegacyBaseline(this.storage()); }
        catch { legacyChanged = true; }
        if (legacyChanged) { result = { state: 'conflict' }; return; }
        if (current.revision === Number.MAX_SAFE_INTEGER) { tx.abort(); return; }
        const revision = current.revision + 1;
        store.put({ revision, tasks, legacyBaseline: current.legacyBaseline }, KEY);
        result = { state: 'saved', revision };
      };
      tx.oncomplete = () => resolve(result!);
      tx.onabort = () => reject(tx.error ?? new Error('Could not save Project Management storage'));
      tx.onerror = () => reject(tx.error ?? new Error('Could not save Project Management storage'));
    });
  }
}
