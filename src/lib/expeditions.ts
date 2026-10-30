// Pure checks and shapes for expeditions, shared by the build (curriculum.ts)
// and the node tests, so the rule is enforced in both places from one copy.
import type { ExpeditionPlan } from '../data/expeditions.ts';

export type LessonFacts = { title: string; minutes: number; ready: boolean; buildsOn: string[] };

export const bonusXp = (e: Pick<ExpeditionPlan, 'lessons'>) => 10 * e.lessons.length;
export const missionId = (id: string) => `expedition-${id}`;

/** Every way the plan can be wrong. Empty means it is safe to build. */
export function checkExpeditions(plans: ExpeditionPlan[], lessons: Map<string, LessonFacts>): string[] {
  const problems: string[] = [];

  // The dependency graph itself: a dangling or circular builds_on would make
  // "nothing used before it is taught" impossible to satisfy or to check.
  for (const [id, l] of lessons) {
    for (const dep of l.buildsOn) {
      if (dep === id) problems.push(`${id} builds_on itself`);
      else if (!lessons.has(dep)) problems.push(`${id} builds_on ${dep}, which does not exist`);
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') { problems.push(`builds_on has a cycle: ${[...path, id].join(' -> ')}`); return; }
    state.set(id, 'visiting');
    for (const dep of lessons.get(id)?.buildsOn ?? []) if (lessons.has(dep)) visit(dep, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of lessons.keys()) visit(id, []);

  const ids = new Set<string>(), badges = new Set<string>();
  for (const e of plans) {
    if (ids.has(e.id)) problems.push(`two expeditions are called ${e.id}`);
    if (badges.has(e.badge)) problems.push(`two expeditions award the ${e.badge} badge`);
    ids.add(e.id); badges.add(e.badge);
    if (!e.lessons.length) problems.push(`${e.id} has no lessons`);
    const seen = new Set<string>();
    for (const id of e.lessons) {
      const l = lessons.get(id);
      if (!l) { problems.push(`${e.id} lists ${id}, which does not exist`); continue; }
      if (!l.ready) problems.push(`${e.id} lists ${id}, which is not ready`);
      if (seen.has(id)) problems.push(`${e.id} lists ${id} twice`);
      for (const dep of l.buildsOn) {
        if (!seen.has(dep)) {
          problems.push(e.lessons.includes(dep)
            ? `${e.id}: ${id} comes before ${dep}, which it builds on - move ${dep} earlier`
            : `${e.id}: ${id} builds on ${dep}, which the expedition skips - add it earlier, or drop ${id}`);
        }
      }
      seen.add(id);
    }
  }
  return problems;
}
