// What the code lab and its missions need on top of the VM: run a program, hand
// values across, and measure how a function's work grows with its input.

import { GIVEN_FILE, PyProgram, type PyFailure, type Status } from './vm.ts';
import { PyDict, PyList, dictSet, repr, type Val } from './values.ts';

export const PROGRAM_FILE = '<lab>';

export type RunResult = { src: string; status: Status; stdout: string; ops: number; depth: number; error?: PyFailure; program: PyProgram };

export const summarise = (p: PyProgram, src: string): RunResult => ({ src, status: p.status, stdout: p.stdout, ops: p.ops, depth: p.maxDepth, error: p.error, program: p });
export function runAll(src: string, maxOps?: number): RunResult {
  const p = new PyProgram(src, { maxOps });
  p.run();
  return summarise(p, src);
}

export function toPy(v: unknown): Val {
  if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : v;
  if (Array.isArray(v)) return new PyList(v.map(toPy));
  // Plain objects only: a value that is already Python's has its own class.
  if (v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const d = new PyDict();
    for (const [k, x] of Object.entries(v)) dictSet(d, k, toPy(x));
    return d;
  }
  return v as Val;
}

/**
 * Calls a function the learner defined with each input and compares repr, so
 * [1, 2] and 1.0 are judged as Python would print them. Reports the first failure
 * in words, because "it doesn't work" is not something a learner can act on.
 */
export function checkCases(r: RunResult, fn: string, cases: { args: unknown[]; want: string }[]): { ok: boolean; why: string } {
  if (r.status !== 'done') return { ok: false, why: 'The program has to finish without an error first.' };
  for (const c of cases) {
    const shown = `${fn}(${c.args.map((a) => repr(toPy(a))).join(', ')})`;
    // Fresh each time: a function that mutates its input or keeps global state
    // must not pass or fail because of an earlier case.
    // With the same input lines and given code the run had, or a program that reads
    // at its top level would fail here for a reason that has nothing to do with it.
    const p = new PyProgram(r.src, { maxOps: 2_000_000, stdin: r.program.stdin, given: r.program.given });
    p.run();
    const got = p.call(fn, c.args.map(toPy));
    if (!got.ok) return { ok: false, why: `${shown} raised ${got.error.type}: ${got.error.message}` };
    const text = repr(got.value);
    if (text !== c.want) return { ok: false, why: `${shown} returned ${text}; expected ${c.want}` };
  }
  return { ok: true, why: `Passed ${cases.length} checks.` };
}

const REPEAT_SHOWN = 3;
/**
 * The error as real Python prints it, word for word, minus the ^^^^ markers under a
 * line, whose placement this engine does not track. tests/py-parity.test.ts compares
 * this with the real interpreter's output.
 */
export function formatTraceback(err: PyFailure, src: string, given?: string): string {
  const head = err.context ? `${formatTraceback(err.context, src, given)}\n\nDuring handling of the above exception, another exception occurred:\n\n` : '';
  const last = err.message ? `${err.type}: ${err.message}` : err.type;
  // A syntax error never ran, so it has no frames, and the status line says where.
  if (!err.stack.length) return head + last;
  const lines = (s: string) => s.replace(/\r\n/g, '\n').split('\n');
  const sources: Record<string, string[]> = { [PROGRAM_FILE]: lines(src), [GIVEN_FILE]: lines(given ?? '') };
  const out = ['Traceback (most recent call last):'];
  let prev = '', repeats = 0;
  const flushRepeats = () => {
    if (repeats > REPEAT_SHOWN) out.push(`  [Previous line repeated ${repeats - REPEAT_SHOWN} more time${repeats - REPEAT_SHOWN === 1 ? '' : 's'}]`);
    repeats = 0;
  };
  for (const f of err.stack) {
    const file = f.file ?? PROGRAM_FILE, key = `${file}:${f.line}:${f.fn}`;
    // Deep recursion would otherwise print the same entry a thousand times.
    if (key !== prev) { flushRepeats(); prev = key; }
    repeats++;
    if (repeats > REPEAT_SHOWN) continue;
    out.push(`  File "${file}", line ${f.line}, in ${f.fn}`);
    const text = sources[file]?.[f.line - 1]?.trim();
    if (text) out.push(`    ${text}`);
  }
  flushRepeats();
  out.push(last);
  return head + out.join('\n');
}

export type GrowthPoint = { n: number; ops: number | null };
export type GrowthShape = 'constant' | 'logarithmic' | 'linear' | 'n log n' | 'quadratic' | 'cubic or worse' | 'exponential or worse' | 'unknown';

/**
 * Steps a function takes at each size. The setup's own steps are subtracted: the
 * cost of building the input is not the cost of the function being measured.
 * A size over budget records null, never a number, so a function too slow to
 * finish cannot be read as cheap.
 */
export function measureGrowth(src: string, fn: string, sizes: number[], makeArgs: (n: number) => unknown[], maxOps = 3_000_000): GrowthPoint[] {
  return sizes.map((n) => {
    const p = new PyProgram(src, { maxOps });
    p.run();
    if (p.status !== 'done') return { n, ops: null };
    const before = p.ops;
    const r = p.call(fn, makeArgs(n).map(toPy));
    return { n, ops: r.ok ? p.ops - before : null };
  });
}

/**
 * Names the curve from how much work grows between the two largest measured sizes.
 * The exponent alone can't separate n log n from n, or log n from constant, at
 * sizes a browser can run, so those two compare against their own prediction.
 */
export function classify(points: GrowthPoint[]): GrowthShape {
  const ok = points.filter((p): p is { n: number; ops: number } => p.ops !== null && p.ops > 0);
  if (ok.length < 2) return 'unknown';
  const a = ok.at(-2)!, b = ok.at(-1)!;
  const k = Math.log(b.ops / a.ops) / Math.log(b.n / a.n);
  // Sizes a fixed amount apart separate these: adding the same amount multiplies
  // exponential work by the same factor or more, while for any polynomial that
  // factor falls as n grows. Doubling sizes can't tell them apart from two points.
  if (k >= 2.5 && ok.length >= 3) {
    const gaps = ok.slice(1).map((p, i) => p.n - ok[i].n);
    const factors = ok.slice(1).map((p, i) => p.ops / ok[i].ops);
    if (gaps.every((g) => g === gaps[0]) && factors.at(-1)! >= 1.5 && factors.at(-1)! >= factors[0] * 0.9) return 'exponential or worse';
  }
  if (k < 0.03) return 'constant';
  if (k < 0.5) return 'logarithmic';
  if (k < 1.5) {
    const asLinear = b.ops / a.ops, r = b.n / a.n, asNLogN = r * (Math.log(b.n) / Math.log(a.n));
    return Math.abs(Math.log(asLinear / r)) <= Math.abs(Math.log(asLinear / asNLogN)) ? 'linear' : 'n log n';
  }
  return k < 2.5 ? 'quadratic' : 'cubic or worse';
}
