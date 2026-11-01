// The coverage page claims to measure the site against CS2023. That claim dies
// quietly if the map and the curriculum drift apart: a renamed lesson that still
// counts toward a unit, a planned lesson nobody assigned, a gap with no plan.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TRACKS, groupOf } from '../src/data/tracks.ts';

const coverage = JSON.parse(readFileSync('src/data/cs2023-coverage.json', 'utf8')) as {
  areas: { id: string; title: string; units: { id: string; title: string; status: string; lessons: string[]; planned: string[]; note: string }[] }[];
};
const units = coverage.areas.flatMap((a) => a.units);
const lessonIds = new Set(TRACKS.flatMap((t) => t.lessons.map((l) => `${t.id}/${l.slug}`)));

test('the map holds all of CS2023: 17 areas and 162 units, each listed once', () => {
  assert.equal(coverage.areas.length, 17);
  assert.equal(units.length, 162);
  assert.equal(new Set(units.map((u) => u.id)).size, 162);
});

test('every lesson the map names exists in the curriculum', () => {
  for (const u of units) for (const id of [...u.lessons, ...u.planned]) assert.ok(lessonIds.has(id), `${u.id} names ${id}, which tracks.ts does not list`);
});

test('every foundations lesson closes a unit: nothing is planned for no reason', () => {
  const planned = new Set(units.flatMap((u) => u.planned));
  for (const t of TRACKS) {
    if (groupOf(t) !== 'foundations') continue;
    for (const l of t.lessons) assert.ok(planned.has(`${t.id}/${l.slug}`), `${t.id}/${l.slug} closes no knowledge unit`);
  }
});

// "Not looked at" and "looked at and left out" must never read the same.
test('a gap either has lessons planned or says why it was left out', () => {
  for (const u of units) {
    assert.ok(['covered', 'partial', 'none', 'excluded'].includes(u.status), `${u.id}: unknown status ${u.status}`);
    if (u.status === 'excluded') { assert.ok(u.note.length > 20, `${u.id} is excluded with no reason`); continue; }
    if (u.status !== 'covered') assert.ok(u.planned.length > 0, `${u.id} is ${u.status} and nothing is planned to close it`);
  }
});

test('a unit claiming to be taught today names a written lesson', () => {
  const ready = new Set(TRACKS.flatMap((t) => t.lessons.filter((l) => l.status === 'ready').map((l) => `${t.id}/${l.slug}`)));
  for (const u of units) {
    if (u.status !== 'covered' && u.status !== 'partial') continue;
    assert.ok(u.lessons.some((id) => ready.has(id)), `${u.id} is ${u.status} but none of its lessons are written`);
  }
});
