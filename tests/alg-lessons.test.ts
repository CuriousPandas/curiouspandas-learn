// What the four lessons print, run for real. Every code sample in them goes through
// real Python, and through the lab where the lab can run it, so a lesson can't show
// something the sandbox disagrees with. Every number in a lesson's table is computed
// again here: a table that drifts from its code is a false statement to a learner.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PyProgram } from '../src/lib/py/vm.ts';
import { KillerLab, comparisonFloor, nLgN, Lcg, type Pivot, type SortName, type InputName, type SortRun } from '../src/lib/cs/sorting.ts';
import { FloodLab, eqCount } from '../src/lib/cs/hashtable.ts';
import { replayOutage, shapeRun, logCeil } from '../src/lib/cs/trees.ts';
import { python, runPython } from './helpers/python.ts';

python();

const LESSONS = ['sorting', 'divide-and-conquer', 'hash-tables', 'trees-and-heaps'];
const read = (slug: string) => readFileSync(`src/content/lessons/algorithms/${slug}.mdx`, 'utf8');

for (const slug of LESSONS) {
  const src = read(slug);
  const labs = [...src.matchAll(/code=\{`([\s\S]*?)`\}/g)].map((m) => m[1]);
  const fences = [...src.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]);

  test(`${slug}: every code-lab sample prints the same in the lab and in real Python`, () => {
    for (const code of labs) {
      const r = runPython(code);
      const p = new PyProgram(code);
      p.run();
      assert.equal(p.stdout, r.stdout, `differs for:\n${code}`);
      // A sample may end in an error on purpose: then both must end in the same one.
      if (r.status !== 0) assert.equal(p.error?.type, r.stderr.trim().split('\n').at(-1)!.split(':')[0], code);
      else assert.equal(p.status, 'done', `${p.error?.type}: ${p.error?.message}\n${code}`);
    }
  });

  test(`${slug}: every code block for a real terminal runs on real Python`, () => {
    for (const code of fences) {
      const r = runPython(code);
      assert.equal(r.status, 0, `${r.stderr}\n${code}`);
      assert.ok(r.stdout.length > 0, 'printed something');
    }
  });

  test(`${slug}: follows the site's writing rules`, () => {
    assert.ok(!src.includes('—'), 'no em dashes');
    assert.doesNotMatch(src, /\bsimply\b/i);
    assert.match(src, /^builds_on: \[.*\]$/m);
    assert.match(src, /<GoDeeper/);
    assert.match(src, /## What to remember/);
    assert.ok((src.match(/<Quiz\b/g) ?? []).length >= 3);
    assert.match(src, /<Callout kind="real">/, 'says where the sandbox differs from the real thing');
  });
}

test('sorting: the table of five sorts', () => {
  const lab = new KillerLab();
  const row = (sort: SortName, pivot: Pivot) => (['sorted', 'shuffled', 'organ'] as InputName[]).map((input) => (lab.run({ sort, pivot, input, n: 1000, seed: 11 }) as SortRun).comparisons);
  assert.deepEqual(row('selection', 'first'), [499_500, 499_500, 499_500]);
  assert.deepEqual(row('insertion', 'first'), [999, 247_364, 250_499]);
  assert.deepEqual(row('merge', 'first'), [4_932, 8_699, 5_487]);
  assert.deepEqual(row('quick', 'first'), [499_500, 12_320, 84_744]);
  assert.deepEqual(row('quick', 'random'), [10_614, 10_572, 11_244]);
  assert.deepEqual(row('python', 'first'), [999, 8_645, 1_998]);
});

test('sorting: the wall table', () => {
  assert.deepEqual([3, 10, 1000].map(comparisonFloor), [3, 22, 8530]);
  assert.deepEqual([3, 10, 1000].map((n) => Math.round(nLgN(n))), [5, 33, 9966]);
  const r = runPython('import math\nf = math.factorial(1000)\ns = str(f)\nprint(s[0], len(s) - 1, math.factorial(10))');
  assert.equal(r.stdout.trim(), '4 2567 3628800');
  // "about 1.3% over the floor"
  const over = (8645 - 8530) / 8530;
  assert.ok(over > 0.0125 && over < 0.0145, String(over));
});

test('sorting: the online-versus-replay table', () => {
  const lab = new KillerLab(), base = { sort: 'quick', pivot: 'random', n: 1000, seed: 11 } as const;
  assert.equal((lab.run({ ...base, input: 'adversary' }) as SortRun).comparisons, 498_502);
  assert.equal((lab.run({ ...base, input: 'replay' }) as SortRun).comparisons, 498_502);
  assert.deepEqual([12, 13, 14].map((seed) => (lab.run({ ...base, input: 'replay', seed }) as SortRun).comparisons), [10_345, 10_821, 11_136]);
  // "about 0.25 n²" against median of three.
  const med = lab.run({ sort: 'quick', pivot: 'median3', input: 'adversary', n: 1000, seed: 11 }) as SortRun;
  assert.ok(Math.abs(med.comparisons / 1e6 - 0.25) < 0.005, String(med.comparisons));
  // The quiz's "about 11,000". It said about 10,500, which is below most of these.
  lab.run({ ...base, input: 'adversary' });
  const replays = [12, 13, 14, 15, 16, 17, 18].map((seed) => (lab.run({ ...base, input: 'replay', seed }) as SortRun).comparisons);
  const mean = replays.reduce((a, b) => a + b) / replays.length;
  assert.ok(mean > 10_750 && mean < 11_250, String(mean));
});

test('sorting: "stays a little below n log n", the ratios behind the lesson\'s wording', () => {
  // ⌈log₂ n!⌉ against n log₂ n: the gap keeps growing, at about 1.44 n, so "very close" was wrong.
  assert.ok(comparisonFloor(1000) / nLgN(1000) < 0.86);
  const gap = (n: number) => nLgN(n) - comparisonFloor(n);
  assert.ok(gap(4000) > gap(1000), 'the gap keeps growing');
  assert.ok(gap(4000) / 4000 > 1.4 && gap(4000) / 4000 < 1.5, String(gap(4000)));
});

test('divide and conquer: the worked figures', () => {
  const n = 1_000_000;
  assert.equal(n * (n - 1) / 2, 499_999_500_000);
  assert.equal(Math.floor(nLgN(n)), 19_931_568);
  assert.ok(Math.abs((n * (n - 1) / 2) / 1e6 / 86400 - 5.8) < 0.05, 'about 5.8 days at a million a second');
  assert.ok(Math.abs(nLgN(n) / 1e6 - 20) < 0.1, 'about 20 seconds');
  assert.equal(Math.ceil(Math.log2(1e9)), 30, 'a billion items is 30 levels');
  const lab = new KillerLab();
  assert.equal((lab.run({ sort: 'quick', pivot: 'middle', input: 'organ', n: 1000, seed: 1 }) as SortRun).comparisons, 250_000, 'middle pivot on an organ pipe');
});

test('divide and conquer: recursion depth on a million items, for the depth table', () => {
  // Only sizes matter for depth, so this doesn't need a million real items.
  const depth = (next: (size: number) => number) => {
    let max = 0;
    const stack: [number, number][] = [[1_000_000, 1]];
    while (stack.length) {
      const [size, d] = stack.pop()!;
      if (d > max) max = d;
      if (size <= 1) continue;
      const left = next(size);
      stack.push([left, d + 1], [size - 1 - left, d + 1]);
    }
    return max;
  };
  assert.equal(depth((size) => (size - 1) >> 1), 20, 'an even split');
  const r = new Lcg(4);
  const random = depth((size) => r.next(size));
  assert.ok(random >= 24 && random <= 72, `random pivots: "a few dozen levels", got ${random}`);
});

test('hash tables: the equality-check table', () => {
  assert.deepEqual([42, 0, 7, 12345, 2 ** 40 + 3].map((h) => eqCount(1000, h)), [500_300, 499_500, 499_500, 500_719, 505_835]);
  const src = read('hash-tables');
  for (const figure of ['500,300', '500,719', '505,835']) assert.ok(src.includes(figure), figure);
});

test('hash tables: the worked hash and the sizes in the prose', () => {
  assert.equal(7362818 % 8, 2);
  assert.equal((5381 * 33 + 69) * 33 + 122, 5862308);
  assert.equal((5381 * 33 + 70) * 33 + 89, 5862308);
  assert.equal(new FloodLab().send({ traffic: 'ordinary', defence: 'none', cap: false, intsAsStr: false, pairs: 12 }).sent, 4096);
});

test('trees: the numbers in the prose, and the table of heights', () => {
  const sorted = shapeRun(1000, 'sorted', 4), shuffled = shapeRun(1000, 'shuffled', 4), nearly = shapeRun(1000, 'nearly', 4);
  assert.equal(sorted.bst.comparisons, 499_500);
  assert.equal(sorted.bst.height, 999);
  assert.equal(sorted.rb.height, 16);
  assert.equal(shuffled.bst.height, 19);
  assert.equal(shuffled.bst.comparisons, 10_672);
  assert.equal(nearly.bst.height, 971);
  assert.deepEqual([2, 16, 100, 256, 500].map((f) => logCeil(1e9, f)), [30, 8, 5, 4, 4]);
  const trip = replayOutage(false).events[0];
  assert.deepEqual([trip.ops, trip.height, trip.live], [247, 81, 83]);
  assert.equal(replayOutage(true).maxHeight, 16);
});

test('trees: the example heap in the lesson really is one', () => {
  const heap = [1, 3, 2, 7, 4, 9, 5];
  for (let k = 0; k < heap.length; k++) {
    if (2 * k + 1 < heap.length) assert.ok(heap[k] <= heap[2 * k + 1]);
    if (2 * k + 2 < heap.length) assert.ok(heap[k] <= heap[2 * k + 2]);
  }
  const r = runPython('import heapq\nh = [1, 3, 2, 7, 4, 9, 5]\nheapq.heapify(h)\nprint(h)');
  assert.equal(r.stdout.trim(), '[1, 3, 2, 7, 4, 9, 5]', 'heapify leaves a valid heap alone');
});
