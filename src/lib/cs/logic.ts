// A logic simulator with one primitive, NAND. Everything else is a part built from
// parts, flattened down to NANDs before it runs, so nothing can do more than real
// NANDs wired that way could. The lessons computer/gates and computer/adder use it
// through LogicLab.astro. Later lessons (flip-flops, registers, a CPU) can reuse this
// file as it stands: it has no DOM and knows nothing about any lesson.
//
// HOW TO USE IT
//
//   const c: Circuit = {
//     inputs: ['a', 'b'],
//     gates: [{ id: 'g1', part: 'NAND', in: ['a', 'b'] }, { id: 'g2', part: 'NOT', in: ['g1'] }],
//     outputs: [{ name: 'out', from: 'g2' }],
//   };
//   const errors = validate(c);              // [] when every wire goes somewhere real
//   const flat = flatten(c);                 // a list of NANDs
//   evaluate(flat, { a: 1, b: 1 });          // { out: 1 }, or null if it never settles
//   judge(c, spec);                          // every row of the truth table against a spec
//
// A Source says where a wire gets its value: an input's name, the constants '0' or
// '1', a gate's id (for a part with one output), or 'id.output' (for a part with
// several, such as 'fa.carry').
//
// TIME, AND FEEDBACK
//
// settle() is the honest model. Every NAND takes one "gate delay" to react, and all of
// them react at once, so a change moves through a circuit one layer per step. That's
// what makes a long carry chain slow. changeDepth() is the limit on how long a change of
// inputs can take. depth() is the longer, purely structural count, and no change need
// ever take that long: don't report it as a settling time.
//
// A wire may loop back, which is what memory is. flatten() and settle() accept loops;
// judge() and truthTable() refuse them, because a looped circuit has no single truth
// table: its output can depend on what it held before. To simulate one, keep the
// nets settle() returns and pass them back as `from` on the next call.
//
// Trap for whoever builds a latch here: with order 'together' a cross-coupled NAND
// latch whose inputs both rise in the same step can oscillate forever, because the two
// gates are perfectly matched in this model and in no real circuit. Real gates differ,
// and one wins. Use order 'inOrder' (one gate at a time, so one always goes first) to
// model that, and treat stable: false under 'together' as "this input change is a
// race", not as a bug in the latch. tests/logic.test.ts pins both behaviours.

export type Bit = 0 | 1;
export type Source = string;
export const NAND = 'NAND';

export type GateInst = { id: string; part: string; in: Source[] };
export type Circuit = { inputs: string[]; gates: GateInst[]; outputs: { name: string; from: Source }[] };
export type Part = Circuit;
export type Library = Record<string, Part>;

const part = (inputs: string[], gates: GateInst[], outputs: Record<string, Source>): Part => ({
  inputs, gates, outputs: Object.entries(outputs).map(([name, from]) => ({ name, from })),
});

/**
 * The sealed parts. Each is one way to build its truth table, not the only way: a
 * learner's own version counts if it behaves the same on every input, which judge()
 * checks. XOR is the four-NAND form, and the test proves no three NANDs can do it.
 */
export const LIBRARY: Library = {
  NOT: part(['a'], [{ id: 'n', part: NAND, in: ['a', 'a'] }], { out: 'n' }),
  AND: part(['a', 'b'], [{ id: 'n', part: NAND, in: ['a', 'b'] }, { id: 'o', part: NAND, in: ['n', 'n'] }], { out: 'o' }),
  OR: part(['a', 'b'], [{ id: 'x', part: NAND, in: ['a', 'a'] }, { id: 'y', part: NAND, in: ['b', 'b'] }, { id: 'o', part: NAND, in: ['x', 'y'] }], { out: 'o' }),
  XOR: part(['a', 'b'], [
    { id: 'm', part: NAND, in: ['a', 'b'] },
    { id: 'x', part: NAND, in: ['a', 'm'] },
    { id: 'y', part: NAND, in: ['b', 'm'] },
    { id: 'o', part: NAND, in: ['x', 'y'] },
  ], { out: 'o' }),
  /** Passes a through when sel is 0, and b when sel is 1. */
  MUX: part(['sel', 'a', 'b'], [
    { id: 'ns', part: NAND, in: ['sel', 'sel'] },
    { id: 'x', part: NAND, in: ['a', 'ns'] },
    { id: 'y', part: NAND, in: ['b', 'sel'] },
    { id: 'o', part: NAND, in: ['x', 'y'] },
  ], { out: 'o' }),
  HALF: part(['a', 'b'], [{ id: 's', part: 'XOR', in: ['a', 'b'] }, { id: 'c', part: 'AND', in: ['a', 'b'] }], { sum: 's', carry: 'c' }),
  FULL: part(['a', 'b', 'cin'], [
    { id: 'h1', part: 'HALF', in: ['a', 'b'] },
    { id: 'h2', part: 'HALF', in: ['h1.sum', 'cin'] },
    { id: 'c', part: 'OR', in: ['h1.carry', 'h2.carry'] },
  ], { sum: 'h2.sum', carry: 'c' }),
};

/** Inputs and outputs of a part, by name. NAND is the one part with no insides. */
export function pinsOf(name: string, lib: Library = LIBRARY): { inputs: string[]; outputs: string[] } | null {
  if (name === NAND) return { inputs: ['a', 'b'], outputs: ['out'] };
  const p = lib[name];
  return p ? { inputs: p.inputs, outputs: p.outputs.map((o) => o.name) } : null;
}

const isConst = (s: Source) => s === '0' || s === '1';

/** Every Source a gate's input or an output could legally name in this circuit. */
export function sourcesOf(c: Circuit, lib: Library = LIBRARY): Source[] {
  const out: Source[] = [...c.inputs];
  for (const g of c.gates) {
    const pins = pinsOf(g.part, lib);
    if (!pins) continue;
    if (pins.outputs.length === 1) out.push(g.id);
    else for (const o of pins.outputs) out.push(`${g.id}.${o}`);
  }
  return [...out, '0', '1'];
}

/**
 * What's wrong with a circuit, in words a learner can act on. An unconnected input
 * is refused rather than read as 0: a real floating wire doesn't hold a steady value, so
 * a circuit that only works if it did must not pass.
 */
export function validate(c: Circuit, lib: Library = LIBRARY): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const g of c.gates) {
    if (ids.has(g.id)) errors.push(`Two parts are both called ${g.id}.`);
    ids.add(g.id);
    if (c.inputs.includes(g.id)) errors.push(`A part and an input are both called ${g.id}.`);
  }
  const legal = new Set(sourcesOf(c, lib));
  const check = (s: Source, where: string) => {
    if (!s) errors.push(`${where} isn't connected to anything.`);
    else if (!legal.has(s)) errors.push(`${where} is connected to ${s}, which isn't in this circuit.`);
  };
  for (const g of c.gates) {
    const pins = pinsOf(g.part, lib);
    if (!pins) { errors.push(`${g.id} is a ${g.part}, and there's no such part.`); continue; }
    if (g.in.length !== pins.inputs.length) { errors.push(`${g.id} needs ${pins.inputs.length} inputs and has ${g.in.length}.`); continue; }
    g.in.forEach((s, i) => check(s, `Input ${pins.inputs[i]} of ${g.id}`));
  }
  for (const o of c.outputs) check(o.from, `Output ${o.name}`);
  return errors;
}

// ---- Flattening ------------------------------------------------------------------

export type Flat = {
  inputs: string[];
  /** One entry per NAND: the net it drives and the two nets it reads. */
  nands: { out: number; a: number; b: number }[];
  /** Number of nets. Net 0 is always 0, net 1 is always 1, then one per input. */
  size: number;
  outputs: Record<string, number>;
  /** The net behind each top-level Source, for showing a wire's value on screen. */
  tap: Record<Source, number>;
};

export function flatten(c: Circuit, lib: Library = LIBRARY): Flat {
  const errors = validate(c, lib);
  if (errors.length) throw new Error(`flatten: ${errors.join(' ')}`);
  let size = 2 + c.inputs.length;
  const alias = new Map<number, number>();
  const nands: Flat['nands'] = [];
  const net = () => size++;
  let top = new Map<string, number>();

  // Each gate's output nets exist before anything reads them, or a wire that loops
  // back to a later gate would have nothing to point at.
  function expand(cir: Circuit, ins: Record<string, number>, path: string[]): Record<string, number> {
    const nets = new Map<string, number>();
    for (const g of cir.gates) {
      if (g.part === NAND) nets.set(g.id, net());
      else for (const o of pinsOf(g.part, lib)!.outputs) nets.set(`${g.id}.${o}`, net());
    }
    if (path.length === 0) top = nets;
    const resolve = (s: Source): number => {
      if (s === '0') return 0;
      if (s === '1') return 1;
      if (s in ins) return ins[s];
      const direct = nets.get(s);
      if (direct !== undefined) return direct;
      const only = pinsOf(cir.gates.find((x) => x.id === s)?.part ?? '', lib)?.outputs;
      if (only?.length === 1) return nets.get(`${s}.${only[0]}`)!;
      throw new Error(`flatten: no net for ${s}`);
    };
    for (const g of cir.gates) {
      const read = g.in.map(resolve);
      if (g.part === NAND) { nands.push({ out: nets.get(g.id)!, a: read[0], b: read[1] }); continue; }
      if (path.includes(g.part)) throw new Error(`flatten: ${g.part} contains itself`);
      const inner = lib[g.part];
      const given = Object.fromEntries(inner.inputs.map((n, i) => [n, read[i]]));
      const outs = expand(inner, given, [...path, g.part]);
      for (const [o, n] of Object.entries(outs)) alias.set(nets.get(`${g.id}.${o}`)!, n);
    }
    return Object.fromEntries(cir.outputs.map((o) => [o.name, resolve(o.from)]));
  }

  const inputNets = Object.fromEntries(c.inputs.map((n, i) => [n, 2 + i]));
  const outs = expand(c, inputNets, []);

  const final = (n: number) => {
    const seen = new Set<number>();
    while (alias.has(n)) {
      if (seen.has(n)) throw new Error('flatten: a wire loop with no gate in it');
      seen.add(n);
      n = alias.get(n)!;
    }
    return n;
  };
  for (const g of nands) { g.out = final(g.out); g.a = final(g.a); g.b = final(g.b); }

  const tap: Record<Source, number> = { 0: 0, 1: 1, ...inputNets };
  for (const [name, n] of top) tap[name] = final(n);
  for (const g of c.gates) {
    const names = pinsOf(g.part, lib)!.outputs;
    if (g.part !== NAND && names.length === 1) tap[g.id] = tap[`${g.id}.${names[0]}`];
  }
  return { inputs: c.inputs, nands, size, outputs: Object.fromEntries(Object.entries(outs).map(([k, v]) => [k, final(v)])), tap };
}

// ---- Time -------------------------------------------------------------------------

export type Inputs = Record<string, Bit>;
export type Settled = {
  nets: Uint8Array;
  /** Gate delays until nothing changed. */
  steps: number;
  /** False if it was still changing at the limit: an oscillator, or a race. */
  stable: boolean;
};

export function freshNets(f: Flat, inputs: Inputs, from?: Uint8Array): Uint8Array {
  const nets = from ? from.slice() : new Uint8Array(f.size);
  nets[0] = 0;
  nets[1] = 1;
  f.inputs.forEach((n, i) => {
    const v = inputs[n];
    if (v !== 0 && v !== 1) throw new Error(`No value given for input ${n}`);
    nets[2 + i] = v;
  });
  return nets;
}

/** One gate delay: every NAND reads the nets as they were and reacts at once. Returns whether anything changed. */
export function delay(f: Flat, nets: Uint8Array): boolean {
  const next = f.nands.map((g) => (nets[g.a] & nets[g.b]) ^ 1);
  let changed = false;
  f.nands.forEach((g, i) => {
    if (nets[g.out] !== next[i]) { nets[g.out] = next[i]; changed = true; }
  });
  return changed;
}

export function settle(f: Flat, inputs: Inputs, opts: { from?: Uint8Array; order?: 'together' | 'inOrder'; maxSteps?: number } = {}): Settled {
  const nets = freshNets(f, inputs, opts.from);
  const limit = opts.maxSteps ?? f.nands.length * 4 + 16;
  let steps = 0;
  while (steps < limit) {
    let changed = false;
    if (opts.order === 'inOrder') {
      for (const g of f.nands) {
        const v = (nets[g.a] & nets[g.b]) ^ 1;
        if (nets[g.out] !== v) { nets[g.out] = v; changed = true; }
      }
    } else changed = delay(f, nets);
    if (!changed) return { nets, steps, stable: true };
    steps++;
  }
  return { nets, steps, stable: false };
}

export const readOutputs = (f: Flat, nets: Uint8Array): Inputs => Object.fromEntries(Object.entries(f.outputs).map(([k, n]) => [k, nets[n] as Bit]));

/** The outputs once settled, or null if the circuit never settles. */
export function evaluate(f: Flat, inputs: Inputs): Inputs | null {
  const r = settle(f, inputs);
  return r.stable ? readOutputs(f, r.nets) : null;
}

/**
 * Longest path through NANDs from any input or constant to each net, or null if the circuit
 * loops. It's structure, not a settling time: a path through a part whose input is wired to
 * a fixed 0 never carries a change, and the panel once showed 19 here beside "Settled after
 * 16" on the same adder. changeDepth() is the number to show a learner.
 */
export function depth(f: Flat): { max: number; outputs: Record<string, number> } | null {
  const driver = new Map(f.nands.map((g) => [g.out, g]));
  const memo = new Map<number, number>();
  const active = new Set<number>();
  const at = (n: number): number | null => {
    const g = driver.get(n);
    if (!g) return 0;
    const known = memo.get(n);
    if (known !== undefined) return known;
    if (active.has(n)) return null;
    active.add(n);
    const a = at(g.a), b = at(g.b);
    active.delete(n);
    if (a === null || b === null) return null;
    const d = Math.max(a, b) + 1;
    memo.set(n, d);
    return d;
  };
  const outputs: Record<string, number> = {};
  let max = 0;
  for (const g of f.nands) {
    const d = at(g.out);
    if (d === null) return null;
    max = Math.max(max, d);
  }
  for (const [name, n] of Object.entries(f.outputs)) outputs[name] = at(n) ?? 0;
  return { max, outputs };
}

export const hasLoop = (f: Flat) => depth(f) === null;

/**
 * The most gate delays a change of inputs can take to settle, starting from a settled
 * circuit, or null if the circuit loops. It's the longest path a change can actually enter:
 * a NAND with a fixed 0 on one input is fixed at 1 and passes nothing on, and a fixed 1 on an
 * input adds no change of its own. Every net at this depth d is right within d delays, so
 * this is a true upper limit. It isn't always reached, because logic can still mask a path.
 * It doesn't cover power-up, where every net starts at 0 and even a fixed net needs a delay.
 */
export function changeDepth(f: Flat): number | null {
  if (hasLoop(f)) return null;
  const driver = new Map(f.nands.map((g) => [g.out, g]));
  const memo = new Map<number, number | 'fixed0' | 'fixed1'>();
  const at = (n: number): number | 'fixed0' | 'fixed1' => {
    if (n === 0) return 'fixed0';
    if (n === 1) return 'fixed1';
    const g = driver.get(n);
    if (!g) return 0;
    const known = memo.get(n);
    if (known !== undefined) return known;
    const a = at(g.a), b = at(g.b);
    const d = a === 'fixed0' || b === 'fixed0' ? 'fixed1'
      : a === 'fixed1' && b === 'fixed1' ? 'fixed0'
      : Math.max(a === 'fixed1' ? 0 : (a as number), b === 'fixed1' ? 0 : (b as number)) + 1;
    memo.set(n, d);
    return d;
  };
  let max = 0;
  for (const g of f.nands) {
    const d = at(g.out);
    if (typeof d === 'number') max = Math.max(max, d);
  }
  return max;
}

// ---- Truth tables and judging ------------------------------------------------------

/** Inputs are read as bits of the row number, first input as the top bit, the way a truth table is usually written. */
export const rowInputs = (names: string[], row: number): Inputs => Object.fromEntries(names.map((n, i) => [n, ((row >> (names.length - 1 - i)) & 1) as Bit]));

export const MAX_TABLE_INPUTS = 14;

export type Spec = { inputs: string[]; outputs: string[]; fn: (x: Inputs) => Inputs };
export type Row = { row: number; inputs: Inputs; want: Inputs; got: Inputs; right: boolean };
export type Verdict = { ok: boolean; problem?: string; total: number; wrong: number; rows: Row[]; nands: number; depth: number; settlesWithin: number };

const refused = (problem: string): Verdict => ({ ok: false, problem, total: 0, wrong: 0, rows: [], nands: 0, depth: 0, settlesWithin: 0 });

/**
 * Every input combination against the spec. A circuit has to be fully wired with no loops,
 * because an unconnected input or a loop has no truth table, even on a spare part. Past that,
 * layout doesn't count: a messy circuit with fully wired spare gates passes, and a tidy one
 * that's wrong on one row fails.
 */
export function judge(c: Circuit, spec: Spec, lib: Library = LIBRARY): Verdict {
  if (spec.inputs.length > MAX_TABLE_INPUTS) throw new Error(`judge: ${spec.inputs.length} inputs is too many to try them all`);
  const errors = validate(c, lib);
  if (errors.length) return refused(errors[0]);
  if (c.inputs.join() !== spec.inputs.join()) throw new Error(`judge: the circuit's inputs ${c.inputs} don't match the spec's ${spec.inputs}`);
  const named = c.outputs.map((o) => o.name);
  if (spec.outputs.some((o) => !named.includes(o))) throw new Error(`judge: the circuit has no output for one of ${spec.outputs}`);
  const f = flatten(c, lib);
  const d = depth(f);
  if (!d) return { ...refused('A wire loops back into the part that drives it. That can hold a value or oscillate, so it has no truth table. Take the loop out for this puzzle.'), nands: f.nands.length };
  const rows: Row[] = [];
  let wrong = 0;
  const total = 2 ** spec.inputs.length;
  for (let row = 0; row < total; row++) {
    const inputs = rowInputs(spec.inputs, row);
    const want = spec.fn(inputs);
    const got = evaluate(f, inputs);
    // No loop means it always settles. If that ever failed it would read as a wrong answer, not a pass.
    const right = !!got && spec.outputs.every((o) => got[o] === want[o]);
    if (!right) wrong++;
    rows.push({ row, inputs, want, got: got ?? {}, right });
  }
  return { ok: wrong === 0, total, wrong, rows, nands: f.nands.length, depth: d.max, settlesWithin: changeDepth(f)! };
}

/** The table of a looped-free circuit, as it behaves. */
export function truthTable(c: Circuit, lib: Library = LIBRARY): { inputs: Inputs; outputs: Inputs }[] {
  const f = flatten(c, lib);
  if (hasLoop(f)) throw new Error('truthTable: this circuit loops, so it has no single truth table');
  const out = [];
  for (let row = 0; row < 2 ** c.inputs.length; row++) {
    const inputs = rowInputs(c.inputs, row);
    out.push({ inputs, outputs: evaluate(f, inputs)! });
  }
  return out;
}

// ---- Multi-bit helpers -------------------------------------------------------------

/** a0 is the lowest bit, the one worth 1. */
export const bitNames = (prefix: string, width: number) => Array.from({ length: width }, (_, i) => `${prefix}${i}`);
export const numberFrom = (x: Inputs, prefix: string, width: number) => bitNames(prefix, width).reduce((n, name, i) => n + (x[name] * 2 ** i), 0);
export const bitsFrom = (n: number, prefix: string, width: number): Inputs => Object.fromEntries(bitNames(prefix, width).map((name, i) => [name, (Math.floor(n / 2 ** i) % 2) as Bit]));

/** A ripple-carry adder of any width, built from FULL parts: each carry feeds the next. */
export function rippleAdder(width: number): Circuit {
  const gates: GateInst[] = [];
  for (let i = 0; i < width; i++) gates.push({ id: `fa${i}`, part: 'FULL', in: [`a${i}`, `b${i}`, i === 0 ? '0' : `fa${i - 1}.carry`] });
  return {
    inputs: [...bitNames('a', width), ...bitNames('b', width)],
    gates,
    outputs: [...bitNames('s', width).map((name, i) => ({ name, from: `fa${i}.sum` })), { name: 'carry', from: `fa${width - 1}.carry` }],
  };
}

// ---- Drawing ----------------------------------------------------------------------

/** Which column a gate sits in: one past the furthest gate it reads from. Loops are cut, so this always finishes. */
export function columns(c: Circuit): Map<string, number> {
  const byId = new Map(c.gates.map((g) => [g.id, g]));
  const memo = new Map<string, number>();
  const at = (id: string, path: Set<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (path.has(id)) return 0;
    const g = byId.get(id);
    if (!g) return 0;
    path.add(id);
    let col = 1;
    for (const s of g.in) {
      if (!s || isConst(s)) continue;
      const from = s.split('.')[0];
      if (byId.has(from)) col = Math.max(col, at(from, path) + 1);
    }
    path.delete(id);
    memo.set(id, col);
    return col;
  };
  for (const g of c.gates) at(g.id, new Set());
  return memo;
}
