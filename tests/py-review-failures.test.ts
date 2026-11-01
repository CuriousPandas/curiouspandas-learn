// Each failure the accuracy review of Programming from Zero found in the lab, by name, with the
// answer real Python gives. tests/py-fuzz.test.ts closes the classes; this says which symptoms
// they were, so the test name turns up when someone searches for the symptom.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PyProgram } from '../src/lib/py/vm.ts';
import { runAll } from '../src/lib/py/lab.ts';
import { python, pythonVersion, runPython } from './helpers/python.ts';

python();

const lastLine = (stderr: string) => stderr.trim().split(/\r?\n/).at(-1) ?? '';
function both(src: string) {
  const r = runPython(src), p = new PyProgram(src);
  p.run();
  return { realOut: r.stdout, realErr: lastLine(r.stderr).split(':')[0], labOut: p.stdout, labErr: p.error?.type ?? '', status: p.status };
}

// P1: valid Python, silently a different answer. [code, the lab's old answer, the real one]
const P1: [string, string, string][] = [
  ['"hello".find("l", 3)', '2', '3'], ['"hello".find("h", 1)', '0', '-1'], ['"hello".find("l", 0, 2)', '2', '-1'], ['"hello".index("l", 3)', '2', '3'], ['"hello".count("l", 3)', '2', '1'],
  ['"hello".startswith("e", 1)', 'False', 'True'], ['"hello".endswith("l", 0, 3)', 'False', 'True'], ['[1, 2, 1].index(1, 1)', '0', '2'], ['sum([1], start=2)', '1', '3'],
  ['sorted({1}.union([2], [3]))', '[1, 2]', '[1, 2, 3]'], ['{1, 2}.difference([1], [2])', '{2}', 'set()'], ['str(object=1)', '', '1'], ['"abc".replace("", "-")', 'a-b-c', '-a-b-c-'],
];
test('P1: an argument is never silently dropped', () => {
  for (const [code, old, want] of P1) {
    const r = both(`print(${code})`);
    assert.equal(r.realOut, `${want}\n`, `real Python, ${code}`);
    assert.equal(r.labOut, `${want}\n`, `${code} used to give ${old}`);
  }
});

// P2: each of these ran without error in the lab, and fails on real Python.
const P2 = [
  '"a1".find(1)', '"a1".index(1)', '"a".count(1)', '"a".replace(1, 2)', '"a1b".split(1)', '"a".find()', '"a".count()', '[1].count()', '"a".upper(1)', '"a".lower("x")', '[1].copy(1)', '[1].clear(1)', '{}.keys(1)',
  '" a ".strip(" ", "a")', '"a".ljust("b")', '"a".zfill("b")', 'float(1, 2)', 'bool(1, 2)', 'str(1, 2)', 'list(x=1)', 'int(x=1)', 'round(1.5, 1.0)', 'round(1.5, "a")', 'list(reversed({1}))',
];
const P2_SYNTAX = ['count = 0\ndef bump():\n    count = 1\n    global count', 'count = 0\ndef bump():\n    print(count)\n    global count', 'def f(x):\n    global x', 'print(1, sep="", sep="")'];
test('P2: what fails on real Python fails here, the same way', () => {
  for (const code of P2) {
    const r = both(`print(${code})`);
    assert.equal(r.realErr, 'TypeError', code);
    assert.equal(r.labErr, 'TypeError', `${code} ran in the lab, and printed ${JSON.stringify(r.labOut)}`);
  }
  for (const src of P2_SYNTAX) {
    const r = both(src);
    assert.equal(r.realErr, 'SyntaxError', src);
    assert.equal(r.labErr, 'SyntaxError', src);
  }
  assert.equal(runAll('count = 0\ndef bump():\n    count = 1\n    global count').error?.message, "name 'count' is assigned to before global declaration");
  assert.equal(runAll('count = 0\ndef bump():\n    print(count)\n    global count').error?.message, "name 'count' is used prior to global declaration");
  assert.equal(runAll('print(1, sep="", sep="")').error?.message, 'keyword argument repeated: sep');
});

// P3: correct Python, reported as the learner's error. Works now, or is refused by name.
const P3_WORKS: [string, string][] = [
  ['if __name__ == "__main__":\n    print("main")', 'main\n'], ['a, *b = [1, 2, 3]\nprint(a, b)', '1 [2, 3]\n'], ['print({**{"a": 1}})', "{'a': 1}\n"], ['print(sorted({1, 2} ^ {2, 3}))', '[1, 3]\n'],
  ['print({"a": 1} | {"b": 2})', "{'a': 1, 'b': 2}\n"], ['print(sorted(["b", "A"], key=str.lower))', "['A', 'b']\n"], ['print(dict.fromkeys(["a"], 0))', "{'a': 0}\n"], ['print({1} < {1, 2})', 'True\n'],
  ['try:\n    int("x")\nexcept (ValueError, FileNotFoundError):\n    print("caught")', 'caught\n'],
];
const P3_REFUSED = ['match 1:\n    case 1:\n        pass', 'exit()', 'quit()', 'def f():\n    pass\nf.__defaults__', 'x = ...', 'print(NotImplemented)', 'x = 1j', 'def f(a, /):\n    pass', 'type X = int', 'class A(metaclass=type):\n    pass'];
test('P3: correct Python never reads as the learner\'s mistake', () => {
  for (const [src, want] of P3_WORKS) {
    assert.equal(runPython(src).stdout, want, `real Python: ${src}`);
    assert.equal(runAll(src).stdout, want, src);
  }
  for (const src of P3_REFUSED) {
    const r = runAll(src);
    assert.equal(r.error?.type, 'SandboxLimit', `${src} -> ${r.error?.type}: ${r.error?.message}`);
  }
  // The f-string form is valid from 3.12 on, and the site follows current Python.
  const nested = 'd = {"a": 1}\nprint(f"{d["a"]}")';
  assert.equal(runAll(nested).stdout, '1\n');
  if (pythonVersion()[1] >= 12) assert.equal(runPython(nested).stdout, '1\n');
});

test('P4: a wrong argument raises Python\'s TypeError, in all four groups the review found frozen', () => {
  for (const code of ['"a1".strip(1)', '"a1".lstrip(1)', '"a1".rstrip(1)', '"a".center(5, 1)', '[1].index()', 'round(1, "x")']) {
    const r = both(`print(${code})`);
    assert.equal(r.realErr, 'TypeError', code);
    assert.equal(r.labErr, 'TypeError', code);
    assert.equal(r.status, 'error', code);
  }
});

// The failure has to be impossible to hang, whatever the next bug is: every instruction goes
// through Array.prototype.at, so breaking it stands in for any raw JavaScript error.
function withEngineFault(fn: () => void) {
  const real = Array.prototype.at;
  Array.prototype.at = function () { throw new TypeError('injected fault'); };
  try { fn(); } finally { Array.prototype.at = real; }
}
test('P4: a raw JavaScript error ends the run as a sandbox bug, and never reads as the learner\'s error', () => {
  const p = new PyProgram('print(1)\nprint(2)');
  withEngineFault(() => p.run());
  assert.equal(p.status, 'crash');
  assert.equal(p.finished, true, 'a crashed program must not look as if it is still going');
  assert.equal(p.error?.type, 'SandboxBug');
  assert.match(p.error!.message, /injected fault/);
  assert.equal(p.run(), 'crash', 'running it again stays ended, rather than hanging');
  // Stepping takes the same road.
  const q = new PyProgram('print(1)');
  withEngineFault(() => q.stepLine());
  assert.equal(q.status, 'crash');
  // A mission's check is told, rather than the panel dying.
  const done = runAll('def f():\n    return 1\n');
  const checked = new PyProgram(done.src);
  checked.run();
  let got: ReturnType<PyProgram['call']> | undefined;
  withEngineFault(() => { got = checked.call('f', []); });
  assert.equal(got!.ok, false);
  assert.equal((got as { error: { type: string } }).error.type, 'SandboxBug');
  // Given code that fails is the site's bug, so it reports as one.
  const bad = new PyProgram('print(1)', { given: '1 / 0' });
  assert.equal(bad.status, 'crash');
  assert.match(bad.error!.message, /given code failed/);
  assert.equal(new PyProgram('print(1)', { given: 'def (' }).status, 'crash');
});

test('a size JavaScript refuses is a sandbox limit, and never a RecursionError', () => {
  for (const src of ['"a".ljust(10 ** 9)', '"a".center(10 ** 9)', '"a".zfill(10 ** 9)', 'round(1, -(10 ** 9))']) {
    const p = new PyProgram(src);
    p.run();
    assert.equal(p.error?.type, 'SandboxLimit', src);
  }
});

test('found by the fuzz: [] * 10 ** 30 froze the tab in a loop of 10 ** 30 empty passes', () => {
  for (const src of ['[] * 10 ** 30', '() * 10 ** 30', '"" * 10 ** 30', '10 ** 30 * []']) {
    const p = new PyProgram(src);
    p.run();
    assert.equal(p.error?.type, 'OverflowError', src);
    assert.equal(lastLine(runPython(src).stderr).split(':')[0], 'OverflowError', `real Python, ${src}`);
  }
  assert.equal(runAll('print([] * 10 ** 9, "" * 10 ** 9)').stdout, runPython('print([] * 10 ** 9, "" * 10 ** 9)').stdout);
});

test('found by the fuzz: quiet wrong answers the review hadn\'t reached', () => {
  const same = (src: string, want: string) => {
    assert.equal(runPython(src).stdout, want, `real Python: ${src}`);
    assert.equal(runAll(src).stdout, want, src);
  };
  same('print(f"{1e30:.2f}")', '1000000000000000019884624838656.00\n'); // toFixed answered 1e+30.
  same('print(f"{2.5:.0e}")', '2e+00\n'); // toExponential breaks a tie upward.
  same('print(f"{255:#06x}")', '0x00ff\n'); // The fill went before the prefix.
  same('print("éa".title())', 'Éa\n'); // Every non-ASCII letter counted as a gap between words.
  same('print(10 ** 400 / 10 ** 399)', '10.0\n'); // Called an overflow.
  same('print(True & True, True | False, True ^ True)', 'True True False\n'); // Printed 1 1 0.
  same('print(0 // -0.5)', '-0.0\n');
  same('a = [1, 2]\nb = a\na *= 2\nprint(b)', '[1, 2, 1, 2]\n'); // *= made a new list, and b missed it.
  same('d = {"a": 1}\nprint(d.keys() == {"a": 1}.keys())', 'True\n'); // Compared two views by identity.
  same('print(len({("a,sb",): 1, ("a", "b"): 2}))', '2\n'); // Keys joined with commas collided.
  same('class E(Exception):\n    def __init__(self, age):\n        super().__init__(f"bad age: {age}")\nprint(E(5))', 'bad age: 5\n'); // Printed 5.
  same('class A:\n    def __ne__(self, o):\n        return "custom"\nprint(A() != 1)', 'custom\n'); // __ne__ was never called.
  same('class A:\n    def __lt__(self, o):\n        return "lt"\nprint(A() < 1)', 'lt\n'); // Turned into True.
  same('print(type(enumerate("a")), zip, type({}.keys()))', "<class 'enumerate'> <class 'zip'> <class 'dict_keys'>\n");
  same('class A:\n    def __init__(self):\n        self.__x = 1\nprint(A()._A__x)', '1\n');
  assert.equal(runAll('class A:\n    def __init__(self):\n        self.__x = 1\nprint(A().__x)').error?.type, 'AttributeError', 'a.__x from outside worked here');
  // These were silently ignored, which is worse than absent.
  for (const body of ['__slots__ = ["a"]', 'def __setattr__(self, n, v):\n        pass', 'def __getattr__(self, n):\n        return 1']) {
    assert.equal(runAll(`class A:\n    ${body}\nA()`).error?.type, 'SandboxLimit', body);
  }
});

test('a refusal is not an exception a program can catch', () => {
  // `except Exception:` used to catch it, so the program took its except branch and printed a
  // confident wrong answer about something that real Python would simply have done.
  for (const handler of ['except Exception:', 'except:', 'except BaseException:']) {
    const r = runAll(`try:\n    "x".casefold()\n${handler}\n    print("caught")\nprint("after")`);
    assert.equal(r.error?.type, 'SandboxLimit', handler);
    assert.equal(r.stdout, '', handler);
    assert.equal(r.error?.line, 2, 'it still says which line');
  }
});

// P5: positions on the page that teaches code points counted UTF-16 units.
test('P5: find, index, strip and padding count code points, as len does', () => {
  const src = 's = "😀a😀b"\nprint(s.find("a"), s.index("b"), s.strip("😀"), s[s.find("a")])\nprint("😀".ljust(3) + "|", "😀".rjust(3), "😀".center(3), "😀".zfill(3))';
  const r = both(src);
  assert.equal(r.realOut, '1 3 a😀b a\n😀  |   😀  😀  00😀\n');
  assert.equal(r.labOut, r.realOut);
});

// P6: records-and-maps says changing a value while looping is fine. It went on showing the old one.
test('P6: a loop over a dictionary reads the live entry, as real Python does', () => {
  const stale = 'd = {"a": 1}\nd["b"] = 2\nfor key, v in d.items():\n    d["b"] = 99\n    print(key, v)';
  assert.equal(both(stale).realOut, 'a 1\nb 99\n');
  assert.equal(both(stale).labOut, 'a 1\nb 99\n');
  const swapped = 'd = {"a": 1, "b": 2}\nfor k in d:\n    print(k)\n    if k == "a":\n        del d["b"]\n        d["c"] = 3';
  assert.equal(both(swapped).realOut, 'a\nc\n');
  assert.equal(both(swapped).labOut, 'a\nc\n');
});

test('the unrated differences the review listed now read the same as real Python', () => {
  const realMsg = (src: string) => { const l = lastLine(runPython(src).stderr); return l.slice(l.indexOf(':') + 2); };
  for (const src of ['len()', '[].append()', 'set().add()', 'ord()', 'print(“hello”)', 'x = $5', 'x = 5?', 'if !True:\n    pass', 'print(1 =< 2)', 'x = 007', 'def f:\n    pass']) {
    assert.equal(runAll(src).error?.message, realMsg(src), src);
  }
  assert.equal(runAll('if True:').error?.line, 1, 'the line the block was missing from');
  // is on strings was True here and False there. It won't guess now.
  assert.equal(runPython('print("hello world" is " ".join(["hello", "world"]))').stdout, 'False\n');
  assert.equal(runAll('print("hello world" is " ".join(["hello", "world"]))').error?.type, 'SandboxLimit');
  assert.equal(runAll('a = [1]\nb = a\nprint(a is b, a is [1], None is None, a is not None)').stdout, 'True False True True\n');
});
