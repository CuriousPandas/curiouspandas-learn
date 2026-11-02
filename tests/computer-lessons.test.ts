// What six lessons on How a Machine Computes say, held to something that runs. Every number
// here is one a lesson states. The Python samples go through this site's engine and real Python,
// and the lesson-level claims go through the models they describe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, runSource, STACK_BASE, STACK_TOP } from '../src/lib/cs/riscv.ts';
import { MACHINE_MISSIONS } from '../src/lib/cs/machine-missions.ts';
import { HAZARD_DEMO, judgeReorder, REORDER_ADDR, REORDER_STARTER, REORDER_VISIBLE, schedule, traceOf } from '../src/lib/cs/pipeline.ts';
import { DEFAULT_CONFIG, runPattern } from '../src/lib/cs/cache.ts';
import { PyProgram } from '../src/lib/py/vm.ts';
import { runPython } from './helpers/python.ts';

const SLUGS = ['clocks-and-memory', 'toy-cpu', 'assembly', 'pipelining', 'caches', 'latency-numbers'];
const read = (slug: string) => readFileSync(join(import.meta.dirname, '..', 'src', 'content', 'lessons', 'computer', `${slug}.mdx`), 'utf8');
/** Pulls a MachineLab program out of a lesson, as the lab will see it, by something unique in it. */
function sample(slug: string, marker: string): string {
  const all = [...read(slug).matchAll(/<MachineLab[^>]*?code=\{`([\s\S]*?)`\}/g)].map((m) => m[1].replace(/\\\\/g, '\\'));
  const hit = all.filter((s) => s.includes(marker));
  assert.equal(hit.length, 1, `${slug}: ${hit.length} samples contain "${marker}"`);
  return hit[0];
}

test('every Python sample in these lessons prints the same here as in real Python', () => {
  let count = 0;
  for (const slug of SLUGS) {
    const text = read(slug);
    const samples = [...text.matchAll(/<CodeLab code=\{`([\s\S]*?)`\}/g)].map((m) => m[1]);
    samples.push(...[...text.matchAll(/```python\n([\s\S]*?)```/g)].map((m) => m[1]));
    for (const src of samples) {
      count++;
      const p = new PyProgram(src);
      p.run();
      assert.equal(p.status, 'done', `${slug}: ${src}`);
      const real = runPython(src);
      assert.equal(real.status, 0, real.stderr);
      assert.equal(p.stdout, real.stdout, `${slug}: ${src}`);
    }
  }
  assert.equal(count, 2);
});

test('toy-cpu: add a0, a0, a1 is the word and the fields the lesson prints', () => {
  const a = assemble('add a0, a0, a1\n');
  assert.ok(a.ok);
  assert.equal(a.program.listing[0].word, 0x00b50533);
  assert.equal(a.program.listing[0].word.toString(2).padStart(32, '0'), `0000000${'01011'}${'01010'}000${'01010'}0110011`);
  const text = read('toy-cpu');
  assert.ok(text.includes('0x00b50533'));
  assert.ok(text.includes('0000000  01011  01010  000     01010  0110011'));
});

test('toy-cpu: the patched nop gives 42, and bad bits are refused with the address', () => {
  const src = sample('toy-cpu', 'patch:');
  const r = runSource(src);
  assert.ok(r.ok);
  assert.equal(r.machine.reg('a0'), 42);
  const broken = runSource(src.replace('li t0, 0x02950513', 'li t0, 0xffffffff'));
  assert.ok(broken.ok);
  assert.equal(broken.machine.status, 'fault');
  assert.match(broken.machine.fault!.message, /aren't an instruction/);
});

test('toy-cpu: says what von Neumann wrote, and not "nothing marks it as code" in his name', () => {
  // The draft gives every word a bit for number or order, and the lesson attributed the opposite to it.
  const text = read('toy-cpu');
  assert.doesNotMatch(text, /Nothing marks it as code\./);
  assert.match(text, /"each minor cycle must contain a distinguishing mark which indicates whether it is a standard number or an order"/);
  assert.match(text, /"i₀ = 0 is to designate a standard number, and i₀ = 1 an order"/);
  assert.match(text, /"come from M, i\.e\. from the same place where the numerical material is stored"/);
  assert.doesNotMatch(text, /That's the stored-program idea/);
  // The mission's debrief repeats the point, so it has to keep the qualifier too.
  assert.match(MACHINE_MISSIONS['cpu-count-up'].debrief, /on this machine, nothing in memory says which bytes are code/);
});

test('toy-cpu: every instruction in the table above the mission really runs here', () => {
  const r = runSource(`li t0, 3
mv t1, t0
add t2, t0, t1
addi t2, t2, 1
beq t0, t1, a
ebreak
a: bne t0, t2, b
ebreak
b: blt t0, t2, c
ebreak
c: ble t0, t1, d
ebreak
d: bgt t2, t0, e
ebreak
e: bge t2, t0, f
ebreak
f: j g
ebreak
g: la t3, total
sw t2, 0(t3)
lw a0, 0(t3)
ebreak
.data
total: .word 0
`);
  assert.ok(r.ok);
  assert.equal(r.machine.status, 'stopped');
  assert.equal(r.machine.reg('a0'), 7);
  assert.equal(r.machine.steps, 16, 'it took every branch rather than stopping early');
});

test('assembly: the loop gets the same total as the Python beside it, and refuses to spin on a negative n', () => {
  const src = sample('assembly', 'skipping 3');
  const r = runSource(src);
  assert.ok(r.ok);
  assert.equal(r.machine.reg('a0'), 12);
  // beqz spun to the step budget here, where Python's while n > 0 runs no times at all.
  const negative = runSource(src.replace('li t0, 5', 'li t0, -1'));
  assert.ok(negative.ok);
  assert.equal(negative.machine.status, 'stopped');
  assert.equal(negative.machine.reg('a0'), 0);
  const py = runPython('total = 0\nn = -1\nwhile n > 0:\n    if n != 3:\n        total = total + n\n    n = n - 1\nprint(total)\n');
  assert.equal(py.stdout.trim(), '0');
});

test('assembly: no more claims that a callee saves registers it never touches', () => {
  const text = read('assembly');
  assert.doesNotMatch(text, /saves registers it never touches/);
  assert.doesNotMatch(text, /ran code it had never been given/);
  assert.match(text, /"the stack pointer shall be aligned to a 128-bit boundary upon procedure entry"/);
  assert.match(text, /"must remain aligned throughout procedure execution"/);
});

test('assembly: double works twice, with no frame at all', () => {
  const r = runSource(sample('assembly', 'double(x)'));
  assert.ok(r.ok);
  assert.equal(r.machine.reg('a0'), 20);
  assert.equal(r.machine.lowestSp, 0x10000);
});

test('assembly: the runaway call stops after 2,048 calls of 16 bytes, at the sw', () => {
  const src = sample('assembly', 'No base case');
  const r = runSource(src);
  assert.ok(r.ok);
  assert.equal(r.machine.status, 'fault');
  assert.match(r.machine.fault!.message, /guard area/);
  assert.equal(r.machine.frames.length, 2048);
  assert.equal((STACK_TOP - STACK_BASE) / 16, 2048);
  assert.ok(read('assembly').includes('2,048 calls'));
  // A frame the convention wouldn't allow, in a lesson that teaches the convention, was the bug.
  for (const m of read('assembly').matchAll(/addi sp, sp, -(\d+)/g)) assert.equal(Number(m[1]) % 16, 0, m[0]);
  assert.match(src.split('\n')[r.machine.fault!.line - 1], /sw ra/);
});

test('assembly: three words is fine, and a fourth takes over the return', () => {
  const src = sample('assembly', 'never_called');
  const safe = runSource(src, { regs: { a1: 3 } });
  assert.ok(safe.ok);
  assert.equal(safe.machine.output, 'K');
  const over = runSource(src, { regs: { a1: 4 } });
  assert.ok(over.ok);
  assert.equal(over.machine.output, 'X');
  assert.equal(over.machine.status, 'stopped', 'and nothing reported an error');
  // The lesson names the line the saved return address points at.
  assert.ok(read('assembly').includes('"a return to line 4"'));
  assert.match(src.split('\n')[3], /li t0, 0x10000000/);
  assert.match(src.split('\n')[2], /call copy/);
});

test('assembly: it prints through the output address', () => {
  const r = runSource(sample('assembly', 'Hello, panda'));
  assert.ok(r.ok);
  assert.equal(r.machine.output, 'Hello, panda\n');
});

test('pipelining: the go-deeper arithmetic is what the model gives', () => {
  const opts = { regs: { a0: REORDER_ADDR }, words: [{ addr: REORDER_ADDR, values: REORDER_VISIBLE }] };
  const cfg = { forwarding: true, predictor: 'not-taken' as const };
  const cost = (src: string) => { const t = traceOf(src, opts); assert.ok(t.ok); return schedule(t.trace, cfg); };
  const before = cost(REORDER_STARTER);
  assert.deepEqual([before.instructions, before.cycles, before.cpi], [8, 14, 1.75]);
  const after = cost(`lw t1, 0(a0)\nlw t2, 4(a0)\nlw t4, 8(a0)\nadd t3, t1, t2\nsw t3, 12(a0)\nadd t5, t1, t4\nsw t5, 16(a0)\nebreak\n`);
  assert.deepEqual([after.instructions, after.cycles, after.cpi], [8, 12, 1.5]);
  const nops = cost(`lw t1, 0(a0)\nlw t2, 4(a0)\nnop\nadd t3, t1, t2\nsw t3, 12(a0)\nlw t4, 8(a0)\nnop\nadd t5, t1, t4\nsw t5, 16(a0)\nebreak\n`);
  assert.deepEqual([nops.instructions, nops.cycles, nops.cpi], [10, 14, 1.4]);
  assert.ok(judgeReorder(REORDER_STARTER).ok === false);
  const off = traceOf(HAZARD_DEMO);
  assert.ok(off.ok);
  assert.equal(schedule(off.trace, { forwarding: false, predictor: 'not-taken' }).cpi, 3);
});

test('caches: the numbers the lesson quotes from the model', () => {
  const on = { ...DEFAULT_CONFIG, prefetch: true };
  const inOff = runPattern('walk-order', 256, 1, DEFAULT_CONFIG).result, inOn = runPattern('walk-order', 256, 1, on).result;
  const scOff = runPattern('walk-scattered', 256, 1, DEFAULT_CONFIG).result, scOn = runPattern('walk-scattered', 256, 1, on).result;
  assert.equal(inOn.misses * 2, inOff.misses);
  assert.deepEqual([scOff.misses, scOn.misses, scOff.misses - scOn.misses, scOn.prefetches], [57800, 57517, 283, 53100]);
  const text = read('caches');
  assert.ok(text.includes('fetched 53,100 extra lines to save 283 misses'));
  // AMAT arithmetic in the go-deeper.
  assert.equal(0.5 + (8192 / 131072) * 100, 6.75);
  assert.equal(0.5 + 0.05 * (7 + 0.2 * 100), 1.85);
});

test('caches: the title is a labelled measurement, and every figure in its table is in the range it says', () => {
  // The raw runs, all on 2026-11-01, on a Xeon E5-2695 v3 in Node 24. No test can repeat them, so
  // this holds the lesson's table to what was recorded: a reader's check that nothing was rounded
  // towards the title. Set A gave 48x to 52x, and a rerun gave 43x to 46x, which is why it says "a
  // round figure" and not "exactly". Set C had eight other walks running alongside on purpose.
  const runs: Record<string, Record<'B' | 'C', [number, number][]>> = {
    '1,000,000': { B: [[2.19, 23.3], [2.18, 23.4], [2.24, 21.8]], C: [[2.28, 23.7], [2.25, 23.3], [2.23, 23.1]] },
    '4,000,000': { B: [[2.33, 70.7], [2.28, 41.8], [2.29, 50.0]], C: [[2.29, 90.8], [2.4, 93.1], [2.33, 91.1]] },
    '16,000,000': { B: [[2.3, 99.8], [2.23, 101.6], [2.28, 100.2]], C: [[2.3, 110.2], [2.28, 125.8], [2.32, 112.2]] },
    '64,000,000': { B: [[2.31, 127.4], [2.31, 124.5], [2.33, 126.5]], C: [[2.33, 126.2], [2.35, 131.1], [2.28, 128.5]] },
  };
  const setA16M = [[2.49, 128.0], [2.71, 130.3], [2.43, 121.9]];
  const ratios = (k: string, set: 'B' | 'C') => runs[k][set].map(([a, b]) => b / a);
  const within = (rs: number[], lo: number, hi: number) => rs.forEach((r) => assert.ok(r >= lo - 0.5 && r <= hi + 0.5, `${r} outside ${lo} to ${hi}`));
  within(setA16M.map(([a, b]) => b / a), 48, 52);
  within(ratios('16,000,000', 'B'), 43, 46);
  within(ratios('16,000,000', 'C'), 48, 55);
  within(ratios('4,000,000', 'B'), 18, 30);
  within(ratios('4,000,000', 'C'), 39, 40);
  within(ratios('1,000,000', 'B'), 9.7, 10.7);
  within(ratios('64,000,000', 'B'), 54, 55);
  within(ratios('64,000,000', 'C'), 54, 57);
  const text = read('caches');
  for (const cell of ['**48x to 52x**', '**43x to 46x**', '**48x to 55x**', '| 18x to 30x |', '| 39x to 40x |', '| 9.7x to 10.7x |']) assert.ok(text.includes(cell), cell);
  assert.ok(text.includes('Xeon E5-2695 v3'));
  assert.ok(text.includes('2026-11-01'));
  // The range the page states for the title's case is the widest of the three sets.
  assert.ok(text.includes('Across all nine runs, the gap at that size was 43x to 55x'));
  // "Order stops mattering when data fits" read as "fits in the cache", against this same table.
  assert.doesNotMatch(text, /order stops mattering when data fits, and/);
  assert.match(text, /Fitting in the cache doesn't end the gap/);
  assert.doesNotMatch(text, /no difference at all|no gap at all/);
  assert.doesNotMatch(text, /and we know which/);
});

test('latency: the ratio the lesson states is the ratio of the numbers it states', () => {
  const text = read('latency-numbers');
  assert.equal(100 / 0.5, 200);
  assert.doesNotMatch(text, /(about|around) a hundred times slower/);
  assert.equal((text.match(/two hundred times slower than the fastest cache/g) ?? []).length, 2);
  // 270 MB/s, from the Seagate sheet, for the table's 1 MB row.
  assert.equal(Math.round((1 / 270) * 10000) / 10, 3.7);
  // Micron's document server refused every direct request. The page has to say that figure is second-hand.
  assert.match(text, /second-hand/);
  assert.doesNotMatch(text, /7450-nvme-ssd-product-brief/);
});

test('no lesson here promises a lesson that isn\'t written, or uses a link to one', () => {
  for (const slug of SLUGS) {
    for (const m of read(slug).matchAll(/\]\(\/learn\/([\w-]+\/[\w-]+)\/?\)/g)) {
      const [track, lesson] = m[1].split('/');
      const path = join(import.meta.dirname, '..', 'src', 'content', 'lessons', track, `${lesson}.mdx`);
      assert.doesNotThrow(() => readFileSync(path), `${slug} links to ${m[1]}`);
    }
  }
});

test('no em dashes in these lessons, as the brief asks', () => {
  for (const slug of SLUGS) assert.equal(read(slug).includes('—'), false, slug);
});
