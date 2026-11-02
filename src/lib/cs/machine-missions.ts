// Missions for the machine lab. A step judges what the program does on inputs the learner
// never saw, and never reads its text, so any correct program counts: a loop, a formula, or a
// recursion. The visible input is 5. A program that hard-codes 15 has to fail, and so does one
// that returns the right number while wrecking the caller's registers.
//
// Every step looks through all the runs so far rather than only the latest. A later step
// that changes the program must not take away an earlier tick: tests/machine-missions.test.ts
// plays each mission to the end to hold that.

import type { Mission } from '../missions.ts';
import { assemble, callFunction, hexAddr, Machine, OUT_ADDR, regIndex, REG_NAMES, type AsmError, type Program, type Status, type StepRecord } from './riscv.ts';

export type MachineRun = { src: string; assembled: boolean; status: Status | 'refused'; backJump: boolean; steps: number };
export type MachineState = { runs: MachineRun[] };

export type MachineMission = Mission<MachineState> & { starter: string; inputs?: string };

const blank = (): MachineState => ({ runs: [] });

/** Judging can run a program dozens of times, and the panel asks on every Step, so each source is judged once. */
function remember<T>(judge: (p: Program) => T): (src: string) => T | null {
  const seen = new Map<string, T | null>();
  return (src) => {
    if (seen.has(src)) return seen.get(src)!;
    const a = assemble(src);
    const verdict = a.ok ? judge(a.program) : null;
    if (seen.size > 40) seen.clear();
    seen.set(src, verdict);
    return verdict;
  };
}

type Verdict = { ok: boolean; why: string };
const sumTo = (n: number) => (n * (n + 1)) / 2;

function latest(s: MachineState) { return s.runs.at(-1); }

// ---- what the lab and the tests share, so a test plays what a learner plays ------------

/** Reads "a0=5, a1=-3". Refuses anything it can't use, because an ignored input reads as a wrong answer. */
export function parseInputs(text: string): { ok: true; regs: Record<string, number> } | { ok: false; why: string } {
  const regs: Record<string, number> = {};
  for (const part of text.split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^([a-z]\w*)\s*=\s*(-?(?:0x[0-9a-fA-F]+|\d+))$/.exec(part);
    if (!m) return { ok: false, why: `can't read "${part}". Write it like a0=5, a1=-3` };
    if (m[1] === 'pc') return { ok: false, why: 'pc always starts at the first instruction here' };
    const i = regIndex(m[1]);
    if (i === undefined) return { ok: false, why: `"${m[1]}" isn't a register` };
    if (i === 0) return { ok: false, why: 'zero is always 0, so it can\'t start as anything else' };
    const v = m[2].startsWith('-') ? -Number(m[2].slice(1)) : Number(m[2]);
    if (v < -(2 ** 31) || v >= 2 ** 32) return { ok: false, why: `${m[2]} doesn't fit in a 32-bit register` };
    regs[m[1]] = v;
  }
  return { ok: true, regs };
}

/** A run that hasn't started, to be filled in by note(). */
export const newRun = (src: string, assembled = true): MachineRun => ({ src, assembled, status: assembled ? 'ready' : 'refused', backJump: false, steps: 0 });

export function note(run: MachineRun, m: Machine, rec: StepRecord | null) {
  if (rec && rec.nextPc < rec.pc && rec.nextPc !== rec.pc) run.backJump = true;
  run.status = m.status;
  run.steps = m.steps;
}

/** Plays a source to its end: what the lab's Run button does. Refused source becomes a run that records so. */
export function playRun(src: string, regs: Record<string, number> = {}): { run: MachineRun; machine: Machine | null; errors: AsmError[] } {
  const a = assemble(src);
  if (!a.ok) return { run: newRun(src, false), machine: null, errors: a.errors };
  const m = new Machine(a.program, { regs });
  const run = newRun(src);
  while (m.status === 'ready') note(run, m, m.step());
  return { run, machine: m, errors: [] };
}

/** What the instruction just did, in words, for the stepper's Execute line. */
export function describeEffect(r: StepRecord): string {
  const n = (i: number) => REG_NAMES[i];
  const parts: string[] = [];
  if (r.d.op === 'ebreak') return 'Stop here and hand control back. pc stays where it is.';
  if (r.memRead) parts.push(`read ${r.memRead.size} byte${r.memRead.size > 1 ? 's' : ''} at ${hexAddr(r.memRead.addr)}, which hold ${r.memRead.value}`);
  if (r.memWrite) parts.push(r.memWrite.addr === OUT_ADDR ? `send the byte ${r.memWrite.value} to the output` : `write ${r.memWrite.value} into ${r.memWrite.size} byte${r.memWrite.size > 1 ? 's' : ''} at ${hexAddr(r.memWrite.addr)}`);
  if (r.regWrite) parts.push(r.regWrite.reg === 0 ? 'throw the result away, because zero is always 0' : `register ${n(r.regWrite.reg)} goes from ${r.regWrite.before} to ${r.regWrite.value}`);
  if (r.d.fmt === 'B') parts.push(`compare ${r.rs1Value} and ${r.rs2Value}: ${r.taken ? 'taken' : 'not taken'}`);
  if (r.taken) parts.push(`pc jumps to ${hexAddr(r.nextPc)}`);
  else parts.push(`pc moves on to ${hexAddr(r.nextPc)}`);
  const text = parts.join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

/** The status line after a run, or after a step that ended one. */
export function statusLine(m: Machine): { text: string; kind: 'ok' | 'warn' | 'bad' | '' } {
  const count = `${m.steps.toLocaleString('en-US')} instruction${m.steps === 1 ? '' : 's'}`;
  switch (m.status) {
    case 'ready': return { text: `Paused after ${count}. pc is ${hexAddr(m.pc)}.`, kind: '' };
    case 'stopped': return { text: `Stopped at ebreak after ${count}.`, kind: 'ok' };
    case 'returned': return { text: `Finished: ret went back to whatever started the program, after ${count}.`, kind: 'ok' };
    case 'budget': return { text: `${m.fault!.line ? `Line ${m.fault!.line}: ` : ''}${m.fault!.message}.`, kind: 'warn' };
    case 'fault': return { text: `${m.fault!.line ? `Line ${m.fault!.line}: ` : ''}${m.fault!.message}.`, kind: 'bad' };
  }
}

// ---- toy-cpu: a program that starts with its input in a0 and stops with ebreak ------

const HIDDEN_N = [0, 1, 2, 3, 7, 10, 100, 1000, 2047];
// A failure names the input it failed on, which is what makes it useful. It also means a patient
// learner could collect them all and build a table of answers, and that passed. These are only ever
// reported without their value, so no table built from the messages can get past them.
const UNNAMED_N = [777, 1234];
const LOOKED_UP = 'on one more input, which this check keeps to itself, the answer came out wrong. A program has to work the answer out, not look it up';

function runWithInput(p: Program, n: number) {
  const m = new Machine(p, { regs: { a0: n } });
  m.run();
  return m;
}

const judgeSum = remember<Verdict>((p) => {
  for (const n of HIDDEN_N) {
    const m = runWithInput(p, n);
    if (m.status === 'fault' || m.status === 'budget') return { ok: false, why: `with n = ${n}, which you can't see from here: ${m.fault!.line ? `line ${m.fault!.line}: ` : ''}${m.fault!.message}` };
    if (m.reg('a0') !== sumTo(n)) return { ok: false, why: `with n = ${n}, which you can't see from here, a0 should end up as ${sumTo(n)} and it ended up as ${m.reg('a0')}` };
  }
  for (const n of UNNAMED_N) {
    const m = runWithInput(p, n);
    if (m.status === 'fault' || m.status === 'budget') return { ok: false, why: m.fault!.message };
    if (m.reg('a0') !== sumTo(n)) return { ok: false, why: LOOKED_UP };
  }
  return { ok: true, why: '' };
});

const judgeStored = remember<Verdict>((p) => {
  const at = p.labels.get('total');
  if (at === undefined) return { ok: false, why: 'there\'s no label called total in your program. It\'s the word in the .data section at the bottom of the starter' };
  for (const n of HIDDEN_N) {
    const m = runWithInput(p, n);
    if (m.status === 'fault' || m.status === 'budget') return { ok: false, why: `with n = ${n}: ${m.fault!.message}` };
    if (m.readWord(at) !== sumTo(n)) return { ok: false, why: `with n = ${n}, which you can't see from here, the word at total should hold ${sumTo(n)} and it holds ${m.readWord(at)}` };
    if (m.reg('a0') !== sumTo(n)) return { ok: false, why: `with n = ${n}, the word at total is right, and a0 should still hold ${sumTo(n)} too. It holds ${m.reg('a0')}` };
  }
  return { ok: true, why: '' };
});

export const COUNT_STARTER = `# Add up 1 + 2 + ... + n.
# n arrives in a0, and the answer has to end up in a0.
    li t0, 0            # the total so far
    li t1, 1            # the next number to add
loop:
    bge t1, a0, done    # stop when there's nothing left to add
    add t0, t0, t1
    addi t1, t1, 1
    j loop
done:
    mv a0, t0
    ebreak

.data
total: .word 0
`;

export const CALL_STARTER = `# main calls sum_to(4), then stops. a0 should end up as 10.
main:
    li a0, 4
    call sum_to
    ebreak

# sum_to(n) is n + sum_to(n - 1), and sum_to(0) is 0.
sum_to:
    beqz a0, base
    mv s0, a0           # keep n for after the call
    addi a0, a0, -1
    call sum_to
    add a0, a0, s0
    ret
base:
    ret

# fib(n): write this one. fib(0) is 0, fib(1) is 1,
# and every other fib(n) is fib(n - 1) + fib(n - 2).
fib:
    ret
`;

const SUM_TO_CASES = [0, 1, 2, 5, 10, 50, 100, 500];
// Inside the named range, so a right answer with a big frame can't run out of stack only on this one.
const SUM_TO_UNNAMED = 333;
const FIB = (n: number) => { let a = 0, b = 1; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a; };
const FIB_CASES = [0, 1, 2, 3, 4, 5, 6, 7, 10, 12, 15];
// 17 and no higher: a plain recursive fib has to finish inside the machine's step budget.
const FIB_UNNAMED = 17;

const judgeSumTo = remember<Verdict>((p) => {
  for (const n of SUM_TO_CASES) {
    const r = callFunction(p, 'sum_to', [n]);
    if (!r.ok) return { ok: false, why: r.why };
    if (r.value !== sumTo(n)) return { ok: false, why: `sum_to(${n}), which you can't see from here, should return ${sumTo(n)} and it returned ${r.value}` };
  }
  const extra = callFunction(p, 'sum_to', [SUM_TO_UNNAMED]);
  if (!extra.ok) return { ok: false, why: extra.why };
  if (extra.value !== sumTo(SUM_TO_UNNAMED)) return { ok: false, why: LOOKED_UP };
  return { ok: true, why: '' };
});

const judgeFib = remember<Verdict>((p) => {
  for (const n of FIB_CASES) {
    const r = callFunction(p, 'fib', [n]);
    if (!r.ok) return { ok: false, why: r.why };
    if (r.value !== FIB(n)) return { ok: false, why: `fib(${n}) should return ${FIB(n)} and it returned ${r.value}` };
  }
  const extra = callFunction(p, 'fib', [FIB_UNNAMED]);
  if (!extra.ok) return { ok: false, why: extra.why };
  if (extra.value !== FIB(FIB_UNNAMED)) return { ok: false, why: LOOKED_UP };
  return { ok: true, why: '' };
});

const anyRun = (s: MachineState, judge: (src: string) => Verdict | null) => s.runs.some((r) => r.assembled && judge(r.src)?.ok);
const reason = (s: MachineState, judge: (src: string) => Verdict | null) => {
  const r = latest(s);
  if (!r) return '';
  if (!r.assembled) return 'The last run didn\'t assemble, so it couldn\'t be checked. Fix the lines listed under the program.';
  return judge(r.src)?.why ?? '';
};

export const MACHINE_MISSIONS: Record<string, MachineMission> = {
  'cpu-count-up': {
    id: 'cpu-count-up', title: 'Teach it to count', xp: 60, setup: blank, starter: COUNT_STARTER, inputs: 'a0=5',
    steps: [
      { text: 'Press Step until the pc goes backwards. That jump is the whole of what makes a loop', hint: 'Keep pressing Step and watch pc. j loop sends it back to an earlier address', done: (s) => s.runs.some((r) => r.backJump) },
      { text: 'With n = 5 the answer should be 15, and it says 10. Fix the program so it\'s right for any n of 0 or more', hint: 'The loop stops when t1 reaches n, before adding n itself. bge means "greater or equal". Which comparison in the table above the lab stops one later?', done: (s) => anyRun(s, judgeSum), why: (s) => reason(s, judgeSum) },
      { text: 'Registers vanish when the program ends. Also store the answer in memory, in the word at the label total', hint: 'la t2, total  then  sw t0, 0(t2)', done: (s) => anyRun(s, judgeStored), why: (s) => reason(s, judgeStored) },
    ],
    debrief: 'That program was checked on inputs it never saw, from 0 to 2047, and it ran on a real instruction set. Every step you watched was the same three things: read the word at pc, work out what its bits mean, and do it. A loop isn\'t a feature of the machine. It\'s an ordinary instruction that happens to write pc. And on this machine, nothing in memory says which bytes are code: the word at total sits in the same memory as the program, and only pc decides which gets run.',
  },
  'asm-calls': {
    id: 'asm-calls', title: 'Calls that come back', xp: 80, setup: blank, starter: CALL_STARTER,
    steps: [
      { text: 'Run it. It never finishes. Step through and find what happened to ra', hint: 'Press Run and read the status, then Step and watch ra when call sum_to runs a second time', done: (s) => s.runs.some((r) => r.status === 'budget') || anyRun(s, judgeSumTo) },
      { text: 'Fix sum_to so it\'s right for any n of 0 or more, keeps sp a multiple of 16, and leaves the stack and s0 as it found them', hint: 'At the top: addi sp, sp, -16  then  sw ra, 12(sp)  then  sw s0, 8(sp). Before ret: read them back, from the same places, and add 16 to sp. It has to be 16 even though you only need 8: the convention keeps sp a multiple of 16', done: (s) => anyRun(s, judgeSumTo), why: (s) => reason(s, judgeSumTo) },
      { text: 'Now write fib. It calls itself twice, so it has more to keep across each call', hint: 'Save ra, s0 and s1, in a 16-byte frame. Keep n in s0 and the first answer in s1. Add them for the result', done: (s) => anyRun(s, judgeFib) && anyRun(s, judgeSumTo), why: (s) => reason(s, judgeFib) },
    ],
    debrief: 'A call is a jump that writes down where to come back to, in one register. That register is the first thing the next call overwrites, so every function that makes a call has to save it somewhere, and the stack is where. A recursive function\'s frames hold the same things Python\'s stepper showed you as a pile of calls: a place to come back to, and the values that belong to this call. Your functions were also checked for manners. Each had to leave sp and every s register as it found them, keep sp a multiple of 16 the whole way through, and leave gp and tp alone, because code it never meets relies on that without being able to check.',
  },
};
