// The README's "How it is sandboxed" section makes claims about what the site's
// code never does. This pins them: each rule names the claim it protects, so a
// change that breaks one fails here instead of quietly making the README false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|astro|mjs|js)$/.test(f) ? [p] : [];
});
const src = files('src').map((p) => ({ p: p.replace(/\\/g, '/'), text: readFileSync(p, 'utf8') }));
const hits = (re: RegExp) => src.filter((f) => re.test(f.text)).map((f) => f.p);

test('nothing a learner types is ever run as code', () => {
  assert.deepEqual(hits(/\beval\s*\(|new Function\s*\(|set(Timeout|Interval)\s*\(\s*['"`]/), []);
});

test('the site makes no network calls of its own: no backend, no analytics', () => {
  assert.deepEqual(hits(/\bfetch\s*\(|XMLHttpRequest|new WebSocket|EventSource|navigator\.sendBeacon/), []);
});

test('no cookies: progress lives in localStorage only', () => {
  assert.deepEqual(hits(/document\.cookie/), []);
});

// innerHTML is reviewed by hand: each of these builds markup from the site's own
// strings and numbers, never from typed text or an imported file. A new use has
// to be added here deliberately, after the same review.
const REVIEWED_INNER_HTML = [
  'src/components/GitOpsSim.astro',
  'src/components/KVCacheSim.astro',
  'src/components/KVCalc.astro',
  'src/components/LayerCache.astro',
  'src/components/ScrapeSim.astro',
  'src/layouts/Base.astro',
  'src/pages/progress/index.astro',
];

test('HTML is only ever built from the site\'s own strings (reviewed list)', () => {
  const found = hits(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|set:html/).sort();
  const unreviewed = found.filter((p) => !REVIEWED_INNER_HTML.includes(p));
  assert.deepEqual(unreviewed, [], `review these for user-controlled input, then add them to REVIEWED_INNER_HTML: ${unreviewed.join(', ')}`);
});
