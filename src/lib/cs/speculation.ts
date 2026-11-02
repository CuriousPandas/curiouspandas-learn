// A model of the mechanism behind Spectre and Meltdown, and nothing more than that. No
// real speculation happens here: JavaScript variables stand for a cache, a predictor and
// memory, the cycle counts are invented round numbers, and the widget says so. It runs no
// timing measurement on the learner's hardware and can't read anything but its own arrays,
// and it's built so that can't change by accident: nothing in this file looks at a clock.
//
// What's modelled: a bounds check that a trained predictor runs past, a load done during that
// wrong guess, a cache that remembers it after the guess is thrown away, and a probe that
// reads the cache by how long a load takes. What isn't: anything an attacker needs on real
// hardware, such as finding a gadget, evicting the bound or a real timer. The lesson says so.

export const PUBLIC_LEN = 16;
export const SECRET_LEN = 4;
export const PROBE_LINES = 16;
/** Invented, round and labelled as invented. Only their difference matters to this model. */
export const HIT_CYCLES = 1;
export const MISS_CYCLES = 100;
const COARSE_STEP = 1000;
export const MASK_COST = 1;
export const BARRIER_COST = 20;

/** A tiny repeatable generator for the invented secrets. */
function digits(seed: number, n: number): number[] {
  let s = (seed >>> 0) || 1;
  return Array.from({ length: n }, () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 16) % PROBE_LINES; });
}

export type SpectreDefence = 'none' | 'barrier' | 'mask';
export type MeltdownCpu = 'affected' | 'checks-first';

export type CallRecord = {
  x: number; inRange: boolean; returned: number;
  /** Whether the predictor guessed that the check would pass. */
  guessed: boolean; mispredicted: boolean;
  /** The speculative read: which cell it read, and whether that cell held a secret. Empty if nothing ran. */
  speculated: { cell: number; value: number; secret: boolean } | null;
  defence: SpectreDefence; cycles: number;
};

export type KernelRead = { position: number; faulted: true; transient: number | null; cpu: MeltdownCpu; pageTableIsolation: boolean };

export type ProbeRecord = {
  attack: 'spectre' | 'meltdown';
  latencies: number[]; fast: number[];
  /** A clean round: the probe was flushed since it was last dirtied, and something then ran. */
  flushed: boolean;
  /** Did an out-of-range call or a kernel read run since the last probe or flush? If not, this reading can say nothing about a secret, flushed or not. */
  aimed: boolean;
  /** What the model knows and an attacker doesn't: did a secret choose the marked line? */
  secretMarked: boolean;
  /** Which of the secret's positions this round was aimed at, if any. */
  position: number | null;
  coarse: boolean; defence: SpectreDefence; pageTableIsolation: boolean; cpu: MeltdownCpu;
  /** Was the predictor trained when the out-of-range call was made? */
  trained: boolean;
};

export class SpecLab {
  readonly publicData: number[];
  readonly #secret: number[];
  readonly #kernel: number[];
  /** Saturating 2-bit counter: 0-1 guesses "out of range", 2-3 guesses "in range". */
  counter = 0;
  cache = new Set<number>();
  /** The cache as it was before the last probe reloaded everything. */
  defence: SpectreDefence = 'none';
  coarseTimer = false;
  cpu: MeltdownCpu = 'affected';
  pageTableIsolation = false;
  calls: CallRecord[] = [];
  kernelReads: KernelRead[] = [];
  probes: ProbeRecord[] = [];
  guesses: { kind: 'spectre' | 'meltdown'; digits: number[]; right: boolean }[] = [];
  cycles = 0;
  #dirtySinceFlush = true;
  #armed: { attack: 'spectre' | 'meltdown'; secret: boolean; position: number | null; trained: boolean; flushedBefore: boolean } | null = null;

  constructor(seed = 1) {
    this.publicData = digits(seed ^ 0x5bd1, PUBLIC_LEN);
    this.#secret = digits(seed ^ 0x1234, SECRET_LEN);
    this.#kernel = digits(seed ^ 0x9e37, SECRET_LEN);
  }

  /** The model's memory, one array holding public cells and then the secret ones. */
  #cell(i: number): { value: number; secret: boolean } {
    if (i < PUBLIC_LEN) return { value: this.publicData[i], secret: false };
    // The victim's memory goes on past the secret; beyond it is just more public-looking zeros.
    if (i < PUBLIC_LEN + SECRET_LEN) return { value: this.#secret[i - PUBLIC_LEN], secret: true };
    return { value: 0, secret: false };
  }

  flush() {
    this.cache.clear();
    this.#dirtySinceFlush = false;
    this.#armed = null;
  }

  /**
   * if (x < 16) return probe[data[x]]; else return 0;
   * Everything visible to the program is decided by the check. The guess only changes the
   * cache and the time taken, and tests/speculation.test.ts holds that against a plain
   * reference with no predictor at all.
   */
  call(x: number): CallRecord {
    if (!Number.isInteger(x) || x < 0) throw new RangeError('x must be a whole number, 0 or more');
    const inRange = x < PUBLIC_LEN;
    let guessed = this.counter >= 2;
    let cycles = 0, speculated: CallRecord['speculated'] = null;
    const trainedAtCall = guessed;

    if (this.defence === 'barrier') { cycles += BARRIER_COST; guessed = false; }
    const index = this.defence === 'mask' ? x & (PUBLIC_LEN - 1) : x;
    if (this.defence === 'mask') cycles += MASK_COST;

    let returned = 0;
    if (inRange) {
      const v = this.#cell(index).value;
      const hit = this.cache.has(v);
      cycles += hit ? HIT_CYCLES : MISS_CYCLES;
      this.cache.add(v);
      returned = v;
      this.#dirtySinceFlush = true;
    } else if (guessed) {
      // The wrong guess. This is the whole vulnerability: the load runs before the check has
      // finished, and undoing it restores registers, not the cache.
      const c = this.#cell(index);
      speculated = { cell: index, value: c.value, secret: c.secret };
      this.cache.add(c.value);
      cycles += MISS_CYCLES;
    }
    this.counter = Math.max(0, Math.min(3, this.counter + (inRange ? 1 : -1)));
    const rec: CallRecord = { x, inRange, returned, guessed, mispredicted: guessed && !inRange, speculated, defence: this.defence, cycles };
    this.calls.push(rec);
    this.cycles += cycles;
    if (!inRange) {
      const position = x >= PUBLIC_LEN && x < PUBLIC_LEN + SECRET_LEN ? x - PUBLIC_LEN : null;
      this.#armed = { attack: 'spectre', secret: !!speculated?.secret, position, trained: trainedAtCall, flushedBefore: !this.#dirtySinceFlush };
      this.#dirtySinceFlush = true;
    }
    return rec;
  }

  /**
   * A user program reads a kernel address. On every CPU this faults: the program never gets
   * the value. The question is whether anything used it first.
   */
  readKernel(position: number): KernelRead {
    if (!Number.isInteger(position) || position < 0 || position >= SECRET_LEN) throw new RangeError('no such kernel position');
    let transient: number | null = null;
    if (this.cpu === 'affected' && !this.pageTableIsolation) {
      transient = this.#kernel[position];
      this.cache.add(transient);
    }
    const rec: KernelRead = { position, faulted: true, transient, cpu: this.cpu, pageTableIsolation: this.pageTableIsolation };
    this.kernelReads.push(rec);
    this.#armed = { attack: 'meltdown', secret: transient !== null, position, trained: true, flushedBefore: !this.#dirtySinceFlush };
    this.#dirtySinceFlush = true;
    return rec;
  }

  /** Time a load of each line. Loading a line caches it, so a second probe with no flush sees all of them fast. */
  probe(): ProbeRecord {
    const latencies = Array.from({ length: PROBE_LINES }, (_, i) => {
      const t = this.cache.has(i) ? HIT_CYCLES : MISS_CYCLES;
      this.cycles += t;
      return this.coarseTimer ? Math.floor(t / COARSE_STEP) * COARSE_STEP : t;
    });
    const fastest = Math.min(...latencies);
    // A line only stands out if some other line is slower. A timer that reads the same for
    // both shows no fast lines at all, not sixteen.
    const fast = latencies.every((l) => l === fastest) && (this.coarseTimer || fastest === MISS_CYCLES) ? [] : latencies.flatMap((l, i) => (l === fastest ? [i] : []));
    const armed = this.#armed;
    const rec: ProbeRecord = {
      attack: armed?.attack ?? 'spectre', latencies, fast,
      flushed: !!armed?.flushedBefore, aimed: armed !== null, secretMarked: !!armed?.secret, position: armed?.position ?? null,
      coarse: this.coarseTimer, defence: this.defence, pageTableIsolation: this.pageTableIsolation, cpu: this.cpu, trained: !!armed?.trained,
    };
    this.probes.push(rec);
    for (let i = 0; i < PROBE_LINES; i++) this.cache.add(i);
    this.#armed = null;
    this.#dirtySinceFlush = true;
    return rec;
  }

  /** Check a guess at the secret. The answer is only ever yes or no, so the lab can't be read for it. */
  guess(kind: 'spectre' | 'meltdown', text: string): boolean {
    // Someone who read 5, e, a, a off the probe has the secret, however they space it.
    const clean = text.replace(/[\s,]/g, '').toLowerCase();
    const got = [...clean].map((c) => parseInt(c, 16));
    const right = got.length === SECRET_LEN && got.every((d, i) => d === (kind === 'spectre' ? this.#secret : this.#kernel)[i]);
    this.guesses.push({ kind, digits: got, right });
    return right;
  }
}

export const hex = (d: number) => d.toString(16);

/** The same program with no predictor, no cache and no speculation. Used as the reference: what a program is entitled to see. */
export function plainVictim(publicData: number[], x: number): number {
  return x < PUBLIC_LEN ? publicData[x] : 0;
}

/** A whole round as a learner would click it. For tests and the scenario's sake, not a shortcut the page hides. */
export function spectreRound(lab: SpecLab, position: number, trainCalls = 4): ProbeRecord {
  for (let i = 0; i < trainCalls; i++) lab.call(i % PUBLIC_LEN);
  lab.flush();
  lab.call(PUBLIC_LEN + position);
  return lab.probe();
}

export function meltdownRound(lab: SpecLab, position: number): ProbeRecord {
  lab.flush();
  lab.readKernel(position);
  return lab.probe();
}

// ---- What the mission reads

export const sawRefusal = (l: SpecLab) => l.calls.some((c) => !c.inRange && c.returned === 0);
export const sawRecovered = (l: SpecLab) => l.probes.some((p) => p.attack === 'spectre' && p.flushed && p.secretMarked && p.fast.length === 1 && !p.coarse);
export const guessedSpectre = (l: SpecLab) => l.guesses.some((g) => g.kind === 'spectre' && g.right);
/** A full attempt: predictor trained, probe flushed, call aimed at the secret, and the secret never reached the cache. */
export const sawDefended = (l: SpecLab) => l.probes.some((p) => p.attack === 'spectre' && p.flushed && p.position !== null && p.trained && p.defence !== 'none' && !p.secretMarked);
/** The timer hid it, and the mark in the cache was still there. */
export const sawBlindTimer = (l: SpecLab) => l.probes.some((p) => p.attack === 'spectre' && p.flushed && p.coarse && p.fast.length === 0 && p.secretMarked);
export const sawMeltdown = (l: SpecLab) => l.probes.some((p) => p.attack === 'meltdown' && p.flushed && p.secretMarked && p.fast.length === 1 && !p.coarse);
export const sawIsolation = (l: SpecLab) => l.probes.some((p) => p.attack === 'meltdown' && p.flushed && !p.secretMarked && p.pageTableIsolation && p.cpu === 'affected' && !p.coarse);

export type SpecState = { lab: SpecLab };
