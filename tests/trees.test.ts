// The Tree Shaper's numbers, held to exact formulas where they exist and to real
// Python where a real tool can check them. Counts only, never times.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BST, RedBlack, BTree, MinHeap, PriorityQueue, keyStream, logCeil, replayOutage, updateLog, shapeRun, SHAPER_MISSION, HEIGHT_LIMIT, type ShaperState } from '../src/lib/cs/trees.ts';
import { Lcg } from '../src/lib/cs/sorting.ts';
import { PyProgram } from '../src/lib/py/vm.ts';
import { python, runPython } from './helpers/python.ts';

python();

test('a plain tree fed sorted keys: comparisons are exactly n(n-1)/2 and height is exactly n-1', () => {
  for (const n of [1, 2, 10, 1000, 4000]) {
    const t = new BST();
    for (const k of keyStream(n, 'sorted')) t.insert(k);
    assert.equal(t.comparisons, n * (n - 1) / 2, `n=${n}`);
    assert.equal(t.height, n - 1, `n=${n}`);
  }
  const t = new BST();
  for (const k of keyStream(16000, 'sorted')) t.insert(k);
  assert.equal(t.comparisons, 127_992_000);
  assert.equal(t.height, 15_999);
});

test('a plain tree fed shuffled keys: the mean over seeds is within 3% of 2(n+1)H(n) - 4n', () => {
  for (const n of [100, 1000, 4000]) {
    let harmonic = 0;
    for (let i = 1; i <= n; i++) harmonic += 1 / i;
    const expected = 2 * (n + 1) * harmonic - 4 * n;
    let total = 0;
    const seeds = 40;
    for (let s = 1; s <= seeds; s++) {
      const t = new BST();
      for (const k of keyStream(n, 'shuffled', s)) t.insert(k);
      total += t.comparisons;
    }
    const mean = total / seeds;
    assert.ok(Math.abs(mean - expected) / expected < 0.03, `n=${n}: mean ${mean}, formula ${expected}`);
  }
});

test('the same tree and the same seeded shuffle give the same counts in real Python', () => {
  const src = `class N:
    def __init__(self, key):
        self.key = key
        self.left = None
        self.right = None
def build(keys):
    root = None
    count = 0
    for k in keys:
        fresh = N(k)
        if root is None:
            root = fresh
            continue
        at = root
        while True:
            count += 1
            if k < at.key:
                if at.left is None:
                    at.left = fresh
                    break
                at = at.left
            else:
                if at.right is None:
                    at.right = fresh
                    break
                at = at.right
    return count
def shuffled(n, seed):
    a = list(range(n))
    s = seed
    for i in range(n - 1, 0, -1):
        s = (s * 1103515245 + 12345) % 2147483648
        j = (s >> 8) % (i + 1)
        a[i], a[j] = a[j], a[i]
    return a
print(build(list(range(1000))), build(shuffled(1000, 1)), build(shuffled(4000, 3)))
`;
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  const t = (n: number, seed: number) => { const b = new BST(); for (const k of keyStream(n, 'shuffled', seed)) b.insert(k); return b.comparisons; };
  assert.equal(r.stdout.trim(), `499500 ${t(1000, 1)} ${t(4000, 3)}`);
  const p = new PyProgram(src); p.run();
  assert.equal(p.stdout.trim(), r.stdout.trim(), 'and in the code lab');
});

// The lesson's loud failure, so it has to happen in real Python as well as here.
test('a recursive insert over sorted keys raises RecursionError at the same key in the lab and in Python', () => {
  const src = `def insert(node, key):
    if node is None:
        return {"key": key, "left": None, "right": None}
    if key < node["key"]:
        node["left"] = insert(node["left"], key)
    else:
        node["right"] = insert(node["right"], key)
    return node

root = None
at = 0
try:
    for k in range(2000):
        at = k
        root = insert(root, k)
    print("built", at)
except RecursionError:
    print("RecursionError at key", at)
`;
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  // A bigger budget than the lab's: this version takes half a million calls to get there.
  const p = new PyProgram(src, { maxOps: 60_000_000 }); p.run();
  assert.equal(p.status, 'done');
  assert.equal(p.stdout, r.stdout);
  assert.equal(r.stdout.trim(), 'RecursionError at key 999');
});

// What the lesson's lab runs: a straight chain, built by a loop, walked by recursion.
const CHAIN = `def chain(n):
    root = {"key": 0, "right": None}
    last = root
    for k in range(1, n):
        node = {"key": k, "right": None}
        last["right"] = node
        last = node
    return root

def height(node):
    if node is None:
        return -1
    return 1 + height(node["right"])

for n in [100, 900, 990, 995, 996, 997, 998, 999, 1000, 1001, 2000]:
    try:
        print(n, height(chain(n)))
    except RecursionError:
        print(n, "RecursionError")
`;

test('walking a straight chain recursively hits the limit at the same size in the lab and in Python', () => {
  const r = runPython(CHAIN);
  assert.equal(r.status, 0, r.stderr);
  const p = new PyProgram(CHAIN); p.run();
  assert.equal(p.status, 'done', 'the lab budget has to cover this one');
  assert.equal(p.stdout, r.stdout);
  assert.match(r.stdout, /^100 99$/m);
  assert.match(r.stdout, /^2000 RecursionError$/m);
});

test('red-black rules hold after every operation when deletes rebalance, and height stays within 2 lg(n+1)', () => {
  const t = new RedBlack(true), r = new Lcg(5), live: number[] = [];
  for (let i = 0; i < 4000; i++) {
    if (live.length && r.next(3) === 0) {
      const j = r.next(live.length);
      assert.ok(t.delete(live[j]));
      live[j] = live[live.length - 1];
      live.pop();
    } else {
      const k = i * 7 + r.next(5);
      t.insert(k);
      live.push(k);
    }
    t.validate();
    assert.equal(t.size, live.length);
    assert.ok(t.height <= 2 * Math.log2(t.size + 1) + 1e-9 || t.size === 0, `height ${t.height} at size ${t.size}`);
  }
  assert.equal(t.delete(-1), false, 'deleting a missing key must say so');
});

test('red-black stays short on sorted input: where a plain tree reaches 999, it stays under 2 lg(n+1)', () => {
  const t = new RedBlack();
  for (let i = 0; i < 1000; i++) t.insert(i);
  t.validate();
  assert.ok(t.height <= 2 * Math.log2(1001), String(t.height));
  assert.ok(t.comparisons < 20_000, String(t.comparisons));
});

test('without delete repairs the update log builds a near straight line: height n-2 for n live keys', () => {
  for (const updates of [200, 1000, 4000]) {
    const t = new RedBlack(false);
    for (const u of updateLog(updates)) { if (u.op === 'ins') t.insert(u.key); else t.delete(u.key); }
    assert.equal(t.size, updates / 2);
    assert.equal(t.height, t.size - 2, `updates ${updates}`);
    assert.throws(() => t.validate(), /black heights differ/, 'a tree this tall cannot be a valid red-black tree');
  }
  // With repairs on, the same log leaves a valid tree.
  const ok = new RedBlack(true);
  for (const u of updateLog(4000)) { if (u.op === 'ins') ok.insert(u.key); else ok.delete(u.key); }
  ok.validate();
  assert.ok(ok.height <= 2 * Math.log2(ok.size + 1));
});

test('the replay: the check fires, recovery replays the log, the check fires at the same place', () => {
  const r = replayOutage(false);
  assert.equal(r.trips, 3);
  assert.ok(r.outage);
  const trips = r.events.filter((e) => e.kind === 'trip');
  assert.equal(new Set(trips.map((e) => e.ops)).size, 1, 'same log, same rules, same point');
  assert.ok(trips[0].height > HEIGHT_LIMIT);
  // A valid red-black tree of height 81 would need billions of keys. This one has about 80.
  assert.ok(trips[0].live < 100, `tripped with only ${trips[0].live} keys live`);

  const fixed = replayOutage(true);
  assert.equal(fixed.trips, 0);
  assert.equal(fixed.outage, false);
  assert.equal(fixed.live, 1000, 'the whole log ran, nothing stopped early');
  assert.ok(fixed.maxHeight < 25, String(fixed.maxHeight));

  const rebuilt = replayOutage(false, true);
  assert.equal(rebuilt.trips, 1);
  assert.equal(rebuilt.outage, false, 'a rebuild from the live keys ends the cycle');
  assert.ok(rebuilt.finalHeight <= 2 * Math.log2(rebuilt.live + 1));
});

test('B-tree: every leaf at one depth whatever the order, and height falls with fanout', () => {
  for (const order of ['sorted', 'shuffled', 'nearly'] as const) {
    for (const f of [3, 4, 16, 100]) {
      const t = new BTree(f);
      for (const k of keyStream(4000, order)) t.insert(k);
      assert.equal(t.size, 4000);
      assert.equal(t.depths().size, 1, `${order}, fanout ${f}: leaves at different depths`);
      assert.equal(t.nodeReads(), t.height + 1);
      // Every non-root node has at least ceil(f/2) children, so height is bounded
      // by the base-(f/2) log of the leaves: ODS section 14.2's bound, h ≤ log_B ℓ + 1.
      const B = Math.ceil(f / 2);
      assert.ok(t.height <= Math.log(4001) / Math.log(B) + 1, `${order}, fanout ${f}: height ${t.height}`);
    }
  }
  const narrow = new BTree(4), wide = new BTree(100);
  for (const k of keyStream(4000, 'sorted')) { narrow.insert(k); wide.insert(k); }
  assert.ok(wide.height < narrow.height);
});

test("the lesson's height-by-fanout table for a billion keys", () => {
  assert.deepEqual([2, 16, 100, 256, 500].map((f) => logCeil(1e9, f)), [30, 8, 5, 4, 4]);
  assert.equal(logCeil(1000, 10), 3);
  assert.equal(logCeil(1, 2), 0);
});

// heapq's documentation describes the invariant. Its C code decides the layout.
test('MinHeap matches real heapq: the same list after every operation and the same comparison count', () => {
  const ops: (['push', number] | ['pop'])[] = [];
  const r = new Lcg(9);
  let size = 0;
  for (let i = 0; i < 3000; i++) {
    if (size && r.next(5) < 2) { ops.push(['pop']); size--; } else { ops.push(['push', r.next(500)]); size++; }
  }
  const src = `import heapq, json, sys
count = 0
class C:
    __slots__ = ("v",)
    def __init__(self, v): self.v = v
    def __lt__(self, o):
        global count
        count += 1
        return self.v < o.v
ops = ${JSON.stringify(ops)}
h = []
out = []
for op in ops:
    if op[0] == "push":
        heapq.heappush(h, C(op[1]))
    else:
        out.append(heapq.heappop(h).v)
print(json.dumps({"final": [c.v for c in h], "out": out, "count": count}))
`;
  const py = runPython(src);
  assert.equal(py.status, 0, py.stderr);
  const real = JSON.parse(py.stdout) as { final: number[]; out: number[]; count: number };
  const h = new MinHeap<number>((a, b) => a < b), out: number[] = [];
  for (const op of ops) { if (op[0] === 'push') h.push(op[1]); else out.push(h.pop()); }
  assert.deepEqual(out, real.out);
  assert.deepEqual(h.items, real.final);
  assert.equal(h.comparisons, real.count);
  assert.ok(real.count > 3000, 'the comparisons were really counted');
});

test('heap invariant holds after every operation, and an empty heap says so loudly', () => {
  const h = new MinHeap<number>((a, b) => a < b), r = new Lcg(3);
  for (let i = 0; i < 2000; i++) {
    if (h.size && r.next(2) === 0) h.pop(); else h.push(r.next(100));
    for (let k = 0; k < h.size; k++) {
      const l = 2 * k + 1, rr = 2 * k + 2;
      if (l < h.size) assert.ok(h.items[k] <= h.items[l]);
      if (rr < h.size) assert.ok(h.items[k] <= h.items[rr]);
    }
  }
  assert.throws(() => new MinHeap<number>((a, b) => a < b).pop(), /empty heap/);
});

test('priority queue: lowest priority first, ties in arrival order, items never compared', () => {
  const q = new PriorityQueue<{ name: string }>();
  // Plain objects have no useful <, so this fails if a tie ever compared them.
  for (const [name, p] of [['b', 2], ['a', 1], ['c', 2], ['d', 1], ['e', 3], ['f', 2]] as const) q.push({ name }, p);
  const order: string[] = [];
  while (q.size) order.push(q.pop().item.name);
  assert.deepEqual(order, ['a', 'd', 'b', 'c', 'f', 'e']);
});

test('a heap costs about log n per operation: n pushes and n pops stay under 2 n lg n comparisons', () => {
  const n = 4096, h = new MinHeap<number>((a, b) => a < b);
  for (const k of keyStream(n, 'shuffled')) h.push(k);
  for (let i = 0; i < n; i++) assert.equal(h.pop(), i);
  assert.ok(h.comparisons < 2 * n * Math.log2(n), String(h.comparisons));
  assert.ok(h.comparisons > n, 'and more than nothing');
});

test('the shaper mission completes from its hints, and shortcuts leave steps open', () => {
  const s: ShaperState = SHAPER_MISSION.setup();
  const steps = SHAPER_MISSION.steps;
  assert.ok(!steps.some((st) => st.done(s)));
  s.runs.push(shapeRun(63, 'sorted', 4));
  assert.equal(steps[0].done(s), false, '63 keys is too few to count');
  s.runs.push(shapeRun(1000, 'shuffled', 4));
  assert.equal(steps[0].done(s), false, 'shuffled is not the sorted step');
  s.runs.push(shapeRun(1000, 'sorted', 4));
  assert.ok(steps[0].done(s));
  assert.ok(steps[1].done(s));
  assert.equal(steps[3].done(s), false, 'fanout 4 is not the wide node');
  s.runs.push(shapeRun(1000, 'nearly', 4));
  assert.ok(steps[2].done(s), `nearly sorted height ${s.runs.at(-1)!.bst.height}`);
  s.runs.push(shapeRun(1000, 'sorted', 100));
  assert.ok(steps[3].done(s), `fanout 100 height ${s.runs.at(-1)!.bt.height}`);
  s.replays.push(replayOutage(true));
  assert.equal(steps[4].done(s), false, 'a clean replay does not show the outage');
  assert.ok(steps[5].done(s));
  s.replays.push(replayOutage(false));
  assert.ok(steps[4].done(s));
});

test('the shaper refuses a size it cannot draw, rather than freezing the page', () => {
  assert.throws(() => shapeRun(5000, 'sorted', 4), /at most 4000/);
});
