// A statevector simulator: the whole state, one complex amplitude per basis state, and gates
// that update it. Tested exactly in tests/qubit.test.ts against known amplitudes and against
// an independent full-matrix version in real Python. It's an ordinary program doing
// ordinary arithmetic, which is why its memory doubles with each qubit, and why simulating
// past a few dozen qubits this way is out of reach.
//
// Convention: qubit 0 is the leftmost in a label, so in |10> qubit 0 is 1.

export type C = { re: number; im: number };
export const MAX_QUBITS = 12;
const S2 = Math.SQRT1_2;

export type GateName = 'H' | 'X' | 'Y' | 'Z' | 'S' | 'T';
type Matrix2 = [C, C, C, C];
const c = (re: number, im = 0): C => ({ re, im });
const mul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const add = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });

export const GATE: Record<GateName, Matrix2> = {
  H: [c(S2), c(S2), c(S2), c(-S2)],
  X: [c(0), c(1), c(1), c(0)],
  Y: [c(0), c(0, -1), c(0, 1), c(0)],
  Z: [c(1), c(0), c(0), c(-1)],
  S: [c(1), c(0), c(0), c(0, 1)],
  T: [c(1), c(0), c(0), c(S2, S2)],
};

export class Rng {
  s: number;
  readonly seed: number;
  constructor(seed: number) { this.seed = seed; this.s = (seed >>> 0) || 1; }
  /** mulberry32: small, repeatable, and good enough to show sampling noise. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

export class State {
  readonly n: number;
  amps: C[];
  constructor(n: number) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError('at least one qubit');
    if (n > MAX_QUBITS) throw new RangeError(`This page stops at ${MAX_QUBITS} qubits: the state doubles with each one`);
    this.n = n;
    this.amps = Array.from({ length: 2 ** n }, () => c(0));
    this.amps[0] = c(1);
  }
  clone() { const s = new State(this.n); s.amps = this.amps.map((a) => ({ ...a })); return s; }
  #mask(q: number) {
    if (!Number.isInteger(q) || q < 0 || q >= this.n) throw new RangeError(`no qubit ${q}`);
    return 1 << (this.n - 1 - q);
  }
  apply(gate: GateName, q: number): this {
    const bit = this.#mask(q), [a, b, cc, d] = GATE[gate];
    for (let i = 0; i < this.amps.length; i++) {
      if (i & bit) continue;
      const x = this.amps[i], y = this.amps[i | bit];
      this.amps[i] = add(mul(a, x), mul(b, y));
      this.amps[i | bit] = add(mul(cc, x), mul(d, y));
    }
    return this;
  }
  /** Flips target where control is 1. Refuses a qubit used twice: that isn't a gate. */
  cnot(control: number, target: number): this {
    if (control === target) throw new RangeError('control and target must be different qubits');
    const cb = this.#mask(control), tb = this.#mask(target);
    for (let i = 0; i < this.amps.length; i++) {
      if (i & cb && !(i & tb)) { const t = this.amps[i]; this.amps[i] = this.amps[i | tb]; this.amps[i | tb] = t; }
    }
    return this;
  }
  /** Negates the amplitude where both are 1. */
  cz(a: number, b: number): this {
    if (a === b) throw new RangeError('the two qubits must be different');
    const ab = this.#mask(a), bb = this.#mask(b);
    for (let i = 0; i < this.amps.length; i++) if (i & ab && i & bb) this.amps[i] = c(-this.amps[i].re, -this.amps[i].im);
    return this;
  }
  /** Negates one basis state's amplitude: Grover's oracle, for a marked item. */
  flip(index: number): this {
    if (!Number.isInteger(index) || index < 0 || index >= this.amps.length) throw new RangeError('no such basis state');
    this.amps[index] = c(-this.amps[index].re, -this.amps[index].im);
    return this;
  }
  /** Reflects every amplitude about their mean: Grover's other step. */
  diffuse(): this {
    const mean = this.amps.reduce((m, a) => add(m, a), c(0));
    const m = c(mean.re / this.amps.length, mean.im / this.amps.length);
    this.amps = this.amps.map((a) => c(2 * m.re - a.re, 2 * m.im - a.im));
    return this;
  }
  /** The chance of each outcome if every qubit is measured now. No sampling: the whole distribution. */
  probabilities(): number[] { return this.amps.map((a) => a.re * a.re + a.im * a.im); }
  norm(): number { return this.probabilities().reduce((s, p) => s + p, 0); }
  /** The chance that one qubit reads 1. */
  marginal(q: number): number {
    const bit = this.#mask(q);
    return this.probabilities().reduce((s, p, i) => s + (i & bit ? p : 0), 0);
  }
  label(i: number) { return i.toString(2).padStart(this.n, '0'); }
  /** Picks an outcome by the probabilities, and leaves the state alone. */
  sample(rng: Rng): number {
    const p = this.probabilities();
    let r = rng.next();
    for (let i = 0; i < p.length; i++) { r -= p[i]; if (r < 0) return i; }
    // Rounding can leave a sliver of r behind: the last outcome with any probability gets it,
    // and never an outcome the state says is impossible.
    for (let i = p.length - 1; i >= 0; i--) if (p[i] > 1e-15) return i;
    return 0;
  }
  shots(rng: Rng, count: number): number[] {
    const out = new Array(this.amps.length).fill(0) as number[];
    for (let i = 0; i < count; i++) out[this.sample(rng)]++;
    return out;
  }
  /** Measures one qubit for real: the state collapses and stays collapsed. Returns what it read. */
  measure(q: number, rng: Rng): 0 | 1 {
    const bit = this.#mask(q);
    const p1 = this.marginal(q);
    const one = rng.next() < p1;
    const keep = one ? p1 : 1 - p1;
    const scale = 1 / Math.sqrt(keep);
    this.amps = this.amps.map((a, i) => (((i & bit) !== 0) === one ? c(a.re * scale, a.im * scale) : c(0)));
    return one ? 1 : 0;
  }
}

/** Sizes that matter for "why can't a laptop simulate this": 16 bytes per complex amplitude. */
export const stateBytes = (n: number) => 2 ** n * 16;

// ---- Grover's search, run on the state, compared with its formula in the test

/** The state after k rounds on an unstructured list of 2^n with one marked item, from the uniform start. */
export function groverState(n: number, marked: number, rounds: number): State {
  const s = new State(n);
  for (let q = 0; q < n; q++) s.apply('H', q);
  for (let k = 0; k < rounds; k++) { s.flip(marked); s.diffuse(); }
  return s;
}

/** The chance of reading the marked item after k rounds: sin²((2k + 1) θ), with sin θ = 1/√N. */
export const groverFormula = (N: number, k: number) => Math.sin((2 * k + 1) * Math.asin(1 / Math.sqrt(N))) ** 2;
/** The best whole number of rounds: about π/4 √N. */
export const groverBestRounds = (N: number) => Math.round(Math.PI / (4 * Math.asin(1 / Math.sqrt(N))) - 0.5);
/** Expected looks for a classical search of N items in random order, with a single marked item, when the last one needn't be looked at if nothing else matched. */
export const classicalExpected = (N: number) => (N + 1) / 2 - 1 / N;

// ---- The lab

export type LabEvent =
  | { k: 'gate'; gate: 'H' | 'X' | 'Z'; q: number }
  | { k: 'cnot'; control: number; target: number }
  | { k: 'cz' }
  | { k: 'oracle' }
  | { k: 'diffusion' }
  | { k: 'measure'; q: number; read: 0 | 1 };

const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
const isBasis = (s: State) => s.probabilities().filter((p) => p > 1e-9).length === 1;
const isUniform = (s: State) => s.probabilities().every((p) => near(p, 1 / s.amps.length));

export class QubitLab {
  readonly n = 2;
  state = new State(2);
  /** Which of the four items the oracle marks. The learner finds out by running the search. */
  readonly #marked: number;
  rng: Rng;
  events: LabEvent[] = [];
  seen: { state: State; after: LabEvent | null; oracleCalls: number; uniformBeforeOracle: boolean; collapsed: boolean }[] = [];
  shotsTaken: { state: State; counts: number[]; total: number; seed: number; replayed: boolean }[] = [];
  measures: { q: number; read: 0 | 1; before: State; after: State }[] = [];
  oracleCalls = 0;
  uniformBeforeOracle = false;
  /** Measured since the last reset. A collapse lands on a certainty by luck, and that isn't a search. */
  collapsed = false;

  constructor(seed = 1) {
    this.rng = new Rng(seed);
    this.#marked = Math.floor(new Rng(seed ^ 0x5eed).next() * 4);
  }
  isMarked(i: number) { return i === this.#marked; }
  reset() {
    this.state = new State(2);
    this.events = [];
    this.oracleCalls = 0;
    this.uniformBeforeOracle = false;
    this.collapsed = false;
  }
  #note(ev: LabEvent) {
    this.events.push(ev);
    this.seen.push({ state: this.state.clone(), after: ev, oracleCalls: this.oracleCalls, uniformBeforeOracle: this.uniformBeforeOracle, collapsed: this.collapsed });
  }
  gate(gate: 'H' | 'X' | 'Z', q: number) { this.state.apply(gate, q); this.#note({ k: 'gate', gate, q }); }
  cnot(control: number, target: number) { this.state.cnot(control, target); this.#note({ k: 'cnot', control, target }); }
  cz() { this.state.cz(0, 1); this.#note({ k: 'cz' }); }
  oracle() {
    if (this.oracleCalls === 0) this.uniformBeforeOracle = isUniform(this.state);
    this.oracleCalls++;
    this.state.flip(this.#marked);
    this.#note({ k: 'oracle' });
  }
  /** The diffusion step, made of ordinary gates the learner has: H H X X CZ X X H H. */
  diffusion() {
    diffuseWithGates(this.state);
    this.#note({ k: 'diffusion' });
  }
  /** Has a measurement happened in the circuit so far? */
  get measured() { return this.events.some((e) => e.k === 'measure'); }
  /**
   * The whole circuit again from |00>, for one shot. A measurement in it gets a fresh read each
   * time: that's what a fresh run of the circuit is. Sampling the collapsed state instead gave
   * 100% one outcome for H then Measure, under a message calling it a fresh run, where a fresh
   * run of that circuit is 50/50.
   */
  #freshRun(rng: Rng): number {
    const s = new State(2);
    for (const e of this.events) {
      if (e.k === 'gate') s.apply(e.gate, e.q);
      else if (e.k === 'cnot') s.cnot(e.control, e.target);
      else if (e.k === 'cz') s.cz(0, 1);
      else if (e.k === 'oracle') s.flip(this.#marked);
      else if (e.k === 'diffusion') diffuseWithGates(s);
      else s.measure(e.q, rng);
    }
    return s.sample(rng);
  }
  /** Without a measurement a fresh run's final state is the one on screen, so the state is sampled directly. */
  shoot(count: number, seed: number) {
    const rng = new Rng(seed);
    const replayed = this.measured;
    let counts: number[];
    if (replayed) {
      counts = new Array(this.state.amps.length).fill(0) as number[];
      for (let i = 0; i < count; i++) counts[this.#freshRun(rng)]++;
    } else counts = this.state.shots(rng, count);
    this.shotsTaken.push({ state: this.state.clone(), counts, total: count, seed, replayed });
    return counts;
  }
  measureQubit(q: number) {
    const before = this.state.clone();
    const read = this.state.measure(q, this.rng);
    this.collapsed = true;
    this.measures.push({ q, read, before, after: this.state.clone() });
    // In the circuit line, and so in every fresh run. Not in `seen`: the mission reads states
    // reached by gates, and a collapse landing on a certainty by luck isn't one of those.
    this.events.push({ k: 'measure', q, read });
    return read;
  }
}

function diffuseWithGates(s: State) {
  for (const q of [0, 1]) s.apply('H', q);
  for (const q of [0, 1]) s.apply('X', q);
  s.cz(0, 1);
  for (const q of [0, 1]) s.apply('X', q);
  for (const q of [0, 1]) s.apply('H', q);
}

/**
 * Two qubits are a product (a, b) ⊗ (c, d) exactly when a0·a3 = a1·a2. Going by chances alone
 * missed H, H, CZ: all four outcomes at 25%, and entangled, which the lab's note didn't mention.
 */
export function isEntangled(s: State): boolean {
  if (s.n !== 2) throw new RangeError('this check is for two qubits');
  const [a, b, cc, d] = s.amps;
  const det = add(mul(a, d), mul(c(-1), mul(b, cc)));
  return Math.hypot(det.re, det.im) > 1e-9;
}

/**
 * The oracle's sign is what the search is trying to find, and a real machine can't read it. The
 * table can, so straight after an oracle call it would hand over the answer before Diffusion
 * has done anything. Later gates turn that sign into something else on purpose: that's the search.
 */
export const signHidden = (l: QubitLab) => l.events.at(-1)?.k === 'oracle';

/** The line under the table. Tested, because it's a claim about the state. */
export function labNote(l: QubitLab): string {
  const s = l.state, live = s.probabilities().filter((x) => x > 1e-9).length;
  if (live === 1) return 'Certain: one outcome has all the chance.';
  if (signHidden(l)) return 'The oracle changed one sign, and this table is hiding which, because a real machine couldn\'t read it either. Measured now, every chance is what it was before the oracle. Diffusion is what makes the marked item findable.';
  if (isBell(s)) return 'Entangled: these two chances can\'t be written as one qubit\'s chances times the other\'s. Each qubit alone reads as a coin toss, and together they always match or always differ.';
  if (isEntangled(s)) return 'Entangled: these amplitudes can\'t be written as one qubit\'s times the other\'s, even where the chances alone look independent. Measuring one qubit changes the state the other is left in.';
  return `${live} outcomes possible. Bars in red have a negative amplitude: the same chance, and it will cancel differently.`;
}

/** An even split between 00 and 10, or the like: one qubit in superposition, the other not. */
export const sawSuperposition = (l: QubitLab) => l.seen.some((e) => { const p = e.state.probabilities(); return p.filter((x) => near(x, 0.5)).length === 2; });
/** A superposition turned back into a certainty by an H: the paths cancelled. */
export const sawInterference = (l: QubitLab) => l.seen.some((e, i) => {
  if (i === 0 || e.after?.k !== 'gate' || e.after.gate !== 'H') return false;
  return isBasis(e.state) && !isBasis(l.seen[i - 1].state);
});
/** A Z changed no probability, then an H made it matter: same chances before, a different certainty after. */
export const sawPhase = (l: QubitLab) => l.seen.some((e, i) => {
  if (i < 2 || e.after?.k !== 'gate' || e.after.gate !== 'H' || !isBasis(e.state)) return false;
  const prev = l.seen[i - 1], before = l.seen[i - 2];
  if (prev.after?.k !== 'gate' || prev.after.gate !== 'Z' || isBasis(prev.state)) return false;
  // The Z had to do something and show nothing: same probabilities, different amplitudes.
  const samePs = prev.state.probabilities().every((p, j) => near(p, before.state.probabilities()[j]));
  const sameAmps = prev.state.amps.every((a, j) => near(a.re, before.state.amps[j].re));
  return samePs && !sameAmps;
});
export const isBell = (s: State) => {
  const p = s.probabilities();
  const correlated = near(p[0], 0.5) && near(p[3], 0.5);
  const anti = near(p[1], 0.5) && near(p[2], 0.5);
  return correlated || anti;
};
/** The menu offers 10, 100 and 1,000, so two runs of 10 at the same pair of outcomes are 20 shots and count as 20. */
export const sawBellShots = (l: QubitLab) => {
  const total = (pick: (p: number[]) => boolean) => l.shotsTaken.filter((t) => isBell(t.state) && pick(t.state.probabilities())).reduce((n, t) => n + t.total, 0);
  return total((p) => near(p[0], 0.5)) >= 20 || total((p) => near(p[1], 0.5)) >= 20;
};
export const sawFoundMarked = (l: QubitLab) => l.seen.some((e) => e.oracleCalls === 1 && e.uniformBeforeOracle && !e.collapsed && isBasis(e.state) && l.isMarked(e.state.probabilities().findIndex((p) => p > 0.5)));
