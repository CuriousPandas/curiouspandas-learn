// What the code lab and its missions need on top of the VM: run a program, hand
// values across, and measure how a function's work grows with its input.

import { PyProgram, type PyFailure, type Status } from './vm.ts';
import { PyList, repr, type Val } from './values.ts';

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
    const p = new PyProgram(r.src, { maxOps: 2_000_000 });
    p.run();
    const got = p.call(fn, c.args.map(toPy));
    if (!got.ok) return { ok: false, why: `${shown} raised ${got.error.type}: ${got.error.message}` };
    const text = repr(got.value);
    if (text !== c.want) return { ok: false, why: `${shown} returned ${text}; expected ${c.want}` };
  }
  return { ok: true, why: `Passed ${cases.length} checks.` };
}

export type GrowthPoint = { n: number; ops: number | null };
export type GrowthShape = 'constant' | 'logarithmic' | 'linear' | 'n log n' | 'quadratic' | 'cubic or worse' | 'unknown';

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
  if (k < 0.03) return 'constant';
  if (k < 0.5) return 'logarithmic';
  if (k < 1.5) {
    const asLinear = b.ops / a.ops, r = b.n / a.n, asNLogN = r * (Math.log(b.n) / Math.log(a.n));
    return Math.abs(Math.log(asLinear / r)) <= Math.abs(Math.log(asLinear / asNLogN)) ? 'linear' : 'n log n';
  }
  return k < 2.5 ? 'quadratic' : 'cubic or worse';
}
