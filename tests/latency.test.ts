// The latency table's promise is that nothing in it is undated or unsourced. Numbers from pages
// aren't re-fetched here, because they're claims about their own date, and the lesson says so.
// What can be pinned is that each row keeps its label, and that the arithmetic on them is right.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUDGET_MS, humanTime, LATENCIES, LATENCY_MISSION, LIGHT_M_PER_S, lightRoundTripMetres, planCost, PLACES, PLAN_WRITES, rowById, scaled, type BudgetState, type Plan } from '../src/lib/cs/latency.ts';

test('every row says where it came from, when, what kind of number it is and where it holds', () => {
  assert.equal(LATENCIES.length, 13);
  for (const r of LATENCIES) {
    assert.ok(r.source.length > 3, r.id);
    assert.match(r.url, /^(https:\/\/|\/learn\/)/, r.id);
    assert.ok(r.date.length >= 4, r.id);
    assert.ok(r.holds.length > 10, r.id);
    assert.ok(r.ns > 0, r.id);
  }
  // Sorted, because the bars and the scale read as a ladder.
  for (let i = 1; i < LATENCIES.length; i++) assert.ok(LATENCIES[i].ns >= LATENCIES[i - 1].ns, LATENCIES[i].id);
});

test('the numbers match what their sources say at their dates', () => {
  const ns = (id: string) => rowById(id).ns;
  assert.equal(ns('l1'), 0.5);
  assert.equal(ns('mem'), 100);
  assert.equal(ns('dc'), 500_000);
  assert.equal(ns('seek'), 10_000_000);
  assert.equal(ns('ssd'), 80_000);
  assert.equal(ns('spin'), 4_160_000);
  assert.equal(ns('region'), 8_000_000);
  assert.equal(ns('coast'), 69_000_000);
  assert.equal(ns('atlantic'), 83_000_000);
  assert.equal(ns('asia'), 224_000_000);
  // The data sheet's 4.16 ms is half a turn at 7,200 RPM, which is arithmetic anyone can check.
  assert.equal(Math.round(((60 / 7200 / 2) * 1000) * 100) / 100, 4.17);
  assert.equal(rowById('coast').date, '30 days to 2026-07-30');
});

test('the speed of light is exact, and no round trip can beat it', () => {
  assert.equal(LIGHT_M_PER_S, 299_792_458);
  // About 30 cm in a nanosecond one way, so 15 cm and back.
  assert.equal(Math.round(lightRoundTripMetres(1) * 100) / 100, 0.15);
  // Light could go about 10,300 km and back in 69 ms, and the US is under that wide.
  assert.equal(Math.round(lightRoundTripMetres(69e6) / 1000), 10343);
});

test('times read the way a person would write them', () => {
  assert.equal(humanTime(0.5), '0.5 ns');
  assert.equal(humanTime(100), '100 ns');
  assert.equal(humanTime(80_000), '80 µs');
  assert.equal(humanTime(4_160_000), '4.16 ms');
  assert.equal(humanTime(69_000_000), '69 ms');
  assert.equal(humanTime(1_500_000_000), '1.5 s');
  assert.equal(scaled(100, 0.5), '3.33 minutes');
  assert.equal(scaled(80_000, 0.5), '1.85 days');
  assert.equal(scaled(69_000_000, 0.5), '4.37 years');
  assert.equal(scaled(0.5, 0.5), '1 second');
});

test('the budget is exact arithmetic, and it refuses what it can\'t price', () => {
  assert.deepEqual(planCost({ writes: 40, place: 'dc', batch: 1 }), { roundTrips: 40, ms: 20, fits: true });
  assert.deepEqual(planCost({ writes: 40, place: 'coast', batch: 1 }), { roundTrips: 40, ms: 2760, fits: false });
  assert.deepEqual(planCost({ writes: 40, place: 'coast', batch: 10 }), { roundTrips: 4, ms: 276, fits: true });
  assert.deepEqual(planCost({ writes: 41, place: 'coast', batch: 10 }), { roundTrips: 5, ms: 345, fits: false });
  assert.deepEqual(planCost({ writes: 0, place: 'coast', batch: 10 }), { roundTrips: 0, ms: 0, fits: true });
  assert.throws(() => planCost({ writes: -1, place: 'dc', batch: 1 }));
  assert.throws(() => planCost({ writes: 1, place: 'dc', batch: 0 }));
  assert.throws(() => planCost({ writes: 1, place: 'moon' as never, batch: 1 }));
  assert.equal(BUDGET_MS, 300);
  assert.equal(PLACES.length, 3);
});

test('the mission plays start to finish, and doing fewer writes doesn\'t count', () => {
  const s: BudgetState = LATENCY_MISSION.setup();
  const ticks = () => { let n = 0; for (const st of LATENCY_MISSION.steps) { if (!st.done(s)) break; n++; } return n; };
  const tryPlan = (p: Plan) => s.tried.push({ ...p, ...planCost(p) });
  assert.equal(ticks(), 0);
  tryPlan({ writes: PLAN_WRITES, place: 'dc', batch: 1 });
  assert.equal(ticks(), 1);
  tryPlan({ writes: PLAN_WRITES, place: 'coast', batch: 1 });
  assert.equal(ticks(), 2);
  tryPlan({ writes: 4, place: 'coast', batch: 1 });
  assert.equal(ticks(), 2, 'skipping 36 writes isn\'t a fix');
  assert.match(LATENCY_MISSION.steps[2].why!(s), /36 never happen/);
  tryPlan({ writes: PLAN_WRITES, place: 'dc', batch: 10 });
  assert.equal(ticks(), 2, 'moving the database back isn\'t the question');
  tryPlan({ writes: PLAN_WRITES, place: 'coast', batch: 10 });
  assert.equal(ticks(), 3);
  // Nothing about step 3 can take step 1 or 2 away, however many more are tried.
  tryPlan({ writes: 1, place: 'region', batch: 40 });
  assert.equal(ticks(), 3);
});
