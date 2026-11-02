// The logic simulator, held to truth tables worked out independently of it, and to
// real integer addition computed by real Python. The missions judge behaviour, so
// this file plays each one with several differently shaped correct circuits and with
// the wrong ones a learner is likely to try. It also pins what the later lessons will
// build on: loops are simulated, not refused, and settling takes time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ADDER_PUZZLES, GATE_PUZZLES, LOGIC_MISSIONS, add4Spec, addSubSpec, describeBits, logicState, record, type LogicState, type Puzzle } from '../src/lib/cs/logic-missions.ts';
import {
  LIBRARY, MAX_TABLE_INPUTS, bitNames, bitsFrom, changeDepth, columns, delay, depth, evaluate, flatten, freshNets, hasLoop, judge, numberFrom, readOutputs, rippleAdder, rowInputs, settle, sourcesOf, truthTable, validate,
  type Circuit, type Flat, type GateInst, type Inputs, type Spec,
} from '../src/lib/cs/logic.ts';
import { runPython } from './helpers/python.ts';

const out = (...pairs: [string, string][]) => pairs.map(([name, from]) => ({ name, from }));
const solve = (id: string, set: Puzzle[]) => set.find((p) => p.id === id)!;
const gp = (id: string) => solve(id, GATE_PUZZLES);
const ap = (id: string) => solve(id, ADDER_PUZZLES);

// ---- The primitive and the shelf -----------------------------------------------------

test('NAND is the only primitive, and its table is right', () => {
  const c: Circuit = { inputs: ['a', 'b'], gates: [{ id: 'g', part: 'NAND', in: ['a', 'b'] }], outputs: out(['out', 'g']) };
  assert.deepEqual(truthTable(c).map((r) => r.outputs.out), [1, 1, 1, 0]);
});

// Written out by hand from the definitions, not derived from the simulator, so a wrong
// part cannot agree with itself.
const TABLES: Record<string, { inputs: string[]; rows: Record<string, number[]> }> = {
  NOT: { inputs: ['a'], rows: { out: [1, 0] } },
  AND: { inputs: ['a', 'b'], rows: { out: [0, 0, 0, 1] } },
  OR: { inputs: ['a', 'b'], rows: { out: [0, 1, 1, 1] } },
  XOR: { inputs: ['a', 'b'], rows: { out: [0, 1, 1, 0] } },
  MUX: { inputs: ['sel', 'a', 'b'], rows: { out: [0, 0, 1, 1, 0, 1, 0, 1] } },
  HALF: { inputs: ['a', 'b'], rows: { sum: [0, 1, 1, 0], carry: [0, 0, 0, 1] } },
  FULL: { inputs: ['a', 'b', 'cin'], rows: { sum: [0, 1, 1, 0, 1, 0, 0, 1], carry: [0, 0, 0, 1, 0, 1, 1, 1] } },
};

for (const [name, want] of Object.entries(TABLES)) {
  test(`the sealed ${name} matches its truth table on every input`, () => {
    const p = LIBRARY[name];
    const f = flatten({ inputs: p.inputs, gates: [{ id: 'x', part: name, in: p.inputs }], outputs: p.outputs.map((o) => ({ name: o.name, from: p.outputs.length === 1 ? 'x' : `x.${o.name}` })) });
    assert.deepEqual(p.inputs, want.inputs);
    for (let row = 0; row < 2 ** p.inputs.length; row++) {
      const got = evaluate(f, rowInputs(p.inputs, row))!;
      for (const [o, col] of Object.entries(want.rows)) assert.equal(got[o], col[row], `${name} row ${row} output ${o}`);
    }
  });
}

test('the nine-NAND full adder the lesson mentions really has nine, and passes', () => {
  const nine = RIGHT.full[2];
  assert.equal(flatten(nine).nands.length, 9);
  assert.equal(judge(nine, ap('full').spec).ok, true);
});

test('every part is NANDs underneath, and the counts the lesson states are the real ones', () => {
  const nands = (name: string) => {
    const p = LIBRARY[name];
    return flatten({ inputs: p.inputs, gates: [{ id: 'x', part: name, in: p.inputs }], outputs: [] }).nands.length;
  };
  assert.equal(nands('NOT'), 1);
  assert.equal(nands('AND'), 2);
  assert.equal(nands('OR'), 3);
  assert.equal(nands('XOR'), 4);
  assert.equal(nands('MUX'), 4);
  assert.equal(nands('HALF'), 6);
  assert.equal(nands('FULL'), 15);
});

// The lesson says these can't be done in fewer. An exhaustive search over every wiring
// of n NANDs from a, b and the constants, so the claim is measured, not recalled.
function fewestNands(target: number[], maxGates: number): number | null {
  const size = target.length;
  const bases = [[0, 0, 1, 1], [0, 1, 0, 1], [0, 0, 0, 0], [1, 1, 1, 1]].map((c) => c.slice(0, size));
  const same = (x: number[]) => x.every((v, i) => v === target[i]);
  let found: number | null = null;
  const go = (signals: number[][], used: number) => {
    if (found !== null && used >= found) return;
    if (used === maxGates) return;
    for (let i = 0; i < signals.length; i++) {
      for (let j = i; j < signals.length; j++) {
        const next = signals[i].map((v, k) => (v & signals[j][k]) ^ 1);
        if (same(next)) { found = found === null ? used + 1 : Math.min(found, used + 1); continue; }
        go([...signals, next], used + 1);
      }
    }
  };
  go(bases, 0);
  return found;
}

test('the fewest NANDs for each two-input gate, by exhaustive search', () => {
  assert.equal(fewestNands([1, 1, 0, 0], 4), 1, 'NOT a');
  assert.equal(fewestNands([0, 0, 0, 1], 4), 2, 'AND');
  assert.equal(fewestNands([0, 1, 1, 1], 4), 3, 'OR');
  assert.equal(fewestNands([0, 1, 1, 0], 4), 4, 'XOR needs four: no wiring of three gives it');
  assert.equal(fewestNands([0, 1, 1, 0], 3), null);
});

test('NAND really is enough: any truth table on three inputs can be built, by the sum-of-products recipe the lesson gives', () => {
  // All 256 functions of three inputs, each built by the same mechanical recipe: an
  // AND for each row that should be 1, then OR them all.
  const inputs = ['a', 'b', 'c'];
  for (let fn = 0; fn < 256; fn++) {
    const gates: GateInst[] = inputs.map((n) => ({ id: `n${n}`, part: 'NOT', in: [n] }));
    let result = '0';
    for (let row = 0; row < 8; row++) {
      if (!((fn >> row) & 1)) continue;
      const lits = inputs.map((n, i) => ((row >> (2 - i)) & 1 ? n : `n${n}`));
      gates.push({ id: `p${row}`, part: 'AND', in: [lits[0], lits[1]] }, { id: `q${row}`, part: 'AND', in: [`p${row}`, lits[2]] });
      gates.push({ id: `r${row}`, part: 'OR', in: [result, `q${row}`] });
      result = `r${row}`;
    }
    const c: Circuit = { inputs, gates, outputs: out(['out', result]) };
    const f = flatten(c);
    for (let row = 0; row < 8; row++) assert.equal(evaluate(f, rowInputs(inputs, row))!.out, (fn >> row) & 1, `function ${fn} row ${row}`);
  }
});

// ---- Refusals -----------------------------------------------------------------------

test('a circuit with something unconnected is refused by name, and not read as 0', () => {
  const c: Circuit = { inputs: ['a', 'b'], gates: [{ id: 'g', part: 'NAND', in: ['a', ''] }], outputs: out(['out', 'g']) };
  assert.match(validate(c)[0], /Input b of g isn't connected/);
  const v = judge(c, gp('nand').spec);
  assert.equal(v.ok, false);
  assert.match(v.problem!, /isn't connected/);
  assert.throws(() => flatten(c), /isn't connected/);
});

test('an output left unwired fails, even when the other outputs are right: the failure a half-built adder would otherwise hide', () => {
  const c: Circuit = { inputs: ['a', 'b'], gates: [{ id: 's', part: 'XOR', in: ['a', 'b'] }], outputs: out(['sum', 's'], ['carry', '']) };
  const v = judge(c, ap('half').spec);
  assert.equal(v.ok, false);
  assert.match(v.problem!, /Output carry isn't connected/);
});

test('names that do not exist are refused', () => {
  const c: Circuit = { inputs: ['a'], gates: [{ id: 'g', part: 'NAND', in: ['a', 'zz'] }], outputs: out(['out', 'g']) };
  assert.match(validate(c)[0], /connected to zz/);
  assert.match(validate({ inputs: ['a'], gates: [{ id: 'g', part: 'WAT', in: ['a'] }], outputs: [] })[0], /no such part/);
  assert.match(validate({ inputs: ['a'], gates: [{ id: 'g', part: 'NOT', in: ['a', 'a'] }], outputs: [] })[0], /needs 1 inputs/);
  assert.match(validate({ inputs: ['a'], gates: [{ id: 'g', part: 'NOT', in: ['a'] }, { id: 'g', part: 'NOT', in: ['a'] }], outputs: [] })[0], /both called g/);
  // A multi-output part has to say which output. Bare 'fa' would be a silent guess.
  assert.match(validate({ inputs: ['a'], gates: [{ id: 'fa', part: 'HALF', in: ['a', 'a'] }], outputs: out(['out', 'fa']) })[0], /connected to fa/);
});

test('judge refuses a table too large to try, rather than checking part of it', () => {
  const names = Array.from({ length: MAX_TABLE_INPUTS + 1 }, (_, i) => `i${i}`);
  const s: Spec = { inputs: names, outputs: [], fn: () => ({}) };
  assert.throws(() => judge({ inputs: names, gates: [], outputs: [] }, s), /too many/);
});

test('judge refuses a circuit that does not have the puzzle\'s pins, so a typo in a puzzle cannot pass vacuously', () => {
  assert.throws(() => judge({ inputs: ['x'], gates: [], outputs: out(['out', 'x']) }, gp('not').spec), /inputs/);
  assert.throws(() => judge({ inputs: ['a'], gates: [], outputs: [] }, gp('not').spec), /no output/);
});

// ---- Time and loops, the contract for the lessons after this one ------------------------

test('settling takes time: a chain of NOTs takes one gate delay each', () => {
  const gates: GateInst[] = [];
  for (let i = 0; i < 5; i++) gates.push({ id: `g${i}`, part: 'NOT', in: [i === 0 ? 'a' : `g${i - 1}`] });
  const f = flatten({ inputs: ['a'], gates, outputs: out(['out', 'g4']) });
  assert.equal(depth(f)!.max, 5);
  const settled = settle(f, { a: 0 });
  const change = settle(f, { a: 1 }, { from: settled.nets });
  assert.equal(change.stable, true);
  assert.equal(change.steps, 5);
  assert.equal(readOutputs(f, change.nets).out, 0);
});

test('delay() moves a change by exactly one gate per call', () => {
  const f = flatten({ inputs: ['a'], gates: [{ id: 'g0', part: 'NOT', in: ['a'] }, { id: 'g1', part: 'NOT', in: ['g0'] }], outputs: out(['out', 'g1']) });
  const nets = freshNets(f, { a: 1 }, settle(f, { a: 0 }).nets);
  assert.equal(readOutputs(f, nets).out, 0, 'not yet');
  assert.equal(delay(f, nets), true);
  assert.equal(readOutputs(f, nets).out, 0, 'one gate has reacted, the output has not');
  assert.equal(delay(f, nets), true);
  assert.equal(readOutputs(f, nets).out, 1);
  assert.equal(delay(f, nets), false, 'settled');
});

// The two cross-coupled NANDs every flip-flop lesson starts from. Active-low: s=0 sets, r=0 resets, both 1 holds.
const latch: Circuit = {
  inputs: ['s', 'r'],
  gates: [{ id: 'q', part: 'NAND', in: ['s', 'nq'] }, { id: 'nq', part: 'NAND', in: ['r', 'q'] }],
  outputs: out(['q', 'q'], ['nq', 'nq']),
};

test('a loop is simulated, and it remembers: an SR latch holds what it was last told', () => {
  const f = flatten(latch);
  assert.equal(hasLoop(f), true);
  let nets = settle(f, { s: 0, r: 1 }).nets;
  assert.equal(readOutputs(f, nets).q, 1);
  nets = settle(f, { s: 1, r: 1 }, { from: nets }).nets;
  assert.equal(readOutputs(f, nets).q, 1, 'holds 1');
  nets = settle(f, { s: 1, r: 0 }, { from: nets }).nets;
  assert.equal(readOutputs(f, nets).q, 0);
  nets = settle(f, { s: 1, r: 1 }, { from: nets }).nets;
  assert.equal(readOutputs(f, nets).q, 0, 'holds 0');
});

test('both inputs released at once is a race: oscillates when gates are perfectly matched, settles when one goes first', () => {
  const f = flatten(latch);
  const both = settle(f, { s: 0, r: 0 }).nets;
  assert.deepEqual(readOutputs(f, both), { q: 1, nq: 1 });
  assert.equal(settle(f, { s: 1, r: 1 }, { from: both }).stable, false, 'matched gates never break the tie');
  const one = settle(f, { s: 1, r: 1 }, { from: both, order: 'inOrder' });
  assert.equal(one.stable, true);
  assert.notEqual(readOutputs(f, one.nets).q, readOutputs(f, one.nets).nq);
});

test('an odd ring of NOTs oscillates, and the simulator reports it rather than hanging or inventing a value', () => {
  const ring: Circuit = { inputs: [], gates: [{ id: 'x', part: 'NOT', in: ['z'] }, { id: 'y', part: 'NOT', in: ['x'] }, { id: 'z', part: 'NOT', in: ['y'] }], outputs: out(['out', 'z']) };
  const f = flatten(ring);
  const r = settle(f, {});
  assert.equal(r.stable, false);
  assert.equal(evaluate(f, {}), null);
});

test('truthTable and judge refuse a loop: it has no single table', () => {
  assert.throws(() => truthTable(latch), /loops/);
  const s: Spec = { inputs: ['s', 'r'], outputs: ['q'], fn: () => ({ q: 0 }) };
  const v = judge(latch, s);
  assert.equal(v.ok, false);
  assert.match(v.problem!, /loops back/);
});

test('a loop through a sealed part is seen too, and a part that contains itself is refused', () => {
  const c: Circuit = { inputs: ['a'], gates: [{ id: 'x', part: 'AND', in: ['a', 'y'] }, { id: 'y', part: 'OR', in: ['a', 'x'] }], outputs: out(['out', 'y']) };
  assert.equal(hasLoop(flatten(c)), true);
  const lib = { ...LIBRARY, SELF: { inputs: ['a'], gates: [{ id: 'g', part: 'SELF', in: ['a'] }], outputs: out(['out', 'g']) } };
  assert.throws(() => flatten({ inputs: ['a'], gates: [{ id: 'x', part: 'SELF', in: ['a'] }], outputs: [] }, lib), /contains itself/);
});

test('no gate is needed for a straight wire, and it has zero delay', () => {
  const c: Circuit = { inputs: ['a'], gates: [], outputs: out(['out', 'a']) };
  assert.deepEqual(truthTable(c).map((r) => r.outputs.out), [0, 1]);
  assert.equal(depth(flatten(c))!.max, 0);
});

test('columns lays every gate after what it reads, and survives a loop', () => {
  const col = columns(rippleAdder(3));
  assert.deepEqual([col.get('fa0'), col.get('fa1'), col.get('fa2')], [1, 2, 3]);
  assert.equal(columns(latch).size, 2);
});

test('sourcesOf offers only what exists, naming each output of a part with several', () => {
  assert.deepEqual(sourcesOf({ inputs: ['a'], gates: [{ id: 'h', part: 'HALF', in: ['a', 'a'] }, { id: 'n', part: 'NOT', in: ['a'] }], outputs: [] }), ['a', 'h.sum', 'h.carry', 'n', '0', '1']);
});

// ---- Real arithmetic ------------------------------------------------------------------

test('the ripple adder agrees with real Python on every 8-bit pair (65,536 sums)', () => {
  const r = runPython('import json\nprint(json.dumps([(a + b) for a in range(256) for b in range(256)]))');
  assert.equal(r.status, 0, r.stderr);
  const want = JSON.parse(r.stdout) as number[];
  const f = flatten(rippleAdder(8));
  let i = 0;
  for (let a = 0; a < 256; a++) {
    for (let b = 0; b < 256; b++) {
      const got = evaluate(f, { ...bitsFrom(a, 'a', 8), ...bitsFrom(b, 'b', 8) })!;
      const value = numberFrom(got, 's', 8) + got.carry * 256;
      assert.equal(value, want[i++], `${a} + ${b}`);
    }
  }
  assert.equal(i, 65536);
});

test('a 32-bit adder on random pairs against real Python, wrapped as ctypes.c_uint32 wraps it', () => {
  const pairs: [number, number][] = [];
  let x = 12345;
  const next = () => { x = (x * 1103515245 + 12345) % 2147483648; return x; };
  for (let i = 0; i < 300; i++) pairs.push([next() * 2 % 4294967296, next() * 2 % 4294967296]);
  pairs.push([4294967295, 1], [0, 0], [4294967295, 4294967295], [2147483648, 2147483648]);
  const r = runPython(`import ctypes, json\nfor a, b in ${JSON.stringify(pairs)}:\n    print(ctypes.c_uint32(a + b).value, (a + b) >> 32)\n`);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout.trim().split('\n');
  const f = flatten(rippleAdder(32));
  pairs.forEach(([a, b], i) => {
    const got = evaluate(f, { ...bitsFrom(a, 'a', 32), ...bitsFrom(b, 'b', 32) })!;
    assert.equal(`${numberFrom(got, 's', 32)} ${got.carry}`, rows[i], `${a} + ${b}`);
  });
});

// The table in the adder lesson, read back from the lesson itself so the two can't drift.
const DELAY_TABLE = [...readFileSync('src/content/lessons/computer/adder.mdx', 'utf8').matchAll(/^\| (\d+) bits? \| (\d+) \| (\d+) \|$/gm)].map((m) => m.slice(1).map(Number));

/** With every bit of a on and b at 0, turn on b0: the carry runs the whole width. Built bit by bit, because 2 ** 64 - 1 isn't a whole number a double can hold. */
function carryRun(f: Flat, w: number) {
  const a = Object.fromEntries(bitNames('a', w).map((n) => [n, 1 as const]));
  const b = Object.fromEntries(bitNames('b', w).map((n) => [n, 0 as const]));
  return settle(f, { ...a, ...b, b0: 1 }, { from: settle(f, { ...a, ...b }).nets });
}

test('the adder table once "measured" 19 gate delays while the panel said "Settled after 16": every row now equals the limit, and a real change reaches it', () => {
  assert.deepEqual(DELAY_TABLE.map((r) => r[0]), [1, 2, 4, 8, 16, 32, 64], 'found every row of the table');
  for (const [w, nands, settles] of DELAY_TABLE) {
    const f = flatten(rippleAdder(w));
    assert.equal(f.nands.length, nands, `${w} bits: NANDs`);
    assert.equal(changeDepth(f), settles, `${w} bits: no change can take longer than this`);
    const run = carryRun(f, w);
    assert.equal(run.stable, true);
    assert.equal(run.steps, settles, `${w} bits: and this change takes exactly that long`);
    assert.equal(readOutputs(f, run.nets).carry, 1, `${w} bits: the carry really got there`);
    if (w >= 2) assert.equal(settles, 4 * w, 'the formula the lesson gives from 2 bits up');
    // The old number is a real count of the wiring, and no change ever takes that long.
    assert.equal(depth(f)!.max, 4 * w + 3);
  }
});

test('every change between settled states, at every width up to 4 bits: 65,280 of them at 4 bits, and the worst is the table\'s number', () => {
  const counted: [number, number, number][] = [];
  for (const w of [1, 2, 3, 4]) {
    const f = flatten(rippleAdder(w));
    const n = 2 ** (2 * w);
    const inputs = (row: number) => Object.fromEntries(f.inputs.map((name, i) => [name, ((row >> i) & 1) as 0 | 1]));
    const settled = Array.from({ length: n }, (_, row) => settle(f, inputs(row)).nets);
    let worst = 0, worstFlip = 0, changes = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const r = settle(f, inputs(j), { from: settled[i] });
        assert.equal(r.stable, true);
        changes++;
        worst = Math.max(worst, r.steps);
        // One switch at a time is all the lab lets a learner do, so the number has to be reachable that way.
        const x = i ^ j;
        if ((x & (x - 1)) === 0) worstFlip = Math.max(worstFlip, r.steps);
      }
    }
    assert.equal(worstFlip, worst, `${w} bits: one switch can reach the worst`);
    assert.equal(worst, changeDepth(f));
    counted.push([w, changes, worst]);
  }
  assert.deepEqual(counted, [[1, 12, 5], [2, 240, 8], [3, 4032, 12], [4, 65280, 16]]);
});

test('changeDepth really is a limit: on random wirings with fixed 0s and 1s, no change between settled states takes longer', () => {
  let x = 2024;
  const next = (m: number) => { x = (x * 1103515245 + 12345) % 2147483648; return Math.floor(x / 65536) % m; };
  let held = 0;
  for (let t = 0; t < 300; t++) {
    const inputs = ['a', 'b', 'c'];
    const gates: GateInst[] = [];
    const size = 1 + next(12);
    for (let i = 0; i < size; i++) {
      const pool = [...inputs, '0', '1', ...gates.map((g) => g.id)];
      gates.push({ id: `g${i}`, part: 'NAND', in: [pool[next(pool.length)], pool[next(pool.length)]] });
    }
    const f = flatten({ inputs, gates, outputs: out(['out', gates.at(-1)!.id]) });
    const limit = changeDepth(f)!;
    if (limit < depth(f)!.max) held++;
    const row = (r: number) => ({ a: ((r >> 2) & 1) as 0 | 1, b: ((r >> 1) & 1) as 0 | 1, c: (r & 1) as 0 | 1 });
    for (let i = 0; i < 8; i++) {
      const from = settle(f, row(i)).nets;
      for (let j = 0; j < 8; j++) {
        const r = settle(f, row(j), { from });
        assert.ok(r.stable && r.steps <= limit, `try ${t}: ${i} to ${j} took ${r.steps}, limit ${limit}`);
      }
    }
  }
  assert.ok(held > 20, `the fixed inputs really were exercised: ${held}`);
  assert.equal(changeDepth(flatten(latch)), null, 'a loop has no limit');
});

test('"A wrap is a carry with nowhere to go" was false for signed numbers: the simulator\'s carry against signed overflow on every 4-bit pair', () => {
  const f = flatten(rippleAdder(4));
  const signed = (u: number) => (u >= 8 ? u - 16 : u);
  let wrapsWithNoCarry = 0, carriesWithNoWrap = 0;
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      const nets = settle(f, { ...bitsFrom(a, 'a', 4), ...bitsFrom(b, 'b', 4) }).nets;
      const o = readOutputs(f, nets);
      const carryOut = o.carry === 1;
      const exact = signed(a) + signed(b);
      const overflow = exact > 7 || exact < -8;
      // The rule the lesson teaches, on the wires it names.
      assert.equal(nets[f.tap['fa2.carry']] !== nets[f.tap['fa3.carry']], overflow, `${a} + ${b}: carry in differs from carry out`);
      const sameSign = (a >= 8) === (b >= 8), result = numberFrom(o, 's', 4);
      assert.equal(sameSign && (result >= 8) !== (a >= 8), overflow, `${a} + ${b}: same-sign inputs, other-sign result`);
      assert.equal(carryOut, a + b >= 16, 'and the carry out is exactly the unsigned wrap');
      if (overflow && !carryOut) wrapsWithNoCarry++;
      if (carryOut && !overflow) carriesWithNoWrap++;
    }
  }
  assert.ok(wrapsWithNoCarry > 0 && carriesWithNoWrap > 0);
  // The lesson's two examples, 7 + 1 and -3 + 5.
  const seven = readOutputs(f, settle(f, { ...bitsFrom(7, 'a', 4), ...bitsFrom(1, 'b', 4) }).nets);
  assert.deepEqual([numberFrom(seven, 's', 4), seven.carry], [8, 0], '1000 and no carry');
  const three = readOutputs(f, settle(f, { ...bitsFrom(13, 'a', 4), ...bitsFrom(5, 'b', 4) }).nets);
  assert.deepEqual([numberFrom(three, 's', 4), three.carry], [2, 1], '0010 and a carry');
});

// Every function reachable from the given starting functions under one gate. A function is its
// truth table over two inputs, one bit per row, with the all-zeros row as the top bit.
function closure(start: number[], gate: (x: number, y: number) => number): Set<number> {
  const seen = new Set(start);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of [...seen]) for (const y of [...seen]) {
      const z = gate(x, y) & 0b1111;
      if (!seen.has(z)) { seen.add(z); grew = true; }
    }
  }
  return seen;
}
const [A, B, ZERO, ONE, AND_TABLE, NOT_A] = [0b0011, 0b0101, 0, 0b1111, 0b0001, 0b1100];

test('"In a similar way, XOR alone can\'t make AND" gave a reason that doesn\'t carry over: AND also gives 0 on all 0s. XOR is stopped by parity', () => {
  assert.equal(AND_TABLE & 0b1000, 0, 'AND gives 0 when both inputs are 0, so the all-zeros argument could not exclude it');
  const xor = closure([A, B, ZERO, ONE], (x, y) => x ^ y);
  assert.equal(xor.size, 8, 'parity of a subset of the inputs, and its opposite');
  assert.equal(xor.has(AND_TABLE), false);
  const parities = [ZERO, A, B, A ^ B];
  for (const fn of xor) assert.ok(parities.includes(fn) || parities.includes(fn ^ ONE), `${fn} is a parity or its flip`);
});

test('the all-zeros argument for AND and OR fell to the lab\'s own "always 1": even with fixed 0s and 1s they can\'t make NOT, because they only ever rise', () => {
  const grown = new Set([A, B, ZERO, ONE]);
  for (let grew = true; grew;) {
    grew = false;
    for (const x of [...grown]) for (const y of [...grown]) for (const z of [x & y, x | y]) if (!grown.has(z)) { grown.add(z); grew = true; }
  }
  assert.deepEqual([...grown].sort((p, q) => p - q), [ZERO, AND_TABLE, A, B, 0b0111, ONE], 'exactly six functions');
  assert.equal(grown.has(NOT_A), false);
  // In the lab's dropdown, a fixed 1 does beat the old reason: OR(a, 1) gives 1 on all 0s.
  const f = flatten({ inputs: ['a'], gates: [{ id: 'o', part: 'OR', in: ['a', '1'] }], outputs: out(['out', 'o']) });
  assert.equal(evaluate(f, { a: 0 })!.out, 1);
});

test('"Nothing in the lab looks at how you wired it" was too strong: a right NOT plus a half-wired or looped spare is refused, and a fully wired spare passes', () => {
  const spec = gp('not').spec;
  const right = { id: 'g', part: 'NAND', in: ['a', 'a'] };
  const with_ = (spare: GateInst) => judge({ inputs: ['a'], gates: [right, spare], outputs: out(['out', 'g']) }, spec);
  assert.match(with_({ id: 's', part: 'NAND', in: ['a', ''] }).problem!, /Input b of s isn't connected/);
  assert.match(with_({ id: 's', part: 'NAND', in: ['a', 's'] }).problem!, /loops back/);
  assert.equal(with_({ id: 's', part: 'NAND', in: ['a', '0'] }).ok, true);
});

test('the panel\'s number is the limit, for a right 4-bit adder built as the mission builds it', () => {
  const c: Circuit = {
    inputs: [...bitNames('a', 4), ...bitNames('b', 4)],
    gates: [{ id: 'g1', part: 'FULL', in: ['a0', 'b0', '0'] }, { id: 'g2', part: 'FULL', in: ['a1', 'b1', 'g1.carry'] }, { id: 'g3', part: 'FULL', in: ['a2', 'b2', 'g2.carry'] }, { id: 'g4', part: 'FULL', in: ['a3', 'b3', 'g3.carry'] }],
    outputs: out(['s0', 'g1.sum'], ['s1', 'g2.sum'], ['s2', 'g3.sum'], ['s3', 'g4.sum'], ['carry', 'g4.carry']),
  };
  const v = judge(c, ap('add4').spec);
  assert.equal(v.ok, true);
  assert.equal(v.settlesWithin, 16);
  assert.equal(v.depth, 19, 'the structural count the panel used to show');
});

test('the worst case really takes that long: a carry running the whole width, simulated, not just the formula', () => {
  const f = flatten(rippleAdder(8));
  const a = bitsFrom(255, 'a', 8);
  const before = settle(f, { ...a, ...bitsFrom(0, 'b', 8) });
  const after = settle(f, { ...a, ...bitsFrom(1, 'b', 8) }, { from: before.nets });
  assert.equal(numberFrom(readOutputs(f, after.nets), 's', 8), 0);
  assert.equal(readOutputs(f, after.nets).carry, 1);
  assert.equal(after.steps, changeDepth(f));
  // Flipping a carry-free bit costs far less, which is why average adds are not the worst case.
  const easy = settle(f, { ...bitsFrom(0, 'a', 8), ...bitsFrom(128, 'b', 8) }, { from: settle(f, { ...bitsFrom(0, 'a', 8), ...bitsFrom(0, 'b', 8) }).nets });
  assert.ok(easy.steps < after.steps);
});

// ---- Missions: differently shaped right answers, and tempting wrong ones ----------------

const c = (inputs: string[], gates: [string, string, ...string[]][], outputs: [string, string][]): Circuit => ({ inputs, gates: gates.map(([id, part, ...i]) => ({ id, part, in: i })), outputs: out(...outputs) });

const RIGHT: Record<string, Circuit[]> = {
  not: [
    c(['a'], [['g', 'NAND', 'a', 'a']], [['out', 'g']]),
    c(['a'], [['g', 'NAND', 'a', '1']], [['out', 'g']]),
    c(['a'], [['g', 'NAND', '1', 'a'], ['spare', 'NAND', 'a', '0']], [['out', 'g']]),
    // Three NOTs in a row is wasteful, and right.
    c(['a'], [['x', 'NAND', 'a', 'a'], ['y', 'NAND', 'x', 'x'], ['z', 'NAND', 'y', 'y']], [['out', 'z']]),
  ],
  and: [
    c(['a', 'b'], [['n', 'NAND', 'a', 'b'], ['o', 'NOT', 'n']], [['out', 'o']]),
    c(['a', 'b'], [['n', 'NAND', 'b', 'a'], ['o', 'NAND', 'n', 'n']], [['out', 'o']]),
    c(['a', 'b'], [['n', 'NAND', 'a', 'b'], ['o', 'NAND', 'n', '1']], [['out', 'o']]),
  ],
  or: [
    c(['a', 'b'], [['x', 'NOT', 'a'], ['y', 'NOT', 'b'], ['o', 'NAND', 'x', 'y']], [['out', 'o']]),
    c(['a', 'b'], [['x', 'NAND', 'a', 'a'], ['y', 'NAND', 'b', 'b'], ['o', 'NAND', 'y', 'x']], [['out', 'o']]),
    // De Morgan by way of AND: not (not a and not b).
    c(['a', 'b'], [['x', 'NOT', 'a'], ['y', 'NOT', 'b'], ['z', 'AND', 'x', 'y'], ['o', 'NOT', 'z']], [['out', 'o']]),
  ],
  xor: [
    c(['a', 'b'], [['m', 'NAND', 'a', 'b'], ['x', 'NAND', 'a', 'm'], ['y', 'NAND', 'b', 'm'], ['o', 'NAND', 'x', 'y']], [['out', 'o']]),
    c(['a', 'b'], [['o', 'OR', 'a', 'b'], ['n', 'NAND', 'a', 'b'], ['r', 'AND', 'o', 'n']], [['out', 'r']]),
    c(['a', 'b'], [['na', 'NOT', 'a'], ['nb', 'NOT', 'b'], ['x', 'AND', 'a', 'nb'], ['y', 'AND', 'b', 'na'], ['r', 'OR', 'x', 'y']], [['out', 'r']]),
  ],
  mux: [
    c(['sel', 'a', 'b'], [['ns', 'NOT', 'sel'], ['x', 'AND', 'a', 'ns'], ['y', 'AND', 'b', 'sel'], ['r', 'OR', 'x', 'y']], [['out', 'r']]),
    c(['sel', 'a', 'b'], [['ns', 'NAND', 'sel', 'sel'], ['x', 'NAND', 'a', 'ns'], ['y', 'NAND', 'b', 'sel'], ['r', 'NAND', 'x', 'y']], [['out', 'r']]),
    // A different idea: a xor (sel and (a xor b)).
    c(['sel', 'a', 'b'], [['d', 'XOR', 'a', 'b'], ['g', 'AND', 'sel', 'd'], ['r', 'XOR', 'a', 'g']], [['out', 'r']]),
  ],
  half: [
    c(['a', 'b'], [['s', 'XOR', 'a', 'b'], ['k', 'AND', 'a', 'b']], [['sum', 's'], ['carry', 'k']]),
    c(['a', 'b'], [['s', 'XOR', 'b', 'a'], ['n', 'NAND', 'a', 'b'], ['k', 'NOT', 'n']], [['sum', 's'], ['carry', 'k']]),
  ],
  full: [
    c(['a', 'b', 'cin'], [['h1', 'HALF', 'a', 'b'], ['h2', 'HALF', 'h1.sum', 'cin'], ['k', 'OR', 'h1.carry', 'h2.carry']], [['sum', 'h2.sum'], ['carry', 'k']]),
    c(['a', 'b', 'cin'], [['s1', 'XOR', 'a', 'b'], ['s2', 'XOR', 's1', 'cin'], ['x', 'AND', 'a', 'b'], ['y', 'AND', 's1', 'cin'], ['k', 'OR', 'x', 'y']], [['sum', 's2'], ['carry', 'k']]),
    // The nine-NAND form, using no parts at all but NAND.
    c(['a', 'b', 'cin'], [
      ['n1', 'NAND', 'a', 'b'], ['n2', 'NAND', 'a', 'n1'], ['n3', 'NAND', 'b', 'n1'], ['n4', 'NAND', 'n2', 'n3'],
      ['n5', 'NAND', 'n4', 'cin'], ['n6', 'NAND', 'n4', 'n5'], ['n7', 'NAND', 'cin', 'n5'], ['n8', 'NAND', 'n6', 'n7'], ['n9', 'NAND', 'n1', 'n5'],
    ], [['sum', 'n8'], ['carry', 'n9']]),
    // Majority for the carry.
    c(['a', 'b', 'cin'], [['s1', 'XOR', 'a', 'b'], ['s2', 'XOR', 's1', 'cin'], ['x', 'AND', 'a', 'b'], ['y', 'AND', 'a', 'cin'], ['z', 'AND', 'b', 'cin'], ['o1', 'OR', 'x', 'y'], ['k', 'OR', 'o1', 'z']], [['sum', 's2'], ['carry', 'k']]),
  ],
};

const FOUR = [...bitNames('a', 4), ...bitNames('b', 4)];
const add4 = (first: string[] = ['0']) => c(FOUR, [
  ['g1', 'FULL', 'a0', 'b0', first[0]], ['g2', 'FULL', 'a1', 'b1', 'g1.carry'], ['g3', 'FULL', 'a2', 'b2', 'g2.carry'], ['g4', 'FULL', 'a3', 'b3', 'g3.carry'],
], [['s0', 'g1.sum'], ['s1', 'g2.sum'], ['s2', 'g3.sum'], ['s3', 'g4.sum'], ['carry', 'g4.carry']]);
RIGHT.add4 = [
  add4(),
  // A half adder for the first column, and a and b swapped everywhere: addition doesn't care.
  c(FOUR, [['h', 'HALF', 'b0', 'a0'], ['g2', 'FULL', 'b1', 'a1', 'h.carry'], ['g3', 'FULL', 'b2', 'a2', 'g2.carry'], ['g4', 'FULL', 'b3', 'a3', 'g3.carry']], [['s0', 'h.sum'], ['s1', 'g2.sum'], ['s2', 'g3.sum'], ['s3', 'g4.sum'], ['carry', 'g4.carry']]),
];
const SUB = ['sub', ...FOUR];
const addsub = c(SUB, [
  ['x0', 'XOR', 'b0', 'sub'], ['x1', 'XOR', 'b1', 'sub'], ['x2', 'XOR', 'b2', 'sub'], ['x3', 'XOR', 'b3', 'sub'],
  ['f0', 'FULL', 'a0', 'x0', 'sub'], ['f1', 'FULL', 'a1', 'x1', 'f0.carry'], ['f2', 'FULL', 'a2', 'x2', 'f1.carry'], ['f3', 'FULL', 'a3', 'x3', 'f2.carry'],
], [['s0', 'f0.sum'], ['s1', 'f1.sum'], ['s2', 'f2.sum'], ['s3', 'f3.sum']]);
RIGHT.addsub = [
  addsub,
  // A mux picks between b and not b, in place of the XOR.
  c(SUB, [
    ['n0', 'NOT', 'b0'], ['n1', 'NOT', 'b1'], ['n2', 'NOT', 'b2'], ['n3', 'NOT', 'b3'], ['ns', 'NOT', 'sub'],
    ['p0', 'AND', 'b0', 'ns'], ['q0', 'AND', 'n0', 'sub'], ['x0', 'OR', 'p0', 'q0'], ['p1', 'AND', 'b1', 'ns'], ['q1', 'AND', 'n1', 'sub'], ['x1', 'OR', 'p1', 'q1'],
    ['p2', 'AND', 'b2', 'ns'], ['q2', 'AND', 'n2', 'sub'], ['x2', 'OR', 'p2', 'q2'], ['p3', 'AND', 'b3', 'ns'], ['q3', 'AND', 'n3', 'sub'], ['x3', 'OR', 'p3', 'q3'],
    ['f0', 'FULL', 'a0', 'x0', 'sub'], ['f1', 'FULL', 'a1', 'x1', 'f0.carry'], ['f2', 'FULL', 'a2', 'x2', 'f1.carry'], ['f3', 'FULL', 'a3', 'x3', 'f2.carry'],
  ], [['s0', 'f0.sum'], ['s1', 'f1.sum'], ['s2', 'f2.sum'], ['s3', 'f3.sum']]),
];

const WRONG: Record<string, Circuit[]> = {
  // The input wired straight through looks plausible and is the exact opposite.
  not: [c(['a'], [], [['out', 'a']]), c(['a'], [['g', 'NAND', 'a', '0']], [['out', 'g']]), c(['a'], [], [['out', '1']])],
  and: [c(['a', 'b'], [['n', 'NAND', 'a', 'b']], [['out', 'n']]), c(['a', 'b'], [], [['out', 'a']]), c(['a', 'b'], [['n', 'NOT', 'a']], [['out', 'n']])],
  // AND's table with one row flipped, which a spot check of 1,1 and 0,0 would miss.
  or: [c(['a', 'b'], [['n', 'AND', 'a', 'b']], [['out', 'n']]), c(['a', 'b'], [], [['out', 'b']]), c(['a', 'b'], [], [['out', '1']])],
  xor: [c(['a', 'b'], [['o', 'OR', 'a', 'b']], [['out', 'o']]), c(['a', 'b'], [['o', 'NAND', 'a', 'b']], [['out', 'o']])],
  mux: [c(['sel', 'a', 'b'], [['o', 'OR', 'a', 'b']], [['out', 'o']]), c(['sel', 'a', 'b'], [], [['out', 'a']]),
    // sel the wrong way round: right shape, opposite behaviour.
    c(['sel', 'a', 'b'], [['ns', 'NOT', 'sel'], ['x', 'AND', 'b', 'ns'], ['y', 'AND', 'a', 'sel'], ['r', 'OR', 'x', 'y']], [['out', 'r']])],
  half: [
    c(['a', 'b'], [['s', 'OR', 'a', 'b'], ['k', 'AND', 'a', 'b']], [['sum', 's'], ['carry', 'k']]),
    c(['a', 'b'], [['s', 'XOR', 'a', 'b']], [['sum', 's'], ['carry', '0']]),
    // sum and carry swapped.
    c(['a', 'b'], [['s', 'XOR', 'a', 'b'], ['k', 'AND', 'a', 'b']], [['sum', 'k'], ['carry', 's']]),
  ],
  // The carry-in ignored: right on every row where cin is 0, half the table.
  full: [
    c(['a', 'b', 'cin'], [['h', 'HALF', 'a', 'b']], [['sum', 'h.sum'], ['carry', 'h.carry']]),
    // AND where the OR belongs: the two half adders can never both carry, so this carry is always 0.
    c(['a', 'b', 'cin'], [['h1', 'HALF', 'a', 'b'], ['h2', 'HALF', 'h1.sum', 'cin'], ['k', 'AND', 'h1.carry', 'h2.carry']], [['sum', 'h2.sum'], ['carry', 'k']]),
  ],
  add4: [
    // No carries at all: the tempting four half-adders that each ignore the column before.
    c(FOUR, [['g1', 'HALF', 'a0', 'b0'], ['g2', 'HALF', 'a1', 'b1'], ['g3', 'HALF', 'a2', 'b2'], ['g4', 'HALF', 'a3', 'b3']], [['s0', 'g1.sum'], ['s1', 'g2.sum'], ['s2', 'g3.sum'], ['s3', 'g4.sum'], ['carry', 'g4.carry']]),
    // Carry-in stuck at 1: off by one on every sum.
    add4(['1']),
    // Top carry dropped: right on every sum that fits in four bits, which a small test would never notice.
    c(FOUR, [['g1', 'FULL', 'a0', 'b0', '0'], ['g2', 'FULL', 'a1', 'b1', 'g1.carry'], ['g3', 'FULL', 'a2', 'b2', 'g2.carry'], ['g4', 'FULL', 'a3', 'b3', 'g3.carry']], [['s0', 'g1.sum'], ['s1', 'g2.sum'], ['s2', 'g3.sum'], ['s3', 'g4.sum'], ['carry', '0']]),
    // The bits read the wrong way round.
    c(FOUR, [['g1', 'FULL', 'a3', 'b3', '0'], ['g2', 'FULL', 'a2', 'b2', 'g1.carry'], ['g3', 'FULL', 'a1', 'b1', 'g2.carry'], ['g4', 'FULL', 'a0', 'b0', 'g3.carry']], [['s0', 'g1.sum'], ['s1', 'g2.sum'], ['s2', 'g3.sum'], ['s3', 'g4.sum'], ['carry', 'g4.carry']]),
  ],
  addsub: [
    // Flips b and forgets the + 1: that's one's complement, and every subtraction is off by one.
    c(SUB, [
      ['x0', 'XOR', 'b0', 'sub'], ['x1', 'XOR', 'b1', 'sub'], ['x2', 'XOR', 'b2', 'sub'], ['x3', 'XOR', 'b3', 'sub'],
      ['f0', 'FULL', 'a0', 'x0', '0'], ['f1', 'FULL', 'a1', 'x1', 'f0.carry'], ['f2', 'FULL', 'a2', 'x2', 'f1.carry'], ['f3', 'FULL', 'a3', 'x3', 'f2.carry'],
    ], [['s0', 'f0.sum'], ['s1', 'f1.sum'], ['s2', 'f2.sum'], ['s3', 'f3.sum']]),
    // Adds 1 and doesn't flip.
    c(SUB, [['f0', 'FULL', 'a0', 'b0', 'sub'], ['f1', 'FULL', 'a1', 'b1', 'f0.carry'], ['f2', 'FULL', 'a2', 'b2', 'f1.carry'], ['f3', 'FULL', 'a3', 'b3', 'f2.carry']], [['s0', 'f0.sum'], ['s1', 'f1.sum'], ['s2', 'f2.sum'], ['s3', 'f3.sum']]),
    // Always subtracts.
    c(SUB, [
      ['x0', 'NOT', 'b0'], ['x1', 'NOT', 'b1'], ['x2', 'NOT', 'b2'], ['x3', 'NOT', 'b3'],
      ['f0', 'FULL', 'a0', 'x0', '1'], ['f1', 'FULL', 'a1', 'x1', 'f0.carry'], ['f2', 'FULL', 'a2', 'x2', 'f1.carry'], ['f3', 'FULL', 'a3', 'x3', 'f2.carry'],
    ], [['s0', 'f0.sum'], ['s1', 'f1.sum'], ['s2', 'f2.sum'], ['s3', 'f3.sum']]),
  ],
};

const ALL = [...GATE_PUZZLES, ...ADDER_PUZZLES];
for (const p of ALL) {
  if (p.id === 'nand') continue;
  test(`puzzle ${p.id}: every differently shaped right answer passes, on the parts offered`, () => {
    assert.ok(RIGHT[p.id].length >= 2, 'at least two shapes');
    for (const sol of RIGHT[p.id]) {
      for (const g of sol.gates) assert.ok(p.parts.includes(g.part), `${g.part} is on the ${p.id} shelf`);
      const v = judge(sol, p.spec);
      assert.equal(v.problem, undefined);
      assert.equal(v.ok, true, `${v.wrong} rows wrong:\n${JSON.stringify(sol)}`);
      assert.equal(v.total, 2 ** p.spec.inputs.length);
      assert.equal(v.rows.length, v.total, 'every row was really tried');
    }
  });

  test(`puzzle ${p.id}: the tempting wrong ones fail`, () => {
    assert.ok(WRONG[p.id].length >= 2);
    for (const bad of WRONG[p.id]) {
      const v = judge(bad, p.spec);
      assert.equal(v.ok, false, JSON.stringify(bad));
      assert.ok(v.wrong > 0, 'wrong because a row is wrong, not because it was refused');
    }
  });

  test(`puzzle ${p.id}: the starter does not already pass`, () => {
    assert.equal(judge(p.starter!, p.spec).ok, false);
  });
}

test('the top-carry-dropped adder is wrong on exactly the sums that do not fit: the row count shows why every row must run', () => {
  const v = judge(WRONG.add4[2], add4Spec);
  // How many of the 256 pairs add to 16 or more: 120, worked out by real Python below.
  const r = runPython('print(sum(1 for a in range(16) for b in range(16) if a + b >= 16))');
  assert.equal(v.wrong, Number(r.stdout.trim()));
  assert.equal(v.wrong, 120);
});

test('the add/subtract spec is real wrapped arithmetic, row by row, against real Python', () => {
  const r = runPython(`import ctypes, json
rows = []
for row in range(512):
    bits = [(row >> (8 - i)) & 1 for i in range(9)]
    sub = bits[0]
    a = sum(bits[1 + i] << i for i in range(4))
    b = sum(bits[5 + i] << i for i in range(4))
    rows.append(ctypes.c_uint8(a - b if sub else a + b).value & 15)
print(json.dumps(rows))`);
  assert.equal(r.status, 0, r.stderr);
  const want = JSON.parse(r.stdout) as number[];
  for (let row = 0; row < 512; row++) assert.equal(numberFrom(addSubSpec.fn(rowInputs(addSubSpec.inputs, row)), 's', 4), want[row], `row ${row}`);
  assert.equal(judge(addsub, addSubSpec).ok, true);
});

// ---- Missions start to finish ----------------------------------------------------------

function ticks(id: string, s: LogicState) {
  let ok = true;
  return LOGIC_MISSIONS[id].steps.map((st) => (ok = ok && st.done(s)));
}

test('the gates mission plays start to finish, ending with every step ticked at once', () => {
  const s = logicState();
  assert.deepEqual(ticks('comp-logic-gates', s), [false, false, false, false, false, false]);
  s.sawNandLow = true;
  for (const id of ['not', 'and', 'or', 'xor', 'mux']) {
    record(s, gp(id), WRONG[id][0]);
    assert.ok(!s.solved.has(id), `a wrong ${id} ticks nothing`);
    const v = record(s, gp(id), RIGHT[id][0]);
    assert.equal(v.ok, true);
  }
  assert.ok(ticks('comp-logic-gates', s).every(Boolean));
});

test('the adder mission plays start to finish, and going back to break a solved puzzle does not untick it', () => {
  const s = logicState();
  for (const id of ['half', 'full', 'add4']) record(s, ap(id), RIGHT[id][0]);
  assert.deepEqual(ticks('comp-logic-adder', s), [true, true, true, false, false]);
  s.watched.push({ puzzle: 'add4', steps: 9 });
  record(s, ap('addsub'), WRONG.addsub[0]);
  assert.deepEqual(ticks('comp-logic-adder', s), [true, true, true, true, false]);
  record(s, ap('addsub'), RIGHT.addsub[0]);
  assert.ok(ticks('comp-logic-adder', s).every(Boolean));
  record(s, ap('half'), WRONG.half[0]);
  assert.ok(ticks('comp-logic-adder', s).every(Boolean));
});

test('watching a settle on some other puzzle does not stand in for the 4-bit adder', () => {
  const s = logicState();
  for (const id of ['half', 'full', 'add4']) record(s, ap(id), RIGHT[id][0]);
  s.watched.push({ puzzle: 'half', steps: 9 });
  assert.equal(ticks('comp-logic-adder', s)[3], false);
});

test('every correct 4-bit adder the mission accepts takes at least the 2 gate delays its watch step needs, for the input the hint gives', () => {
  for (const sol of RIGHT.add4) {
    const f = flatten(sol);
    const before = settle(f, { ...bitsFrom(15, 'a', 4), ...bitsFrom(0, 'b', 4) });
    const after = settle(f, { ...bitsFrom(15, 'a', 4), ...bitsFrom(1, 'b', 4) }, { from: before.nets });
    assert.ok(after.steps >= 2, `${after.steps}`);
  }
});

test('the NAND fact the widget watches for: its output is 0 on exactly one row', () => {
  const v = judge(gp('nand').starter!, gp('nand').spec);
  assert.equal(v.ok, true);
  assert.deepEqual(v.rows.filter((r) => r.got.out === 0).map((r) => r.inputs), [{ a: 1, b: 1 } as Inputs]);
  const s = logicState();
  record(s, gp('nand'), gp('nand').starter!);
  assert.equal(s.solved.size, 0, 'running the demo solves nothing');
});

test('no starter uses a part its puzzle has not offered', () => {
  for (const p of ALL) for (const g of p.starter?.gates ?? []) assert.ok(p.parts.includes(g.part), `${p.id} starts with ${g.part}`);
});

test('a wide row reads as numbers, and a lone bit by its own name', () => {
  const x = { ...bitsFrom(3, 'a', 4), ...bitsFrom(5, 'b', 4), sub: 1 } as Inputs;
  assert.equal(describeBits(x, ['sub', ...bitNames('a', 4), ...bitNames('b', 4)]), 'sub = 1, a = 3, b = 5');
  assert.equal(describeBits({ ...bitsFrom(8, 's', 4), carry: 0 }, [...bitNames('s', 4), 'carry']), 's = 8, carry = 0');
});
