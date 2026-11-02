// What the six lessons state, run for real. Every code sample goes through real Python
// and through the lab. Every number in a table or in the prose is computed again here,
// because a table that drifts from its source is a false statement to a learner. Mission
// plays are here as well: each code mission to the end, with the wrong answers a learner
// is likely to try, and differently shaped right ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PyProgram } from '../src/lib/py/vm.ts';
import { runAll } from '../src/lib/py/lab.ts';
import { repr } from '../src/lib/py/values.ts';
import { CODE_MISSIONS, type CodeState } from '../src/lib/cs/missions.ts';
import { CLOSE_CASES, FITS_CASES, FROM_DIGITS_CASES, TO_DIGITS_CASES, UTF8_BYTES_CASES, UTF8_LEN_CASES, WRAP_CASES } from '../src/lib/cs/computer-basics-missions.ts';
import { exactDecimal, nextFloat } from '../src/lib/cs/float.ts';
import { python, pythonVersion, runPython } from './helpers/python.ts';

python();
const [major, minor] = pythonVersion();
assert.equal(major, 3);

const LESSONS = ['bits-and-bases', 'negative-numbers', 'floating-point', 'text-and-images-as-bytes', 'gates', 'adder'];
const read = (slug: string) => readFileSync(`src/content/lessons/computer/${slug}.mdx`, 'utf8');
const py = (src: string) => {
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

for (const slug of LESSONS) {
  const src = read(slug);
  const labs = [...src.matchAll(/code=\{`([\s\S]*?)`\}/g)].map((m) => m[1]);
  const fences = [...src.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]);

  test(`${slug}: every code-lab sample prints the same in the lab and in real Python`, () => {
    for (const code of labs) {
      const r = runPython(code);
      assert.equal(r.status, 0, `${r.stderr}\n${code}`);
      const p = new PyProgram(code);
      p.run();
      assert.equal(p.status, 'done', `${p.error?.type}: ${p.error?.message}\n${code}`);
      // sum() changed in 3.12, and the lab follows 3.12 as CI does. An older local Python differs on exactly this one printed line, which the lesson says.
      const want = minor < 12 ? r.stdout.replace(/0\.9999999999999999\n$/, code.includes('sum([0.1] * 10)') ? '1.0\n' : '0.9999999999999999\n') : r.stdout;
      assert.equal(p.stdout, want, `differs for:\n${code}`);
    }
  });

  test(`${slug}: every code block for a real terminal runs on real Python`, () => {
    for (const code of fences) {
      const r = runPython(code);
      assert.equal(r.status, 0, `${r.stderr}\n${code}`);
      assert.ok(r.stdout.length > 0);
    }
  });

  test(`${slug}: follows the site's writing rules`, () => {
    assert.ok(!src.includes('—'), 'no em dashes');
    assert.doesNotMatch(src, /\bsimply\b/i);
    assert.doesNotMatch(src, /by hand/i, 'lessons never imply how they were made');
    assert.match(src, /^builds_on: \[.*\]$/m);
    assert.match(src, /<GoDeeper/);
    assert.match(src, /## What to remember/);
    assert.ok((src.match(/<Quiz\b/g) ?? []).length >= 3);
    assert.match(src, /<Callout kind="real"/, 'says where the sandbox differs from the real thing');
  });

  test(`${slug}: no quiz depends on the GoDeeper section, because the words it defines appear only there`, () => {
    const quizzes = [...src.matchAll(/<Quiz[\s\S]*?\/>/g)].map((m) => m[0]).join('\n');
    assert.doesNotMatch(quizzes, /functionally complete|mod 2|telescop|surrogate|subnormal/i);
  });
}

test('builds_on matches the plan', () => {
  const b = (slug: string) => /^builds_on: (\[.*\])$/m.exec(read(slug))![1];
  assert.equal(b('bits-and-bases'), '[]');
  assert.equal(b('negative-numbers'), '[computer/bits-and-bases]');
  assert.equal(b('floating-point'), '[computer/bits-and-bases]');
  assert.equal(b('text-and-images-as-bytes'), '[computer/bits-and-bases]');
  assert.equal(b('gates'), '[computer/bits-and-bases]');
  assert.equal(b('adder'), '[computer/gates, computer/negative-numbers]');
});

// ---- The prose, computed ------------------------------------------------------------

test('bits: what the trap callout says about real Python', () => {
  assert.equal(py('print(int("101"), int("101", 2), int("11"), int("11", 2))').trim(), '101 5 11 3');
  assert.match(runPython('bin(5) + 1').stderr, /TypeError/);
  assert.match(runPython('print(010)').stderr, /SyntaxError/);
  assert.equal(runAll('print(010)').error?.type, 'SyntaxError');
  assert.equal(py('print(2 ** 100, 255 + 1)').trim(), '1267650600228229401496703205376 256');
  assert.equal(py('print(hex(47), 0x2f, format(0x2f, "08b"))').trim(), '0x2f 47 00101111');
  for (const refused of ['print(bytes([1]))', 'print("a".encode())', 'print((1).to_bytes(1, "big"))']) assert.equal(runAll(refused).error?.type, 'SandboxLimit', refused);
});

test('negative numbers: the 787 sum, and the limits table', () => {
  const r = Number(py('print(2 ** 31 / 100 / 86400)').trim());
  assert.ok(r > 248 && r < 249, `${r}`);
  assert.equal(Math.floor(r), 248);
  for (const [bits, lo, hi] of [[8, '-128', '127'], [16, '-32768', '32767'], [32, '-2147483648', '2147483647'], [64, '-9223372036854775808', '9223372036854775807']] as const) {
    assert.equal(py(`print(-2 ** (${bits} - 1), 2 ** (${bits} - 1) - 1)`).trim(), `${lo} ${hi}`);
  }
  const src = read('negative-numbers');
  for (const n of ['-32,768', '32,767', '-2,147,483,648', '2,147,483,647', '-9,223,372,036,854,775,808', '9,223,372,036,854,775,807']) assert.ok(src.includes(n), n);
});

test('negative numbers: the table of worked patterns', () => {
  const twos = (s: string) => [...s].reduce((v, c, i) => v + Number(c) * (i === 0 ? -128 : 2 ** (7 - i)), 0);
  assert.equal(twos('00000101'), 5);
  assert.equal(twos('11111111'), -1);
  assert.equal(twos('11111011'), -5);
  assert.equal(twos('10000000'), -128);
  assert.equal(twos('01111111'), 127);
  assert.equal(twos('11111110'), -2);
  assert.equal(py('import ctypes\nprint(ctypes.c_int8(0b11111011).value, ctypes.c_int16(32767 + 1).value)').trim(), '-5 -32768');
});

test('negative numbers: the fixed-width edges real Python really has, as the callout says', () => {
  assert.match(runPython('import struct\nstruct.pack(">h", 40000)').stderr, /struct\.error/);
  assert.match(runPython('float(10 ** 400)').stderr, /OverflowError/);
  assert.equal(runAll('float(10 ** 400)').error?.type, 'OverflowError');
  const bytes = py(`import struct
print(*[int.from_bytes(struct.pack(f, v), 'big') for f, v in (('>b', -1), ('>b', -128), ('>h', -32768), ('>i', -2147483648))])`);
  assert.equal(bytes.trim(), '255 128 32768 2147483648');
});

test('negative numbers: 2038 is 2^31 seconds after the start of 1970, as the man page has it', () => {
  assert.equal(py('from datetime import datetime, timezone\nprint(datetime.fromtimestamp(2 ** 31, timezone.utc).strftime("%Y-%m-%d %H:%M:%S"))').trim(), '2038-01-19 03:14:08');
});

test('floating point: the code sample prints the two errors Skeel gives, at 8 and 100 hours', () => {
  const sample = /code=\{`(# 0\.1 chopped[\s\S]*?)`\}/.exec(read('floating-point'))![1];
  const rows = py(sample).trim().split('\n').slice(2).map((l) => l.split(' '));
  assert.deepEqual(rows, [['1', '0.0034'], ['8', '0.0275'], ['20', '0.0687'], ['48', '0.1648'], ['72', '0.2472'], ['100', '0.3433']]);
  const src = read('floating-point');
  assert.match(src, /0\.0275 seconds after eight hours and 0\.3433 seconds after 100 hours/, 'in Skeel\'s words');
  // Skeel's form of the same thing: chopping at 23 digits is 0.1 x (1 - 2^-20), exactly.
  assert.equal(py('from fractions import Fraction as F\nprint(F(838860, 2**23) == F(1, 10) * (1 - F(1, 2**20)), int(F(1, 10) * 2**23))').trim(), 'True 838860');
});

// gao.gov refused the fetch on both reviews of this lesson, so nobody could confirm what the
// report does or doesn't say. These pin the rule until someone has read the document: if you
// have, restore what you confirmed and change this test, don't delete it.
test('floating point: the unread GAO report is not quoted, and nothing says what it leaves out', () => {
  const src = read('floating-point');
  const body = src.slice(src.indexOf('---', 3));
  for (const unconfirmed of [/GAO says/, /per GAO/, /GAO's numbers/, /GAO's report gives/, /GAO's own summary/, /GAO doesn't/, /doesn't spell out/, /every few hours/, /26 February/, /25 February/, /killed 28 American soldiers/, /This problem led to/, /after about 20 hours/]) {
    assert.doesNotMatch(body, unconfirmed);
  }
  assert.match(body, /gao\.gov refused the request/, 'and the lesson says why');
  assert.match(body, /the computer's registers were only 24 bits long/, 'attributed to Skeel, who is the one we can read');
});

test('floating point: the Patriot quiz had the subtraction backwards. Skeel\'s elapsed time is too long, which needs the less accurate time to be the one subtracted', () => {
  const src = read('floating-point');
  assert.match(src, /a less accurate time was subtracted from a more accurate one/);
  assert.doesNotMatch(src, /an accurate time was subtracted from an inaccurate one/);
  // Two pulses, ten seconds apart. Times are truncated by 0.0001%, so the earlier one reads low.
  assert.equal(py(`from fractions import Fraction as F
t1, t2, chop = F(360000), F(360010), 1 - F(1, 2 ** 20)
print((t2 - t1 * chop) > (t2 - t1), (t2 * chop - t1) > (t2 - t1))`).trim(), 'True False');
});

test('floating point: the lesson\'s sentences about the sample\'s .55f and as_integer_ratio, and a table row the lab can\'t read', () => {
  assert.equal(py('print(len(f"{0.1:.55f}") - 2, (0.1).as_integer_ratio()[1] == 2 ** 55)').trim(), '55 True');
  assert.equal(runAll('print(len(f"{0.1:.55f}") - 2, (0.1).as_integer_ratio()[1] == 2 ** 55)').stdout.trim(), '55 True');
  assert.doesNotMatch(read('floating-point'), /You can type each into the Float Lab/);
});

test('floating point: "It\'s the same in banking and in a shopping cart" had no source, and is gone', () => {
  assert.doesNotMatch(read('floating-point'), /same in banking/);
});

test('bits: "bits can\'t say that" was false, and the inquiry report points the other way', () => {
  const src = read('bits-and-bases');
  for (const gone of [/bits can't say that/, /nothing in them could say so/, /no error raised/, /with nothing noticing/, /without any error/, /Bits carry no label/]) assert.doesNotMatch(src, gone);
  assert.match(src, /should be indicated on the databus/);
  assert.match(src, /had declared a failure/);
  assert.match(src, /doesn't say what in the pattern could have told the two apart/);
  assert.match(/id="comp-bits-3"[\s\S]*?\/>/.exec(src)![0], /a reader that doesn't check can take one kind of data for another/, 'the quiz keeps its id, with the corrected answer');
});

test('bits and negative numbers: "unlimited" Python ints do hit a limit when printed, as the lessons now say', () => {
  const big = 'print(2 ** 20000)';
  assert.match(runPython(big).stderr, /ValueError: Exceeds the limit \(4300/);
  const lab = runAll(big);
  assert.equal(lab.error?.type, 'ValueError');
  assert.equal(py('print(2 ** 20000 > 0)').trim(), 'True');
  assert.equal(runAll('print(2 ** 20000 > 0)').stdout.trim(), 'True');
  assert.match(read('bits-and-bases'), /one past 4,300 digits/);
  assert.match(read('negative-numbers'), /one past 4,300 digits/);
});

test('negative numbers: the 787 hedge vanished one paragraph later, and an unsigned counter at 200 ticks a second gives exactly the same days', () => {
  assert.equal(py('print(2 ** 31 / 100 / 86400 == 2 ** 32 / 200 / 86400, 2 ** 32 / 200 / 86400)').trim(), 'True 248.55134814814815');
  const src = read('negative-numbers');
  assert.doesNotMatch(src, /Why 2³¹ and not 2³²\? Because one of the 32 bits is spent/);
  assert.match(src, /If that reading is right, why 2³¹ and not 2³²\?/);
  assert.match(src, /The arithmetic can't settle it/);
  assert.doesNotMatch(src, /nothing says anything happened/);
  assert.doesNotMatch(src, /sent as if it were flight data/);
});

test('negative numbers: what bin(-5) really prints, in real Python and in the lab', () => {
  const code = 'print(bin(-5), -5 & 0xff, format(-5 & 0xff, "08b"))';
  assert.equal(py(code).trim(), '-0b101 251 11111011');
  assert.equal(runAll(code).stdout.trim(), '-0b101 251 11111011');
  assert.match(read('negative-numbers'), /`-0b101`.*251, which is `11111011`/);
});

test('negative numbers: the C claim is about what the rules allow, and says what was and wasn\'t compiled', () => {
  const src = read('negative-numbers');
  assert.match(src, /under C's rules, a check written as `if \(x \+ 1 < x\)`/);
  assert.match(src, /MSVC 19\.44 kept the check/);
  assert.match(src, /We haven't run GCC or Clang/);
});

test('text: the curly apostrophe that "plain English survives" left out, against real Python', () => {
  assert.equal(py('print("don\\u2019t".encode("utf-8").decode("cp1252"))').trim(), 'donâ€™t');
  const src = read('text-and-images-as-bytes');
  assert.ok(src.includes('`don’t` into `donâ€™t`'));
  assert.doesNotMatch(src, /Plain English survives/);
  assert.doesNotMatch(src, /old English files/);
  assert.doesNotMatch(src, /the older encodings agree/);
});

test('text: the story ended on "fixed" while Firefox wasn\'t', () => {
  const src = read('text-and-images-as-bytes');
  assert.match(src, /The problem remains in Firefox as they decided that it is a problem for domain registrars to deal with\./);
});

test('text: "takes the same time for any position" contradicted the caches lesson', () => {
  assert.doesNotMatch(read('text-and-images-as-bytes'), /takes the same time for any position/);
});

test('comp-text-utf8: "a real UTF-8 encoder" encodes a surrogate real Python refuses, so the debrief now says so', () => {
  const m = CODE_MISSIONS['comp-text-utf8'];
  const encoder = `def utf8_bytes(ch):\n    n = ord(ch)\n    if n < 128:\n        return [n]\n    if n < 2048:\n        return [192 + n // 64, 128 + n % 64]\n    if n < 65536:\n        return [224 + n // 4096, 128 + (n // 64) % 64, 128 + n % 64]\n    return [240 + n // 262144, 128 + (n // 4096) % 64, 128 + (n // 64) % 64, 128 + n % 64]\nprint(utf8_bytes(chr(0xD800)))\n`;
  assert.equal(py(encoder).trim(), '[237, 160, 128]');
  assert.notEqual(runPython('chr(0xD800).encode()').status, 0);
  assert.match(m.debrief, /every code point except surrogates/);
  assert.match(m.steps[0].text, /counts code points, not bytes/);
});

test('comp-neg-emulate: the debrief no longer says the Ariane inquiry "spent most of its words" on what to do about an overflow', () => {
  const d = CODE_MISSIONS['comp-neg-emulate'].debrief;
  assert.doesNotMatch(d, /most of its words/);
  assert.match(d, /recommendation R3/);
});

test('gates: the lesson\'s claims about the shelf and the judge, and the reason it gives for XOR', () => {
  const src = read('gates');
  assert.doesNotMatch(src, /Nothing in the lab looks at how you wired it/);
  assert.doesNotMatch(src, /is one you've shown can be made from it/);
  assert.doesNotMatch(src, /In a similar way/);
  assert.match(src, /AND isn't a parity/);
});

test('adder: the frontmatter reversed Shirriff, and the wrap is taught for both readings', () => {
  const src = read('adder');
  assert.doesNotMatch(src, /because it was wrong on very few inputs/, 'rarity was Intel\'s argument against a recall, not the cost');
  assert.doesNotMatch(src, /isn't in dispute/);
  assert.match(src, /wasn't the first to find it/);
  assert.match(src, /Intel quietly revised the Pentium circuitry to fix the problem/);
  assert.doesNotMatch(src, /- A wrap is a carry/);
  assert.match(src, /An unsigned wrap is a carry with nowhere to go\. A signed wrap is different/);
  assert.doesNotMatch(src, /4 × width \+ 3/);
  assert.doesNotMatch(src, /slowest path through the circuit/);
});

test('floating point: the four exact values in the table, against Decimal', () => {
  const src = read('floating-point');
  const got = py(`from decimal import Decimal
for x in (0.1, 0.2, 0.1 + 0.2, 0.3):
    print(format(Decimal(x), 'f'))`).trim().split('\n');
  for (const line of got) assert.ok(src.includes(line), `table has ${line}`);
  assert.equal(exactDecimal(0.2), got[1]);
  assert.equal(got[0].length - 2, 55, 'the prose says 55 digits after the point');
});

test('floating point: 0.1 + 0.2 and 0.3 are neighbours, and the sum is the true sum rounded', () => {
  assert.equal(nextFloat(0.3, true), 0.1 + 0.2);
  assert.equal(py('from fractions import Fraction as F\nprint(float(F(0.1) + F(0.2)) == 0.1 + 0.2, repr(0.1 + 0.2), repr(0.3))').trim(), 'True 0.30000000000000004 0.3');
  assert.equal(py('print(len(repr(0.1 + 0.2)) - 2)').trim(), '17');
});

test('floating point: the GoDeeper arithmetic for 0.1', () => {
  assert.equal(py(`from fractions import Fraction as F
print(round(F(2 ** 56, 10)), 3602879701896397 * 2 == round(F(2 ** 56, 10)), 2 ** 55, (0.1).as_integer_ratio())
print(2 ** 52 <= round(F(2 ** 56, 10)) < 2 ** 53, F(0.1) == F(1, 10) * 1 or F(0.1) > F(1, 10))
print((0.1).hex())
import struct
b = struct.unpack('>Q', struct.pack('>d', 0.1))[0]
print(b >> 63, (b >> 52) & 0x7ff, format(b & (2 ** 52 - 1), '052b')[:8], format(b & (2 ** 52 - 1), '052b')[-4:])`).trim(),
  `7205759403792794 True 36028797018963968 (3602879701896397, 36028797018963968)
True True
0x1.999999999999ap-4
0 1019 10011001 1010`);
});

test('floating point: what the trap callout says about rounding, on real Python and in the lab', () => {
  const claims = 'print(round(0.1 + 0.2, 2) == 0.3, round(0.12499, 2), round(0.12501, 2), round(2.675, 2), 1.5 + 2.25 == 3.75, 1e309, 1e308 * 10)';
  const want = 'True 0.12 0.13 2.67 True inf inf\n';
  assert.equal(py(claims), want);
  assert.equal(runAll(claims).stdout, want);
  assert.match(runPython('2.0 ** 2000').stderr, /OverflowError/);
  assert.equal(runAll('2.0 ** 2000').error?.type, 'OverflowError');
  assert.equal(py('from decimal import Decimal\nprint(Decimal(2.675) < Decimal("2.675"))').trim(), 'True');
  assert.equal(py('print(9007199254740993.0)').trim(), '9007199254740992.0');
  assert.equal(py('print(float("1e-20") == 0.0)').trim(), 'False');
});

test('floating point: the decimal block prints what the lesson says it does', () => {
  const block = /```python\n(from decimal[\s\S]*?)```/.exec(read('floating-point'))![1];
  const lines = py(block).trim().split('\n');
  assert.equal(lines[0], 'True');
  assert.equal(lines[1], '0.9999999999999999999999999999');
  assert.equal(lines[2], exactDecimal(0.1));
});

test('floating point: sum, on this Python, does what the lesson says it does on this version', () => {
  const printed = py('print(sum([0.1] * 10))').trim();
  // Both branches are pinned to a value, so neither can quietly drift.
  assert.equal(printed, minor >= 12 ? '1.0' : '0.9999999999999999');
  assert.equal(runAll('print(sum([0.1] * 10))').stdout.trim(), '1.0', 'the lab follows 3.12');
});

test('text: the lookalike, the two é, and the emoji counts', () => {
  assert.equal(py('print(ord("a"), ord(chr(1072)), hex(1072))').trim(), '97 1072 0x430');
  assert.equal(py('print(chr(233) == "e" + chr(769), len(chr(233)), len("e" + chr(769)))').trim(), 'False 1 2');
  assert.equal('😀'.length, 2);
  assert.equal(py('print(0x10FFFF, ord("A"), hex(ord("A")))').trim(), '1114111 65 0x41');
});

test('text: a browser\'s windows-1252 fills the five holes with control characters, as the trap says; Python\'s replaces', () => {
  const holes = [0x81, 0x8d, 0x8f, 0x90, 0x9d];
  const web = new TextDecoder('windows-1252').decode(new Uint8Array(holes));
  assert.deepEqual([...web].map((c) => c.codePointAt(0)), holes);
  assert.equal(py(`print([ord(c) for c in bytes(${JSON.stringify(holes)}).decode('cp1252', errors='replace')])`).trim(), '[65533, 65533, 65533, 65533, 65533]');
  assert.notEqual(runPython(`bytes([0x81]).decode('cp1252')`).status, 0, 'and strict Python raises');
});

test('text: the quiz sums', () => {
  assert.equal(py('print(len("José".encode()), len("日本語の名前".encode()), len("Marie-Anne".encode()), len("日本語の名前"), (2 * 100 + 5) * 3)').trim(), '5 18 10 6 615');
});

test('adder: the sums in the prose', () => {
  assert.equal(py('print(len(str(2 ** 128)), 2 ** 128 // (10 ** 18) // (365 * 24 * 3600) // 10 ** 13)').trim(), '39 1');
});

test('adder: the sample finds no wrong answers, and fits the lab\'s step limit', () => {
  const sample = /code=\{`(def full_adder[\s\S]*?)`\}/.exec(read('adder'))![1];
  const p = new PyProgram(sample);
  p.run();
  assert.equal(p.status, 'done', 'finishes inside the budget');
  assert.equal(p.stdout, 'wrong answers: 0 of 4096\n(16, 1)\n');
});

test('gates: the sample shows the two functions agree on all four rows', () => {
  const sample = /code=\{`(def long_way[\s\S]*?)`\}/.exec(read('gates'))![1];
  const rows = py(sample).trim().split('\n').map((l) => l.split(' '));
  assert.equal(rows.length, 4);
  for (const [, , x, y] of rows) assert.equal(x, y);
});

// ---- The code missions, played -------------------------------------------------------

const state = (): CodeState => ({ runs: [], growth: [] });
const act = (s: CodeState, ...programs: string[]) => { for (const p of programs) s.runs.push(runAll(p)); return s; };
const ticks = (id: string, s: CodeState) => { let ok = true; return CODE_MISSIONS[id].steps.map((st) => (ok = ok && st.done(s))); };
const starter = (id: string) => CODE_MISSIONS[id].starter!;
const all = (id: string, ...programs: string[]) => assert.ok(ticks(id, act(state(), starter(id), ...programs)).every(Boolean), `${id}: ${ticks(id, act(state(), starter(id), ...programs))}`);
const failsStep = (id: string, step: number, program: string, label: string) => assert.equal(ticks(id, act(state(), starter(id), program))[step], false, label);

const TO = {
  loop: `def to_digits(n, base):
    if n == 0:
        return [0]
    digits = []
    while n > 0:
        digits.insert(0, n % base)
        n = n // base
    return digits
`,
  recursive: `def to_digits(n, base):
    if n < base:
        return [n]
    return to_digits(n // base, base) + [n % base]
`,
  reversed: `def to_digits(n, base):
    d = []
    while True:
        d.append(n % base)
        n //= base
        if n == 0:
            break
    d.reverse()
    return d
`,
};
const FROM = {
  horner: `def from_digits(digits, base):
    value = 0
    for d in digits:
        value = value * base + d
    return value
`,
  powers: `def from_digits(digits, base):
    total = 0
    for i, d in enumerate(reversed(digits)):
        total += d * base ** i
    return total
`,
};

test('comp-bits-digits: plays to the end, by differently shaped right answers', () => {
  for (const t of Object.values(TO)) for (const f of Object.values(FROM)) all('comp-bits-digits', `${t}\n${f}`);
});

test('comp-bits-digits: the cases are real Python\'s answers', () => {
  const r = py(`for n, b in ${JSON.stringify(TO_DIGITS_CASES.map((c) => c.args))}:
    d = []
    while True:
        d.insert(0, n % b)
        n //= b
        if n == 0:
            break
    print(d)
`).trim().split('\n');
  TO_DIGITS_CASES.forEach((c, i) => assert.equal(c.want, r[i]));
  assert.equal(py(`for ds, b in ${JSON.stringify(FROM_DIGITS_CASES.map((c) => c.args))}:
    print(int(''.join(format(d, 'x') if d < 16 else chr(87 + d) for d in ds), b))
`).trim(), FROM_DIGITS_CASES.map((c) => c.want).join('\n'));
});

test('comp-bits-digits: shortcuts and slips fail', () => {
  const id = 'comp-bits-digits';
  // bin() is only base 2, and gives text, not a list of digits.
  failsStep(id, 1, `def to_digits(n, base):\n    return [int(c) for c in bin(n)[2:]]\n`, 'base 2 only');
  failsStep(id, 1, `def to_digits(n, base):\n    digits = []\n    while n > 0:\n        digits.insert(0, n % base)\n        n = n // base\n    return digits\n`, 'forgets that 0 has a digit');
  failsStep(id, 1, `def to_digits(n, base):\n    if n == 0:\n        return [0]\n    digits = []\n    while n > 0:\n        digits.append(n % base)\n        n = n // base\n    return digits\n`, 'digits backwards');
  failsStep(id, 2, `${TO.loop}\ndef from_digits(digits, base):\n    return int("".join([str(d) for d in digits]), base)\n`, 'text route breaks on digit 15');
  failsStep(id, 2, `${TO.loop}\ndef from_digits(digits, base):\n    return sum(digits)\n`, 'adding the digits');
});

test('comp-neg-emulate: the cases agree with ctypes, and right answers pass in more than one shape', () => {
  const r = py(`import ctypes
kinds = {8: ctypes.c_int8, 16: ctypes.c_int16, 32: ctypes.c_int32}
for n, b in ${JSON.stringify(WRAP_CASES.map((c) => c.args))}:
    if b == 4:
        u = n % 16
        print(u - 16 if u >= 8 else u)
    else:
        print(kinds[b](n).value)
`).trim().split('\n');
  WRAP_CASES.forEach((c, i) => assert.equal(c.want, r[i], JSON.stringify(c.args)));
  const fitsReal = FITS_CASES.map((c) => { const [n, b] = c.args as [number, number]; return n >= -(2 ** (b - 1)) && n < 2 ** (b - 1) ? 'True' : 'False'; });
  assert.deepEqual(FITS_CASES.map((c) => c.want), fitsReal);
  const wrapA = `def wrap(n, bits):\n    u = n % 2 ** bits\n    if u >= 2 ** (bits - 1):\n        u = u - 2 ** bits\n    return u\n`;
  const wrapB = `def wrap(n, bits):\n    half = 2 ** (bits - 1)\n    return (n + half) % (2 * half) - half\n`;
  const wrapC = `def wrap(n, bits):\n    u = n & ((1 << bits) - 1)\n    return u - (1 << bits) if u >> (bits - 1) else u\n`;
  const fitsA = `def fits(n, bits):\n    return -(2 ** (bits - 1)) <= n <= 2 ** (bits - 1) - 1\n`;
  const fitsB = (w: string) => `${w}\ndef fits(n, bits):\n    return wrap(n, bits) == n\n`;
  for (const w of [wrapA, wrapB, wrapC]) { all('comp-neg-emulate', `print(32768)\n${w}\n${fitsA}`); all('comp-neg-emulate', `${fitsB(w)}`); }
});

test('comp-neg-emulate: the tempting wrong ones fail, and the debrief\'s claim about wrap is true', () => {
  const id = 'comp-neg-emulate';
  failsStep(id, 1, `def wrap(n, bits):\n    return n % 2 ** bits\n`, 'unsigned: 255 stays 255');
  failsStep(id, 1, `def wrap(n, bits):\n    top = 2 ** (bits - 1)\n    return max(-top, min(top - 1, n))\n`, 'clamping is not wrapping');
  failsStep(id, 1, `def wrap(n, bits):\n    u = abs(n) % 2 ** bits\n    return u - 2 ** bits if u >= 2 ** (bits - 1) else u\n`, 'loses the sign of a negative');
  const w = `def wrap(n, bits):\n    u = n % 2 ** bits\n    return u - 2 ** bits if u >= 2 ** (bits - 1) else u\n`;
  failsStep(id, 2, `${w}\ndef fits(n, bits):\n    return abs(n) < 2 ** (bits - 1)\n`, 'forgets the extra negative: -128');
  failsStep(id, 2, `${w}\ndef fits(n, bits):\n    return n < 2 ** (bits - 1)\n`, 'no lower bound');
  failsStep(id, 2, `${w}\ndef fits(n, bits):\n    return abs(n) <= 2 ** (bits - 1)\n`, '+128 does not fit');
});

test('comp-float-close: the cases agree with math.isclose, and right answers pass with any sensible tolerance', () => {
  const r = py(`import math
for a, b in ${JSON.stringify(CLOSE_CASES.map(([a, b]) => [repr(a), repr(b)]))}:
    print(math.isclose(float(a), float(b)))
`).trim().split('\n');
  CLOSE_CASES.forEach(([, , want], i) => assert.equal(r[i], want ? 'True' : 'False', `case ${i}`));
  const split = `def split(cents, people):\n    each = cents // people\n    extra = cents % people\n    return [each + 1 if i < extra else each for i in range(people)]\n`;
  const close = (tol: string) => `def close(a, b):\n    return abs(a - b) <= ${tol} * max(abs(a), abs(b))\n`;
  for (const t of ['1e-9', '1e-12', '1e-14']) all('comp-float-close', `${close(t)}\n${split}`);
  const closeB = `def close(a, b):\n    if a == b:\n        return True\n    return abs(a - b) / max(abs(a), abs(b)) < 1e-10\n`;
  const splitB = `def split(cents, people):\n    shares = [0] * people\n    i = 0\n    while cents > 0:\n        shares[i] = shares[i] + 1\n        cents = cents - 1\n        i = (i + 1) % people\n    return shares\n`;
  const splitC = `def split(cents, people):\n    out = []\n    for i in range(people):\n        share = cents // (people - i)\n        out.append(share)\n        cents = cents - share\n    return out\n`;
  all('comp-float-close', `${closeB}\n${splitB}`);
  all('comp-float-close', `${close('1e-9')}\n${splitC}`);
});

test('comp-float-close: the tempting wrong ones fail', () => {
  const id = 'comp-float-close';
  const good = `def close(a, b):\n    return abs(a - b) <= 1e-9 * max(abs(a), abs(b))\n`;
  failsStep(id, 1, `def close(a, b):\n    return abs(a - b) < 1e-9\n`, 'a fixed tolerance: wrong on tiny and huge');
  failsStep(id, 1, `def close(a, b):\n    return round(a, 9) == round(b, 9)\n`, 'rounding: 1e-20 and 2e-20 both round to 0');
  failsStep(id, 1, `def close(a, b):\n    return a == b\n`, 'starter');
  failsStep(id, 1, `def close(a, b):\n    return True\n`, 'always yes');
  // Rounding to compare, in another form: it once passed, and the lesson calls it a different bug.
  failsStep(id, 1, `def close(a, b):\n    return f"{a:.15e}" == f"{b:.15e}"\n`, 'comparing rounded text');
  // An absolute floor can pass as the shape of math.isclose, and swallows real differences here. The hint says why.
  failsStep(id, 1, `def close(a, b):\n    return abs(a - b) <= max(1e-9 * max(abs(a), abs(b)), 1e-12)\n`, 'a floor bigger than the numbers');
  assert.match(CODE_MISSIONS[id].steps[1].hint!, /absolute floor/);
  failsStep(id, 2, `${good}\ndef split(cents, people):\n    return [cents // people] * people\n`, 'loses the remainder');
  failsStep(id, 2, `${good}\ndef split(cents, people):\n    return [cents / people] * people\n`, 'fractions of a cent');
  failsStep(id, 2, `${good}\ndef split(cents, people):\n    return [round(cents / people)] * people\n`, 'rounds, and the total is off');
  failsStep(id, 2, `${good}\ndef split(cents, people):\n    return [cents - (people - 1) * (cents // people)] + [cents // people] * (people - 1)\n`, 'adds up, but one person pays too much: 99 between 100');
});

test('comp-float-close: a split that returns floats that happen to be whole is told why, not just failed', () => {
  const s = act(state(), `def close(a, b):\n    return True\ndef split(cents, people):\n    return [1.0] * people\n`);
  assert.match(CODE_MISSIONS['comp-float-close'].steps[2].why!(s)!, /isn't a whole number of cents/);
});

test('comp-text-utf8: the cases are real .encode()\'s answers', () => {
  const code = (args: unknown[]) => [...(args[0] as string)].map((c) => c.codePointAt(0));
  const r1 = py(`for cps in ${JSON.stringify(UTF8_LEN_CASES.map((c) => code(c.args)))}:
    print(len(''.join(map(chr, cps)).encode('utf-8')))
`).trim().split('\n');
  UTF8_LEN_CASES.forEach((c, i) => assert.equal(c.want, r1[i], JSON.stringify(c.args)));
  const r2 = py(`for cps in ${JSON.stringify(UTF8_BYTES_CASES.map((c) => code(c.args)))}:
    print(list(''.join(map(chr, cps)).encode('utf-8')))
`).trim().split('\n');
  UTF8_BYTES_CASES.forEach((c, i) => assert.equal(c.want, r2[i], JSON.stringify(c.args)));
});

test('comp-text-utf8: plays to the end by the table and by bit operations, and the strings really reach the lab', () => {
  const lenA = `def utf8_len(text):\n    total = 0\n    for c in text:\n        n = ord(c)\n        if n < 128:\n            total += 1\n        elif n < 2048:\n            total += 2\n        elif n < 65536:\n            total += 3\n        else:\n            total += 4\n    return total\n`;
  const bytesA = `def utf8_bytes(ch):\n    n = ord(ch)\n    if n < 128:\n        return [n]\n    if n < 2048:\n        return [192 + n // 64, 128 + n % 64]\n    if n < 65536:\n        return [224 + n // 4096, 128 + (n // 64) % 64, 128 + n % 64]\n    return [240 + n // 262144, 128 + (n // 4096) % 64, 128 + (n // 64) % 64, 128 + n % 64]\n`;
  const bytesB = `def utf8_bytes(ch):\n    n = ord(ch)\n    if n < 0x80:\n        return [n]\n    if n < 0x800:\n        return [0xC0 | (n >> 6), 0x80 | (n & 63)]\n    if n < 0x10000:\n        return [0xE0 | (n >> 12), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63)]\n    return [0xF0 | (n >> 18), 0x80 | ((n >> 12) & 63), 0x80 | ((n >> 6) & 63), 0x80 | (n & 63)]\n`;
  const lenB = `${bytesB}\ndef utf8_len(text):\n    return sum([len(utf8_bytes(c)) for c in text])\n`;
  all('comp-text-utf8', `print(128512)\n${lenA}\n${bytesA}`);
  all('comp-text-utf8', `print(128512)\n${lenB}`);
});

test('comp-text-utf8: shortcuts and slips fail', () => {
  const id = 'comp-text-utf8';
  failsStep(id, 1, `def utf8_len(text):\n    return len(text)\n`, 'characters, not bytes');
  failsStep(id, 1, `def utf8_len(text):\n    return len(text) * 2\n`, 'a guess');
  failsStep(id, 1, `def utf8_len(text):\n    total = 0\n    for c in text:\n        n = ord(c)\n        total += 1 if n < 128 else 2 if n < 2048 else 3\n    return total\n`, 'no four-byte case');
  failsStep(id, 1, `def utf8_len(text):\n    total = 0\n    for c in text:\n        n = ord(c)\n        total += 1 if n <= 128 else 2 if n <= 2048 else 3 if n <= 65536 else 4\n    return total\n`, 'off by one at each boundary');
  const len = `def utf8_len(text):\n    total = 0\n    for c in text:\n        n = ord(c)\n        total += 1 if n < 128 else 2 if n < 2048 else 3 if n < 65536 else 4\n    return total\n`;
  failsStep(id, 2, `${len}\ndef utf8_bytes(ch):\n    return [ord(ch)]\n`, 'starter');
  failsStep(id, 2, `${len}\ndef utf8_bytes(ch):\n    n = ord(ch)\n    return [192 + n // 64, 128 + n % 64]\n`, 'always two bytes');
});

test('every code mission refuses a program that crashes, without telling a learner it passed', () => {
  for (const id of ['comp-bits-digits', 'comp-neg-emulate', 'comp-float-close', 'comp-text-utf8']) {
    const s = act(state(), 'print(1 / 0)');
    assert.ok(CODE_MISSIONS[id].steps.every((st) => !st.done(s)), id);
  }
});

test('repr of a raw float is how the mission\'s message reads it', () => {
  assert.equal(repr(1e20), '1e+20');
});
