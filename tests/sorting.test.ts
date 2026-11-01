// The Killer Lab's counts, run through real Python as well. No timings. McIlroy's
// finding is only taught correctly if both halves hold: the adversary beats random
// pivots while it answers the comparisons, and loses when its input is replayed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adversary, comparisonFloor, equalInput, KillerLab, KILLER_MISSION, Lcg, mergeSort, nLgN, organPipe, pythonSort, quickSort, selectionSort, insertionSort, shuffledInput, sortedInput, zeroOneInput, type Cmp, type Config, type Pivot, type SortRun } from '../src/lib/cs/sorting.ts';
import { python, runPython } from './helpers/python.ts';

python();

const counted = () => { let c = 0; return { cmp: (x: number, y: number) => { c++; return x - y; }, get: () => c }; };

const count = (input: number[], sort: (a: number[], cmp: (x: number, y: number) => number) => void) => {
  const a = [...input], c = counted();
  sort(a, c.cmp);
  for (let i = 1; i < a.length; i++) assert.ok(a[i - 1] <= a[i], 'came out unsorted');
  return c.get();
};

test('selection sort always costs n(n-1)/2; insertion sort costs n-1 on sorted input', () => {
  for (const n of [10, 100, 1000]) {
    assert.equal(count(sortedInput(n), selectionSort), n * (n - 1) / 2);
    assert.equal(count(shuffledInput(n, 3), selectionSort), n * (n - 1) / 2);
    assert.equal(count(sortedInput(n), insertionSort), n - 1);
    assert.equal(count([...sortedInput(n)].reverse(), insertionSort), n * (n - 1) / 2);
  }
});

test('merge sort never exceeds n lg n on any input, and costs half that on sorted input at a power of two', () => {
  for (const n of [16, 1000, 4096]) {
    for (const input of [sortedInput(n), [...sortedInput(n)].reverse(), shuffledInput(n, 7), organPipe(n)]) {
      assert.ok(count(input, mergeSort) <= nLgN(n), `n=${n}`);
    }
  }
  assert.equal(count(sortedInput(4096), mergeSort), 4096 * 12 / 2);
  // Sedgewick's "between 1/2 N lg N and N lg N" is exact at powers of two only:
  // n=1000 sorted costs 4,932, just under 4,983. So the lesson states the upper bound.
  assert.equal(count(sortedInput(1000), mergeSort), 4932);
});

test('first-item pivot on sorted input: exactly n(n-1)/2, with no attacker at all', () => {
  assert.equal(count(sortedInput(2000), (a, c) => quickSort(a, c, 'first')), 1_999_000);
});

// The same programs, in Python, sharing the seeded generator so nothing depends on
// Mersenne Twister. Comparison counts must match to the last one.
const PY_SORTS = `
def lcg_next(st, n):
    st[0] = (st[0] * 1103515245 + 12345) % 2147483648
    return (st[0] >> 8) % n

def antiqsort(n):
    val = [n - 1] * n
    gas = n - 1
    s = {"nsolid": 0, "candidate": 0, "ncmp": 0}
    def cmp(x, y):
        s["ncmp"] += 1
        if val[x] == gas and val[y] == gas:
            if x == s["candidate"]:
                val[x] = s["nsolid"]
            else:
                val[y] = s["nsolid"]
            s["nsolid"] += 1
        if val[x] == gas:
            s["candidate"] = x
        elif val[y] == gas:
            s["candidate"] = y
        return val[x] - val[y]
    return val, s, cmp

def qs(a, cmp, rule, seed=0):
    st = [seed]
    stack = [(0, len(a) - 1)]
    while stack:
        lo, hi = stack.pop()
        if lo >= hi:
            continue
        if rule == "first":
            p = lo
        elif rule == "middle":
            p = (lo + hi) // 2
        elif rule == "random":
            p = lo + lcg_next(st, hi - lo + 1)
        else:
            x, y, z = lo, (lo + hi) // 2, hi
            if cmp(a[x], a[y]) > 0:
                x, y = y, x
            if cmp(a[y], a[z]) > 0:
                y = z
                if cmp(a[x], a[y]) > 0:
                    y = x
            p = y
        pv = a[p]
        a[p], a[hi] = a[hi], a[p]
        i = lo
        for j in range(lo, hi):
            if cmp(a[j], pv) < 0:
                a[i], a[j] = a[j], a[i]
                i += 1
        a[i], a[hi] = a[hi], a[i]
        stack.append((lo, i - 1))
        stack.append((i + 1, hi))
`;

test('the adversary against every pivot rule: counts match real Python exactly', () => {
  const rules: Pivot[] = ['first', 'middle', 'random', 'median3'];
  const sizes = [500, 1000, 2000];
  const src = `${PY_SORTS}
for rule in ${JSON.stringify(rules)}:
    row = []
    for n in ${JSON.stringify(sizes)}:
        val, s, cmp = antiqsort(n)
        qs(list(range(n)), cmp, rule, 11)
        row.append(s["ncmp"])
    print(rule, row)
`;
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  rules.forEach((rule, i) => {
    const ours = sizes.map((n) => {
      const adv = adversary(n), c = { n: 0 };
      quickSort(sortedInput(n), (x, y) => { c.n++; return adv.cmp(x, y); }, rule, new Lcg(11));
      return c.n;
    });
    assert.equal(lines[i], `${rule} [${ours.join(', ')}]`);
  });
});

test("anchors from the sources report's table, which used the same partition", () => {
  const lab = new KillerLab();
  const run = (n: number, pivot: Pivot) => lab.run({ sort: 'quick', pivot, input: 'adversary', n, seed: 11 }) as SortRun;
  assert.deepEqual([500, 1000, 2000].map((n) => run(n, 'first').comparisons), [124_750, 499_500, 1_999_000]);
  assert.deepEqual([500, 1000, 2000].map((n) => run(n, 'middle').comparisons), [124_252, 498_502, 1_997_002]);
  assert.deepEqual([500, 1000, 2000].map((n) => run(n, 'random').comparisons), [124_252, 498_502, 1_997_002]);
  assert.deepEqual([500, 1000, 2000].map((n) => run(n, 'median3').comparisons), [63_000, 251_000, 1_002_000]);
});

test("McIlroy's own check: doubling n more than 3.99x's the work, for every pivot rule", () => {
  for (const rule of ['first', 'middle', 'random', 'median3'] as Pivot[]) {
    const lab = new KillerLab();
    const a = lab.run({ sort: 'quick', pivot: rule, input: 'adversary', n: 1000, seed: 5 }) as SortRun;
    const b = lab.run({ sort: 'quick', pivot: rule, input: 'adversary', n: 2000, seed: 5 }) as SortRun;
    assert.ok(b.comparisons > 3.99 * a.comparisons, rule);
    assert.ok(a.ordered && b.ordered, 'the adversary and the sort must agree');
  }
});

test('online versus replayed: the attack needs the comparisons or the seed', () => {
  const n = 2000, lab = new KillerLab();
  const base: Config = { sort: 'quick', pivot: 'random', input: 'adversary', n, seed: 11 };
  const online = lab.run(base) as SortRun;
  assert.ok(online.comparisons > 0.49 * n * n, String(online.comparisons));

  const same = lab.run({ ...base, input: 'replay' }) as SortRun;
  assert.equal(same.comparisons, online.comparisons, 'the same seed sees the same pivots, so the attack reproduces');

  for (const seed of [12, 13, 14, 15, 99]) {
    const fresh = lab.run({ ...base, input: 'replay', seed }) as SortRun;
    assert.ok(fresh.comparisons < 2 * nLgN(n), `seed ${seed}: ${fresh.comparisons}`);
    assert.ok(fresh.ordered);
  }
});

test('replay in real Python: same seed, same count; new seeds fall to near n lg n', () => {
  const src = `${PY_SORTS}
n = 2000
val, s, cmp = antiqsort(n)
qs(list(range(n)), cmp, "random", 11)
print(s["ncmp"])
built = list(val)
for seed in [11, 12, 13]:
    c = [0]
    def plain(x, y):
        c[0] += 1
        return x - y
    a = list(built)
    qs(a, plain, "random", seed)
    assert a == sorted(built)
    print(c[0])
`;
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  const [online, same, s12, s13] = r.stdout.trim().split('\n').map(Number);
  assert.equal(online, 1_997_002);
  assert.equal(same, online);
  const lab = new KillerLab(), base: Config = { sort: 'quick', pivot: 'random', input: 'adversary', n: 2000, seed: 11 };
  lab.run(base);
  assert.equal((lab.run({ ...base, input: 'replay', seed: 12 }) as SortRun).comparisons, s12);
  assert.equal((lab.run({ ...base, input: 'replay', seed: 13 }) as SortRun).comparisons, s13);
  assert.ok(s12 < 30_000 && s13 < 30_000);
});

// The debrief used to say "no fixed file can hurt them". An accuracy review ran a
// file of one repeated number and got 499,500, the same as first-item pivots on
// sorted input. Bentley and McIlroy report this failure in a 1983 qsort.
test('"no fixed file can hurt random pivots" was false: 1,000 equal numbers cost 499,500 at every seed, in the lab and in real Python', () => {
  const seeds = [1, 2, 3, 11, 12, 999];
  const lab = new KillerLab();
  const ours = seeds.map((seed) => {
    const r = lab.run({ sort: 'quick', pivot: 'random', input: 'equal', n: 1000, seed }) as SortRun;
    assert.ok(r.ordered);
    return r.comparisons;
  });
  assert.deepEqual(ours, seeds.map(() => 499_500));
  const real = runPython(`${PY_SORTS}
for seed in ${JSON.stringify(seeds)}:
    c = [0]
    def plain(x, y):
        c[0] += 1
        return x - y
    qs([7] * 1000, plain, "random", seed)
    print(c[0])
`);
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(real.stdout.trim().split('\n').map(Number), ours);
  // Every pivot rule, because no choice of pivot helps when every pivot is the same.
  for (const pivot of ['first', 'middle', 'random'] as Pivot[]) {
    assert.equal((lab.run({ sort: 'quick', pivot, input: 'equal', n: 1000, seed: 4 }) as SortRun).comparisons, 499_500, pivot);
  }
});

test('random zeros and ones cost about n²/4 with random pivots, in the lab and in real Python, and sorted does not care', () => {
  const seeds = [1, 2, 3, 11];
  const lab = new KillerLab();
  const ours = seeds.map((seed) => (lab.run({ sort: 'quick', pivot: 'random', input: 'zeroOne', n: 1000, seed }) as SortRun).comparisons);
  for (const c of ours) assert.ok(c >= 245_000 && c <= 255_000, String(c));
  const real = runPython(`${PY_SORTS}
for seed in ${JSON.stringify(seeds)}:
    st = [seed + 1000]
    a = [lcg_next(st, 2) for _ in range(1000)]
    c = [0]
    def plain(x, y):
        c[0] += 1
        return x - y
    b = list(a)
    qs(b, plain, "random", seed)
    assert b == sorted(a)
    print(c[0])
`);
  assert.equal(real.status, 0, real.stderr);
  assert.deepEqual(real.stdout.trim().split('\n').map(Number), ours);
  assert.equal(count(equalInput(1000), pythonSort), 999);
  assert.ok(count(zeroOneInput(1000, 5), pythonSort) < 12_000);
  assert.ok(count(equalInput(1000), mergeSort) <= nLgN(1000));
});

test("three-way partitioning is immune: the divide-and-conquer lesson's quicksort, on 1,000 equal numbers, makes one pass of three comparisons per item", () => {
  const r = runPython(`class C:
    n = 0
    def __init__(self, v): self.v = v
    def __lt__(self, o):
        C.n += 1
        return self.v < o.v
    def __gt__(self, o):
        C.n += 1
        return self.v > o.v
    def __eq__(self, o):
        C.n += 1
        return self.v == o.v
def quick_sort(items):
    if len(items) <= 1:
        return items
    pivot = items[len(items) // 2]
    smaller = [x for x in items if x < pivot]
    same = [x for x in items if x == pivot]
    larger = [x for x in items if x > pivot]
    return quick_sort(smaller) + same + quick_sort(larger)
quick_sort([C(7) for _ in range(1000)])
print(C.n)
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '3000');
});

// The lesson used to leave McIlroy's "cannot defend against all inputs" standing as a
// current statement. A depth limit with a heapsort fallback is what libraries do about
// it. This is a sketch of that idea on the lab's own partition, not any library's code.
function introSketch(a: number[], cmp: Cmp) {
  const limit = 2 * Math.ceil(Math.log2(a.length));
  const heapsort = (lo: number, hi: number) => {
    const n = hi - lo + 1;
    const down = (start: number, m: number) => {
      let i = start;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= m) return;
        if (c + 1 < m && cmp(a[lo + c], a[lo + c + 1]) < 0) c++;
        if (cmp(a[lo + i], a[lo + c]) >= 0) return;
        [a[lo + i], a[lo + c]] = [a[lo + c], a[lo + i]];
        i = c;
      }
    };
    for (let i = (n >> 1) - 1; i >= 0; i--) down(i, n);
    for (let m = n - 1; m > 0; m--) { [a[lo], a[lo + m]] = [a[lo + m], a[lo]]; down(0, m); }
  };
  const stack: [number, number, number][] = [[0, a.length - 1, 0]];
  while (stack.length) {
    const [lo, hi, depth] = stack.pop()!;
    if (lo >= hi) continue;
    if (depth >= limit) { heapsort(lo, hi); continue; }
    let x = lo, y = (lo + hi) >> 1;
    if (cmp(a[x], a[y]) > 0) [x, y] = [y, x];
    if (cmp(a[y], a[hi]) > 0) { y = hi; if (cmp(a[x], a[y]) > 0) y = x; }
    const pv = a[y];
    [a[y], a[hi]] = [a[hi], a[y]];
    let i = lo;
    for (let j = lo; j < hi; j++) if (cmp(a[j], pv) < 0) { [a[i], a[j]] = [a[j], a[i]]; i++; }
    [a[i], a[hi]] = [a[hi], a[i]];
    stack.push([lo, i - 1, depth + 1], [i + 1, hi, depth + 1]);
  }
}

test("McIlroy's adversary against a depth limit and a heapsort fallback: doubling costs about 2.2x, not 4x", () => {
  const cost = (n: number) => {
    const adv = adversary(n), a = sortedInput(n);
    let c = 0;
    introSketch(a, (x, y) => { c++; return adv.cmp(x, y); });
    assert.ok(a.every((v, i) => i === 0 || adv.val[a[i - 1]] <= adv.val[v]), 'came out in order');
    return c;
  };
  assert.deepEqual([1000, 2000, 4000].map(cost), [34_844, 78_705, 174_524]);
  assert.ok(174_524 / 78_705 < 2.3);
  // The same adversary on plain median-of-three, for the comparison the lesson makes.
  const lab = new KillerLab();
  assert.equal((lab.run({ sort: 'quick', pivot: 'median3', input: 'adversary', n: 1000, seed: 1 }) as SortRun).comparisons, 251_000);
});

test("Python's sorted, in the lab and in real Python, makes n-1 comparisons against the adversary", () => {
  const sizes = [1000, 2000, 4000];
  const r = runPython(`from functools import cmp_to_key
${PY_SORTS}
print([(lambda v: (sorted(range(n), key=cmp_to_key(v[2])), v[1]["ncmp"])[1])(antiqsort(n)) for n in ${JSON.stringify(sizes)}])
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '[999, 1999, 3999]');
  const lab = new KillerLab();
  for (const n of sizes) assert.equal((lab.run({ sort: 'python', pivot: 'first', input: 'adversary', n, seed: 1 }) as SortRun).comparisons, n - 1);
});

test("sorted's counts in the lab match real Python on sorted, reversed, organ pipe and shuffled input", () => {
  const n = 2000;
  const inputs: [string, number[]][] = [['list(range(n))', sortedInput(n)], ['list(range(n, 0, -1))', [...sortedInput(n)].reverse().map((x) => x + 1)], ['[i if i < n / 2 else n - 1 - i for i in range(n)]', organPipe(n)]];
  const body = inputs.map(([e]) => `print(cost(${e}))`).join('\n');
  const r = runPython(`from functools import cmp_to_key
n = ${n}
def cost(xs):
    c = [0]
    def cmp(x, y):
        c[0] += 1
        return x - y
    sorted(xs, key=cmp_to_key(cmp))
    return c[0]
${body}
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n').map(Number), inputs.map(([, a]) => count(a, pythonSort)));
});

test('real sorted on 100,000 organ-pipe items takes under 200,000 comparisons, and random stays near the floor', () => {
  const r = runPython(`class C:
    n = 0
    __slots__ = ("v",)
    def __init__(self, v): self.v = v
    def __lt__(self, o):
        C.n += 1
        return self.v < o.v
n = 100000
sorted([C(i if i < n // 2 else n - 1 - i) for i in range(n)])
print(C.n)
`);
  assert.equal(r.stdout.trim(), '199998');
  assert.equal(count(organPipe(100_000), pythonSort), 199_998);
  // Random sits about 1% above the floor. A range, since the exact count isn't stable across versions.
  const c = count(shuffledInput(10_000, 3), pythonSort);
  const floor = comparisonFloor(10_000);
  assert.ok(c >= floor && c < floor * 1.03, `${c} vs floor ${floor}`);
});

test('the decision-tree floor, exactly: ⌈log₂ n!⌉ by integers, compared with real math.factorial', () => {
  const table: Record<number, number> = { 2: 1, 3: 3, 4: 5, 5: 7, 6: 10, 7: 13, 8: 16, 9: 19, 10: 22, 11: 26, 12: 29, 13: 33, 16: 45, 20: 62, 52: 226 };
  for (const [n, b] of Object.entries(table)) assert.equal(comparisonFloor(Number(n)), b, `n=${n}`);
  const ns = [1000, 10000, 100000];
  const r = runPython(`import math\nprint([(math.factorial(n) - 1).bit_length() for n in ${JSON.stringify(ns.slice(0, 2))}])`);
  assert.deepEqual(JSON.parse(r.stdout), ns.slice(0, 2).map(comparisonFloor));
  assert.equal(comparisonFloor(1000), 8530);
  assert.equal(comparisonFloor(1), 0);
});

test('stability in the Python docs: selection is unstable, as MIT 6.006 shows with (2, 1, 1\')', () => {
  // Selection sort swaps the 2 past the first 1, flipping the two equal keys.
  const items = [{ k: 2, tag: 'a' }, { k: 1, tag: 'b' }, { k: 1, tag: 'c' }];
  const a = items.map((_, i) => i);
  selectionSort(a, (x, y) => items[x].k - items[y].k);
  assert.deepEqual(a.map((i) => items[i].tag), ['b', 'c', 'a'], 'this order of arguments keeps b before c');
  const unstable = [{ k: 2, tag: 'first 2' }, { k: 2, tag: 'second 2' }, { k: 1, tag: '1' }];
  const b = unstable.map((_, i) => i);
  selectionSort(b, (x, y) => unstable[x].k - unstable[y].k);
  assert.deepEqual(b.map((i) => unstable[i].tag), ['1', 'second 2', 'first 2'], 'the swap carries the first 2 past the second');
  const c = unstable.map((_, i) => i);
  insertionSort(c, (x, y) => unstable[x].k - unstable[y].k);
  assert.deepEqual(c.map((i) => unstable[i].tag), ['1', 'first 2', 'second 2'], 'insertion sort keeps them in order');
  const d = unstable.map((_, i) => i);
  mergeSort(d, (x, y) => unstable[x].k - unstable[y].k);
  assert.deepEqual(d.map((i) => unstable[i].tag), ['1', 'first 2', 'second 2'], 'and so does this merge');
});

test('replaying nothing is refused, rather than reading as a very cheap sort', () => {
  const lab = new KillerLab();
  const r = lab.run({ sort: 'quick', pivot: 'random', input: 'replay', n: 1000, seed: 1 });
  assert.ok('refused' in r);
  assert.equal(lab.runs.length, 0);
  lab.run({ sort: 'quick', pivot: 'random', input: 'adversary', n: 1000, seed: 1 });
  const wrong = lab.run({ sort: 'quick', pivot: 'random', input: 'replay', n: 500, seed: 1 });
  assert.ok('refused' in wrong, 'a saved input of another size is not this size');
});

test('the killer mission completes from its hints, and shortcuts leave steps open', () => {
  const s = KILLER_MISSION.setup(), steps = KILLER_MISSION.steps;
  assert.ok(!steps.some((st) => st.done(s)));
  const go = (c: Partial<Config>) => s.lab.run({ sort: 'quick', pivot: 'first', input: 'sorted', n: 1000, seed: 11, ...c });

  go({ n: 100 });
  assert.equal(steps[0].done(s), false, 'n=100 is too small to count');
  go({ pivot: 'middle' });
  assert.equal(steps[0].done(s), false, 'a middle pivot is fine on sorted input');
  go({}); assert.ok(steps[0].done(s));

  go({ pivot: 'random' }); assert.ok(steps[1].done(s));

  go({ pivot: 'first', input: 'adversary' });
  assert.equal(steps[2].done(s), false, 'beating first-pivot is not beating random');
  // A replay of an input built against a different rule is not the lesson's claim.
  go({ pivot: 'random', input: 'replay', seed: 77 });
  assert.equal(steps[3].done(s), false, 'the saved input was built against first-pivot');

  go({ pivot: 'random', input: 'adversary' }); assert.ok(steps[2].done(s));
  go({ pivot: 'random', input: 'replay' });
  assert.equal(steps[3].done(s), false, 'the same seed is not a fresh seed');
  assert.ok(steps[4].done(s), 'and it is the attacker who knows the seed');
  go({ pivot: 'random', input: 'replay', seed: 12 }); assert.ok(steps[3].done(s));

  go({ pivot: 'random', input: 'equal', n: 100 });
  assert.equal(steps[5].done(s), false, 'n=100 is too small to count');
  go({ sort: 'python', input: 'equal' });
  assert.equal(steps[5].done(s), false, 'sorted is not the sort that fails here');
  go({ pivot: 'random', input: 'equal' }); assert.ok(steps[5].done(s));

  go({ sort: 'python', input: 'sorted' });
  assert.equal(steps[6].done(s), false, 'sorted on sorted input is not the adversary');
  go({ sort: 'python', input: 'adversary' }); assert.ok(steps[6].done(s));
  assert.ok(steps.every((st) => st.done(s)));
});

// The lesson used to close its NaN section with "a < b and b < c guarantee a < c",
// which NaN doesn't break. What it breaks is "neither is smaller" carrying across.
test('NaN keeps < transitive and breaks "neither is smaller": 3.3 ties NaN, NaN ties 1.1, and 1.1 < 3.3', () => {
  const r = runPython(`nan = float("nan")
print(3.3 < nan, nan < 3.3, nan < 1.1, 1.1 < nan, 1.1 < 3.3)
`);
  assert.equal(r.stdout.trim(), 'False False False False True');
});

test('selection sort asks the same number of questions, and which ones depends on the data', () => {
  const pairs = (input: number[]) => {
    const seen: string[] = [], a = input.map((_, i) => i);
    selectionSort(a, (x, y) => { seen.push(`${x},${y}`); return input[x] - input[y]; });
    return seen;
  };
  const up = pairs([1, 2, 3]), mixed = pairs([3, 1, 2]);
  assert.equal(up.length, mixed.length);
  assert.notDeepEqual(up, mixed);
  assert.equal(up[1], '2,0');
  assert.equal(mixed[1], '2,1');
});

test('the Python the sorting lesson shows behaves as the lesson says', () => {
  const r = runPython(`nan = float("nan")
print(sorted([3.3, nan, 1.1, 2.2]))
print(sorted([nan, 3.3, 1.1, 2.2]))
print(sorted([3.3, 1.1, nan, 2.2]))
try:
    sorted([1, "a"])
except TypeError as e:
    print("TypeError")
pairs = [("b", 2), ("a", 2), ("c", 1), ("a", 1)]
print(sorted(pairs, key=lambda p: p[1]))
print(sorted(pairs, key=lambda p: p[1], reverse=True))
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `[3.3, nan, 1.1, 2.2]
[nan, 1.1, 2.2, 3.3]
[1.1, 2.2, 3.3, nan]
TypeError
[('c', 1), ('a', 1), ('b', 2), ('a', 2)]
[('b', 2), ('a', 2), ('c', 1), ('a', 1)]
`);
});

// The master theorem's three examples, by the recurrence itself.
test('recurrences behave as the master theorem says: 2T(n/2)+1 ~ n, 2T(n/2)+n ~ n lg n, 2T(n/2)+n² ~ n², T(n/2)+1 ~ lg n', () => {
  const T = (n: number, a: number, f: (n: number) => number): number => (n <= 1 ? 1 : a * T(n / 2, a, f) + f(n));
  const big = 2 ** 20;
  const case1 = T(big, 2, () => 1), case2 = T(big, 2, (n) => n), case3 = T(big, 2, (n) => n * n), bin = T(big, 1, () => 1);
  assert.equal(case1, 2 * big - 1);
  assert.equal(case2, big * 20 + big);
  assert.ok(case3 / (big * big) > 1.99 && case3 / (big * big) < 2.01);
  assert.equal(bin, 21);
});
