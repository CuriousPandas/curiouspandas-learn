// The lessons say this is Python. So every program here runs through the sandbox
// and through the real interpreter, and stdout plus the final error line must
// match byte for byte. Fails rather than skips when Python is missing: a parity
// test that quietly skips reads as parity.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { PyProgram } from '../src/lib/py/vm.ts';

function findPython(): string {
  // On Windows `python3` can be the Store stub, which exits non-zero with no
  // version, so each candidate has to prove it runs.
  for (const c of ['python3', 'python']) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0], sys.version_info[1])'], { encoding: 'utf8' });
    if (r.status === 0 && /^3 \d+/.test(r.stdout)) return c;
  }
  throw new Error('No Python 3 found; these tests compare against the real interpreter and cannot pass without it');
}
const PY = findPython();

// Messages Python changed between 3.11 and 3.14, or that come from the platform's
// C library (OverflowError's errno text differs on Windows and Linux). For these
// only the type must match, so the test holds on any runner and minor version.
const TYPE_ONLY = /^(ZeroDivisionError|RecursionError|OverflowError: \(34|ValueError: (min|max)\(\)|TypeError: 'str' object cannot|SyntaxError|IndentationError)/;
// "Did you mean" comes from the traceback printer and its suggestions change with
// the version (3.12 added 'self.x'). The sandbox doesn't offer them, yet.
const lastErr = (stderr: string) => (stderr.trim().split(/\r?\n/).at(-1) ?? '').replace(/\. Did you mean: .*\?$/, '');

function real(src: string) {
  // -X utf8, not the PYTHONUTF8 variable: -I ignores the environment, and without
  // UTF-8 a Windows console encoding garbles the output this compares.
  const r = spawnSync(PY, ['-I', '-X', 'utf8', '-c', src], { encoding: 'utf8' });
  return { out: r.stdout.replace(/\r\n/g, '\n'), err: lastErr(r.stderr ?? '') };
}
function ours(src: string) {
  const p = new PyProgram(src);
  p.run();
  assert.notEqual(p.status, 'budget', `budget hit: ${src}`);
  return { out: p.stdout, err: p.error ? (p.error.message ? `${p.error.type}: ${p.error.message}` : p.error.type) : '' };
}
function same(src: string) {
  const a = real(src), b = ours(src);
  assert.equal(b.out, a.out, `stdout differs for:\n${src}`);
  if (TYPE_ONLY.test(a.err) || TYPE_ONLY.test(b.err)) assert.equal(b.err.split(':')[0], a.err.split(':')[0], `error type differs for:\n${src}\nreal: ${a.err}\nours: ${b.err}`);
  else assert.equal(b.err, a.err, `error differs for:\n${src}`);
}

const PROGRAMS: Record<string, string[]> = {
  'integers and floats': [
    'print(7 // 2, -7 // 2, 7 // -2, -7 // -2, 7 % 3, -7 % 3, 7 % -3, -7 % -3)',
    'print(7 / 2, 2 ** 10, 2 ** -1, (-2) ** 3, -2 ** 2, 2 ** 3 ** 2)',
    'print(2 ** 100, -(2 ** 64), 10 ** 30 // 7)',
    'print(0.1 + 0.2, 1.0, 1e16, 1e15, 1e-4, 1e-5, 123456789.123456789, 1.5e300, -0.0, 2.5e-07)',
    'print(1.0 // 0.1, 1.0 % 0.1, -1.5 // 1, 5.5 % -2, 7.0 // 2, 3 * 0.1)',
    'print(1 == 1.0, True == 1, 0.1 + 0.2 == 0.3, 2 ** 53 == 2.0 ** 53, 2 ** 53 + 1 == 2.0 ** 53)',
    'print(True + True, True * 3, int(3.9), int(-3.9), int("42"), int(" 7 "), float("1.5"), int("ff", 16), int("101", 2))',
    'print(round(2.5), round(3.5), round(-2.5), round(2.675, 2), round(0.125, 2), round(1234, -2), round(1250, -2))',
    'print(abs(-3), abs(-3.5), min(3, 1, 2), max([1, 5, 2]), sum([1, 2, 3]), divmod(7, 2), divmod(-7, 2), pow(2, 10, 1000))',
    'print(5 & 3, 5 | 3, 5 ^ 3, ~5, 1 << 40, -16 >> 2, bin(10), hex(255), oct(8), bin(-5), (255).bit_length())',
    'print(type(1), type(1.0), type("x"), type(None), type([]), type(True))',
    'print(float("inf"), -float("inf"), float("nan"), float("inf") - float("inf"))',
    'x = 2 ** 1000\nprint(len(str(x)), x % 1000)',
  ],
  'strings': [
    'print("a" + "b", "ab" * 3, len("hello"), "hello"[1], "hello"[-1], "hello"[1:3], "hello"[::-1], "hello"[::2])',
    'print("Hi There".upper(), "Hi".lower(), " x ".strip(), "a,b,c".split(","), "a b  c".split(), "-".join(["a", "b"]))',
    'print("hello".replace("l", "L"), "hello".find("l"), "hello".find("z"), "hello".count("l"), "abc".startswith("a"), "abc".endswith("c"), "1".isdigit(), "a".isalpha())',
    'print(repr("a"), repr("it\'s"), repr("say \\"hi\\""), repr("a\\nb"), ["x", "it\'s"], "tab\\there")',
    'print(f"{1 + 1} {\'x\'} {3.14159:.2f} {7:>4} {7:<4}| {7:^5}| {255:x} {255:b} {1234567:,} {0.5:.0%} {42:05d}")',
    'print(f"{\'hi\':>5}|{\'hi\':<5}|{\'hi\':^6}|{\'hi\'!r}|{{literal}}", f"{0.125:.2f} {2.5:.0f} {3.5:.0f} {1e10:.1e}")',
    'print(ord("A"), chr(97), "abc" < "abd", "Z" < "a", "" < "a", "é", len("é"), "😀"[0], len("😀x"))',
    'print("hello world".title(), "abc".capitalize(), "7".zfill(3), "x".ljust(3) + "|", "x".rjust(3), "x".center(4, "*"))',
    's = "abc"\ns[0] = "x"',
    'print("a" + 1)',
    'print("abc"[10])',
    'print(1 + "a")',
    'print("a" * "b")',
    'int("x")',
    'float("x")',
  ],
  'lists, tuples, dicts, sets': [
    'a = [1, 2, 3]\na.append(4)\na.insert(0, 0)\nprint(a, a.pop(), a.pop(0), a, len(a), a[-1], a[1:], a[:1], a[::-1])',
    'a = [3, 1, 2]\nb = sorted(a)\na.sort(reverse=True)\nprint(a, b, sorted("bca"), sorted([(2, "a"), (1, "b")]))',
    'a = [1, 2]\nb = a\nb.append(3)\nprint(a, a is b, a == [1, 2, 3], a is [1, 2, 3])',
    'a = [1, 2]\nb = a\na += [3]\nprint(a, b)\na = a + [4]\nprint(a, b)',
    'a = [[0]] * 3\na[0].append(1)\nprint(a)\nb = [[0] for _ in range(3)]\nb[0].append(1)\nprint(b)',
    'a = [1, 2, 3, 4, 5]\na[1:3] = [9]\nprint(a)\ndel a[0]\nprint(a)\ndel a[::2]\nprint(a)\na[0] = 7\nprint(a, a.index(7), a.count(7))',
    'a = [1, 2, 3, 4]\nfor x in a:\n    if x % 2 == 0:\n        a.remove(x)\nprint(a)',
    't = (1, 2)\nu = (1,)\nprint(t, u, (), t + u, t[0], len(t), (1, 2) < (1, 3), [1, 2] < [1, 2, 3])',
    'a, b = 1, 2\na, b = b, a\n(c, d), e = (3, 4), 5\nprint(a, b, c, d, e)',
    'a, b = [1, 2, 3]',
    'a, b, c = [1, 2]',
    'a, b = 5',
    'd = {"a": 1}\nd["b"] = 2\nprint(d, d["a"], d.get("z"), d.get("z", 0), len(d), "a" in d, 1 in d, list(d), list(d.keys()), list(d.values()), list(d.items()))',
    'd = {"a": 1, "b": 2}\nprint(d.keys(), d.values(), d.items())\nd.pop("a")\nprint(d)\nd.setdefault("c", 3)\nprint(d, {k: v * 2 for k, v in d.items()})',
    'd = {1: "int"}\nd[1.0] = "float"\nd[True] = "bool"\nprint(d)',
    'd = {}\nprint(d["missing"])',
    'd = {[1]: 2}',
    's = {1}\ns.add([1])',
    'd = {"a": 1, "b": 2}\nfor k in d:\n    d["c"] = 3',
    's = {1, 2}\ns.add(1)\nprint(len(s), 1 in s, 3 in s, set(), {1} | {1}, {1, 2} & {1}, {1} - {1})',
    'print([x * x for x in range(5)], [x for x in range(10) if x % 3 == 0], [(x, y) for x in range(2) for y in range(2)], {x % 2 for x in [2]})',
    'print(list(range(3)), list(range(1, 4)), list(range(10, 0, -3)), range(3), len(range(0, 10, 2)), range(5)[2], 3 in range(5), list(range(5))[1:3])',
    'print(list(enumerate("ab")), list(zip([1, 2], "ab")), list(map(abs, [-1])), list(filter(None, [0, 1])), list(reversed([1, 2])), any([0, 1]), all([0, 1]))',
    'print([1, 2, 3][10])',
    'print((1, 2)[5])',
    '[1, 2].pop(9)',
    '[].pop()',
    '[1].remove(2)',
    'print(len(5))',
    'for x in 5:\n    pass',
    'print(5[0])',
    '(1, 2)[0] = 3',
    'x = [1, 2]\nprint(x["a"])',
    'a = [1]\na.append(a)\nprint(a)',
    'print(sorted([3, "a"]))',
    'print(3 < "a")',
    'print(None + 1)',
  ],
  'control flow': [
    'for i in range(3):\n    if i == 1:\n        continue\n    print(i)\nelse_ = 5\nprint(else_)',
    'i = 0\nwhile True:\n    i += 1\n    if i > 3:\n        break\nprint(i)',
    'x = 5\nif x > 10:\n    print("big")\nelif x > 3:\n    print("mid")\nelse:\n    print("small")',
    'print(1 if True else 2, 0 or "x", 1 and "y", not 0, None or [], [] and 1, 1 < 2 < 3, 3 > 2 > 2, 1 == 1 != 2)',
    'def f(x):\n    print("called", x)\n    return x\nprint(f(1) < f(2) < f(3), f(0) and f(9), f(1) or f(9))',
    'print(bool(0), bool(""), bool([]), bool({}), bool(None), bool(0.0), bool("0"), bool([0]))',
    'for i in range(2):\n    for j in range(2):\n        if j == 1:\n            break\n        print(i, j)',
  ],
  'functions and scope': [
    'def f(a, b=2):\n    return a + b\nprint(f(1), f(1, 1), f(a=3), f(b=1, a=1))',
    'def f(a, b):\n    pass\nf(1)',
    'def f(a, b, c):\n    pass\nf()',
    'def f(a, b, c):\n    pass\nf(1)',
    'def f(a):\n    pass\nf(1, 2)',
    'def f(a, b=1):\n    pass\nf(1, 2, 3)',
    'def f(a):\n    pass\nf(1, a=2)',
    'def f(a):\n    pass\nf(z=2, a=1)',
    'x = 1\ndef f():\n    print(x)\nf()',
    'x = 1\ndef f():\n    print(x)\n    x = 2\nf()',
    'x = 1\ndef f():\n    global x\n    x = 2\nf()\nprint(x)',
    'def outer():\n    n = 0\n    def inc():\n        nonlocal n\n        n += 1\n        return n\n    return inc\nc = outer()\nprint(c(), c(), outer()())',
    'def f(x, acc=[]):\n    acc.append(x)\n    return acc\nprint(f(1), f(2))',
    'fs = [lambda: i for i in range(3)]\nprint([g() for g in fs])',
    'add = lambda a, b=1: a + b\nprint(add(1), add(1, 2), (lambda: 5)(), list(map(lambda x: x + 1, [1])), sorted([3, 1], key=lambda x: -x))',
    'def f():\n    pass\nprint(f(), f.__name__)',
    'print(undefined_name)',
    '5()',
    'def fact(n):\n    return 1 if n <= 1 else n * fact(n - 1)\nprint(fact(20), fact(30))',
    'def fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\nprint([fib(i) for i in range(15)])',
    'def f(n):\n    return f(n + 1)\nf(0)',
    'def f(x):\n    y = x\n    return y\nf(1)\nprint(y)',
    'def f():\n    return\nprint(f())',
  ],
  'classes': [
    'class P:\n    n = 0\n    def __init__(self, x):\n        self.x = x\n        P.n += 1\n    def get(self):\n        return self.x\np = P(3)\nq = P(4)\nprint(p.get(), q.x, P.n, p.n, isinstance(p, P), type(p).__name__)',
    'class A:\n    def hi(self):\n        return "A"\n    def who(self):\n        return self.hi()\nclass B(A):\n    def hi(self):\n        return "B" + super().hi()\nprint(B().who(), isinstance(B(), A), issubclass(B, A), B.__name__)',
    'class A:\n    def __init__(self, v):\n        self.v = v\nclass B(A):\n    def __init__(self, v):\n        super().__init__(v + 1)\nprint(B(1).v)',
    'class V:\n    def __init__(self, x):\n        self.x = x\n    def __repr__(self):\n        return f"V({self.x})"\n    def __eq__(self, o):\n        return self.x == o.x\n    def __lt__(self, o):\n        return self.x < o.x\n    def __add__(self, o):\n        return V(self.x + o.x)\n    def __len__(self):\n        return self.x\nprint(V(1), [V(2)], V(1) == V(1), V(1) != V(2), sorted([V(2), V(1)]), V(1) + V(2), len(V(3)), bool(V(0)), str(V(5)), f"{V(6)}")',
    'class S:\n    def __str__(self):\n        return "str!"\nprint(S(), str(S()), f"{S()}")',
    'class I:\n    def __init__(self):\n        self.i = 0\n    def __iter__(self):\n        return self\n    def __next__(self):\n        self.i += 1\n        if self.i > 3:\n            raise StopIteration\n        return self.i\nprint(list(I()), [x for x in I()])',
    'class C:\n    def __getitem__(self, i):\n        return i * 2\n    def __contains__(self, x):\n        return x == 1\n    def __call__(self, y):\n        return y + 1\nprint(C()[2], 1 in C(), 2 in C(), C()(1))',
    // tests the step counter's claim directly: scanning a list of n different items
    // for each new item makes exactly (n^2 - n) / 2 comparisons.
    'n = 0\nclass C:\n    def __eq__(self, o):\n        global n\n        n += 1\n        return False\nfor size in [10, 100, 300]:\n    n = 0\n    seen = []\n    for i in range(size):\n        c = C()\n        if c in seen:\n            pass\n        seen.append(c)\n    print(size, n)',
    'class A:\n    pass\nA().x',
    'class A:\n    pass\nA(1)',
    'class A:\n    def m(self):\n        pass\nA().m(1)',
    'class A:\n    def __eq__(self, o):\n        return True\n{A(): 1}',
    'class A:\n    x = 1\n    def f(self):\n        return x\nA().f()',
  ],
  'exceptions': [
    'try:\n    1 / 0\nexcept ZeroDivisionError as e:\n    print("caught", type(e).__name__)\nprint("after")',
    'try:\n    [][1]\nexcept (KeyError, IndexError) as e:\n    print(e, repr(e))',
    'try:\n    {}["a"]\nexcept LookupError as e:\n    print(e, repr(e), e.args)',
    'try:\n    int("x")\nexcept TypeError:\n    print("no")\nexcept ValueError as e:\n    print(e)\nelse:\n    print("else")',
    'try:\n    x = 1\nexcept ValueError:\n    print("no")\nelse:\n    print("else", x)',
    'try:\n    raise ValueError("bad")\nexcept Exception as e:\n    print(e, e.args)\ntry:\n    print(e)\nexcept NameError as n:\n    print("deleted:", n)',
    'class My(Exception):\n    pass\ntry:\n    raise My("hi", 2)\nexcept My as e:\n    print(e, e.args, isinstance(e, Exception))',
    'def f():\n    raise KeyError("k")\ndef g():\n    try:\n        f()\n    except ValueError:\n        print("no")\ntry:\n    g()\nexcept KeyError as e:\n    print("up:", e)',
    'for i in range(3):\n    try:\n        if i == 1:\n            continue\n        if i == 2:\n            break\n        print(i)\n    except ValueError:\n        pass\ntry:\n    raise ValueError\nexcept ValueError as e:\n    print(repr(e), str(e) == "")',
    'def f():\n    try:\n        return 1\n    except ValueError:\n        return 2\nprint(f())',
    'raise ValueError("loud")',
    'raise KeyError("k")',
    'raise ValueError',
    'raise 5',
    'assert 1 == 2',
    'assert 1 == 2, "nope"',
    'assert 1 == 1\nprint("ok")',
    'print(2 ** 20000)',
    '1 / 0',
    '1 // 0',
    '1 % 0',
    '1.0 / 0',
    '0 ** -1',
    'print(1e308 * 10, 2.0 ** 10)',
    '2.0 ** 100000',
    'float(10 ** 400)',
    'print(min([]))',
  ],
  'syntax errors stay errors': [
    'if True\n    print(1)',
    'def f(:\n    pass',
    'x = (1, 2',
    'print("a)',
    'if True:\nprint(1)',
    'x = 1\n  y = 2',
    'if True:\n    x = 1\n  y = 2',
    '1 = 2',
    'f() = 2',
    'return 5',
    'break',
    '012',
    'def f(a=1, b):\n    pass',
  ],
};

// Reports every program that differs: stopping at the first hid the rest of the
// group behind one failure, and each CI round costs minutes.
for (const [name, programs] of Object.entries(PROGRAMS)) {
  test(`matches real Python: ${name}`, () => {
    const wrong: string[] = [];
    for (const src of programs) {
      try { same(src); } catch (e) { wrong.push((e as Error).message); }
    }
    assert.equal(wrong.length, 0, `${wrong.length} of ${programs.length} differ:\n\n${wrong.join('\n\n')}`);
  });
}

// sum() of floats changed in 3.12. The sandbox follows current Python, so this can
// only be compared on 3.12 or later; on older interpreters the answers are pinned.
const minor = Number(spawnSync(PY, ['-c', 'import sys; print(sys.version_info[1])'], { encoding: 'utf8' }).stdout);
const SUMS: [string, string][] = [
  ['print(sum([0.1] * 10))', '1.0\n'],
  ['print(sum([0.1, 0.2, 0.3]))', '0.6\n'],
  ['print(sum([1e100, 1.0, -1e100]))', '1.0\n'],
  ['print(sum([1, 0.1, 2, 0.2]))', '3.3000000000000003\n'],
  ['print(sum([0.1, 1, 0.2, True]))', '2.3\n'],
  ['print(sum([1, 2], 0.5), sum([], 1.5), sum([True, True]))', '3.5 1.5 2\n'],
];
test('sum() of floats is compensated, as in Python 3.12 and later', () => {
  for (const [src, want] of SUMS) {
    assert.equal(ours(src).out, want, src);
    if (minor >= 12) same(src);
  }
});

test('python: recursion stops near the same depth as real Python', () => {
  const src = 'n = 0\ndef f():\n    global n\n    n += 1\n    f()\ntry:\n    f()\nexcept RecursionError:\n    print(n)';
  const a = Number(real(src).out), b = Number(ours(src).out);
  assert.ok(Math.abs(a - b) <= 5, `real ${a}, ours ${b}`);
});
