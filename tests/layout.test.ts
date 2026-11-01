// The Layout Lab's model panel and growth panel claim to be checked, so they are:
// the cache against an independent reference in real Python, the growth rule
// against real sys.getsizeof. These fail rather than skip without Python. The "your
// machine" panel is timing on someone's hardware, and nothing here asserts it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CACHE_LINES, CACHE_WORDS, LAYOUT_MISSION, LINE_WORDS, MAX_SIZE, MIN_SIZE, NODE_WORDS, SIZE_STEP, addresses, chase, growthAfter, makeCycle, makeInOrder, nextCapacity, simulate, tippingSize, walkRun, type LayoutState, type Walk } from '../src/lib/cs/layout.ts';

function findPython(): string {
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return c;
  }
  throw new Error('No Python 3 found; these tests compare against the real interpreter and cannot pass without it');
}
const PY = findPython();
function python(src: string, input = ''): string {
  const r = spawnSync(PY, ['-I', '-c', src], { encoding: 'utf8', input, maxBuffer: 1 << 28 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test('the cache model matches a separate LRU written in Python, on every walk and size', () => {
  // A second implementation by a different route (OrderedDict, in another
  // language), so a shared misunderstanding would have to be made twice.
  const cases: { walk: Walk; n: number; addrs: number[]; hits: number; misses: number }[] = [];
  for (const walk of ['array', 'list-ordered', 'list-shuffled'] as Walk[]) {
    for (const n of [8, 16, 64, 72, 128, 256, 512, 1024]) {
      const addrs = addresses(walk, n), r = simulate(addrs);
      cases.push({ walk, n, addrs, hits: r.hits, misses: r.misses });
    }
  }
  const out = python(`
import json, sys
from collections import OrderedDict
for c in json.load(sys.stdin):
    cache = OrderedDict(); hits = misses = 0
    for a in c["addrs"]:
        line = a // ${LINE_WORDS}
        if line in cache:
            hits += 1; cache.move_to_end(line)
        else:
            misses += 1
            if len(cache) == ${CACHE_LINES}: cache.popitem(last=False)
            cache[line] = True
    print(hits, misses)
`, JSON.stringify(cases));
  const rows = out.trim().split(/\r?\n/);
  assert.equal(rows.length, cases.length);
  cases.forEach((c, i) => assert.equal(rows[i], `${c.hits} ${c.misses}`, `${c.walk} at ${c.n}`));
});

test('cold misses are exact arithmetic: one per cache line touched', () => {
  for (let n = MIN_SIZE; n <= MAX_SIZE; n += SIZE_STEP) {
    assert.equal(walkRun('array', n).misses, Math.ceil(n / LINE_WORDS), `array at ${n}`);
    assert.equal(walkRun('list-ordered', n).misses, Math.ceil((n * NODE_WORDS) / LINE_WORDS), `ordered list at ${n}`);
  }
});

test('every walk takes the same number of steps: only where they land differs', () => {
  for (const walk of ['array', 'list-ordered', 'list-shuffled'] as Walk[]) {
    const r = walkRun(walk, 512);
    assert.equal(r.hits + r.misses, 512);
    assert.equal(new Set(r.addrs).size, 512, `${walk} must read each element once`);
  }
});

test('the scattered walk costs far more once it outgrows the cache', () => {
  const a = walkRun('list-ordered', 1024), s = walkRun('list-shuffled', 1024);
  assert.equal(a.misses, 256);
  assert.ok(s.misses > 3 * a.misses, `scattered ${s.misses} against ${a.misses}`);
  assert.ok(s.ns > a.ns);
});

test('the tipping point is where the list stops fitting: 64 nodes, 128 words', () => {
  assert.equal(CACHE_WORDS, 128);
  assert.equal(tippingSize(), 64);
  assert.equal(walkRun('list-shuffled', 64).misses, walkRun('list-ordered', 64).misses);
  assert.ok(walkRun('list-shuffled', 72).misses > walkRun('list-ordered', 72).misses, 'one notch past it must cost more, or the mission has no answer');
  // Every larger size too, or the learner's "and one notch bigger" could mislead.
  for (let n = 72; n <= MAX_SIZE; n += SIZE_STEP) assert.ok(walkRun('list-shuffled', n).misses > walkRun('list-ordered', n).misses, `size ${n}`);
});

test('the scattered next-pointers are one cycle through every node', () => {
  // A plain shuffle can give small cycles, and a walk would then sit in a corner of
  // memory, timing the cache while claiming to measure a list.
  for (const n of [2, 3, 10, 1000, 65_536]) {
    const next = makeCycle(n, 1), seen = new Set<number>();
    let at = 0;
    for (let i = 0; i < n; i++) { assert.ok(!seen.has(at), `n=${n}: revisited ${at} after ${i} steps`); seen.add(at); at = next[at]; }
    assert.equal(at, 0, `n=${n}: must close the loop`);
    assert.equal(chase(next, 0, n), 0);
    assert.equal(chase(makeInOrder(n), 0, n), 0);
  }
  assert.notDeepEqual(makeCycle(1000, 1), makeInOrder(1000), 'shuffled must not be the identity walk');
  assert.deepEqual(makeCycle(1000, 1), makeCycle(1000, 1), 'the same seed must give the same walk on every machine');
});

test('list capacities equal real sys.getsizeof at every resize', () => {
  const out = python(`
import sys
base = sys.getsizeof([])
l = []
last = base
for i in range(1, 300001):
    l.append(None)
    s = sys.getsizeof(l)
    if s != last:
        print(i, (s - base) // 8)
        last = s
`);
  const real = out.trim().split(/\r?\n/).map((r) => r.split(' ').map(Number));
  const ours = growthAfter('cpython', 300_000).jumps;
  assert.deepEqual(ours, real);
  assert.ok(real.length > 50, 'a comparison of nothing would pass');
});

test("the sources report's measured growth pattern, and not the pre-3.9 one", () => {
  const caps = growthAfter('cpython', 76).jumps.map(([, c]) => c);
  assert.deepEqual(caps, [4, 8, 16, 24, 32, 40, 52, 64, 76]);
  assert.notDeepEqual(caps.slice(3, 6), [25, 35, 46], 'the 3.8 pattern that many tutorials still show');
  assert.deepEqual(growthAfter('cpython', 172).jumps.slice(0, 14), [[1, 4], [5, 8], [9, 16], [17, 24], [25, 32], [33, 40], [41, 52], [53, 64], [65, 76], [77, 92], [93, 108], [109, 128], [129, 148], [149, 172]]);
});

test('copies per append match the lesson and the report; Python does not double', () => {
  const row = (rule: Parameters<typeof growthAfter>[0], n: number) => { const g = growthAfter(rule, n); return [g.copiesPerAppend.toFixed(2), g.slackPct.toFixed(1)]; };
  assert.deepEqual(row('cpython', 2_000_000), ['8.56', '7.1']);
  assert.deepEqual(row('cpython', 10_000_000), ['8.91', '11.4']);
  assert.deepEqual(row('doubling', 2_000_000), ['1.05', '4.9']);
  assert.deepEqual(row('doubling', 10_000_000), ['1.68', '67.8']);
  assert.deepEqual(row('1.5x', 10_000_000), ['2.39', '19.6']);
  assert.equal(growthAfter('cpython', 2_000_000).resizes, 92);
  assert.notEqual(nextCapacity('cpython', 17, 16), 32, 'a list of 16 grows to 24, not 32');
  // The go-deeper bound: geometric growth at factor r stays under n*r/(r-1) copies.
  assert.ok(growthAfter('doubling', 10_000_000).copies < 2 * 10_000_000);
  assert.ok(growthAfter('cpython', 10_000_000).copies < 9 * 10_000_000);
});

// The lesson said "about eight times worse". That holds only near 2,000,000.
test('CPython against doubling, copies per append: about six times, between four and nine depending on n', () => {
  const ratio = (n: number) => growthAfter('cpython', n).copiesPerAppend / growthAfter('doubling', n).copiesPerAppend;
  assert.ok(ratio(2_000_000) > 8 && ratio(2_000_000) < 8.5, 'where the old "eight" came from');
  assert.ok(ratio(10_000_000) > 5 && ratio(10_000_000) < 5.5, "the lesson's own other column");
  const seen: number[] = [];
  for (let i = 0; i <= 2000; i++) seen.push(ratio(Math.round(10 ** (4 + (4 * i) / 2000))));
  seen.sort((a, b) => a - b);
  assert.ok(seen[0] > 3.9 && seen.at(-1)! < 9, `${seen[0]} to ${seen.at(-1)}`);
  assert.ok(seen[1000] > 5.5 && seen[1000] < 6.5, `median ${seen[1000]}`);
});

// The lesson's table has one slack column, at a size bad for doubling. The widget lets
// a learner falsify "doubling wastes more" at 2,000,000, so the lesson says so now.
test('slack depends on n: doubling can beat CPython, and long lists stay in the ranges the lesson gives', () => {
  assert.ok(growthAfter('doubling', 2_000_000).slackPct < growthAfter('cpython', 2_000_000).slackPct);
  assert.ok(growthAfter('doubling', 10_000_000).slackPct > growthAfter('cpython', 10_000_000).slackPct);
  let cpythonMax = 0, doublingMin = Infinity, doublingMax = 0;
  for (let i = 0; i <= 4000; i++) {
    const n = Math.round(10 ** (3 + (4 * i) / 4000));
    cpythonMax = Math.max(cpythonMax, growthAfter('cpython', n).slackPct);
    const d = growthAfter('doubling', n).slackPct;
    doublingMin = Math.min(doublingMin, d);
    doublingMax = Math.max(doublingMax, d);
  }
  assert.ok(cpythonMax <= 13, String(cpythonMax));
  assert.ok(doublingMin < 1 && doublingMax > 95, `${doublingMin} to ${doublingMax}`);
});

// "So no Python program can lay values out" was false, and so was "nothing a Python
// program can see says when it did". Addresses, not times: this asserts the layout
// and the moves, which are what the lesson claims. The timings are in the lesson as
// one laptop's numbers.
test("Python's array module does lay values side by side, which a list doesn't", () => {
  const out = python(`import array, ctypes
a = array.array('i', range(1000))
address, count = a.buffer_info()
assert count == 1000
print(all(ctypes.c_int.from_address(address + i * a.itemsize).value == i for i in range(1000)), a.itemsize)
`);
  assert.match(out.trim(), /^True [24]$/);
});

test('ctypes can see a list move: moved resizes are fewer than all of them, and real copies stay under the bound in the table', () => {
  const out = python(`import ctypes, sys
assert sys.maxsize == 2**63 - 1, "reads ob_item at a 64-bit offset"
l = []
last = sys.getsizeof(l)
resizes = moved = copies = 0
ptr = None
for i in range(2_000_000):
    l.append(i)
    s = sys.getsizeof(l)
    if s != last:
        p = ctypes.c_void_p.from_address(id(l) + 24).value
        resizes += 1
        if ptr is not None and p != ptr:
            moved += 1
            copies += i
        ptr = p
        last = s
print(resizes, moved, copies / 2_000_000)
`);
  const [resizes, moved, perAppend] = out.trim().split(' ').map(Number);
  assert.equal(resizes, 92);
  assert.ok(moved > 0 && moved < resizes, `moved ${moved} of ${resizes}`);
  assert.ok(perAppend > 0 && perAppend < growthAfter('cpython', 2_000_000).copiesPerAppend, String(perAppend));
});

test('an empty list is at nothing, not at a divide by zero', () => {
  assert.deepEqual(growthAfter('cpython', 0), { n: 0, capacity: 0, resizes: 0, copies: 0, copiesPerAppend: 0, slackPct: 0, jumps: [] });
});

const ran = (s: LayoutState, walk: Walk, n: number) => { const r = walkRun(walk, n); s.runs.push({ walk, n, hits: r.hits, misses: r.misses, ns: r.ns }); };

test('the mission is not born done, and completes by playing it', () => {
  const m = LAYOUT_MISSION, s = m.setup();
  assert.ok(m.steps.every((st) => !st.done(s)), 'no step may be done before anything ran');
  ran(s, 'array', 512); ran(s, 'list-ordered', 512);
  assert.deepEqual(m.steps.map((st) => st.done(s)), [true, false, false]);
  ran(s, 'list-shuffled', 512);
  assert.deepEqual(m.steps.map((st) => st.done(s)), [true, true, false]);
  for (const n of [64, 72]) { ran(s, 'list-shuffled', n); ran(s, 'list-ordered', n); }
  assert.ok(m.steps.every((st) => st.done(s)));
});

test('shortcuts do not pass the mission', () => {
  const m = LAYOUT_MISSION;
  // Comparing different sizes is not the same data.
  let s = m.setup();
  ran(s, 'array', 512); ran(s, 'list-ordered', 256);
  assert.equal(m.steps[0].done(s), false);
  // While the list fits in the cache, scattering costs nothing, so there is nothing to see.
  s = m.setup();
  ran(s, 'list-shuffled', 32); ran(s, 'list-ordered', 32);
  assert.equal(m.steps[1].done(s), false, 'a size where scattered equals in-order shows nothing');
  // Below the tipping point everything matches: a match alone is not the largest.
  s = m.setup();
  for (const n of [8, 16, 32, 56, 64]) { ran(s, 'list-shuffled', n); ran(s, 'list-ordered', n); }
  assert.equal(m.steps[2].done(s), false, 'having only seen matches, nothing shows this is the largest');
  // And seeing the crossing from one side only does not find it.
  s = m.setup();
  for (const n of [72, 80, 512]) { ran(s, 'list-shuffled', n); ran(s, 'list-ordered', n); }
  assert.equal(m.steps[2].done(s), false);
});

test('the widget says it is not Python, and labels the machine panel as unchecked', () => {
  const src = readFileSync('src/components/LayoutLab.astro', 'utf8');
  assert.match(src, /not Python: a Python list holds pointers/);
  assert.match(src, /shown, never checked/);
});
