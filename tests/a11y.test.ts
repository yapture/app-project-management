import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Source-level WCAG 2.2 AA regression checks for the single-screen SPA (src/App.tsx).
const ROOT = resolve(import.meta.dir, '..');
const src = readFileSync(join(ROOT, 'src/App.tsx'), 'utf8');

describe('a11y (source-level)', () => {
  test('no outline:none without a :focus-visible replacement rule', () => {
    if (/outline:\s*['"]none['"]/.test(src)) {
      expect(src).toMatch(/input:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--yap-ring\)/);
    }
    expect(src).toMatch(/input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--yap-ring\)/);
  });

  test('every x remove button has an aria-label and an aria-hidden glyph', () => {
    const buttons = [...src.matchAll(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g)].map(m => m[0]).filter(b => /&times;/.test(b) && !/\d&times;|&times;\{/.test(b));
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b).toMatch(/aria-label=\{`Remove /);
      expect(b).toMatch(/<span aria-hidden="true">&times;<\/span>/);
    }
  });

  test('main input has a programmatic label', () => {
    expect(src).toMatch(/<label htmlFor="task-input"[^>]*>Add a task<\/label>/);
    expect(src).toMatch(/<input id="task-input"/);
  });

  test('always-mounted polite status region exists', () => {
    expect(src).toMatch(/<p role="status" aria-live="polite"[^>]*className="sr-only"/);
    expect(src).toContain('.sr-only {');
  });

  test('every task card (both views) has a keyboard move <select> labelled per task', () => {
    expect(src).toMatch(/<select aria-label=\{`Move \$\{task\.title\} to`\} value=\{task\.column\}/);
    // used in the kanban card and in the milestone card
    expect((src.match(/moveSelect\(/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/if \(id !== null\) void moveTask\(id, target\)/);
  });

  test('milestone group name is a heading', () => {
    expect(src).toMatch(/<h2 id=\{`ms-\$\{gi\}`\}[^>]*style=\{S\.msName\}/);
  });

  test('footer links are underlined; faint text token is not used for text', () => {
    expect(src).toMatch(/ftLink: \{[^}]*textDecoration: 'underline'/);
    expect(src).not.toMatch(/(?<![a-zA-Z])color: 'var\(--yap-fg-faint\)'/);
  });
  test("a mouse drop does not move focus; the move select does", () => {
    expect(/if \(restoreFocus\) pendingFocus\.current = \{ id, attribute: 'data-move-id'/.test(src)).toBe(true);
    expect(/moveTask\(task\.id, e\.target\.value as Col, true\)/.test(src)).toBe(true);
    expect(/if \(id !== null\) void moveTask\(id, target\);/.test(src)).toBe(true);
  });
});
