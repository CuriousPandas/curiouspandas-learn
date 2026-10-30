// Browser side of expeditions. Which lessons are done comes from the progress
// store; nothing about expeditions is added to it except the badge's XP, kept
// as a mission so the store's shape (and every learner's saved copy) is
// unchanged.
import { store, type Progress } from './progress.ts';
import { award } from './ui.ts';

export type ExpeditionDef = { id: string; title: string; badge: string; xp: number; lessons: string[] };

// Separate from the progress key on purpose: a following choice is a
// preference, and losing it costs nothing, so it must never be able to make
// the progress record fail to load.
export const ACTIVE_KEY = 'curiouspandas.expedition.v1';

export function following(): string | null {
  try { return localStorage.getItem(ACTIVE_KEY); } catch { return null; }
}

/** Returns false when the browser will not store it, so the page can say so. */
export function follow(id: string | null): boolean {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id); else localStorage.removeItem(ACTIVE_KEY);
    return true;
  } catch { return false; }
}

export const done = (p: Progress, d: ExpeditionDef) => d.lessons.filter((id) => p.lessons[id]).length;
export const earned = (p: Progress, d: ExpeditionDef) => !!p.missions[`expedition-${d.id}`];

/**
 * Awards the badge for every expedition whose lessons are all done. Run on
 * load as well as on finishing a lesson: lessons finished before expeditions
 * existed count, and the award is once per id, so running it twice is harmless.
 */
export function settle(defs: ExpeditionDef[]) {
  const p = store().data;
  for (const d of defs) {
    if (!earned(p, d) && done(p, d) === d.lessons.length) award('missions', `expedition-${d.id}`, d.xp, `Expedition complete: ${d.badge} badge`);
  }
}
