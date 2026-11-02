// DOM helpers shared by the playgrounds. Plain DOM, no framework: each widget
// is a few hundred lines and a framework runtime would outweigh all of them.

import { store } from './progress.ts';
import type { Mission } from './missions.ts';

export type TermLine = { text: string; kind: 'out' | 'err' | 'hint' | 'cmd' | 'dim' };

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export function toast(text: string) {
  const t = el('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function award(kind: 'lessons' | 'quizzes' | 'missions' | 'real', id: string, xp: number, label: string) {
  const got = store().award(kind, id, xp);
  if (got) toast(`+${got} XP · ${label}`);
  return got;
}

export function mountTerminal(root: HTMLElement, opts: { prompt: string; greeting: string[]; onCommand: (line: string) => TermLine[] }) {
  const out = el('div', { class: 'term-out', role: 'log', 'aria-live': 'polite' });
  const input = el('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Command' });
  const bar = el('label', { class: 'term-in' }, el('span', {}, opts.prompt), input);
  root.classList.add('term');
  root.append(out, bar);
  const history: string[] = [];
  let cursor = 0;

  const print = (lines: TermLine[]) => {
    for (const l of lines) out.append(el('div', { class: l.kind }, l.text || ' '));
    out.scrollTop = out.scrollHeight;
  };
  print(opts.greeting.map((text) => ({ text, kind: 'dim' as const })));

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const line = input.value;
      input.value = '';
      if (line.trim()) { history.push(line); cursor = history.length; }
      if (line.trim() === 'clear') { out.replaceChildren(); return; }
      print([{ text: `${opts.prompt} ${line}`, kind: 'cmd' }]);
      print(opts.onCommand(line));
    } else if (e.key === 'ArrowUp' && history.length) {
      cursor = Math.max(0, cursor - 1); input.value = history[cursor]; e.preventDefault();
    } else if (e.key === 'ArrowDown' && history.length) {
      cursor = Math.min(history.length, cursor + 1); input.value = history[cursor] ?? ''; e.preventDefault();
    }
  });
  root.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('a,button') && !getSelection()?.toString()) input.focus({ preventScroll: true }); });

  return {
    print,
    clear: () => out.replaceChildren(),
    type(line: string) { input.value = line; input.focus(); },
    run(line: string) { input.value = line; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); },
  };
}

/** Renders a mission's checklist; call the returned function after anything changes. */
export function mountMission<S>(root: HTMLElement, m: Mission<S>, state: () => S, onType?: (cmd: string) => void) {
  const title = el('div', { class: 'm-title' }, el('span', { class: 'eyebrow' }, 'Mission'), el('strong', {}, m.title), el('span', { class: 'pill gold' }, `+${m.xp} XP`));
  const bar = el('div', { class: 'm-bar' }, el('i'));
  const list = el('ol', { class: 'm-steps' });
  const debrief = el('div', { class: 'm-debrief', hidden: '' }, el('strong', {}, 'What just happened'), el('p', {}, m.debrief));
  root.classList.add('mission');
  root.append(title, bar, list, debrief);
  const items = m.steps.map((s) => {
    const hint = el('button', { type: 'button', class: 'm-hint' }, 'hint');
    const code = el('code', { hidden: '' }, s.hint ?? '');
    const why = el('p', { class: 'm-why', hidden: '' });
    const li = el('li', {}, el('span', { class: 'm-text' }, s.text), ' ', hint, code, why);
    hint.addEventListener('click', () => {
      code.hidden = !code.hidden;
      hint.textContent = code.hidden ? 'hint' : 'hide';
    });
    // A widget with no terminal passes nothing, and then the hint must not promise one: the
    // code lab showed "Click to put this in the terminal" on a page that has no terminal.
    if (onType) {
      code.addEventListener('click', () => { if (s.hint && !s.hint.includes('<') && !s.hint.includes('  then  ') && !s.hint.includes('  or  ')) onType(s.hint); });
      code.title = 'Click to put this in the terminal';
    }
    list.append(li);
    return li;
  });
  let complete = store().has('missions', m.id);
  return () => {
    const s = state();
    let firstOpen = -1;
    // Steps are shown done only in order: a later step that happens to be true
    // (e.g. "all 3 Ready" before you deleted anything) should not tick early.
    let ok = true;
    m.steps.forEach((st, i) => {
      ok = ok && st.done(s);
      items[i].classList.toggle('done', ok);
      if (!ok && firstOpen < 0) firstOpen = i;
      items[i].classList.toggle('current', i === firstOpen);
      const why = items[i].querySelector<HTMLElement>('.m-why')!;
      const reason = i === firstOpen && st.why ? st.why(s) : '';
      why.textContent = reason;
      why.hidden = !reason;
    });
    const n = firstOpen < 0 ? m.steps.length : firstOpen;
    (bar.firstChild as HTMLElement).style.width = `${(n / m.steps.length) * 100}%`;
    if (firstOpen < 0) {
      debrief.hidden = false;
      if (!complete) { complete = true; award('missions', m.id, m.xp, `Mission complete: ${m.title}`); root.classList.add('celebrate'); }
    }
  };
}
