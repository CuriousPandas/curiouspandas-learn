// The puzzles and missions for LogicLab. A puzzle's verdict comes only from judge():
// every input combination against a rule written as ordinary arithmetic or logic. No
// puzzle looks at which gates were used or how they're arranged, so any correct
// circuit passes. What a puzzle restricts is the parts offered, because "build AND from
// NAND" means nothing if AND is on the shelf.

import type { Mission } from '../missions.ts';
import { bitNames, bitsFrom, judge, numberFrom, type Bit, type Circuit, type Inputs, type Spec } from './logic.ts';

export type Puzzle = {
  id: string;
  title: string;
  brief: string;
  /** What's on the shelf. Each is a sealed part with the same behaviour as a correct solution to an earlier puzzle. */
  parts: string[];
  spec: Spec;
  /** Wired in place at the start. It can be changed: only the behaviour is judged. */
  starter?: Circuit;
  hint: string;
};

const not = (a: Bit) => (a ^ 1) as Bit;
const fn1 = (name: string, f: (x: Inputs) => Bit) => (x: Inputs) => ({ [name]: f(x) });

const AB = ['a', 'b'];
const empty = (inputs: string[], outputs: string[]): Circuit => ({ inputs, gates: [], outputs: outputs.map((name) => ({ name, from: '' })) });

export const NAND_PLAY: Puzzle = {
  id: 'nand', title: 'NAND, on its own', parts: ['NAND'],
  brief: 'Here is the one gate. Its output is 0 only when both inputs are 1. Flip the input switches and watch.',
  spec: { inputs: AB, outputs: ['out'], fn: fn1('out', (x) => not((x.a & x.b) as Bit)) },
  starter: { inputs: AB, gates: [{ id: 'g1', part: 'NAND', in: ['a', 'b'] }], outputs: [{ name: 'out', from: 'g1' }] },
  hint: 'Turn on both a and b.',
};

export const GATE_PUZZLES: Puzzle[] = [
  NAND_PLAY,
  {
    id: 'not', title: 'Build NOT', parts: ['NAND'],
    brief: 'One input. The output is the opposite of it.',
    spec: { inputs: ['a'], outputs: ['out'], fn: fn1('out', (x) => not(x.a)) },
    starter: empty(['a'], ['out']),
    hint: 'A NAND has two inputs, and nothing stops you connecting both to the same wire.',
  },
  {
    id: 'and', title: 'Build AND', parts: ['NAND', 'NOT'],
    brief: 'The output is 1 only when both inputs are 1. NOT is on the shelf now: it behaves as a right answer to the NOT puzzle does.',
    spec: { inputs: AB, outputs: ['out'], fn: fn1('out', (x) => (x.a & x.b) as Bit) },
    starter: empty(AB, ['out']),
    hint: 'NAND is "not and". So what do you get if you flip its output?',
  },
  {
    id: 'or', title: 'Build OR', parts: ['NAND', 'NOT', 'AND'],
    brief: 'The output is 1 when either input is 1, or both.',
    spec: { inputs: AB, outputs: ['out'], fn: fn1('out', (x) => (x.a | x.b) as Bit) },
    starter: empty(AB, ['out']),
    hint: 'A NAND gives 1 when either of its inputs is 0. So flip a, flip b, and NAND those.',
  },
  {
    id: 'xor', title: 'Build XOR', parts: ['NAND', 'NOT', 'AND', 'OR'],
    brief: 'Exclusive or: the output is 1 when the inputs differ. This is the first one that takes some thought, and the adder will need it.',
    spec: { inputs: AB, outputs: ['out'], fn: fn1('out', (x) => (x.a ^ x.b) as Bit) },
    starter: empty(AB, ['out']),
    hint: 'In words: "a or b, and not both". OR gives the first half. NAND gives "not both". AND joins them.',
  },
  {
    id: 'mux', title: 'Build a chooser', parts: ['NAND', 'NOT', 'AND', 'OR', 'XOR'],
    brief: 'A multiplexer. When sel is 0, the output copies a. When sel is 1, it copies b. This is "if" made of gates.',
    spec: { inputs: ['sel', 'a', 'b'], outputs: ['out'], fn: fn1('out', (x) => (x.sel ? x.b : x.a)) },
    starter: empty(['sel', 'a', 'b'], ['out']),
    hint: '(a and not sel) or (b and sel). That takes one NOT, two ANDs and one OR.',
  },
];

const halfSpec: Spec = { inputs: AB, outputs: ['sum', 'carry'], fn: (x) => ({ sum: (x.a ^ x.b) as Bit, carry: (x.a & x.b) as Bit }) };
const fullSpec: Spec = {
  inputs: ['a', 'b', 'cin'], outputs: ['sum', 'carry'],
  fn: (x) => {
    const t = x.a + x.b + x.cin;
    return { sum: (t % 2) as Bit, carry: (t >> 1) as Bit };
  },
};
const FOUR = [...bitNames('a', 4), ...bitNames('b', 4)];
export const add4Spec: Spec = {
  inputs: FOUR, outputs: [...bitNames('s', 4), 'carry'],
  fn: (x) => {
    const t = numberFrom(x, 'a', 4) + numberFrom(x, 'b', 4);
    return { ...bitsFrom(t % 16, 's', 4), carry: (t >> 4) as Bit };
  },
};
export const addSubSpec: Spec = {
  inputs: ['sub', ...FOUR], outputs: bitNames('s', 4),
  // Real arithmetic, wrapped to four bits. It says nothing about how to do it, so flipping b and adding 1 is a discovery, not a rule of the puzzle.
  fn: (x) => {
    const a = numberFrom(x, 'a', 4), b = numberFrom(x, 'b', 4);
    return bitsFrom(((x.sub ? a - b : a + b) + 16) % 16, 's', 4);
  },
};

export const ADDER_PUZZLES: Puzzle[] = [
  {
    id: 'half', title: 'Half adder: add two bits', parts: ['XOR', 'AND', 'OR', 'NOT', 'NAND'],
    brief: 'Add a + b, where each is 0 or 1. The answer can be 2, which takes two bits: sum is the bit worth 1, and carry is the bit worth 2.',
    spec: halfSpec,
    starter: empty(AB, ['sum', 'carry']),
    hint: 'Compare the two output columns with the gates you built last lesson. Each one is a gate you already have.',
  },
  {
    id: 'full', title: 'Full adder: add three bits', parts: ['HALF', 'XOR', 'AND', 'OR', 'NOT', 'NAND'],
    brief: 'Add a + b + cin, where cin is the carry coming in from the column to the right. The answer is at most 3, so sum and carry still hold it.',
    spec: fullSpec,
    starter: empty(['a', 'b', 'cin'], ['sum', 'carry']),
    hint: 'Add a and b with one half adder. Add its sum to cin with a second. If either half adder carried, the output carries: use an OR.',
  },
  {
    id: 'add4', title: 'A 4-bit adder', parts: ['FULL', 'HALF', 'XOR', 'AND', 'OR', 'NOT', 'NAND'],
    brief: 'Add two 4-bit numbers. a0 and b0 are worth 1, a3 and b3 are worth 8. The first column is wired for you, and the carry out of the top bit goes to carry. It has to be right for all 256 pairs.',
    spec: add4Spec,
    starter: {
      inputs: FOUR,
      gates: [{ id: 'g1', part: 'FULL', in: ['a0', 'b0', '0'] }],
      outputs: [{ name: 's0', from: 'g1.sum' }, { name: 's1', from: '' }, { name: 's2', from: '' }, { name: 's3', from: '' }, { name: 'carry', from: '' }],
    },
    hint: 'Four full adders in a row. Each one\'s carry goes into the cin of the next.',
  },
  {
    id: 'addsub', title: 'Add or subtract', parts: ['FULL', 'XOR', 'HALF', 'AND', 'OR', 'NOT', 'NAND'],
    brief: 'When sub is 0, s is a + b. When sub is 1, s is a - b. Both wrap at four bits, as a real 4-bit register does. All 512 combinations count. There is no subtract part, and you do not need one.',
    spec: addSubSpec,
    starter: empty(['sub', ...FOUR], bitNames('s', 4)),
    hint: 'a - b is a + (flip every bit of b) + 1. XOR with sub flips a bit only when sub is 1. And the first column has a spare input for the + 1.',
  },
];

export const PUZZLES: Record<string, Puzzle[]> = { gates: GATE_PUZZLES, adder: ADDER_PUZZLES };

/** A row in words, with bits grouped into numbers: "a = 3, b = 5". For tables too wide to show bit by bit. */
export function describeBits(x: Inputs, names: string[]): string {
  const groups = new Map<string, string[]>();
  for (const n of names) {
    const m = /^([a-z]+)\d+$/.exec(n);
    const key = m ? m[1] : n;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  return [...groups].map(([key, members]) => (members.length > 1 ? `${key} = ${numberFrom(x, key, members.length)}` : `${members[0]} = ${x[members[0]]}`)).join(', ');
}

export type LogicState = {
  solved: Set<string>;
  /** The NAND puzzle's output was seen at 0, which only happens with both inputs on. */
  sawNandLow: boolean;
  /** A settle watched one gate delay at a time, on a correct 4-bit adder. Its steps, for the mission and the debrief. */
  watched: { puzzle: string; steps: number }[];
};
export const logicState = (): LogicState => ({ solved: new Set(), sawNandLow: false, watched: [] });

/** Records a circuit's verdict. A solved puzzle stays solved: going back to try another route must not untick a step. */
export function record(s: LogicState, p: Puzzle, c: Circuit): ReturnType<typeof judge> {
  const v = judge(c, p.spec);
  if (v.ok && p.id !== NAND_PLAY.id) s.solved.add(p.id);
  return v;
}

export const LOGIC_MISSIONS: Record<string, Mission<LogicState>> = {
  'comp-logic-gates': {
    id: 'comp-logic-gates', title: 'Everything from one gate', xp: 80, setup: logicState,
    steps: [
      { text: 'On the NAND puzzle, get the output to 0', hint: 'Turn on both input switches', done: (s) => s.sawNandLow },
      { text: 'Build NOT from NAND', hint: 'One NAND, both inputs on the same wire', done: (s) => s.solved.has('not') },
      { text: 'Build AND', hint: 'A NAND followed by a NOT', done: (s) => s.solved.has('and') },
      { text: 'Build OR', hint: 'NOT a, NOT b, then NAND them', done: (s) => s.solved.has('or') },
      { text: 'Build XOR', hint: 'a OR b, a NAND b, then AND those two', done: (s) => s.solved.has('xor') },
      { text: 'Build the chooser', hint: 'NOT sel. AND a with that. AND b with sel. OR the two', done: (s) => s.solved.has('mux') },
    ],
    debrief: 'You built five gates, and at the bottom every one of them is NANDs. Once each was wired up with no loops, it was judged only on every possible input. That is the bargain of a gate: if it behaves the same on all inputs, it can replace any other that does. It is why a sealed part on the shelf could stand in for yours.',
  },
  'comp-logic-adder': {
    id: 'comp-logic-adder', title: 'Gates that do sums', xp: 100, setup: logicState,
    steps: [
      { text: 'Build a half adder', hint: 'sum is XOR, carry is AND', done: (s) => s.solved.has('half') },
      { text: 'Build a full adder', hint: 'Two half adders and an OR', done: (s) => s.solved.has('full') },
      { text: 'Build the 4-bit adder, right on all 256 pairs', hint: 'Each full adder\'s carry goes into the next one\'s cin', done: (s) => s.solved.has('add4') },
      { text: 'Watch it think. With the 4-bit adder right, tick "one gate delay at a time", flip an input, and press the button until it settles', hint: 'Set a to 1111 and b to 0000. Tick the box. Turn on b0, then keep pressing', done: (s) => s.watched.some((w) => w.puzzle === 'add4' && w.steps >= 2) },
      { text: 'Make it subtract as well, right on all 512 combinations', hint: 'XOR each bit of b with sub, and feed sub into the first carry-in', done: (s) => s.solved.has('addsub') },
    ],
    debrief: 'Those circuits are NANDs doing real arithmetic, and each was checked against every input it can have. Subtraction needed no new hardware: flip b, add 1, and two\'s complement does the rest. You also saw the price. The answer takes time to appear, and the carry is the slow part, because it has to pass through every column in turn.',
  },
};
