// The Pipeline Lab's logic: a classic textbook five-stage pipeline, timed over the real
// instruction trace from the RISC-V machine in riscv.ts. The trace decides what ran, and this
// decides how many cycles it took, so the model can never change a program's answer. That's a limit
// of the model and not a law: a real pipeline has already fetched the next instructions when a
// store lands, so a program that overwrites its own code can behave differently there.
//
// It's a simple model and it says so everywhere it appears. One instruction fetched per cycle,
// memory always answers in one cycle (no caches), a branch is settled at the end of EX, and a
// predictor that guesses "taken" knows the target at once. No commercial CPU works like this.
//
// tests/pipeline.test.ts holds these exact cycle counts against a separate reference in real
// Python that simulates the pipeline registers cycle by cycle, where this module works out each
// instruction's stage times directly. A shared misunderstanding would have to be made twice.

import type { Mission } from '../missions.ts';
import { assemble, DATA_BASE, hex32, hexAddr, Machine, REG_NAMES, type AsmError, type Decoded, type MachineOptions, type StepRecord } from './riscv.ts';
import { rng } from './layout.ts';

export type Predictor = 'stall' | 'not-taken' | 'one-bit' | 'two-bit';
export const PREDICTORS: { id: Predictor; label: string }[] = [
  { id: 'stall', label: 'no guessing: wait for every branch' },
  { id: 'not-taken', label: 'always guess not taken' },
  { id: 'one-bit', label: 'remember the last outcome (1 bit)' },
  // Not "two strikes": from the middle of the counter one surprise flips the guess, and an alternating branch can fool it every time.
  { id: 'two-bit', label: 'a counter pushed past its middle (2 bits)' },
];
export type PipeConfig = { forwarding: boolean; predictor: Predictor };
// What a wrong guess costs here: the two instructions fetched behind a branch before EX settles it.
export const FLUSH_CYCLES = 2;

/** Which registers an instruction really reads. lui, auipc, jal and ebreak read none. */
export function sourcesOf(d: Decoded): number[] {
  switch (d.fmt) {
    case 'R': case 'S': case 'B': return [d.rs1, d.rs2].filter((r) => r !== 0);
    case 'I': return d.op === 'ebreak' || d.rs1 === 0 ? [] : [d.rs1];
    default: return [];
  }
}
const isLoad = (d: Decoded) => d.op === 'lb' || d.op === 'lh' || d.op === 'lw' || d.op === 'lbu' || d.op === 'lhu';
const isBranch = (d: Decoded) => d.fmt === 'B';
const isJump = (d: Decoded) => d.op === 'jal' || d.op === 'jalr';

export type PipeRow = { text: string; line: number; IF: number; ID: number; EX: number; MEM: number; WB: number; stalls: number; flushAfter: boolean };
export type PipeResult = {
  cycles: number; instructions: number; cpi: number;
  dataStalls: number; loadUseStalls: number;
  branches: number; taken: number; mispredicts: number; jumps: number; flushCycles: number;
  rows: PipeRow[];
};

/**
 * Stage times for each instruction in order. The cycle total is exact: instructions, plus the
 * four extra cycles the last one needs to reach WB, plus every stall and flush.
 */
export function schedule(trace: StepRecord[], cfg: PipeConfig): PipeResult {
  const rows: PipeRow[] = [];
  // For each register, the last instruction that wrote it, and when: all a later reader needs.
  const writer = new Map<number, { EX: number; load: boolean }>();
  const oneBit = new Map<number, boolean>();
  const twoBit = new Map<number, number>();
  let prevID = 0, prevEX = 0, fetchNotBefore = 1;
  let dataStalls = 0, loadUseStalls = 0, branches = 0, taken = 0, mispredicts = 0, jumps = 0, flushCycles = 0;

  for (const r of trace) {
    const IF = Math.max(fetchNotBefore, prevID);
    const ID = Math.max(IF + 1, prevEX);
    let EX = ID + 1;
    for (const s of sourcesOf(r.d)) {
      const w = writer.get(s);
      if (!w) continue;
      // With forwarding, an ALU result is ready for the very next EX, and a load's only after its MEM.
      // Without it, a reader in ID must wait for the writer's WB, which writes in the first half
      // of its cycle so ID can read in the second half.
      const ready = cfg.forwarding ? w.EX + (w.load ? 2 : 1) : w.EX + 3;
      if (ready > EX) {
        if (cfg.forwarding && w.load) loadUseStalls += ready - EX;
        EX = ready;
      }
    }
    const stalls = EX - ID - 1;
    dataStalls += stalls;

    let flush = false;
    if (isBranch(r.d)) {
      branches++;
      const went = !!r.taken;
      if (went) taken++;
      let guess: boolean;
      switch (cfg.predictor) {
        case 'stall': guess = !went; break; // Waiting costs the same two cycles as guessing wrong, every time.
        case 'not-taken': guess = false; break;
        case 'one-bit': guess = oneBit.get(r.pc) ?? false; oneBit.set(r.pc, went); break;
        case 'two-bit': {
          const c = twoBit.get(r.pc) ?? 1;
          guess = c >= 2;
          twoBit.set(r.pc, went ? Math.min(3, c + 1) : Math.max(0, c - 1));
          break;
        }
      }
      flush = guess !== went;
      if (flush) mispredicts++;
    } else if (isJump(r.d)) {
      jumps++;
      flush = true;
    }
    if (flush) flushCycles += FLUSH_CYCLES;

    const row: PipeRow = { text: r.text, line: r.line, IF, ID, EX, MEM: EX + 1, WB: EX + 2, stalls, flushAfter: flush };
    rows.push(row);
    if (r.regWrite && r.regWrite.reg !== 0) writer.set(r.regWrite.reg, { EX, load: isLoad(r.d) });
    prevID = ID; prevEX = EX;
    fetchNotBefore = flush ? EX + 1 : IF + 1;
  }
  const cycles = rows.length ? rows.at(-1)!.WB : 0;
  return { cycles, instructions: rows.length, cpi: rows.length ? cycles / rows.length : 0, dataStalls, loadUseStalls, branches, taken, mispredicts, jumps, flushCycles, rows };
}

export type TraceResult =
  | { ok: true; trace: StepRecord[]; machine: Machine }
  | { ok: false; errors: AsmError[] }
  | { ok: false; fault: string; line: number };

/** Runs a program to its end and keeps every instruction that retired. A run that never stops has no cycle count, so it's refused. */
export function traceOf(src: string, opts: MachineOptions = {}): TraceResult {
  const a = assemble(src);
  if (!a.ok) return { ok: false, errors: a.errors };
  const machine = new Machine(a.program, opts);
  const trace: StepRecord[] = [];
  for (;;) {
    const rec = machine.step();
    if (rec) trace.push(rec);
    if (machine.status !== 'ready') break;
  }
  if (machine.status === 'fault' || machine.status === 'budget') return { ok: false, fault: machine.fault!.message, line: machine.fault!.line };
  return { ok: true, trace, machine };
}

// ---- a grid for showing it, one row per instruction, one column per cycle ----------

export type Cell = '' | 'IF' | 'ID' | 'EX' | 'MEM' | 'WB' | 'stall' | 'wait';
/** Each cell of the classic pipeline diagram, for the first rows of a run. */
export function chart(rows: PipeRow[], maxRows = 24, maxCycles = 48): { rows: { text: string; line: number; cells: Cell[]; flushAfter: boolean }[]; cycles: number; clippedRows: boolean; clippedCycles: boolean } {
  const shown = rows.slice(0, maxRows);
  const last = shown.at(-1)?.WB ?? 0;
  const cycles = Math.min(last, maxCycles);
  return {
    cycles,
    clippedRows: rows.length > maxRows,
    clippedCycles: last > maxCycles,
    rows: shown.map((r) => {
      const cells: Cell[] = Array.from({ length: cycles }, () => '' as Cell);
      const put = (c: number, v: Cell) => { if (c >= 1 && c <= cycles) cells[c - 1] = v; };
      put(r.IF, 'IF');
      for (let c = r.IF + 1; c < r.ID; c++) put(c, 'wait');
      put(r.ID, 'ID');
      for (let c = r.ID + 1; c < r.EX; c++) put(c, 'stall');
      put(r.EX, 'EX'); put(r.MEM, 'MEM'); put(r.WB, 'WB');
      return { text: r.text, line: r.line, cells, flushAfter: r.flushAfter };
    }),
  };
}

// ---- no protection at all: what the stalls are for ---------------------------------

/**
 * The pipeline with its hazard handling removed: no forwarding, no stalls. A register write lands
 * three instruction slots later, so the next two instructions read the old value. Each register
 * write and memory access is done for real, which makes the wrong answers real ones too.
 */
export function runUnprotected(src: string, opts: MachineOptions = {}): TraceResult {
  return traceOf(src, { ...opts, writeDelay: 3 });
}

export type RunDifference = { registers: string[]; memory: string[]; memoryBytes: number; output: string | null; ending: string | null; same: boolean };

const shownOutput = (t: string) => `"${t.replace(/[^\x20-\x7e]/g, (c) => (c === '\n' ? '\\n' : c === '\0' ? '\\0' : `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`))}"`;

/**
 * Everything two finished runs could disagree on: registers, all of memory, what was printed, and
 * where and how they stopped. The hazard button once compared registers alone, so a stale store
 * that wrote over the program's first instruction, and a print of a zero byte in place of "A", were
 * both told they "happen to come out right". This only looks at the ends of the runs, and the page says so.
 */
export function compareRuns(right: Machine, wrong: Machine): RunDifference {
  const registers: string[] = [];
  for (let i = 1; i < 32; i++) if (right.regs[i] !== wrong.regs[i]) registers.push(`${REG_NAMES[i]} is ${wrong.regs[i]}, and should be ${right.regs[i]}`);
  const memory: string[] = [];
  let memoryBytes = 0;
  const words = new Set<number>();
  for (let a = 0; a < right.mem.length; a++) if (right.mem[a] !== wrong.mem[a]) { memoryBytes++; words.add(a - (a % 4)); }
  for (const a of words) memory.push(`the word at ${hexAddr(a)} is ${hex32(wrong.readWord(a))}, and should be ${hex32(right.readWord(a))}`);
  const output = right.output === wrong.output ? null : `it printed ${shownOutput(wrong.output)}, and should have printed ${shownOutput(right.output)}`;
  const ending = right.status === wrong.status && right.pc === wrong.pc ? null : `it ended at ${hexAddr(wrong.pc)} (${wrong.status}), and should have ended at ${hexAddr(right.pc)} (${right.status})`;
  return { registers, memory, memoryBytes, output, ending, same: !registers.length && !memoryBytes && output === null && ending === null };
}

// ---- the programs the lesson runs ----------------------------------------------------

export const LOOP_LENGTH = 256;
export type Dataset = 'shuffled' | 'sorted';

/** The same 256 values each time, either way round: only the order differs, as in the question that made this famous. */
export function dataset(kind: Dataset): number[] {
  const r = rng(128);
  const values = Array.from({ length: LOOP_LENGTH }, () => Math.floor(r() * 256));
  return kind === 'sorted' ? values.sort((a, b) => a - b) : values;
}
export const dataWords = (kind: Dataset) => [{ addr: DATA_BASE, values: dataset(kind) }];

export const BRANCH_LOOP = `# Add up the values that are 128 or more.
# 256 values are already in memory at 0x2000.
    li t0, 0x2000       # where the next value is
    li t1, 256          # how many are left
    li t3, 128
    li a0, 0            # the total
loop:
    lw t2, 0(t0)
    blt t2, t3, skip    # the branch that depends on the data
    add a0, a0, t2
skip:
    addi t0, t0, 4
    addi t1, t1, -1
    bnez t1, loop       # the loop's own branch
    ebreak
`;

export const REORDER_STARTER = `# Reads three values at a0, the address it's given.
# Writes value0 + value1 to a0+12, and value0 + value2 to a0+16.
    lw t1, 0(a0)
    lw t2, 4(a0)
    add t3, t1, t2
    sw t3, 12(a0)
    lw t4, 8(a0)
    add t5, t1, t4
    sw t5, 16(a0)
    ebreak
`;

export const HAZARD_DEMO = `# Each line uses the answer from the line before it.
    li t0, 5
    addi t1, t0, 1
    addi t2, t1, 1
    addi a0, t2, 1
    ebreak
`;

export const NESTED_LOOPS = `# An inner loop of 8, run 16 times. The inner branch goes
# back 7 times out of 8, which is where a second bit of memory pays.
    li t0, 16
outer:
    li t1, 8
inner:
    addi t1, t1, -1
    bnez t1, inner
    addi t0, t0, -1
    bnez t0, outer
    ebreak
`;

export const PIPE_PROGRAMS: { id: string; label: string; src: string; usesData: boolean }[] = [
  { id: 'chain', label: 'Each line uses the last one', src: HAZARD_DEMO, usesData: false },
  { id: 'reorder', label: 'Loads next to the code that needs them', src: REORDER_STARTER, usesData: false },
  { id: 'loop', label: 'A loop with a branch on its data', src: BRANCH_LOOP, usesData: true },
  { id: 'nested', label: 'A loop inside a loop', src: NESTED_LOOPS, usesData: false },
];

export type PipeRun = { program: string; src: string; cfg: PipeConfig; data: Dataset; result: PipeResult; a0: number };
export type PipeState = { runs: PipeRun[]; reorder: { src: string; ok: boolean; why: string } | null };

// The same source in both runs, and not BRANCH_LOOP's exact bytes. The page says "you can edit it",
// and this step used to stay unticked, with no reason given, over one added comment or newline.
const loopRuns = (s: PipeState, data: Dataset) => s.runs.filter((r) => r.program === 'loop' && r.data === data && r.cfg.predictor === 'two-bit');
const comparedOrders = (s: PipeState) => loopRuns(s, 'shuffled').some((a) => loopRuns(s, 'sorted').some((b) => a.src === b.src && a.a0 === b.a0 && a.result.mispredicts > b.result.mispredicts));
const whyNotCompared = (s: PipeState) => {
  const a = loopRuns(s, 'shuffled'), b = loopRuns(s, 'sorted');
  if (!a.length || !b.length || comparedOrders(s)) return '';
  if (!a.some((x) => b.some((y) => x.src === y.src))) return 'Those two runs used different programs, so they can\'t be compared. Run the same program on both data orders.';
  return 'On this program the shuffled data didn\'t come out with more wrong guesses than the sorted data, or the two answers differ. Choosing the program again in the list brings the original back.';
};

/** Records a try at the reorder. Once it's been done, a later wrong attempt can't take the tick away: a browser run lost it to one typo. */
export function noteReorder(s: PipeState, src: string) {
  if (s.reorder?.ok) return;
  const v = judgeReorder(src);
  s.reorder = v.ok ? { src, ok: true, why: '' } : { src, ok: false, why: v.why };
}

export const PIPE_MISSION: Mission<PipeState> = {
  id: 'pipe-same-answer', title: 'Same answers, fewer cycles', xp: 70,
  setup: () => ({ runs: [], reorder: null }),
  steps: [
    { text: 'Run one program with forwarding off, then on. The answer stays the same. What happened to the cycles?', hint: 'Pick a program, press Run, change Forwarding, press Run again', done: (s) => s.runs.some((a) => !a.cfg.forwarding && s.runs.some((b) => b.cfg.forwarding && b.src === a.src && b.result.cycles < a.result.cycles)) },
    {
      text: 'Choose the "Loads next to the code that needs them" program and reorder its lines. Keep the answers right on values you can\'t see, and get it to 12 cycles with forwarding on',
      hint: 'A load\'s value is one cycle late for the very next instruction. Which load could move up, so something else goes between it and its use?',
      done: (s) => !!s.reorder?.ok,
      why: (s) => (s.reorder && !s.reorder.ok ? s.reorder.why : ''),
    },
    { text: 'Run the loop program with the 2-bit predictor on shuffled data, then on sorted data, and compare the wrong guesses. Same values, same answer', hint: 'Choose "A loop with a branch on its data", then the predictor, then the data order', done: comparedOrders, why: whyNotCompared },
  ],
  debrief: 'A pipeline does several instructions at once, and every way it can go wrong comes from one instruction needing what another hasn\'t finished. Forwarding and stalls keep the answers right whatever the order, for a program that doesn\'t overwrite its own instructions, and only the bill changes. You paid less by moving a line, without changing a single answer. The sorted data did the same work with fewer wrong guesses. In this short model a wrong guess costs two cycles, so the gap is small. Real CPUs generally have longer pipelines, and a wrong guess can cost them far more. The model can\'t tell you how much on yours: only a measurement can.',
};
// Where the reorder program finds its three values in the lab, so a visible run has something to read.
export const REORDER_ADDR = 0x2400;
export const REORDER_VISIBLE = [10, 20, 30];
// Eight instructions, and four more cycles for the last to reach WB: what's left with no stall at all.
export const REORDER_TARGET_CYCLES = 12;

/** Results and cycles on inputs the learner never saw, so hard-coding the visible answers can't pass. */
export function judgeReorder(src: string): { ok: true; cycles: number } | { ok: false; why: string } {
  const hidden = [[7, 11, 13], [-5, 1000, 2048], [0, 0, 1], [123456, -123456, 99], [2147483647, 1, -1]];
  const addrs = [REORDER_ADDR, 0x3000, 0x4100, 0x5200, 0x2800];
  let worst = 0;
  for (const [k, values] of hidden.entries()) {
    const addr = addrs[k];
    const t = traceOf(src, { regs: { a0: addr }, words: [{ addr, values }] });
    if (!t.ok) return { ok: false, why: 'errors' in t ? `line ${t.errors[0].line}: ${t.errors[0].message}` : `line ${t.line}: ${t.fault}` };
    const m = t.machine;
    const sum1 = (values[0] + values[1]) | 0, sum2 = (values[0] + values[2]) | 0;
    if (m.readWord(addr + 12) !== sum1 || m.readWord(addr + 16) !== sum2) {
      return { ok: false, why: `on values you can't see, ${values.join(', ')}, the answers should be ${sum1} and ${sum2}, and memory holds ${m.readWord(addr + 12)} and ${m.readWord(addr + 16)}` };
    }
    worst = Math.max(worst, schedule(t.trace, { forwarding: true, predictor: 'not-taken' }).cycles);
  }
  if (worst > REORDER_TARGET_CYCLES) return { ok: false, why: `the answers are right on values you can't see, and it takes ${worst} cycles with forwarding on. ${REORDER_TARGET_CYCLES} is possible. A nop in place of a stall costs the same cycle, so move an instruction instead` };
  return { ok: true, cycles: worst };
}
