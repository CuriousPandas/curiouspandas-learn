// What the Programming from Zero lessons show, run for real. Every sample goes through
// real Python and through the lab, and has to agree, because these lessons promise that
// what a learner writes here works on a real install. The claims in the prose are
// computed again here: a sentence that drifts from Python is a false statement to
// someone with no way of telling.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PyProgram } from '../src/lib/py/vm.ts';
import { TRACKS } from '../src/data/tracks.ts';
import { python, runPython } from './helpers/python.ts';

python();

const LESSONS = ['first-program', 'values-and-variables', 'decisions', 'loops', 'functions', 'lists', 'records-and-maps', 'text'];
const read = (slug: string) => readFileSync(`src/content/lessons/programming/${slug}.mdx`, 'utf8');
// A sample is a JavaScript template literal, so \\n in the file is \n in the lab. Without
// cooking it, this test would run different text from what the learner sees.
const cook = (raw: string) => (0, eval)('`' + raw + '`') as string;

function lab(src: string) {
  const p = new PyProgram(src);
  p.run();
  return p;
}

for (const slug of LESSONS) {
  const src = read(slug);
  const labs = [...src.matchAll(/code=\{`([\s\S]*?)`\}/g)].map((m) => cook(m[1]));
  const fences = [...src.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]);

  test(`${slug}: every code-lab sample prints the same in the lab and in real Python, and ends the same way`, () => {
    assert.ok(labs.length >= 3, `only ${labs.length} labs: every lesson has the learner running code`);
    for (const code of labs) {
      const r = runPython(code), p = lab(code);
      assert.equal(p.stdout, r.stdout, `differs for:\n${code}`);
      // A sample may end in an error on purpose: then both must end in the same one, word for word.
      if (r.status !== 0) {
        const last = r.stderr.trim().split(/\r?\n/).at(-1)!.replace(/\. Did you mean: .*\?$/, '');
        assert.equal(`${p.error?.type}: ${p.error?.message}`, last, code);
      } else assert.equal(p.status, 'done', `${p.error?.type}: ${p.error?.message}\n${code}`);
    }
  });

  test(`${slug}: every block written for a real terminal runs on real Python`, () => {
    for (const code of fences) {
      const r = runPython(code);
      assert.equal(r.status, 0, `${r.stderr}\n${code}`);
      assert.ok(r.stdout.length > 0, 'printed something');
    }
  });

  test(`${slug}: follows the site's writing rules, and has the parts a lesson must have`, () => {
    assert.ok(!src.includes('—'), 'no em dashes');
    assert.doesNotMatch(src, /\bsimply\b/i);
    assert.match(src, /^builds_on: \[.*\]$/m);
    assert.match(src, /<GoDeeper/);
    assert.match(src, /## What to remember/);
    assert.ok((src.match(/<Quiz\b/g) ?? []).length >= 3);
    assert.match(src, /<Callout kind="real"/, 'says where the sandbox differs from the real thing');
    assert.match(src, /<CodeLab mission="prog-/, 'has a mission');
    // An entity inside a JavaScript string is shown literally, as &quot;.
    for (const m of src.matchAll(/options=\{\[.*\]\}|explain="[^"]*"/g)) assert.ok(!m[0].includes('&quot;') || m[0].startsWith('explain'), m[0]);
  });

  test(`${slug}: links go to lessons that exist and are ready, and doesn't teach recursion`, () => {
    const ready = new Set(TRACKS.flatMap((t) => t.lessons.filter((l) => l.status === 'ready').map((l) => `${t.id}/${l.slug}`)));
    for (const m of src.matchAll(/\]\(\/learn\/([\w-]+\/[\w-]+)\/\)/g)) assert.ok(ready.has(m[1]), `links to ${m[1]}, which isn't ready`);
    // input-and-errors is allowed: two lessons have to say where input() really does work, and
    // the check above holds that link to a lesson that exists and is ready.
    assert.doesNotMatch(src, /\/learn\/programming\/(debugging|your-first-tests|readable-code|recursion|real-program|shell-scripts|whose-code)\//, 'the other half of the trail is not this writer\'s to promise');
    assert.doesNotMatch(src, /\brecurs/i);
  });
}

test('frontmatter builds_on matches the planned order', () => {
  const want: Record<string, string> = {
    'first-program': '[]', 'values-and-variables': '[programming/first-program]', decisions: '[programming/values-and-variables]', loops: '[programming/decisions]',
    functions: '[programming/loops]', lists: '[programming/functions]', 'records-and-maps': '[programming/lists]', text: '[programming/lists]',
  };
  for (const [slug, b] of Object.entries(want)) assert.match(read(slug), new RegExp(`^builds_on: ${b.replace(/[[\]]/g, '\\$&')}$`, 'm'), slug);
});

test('titles are the ones in tracks.ts', () => {
  const track = TRACKS.find((t) => t.id === 'programming')!;
  for (const slug of LESSONS) {
    const l = track.lessons.find((x) => x.slug === slug)!;
    assert.equal(l.status, 'ready');
    const fm = /^title: "?(.*?)"?$/m.exec(read(slug))![1];
    assert.equal(fm, l.title);
  }
});

// Every value quoted in the prose, printed by real Python on this machine and by the lab.
const CLAIMS: [string, string, string][] = [
  ['values', 'print(7 // 2, -7 // 2, 7 % 2, 6 / 2, 2 ** 10, int(3.9), int(-3.5), round(3.9))', '3 -4 1 3.0 1024 3 -3 4\n'],
  ['values', 'print(2 + 3 * 4, (2 + 3) * 4, "4" + "1", "4" * 3, True + 1, 1 == True)', '14 20 41 444 2 True\n'],
  ['values', 'print(len(str(2 ** 100)), 0.1 + 0.2)', '31 0.30000000000000004\n'],
  ['decisions', 'x = 7\nprint(x == 3 or 4, 0 or "x", 1 and "y", bool("False"), bool("0"), bool(0), "1" == 1, 1 == 1.0)', '4 x y True True False False True\n'],
  ['loops', 'print(list(range(3)), list(range(2, 6)), len(range(0, 11)), len(range(0, 10)), sum(range(1, 11)), sum(range(1, 10)))', '[0, 1, 2] [2, 3, 4, 5] 11 10 55 45\n'],
  ['functions', 'print(3 * 1.25, 2 * 1.25, 4 * 1.25, 10 * 1.25, 10 * 1.05)', '3.75 2.5 5.0 12.5 10.5\n'],
  ['lists', 'a = [1, 2]\nb = a\na += [3]\nprint(a, b)\na = a + [4]\nprint(a, b)', '[1, 2, 3] [1, 2, 3]\n[1, 2, 3, 4] [1, 2, 3]\n'],
  ['lists', 'g = [[0]] * 3\ng[0].append(1)\nprint(g)\nn = [10, 20, 30, 40, 50]\nprint(n[3:100])', '[[0, 1], [0, 1], [0, 1]]\n[40, 50]\n'],
  ['maps', 'print({1: "a", 1.0: "b", True: "c"}, 41 in {"age": 41}, {"a": 1, "b": 2} == {"b": 2, "a": 1}, [1, 2] == [2, 1])', "{1: 'c'} False True False\n"],
  ['text', 'print(len("\\u00e9"), len("e\\u0301"), "\\u00e9" == "e\\u0301", len("👍🏽"), len("🇬🇧"), len("👨‍👩‍👧"))', '1 2 False 2 2 5\n'],
  ['text', 'print("🇬🇧"[::-1] == "🇧🇬", "ß".upper(), len("ß".upper()), "straße".upper().lower(), "Straße".lower() == "STRASSE".lower())', 'True SS 2 strasse False\n'],
  ['text', 'print("10" < "9", "Zebra" < "apple", ord("A"), ord("Z"), ord("a"), sorted(["10", "9", "100"]))', "True True 65 90 97 ['10', '100', '9']\n"],
  ['text', 'print("hello".find("h"), "hello".find("z"), "a  b".split(" "), "a  b".split(), "".split(","), "and" in "panda", len("\\n"))', "0 -1 ['a', '', 'b'] ['a', 'b'] [''] True 1\n"],
];
test('the values the lessons quote are what Python and the lab both print', () => {
  for (const [where, src, want] of CLAIMS) {
    assert.equal(runPython(src).stdout, want, `${where}, real Python: ${src}`);
    assert.equal(lab(src).stdout, want, `${where}, lab: ${src}`);
  }
});

test('text: what the real-Python block says it prints is what it prints', () => {
  const block = /```python\n([\s\S]*?)```/.exec(read('text'))![1];
  assert.equal(runPython(block).stdout, 'True\nTrue\nBIGBIRD\n1 2 4\n');
  // "bigbird" is what a second pass gave Spotify. Lower-casing the first result here shows the same.
  assert.equal(runPython('import unicodedata as u\nprint(u.normalize("NFKC", "ᴮᴵᴳᴮᴵᴿᴰ").lower(), "ᴮᴵᴳᴮᴵᴿᴰ".lower() == "bigbird", len("日本語"), len("日本語".encode()), len("👨‍👩‍👧".encode()))').stdout, 'bigbird False 3 9 18\n');
  // "The family takes more again": 5 code points, 18 bytes.
});

test('records: set order differs from the lab exactly as the callout says, and strings really do reorder between runs', () => {
  assert.equal(runPython('print({3, 1, 2})').stdout, '{1, 2, 3}\n');
  assert.equal(lab('print({3, 1, 2})').stdout, '{3, 1, 2}\n');
  const orders = new Set(['0', '1', '2', '3', '4', '5'].map((seed) => runPython('print(list({"tea", "milk", "bread", "honey"}))', { PYTHONHASHSEED: seed }).stdout));
  assert.ok(orders.size > 1, 'six different hash seeds all gave one order');
  // Every sample in the lesson prints a set only through sorted(), so none can depend on this.
  const src = read('records-and-maps');
  for (const m of src.matchAll(/code=\{`([\s\S]*?)`\}/g)) assert.doesNotMatch(m[1], /print\(\{[^:}]*\}\)/, 'a sample prints a set directly');
});

test('first-program: the real traceback in the lesson is real, in its last line and its shape', () => {
  const r = runPython('print("one")\nprnt("two")\nprint("three")');
  assert.equal(r.stdout, 'one\n');
  assert.match(read('first-program'), /NameError: name 'prnt' is not defined\. Did you mean: 'print'\?/);
  assert.match(r.stderr, /Traceback \(most recent call last\):/);
  assert.match(r.stderr, /NameError: name 'prnt' is not defined\. Did you mean: 'print'\?/);
  assert.match(runPython('print(hello)').stderr, /Did you mean: 'help'\?/);
});

test('decisions: the message the lesson quotes for each mistake', () => {
  const msg = (src: string) => { const p = lab(src); return `${p.error?.type}: ${p.error?.message}`; };
  assert.equal(msg('uid = 1000\nif uid = 0:\n    print(1)'), "SyntaxError: invalid syntax. Maybe you meant '==' or ':=' instead of '='?");
  assert.equal(msg('age = 15\nif age >= 18\n    print(1)'), "SyntaxError: expected ':'");
  assert.equal(msg('age = 15\nif age >= 18:\nprint("You can vote")'), "IndentationError: expected an indented block after 'if' statement on line 2");
  assert.equal(msg('age = 15\nif age >= 18:\n    print(1)\n  print(2)'), 'IndentationError: unindent does not match any outer indentation level');
  assert.equal(msg('my-name = 3'), "SyntaxError: cannot assign to expression here. Maybe you meant '==' instead of '='?");
});

test('loops and functions: the messages the lessons quote', () => {
  const msg = (src: string) => { const p = lab(src); return `${p.error?.type}: ${p.error?.message}`; };
  assert.equal(msg('for i in 3:\n    pass'), "TypeError: 'int' object is not iterable");
  assert.equal(msg('for i in range(3.0):\n    pass'), "TypeError: 'float' object cannot be interpreted as an integer");
  assert.equal(msg('n = 4\nfor i in range(n / 2):\n    pass'), "TypeError: 'float' object cannot be interpreted as an integer");
  assert.equal(msg('i = 0\ni++'), 'SyntaxError: invalid syntax');
  assert.equal(msg('def with_tax(price):\n    pass\nwith_tax()'), "TypeError: with_tax() missing 1 required positional argument: 'price'");
  assert.equal(msg('def with_tax(price):\n    pass\nwith_tax(1, 2)'), 'TypeError: with_tax() takes 1 positional argument but 2 were given');
  assert.equal(msg('x = None\nx + 1'), "TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'");
  assert.equal(msg('count = 0\ndef bump():\n    count = count + 1\nbump()'), "UnboundLocalError: cannot access local variable 'count' where it is not associated with a value");
  assert.equal(msg('[].push(1)'), "AttributeError: 'list' object has no attribute 'push'");
  assert.equal(msg('r = None\nr[0]'), "TypeError: 'NoneType' object is not subscriptable");
});

// The accuracy review's findings, by the sentence that was false. Each was true-looking and
// passed everything above, so what's pinned is the claim and, where it can be run, the fact.
const GONE: [string, string, string][] = [
  ['first-program', 'The page gives you one line', 'F1: the lab shows a traceback box as well'],
  ['first-program', 'Anything after a `#` on a line is a **comment**. Python', 'F2: print("#1 fan") has a # that is no comment'],
  ['first-program', 'A runtime error means everything above that line did', 'F3: false once there are ifs and functions'],
  ['first-program', 'from one large research university', 'F4: a reader takes it to be Toronto, and the grades came from UBC'],
  ['first-program', "You don't need a talent for this", 'F5: the source tests grades, not talent'],
  ['first-program', 'so it will work on a real install too', 'the promise said nothing about which version it was tested on'],
  ['values-and-variables', 'Only `=` changes what a name stands for', 'V1: for, def and del do as well'],
  ['values-and-variables', 'because `x` is too useful as a name', 'V3: a reason with no source'],
  ['values-and-variables', 'in any lab, and the page says', 'F7: input-and-errors has labs where input() works'],
  ['decisions', 'any program that called this function', 'B1: functions come two lessons later'],
  ['loops', 'you now know enough to read it', 'O1: that lesson\'s lab uses def, lists and set()'],
  ['loops', 'Every `while` loop has a promise inside it', 'O2: while True with break is correct'],
  ['loops', "Here's the fence again", 'O3: the mission that follows has no fence in it'],
  ['lists', 'Each of those has an error when', 'I1: insert has none, and a far-off position is accepted'],
  ['text', 'So every string method gives you back a new string', 'T1: find, count, split and endswith do not'],
  ['text', 'Every method gives you a new string', 'T1 again, in What to remember'],
  ['text', 'and it never checked', "T2: the post's last twist says it did, until a Python upgrade"],
  ['text', 'which is why files named', 'T3: Windows Explorer sorts them as numbers'],
];
test('the sentences the review found false are gone, in every place they were repeated', () => {
  for (const [slug, text, why] of GONE) assert.ok(!read(slug).includes(text), `${slug}: "${text}": ${why}`);
  assert.doesNotMatch(readFileSync('src/lib/cs/prog-basics.ts', 'utf8'), /Every string method/, 'T1 in a mission debrief');
});

test('first-program says what it was tested against, what a new install is, and how to tell', () => {
  const src = read('first-program');
  assert.match(src, /we ran it on Python 3\.12/);
  assert.match(src, /docs now show 3\.15/);
  assert.match(src, /python --version/);
  assert.match(src, /real Python is right/);
  assert.match(src, /University of British Columbia/);
});

test('what the lessons now say is what real Python does', () => {
  assert.equal(runPython('print("#1 fan")').stdout, '#1 fan\n');
  assert.equal(lab('print("#1 fan")').stdout, '#1 fan\n');
  const skipped = 'if False:\n    print("skipped")\nprnt("x")';
  assert.equal(lab(skipped).error?.line, 3, 'F3: an error on line 3 with line 2 never run');
  assert.equal(lab(skipped).stdout, '');
  const insert = 'a = [1]\na.insert(100, 2)\na.insert(-100, 0)\nprint(a)';
  assert.equal(runPython(insert).stdout, '[0, 1, 2]\n', 'I1: insert past the end has no error');
  assert.equal(lab(insert).stdout, '[0, 1, 2]\n');
  const slices = 'n = [1, 2, 3]\nprint(n[:2], n[1:], n[::-1], n[::2])';
  assert.equal(runPython(slices).stdout, '[1, 2] [2, 3] [3, 2, 1] [1, 3]\n', 'I2');
  assert.equal(lab(slices).stdout, '[1, 2] [2, 3] [3, 2, 1] [1, 3]\n');
  assert.match(runPython('print(2 ** 20000)').stderr, /ValueError: Exceeds the limit \(4300 digits\)/, 'V2');
  assert.equal(lab('print(2 ** 20000)').error?.type, 'ValueError');
  assert.equal(lab('x = 2 ** 20000\nprint(x > 0)').stdout, 'True\n', 'V2: the number itself is fine');
  assert.equal(runPython('print("a".find("a"), "ab".split("b"), "a".count("a"), "a".endswith("a"))').stdout, "0 ['a', ''] 1 True\n", 'T1');
});

test('the note in the first Algorithms lesson sends a newcomer here, now this trail exists', () => {
  assert.match(readFileSync('src/content/lessons/algorithms/what-is-an-algorithm.mdx', 'utf8'), /\[Programming from Zero\]\(\/learn\/programming\/first-program\/\)/);
});
