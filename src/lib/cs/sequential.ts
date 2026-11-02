// The Clock Lab's logic: memory and timing built from NAND gates and nothing else, with every
// gate taking one time step to answer. That single rule is the whole model. It's enough to make
// a latch remember, an edge-triggered flip-flop work, and a counter fail when its clock is too
// fast, because none of those is programmed in: they all come out of the gates.
//
// tests/sequential.test.ts runs the same netlist through a separate simulator in real Python.
// It's a model: real gates have different delays that depend on their load, voltage and
// temperature, and a real latch can sit between 0 and 1 for a while. The model can't see those.

import type { Mission } from '../missions.ts';

export type Gate = { a: number; b: number; out: number };

/** A netlist of two-input NAND gates. A NOT is a NAND with both inputs tied together. */
export class Circuit {
  gates: Gate[] = [];
  values: number[] = [];
  names = new Map<string, number>();

  net(name?: string, value = 0): number {
    const id = this.values.length;
    this.values.push(value);
    if (name) this.names.set(name, id);
    return id;
  }
  // A new gate's output starts at 1, the right answer while its inputs are still 0. Starting
  // at 0 releases every latch from "both inputs active" on the first step, and a latch released
  // like that oscillates for ever in this model: the whole counter buzzed at every clock speed.
  nand(a: number, b: number, out = this.net(undefined, 1)): number {
    this.gates.push({ a, b, out });
    return out;
  }
  not(a: number): number { return this.nand(a, a); }
  and(a: number, b: number): number { return this.not(this.nand(a, b)); }
  xor(a: number, b: number): number {
    const n = this.nand(a, b);
    return this.nand(this.nand(a, n), this.nand(b, n));
  }
  set(net: number, v: number) { this.values[net] = v; }
  get(net: number) { return this.values[net]; }

  /** One gate delay: every gate reads the values from before this step, all at once. */
  tick(): boolean {
    const next = this.gates.map((g) => (this.values[g.a] & this.values[g.b]) ^ 1);
    let changed = false;
    this.gates.forEach((g, i) => { if (this.values[g.out] !== next[i]) { this.values[g.out] = next[i]; changed = true; } });
    return changed;
  }
  /** Runs until nothing changes. A false `settled` is a real result: the circuit is oscillating. */
  settle(max = 64): { ticks: number; settled: boolean } {
    for (let t = 0; t < max; t++) if (!this.tick()) return { ticks: t, settled: true };
    return { ticks: max, settled: false };
  }
}

// ---- one bit that remembers ------------------------------------------------------

/** Two cross-coupled NANDs. Pressing Set or Reset pulls that input low. */
export class SrLatch {
  c = new Circuit();
  sn: number; rn: number; q: number; qn: number;
  constructor() {
    const c = this.c;
    this.sn = c.net('sn', 1); this.rn = c.net('rn', 1);
    this.q = c.net('q', 0); this.qn = c.net('qn', 1);
    c.nand(this.sn, this.qn, this.q);
    c.nand(this.rn, this.q, this.qn);
  }
  /** Set the two inputs at once, then wait for the gates. */
  apply(set: boolean, reset: boolean) {
    this.c.set(this.sn, set ? 0 : 1);
    this.c.set(this.rn, reset ? 0 : 1);
    return { ...this.c.settle(), q: this.c.get(this.q), qn: this.c.get(this.qn) };
  }
}

/** A D latch made of NANDs: while enable is 1, Q follows D. While it's 0, Q holds. Returns the nets. */
export function dLatch(c: Circuit, d: number, en: number, name = '') {
  const dn = c.not(d);
  const s = c.nand(d, en), r = c.nand(dn, en);
  const q = c.net(name ? `${name}.q` : undefined, 0), qn = c.net(name ? `${name}.qn` : undefined, 1);
  c.nand(s, qn, q);
  c.nand(r, q, qn);
  return { q, qn };
}

/**
 * Two latches back to back, sharing a clock with one inverted: the master listens while the
 * clock is low, the slave while it is high. So a change at D can never run straight through.
 * Q changes only when the clock rises, which is what "edge-triggered" means.
 */
export function dFlipFlop(c: Circuit, d: number, clk: number, clkN: number, name = '') {
  const master = dLatch(c, d, clkN, name ? `${name}.m` : '');
  const slave = dLatch(c, master.q, clk, name);
  return slave;
}

export type BenchState = { d: number; clk: number; latchQ: number; ffQ: number };

/** The latch and the flip-flop on one bench, fed the same D and clock. The lab's middle panel. */
export class EdgeBench {
  c = new Circuit();
  dNet: number; clkNet: number; latchQ: number; ffQ: number;
  history: BenchState[] = [];
  constructor() {
    const c = this.c;
    this.dNet = c.net('d'); this.clkNet = c.net('clk');
    const clkN = c.not(this.clkNet);
    this.latchQ = dLatch(c, this.dNet, this.clkNet, 'latch').q;
    this.ffQ = dFlipFlop(c, this.dNet, this.clkNet, clkN, 'ff').q;
    c.settle();
    this.record();
  }
  private record() {
    this.history.push({ d: this.c.get(this.dNet), clk: this.c.get(this.clkNet), latchQ: this.c.get(this.latchQ), ffQ: this.c.get(this.ffQ) });
    if (this.history.length > 40) this.history.shift();
  }
  setD(v: number) { this.c.set(this.dNet, v); this.c.settle(); this.record(); }
  setClk(v: number) { this.c.set(this.clkNet, v); this.c.settle(); this.record(); }
  get state() { return this.history.at(-1)!; }
}

// ---- a counter, and the clock it can't keep up with -------------------------------

export const COUNTER_BITS = 4;

/** Reads D for each bit from an add-one circuit fed by the bits themselves. Output back to input, through a clock. */
export function buildCounter() {
  const c = new Circuit();
  const clk = c.net('clk');
  const clkN = c.not(clk);
  // One's digit: the carry into bit 0 is always 1, because this circuit always adds one.
  const one = c.net('one', 1);
  const d: number[] = Array.from({ length: COUNTER_BITS }, (_, i) => c.net(`d${i}`));
  const q: number[] = [];
  for (let i = 0; i < COUNTER_BITS; i++) q.push(dFlipFlop(c, d[i], clk, clkN, `q${i}`).q);
  let carry = one;
  for (let i = 0; i < COUNTER_BITS; i++) {
    const sum = c.xor(q[i], carry);
    // A wire, modelled as an instant copy: rebuilt by pointing the D net at the sum's gate.
    c.gates.find((g) => g.out === sum)!.out = d[i];
    if (i < COUNTER_BITS - 1) carry = c.and(q[i], carry);
  }
  return { c, clk, q, d };
}

export type CounterTrace = {
  period: number; cycles: number;
  /** The count read just before each rising edge. The first is the starting 0. */
  read: number[];
  /** The first read that isn't the right count, or -1 if every read is right. */
  firstWrong: number;
  /** Whether each signal was high, sampled each gate delay: clock, then bit 0 up to the top bit. */
  wave: { clk: number[]; bits: number[][] };
  correct: boolean;
};

const value = (c: Circuit, q: number[]) => q.reduce((v, n, i) => v | (c.get(n) << i), 0);

/** Runs the counter with a clock of this period, in gate delays: high for half, low for the rest. */
export function runCounter(period: number, cycles = 16): CounterTrace {
  if (!Number.isInteger(period) || period < 2 || period > 64) throw new Error(`a clock period has to be a whole number from 2 to 64 gate delays, not ${period}`);
  const { c, clk, q } = buildCounter();
  // Start from a settled zero: the clock low, and the master latches holding what the adder says.
  c.set(clk, 0);
  c.settle(200);
  const high = Math.floor(period / 2);
  const read: number[] = [value(c, q)];
  const wave = { clk: [] as number[], bits: Array.from({ length: COUNTER_BITS }, () => [] as number[]) };
  const sample = () => { wave.clk.push(c.get(clk)); q.forEach((n, i) => wave.bits[i].push(c.get(n))); };
  for (let k = 0; k < cycles; k++) {
    c.set(clk, 1);
    for (let t = 0; t < high; t++) { sample(); c.tick(); }
    c.set(clk, 0);
    for (let t = high; t < period; t++) { sample(); c.tick(); }
    read.push(value(c, q));
  }
  const firstWrong = read.findIndex((v, i) => v !== i % (1 << COUNTER_BITS));
  return { period, cycles, read, firstWrong, wave, correct: firstWrong < 0 };
}

/** The shortest period from which every period up to the widest here counts correctly. */
export function safePeriod(max = 64): number {
  let safe = max;
  for (let p = max; p >= 2; p--) {
    if (!runCounter(p).correct) break;
    safe = p;
  }
  return safe;
}

export const MIN_PERIOD = 2;
export const MAX_PERIOD = 40;

export type ClockState = { latchHeld: boolean; edgeHeld: boolean; tried: { period: number; correct: boolean }[] };

export const CLOCK_MISSION: Mission<ClockState> = {
  id: 'clock-too-fast', title: 'How fast can it count?', xp: 60,
  setup: () => ({ latchHeld: false, edgeHeld: false, tried: [] }),
  steps: [
    { text: 'Press Set on the latch, then let go. Q is still 1, and nothing is holding it there except the two gates', hint: 'Press Set, then Release', done: (s) => s.latchHeld },
    { text: 'Raise the clock, then change D. The plain latch follows D, and the flip-flop does not', hint: 'Raise clock, then Flip D', done: (s) => s.edgeHeld },
    { text: 'Run the counter with a slow clock. All 16 counts should come out right', hint: 'Set the period to 30 and press Run the counter', done: (s) => s.tried.some((t) => t.correct) },
    { text: 'Find the shortest period where it still counts right: that period right, and one gate delay less wrong', hint: 'Halve the period until it breaks, then creep back up', done: (s) => {
      const safe = safePeriod();
      return s.tried.some((t) => t.period === safe && t.correct) && s.tried.some((t) => t.period === safe - 1 && !t.correct);
    } },
  ],
  debrief: 'No gate in that counter is broken at any speed, and each one still answers in one delay. At a period of 12 it counted to 6, read 15 where 7 belongs, and never got back to 0: over 96 ticks, 42 of its 97 reads are wrong. The add-one circuit\'s answer was right at that edge, but only just: bit 3\'s input had been briefly 1 on its way to 0, and a flip-flop needs its input steady for a few delays before the clock rises. In this model bit 3 then flips on every gate delay, for good, and the reads that look right are only the clock catching it high each time. The period is a promise that everything between two flip-flops has settled, with time to spare, before the next edge. Break it and nothing raises an error. The count just goes wrong.',
};
