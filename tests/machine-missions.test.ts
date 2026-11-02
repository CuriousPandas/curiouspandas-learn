// Each machine mission played start to finish, judged as the panel judges it: every step, in
// order, against all the runs so far. Then the shortcuts, which must fail, and programs shaped
// differently from the hints, which must pass. A lost tick costs XP nobody can earn, and a
// program that hard-codes the visible answer earning it would make the mission mean nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CALL_STARTER, COUNT_STARTER, MACHINE_MISSIONS, describeEffect, parseInputs, playRun, statusLine, type MachineState } from '../src/lib/cs/machine-missions.ts';
import { assemble, Machine } from '../src/lib/cs/riscv.ts';

const LESSONS = ['toy-cpu', 'assembly'];
const read = (slug: string) => readFileSync(join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'computer', `${slug}.mdx`), 'utf8');

function ticks(id: string, s: MachineState) {
  let n = 0;
  for (const st of MACHINE_MISSIONS[id].steps) { if (!st.done(s)) break; n++; }
  return n;
}
function play(id: string, stages: { src: string; regs?: Record<string, number> }[]) {
  const s: MachineState = MACHINE_MISSIONS[id].setup();
  const seen: number[] = [];
  for (const { src, regs } of stages) {
    s.runs.push(playRun(src, regs).run);
    seen.push(ticks(id, s));
  }
  return { s, seen };
}
const after = (id: string, src: string, regs?: Record<string, number>) => ticks(id, { runs: [playRun(src, regs).run] });
/** Ticks once the learner has seen the starter hang, which is where anyone fixing it has come from. */
const afterStarter = (src: string) => ticks('asm-calls', { runs: [playRun(CALL_STARTER).run, playRun(src).run] });

const COUNT_FIXED = COUNT_STARTER.replace('bge t1, a0, done', 'bgt t1, a0, done');
const COUNT_STORED = COUNT_FIXED.replace('    mv a0, t0\n', '    mv a0, t0\n    la t2, total\n    sw t0, 0(t2)\n');
const WITH_DATA = '\n.data\ntotal: .word 0\n';

const SUM_REC = `sum_to:
    beqz a0, base
    addi sp, sp, -16
    sw ra, 12(sp)
    sw s0, 8(sp)
    mv s0, a0
    addi a0, a0, -1
    call sum_to
    add a0, a0, s0
    lw s0, 8(sp)
    lw ra, 12(sp)
    addi sp, sp, 16
    ret
base:
    ret
`;
const FIB_REC = `fib:
    li t0, 2
    blt a0, t0, fib_small
    addi sp, sp, -16
    sw ra, 12(sp)
    sw s0, 8(sp)
    sw s1, 4(sp)
    mv s0, a0
    addi a0, s0, -1
    call fib
    mv s1, a0
    addi a0, s0, -2
    call fib
    add a0, a0, s1
    lw s1, 4(sp)
    lw s0, 8(sp)
    lw ra, 12(sp)
    addi sp, sp, 16
fib_small:
    ret
`;
const MAIN = 'main:\n    li a0, 4\n    call sum_to\n    ebreak\n\n';

test('every mission on the toy-cpu and assembly lessons has a test below', () => {
  const inLessons = LESSONS.flatMap((slug) => [...read(slug).matchAll(/<MachineLab[^>]*mission="([^"]+)"/g)].map((m) => m[1]));
  assert.deepEqual(inLessons.sort(), Object.keys(MACHINE_MISSIONS).sort());
});

test('cpu-count-up plays start to finish, and no tick is ever lost', () => {
  const { seen } = play('cpu-count-up', [{ src: COUNT_STARTER, regs: { a0: 5 } }, { src: COUNT_FIXED, regs: { a0: 5 } }, { src: COUNT_STORED, regs: { a0: 5 } }]);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('the starter is wrong in the way the mission says: 10 for n = 5', () => {
  const r = playRun(COUNT_STARTER, { a0: 5 });
  assert.equal(r.machine!.reg('a0'), 10);
  assert.equal(r.run.backJump, true);
  assert.equal(playRun(COUNT_FIXED, { a0: 5 }).machine!.reg('a0'), 15);
});

test('cpu-count-up: someone who gets it right first time isn\'t stranded', () => {
  assert.equal(after('cpu-count-up', COUNT_STORED, { a0: 5 }), 3);
  const { seen } = play('cpu-count-up', [{ src: COUNT_STORED, regs: { a0: 5 } }]);
  assert.deepEqual(seen, [3]);
  // With the input box emptied, a0 is 0 and the loop never jumps back. That run can't tick step 1, and it says nothing false.
  assert.equal(after('cpu-count-up', COUNT_STORED), 0);
});

test('cpu-count-up: tempting shortcuts fail on the hidden inputs', () => {
  const shortcuts: [string, string, number][] = [
    ['hard-code the visible answer', 'li a0, 15\nebreak\n', 0],
    ['a back-jump, then the visible answer', 'li t0, 2\nagain:\naddi t0, t0, -1\nbeqz t0, out\nj again\nout:\nli a0, 15\nebreak\n', 1],
    ['special-case 5, and be wrong otherwise', `li t0, 5\nbeq a0, t0, five\nmv t1, a0\nback:\nebreak\nfive:\nli a0, 15\nj back\n`, 1],
    ['the off-by-one the other way', COUNT_STARTER.replace('li t1, 1 ', 'li t1, 0 '), 1],
    ['adds n itself but forgets n = 0', COUNT_FIXED.replace('li t0, 0 ', 'li t0, 1 '), 1],
    ['stores the wrong word', COUNT_FIXED.replace('    mv a0, t0\n', '    mv a0, t0\n    la t2, total\n    sw t1, 0(t2)\n'), 2],
    ['stores but loses a0', COUNT_FIXED.replace('    mv a0, t0\n', '    la t2, total\n    sw t0, 0(t2)\n'), 1],
  ];
  for (const [name, src, want] of shortcuts) assert.equal(after('cpu-count-up', src, { a0: 5 }), want, name);
});

test('cpu-count-up: differently shaped right answers pass', () => {
  const countDown = `    mv t1, a0\n    li t0, 0\nagain:\n    beqz t1, finished\n    add t0, t0, t1\n    addi t1, t1, -1\n    j again\nfinished:\n    la t2, total\n    sw t0, 0(t2)\n    mv a0, t0\n    ret\n${WITH_DATA}`;
  assert.equal(after('cpu-count-up', countDown, { a0: 5 }), 3);
  // n(n+1)/2 with no multiply instruction: add n to a total n+1 times, then halve it.
  const gauss = `    mv t0, a0\n    addi t1, a0, 1\n    li t2, 0\nm:\n    beqz t1, half\n    add t2, t2, t0\n    addi t1, t1, -1\n    j m\nhalf:\n    srai a0, t2, 1\n    la t3, total\n    sw a0, 0(t3)\n    j home\nhome:\n    li t4, 1\n    bnez t4, end\nend:\n    addi t4, t4, -1\n    ebreak\n${WITH_DATA}`;
  assert.equal(after('cpu-count-up', gauss, { a0: 5 }), 3, 'gauss, which has a loop and a back-jump too');
});

test('asm-calls: the starter really never finishes, and it\'s ra that did it', () => {
  const r = playRun(CALL_STARTER);
  assert.equal(r.run.status, 'budget');
  // After the inner call, ra points at the line after that call, and its own ret goes back there for ever.
  const m = r.machine!;
  assert.equal(CALL_STARTER.split('\n')[m.program.lineOf.get(m.reg('ra') >>> 0)! - 1].trim().startsWith('add a0, a0, s0'), true);
});

test('asm-calls plays start to finish, and no tick is ever lost', () => {
  const full = `${MAIN}${SUM_REC}\n${FIB_REC}`;
  const { seen } = play('asm-calls', [{ src: CALL_STARTER }, { src: `${MAIN}${SUM_REC}\nfib:\n    ret\n` }, { src: full }]);
  assert.deepEqual(seen, [1, 2, 3]);
  const m = playRun(full).machine!;
  assert.equal(m.status, 'stopped');
  assert.equal(m.reg('a0'), 10);
});

test('asm-calls: right first time isn\'t stranded, and a loop is a right answer too', () => {
  assert.equal(after('asm-calls', `${MAIN}${SUM_REC}\n${FIB_REC}`), 3);
  const loopy = `${MAIN}sum_to:\n    li t0, 0\nl1:\n    beqz a0, d1\n    add t0, t0, a0\n    addi a0, a0, -1\n    j l1\nd1:\n    mv a0, t0\n    ret\nfib:\n    li t0, 0\n    li t1, 1\nl2:\n    beqz a0, d2\n    add t2, t0, t1\n    mv t0, t1\n    mv t1, t2\n    addi a0, a0, -1\n    j l2\nd2:\n    mv a0, t0\n    ret\n`;
  assert.equal(after('asm-calls', loopy), 3);
});

test('asm-calls: answers right but manners wrong must fail, with the reason shown', () => {
  const m = MACHINE_MISSIONS['asm-calls'];
  // Saves ra and not s0. The inner calls overwrite the outer n, so even the answer goes wrong.
  const noS0 = `${MAIN}sum_to:\n    beqz a0, base\n    addi sp, sp, -16\n    sw ra, 12(sp)\n    mv s0, a0\n    addi a0, a0, -1\n    call sum_to\n    add a0, a0, s0\n    lw ra, 12(sp)\n    addi sp, sp, 16\n    ret\nbase:\n    ret\nfib:\n    ret\n`;
  assert.equal(afterStarter(noS0), 1);
  const s: MachineState = { runs: [playRun(noS0).run] };
  assert.match(m.steps[1].why!(s), /sum_to\(\d+\)/);
  // A correct answer that uses s1 without saving it.
  const trash = `${MAIN}sum_to:\n    li s1, 0\nl:\n    beqz a0, d\n    add s1, s1, a0\n    addi a0, a0, -1\n    j l\nd:\n    mv a0, s1\n    ret\nfib:\n    ret\n`;
  assert.equal(afterStarter(trash), 1);
  assert.match(m.steps[1].why!({ runs: [playRun(trash).run] }), /changed s1/);
  // Forgets to give the stack back.
  const leak = `${MAIN}sum_to:\n    addi sp, sp, -16\n    li t0, 0\nl:\n    beqz a0, d\n    add t0, t0, a0\n    addi a0, a0, -1\n    j l\nd:\n    mv a0, t0\n    ret\nfib:\n    ret\n`;
  assert.match(m.steps[1].why!({ runs: [playRun(leak).run] }), /give back the stack/);
  // Hard-coded.
  assert.equal(afterStarter(`${MAIN}sum_to:\n    li a0, 10\n    ret\nfib:\n    li a0, 5\n    ret\n`), 1);
  // Stops the whole machine rather than returning.
  assert.match(m.steps[1].why!({ runs: [playRun(`${MAIN}sum_to:\n    ebreak\nfib:\n    ret\n`).run] }), /instead of returning/);
  // Program that doesn't assemble says so.
  const broken: MachineState = { runs: [playRun('frob').run] };
  assert.equal(m.steps[1].done(broken), false);
  assert.match(m.steps[1].why!(broken), /didn't assemble/);
});

test('fib written with a bad base case fails, and its reason names the input', () => {
  const m = MACHINE_MISSIONS['asm-calls'];
  const bad = `${MAIN}${SUM_REC}\n${FIB_REC.replace('li t0, 2', 'li t0, 1')}`;
  assert.equal(afterStarter(bad), 2);
  assert.match(m.steps[2].why!({ runs: [playRun(bad).run] }), /fib\(\d+\)/);
});

test('inputs are refused by name, never ignored', () => {
  assert.deepEqual(parseInputs('a0=5, a1=-3, t0 = 0x10'), { ok: true, regs: { a0: 5, a1: -3, t0: 16 } });
  assert.deepEqual(parseInputs(''), { ok: true, regs: {} });
  for (const [text, re] of [['a0', /can't read/], ['q9=1', /isn't a register/], ['pc=4', /first instruction/], ['zero=1', /always 0/], ['a0=99999999999', /32-bit/]] as const) {
    const r = parseInputs(text);
    assert.ok(!r.ok && re.test(r.why), text);
  }
});

test('the stepper describes each kind of instruction in words', () => {
  const a = assemble(`li a0, 3
add a1, a0, a0
la t0, x
sw a1, 0(t0)
lw a2, 0(t0)
beq a0, a1, end
j end
end:
ebreak
.data
x: .word 0
`);
  assert.ok(a.ok);
  const m = new Machine(a.program);
  const said: string[] = [];
  for (;;) { const r = m.step(); if (r) said.push(describeEffect(r)); if (m.status !== 'ready') break; }
  assert.match(said[0], /a0 goes from 0 to 3/);
  assert.match(said[1], /a1 goes from 0 to 6/);
  assert.ok(said.some((t) => /Write 6 into 4 bytes at 0x2000/.test(t)));
  assert.ok(said.some((t) => /Read 4 bytes at 0x2000, which hold 6/.test(t)));
  assert.ok(said.some((t) => /Compare 3 and 6: not taken/.test(t)));
  assert.ok(said.some((t) => /jumps to/.test(t)));
  assert.match(said.at(-1)!, /Stop here/);
  assert.equal(statusLine(m).kind, 'ok');
});

test('every sample program in the two lessons assembles, so none can rot', () => {
  let count = 0;
  for (const slug of LESSONS) {
    for (const m of read(slug).matchAll(/<MachineLab[^>]*?code=\{`([\s\S]*?)`\}/g)) {
      const src = m[1].replace(/\\\\/g, '\\');
      const a = assemble(src);
      assert.ok(a.ok, `${slug}: ${src}\n${!a.ok ? JSON.stringify(a.errors) : ''}`);
      count++;
    }
  }
  assert.equal(count, 6);
});

test('the convention\'s 16-byte stack: the mission refused nothing and its hint taught 8, against the psABI it cites', () => {
  const m = MACHINE_MISSIONS['asm-calls'];
  // The frame sizes a learner would try. Every one gets the right answer and gives the stack back.
  const frame = (n: number) => `${MAIN}sum_to:\n    beqz a0, base\n    addi sp, sp, -${n}\n    sw ra, ${n - 4}(sp)\n    sw s0, ${n - 8}(sp)\n    mv s0, a0\n    addi a0, a0, -1\n    call sum_to\n    add a0, a0, s0\n    lw s0, ${n - 8}(sp)\n    lw ra, ${n - 4}(sp)\n    addi sp, sp, ${n}\n    ret\nbase:\n    ret\nfib:\n    ret\n`;
  for (const n of [8, 12, 20, 24]) {
    assert.equal(afterStarter(frame(n)), 1, `a ${n}-byte frame`);
    assert.match(m.steps[1].why!({ runs: [playRun(frame(n)).run] }), /isn't a multiple of 16/, `a ${n}-byte frame`);
  }
  for (const n of [16, 32, 48]) assert.equal(afterStarter(frame(n)), 2, `a ${n}-byte frame`);
  // The hint has to pass its own judge, in the words it gives.
  assert.match(m.steps[1].hint!, /addi sp, sp, -16/);
  assert.doesNotMatch(`${m.steps[1].hint} ${m.steps[2].hint}`, /-8\b|-12\b/);
  // Two moves of 8 end up aligned, but sp isn't aligned "throughout" in between, which is the psABI's word.
  const twoSteps = frame(16).replace('addi sp, sp, -16', 'addi sp, sp, -8\n    addi sp, sp, -8');
  assert.equal(afterStarter(twoSteps), 1);
  // A leaf that never touches sp owes nothing, and that's the double from the lesson.
  const leaf = `${MAIN}sum_to:\n    li t0, 0\nl1:\n    beqz a0, d1\n    add t0, t0, a0\n    addi a0, a0, -1\n    j l1\nd1:\n    mv a0, t0\n    ret\nfib:\n    ret\n`;
  assert.equal(afterStarter(leaf), 2);
});

test('gp and tp are reserved: writing them passed before, while the psABI calls them Unallocatable', () => {
  const m = MACHINE_MISSIONS['asm-calls'];
  for (const r of ['gp', 'tp']) {
    const src = SUM_REC.replace('    mv s0, a0\n', `    mv s0, a0\n    li ${r}, 7\n`);
    assert.match(m.steps[1].why!({ runs: [playRun(`${MAIN}${src}\nfib:\n    ret\n`).run] }), new RegExp(`changed ${r}`));
  }
});

test('a table of answers built from the failure messages can\'t pass: both of these did', () => {
  // Every input a failure can name. Before the unnamed inputs, this ticked "right for any n".
  const named = [0, 1, 2, 3, 7, 10, 100, 1000, 2047];
  const branches = named.map((n, i) => `    li t3, ${n}\n    beq a0, t3, is${i}\n`).join('');
  const answers = named.map((n, i) => `is${i}:\n    li a0, ${(n * (n + 1)) / 2}\n    ebreak\n`).join('');
  const table = `${branches}    ebreak\n${answers}\n.data\ntotal: .word 0\n`;
  assert.equal(after('cpu-count-up', table, { a0: 5 }), 0, 'and it never jumps back either');
  const m = MACHINE_MISSIONS['cpu-count-up'];
  assert.equal(m.steps[1].done({ runs: [playRun(table, { a0: 5 }).run] }), false);
  assert.match(m.steps[1].why!({ runs: [playRun(table, { a0: 5 }).run] }), /keeps to itself/);
  // The same for fib, up to the largest input a message can name.
  const fibs = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610];
  const fibTable = `fib:\n${fibs.map((_, i) => `    li t3, ${i}\n    beq a0, t3, f${i}\n`).join('')}    ret\n${fibs.map((v, i) => `f${i}:\n    li a0, ${v}\n    ret\n`).join('')}`;
  assert.equal(afterStarter(`${MAIN}${SUM_REC}\n${fibTable}`), 2);
  assert.match(MACHINE_MISSIONS['asm-calls'].steps[2].why!({ runs: [playRun(`${MAIN}${SUM_REC}\n${fibTable}`).run] }), /keeps to itself/);
  // And a plain recursive fib still fits inside the step budget on the unnamed input.
  assert.equal(after('asm-calls', `${MAIN}${SUM_REC}\n${FIB_REC}`), 3);
});
