// A learner in Programming from Zero causes each of these on purpose and reads what
// comes back. So this compares type, message, line and output exactly, against real
// Python, and fails rather than skips when Python is missing.
//
// Original failures pinned here: `if x = 5:` said "expected ':'"; print('it's') said
// "real Python has s'' strings"; "\U0001F600" printed as ten characters of text; a
// tab beside spaces ran instead of raising TabError; for x in 5 blamed line 0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PyProgram } from '../src/lib/py/vm.ts';
import { python, runPython } from './helpers/python.ts';
import { BEGINNER_PROGRAMS } from './helpers/beginner-programs.ts';

python();

// Reads Python's own report per program. str(e) has no "Did you mean": the traceback
// printer adds that, and the lessons say so. The innermost frame is the line the lab
// names first, then it lists the calls that led there.
const DRIVER = (programs: string[]) => `
import contextlib, io, json, traceback
out = []
for src in json.loads(${JSON.stringify(JSON.stringify(programs))}):
    buf = io.StringIO()
    rec = {"out": "", "type": "", "msg": "", "line": 0}
    try:
        code = compile(src, "<p>", "exec")
    except SyntaxError as e:
        rec.update(type=type(e).__name__, msg=e.msg, line=e.lineno or 0)
    else:
        try:
            with contextlib.redirect_stdout(buf):
                exec(code, {"__name__": "__main__"})
        except Exception as e:
            frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename == "<p>"]
            rec.update(type=type(e).__name__, msg=str(e), line=frames[-1].lineno if frames else 0)
    rec["out"] = buf.getvalue()
    out.append(rec)
print(json.dumps(out))
`;

function ours(src: string) {
  const p = new PyProgram(src, { maxOps: 200_000 });
  p.run();
  return { out: p.stdout, type: p.error?.type ?? '', msg: p.error?.message ?? '', line: p.error?.line ?? 0 };
}

test('a beginner mistake reads the same here as on real Python: type, message, line, output', () => {
  const r = runPython(DRIVER(BEGINNER_PROGRAMS));
  assert.equal(r.status, 0, r.stderr);
  const real = JSON.parse(r.stdout) as ReturnType<typeof ours>[];
  assert.equal(real.length, BEGINNER_PROGRAMS.length);
  const wrong: string[] = [];
  BEGINNER_PROGRAMS.forEach((src, i) => {
    const a = real[i], b = ours(src);
    if (JSON.stringify(a) !== JSON.stringify(b)) wrong.push(`${JSON.stringify(src)}\n  real ${JSON.stringify(a)}\n  ours ${JSON.stringify(b)}`);
  });
  assert.equal(wrong.length, 0, `${wrong.length} of ${BEGINNER_PROGRAMS.length} differ:\n${wrong.join('\n')}`);
});

test('the list really does contain errors, so the comparison above cannot pass on nothing', () => {
  const failing = BEGINNER_PROGRAMS.filter((src) => ours(src).type !== '').length;
  assert.ok(failing > 100, `only ${failing} programs raise`);
});

test("the sandbox's table of real methods matches dir() on real Python", () => {
  const r = runPython(`
import json
print(json.dumps({t.__name__: sorted(n for n in dir(t) if not n.startswith("_")) for t in (str, list, tuple, dict, set)}))`);
  const real = JSON.parse(r.stdout) as Record<string, string[]>;
  const instance: Record<string, string> = { str: '"x"', list: '[1]', tuple: '(1, 2)', dict: '{"a": 1}', set: '{1}' };
  for (const [kind, names] of Object.entries(real)) {
    for (const name of names) {
      // Reading the attribute, not calling it: having it, or being refused by name, are the only right answers.
      const p = new PyProgram(`x = ${instance[kind]}.${name}`);
      p.run();
      assert.notEqual(p.error?.type, 'AttributeError', `${kind}.${name} exists on real Python, and this says it doesn't`);
    }
  }
  const made = new PyProgram('[].push');
  made.run();
  assert.equal(made.error?.type, 'AttributeError');
  assert.equal(made.error?.message, "'list' object has no attribute 'push'");
  const gap = new PyProgram('"".casefold');
  gap.run();
  assert.equal(gap.error?.type, 'SandboxLimit', 'a real method this sandbox lacks must never read as the learner\'s mistake');
});

test('a program that opens with a for loop steps once per header visit, and an error in its header names the line', () => {
  const stops: number[] = [];
  const q = new PyProgram('for i in range(2):\n    print(i)\n');
  stops.push(q.nextLine);
  while (!q.finished) { q.stepLine(); if (!q.finished) stops.push(q.nextLine); }
  assert.deepEqual(stops, [1, 2, 1, 2, 1]);
  assert.equal(q.stdout, '0\n1\n');
  // The line number costs no step: published step counts in other lessons depend on that.
  const p = new PyProgram('for i in range(3):\n    pass\n');
  p.run();
  assert.equal(p.ops, 12);
});
