// Differential fuzz of the lab against real Python, for the failure the review found:
// "hello".find("l", 3) answered 2 in the lab and 3 on real Python, with no warning, and
// "a1".strip(1) threw a raw JavaScript error that froze the browser on "Running…".
//
// Every built-in and every method goes through a table of argument shapes, as a program run by
// both interpreters. Each must give the same output or the same type of exception, or the lab
// must refuse by name (SandboxLimit). A raw JavaScript error or a silent difference fails.
//
// Fails rather than skips without Python. Deterministic: no randomness anywhere. Set
// PY_FUZZ_PYTHON to compare against another interpreter, as in
//   PY_FUZZ_PYTHON="wsl -d Ubuntu-24.04 -- python3" node --test tests/py-fuzz.test.ts
// Set PY_FUZZ_REPORT=1 to print the counts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { PyProgram } from '../src/lib/py/vm.ts';
import { python } from './helpers/python.ts';
import { CONSTRUCTS, PRELUDE, generateCalls, generateFormats, generateOperators } from './helpers/py-fuzz-table.ts';

const interpreter = (process.env.PY_FUZZ_PYTHON ?? python()).split(/\s+/);

type Rec = { out: string; exc: string; msg: string };

/** The whole batch in one process, on stdin, because starting Python 70,000 times would take an hour. */
function runReal(script: string): string {
  // -I so nothing on this machine can change the answers. On stdin, because a program this
  // long as an argument hits Windows' command line limit.
  const r = spawnSync(interpreter[0], [...interpreter.slice(1), '-I', '-X', 'utf8', '-'], { encoding: 'utf8', input: script, maxBuffer: 2 ** 30, timeout: 280_000 });
  assert.equal(r.status, 0, `the real interpreter failed: ${r.error ?? ''}\n${(r.stderr ?? '').slice(-2000)}`);
  return r.stdout;
}

const real = (programs: string[], prelude: string): Rec[] => {
  const payload = Buffer.from(JSON.stringify({ programs, prelude })).toString('base64');
  const out = runReal(`
import base64, contextlib, io, json, sys, warnings
warnings.simplefilter("ignore")
data = json.loads(base64.b64decode("${payload}").decode())
base = {"__name__": "__main__", "__doc__": None}
exec(data["prelude"], base)
out = []
for src in data["programs"]:
    buf = io.StringIO()
    sys.stdin = io.StringIO("")
    rec = {"out": "", "exc": "", "msg": ""}
    try:
        code = compile(src, "<p>", "exec")
    except SyntaxError as e:
        rec.update(exc=type(e).__name__, msg=e.msg or "")
    else:
        try:
            with contextlib.redirect_stdout(buf):
                exec(code, dict(base))
        except BaseException as e:
            try:
                msg = str(e)
            except BaseException:
                msg = ""
            rec.update(exc=type(e).__name__, msg=msg)
    rec["out"] = buf.getvalue()
    out.append(rec)
sys.stdout.write(json.dumps(out))
`);
  return JSON.parse(out);
};

function lab(src: string, prelude: string): Rec & { status: string } {
  const p = new PyProgram(src, { maxOps: 300_000, given: prelude });
  p.run();
  return { status: p.status, out: p.stdout, exc: p.error?.type ?? '', msg: p.error?.message ?? '' };
}

// An address in a repr is different on every run of real Python.
const scrub = (s: string) => s.replace(/ at 0x[0-9a-fA-F]+/g, ' at 0x');

type Verdict = 'same' | 'refused-valid' | 'refused-invalid' | 'accepted' | 'wrong';

// ---- The accepted differences. Each one says why, and tests below pin it where that can be pinned.
//
// Sets' order: never compared here, because show() sorts them, and the lessons tell the
// learner not to rely on it. Python's own order isn't promised either.
// id() and addresses: scrubbed or reduced to a type by the table, since neither is meaningful.
// Message wording: only the exception's type is compared. Wording moves between versions, and
// the exact messages the lessons quote are held by tests/py-beginner-errors.test.ts.
//
// What's left is below. A difference needs a reason a real learner couldn't be misled by.
const minorVersion = Number(runReal('import sys\nprint(sys.version_info[1])'));
const NAN_SAME_OBJECT = 'x = float("nan")\nprint(x in [x], [x] == [x])';
const UNDEFINED_ANNOTATION = 'x: Nope = 1\nprint(x)';
const ACCEPTED: { why: string; matches: (src: string, r: Rec, l: Rec) => boolean }[] = [
  {
    // The sandbox follows 3.12 and CI compares against it. These only apply to an older
    // interpreter, like the 3.11 on the machine this was written on, and never fire on 3.12.
    why: 'before 3.12, reverse= and keepends= had to be integers; from 3.12 they are tested for truth',
    matches: (src, r) => minorVersion < 12 && (r.exc === 'TypeError' || r.exc === 'OverflowError') && /reverse=|splitlines|keepends/.test(src),
  },
  {
    why: 'slices became hashable in 3.12, so {}[1:2] is a KeyError there and "unhashable" before',
    matches: (_src, r) => minorVersion < 12 && r.exc === 'TypeError' && r.msg === "unhashable type: 'slice'",
  },
  {
    // Floats have no identity in the sandbox. A fresh NaN agrees either way; this is the same one twice.
    why: 'a NaN is found in a list holding that same NaN on real Python, because it checks identity first',
    matches: (src, r) => src === NAN_SAME_OBJECT && r.out === 'True True\n',
  },
  {
    // Python 3.14 stopped evaluating annotations until something asks, so what the sandbox
    // does here (never look at them) is what a new install does, and 3.12 is the odd one out.
    why: 'annotations are evaluated on 3.12 and earlier, so an undefined name in one is a NameError there',
    matches: (src, r) => src === UNDEFINED_ANNOTATION && r.exc === 'NameError' && minorVersion < 14,
  },
  {
    why: 'int.is_integer arrived in 3.12',
    matches: (src, r) => minorVersion < 12 && r.exc === 'AttributeError' && src.includes('is_integer'),
  },
];

function judge(src: string, r: Rec, l: Rec & { status: string }): Verdict {
  if (l.status === 'crash' || l.status === 'budget' || l.status === 'output') return 'wrong';
  if (l.exc === 'SandboxLimit') {
    // What it printed before the refusal still has to be right.
    if (!scrub(r.out).startsWith(scrub(l.out))) return 'wrong';
    return r.exc ? 'refused-invalid' : 'refused-valid';
  }
  if (scrub(r.out) === scrub(l.out) && r.exc === l.exc) return 'same';
  return ACCEPTED.some((a) => a.matches(src, r, l)) ? 'accepted' : 'wrong';
}

function compare(programs: string[]) {
  const results = real(programs, PRELUDE);
  assert.equal(results.length, programs.length);
  const counts: Record<Verdict, number> = { same: 0, 'refused-valid': 0, 'refused-invalid': 0, accepted: 0, wrong: 0 };
  const wrong: string[] = [], refused: string[] = [];
  let sameMessage = 0, bothRaised = 0;
  programs.forEach((src, i) => {
    const r = results[i], l = lab(src, PRELUDE), v = judge(src, r, l);
    counts[v]++;
    if (v === 'wrong') wrong.push(`${JSON.stringify(src)}\n  real ${JSON.stringify(r)}\n  lab  ${JSON.stringify(l)}`);
    if (v === 'refused-valid') refused.push(`${JSON.stringify(src)} -> ${l.msg}`);
    if (v === 'same' && r.exc) { bothRaised++; if (r.msg === l.msg) sameMessage++; }
  });
  return { counts, wrong, refused, sameMessage, bothRaised, total: programs.length };
}

function report(name: string, c: ReturnType<typeof compare>) {
  if (process.env.PY_FUZZ_REPORT) {
    console.log(`${name}: ${c.total} programs, ${JSON.stringify(c.counts)}; of ${c.bothRaised} where both raised the same type, ${c.sameMessage} had the same message`);
    if (process.env.PY_FUZZ_DUMP) writeFileSync(`${process.env.PY_FUZZ_DUMP}/${name}.txt`, `WRONG ${c.wrong.length}\n${c.wrong.join('\n')}\n\nREFUSED ${c.refused.length}\n${c.refused.join('\n')}\n`);
  }
  assert.equal(c.wrong.length, 0, `${c.wrong.length} of ${c.total} differ:\n${c.wrong.slice(0, 60).join('\n')}`);
}

// Real Python's own list of what each type has, so a method added to a later Python gets fuzzed.
function methodNames(): Record<string, string[]> {
  const out = runReal(`
import json, sys
print(json.dumps({t.__name__: sorted(n for n in dir(t) if not n.startswith("_")) for t in (str, list, tuple, dict, set, int, float, bool, range)}))`);
  return JSON.parse(out);
}

test('every built-in function and method, over a table of argument shapes, matches real Python or is refused by name', () => {
  const programs = generateCalls(methodNames());
  assert.ok(programs.length > 20_000, `only ${programs.length} programs`);
  const c = compare(programs);
  report('calls', c);
  // Most odd arguments raise, so this also has to have reached real answers, on both sides.
  assert.ok(c.counts.same - c.bothRaised > 5000, `only ${c.counts.same - c.bothRaised} programs gave an answer on both`);
  assert.ok(c.bothRaised > 5000, `only ${c.bothRaised} programs raised on both`);
});

test('operators, subscripts and slices over a table of operands', () => {
  report('operators', compare(generateOperators()));
});

test('format specs, f-strings and str.format', () => {
  report('formats', compare(generateFormats()));
});

test('constructs: valid Python never gets an error real Python would not give', () => {
  const c = compare([...CONSTRUCTS, NAN_SAME_OBJECT, UNDEFINED_ANNOTATION]);
  report('constructs', c);
  // Refusing is allowed, so a refusal by name has to be the thing it says it is.
  for (const line of c.refused) assert.match(line, /real Python|this sandbox/, line);
});

test('every name in real Python\'s dir(builtins) is defined here, or refused by name: never a NameError', () => {
  const names: string[] = JSON.parse(runReal('import builtins, json\nprint(json.dumps(dir(builtins)))'));
  assert.ok(names.includes('print') && names.includes('SyntaxError'));
  const wrong = names.filter((n) => {
    const p = new PyProgram(`x = ${n}`);
    p.run();
    return p.error?.type === 'NameError';
  });
  assert.deepEqual(wrong, []);
});

test('the fuzz can see a difference: a deliberate one fails, and so does a crash', () => {
  // A comparison that can't fail reads as parity. Both of these have to be caught.
  assert.equal(judge('x', { out: '3\n', exc: '', msg: '' }, { status: 'done', out: '2\n', exc: '', msg: '' }), 'wrong', 'different output');
  assert.equal(judge('x', { out: '', exc: 'TypeError', msg: '' }, { status: 'done', out: '', exc: '', msg: '' }), 'wrong', 'ran where real Python raises');
  assert.equal(judge('x', { out: '', exc: '', msg: '' }, { status: 'crash', out: '', exc: 'SandboxBug', msg: 'TypeError: bigint is not iterable' }), 'wrong', 'raw JavaScript error');
  assert.equal(judge('x', { out: 'a\n', exc: '', msg: '' }, { status: 'error', out: 'b\n', exc: 'SandboxLimit', msg: 'no' }), 'wrong', 'wrong output before a refusal');
  assert.equal(judge('x', { out: 'a\n', exc: '', msg: '' }, { status: 'error', out: 'a\n', exc: 'SandboxLimit', msg: 'no' }), 'refused-valid');
  // The original failures, through the real comparison.
  const [find] = real(['print("hello".find("l", 3))'], PRELUDE);
  assert.equal(find.out, '3\n');
  assert.equal(lab('print("hello".find("l", 3))', PRELUDE).out, '3\n');
  assert.equal(lab('print("a1".strip(1))', PRELUDE).exc, 'TypeError');
});
