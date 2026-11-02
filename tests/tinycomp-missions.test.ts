// The two code-lab missions, played from starter to finish in the lab and on real Python,
// with the shortcuts a learner might try. A tick may never be lost on the way, and all of
// them must hold at once at the end: a mission that can't finish looks like the learner's
// fault (tests/prog-missions-finish.test.ts has the story).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PyProgram } from '../src/lib/py/vm.ts';
import { summarise } from '../src/lib/py/lab.ts';
import { ANSWER_CASES, BRACKET_CASES, COMPILER_CODE_MISSIONS, FOLD_VALUE_CASES, LEFT_CASES, PRECEDENCE_CASES } from '../src/lib/cs/tinycomp-missions.ts';
import { CODE_MISSIONS } from '../src/lib/cs/missions.ts';
import { python, runPython } from './helpers/python.ts';

python();

function play(id: string, stages: string[]) {
  const m = COMPILER_CODE_MISSIONS[id];
  const s = m.setup();
  const seen: number[] = [];
  const ticks = () => { let n = 0; for (const st of m.steps) { if (!st.done(s)) break; n++; } return n; };
  for (const src of stages) {
    const p = new PyProgram(src, { given: m.given });
    p.run();
    s.runs.push(summarise(p, src));
    seen.push(ticks());
  }
  return { seen, total: m.steps.length, s, m };
}

const realOut = (id: string, src: string) => {
  const m = COMPILER_CODE_MISSIONS[id];
  return runPython(`${m.given ?? ''}\n${src}`);
};

const replaceOnce = (s: string, a: string, b: string) => { assert.ok(s.includes(a), `no ${a}`); return s.replace(a, b); };

const P0 = COMPILER_CODE_MISSIONS['comp-parse-fix'].starter!;
const P1 = replaceOnce(P0, `    left = parse_number(toks)
    if len(toks) > 0 and toks[0] in ("+", "-"):
        op = toks.pop(0)
        right = parse_expr(toks)
        return (op, left, right)
    return left`, `    left = parse_number(toks)
    while len(toks) > 0 and toks[0] in ("+", "-"):
        op = toks.pop(0)
        left = (op, left, parse_number(toks))
    return left`);
const P2 = replaceOnce(replaceOnce(P1, 'def parse_expr(toks):\n    left = parse_number(toks)', `def parse_term(toks):
    left = parse_number(toks)
    while len(toks) > 0 and toks[0] in ("*", "/"):
        op = toks.pop(0)
        left = (op, left, parse_number(toks))
    return left

def parse_expr(toks):
    left = parse_term(toks)`), 'left = (op, left, parse_number(toks))\n    return left\n\ndef calc', 'left = (op, left, parse_term(toks))\n    return left\n\ndef calc');
const P3 = replaceOnce(P2, `def parse_number(toks):
    return toks.pop(0)`, `def parse_number(toks):
    if toks[0] == "(":
        toks.pop(0)
        inner = parse_expr(toks)
        toks.pop(0)
        return inner
    return toks.pop(0)`);

test('parser mission: starter to finish, ticks only ever added, all four hold at the end', () => {
  const { seen, total, s, m } = play('comp-parse-fix', [P0, P1, P2, P3]);
  assert.deepEqual(seen, [1, 2, 3, 4], JSON.stringify(seen));
  assert.equal(total, 4);
  assert.ok(m.steps.every((st) => st.done(s)));
});

test('parser mission: the starter says what the mission says it says', () => {
  const p = new PyProgram(P0);
  p.run();
  assert.equal(p.status, 'done');
  assert.equal(p.stdout, "('-', 10, ('-', 3, 2))\n9\n");
  assert.equal(runPython(P0).stdout, p.stdout);
});

test('parser mission: someone who is right on the first run is not stranded', () => {
  const { seen, total } = play('comp-parse-fix', [P3]);
  assert.deepEqual(seen, [total]);
});

test('parser mission: tempting wrong answers do not pass', () => {
  // Special-casing the visible example.
  const cheat = replaceOnce(P0, 'def value(text):\n    return calc(parse_expr(tokens(text)))', 'def value(text):\n    if text == "10 - 3 - 2":\n        return 5\n    return calc(parse_expr(tokens(text)))');
  assert.equal(play('comp-parse-fix', [cheat]).seen[0], 1);
  // Reversing the tokens makes left grouping out of right grouping, and breaks the operators' meaning.
  const reversed = replaceOnce(P0, 'return calc(parse_expr(tokens(text)))', 'return calc(parse_expr(tokens(text)[::-1]))');
  assert.equal(play('comp-parse-fix', [reversed]).seen[0], 1);
  // Flat: one loop over every operator gets left grouping and no precedence.
  const flat = replaceOnce(P1, 'toks[0] in ("+", "-")', 'toks[0] in ("+", "-", "*", "/")');
  assert.equal(play('comp-parse-fix', [flat]).seen[0], 2);
  // Real Python's eval would make this easy, so it must not exist in the sandbox: the
  // program stops with a NameError, and not even the first tick comes.
  const viaEval = replaceOnce(P0, 'def value(text):\n    return calc(parse_expr(tokens(text)))', 'def value(text):\n    return eval(text)');
  assert.equal(play('comp-parse-fix', [viaEval]).seen[0], 0);
});

test('parser mission: a differently shaped right answer passes', () => {
  // A table of precedence levels with one loop, a precedence-climbing parser. Nothing the hints mention.
  const climbing = replaceOnce(P0, `def parse_number(toks):
    return toks.pop(0)

def parse_expr(toks):
    left = parse_number(toks)
    if len(toks) > 0 and toks[0] in ("+", "-"):
        op = toks.pop(0)
        right = parse_expr(toks)
        return (op, left, right)
    return left`, `LEVEL = {"+": 1, "-": 1, "*": 2, "/": 2}

def parse_number(toks):
    t = toks.pop(0)
    if t == "(":
        inner = parse_expr(toks)
        toks.pop(0)
        return inner
    return t

def parse_expr(toks, floor=1):
    left = parse_number(toks)
    while len(toks) > 0 and toks[0] in LEVEL and LEVEL[toks[0]] >= floor:
        op = toks.pop(0)
        left = (op, left, parse_expr(toks, LEVEL[op] + 1))
    return left`);
  const { seen, total } = play('comp-parse-fix', [climbing]);
  assert.deepEqual(seen, [total]);
});

test('the answers the parser mission demands are what real Python says, including the worked fix', () => {
  for (const c of [...LEFT_CASES, ...PRECEDENCE_CASES, ...BRACKET_CASES]) {
    const r = runPython(`print(repr(${c.args[0]}))`);
    assert.equal(r.stdout.trim(), c.want, String(c.args[0]));
  }
  // The finished parser, on real Python, agrees with real Python's own arithmetic.
  const r = runPython(`${P3}\nfor t in ${JSON.stringify([...LEFT_CASES, ...PRECEDENCE_CASES, ...BRACKET_CASES].map((c) => c.args[0]))}:\n    assert value(t) == eval(t), t\nprint("ok")\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ok\n$/);
});

const G0 = COMPILER_CODE_MISSIONS['comp-gen-stack'].starter!;
const G1 = replaceOnce(G0, 'gen(right) + gen(left)', 'gen(left) + gen(right)');
const G2 = replaceOnce(G1, `def fold(tree):
    return tree`, `def fold(tree):
    if type(tree) != tuple:
        return tree
    op, left, right = tree
    left = fold(left)
    right = fold(right)
    if type(left) not in (str, tuple) and type(right) not in (str, tuple):
        try:
            return run(gen((op, left, right)))
        except ZeroDivisionError:
            pass
    return (op, left, right)`);

test('generator mission: starter to finish, ticks only ever added, all hold at the end', () => {
  const { seen, total, s, m } = play('comp-gen-stack', [G0, G1, G2]);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(total, 3);
  assert.ok(m.steps.every((st) => st.done(s)));
});

test('generator mission: the starter says what the mission says it says, in both interpreters', () => {
  const p = new PyProgram(G0, { given: COMPILER_CODE_MISSIONS['comp-gen-stack'].given });
  p.run();
  assert.equal(p.status, 'done', p.error?.message);
  assert.match(p.stdout, /-7\n$/);
  assert.equal(realOut('comp-gen-stack', G0).stdout, p.stdout);
  assert.equal(realOut('comp-gen-stack', G2).stdout, (() => { const q = new PyProgram(G2, { given: COMPILER_CODE_MISSIONS['comp-gen-stack'].given }); q.run(); return q.stdout; })());
});

test('generator mission: the right-first-time learner is not stranded, and shortcuts fail', () => {
  assert.deepEqual(play('comp-gen-stack', [G2]).seen, [3]);
  // A fold that evaluates everything crashes the compile on 1 / 0.
  const greedy = replaceOnce(G2, `        try:
            return run(gen((op, left, right)))
        except ZeroDivisionError:
            pass`, '        return run(gen((op, left, right)))');
  assert.equal(play('comp-gen-stack', [greedy]).seen[0], 2);
  // A fold that turns a failure into a number changes what the program means.
  const swallow = replaceOnce(G2, `        except ZeroDivisionError:
            pass`, `        except ZeroDivisionError:
            return 0`);
  assert.equal(play('comp-gen-stack', [swallow]).seen[0], 2);
  // A fold that does nothing keeps the answers and doesn't get shorter.
  assert.equal(play('comp-gen-stack', [G1]).seen[0], 2);
  // An interpreter in gen's clothing: gen computes the answer itself and pushes one number.
  const noCode = replaceOnce(G1, `    op, left, right = tree
    return gen(left) + gen(right) + [(op,)]`, `    return [("PUSH", tree)]`);
  assert.equal(play('comp-gen-stack', [noCode]).seen[0], 1);
  // Rewriting x + 2 + 3 into x + 5 passed all three steps, though the lesson's own trap says
  // that rewrite isn't safe. On this mission's whole numbers it gives the right answers, and
  // that's the point: it has to be stopped by the program's shape.
  const rearranged = replaceOnce(G2, `    left = fold(left)
    right = fold(right)
`, `    left = fold(left)
    right = fold(right)
    if op == "+" and type(left) == tuple and left[0] == "+" and type(left[2]) != str and type(right) != str and type(right) != tuple and type(left[2]) != tuple:
        return ("+", left[1], left[2] + right)
`);
  assert.equal(play('comp-gen-stack', [rearranged]).seen[0], 2);
  assert.equal((() => { const p = new PyProgram(`${rearranged}\nprint(answer("x + 2 + 3"), folded_answer("x + 2 + 3"), instructions("x + 2 + 3"))`, { given: COMPILER_CODE_MISSIONS['comp-gen-stack'].given }); p.run(); return p.stdout.trim().split('\n').at(-1); })(), '15 15 3');
  // Swapping back must take the tick away again.
  const wrongOrder = replaceOnce(G1, 'gen(left) + gen(right)', 'gen(right) + gen(left)');
  assert.equal(play('comp-gen-stack', [wrongOrder]).seen[0], 1);
});

test('generator mission: a differently shaped right answer passes', () => {
  // Folds through a table of operations rather than through run().
  const table = replaceOnce(G1, `def fold(tree):
    return tree`, `def fold(tree):
    if type(tree) != tuple:
        return tree
    op = tree[0]
    a = fold(tree[1])
    b = fold(tree[2])
    numbers = (int, float)
    if isinstance(a, numbers) and isinstance(b, numbers):
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op == "/" and b != 0:
            return a / b
    return (op, a, b)`);
  assert.deepEqual(play('comp-gen-stack', [table]).seen, [3]);
});

test('the answers the generator mission demands are what real Python says', () => {
  for (const c of [...ANSWER_CASES, ...FOLD_VALUE_CASES]) {
    const r = runPython(`x = 10\nprint(repr(${c.args[0]}))`);
    assert.equal(r.stdout.trim(), c.want, String(c.args[0]));
  }
});

test('both missions are reachable from the code lab', () => {
  assert.ok(CODE_MISSIONS['comp-parse-fix']);
  assert.ok(CODE_MISSIONS['comp-gen-stack']);
});
