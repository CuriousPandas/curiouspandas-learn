import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, KEY, rank, streak } from '../src/lib/progress.ts';

function mem(initial?: Record<string, string>) {
  const m = new Map(Object.entries(initial ?? {}));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
}

test('XP is awarded once per id and survives a reload', () => {
  const s = mem();
  const a = new Store(s);
  assert.equal(a.award('lessons', 'git/what-is-git', 30), 30);
  assert.equal(a.award('lessons', 'git/what-is-git', 30), 0);
  assert.equal(new Store(s).data.xp, 30);
});

test('a corrupt store is kept, flagged and never overwritten', () => {
  // Starting empty and saving over it would erase a learner's history the
  // first time they earned anything after a bad write.
  const s = mem({ [KEY]: '{"v":1,"xp":120,"lessons":{' });
  const st = new Store(s);
  assert.equal(st.state, 'corrupt');
  st.award('lessons', 'x', 10);
  assert.equal(s.m.get(KEY), '{"v":1,"xp":120,"lessons":{', 'original bytes untouched');
  st.reset();
  assert.equal(st.state, 'ok');
  assert.equal(JSON.parse(s.m.get(KEY)!).xp, 0, 'an explicit reset is what replaces it');
});

test('no storage at all reads as unavailable, not as a fresh start', () => {
  const st = new Store(null);
  assert.equal(st.state, 'unavailable');
});

test('ranks and streaks', () => {
  assert.equal(rank(0).name, 'Curious Cub');
  assert.equal(rank(150).name, 'Bamboo Hacker');
  assert.equal(rank(149).toNext, 1);
  const today = new Date(2026, 9, 29);
  assert.equal(streak(['2026-10-27', '2026-10-28', '2026-10-29'], today), 3);
  assert.equal(streak(['2026-10-27', '2026-10-28'], today), 2, 'yesterday still counts until today ends');
  assert.equal(streak(['2026-10-26'], today), 0);
});
