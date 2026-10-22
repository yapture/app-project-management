import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { BoardStore } from './board-store';
import { createBackup, isTask, MAX_BACKUP_BYTES, parseBackup, type Col, type Task } from './backup';

/* -- Types ---------------------------------------------------------------- */

export type { Task } from './backup';

/* -- Persistence ---------------------------------------------------------- */

const STORAGE_KEY = 'yapture.app-pm.tasks.v1';
export function loadTasks(): Task[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isTask) : [];
  } catch { return []; }
}
export function saveTasks(t: Task[]): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null) {
      const prior: unknown = JSON.parse(raw);
      if (!Array.isArray(prior) || !prior.every(isTask)) return false;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    return true;
  } catch { return false; }
}

/* -- Parser --------------------------------------------------------------- */

function parseScript(text: string): Omit<Task, 'id' | 'column' | 'createdAt'> {
  let assignee: string | null = null, workspace: string | null = null;
  let priority: string | null = null, goal: string | null = null, dueDate: string | null = null;
  const dueMatch = text.match(/\bdue:(\S+)/);
  if (dueMatch) dueDate = dueMatch[1];
  const tokenRx = /#([!@+^~$?])?(\w[\w-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = tokenRx.exec(text)) !== null) {
    const [, pfx, val] = m;
    if (pfx === '+') assignee = val;
    else if (pfx === '!') priority = val;
    else if (pfx === '@') workspace = val;
    else if (pfx === '^') goal = val;
  }
  const title = text.replace(/#[!@+^~$?]?\w[\w-]*/g, '').replace(/#\*\{[^}]*\}/g, '').replace(/\bdue:\S+/g, '').trim();
  return { raw: text, title: title || text, assignee, workspace, priority, goal, dueDate };
}

/* -- Column metadata ------------------------------------------------------ */

/* accent = decorative border colour; fg = text colour that meets 4.5:1 on the card background */
const COLS: { key: Col; label: string; accent: string; fg: string }[] = [
  { key: 'todo', label: 'To Do', accent: 'var(--yap-fg-faint)', fg: 'var(--yap-fg-muted)' },
  { key: 'in-progress', label: 'In Progress', accent: 'var(--yap-accent)', fg: 'var(--yap-info-fg)' },
  { key: 'review', label: 'Review', accent: 'var(--yap-warning)', fg: 'var(--yap-warning)' },
  { key: 'done', label: 'Done', accent: 'var(--yap-success)', fg: 'var(--yap-success)' },
];

const PRIO: Record<string, string> = {
  urgent: 'var(--yap-danger)',
  high: 'var(--yap-priority-high)',
  medium: 'var(--yap-warning)',
  low: 'var(--yap-success)',
};
export function prioColor(p: string | null): string {
  if (!p) return 'var(--yap-fg-faint)';
  const key = p.toLowerCase();
  return Object.hasOwn(PRIO, key) ? PRIO[key] : 'var(--yap-fg-muted)';
}

export function groupMilestones(tasks: Task[]) {
  const gm = new Map<string, Task[]>();
  const un: Task[] = [];
  for (const t of tasks) { if (t.goal) { if (!gm.has(t.goal)) gm.set(t.goal, []); gm.get(t.goal)!.push(t); } else un.push(t); }
  const groups = Array.from(gm.entries()).sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => ({ key: `goal:${name}`, name, tasks: items, done: items.filter((t) => t.column === 'done').length, total: items.length }));
  // A goal label can equal the fallback label, so their identities need separate namespaces.
  if (un.length) groups.push({ key: 'unassigned', name: 'Ungrouped', tasks: un, done: un.filter((t) => t.column === 'done').length, total: un.length });
  return groups;
}

export function resolveTaskDropId(payload: string, activeId: string | null): string | null {
  // Imported IDs are opaque strings; null alone means no local task drag.
  return activeId !== null && payload === activeId ? activeId : null;
}

/* -- Example data --------------------------------------------------------- */

const EXAMPLES: { text: string; column: Col }[] = [
  { text: 'Design the onboarding flow #+alice #@launch #!high #^q3-release due:friday', column: 'todo' },
  { text: 'Write API integration tests #+bob #@backend #!medium #^q3-release', column: 'todo' },
  { text: 'Build notification service #+alice #@backend #!high due:wednesday', column: 'in-progress' },
  { text: 'Review auth middleware PR #+bob #@security #!medium #^q3-release', column: 'review' },
  { text: 'Deploy staging environment #+alice #@infra #!low #^q3-release', column: 'done' },
];

/* -- Component ------------------------------------------------------------ */

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [input, setInput] = useState('');
  const [milestoneView, setMilestoneView] = useState(false);
  const [dragOverCol, setDragOverCol] = useState<Col | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const activeDragId = useRef<string | null>(null);
  const [status, setStatus] = useState('');
  const [storageWarning, setStorageWarning] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recoveryFeedback, setRecoveryFeedback] = useState('');
  const [backupFeedback, setBackupFeedback] = useState('');
  const backupInput = useRef<HTMLInputElement>(null);
  const storeRef = useRef<BoardStore | null>(null);
  const revisionRef = useRef<number | null>(null);
  const boardRef = useRef<Task[]>([]);
  const conflictRef = useRef(false);
  const legacyWriteRef = useRef(false);
  const savingRef = useRef(false);
  const flip = useRef(false);
  const pendingFocus = useRef<{
    id: string | null;
    attribute: 'data-move-id' | 'data-remove-id';
    fallbacks: string[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let opened: BoardStore | null = null;
    let opening: ReturnType<typeof BoardStore.open>;
    try { opening = BoardStore.open(indexedDB, () => localStorage); }
    catch { setLoadError(true); return; }
    void opening.then(({ store, board, legacyChanged }) => {
      if (cancelled) { store.close(); return; }
      opened = store;
      storeRef.current = store;
      revisionRef.current = board.revision;
      boardRef.current = board.tasks;
      setTasks(board.tasks);
      if (legacyChanged) { legacyWriteRef.current = true; setStorageWarning(true); }
      setReady(true);
    }).catch(() => { if (!cancelled) setLoadError(true); });
    return () => {
      cancelled = true;
      opened?.close();
      if (storeRef.current === opened) storeRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onLegacyWrite = (event: StorageEvent) => {
      if (event.key === null || event.key === STORAGE_KEY) { legacyWriteRef.current = true; setStorageWarning(true); }
    };
    window.addEventListener('storage', onLegacyWrite);
    return () => window.removeEventListener('storage', onLegacyWrite);
  }, []);

  const persist = useCallback(async (next: Task[]): Promise<boolean> => {
    if (conflictRef.current || savingRef.current || !storeRef.current || revisionRef.current === null) return false;
    if (legacyWriteRef.current) {
      conflictRef.current = true;
      setTasks(next);
      setConflict(true);
      setStorageWarning(true);
      return false;
    }
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await storeRef.current.commit(revisionRef.current, next);
      if (result.state === 'saved') {
        revisionRef.current = result.revision;
        boardRef.current = next;
        setTasks(next);
        return true;
      }
    } catch { /* Keep the attempted collection available for export. */ }
    finally { savingRef.current = false; setSaving(false); }
    setTasks(next);
    conflictRef.current = true;
    setConflict(true);
    setStorageWarning(true);
    return false;
  }, []);

  /* Polite live-region message; alternate a trailing nbsp so repeats are re-announced. */
  const announce = useCallback((msg: string) => {
    flip.current = !flip.current;
    setStatus(flip.current ? msg : msg + '\u00a0');
  }, []);

  /* After a remove/move, restore focus to the next control, else a heading, else the composer. */
  useEffect(() => {
    const p = pendingFocus.current;
    if (!p) return;
    pendingFocus.current = null;
    // Restored IDs are opaque strings; CSS escaping changes NUL to U+FFFD.
    const selected = p.id !== null
      ? Array.from(document.querySelectorAll<HTMLElement>(`[${p.attribute}]`))
        .find((el) => el.getAttribute(p.attribute) === p.id && !el.matches(':disabled'))
      : undefined;
    const el = selected || p.fallbacks.map((id) => document.getElementById(id))
      .find((el) => el !== null && !el.matches(':disabled'));
    el?.focus();
  }, [tasks]);

  const addTask = useCallback(async (text: string, col?: Col) => {
    if (!text.trim()) return;
    const parsed = parseScript(text);
    if (!(await persist([{ id: crypto.randomUUID(), ...parsed, column: col ?? 'todo', createdAt: new Date().toISOString() }, ...tasks]))) return;
    // A completed save must not erase a draft typed while it was pending.
    setInput(current => current === text ? '' : current);
    announce(`Added ${parsed.title}`);
  }, [tasks, persist, announce]);

  /* siblings = the tasks shown in the same column/group, so focus can move to the next card. */
  const removeTask = useCallback(async (id: string, siblings: Task[], headingId: string) => {
    const gone = tasks.find((t) => t.id === id);
    const i = siblings.findIndex((t) => t.id === id);
    const next = siblings[i + 1] ?? siblings[i - 1];
    pendingFocus.current = { id: next ? next.id : null, attribute: 'data-remove-id', fallbacks: [headingId, 'task-input'] };
    if (!(await persist(tasks.filter((t) => t.id !== id)))) return;
    if (gone) announce(`Removed ${gone.title}`);
  }, [tasks, persist, announce]);

  /* Keyboard / single-pointer alternative to drag-and-drop. */
  // restoreFocus only from the select (keyboard/single pointer); a mouse drop must not move focus or scroll.
  const moveTask = useCallback(async (id: string, target: Col, restoreFocus = false) => {
    const t = tasks.find((x) => x.id === id);
    if (!t || t.column === target) return;
    if (restoreFocus) pendingFocus.current = { id, attribute: 'data-move-id', fallbacks: ['task-input'] };
    if (!(await persist(tasks.map((x) => (x.id === id ? { ...x, column: target } : x))))) return;
    announce(`Moved ${t.title} to ${COLS.find((c) => c.key === target)!.label}`);
  }, [tasks, persist, announce]);
  const handleSubmit = (e: FormEvent) => { e.preventDefault(); void addTask(input); };

  const loadExamples = async () => {
    const items = EXAMPLES.map((ex) => ({
      id: crypto.randomUUID(), ...parseScript(ex.text), column: ex.column, createdAt: new Date().toISOString(),
    })) as Task[];
    if (!(await persist([...items, ...tasks]))) return;
    announce(`Added ${items.length} tasks`);
  };

  const downloadBackup = useCallback(() => {
    try {
      const url = URL.createObjectURL(new Blob([createBackup(tasks)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `project-management-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      try { link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      setBackupFeedback('Backup download started. Keep the JSON file somewhere safe.');
      announce('Backup download started');
    } catch {
      setBackupFeedback('Could not create backup.');
      announce('Could not create backup');
    }
  }, [tasks, announce]);

  const restoreBackup = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setBackupFeedback('');
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('Backup exceeds 1 MiB');
      const backup = parseBackup(await file.text());
      const revision = revisionRef.current;
      if (revision === null || boardRef.current.length || conflictRef.current || savingRef.current || legacyWriteRef.current) {
        throw new Error('Restore requires an empty, unchanged board. Download a backup and reload before restoring.');
      }
      const legacyBeforeConfirm = localStorage.getItem(STORAGE_KEY);
      if (!window.confirm(`Restore ${backup.tasks.length} project tasks?`)) return;
      if (revisionRef.current !== revision || boardRef.current.length || conflictRef.current
        || savingRef.current || legacyWriteRef.current || localStorage.getItem(STORAGE_KEY) !== legacyBeforeConfirm) {
        throw new Error('Board changed in another tab. Reload before restoring.');
      }
      if (!(await persist(backup.tasks))) {
        throw new Error('Restore conflicted or storage failed. Download the unsaved JSON before reloading.');
      }
      setBackupFeedback(`Restored ${backup.tasks.length} project tasks.`);
      announce(`Restored ${backup.tasks.length} project tasks`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not restore backup';
      setBackupFeedback(message);
      announce(message);
    } finally {
      if (backupInput.current) backupInput.current.value = '';
    }
  }, [persist, announce]);

  /* -- Drag-and-drop ------------------------------------------------------ */

  const onDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    activeDragId.current = null;
    if (conflict || saving) { e.preventDefault(); return; }
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    activeDragId.current = id;
    setDraggingId(id);
  };
  const onDragEnd = () => { activeDragId.current = null; setDraggingId(null); setDragOverCol(null); };

  const onDragOver = (e: DragEvent<HTMLDivElement>, col: Col) => {
    if (conflict || saving) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
    if (dragOverCol !== col) setDragOverCol(col);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>, col: Col) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) {
      if (dragOverCol === col) setDragOverCol(null);
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>, target: Col) => {
    e.preventDefault();
    const activeId = activeDragId.current;
    activeDragId.current = null;
    setDragOverCol(null); setDraggingId(null);
    if (conflict || saving) return;
    const id = resolveTaskDropId(e.dataTransfer.getData('text/plain'), activeId);
    if (id !== null) void moveTask(id, target);
  };

  /* -- Derived data ------------------------------------------------------- */

  const colTasks = useMemo(() => {
    const m: Record<Col, Task[]> = { 'todo': [], 'in-progress': [], 'review': [], 'done': [] };
    for (const t of tasks) m[t.column].push(t);
    return m;
  }, [tasks]);

  const milestoneGroups = useMemo(() => {
    if (!milestoneView) return null;
    return groupMilestones(tasks);
  }, [tasks, milestoneView]);

  const preview = useMemo(() => (input.trim() ? parseScript(input) : null), [input]);

  const downloadRecovery = useCallback(() => {
    try {
      const data = JSON.stringify({
        app: 'yapture-project-management', schemaVersion: 1,
        exportedAt: new Date().toISOString(), tasks,
      }, null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `project-management-unsaved-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      try { link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      setRecoveryFeedback('Unsaved Project Management JSON download started. Keep it before reloading.');
      announce('Unsaved Project Management download started');
    } catch {
      setRecoveryFeedback('Could not download unsaved data. Keep this tab open.');
      announce('Could not download unsaved data');
    }
  }, [tasks, announce]);

  const downloadLegacyRecovery = () => {
    try {
      const data = JSON.stringify({
        app: 'yapture-project-management', schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        legacyTasksRaw: localStorage.getItem(STORAGE_KEY),
      }, null, 2);
      const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `project-management-legacy-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(link);
      try { link.click(); }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000); }
      setRecoveryFeedback('Original browser data download started. Keep it before changing this browser.');
    } catch {
      setRecoveryFeedback('Browser storage could not be read. Keep this tab and browser profile intact.');
    }
  };

  /* -- Render helpers ----------------------------------------------------- */

  const moveSelect = (task: Task) => (
    <select aria-label={`Move ${task.title} to`} value={task.column} data-move-id={task.id}
      disabled={conflict || saving}
      onChange={(e) => { void moveTask(task.id, e.target.value as Col, true); }} style={S.moveSel}>
      {COLS.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
    </select>
  );

  const renderCard = (task: Task) => (
    <div key={task.id} draggable={!conflict && !saving} onDragStart={(e) => onDragStart(e, task.id)} onDragEnd={onDragEnd}
      style={{ ...S.card, opacity: draggingId === task.id ? 0.4 : 1 }}>
      <div style={S.cardTop}>
        <span style={{ ...S.cardTitle, ...(task.column === 'done' ? { textDecoration: 'line-through', opacity: 0.5 } : {}) }}>
          {task.title}
        </span>
        <button type="button" disabled={conflict || saving} onClick={() => { void removeTask(task.id, colTasks[task.column], `col-${task.column}`); }} style={S.removeBtn}
          aria-label={`Remove ${task.title}`} data-remove-id={task.id}><span aria-hidden="true">&times;</span></button>
      </div>
      <div style={S.cardBadges}>
        {task.assignee && <span style={{ ...S.badge, ...S.bAssign }}>+{task.assignee}</span>}
        {task.workspace && <span style={{ ...S.badge, ...S.bWork }}>@{task.workspace}</span>}
        {task.priority && <span style={S.prioRow}><span style={{ ...S.prioDot, background: prioColor(task.priority) }} /><span style={{ fontSize: 11, color: 'var(--yap-fg-muted)' }}>{task.priority}</span></span>}
        {task.dueDate && <span style={{ ...S.badge, ...S.bDue }}>due:{task.dueDate}</span>}
        {task.goal && <span style={{ ...S.badge, ...S.bGoal }}>{task.goal}</span>}
      </div>
      <div style={S.moveRow}>{moveSelect(task)}</div>
    </div>
  );

  const renderCol = (c: typeof COLS[number]) => {
    const items = colTasks[c.key];
    const over = dragOverCol === c.key;
    return (
      <div key={c.key} className="pm-column"
        onDragOver={(e) => onDragOver(e, c.key)} onDragLeave={(e) => onDragLeave(e, c.key)}
        onDrop={(e) => onDrop(e, c.key)}
        style={{ ...S.col, borderTopColor: c.accent, ...(over ? S.colOver : {}) }}>
        <div style={S.colHead}>
          <h2 id={`col-${c.key}`} tabIndex={-1} style={S.colLabel}>{c.label}</h2>
          <span style={S.colCnt}>{items.length}</span>
        </div>
        <div style={S.colBody}>
          {items.length === 0 ? <div style={S.colEmpty}>{over ? 'Drop here' : 'No tasks'}</div> : items.map(renderCard)}
        </div>
      </div>
    );
  };

  const colMeta = (key: Col) => COLS.find((c) => c.key === key)!;

  /* -- JSX ---------------------------------------------------------------- */

  if (loadError) return <main role="alert">
    <p>Project Management storage could not be opened. Your older browser data was left untouched. Close older tabs and reload after saving a recovery copy.</p>
    <button type="button" onClick={downloadLegacyRecovery}>Download original browser data</button>
    {recoveryFeedback && <p role="status">{recoveryFeedback}</p>}
  </main>;
  if (!ready) return <main role="status">Loading Project Management…</main>;

  return (
    <div style={S.root}>
      <style>{responsiveCSS}</style>

      <header style={S.header}>
        <div style={S.headerInner}>
          <h1 style={S.logo}><span style={{ color: 'var(--yap-accent)' }}>Project Management</span><span style={S.logoSub}>by Yapture</span></h1>
          <a href="https://yapture.com/market/project-management" style={S.mktLink}>View on Market &rarr;</a>
        </div>
      </header>

      <main style={S.main}>
        {storageWarning && <p role="alert">{conflict
          ? 'Another tab changed this board or storage failed. This tab holds unsaved data. Download its JSON before reloading.'
          : 'Older browser storage changed or cannot be read. This tab is read-only. Download the current backup and, if available, the original browser data before resolving the copies.'}</p>}
        {storageWarning && <button type="button" onClick={downloadLegacyRecovery} style={S.actBtn}>Download original browser data</button>}
        {conflict && <button type="button" onClick={downloadRecovery} style={S.actBtn}>Download unsaved JSON</button>}
        {storageWarning && recoveryFeedback && <p role="status">{recoveryFeedback}</p>}
        <form onSubmit={handleSubmit} style={S.form}>
          <label htmlFor="task-input" className="sr-only">Add a task</label>
          <input id="task-input" type="text" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Add a task -- try: Design onboarding #+alice #@launch #!high #^q3-release due:friday" style={S.input} />
          <button type="submit" disabled={conflict || saving || !input.trim()} style={S.addBtn}>Add</button>
        </form>

        {preview && (
          <div style={S.preview}>
            <span style={S.prevTitle}>{preview.title}</span>
            {preview.assignee && <span style={{ ...S.badge, ...S.bAssign }}>+{preview.assignee}</span>}
            {preview.workspace && <span style={{ ...S.badge, ...S.bWork }}>@{preview.workspace}</span>}
            {preview.priority && <span style={S.prioRow}><span style={{ ...S.prioDot, background: prioColor(preview.priority) }} /><span style={{ fontSize: 11, color: 'var(--yap-fg-muted)' }}>{preview.priority}</span></span>}
            {preview.dueDate && <span style={{ ...S.badge, ...S.bDue }}>due:{preview.dueDate}</span>}
            {preview.goal && <span style={{ ...S.badge, ...S.bGoal }}>{preview.goal}</span>}
          </div>
        )}

        <div style={S.actions}>
          <button type="button" disabled={conflict || saving} onClick={() => { void loadExamples(); }} style={S.actBtn}>+ Sprint planning</button>
          <button type="button" onClick={() => setMilestoneView(!milestoneView)}
            style={{ ...S.actBtn, ...(milestoneView ? S.actBtnOn : {}) }}>
            {milestoneView ? 'Kanban view' : 'Milestone view'}
          </button>
          <span style={S.countLabel}>{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
        </div>
        <div style={S.actions}>
          <button type="button" onClick={downloadBackup} style={S.actBtn}>Download backup</button>
          <input ref={backupInput} type="file" accept="application/json,.json" hidden
            aria-label="Choose Project Management backup" onChange={(e) => { void restoreBackup(e.target.files?.[0]); }} />
          <button type="button" disabled={conflict || saving} onClick={() => backupInput.current?.click()} style={S.actBtn}>Restore backup</button>
        </div>
        {backupFeedback && <p role="alert">{backupFeedback}</p>}

        {milestoneView && milestoneGroups ? (
          <div className="pm-milestones">
            {milestoneGroups.length === 0 ? (
              <div style={S.colEmpty}>No tasks yet. Add some or load the Sprint planning example.</div>
            ) : milestoneGroups.map((g, gi) => (
              <div key={g.key} style={S.msGroup}>
                <div style={S.msHead}>
                  <h2 id={`ms-${gi}`} tabIndex={-1} style={S.msName}>{g.name}</h2>
                  <span style={S.msCount}>{g.done}/{g.total} done</span>
                </div>
                <div style={S.progTrack}>
                  <div style={{ ...S.progFill, width: g.total > 0 ? `${(g.done / g.total) * 100}%` : '0%' }} />
                </div>
                <div style={S.msCards}>
                  {g.tasks.map((t) => (
                    <div key={t.id} style={S.msCard}>
                      <span style={{ ...S.msCardTitle, ...(t.column === 'done' ? { textDecoration: 'line-through', opacity: 0.5 } : {}) }}>{t.title}</span>
                      <span style={{ ...S.badge, color: colMeta(t.column).fg }}>{colMeta(t.column).label}</span>
                      {t.assignee && <span style={{ ...S.badge, ...S.bAssign }}>+{t.assignee}</span>}
                      {moveSelect(t)}
                      <button type="button" disabled={conflict || saving} onClick={() => { void removeTask(t.id, g.tasks, `ms-${gi}`); }} style={S.removeBtn}
                        aria-label={`Remove ${t.title}`} data-remove-id={t.id}><span aria-hidden="true">&times;</span></button>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="pm-board">{COLS.map(renderCol)}</div>
        )}
      </main>

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{status}</p>

      <footer style={S.footer}>
        <span>Built on{' '}<a href="https://yapture.com" style={S.ftLink}>Yapture</a>{' '}Script and list primitives</span>
        <span>&middot;</span>
        <a href="https://yapture.com/docs/script" style={S.ftLink}>Script docs</a>
        <span>&middot;</span>
        <a href="https://yapture.com/.well-known/yapture-api.md" style={S.ftLink}>API reference</a>
      </footer>
    </div>
  );
}

/* -- Responsive CSS ------------------------------------------------------- */

const responsiveCSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #080b10; }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 2px solid var(--yap-ring); outline-offset: 2px; }
.pm-board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
@media (max-width: 900px) { .pm-board { grid-template-columns: repeat(2, 1fr) !important; } }
@media (max-width: 600px) { .pm-board { grid-template-columns: 1fr !important; } }
.pm-column { transition: border-color .15s, background .15s; }
[draggable="true"] { cursor: grab; }
[draggable="true"]:active { cursor: grabbing; }
`;

/* -- Styles --------------------------------------------------------------- */

const S: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', background: '#080b10', color: 'var(--yap-fg)', fontFamily: 'var(--yap-font-sans)', display: 'flex', flexDirection: 'column' },
  header: { borderBottom: '1px solid var(--yap-border)', padding: '16px 0' },
  headerInner: { maxWidth: 1220, margin: '0 auto', padding: '0 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  logo: { fontSize: 20, fontWeight: 700, margin: 0, display: 'flex', alignItems: 'baseline', gap: 8 },
  logoSub: { fontSize: 13, fontWeight: 400, color: 'var(--yap-fg-muted)' },
  mktLink: { fontSize: 14, color: 'var(--yap-accent)', textDecoration: 'none', fontWeight: 500 },
  main: { flex: 1, maxWidth: 1220, margin: '0 auto', padding: '32px 24px', width: '100%', boxSizing: 'border-box' as const },
  form: { display: 'flex', gap: 12, marginBottom: 12 },
  input: { flex: 1, padding: '12px 16px', borderRadius: 10, border: '1px solid var(--yap-fg-faint)', background: 'var(--yap-input-bg)', color: 'var(--yap-fg)', fontSize: 15, fontFamily: 'var(--yap-font-mono)' },
  addBtn: { padding: '12px 24px', borderRadius: 10, border: 'none', background: 'var(--yap-accent)', color: 'var(--yap-bg)', fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  preview: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', marginBottom: 16, borderRadius: 8, background: 'var(--yap-accent-muted)', border: '1px solid var(--yap-accent)', fontSize: 14, flexWrap: 'wrap' as const },
  prevTitle: { color: 'var(--yap-fg)', fontWeight: 500 },
  actions: { display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 28, alignItems: 'center' },
  actBtn: { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--yap-border-subtle)', background: 'rgba(255,255,255,.04)', color: 'var(--yap-fg-muted)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  actBtnOn: { background: 'var(--yap-accent-muted)', color: 'var(--yap-info-fg)', borderColor: 'var(--yap-accent)' },
  countLabel: { marginLeft: 'auto', fontSize: 13, color: 'var(--yap-fg-muted)' },
  col: { minWidth: 0, borderRadius: 12, background: 'var(--yap-bg)', borderTop: '3px solid', padding: 12, minHeight: 200 },
  colOver: { border: '2px dashed var(--yap-accent)', background: 'var(--yap-accent-muted)', borderTop: '3px solid' },
  colHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, paddingBottom: 8, borderBottom: '1px solid var(--yap-border-subtle)' },
  colLabel: { fontSize: 13, fontWeight: 600, fontFamily: 'var(--yap-font-mono)', textTransform: 'uppercase' as const, letterSpacing: '.08em', color: 'var(--yap-fg-muted)' },
  colCnt: { fontSize: 12, fontWeight: 600, color: 'var(--yap-fg-muted)', background: 'var(--yap-border-subtle)', borderRadius: 10, padding: '2px 8px', minWidth: 22, textAlign: 'center' as const },
  colBody: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  colEmpty: { fontSize: 13, color: 'var(--yap-fg-muted)', padding: '24px 0', textAlign: 'center' as const },
  card: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--yap-border)', background: 'var(--yap-card-bg)', transition: 'transform .12s, box-shadow .12s, opacity .15s' },
  cardTop: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: 500, lineHeight: 1.35 },
  removeBtn: { border: 'none', background: 'none', color: 'var(--yap-fg-muted)', fontSize: 16, cursor: 'pointer', padding: '0 2px', flexShrink: 0, lineHeight: 1 },
  cardBadges: { display: 'flex', flexWrap: 'wrap' as const, gap: 4, alignItems: 'center' },
  badge: { padding: '2px 7px', borderRadius: 5, fontSize: 11, fontWeight: 600, fontFamily: 'var(--yap-font-mono)' },
  bAssign: { background: 'var(--yap-info-bg)', color: 'var(--yap-info-fg)' },
  bWork: { background: 'var(--yap-success-bg)', color: 'var(--yap-success-fg)' },
  bDue: { background: 'var(--yap-border-subtle)', color: 'var(--yap-fg-muted)' },
  bGoal: { background: 'var(--yap-accent-muted)', color: 'var(--yap-info-fg)' },
  moveRow: { marginTop: 8 },
  moveSel: { padding: '4px 8px', borderRadius: 6, border: '1px solid var(--yap-fg-faint)', background: 'var(--yap-input-bg)', color: 'var(--yap-fg)', fontSize: 12, fontFamily: 'inherit', cursor: 'pointer' },
  prioRow: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  prioDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  msGroup: { marginBottom: 28, padding: 16, borderRadius: 12, background: 'var(--yap-bg)', border: '1px solid var(--yap-border-subtle)' },
  msHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  msName: { margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--yap-accent-hover)', fontFamily: 'var(--yap-font-mono)' },
  msCount: { fontSize: 13, color: 'var(--yap-fg-muted)' },
  progTrack: { height: 6, borderRadius: 3, background: 'var(--yap-border-subtle)', marginBottom: 14, overflow: 'hidden' },
  progFill: { height: '100%', borderRadius: 3, background: 'var(--yap-accent)', transition: 'width .3s ease' },
  msCards: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  msCard: { display: 'flex', flexWrap: 'wrap' as const, alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--yap-card-bg)', border: '1px solid var(--yap-border-subtle)' },
  msCardTitle: { flex: 1, fontSize: 14, fontWeight: 500 },
  footer: { borderTop: '1px solid var(--yap-border)', padding: '20px 24px', display: 'flex', justifyContent: 'center', gap: 12, fontSize: 13, color: 'var(--yap-fg-muted)' },
  ftLink: { color: 'var(--yap-accent)', textDecoration: 'underline' },
};
