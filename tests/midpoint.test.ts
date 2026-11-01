// The Midpoint Lab emulates a 32-bit int, so its arithmetic is held against
// ctypes.c_int32 in real Python, and its search against real bisect. The shortest
// breaking length is the lab's whole mission, and the answer (2^30 + 1) disagrees
// with Bloch's post (2^30), so it is proved by brute force at small widths as well.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MAX_LENGTH, MIDPOINT_MISSION, SHORTEST_BREAKING, bisectLeft, isSorted, lookup, midpoint, parseItems, randomTargets, search, targetValue, worstReads, wrap, type Formula, type IntModel, type MidpointState, type Target } from '../src/lib/cs/midpoint.ts';

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

test("the report's table: the same line, four ways", () => {
  const lo = 2 ** 30, hi = 2 ** 31 - 2;
  assert.equal(midpoint(lo, hi, 'int32', 'sum').mid, -536_870_913);
  assert.equal(midpoint(lo, hi, 'python', 'sum').mid, 1_610_612_735);
  assert.equal(midpoint(lo, hi, 'int32', 'diff').mid, 1_610_612_735);
  assert.equal(midpoint(lo, hi, 'int32', 'ushift').mid, 1_610_612_735);
  assert.equal(midpoint(lo, hi, 'int64', 'sum').mid, 1_610_612_735);
});

test('the 32-bit wrap agrees with ctypes.c_int32, and the midpoints with Java-style truncation', () => {
  const pairs = [[0, 0], [1, 2], [2 ** 30, 2 ** 30], [2 ** 30, 2 ** 31 - 2], [2 ** 31 - 2, 2 ** 31 - 1], [2 ** 31 - 1, 2 ** 31 - 1], [2 ** 30 - 1, 2 ** 30], [1_500_000_000, 2_000_000_000]];
  const out = python(`
import ctypes, json, sys
for lo, hi in json.load(sys.stdin):
    s = ctypes.c_int32(lo + hi).value
    # Java's / truncates toward zero. Python's // floors, so it can't be used bare.
    t = abs(s) // 2
    mid = t if s >= 0 else -t
    # >>> 1 reads the bits as unsigned.
    u = ctypes.c_uint32(s).value >> 1
    print(s, mid, u, lo + (hi - lo) // 2)
`, JSON.stringify(pairs));
  const rows = out.trim().split(/\r?\n/);
  pairs.forEach(([lo, hi], i) => {
    const sum = midpoint(lo, hi, 'int32', 'sum'), ush = midpoint(lo, hi, 'int32', 'ushift'), diff = midpoint(lo, hi, 'int32', 'diff');
    assert.equal(`${sum.sum} ${sum.mid} ${ush.mid} ${diff.mid}`, rows[i], `low=${lo} high=${hi}`);
    assert.equal(wrap(lo + hi), sum.sum);
  });
});

test('the shortest breaking length is 2^30 + 1, not the 2^30 Bloch wrote', () => {
  assert.equal(SHORTEST_BREAKING, 1_073_741_825);
  const at = (n: number) => search(n, n - 1, 'int32', 'sum');
  assert.equal(at(2 ** 30).status, 'found', 'at exactly 2^30 the largest sum is 2^31 - 2, which fits');
  assert.equal(at(2 ** 30 + 1).status, 'out-of-bounds');
  assert.equal(at(2 ** 30 + 1).index, -(2 ** 30));
  assert.equal(at(2 ** 31 - 1).status, 'out-of-bounds');
  assert.equal(at(1_000_000).status, 'found');
});

test('real Python, wrapping with ctypes, breaks at exactly the same length and the same index', () => {
  const out = python(`
import ctypes
def run(n):
    low, high = 0, n - 1
    target = n - 1
    while low <= high:
        s = ctypes.c_int32(low + high).value
        t = abs(s) // 2
        mid = t if s >= 0 else -t
        if mid < 0 or mid >= n: return "crash", mid
        if mid < target: low = mid + 1
        elif mid > target: high = mid - 1
        else: return "found", mid
    return "absent", low
for n in (2**30 - 1, 2**30, 2**30 + 1, 2**30 + 2, 2**31 - 1):
    print(*run(n))
`);
  const name: Record<string, string> = { found: 'found', 'out-of-bounds': 'crash', absent: 'absent' };
  const rows = out.trim().split(/\r?\n/);
  [2 ** 30 - 1, 2 ** 30, 2 ** 30 + 1, 2 ** 30 + 2, 2 ** 31 - 1].forEach((n, i) => {
    const r = search(n, n - 1, 'int32', 'sum');
    assert.equal(`${name[r.status]} ${r.index}`, rows[i], `n=${n}`);
  });
});

test('proved by brute force at small widths: first failure at 2^(bits-2) + 1, for any target', () => {
  // Nobody can walk 2^30 lengths and every target, and the same arithmetic scales.
  for (const bits of [6, 7, 8, 9, 10]) {
    const max = 2 ** (bits - 1) - 1;
    let first = 0;
    for (let n = 1; n <= max && !first; n++) {
      for (let t = 0; t < n; t++) if (search(n, t, 'int32', 'sum', bits).status === 'out-of-bounds') { first = n; break; }
    }
    assert.equal(first, 2 ** (bits - 2) + 1, `${bits}-bit`);
    // At that length, of the values in the array, only the last crashes. Keys above it
    // aren't in the array and crash too: the next test pins that.
    const crashing = Array.from({ length: first }, (_, t) => t).filter((t) => search(first, t, 'int32', 'sum', bits).status === 'out-of-bounds');
    assert.deepEqual(crashing, [first - 1], `${bits}-bit: which targets crash`);
    // Both fixes never crash, for any target, at any length the int can hold.
    for (const f of ['diff', 'ushift'] as Formula[]) {
      for (let n = 1; n <= max; n += 1) {
        for (const t of [0, n - 1, n >> 1]) assert.equal(search(n, t, 'int32', f, bits).status, 'found', `${bits}-bit ${f} n=${n} t=${t}`);
      }
    }
  }
});

// The lesson used to say "only one target can trigger it". That counted only values
// in the array, and hid the missing-key test the lesson itself calls awkward.
test('"only one target crashes" was false: every key above the last element crashes too, and one length shorter none do', () => {
  assert.equal(search(SHORTEST_BREAKING, 2 ** 30 + 5, 'int32', 'sum').status, 'out-of-bounds');
  assert.equal(search(SHORTEST_BREAKING, 2 ** 31 - 1, 'int32', 'sum').status, 'out-of-bounds');
  assert.equal(search(SHORTEST_BREAKING - 1, 2 ** 30 + 5, 'int32', 'sum').status, 'absent');
  // Every key, at small widths where every key can be tried.
  for (const bits of [8, 12]) {
    const first = 2 ** (bits - 2) + 1, top = 2 ** (bits - 1) - 1;
    for (let key = 0; key <= top; key++) {
      const want = key >= first - 1 ? 'out-of-bounds' : 'found';
      assert.equal(search(first, key, 'int32', 'sum', bits).status, want, `${bits}-bit key ${key}`);
      assert.notEqual(search(first - 1, key, 'int32', 'sum', bits).status, 'out-of-bounds', `${bits}-bit, one shorter, key ${key}`);
    }
  }
});

// B2, B5, and B8's cost, from an accuracy review of the lesson.
test('a list of two is enough to make bisect_left miss a value that is there, and length one never does', () => {
  const real = python(`import bisect, itertools
def broken(length):
    return [(t, x) for t in itertools.product(range(3), repeat=length) for x in set(t)
            if bisect.bisect_left(list(t), x) >= length or t[bisect.bisect_left(list(t), x)] != x]
print(len(broken(1)), len(broken(2)) > 0, bisect.bisect_left([2, 1], 2))
`);
  assert.equal(real.trim(), '0 True 2');
  assert.equal(lookup([2, 1], 2).found, false);
  assert.equal(lookup([2, 1], 2).present, true);
});

test('bisect_left never stops early: 9 or 10 reads on 1,000 items, even when the first middle is the target', () => {
  const items = Array.from({ length: 1000 }, (_, k) => k * 2);
  assert.equal(bisectLeft(items, items[500]).reads, 9);
  const reads = new Set<number>();
  for (let t = -1; t <= 2000; t++) reads.add(bisectLeft(items, t).reads);
  assert.deepEqual(reads, new Set([9, 10]));
});

test('the bug needs the wrap: 64-bit and Python never crash at any length here', () => {
  for (const m of ['int64', 'python'] as IntModel[]) for (const f of ['sum', 'diff', 'ushift'] as Formula[]) {
    const r = search(MAX_LENGTH, MAX_LENGTH - 1, m, f);
    assert.equal(r.status, 'found', `${m} ${f}`);
    assert.equal(r.index, MAX_LENGTH - 1);
  }
});

test('the first element never crashes, at any length: a test that looks there can pass forever', () => {
  for (const n of [SHORTEST_BREAKING, MAX_LENGTH]) assert.equal(search(n, targetValue(n, 'first'), 'int32', 'sum').status, 'found');
});

test('random testing: nothing at the shortest length, about half at the longest', () => {
  assert.equal(randomTargets(SHORTEST_BREAKING, 1000, 'int32', 'sum'), 0, 'of the values in the array, one in a billion crashes');
  const crashes = randomTargets(MAX_LENGTH, 1000, 'int32', 'sum');
  assert.ok(crashes > 400 && crashes < 600, `expected about half, got ${crashes}`);
  assert.equal(randomTargets(MAX_LENGTH, 1000, 'int32', 'diff'), 0);
});

test('worst-case reads equal bit length, and match real bisect with a counting sequence', () => {
  assert.equal(worstReads(1000n), 10);
  assert.equal(worstReads(1_000_000n), 20);
  assert.equal(worstReads(10n ** 18n), 60);
  const out = python(`
import bisect
class Counting:
    def __init__(self, n): self.n = n; self.reads = 0
    def __len__(self): return self.n
    def __getitem__(self, i): self.reads += 1; return i * 2
for n in range(1, 301):
    worst = 0
    # Every present value and every gap: the last element is not always the worst.
    for t in range(-1, 2 * n + 1):
        c = Counting(n); bisect.bisect_left(c, t); worst = max(worst, c.reads)
    print(worst)
`);
  const real = out.trim().split(/\r?\n/).map(Number);
  assert.equal(real.length, 300);
  real.forEach((w, i) => {
    const n = i + 1, items = Array.from({ length: n }, (_, k) => k * 2);
    let ours = 0;
    for (let t = -1; t <= 2 * n; t++) ours = Math.max(ours, bisectLeft(items, t).reads);
    assert.equal(ours, w, `bisectLeft reads at n=${n}`);
    assert.equal(worstReads(BigInt(n)), w, `formula at n=${n}`);
  });
  // The trap the report found: at n=10, the last element takes 3 reads and the worst is 4.
  const ten = Array.from({ length: 10 }, (_, k) => k * 2);
  assert.equal(bisectLeft(ten, 18).reads, 3);
  assert.equal(worstReads(10n), 4);
});

test("the lesson's table is real bisect, even at 10^18: an adversarial list forces the worst case", () => {
  // Nobody can try every target in 10^18 items. This list answers each read so that
  // the search always continues into the larger side, which is what a worst case is.
  const out = python(`
import bisect
class Adversary:
    def __init__(self, n): self.n = n; self.lo = 0; self.hi = n; self.reads = 0
    def __len__(self): return self.n
    def __getitem__(self, mid):
        self.reads += 1
        if self.hi - mid - 1 > mid - self.lo:
            self.lo = mid + 1
            return 0
        self.hi = mid
        return 2
for n in (1000, 10**6, 10**18):
    a = Adversary(n)
    bisect.bisect_left(a, 1)
    print(a.reads)
`);
  assert.deepEqual(out.trim().split(/\r?\n/).map(Number), [10, 20, 60]);
});

test("Bloch's loop never reads more than the formula says, for every target", () => {
  for (const n of [1, 2, 3, 7, 8, 10, 100, 1023, 1024]) {
    let worst = 0;
    for (let t = 0; t < n; t++) worst = Math.max(worst, search(n, t, 'python', 'sum').reads);
    assert.equal(worst, worstReads(BigInt(n)), `n=${n}`);
  }
});

test('bisectLeft equals real bisect_left on sorted and unsorted lists, wrong answers included', () => {
  let a = 12345;
  // The top bits: this generator's low bits repeat, and a sample of near-identical
  // lists would barely contain the failure this test is for.
  const r = (m: number) => { a = (Math.imul(a, 1103515245) + 12345) & 0x7fffffff; return (a >>> 12) % m; };
  const cases: { items: number[]; x: number }[] = [{ items: [3, 1, 2], x: 3 }, { items: [], x: 1 }];
  for (let i = 0; i < 600; i++) {
    const items = Array.from({ length: r(14) }, () => r(20));
    if (i % 2) items.sort((p, q) => p - q);
    cases.push({ items, x: r(22) - 1 });
  }
  const real = python(`
import bisect, json, sys
for c in json.load(sys.stdin):
    print(bisect.bisect_left(c["items"], c["x"]))
`, JSON.stringify(cases)).trim().split(/\r?\n/).map(Number);
  assert.equal(real.length, cases.length);
  cases.forEach((c, i) => assert.equal(bisectLeft(c.items, c.x).index, real[i], JSON.stringify(c)));
  // Named failure: a search that looks fine and lies. Measured in the sources report.
  assert.equal(real[0], 3);
  const wrong = cases.filter((c) => { const u = lookup(c.items, c.x); return u.present && !u.found; });
  assert.ok(wrong.length > 20, 'the sample has to contain the failure this test exists for');
  assert.ok(wrong.every((c) => !isSorted(c.items)), 'a sorted list must never produce it');
});

test('the unsorted example says what the lesson says it says', () => {
  const u = lookup([3, 1, 2], 3);
  assert.deepEqual([u.index, u.found, u.present, u.sorted], [3, false, true, false]);
  const s = lookup([1, 2, 3], 3);
  assert.deepEqual([s.index, s.found, s.present, s.sorted], [2, true, true, true]);
});

test('a typo in the list is refused, not quietly dropped', () => {
  assert.deepEqual(parseItems('3, 1, 2'), { items: [3, 1, 2] });
  assert.ok('error' in parseItems('3, x, 2'));
  assert.ok('error' in parseItems(''));
  assert.ok('error' in parseItems('1.5'));
  assert.deepEqual(parseItems('-4,5'), { items: [-4, 5] });
});

const ran = (s: MidpointState, length: number, model: IntModel = 'int32', formula: Formula = 'sum', targetKind: Target = 'last') =>
  s.runs.push({ ...search(length, targetValue(length, targetKind), model, formula), model, formula, targetKind });

test('the mission is not born done, and completes by playing it', () => {
  const m = MIDPOINT_MISSION, s = m.setup();
  assert.ok(m.steps.every((st) => !st.done(s)), 'no step may be done before anything ran');
  ran(s, 1_000_000);
  assert.deepEqual(m.steps.map((st) => st.done(s)), [true, false, false, false, false]);
  ran(s, MAX_LENGTH);
  assert.deepEqual(m.steps.map((st) => st.done(s)), [true, true, false, false, false]);
  ran(s, SHORTEST_BREAKING); ran(s, SHORTEST_BREAKING - 1);
  assert.deepEqual(m.steps.map((st) => st.done(s)), [true, true, true, false, false]);
  ran(s, SHORTEST_BREAKING, 'int32', 'diff');
  assert.deepEqual(m.steps.map((st) => st.done(s)), [true, true, true, true, false]);
  s.unsorted.push(lookup([3, 1, 2], 3));
  assert.ok(m.steps.every((st) => st.done(s)));
});

test('shortcuts do not pass the mission', () => {
  const m = MIDPOINT_MISSION;
  // Bloch's own number is not the answer: it does not crash, so the step stays open.
  let s = m.setup();
  ran(s, 2 ** 30); ran(s, 2 ** 30 - 1);
  assert.equal(m.steps[2].done(s), false, "Bloch's 2^30 must not pass");
  // A "works" one below that came from looking at the first element proves nothing.
  s = m.setup();
  ran(s, SHORTEST_BREAKING); ran(s, SHORTEST_BREAKING - 1, 'int32', 'sum', 'first');
  assert.equal(m.steps[2].done(s), false, 'the first element never crashes');
  // Nor does one that came from wider integers.
  s = m.setup();
  ran(s, SHORTEST_BREAKING); ran(s, SHORTEST_BREAKING - 1, 'int64');
  assert.equal(m.steps[2].done(s), false);
  // Moving to 64-bit avoids the bug and leaves the line broken on 32-bit ints.
  s = m.setup();
  ran(s, SHORTEST_BREAKING, 'int64');
  assert.equal(m.steps[3].done(s), false, 'a wider int is not the formula fix');
  // A short array passes any formula, so it shows nothing.
  s = m.setup();
  ran(s, 1000, 'int32', 'diff');
  assert.equal(m.steps[3].done(s), false, 'a fix must be shown where the bug was');
  // Not finding a number that is truly absent is the correct answer.
  s = m.setup();
  s.unsorted.push(lookup([3, 1, 2], 9), lookup([1, 2, 3], 2));
  assert.equal(m.steps[4].done(s), false);
});
