// The lessons say this machine is real RV32I, so that has to be checked against something
// that isn't this code. tests/fixtures/rv32-unicorn.json holds what Unicorn (QEMU's CPU core)
// did on 2,220 random single instructions and 40 random programs, and how Capstone (LLVM's
// disassembler) read each word. scripts/gen-rv32-fixture.py wrote it, with its own encoder
// from the manual's tables. The fixture is committed so CI needs no native wheel, and an empty
// or partial one fails here rather than passing on nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assemble, callFunction, decode, disassemble, encode, EXIT_ADDR, fieldsOf, Machine, MEM_SIZE, regIndex, REG_NAMES, runSource, STACK_BASE, STACK_TOP, type Decoded, type Program } from '../src/lib/cs/riscv.ts';

type Case = { op: string; w: number; pc: number; r: Record<string, number>; text: string; m?: [number, number[]]; after: { r: Record<string, number>; pc: number; m?: number[] } };
type Prog = { words: number[]; regs: number[]; mem: number[]; after: number[]; memAfter: number[] };
const fixture = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'rv32-unicorn.json'), 'utf8')) as { cases: Case[]; programs: Prog[] };

const ALL_OPS = ['add', 'addi', 'and', 'andi', 'auipc', 'beq', 'bge', 'bgeu', 'blt', 'bltu', 'bne', 'jal', 'jalr', 'lb', 'lbu', 'lh', 'lhu', 'lui', 'lw', 'or', 'ori', 'sb', 'sh', 'sll', 'slli', 'slt', 'slti', 'sltiu', 'sltu', 'sra', 'srai', 'srl', 'srli', 'sub', 'sw', 'xor', 'xori'];

/** A machine with nothing in it but what a case puts there. */
function blank(): Program {
  return { source: '', bytes: new Uint8Array(MEM_SIZE), labels: new Map(), listing: [], lineOf: new Map(), textEnd: 0, dataEnd: 0, lastLine: 0 };
}

test('the fixture really covers all 37 instructions this machine runs', () => {
  assert.equal(fixture.cases.length, 2220);
  assert.equal(fixture.programs.length, 40);
  assert.deepEqual([...new Set(fixture.cases.map((c) => c.op))].sort(), ALL_OPS);
  for (const op of ALL_OPS) assert.equal(fixture.cases.filter((c) => c.op === op).length, 60, op);
});

test('every word decodes to the instruction Unicorn was given, and encodes back to itself', () => {
  for (const c of fixture.cases) {
    const d = decode(c.w);
    assert.ok(d.ok, `${c.op} ${c.w.toString(16)}`);
    assert.equal(d.d.op, c.op);
    assert.equal(encode(d.d), c.w >>> 0, `${c.op} re-encoded`);
  }
});

test('one instruction at a time, this machine and Unicorn agree on registers, pc and memory', () => {
  for (const c of fixture.cases) {
    const program = blank();
    for (let i = 0; i < 4; i++) program.bytes[c.pc + i] = (c.w >>> (8 * i)) & 0xff;
    const m = new Machine(program, { entry: c.pc });
    m.regs.fill(0);
    for (const [k, v] of Object.entries(c.r)) if (k !== '0') m.regs[Number(k)] = v | 0;
    if (c.m) c.m[1].forEach((b, i) => { m.mem[c.m![0] + i] = b; });
    const rec = m.step();
    const name = `${c.op} ${c.text} (word ${c.w.toString(16)}, regs ${JSON.stringify(c.r)})`;
    assert.ok(rec, `${name}: ${m.fault?.message}`);
    for (let i = 1; i < 32; i++) assert.equal(m.regs[i] >>> 0, c.after.r[String(i)] ?? 0, `${name}: x${i}`);
    assert.equal(m.pc >>> 0, c.after.pc, `${name}: pc`);
    if (c.m) assert.deepEqual([...m.mem.slice(c.m[0], c.m[0] + c.m[1].length)], c.after.m, `${name}: memory`);
  }
});

test('whole random programs end with the same registers and memory as on Unicorn', () => {
  for (const [n, p] of fixture.programs.entries()) {
    const program = blank();
    p.words.forEach((w, k) => { for (let i = 0; i < 4; i++) program.bytes[0x1000 + 4 * k + i] = (w >>> (8 * i)) & 0xff; });
    const m = new Machine(program, { entry: 0x1000 });
    p.regs.forEach((v, i) => { m.regs[i] = v | 0; });
    p.mem.forEach((b, i) => { m.mem[0x3000 + i] = b; });
    const end = 0x1000 + 4 * p.words.length;
    while (m.pc >>> 0 !== end) assert.ok(m.step(), `program ${n}: ${m.fault?.message}`);
    p.after.forEach((v, i) => assert.equal(m.regs[i] >>> 0, v, `program ${n} x${i}`));
    assert.deepEqual([...m.mem.slice(0x3000, 0x3100)], p.memAfter, `program ${n} memory`);
  }
});

test('the assembler turns what Capstone printed back into the same word', () => {
  let checked = 0;
  for (const c of fixture.cases) {
    if (['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'jal'].includes(c.op)) continue;
    // Capstone's aliases, like seqz and li, are the point: each has to come out as the instruction it stands for.
    const got = assemble(c.text);
    assert.ok(got.ok, `"${c.text}": ${!got.ok && got.errors[0].message}`);
    const bytes = got.program.bytes;
    const word = (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    assert.equal(word, c.w >>> 0, `"${c.text}" gave ${word.toString(16)}, wanted ${c.w.toString(16)}`);
    checked++;
  }
  assert.equal(checked, 1800, 'every word that is not a branch or a jal to a number');
});

test('branch and jump offsets read the same as Capstone prints them', () => {
  for (const c of fixture.cases) {
    if (!['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu', 'jal'].includes(c.op)) continue;
    const off = /(-?(?:0x[0-9a-f]+|\d+))$/.exec(c.text)!;
    const printed = off[1].startsWith('-') ? -Number(off[1].slice(1)) : Number(off[1]);
    const d = decode(c.w);
    assert.ok(d.ok);
    assert.equal(d.d.imm, printed, c.text);
  }
});

test('the disassembler, which the stepper shows, prints what it decoded', () => {
  const d: Decoded = { op: 'lw', fmt: 'I', rd: 5, rs1: 2, rs2: 0, imm: 8 };
  assert.equal(disassemble(d), 'lw t0, 8(sp)');
  const r = assemble('add a0, a1, a2\nsw ra, -4(sp)\nloop: beq a0, zero, loop\nlui t0, 0x12345\n');
  assert.ok(r.ok);
  assert.deepEqual(r.program.listing.map((l) => l.text), ['add a0, a1, a2', 'sw ra, -4(sp)', 'beq a0, zero, 0x0008', 'lui t0, 0x12345']);
});

test('pseudoinstructions expand to the words the manual lists', () => {
  const word = (src: string, at = 0) => {
    const r = assemble(src);
    assert.ok(r.ok, !r.ok ? r.errors[0].message : '');
    const b = r.program.bytes;
    return (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;
  };
  assert.equal(word('nop'), 0x00000013); // "NOP is encoded as ADDI x0, x0, 0."
  assert.equal(word('ebreak'), 0x00100073);
  assert.equal(word('ret'), 0x00008067);
  assert.equal(word('mv a0, a1'), 0x00058513);
  assert.equal(word('li a0, 1'), 0x00100513);
  assert.equal(word('li a0, 0x12345678'), 0x12345537);
  assert.equal(word('li a0, 0x12345678', 4), 0x67850513);
  // The classic trap: the low half is sign-extended, so the high half has to allow for it.
  assert.equal(word('li a0, 0x12345fff'), 0x12346537);
  assert.equal(word('li a0, 0x12345fff', 4), 0xfff50513);
  const r = runSource('li a0, 0x12345fff\nli a1, -2049\nli a2, 0xffffffff\nli a3, 0x1000\nebreak\n');
  assert.ok(r.ok);
  assert.equal(r.machine.reg('a0'), 0x12345fff);
  assert.equal(r.machine.reg('a1'), -2049);
  assert.equal(r.machine.reg('a2'), -1);
  assert.equal(r.machine.reg('a3'), 0x1000);
  const branches = runSource(`li a0, 5
li a1, 3
bgt a0, a1, a
li t0, 1
a: ble a0, a1, b
li t1, 7
b: blez a1, c
li t2, 9
c: bgez a1, d
li t3, 1
d: bltz a1, e
li t4, 8
e: bgtz a1, f
li t5, 1
f: ebreak
`);
  assert.ok(branches.ok);
  const m = branches.machine;
  assert.deepEqual(['t0', 't1', 't2', 't3', 't4', 't5'].map((n) => m.reg(n)), [0, 7, 9, 0, 8, 0]);
});

test('an invalid program is refused with its line number, never run as nothing', () => {
  const refused: [string, number, RegExp][] = [
    ['nop\nfrob a0, a1\n', 2, /"frob" isn't an instruction/],
    ['add a0, a1\n', 1, /add takes 3 operands/],
    ['add a0 a1 a2\n', 1, /needs commas/],
    ['addi a0, a0, 2048\n', 1, /between -2048 and 2047/],
    ['addi a0, a0, loop\nloop: nop\n', 1, /is a label/],
    ['slli a0, a0, 32\n', 1, /between 0 and 31/],
    ['nop\n\nbeq a0, a1, nowhere\n', 3, /no label called "nowhere"/],
    ['Loop: nop\nj loop\n', 2, /labels are case-sensitive/],
    ['add a0, a1, q9\n', 1, /"q9" isn't a register/],
    ['lw a0, a1\n', 1, /isn't a memory operand/],
    ['lw a0, 4(q)\n', 1, /"q" isn't a register/],
    ['a: nop\na: nop\n', 2, /defined twice/],
    ['sp: nop\n', 1, /is a register/],
    ['mul a0, a1, a2\n', 1, /M extension/],
    ['div a0, a1, a2\n', 1, /M extension/],
    ['ecall\n', 1, /operating system/],
    ['fence\n', 1, /one core/],
    ['push a0\n', 1, /no push/],
    ['mov a0, a1\n', 1, /mv rd, rs/],
    ['cmp a0, a1\n', 1, /no flags/],
    ['.globl main\n', 1, /one file/],
    ['.section .rodata\n', 1, /\.section/],
    ['.frob\n', 1, /isn't a directive/],
    ['.data\nnop\n', 2, /\.data section/],
    ['.word\n', 1, /needs at least one/],
    ['.word nope\n', 1, /neither a number nor a label/],
    ['.byte 300\n', 1, /doesn't fit/],
    ['.asciz hello\n', 1, /double quotes/],
    ['.asciz "a\\q"\n', 1, /isn't an escape/],
    ['li a0, 99999999999\n', 1, /doesn't fit in 32 bits/],
    ['li a0, loop\nloop: nop\n', 1, /Use la/],
    ['addi a0, a0, 1+1\n', 1, /arithmetic/],
    ['lui a0, %hi(x)\nx: nop\n', 1, /%hi/],
    ['nop; nop\n', 1, /one instruction per line/],
    ['// hello\n', 1, /start with #/],
    ['add a0, a1,, a2\n', 1, /stray comma/],
    ['ret a0\n', 1, /ret takes nothing/],
    ['beq a0, a1, 8\n', 1, /label, not a number/],
  ];
  for (const [src, line, re] of refused) {
    const r = assemble(src);
    assert.equal(r.ok, false, `${JSON.stringify(src)} assembled`);
    if (!r.ok) {
      assert.equal(r.errors[0].line, line, JSON.stringify(src));
      assert.match(r.errors[0].message, re, JSON.stringify(src));
    }
  }
  // Every bad line, not just the first: fixing one at a time is slow, and a beginner shouldn't have to.
  const many = assemble('frob\nnop\nadd a0\n');
  assert.ok(!many.ok && many.errors.length === 2 && many.errors[0].line === 1 && many.errors[1].line === 3);
});

test('a branch too far is refused with the distance, and a program too big for its area is refused', () => {
  const far = assemble(`beq a0, a1, end\n.space 5000\nend: nop\n`);
  assert.ok(!far.ok && /5004 bytes away|bytes away/.test(far.errors[0].message));
  const big = assemble(`${'nop\n'.repeat(2049)}`);
  assert.ok(!big.ok && /code area holds 8192/.test(big.errors[0].message));
});

test('a runaway program stops at the step budget, and says so with a line', () => {
  const r = runSource('loop: j loop\n', { budget: 500 });
  assert.ok(r.ok);
  assert.equal(r.machine.status, 'budget');
  assert.equal(r.machine.steps, 500);
  assert.match(r.machine.fault!.message, /stopped after 500 steps/);
  assert.equal(r.machine.fault!.line, 1);
});

test('faults at run time carry a line number and a reason', () => {
  const cases: [string, number, RegExp][] = [
    ['nop\nli t0, 0x20000\nlw a0, 0(t0)\n', 3, /memory stops at/],
    ['li t0, 0x2001\nlw a0, 0(t0)\n', 2, /isn't a multiple of 4/],
    ['li t0, 0x2002\nsw a0, 0(t0)\n', 2, /isn't a multiple of 4/],
    ['li t0, 0x7004\nlw a0, 0(t0)\n', 2, /guard area/],
    ['li t0, 0x10000000\nlb a0, 0(t0)\n', 2, /only be written/],
    ['li t0, 0x10000000\nsw a0, 0(t0)\n', 2, /one byte at a time/],
    ['li t0, 2\njr t0\n', 2, /4-byte boundary/],
    ['li t0, 0x30000\njr t0\n', 3, /outside this machine's memory/],
    ['nop\nnop\n', 0, /ran off the end.*line 2/],
    ['.word 0xffffffff\n', 0, /aren't an instruction/],
    ['.word 0x00000073\n', 0, /ecall/],
    ['.word 0x02b50533\n', 0, /M extension/],
  ];
  for (const [src, line, re] of cases) {
    const r = runSource(src);
    assert.ok(r.ok, src);
    assert.equal(r.machine.status, 'fault', `${src} ended ${r.machine.status}`);
    assert.match(r.machine.fault!.message, re, src);
    if (src !== 'li t0, 0x30000\njr t0\n') assert.equal(r.machine.fault!.line, line, src);
  }
  // Jumping outside memory lands nowhere with a line, so the lab names the address.
  const away = runSource('li t0, 0x30000\njr t0\n');
  assert.ok(away.ok);
  assert.match(away.machine.fault!.message, /0x00030000/);
});

test('x0 stays zero whatever writes to it, by the manual\'s rule', () => {
  const r = runSource('li t0, 7\nadd zero, t0, t0\nmv a0, zero\nebreak\n');
  assert.ok(r.ok);
  assert.equal(r.machine.regs[0], 0);
  assert.equal(r.machine.reg('a0'), 0);
});

test('instructions are fetched from memory, so a program can overwrite its own next instruction', () => {
  // Stored program: the same memory holds both. The nop on line 5 becomes addi a0, a0, 41 at run time.
  const r = runSource(`
li a0, 1
li t0, 0x02950513
la t1, patch
sw t0, 0(t1)
patch: nop
ebreak
`);
  assert.ok(r.ok);
  assert.equal(r.machine.status, 'stopped');
  assert.equal(r.machine.reg('a0'), 42);
});

test('ret from the top stops cleanly, and memory-mapped output prints', () => {
  const r = runSource(`
.data
msg: .asciz "hi\\n"
.text
la t0, msg
li t1, 0x10000000
next:
lbu t2, 0(t0)
beqz t2, done
sb t2, 0(t1)
addi t0, t0, 1
j next
done:
ret
`);
  assert.ok(r.ok);
  assert.equal(r.machine.status, 'returned');
  assert.equal(r.machine.output, 'hi\n');
  assert.equal(r.machine.pc >>> 0, EXIT_ADDR);
});

test('.data, .word with labels, .half, .byte and .align land where the map says', () => {
  const r = assemble(`
.data
a: .byte 1, 2, 3
b: .half 0x1234
c: .word 0xdeadbeef, a
d: .space 3
.align 2
e: .word -1
`);
  assert.ok(r.ok);
  const p = r.program;
  assert.equal(p.labels.get('a'), 0x2000);
  assert.equal(p.labels.get('b'), 0x2004);
  assert.equal(p.labels.get('c'), 0x2008);
  assert.equal(p.labels.get('d'), 0x2010);
  assert.equal(p.labels.get('e'), 0x2014);
  assert.deepEqual([...p.bytes.slice(0x2000, 0x2003)], [1, 2, 3]);
  assert.deepEqual([...p.bytes.slice(0x2008, 0x2010)], [0xef, 0xbe, 0xad, 0xde, 0x00, 0x20, 0, 0]);
});

test('a stack overflow hits the guard, with the line that did it, and the depth is real arithmetic', () => {
  const r = runSource(`
forever:
  addi sp, sp, -8
  sw ra, 4(sp)
  jal forever
`);
  assert.ok(r.ok);
  assert.equal(r.machine.status, 'fault');
  assert.match(r.machine.fault!.message, /guard area/);
  assert.equal(r.machine.fault!.line, 4);
  // 32 KB at 8 bytes a call is 4,096 calls, and the 4,097th store lands in the guard.
  assert.equal(r.machine.frames.length, (STACK_TOP - STACK_BASE) / 8);
});

test('the stack panel can name the line a saved return address goes back to', () => {
  const src = `li a0, 2
call f
ebreak
f: addi sp, sp, -4
sw ra, 0(sp)
ebreak
`;
  const r = runSource(src);
  assert.ok(r.ok);
  const words = r.machine.stackWords();
  assert.equal(words.length, 1);
  assert.equal(words[0].returnLine, 3);
  assert.deepEqual(r.machine.frames.map((f) => [f.name, f.calledFromLine]), [['f', 2]]);
});

test('calling a function checks the calling convention, not only the answer', () => {
  const asm = (s: string) => { const a = assemble(s); assert.ok(a.ok, !a.ok ? a.errors[0].message : ''); return a.program; };
  const good = callFunction(asm('double: add a0, a0, a0\nret\n'), 'double', [21]);
  assert.ok(good.ok && good.value === 42);
  const noLabel = callFunction(asm('nop\nret\n'), 'double', [1]);
  assert.ok(!noLabel.ok && /no label called double/.test(noLabel.why));
  const lost = callFunction(asm('f: addi sp, sp, -16\nadd a0, a0, a0\nret\n'), 'f', [2]);
  assert.ok(!lost.ok && /give back the stack/.test(lost.why));
  const clobber = callFunction(asm('f: li s3, 9\nret\n'), 'f', [2]);
  assert.ok(!clobber.ok && /changed s3/.test(clobber.why));
  const halts = callFunction(asm('f: ebreak\n'), 'f', [2]);
  assert.ok(!halts.ok && /instead of returning/.test(halts.why));
  const spins = callFunction(asm('f: j f\n'), 'f', [2], { budget: 100 });
  assert.ok(!spins.ok && /never finished/.test(spins.why));
  // A temporary starts as garbage, so reading one before writing it can't look fine.
  const uninit = callFunction(asm('f: mv a0, t0\nret\n'), 'f', [2]);
  assert.ok(uninit.ok && uninit.value !== 0);
});

test('a wild jump isn\'t "ran off the end": it blamed the jump\'s own line as the last one, with no line number', () => {
  for (const [src, where] of [['li t0, 0x7000\njr t0\n', '0x7000'], ['li t0, 0x8000\njr t0\n', '0x8000'], ['li t0, 0x3000\njr t0\n', '0x3000']] as const) {
    const r = runSource(src);
    assert.ok(r.ok);
    assert.equal(r.machine.status, 'fault');
    assert.match(r.machine.fault!.message, new RegExp(`jumped to ${where}, where nothing has been written`));
    assert.doesNotMatch(r.machine.fault!.message, /ran off the end/);
    assert.equal(r.machine.fault!.line, 2, 'the line of the jump');
  }
  // A return through a corrupted ra is how a learner meets this.
  const smashed = runSource('li ra, 0x5000\nret\n');
  assert.ok(smashed.ok);
  assert.match(smashed.machine.fault!.message, /jumped to 0x5000/);
  // A taken branch lands the same way, and a fall-through is still the end of the program.
  const fell = runSource('nop\nnop\n');
  assert.ok(fell.ok);
  assert.match(fell.machine.fault!.message, /ran off the end.*line 2/);
});

test('an empty program says so: all three of these used to report "the instruction on line 0"', () => {
  for (const src of ['', '# nothing here\n', '.data\nx: .word 1\n']) {
    const r = runSource(src);
    assert.ok(r.ok, JSON.stringify(src));
    assert.equal(r.machine.status, 'fault');
    assert.match(r.machine.fault!.message, /no instructions/, JSON.stringify(src));
    assert.doesNotMatch(r.machine.fault!.message, /line 0/);
  }
});

test('code on an odd address is refused by line: it assembled silently and failed later, blaming the bytes', () => {
  for (const [src, line] of [['.byte 1\nnop\nebreak\n', 2], ['.space 2\nli a0, 3\nebreak\n', 2], ['nop\n.byte 9\nfoo:\nebreak\n', 4]] as const) {
    const r = assemble(src);
    assert.ok(!r.ok, JSON.stringify(src));
    assert.equal(r.errors[0].line, line);
    assert.match(r.errors[0].message, /isn't a multiple of 4/);
  }
  // A jump to an odd label used to lose the low bit silently and land a byte away from it.
  const odd = assemble('j foo\n.byte 1\nfoo: .byte 2\n');
  assert.ok(!odd.ok && /odd address/.test(odd.errors[0].message), JSON.stringify(odd));
  // .align is the way out the message offers, and data in .data is still free to sit anywhere.
  const fixed = runSource('j go\n.byte 1\n.align 2\ngo: li a0, 3\nebreak\n');
  assert.ok(fixed.ok);
  assert.equal(fixed.machine.reg('a0'), 3);
  assert.ok(assemble('nop\nebreak\n.data\na: .byte 1\nb: .byte 2\n').ok);
});

test('refusals say what\'s allowed: -1 was "too big", and shifts were told to use li, which then shifts by 0', () => {
  const said = (src: string) => { const r = assemble(src); assert.ok(!r.ok, src); return r.errors[0].message; };
  assert.match(said('slli a0, a0, -1\n'), /has to be between 0 and 31, and -1 isn't/);
  assert.match(said('lui a0, -1\n'), /has to be between 0 and 1048575, and -1 isn't/);
  for (const src of ['slli a0, a0, -1\n', 'slli a0, a0, 32\n', 'lui a0, -1\n', 'lw a0, 5000(sp)\n']) {
    assert.doesNotMatch(said(src), /too big|with li first/, src);
  }
  // The advice is real where it's offered: a register does stand in for addi's number.
  assert.match(said('addi a0, a0, 5000\n'), /with li first/);
  const followed = runSource('li a0, 1\nli t0, 5000\nadd a0, a0, t0\nebreak\n');
  assert.ok(followed.ok);
  assert.equal(followed.machine.reg('a0'), 5001);
  // Why the shift advice had to go: by the manual, a shift amount in a register uses its low 5 bits.
  const shifted = runSource('li t0, 32\nli a1, 9\nsll a0, a1, t0\nebreak\n');
  assert.ok(shifted.ok);
  assert.equal(shifted.machine.reg('a0'), 9);
  // The word for fence.i got the answer meant for fence.
  const fenceI = runSource('.word 0x0000100f\n');
  assert.ok(fenceI.ok);
  assert.match(fenceI.machine.fault!.message, /fence\.i synchronises/);
  const fence = runSource('.word 0x0000000f\n');
  assert.ok(fence.ok);
  assert.match(fence.machine.fault!.message, /between cores/);
});

test('a character literal can be a comma, a semicolon or a percent sign: each collided with the parser', () => {
  for (const [ch, code] of [[',', 44], [';', 59], ['%', 37], ['#', 35]] as const) {
    const r = runSource(`li a0, '${ch}'\nebreak\n`);
    assert.ok(r.ok, `li a0, '${ch}'`);
    assert.equal(r.machine.reg('a0'), code);
  }
  const bytes = assemble(`.data\nx: .byte ',', 'a', ';'\n`);
  assert.ok(bytes.ok);
  assert.deepEqual([...bytes.program.bytes.slice(0x2000, 0x2003)], [44, 97, 59]);
  // The real punctuation is still refused, as it was.
  const two = assemble('li a0, 1; li a1, 2\n');
  assert.ok(!two.ok && /one instruction per line/.test(two.errors[0].message));
  const three = assemble("li a0, 1, ','\n");
  assert.ok(!three.ok && /This line has 3/.test(three.errors[0].message));
});

test('neither random text nor random memory can make the machine throw, or hang', () => {
  // A learner can type anything. An exception here would show as a bug in the sandbox, so the
  // only allowed outcomes are a refusal with a line, a fault with a reason, or a clean stop.
  let seed = 12345;
  const rand = (n: number) => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return (seed >>> 8) % n; };
  const bits = ['add', 'lw', 'sw', 'beq', 'jal', 'jalr', 'li', 'la', 'ret', 'call', 'ebreak', '.word', '.byte', '.space', '.data', '.text', '.align', '.asciz', 'a0', 'sp', 'x31', 'q', 'zero', ',', ',', '(', ')', ':', '#', '-1', '0', '4096', '0x7fffffff', '99999999999', '"hi"', "'A'", 'loop', 'loop:', '__proto__', 'constructor', '%hi', '\t', '\n', '\n'];
  for (let i = 0; i < 3000; i++) {
    const src = Array.from({ length: 1 + rand(14) }, () => bits[rand(bits.length)]).join(' ');
    const a = assemble(src);
    if (!a.ok) {
      assert.ok(a.errors.length > 0 && a.errors.every((e) => e.line >= 1 && e.message.length > 0), src);
      continue;
    }
    const m = new Machine(a.program, { budget: 2000 });
    m.run();
    assert.notEqual(m.status, 'ready', src);
    if (m.status === 'fault' || m.status === 'budget') assert.ok(m.fault!.message.length > 0, src);
  }
  for (let i = 0; i < 400; i++) {
    const program = blank();
    for (let k = 0; k < 64; k++) { const w = rand(4) === 0 ? (rand(65536) * 65536 + rand(65536)) >>> 0 : [0x13, 0x33, 0x63, 0x67, 0x6f, 0x23, 0x03][rand(7)] + (rand(65536) * 65536 + (rand(4096) << 7)) ; for (let b = 0; b < 4; b++) program.bytes[4 * k + b] = (w >>> (8 * b)) & 0xff; }
    const m = new Machine(program, { budget: 2000 });
    m.run();
    assert.notEqual(m.status, 'ready');
  }
});

test('field cuts add up to 32 bits for every format', () => {
  for (const f of ['R', 'I', 'S', 'B', 'U', 'J'] as const) {
    assert.equal(fieldsOf(0xdeadbeef, f).map((x) => x.bits).join('').length, 32);
    assert.equal(fieldsOf(0xdeadbeef, f).map((x) => x.bits).join(''), (0xdeadbeef).toString(2));
  }
  assert.deepEqual(fieldsOf(0x00b50533, 'R').map((x) => x.name), ['funct7', 'rs2', 'rs1', 'funct3', 'rd', 'opcode']);
  assert.equal(REG_NAMES.length, 32);
  assert.equal(regIndex('fp'), 8);
  assert.equal(regIndex('x31'), 31);
});
