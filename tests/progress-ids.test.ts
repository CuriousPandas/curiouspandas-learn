// Learners' progress is stored under ids, in their own browser, where no
// deploy can reach it. So a renamed lesson, quiz or mission does not fail
// anything: the learner's tick quietly disappears and an Expedition containing
// it can never complete. These tests turn that into a build failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AWARD_SITES, awardSites, collect, shipped } from '../scripts/progress-ids.ts';
import { RENAMED, RETIRED, migrate, type Kind } from '../src/lib/progress-renames.ts';
import { Store, KEY } from '../src/lib/progress.ts';

const now = await collect();
const list = shipped();
const kinds = Object.keys(now) as Kind[];

test('no shipped progress id has disappeared without a rename or retirement', () => {
  const lost = kinds.flatMap((k) => list[k]
    .filter((id) => !now[k].includes(id) && !(id in RENAMED[k]) && !RETIRED[k].includes(id))
    .map((id) => `${k} "${id}"`));
  assert.deepEqual(lost, [], `These ids were shipped and learners may hold progress under them. Map each to its new id in RENAMED (src/lib/progress-renames.ts), or list it in RETIRED if nothing replaces it:\n  ${lost.join('\n  ')}`);
});

test('every rename points at an id that exists now', () => {
  const dangling = kinds.flatMap((k) => Object.entries(RENAMED[k]).filter(([, to]) => !now[k].includes(to)).map(([from, to]) => `${k} ${from} -> ${to}`));
  assert.deepEqual(dangling, []);
});

test('every current id is in the shipped list', () => {
  const unlisted = kinds.flatMap((k) => now[k].filter((id) => !list[k].includes(id)).map((id) => `${k} "${id}"`));
  assert.deepEqual(unlisted, [], `New ids - run: node scripts/progress-ids.ts --write\n  ${unlisted.join('\n  ')}`);
});

test('every file that awards progress says where its ids come from', () => {
  // A new widget that calls award() with ids from somewhere the collector does
  // not read would ship ids nobody guards. Reviewing it here is the fix.
  assert.deepEqual(awardSites(), Object.keys(AWARD_SITES).sort());
});

test('the collector finds what the site is known to hold (2026-10-30, after the agents merge: 73 lessons, 181 quizzes, 51 real)', () => {
  // A regex that stopped matching would make every check above pass vacuously.
  // Lower these only when content is deliberately removed, as the merge did.
  assert.ok(now.lessons.length >= 73 && now.quizzes.length >= 181 && now.real.length >= 51 && now.missions.length >= 63,
    JSON.stringify(Object.fromEntries(kinds.map((k) => [k, now[k].length]))));
});

test('a renamed id moves the learner\'s record, keeps the earliest date and adds no XP', () => {
  const p = { lessons: { 'old/a': '2026-01-01', 'old/b': '2026-03-01', 'new/b': '2026-02-01' }, quizzes: {}, missions: {}, real: {} };
  const renamed = { lessons: { 'old/a': 'new/a', 'old/b': 'new/b' }, quizzes: {}, missions: {}, real: {} };
  assert.equal(migrate(p, renamed), true);
  assert.deepEqual(p.lessons, { 'new/a': '2026-01-01', 'new/b': '2026-02-01' });
  assert.equal(migrate(p, renamed), false, 'running it again changes nothing');
});

test('a v1 store saved before Expeditions still loads, untouched (fixture from 2026-10-30)', () => {
  // If the store's shape or version ever changes, this fixture is what every
  // returning learner already has. Failing to load it means a "could not read
  // your progress" banner for all of them.
  const raw = readFileSync(new URL('./fixtures/progress-v1.json', import.meta.url), 'utf8');
  const m = new Map([[KEY, raw]]);
  const st = new Store({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) });
  assert.equal(st.state, 'ok');
  assert.equal(st.data.xp, 425);
  // Through RENAMED, so a later rename of one of these ids checks the migration
  // instead of failing this test.
  const fixture = JSON.parse(raw);
  for (const k of kinds) for (const id of Object.keys(fixture[k])) assert.ok(st.has(k, RENAMED[k][id] ?? id), `${k} ${id} lost on load`);
  const renames = kinds.some((k) => Object.keys(fixture[k]).some((id) => id in RENAMED[k]));
  if (!renames) assert.equal(m.get(KEY), raw, 'nothing to migrate, so the stored bytes are not rewritten');
});
