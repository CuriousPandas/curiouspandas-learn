// The lesson says this model's cycle counts are exact, so they're held against a reference in
// real Python that works the other way round: it simulates the pipeline registers one cycle at a
// time, moving instructions between stages, where schedule() computes each instruction's stage
// times directly. Hand-worked counts sit alongside, because two programs can share a mistake.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BRANCH_LOOP, compareRuns, dataset, dataWords, HAZARD_DEMO, judgeReorder, NESTED_LOOPS, noteReorder, PIPE_MISSION, PIPE_PROGRAMS, REORDER_ADDR, REORDER_STARTER, REORDER_VISIBLE, runUnprotected, schedule, sourcesOf, traceOf, chart, type PipeConfig, type PipeState, type Predictor } from '../src/lib/cs/pipeline.ts';
import type { MachineOptions, StepRecord } from '../src/lib/cs/riscv.ts';
import { python } from './helpers/python-json.ts';

const FWD: PipeConfig = { forwarding: true, predictor: 'not-taken' };
const NOFWD: PipeConfig = { forwarding: false, predictor: 'not-taken' };

function run(src: string, cfg: PipeConfig, opts: MachineOptions = {}) {
  const t = traceOf(src, opts);
  assert.ok(t.ok, JSON.stringify(t));
  return { r: schedule(t.trace, cfg), m: t.machine, trace: t.trace };
}
const REORDER_OPTS = { regs: { a0: REORDER_ADDR }, words: [{ addr: REORDER_ADDR, values: REORDER_VISIBLE }] };

test('hand-worked counts: independent instructions take n + 4 cycles', () => {
  const { r } = run('addi t0, zero, 1\naddi t1, zero, 2\naddi t2, zero, 3\nebreak\n', FWD);
  assert.equal(r.instructions, 4);
  assert.equal(r.cycles, 8);
  assert.equal(r.dataStalls, 0);
});

test('hand-worked counts: a chain of dependent instructions, with and without forwarding', () => {
  // li, then three addi that each read the last, then ebreak. Forwarding: no stalls, 5 + 4 = 9.
  assert.equal(run(HAZARD_DEMO, FWD).r.cycles, 9);
  // Without it, each of the three waits 2 cycles for the last one's WB: 9 + 6 = 15.
  const off = run(HAZARD_DEMO, NOFWD).r;
  assert.equal(off.cycles, 15);
  assert.equal(off.dataStalls, 6);
  // The answer is the machine's: the model only prices it.
  assert.equal(run(HAZARD_DEMO, NOFWD).m.reg('a0'), 8);
});

test('hand-worked counts: a load\'s value is one cycle late even with forwarding', () => {
  const useNext = run('lw t0, 0(sp)\nadd t1, t0, t0\nebreak\n', FWD, { regs: { sp: 0x2000 } }).r;
  assert.equal(useNext.loadUseStalls, 1);
  assert.equal(useNext.cycles, 3 + 4 + 1);
  const gap = run('lw t0, 0(sp)\nnop\nadd t1, t0, t0\nebreak\n', FWD, { regs: { sp: 0x2000 } }).r;
  assert.equal(gap.loadUseStalls, 0);
  assert.equal(gap.cycles, 4 + 4);
  // A nop spends the cycle a stall would have: it removes the stall and not the wait.
  assert.equal(gap.cycles, useNext.cycles);
});

test('hand-worked counts: x0 is never a hazard, and a store reads its data like any source', () => {
  assert.equal(run('addi zero, zero, 1\nadd t0, zero, zero\nebreak\n', NOFWD).r.dataStalls, 0);
  assert.equal(run('lw t0, 0(sp)\nsw t0, 4(sp)\nebreak\n', FWD, { regs: { sp: 0x2000 } }).r.loadUseStalls, 1);
});

test('hand-worked counts: a taken branch costs two cycles under not-taken, and a jump always does', () => {
  const taken = run('beq zero, zero, x\nnop\nx: ebreak\n', FWD).r;
  assert.equal(taken.instructions, 2);
  assert.equal(taken.mispredicts, 1);
  assert.equal(taken.cycles, 2 + 4 + 2);
  const untaken = run('bne zero, zero, x\nnop\nx: ebreak\n', FWD).r;
  assert.equal(untaken.mispredicts, 0);
  assert.equal(untaken.cycles, 3 + 4);
  assert.equal(run('bne zero, zero, x\nnop\nx: ebreak\n', { forwarding: true, predictor: 'stall' }).r.cycles, 3 + 4 + 2, 'no guessing: it waits either way');
  const jump = run('j x\nnop\nx: ebreak\n', FWD).r;
  assert.equal(jump.jumps, 1);
  assert.equal(jump.cycles, 2 + 4 + 2);
});

test('the total is always instructions + 4 + stalls + 2 for each flush', () => {
  for (const p of PIPE_PROGRAMS) {
    for (const forwarding of [true, false]) {
      for (const predictor of ['stall', 'not-taken', 'one-bit', 'two-bit'] as Predictor[]) {
        const opts: MachineOptions = p.usesData ? { words: dataWords('shuffled') } : p.id === 'reorder' ? REORDER_OPTS : {};
        const { r } = run(p.src, { forwarding, predictor }, opts);
        assert.equal(r.cycles, r.instructions + 4 + r.dataStalls + r.flushCycles, `${p.id} ${forwarding} ${predictor}`);
        assert.equal(r.flushCycles, 2 * (r.mispredicts + r.jumps));
      }
    }
  }
});

test('stalls change the bill and never the answer', () => {
  for (const p of PIPE_PROGRAMS) {
    const opts: MachineOptions = p.usesData ? { words: dataWords('sorted') } : p.id === 'reorder' ? REORDER_OPTS : {};
    const a = run(p.src, FWD, opts), b = run(p.src, { forwarding: false, predictor: 'two-bit' }, opts);
    assert.deepEqual([...a.m.regs], [...b.m.regs], p.id);
    assert.ok(b.r.cycles >= a.r.cycles || p.id === 'nested');
  }
});

test('with no hazard handling, the same instructions give the wrong answer, and say nothing', () => {
  const right = run(HAZARD_DEMO, FWD).m;
  assert.deepEqual(['t0', 't1', 't2', 'a0'].map((n) => right.reg(n)), [5, 6, 7, 8]);
  const wrong = runUnprotected(HAZARD_DEMO);
  assert.ok(wrong.ok);
  assert.deepEqual(['t0', 't1', 't2', 'a0'].map((n) => wrong.machine.reg(n)), [5, 1, 1, 1]);
  assert.equal(wrong.machine.status, 'stopped');
  // Far enough apart, they don't collide: 3 instruction slots later, the write has landed.
  const spaced = runUnprotected('li t0, 5\nnop\nnop\naddi a0, t0, 1\nebreak\n');
  assert.ok(spaced.ok);
  assert.equal(spaced.machine.reg('a0'), 6);
  // And a reader two slots later still misses it, which is why the nops above are two.
  const close = runUnprotected('li t0, 5\nnop\naddi a0, t0, 1\nebreak\n');
  assert.ok(close.ok);
  assert.equal(close.machine.reg('a0'), 1);
});

test('the reorder mission: exact cycles, and the shortcuts fail on hidden values', () => {
  assert.equal(run(REORDER_STARTER, FWD, REORDER_OPTS).r.cycles, 14);
  assert.equal(run(REORDER_STARTER, FWD, REORDER_OPTS).r.loadUseStalls, 2);
  const starter = judgeReorder(REORDER_STARTER);
  assert.ok(!starter.ok && /14 cycles/.test(starter.why));
  const good = `lw t1, 0(a0)\nlw t2, 4(a0)\nlw t4, 8(a0)\nadd t3, t1, t2\nsw t3, 12(a0)\nadd t5, t1, t4\nsw t5, 16(a0)\nebreak\n`;
  assert.deepEqual(judgeReorder(good), { ok: true, cycles: 12 });
  // A differently ordered right answer has to pass too.
  const other = `lw t2, 4(a0)\nlw t4, 8(a0)\nlw t1, 0(a0)\nnop\nadd t3, t1, t2\nadd t5, t1, t4\nsw t3, 12(a0)\nsw t5, 16(a0)\nebreak\n`;
  const v2 = judgeReorder(other);
  assert.ok(!v2.ok && /13 cycles/.test(v2.why), 'a nop costs a cycle, so this is right and one over');
  const third = `lw t4, 8(a0)\nlw t2, 4(a0)\nlw t1, 0(a0)\nsw zero, 12(a0)\nadd t3, t1, t2\nsw t3, 12(a0)\nadd t5, t1, t4\nsw t5, 16(a0)\nebreak\n`;
  const v3 = judgeReorder(third);
  assert.ok(!v3.ok, 'nine instructions can\'t be 12 cycles');
  const fourth = `lw t2, 4(a0)\nlw t1, 0(a0)\nlw t4, 8(a0)\nadd t5, t1, t4\nsw t5, 16(a0)\nadd t3, t1, t2\nsw t3, 12(a0)\nret\n`;
  const v4 = judgeReorder(fourth);
  // The load of t4 is right before its use, so this one stalls: the right answer at 13, and ret is a flush too.
  assert.ok(!v4.ok);
  const fifth = `lw t4, 8(a0)\nlw t1, 0(a0)\nlw t2, 4(a0)\nadd t5, t1, t4\nadd t3, t1, t2\nsw t5, 16(a0)\nsw t3, 12(a0)\nebreak\n`;
  assert.deepEqual(judgeReorder(fifth), { ok: true, cycles: 12 }, 'writing the two results in the other order is fine');
  // Shortcuts: delete the work, hard-code the visible answers, swap in stalls for nops.
  const hardcode = `li t0, 30\nsw t0, 12(a0)\nli t0, 40\nsw t0, 16(a0)\nebreak\n`;
  const h = judgeReorder(hardcode);
  assert.ok(!h.ok && /values you can't see/.test(h.why));
  const nops = `lw t1, 0(a0)\nlw t2, 4(a0)\nnop\nadd t3, t1, t2\nsw t3, 12(a0)\nlw t4, 8(a0)\nnop\nadd t5, t1, t4\nsw t5, 16(a0)\nebreak\n`;
  const n = judgeReorder(nops);
  assert.ok(!n.ok && /14 cycles/.test(n.why), 'no stalls left, and no cycles saved');
  const refused = judgeReorder('frob\n');
  assert.ok(!refused.ok && /line 1/.test(refused.why));
});

test('branch prediction: the exact counts the lesson quotes', () => {
  const on = (data: 'shuffled' | 'sorted', predictor: Predictor) => run(BRANCH_LOOP, { forwarding: true, predictor }, { words: dataWords(data) }).r;
  const counts = (r: ReturnType<typeof on>) => [r.mispredicts, r.cycles];
  assert.deepEqual(counts(on('shuffled', 'stall')), [512, 2704]);
  assert.deepEqual(counts(on('shuffled', 'not-taken')), [376, 2432]);
  assert.deepEqual(counts(on('shuffled', 'one-bit')), [128, 1936]);
  assert.deepEqual(counts(on('shuffled', 'two-bit')), [129, 1938]);
  assert.deepEqual(counts(on('sorted', 'one-bit')), [4, 1688]);
  assert.deepEqual(counts(on('sorted', 'two-bit')), [5, 1690]);
  assert.equal(on('sorted', 'two-bit').instructions, on('shuffled', 'two-bit').instructions, 'same instructions either way');
  // Same values: sorting only reorders them, and the answer can't change.
  assert.deepEqual([...dataset('shuffled')].sort((a, b) => a - b), dataset('sorted'));
  assert.equal(run(BRANCH_LOOP, FWD, { words: dataWords('sorted') }).m.reg('a0'), run(BRANCH_LOOP, FWD, { words: dataWords('shuffled') }).m.reg('a0'));
});

test('two bits beat one on a loop inside a loop: 34 wrong guesses against 19', () => {
  const one = run(NESTED_LOOPS, { forwarding: true, predictor: 'one-bit' }).r;
  const two = run(NESTED_LOOPS, { forwarding: true, predictor: 'two-bit' }).r;
  assert.equal(one.branches, 16 * 8 + 16);
  // One bit: the inner branch is wrong at each exit, and again on the way back in.
  assert.deepEqual([one.mispredicts, two.mispredicts], [34, 19]);
});

test('a program that never ends has no cycle count, and says so', () => {
  const t = traceOf('x: j x\n', { budget: 100 });
  assert.ok(!t.ok && 'fault' in t && /stopped after 100 steps/.test(t.fault));
});

test('the chart draws the classic diagram, and says when it\'s clipped', () => {
  const { r } = run('lw t0, 0(sp)\nadd t1, t0, t0\nebreak\n', FWD, { regs: { sp: 0x2000 } });
  const c = chart(r.rows);
  assert.deepEqual(c.rows[0].cells.slice(0, 5), ['IF', 'ID', 'EX', 'MEM', 'WB']);
  assert.deepEqual(c.rows[1].cells.slice(1, 7), ['IF', 'ID', 'stall', 'EX', 'MEM', 'WB']);
  assert.deepEqual(c.rows[2].cells.slice(2, 8), ['IF', 'wait', 'ID', 'EX', 'MEM', 'WB']);
  const big = run(BRANCH_LOOP, FWD, { words: dataWords('shuffled') }).r;
  const clipped = chart(big.rows);
  assert.ok(clipped.clippedRows);
  assert.equal(clipped.rows.length, 24);
});

test('a separate cycle-by-cycle simulator in real Python gets the same cycles, stalls and flushes', () => {
  const programs: { name: string; src: string; opts: MachineOptions }[] = [
    ...PIPE_PROGRAMS.map((p) => ({ name: p.id, src: p.src, opts: p.usesData ? { words: dataWords('shuffled') } : p.id === 'reorder' ? REORDER_OPTS : {} })),
    { name: 'loop sorted', src: BRANCH_LOOP, opts: { words: dataWords('sorted') } },
    { name: 'calls', src: `li a0, 6\ncall f\nebreak\nf: beqz a0, b\naddi sp, sp, -8\nsw ra, 4(sp)\nsw a0, 0(sp)\naddi a0, a0, -1\ncall f\nlw t0, 0(sp)\nadd a0, a0, t0\nlw ra, 4(sp)\naddi sp, sp, 8\nret\nb: ret\n`, opts: {} },
    { name: 'mixed', src: `li t0, 0x2000\nli t1, 7\nsw t1, 0(t0)\nlw t2, 0(t0)\nadd t3, t2, t2\nlw t4, 0(t0)\nsw t4, 4(t0)\nbeq t3, t4, x\nsub t5, t3, t4\nlb a0, 0(t0)\nsll a1, a0, a0\nx: j y\nnop\ny: ebreak\n`, opts: {} },
  ];
  type Row = { kind: string; rd: number; srcs: number[]; pc: number; taken: boolean };
  const shape = (t: StepRecord): Row => ({
    kind: /^(lb|lh|lw|lbu|lhu)$/.test(t.d.op) ? 'load' : t.d.fmt === 'B' ? 'branch' : t.d.op === 'jal' || t.d.op === 'jalr' ? 'jump' : 'other',
    rd: t.regWrite && t.regWrite.reg ? t.regWrite.reg : 0, srcs: sourcesOf(t.d), pc: t.pc, taken: !!t.taken,
  });
  const jobs: { program: string; cfg: PipeConfig; trace: Row[] }[] = [];
  const results: number[][] = [];
  for (const p of programs) {
    const t = traceOf(p.src, p.opts);
    assert.ok(t.ok, p.name);
    const trace = t.trace.map(shape);
    for (const forwarding of [true, false]) for (const predictor of ['stall', 'not-taken', 'one-bit', 'two-bit'] as Predictor[]) {
      const cfg = { forwarding, predictor };
      jobs.push({ program: p.name, cfg, trace });
      const r = schedule(t.trace, cfg);
      results.push([r.cycles, r.dataStalls, r.mispredicts + r.jumps]);
    }
  }
  const out = python(`
import json, sys

def guess_for(pred, table, pc, went):
    if pred == "stall":
        return not went
    if pred == "not-taken":
        return False
    if pred == "one-bit":
        g = table.get(pc, False)
        table[pc] = went
        return g
    c = table.get(pc, 1)
    table[pc] = min(3, c + 1) if went else max(0, c - 1)
    return c >= 2

def simulate(trace, forwarding, pred):
    # Slots hold an index into the trace, or None for a bubble. Wrong-path fetches are bubbles
    # that were never going to reach WB, which is what flushing them amounts to.
    IF = ID = EX = MEM = WB = None
    next_i = 0
    done = 0
    cycle = 0
    stalls = 0
    flushes = 0
    resume_after_flush = False
    table = {}
    n = len(trace)
    hold_fetch = 0
    while done < n:
        cycle += 1
        # A wrong guess is discovered when the instruction has just done EX, last cycle.
        flush_now = False
        if EX is not None and trace[EX]["kind"] in ("branch", "jump"):
            t = trace[EX]
            if t["kind"] == "jump":
                flush_now = True
            else:
                flush_now = guess_for(pred, table, t["pc"], t["taken"]) != t["taken"]
        # Advance from the back, deciding first whether ID has to wait.
        new_WB = MEM
        new_MEM = EX
        must_wait = False
        if ID is not None and not flush_now:
            need = set(trace[ID]["srcs"])
            if forwarding:
                if EX is not None and trace[EX]["kind"] == "load" and trace[EX]["rd"] in need:
                    must_wait = True
            else:
                for slot in (EX, MEM):
                    if slot is not None and trace[slot]["rd"] != 0 and trace[slot]["rd"] in need:
                        must_wait = True
        if must_wait:
            stalls += 1
            new_EX, new_ID, new_IF = None, ID, IF
        else:
            new_EX = ID
            new_ID = IF
            new_IF = None
        if flush_now:
            flushes += 1
            # The two slots behind it held the wrong path. This trace only holds the right path,
            # so what they held is put back to be fetched again, two cycles later than it could have been.
            behind = [s for s in (ID, IF) if s is not None]
            if behind:
                next_i = min(behind)
            new_EX = new_ID = new_IF = None
        if new_IF is None:
            if next_i < n:
                new_IF = next_i
                next_i += 1
        IF, ID, EX, MEM, WB = new_IF, new_ID, new_EX, new_MEM, new_WB
        if WB is not None:
            done += 1
    return cycle, stalls, flushes

for job in json.load(sys.stdin):
    c = job["cfg"]
    print(*simulate(job["trace"], c["forwarding"], c["predictor"]))
`, JSON.stringify(jobs));
  const rows = out.trim().split(/\r?\n/).map((l) => l.split(' ').map(Number));
  assert.equal(rows.length, jobs.length);
  rows.forEach((row, i) => assert.deepEqual(row, results[i], `${jobs[i].program} ${JSON.stringify(jobs[i].cfg)}`));
});

test('the mission plays start to finish, and no tick is lost when the program changes', () => {
  const s: PipeState = PIPE_MISSION.setup();
  const ticks = () => { let n = 0; for (const st of PIPE_MISSION.steps) { if (!st.done(s)) break; n++; } return n; };
  const push = (program: string, src: string, cfg: PipeConfig, opts: MachineOptions, data: 'shuffled' | 'sorted' = 'shuffled') => {
    const t = traceOf(src, opts);
    assert.ok(t.ok);
    s.runs.push({ program, src, cfg, data, result: schedule(t.trace, cfg), a0: t.machine.reg('a0') });
  };
  assert.equal(ticks(), 0);
  push('chain', HAZARD_DEMO, NOFWD, {});
  assert.equal(ticks(), 0, 'one setting isn\'t a comparison');
  push('chain', HAZARD_DEMO, FWD, {});
  assert.equal(ticks(), 1);
  const good = `lw t1, 0(a0)\nlw t2, 4(a0)\nlw t4, 8(a0)\nadd t3, t1, t2\nsw t3, 12(a0)\nadd t5, t1, t4\nsw t5, 16(a0)\nebreak\n`;
  noteReorder(s, REORDER_STARTER);
  assert.equal(ticks(), 1);
  assert.match(PIPE_MISSION.steps[1].why!(s), /14 cycles/);
  noteReorder(s, good);
  assert.equal(ticks(), 2);
  // A typo after finishing must not take the tick away. In the browser, this is what it did.
  noteReorder(s, 'frob\n');
  assert.equal(ticks(), 2);
  push('loop', BRANCH_LOOP, { forwarding: true, predictor: 'two-bit' }, { words: dataWords('shuffled') }, 'shuffled');
  assert.equal(ticks(), 2, 'one data order isn\'t a comparison');
  push('loop', BRANCH_LOOP, { forwarding: true, predictor: 'two-bit' }, { words: dataWords('sorted') }, 'sorted');
  assert.equal(ticks(), 3);
});

const hazardDiff = (src: string) => {
  const right = traceOf(src), wrong = runUnprotected(src);
  assert.ok(right.ok && wrong.ok, src);
  return compareRuns(right.machine, wrong.machine);
};

test('the no-hazard comparison sees memory: a stale store was told it "happens to come out right"', () => {
  // The store reads both registers stale, so it writes 0 to address 0, over the program's own first
  // instruction, and 0x2000 never gets its 7. Every register still ends up right.
  const d = hazardDiff('li t0, 7\nli t1, 0x2000\nsw t0, 0(t1)\nebreak\n');
  assert.equal(d.same, false);
  assert.deepEqual(d.registers, []);
  assert.equal(d.memoryBytes, 4);
  assert.equal(d.memory.length, 2);
  assert.match(d.memory[0], /the word at 0x0000 is 0x00000000, and should be /);
  assert.match(d.memory[1], /the word at 0x2000 is 0x00000000, and should be 0x00000007/);
});

test('the no-hazard comparison sees output: a print of a zero byte in place of A passed the same way', () => {
  const d = hazardDiff("li t1, 0x10000000\nnop\nnop\nli t0, 'A'\nsb t0, 0(t1)\nebreak\n");
  assert.equal(d.same, false);
  assert.deepEqual(d.registers, []);
  assert.equal(d.memoryBytes, 0);
  assert.equal(d.output, 'it printed "\\0", and should have printed "A"');
});

test('the no-hazard comparison still clears what really matches, and says what it compared on the page', () => {
  const d = hazardDiff('li t0, 5\nnop\nnop\nli t1, 1\nnop\nnop\nebreak\n');
  assert.equal(d.same, true);
  const page = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'CpuPipelineLab.astro'), 'utf8');
  assert.match(page, /registers, all of memory, what it printed, and where it stopped/);
  // It never gives the reason it couldn't back.
  assert.doesNotMatch(page, /nothing here reads a register/);
  // And registers that differ are still reported.
  const chain = hazardDiff(HAZARD_DEMO);
  assert.ok(chain.registers.some((r) => /a0 is 1, and should be 8/.test(r)));
});

test('a different ending counts as a difference, not only a different value', () => {
  // Stale t0 is still 0 at the branch, so it stops at the first ebreak, and every register still matches.
  const d = hazardDiff('li t0, 1\nbnez t0, skip\nebreak\nskip:\nli a0, 0\nebreak\n');
  assert.equal(d.same, false);
  assert.deepEqual(d.registers, []);
  assert.equal(d.ending, 'it ended at 0x0008 (stopped), and should have ended at 0x0010 (stopped)');
});

test('"one surprise doesn\'t flip the guess" is only true at the ends: an alternating branch beats two bits every time', () => {
  // Starts at the counter's weak not-taken. Taken, not taken, taken, and so on keeps it either side of the middle.
  const t = traceOf(`li t0, 12\nli t1, 0\nloop:\nxori t1, t1, 1\nbnez t1, skip\nnop\nskip:\naddi t0, t0, -1\nbnez t0, loop\nebreak\n`);
  assert.ok(t.ok);
  const data = t.trace.filter((r) => r.d.fmt === 'B' && r.line === 5);
  assert.deepEqual(data.slice(0, 4).map((r) => !!r.taken), [true, false, true, false]);
  const two = schedule(data, { forwarding: true, predictor: 'two-bit' });
  assert.equal(two.branches, 12);
  assert.equal(two.mispredicts, 12, 'wrong every single time');
  // From a strong state one surprise really doesn't flip it: a branch taken a lot, then one miss.
  const loop = traceOf('li t0, 8\nl:\naddi t0, t0, -1\nbnez t0, l\nli t0, 8\nm:\naddi t0, t0, -1\nbnez t0, m\nebreak\n');
  assert.ok(loop.ok);
  const strong = schedule(loop.trace, { forwarding: true, predictor: 'two-bit' });
  assert.equal(strong.branches, 16);
  assert.equal(strong.mispredicts, 4, 'the first guess and the exit of each loop, and nothing in between');
  const lesson = readFileSync(join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'computer', 'pipelining.mdx'), 'utf8');
  assert.doesNotMatch(lesson, /One surprise doesn't flip the guess\./);
  assert.match(lesson, /alternating can fool it every time/);
});

test('the patching program runs here at the cycle count the lesson states, which is the limit of this model', () => {
  const lesson = readFileSync(join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'computer', 'toy-cpu.mdx'), 'utf8');
  const src = /<MachineLab code=\{`(# 0x02950513[\s\S]*?)`\}/.exec(lesson)![1];
  const t = traceOf(src);
  assert.ok(t.ok);
  assert.equal(t.machine.reg('a0'), 42);
  assert.equal(schedule(t.trace, FWD).cycles, 12);
});

test('the loop step survives an edit: one added comment left it unticked with no reason given', () => {
  const s: PipeState = PIPE_MISSION.setup();
  const step = PIPE_MISSION.steps[2];
  const push = (src: string, data: 'shuffled' | 'sorted', predictor: Predictor = 'two-bit') => {
    const t = traceOf(src, { words: dataWords(data) });
    assert.ok(t.ok);
    const cfg = { forwarding: true, predictor };
    s.runs.push({ program: 'loop', src, cfg, data, result: schedule(t.trace, cfg), a0: t.machine.reg('a0') });
  };
  const edited = `# my own note\n${BRANCH_LOOP}\n`;
  push(edited, 'shuffled');
  assert.equal(step.done(s), false, 'one data order isn\'t a comparison');
  push(BRANCH_LOOP, 'sorted');
  assert.equal(step.done(s), false, 'two different programs aren\'t one either');
  assert.match(step.why!(s), /different programs/);
  push(edited, 'sorted');
  assert.equal(step.done(s), true);
  assert.equal(step.why!(s), '');
  // A program with no branch on its data has nothing to show, and says why instead of staying silent.
  const flat: PipeState = PIPE_MISSION.setup();
  const noBranch = 'li a0, 1\nebreak\n';
  for (const data of ['shuffled', 'sorted'] as const) {
    const t = traceOf(noBranch, { words: dataWords(data) });
    assert.ok(t.ok);
    const cfg = { forwarding: true, predictor: 'two-bit' as Predictor };
    flat.runs.push({ program: 'loop', src: noBranch, cfg, data, result: schedule(t.trace, cfg), a0: 1 });
  }
  assert.equal(step.done(flat), false);
  assert.match(step.why!(flat), /didn't come out with more wrong guesses/);
});
