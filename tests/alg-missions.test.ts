// Each code-lab mission played from its starter to its fix, then attacked with the
// tempting shortcuts. A mission that can't finish looks like the learner's fault,
// and one a shortcut can finish teaches nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODE_MISSIONS, type CodeState } from '../src/lib/cs/missions.ts';
import { cleanSortWorks, hashSpreads, reachesLibrarySort, tableWorks, queueIsLogarithmic, queueOrders } from '../src/lib/cs/alg-missions.ts';
import { runAll, measureGrowth, classify } from '../src/lib/py/lab.ts';
import { shuffledInput } from '../src/lib/cs/sorting.ts';
import { python, runPython } from './helpers/python.ts';

python();

type Lab = { fn: string; sizes: number[]; arg: 'list' | 'n' };

function act(s: CodeState, src: string, lab?: Lab) {
  const r = runAll(src);
  s.runs.push(r);
  if (lab) {
    const args = (n: number) => (lab.arg === 'n' ? [n] : [Array.from({ length: n }, (_, i) => i)]);
    const points = measureGrowth(src, lab.fn, lab.sizes, args);
    s.growth.push({ src, fn: lab.fn, points, shape: classify(points) });
  }
  return s;
}

const stepsDone = (id: string, s: CodeState) => CODE_MISSIONS[id].steps.map((st) => st.done(s));

// Every program the lesson shows or a mission accepts has to behave the same in real Python.
function sameInReal(src: string) {
  const r = runPython(src);
  assert.equal(r.status, 0, `real Python failed:\n${r.stderr}`);
  const ours = runAll(src);
  assert.equal(ours.status, 'done', `lab: ${ours.status} ${ours.error?.message}`);
  assert.equal(ours.stdout, r.stdout, `differs for:\n${src}`);
}

const MERGE = { fn: 'merge_sort', sizes: [200, 400, 800, 1600], arg: 'list' } as Lab;
const FIXED_MERGE = `def merge(left, right):
    out = []
    i = 0
    j = 0
    while i < len(left) and j < len(right):
        if right[j] < left[i]:
            out.append(right[j])
            j += 1
        else:
            out.append(left[i])
            i += 1
    return out + left[i:] + right[j:]

def merge_sort(items):
    if len(items) <= 1:
        return items
    mid = len(items) // 2
    return merge(merge_sort(items[:mid]), merge_sort(items[mid:]))

print(merge_sort([5, 2, 9, 1, 5, 6]))
`;

test('merge sort mission: pop(0) makes it quadratic, indices make it n log n', () => {
  const m = CODE_MISSIONS['cs-dc-merge-sort'], s = m.setup();
  assert.ok(!m.steps.some((st) => st.done(s)));
  act(s, m.starter!, MERGE);
  assert.deepEqual(stepsDone(m.id, s), [true, true, false], `starter shape: ${s.growth[0].shape}`);
  act(s, FIXED_MERGE, MERGE);
  assert.equal(s.growth.at(-1)!.shape, 'n log n', JSON.stringify(s.growth.at(-1)!.points));
  assert.ok(m.steps.every((st) => st.done(s)));
});

test('merge sort mission: calling sorted, returning the input or breaking the answer does not pass', () => {
  for (const cheat of [
    'def merge_sort(items):\n    return sorted(items)\n',
    'def merge_sort(items):\n    return items\n',
    // Right shape, wrong answers: drops duplicates.
    FIXED_MERGE.replace('return out + left[i:] + right[j:]', 'return sorted(set(out + left[i:] + right[j:]))'),
  ]) {
    const s = CODE_MISSIONS['cs-dc-merge-sort'].setup();
    act(s, cheat, MERGE);
    assert.equal(CODE_MISSIONS['cs-dc-merge-sort'].steps[2].done(s), false, cheat);
  }
});

// An accuracy review finished this mission with `return sorted(left + right)`: it
// measures n log n and every answer is right, so the shape and the cases both pass.
test('merge sort mission: sorted inside merge measured n log n and passed. It no longer does, in any spelling', () => {
  const m = CODE_MISSIONS['cs-dc-merge-sort'];
  const merged = (body: string) => m.starter!.replace(/def merge\(left, right\):[\s\S]*?return out \+ left \+ right/, `def merge(left, right):\n${body}`);
  const first = m.setup();
  act(first, merged('    return sorted(left + right)'), MERGE);
  assert.equal(first.growth.at(-1)!.shape, 'n log n', 'the route the shape check can not see');
  for (const cheat of [
    merged('    return sorted(left + right)'),
    merged('    out = left + right\n    out.sort()\n    return out'),
    merged('    s = sorted\n    return s(left + right)'),
    // Only on big lists, so a check that used small inputs would miss it.
    merged('    if len(left) > 100:\n        return sorted(left + right)\n    out = []\n    i = 0\n    j = 0\n    while i < len(left) and j < len(right):\n        if right[j] < left[i]:\n            out.append(right[j])\n            j += 1\n        else:\n            out.append(left[i])\n            i += 1\n    return out + left[i:] + right[j:]'),
  ]) {
    const s = m.setup();
    act(s, cheat, MERGE);
    assert.ok(reachesLibrarySort(cheat, 'merge_sort'), cheat);
    assert.equal(m.steps[2].done(s), false, cheat);
  }
  assert.equal(reachesLibrarySort(FIXED_MERGE, 'merge_sort'), false, 'the real fix must not be flagged');
});

// The lesson used to imply the label held in general. It holds for lists in order,
// which is all Measure growth feeds, and the lesson now says so.
test('a sort-based duplicate check reads as linear only because the lab measures lists already in order', () => {
  const src = 'def has_duplicate(items):\n    s = sorted(items)\n    for i in range(1, len(s)):\n        if s[i] == s[i - 1]:\n            return True\n    return False\n';
  const sizes = [200, 400, 800, 1600];
  assert.equal(classify(measureGrowth(src, 'has_duplicate', sizes, (n) => [Array.from({ length: n }, (_, i) => i)])), 'linear');
  assert.equal(classify(measureGrowth(src, 'has_duplicate', sizes, (n) => [shuffledInput(n, 3)])), 'n log n');
});

// The counting-steps lesson used to say twice the input and four times the work "means
// quadratic". This program is quadratic and never reaches 4x at these sizes.
test('a quadratic program can stay below 4x for several doublings, so one pair of sizes can mislead', () => {
  const pts = measureGrowth(CODE_MISSIONS['cs-dc-merge-sort'].starter!, 'merge_sort', [200, 400, 800, 1600], (n) => [Array.from({ length: n }, (_, i) => i)]);
  const ratios = pts.slice(1).map((p, i) => p.ops! / pts[i].ops!);
  assert.ok(ratios.every((r) => r < 4), JSON.stringify(ratios));
  assert.ok(ratios[2] > ratios[0], 'and the ratio climbs towards 4');
  assert.equal(classify(pts), 'quadratic');
});

test('a measurement of older code does not count: running something else after measuring reopens the step', () => {
  const m = CODE_MISSIONS['cs-dc-merge-sort'], s = m.setup();
  act(s, FIXED_MERGE, MERGE);
  assert.ok(m.steps[2].done(s));
  act(s, m.starter!);
  assert.equal(m.steps[2].done(s), false);
});

const QUICK = { fn: 'quick_sort', sizes: [100, 200, 400, 800, 1600], arg: 'list' } as Lab;

test('quicksort mission: first pivot is quadratic on sorted input, the middle pivot is n log n', () => {
  const m = CODE_MISSIONS['cs-dc-quicksort'], s = m.setup();
  act(s, m.starter!, QUICK);
  assert.deepEqual(stepsDone(m.id, s), [true, true, false], JSON.stringify(s.growth[0]));
  const fixed = m.starter!.replace('pivot = items[0]', 'pivot = items[len(items) // 2]');
  act(s, fixed, QUICK);
  assert.equal(s.growth.at(-1)!.shape, 'n log n', JSON.stringify(s.growth.at(-1)!.points));
  assert.ok(m.steps.every((st) => st.done(s)));
  sameInReal(fixed);
  const cheat = m.setup();
  act(cheat, 'def quick_sort(items):\n    return sorted(items)\n', QUICK);
  assert.equal(m.steps[2].done(cheat), false, 'sorted on sorted input measures as linear, and is not the point');
});

test('real Python hits the recursion limit on the first-pivot version with sorted input, as the lesson says', () => {
  const src = `${CODE_MISSIONS['cs-dc-quicksort'].starter}
try:
    quick_sort(list(range(900)))
    print("900 fine")
except RecursionError:
    print("900 RecursionError")
try:
    quick_sort(list(range(1100)))
    print("1100 fine")
except RecursionError:
    print("1100 RecursionError")
`;
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /900 fine\n1100 RecursionError/);
});

test('NaN mission: the starter shows the silent failure, either fix passes, and shortcuts do not', () => {
  const m = CODE_MISSIONS['cs-sort-nan'], s = m.setup();
  assert.ok(!m.steps.some((st) => st.done(s)));
  act(s, m.starter!);
  assert.deepEqual(stepsDone(m.id, s), [true, false]);
  sameInReal(m.starter!);

  const dropped = m.starter!.replace('return sorted(numbers)', 'return sorted([x for x in numbers if x == x])');
  const kept = m.starter!.replace('return sorted(numbers)', 'return sorted(numbers, key=lambda x: (x != x, x))');
  for (const fix of [dropped, kept]) {
    assert.ok(cleanSortWorks(fix), fix);
    sameInReal(fix);
  }
  act(s, kept);
  assert.ok(m.steps.every((st) => st.done(s)));

  const cheats = [
    m.starter!,
    'def clean_sort(numbers):\n    return [1.1, 2.2, 3.3]\n',
    'def clean_sort(numbers):\n    return [x for x in numbers if x == x]\n',
    'def clean_sort(numbers):\n    return []\n',
    // Drops the real numbers around the NaN instead of ordering them.
    'def clean_sort(numbers):\n    return sorted(numbers[:1])\n',
  ];
  for (const c of cheats) assert.equal(cleanSortWorks(c), false, c);
});

const LOAD = { fn: 'load', sizes: [100, 200, 400, 800], arg: 'n' } as Lab;
const GOOD_H = `def h(key):
    v = 5381
    for c in key:
        v = (v * 33 + ord(c)) % 2**32
    return v
`;
const RESIZING = (starter: string) => starter
  .replace('def h(key):\n    return len(key)\n', GOOD_H)
  .replace('    table["count"] += 1\n', `    table["count"] += 1
    if table["count"] > len(buckets) * 2 // 3:
        grow(table)
`)
  .replace('def put(table, key, value):', `def grow(table):
    old = table["buckets"]
    table["buckets"] = [[] for _ in range(len(old) * 2)]
    for bucket in old:
        for pair in bucket:
            table["buckets"][h(pair[0]) % len(table["buckets"])].append(pair)

def put(table, key, value):`);

test('hash table mission: a bad hash, then a good hash, then growth, in that order', () => {
  const m = CODE_MISSIONS['cs-hash-table'], s = m.setup();
  act(s, m.starter!, LOAD);
  assert.deepEqual(stepsDone(m.id, s), [true, true, false, false], JSON.stringify(s.growth[0]));

  // The good hash alone: spreads the keys, and the work is still not linear.
  const hashed = m.starter!.replace('def h(key):\n    return len(key)\n', GOOD_H);
  act(s, hashed, LOAD);
  assert.ok(m.steps[2].done(s), 'the spread step passes');
  assert.equal(m.steps[3].done(s), false, 'and growth is still needed');
  assert.notEqual(s.growth.at(-1)!.shape, 'linear', JSON.stringify(s.growth.at(-1)));

  const full = RESIZING(m.starter!);
  act(s, full, LOAD);
  assert.equal(s.growth.at(-1)!.shape, 'linear', JSON.stringify(s.growth.at(-1)));
  assert.ok(m.steps.every((st) => st.done(s)));
  sameInReal(full);
});

test('hash table mission: additive hashes and a hidden dict do not pass', () => {
  const m = CODE_MISSIONS['cs-hash-table'];
  const additive = m.starter!.replace('def h(key):\n    return len(key)\n', `def h(key):
    return sum([ord(c) for c in key])
`);
  assert.equal(hashSpreads(additive), false, 'sum of characters only reaches a narrow range');
  assert.equal(hashSpreads(m.starter!), false);
  // A counter "spreads" perfectly and can never find anything again.
  const counter = `n = 0
def h(key):
    global n
    n += 1
    return n
`;
  assert.equal(hashSpreads(counter), false);
  const hidden = `real = {}
def h(key):
    return 0
def new_table():
    return {"buckets": [[]], "count": 0}
def put(table, key, value):
    if key not in real:
        table["count"] += 1
    real[key] = value
def get(table, key):
    return real[key]
def load(n):
    t = new_table()
    for i in range(n):
        put(t, "user" + str(i).zfill(6), i)
    return t
`;
  assert.equal(tableWorks(hidden), false, 'a Python dict hidden inside put is not a hash table you built');
  assert.equal(tableWorks(m.starter!), false);
  assert.ok(tableWorks(RESIZING(m.starter!)));
});

const DRAIN = { fn: 'drain', sizes: [200, 400, 800, 1600], arg: 'list' } as Lab;
const HEAP_SOLUTION = `def push(q, x):
    q.append(x)
    i = len(q) - 1
    while i > 0:
        parent = (i - 1) // 2
        if q[i] < q[parent]:
            q[i], q[parent] = q[parent], q[i]
            i = parent
        else:
            break

def pop_smallest(q):
    top = q[0]
    last = q.pop()
    if q:
        q[0] = last
        i = 0
        while True:
            left = 2 * i + 1
            right = 2 * i + 2
            smallest = i
            if left < len(q) and q[left] < q[smallest]:
                smallest = left
            if right < len(q) and q[right] < q[smallest]:
                smallest = right
            if smallest == i:
                break
            q[i], q[smallest] = q[smallest], q[i]
            i = smallest
    return top

def drain(items):
    q = []
    for x in items:
        push(q, x)
    out = []
    while q:
        out.append(pop_smallest(q))
    return out

print(drain([5, 1, 4, 2, 3]))
`;

test('heap mission: the scan is quadratic, the heap is n log n, and the fix matches sorted on real Python', () => {
  const m = CODE_MISSIONS['cs-heap-queue'], s = m.setup();
  act(s, m.starter!, DRAIN);
  assert.deepEqual(stepsDone(m.id, s), [true, true, false], JSON.stringify(s.growth[0]));
  act(s, HEAP_SOLUTION, DRAIN);
  assert.equal(s.growth.at(-1)!.shape, 'n log n', JSON.stringify(s.growth.at(-1)));
  assert.ok(queueOrders(HEAP_SOLUTION));
  assert.ok(queueIsLogarithmic(HEAP_SOLUTION));
  assert.ok(m.steps.every((st) => st.done(s)));
  sameInReal(HEAP_SOLUTION);
});

test('heap mission: sorted, a kept-sorted list and a broken heap do not pass', () => {
  const m = CODE_MISSIONS['cs-heap-queue'];
  const usesSorted = m.starter!.replace('    q = []\n    for x in items:\n        push(q, x)\n    out = []\n    while q:\n        out.append(pop_smallest(q))\n    return out\n', '    return sorted(items)\n');
  const s1 = m.setup();
  act(s1, usesSorted, DRAIN);
  assert.equal(m.steps[2].done(s1), false, 'sorted inside drain');

  const keptSorted = `def push(q, x):
    i = 0
    while i < len(q) and q[i] < x:
        i += 1
    q.insert(i, x)

def pop_smallest(q):
    return q.pop(0)

def drain(items):
    q = []
    for x in items:
        push(q, x)
    out = []
    while q:
        out.append(pop_smallest(q))
    return out
`;
  assert.equal(queueIsLogarithmic(keptSorted), false, 'a kept-sorted list costs a scan per push');
  assert.ok(queueOrders(keptSorted), 'it does give the right order, which is why the cost has to be checked');

  // Sifts up but not down: fast, and pops come out in the wrong order.
  const broken = HEAP_SOLUTION.replace(/    if q:\n        q\[0\] = last[\s\S]*?    return top/, '    if q:\n        q[0] = last\n    return top');
  assert.equal(queueOrders(broken), false);
});

test('the heap the lesson teaches gives real heapq\'s answer, popping in the same order', () => {
  const src = `import heapq
${HEAP_SOLUTION}
seed = 5
vals = []
for _ in range(2000):
    seed = (seed * 1103515245 + 12345) % 2147483648
    vals.append((seed >> 8) % 300)
ours = []
real = []
for v in vals:
    push(ours, v)
    heapq.heappush(real, v)
    assert ours == real, "same layout after every push"
a = [pop_smallest(ours) for _ in range(2000)]
b = [heapq.heappop(real) for _ in range(2000)]
assert a == b, "same pop order"
print("ok")
`;
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok\n$/);
});
