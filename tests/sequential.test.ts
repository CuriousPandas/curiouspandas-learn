// The Clock Lab's gates, held against a separate simulator in real Python. The first version of
// this model buzzed: every new gate output started at 0, which released each latch from "both
// inputs active" at the first step, and a latch released like that oscillates for ever. So the
// counter read 0, 15, 0, 15 at every clock speed. The exact-count tests below would catch it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCounter, CLOCK_MISSION, Circuit, COUNTER_BITS, EdgeBench, MAX_PERIOD, MIN_PERIOD, runCounter, safePeriod, SrLatch, type ClockState } from '../src/lib/cs/sequential.ts';
import { python } from './helpers/python-json.ts';

test('a NAND gate is the truth table, one step later', () => {
  for (const [a, b, want] of [[0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 0]]) {
    const c = new Circuit();
    const x = c.net(), y = c.net();
    const o = c.nand(x, y);
    c.set(x, a); c.set(y, b);
    c.settle();
    assert.equal(c.get(o), want, `${a} NAND ${b}`);
  }
});

test('xor and and, built from NAND, match the truth tables', () => {
  for (const [a, b] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
    const c = new Circuit();
    const x = c.net(), y = c.net();
    const xo = c.xor(x, y), an = c.and(x, y);
    c.set(x, a); c.set(y, b);
    assert.ok(c.settle().settled);
    assert.equal(c.get(xo), a ^ b);
    assert.equal(c.get(an), a & b);
  }
});

test('the latch remembers, forgets on Reset, and both-at-once is not a stored bit', () => {
  const s = new SrLatch();
  assert.equal(s.apply(false, false).q, 0);
  assert.equal(s.apply(true, false).q, 1);
  assert.equal(s.apply(false, false).q, 1, 'held with nothing pressed');
  assert.equal(s.apply(false, true).q, 0);
  assert.equal(s.apply(false, false).q, 0);
  const both = s.apply(true, true);
  assert.deepEqual([both.q, both.qn], [1, 1]);
  // Release in the same instant: the model doesn't settle, and the lab says so.
  assert.equal(s.apply(false, false).settled, false);
  assert.equal(s.apply(true, false).q, 1, 'and Set still recovers it');
});

test('a latch follows D while the clock is high. A flip-flop only moves as it rises', () => {
  const b = new EdgeBench();
  b.setD(1);
  assert.deepEqual([b.state.latchQ, b.state.ffQ], [0, 0], 'clock low: nothing moves');
  b.setClk(1);
  assert.deepEqual([b.state.latchQ, b.state.ffQ], [1, 1], 'rising edge: both take D');
  b.setD(0);
  assert.deepEqual([b.state.latchQ, b.state.ffQ], [0, 1], 'clock high: the latch follows and the flip-flop holds');
  b.setD(1); b.setD(0);
  assert.equal(b.state.ffQ, 1, 'and still holds through more changes');
  b.setClk(0);
  assert.deepEqual([b.state.latchQ, b.state.ffQ], [0, 1], 'falling edge: nothing new');
  b.setD(1);
  assert.deepEqual([b.state.latchQ, b.state.ffQ], [0, 1], 'clock low: both ignore D');
  b.setClk(1);
  assert.deepEqual([b.state.latchQ, b.state.ffQ], [1, 1]);
});

test('the counter counts at a slow clock, and the exact safe period is 13 gate delays', () => {
  const slow = runCounter(30);
  assert.ok(slow.correct);
  assert.deepEqual(slow.read, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0]);
  assert.equal(safePeriod(), 13);
  for (let p = 13; p <= MAX_PERIOD; p++) assert.ok(runCounter(p).correct, `period ${p}`);
  assert.equal(runCounter(13).correct, true);
});

test('one delay too fast: it counts to 6, then reads 15 where 7 belongs', () => {
  const r = runCounter(12);
  assert.equal(r.correct, false);
  assert.equal(r.firstWrong, 7);
  assert.deepEqual(r.read.slice(0, 9), [0, 1, 2, 3, 4, 5, 6, 15, 8]);
  // A lower period can look right for a while, and every period below the safe one goes wrong somewhere.
  for (let p = MIN_PERIOD; p < 13; p++) assert.equal(runCounter(p).correct, false, `period ${p}`);
});

test('period 12 never recovers: "goes on to 8" and "flickers for a while" were both wrong', () => {
  // The lesson used to tell a story of one bad read and a brief flicker. This pins what the
  // simulation really does, and each number here is one the lesson and the debrief state.
  const r = runCounter(12, 96);
  assert.equal(r.read.length, 97);
  assert.equal(r.read.filter((v, i) => v !== i % 16).length, 42, '42 of 97 reads are wrong');
  assert.deepEqual(r.read.slice(0, 17), [0, 1, 2, 3, 4, 5, 6, 15, 8, 9, 10, 11, 12, 13, 14, 15, 8]);
  // It never gets back to 0, or anywhere below 8, however long it runs.
  const long = runCounter(12, 2000);
  assert.ok(long.read.slice(7).every((v) => v >= 8));
  // The lab's own 17 reads show two of them.
  assert.equal(runCounter(12).read.filter((v, i) => v !== i % 16).length, 2);
  // Bit 3 flips on every single gate delay from tick 78 to the end of the run, so it never settles.
  const b3 = r.wave.bits[3];
  assert.equal(b3.length, 12 * 96);
  for (let t = 79; t < b3.length; t++) assert.notEqual(b3[t], b3[t - 1], `tick ${t}`);
  assert.equal(b3[78], b3[77], 'and tick 78 is where that starts');
  // 8 to 15 look right only because an even period samples that flip at the same point each time.
  // An odd period catches it high and low in turn, which the lesson quotes.
  assert.deepEqual(runCounter(11, 24).read.slice(6, 14), [14, 7, 8, 1, 10, 3, 12, 5]);
});

test('13 is the limit for reads, not for a clean signal: "the flip-flops cost the other 4" read as a measurement', () => {
  const mostInOneCycle = (p: number) => {
    const w = runCounter(p).wave.bits;
    let most = 0;
    for (const bits of w) for (let c = 0; c < 16; c++) {
      let changes = 0;
      for (let t = c * p + 1; t < (c + 1) * p; t++) if (bits[t] !== bits[t - 1]) changes++;
      most = Math.max(most, changes);
    }
    return most;
  };
  // At 13 and 14 bit 3 blips after the edge into 7 and comes back before it's read.
  assert.equal(runCounter(13).wave.bits[3].slice(6 * 13, 7 * 13).join(''), '0011110000000');
  assert.ok(mostInOneCycle(13) > 1 && mostInOneCycle(14) > 1);
  assert.ok(runCounter(13).correct && runCounter(14).correct);
  for (let p = 15; p <= MAX_PERIOD; p++) assert.equal(mostInOneCycle(p), 1, `period ${p}`);
  for (let p = 13; p <= 64; p++) assert.ok(runCounter(p, 200).correct, `period ${p}, 200 cycles`);
});

test('the flip-flop did not store what was in front of it: its input was 0 at the edge, and 1 got stored', () => {
  // The callout said each flip-flop "did its job with the value in front of it", and the lab said
  // "the flip-flops saved what they were given". Both contradicted the paragraph above them.
  const { c, clk, d, q } = buildCounter();
  c.set(clk, 0);
  c.settle(200);
  for (let edge = 1; edge <= 7; edge++) {
    c.set(clk, 1);
    for (let t = 0; t < 6; t++) c.tick();
    c.set(clk, 0);
    for (let t = 6; t < 12; t++) { if (edge === 6 && t === 10) assert.equal(c.get(d[3]), 1, 'the glitch, still high two delays before the edge'); c.tick(); }
    if (edge === 6) { assert.equal(c.get(d[3]), 0, 'the input just before the edge is 0'); assert.equal(c.get(q[3]), 0); }
  }
  assert.equal(c.get(q[3]), 1, 'and the read after that edge has bit 3 high');
});

test('the reason it fails: bit 3\'s input is briefly wrong on its way, and only just settled at the edge', () => {
  // I first wrote that it failed on 7 + 1, the longest carry. It doesn't: it fails a step
  // earlier, on 6 + 1, where the right answer has no carry into bit 3 at all. This pins what
  // really happens. The lesson and the mission's debrief both describe it.
  const { c, clk, d } = buildCounter();
  c.set(clk, 0);
  c.settle(200);
  const period = 12, high = 6;
  const d3AfterEdge6: number[] = [];
  for (let edge = 1; edge <= 6; edge++) {
    c.set(clk, 1);
    for (let t = 0; t < high; t++) { if (edge === 6) d3AfterEdge6.push(c.get(d[3])); c.tick(); }
    c.set(clk, 0);
    for (let t = high; t < period; t++) { if (edge === 6) d3AfterEdge6.push(c.get(d[3])); c.tick(); }
  }
  // It starts at 0 and ends at 0, which is right. In between it goes to 1.
  assert.equal(d3AfterEdge6[0], 0);
  assert.ok(d3AfterEdge6.includes(1), 'a glitch: briefly 1 on its way');
  assert.equal(c.get(d[3]), 0, 'correct at the moment the clock rises');
  // With one more gate delay the same glitch has time to clear the flip-flop's input stage.
  assert.equal(runCounter(13).read[7], 7);
});

test('the longest path through the add-one logic is 9 gates, and that sets the clock', () => {
  const { c, q, d } = buildCounter();
  // The clock inverter and ten gates a flip-flop come first, then the adder's four XORs and three ANDs.
  const logic = c.gates.slice(1 + 10 * COUNTER_BITS);
  assert.equal(logic.length, 4 * 4 + 3 * 2);
  const depth = new Map<number, number>(q.map((n) => [n, 0]));
  // Settle longest-path depths over the feed-forward adder: repeat until nothing grows.
  for (let i = 0; i < logic.length + 2; i++) {
    for (const g of logic) {
      const da = depth.get(g.a), db = depth.get(g.b);
      if (da === undefined && db === undefined) continue;
      depth.set(g.out, Math.max(depth.get(g.out) ?? 0, 1 + Math.max(da ?? 0, db ?? 0)));
    }
  }
  assert.equal(Math.max(...d.map((n) => depth.get(n)!)), 9);
  assert.equal(c.gates.length, 63, 'the number the lesson states');
  assert.equal(COUNTER_BITS, 4);
});

test('a separate simulator in real Python agrees on every read at every clock period', () => {
  const { c, clk, q } = buildCounter();
  const netlist = { gates: c.gates.map((g) => [g.a, g.b, g.out]), values: c.values, clk, q };
  const out = python(`
import json, sys
net = json.load(sys.stdin)
gates, q, clk = net["gates"], net["q"], net["clk"]
def tick(v):
    # Every gate reads the old values, then all outputs change together: a pure function here,
    # where the TypeScript mutates in place, so they don't share a mistake about ordering.
    out = list(v)
    for a, b, o in gates:
        out[o] = 0 if v[a] and v[b] else 1
    return out
def read(v):
    return sum(v[n] << i for i, n in enumerate(q))
for period in range(2, 41):
    v = list(net["values"])
    v[clk] = 0
    for _ in range(200):
        n = tick(v)
        if n == v:
            break
        v = n
    seen = [read(v)]
    high = period // 2
    for _ in range(16):
        v[clk] = 1
        for _ in range(high):
            v = tick(v)
        v[clk] = 0
        for _ in range(period - high):
            v = tick(v)
        seen.append(read(v))
    print(period, " ".join(map(str, seen)))
`, JSON.stringify(netlist));
  const rows = out.trim().split(/\r?\n/);
  assert.equal(rows.length, MAX_PERIOD - MIN_PERIOD + 1);
  for (const row of rows) {
    const [p, ...reads] = row.split(' ').map(Number);
    assert.deepEqual(runCounter(p).read, reads, `period ${p}`);
  }
});

test('a clock period that isn\'t a whole number of gate delays is refused', () => {
  for (const p of [0, 1, 2.5, 65, Number.NaN]) assert.throws(() => runCounter(p), /whole number from 2 to 64/);
});

test('the mission plays start to finish, and a shortcut can\'t tick the last step', () => {
  const s: ClockState = CLOCK_MISSION.setup();
  const ticks = () => { let n = 0; for (const st of CLOCK_MISSION.steps) { if (!st.done(s)) break; n++; } return n; };
  assert.equal(ticks(), 0);
  s.latchHeld = true;
  assert.equal(ticks(), 1);
  s.edgeHeld = true;
  assert.equal(ticks(), 2);
  s.tried.push({ period: 30, correct: runCounter(30).correct });
  assert.equal(ticks(), 3);
  // Wrong at 5 and right at 30 is not "the shortest period".
  s.tried.push({ period: 5, correct: runCounter(5).correct });
  assert.equal(ticks(), 3);
  // Right at 14 and wrong at 13 can't happen, and 13 alone isn't enough.
  s.tried.push({ period: 13, correct: runCounter(13).correct });
  assert.equal(ticks(), 3);
  s.tried.push({ period: 12, correct: runCounter(12).correct });
  assert.equal(ticks(), 4);
});
