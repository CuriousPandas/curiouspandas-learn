// The tiny compiler against real Python. Python is the ground truth for what an expression
// means, so every generated expression must give the same answer or the same type of
// exception, through the tree, the stack machine, the register machine and folding, and
// parse errors must land where Python's land. Fails rather than skips without Python.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../src/lib/py/vm.ts';
import {
  GenLab, LAB_ENV, LIMIT_NOTE, MAX_TEXT, PRINT_NOTE, ParseLab, TinySyntaxError, bracketed, checkNames, compile, evaluate, fold, genCaughtSwap, genFoldKeptError, genFolded, genRegisters, genSawStack, genSpilled, genStack, generate, isPythonNumber, layout, parse, parseCaught, parseHidden, parseSawPointer, parseSawPrecedence, parseVerdict, runRegisters, runStack, sameTree, showValue, tokenize, type Outcome,
} from '../src/lib/cs/tinycomp.ts';
import { python, runPython } from './helpers/python.ts';

python();

// A small generator with no Math.random, so a failure can be reproduced.
class Rng {
  s: number;
  constructor(seed: number) { this.s = seed >>> 0; }
  next() { this.s = (Math.imul(this.s, 1664525) + 1013904223) >>> 0; return this.s; }
  int(n: number) { return (this.next() >>> 8) % n; }
  pick<T>(xs: T[]) { return xs[this.int(xs.length)]; }
}

const ENV_PY = '{"x": 7, "y": 2}';

/** Real Python's reading of each text: value, or exception type. */
function realEval(texts: string[]): { ok: boolean; text: string }[] {
  const payload = Buffer.from(JSON.stringify(texts)).toString('base64');
  const r = runPython(`
import base64, json, warnings
warnings.simplefilter("ignore")
texts = json.loads(base64.b64decode("${payload}").decode())
out = []
for t in texts:
    try:
        v = eval(compile(t, "<e>", "eval"), dict(${ENV_PY}))
        out.append({"ok": True, "text": repr(v)})
    except Exception as e:
        out.append({"ok": False, "text": type(e).__name__})
print(json.dumps(out))
`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

/** Exponents stay small: 9**9**9 is a legal expression that would hang real Python for hours. */
function genExpr(r: Rng, depth: number): string {
  const space = () => r.pick(['', '', ' ', '  ']);
  if (depth === 0 || r.int(5) === 0) {
    return r.pick(['0', '1', '2', '3', '5', '7', '10', '12', '100', '1.5', '0.5', '2.5', '.25', '3.', 'x', 'y', '0.1', '1000000007']);
  }
  switch (r.int(10)) {
    case 0: case 1: return `${r.pick(['-', '+', '- '])}${genExpr(r, depth - 1)}`;
    case 2: return `(${space()}${genExpr(r, depth - 1)}${space()})`;
    case 3: return `${genExpr(r, depth - 1)}${space()}**${space()}${r.pick(['0', '1', '2', '3', '-1', '-2', '- 1', '0.5', '(1/2)'])}`;
    default: {
      const op = r.pick(['+', '-', '*', '/', '//', '%', '+', '-', '*']);
      return `${genExpr(r, depth - 1)}${space()}${op}${space()}${genExpr(r, depth - 1)}`;
    }
  }
}

const sameOutcome = (mine: Outcome, real: { ok: boolean; text: string }) => (mine.ok ? real.ok && mine.text === real.text : !real.ok && mine.error.type === real.text);

// Float powers go through JavaScript's Math.pow where Python uses the platform's C library,
// and the two can differ in the last digit. Everything else is exact.
const closeEnough = (mine: Outcome, real: { ok: boolean; text: string }) => {
  if (!mine.ok || !real.ok) return false;
  const a = Number(mine.text), b = Number(real.text);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-12 * Math.max(Math.abs(a), Math.abs(b));
};

test('differential: 6,000 generated expressions give what real Python gives, by every route', () => {
  const r = new Rng(20261101);
  const texts = Array.from({ length: 6000 }, () => genExpr(r, 1 + r.int(6)));
  const real = realEval(texts);
  let errors = 0, limits = 0, compared = 0, lastDigit = 0;
  const lastDigitTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i], want = real[i];
    const tree = parse(t);
    const direct = evaluate(tree, LAB_ENV);
    const stack = runStack(genStack(tree), LAB_ENV).outcome;
    const folded = runStack(genStack(fold(tree)), LAB_ENV).outcome;
    const reg2 = runRegisters(genRegisters(tree, 2), LAB_ENV);
    const reg5 = runRegisters(genRegisters(fold(tree), 5), LAB_ENV);
    for (const [route, got] of Object.entries({ direct, stack, folded, reg2, reg5 })) {
      // A complex result is refused by name, the one thing that may differ from Python: a
      // value this page has no way to show. It must be a refusal, never a wrong number.
      if (!got.ok && got.error.type === 'SandboxLimit') { limits++; assert.match(want.text, /[0-9]j\)?$|^[(]/, `${t}: refused, but Python gave ${want.text}`); continue; }
      if (sameOutcome(got, want)) continue;
      if (closeEnough(got, want)) { lastDigit++; if (lastDigitTexts.length < 3) lastDigitTexts.push(`${t}: ${(got as { text: string }).text} vs ${want.text}`); continue; }
      assert.fail(`${route} differs for ${JSON.stringify(t)}: mine ${got.ok ? got.text : got.error.type}, Python ${JSON.stringify(want)}`);
    }
    compared++;
    if (!want.ok) errors++;
  }
  assert.equal(compared, 6000);
  // A fuzz that never reached a failure or a negative power would prove little.
  assert.ok(errors > 200, `only ${errors} expressions raised`);
  if (process.env.TINY_REPORT) console.log({ compared, errors, limits, lastDigit, lastDigitTexts });
  // Named so that a change in the rate gets noticed: the last digit isn't a licence to drift.
  assert.ok(lastDigit < 150, `${lastDigit} last-digit differences`);
});

test('precedence and associativity, read off the tree as well as the answer', () => {
  const cases: [string, string][] = [
    ['1 + 2 * 3', '(1 + (2 * 3))'],
    ['(1 + 2) * 3', '((1 + 2) * 3)'],
    ['10 - 3 - 2', '((10 - 3) - 2)'],
    ['100 / 10 / 5', '((100 / 10) / 5)'],
    ['2 ** 3 ** 2', '(2 ** (3 ** 2))'],
    ['-2 ** 2', '(-(2 ** 2))'],
    ['2 ** -1', '(2 ** (-1))'],
    ['- - 3', '(-(-3))'],
    ['7 // 2 * 2', '((7 // 2) * 2)'],
    ['7 % 3 + 1', '((7 % 3) + 1)'],
  ];
  for (const [t, want] of cases) assert.equal(bracketed(parse(t)), want, t);
});

test('division semantics match Python on the cases people get wrong', () => {
  const texts = ['7 / 2', '6 / 2', '7 // 2', '-7 // 2', '7 // -2', '-7 % 3', '7 % -3', '1.0 // 0.1', '5.5 % 2', '2 ** -1', '0 ** 0', '(-8) ** 3', '1 / 0', '1 // 0', '1 % 0', '0 ** -1', '1.5 // 0', '10 / 3', '(10 / 1) ** 400', '1000000007 * 1000000007 * 1000000007'];
  const real = realEval(texts);
  texts.forEach((t, i) => {
    const got = evaluate(parse(t));
    assert.ok(sameOutcome(got, real[i]), `${t}: ${got.ok ? got.text : got.error.type} vs ${real[i].text}`);
  });
  assert.equal((evaluate(parse('6 / 2')) as { text: string }).text, '3.0');
  assert.equal((evaluate(parse('-7 // 2')) as { text: string }).text, '-4');
});

/** Python's own verdict on arbitrary text. */
function realSyntax(texts: string[]): { ok: boolean; offset: number | null; msg: string }[] {
  const payload = Buffer.from(JSON.stringify(texts)).toString('base64');
  const r = runPython(`
import base64, json, warnings
warnings.simplefilter("ignore")
texts = json.loads(base64.b64decode("${payload}").decode())
out = []
for t in texts:
    try:
        compile(t, "<e>", "eval")
        out.append({"ok": True, "offset": None, "msg": ""})
    except SyntaxError as e:
        out.append({"ok": False, "offset": e.offset, "msg": e.msg})
print(json.dumps(out))
`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('fuzz: token soup is accepted or rejected as Python does, and errors point where Python points', () => {
  const r = new Rng(7);
  const parts = ['1', '22', '3.5', 'x', '+', '-', '*', '/', '//', '%', '**', '(', ')', ' ', ' '];
  // Trimmed: compile() treats a leading space as an indent where eval() ignores it, a
  // difference about statements that this one-line language has no use for.
  const texts = Array.from({ length: 8000 }, () => Array.from({ length: 1 + r.int(9) }, () => r.pick(parts)).join('').trim());
  const real = realSyntax(texts);
  let accepted = 0, rejected = 0, comparedPos = 0, calls = 0, comma = 0, ended = 0, tokenizerFirst = 0, insideOpen = 0, star = 0;
  const posDiffs: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    const t = texts[i], want = real[i];
    // Blank text: Python reports it at its own spot. Ours says there is nothing yet.
    if (t === '') continue;
    let mine: TinySyntaxError | null = null;
    try { parse(t); } catch (e) { if (e instanceof TinySyntaxError) mine = e; else throw e; }
    if (mine?.kind === 'refused') {
      // The only refusals soup can reach: a bracket after a value, which is a call in Python,
      // and an empty tuple. Each is read by Python as something this language doesn't have.
      assert.ok(/call in Python|empty tuple/.test(mine.message), `${t}: ${mine.message}`);
      calls++;
      continue;
    }
    // Python's own tokenizer treats adjacent digits and dots its own way, and we took them
    // as one token too. Anything else that differs is a bug.
    assert.equal(mine === null, want.ok, `${JSON.stringify(t)}: mine ${mine?.message ?? 'accepted'}, Python ${want.ok ? 'accepted' : want.msg}`);
    if (want.ok) { accepted++; continue; }
    rejected++;
    // "Perhaps you forgot a comma" marks a whole range from its start, a hint for a list that
    // this language doesn't have. Ours points at the second value, which is the actual place.
    if (/comma/.test(want.msg)) { comma++; continue; }
    // Where the text just ran out, Python 3.11 reports offset 0, which marks nothing. The
    // place is the end of the text, and ours must say exactly that.
    if (want.offset === 0) {
      ended++;
      assert.equal(mine!.col, t.length, `${JSON.stringify(t)} ran out: ${mine!.message}`);
      continue;
    }
    // These two come from Python's tokenizer, which it runs over the rest of the file after
    // any syntax error, and whose complaint then wins over the parser's. So Python can name a
    // bad ) or literal further along than the first thing wrong. Ours names the first thing.
    if (/unmatched|invalid decimal literal/.test(want.msg) && mine!.col + 1 < want.offset!) { tokenizerFirst++; continue; }
    // Likewise an open bracket, in the cases where Python gets as far as naming it: it doesn't
    // always, as the bracket test below pins. Ours names what went wrong first, which isn't
    // the end of the text.
    if (/never closed/.test(want.msg) && mine!.col < t.length) { insideOpen++; continue; }
    // (* starts a starred item in real Python, as in (*a, b). Not in this language, so ours
    // stops at the star, and Python reads on to the next token.
    if (/^[*]/.test(t.slice(mine!.col)) && /\(\s*$/.test(t.slice(0, mine!.col))) { star++; continue; }
    comparedPos++;
    if (want.offset !== mine!.col + 1) posDiffs.push(`${JSON.stringify(t)}: mine col ${mine!.col + 1} (${mine!.message}), Python ${want.offset} (${want.msg})`);
  }
  if (process.env.TINY_REPORT) console.log({ accepted, rejected, comparedPos, calls, comma, ended, tokenizerFirst, insideOpen, star, posDiffs: posDiffs.length, sample: posDiffs.slice(0, 14) });
  assert.ok(accepted > 300 && rejected > 3000, `${accepted} accepted, ${rejected} rejected`);
  // The exceptions above must stay exceptions: most errors have to be compared exactly.
  assert.ok(comparedPos > 4000, `only ${comparedPos} positions compared`);
  assert.equal(posDiffs.length, 0, posDiffs.slice(0, 10).join('\n'));
});

test('errors point at the right place, by name', () => {
  const at = (t: string) => { try { parse(t); return null; } catch (e) { return e as TinySyntaxError; } };
  assert.equal(at('1 +')!.col, 3);
  assert.equal(at('1 + * 2')!.col, 4);
  assert.equal(at('(1 + 2')!.col, 0);
  assert.match(at('(1 + 2')!.message, /never closed/);
  assert.equal(at('1 + 2)')!.col, 5);
  assert.equal(at('2 3')!.col, 2);
  assert.equal(at('')!.col, 0);
  assert.equal(at('2 ^ 3')!.col, 2);
  assert.equal(at('2 ^ 3')!.kind, 'refused');
  assert.equal(at('2(3)')!.kind, 'refused');
  assert.equal(at('2(3)')!.col, 1);
  assert.equal(at('1e5')!.kind, 'refused');
  assert.equal(at('0x10')!.kind, 'refused');
  assert.equal(at('1_000')!.kind, 'refused');
  assert.equal(at('2x')!.kind, 'syntax');
  assert.equal(at('2x')!.col, 0);
  assert.equal(at('007')!.kind, 'syntax');
  assert.equal(at('if')!.kind, 'refused');
  assert.equal(at('1 @ 2')!.kind, 'syntax');
  assert.equal(at('1 @ 2')!.col, 2);
});

test('refusals name what real Python really does with the same text', () => {
  const real = realSyntax(['1e5', '0x10', '1_000', '2(3)', '2 ^ 3', '007', '2x']);
  // Real Python accepts these, so calling them syntax errors would be false.
  for (const i of [0, 1, 2, 3, 4]) assert.equal(real[i].ok, true);
  // And refuses these.
  for (const i of [5, 6]) assert.equal(real[i].ok, false);
  assert.throws(() => parse('1e5'), /reads 1e5 as a number/);
});

test('the lesson\'s bracket claims: Python reports an unmatched ) from anywhere, and an unclosed ( only sometimes', () => {
  // The lesson said "Python reports the bracket" whenever an error comes before one, which is
  // false for 1 + * (2: Python reports the *. Reported identical on 3.11.9 and 3.12.3 by the review.
  const real = realSyntax(['1 + * (2', '1 + * 2)', '1 2 (3']);
  assert.equal(real[0].offset, 5);
  assert.doesNotMatch(real[0].msg, /never closed/);
  assert.equal(real[1].offset, 8);
  assert.match(real[1].msg, /unmatched/);
  assert.equal(real[2].offset, 5);
  assert.match(real[2].msg, /never closed/);
  // Ours: the first thing wrong in reading order, in all three.
  const col = (t: string) => { try { parse(t); return -1; } catch (e) { return (e as TinySyntaxError).col; } };
  assert.deepEqual(['1 + * (2', '1 + * 2)', '1 2 (3'].map(col), [4, 4, 2]);
});

test('a number the lab calls a number is one in real Python, and a number it calls invalid is not', () => {
  // The lab said "Real Python reads 1_ as a number", and the same of 0b12, 0o9, 1__0 and 1.5_:
  // all syntax errors. It called 1_2e5 a number running into letters, and it is valid. It said
  // 007e5 and 007j can't start with 0, and they are valid. It read 0xe+1 as one bad number,
  // and that is 0xe plus 1. Generated texts are checked both ways, so each message is earned.
  const pyVerdict = (texts: string[]) => {
    const payload = Buffer.from(JSON.stringify(texts)).toString('base64');
    const r = runPython(`
import ast, base64, json, warnings
warnings.simplefilter("ignore")
out = []
for t in json.loads(base64.b64decode("${payload}").decode()):
    try:
        out.append(isinstance(ast.parse(t, mode="eval").body, ast.Constant))
    except SyntaxError:
        out.append(False)
print(json.dumps(out))
`);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as boolean[];
  };
  const r = new Rng(424242);
  const parts = ['0', '1', '7', '9', '_', '_', '.', 'e', 'E', '+', '-', 'j', 'x', 'X', 'b', 'o', 'a', 'f'];
  const named = ['1_', '1__0', '1_000_', '1.5_', '1_.5', '0b12', '0o9', '1_2e5', '1e5', '0x10', '1_000', '1_000.5', '007e5', '007j', '007.5', '0_0', '00_7', '0_7', '0xe', '0xFFj', '0b_1', '1e', '1.e5', '.5j', '1._5', '1e_5', '1e5_0'];
  const fuzz = Array.from({ length: 6000 }, () => (r.int(2) ? '' : '.') + r.pick(['0', '1', '7']) + Array.from({ length: r.int(6) }, () => r.pick(parts)).join(''));
  const texts = [...new Set([...named, ...fuzz])];
  const reads: string[] = [], refuses: string[] = [], whole: string[] = [];
  for (const t of texts) {
    let e: TinySyntaxError | null = null;
    try { parse(t); } catch (x) { if (x instanceof TinySyntaxError) e = x; else throw x; }
    const m = e && /^Real Python (reads|refuses) (\S+)/.exec(e.message);
    if (m) (m[1] === 'reads' ? reads : refuses).push(m[2]);
    whole.push(t);
  }
  const readsReal = pyVerdict(reads), refusesReal = pyVerdict(refuses);
  reads.forEach((w, i) => assert.equal(readsReal[i], true, `the lab says real Python reads ${w}`));
  refuses.forEach((w, i) => assert.equal(refusesReal[i], false, `the lab says real Python refuses ${w}`));
  // And the regex alone, against Python, on every run the fuzz reached.
  const real = pyVerdict(whole);
  const looksLikeOne = /^[0-9.][0-9a-zA-Z_.]*$/;
  whole.forEach((t, i) => { if (looksLikeOne.test(t) && !/\.[a-zA-Z_]/.test(t)) assert.equal(isPythonNumber(t), real[i], `${t}: Python says ${real[i]}`); });
  // A fuzz that never reached either message would prove nothing.
  assert.ok(reads.length > 200 && refuses.length > 500, `${reads.length} reads, ${refuses.length} refuses`);
  // The named failures, one by one.
  const message = (t: string) => { try { parse(t); return ''; } catch (e) { return (e as Error).message; } };
  for (const t of ['1_', '1__0', '0b12', '0o9', '1.5_', '1_.5']) assert.match(message(t), /^Real Python refuses/, t);
  for (const t of ['1_2e5', '007e5', '007j', '1_000.5']) assert.match(message(t), /^Real Python reads/, t);
  assert.match(message('0xe+1'), /reads 0xe as a number/);
  assert.equal(realEval(['0xe+1'])[0].text, '15');
  assert.match(message('007'), /can't start with 0/);
  assert.match(message('2x'), /run straight into letters/);
});

test('deep brackets are refused, never a crash', () => {
  const t = `${'('.repeat(5000)}1${')'.repeat(5000)}`;
  assert.throws(() => parse(t), TinySyntaxError);
  // A power tower real Python would spend hours on stops by name, with no wrong number.
  const big = evaluate(parse('9 ** 9 ** 9'));
  assert.equal(big.ok, false);
  assert.equal((big as { error: { type: string } }).error.type, 'SandboxLimit');
});

test('huge values and long text: an honest error or refusal, never a crash', () => {
  // Real Python refuses to print an int this long as well, and the types must agree.
  assert.equal(realEval(['10 ** 5000'])[0].text, 'ValueError');
  const big = evaluate(parse('10 ** 5000'));
  assert.equal(big.ok, false);
  assert.equal((big as { error: { type: string } }).error.type, 'ValueError');
  // The stack view still has to show it, where the answer line reports the error.
  const r = runStack(genStack(parse('10 ** 5000')));
  assert.match(showValue(r.trace.at(-1)!.stack[0]), /^100000000000\.\.\. \(5001 digits\)$/);
  assert.equal(showValue(14n), '14');
  assert.equal(showValue(3.5), '3.5');
  // A sum thousands of terms long would overflow the tree-walks if it got that far.
  for (const t of [Array(30_000).fill('1').join('+'), '-'.repeat(30_000) + '1', `${Array(30_000).fill('2').join('**')}`]) {
    const c = compile(t);
    assert.equal(c.ok, false);
    assert.equal((c as { error: TinySyntaxError }).error.kind, 'refused');
    assert.ok(generate(t) instanceof TinySyntaxError);
  }
  // And the longest allowed still works all the way through.
  const longest = Array(500).fill('1').join('+');
  assert.ok(longest.length <= MAX_TEXT);
  const g = generate(longest);
  assert.ok(!(g instanceof TinySyntaxError) && (g.truth as { text: string }).text === '500');
});

test('names: an unknown one stops the compile at its own position, where Python waits for run time', () => {
  const r = compile('x + zebra');
  assert.equal(r.ok, false);
  assert.equal((r as { error: TinySyntaxError }).error.kind, 'name');
  assert.equal((r as { error: TinySyntaxError }).error.col, 4);
  assert.equal(realEval(['zebra + 1'])[0].text, 'NameError');
  assert.equal(realSyntax(['zebra + 1'])[0].ok, true);
  assert.doesNotThrow(() => checkNames(parse('x * y'), LAB_ENV));
  // A prototype's property isn't a variable.
  assert.equal(compile('constructor').ok, false);
  assert.equal(compile('toString + 1').ok, false);
});

test('stack machine: the program is exact, and an imbalance is a loud failure', () => {
  assert.deepEqual(genStack(parse('2 + 3 * 4')).map((i) => i.op), ['PUSH', 'PUSH', 'PUSH', 'MUL', 'ADD']);
  assert.deepEqual(runStack(genStack(parse('2 + 3 * 4'))).trace.map((s) => s.stack.map(String)), [['2'], ['2', '3'], ['2', '3', '4'], ['2', '12'], ['14']]);
  assert.throws(() => runStack([{ op: 'PUSH', value: 1n }, { op: 'PUSH', value: 2n }]), /tiny-compiler bug/);
  // A failure stops at the instruction that failed.
  const r = runStack(genStack(parse('1 + 2 / 0 + 3')));
  assert.equal(r.outcome.ok, false);
  assert.equal(r.trace.at(-1)!.instr.op, 'DIV');
  assert.equal(r.trace.at(-1)!.error!.type, 'ZeroDivisionError');
});

test('the swapped generator passes on + and * and fails on -, which is why it survives', () => {
  const swapped = (t: string) => runStack(genStack(parse(t), 'swapped')).outcome;
  assert.equal((swapped('2 + 3') as { text: string }).text, '5');
  assert.equal((swapped('2 * 3') as { text: string }).text, '6');
  assert.equal((swapped('10 - 3') as { text: string }).text, '-7');
  assert.equal((swapped('10 / 4') as { text: string }).text, '0.4');
});

test('registers: fewer registers means more spills, never a different answer', () => {
  const t = parse('(1 + 2) * (3 + 4) - (5 + 6) * (7 + 8)');
  const want = evaluate(t) as { text: string };
  const spills: number[] = [];
  for (let n = 2; n <= 6; n++) {
    const p = genRegisters(t, n);
    spills.push(p.spills);
    assert.equal((runRegisters(p) as { text: string }).text, want.text, `${n} registers`);
    // Never touches a register it doesn't have: the spill path is what's being tested.
    for (const ins of p.code) for (const r of ['d', 'a', 'b'] as const) { const v = (ins as Record<string, unknown>)[r]; if (typeof v === 'number') assert.ok(v < n, `${n}: r${v}`); }
  }
  assert.ok(spills[0] > 0, 'two registers must spill');
  assert.equal(spills.at(-1), 0, 'six is plenty here');
  for (let i = 1; i < spills.length; i++) assert.ok(spills[i] <= spills[i - 1], spills.join());
  assert.throws(() => genRegisters(t, 1), /at least 2/);
});

test('folding shortens the program, keeps the answer, and leaves a failure for run time', () => {
  const a = parse('x + 2 * 3');
  assert.equal(genStack(a).length, 5);
  assert.equal(genStack(fold(a)).length, 3);
  // x + 2 + 3 reads as (x + 2) + 3, so nothing here is constant: folding must not "see" 5.
  assert.equal(genStack(fold(parse('x + 2 + 3'))).length, 5);
  const bad = fold(parse('1 / 0 + 2'));
  assert.equal(bracketed(bad), '((1 / 0) + 2)');
  assert.equal(runStack(genStack(bad)).outcome.ok, false);
  // Too big to be worth storing stays in the program, as CPython's does.
  assert.equal(fold(parse('2 ** 5000')).k, 'bin');
});

/** The instructions, as data. Printed listings change layout and names between versions, and this doesn't depend on either. */
function bytecode(text: string): { op: string; val: unknown; shown: string }[] {
  const r = runPython(`
import dis, json
print(json.dumps([{"op": i.opname, "val": i.argval if isinstance(i.argval, (int, str)) else None, "shown": i.argrepr} for i in dis.get_instructions(${JSON.stringify(text)})]))
`);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('CPython folds what the lesson says it folds, on any Python this runs on', () => {
  // This pinned LOAD_CONST ... (14), which 3.12 prints as RETURN_CONST and 3.14 doesn't print
  // either way, so it was set to fail wherever the site's checks ran on 3.12. What the lesson
  // leans on is stable: the 14 is there, and the arithmetic isn't.
  const folded = bytecode('2 + 3 * 4');
  assert.ok(folded.some((i) => i.val === 14), JSON.stringify(folded));
  assert.ok(!folded.some((i) => /^BINARY/.test(i.op)), JSON.stringify(folded));
  // 1 / 0 + 2 keeps its division for run time.
  assert.ok(bytecode('1 / 0 + 2').some((i) => /^BINARY/.test(i.op) && i.shown === '/'));
  // x + 2 + 3 is (x + 2) + 3, and Python doesn't "see" a 5 either, which the lesson's trap says.
  assert.ok(!bytecode('x + 2 + 3').some((i) => i.val === 5));
});

test('real Python compiles to a stack machine too, which the lesson claims', () => {
  // Names first, then operators after their operands. 3.14 loads a small int with its own
  // instruction, so "loads something" is what's pinned for the constant.
  const ops = bytecode('x + 2 * y').map((i) => i.op).join(' ');
  assert.match(ops, /LOAD_NAME LOAD_\w+ LOAD_NAME BINARY_OP BINARY_OP/);
});

test('tree layout puts each parent over its children and every node on the page', () => {
  const l = layout(parse('1 + 2 * -x'));
  assert.equal(l.nodes.length, 6);
  assert.equal(l.width, 3);
  for (const n of l.nodes) {
    assert.ok(n.x >= 0 && n.x < l.width);
    if (n.parent !== null) assert.equal(n.y, l.nodes[n.parent].y + 1);
  }
  assert.equal(l.nodes[0].label, '+');
  // A unary minus reads as a minus: "-x" as a label looked like a variable called x.
  assert.deepEqual(l.nodes.map((n) => n.label), ['+', '1', '*', '2', '-', 'x']);
});

test('tokens carry their position, and every character is accounted for', () => {
  assert.deepEqual(tokenize('12 + x').map((t) => [t.t, t.text, t.at]), [['num', '12', 0], ['op', '+', 3], ['name', 'x', 5], ['end', '', 6]]);
  assert.equal(tokenize('2**3').filter((t) => t.text === '**').length, 1);
  assert.equal(tokenize('7//2').filter((t) => t.text === '//').length, 1);
});

test('parse lab: the mission plays to the end, with each shortcut refused', () => {
  const lab = new ParseLab();
  assert.equal(parseSawPrecedence(lab), false);
  // Brackets force the shape, so they don't show precedence.
  lab.try('(1 + 2) * 3');
  assert.equal(parseSawPrecedence(lab), false);
  lab.try('1 * 2 + 3');
  assert.equal(parseSawPrecedence(lab), true);
  // An error at column 0 is an empty box, not a mistake found somewhere in a text.
  lab.try('');
  assert.equal(parseSawPointer(lab), false);
  lab.try('1 +');
  assert.equal(parseSawPointer(lab), true);
  // A disagreement needs two finished answers.
  lab.try('1 +', 'flat');
  assert.equal(parseCaught(lab, 'flat'), false);
  lab.try('1 + 2', 'flat');
  assert.equal(parseCaught(lab, 'flat'), false);
  lab.try('1 + 2 * 3', 'flat');
  assert.equal(parseCaught(lab, 'flat'), true);
  lab.try('10 - 3 - 2', 'right');
  assert.equal(parseCaught(lab, 'right'), true);
  assert.equal(parseHidden(lab, 'right'), false);
  // The same tree isn't hidden damage, it's no damage.
  lab.try('1 + 2', 'right');
  assert.equal(parseHidden(lab, 'right'), false);
  lab.try('1 + 2 + 3', 'right');
  assert.equal(parseHidden(lab, 'right'), true);
});

test('parse lab: other right answers pass, including ones the hints never mention', () => {
  const lab = new ParseLab();
  lab.try('8 - 6 / 2');
  assert.equal(parseSawPrecedence(lab), true);
  const l2 = new ParseLab();
  l2.try('x ** 2 % 3 + 1');
  assert.equal(parseSawPrecedence(l2), true);
  const l3 = new ParseLab();
  l3.try('20 / 2 - 5', 'flat');
  assert.equal(parseCaught(l3, 'flat'), false);
  l3.try('2 + 3 * x', 'flat');
  assert.equal(parseCaught(l3, 'flat'), true);
  const l4 = new ParseLab();
  l4.try('x + y + 1', 'right');
  assert.equal(parseHidden(l4, 'right'), true);
});

test('the Excel rule gives the answers its published table implies, with Python alongside', () => {
  const ex = (t: string) => evaluate(parse(t, 'excel')) as { text: string };
  assert.equal(ex('-2 ** 2').text, '4');
  assert.equal(ex('2 ** 3 ** 2').text, '64');
  assert.equal(ex('1 - -2 ** 2').text, '-3');
  assert.deepEqual(realEval(['-2 ** 2', '2 ** 3 ** 2']).map((r) => r.text), ['-4', '512']);
  assert.ok(!sameTree(parse('-2 ** 2', 'excel'), parse('-2 ** 2')));
});

test('the Excel rule keeps every minus: the bug that dropped them, and said "Neither program is broken"', () => {
  // The parser consumed a leading sign and then threw it away, so -5 gave 5, and the widget called
  // that a difference of opinion. Every earlier test used -2 ** 2, where the answer is right from
  // the wrong tree. Each row here is worked by hand from Microsoft's table.
  const rows: [string, string, string][] = [
    ['-5', '(-5)', '-5'],
    ['2 * -3', '(2 * (-3))', '-6'],
    ['-1 + 2', '((-1) + 2)', '1'],
    ['-3 ** 3', '((-3) ** 3)', '-27'],
    ['(-2) ** 3', '((-2) ** 3)', '-8'],
    ['--5', '(-(-5))', '5'],
    ['-2 ** 2', '((-2) ** 2)', '4'],
    ['2 ** -1', '(2 ** (-1))', '0.5'],
    ['2 ** 3 ** 2', '((2 ** 3) ** 2)', '64'],
    ['-(1 + 2) ** 2', '((-(1 + 2)) ** 2)', '9'],
    ['1 - -2 ** 2', '(1 - ((-2) ** 2))', '-3'],
    ['-x + -y', '((-x) + (-y))', '-9'],
  ];
  for (const [text, tree, answer] of rows) {
    assert.equal(bracketed(parse(text, 'excel')), tree, text);
    assert.equal((evaluate(parse(text, 'excel'), LAB_ENV) as { text: string }).text, answer, text);
  }
});

/**
 * Microsoft's table, written out from its page and sharing no code with tinycomp.ts: a table-driven
 * shunting-yard over its own tokens, giving the fully bracketed reading. Negation binds first, then
 * the power, then * and /, then + and -, and equal operators go left to right. It knows nothing
 * of Excel's arithmetic, only of grouping, which is all the lab borrows, so real Python then
 * computes the bracketed text as the check on the lab's value. Excel itself was never run: this
 * can show the lab follows the table, and nothing about Excel.
 */
const MICROSOFT_ORDER: string[][] = [['neg'], ['**'], ['*', '/'], ['+', '-']];
const rank = (op: string) => MICROSOFT_ORDER.findIndex((level) => level.includes(op));
function readByMicrosoftsTable(text: string): string {
  const toks = text.match(/\*\*|[0-9]+\.?[0-9]*|\.[0-9]+|[a-z]+|[-+*/()]/g) ?? [];
  const values: string[] = [], ops: string[] = [];
  const apply = () => {
    const op = ops.pop()!;
    if (op === 'neg') { values.push(`(-${values.pop()})`); return; }
    const b = values.pop()!, a = values.pop()!;
    values.push(`(${a} ${op} ${b})`);
  };
  let wantValue = true;
  for (const t of toks) {
    if (wantValue && t === '-') { ops.push('neg'); continue; }
    if (t === '(') { ops.push(t); continue; }
    if (t === ')') { while (ops.at(-1) !== '(') apply(); ops.pop(); wantValue = false; continue; }
    if (/^[0-9a-z.]/.test(t)) { values.push(t); wantValue = false; continue; }
    // All of these go left to right, so an equal operator already waiting goes first.
    while (ops.length && ops.at(-1) !== '(' && rank(ops.at(-1)!) <= rank(t)) apply();
    ops.push(t);
    wantValue = true;
  }
  while (ops.length) apply();
  assert.equal(values.length, 1, text);
  return values[0];
}

test('differential: the Excel rule against a separate evaluator of Microsoft\'s table, with a minus everywhere it can go', () => {
  const r = new Rng(20260728);
  const num = () => r.pick(['0', '1', '2', '3', '5', '7', '1.5', '0.5', 'x', 'y']);
  const minus = () => r.pick(['', '', '-', '-', '- ', '--']);
  // Exponents stay small: left-to-right powers still grow, and the lab's own limit stops the rest.
  const gen = (d: number): string => {
    if (d === 0 || r.int(4) === 0) return `${minus()}${num()}`;
    if (r.int(4) === 0) return `${minus()}(${gen(d - 1)})`;
    if (r.int(5) === 0) return `${gen(d - 1)} ** ${r.pick(['0', '1', '2', '3', '-1', '-2', '- 1', '--2'])}`;
    return `${gen(d - 1)} ${r.pick(['+', '-', '*', '/'])} ${gen(d - 1)}`;
  };
  const texts = Array.from({ length: 6000 }, () => gen(1 + r.int(5)));
  let start = 0, afterOp = 0, afterPower = 0, beforeBracket = 0, doubled = 0;
  for (const t of texts) {
    if (/^-/.test(t)) start++;
    if (/[+*/] -/.test(t)) afterOp++;
    if (/\*\* ?-/.test(t)) afterPower++;
    if (/-\(/.test(t)) beforeBracket++;
    if (/--/.test(t)) doubled++;
  }
  // The whole bug was a test that never put a minus where it could show.
  assert.ok(start > 500 && afterOp > 500 && afterPower > 200 && beforeBracket > 200 && doubled > 200, JSON.stringify({ start, afterOp, afterPower, beforeBracket, doubled }));
  const compared: { text: string; bracketedText: string; got: Outcome }[] = [];
  let refused = 0, differFromPythonsTree = 0;
  for (const t of texts) {
    const tree = parse(t, 'excel');
    assert.equal(bracketed(tree), readByMicrosoftsTable(t), t);
    if (!sameTree(tree, parse(t))) differFromPythonsTree++;
    const got = evaluate(tree, LAB_ENV);
    // Both the stack route and the tree route, since the widget shows the stack's answer.
    const stack = runStack(genStack(tree), LAB_ENV).outcome;
    assert.equal(stack.ok ? stack.text : stack.error.type, got.ok ? got.text : got.error.type, t);
    if (!got.ok && got.error.type === 'SandboxLimit') { refused++; continue; }
    compared.push({ text: t, bracketedText: bracketed(tree), got });
  }
  const real = realEval(compared.map((c) => c.bracketedText));
  compared.forEach((c, i) => {
    if (sameOutcome(c.got, real[i]) || closeEnough(c.got, real[i])) return;
    assert.fail(`${c.text} read as ${c.bracketedText}: lab ${c.got.ok ? c.got.text : c.got.error.type}, Python ${JSON.stringify(real[i])}`);
  });
  assert.ok(compared.length > 5000, `only ${compared.length} compared, ${refused} refused`);
  // If most trees matched Python's, this rule wouldn't be being tested as a different rule.
  assert.ok(differFromPythonsTree > 500, `only ${differFromPythonsTree} trees differ from Python's`);
});

test('the Excel rule refuses what Microsoft\'s table doesn\'t give it, by name, where the correct parser carries on', () => {
  const said = (t: string) => { try { parse(t, 'excel'); return null; } catch (e) { return e as TinySyntaxError; } };
  for (const [t, why] of [['7 % 2', /percent mark/], ['7 // 2', /no \/\//], ['+5', /leading \+/], ['-2 ^ 2', /type \*\*/]] as [string, RegExp][]) {
    const e = said(t)!;
    assert.equal(e.kind, 'refused', t);
    assert.match(e.message, why);
  }
  assert.equal((evaluate(parse('7 % 2')) as { text: string }).text, '1');
  assert.equal((evaluate(parse('+5')) as { text: string }).text, '5');
  assert.throws(() => parse('2 ^ 3'), /isn't a power in Python/);
});

test('parser labels say what the parser breaks: ** and / survive in the modes that leave them alone', () => {
  // A learner saw "Same answer and the right tree" under "no precedence" and could fairly decide the label lied.
  assert.equal(bracketed(parse('2 * 3 ** 2', 'flat')), '(2 * (3 ** 2))');
  assert.equal(bracketed(parse('20 / 2 / 5', 'right')), '((20 / 2) / 5)');
  const src = readFileSync('src/components/CompilerLab.astro', 'utf8');
  assert.match(src, /no precedence for \+ - \* \/ \/\/ %/);
  assert.match(src, /\+ and - group from the right/);
});

test('verdicts are earned: each one is true of the numbers it sits beside', () => {
  const py = (t: string) => realEval([t])[0];
  const said = (t: string, m: 'correct' | 'flat' | 'right' | 'excel') => {
    const c = compile(t, m), truth = compile(t);
    if (!c.ok || !truth.ok) throw new Error(`${t} should compile`);
    return parseVerdict(m, c.outcome, py(t), sameTree(c.tree, truth.tree));
  };
  assert.match(said('-2 ** 2', 'excel').text, /neither program is broken/);
  assert.match(said('-2 ** 2', 'excel').text, /didn't run in Excel/);
  // A minus that used to vanish now reads the same as Python.
  assert.equal(said('2 * -3', 'excel').cls, 'ok');
  assert.match(said('-0 ** 2', 'excel').text, /different tree/);
  assert.match(said('1 + 2 * 3', 'flat').text, /tree is wrong/);
  assert.match(said('1 + 2 + 3', 'right').text, /Same answer from the wrong tree/);
  assert.match(said('1 + 2 * 3', 'correct').text, /right tree/);
  // Nothing on the Excel rule may call a tree wrong: it's a different rule, not a broken one.
  assert.doesNotMatch(said('-2 ** 2', 'excel').text, /wrong/);
  assert.doesNotMatch(said('-0 ** 2', 'excel').text, /wrong/);
  // One side refused: there aren't two answers, so "a different answer" would be false.
  const complex = { ok: false as const, error: { type: 'SandboxLimit', message: 'complex' } };
  assert.equal((evaluate(parse('-8 ** 0.5', 'excel')) as { error: { type: string } }).error.type, 'SandboxLimit');
  const oneSided = parseVerdict('excel', complex, py('-8 ** 0.5'), false);
  assert.equal(oneSided.cls, 'warn');
  assert.doesNotMatch(oneSided.text, /different answer/);
  assert.match(oneSided.text, /aren't two answers/);
  assert.equal(parseVerdict('correct', complex, { ok: false, text: 'SandboxLimit' }, true).text, LIMIT_NOTE);
  // The correct parser disagreeing with Python is a bug in this page, and must read as one.
  assert.match(parseVerdict('correct', { ok: true, value: 1n, text: '1' }, { ok: true, text: '2' }, true).text, /bug in this page/);
  assert.match(parseVerdict('flat', { ok: true, value: 1n, text: '1' }, { ok: true, text: '2' }, true).text, /bug in this page/);
  // A failure on one side isn't an answer on it.
  assert.match(parseVerdict('excel', { ok: false, error: { type: 'ZeroDivisionError', message: '' } }, { ok: true, text: '2' }, false).text, /different result/);
});

test('huge numbers: the arithmetic worked and the printing failed, and the lab now says which', () => {
  // The Step view showed the value and "the last value left is the answer", beside a bare ValueError.
  for (const t of ['10 ** 4300', '2 ** 100000']) {
    const c = compile(t);
    assert.ok(c.ok);
    const out = (c as { outcome: Outcome }).outcome;
    assert.equal(out.ok, false);
    const real = realEval([t])[0];
    assert.equal(real.text, 'ValueError');
    assert.equal(parseVerdict('correct', out, real, true).text, PRINT_NOTE);
  }
  // One digit short of the limit still prints, in both.
  assert.equal(realEval(['10 ** 4299'])[0].ok, true);
  assert.equal((evaluate(parse('10 ** 4299')) as { ok: boolean }).ok, true);
});

test('generate lab: the mission plays to the end, with each shortcut refused', () => {
  const lab = new GenLab();
  const one = lab.build('2 + 3') as ReturnType<typeof generate> & { stack: unknown[] };
  // One operator is too small a program to see the stack grow and shrink.
  lab.steppedToEnd.push(one as never);
  assert.equal(genSawStack(lab), false);
  lab.steppedToEnd.push(lab.build('1 + 2 * 3') as never);
  assert.equal(genSawStack(lab), true);
  // Commutative: the swapped generator gets it right, so this catches nothing.
  lab.build('2 + 3', { mode: 'swapped' });
  assert.equal(genCaughtSwap(lab), false);
  lab.build('10 - 3', { mode: 'swapped' });
  assert.equal(genCaughtSwap(lab), true);
  // Nothing to fold: folding on but no change.
  lab.build('x + 1', { fold: true });
  assert.equal(genFolded(lab), false);
  lab.build('x + 2 * 3', { fold: true });
  assert.equal(genFolded(lab), true);
  // Without folding this isn't the point being made.
  lab.build('1 / 0 + 2');
  assert.equal(genFoldKeptError(lab), false);
  lab.build('1 / 0 + 2', { fold: true });
  assert.equal(genFoldKeptError(lab), true);
  lab.build('1 + 2', { registers: 4 });
  assert.equal(genSpilled(lab), false);
  lab.build('(1 + 2) * (3 + 4)', { registers: 2 });
  assert.equal(genSpilled(lab), true);
  // A syntax error is counted, never stored as a program.
  lab.build('1 +');
  assert.equal(lab.errors, 1);
});

test('generate mission: the hints work in the order given, with folding left on as step 4 says', () => {
  // A hint of (1 + 2) * (3 + 4) folded to one number, spilled nothing, and stranded the learner.
  const lab = new GenLab();
  lab.build('1 / 0 + 2', { fold: true, registers: 2 });
  lab.build('(1 + 2) * (3 + 4)', { fold: true, registers: 2 });
  assert.equal(genSpilled(lab), false);
  lab.build('(x + 1) * (y + 2)', { fold: true, registers: 2 });
  assert.equal(genSpilled(lab), true);
});

test('nothing the lab accepts can crash it: odd input ends in an answer or an error with a place', () => {
  const r = new Rng(99);
  const odd = ['', ' ', '()', '(((', ')))', '1..2', '1.2.3', '.', '..', '-', '--', '**', '2***3', '2****3', '//', '1///2', '½', '٣', 'é', 'x y', 'x.y', 'x()', '1 if 2 else 3', '"a"', '#', '\n', 'a=1', 'None', 'True', 'lambda', 'print', '0.', '00', '0', '-0', '0.0', '1 % 0.0', '2**0.5', '(-2)**0.5', '1/3'];
  for (const t of odd) {
    const c = compile(t);
    if (!c.ok) { assert.ok(c.error.col >= 0 && c.error.col <= t.length, `${JSON.stringify(t)} at ${c.error.col}`); assert.ok(c.error.message.length > 5); }
  }
  for (let i = 0; i < 2000; i++) {
    const t = Array.from({ length: r.int(8) }, () => r.pick([...odd, '1', '+', '*', '(', ')', 'x'])).join('');
    assert.doesNotThrow(() => compile(t), JSON.stringify(t));
  }
});
