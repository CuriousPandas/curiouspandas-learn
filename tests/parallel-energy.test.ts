// Amdahl's law against a tick-by-tick scheduler that knows nothing of it, lanes against a
// brute-force count, a race against every interleaving, and the energy sums against their
// formulas. The published numbers these lessons quote are checked here too, so the page and
// its arithmetic can't drift apart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AmdahlLab, JOB_TICKS, allAtomicInterleavings, allInterleavings, amdahl, amdahlLimit, bestCores, gustafson, instructionsForAdd, lanePattern, ranSchedule, runLanes, sawManyCoresAtNinety, sawTwentyTimes, schedule, tickNote, withOverhead,
} from '../src/lib/cs/parallel.ts';
import { AMDAHL_MISSION } from '../src/lib/cs/parallel-missions.ts';
import {
  BOLTZMANN, CHIP, EnergyLab, FULL_SPEED, GATES, GEMINI_MEDIAN_WH, GHZ_STEPS, GREEN500_TOP, HOROWITZ, JOB, ROOM_KELVIN, VOLT_STEPS, bitsLost, cheapest, jobCost, joulesPerFlop, landauer, maxGhz, reversible, sawBest, sawBrokenSetting, sawSaving, sawSlowClockSameVolts, timesLandauer, truthTable, twhToJoules, wattHoursToJoules,
} from '../src/lib/cs/energy.ts';
import { ENERGY_MISSION } from '../src/lib/cs/energy-missions.ts';

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

// ---- Amdahl

test('the formula at values worked by hand', () => {
  near(amdahl(0.9, 1), 1);
  near(amdahl(0.9, 8), 1 / (0.1 + 0.9 / 8));
  near(amdahl(0.95, 20), 1 / (0.05 + 0.95 / 20));
  near(amdahl(1, 16), 16);
  near(amdahl(0, 1024), 1);
  near(amdahlLimit(0.9), 10);
  assert.equal(amdahlLimit(1), Infinity);
  assert.throws(() => amdahl(1.5, 2), /share/);
  assert.throws(() => amdahl(0.5, 0), /at least one/);
});

test('a scheduler that has never heard of Amdahl lands on Amdahl, wherever the work divides evenly', () => {
  for (const [serial, parallel] of [[100, 900], [50, 950], [1, 999], [500, 500], [0, 1000], [1000, 0], [360, 1680]]) {
    for (const cores of [1, 2, 3, 4, 5, 8, 12, 16, 24, 64, 1000]) {
      const r = schedule(serial, parallel, cores);
      const want = serial + Math.ceil(parallel / cores);
      assert.equal(r.ticks, want, `${serial}+${parallel} on ${cores}`);
      if (parallel % cores === 0) near((serial + parallel) / r.ticks, amdahl(parallel / (serial + parallel), cores));
      // Rounding up can only make the real job slower than the ideal figure, never faster.
      assert.ok((serial + parallel) / r.ticks <= amdahl(parallel / (serial + parallel), cores) + 1e-9);
      // Conservation: all the work was done by someone.
      assert.equal(r.busy.reduce((a, b) => a + b, 0), serial + parallel);
    }
  }
});

test('the numbers the lesson quotes', () => {
  near(amdahl(0.9, 8), 4.705882352941177);
  near(amdahl(0.9, 16), 6.4);
  near(amdahl(0.9, 64), 8.767123287671232);
  assert.equal(amdahl(0.9, 1024).toFixed(2), '9.91');
  near(amdahl(0.99, 64), 39.26380368098159);
  assert.equal(amdahl(0.99, 1024).toFixed(1), '91.2');
  assert.ok(amdahl(0.9, 1_000_000) < 10);
  // Amdahl's own sum: 40% housekeeping, on his reading. 1 / 0.4 = 2.5, and halved to 20%, 5.
  near(amdahlLimit(0.6), 2.5);
  near(amdahlLimit(0.8), 5);
  // Gustafson's reading with 1% serial on 1024: he reports figures of this size, not this one.
  near(gustafson(0.01, 1024), 1013.77);
});

test('coordination cost: past a point, more cores make the job slower', () => {
  const p = 0.95, cost = 0.001, best = bestCores(p, cost, 1024);
  assert.ok(best > 1 && best < 1024);
  assert.ok(withOverhead(p, 1024, cost) < withOverhead(p, best, cost));
  near(withOverhead(p, 1, 0), amdahl(p, 1));
  near(withOverhead(p, 64, 0), amdahl(p, 64));
  // Calculus says √(p / cost) is the peak; the brute force and the formula agree.
  assert.ok(Math.abs(best - Math.sqrt(p / cost)) <= 1);
});

test('mission: played start to finish, ticks never lost, with shortcuts refused', () => {
  const s = AMDAHL_MISSION.setup();
  const l = s.lab;
  const ticks = () => { let n = 0; for (const st of AMDAHL_MISSION.steps) { if (!st.done(s)) break; n++; } return n; };
  const seen: number[] = [];
  l.set(0.9, 8); seen.push(ticks());
  l.runSchedule(); seen.push(ticks());
  l.set(0.9, 1024); seen.push(ticks());
  l.set(0.97, 64); seen.push(ticks());
  assert.deepEqual(seen, [1, 2, 3, 4]);
  assert.ok(AMDAHL_MISSION.steps.every((st) => st.done(s)));
  // More cores alone can't reach 20x at 90%, however many the lab allows.
  const t = new AmdahlLab();
  for (const c of [64, 128, 1024, 4096]) { t.set(0.9, c); assert.equal(sawTwentyTimes(t), false, `${c}`); }
  // And 99.9% on 4096 cores overshoots the budget of 64.
  t.set(0.999, 4096);
  assert.equal(sawTwentyTimes(t), false);
  t.set(0.999, 64);
  assert.equal(sawTwentyTimes(t), true);
  // A schedule on one core shows nothing about waiting.
  const u = new AmdahlLab();
  u.set(0.9, 1); u.runSchedule();
  assert.equal(ranSchedule(u), false);
  assert.equal(sawManyCoresAtNinety(u), false);
  assert.ok(JOB_TICKS === 1000);
});

test('the widest fix within 64 cores: the serial share has to fall below what the lab can check', () => {
  // The exact p needed on 64 cores for 20x, so the lesson can state it: 1/20 = (1-p) + p/64.
  const needed = (1 - 1 / 20) / (1 - 1 / 64);
  near(needed, 0.965079365);
  assert.ok(amdahl(0.97, 64) >= 20);
  assert.ok(amdahl(0.96, 64) < 20);
});

test('the tick note is true at every setting the lab allows, not only near the middle', () => {
  // It said "a little under the formula" whenever the work didn't divide, and at 100% on 4,096
  // cores the run gives 1,000 against a formula of 4,096. The scheduler here shares nothing with
  // the note, so the percentage in the note has to match the run it describes.
  let notes = 0, bigGaps = 0;
  for (let tenths = 0; tenths <= 1000; tenths++) {
    for (let power = 0; power <= 12; power++) {
      const p = tenths / 1000, cores = 2 ** power;
      const parallel = Math.round(p * JOB_TICKS);
      const run = schedule(JOB_TICKS - parallel, parallel, cores);
      const byTicks = JOB_TICKS / run.ticks, formula = amdahl(p, cores);
      // Whole ticks can only lose to the formula, at any setting.
      assert.ok(byTicks <= formula * (1 + 1e-9), `${p} on ${cores}`);
      const note = tickNote(p, cores);
      if (note === '') { assert.ok(Math.abs(byTicks - formula) <= 1e-9 * formula, `${p} on ${cores}: silent at ${byTicks} against ${formula}`); continue; }
      notes++;
      assert.doesNotMatch(note, /a little|slightly|tiny/);
      const stated = Number(/([0-9.]+)% under/.exec(note)![1]), real = (1 - byTicks / formula) * 100;
      assert.ok(Math.abs(stated - real) <= (real < 1 ? 0.051 : 0.51), `${p} on ${cores}: says ${stated}%, is ${real}%`);
      if (real > 5) bigGaps++;
      assert.equal(note.includes('no use for more than'), cores > parallel, `${p} on ${cores}`);
    }
  }
  assert.ok(notes > 5000, `${notes}`);
  // Few settings have a gap this big, and they're the ones the old wording got wrong.
  assert.ok(bigGaps >= 20, `the sweep has to reach the far end: ${bigGaps}`);
  // The extremes by name, as the review found them.
  const row = (p: number, c: number) => { const lab = new AmdahlLab(); lab.set(p, c); return { ticks: JOB_TICKS / lab.runSchedule().ticks, formula: lab.speedup(), note: tickNote(p, c) }; };
  const top = row(1, 4096);
  assert.equal(top.ticks, 1000);
  assert.equal(top.formula, 4096);
  assert.match(top.note, /76% under/);
  assert.match(top.note, /no use for more than 1,000 cores/);
  assert.match(row(1, 2048).note, /51% under/);
  assert.match(row(0.999, 4096).note, /38% under/);
  assert.match(row(0.99, 4096).note, /7% under/);
  // Where the work divides, the two agree and nothing is said.
  assert.equal(tickNote(1, 8), '');
  assert.equal(tickNote(0.5, 4), '');
  assert.equal(tickNote(0, 4096), '');
  // And the small one the lesson's lab opens on.
  assert.match(row(0.9, 8).note, /0\.[0-9]% under/);
  assert.equal(row(0.9, 8).ticks.toFixed(2), '4.69');
});

// ---- SIMD

test('lanes: instructions to add n values, by brute force', () => {
  for (const [n, lanes] of [[1000, 1], [1000, 4], [1000, 8], [1000, 16], [7, 8], [8, 8], [9, 8]]) {
    let count = 0;
    for (let i = 0; i < n; i += lanes) count++;
    assert.equal(instructionsForAdd(n, lanes), count);
  }
  assert.equal(instructionsForAdd(1000, 8), 125);
});

test('lanes: uniform work gets the full speedup, mixed branches lose it, and it can go below 1', () => {
  const n = 1024;
  near(runLanes(lanePattern('uniform', n), 8).speedup, 8);
  const alt = runLanes(lanePattern('alternating', n), 8);
  assert.equal(alt.bothSidesBatches, alt.batches);
  // 512 × 8 + 512 × 1 = 4608 scalar, 128 batches × 9 = 1152 with lanes: 4 times, not 8.
  assert.equal(alt.scalar, 4608);
  assert.equal(alt.simd, 1152);
  near(alt.speedup, 4);
  const rnd = runLanes(lanePattern('random', n, 7), 8);
  assert.ok(rnd.speedup < 8 && rnd.speedup > 1);
  // One lane is exactly the scalar machine.
  near(runLanes(lanePattern('random', n, 7), 1).speedup, 1);
  // Against a brute-force walk of the batches.
  const pat = lanePattern('random', 97, 3);
  let simd = 0;
  for (let i = 0; i < pat.length; i += 8) {
    const b = pat.slice(i, i + 8);
    if (b.includes(true)) simd += 8;
    if (b.includes(false)) simd += 1;
  }
  assert.equal(runLanes(pat, 8).simd, simd);
  assert.throws(() => runLanes(pat, 0), /at least one lane/);
});

// ---- Two cores, one counter

test('every interleaving of two read-add-writes: 20 orders, 18 lose an update, and the atomic version loses none', () => {
  const all = allInterleavings();
  assert.equal(all.length, 20);
  assert.equal(new Set(all.map((o) => o.order)).size, 20);
  assert.equal(all.filter((o) => o.final === 2).length, 2);
  assert.equal(all.filter((o) => o.final === 1).length, 18);
  assert.ok(all.every((o) => o.final === 1 || o.final === 2));
  assert.deepEqual(all.filter((o) => o.final === 2).map((o) => o.order).sort(), ['AAABBB', 'BBBAAA']);
  assert.ok(allAtomicInterleavings().every((o) => o.final === 2));
});

// ---- Energy

test('Landauer at room temperature, computed from the exact constant', () => {
  assert.equal(BOLTZMANN, 1.380649e-23);
  near(landauer(ROOM_KELVIN), 1.380649e-23 * 300 * Math.LN2);
  // The lesson's figure: about 2.87 × 10^-21 J.
  assert.equal(landauer(300).toExponential(2), '2.87e-21');
  // Landauer's own number, from page 265 of the paper: 0.6931.
  assert.equal(Math.LN2.toFixed(4), '0.6931');
  near(landauer(600), 2 * landauer(300));
  assert.throws(() => landauer(0), /kelvin/);
});

test('the gap to the limit, for the published figures', () => {
  // The lesson's ratios, computed and pinned.
  const add = HOROWITZ.find((h) => h.id === 'add32')!;
  assert.equal(Math.round(timesLandauer(add.joules, add.bits)! / 1e6), 1);
  assert.equal(timesLandauer(add.joules, add.bits)!.toPrecision(2), '1.1e+6');
  const instr = HOROWITZ.find((h) => h.id === 'instr')!;
  assert.equal(timesLandauer(instr.joules, instr.bits)!.toPrecision(2), '7.6e+8');
  assert.equal((joulesPerFlop(GREEN500_TOP.gflopsPerWatt) * 1e12).toFixed(1), '13.6');
  assert.equal((joulesPerFlop(GREEN500_TOP.gflopsPerWatt) / landauer(300)).toPrecision(2), '4.8e+9');
  // A copy needs no erasing, so the model gives no minimum for the copy rather than a false one.
  assert.equal(timesLandauer(1.3e-9, 0), null);
  // What the read overwrites in a register does count, on the same rule as the add. "Erases
  // nothing" judged the read by a different rule from the add, and hid that it's far above the
  // limit by the same accounting. The lesson's "about 7 to 14 billion":
  const dram = HOROWITZ.find((h) => h.id === 'dram')!;
  assert.equal(dram.overwrites, 64);
  assert.equal(timesLandauer(1.3e-9, 64)!.toPrecision(1), '7e+9');
  assert.equal(timesLandauer(2.6e-9, 64)!.toPrecision(2), '1.4e+10');
});

test('every setting the Joule lab can show has a verdict that reads true', () => {
  // The verdict rounds to a whole percent, so anything under half a percent would read "0% more
  // energy than full speed", and only full speed itself may take the baseline message.
  const full = jobCost(FULL_SPEED).totalJ;
  for (const volts of VOLT_STEPS) for (const ghz of GHZ_STEPS) {
    const c = jobCost({ volts, ghz });
    if (!c.feasible || !c.meetsDeadline) continue;
    const pct = Math.abs((c.totalJ / full - 1) * 100);
    if (volts === FULL_SPEED.volts && ghz === FULL_SPEED.ghz) { assert.ok(pct < 0.05); continue; }
    assert.ok(pct >= 0.5, `${volts} V, ${ghz} GHz is ${pct}% from full speed`);
  }
});

test('conversions the lesson leans on', () => {
  near(wattHoursToJoules(1), 3600);
  near(wattHoursToJoules(GEMINI_MEDIAN_WH), 864);
  near(twhToJoules(415), 415 * 3.6e15);
  // The prompt's energy against a kettle-sized sum, and the data-centre range from the IEA.
  assert.equal((1700 / 700).toFixed(1), '2.4');
});

test('reversibility: read off the truth table, against what Landauer\'s paper says', () => {
  const by = (n: string) => GATES.find((g) => g.name.startsWith(n))!;
  assert.equal(reversible(by('NOT')), true);
  assert.equal(reversible(by('AND')), false);
  assert.equal(reversible(by('OR')), false);
  assert.equal(reversible(by('XOR,')), true);
  assert.equal(reversible(by('Toffoli')), true);
  assert.equal(reversible(by('Erase')), false);
  // AND gives 0 from three of its four inputs, which is why you can't run it backwards.
  assert.equal(truthTable(by('AND')).filter((r) => r.output[0] === 0).length, 3);
  near(bitsLost(by('NOT')), 0);
  near(bitsLost(by('Toffoli')), 0);
  near(bitsLost(by('Erase')), 1);
  near(bitsLost(by('AND')), 2 - (-(0.75 * Math.log2(0.75)) - 0.25 * Math.log2(0.25)));
  assert.equal(bitsLost(by('AND')).toFixed(3), '1.189');
  // Toffoli with c = 0 computes AND, the construction in Landauer's section 3 (and Toffoli's own).
  for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) assert.equal(by('Toffoli').f([a, b, 0])[2], a & b);
});

test('the invented chip: dynamic energy per job ignores clock speed, leakage rewards finishing', () => {
  const a = jobCost({ volts: 1.2, ghz: 4.5 }), b = jobCost({ volts: 1.2, ghz: 2.25 });
  near(a.dynamicJ, b.dynamicJ);
  assert.ok(b.leakJ > a.leakJ);
  near(a.dynamicJ, CHIP.capacitance * 1.44 * JOB.cycles);
  // Lower voltage saves by the square.
  near(jobCost({ volts: 0.6, ghz: 1 }).dynamicJ, 0.25 * a.dynamicJ);
  // Same voltage, half the clock: worse, and that's the point of the lab.
  assert.ok(jobCost({ volts: 1.2, ghz: 1 }).totalJ > jobCost(FULL_SPEED).totalJ);
  assert.ok(jobCost({ volts: 1.2, ghz: 1 }).feasible);
  // Asking for a clock the voltage can't reach is reported, never costed as if it worked.
  assert.equal(jobCost({ volts: 0.5, ghz: 4.5 }).feasible, false);
  assert.equal(maxGhz(CHIP.thresholdVolts), 0);
  near(maxGhz(1.2), 4.5);
});

test('the best setting by brute force is a real saving, and going lower still is not better', () => {
  const best = cheapest();
  assert.ok(best.cost.meetsDeadline && best.cost.feasible);
  assert.ok(best.cost.totalJ < jobCost(FULL_SPEED).totalJ * 0.6);
  for (const volts of VOLT_STEPS) for (const ghz of GHZ_STEPS) {
    const c = jobCost({ volts, ghz });
    if (c.feasible && c.meetsDeadline) assert.ok(c.totalJ >= best.cost.totalJ - 1e-9);
  }
  // Slow enough to miss the deadline is off the table even when it would cost less.
  assert.equal(jobCost({ volts: 0.5, ghz: 0.5 }).meetsDeadline, false);
});

test('energy mission: played start to finish, ticks never lost, with shortcuts refused', () => {
  const s = ENERGY_MISSION.setup();
  const l = s.lab;
  const ticks = () => { let n = 0; for (const st of ENERGY_MISSION.steps) { if (!st.done(s)) break; n++; } return n; };
  const seen: number[] = [];
  l.set({ volts: 1.2, ghz: 2 }); seen.push(ticks());
  l.set({ volts: 0.6, ghz: 4.5 }); seen.push(ticks());
  const best = cheapest().setting;
  l.set({ volts: 0.8, ghz: 1.5 }); seen.push(ticks());
  l.set({ volts: 0.8, ghz: 2.5 }); seen.push(ticks());
  l.set(best); seen.push(ticks());
  assert.deepEqual(seen, [1, 2, 2, 3, 4]);
  assert.ok(ENERGY_MISSION.steps.every((st) => st.done(s)));
  // Missing the deadline, or a clock the voltage can't reach, doesn't count as a saving.
  const t = new EnergyLab();
  t.set({ volts: 0.5, ghz: 0.5 });
  assert.equal(sawSaving(t), false);
  t.set({ volts: 0.5, ghz: 4.5 });
  assert.equal(sawSaving(t), false);
  assert.equal(sawBrokenSetting(t), true);
  assert.equal(sawBest(t), false);
  // Full speed itself isn't a slower clock at the same voltage.
  const u = new EnergyLab();
  u.set(FULL_SPEED);
  assert.equal(sawSlowClockSameVolts(u), false);
});
