// A tool's learning path is an expedition without a badge, and is held to the
// same rules: every step written, nothing before what it builds on, and it ends
// on the tool's own lesson. The build checks this too (src/lib/curriculum.ts);
// this runs without Astro, against the files on disk.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS } from '../src/data/tools.ts';
import { TRACKS } from '../src/data/tracks.ts';
import { checkExpeditions, type LessonFacts } from '../src/lib/expeditions.ts';
import type { ExpeditionPlan } from '../src/data/expeditions.ts';

const dir = 'src/content/lessons';
const ready = new Set(TRACKS.flatMap((t) => t.lessons.filter((l) => l.status === 'ready').map((l) => `${t.id}/${l.slug}`)));
const lessons = new Map<string, LessonFacts>();
for (const t of readdirSync(dir)) for (const f of readdirSync(join(dir, t))) {
  const front = readFileSync(join(dir, t, f), 'utf8').split(/^---$/m)[1];
  const id = `${t}/${f.replace(/\.mdx$/, '')}`;
  lessons.set(id, { title: front.match(/^title: (.*)$/m)![1], minutes: Number(front.match(/^minutes: (\d+)$/m)![1]), ready: ready.has(id), buildsOn: front.match(/^builds_on: \[(.*)\]$/m)![1].split(',').map((s) => s.trim()).filter(Boolean) });
}

test('every tool path is written, in builds_on order, and ends on the tool\'s own lesson', () => {
  const withPath = TOOLS.filter((t) => t.path?.length);
  const plans: ExpeditionPlan[] = withPath.map((t) => ({ id: `tool-${t.id}`, title: t.name, who: '', tagline: '', badge: `path:${t.id}`, icon: '', hue: 0, status: 'ready', lessons: t.path! }));
  assert.deepEqual(checkExpeditions(plans, lessons), []);
  for (const t of withPath) assert.equal(t.path!.at(-1), `tools/${t.id}`, `${t.id}'s path ends elsewhere`);
});

test('every written tools lesson closes a path, so no tool lesson is unreachable from the atlas', () => {
  const ends = new Set(TOOLS.filter((t) => t.path?.length).map((t) => t.path!.at(-1)));
  for (const id of ready) if (id.startsWith('tools/')) assert.ok(ends.has(id), `${id} is written but no tool path ends on it`);
});

test('a tools lesson is named after a tool in the atlas', () => {
  const ids = new Set(TOOLS.map((t) => t.id));
  for (const l of TRACKS.find((t) => t.id === 'tools')!.lessons) assert.ok(ids.has(l.slug), `tools/${l.slug} has no atlas entry`);
});
