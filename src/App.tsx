import { useCallback, useMemo, useState, type DragEvent, type FormEvent } from 'react';

/* -- Types ---------------------------------------------------------------- */

type Col = 'todo' | 'in-progress' | 'review' | 'done';

interface Task {
  id: string; raw: string; title: string;
  assignee: string | null; workspace: string | null;
  priority: string | null; goal: string | null;
  dueDate: string | null; column: Col; createdAt: string;
}

/* -- Persistence ---------------------------------------------------------- */

const STORAGE_KEY = 'yapture.app-pm.tasks.v1';
function loadTasks(): Task[] { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : []; } catch { return []; } }
function saveTasks(t: Task[]) { localStorage.setItem(STORAGE_KEY, JSON.stringify(t)); }

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

const COLS: { key: Col; label: string; accent: string }[] = [
  { key: 'todo', label: 'To Do', accent: 'var(--yap-fg-faint)' },
  { key: 'in-progress', label: 'In Progress', accent: 'var(--yap-accent)' },
  { key: 'review', label: 'Review', accent: 'var(--yap-warning)' },
  { key: 'done', label: 'Done', accent: 'var(--yap-success)' },
];

const PRIO: Record<string, string> = {
  urgent: 'var(--yap-danger)',
  high: 'var(--yap-priority-high)',
  medium: 'var(--yap-warning)',
  low: 'var(--yap-success)',
};
function prioColor(p: string | null): string { return p ? (PRIO[p.toLowerCase()] ?? 'var(--yap-fg-muted)') : 'var(--yap-fg-faint)'; }

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
  const [tasks, setTasks] = useState<Task[]>(loadTasks);
  const [input, setInput] = useState('');
  const [milestoneView, setMilestoneView] = useState(false);
  const [dragOverCol, setDragOverCol] = useState<Col | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const persist = useCallback((next: Task[]) => { setTasks(next); saveTasks(next); }, []);

  const addTask = useCallback((text: string, col?: Col) => {
    if (!text.trim()) return;
    const parsed = parseScript(text);
    persist([{ id: crypto.randomUUID(), ...parsed, column: col ?? 'todo', createdAt: new Date().toISOString() }, ...tasks]);
    setInput('');
  }, [tasks, persist]);

  const removeTask = useCallback((id: string) => { persist(tasks.filter((t) => t.id !== id)); }, [tasks, persist]);
  const handleSubmit = (e: FormEvent) => { e.preventDefault(); addTask(input); };

  const loadExamples = () => {
    const items = EXAMPLES.map((ex) => ({
      id: crypto.randomUUID(), ...parseScript(ex.text), column: ex.column, createdAt: new Date().toISOString(),
    })) as Task[];
    persist([...items, ...tasks]);
  };

  /* -- Drag-and-drop ------------------------------------------------------ */

  const onDragStart = (e: DragEvent<HTMLDivElement>, id: string) => {
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggingId(id);
  };
  const onDragEnd = () => { setDraggingId(null); setDragOverCol(null); };

  const onDragOver = (e: DragEvent<HTMLDivElement>, col: Col) => {
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
    const id = e.dataTransfer.getData('text/plain');
    if (id) persist(tasks.map((t) => (t.id === id ? { ...t, column: target } : t)));
    setDragOverCol(null); setDraggingId(null);
  };

  /* -- Derived data ------------------------------------------------------- */

  const colTasks = useMemo(() => {
    const m: Record<Col, Task[]> = { 'todo': [], 'in-progress': [], 'review': [], 'done': [] };
    for (const t of tasks) m[t.column].push(t);
    return m;
  }, [tasks]);

  const milestoneGroups = useMemo(() => {
    if (!milestoneView) return null;
    const gm = new Map<string, Task[]>();
    const un: Task[] = [];
    for (const t of tasks) { if (t.goal) { if (!gm.has(t.goal)) gm.set(t.goal, []); gm.get(t.goal)!.push(t); } else un.push(t); }
    const groups = Array.from(gm.entries()).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, items]) => ({ name, tasks: items, done: items.filter((t) => t.column === 'done').length, total: items.length }));
    if (un.length) groups.push({ name: 'Ungrouped', tasks: un, done: un.filter((t) => t.column === 'done').length, total: un.length });
    return groups;
  }, [tasks, milestoneView]);

  const preview = useMemo(() => (input.trim() ? parseScript(input) : null), [input]);

  /* -- Render helpers ----------------------------------------------------- */

  const renderCard = (task: Task) => (
    <div key={task.id} draggable onDragStart={(e) => onDragStart(e, task.id)} onDragEnd={onDragEnd}
      style={{ ...S.card, opacity: draggingId === task.id ? 0.4 : 1 }}>
      <div style={S.cardTop}>
        <span style={{ ...S.cardTitle, ...(task.column === 'done' ? { textDecoration: 'line-through', opacity: 0.5 } : {}) }}>
          {task.title}
        </span>
        <button type="button" onClick={() => removeTask(task.id)} style={S.removeBtn}>&times;</button>
      </div>
      <div style={S.cardBadges}>
        {task.assignee && <span style={{ ...S.badge, ...S.bAssign }}>+{task.assignee}</span>}
        {task.workspace && <span style={{ ...S.badge, ...S.bWork }}>@{task.workspace}</span>}
        {task.priority && <span style={S.prioRow}><span style={{ ...S.prioDot, background: prioColor(task.priority) }} /><span style={{ fontSize: 11, color: 'var(--yap-fg-muted)' }}>{task.priority}</span></span>}
        {task.dueDate && <span style={{ ...S.badge, ...S.bDue }}>due:{task.dueDate}</span>}
        {task.goal && <span style={{ ...S.badge, ...S.bGoal }}>{task.goal}</span>}
      </div>
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
          <h2 style={S.colLabel}>{c.label}</h2>
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
        <form onSubmit={handleSubmit} style={S.form}>
          <input type="text" value={input} onChange={(e) => setInput(e.target.value)}
            placeholder="Add a task -- try: Design onboarding #+alice #@launch #!high #^q3-release due:friday" style={S.input} />
          <button type="submit" disabled={!input.trim()} style={S.addBtn}>Add</button>
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
          <button type="button" onClick={loadExamples} style={S.actBtn}>+ Sprint planning</button>
          <button type="button" onClick={() => setMilestoneView(!milestoneView)}
            style={{ ...S.actBtn, ...(milestoneView ? S.actBtnOn : {}) }}>
            {milestoneView ? 'Kanban view' : 'Milestone view'}
          </button>
          <span style={S.countLabel}>{tasks.length} task{tasks.length !== 1 ? 's' : ''}</span>
        </div>

        {milestoneView && milestoneGroups ? (
          <div className="pm-milestones">
            {milestoneGroups.length === 0 ? (
              <div style={S.colEmpty}>No tasks yet. Add some or load the Sprint planning example.</div>
            ) : milestoneGroups.map((g) => (
              <div key={g.name} style={S.msGroup}>
                <div style={S.msHead}>
                  <span style={S.msName}>{g.name}</span>
                  <span style={S.msCount}>{g.done}/{g.total} done</span>
                </div>
                <div style={S.progTrack}>
                  <div style={{ ...S.progFill, width: g.total > 0 ? `${(g.done / g.total) * 100}%` : '0%' }} />
                </div>
                <div style={S.msCards}>
                  {g.tasks.map((t) => (
                    <div key={t.id} style={S.msCard}>
                      <span style={{ ...S.msCardTitle, ...(t.column === 'done' ? { textDecoration: 'line-through', opacity: 0.5 } : {}) }}>{t.title}</span>
                      <span style={{ ...S.badge, color: colMeta(t.column).accent }}>{colMeta(t.column).label}</span>
                      {t.assignee && <span style={{ ...S.badge, ...S.bAssign }}>+{t.assignee}</span>}
                      <button type="button" onClick={() => removeTask(t.id)} style={S.removeBtn}>&times;</button>
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
  input: { flex: 1, padding: '12px 16px', borderRadius: 10, border: '1px solid var(--yap-input-border)', background: 'var(--yap-input-bg)', color: 'var(--yap-fg)', fontSize: 15, fontFamily: 'var(--yap-font-mono)', outline: 'none' },
  addBtn: { padding: '12px 24px', borderRadius: 10, border: 'none', background: 'var(--yap-accent)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' },
  preview: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', marginBottom: 16, borderRadius: 8, background: 'var(--yap-accent-muted)', border: '1px solid var(--yap-accent)', fontSize: 14, flexWrap: 'wrap' as const },
  prevTitle: { color: 'var(--yap-fg)', fontWeight: 500 },
  actions: { display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 28, alignItems: 'center' },
  actBtn: { padding: '8px 16px', borderRadius: 8, border: '1px solid var(--yap-border-subtle)', background: 'rgba(255,255,255,.04)', color: 'var(--yap-fg-muted)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  actBtnOn: { background: 'var(--yap-accent-muted)', color: 'var(--yap-accent-hover)', borderColor: 'var(--yap-accent)' },
  countLabel: { marginLeft: 'auto', fontSize: 13, color: 'var(--yap-fg-faint)' },
  col: { minWidth: 0, borderRadius: 12, background: 'var(--yap-bg)', borderTop: '3px solid', padding: 12, minHeight: 200 },
  colOver: { border: '2px dashed var(--yap-accent)', background: 'var(--yap-accent-muted)', borderTop: '3px solid' },
  colHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, paddingBottom: 8, borderBottom: '1px solid var(--yap-border-subtle)' },
  colLabel: { fontSize: 13, fontWeight: 600, fontFamily: 'var(--yap-font-mono)', textTransform: 'uppercase' as const, letterSpacing: '.08em', color: 'var(--yap-fg-muted)' },
  colCnt: { fontSize: 12, fontWeight: 600, color: 'var(--yap-fg-faint)', background: 'var(--yap-border-subtle)', borderRadius: 10, padding: '2px 8px', minWidth: 22, textAlign: 'center' as const },
  colBody: { display: 'flex', flexDirection: 'column' as const, gap: 8 },
  colEmpty: { fontSize: 13, color: 'var(--yap-fg-faint)', padding: '24px 0', textAlign: 'center' as const },
  card: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--yap-border)', background: 'var(--yap-card-bg)', transition: 'transform .12s, box-shadow .12s, opacity .15s' },
  cardTop: { display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 4 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: 500, lineHeight: 1.35 },
  removeBtn: { border: 'none', background: 'none', color: 'var(--yap-fg-faint)', fontSize: 16, cursor: 'pointer', padding: '0 2px', flexShrink: 0, lineHeight: 1 },
  cardBadges: { display: 'flex', flexWrap: 'wrap' as const, gap: 4, alignItems: 'center' },
  badge: { padding: '2px 7px', borderRadius: 5, fontSize: 11, fontWeight: 600, fontFamily: 'var(--yap-font-mono)' },
  bAssign: { background: 'var(--yap-info-bg)', color: 'var(--yap-info-fg)' },
  bWork: { background: 'var(--yap-success-bg)', color: 'var(--yap-success-fg)' },
  bDue: { background: 'var(--yap-border-subtle)', color: 'var(--yap-fg-muted)' },
  bGoal: { background: 'var(--yap-accent-muted)', color: 'var(--yap-accent-hover)' },
  prioRow: { display: 'inline-flex', alignItems: 'center', gap: 4 },
  prioDot: { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 },
  msGroup: { marginBottom: 28, padding: 16, borderRadius: 12, background: 'var(--yap-bg)', border: '1px solid var(--yap-border-subtle)' },
  msHead: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  msName: { fontSize: 16, fontWeight: 600, color: 'var(--yap-accent-hover)', fontFamily: 'var(--yap-font-mono)' },
  msCount: { fontSize: 13, color: 'var(--yap-fg-faint)' },
  progTrack: { height: 6, borderRadius: 3, background: 'var(--yap-border-subtle)', marginBottom: 14, overflow: 'hidden' },
  progFill: { height: '100%', borderRadius: 3, background: 'var(--yap-accent)', transition: 'width .3s ease' },
  msCards: { display: 'flex', flexDirection: 'column' as const, gap: 6 },
  msCard: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderRadius: 8, background: 'var(--yap-card-bg)', border: '1px solid var(--yap-border-subtle)' },
  msCardTitle: { flex: 1, fontSize: 14, fontWeight: 500 },
  footer: { borderTop: '1px solid var(--yap-border)', padding: '20px 24px', display: 'flex', justifyContent: 'center', gap: 12, fontSize: 13, color: 'var(--yap-fg-faint)' },
  ftLink: { color: 'var(--yap-accent)', textDecoration: 'none' },
};
