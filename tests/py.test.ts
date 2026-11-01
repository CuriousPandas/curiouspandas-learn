// What the parity suite can't check, because real Python has no equivalent: the
// step counter, the stepper, the budget and the features refused by name.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PyProgram } from '../src/lib/py/vm.ts';
import { runAll, checkCases, measureGrowth, classify, toPy } from '../src/lib/py/lab.ts';
import { CODE_MISSIONS } from '../src/lib/cs/missions.ts';
import { repr } from '../src/lib/py/values.ts';

test('an endless loop stops at the budget and says so; it is not reported as finished', () => {
  const r = runAll('while True:\n    pass', 10_000);
  assert.equal(r.status, 'budget');
  assert.ok(r.ops >= 10_000);
  assert.equal(r.error, undefined);
});

test('endless recursion is a RecursionError from the limit, not a crash of the page', () => {
  const r = runAll('def f():\n    f()\nf()');
  assert.equal(r.status, 'error');
  assert.equal(r.error?.type, 'RecursionError');
  assert.ok(r.depth > 900 && r.depth <= 1000, `depth ${r.depth}`);
});

test('values too big to compute safely are refused as a sandbox limit, not as the learner\'s bug', () => {
  for (const src of ['x = 2 ** (10 ** 9)', 'x = 1 << (10 ** 9)', 'x = "a" * (10 ** 9)', 'x = [0] * (10 ** 9)', 'x = 3\nwhile True:\n    x = x * x']) {
    const r = runAll(src);
    assert.equal(r.error?.type, 'SandboxLimit', src);
  }
});

test('printing without end stops at the output limit', () => {
  const r = runAll('while True:\n    print("x" * 1000)');
  assert.equal(r.status, 'output');
});

test('features this sandbox lacks are refused by name, never ignored', () => {
  for (const [src, word] of [
    ['import math', 'import'], ['from x import y', 'from'], ['with a as b:\n    pass', 'with'], ['def f():\n    yield 1', 'yield'],
    ['try:\n    pass\nexcept ValueError:\n    pass\nfinally:\n    pass', 'finally'], ['def f(*a):\n    pass', '*args'], ['f(*x)', '*args'],
    ['print(x for x in y)', 'generator'], ['x = (a for a in b)', 'generator'], ['@d\ndef f():\n    pass', 'decorators'], ['for x in y:\n    pass\nelse:\n    pass', 'for ... else'],
    ['while x:\n    pass\nelse:\n    pass', 'while ... else'], ['class A(B, C):\n    pass', 'multiple inheritance'], ['x = (y := 1)', ':='], ['x = b"a"', 'strings'],
    ['input()', 'input'], ['class M(int):\n    pass', 'subclass'], ['"%d" % 1', '%'], ['(-8.0) ** 0.5', 'complex'], ['print(f"{1=}")', 'debugging'],
  ] as const) {
    const r = runAll(src);
    assert.equal(r.error?.type, 'SandboxLimit', `${src} -> ${r.error?.type}: ${r.error?.message}`);
    assert.match(r.error!.message, new RegExp(word.replace(/[*.]/g, '\\$&')), src);
  }
});

// The sandbox's real promise. JavaScript's object model must be unreachable: names
// like constructor and __proto__ mean nothing to the VM's own maps and classes.
test('a program cannot reach JavaScript or the outside world', () => {
  for (const src of [
    '"a".constructor', '[].constructor', '[].__proto__', '{}.__proto__', '(1).constructor', 'print.fn', 'print.constructor',
    'def f():\n    pass\nf.code', 'def f():\n    pass\nf.constructor', 'class A:\n    pass\nA.constructor', 'A = 1\nA.prototype', 'range(1).start.constructor',
    'constructor', '__proto__', 'window', 'document', 'globalThis', 'process', 'fetch("x")', 'localStorage',
    'getattr("", "constructor")', 'getattr(print, "fn")', 'getattr([], "__proto__")',
    'eval("1")', 'exec("1")', 'open("x")', '__import__("os")', 'globals()', 'compile("1", "", "eval")',
  ]) {
    const r = runAll(src);
    assert.equal(r.status, 'error', `${src} ran: ${r.stdout}`);
    assert.ok(['AttributeError', 'NameError', 'SandboxLimit'].includes(r.error!.type), `${src} -> ${r.error!.type}: ${r.error!.message}`);
  }
  // Setting one must not change the object JavaScript shares, or the next program.
  runAll('class A:\n    pass\nA.__proto__ = 1\na = A()\na.constructor = 2\nd = {"__proto__": 1, "constructor": 2}\nprint(d["__proto__"])');
  assert.equal(({} as { polluted?: unknown }).polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
  assert.equal(runAll('d = {"__proto__": 1, "constructor": 2}\nprint(d["__proto__"], d["constructor"], len(d))').stdout, '1 2 2\n');
});

test('an unknown method on a built-in type says the sandbox may just lack it', () => {
  const r = runAll('[].no_such_thing()');
  assert.equal(r.error?.type, 'SandboxLimit');
  assert.match(r.error!.message, /real Python may have it, or you may have a typo/);
});

test('Step stops once per statement, a loop header is revisited, and the highlight is the line about to run', () => {
  const p = new PyProgram('x = 0\nfor i in range(2):\n    x += i\nprint(x)\n');
  const lines = [p.nextLine];
  while (!p.finished) { p.stepLine(); if (!p.finished) lines.push(p.nextLine); }
  assert.deepEqual(lines, [1, 2, 3, 2, 3, 2, 4]);
  assert.equal(p.stdout, '1\n');
  assert.equal(p.status, 'done');
});

test('stepping into a call shows its frame, and the frame is gone after it returns', () => {
  const p = new PyProgram('def f(a):\n    b = a + 1\n    return b\nr = f(1)\nprint(r)\n');
  const seen: string[][] = [];
  while (!p.finished) { p.stepLine(); seen.push(p.view().map((f) => f.name)); }
  assert.ok(seen.some((s) => s.join() === '<module>,f'), JSON.stringify(seen));
  assert.deepEqual(seen.at(-1), ['<module>'], 'after the end, the panel shows what the program left behind');
  assert.deepEqual(p.view()[0].vars.map((v) => [v.name, v.value]), [['f', 'def'], ['r', '2']]);
});

test('Step inside an __init__ works: construction is not a hidden nested run', () => {
  const p = new PyProgram('class A:\n    def __init__(self):\n        self.x = 1\na = A()\nprint(a.x)\n');
  const lines: number[] = [];
  while (!p.finished) { lines.push(p.nextLine); p.stepLine(); }
  assert.ok(lines.includes(3), `never stopped inside __init__: ${lines}`);
  assert.equal(p.stdout, '1\n');
});

test('the variables panel shows frames and leaves out comprehension internals', () => {
  const p = new PyProgram('a = [x * 2 for x in range(2)]\nb = 1\n');
  p.stepLine();
  const names = p.view()[0].vars.map((v) => v.name);
  assert.deepEqual(names, ['a']);
});

test('a long-running program can be sliced and picks up where it stopped', () => {
  const p = new PyProgram('n = 0\nfor i in range(1000):\n    n += i\nprint(n)\n');
  let slices = 0;
  while (!p.finished) { p.run(100); slices++; }
  assert.ok(slices > 5);
  assert.equal(p.stdout, '499500\n');
});

// The counter's whole job. A line that scans has to cost like a scan, or the lab
// would call the quadratic loop in the growth lesson linear.
test('hidden work is charged: in on a list scans, in on a set does not', () => {
  const big = 'xs = list(range(100000))\n';
  const opsOf = (line: string) => {
    const base = runAll(big).ops;
    return runAll(big + line).ops - base;
  };
  assert.ok(opsOf('99999 in xs') > 90_000);
  assert.ok(opsOf('0 in xs') < 10);
  const s = 's = set(xs)\n';
  assert.ok(opsOf(`${s}99999 in s`) - opsOf(s) < 10);
  assert.ok(opsOf('xs.pop(0)') > 90_000);
  assert.ok(opsOf('xs.pop()') < 10);
  assert.ok(opsOf('xs.insert(0, 1)') > 90_000);
  assert.ok(opsOf('xs.index(99999)') > 90_000);
  assert.ok(opsOf('ys = xs[:]') > 90_000);
  assert.ok(opsOf('ys = xs + xs') > 190_000);
  assert.ok(opsOf('sorted(xs)') > 90_000);
  assert.ok(opsOf('len(xs)') < 10);
  assert.ok(opsOf('xs[50000]') < 10);
  assert.ok(opsOf('d = {}\nd[1] = 2\nd[1]') < 20);
  assert.ok(opsOf('50000 in range(100000)') < 10, 'range answers in by arithmetic');
});

test('measureGrowth subtracts setup, and classify names the shapes the lessons teach', () => {
  const m = (src: string, arg: 'list' | 'n' = 'n', sizes = [1000, 10000]) => classify(measureGrowth(src, 'f', sizes, (n) => (arg === 'list' ? [Array.from({ length: n }, (_, i) => i)] : [n])));
  assert.equal(m('def f(n):\n    return n * 2'), 'constant');
  assert.equal(m('def f(n):\n    c = 0\n    while n > 0:\n        n //= 2\n        c += 1\n    return c', 'n', [1000, 100000]), 'logarithmic');
  assert.equal(m('def f(n):\n    t = 0\n    for i in range(n):\n        t += i\n    return t'), 'linear');
  assert.equal(m('def f(n):\n    t = 0\n    for i in range(n):\n        for j in range(n):\n            t += 1\n    return t', 'n', [100, 300]), 'quadratic');
  assert.equal(m('def f(n):\n    t = 0\n    for i in range(n):\n        for j in range(n):\n            for k in range(n):\n                t += 1\n    return t', 'n', [20, 60]), 'cubic or worse');
  const merge = 'def f(xs):\n    if len(xs) < 2:\n        return xs\n    m = len(xs) // 2\n    a = f(xs[:m])\n    b = f(xs[m:])\n    r = []\n    i = 0\n    j = 0\n    while i < len(a) and j < len(b):\n        if a[i] <= b[j]:\n            r.append(a[i])\n            i += 1\n        else:\n            r.append(b[j])\n            j += 1\n    return r + a[i:] + b[j:]';
  assert.equal(m(merge, 'list', [1000, 8000]), 'n log n');
});

test('a function over budget measures as null, never as cheap', () => {
  const pts = measureGrowth('def f(n):\n    while True:\n        pass', 'f', [10], (n) => [n], 5000);
  assert.deepEqual(pts, [{ n: 10, ops: null }]);
  assert.equal(classify(pts), 'unknown');
});

test('checkCases judges behaviour on fresh state and explains the first failure', () => {
  const good = runAll('def f(xs):\n    return sorted(xs)');
  assert.ok(checkCases(good, 'f', [{ args: [[2, 1]], want: '[1, 2]' }]).ok);
  const stateful = runAll('seen = []\ndef f(x):\n    seen.append(x)\n    return len(seen)');
  assert.ok(checkCases(stateful, 'f', [{ args: [1], want: '1' }, { args: [2], want: '1' }]).ok, 'each case starts clean');
  const wrong = checkCases(runAll('def f(x):\n    return x'), 'f', [{ args: [1], want: '2' }]);
  assert.equal(wrong.ok, false);
  assert.match(wrong.why, /f\(1\) returned 1; expected 2/);
  const boom = checkCases(runAll('def f(x):\n    return 1 / x'), 'f', [{ args: [0], want: '0' }]);
  assert.match(boom.why, /ZeroDivisionError/);
  assert.equal(checkCases(runAll('x ='), 'f', [{ args: [], want: '0' }]).ok, false);
});

test('toPy maps integers to Python ints and keeps floats as floats', () => {
  assert.equal(repr(toPy([1, 2.5, 'a', [true, null]])), "[1, 2.5, 'a', [True, None]]");
});

// ---- the growth mission, played -----------------------------------------------

const play = (m: typeof CODE_MISSIONS[string], ...moves: ((s: ReturnType<typeof m.setup>) => void)[]) => {
  const s = m.setup();
  return moves.map((mv) => { mv(s); return m.steps.map((st) => st.done(s)); });
};
const list = (n: number) => [Array.from({ length: n }, (_, i) => i)];
const sizes = [200, 400, 800, 1600];

test('growth mission: the starter is quadratic, a set fixes it, and shortcuts do not pass', () => {
  const m = CODE_MISSIONS['cs-growth-duplicates'];
  const fixed = m.starter!.replace('seen = []', 'seen = set()').replace('seen.append(x)', 'seen.add(x)');
  const measured = (src: string) => (s: ReturnType<typeof m.setup>) => {
    const points = measureGrowth(src, 'has_duplicate', sizes, list);
    s.runs.push(runAll(src));
    s.growth.push({ src, fn: 'has_duplicate', points, shape: classify(points) });
  };
  const [ran, q, ok] = play(m, (s) => { s.runs.push(runAll(m.starter!)); }, measured(m.starter!), measured(fixed));
  assert.deepEqual(ran, [true, false, false]);
  assert.deepEqual(q.slice(0, 2), [true, true]);
  assert.equal(q[2], false, 'the quadratic starter must not pass step 3');
  assert.deepEqual(ok, [true, true, true]);

  // Linear, and wrong: always False never finds a duplicate.
  const cheat = 'def has_duplicate(items):\n    n = 0\n    for x in items:\n        n += 1\n    return False\n';
  const [, , bad] = play(m, (s) => { s.runs.push(runAll(m.starter!)); }, measured(m.starter!), measured(cheat));
  assert.equal(bad[2], false, 'a fast wrong answer must not pass');
});
