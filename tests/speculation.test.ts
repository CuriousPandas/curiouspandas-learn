// The Speculation Lab is a model and says so, so what's tested is that it models the
// mechanism honestly: the program never sees a difference, the cache does, the mission can't
// be finished without reading the cache, and no defence gets credit it hasn't earned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BARRIER_COST, HIT_CYCLES, MASK_COST, MISS_CYCLES, PROBE_LINES, PUBLIC_LEN, SECRET_LEN, SpecLab, guessedSpectre, hex, meltdownRound, plainVictim, sawBlindTimer, sawDefended, sawIsolation, sawMeltdown, sawRecovered, sawRefusal, spectreRound,
} from '../src/lib/cs/speculation.ts';
import { SPEC_MISSION } from '../src/lib/cs/speculation-missions.ts';

function rng(seed: number) { let s = seed >>> 0; return (n: number) => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s >>> 8) % n; }; }

test('what a program sees never depends on the guess: 40,000 random calls match a CPU with no predictor', () => {
  for (const seed of [1, 2, 3, 4]) {
    const lab = new SpecLab(seed), r = rng(seed);
    for (let i = 0; i < 10_000; i++) {
      if (r(10) === 0) lab.defence = (['none', 'barrier', 'mask'] as const)[r(3)];
      if (r(20) === 0) lab.flush();
      const x = r(40);
      assert.equal(lab.call(x).returned, plainVictim(lab.publicData, x), `seed ${seed}, x ${x}`);
    }
    // And the wrong guesses really did happen, or the test proved nothing.
    assert.ok(lab.calls.filter((c) => c.mispredicted).length > 50);
  }
});

test('an untrained predictor means no speculation, so the attack finds nothing', () => {
  const lab = new SpecLab(5);
  lab.flush();
  const c = lab.call(PUBLIC_LEN);
  assert.equal(c.returned, 0);
  assert.equal(c.guessed, false);
  assert.equal(c.speculated, null);
  assert.equal(lab.cache.size, 0);
  assert.deepEqual(lab.probe().fast, []);
});

test('the predictor is a saturating 2-bit counter', () => {
  const lab = new SpecLab(1);
  const seen: number[] = [];
  for (const x of [0, 0, 0, 0, 99, 99, 99, 99, 99, 0, 0]) { lab.call(x); seen.push(lab.counter); }
  assert.deepEqual(seen, [1, 2, 3, 3, 2, 1, 0, 0, 0, 1, 2]);
});

test('it takes two in-range calls to teach the guess, and the attack then lands', () => {
  const lab = new SpecLab(9);
  lab.call(0);
  lab.flush();
  lab.call(PUBLIC_LEN);
  assert.equal(lab.cache.size, 0, 'one call is not enough');
  const lab2 = new SpecLab(9);
  lab2.call(0); lab2.call(1);
  lab2.flush();
  assert.ok(lab2.call(PUBLIC_LEN).speculated);
  assert.equal(lab2.cache.size, 1);
});

test('a full round recovers exactly one hidden digit, on every seed tried', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const lab = new SpecLab(seed);
    const found: number[] = [];
    for (let p = 0; p < SECRET_LEN; p++) {
      const r = spectreRound(lab, p);
      assert.equal(r.fast.length, 1, `seed ${seed} position ${p}`);
      assert.equal(r.secretMarked, true);
      found.push(r.fast[0]);
    }
    assert.equal(lab.guess('spectre', found.map(hex).join('')), true, `seed ${seed}`);
  }
});

test('a probe with no flush before it shows nothing useful', () => {
  const lab = new SpecLab(3);
  lab.call(0); lab.call(1); lab.call(2);
  lab.call(PUBLIC_LEN);
  const r = lab.probe();
  // Training left its own lines fast too, so the mark isn't one line among slow ones.
  assert.ok(r.fast.length > 1 || r.flushed === false);
  assert.equal(r.flushed, false);
  assert.equal(sawRecovered(lab), false);
  // A second probe straight after sees all of them fast, because probing loads them.
  assert.equal(lab.probe().fast.length, PROBE_LINES);
});

test('reading latencies: the hit and miss are the invented numbers, and a fast line is real', () => {
  const lab = new SpecLab(11);
  const r = spectreRound(lab, 0);
  assert.equal(r.latencies.filter((l) => l === HIT_CYCLES).length, 1);
  assert.equal(r.latencies.filter((l) => l === MISS_CYCLES).length, PROBE_LINES - 1);
});

test('the barrier stops speculation, and costs every call whether or not it was needed', () => {
  const plain = new SpecLab(21), guarded = new SpecLab(21);
  guarded.defence = 'barrier';
  for (let i = 0; i < 16; i++) { plain.call(0); guarded.call(0); }
  assert.equal(guarded.cycles - plain.cycles, 16 * BARRIER_COST);
  const r = spectreRound(guarded, 1);
  assert.equal(r.secretMarked, false);
  assert.deepEqual(r.fast, []);
  assert.equal(sawDefended(guarded), true);
});

test('the mask lets speculation run and keeps it in bounds, so a line still lights up and it is public', () => {
  const lab = new SpecLab(22);
  lab.defence = 'mask';
  const r = spectreRound(lab, 2);
  assert.equal(r.secretMarked, false);
  assert.equal(r.fast.length, 1, 'something still reached the cache');
  assert.equal(r.fast[0], lab.publicData[(PUBLIC_LEN + 2) & (PUBLIC_LEN - 1)]);
  assert.equal(sawDefended(lab), true);
  const cheap = new SpecLab(22);
  cheap.defence = 'mask';
  const before = cheap.cycles;
  cheap.flush(); cheap.call(0); cheap.flush(); cheap.call(0);
  assert.equal(cheap.cycles - before, 2 * (MISS_CYCLES + MASK_COST));
});

test('a mask needs a power-of-two size: the model has one, and the lesson says so', () => {
  assert.equal(PUBLIC_LEN & (PUBLIC_LEN - 1), 0);
});

test('a coarser timer blinds this probe and leaves the mark in the cache', () => {
  const lab = new SpecLab(31);
  lab.coarseTimer = true;
  const r = spectreRound(lab, 0);
  assert.deepEqual(r.fast, []);
  assert.equal(r.secretMarked, true, 'the secret still reached the cache');
  assert.equal(sawBlindTimer(lab), true);
  // Not counted as a defence that worked: the secret still marked the cache.
  assert.equal(sawDefended(lab), false);
});

test('a defence credit needs a real attempt: an untrained call, or one aimed elsewhere, earns nothing', () => {
  const lab = new SpecLab(41);
  lab.defence = 'barrier';
  lab.flush();
  lab.call(PUBLIC_LEN);
  lab.probe();
  assert.equal(sawDefended(lab), false, 'never trained');
  const l2 = new SpecLab(41);
  l2.defence = 'barrier';
  for (let i = 0; i < 4; i++) l2.call(0);
  l2.flush();
  l2.call(30);
  l2.probe();
  assert.equal(sawDefended(l2), false, 'aimed past the secret');
});

test('Spectre without a defence is not reported as defended when the secret was simply missed', () => {
  const lab = new SpecLab(42);
  for (let i = 0; i < 4; i++) lab.call(0);
  lab.flush();
  lab.call(PUBLIC_LEN + SECRET_LEN + 5);
  const r = lab.probe();
  assert.equal(r.secretMarked, false);
  assert.equal(r.fast.length, 1);
  assert.equal(sawRecovered(lab), false);
});

test('Meltdown: the read always faults, and what differs is what ran before the fault', () => {
  const lab = new SpecLab(51);
  const r = meltdownRound(lab, 0);
  assert.equal(lab.kernelReads[0].faulted, true);
  assert.equal(r.secretMarked, true);
  assert.equal(r.fast.length, 1);
  assert.equal(sawMeltdown(lab), true);
  assert.equal(sawIsolation(lab), false);
  lab.pageTableIsolation = true;
  const q = meltdownRound(lab, 0);
  assert.equal(lab.kernelReads[1].faulted, true);
  assert.equal(q.secretMarked, false);
  assert.deepEqual(q.fast, []);
  assert.equal(sawIsolation(lab), true);
});

test('a CPU that checks permissions before passing data on has nothing to leak, with no patch', () => {
  const lab = new SpecLab(61);
  lab.cpu = 'checks-first';
  const r = meltdownRound(lab, 1);
  assert.equal(r.secretMarked, false);
  assert.deepEqual(r.fast, []);
  // It isn't credited as the page-table fix: no isolation was switched on.
  assert.equal(sawIsolation(lab), false);
});

test('each defence is for its own attack: the model makes neither cover for the other', () => {
  const a = new SpecLab(71);
  a.pageTableIsolation = true;
  assert.equal(spectreRound(a, 0).secretMarked, true, 'page table isolation does not stop this Spectre round');
  const b = new SpecLab(72);
  b.defence = 'barrier';
  assert.equal(meltdownRound(b, 0).secretMarked, true, 'a barrier in the victim does not stop Meltdown');
  const c = new SpecLab(73);
  c.cpu = 'checks-first';
  assert.equal(spectreRound(c, 0).secretMarked, true, 'a CPU without Meltdown can still have Spectre');
});

test('a guess only says yes or no, and wrong shapes are just wrong', () => {
  const lab = new SpecLab(81);
  for (const bad of ['', '0', '00000', 'zzzz', '12 34', '0x12']) assert.equal(lab.guess('spectre', bad), false, bad);
  assert.equal(guessedSpectre(lab), false);
});

test('the right digits count however they are spaced: "5 e a a" was refused as the wrong shape', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const lab = new SpecLab(seed);
    const found: string[] = [];
    for (let p = 0; p < SECRET_LEN; p++) found.push(hex(spectreRound(lab, p).fast[0]));
    for (const text of [found.join(''), found.join(' '), found.join(', '), ` ${found.join('  ')} `, found.join('').toUpperCase()]) {
      assert.equal(lab.guess('spectre', text), true, `seed ${seed}: ${text}`);
    }
    // Spacing doesn't rescue the wrong digits.
    const wrong = [...found]; wrong[0] = hex((parseInt(wrong[0], 16) + 1) % 16);
    assert.equal(lab.guess('spectre', wrong.join(' ')), false);
    assert.equal(lab.guess('spectre', found.slice(0, 3).join(' ')), false);
  }
});

test('a probe with nothing aimed at it says so: "wasn\'t flushed" appeared straight after a flush', () => {
  const lab = new SpecLab(90);
  lab.flush();
  const nothing = lab.probe();
  assert.equal(nothing.aimed, false);
  // In range after a flush: not flushed-and-dirty in the sense the old message claimed.
  lab.flush();
  lab.call(3);
  assert.equal(lab.probe().aimed, false);
  // A real round is aimed, and a second probe straight after isn't.
  const r = spectreRound(lab, 0);
  assert.equal(r.aimed, true);
  assert.equal(r.flushed, true);
  assert.equal(lab.probe().aimed, false);
  const src = readFileSync('src/components/SpeculationLab.astro', 'utf8');
  assert.match(src, /!p\.aimed \?/);
});

test('mission: played start to finish by reading the probe, ticks never lost, all hold at the end', () => {
  const s = SPEC_MISSION.setup();
  const lab = s.lab;
  const ticks = () => { let n = 0; for (const st of SPEC_MISSION.steps) { if (!st.done(s)) break; n++; } return n; };
  const seen: number[] = [];
  lab.call(PUBLIC_LEN);
  seen.push(ticks());
  const digitsFound: number[] = [];
  for (let p = 0; p < SECRET_LEN; p++) digitsFound.push(spectreRound(lab, p).fast[0]);
  seen.push(ticks());
  assert.equal(lab.guess('spectre', 'zzzz'), false);
  seen.push(ticks());
  assert.equal(lab.guess('spectre', digitsFound.map(hex).join('')), true);
  seen.push(ticks());
  lab.defence = 'barrier';
  spectreRound(lab, 0);
  seen.push(ticks());
  lab.defence = 'none';
  lab.coarseTimer = true;
  spectreRound(lab, 0);
  seen.push(ticks());
  lab.coarseTimer = false;
  meltdownRound(lab, 0);
  seen.push(ticks());
  lab.pageTableIsolation = true;
  meltdownRound(lab, 0);
  seen.push(ticks());
  assert.deepEqual(seen, [1, 2, 2, 3, 4, 5, 5, 6]);
  assert.ok(SPEC_MISSION.steps.every((st) => st.done(s)));
});

test('mission: shortcuts do not pass, and a differently ordered route does', () => {
  // Doing nothing, and calling only in range.
  const s = SPEC_MISSION.setup();
  assert.equal(SPEC_MISSION.steps[0].done(s), false);
  s.lab.call(1);
  assert.equal(sawRefusal(s.lab), false);
  // A learner who starts with the defence on and only later attacks.
  const t = SPEC_MISSION.setup();
  t.lab.defence = 'mask';
  spectreRound(t.lab, 3);
  t.lab.call(PUBLIC_LEN);
  assert.equal(sawRecovered(t.lab), false);
  assert.equal(sawDefended(t.lab), true);
  t.lab.defence = 'none';
  const got: number[] = [];
  for (let p = 0; p < SECRET_LEN; p++) got.push(spectreRound(t.lab, p).fast[0]);
  assert.equal(sawRecovered(t.lab), true);
  assert.equal(t.lab.guess('spectre', got.map(hex).join('')), true);
  // Brute force isn't blocked by the lab, and 65,536 tries isn't a route anyone takes by hand.
  assert.equal(16 ** SECRET_LEN, 65536);
});

test('the model never touches a real clock or a real timer API', () => {
  const src = readFileSync('src/lib/cs/speculation.ts', 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*')).join('\n');
  assert.doesNotMatch(code, /performance\.|Date\.now|SharedArrayBuffer|Atomics|setTimeout|new Date/);
  const widget = readFileSync('src/components/SpeculationLab.astro', 'utf8');
  assert.doesNotMatch(widget, /performance\.now|SharedArrayBuffer|Atomics\./);
  assert.match(widget, /model/i);
});

test('MASK_COST is below a miss: the model does not claim the cheap fix is expensive', () => {
  assert.ok(MASK_COST < BARRIER_COST && BARRIER_COST < MISS_CYCLES);
});
