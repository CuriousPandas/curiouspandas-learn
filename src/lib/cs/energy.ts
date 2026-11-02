// The arithmetic of "What a computation costs in joules". Each published figure carries its
// source and date where it's defined, so the widget and the lesson can't quote different
// ones. The chip in the DVFS lab is invented: real voltage and frequency curves aren't
// public in this form, and the lab says so. tests/energy.test.ts checks it all from the formulas.

/** Boltzmann's constant, exact since the 2019 SI redefinition, in joules per kelvin. */
export const BOLTZMANN = 1.380649e-23;

/** Landauer's minimum heat to erase one bit at temperature kelvin: k T ln 2. */
export const landauer = (kelvin: number) => {
  if (!(kelvin > 0)) throw new RangeError('temperature in kelvin, above zero');
  return BOLTZMANN * kelvin * Math.LN2;
};

export const ROOM_KELVIN = 300;

/** A figure someone published. Not called measured: Horowitz's own caption says "Rough energy costs". */
export type Published = { id: string; label: string; joules: number; bits: number; overwrites?: number; note: string };

/**
 * Horowitz, ISSCC 2014, Figure 1.1.9: "Rough energy costs for various operations in 45nm
 * 0.9V". Twelve years old at the time of writing and for an old process. It's used because
 * it's the published breakdown people can check, and the lesson says newer chips differ.
 * `bits` is what a 32-bit operation erases on our count: 32 either way, whether you count 64
 * bits in and 32 out, or the 32 bits of old value its result overwrites. A read only copies, so
 * the copy itself needs no erasing (`bits: 0`), and `overwrites` is the old value it replaces in
 * a register, counted the same way as the add's. Counting one by the first rule and the other by
 * neither made the read look exempt from physics, where it's only far above the limit.
 */
export const HOROWITZ: Published[] = [
  { id: 'add32', label: '32-bit integer add', joules: 0.1e-12, bits: 32, note: 'Horowitz 2014, 45 nm' },
  { id: 'fmul32', label: '32-bit floating-point multiply', joules: 3.7e-12, bits: 32, note: 'Horowitz 2014, 45 nm' },
  { id: 'instr', label: 'a whole instruction for that add (fetch, registers, control, add)', joules: 70e-12, bits: 32, note: 'Horowitz 2014, 45 nm' },
  { id: 'dram', label: 'one 64-bit read from DRAM, low end', joules: 1.3e-9, bits: 0, overwrites: 64, note: 'Horowitz 2014, 45 nm' },
];

/** Green500, June 2026: the top system, KAIROS, at 73.282 GFlops per watt by the list's own rules. */
export const GREEN500_TOP = { system: 'KAIROS', gflopsPerWatt: 73.282, list: 'June 2026' };
/** Flops per watt is operations per second per joule per second, so the seconds cancel: its reciprocal is joules per flop. */
export const joulesPerFlop = (gflopsPerWatt: number) => 1 / (gflopsPerWatt * 1e9);

/** How many times the Landauer minimum this is, for the bits the operation erases. */
export function timesLandauer(joules: number, bits: number, kelvin = ROOM_KELVIN): number | null {
  return bits > 0 ? joules / (bits * landauer(kelvin)) : null;
}

export const wattHoursToJoules = (wh: number) => wh * 3600;
export const twhToJoules = (twh: number) => twh * 1e12 * 3600;

/** Figures in the lesson that are arithmetic on a published number, kept together so the test can pin them. */
export const GEMINI_MEDIAN_WH = 0.24; // Elsworth et al., Google, August 2025: their own measurement of their own service.

// ---- Reversibility: can you work out the input from the output?

export type Gate = { name: string; inputs: number; f: (bits: number[]) => number[] };

export const GATES: Gate[] = [
  { name: 'NOT', inputs: 1, f: ([a]) => [a ^ 1] },
  { name: 'AND', inputs: 2, f: ([a, b]) => [a & b] },
  { name: 'OR', inputs: 2, f: ([a, b]) => [a | b] },
  { name: 'XOR', inputs: 2, f: ([a, b]) => [a ^ b] },
  { name: 'XOR, keeping a', inputs: 2, f: ([a, b]) => [a, a ^ b] },
  { name: 'Toffoli (a, b, c gives a, b, c XOR (a AND b))', inputs: 3, f: ([a, b, c]) => [a, b, c ^ (a & b)] },
  { name: 'Erase (set to 0)', inputs: 1, f: () => [0] },
];

export function truthTable(g: Gate): { input: number[]; output: number[] }[] {
  return Array.from({ length: 2 ** g.inputs }, (_, i) => {
    const input = Array.from({ length: g.inputs }, (_, b) => (i >> (g.inputs - 1 - b)) & 1);
    return { input, output: g.f(input) };
  });
}

/** True when every output comes from exactly one input, so the gate can be run backwards. */
export function reversible(g: Gate): boolean {
  const rows = truthTable(g).map((r) => r.output.join(''));
  return new Set(rows).size === rows.length;
}

/** Bits of information lost when every input is equally likely: the bits in, minus the entropy of what comes out. */
export function bitsLost(g: Gate): number {
  const rows = truthTable(g);
  const count = new Map<string, number>();
  for (const r of rows) { const k = r.output.join(''); count.set(k, (count.get(k) ?? 0) + 1); }
  let h = 0;
  for (const c of count.values()) { const p = c / rows.length; h -= p * Math.log2(p); }
  return g.inputs - h;
}

// ---- DVFS: an invented chip, with a real shape

export type ChipSetting = { volts: number; ghz: number };
export type JobCost = { seconds: number; dynamicJ: number; leakJ: number; idleJ: number; totalJ: number; feasible: boolean; meetsDeadline: boolean };

/** The invented chip. C is switched capacitance per cycle, chosen so the numbers are readable. */
export const CHIP = { capacitance: 1e-9, leakWattsPerVolt: 2, idleWatts: 0.2, thresholdVolts: 0.3, ghzPerVolt: 5, minVolts: 0.5, maxVolts: 1.2 };
export const JOB = { cycles: 2e9, deadlineSeconds: 2 };

/** The fastest this invented chip runs at a voltage: lower voltage means slower transistors. */
export const maxGhz = (volts: number) => Math.max(0, (volts - CHIP.thresholdVolts) * CHIP.ghzPerVolt);

/**
 * Energy for a job: dynamic is C V² per cycle, whatever the clock speed; leakage is paid for
 * as long as the chip is powered on and awake. After finishing, the chip idles to the deadline
 * so settings are compared over the same stretch of time. Going slower at the same voltage
 * therefore saves nothing on dynamic energy and pays more leakage.
 */
export function jobCost(s: ChipSetting): JobCost {
  const cycles = JOB.cycles, hz = s.ghz * 1e9;
  const seconds = cycles / hz;
  const dynamicJ = CHIP.capacitance * s.volts ** 2 * cycles;
  const leakJ = CHIP.leakWattsPerVolt * s.volts * seconds;
  const idleJ = Math.max(0, JOB.deadlineSeconds - seconds) * CHIP.idleWatts;
  return { seconds, dynamicJ, leakJ, idleJ, totalJ: dynamicJ + leakJ + idleJ, feasible: s.ghz <= maxGhz(s.volts) + 1e-9, meetsDeadline: seconds <= JOB.deadlineSeconds + 1e-9 };
}

export const FULL_SPEED: ChipSetting = { volts: 1.2, ghz: 4.5 };

export const VOLT_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2];
export const GHZ_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5];

/** The cheapest setting that works and meets the deadline, found by trying them all. */
export function cheapest(): { setting: ChipSetting; cost: JobCost } {
  let best: { setting: ChipSetting; cost: JobCost } | null = null;
  for (const volts of VOLT_STEPS) for (const ghz of GHZ_STEPS) {
    const cost = jobCost({ volts, ghz });
    if (!cost.feasible || !cost.meetsDeadline) continue;
    if (!best || cost.totalJ < best.cost.totalJ) best = { setting: { volts, ghz }, cost };
  }
  return best!;
}

export class EnergyLab {
  setting: ChipSetting = { ...FULL_SPEED };
  tried: { setting: ChipSetting; cost: JobCost }[] = [];
  /** A setting the chip can't run is reported, never costed as if it could. */
  set(s: ChipSetting) {
    this.setting = s;
    const cost = jobCost(s);
    this.tried.push({ setting: s, cost });
    return cost;
  }
}

const fullCost = () => jobCost(FULL_SPEED).totalJ;
export const sawSlowClockSameVolts = (l: EnergyLab) => l.tried.some((t) => t.setting.volts === FULL_SPEED.volts && t.setting.ghz < FULL_SPEED.ghz && t.cost.meetsDeadline && t.cost.totalJ >= fullCost());
export const sawBrokenSetting = (l: EnergyLab) => l.tried.some((t) => !t.cost.feasible);
export const sawDeadlineMiss = (l: EnergyLab) => l.tried.some((t) => t.cost.feasible && !t.cost.meetsDeadline);
export const sawSaving = (l: EnergyLab) => l.tried.some((t) => t.cost.feasible && t.cost.meetsDeadline && t.cost.totalJ <= fullCost() * (2 / 3));
export const sawBest = (l: EnergyLab) => { const b = cheapest().cost.totalJ; return l.tried.some((t) => t.cost.feasible && t.cost.meetsDeadline && t.cost.totalJ <= b + 1e-9); };
