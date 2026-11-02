// The sums behind "Multicore, SIMD and why GPUs exist". Each formula here is checked in
// tests/parallel.test.ts against a simulation that shares no code with it: a scheduler
// that hands out work one tick at a time, and an exhaustive walk of every interleaving.
// The workloads are invented and the lab says so. A real program's parallel share has to be
// measured, and it usually changes with the input.

/**
 * Amdahl's law, as it's usually written. Amdahl's 1967 paper has no equations: this form
 * came later and carries his name. p is the share of the run that can use all the cores.
 */
export function amdahl(p: number, n: number): number {
  if (!(p >= 0 && p <= 1)) throw new RangeError('p is a share, from 0 to 1');
  if (!(n >= 1)) throw new RangeError('at least one core');
  return 1 / ((1 - p) + p / n);
}

/** Where the speedup stops however many cores you add. Infinite when nothing is serial. */
export const amdahlLimit = (p: number) => (p === 1 ? Infinity : 1 / (1 - p));

/** Gustafson's reading (1988): the job grows with the machine, so serial time stays a fixed share of the run on N. s is that share. */
export const gustafson = (s: number, n: number) => s + (1 - s) * n;

/** Amdahl, plus coordination that costs each extra core a little of the whole run. An invented, simple model of overhead. */
export function withOverhead(p: number, n: number, costPerCore: number): number {
  return 1 / ((1 - p) + p / n + costPerCore * (n - 1));
}

/** The core count, among 1 to maxCores, where withOverhead peaks: more cores past here make the job slower. */
export function bestCores(p: number, costPerCore: number, maxCores: number): number {
  let best = 1, top = -Infinity;
  for (let n = 1; n <= maxCores; n++) { const s = withOverhead(p, n, costPerCore); if (s > top) { top = s; best = n; } }
  return best;
}

export type Schedule = { ticks: number; busy: number[]; idleCoreTicks: number };

/**
 * Runs a job a tick at a time. Serial work takes one core while the rest wait, and parallel
 * work goes to every free core at once. Knows nothing of the formula.
 */
export function schedule(serialTicks: number, parallelTicks: number, cores: number): Schedule {
  if (!Number.isInteger(serialTicks) || !Number.isInteger(parallelTicks) || !Number.isInteger(cores) || serialTicks < 0 || parallelTicks < 0 || cores < 1) throw new RangeError('whole, non-negative work and at least one core');
  const busy = new Array(cores).fill(0) as number[];
  let ticks = 0, idle = 0, s = serialTicks, q = parallelTicks;
  while (s > 0 || q > 0) {
    ticks++;
    if (s > 0) { s--; busy[0]++; idle += cores - 1; continue; }
    for (let c = 0; c < cores; c++) {
      if (q > 0) { q--; busy[c]++; } else idle++;
    }
  }
  return { ticks, busy, idleCoreTicks: idle };
}

// ---- The Amdahl lab

export type AmdahlSeen = { p: number; cores: number; speedup: number };

export class AmdahlLab {
  p = 0.9;
  cores = 1;
  seen: AmdahlSeen[] = [];
  scheduled: { p: number; cores: number; ticks: number }[] = [];
  set(p: number, cores: number) {
    this.p = p; this.cores = cores;
    this.seen.push({ p, cores, speedup: amdahl(p, cores) });
  }
  speedup() { return amdahl(this.p, this.cores); }
  limit() { return amdahlLimit(this.p); }
  /** A job of 1000 ticks of work, run tick by tick at the current settings. */
  runSchedule(): Schedule {
    const parallel = Math.round(this.p * JOB_TICKS);
    const r = schedule(JOB_TICKS - parallel, parallel, this.cores);
    this.scheduled.push({ p: this.p, cores: this.cores, ticks: r.ticks });
    return r;
  }
}
export const JOB_TICKS = 1000;

/**
 * Why the tick run came in under the formula, in numbers, at any setting the lab allows. It used
 * to say "a little under" whatever the size of the gap, and at 100% on 4,096 cores the run gives
 * 1,000 where the formula gives 4,096: a quarter is not a little. The size is computed here, so
 * no adverb can go stale, and the reason is the same at both ends: the formula divides work as
 * finely as it likes, and this job's work comes in whole ticks.
 */
export function tickNote(p: number, cores: number): string {
  const parallel = Math.round(p * JOB_TICKS), each = parallel / cores, needed = Math.ceil(each);
  const byTicks = JOB_TICKS / (JOB_TICKS - parallel + needed), under = (1 - byTicks / amdahl(p, cores)) * 100;
  if (needed === each) return '';
  const place = (x: number) => x.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const wall = cores > parallel ? ` This job has no use for more than ${place(parallel)} cores: the rest have nothing to do.` : '';
  return ` That's ${under < 1 ? under.toFixed(1) : under.toFixed(0)}% under the formula. The formula lets the ${place(parallel)} ticks of parallel work take ${place(each)} ticks on ${place(cores)} cores, as if work divided as finely as you like. This run needs ${place(needed)}, because work comes in whole ticks.${wall}`;
}

export const sawManyCoresAtNinety = (l: AmdahlLab) => l.seen.some((s) => s.p === 0.9 && s.cores >= 512);
export const sawTwentyTimes = (l: AmdahlLab) => l.seen.some((s) => s.cores <= 64 && s.speedup >= 20);
export const ranSchedule = (l: AmdahlLab) => l.scheduled.some((s) => s.cores >= 2 && s.p < 1);

// ---- SIMD lanes

export type LanePath = 'uniform' | 'alternating' | 'random';
/** One operation over a run of values, on a machine with this many lanes. The if costs "heavy" on one side and "light" on the other. */
export type LaneRun = { scalar: number; lanes: number; simd: number; speedup: number; bothSidesBatches: number; batches: number };

/** A repeatable pattern of which elements take the heavy side of the if. */
export function lanePattern(kind: LanePath, n: number, seed = 1): boolean[] {
  if (kind === 'uniform') return new Array(n).fill(true);
  if (kind === 'alternating') return Array.from({ length: n }, (_, i) => i % 2 === 0);
  let s = seed >>> 0 || 1;
  return Array.from({ length: n }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 16) % 2 === 0; });
}

/**
 * Scalar cost is each element's own side of the if. A lane machine runs one instruction
 * stream for the batch, so a batch with elements on both sides pays for both sides and masks
 * the unwanted results. This is what "coherence" means when GPU people talk about branches.
 */
export function runLanes(pattern: boolean[], lanes: number, heavy = 8, light = 1): LaneRun {
  if (!Number.isInteger(lanes) || lanes < 1) throw new RangeError('at least one lane');
  let scalar = 0, simd = 0, both = 0, batches = 0;
  for (const h of pattern) scalar += h ? heavy : light;
  for (let i = 0; i < pattern.length; i += lanes) {
    const batch = pattern.slice(i, i + lanes);
    const anyHeavy = batch.some((h) => h), anyLight = batch.some((h) => !h);
    simd += (anyHeavy ? heavy : 0) + (anyLight ? light : 0);
    if (anyHeavy && anyLight) both++;
    batches++;
  }
  return { scalar, lanes, simd, speedup: simd === 0 ? 1 : scalar / simd, bothSidesBatches: both, batches };
}

export const instructionsForAdd = (n: number, lanes: number) => Math.ceil(n / lanes);

// ---- Two cores, one counter

export type Micro = 'read' | 'add' | 'write';
export type Interleaving = { order: string; final: number };

/**
 * Every order two cores can run read-add-write on a shared counter that starts at 0, each
 * keeping its own step order. Twenty orders, by counting. This is the answer the lesson
 * quotes, walked rather than claimed.
 */
export function allInterleavings(steps: Micro[] = ['read', 'add', 'write']): Interleaving[] {
  const out: Interleaving[] = [];
  const go = (a: number, b: number, order: string, mem: number, ra: number, rb: number) => {
    if (a === steps.length && b === steps.length) { out.push({ order, final: mem }); return; }
    const apply = (who: 'A' | 'B', i: number) => {
      const s = steps[i];
      let m = mem, x = who === 'A' ? ra : rb;
      if (s === 'read') x = m;
      else if (s === 'add') x += 1;
      else m = x;
      if (who === 'A') go(a + 1, b, `${order}A`, m, x, rb);
      else go(a, b + 1, `${order}B`, m, ra, x);
    };
    if (a < steps.length) apply('A', a);
    if (b < steps.length) apply('B', b);
  };
  go(0, 0, '', 0, 0, 0);
  return out;
}

/** A hardware atomic add does the three steps as one, and no other core can get in between. */
export function allAtomicInterleavings(): Interleaving[] {
  return [{ order: 'AB', final: 2 }, { order: 'BA', final: 2 }];
}
