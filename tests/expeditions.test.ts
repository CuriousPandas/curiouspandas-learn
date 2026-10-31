// An expedition that uses a lesson before teaching what it builds on fails no
// link check and no build of its own: the learner just meets a term nobody
// explained. These pin the order against each lesson's builds_on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { EXPEDITIONS, type ExpeditionPlan } from '../src/data/expeditions.ts';
import { TRACKS } from '../src/data/tracks.ts';
import { checkExpeditions, type LessonFacts } from '../src/lib/expeditions.ts';
import { collect } from '../scripts/progress-ids.ts';

const dir = 'src/content/lessons';
const ready = new Set(TRACKS.flatMap((t) => t.lessons.filter((l) => l.status === 'ready').map((l) => `${t.id}/${l.slug}`)));
const lessons = new Map<string, LessonFacts>();
for (const t of readdirSync(dir)) for (const f of readdirSync(join(dir, t))) {
  const front = readFileSync(join(dir, t, f), 'utf8').split(/^---$/m)[1];
  const list = front.match(/^builds_on: \[(.*)\]$/m);
  assert.ok(list, `${t}/${f} has no builds_on line (an empty one is "builds_on: []")`);
  lessons.set(`${t}/${f.replace(/\.mdx$/, '')}`, {
    title: front.match(/^title: (.*)$/m)![1],
    minutes: Number(front.match(/^minutes: (\d+)$/m)![1]),
    ready: ready.has(`${t}/${f.replace(/\.mdx$/, '')}`),
    buildsOn: list[1].split(',').map((s) => s.trim()).filter(Boolean),
  });
}
// A lesson still marked 'soon' has no file yet, so nothing it builds on is
// known. The build counts it as a lesson with no prerequisites
// (src/lib/curriculum.ts); this does the same, so a planned expedition may
// list planned lessons, and their order is checked once they are written.
for (const t of TRACKS) for (const l of t.lessons) {
  const id = `${t.id}/${l.slug}`;
  if (!lessons.has(id)) lessons.set(id, { title: l.title, minutes: 0, ready: false, buildsOn: [] });
}

test('every expedition, ready or planned, teaches before it relies', () => {
  assert.deepEqual(checkExpeditions(EXPEDITIONS, lessons), []);
});

test('all nine are planned and five are ready', () => {
  assert.equal(EXPEDITIONS.length, 9);
  assert.deepEqual(EXPEDITIONS.filter((e) => e.status === 'ready').map((e) => e.id), ['first-steps', 'platform-engineer', 'ai-builder', 'founder', 'teamwork']);
});

const plan = (lessons: string[]): ExpeditionPlan => ({ id: 'x', title: 'X', who: '', tagline: '', badge: 'B', icon: 'star', hue: 0, status: 'soon', lessons });

test('a ready expedition may not list an unwritten lesson; a planned one may', () => {
  const unwritten = 'change/rewrite-or-evolve';
  assert.equal(lessons.get(unwritten)?.ready, false, 'the fixture lesson must still be unwritten');
  assert.match(checkExpeditions([{ ...plan([unwritten]), status: 'ready' }], lessons).join(), /lists change\/rewrite-or-evolve, which is not ready/);
  assert.deepEqual(checkExpeditions([plan([unwritten])], lessons), []);
});

test('the check refuses a skipped prerequisite, a wrong order and a cycle', () => {
  assert.match(checkExpeditions([plan(['git/branches'])], lessons).join(), /git\/branches builds on git\/what-is-git, which the expedition skips/);
  assert.match(checkExpeditions([plan(['git/branches', 'git/what-is-git'])], lessons).join(), /comes before git\/what-is-git/);
  const looped = new Map(lessons);
  looped.set('git/what-is-git', { ...lessons.get('git/what-is-git')!, buildsOn: ['git/conflicts'] });
  assert.match(checkExpeditions([], looped).join(), /cycle: .*git\/what-is-git/);
  assert.match(checkExpeditions([plan(['git/nope'])], lessons).join(), /does not exist/);
});

test('each ready expedition\'s badge XP is a guarded progress id', async () => {
  // The badge is stored as a mission; if this id were not collected, renaming
  // an expedition would strand everyone who had earned it.
  const missions = (await collect()).missions;
  for (const e of EXPEDITIONS.filter((x) => x.status === 'ready')) assert.ok(missions.includes(`expedition-${e.id}`), e.id);
});
