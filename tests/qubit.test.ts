// A statevector simulator has a known right answer to the last decimal, so nothing here is
// statistical except where sampling is the subject, and that's seeded. Random circuits are
// checked against an independent full-matrix simulator in real Python, sharing no code
// with the module. Fails rather than skips without Python.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE, MAX_QUBITS, QubitLab, Rng, State, classicalExpected, groverBestRounds, groverFormula, groverState, isBell, isEntangled, labNote, sawBellShots, sawFoundMarked, sawInterference, sawPhase, sawSuperposition, signHidden, stateBytes, type GateName, type LabEvent,
} from '../src/lib/cs/qubit.ts';
import { QUBIT_MISSION } from '../src/lib/cs/qubit-missions.ts';
import { python, runPython } from './helpers/python.ts';

python();

const EPS = 1e-12;
const close = (a: number, b: number, msg = '') => assert.ok(Math.abs(a - b) < EPS, `${msg}: ${a} vs ${b}`);
function amps(s: State, want: [number, number][]) {
  assert.equal(s.amps.length, want.length);
  want.forEach(([re, im], i) => { close(s.amps[i].re, re, `re[${i}]`); close(s.amps[i].im, im, `im[${i}]`); });
}
const r2 = Math.SQRT1_2;

test('Hadamard on |0> and |1>, to the last decimal', () => {
  amps(new State(1).apply('H', 0), [[r2, 0], [r2, 0]]);
  amps(new State(1).apply('X', 0).apply('H', 0), [[r2, 0], [-r2, 0]]);
});

test('interference: H twice is back where it started, because the paths to |1> cancel', () => {
  amps(new State(1).apply('H', 0).apply('H', 0), [[1, 0], [0, 0]]);
  amps(new State(1).apply('X', 0).apply('H', 0).apply('H', 0), [[0, 0], [1, 0]]);
});

test('a phase is invisible until an H: H Z has the same chances as H, and H Z H is certain |1>', () => {
  const h = new State(1).apply('H', 0), hz = new State(1).apply('H', 0).apply('Z', 0);
  assert.deepEqual(h.probabilities().map((p) => p.toFixed(12)), hz.probabilities().map((p) => p.toFixed(12)));
  amps(hz.apply('H', 0), [[0, 0], [1, 0]]);
});

test('the Bell states, all four, by the textbook circuit', () => {
  amps(new State(2).apply('H', 0).cnot(0, 1), [[r2, 0], [0, 0], [0, 0], [r2, 0]]);
  amps(new State(2).apply('X', 1).apply('H', 0).cnot(0, 1), [[0, 0], [r2, 0], [r2, 0], [0, 0]]);
  amps(new State(2).apply('X', 0).apply('H', 0).cnot(0, 1), [[r2, 0], [0, 0], [0, 0], [-r2, 0]]);
  amps(new State(2).apply('X', 0).apply('X', 1).apply('H', 0).cnot(0, 1), [[0, 0], [r2, 0], [-r2, 0], [0, 0]]);
});

test('measurement probabilities of a Bell state, the whole distribution rather than a sample', () => {
  const p = new State(2).apply('H', 0).cnot(0, 1).probabilities();
  [0.5, 0, 0, 0.5].forEach((want, i) => close(p[i], want, `P[${i}]`));
  close(new State(2).apply('H', 0).cnot(0, 1).marginal(0), 0.5);
  close(new State(2).apply('H', 0).cnot(0, 1).marginal(1), 0.5);
});

test('collapse: measuring one half of a Bell state fixes the other, in every seed', () => {
  for (let seed = 1; seed <= 500; seed++) {
    const s = new State(2).apply('H', 0).cnot(0, 1), rng = new Rng(seed);
    const a = s.measure(0, rng);
    close(s.norm(), 1, 'still normalised');
    close(s.marginal(1), a, 'other qubit is now certain');
    assert.equal(s.measure(1, rng), a);
  }
});

test('no cloning, the concrete failure: CNOT copies 0 and 1, and does not copy a superposition', () => {
  amps(new State(2).cnot(0, 1), [[1, 0], [0, 0], [0, 0], [0, 0]]);
  amps(new State(2).apply('X', 0).cnot(0, 1), [[0, 0], [0, 0], [0, 0], [1, 0]]);
  const attempted = new State(2).apply('H', 0).cnot(0, 1);
  const trueCopy = new State(2).apply('H', 0).apply('H', 1);
  // Two real copies would give all four outcomes equally. This gives two of them.
  amps(trueCopy, [[0.5, 0], [0.5, 0], [0.5, 0], [0.5, 0]]);
  assert.notDeepEqual(attempted.probabilities().map((p) => p.toFixed(6)), trueCopy.probabilities().map((p) => p.toFixed(6)));
});

test('complex gates, kept out of the lab and tested anyway: S, T, Y', () => {
  amps(new State(1).apply('H', 0).apply('S', 0), [[r2, 0], [0, r2]]);
  amps(new State(1).apply('H', 0).apply('T', 0), [[r2, 0], [0.5, 0.5]]);
  amps(new State(1).apply('Y', 0), [[0, 0], [0, 1]]);
  amps(new State(1).apply('X', 0).apply('Y', 0), [[0, -1], [0, 0]]);
  // T twice is S, S twice is Z: the identities every textbook gives.
  const tt = new State(1).apply('H', 0).apply('T', 0).apply('T', 0), s = new State(1).apply('H', 0).apply('S', 0);
  close(tt.amps[1].re, s.amps[1].re); close(tt.amps[1].im, s.amps[1].im);
});

test('every gate is unitary: chances add to 1 after any circuit, and every gate undoes', () => {
  for (const g of Object.keys(GATE) as GateName[]) {
    const m = GATE[g];
    const row = (i: number, j: number) => {
      const a = [m[i * 2], m[i * 2 + 1]], b = [m[j * 2], m[j * 2 + 1]];
      return a.reduce((acc, x, k) => ({ re: acc.re + x.re * b[k].re + x.im * b[k].im, im: acc.im + x.im * b[k].re - x.re * b[k].im }), { re: 0, im: 0 });
    };
    close(row(0, 0).re, 1, g); close(row(1, 1).re, 1, g); close(row(0, 1).re, 0, g); close(row(0, 1).im, 0, g);
  }
});

test('refuses what it can\'t do, by name', () => {
  assert.throws(() => new State(MAX_QUBITS + 1), /stops at 12 qubits/);
  assert.throws(() => new State(0), /at least one/);
  assert.throws(() => new State(1).apply('H', 1), /no qubit 1/);
  assert.throws(() => new State(2).cnot(0, 0), /different/);
  assert.throws(() => new State(2).cz(1, 1), /different/);
  assert.throws(() => new State(2).flip(4), /no such/);
  assert.throws(() => new State(1).apply('H', 0.5), /no qubit/);
});

/** The same circuits by full 2^n matrices in Python's complex numbers. Shares no code with the module. */
const PY_MATRIX = `
import json, sys, cmath
R = 2 ** -0.5
G = {"H": [[R, R], [R, -R]], "X": [[0, 1], [1, 0]], "Y": [[0, -1j], [1j, 0]], "Z": [[1, 0], [0, -1]], "S": [[1, 0], [0, 1j]], "T": [[1, 0], [0, cmath.exp(1j * cmath.pi / 4)]]}
I = [[1, 0], [0, 1]]
def kron(a, b):
    return [[x * y for x in ra for y in rb] for ra in a for rb in b]
def single(g, q, n):
    m = [[1]]
    for i in range(n):
        m = kron(m, G[g] if i == q else I)
    return m
def apply(m, v):
    return [sum(m[i][j] * v[j] for j in range(len(v))) for i in range(len(v))]
def cnot(c, t, n):
    size = 2 ** n
    m = [[0] * size for _ in range(size)]
    for i in range(size):
        j = i ^ (1 << (n - 1 - t)) if i & (1 << (n - 1 - c)) else i
        m[j][i] = 1
    return m
def cz(a, b, n):
    size = 2 ** n
    m = [[0] * size for _ in range(size)]
    for i in range(size):
        m[i][i] = -1 if (i & (1 << (n - 1 - a))) and (i & (1 << (n - 1 - b))) else 1
    return m
out = []
for n, ops in json.loads(sys.stdin_data):
    v = [0] * (2 ** n)
    v[0] = 1
    for op in ops:
        if op[0] == "cnot":
            v = apply(cnot(op[1], op[2], n), v)
        elif op[0] == "cz":
            v = apply(cz(op[1], op[2], n), v)
        else:
            v = apply(single(op[0], op[1], n), v)
    out.append([[complex(x).real, complex(x).imag] for x in v])
print(json.dumps(out))
`;

test('differential: 300 random circuits match an independent full-matrix simulator in real Python', () => {
  let x = 20261101;
  const rand = (n: number) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % n; };
  const gates: GateName[] = ['H', 'X', 'Y', 'Z', 'S', 'T'];
  const circuits: [number, (string | number)[][]][] = [];
  for (let i = 0; i < 300; i++) {
    const n = 1 + rand(4), ops: (string | number)[][] = [];
    for (let k = 0, len = 1 + rand(25); k < len; k++) {
      const pick = rand(10);
      if (n >= 2 && pick === 0) { const a = rand(n); ops.push(['cnot', a, (a + 1 + rand(n - 1)) % n]); }
      else if (n >= 2 && pick === 1) { const a = rand(n); ops.push(['cz', a, (a + 1 + rand(n - 1)) % n]); }
      else ops.push([gates[rand(gates.length)], rand(n)]);
    }
    circuits.push([n, ops]);
  }
  const payload = Buffer.from(JSON.stringify(circuits)).toString('base64');
  const r = runPython(`import base64, sys\nsys.stdin_data = base64.b64decode("${payload}").decode()\n${PY_MATRIX}`);
  assert.equal(r.status, 0, r.stderr);
  const real: [number, number][][] = JSON.parse(r.stdout);
  circuits.forEach(([n, ops], i) => {
    const s = new State(n);
    for (const op of ops) {
      if (op[0] === 'cnot') s.cnot(op[1] as number, op[2] as number);
      else if (op[0] === 'cz') s.cz(op[1] as number, op[2] as number);
      else s.apply(op[0] as GateName, op[1] as number);
    }
    s.amps.forEach((a, j) => {
      assert.ok(Math.abs(a.re - real[i][j][0]) < 1e-10 && Math.abs(a.im - real[i][j][1]) < 1e-10, `circuit ${i}, amp ${j}: ${a.re}+${a.im}i vs ${real[i][j]}`);
    });
    close(s.norm(), 1, `circuit ${i} norm`);
  });
});

test('sampling is seeded: the same seed gives the same shots, and the counts sit where they should', () => {
  const bell = () => new State(2).apply('H', 0).cnot(0, 1);
  assert.deepEqual(bell().shots(new Rng(7), 200), bell().shots(new Rng(7), 200));
  const counts = bell().shots(new Rng(7), 10_000);
  assert.equal(counts[1] + counts[2], 0, 'an impossible outcome never comes up');
  assert.equal(counts[0] + counts[3], 10_000);
  // Roughly half, with a seeded generator: this pins the seed's result, not luck.
  assert.ok(Math.abs(counts[0] - 5000) < 200, `${counts[0]}`);
});

test('Grover: the simulated search matches its formula, at every size and round', () => {
  for (const n of [2, 3, 4, 6, 8, 10]) {
    const N = 2 ** n, marked = N - 3;
    for (let k = 0; k <= 2 * groverBestRounds(N) + 2; k++) {
      close(groverState(n, marked, k).probabilities()[marked], groverFormula(N, k), `N=${N} k=${k}`);
    }
  }
});

test('Grover: one round finds 1 in 4 with certainty, and too many rounds lose it again', () => {
  close(groverFormula(4, 1), 1);
  close(groverState(2, 2, 1).probabilities()[2], 1);
  assert.equal(groverBestRounds(4), 1);
  // Grover's overshoot, which "more quantum is better" gets wrong.
  assert.ok(groverFormula(4, 2) < 0.3);
  const N = 1024, best = groverBestRounds(N);
  assert.equal(best, 25);
  assert.ok(groverFormula(N, best) > 0.999);
  assert.ok(groverFormula(N, best * 2) < 0.01);
});

test('Grover: √N, measured from the search itself across sizes: 100 times the items takes about 10 times the rounds', () => {
  const rows = [2 ** 8, 2 ** 12, 2 ** 16, 2 ** 20].map((N) => groverBestRounds(N));
  assert.deepEqual(rows, [12, 50, 201, 804]);
  // The classical figure: expected looks, with the last one unnecessary.
  close(classicalExpected(4), 2.25);
  close(classicalExpected(1024), 512.5 - 1 / 1024);
});

test('stateBytes: the doubling the lesson quotes', () => {
  assert.equal(stateBytes(2), 64);
  assert.equal(stateBytes(30), 16 * 2 ** 30);
  assert.equal(stateBytes(53), 16 * 2 ** 53);
});

// ---- The mission

test('mission: played start to finish, with real gates, in order, ticks never lost', () => {
  const s = QUBIT_MISSION.setup();
  const lab = s.lab;
  const ticks = () => { let n = 0; for (const st of QUBIT_MISSION.steps) { if (!st.done(s)) break; n++; } return n; };
  const seen: number[] = [];
  lab.gate('H', 0); seen.push(ticks());
  lab.gate('H', 0); seen.push(ticks());
  lab.reset();
  lab.gate('H', 0); lab.gate('Z', 0); lab.gate('H', 0); seen.push(ticks());
  lab.reset();
  lab.gate('H', 0); lab.cnot(0, 1); lab.shoot(100, 3); seen.push(ticks());
  lab.reset();
  lab.gate('H', 0); lab.gate('H', 1); lab.oracle(); lab.diffusion(); seen.push(ticks());
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
  assert.ok(QUBIT_MISSION.steps.every((st) => st.done(s)));
});

test('mission: the search step finds any marked item, since it never knows which', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const l = new QubitLab(seed);
    l.gate('H', 0); l.gate('H', 1); l.oracle(); l.diffusion();
    assert.equal(sawFoundMarked(l), true, `seed ${seed}`);
    const p = l.state.probabilities();
    assert.equal(p.filter((x) => x > 0.999).length, 1);
  }
});

test('mission: tempting shortcuts do not pass', () => {
  // X X reaches a basis state with no search at all.
  const a = new QubitLab(5);
  a.gate('X', 0); a.gate('X', 1);
  assert.equal(sawFoundMarked(a), false);
  // Calling the oracle on |00> changes only a sign, and then guessing with X.
  for (let seed = 1; seed <= 12; seed++) {
    const b = new QubitLab(seed);
    b.oracle();
    b.gate('X', 0);
    b.gate('X', 1);
    assert.equal(sawFoundMarked(b), false, `seed ${seed}`);
  }
  // Two oracle calls isn't one, even if it lands.
  const c = new QubitLab(6);
  c.gate('H', 0); c.gate('H', 1); c.oracle(); c.oracle(); c.diffusion();
  assert.equal(sawFoundMarked(c), false);
  // Measuring collapses the state to a certainty, and that's a one-in-four guess, not a search.
  for (let seed = 1; seed <= 12; seed++) {
    const m = new QubitLab(seed);
    m.gate('H', 0); m.gate('H', 1); m.oracle(); m.measureQubit(0); m.measureQubit(1); m.gate('Z', 0);
    assert.equal(sawFoundMarked(m), false, `seed ${seed}`);
  }
  // Interference needs a superposition that became a certainty, not X twice.
  const d = new QubitLab(1);
  d.gate('X', 0); d.gate('X', 0);
  assert.equal(sawInterference(d), false);
  // H then H on different qubits isn't cancelling anything.
  const e = new QubitLab(1);
  e.gate('H', 0); e.gate('H', 1);
  assert.equal(sawInterference(e), false);
  // Z on a basis state is a sign with nothing to interfere with.
  const f = new QubitLab(1);
  f.gate('Z', 0); f.gate('H', 0); f.gate('H', 0);
  assert.equal(sawPhase(f), false);
  // A 50/50 state that isn't entangled isn't a Bell state, however many shots.
  const g = new QubitLab(1);
  g.gate('H', 0); g.shoot(100, 1);
  assert.equal(sawBellShots(g), false);
  // A Bell state read with too few shots to see anything.
  const h = new QubitLab(1);
  h.gate('H', 0); h.cnot(0, 1); h.shoot(5, 1);
  assert.equal(sawBellShots(h), false);
});

test('mission: differently shaped right answers pass', () => {
  // H on the other qubit is just as much a superposition.
  const a = new QubitLab(1);
  a.gate('H', 1);
  assert.equal(sawSuperposition(a), true);
  // Interference on qubit 1, and starting from |1>.
  const b = new QubitLab(1);
  b.gate('X', 1); b.gate('H', 1); b.gate('H', 1);
  assert.equal(sawInterference(b), true);
  // CNOT the other way round, and the anti-correlated Bell state, both entangle.
  const c = new QubitLab(1);
  c.gate('H', 1); c.cnot(1, 0);
  assert.equal(isBell(c.state), true);
  c.shoot(50, 2);
  assert.equal(sawBellShots(c), true);
  const d = new QubitLab(1);
  d.gate('X', 1); d.gate('H', 0); d.cnot(0, 1); d.shoot(50, 2);
  assert.equal(sawBellShots(d), true);
  // The diffusion step spelled out with the lab's own gates finds it too.
  const e = new QubitLab(9);
  e.gate('H', 0); e.gate('H', 1); e.oracle();
  e.gate('H', 0); e.gate('H', 1); e.gate('X', 0); e.gate('X', 1); e.cz(); e.gate('X', 0); e.gate('X', 1); e.gate('H', 0); e.gate('H', 1);
  assert.equal(sawFoundMarked(e), true);
  // The phase route on the other qubit.
  const f = new QubitLab(1);
  f.gate('H', 1); f.gate('Z', 1); f.gate('H', 1);
  assert.equal(sawPhase(f), true);
});

test('a lab measurement collapses the state and the lab reports what it read', () => {
  const l = new QubitLab(4);
  l.gate('H', 0); l.cnot(0, 1);
  const read = l.measureQubit(0);
  close(l.state.marginal(0), read);
  close(l.state.marginal(1), read);
  assert.equal(l.measures.length, 1);
});

test('shots after a measurement are fresh runs: H then Measure is 50/50, whichever way the one measurement went', () => {
  // The shots message said "each shot is a fresh run of the same circuit" and showed 100% one
  // outcome, because it sampled the collapsed state. And the circuit line never recorded the
  // measurement, so it showed a circuit that visibly doesn't give those counts.
  const reads = new Set<number>();
  for (let seed = 1; seed <= 40; seed++) {
    const l = new QubitLab(seed);
    l.gate('H', 0);
    const read = l.measureQubit(0);
    reads.add(read);
    assert.deepEqual(l.events.at(-1), { k: 'measure', q: 0, read });
    // The table shows the one run that was measured.
    close(l.state.probabilities()[read === 0 ? 0 : 2], 1);
    const counts = l.shoot(1000, seed + 100);
    assert.ok(Math.abs(counts[0] - 500) < 80, `seed ${seed}: ${counts}`);
    assert.ok(Math.abs(counts[2] - 500) < 80, `seed ${seed}: ${counts}`);
    assert.equal(counts[1] + counts[3], 0);
    assert.equal(l.shotsTaken.at(-1)!.replayed, true);
  }
  assert.equal(reads.size, 2, 'both reads came up, so neither branch went unchecked');
  // A reset forgets it, and a plain circuit is sampled as before.
  const l = new QubitLab(1);
  l.gate('H', 0); l.measureQubit(0); l.reset();
  assert.equal(l.measured, false);
  l.gate('H', 0);
  assert.deepEqual(l.shoot(200, 7), new State(2).apply('H', 0).shots(new Rng(7), 200));
  assert.equal(l.shotsTaken.at(-1)!.replayed, false);
  // The same seed still gives the same counts, measurement or not.
  const m = new QubitLab(2);
  m.gate('H', 0); m.measureQubit(0);
  assert.deepEqual(m.shoot(300, 9), m.shoot(300, 9));
});

/** The exact chance of each final outcome, by walking both branches of every measurement. Shares no sampling with the lab. */
function exactWithMeasurements(events: LabEvent[], marked: number): number[] {
  const out = [0, 0, 0, 0];
  const go = (s: State, i: number, weight: number) => {
    if (weight < 1e-15) return;
    if (i === events.length) { s.probabilities().forEach((p, j) => { out[j] += weight * p; }); return; }
    const e = events[i], next = s.clone();
    if (e.k === 'gate') next.apply(e.gate, e.q);
    else if (e.k === 'cnot') next.cnot(e.control, e.target);
    else if (e.k === 'cz') next.cz(0, 1);
    else if (e.k === 'oracle') next.flip(marked);
    else if (e.k === 'diffusion') next.diffuse();
    else {
      const bit = e.q === 0 ? 2 : 1, p1 = s.marginal(e.q);
      for (const one of [false, true]) {
        const p = one ? p1 : 1 - p1;
        if (p < 1e-15) continue;
        const b = s.clone();
        b.amps = b.amps.map((a, k) => (((k & bit) !== 0) === one ? { re: a.re / Math.sqrt(p), im: a.im / Math.sqrt(p) } : { re: 0, im: 0 }));
        go(b, i + 1, weight * p);
      }
      return;
    }
    go(next, i + 1, weight);
  };
  go(new State(2), 0, 1);
  return out;
}

test('differential: fresh runs of 200 circuits with measurements in them land on the exact mixture', () => {
  let x = 77;
  const rand = (n: number) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % n; };
  let measured = 0;
  for (let i = 0; i < 200; i++) {
    const l = new QubitLab(i + 1);
    for (let k = 0, len = 2 + rand(8); k < len; k++) {
      const pick = rand(10), q = rand(2);
      if (pick < 3) l.gate('H', q);
      else if (pick === 3) l.gate('X', q);
      else if (pick === 4) l.gate('Z', q);
      else if (pick === 5) l.cnot(q, 1 - q);
      else if (pick === 6) l.cz();
      else if (pick === 7) l.oracle();
      else if (pick === 8) l.diffusion();
      else l.measureQubit(q);
    }
    if (!l.measured) l.measureQubit(rand(2));
    measured++;
    const marked = [0, 1, 2, 3].find((j) => l.isMarked(j))!;
    const want = exactWithMeasurements(l.events, marked);
    close(want.reduce((a, b) => a + b, 0), 1, 'the branches add up');
    const shots = 2000, got = l.shoot(shots, i + 1);
    got.forEach((n, j) => {
      // Five standard deviations, on a seeded generator: this pins the result, not luck.
      const sd = Math.sqrt(Math.max(0, shots * want[j] * (1 - want[j])));
      assert.ok(Math.abs(n - shots * want[j]) <= 5 * sd + 1, `circuit ${i}, outcome ${j}: ${n} of ${shots}, exact ${want[j]}`);
      if (want[j] < 1e-12) assert.equal(n, 0, 'an impossible outcome never comes up');
    });
  }
  assert.equal(measured, 200);
});

test('a measurement sticks until a gate changes it, and a later gate can make new outcomes', () => {
  // "they don't come back" was false of H, Measure, H.
  for (let seed = 1; seed <= 20; seed++) {
    const l = new QubitLab(seed);
    l.gate('H', 0);
    const read = l.measureQubit(0);
    for (let k = 0; k < 5; k++) assert.equal(l.measureQubit(0), read);
    l.gate('H', 0);
    assert.equal(l.state.probabilities().filter((p) => p > 0.4).length, 2);
  }
});

test('entanglement: the note tests amplitudes, so H, H, CZ is called what it is', () => {
  // All four chances are 25% there, and going by chances alone the note said "4 outcomes possible".
  const hhcz = new State(2).apply('H', 0).apply('H', 1).cz(0, 1);
  assert.equal(isEntangled(hhcz), true);
  assert.equal(isBell(hhcz), false);
  assert.equal(isEntangled(new State(2).apply('H', 0).cnot(0, 1)), true);
  // Every product of two one-qubit states, including signs: never entangled.
  for (const a of ['', 'H', 'XH', 'HZ']) for (const b of ['', 'H', 'XH', 'HZ']) {
    const s = new State(2);
    for (const g of a) s.apply(g as GateName, 0);
    for (const g of b) s.apply(g as GateName, 1);
    assert.equal(isEntangled(s), false, `${a} on 0, ${b} on 1`);
  }
  const l = new QubitLab(1);
  l.gate('H', 0); l.gate('H', 1); l.cz();
  assert.match(labNote(l), /^Entangled: these amplitudes/);
  const product = new QubitLab(1);
  product.gate('H', 0); product.gate('H', 1);
  assert.match(labNote(product), /4 outcomes possible/);
  const bell = new QubitLab(1);
  bell.gate('H', 0); bell.cnot(0, 1);
  assert.match(labNote(bell), /always match or always differ/);
  assert.match(labNote(new QubitLab(1)), /^Certain/);
});

test('the oracle\'s sign stays hidden until the next gate: the table gave the answer away before Diffusion', () => {
  // H, H, Oracle showed one red bar and a -0.5, so the "secret" could be read off before the
  // step that's supposed to find it, which is the "tries everything" error the lesson fights.
  for (let seed = 1; seed <= 12; seed++) {
    const l = new QubitLab(seed);
    l.gate('H', 0); l.gate('H', 1);
    assert.equal(signHidden(l), false);
    const before = l.state.probabilities();
    l.oracle();
    assert.equal(signHidden(l), true);
    // What a measurement could see didn't change, which is what the note claims.
    l.state.probabilities().forEach((p, i) => close(p, before[i], 'same chance'));
    assert.match(labNote(l), /hiding which/);
    assert.match(labNote(l), /Diffusion is what makes/);
    l.diffusion();
    assert.equal(signHidden(l), false);
    assert.match(labNote(l), /^Certain/);
  }
  // A sign the learner made themselves isn't the oracle's secret, and stays visible.
  const z = new QubitLab(1);
  z.gate('H', 0); z.gate('Z', 0);
  assert.equal(signHidden(z), false);
});

test('"at least 20 shots" counts 10 and 10, since the menu offers 10, and a stray pair doesn\'t count', () => {
  const a = new QubitLab(1);
  a.gate('H', 0); a.cnot(0, 1); a.shoot(10, 1);
  assert.equal(sawBellShots(a), false);
  a.shoot(10, 2);
  assert.equal(sawBellShots(a), true);
  // Ten at each of two different pairs of outcomes isn't twenty at either.
  const b = new QubitLab(1);
  b.gate('H', 0); b.cnot(0, 1); b.shoot(10, 1);
  b.reset();
  b.gate('X', 1); b.gate('H', 0); b.cnot(0, 1); b.shoot(10, 1);
  assert.equal(sawBellShots(b), false);
  // Shots taken after collapsing it are of a collapsed state, however many.
  const c = new QubitLab(1);
  c.gate('H', 0); c.cnot(0, 1); c.measureQubit(0); c.shoot(1000, 1);
  assert.equal(sawBellShots(c), false);
});
