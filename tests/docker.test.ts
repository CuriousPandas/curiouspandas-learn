// Pins the two cache rules the layers lesson teaches, and the cascade. If the
// widget ever showed `npm ci` cached after package.json changed, it would teach
// the one belief that ships stale dependencies.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, NAIVE, FRIENDLY, PROJECT, matchSources } from '../src/lib/docker/cache.ts';

const status = (b: ReturnType<typeof build>) => b.steps.map((s) => (s.cached ? 'cached' : 'built'));

test('a second build of unchanged files is fully cached', () => {
  const cache = new Set<string>();
  build(NAIVE, PROJECT, cache);
  const again = build(NAIVE, PROJECT, cache);
  assert.ok(again.steps.every((s) => s.cached));
  assert.equal(again.seconds, 0);
});

test('a changed file invalidates its COPY layer and every layer after it, not before', () => {
  const cache = new Set<string>();
  build(FRIENDLY, PROJECT, cache);
  const b = build(FRIENDLY, { ...PROJECT, 'src/server.js': 'changed' }, cache);
  // FROM, WORKDIR, COPY package*, RUN npm ci | COPY . ., RUN build, CMD
  assert.deepEqual(status(b), ['cached', 'cached', 'cached', 'cached', 'built', 'built', 'built']);
});

test('copying everything first means a code change reinstalls dependencies', () => {
  const cache = new Set<string>();
  build(NAIVE, PROJECT, cache);
  const b = build(NAIVE, { ...PROJECT, 'src/server.js': 'changed' }, cache);
  const install = b.steps.find((s) => s.text === 'RUN npm ci')!;
  assert.equal(install.cached, false);
  assert.ok(b.seconds >= 45);
});

test('copying the package files first keeps the install cached across code changes', () => {
  const cache = new Set<string>();
  build(FRIENDLY, PROJECT, cache);
  const b = build(FRIENDLY, { ...PROJECT, 'src/server.js': 'changed' }, cache);
  assert.equal(b.steps.find((s) => s.text === 'RUN npm ci')!.cached, true);
  assert.ok(b.seconds < 45);
});

test('changing package.json reinstalls in both orders - the cache never hides a dependency change', () => {
  for (const df of [NAIVE, FRIENDLY]) {
    const cache = new Set<string>();
    build(df, PROJECT, cache);
    const b = build(df, { ...PROJECT, 'package.json': '{ "dependencies": { "express": "^5.1.0" } }' }, cache);
    assert.equal(b.steps.find((s) => s.text === 'RUN npm ci')!.cached, false);
  }
});

test('RUN is matched on its text alone: editing the command misses, nothing else does', () => {
  const cache = new Set<string>();
  build(FRIENDLY, PROJECT, cache);
  const b = build(FRIENDLY.replace('RUN npm run build', 'RUN npm run build --production'), PROJECT, cache);
  assert.deepEqual(status(b), ['cached', 'cached', 'cached', 'cached', 'cached', 'built', 'built']);
});

test('.dockerignore keeps an ignored file from busting COPY . .', () => {
  const cache = new Set<string>();
  build(FRIENDLY, PROJECT, cache, ['README.md']);
  const b = build(FRIENDLY, { ...PROJECT, 'README.md': '# new docs' }, cache, ['README.md']);
  assert.ok(b.steps.every((s) => s.cached));
  const without = new Set<string>();
  build(FRIENDLY, PROJECT, without);
  assert.equal(build(FRIENDLY, { ...PROJECT, 'README.md': '# new docs' }, without).steps[4].cached, false);
});

test('COPY source patterns', () => {
  const files = ['package.json', 'package-lock.json', 'src/a.js', 'README.md'];
  assert.deepEqual(matchSources('package*.json', files), ['package.json', 'package-lock.json']);
  assert.deepEqual(matchSources('src/', files), ['src/a.js']);
  assert.deepEqual(matchSources('.', files), files);
});

test('mistakes are reported, not silently skipped', () => {
  assert.match(build('RUN echo hi', PROJECT, new Set()).error!, /start with FROM/);
  assert.match(build('FROM x\nCOPY nope.txt ./', PROJECT, new Set()).error!, /no such file/);
  assert.match(build('FROM x\nRUNN echo', PROJECT, new Set()).error!, /Unknown instruction/);
});
