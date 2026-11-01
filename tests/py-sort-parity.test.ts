// The sorting and hashing lessons make claims a learner can check in the code lab,
// so the lab has to agree with real Python on them. These run each program through
// both and compare the output byte for byte. They fail rather than skip when Python
// is missing, because a parity test that skips reads as parity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PyProgram } from '../src/lib/py/vm.ts';
import { python, pythonVersion, runPython } from './helpers/python.ts';

python();

function same(src: string, maxOps = 60_000_000) {
  const real = runPython(src);
  assert.equal(real.status, 0, `real Python failed:\n${real.stderr}`);
  const p = new PyProgram(src, { maxOps });
  p.run();
  assert.equal(p.status, 'done', `sandbox: ${p.status} ${p.error?.type} ${p.error?.message}`);
  assert.equal(p.stdout, real.stdout, `differs for:\n${src}`);
}

// Seeded the same way on both sides. Python's random module is not in the sandbox.
const LCG = `seed = 12345
def rand(n):
    global seed
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % n
def shuffled(n):
    a = list(range(n))
    for i in range(n - 1, 0, -1):
        j = rand(i + 1)
        a[i], a[j] = a[j], a[i]
    return a
`;

const COUNTING = `count = 0
class C:
    def __init__(self, v):
        self.v = v
    def __lt__(self, o):
        global count
        count += 1
        return self.v < o.v
def cost(xs, rev=False):
    global count
    count = 0
    out = sorted([C(x) for x in xs], reverse=rev)
    return count, [c.v for c in out] == sorted(xs, reverse=rev)
`;

test('sorted makes exactly the comparisons real Python makes, including the n-1 the lesson claims', () => {
  // 3.13 changed run detection; the source diff showed 3.11 and 3.12 identical.
  // On a newer Python the exact counts would no longer be the claim under test.
  const [major, minor] = pythonVersion();
  assert.ok(major === 3 && minor >= 11, `need Python 3.11 or later, have ${major}.${minor}`);
  const inputs = [
    'list(range(1000))', 'list(range(1000, 0, -1))', '[0] * 1000',
    'list(range(500)) + list(range(500, 0, -1))', 'shuffled(63)', 'shuffled(64)', 'shuffled(65)', 'shuffled(1000)', 'shuffled(5000)',
    '[x % 7 for x in shuffled(2000)]', 'list(range(300)) + shuffled(300) + list(range(300))', 'list(range(2000)) + [5]', '[5] + list(range(2000))',
    '[x // 50 for x in range(5000)]',
  ];
  const body = inputs.map((e) => `print(${JSON.stringify(e)}, cost(${e}), cost(${e}, True))`).join('\n');
  const src = `${LCG}${COUNTING}${body}\n`;
  if (minor > 12) {
    // Still has to sort correctly; the counts are only pinned to the versions read.
    const p = new PyProgram(src, { maxOps: 60_000_000 });
    p.run();
    assert.equal(p.status, 'done');
    assert.doesNotMatch(p.stdout, /False/);
    return;
  }
  same(src);
});

test('anchors: sorted input costs n-1, reversed input costs n-1, in the lab as in Python', () => {
  const src = `${COUNTING}print(cost(list(range(1000)))[0], cost(list(range(1000, 0, -1)))[0])\n`;
  const p = new PyProgram(src); p.run();
  assert.equal(p.stdout.trim(), '999 999');
});

test('NaN gives the same wrong answers as real Python at every size, not merely a wrong answer', () => {
  same(`nan = float("nan")
print(sorted([3.3, nan, 1.1, 2.2]))
print(sorted([nan, 3.3, 1.1, 2.2]))
print(sorted([3.3, 1.1, nan, 2.2]))
${LCG}
for n in [5, 10, 63, 64, 65, 100, 500, 2000]:
    for gap in [2, 3, 7]:
        a = [float(x) for x in shuffled(n)]
        for i in range(0, n, gap * 5):
            a[i] = nan
        b = sorted(a)
        print(n, gap, b)
        print(len([i for i in range(1, n) if b[i] < b[i - 1]]))
`);
});

test('the fix the lesson teaches for NaN works the same in both', () => {
  same(`nan = float("nan")
print(sorted([2.0, nan, 1.0, nan, 0.5], key=lambda x: (x != x, x)))
print(sorted([x for x in [2.0, nan, 1.0] if x == x]))
`);
});

test('stability: equal keys keep their order, with and without reverse, as the Sorting HOWTO promises', () => {
  same(`pairs = [("b", 2), ("a", 2), ("c", 1), ("a", 1)]
print(sorted(pairs, key=lambda p: p[1]))
print(sorted(pairs, key=lambda p: p[1], reverse=True))
print(sorted(sorted(pairs, key=lambda p: p[0]), key=lambda p: p[1]))
a = pairs[:]
a.sort(key=lambda p: p[0], reverse=True)
print(a)
print(sorted([1, 1.0, True, 0, False, 0.0]))
print(sorted([], reverse=True), sorted([7], reverse=True))
`);
});

// The bug: every key with the same __hash__ was treated as one key.
test('keys sharing a hash stay separate keys, and == decides: the dict held 1 key where Python holds 5', () => {
  same(`class K:
    def __init__(self, v):
        self.v = v
    def __hash__(self):
        return 42
    def __eq__(self, o):
        return self.v == o.v
    def __repr__(self):
        return f"K({self.v})"
d = {}
for i in range(5):
    d[K(i)] = i * 10
print(len(d), K(3) in d, K(9) in d, d[K(4)], d)
d[K(2)] = "new"
print(len(d), d[K(2)])
del d[K(2)]
print(len(d), K(2) in d)
s = {K(1), K(1), K(2)}
print(len(s), K(1) in s, K(3) in s)
class Same:
    def __hash__(self):
        return 7
a = Same()
b = Same()
e = {a: 1, b: 2}
print(len(e), e[a], e[b], Same() in e)
`);
});

test('hash of a float follows the documented rule, so hash(1.0) == hash(1) as == requires', () => {
  same(`vals = [1.0, 1.5, -1.5, 0.0, -0.0, 0.1, -0.1, 2.5, 1e300, -1e300, 1e-300, 5e-324, 1.7976931348623157e308, 2.0**61, 2.0**61 - 2**9, 3.14159, float("inf"), -float("inf"), -1.0, -2.0]
for v in vals:
    print(v, hash(v))
print(hash(2.0) == hash(2), hash(1e20) == hash(10**20))
`);
});

test('hash still refuses a string, by name, instead of showing a number that would change on every run', () => {
  const p = new PyProgram('print(hash("abc"))');
  p.run();
  assert.equal(p.error?.type, 'SandboxLimit');
  const q = new PyProgram('print(hash(float("nan")))');
  q.run();
  assert.equal(q.error?.type, 'SandboxLimit', 'NaN hashes by identity, which the sandbox lacks');
});

test('integers that are multiples of 2**61 - 1 all hash to 0, as the hash-flood lesson shows', () => {
  same(`P = 2**61 - 1
print(hash(P), hash(2 * P), hash(3 * P), hash(-1), hash(1), hash(True), hash(P + 1), hash(-P))
print([hash(k * P) for k in range(1, 6)])
`);
});
