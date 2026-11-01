// The code-lab missions and programs of the second half of the Algorithms trail.
// Each mission is played from its own hints, its tempting shortcuts must not pass,
// and every number a lesson states is computed here, by the sandbox and by real
// Python. Fails rather than skips without Python.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { CODE_MISSIONS, type CodeMission, type CodeState } from '../src/lib/cs/missions.ts';
import { CLASS_CASES } from '../src/lib/cs/alg-strategies.ts';
import { PyProgram } from '../src/lib/py/vm.ts';
import { checkCases, classify, measureGrowth, runAll, type GrowthPoint } from '../src/lib/py/lab.ts';

function findPython(): string {
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === '3') return c;
  }
  throw new Error('No Python 3 found; these tests compare against the real interpreter and cannot pass without it');
}
const PY = findPython();
function real(src: string, input?: string) {
  const r = spawnSync(PY, ['-I', '-X', 'utf8', '-c', src], { encoding: 'utf8', input, maxBuffer: 1 << 26 });
  return { out: (r.stdout ?? '').replace(/\r\n/g, '\n'), err: (r.stderr ?? '').trim().split(/\r?\n/).at(-1) ?? '', status: r.status };
}
/** Runs in the sandbox and in real Python, and the output has to match byte for byte. */
function both(src: string): string {
  const mine = runAll(src), theirs = real(src);
  assert.equal(mine.status, 'done', `sandbox: ${mine.status} ${mine.error?.message ?? ''}`);
  assert.equal(theirs.status, 0, theirs.err);
  assert.equal(mine.stdout, theirs.out);
  return mine.stdout;
}

const fresh = (m: CodeMission): CodeState => m.setup();
function play(s: CodeState, src: string) { s.runs.push(runAll(src)); }
function measure(s: CodeState, src: string, fn: string, sizes: number[], arg: 'n' | 'list') {
  const pts: GrowthPoint[] = measureGrowth(src, fn, sizes, (n) => (arg === 'n' ? [n] : [Array.from({ length: n }, (_, i) => i)]));
  const r = runAll(src);
  s.runs.push(r);
  s.growth.push({ src, fn, points: pts, shape: classify(pts) });
  return classify(pts);
}
const M = (id: string) => { const m = CODE_MISSIONS[id]; assert.ok(m, id); return m; };

// ---------- classify, the engine change ----------

test('classify separates exponential from polynomial only where sizes are a fixed amount apart', () => {
  const shape = (f: (n: number) => number, sizes: number[]) => classify(sizes.map((n) => ({ n, ops: f(n) })));
  assert.equal(shape((n) => 2 ** n, [4, 8, 12, 16]), 'exponential or worse');
  assert.equal(shape((n) => 1.618 ** n, [8, 12, 16, 20]), 'exponential or worse');
  const fact = (n: number): number => (n < 2 ? 1 : n * fact(n - 1));
  assert.equal(shape(fact, [3, 4, 5, 6, 7]), 'exponential or worse');
  // Polynomials on the same kind of sizes must not be called exponential.
  assert.equal(shape((n) => n ** 3, [10, 20, 30, 40]), 'cubic or worse');
  assert.equal(shape((n) => n ** 4 + 100, [10, 20, 30, 40]), 'cubic or worse');
  assert.equal(shape((n) => n ** 2, [10, 20, 30, 40]), 'quadratic');
  assert.equal(shape((n) => n, [10, 20, 30, 40]), 'linear');
  // Doubling sizes can't tell, and two points never can: it stays what it was.
  assert.equal(shape((n) => n ** 3, [100, 200, 400, 800]), 'cubic or worse');
  assert.equal(shape((n) => 2 ** n, [4, 8]), 'cubic or worse');
});

// ---------- shortest paths ----------

const DIJKSTRA_FIXED = `EDGES = [("s", "a", 2), ("s", "b", 3), ("b", "a", -2), ("a", "t", 1)]

def shortest(edges, start, goal):
    dist = {start: 0}
    settled = set()
    while True:
        best = None
        for node in dist:
            if node not in settled and (best is None or dist[node] < dist[best]):
                best = node
        if best is None:
            return dist.get(goal)
        settled.add(best)
        for a, b, length in edges:
            if a == best:
                if b not in dist or dist[a] + length < dist[b]:
                    dist[b] = dist[a] + length
                    settled.discard(b)

print(shortest(EDGES, "s", "t"))
`;

test('alg-paths-dijkstra: the starter is silently wrong, the hint fixes it, shortcuts fail', () => {
  const m = M('alg-paths-dijkstra'), s = fresh(m);
  assert.ok(!m.steps.some((st) => st.done(s)));
  assert.equal(both(m.starter!), '3\n');
  play(s, m.starter!);
  assert.ok(m.steps[0].done(s));
  assert.ok(!m.steps[1].done(s), 'the starter must not pass');
  assert.equal(both(DIJKSTRA_FIXED), '2\n');
  play(s, DIJKSTRA_FIXED);
  assert.ok(m.steps.every((st) => st.done(s)));

  // Only dropping the early return leaves the wrong answer in place.
  const noEarly = fresh(m);
  play(noEarly, m.starter!.replace('        if best == goal:\n            return dist[best]\n', '').replace('            return None\n', '            return dist.get(goal)\n'));
  assert.ok(!m.steps[1].done(noEarly));
  // Hard-coding the visible answer.
  const hard = fresh(m);
  play(hard, 'def shortest(edges, start, goal):\n    return 2\n');
  assert.ok(!m.steps[1].done(hard));
  // Bellman-Ford is a correct route, and counts: judged on behaviour, not method.
  const bf = fresh(m);
  play(bf, `def shortest(edges, start, goal):
    dist = {start: 0}
    for _ in range(len(edges) + 1):
        for a, b, w in edges:
            if a in dist and (b not in dist or dist[a] + w < dist[b]):
                dist[b] = dist[a] + w
    return dist.get(goal)
`);
  assert.ok(m.steps[1].done(bf));
});

test('the MST program in the greedy lesson matches a brute force over every spanning tree', () => {
  const src = readLesson('greedy');
  const prog = extractCode(src, 'cheapest_network');
  assert.match(both(prog), /^total 10\n/);
  const brute = real(`
import itertools
edges = [("A","B",7),("A","C",3),("B","C",1),("B","D",6),("C","D",9),("C","E",4),("D","E",2)]
nodes = {"A","B","C","D","E"}
best = None
for tree in itertools.combinations(edges, len(nodes) - 1):
    parent = {n: n for n in nodes}
    def find(x):
        while parent[x] != x: x = parent[x]
        return x
    ok = True
    for a, b, w in tree:
        ra, rb = find(a), find(b)
        if ra == rb: ok = False; break
        parent[ra] = rb
    if ok:
        total = sum(w for _, _, w in tree)
        best = total if best is None else min(best, total)
print(best)`);
  assert.equal(brute.out.trim(), '10', `brute force says ${brute.out}`);
});

// ---------- greedy ----------

const LIE_FIX = (starter: string) => starter.replace('    # The smallest amount up to 100 where greedy needs more coins, or None.\n    return None\n', `    for amount in range(1, 101):
        if greedy(amount, coins) != fewest(amount, coins):
            return amount
    return None
`);

test('alg-greedy-coins: the counterexamples are real, every case agrees with real Python, shortcuts fail', () => {
  const m = M('alg-greedy-coins'), s = fresh(m);
  assert.ok(!m.steps.some((st) => st.done(s)));
  assert.equal(both(m.starter!), '2 2\n3 2\nNone\n');
  play(s, m.starter!);
  assert.ok(m.steps[0].done(s));
  assert.ok(!m.steps[1].done(s));
  const fixed = LIE_FIX(m.starter!);
  assert.notEqual(fixed, m.starter);
  assert.match(both(fixed), /\n6\n$/);
  play(s, fixed);
  assert.ok(m.steps.every((st) => st.done(s)));

  // The answers the mission expects, from real Python.
  const answers = real(`${fixed}
print([first_lie(c) for c in ([1,3,4],[1,7,10],[1,12,19],[1,5,18,25],[1,5,10,25],[1,2,5,10],[1,4,5])])`);
  assert.match(answers.out, /\[6, 14, 24, 28, None, None, 8\]\n$/);

  // Returning the one visible answer.
  const hard = fresh(m);
  play(hard, m.starter!.replace('    return None\n\nprint(greedy', '    return 6\n\nprint(greedy'));
  assert.ok(!m.steps[1].done(hard));
});

test('the coin numbers the lesson states: Shallit\'s 4.7 and 3.89, reproduced by counting', () => {
  const out = both(`def greedy(amount, coins):
    count = 0
    for coin in sorted(coins, reverse=True):
        while amount >= coin:
            amount -= coin
            count += 1
    return count

def fewest(amount, coins):
    best = [0] * (amount + 1)
    for a in range(1, amount + 1):
        best[a] = min([best[a - c] + 1 for c in coins if c <= a])
    return best[amount]

for coins in ([1, 5, 10, 25], [1, 5, 18, 25]):
    g = sum([greedy(a, coins) for a in range(100)])
    f = sum([fewest(a, coins) for a in range(100)])
    lies = [a for a in range(100) if greedy(a, coins) != fewest(a, coins)]
    print(g / 100, f / 100, len(lies), lies[:4])
print(greedy(36, [1, 5, 18, 25]), fewest(36, [1, 5, 18, 25]))
print(greedy(14, [1, 7, 10]), greedy(24, [1, 12, 19]))
`);
  assert.equal(out, '4.7 4.7 0 []\n4.58 3.89 37 [28, 29, 33, 34]\n4 2\n5 6\n');
});

const MOST = (key: string) => `def most_classes(classes):
    chosen = 0
    free_from = 0
    for start, finish in sorted(classes, key=lambda c: ${key}):
        if start >= free_from:
            chosen += 1
            free_from = finish
    return chosen
`;

test('alg-greedy-classes: only "ends earliest" passes, and the expected answers are held to brute force', () => {
  const m = M('alg-greedy-classes'), s = fresh(m);
  assert.ok(!m.steps.some((st) => st.done(s)));
  assert.equal(both(m.starter!), '1\n');
  play(s, m.starter!);
  assert.ok(m.steps[0].done(s));
  assert.ok(!m.steps[1].done(s));
  for (const [name, key] of [['shortest first', 'c[1] - c[0]'], ['latest start', '-c[0]'], ['latest end', '-c[1]']] as const) {
    const t = fresh(m);
    play(t, MOST(key));
    assert.ok(!m.steps[1].done(t), `${name} must not pass`);
  }
  play(s, MOST('c[1]'));
  assert.ok(m.steps.every((st) => st.done(s)));

  const brute = real(`
import itertools, json, sys
def fits(sel):
    sel = sorted(sel)
    return all(sel[i][1] <= sel[i + 1][0] for i in range(len(sel) - 1))
def best(cs):
    for k in range(len(cs), -1, -1):
        if any(fits(c) for c in itertools.combinations(cs, k)):
            return k
print(json.dumps([best([tuple(c) for c in cs]) for cs in json.load(sys.stdin)]))`, JSON.stringify(CLASS_CASES.map((c) => c.args[0])));
  assert.deepEqual(JSON.parse(brute.out), CLASS_CASES.map((c) => Number(c.want)));
});

test('"ends earliest" equals brute force on 300 random timetables, and the other two rules don\'t', () => {
  const r = real(`
import itertools, random
random.seed(7)
def fits(sel):
    sel = sorted(sel)
    return all(sel[i][1] <= sel[i + 1][0] for i in range(len(sel) - 1))
def best(cs):
    for k in range(len(cs), -1, -1):
        if any(fits(c) for c in itertools.combinations(cs, k)):
            return k
def greedy(cs, key):
    n, free = 0, 0
    for s, f in sorted(cs, key=key):
        if s >= free:
            n, free = n + 1, f
    return n
wrong = {"end": 0, "start": 0, "short": 0}
for _ in range(300):
    cs = []
    for _ in range(random.randint(1, 9)):
        s = random.randint(0, 20)
        cs.append((s, s + random.randint(1, 8)))
    b = best(cs)
    wrong["end"] += greedy(cs, lambda c: c[1]) != b
    wrong["start"] += greedy(cs, lambda c: c[0]) != b
    wrong["short"] += greedy(cs, lambda c: c[1] - c[0]) != b
print(wrong["end"], wrong["start"] > 20, wrong["short"] > 5)`);
  assert.equal(r.out.trim(), '0 True True');
});

// ---------- dynamic programming ----------

const MEMO = `memo = {}

def fib(n):
    if n in memo:
        return memo[n]
    if n < 2:
        return n
    memo[n] = fib(n - 1) + fib(n - 2)
    return memo[n]

print(fib(0), fib(1), fib(2))
`;
const LOOP = `def fib(n):
    a, b = 0, 1
    for _ in range(n):
        a, b = b, a + b
    return a

print(fib(0), fib(1), fib(2))
`;

test('alg-dp-fib: exponential, then linear, then the stack, then no stack; shortcuts fail', () => {
  const m = M('alg-dp-fib'), s = fresh(m), sizes = [8, 12, 16, 20];
  assert.ok(!m.steps.some((st) => st.done(s)));
  assert.equal(both(m.starter!), '0 1 1\n');
  assert.equal(measure(s, m.starter!, 'fib', sizes, 'n'), 'exponential or worse');
  assert.ok(m.steps[0].done(s));
  assert.ok(!m.steps[1].done(s), 'the naive version must not pass the memo step');
  assert.equal(measure(s, MEMO, 'fib', sizes, 'n'), 'linear');
  assert.ok(m.steps[1].done(s));
  const deep = `${MEMO}print(fib(5000))\n`;
  const r = runAll(deep);
  assert.equal(r.error?.type, 'RecursionError');
  assert.match(real(deep).err, /^RecursionError/, 'real Python raises the same');
  s.runs.push(r);
  assert.ok(m.steps[2].done(s));
  assert.ok(!m.steps[3].done(s), 'the memo alone must not pass fib(5000)');
  play(s, LOOP);
  assert.ok(m.steps.every((st) => st.done(s)));

  // A wrong recurrence that is fast.
  const wrong = fresh(m);
  play(wrong, 'def fib(n):\n    return n\n');
  assert.ok(!m.steps[3].done(wrong));
  // A wrong sum that "looks like" Fibonacci.
  const nearly = fresh(m);
  play(nearly, 'def fib(n):\n    a, b = 1, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n');
  assert.ok(!m.steps[3].done(nearly));
  // Filling a memo from the bottom works too: it's a correct route, and the report
  // measured it on real functools.
  const filled = fresh(m);
  play(filled, `memo = {0: 0, 1: 1}
def fib(n):
    for i in range(2, n + 1):
        memo[i] = memo[i - 1] + memo[i - 2]
    return memo[n]
`);
  assert.ok(m.steps[3].done(filled));
});

test('alg-dp-fib step 3 used to pass on any RecursionError at all, from any cause, memo or no memo', () => {
  const m = M('alg-dp-fib'), step = m.steps[2];
  const failing = (src: string) => { const s = fresh(m); const r = runAll(src); assert.equal(r.error?.type, 'RecursionError', src); s.runs.push(r); return step.done(s); };
  assert.ok(!failing('def fib(n):\n    if n < 2:\n        return n\n    return fib(n - 1) + fib(n - 2)\n\nprint(fib(5000))\n'), 'no memo');
  assert.ok(!failing('def f():\n    f()\n\nf()\n'), 'another function, and no fib');
  assert.ok(!failing(`${LOOP}\ndef f():\n    f()\n\nf()\n`), 'a loop fib that never overflows, beside an unrelated overflow');
  assert.ok(!failing(`def fib(n):\n    return fib(n + 1)\n\nprint(fib(1))\n`), 'a fib that never gives an answer');
  assert.ok(failing(`${MEMO}print(fib(5000))\n`), 'the step itself');
  assert.ok(failing(`memo = {0: 0, 1: 1}\ndef fib(n):\n    if n not in memo:\n        memo[n] = fib(n - 1) + fib(n - 2)\n    return memo[n]\n\nprint(fib(4000))\n`), 'another way to write a memo, and another deep call');
});

test('real functools.cache: fast, and the same RecursionError from cold', () => {
  const r = real(`
import functools, sys
@functools.lru_cache(maxsize=None)
def fib(n):
    return n if n < 2 else fib(n - 1) + fib(n - 2)
print(fib(30))
print(fib.cache_info())
try:
    fib.cache_clear()
    fib(5000)
except RecursionError as e:
    print("RecursionError")
fib.cache_clear()
for i in range(0, 5001, 200):
    fib(i)
print(len(str(fib(5000))))
`);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, '832040\nCacheInfo(hits=28, misses=31, maxsize=None, currsize=31)\nRecursionError\n1045\n');
});

test('the naive call counts in the lesson: 2F(n+1)-1, by counting in the sandbox and in Python', () => {
  const out = both(`calls = 0
def fib(n):
    global calls
    calls += 1
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)

for n in [10, 20, 25]:
    calls = 0
    print(n, fib(n), calls)
`);
  assert.equal(out, '10 55 177\n20 6765 21891\n25 75025 242785\n');
});

test('the lesson\'s regex matcher reproduces the report\'s counts, and doubles and quadruples as stated', () => {
  const prog = extractCode(readLesson('dynamic-programming'), 'def matches');
  const out = both(prog);
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'k=40 plain 1763 remembering 163');
  assert.equal(lines[1], 'k=80 plain 6723 remembering 323');
  assert.equal(lines[2], 'k=160 plain 26243 remembering 643');
  // Cross-check the pattern the report measured at a size the page itself won't run.
  const big = real(`import sys
sys.setrecursionlimit(100000)
${prog.split('print(')[0].split('for k in')[0]}
tokens = [("star", "."), ("star", "."), ("one", "="), ("star", ".")]
print(matches(tokens, "x" * 640, False)[1], matches(tokens, "x" * 640, True)[1])
tokens = [("star", "a"), ("opt", "b"), ("star", "a")]
print(matches(tokens, "a" * 320 + "x", False)[1], matches(tokens, "a" * 320 + "x", True)[1])
`);
  assert.equal(big.status, 0, big.err);
  assert.equal(big.out, '412163 2563\n104004 1604\n');
});

test('the DP lesson said p(n+1) pairs, and its own matcher also stores the end of the pattern: the bound is (p+1)(n+1)', () => {
  const lesson = readLesson('dynamic-programming');
  assert.match(lesson, /at most `\(p \+ 1\)\(n \+ 1\)`/);
  assert.doesNotMatch(lesson, /at most `p\(n \+ 1\)`/);
  // The lesson's own code, with only what it returns changed, so this can't drift from it.
  const prog = extractCode(lesson, 'def matches').split('# The pattern .*.*=.*')[0].replace('return m(0, 0), calls', 'return m(0, 0), len(tried)');
  assert.notEqual(prog.indexOf('len(tried)'), -1);
  const r = real(`import random, sys
sys.setrecursionlimit(100000)
${prog}
print(matches([("star", "x")], "xxy", True)[1])
random.seed(5)
over_old, over_new, reached = 0, 0, 0
for _ in range(5000):
    p, n = random.randint(1, 5), random.randint(0, 8)
    toks = [(random.choice(["one", "opt", "star"]), random.choice("ab.")) for _ in range(p)]
    size = matches(toks, "".join(random.choice("abc") for _ in range(n)), True)[1]
    over_old += size > p * (n + 1)
    over_new += size > (p + 1) * (n + 1)
    reached += size == (p + 1) * (n + 1)
print(over_old > 0, over_new, reached > 0)`);
  assert.equal(r.status, 0, r.err);
  // 6 pairs where p(n+1) says 4, none ever over the new bound, and some exactly on it.
  assert.equal(r.out, '6\nTrue 0 True\n');
});

test('the cubic input the DP lesson gives: the lesson\'s matcher counts about 8x per doubling on x= repeated', () => {
  const prog = extractCode(readLesson('dynamic-programming'), 'def matches').split('# The pattern .*.*=.*')[0];
  const r = real(`import sys
sys.setrecursionlimit(100000)
${prog}
pattern = [("star", "."), ("star", "."), ("one", "="), ("star", "."), ("one", ";")]
print(*[matches(pattern, "x=" * k, False)[1] for k in (30, 60, 120)])
print(*[matches(pattern, "x=" * k, True)[1] for k in (30, 60, 120)])`);
  assert.equal(r.status, 0, r.err);
  const [plain, memo] = r.out.trim().split('\n').map((l) => l.split(' ').map(Number));
  assert.ok(plain[2] / plain[1] > 7 && plain[2] / plain[1] < 9, `plain counts ${plain}`);
  assert.ok(memo[2] / memo[1] > 1.9 && memo[2] / memo[1] < 2.1, `and remembering makes it linear again: ${memo}`);
});

test('Cloudflare\'s published counts fit k squared plus 7k plus 15: polynomial, not exponential', () => {
  const f = (k: number) => k * k + 7 * k + 15;
  assert.deepEqual([f(1), f(2), f(3), f(20)], [23, 33, 45, 555]);
});

test('the DP lesson\'s table version of change-making is what the greedy lesson\'s table was', () => {
  const m = M('alg-greedy-coins');
  assert.match(m.starter!, /best\[a\] = min\(\[best\[a - c\] \+ 1 for c in coins if c <= a\]\)/);
});

// ---------- growth classes ----------

const MIDDLE = `def quicksort(items):
    if len(items) < 2:
        return items
    mid = len(items) // 2
    pivot = items[mid]
    rest = items[:mid] + items[mid + 1:]
    smaller = [x for x in rest if x < pivot]
    larger = [x for x in rest if x >= pivot]
    return quicksort(smaller) + [pivot] + quicksort(larger)

print(quicksort([3, 1, 4, 1, 5, 9, 2, 6]))
`;

test('alg-growth-quicksort: quadratic on sorted input, fixed by the middle pivot; a sorted-check shortcut fails', () => {
  const m = M('alg-growth-quicksort'), s = fresh(m), sizes = [100, 200, 400, 800];
  assert.ok(!m.steps.some((st) => st.done(s)));
  assert.equal(both(m.starter!), '[1, 1, 2, 3, 4, 5, 6, 9]\n');
  assert.equal(measure(s, m.starter!, 'quicksort', sizes, 'list'), 'quadratic');
  assert.ok(m.steps[0].done(s));
  assert.ok(!m.steps[1].done(s));
  assert.equal(both(MIDDLE), '[1, 1, 2, 3, 4, 5, 6, 9]\n');
  assert.equal(measure(s, MIDDLE, 'quicksort', sizes, 'list'), 'n log n');
  assert.ok(m.steps.every((st) => st.done(s)));

  // Special-casing the input the lab measures: still first-pivot underneath.
  const cheat = `def quicksort(items):
    if items == sorted(items):
        return items
    pivot = items[0]
    rest = items[1:]
    return quicksort([x for x in rest if x < pivot]) + [pivot] + quicksort([x for x in rest if x >= pivot])
`;
  const t = fresh(m);
  measure(t, cheat, 'quicksort', sizes, 'list');
  assert.ok(!m.steps[1].done(t), 'a sorted check must not pass');
  // Wrong output never passes:
  const broken = fresh(m);
  measure(broken, 'def quicksort(items):\n    return items\n', 'quicksort', sizes, 'list');
  assert.ok(!m.steps[1].done(broken));
});

test('"return sorted(items)" used to finish alg-growth-quicksort without touching a pivot', () => {
  const m = M('alg-growth-quicksort'), sizes = [100, 200, 400, 800], step = m.steps[1];
  const verdict = (src: string) => { const s = fresh(m); measure(s, src, 'quicksort', sizes, 'list'); return step.done(s); };
  // Each of these sorts correctly and isn't quadratic on sorted or reversed input.
  assert.ok(!verdict('def quicksort(items):\n    return sorted(items)\n'), 'sorted()');
  assert.ok(!verdict('def quicksort(items):\n    items = list(items)\n    items.sort()\n    return items\n'), '.sort()');
  assert.ok(!verdict('def quicksort(items):\n    if items == sorted(items):\n        return items\n    if items == sorted(items, reverse=True):\n        return items[::-1]\n    pivot = items[0]\n    rest = items[1:]\n    return quicksort([x for x in rest if x < pivot]) + [pivot] + quicksort([x for x in rest if x >= pivot])\n'), 'checks for both inputs the lab uses');
  // Honest quicksorts, written the ways a learner might, must not be caught by that.
  assert.ok(verdict(MIDDLE), 'the hint');
  assert.ok(verdict('def quicksort(items):\n    if len(items) < 2:\n        return items\n    pivot = items[len(items) // 2]\n    smaller = [x for x in items if x < pivot]\n    same = [x for x in items if x == pivot]\n    larger = [x for x in items if x > pivot]\n    return quicksort(smaller) + same + quicksort(larger)\n'), 'three lists');
  assert.ok(verdict('def quicksort(items):\n    if len(items) < 2:\n        return items\n    mid = (len(items) - 1) // 2\n    pivot = items[mid]\n    smaller = []\n    larger = []\n    for i in range(len(items)):\n        if i == mid:\n            continue\n        if items[i] < pivot:\n            smaller.append(items[i])\n        else:\n            larger.append(items[i])\n    return quicksort(smaller) + [pivot] + quicksort(larger)\n'), 'a loop');
  assert.ok(verdict('def quicksort(items):\n    items = list(items)\n    def go(lo, hi):\n        if hi - lo < 1:\n            return\n        p = items[(lo + hi) // 2]\n        i, j = lo, hi\n        while i <= j:\n            while items[i] < p:\n                i += 1\n            while items[j] > p:\n                j -= 1\n            if i <= j:\n                items[i], items[j] = items[j], items[i]\n                i += 1\n                j -= 1\n        go(lo, j)\n        go(i, hi)\n    go(0, len(items) - 1)\n    return items\n'), 'in place');
});

test('the numbers the growth lesson states about quicksort, best, worst and average', () => {
  const out = real(`
import random
def qs(items, rule):
    count = 0
    def go(a):
        nonlocal count
        if len(a) < 2:
            return a
        i = 0 if rule == "first" else len(a) // 2
        p = a[i]
        rest = a[:i] + a[i + 1:]
        count += len(rest)
        return go([x for x in rest if x < p]) + [p] + go([x for x in rest if x >= p])
    r = go(items)
    assert r == sorted(items)
    return count
import sys
sys.setrecursionlimit(100000)
n = 800
print(qs(list(range(n)), "first"))
print(qs(list(range(n, 0, -1)), "middle"))
pipe = list(range(0, n, 2)) + list(range(n - 1, 0, -2))
print(qs(pipe, "middle"))
print(qs(pipe, "first"))
means = []
for rule in ("first", "middle"):
    random.seed(1)
    vals = []
    for _ in range(200):
        a = list(range(n)); random.shuffle(a); vals.append(qs(a, rule))
    means.append(sum(vals) // len(vals))
print(*means)
# The paper's own organ pipe, 123..nn..321, which the lesson says isn't the table's row.
bentley = list(range(1, n // 2 + 1)) + list(range(n // 2, 0, -1))
print(qs(bentley, "middle"), pipe[:3], pipe[398:402], pipe[-2:])
`);
  assert.equal(out.status, 0, out.err);
  assert.equal(out.out, '319600\n6187\n319600\n160399\n8468 8432\n160000 [0, 2, 4] [796, 798, 799, 797] [3, 1]\n');
  assert.equal(800 * 799 / 2, 319600, 'n(n-1)/2 at n=800');
  assert.equal(400 * 400, 160000, 'and Bentley and McIlroy\'s n squared on 2n items, for n = 400');
});

test('spanning trees stay right with negative costs, which is why being greedy alone isn\'t what needs non-negative lengths', () => {
  const prog = extractCode(readLesson('greedy'), 'cheapest_network').split('network = cheapest_network')[0];
  const r = real(`import itertools, random
${prog}
def brute(links):
    nodes = {x for l in links for x in l[:2]}
    best = None
    for tree in itertools.combinations(links, len(nodes) - 1):
        parent = {n: n for n in nodes}
        def find(x):
            while parent[x] != x: x = parent[x]
            return x
        ok = True
        for a, b, _ in tree:
            ra, rb = find(a), find(b)
            if ra == rb:
                ok = False
                break
            parent[ra] = rb
        if ok:
            total = sum(w for _, _, w in tree)
            best = total if best is None else min(best, total)
    return best
random.seed(11)
wrong = 0
for _ in range(500):
    ls = [(a, b, random.randint(-9, 9)) for a, b, _ in links]
    wrong += sum(c for _, _, c in cheapest_network(ls, "A")) != brute(ls)
print(wrong)`);
  assert.equal(r.status, 0, r.err);
  assert.equal(r.out, '0\n');
  // The shortest-path half of the same claim: the mission's starter goes wrong on one.
  assert.equal(both(M('alg-paths-dijkstra').starter!), '3\n', 'the true shortest is 2');
});

test('claims the 2026-11-01 review found false stay out of these lessons', () => {
  const absent: [string, RegExp, string][] = [
    ['algorithms-and-people', /No test of the program would have failed/, 'the Royal Commission records plain system errors'],
    ['algorithms-and-people', /couldn't have come out otherwise/, 'contradicted the lesson\'s own line that the numbers weren\'t inevitable'],
    ['algorithms-and-people', /remains in dispute/, 'the sources read stop in 2016'],
    ['algorithms-and-people', /it's always true of any such table/, 'it divides by zero when no flagged person is positive'],
    ['algorithms-and-people', /Law has started to respond/, 'the GDPR entered into force the month ProPublica published'],
    ['growth-classes', /Their fix was to make the table bigger/, 'all the sockets shared port 53, so a bigger table alone could not split them'],
    ['growth-classes', /Linux keeps its listening sockets/, 'a 2016 post, in the present tense'],
    ['growth-classes', /That's why it's exponential/, 'T(n) = T(n-1) + O(1) subtracts and is linear'],
    ['graphs', /one loud tool and one quiet one/, 'make prints the message: what differs is whether it stops'],
    ['graphs', /nearly every buffer on every IMP/, 'RFC 789 says core dumps from several IMPs'],
    ['greedy', /That's why they need non-negative lengths/, 'the spanning tree method is greedy too and is fine with negative costs'],
    ['trees-and-heaps', /shortest-paths lesson (uses all of this|runs on)|priority queue the shortest-paths lesson/, 'that lesson scans'],
    ['dynamic-programming', /whole class of problem/, 'Ruby\'s own notes say about 90%, with a timeout as the fallback'],
    ['dynamic-programming', /on every request|on every HTTP request/, 'not in the post, which says real customer traffic passes through the rule'],
    ['dynamic-programming', /usually polynomial/, 'no source says usually'],
  ];
  for (const [slug, pattern, why] of absent) assert.doesNotMatch(readLesson(slug), pattern, `${slug}: ${why}`);
  // counting-steps is second on the trail. what-is-an-algorithm is first and has no GTA in it.
  for (const slug of ['algorithms-and-people', 'growth-classes', 'dynamic-programming']) assert.doesNotMatch(readLesson(slug), /[Tt]he first lesson/, slug);
  // Lessons that don't exist yet are promised as planned, not as here.
  assert.match(readLesson('algorithms-and-people'), /Two planned lessons, not written yet/);
  assert.match(readLesson('growth-classes'), /A planned lesson on P and NP/);
});

test('the Robodebt quiz asks about the averaging, and no longer says a test of the program could pass', () => {
  const s = readLesson('algorithms-and-people');
  assert.match(s, /q="Set aside the scheme's ordinary bugs\. What was wrong with the averaging itself/);
  assert.doesNotMatch(s, /a test of the program could pass/);
  assert.doesNotMatch(s, /Robodebt's arithmetic, in the sense/);
});

test('the graphs lesson\'s two programs: the walk finds the island is unreachable, and the plain build order hides a cycle', () => {
  const src = readLesson('graphs');
  const walk = extractCode(src, 'def walk');
  assert.equal(both(walk), `['A', 'B', 'C', 'D', 'E']\nReachable from A: ['A', 'B', 'C', 'D', 'E']\n`);
  assert.equal(both(walk.replace('waiting.pop(0)', 'waiting.pop()')), `['A', 'C', 'E', 'D', 'B']\nReachable from A: ['A', 'B', 'C', 'D', 'E']\n`);
  assert.match(both(walk.replace('walk(roads, "A"))\nprint("Reachable from A:", sorted(walk(roads, "A")))', 'walk(roads, "F"))')), /\['F', 'G'\]/);
  const build = extractCode(src, 'def build_order');
  assert.equal(both(build), `['core', 'lib', 'log', 'app']\n`);
  // What the lesson says happens when you add the edge: an order, and no error.
  const cyc = build.replace('"core": [],', '"core": ["app"],');
  assert.notEqual(cyc, build);
  assert.equal(both(cyc), `['core', 'lib', 'log', 'app']\n`);
});

test('linear search: best 1, worst n, average (n+1)/2, by trying every position', () => {
  const prog = extractCode(readLesson('growth-classes'), 'def find');
  assert.equal(both(prog), 'best 1\nworst 1000\naverage 500.5\nnot there 1000\n');
});

test('subsets and orderings are named as such, on their own lab sizes', () => {
  const src = readLesson('growth-classes');
  const subs = extractCode(src, 'def subsets');
  const perms = extractCode(src, 'def orderings');
  assert.equal(both(subs), '4\n[[], [3], [2], [2, 3]]\n');
  assert.equal(both(perms), '6\n[[1, 2, 3], [1, 3, 2], [2, 1, 3], [2, 3, 1], [3, 1, 2], [3, 2, 1]]\n');
  const list = (n: number) => [Array.from({ length: n }, (_, i) => i)];
  assert.equal(classify(measureGrowth(subs, 'subsets', [8, 10, 12, 14], list)), 'exponential or worse');
  assert.equal(classify(measureGrowth(perms, 'orderings', [4, 5, 6, 7], list)), 'exponential or worse');
});

test('the growth table: every cell computed at the invented million steps a second', () => {
  const secs = (steps: number) => steps / 1e6;
  assert.equal(secs(2 ** 20), 1.048576);
  assert.ok(Math.abs(secs(2 ** 40) / 86400 - 12.7) < 0.05, '2^40 is about 12.7 days');
  assert.ok(Math.abs(secs(2 ** 60) / (86400 * 365.25) - 36533) < 5, '2^60 is about 36,500 years');
  const fact = (n: number): number => (n < 2 ? 1 : n * fact(n - 1));
  assert.equal(secs(fact(10)), 3.6288);
  assert.ok(Math.abs(secs(fact(15)) / 86400 - 15.1) < 0.05, '15! is about 15.1 days');
  assert.ok(Math.abs(secs(fact(20)) / (86400 * 365.25) - 77094) < 50, '20! is about 77,000 years');
  // 60! as a number of years has 69 digits: about 2.6 x 10^68.
  const years60 = real('import math; print(math.factorial(60) // (10 ** 6 * 31557600))').out.trim();
  assert.equal(years60.length, 69);
  assert.equal(secs(20 ** 3), 0.008);
  assert.equal(secs(60 ** 3), 0.216);
});

// ---------- algorithms and people ----------

const DEBT_FIX = (starter: string) => starter
  .replace('    average = sum(income) / len(income)\n', '')
  .replace('if on_benefit[fortnight] and average > FREE:', 'if on_benefit[fortnight] and income[fortnight] > FREE:')
  .replace('owed += (average - FREE) * TAPER', 'owed += (income[fortnight] - FREE) * TAPER');

test('alg-people-averaging: a false debt from averaging, fixed by using real figures; shortcuts fail', () => {
  const m = M('alg-people-averaging'), s = fresh(m);
  assert.ok(!m.steps.some((st) => st.done(s)));
  const out = both(m.starter!);
  assert.match(out, /^1615\.38/, out);
  play(s, m.starter!);
  assert.ok(m.steps[0].done(s));
  assert.ok(!m.steps[1].done(s));
  const fixed = DEBT_FIX(m.starter!);
  assert.notEqual(fixed, m.starter);
  assert.equal(both(fixed), '0.0\n');
  play(s, fixed);
  assert.ok(m.steps.every((st) => st.done(s)));

  // "Nobody owes anything" also clears the false debt, and misses real overpayments.
  const zero = fresh(m);
  play(zero, 'def debt(income, on_benefit):\n    return 0.0\n');
  assert.ok(!m.steps[1].done(zero));
  // Averaging only the fortnights on benefit is still averaging: it hides a real one.
  const part = fresh(m);
  play(part, `FREE = 300
TAPER = 0.5
def debt(income, on_benefit):
    months = [i for i, b in zip(income, on_benefit) if b]
    if not months:
        return 0.0
    average = sum(months) / len(months)
    return float(max(average - FREE, 0) * TAPER * len(months))
`);
  assert.ok(!m.steps[1].done(part));
});

test('the COMPAS table program prints what both published sides say', () => {
  const prog = extractCode(readLesson('algorithms-and-people'), 'black = ');
  const out = both(prog);
  assert.match(out, /false positives 44\.8% vs 23\.5%/);
  assert.match(out, /false negatives 28\.0% vs 47\.7%/);
  assert.match(out, /flagged but did not reoffend 37\.0% vs 40\.9%/);
  assert.match(out, /not flagged but did reoffend 35\.0% vs 28\.8%/);
  assert.match(out, /reoffended at all 51\.4% vs 39\.4%/);
});

// ---------- helpers ----------

function readLesson(slug: string) { return readFileSync(`src/content/lessons/algorithms/${slug}.mdx`, 'utf8'); }
/** The program from a <CodeLab code={`...`}> whose source contains `marker`, unescaped as MDX reads it. */
function extractCode(mdx: string, marker: string): string {
  for (const m of mdx.matchAll(/code=\{`([\s\S]*?)`\}/g)) {
    if (m[1].includes(marker)) return m[1].replace(/\\`/g, '`').replace(/\\\\/g, '\\').replace(/\\\$/g, '$');
  }
  throw new Error(`no CodeLab program containing ${marker}`);
}
void PyProgram; void checkCases;
