// A real instruction set, so nothing here can be a teaching fiction: RV32I from the
// RISC-V unprivileged manual (version 20240411, chapter 2), minus the instructions that
// need something this page doesn't have. The assembler turns text into the spec's exact
// 32-bit words, those words go into one flat memory, and the machine fetches and decodes
// them from there. Nothing runs from the text, so overwriting an instruction really
// changes what runs. tests/riscv.test.ts holds the decoder and every instruction's
// results against Unicorn (QEMU's CPU core) and Capstone, on recorded random cases.
//
// Left out on purpose, and refused by name rather than ignored: ecall and fence (no
// operating system, one core), the CSR instructions, and the M extension's mul and div.
//
// A lab that goes quiet teaches nothing, so every failure carries a line number:
// assembly errors, faults at run time, and a step budget for loops that never end.

export const MEM_SIZE = 0x10000;
// Fixed addresses, so a lesson can name them and a learner can find them in the panel.
export const TEXT_BASE = 0x0000;
export const DATA_BASE = 0x2000;
// A hole between data and stack, like the guard page an operating system puts below a
// thread's stack. Without it a runaway recursion would quietly eat the data and then the
// code, and the failure would show up somewhere that has nothing to do with the cause.
export const GUARD_BASE = 0x7000;
export const STACK_BASE = 0x8000;
export const STACK_TOP = 0x10000;
// Where a `ret` from the first function lands. It stands in for whatever called the
// program on a real system. Without it `ret` jumps to address 0 and runs the program again, for ever.
export const EXIT_ADDR = 0xfffffff0;
// Memory-mapped output: this lab's choice of address. A byte stored here is printed.
export const OUT_ADDR = 0x10000000;
export const DEFAULT_BUDGET = 200_000;

export const REG_NAMES = ['zero', 'ra', 'sp', 'gp', 'tp', 't0', 't1', 't2', 's0', 's1', 'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11', 't3', 't4', 't5', 't6'];
const REG_INDEX = new Map<string, number>([...REG_NAMES.map((n, i) => [n, i] as [string, number]), ...Array.from({ length: 32 }, (_, i) => [`x${i}`, i] as [string, number]), ['fp', 8]]);
export const regIndex = (name: string) => REG_INDEX.get(name);

export type Fmt = 'R' | 'I' | 'S' | 'B' | 'U' | 'J';
export type Op =
  | 'lui' | 'auipc' | 'jal' | 'jalr'
  | 'beq' | 'bne' | 'blt' | 'bge' | 'bltu' | 'bgeu'
  | 'lb' | 'lh' | 'lw' | 'lbu' | 'lhu' | 'sb' | 'sh' | 'sw'
  | 'addi' | 'slti' | 'sltiu' | 'xori' | 'ori' | 'andi' | 'slli' | 'srli' | 'srai'
  | 'add' | 'sub' | 'sll' | 'slt' | 'sltu' | 'xor' | 'srl' | 'sra' | 'or' | 'and'
  | 'ebreak';
export type Decoded = { op: Op; fmt: Fmt; rd: number; rs1: number; rs2: number; imm: number };

// funct3 and funct7 from the manual's table of RV32I instructions.
const R_OPS: Record<string, Op> = { '0:0': 'add', '0:32': 'sub', '1:0': 'sll', '2:0': 'slt', '3:0': 'sltu', '4:0': 'xor', '5:0': 'srl', '5:32': 'sra', '6:0': 'or', '7:0': 'and' };
const I_OPS: Op[] = ['addi', 'slli', 'slti', 'sltiu', 'xori', 'srli', 'ori', 'andi'];
const LOAD_OPS: (Op | null)[] = ['lb', 'lh', 'lw', null, 'lbu', 'lhu', null, null];
const STORE_OPS: (Op | null)[] = ['sb', 'sh', 'sw', null, null, null, null, null];
const BRANCH_OPS: (Op | null)[] = ['beq', 'bne', null, null, 'blt', 'bge', 'bltu', 'bgeu'];

const sext = (v: number, bits: number) => (v << (32 - bits)) >> (32 - bits);
const hex = (v: number, width = 8) => `0x${(v >>> 0).toString(16).padStart(width, '0')}`;
export const hex32 = (v: number) => hex(v, 8);
export const hexAddr = (v: number) => ((v >>> 0) <= 0xffff ? hex(v, 4) : hex(v, 8));

export type DecodeResult = { ok: true; d: Decoded } | { ok: false; why: string };

/** Reads a 32-bit word the way the manual's formats lay it out. Everything else is refused, with a reason. */
export function decode(word: number): DecodeResult {
  const w = word >>> 0;
  const opcode = w & 0x7f, rd = (w >>> 7) & 31, f3 = (w >>> 12) & 7, rs1 = (w >>> 15) & 31, rs2 = (w >>> 20) & 31, f7 = w >>> 25;
  const immI = sext(w >>> 20, 12);
  const immS = sext((f7 << 5) | rd, 12);
  const immB = sext((((w >>> 31) & 1) << 12) | (((w >>> 7) & 1) << 11) | (((w >>> 25) & 0x3f) << 5) | (((w >>> 8) & 0xf) << 1), 13);
  const immU = (w & 0xfffff000) | 0;
  const immJ = sext((((w >>> 31) & 1) << 20) | (((w >>> 12) & 0xff) << 12) | (((w >>> 20) & 1) << 11) | (((w >>> 21) & 0x3ff) << 1), 21);
  const bad = (why: string): DecodeResult => ({ ok: false, why });
  const good = (op: Op, fmt: Fmt, imm: number, f: Partial<Decoded> = {}): DecodeResult => ({ ok: true, d: { op, fmt, rd: 0, rs1: 0, rs2: 0, imm, ...f } });
  switch (opcode) {
    case 0x37: return good('lui', 'U', immU, { rd });
    case 0x17: return good('auipc', 'U', immU, { rd });
    case 0x6f: return good('jal', 'J', immJ, { rd });
    case 0x67: return f3 === 0 ? good('jalr', 'I', immI, { rd, rs1 }) : bad('jalr with a funct3 the manual does not define');
    case 0x63: { const op = BRANCH_OPS[f3]; return op ? good(op, 'B', immB, { rs1, rs2 }) : bad('a branch with a funct3 the manual does not define'); }
    case 0x03: { const op = LOAD_OPS[f3]; return op ? good(op, 'I', immI, { rd, rs1 }) : bad('a load with a funct3 RV32I does not define'); }
    case 0x23: { const op = STORE_OPS[f3]; return op ? good(op, 'S', immS, { rs1, rs2 }) : bad('a store with a funct3 RV32I does not define'); }
    case 0x13: {
      const op = I_OPS[f3];
      if (op === 'slli') return f7 === 0 ? good('slli', 'I', rs2, { rd, rs1 }) : bad('a shift with a funct7 RV32I does not define');
      if (op === 'srli') {
        if (f7 === 0) return good('srli', 'I', rs2, { rd, rs1 });
        if (f7 === 32) return good('srai', 'I', rs2, { rd, rs1 });
        return bad('a shift with a funct7 RV32I does not define');
      }
      return good(op, 'I', immI, { rd, rs1 });
    }
    case 0x33: {
      if (f7 === 1) return bad('mul or div: those are the M extension, which this machine leaves out');
      const op = R_OPS[`${f3}:${f7}`];
      return op ? good(op, 'R', 0, { rd, rs1, rs2 }) : bad('a register operation with a funct7 RV32I does not define');
    }
    case 0x73:
      if (w === 0x00100073) return good('ebreak', 'I', 1);
      if (w === 0x00000073) return bad('ecall asks an operating system for something, and this machine has none');
      return bad('a system instruction this machine leaves out');
    // funct3 1 is fence.i, which isn't about cores at all: telling it the fence answer sent people the wrong way.
    case 0x0f: return bad(f3 === 1 ? 'fence.i synchronises instruction fetches with earlier stores, and this machine leaves it out because it has no instruction cache to synchronise' : 'fence orders memory between cores, and this machine has one core and leaves it out');
    default:
      if (w === 0) return bad('all zero bits, which the manual reserves as illegal');
      return bad('its low bits are not an RV32I opcode');
  }
}

/** The word for an instruction. The inverse of decode, and held to it by a test. */
export function encode(d: Decoded): number {
  const { op, rd, rs1, rs2, imm } = d;
  const r = (f7: number, f3: number) => ((f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | 0x33) >>> 0;
  const i = (opc: number, f3: number, v: number) => (((v & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opc) >>> 0;
  const s = (f3: number) => ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 0x1f) << 7) | 0x23) >>> 0;
  const b = (f3: number) => ((((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (((imm >> 1) & 0xf) << 8) | (((imm >> 11) & 1) << 7) | 0x63) >>> 0;
  switch (op) {
    case 'lui': return ((imm & 0xfffff000) | (rd << 7) | 0x37) >>> 0;
    case 'auipc': return ((imm & 0xfffff000) | (rd << 7) | 0x17) >>> 0;
    case 'jal': return ((((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3ff) << 21) | (((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xff) << 12) | (rd << 7) | 0x6f) >>> 0;
    case 'jalr': return i(0x67, 0, imm);
    case 'beq': return b(0); case 'bne': return b(1); case 'blt': return b(4); case 'bge': return b(5); case 'bltu': return b(6); case 'bgeu': return b(7);
    case 'lb': return i(0x03, 0, imm); case 'lh': return i(0x03, 1, imm); case 'lw': return i(0x03, 2, imm); case 'lbu': return i(0x03, 4, imm); case 'lhu': return i(0x03, 5, imm);
    case 'sb': return s(0); case 'sh': return s(1); case 'sw': return s(2);
    case 'addi': return i(0x13, 0, imm); case 'slti': return i(0x13, 2, imm); case 'sltiu': return i(0x13, 3, imm); case 'xori': return i(0x13, 4, imm); case 'ori': return i(0x13, 6, imm); case 'andi': return i(0x13, 7, imm);
    case 'slli': return i(0x13, 1, imm & 31); case 'srli': return i(0x13, 5, imm & 31); case 'srai': return i(0x13, 5, (imm & 31) | 0x400);
    case 'add': return r(0, 0); case 'sub': return r(32, 0); case 'sll': return r(0, 1); case 'slt': return r(0, 2); case 'sltu': return r(0, 3); case 'xor': return r(0, 4); case 'srl': return r(0, 5); case 'sra': return r(32, 5); case 'or': return r(0, 6); case 'and': return r(0, 7);
    case 'ebreak': return 0x00100073;
  }
}

/** One instruction as text, in standard assembly. `pc` turns a branch's offset into the address it goes to. */
export function disassemble(d: Decoded, pc?: number): string {
  const n = (i: number) => REG_NAMES[i];
  const target = (off: number) => (pc === undefined ? `${off >= 0 ? '+' : ''}${off}` : hexAddr(pc + off));
  switch (d.fmt) {
    case 'R': return `${d.op} ${n(d.rd)}, ${n(d.rs1)}, ${n(d.rs2)}`;
    case 'U': return `${d.op} ${n(d.rd)}, ${hex(d.imm >>> 12, 1)}`;
    case 'J': return `jal ${n(d.rd)}, ${target(d.imm)}`;
    case 'B': return `${d.op} ${n(d.rs1)}, ${n(d.rs2)}, ${target(d.imm)}`;
    case 'S': return `${d.op} ${n(d.rs2)}, ${d.imm}(${n(d.rs1)})`;
    case 'I':
      if (d.op === 'ebreak') return 'ebreak';
      if (d.op === 'lb' || d.op === 'lh' || d.op === 'lw' || d.op === 'lbu' || d.op === 'lhu' || d.op === 'jalr') return `${d.op} ${n(d.rd)}, ${d.imm}(${n(d.rs1)})`;
      return `${d.op} ${n(d.rd)}, ${n(d.rs1)}, ${d.imm}`;
  }
}

/** A word cut along its format's fields, from the top bit down, for showing what decoding reads. */
export function fieldsOf(word: number, fmt: Fmt): { name: string; bits: string }[] {
  const b = (word >>> 0).toString(2).padStart(32, '0');
  const cut = (spec: [string, number][]) => { let at = 0; return spec.map(([name, len]) => { const bits = b.slice(at, at + len); at += len; return { name, bits }; }); };
  switch (fmt) {
    case 'R': return cut([['funct7', 7], ['rs2', 5], ['rs1', 5], ['funct3', 3], ['rd', 5], ['opcode', 7]]);
    case 'I': return cut([['imm', 12], ['rs1', 5], ['funct3', 3], ['rd', 5], ['opcode', 7]]);
    case 'S': return cut([['imm high', 7], ['rs2', 5], ['rs1', 5], ['funct3', 3], ['imm low', 5], ['opcode', 7]]);
    case 'B': return cut([['imm scattered', 7], ['rs2', 5], ['rs1', 5], ['funct3', 3], ['imm scattered', 5], ['opcode', 7]]);
    case 'U': return cut([['imm', 20], ['rd', 5], ['opcode', 7]]);
    case 'J': return cut([['imm scattered', 20], ['rd', 5], ['opcode', 7]]);
  }
}

// ---- the assembler --------------------------------------------------------------

export type AsmError = { line: number; message: string };
export type Listed = { addr: number; word: number; line: number; text: string };
export type Program = { source: string; bytes: Uint8Array; labels: Map<string, number>; listing: Listed[]; lineOf: Map<number, number>; textEnd: number; dataEnd: number; lastLine: number };
export type AsmResult = { ok: true; program: Program } | { ok: false; errors: AsmError[] };

type Section = 'text' | 'data';
type Pending =
  | { kind: 'instr'; line: number; addr: number; op: string; args: string[] }
  | { kind: 'word'; line: number; addr: number; size: 1 | 2 | 4; value: string }
  | { kind: 'bytes'; line: number; addr: number; bytes: number[] };

const R_FORM = new Set(['add', 'sub', 'sll', 'slt', 'sltu', 'xor', 'srl', 'sra', 'or', 'and']);
const I_FORM = new Set(['addi', 'slti', 'sltiu', 'xori', 'ori', 'andi']);
const SHIFT_FORM = new Set(['slli', 'srli', 'srai']);
const LOAD_FORM = new Set(['lb', 'lh', 'lw', 'lbu', 'lhu']);
const STORE_FORM = new Set(['sb', 'sh', 'sw']);
const BRANCH_FORM = new Set(['beq', 'bne', 'blt', 'bge', 'bltu', 'bgeu']);
const PSEUDO = new Set(['nop', 'li', 'la', 'mv', 'not', 'neg', 'seqz', 'snez', 'sltz', 'sgtz', 'beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz', 'bgt', 'ble', 'bgtu', 'bleu', 'j', 'jr', 'ret', 'call', 'tail']);

// What people type from other assembly languages or from the wider RISC-V world. Each
// gets a real answer, because "unknown instruction" sends a beginner looking for a typo.
const REFUSED: Record<string, string> = {
  mul: 'mul is in the M extension, which this machine leaves out. Multiply with a loop of adds, or with shifts',
  mulh: 'mulh is in the M extension, which this machine leaves out',
  mulhu: 'mulhu is in the M extension, which this machine leaves out',
  mulhsu: 'mulhsu is in the M extension, which this machine leaves out',
  div: 'div is in the M extension, which this machine leaves out. Divide with a loop of subtracts',
  divu: 'divu is in the M extension, which this machine leaves out',
  rem: 'rem is in the M extension, which this machine leaves out',
  remu: 'remu is in the M extension, which this machine leaves out',
  ecall: 'ecall asks an operating system for something, and this machine has none. Print by storing a byte at the output address. End with ebreak or ret',
  fence: 'fence orders memory between cores, and this machine has one core, so it leaves fence out',
  'fence.i': 'fence.i is in the Zifencei extension, which this machine leaves out. It runs each instruction straight from memory, with no instruction cache to synchronise',
  csrrw: 'the CSR instructions are in the Zicsr extension, which this machine leaves out',
  csrrs: 'the CSR instructions are in the Zicsr extension, which this machine leaves out',
  csrrc: 'the CSR instructions are in the Zicsr extension, which this machine leaves out',
  mov: 'mov is from other assembly languages. RISC-V writes mv rd, rs',
  move: 'RISC-V writes mv rd, rs',
  // Not -4 and 4: the calling convention keeps sp a multiple of 16, and this advice used to teach otherwise.
  push: 'RISC-V has no push. Make room with addi sp, sp, -16, and then store with sw on the next line',
  pop: 'RISC-V has no pop. Read back with lw, and then give the room back with addi sp, sp, 16 on the next line',
  cmp: 'RISC-V has no cmp and no flags. Its branches compare two registers themselves, as in blt a0, a1, label',
  jmp: 'RISC-V writes j label',
  b: 'RISC-V writes j label',
  bl: 'RISC-V writes call label',
  hlt: 'RISC-V writes ebreak to stop here',
  halt: 'RISC-V writes ebreak to stop here',
  syscall: 'this machine has no operating system to call. Print by storing a byte at the output address',
  addu: 'RISC-V has no addu, because add already wraps without complaint. Write add',
  subu: 'RISC-V has no subu, because sub already wraps without complaint. Write sub',
};

const parseNumber = (t: string): number | null => {
  const s = t.trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?0x[0-9a-fA-F]+$/.test(s)) return s.startsWith('-') ? -Number(s.slice(1)) : Number(s);
  if (/^-?0b[01]+$/.test(s)) return s.startsWith('-') ? -Number(s.slice(1)) : Number(s);
  const c = /^'(\\?.)'$/.exec(s);
  if (c) { const e = c[1].length === 2 ? ({ n: 10, t: 9, r: 13, '0': 0, '\\': 92, "'": 39 } as Record<string, number>)[c[1][1]] : c[1].charCodeAt(0); return e ?? null; }
  return null;
};

/** Removes a comment, minding quotes: the # in .asciz "a#b" isn't one. */
function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === '"' || (ch === "'" && line[i + 2] === "'") || (ch === "'" && line[i + 1] === '\\')) { quote = ch; continue; }
    if (ch === '#') return line.slice(0, i);
  }
  return line;
}

// A character literal can hold a comma, a semicolon or a percent sign, so they have to be hidden
// before anything looks for those as punctuation. Without this, li a0, ',' reported "3 operands"
// to someone printing "Hello, panda" one character at a time.
const hideCharLiterals = (text: string) => text.replace(/'(?:\\.|[^\\])'/g, (m) => '_'.repeat(m.length));

/** Splits on the commas that really separate operands. */
function splitOperands(text: string): string[] {
  const masked = hideCharLiterals(text);
  const out: string[] = [];
  let from = 0;
  for (let i = 0; i < masked.length; i++) if (masked[i] === ',') { out.push(text.slice(from, i).trim()); from = i + 1; }
  out.push(text.slice(from).trim());
  return out;
}

const sizeOfLi = (imm: number) => {
  const v = imm | 0;
  if (v >= -2048 && v <= 2047) return 1;
  return (v & 0xfff) === 0 ? 1 : 2;
};

export function assemble(source: string): AsmResult {
  const errors: AsmError[] = [];
  const labels = new Map<string, number>();
  const pending: Pending[] = [];
  const counters: Record<Section, number> = { text: TEXT_BASE, data: DATA_BASE };
  let section: Section = 'text';
  const err = (line: number, message: string) => { errors.push({ line, message }); };

  const lines = source.replace(/\r\n/g, '\n').split('\n');
  lines.forEach((raw, idx) => {
    const line = idx + 1;
    let text = stripComment(raw).trim();
    if (!text) return;
    if (text.startsWith('//') || text.startsWith(';')) { err(line, 'comments in this assembly start with #'); return; }
    // Any number of labels can start a line, and an instruction can follow them.
    for (;;) {
      const m = /^([A-Za-z_.][\w.$]*)\s*:\s*/.exec(text);
      if (!m) break;
      const name = m[1];
      if (REG_INDEX.has(name)) err(line, `"${name}" is a register, so it can't also be a label`);
      else if (labels.has(name)) err(line, `the label "${name}" is defined twice`);
      else labels.set(name, counters[section]);
      text = text.slice(m[0].length);
    }
    if (!text) return;

    if (text.startsWith('.')) { directive(text, line); return; }

    const m = /^([A-Za-z][\w.]*)\s*(.*)$/.exec(text);
    if (!m) { err(line, `can't read "${text}" as an instruction`); return; }
    const op = m[1].toLowerCase();
    const known = R_FORM.has(op) || I_FORM.has(op) || SHIFT_FORM.has(op) || LOAD_FORM.has(op) || STORE_FORM.has(op) || BRANCH_FORM.has(op) || PSEUDO.has(op) || ['lui', 'auipc', 'jal', 'jalr', 'ebreak'].includes(op);
    if (!known) {
      if (Object.hasOwn(REFUSED, op)) err(line, REFUSED[op]);
      else err(line, `"${m[1]}" isn't an instruction this machine knows`);
      return;
    }
    if (section === 'data') { err(line, `"${op}" is an instruction, but this line is in the .data section. Write .text first`); return; }
    const bare = hideCharLiterals(text);
    if (bare.includes(';')) { err(line, 'one instruction per line: ; does not separate instructions here'); return; }
    if (bare.includes('%')) { err(line, '%hi and %lo are not supported here. Use li for a number and la for a label'); return; }
    const argText = m[2].trim();
    const args = argText ? splitOperands(argText) : [];
    if (args.some((a) => !a)) { err(line, `there's a stray comma in "${argText}"`); return; }
    // .byte or .space in the code can leave the next instruction on an odd address. It used to
    // assemble without a word and then fail at run time with no line, blaming the bytes.
    if (counters.text % 4) { err(line, `this instruction would start at address ${hexAddr(counters.text)}, which isn't a multiple of 4, and every instruction here has to be. Something before it in .text isn't a whole number of words. .align 2 moves on to the next multiple of 4`); return; }
    pending.push({ kind: 'instr', line, addr: counters.text, op, args });
    let size = 1;
    if (op === 'li') {
      const v = args.length === 2 ? parseNumber(args[1]) : null;
      size = v === null ? 1 : sizeOfLi(v);
    } else if (op === 'la') size = 2;
    counters.text += 4 * size;
  });

  function align(to: number) {
    const left = counters[section] % to;
    if (left) counters[section] += to - left;
  }

  function directive(text: string, line: number) {
    const m = /^(\.[\w.]+)\s*(.*)$/.exec(text);
    if (!m) { err(line, `can't read the directive "${text}"`); return; }
    const name = m[1].toLowerCase(), rest = m[2].trim();
    const list = () => splitOperands(rest);
    switch (name) {
      case '.text': section = 'text'; if (rest) err(line, '.text takes nothing after it'); return;
      case '.data': section = 'data'; if (rest) err(line, '.data takes nothing after it'); return;
      case '.word': case '.half': case '.byte': {
        if (!rest) { err(line, `${name} needs at least one value`); return; }
        const size = name === '.word' ? 4 : name === '.half' ? 2 : 1;
        // A label just before this names the data, so it moves with the padding. Left
        // behind, `b: .half 1` after an odd byte would name an address lh can't read.
        const before = counters[section];
        align(size);
        if (counters[section] !== before) for (const [k, v] of labels) if (v === before) labels.set(k, counters[section]);
        for (const v of list()) {
          if (!v) { err(line, `there's a stray comma after ${name}`); continue; }
          pending.push({ kind: 'word', line, addr: counters[section], size: size as 1 | 2 | 4, value: v });
          counters[section] += size;
        }
        return;
      }
      case '.space': case '.zero': {
        const n = parseNumber(rest);
        if (n === null || n < 0) { err(line, `${name} needs a byte count, such as ${name} 16`); return; }
        counters[section] += n;
        return;
      }
      case '.align': {
        const n = parseNumber(rest);
        if (n === null || n < 0 || n > 12) { err(line, '.align needs a power of two as its exponent: .align 2 means a 4-byte boundary'); return; }
        align(2 ** n);
        return;
      }
      case '.asciz': case '.string': case '.ascii': {
        const q = /^"((?:[^"\\]|\\.)*)"$/.exec(rest);
        if (!q) { err(line, `${name} needs one string in double quotes`); return; }
        const bytes: number[] = [];
        const escapes: Record<string, number> = { n: 10, t: 9, r: 13, '0': 0, '\\': 92, '"': 34 };
        for (let i = 0; i < q[1].length; i++) {
          const code = q[1].charCodeAt(i);
          if (q[1][i] === '\\') {
            const e = escapes[q[1][++i]];
            if (e === undefined) { err(line, `\\${q[1][i]} isn't an escape this assembler knows. It knows \\n \\t \\r \\0 \\\\ \\"`); return; }
            bytes.push(e);
          } else if (code > 126 || (code < 32 && code !== 9)) { err(line, `this assembler handles plain ASCII text, and "${q[1][i]}" isn't ASCII`); return; }
          else bytes.push(code);
        }
        if (name !== '.ascii') bytes.push(0);
        pending.push({ kind: 'bytes', line, addr: counters[section], bytes });
        counters[section] += bytes.length;
        return;
      }
      case '.globl': case '.global': err(line, `${name} shares a label between files, and this lab has one file. Remove the line`); return;
      case '.section': err(line, '.section is not supported here. Use .text and .data'); return;
      default: err(line, `"${name}" isn't a directive this assembler knows. It knows .text .data .word .half .byte .space .align .asciz .string .ascii`);
    }
  }

  if (counters.text > DATA_BASE) err(lines.length, `the program takes ${counters.text} bytes, and the code area holds ${DATA_BASE}`);
  if (counters.data > GUARD_BASE) err(lines.length, `the data takes ${counters.data - DATA_BASE} bytes, and the data area holds ${GUARD_BASE - DATA_BASE}`);
  // Too big is the one error that stops here, because the addresses below would run off memory.
  // Others carry on, so every bad line gets reported at once and not one per attempt.
  if (counters.text > DATA_BASE || counters.data > GUARD_BASE) { errors.sort((a, b) => a.line - b.line); return { ok: false, errors }; }

  const bytes = new Uint8Array(MEM_SIZE);
  const listing: Listed[] = [];
  const lineOf = new Map<number, number>();
  const put = (addr: number, word: number, line: number, d: Decoded) => {
    for (let i = 0; i < 4; i++) bytes[addr + i] = (word >>> (8 * i)) & 0xff;
    listing.push({ addr, word, line, text: disassemble(d, addr) });
    lineOf.set(addr, line);
  };

  const reg = (line: number, t: string): number | null => {
    const v = REG_INDEX.get(t.trim());
    if (v === undefined) { err(line, `"${t}" isn't a register. Registers are x0 to x31, or names like a0, t1, s2, sp, ra`); return null; }
    return v;
  };
  // "put it in a register with li first" only helps where a register can stand in for the number.
  // It used to be offered for shifts too, where the register form silently uses only the low 5 bits,
  // so following that advice for slli a0, a0, 32 shifted by 0.
  const immediate = (line: number, t: string, lo: number, hi: number, what: string, advice = ''): number | null => {
    const v = parseNumber(t);
    if (v === null) {
      if (labels.has(t.trim())) err(line, `${what} needs a number, and "${t}" is a label. Use la to put a label's address in a register`);
      else if (/[+*/-]/.test(t.slice(1))) err(line, `this assembler doesn't do arithmetic in operands: write the number that "${t}" comes to`);
      else err(line, `${what} needs a number, and "${t}" isn't one`);
      return null;
    }
    if (v < lo || v > hi) { err(line, `${what} has to be between ${lo} and ${hi}, and ${v} isn't${advice ? `. ${advice}` : ''}`); return null; }
    return v;
  };
  const target = (line: number, t: string, pc: number, range: number, what: string): number | null => {
    const name = t.trim();
    const addr = labels.get(name);
    if (addr === undefined) {
      if (parseNumber(name) !== null) err(line, `${what} here takes a label, not a number`);
      else {
        const close = [...labels.keys()].find((k) => k.toLowerCase() === name.toLowerCase());
        err(line, close ? `no label called "${name}". There is a "${close}": labels are case-sensitive` : `no label called "${name}" anywhere in this program`);
      }
      return null;
    }
    const off = addr - pc;
    if (off < -range || off >= range) { err(line, `"${name}" is ${off} bytes away, and ${what} only reaches ${range} bytes either way`); return null; }
    // A jump's offset has no bit for an odd number. encode() would drop it and land one byte away from the label, silently.
    if (what !== 'la' && off % 2) { err(line, `"${name}" is at the odd address ${hexAddr(addr)}, and ${what} can't reach an odd address`); return null; }
    return off;
  };
  const memOperand = (line: number, t: string): { imm: number; base: number } | null => {
    const m = /^(.*?)\(\s*([^)\s]+)\s*\)$/.exec(t.trim());
    if (!m) { err(line, `"${t}" isn't a memory operand. It looks like 8(sp): an offset, then a register in brackets`); return null; }
    const imm = m[1].trim() === '' ? 0 : immediate(line, m[1], -2048, 2047, 'a load or store offset');
    const base = reg(line, m[2]);
    return imm === null || base === null ? null : { imm, base };
  };

  const emit = (p: { addr: number; line: number }, parts: Decoded[]) => {
    parts.forEach((d, i) => put(p.addr + 4 * i, encode(d), p.line, d));
  };
  const D = (op: Op, f: Partial<Decoded>): Decoded => ({ op, fmt: fmtOf(op), rd: 0, rs1: 0, rs2: 0, imm: 0, ...f });

  for (const p of pending) {
    if (p.kind === 'bytes') { p.bytes.forEach((b, i) => { bytes[p.addr + i] = b; }); continue; }
    if (p.kind === 'word') {
      const n = parseNumber(p.value);
      const lab = labels.get(p.value);
      if (n === null && lab === undefined) { err(p.line, `"${p.value}" is neither a number nor a label in this program`); continue; }
      const v = n ?? lab!;
      const limit = p.size === 4 ? 2 ** 32 : p.size === 2 ? 65536 : 256;
      if (v >= limit || v < -limit / 2) { err(p.line, `${v} doesn't fit in ${p.size === 1 ? 'one byte' : `${p.size} bytes`}`); continue; }
      for (let i = 0; i < p.size; i++) bytes[p.addr + i] = (v >>> (8 * i)) & 0xff;
      continue;
    }
    const { op, args, line, addr } = p;
    const need = (n: number, shape: string) => {
      if (args.length === n) return true;
      if (args.length === 1 && /\s/.test(args[0])) err(line, `${op} needs commas between its operands: ${op} ${shape}`);
      else err(line, `${op} takes ${n === 0 ? 'nothing' : `${n} operand${n > 1 ? 's' : ''}`}: ${op}${shape ? ` ${shape}` : ''}. This line has ${args.length}`);
      return false;
    };
    const branchImm = (t: string) => target(line, t, addr, 4096, 'a branch');
    const jumpImm = (t: string) => target(line, t, addr, 1 << 20, 'a jump');

    if (R_FORM.has(op)) {
      if (!need(3, 'rd, rs1, rs2')) continue;
      const [rd, rs1, rs2] = args.map((a) => reg(line, a));
      if (rd === null || rs1 === null || rs2 === null) continue;
      emit(p, [D(op as Op, { rd, rs1, rs2 })]);
    } else if (I_FORM.has(op)) {
      if (!need(3, 'rd, rs1, number')) continue;
      const rd = reg(line, args[0]), rs1 = reg(line, args[1]), imm = immediate(line, args[2], -2048, 2047, `${op}'s number`, 'For a larger number, put it in a register with li first');
      if (rd === null || rs1 === null || imm === null) continue;
      emit(p, [D(op as Op, { rd, rs1, imm })]);
    } else if (SHIFT_FORM.has(op)) {
      if (!need(3, 'rd, rs1, amount')) continue;
      const rd = reg(line, args[0]), rs1 = reg(line, args[1]), imm = immediate(line, args[2], 0, 31, 'a shift amount');
      if (rd === null || rs1 === null || imm === null) continue;
      emit(p, [D(op as Op, { rd, rs1, imm })]);
    } else if (LOAD_FORM.has(op)) {
      if (!need(2, 'rd, offset(rs1)')) continue;
      const rd = reg(line, args[0]), m = memOperand(line, args[1]);
      if (rd === null || !m) continue;
      emit(p, [D(op as Op, { rd, rs1: m.base, imm: m.imm })]);
    } else if (STORE_FORM.has(op)) {
      if (!need(2, 'rs2, offset(rs1)')) continue;
      const rs2 = reg(line, args[0]), m = memOperand(line, args[1]);
      if (rs2 === null || !m) continue;
      emit(p, [D(op as Op, { rs2, rs1: m.base, imm: m.imm })]);
    } else if (BRANCH_FORM.has(op)) {
      if (!need(3, 'rs1, rs2, label')) continue;
      const rs1 = reg(line, args[0]), rs2 = reg(line, args[1]), imm = branchImm(args[2]);
      if (rs1 === null || rs2 === null || imm === null) continue;
      emit(p, [D(op as Op, { rs1, rs2, imm })]);
    } else {
      switch (op) {
        case 'lui': case 'auipc': {
          if (!need(2, 'rd, number')) break;
          const rd = reg(line, args[0]), v = immediate(line, args[1], 0, 0xfffff, `${op}'s number`);
          if (rd === null || v === null) break;
          emit(p, [D(op, { rd, imm: (v << 12) | 0 })]);
          break;
        }
        case 'jal': {
          if (args.length === 1) {
            const imm = jumpImm(args[0]);
            if (imm !== null) emit(p, [D('jal', { rd: 1, imm })]);
            break;
          }
          if (!need(2, 'rd, label')) break;
          const rd = reg(line, args[0]), imm = jumpImm(args[1]);
          if (rd === null || imm === null) break;
          emit(p, [D('jal', { rd, imm })]);
          break;
        }
        case 'jalr': {
          if (args.length === 1) {
            const rs1 = reg(line, args[0]);
            if (rs1 !== null) emit(p, [D('jalr', { rd: 1, rs1 })]);
            break;
          }
          if (args.length === 2) {
            const rd = reg(line, args[0]), m = memOperand(line, args[1]);
            if (rd !== null && m) emit(p, [D('jalr', { rd, rs1: m.base, imm: m.imm })]);
            break;
          }
          if (!need(3, 'rd, rs1, offset')) break;
          const rd = reg(line, args[0]), rs1 = reg(line, args[1]), imm = immediate(line, args[2], -2048, 2047, 'a jalr offset');
          if (rd === null || rs1 === null || imm === null) break;
          emit(p, [D('jalr', { rd, rs1, imm })]);
          break;
        }
        case 'ebreak': if (need(0, '')) emit(p, [D('ebreak', { imm: 1 })]); break;
        case 'nop': if (need(0, '')) emit(p, [D('addi', {})]); break;
        case 'ret': if (need(0, '')) emit(p, [D('jalr', { rs1: 1 })]); break;
        case 'jr': { if (!need(1, 'rs')) break; const rs1 = reg(line, args[0]); if (rs1 !== null) emit(p, [D('jalr', { rs1 })]); break; }
        case 'j': case 'tail': { if (!need(1, 'label')) break; const imm = jumpImm(args[0]); if (imm !== null) emit(p, [D('jal', { imm })]); break; }
        // The manual's expansion is auipc + jalr, which an assembler and linker shrink
        // to one jal whenever the target is near, and on a 64 KB machine it always is.
        case 'call': { if (!need(1, 'label')) break; const imm = jumpImm(args[0]); if (imm !== null) emit(p, [D('jal', { rd: 1, imm })]); break; }
        case 'mv': { if (!need(2, 'rd, rs')) break; const rd = reg(line, args[0]), rs1 = reg(line, args[1]); if (rd !== null && rs1 !== null) emit(p, [D('addi', { rd, rs1 })]); break; }
        case 'not': { if (!need(2, 'rd, rs')) break; const rd = reg(line, args[0]), rs1 = reg(line, args[1]); if (rd !== null && rs1 !== null) emit(p, [D('xori', { rd, rs1, imm: -1 })]); break; }
        case 'neg': { if (!need(2, 'rd, rs')) break; const rd = reg(line, args[0]), rs2 = reg(line, args[1]); if (rd !== null && rs2 !== null) emit(p, [D('sub', { rd, rs2 })]); break; }
        case 'seqz': { if (!need(2, 'rd, rs')) break; const rd = reg(line, args[0]), rs1 = reg(line, args[1]); if (rd !== null && rs1 !== null) emit(p, [D('sltiu', { rd, rs1, imm: 1 })]); break; }
        case 'snez': { if (!need(2, 'rd, rs')) break; const rd = reg(line, args[0]), rs2 = reg(line, args[1]); if (rd !== null && rs2 !== null) emit(p, [D('sltu', { rd, rs2 })]); break; }
        case 'sltz': { if (!need(2, 'rd, rs')) break; const rd = reg(line, args[0]), rs1 = reg(line, args[1]); if (rd !== null && rs1 !== null) emit(p, [D('slt', { rd, rs1 })]); break; }
        case 'sgtz': { if (!need(2, 'rd, rs')) break; const rd = reg(line, args[0]), rs2 = reg(line, args[1]); if (rd !== null && rs2 !== null) emit(p, [D('slt', { rd, rs2 })]); break; }
        case 'beqz': case 'bnez': case 'bgez': case 'bltz': {
          if (!need(2, 'rs, label')) break;
          const rs1 = reg(line, args[0]), imm = branchImm(args[1]);
          if (rs1 === null || imm === null) break;
          emit(p, [D(({ beqz: 'beq', bnez: 'bne', bgez: 'bge', bltz: 'blt' } as Record<string, Op>)[op], { rs1, imm })]);
          break;
        }
        case 'blez': case 'bgtz': {
          if (!need(2, 'rs, label')) break;
          const rs2 = reg(line, args[0]), imm = branchImm(args[1]);
          if (rs2 === null || imm === null) break;
          emit(p, [D(op === 'blez' ? 'bge' : 'blt', { rs2, imm })]);
          break;
        }
        case 'bgt': case 'ble': case 'bgtu': case 'bleu': {
          if (!need(3, 'rs1, rs2, label')) break;
          const rs2 = reg(line, args[0]), rs1 = reg(line, args[1]), imm = branchImm(args[2]);
          if (rs1 === null || rs2 === null || imm === null) break;
          emit(p, [D(({ bgt: 'blt', ble: 'bge', bgtu: 'bltu', bleu: 'bgeu' } as Record<string, Op>)[op], { rs1, rs2, imm })]);
          break;
        }
        case 'li': {
          if (!need(2, 'rd, number')) break;
          const rd = reg(line, args[0]);
          const v = parseNumber(args[1]);
          if (v === null) {
            if (labels.has(args[1])) err(line, `li takes a number, and "${args[1]}" is a label. Use la for a label's address`);
            else err(line, `li needs a number, and "${args[1]}" isn't one`);
            break;
          }
          if (v < -(2 ** 31) || v >= 2 ** 32) { err(line, `${v} doesn't fit in 32 bits`); break; }
          if (rd === null) break;
          const value = v | 0;
          if (value >= -2048 && value <= 2047) { emit(p, [D('addi', { rd, imm: value })]); break; }
          const lo = sext(value & 0xfff, 12), hi = (value - lo) | 0;
          emit(p, lo === 0 ? [D('lui', { rd, imm: hi })] : [D('lui', { rd, imm: hi }), D('addi', { rd, rs1: rd, imm: lo })]);
          break;
        }
        case 'la': {
          if (!need(2, 'rd, label')) break;
          const rd = reg(line, args[0]), off = target(line, args[1], addr, 1 << 30, 'la');
          if (rd === null || off === null) break;
          const lo = sext(off & 0xfff, 12), hi = (off - lo) | 0;
          emit(p, [D('auipc', { rd, imm: hi }), D('addi', { rd, rs1: rd, imm: lo })]);
          break;
        }
        default: err(line, `"${op}" isn't an instruction this machine knows`);
      }
    }
  }
  if (errors.length) { errors.sort((a, b) => a.line - b.line); return { ok: false, errors }; }
  listing.sort((a, b) => a.addr - b.addr);
  return { ok: true, program: { source, bytes, labels, listing, lineOf, textEnd: counters.text, dataEnd: counters.data, lastLine: listing.at(-1)?.line ?? 0 } };
}

function fmtOf(op: Op): Fmt {
  if (R_FORM.has(op)) return 'R';
  if (STORE_FORM.has(op)) return 'S';
  if (BRANCH_FORM.has(op)) return 'B';
  if (op === 'lui' || op === 'auipc') return 'U';
  if (op === 'jal') return 'J';
  return 'I';
}

// ---- the machine ----------------------------------------------------------------

export type Status = 'ready' | 'stopped' | 'returned' | 'fault' | 'budget';
export type StepRecord = {
  pc: number; word: number; d: Decoded; text: string; line: number; nextPc: number;
  regWrite?: { reg: number; value: number; before: number };
  memRead?: { addr: number; size: number; value: number };
  memWrite?: { addr: number; size: number; value: number; before: number };
  rs1Value: number; rs2Value: number; taken?: boolean;
};
export type Fault = { message: string; line: number };
export type Frame = { name: string; calledFromLine: number; sp: number; returnsTo: number };

export type MachineOptions = {
  regs?: Record<string, number>;
  /** Words written to memory before the run: hidden inputs reach a program this way. */
  words?: { addr: number; values: number[] }[];
  budget?: number;
  entry?: number;
  /**
   * The pipelining lesson's hazard demo: a register write only becomes visible this many
   * instruction slots later, which is what a pipeline with no forwarding and no stalls does.
   * Zero is the architecture: each instruction sees all the ones before it.
   */
  writeDelay?: number;
};

/** A Machine runs from bytes alone. The source only names lines for its messages. */
export class Machine {
  regs = new Int32Array(32);
  pc = TEXT_BASE;
  mem: Uint8Array;
  steps = 0;
  status: Status = 'ready';
  fault: Fault | null = null;
  output = '';
  budget: number;
  frames: Frame[] = [];
  /** The lowest sp this run reached, so a lesson can show how deep a stack got. */
  lowestSp = STACK_TOP;
  readonly program: Program;
  private delay: number;
  private delayed: { due: number; reg: number; value: number }[] = [];
  private slot = 0;
  /** Where the last taken jump or branch was, so landing on empty memory can blame it and not "the end of the program". */
  private jumpedFrom: number | null = null;

  constructor(program: Program, opts: MachineOptions = {}) {
    this.program = program;
    this.mem = program.bytes.slice();
    this.budget = opts.budget ?? DEFAULT_BUDGET;
    this.delay = opts.writeDelay ?? 0;
    this.regs[2] = STACK_TOP | 0;
    this.regs[1] = EXIT_ADDR | 0;
    this.pc = opts.entry ?? TEXT_BASE;
    for (const [name, v] of Object.entries(opts.regs ?? {})) {
      const i = REG_INDEX.get(name);
      if (i === undefined) throw new Error(`no register called ${name}`);
      if (i !== 0) this.regs[i] = v | 0;
    }
    for (const block of opts.words ?? []) {
      block.values.forEach((v, k) => this.store(block.addr + 4 * k, 4, v));
    }
  }

  private store(addr: number, size: number, value: number) {
    for (let i = 0; i < size; i++) this.mem[addr + i] = (value >>> (8 * i)) & 0xff;
  }
  private load(addr: number, size: number): number {
    let v = 0;
    for (let i = 0; i < size; i++) v |= this.mem[addr + i] << (8 * i);
    return v;
  }
  readWord(addr: number): number { return this.load(addr, 4) | 0; }
  labelAddr(name: string) { return this.program.labels.get(name); }
  reg(name: string) { return this.regs[REG_INDEX.get(name)!]; }

  private fail(message: string, pc = this.pc) {
    this.status = 'fault';
    const line = this.program.lineOf.get(pc) ?? 0;
    this.fault = { message, line };
    return null;
  }

  /** Why an access can't go ahead, in words, or null if it can. */
  private refuseAccess(addr: number, size: number, write: boolean): string | null {
    const a = addr >>> 0;
    const verb = write ? 'write to' : 'read from';
    if (a === OUT_ADDR) {
      if (!write) return `${hexAddr(a)} is the output address, and it can only be written`;
      return size === 1 ? null : `the output address takes one byte at a time, so use sb`;
    }
    if (a % size !== 0) return `tried to ${verb} ${size} bytes at ${hexAddr(a)}, which isn't a multiple of ${size}. The RISC-V manual lets each machine choose what to do about that, and this one refuses`;
    if (a >= GUARD_BASE && a < STACK_BASE) return `tried to ${verb} ${hexAddr(a)}, in the guard area below the stack. That's a stack overflow if sp got there: the stack holds ${(STACK_TOP - STACK_BASE) / 1024} KB`;
    if (a + size > MEM_SIZE) return `tried to ${verb} ${hexAddr(a)}, and this machine's memory stops at ${hexAddr(MEM_SIZE - 1)}`;
    return null;
  }

  /** Fetch, decode, execute, once. Returns null if the machine stopped instead. */
  step(): StepRecord | null {
    if (this.status !== 'ready') return null;
    if (this.steps >= this.budget) {
      this.status = 'budget';
      this.fault = { message: `stopped after ${this.budget.toLocaleString('en-US')} steps. A loop whose exit is never reached looks like this: the program hasn't failed, and it hasn't finished either`, line: this.program.lineOf.get(this.pc) ?? 0 };
      return null;
    }
    const pc = this.pc >>> 0;
    if (pc === EXIT_ADDR) { this.drain(); this.status = 'returned'; return null; }
    if (pc + 4 > MEM_SIZE) return this.fail(`jumped to ${hexAddr(pc)}, outside this machine's memory. A wrong value in ra is the usual cause`);

    // Fetch: the instruction is read out of the same memory the data lives in.
    const word = this.load(pc, 4) >>> 0;
    const dec = decode(word);
    if (!dec.ok) {
      if (word === 0 && pc >= this.program.textEnd) {
        // Three different mistakes land here, and "ran off the end" is only true of the last.
        // An empty box used to blame "line 0", and a jump through a bad ra blamed the jump's own line as the last one.
        if (!this.program.listing.length) return this.fail('this program has no instructions, so there is nothing to run. Comments and .data sections don\'t count as code', pc);
        if (this.jumpedFrom !== null) return this.fail(`jumped to ${hexAddr(pc)}, where nothing has been written, so there's no instruction there. A wrong value in ra, or in the register it jumped through, is the usual cause`, this.jumpedFrom);
        return this.fail(`ran off the end of the program: the instruction on line ${this.program.lastLine} was the last one, and nothing after it is code. End with ebreak or ret`, pc);
      }
      return this.fail(`the bytes at ${hexAddr(pc)} are ${hex32(word)}, and they aren't an instruction this machine runs: ${dec.why}`);
    }
    const d = dec.d;
    const text = disassemble(d, pc);
    if (d.op === 'ebreak') {
      this.steps++;
      this.drain();
      this.status = 'stopped';
      return { pc, word, d, text, line: this.program.lineOf.get(pc) ?? 0, nextPc: pc, rs1Value: 0, rs2Value: 0 };
    }

    // Stale reads for the hazard demo: a write from fewer than `delay` slots ago hasn't
    // landed yet, so this instruction reads what was there before it.
    if (this.delay) this.applyDue();

    const a = this.regs[d.rs1], b = this.regs[d.rs2];
    const rec: StepRecord = { pc, word, d, text, line: this.program.lineOf.get(pc) ?? 0, nextPc: (pc + 4) >>> 0, rs1Value: a, rs2Value: b };
    let result: number | null = null;
    switch (d.op) {
      case 'lui': result = d.imm; break;
      case 'auipc': result = (pc + d.imm) | 0; break;
      case 'addi': result = (a + d.imm) | 0; break;
      case 'slti': result = a < d.imm ? 1 : 0; break;
      case 'sltiu': result = (a >>> 0) < (d.imm >>> 0) ? 1 : 0; break;
      case 'xori': result = a ^ d.imm; break;
      case 'ori': result = a | d.imm; break;
      case 'andi': result = a & d.imm; break;
      case 'slli': result = a << d.imm; break;
      case 'srli': result = (a >>> d.imm) | 0; break;
      case 'srai': result = a >> d.imm; break;
      case 'add': result = (a + b) | 0; break;
      case 'sub': result = (a - b) | 0; break;
      case 'sll': result = a << (b & 31); break;
      case 'slt': result = a < b ? 1 : 0; break;
      case 'sltu': result = (a >>> 0) < (b >>> 0) ? 1 : 0; break;
      case 'xor': result = a ^ b; break;
      case 'srl': result = (a >>> (b & 31)) | 0; break;
      case 'sra': result = a >> (b & 31); break;
      case 'or': result = a | b; break;
      case 'and': result = a & b; break;
      case 'beq': case 'bne': case 'blt': case 'bge': case 'bltu': case 'bgeu': {
        const taken = d.op === 'beq' ? a === b : d.op === 'bne' ? a !== b : d.op === 'blt' ? a < b : d.op === 'bge' ? a >= b : d.op === 'bltu' ? (a >>> 0) < (b >>> 0) : (a >>> 0) >= (b >>> 0);
        rec.taken = taken;
        if (taken) {
          const t = (pc + d.imm) >>> 0;
          if (t % 4) return this.fail(`branches to ${hexAddr(t)}, which isn't on a 4-byte boundary. The manual makes that an exception, reported on the branch`);
          rec.nextPc = t;
        }
        break;
      }
      case 'jal': case 'jalr': {
        const t = d.op === 'jal' ? (pc + d.imm) >>> 0 : ((a + d.imm) & ~1) >>> 0;
        if (t % 4) return this.fail(`jumps to ${hexAddr(t)}, which isn't on a 4-byte boundary. The manual makes that an exception, reported on the jump`);
        rec.nextPc = t;
        rec.taken = true;
        result = (pc + 4) | 0;
        break;
      }
      case 'lb': case 'lh': case 'lw': case 'lbu': case 'lhu': {
        const addr = (a + d.imm) >>> 0;
        const size = d.op === 'lw' ? 4 : d.op === 'lh' || d.op === 'lhu' ? 2 : 1;
        const why = this.refuseAccess(addr, size, false);
        if (why) return this.fail(`${d.op} ${why}`);
        const raw = this.load(addr, size);
        result = d.op === 'lb' ? sext(raw, 8) : d.op === 'lh' ? sext(raw, 16) : d.op === 'lw' ? raw | 0 : raw;
        rec.memRead = { addr, size, value: result };
        break;
      }
      case 'sb': case 'sh': case 'sw': {
        const addr = (a + d.imm) >>> 0;
        const size = d.op === 'sw' ? 4 : d.op === 'sh' ? 2 : 1;
        const why = this.refuseAccess(addr, size, true);
        if (why) return this.fail(`${d.op} ${why}`);
        const value = size === 4 ? b : b & (size === 2 ? 0xffff : 0xff);
        if (addr === OUT_ADDR) {
          this.output += String.fromCharCode(b & 0xff);
          rec.memWrite = { addr, size, value, before: 0 };
          break;
        }
        rec.memWrite = { addr, size, value, before: this.load(addr, size) | 0 };
        this.store(addr, size, b);
        break;
      }
    }
    if (result !== null) {
      // Writing x0 does nothing, by the manual's rule: it's how `j` throws away its return address.
      rec.regWrite = { reg: d.rd, value: d.rd === 0 ? 0 : result, before: this.regs[d.rd] };
      if (d.rd !== 0) {
        if (this.delay) this.delayed.push({ due: this.slot + this.delay, reg: d.rd, value: result });
        else this.regs[d.rd] = result;
      }
    }
    this.trackFrames(rec);
    this.jumpedFrom = rec.taken ? pc : null;
    this.pc = rec.nextPc;
    this.steps++;
    this.slot += 1;
    if (this.delay && rec.nextPc !== pc + 4) this.slot += 2;
    if (this.regs[2] >>> 0 < this.lowestSp) this.lowestSp = this.regs[2] >>> 0;
    return rec;
  }

  /** A stopped pipeline finishes what's already in it, so the final registers show every write. */
  private drain() {
    for (const w of this.delayed) this.regs[w.reg] = w.value;
    this.delayed = [];
  }

  private applyDue() {
    this.delayed = this.delayed.filter((w) => {
      if (w.due > this.slot) return true;
      this.regs[w.reg] = w.value;
      return false;
    });
  }

  // The CPU keeps no list of calls: it has a register called sp and some memory. This list
  // is the lab's own, worked out from jumps that follow the convention, to help a person read
  // the stack. A program that keeps its own convention will confuse it, and that's all it can do.
  private trackFrames(r: StepRecord) {
    if (r.d.op !== 'jal' && r.d.op !== 'jalr') return;
    if (r.d.rd === 1) {
      const name = [...this.program.labels.entries()].find(([, a]) => a === r.nextPc)?.[0] ?? hexAddr(r.nextPc);
      this.frames.push({ name, calledFromLine: r.line, sp: this.regs[2] >>> 0, returnsTo: (r.pc + 4) >>> 0 });
    } else if (r.d.op === 'jalr' && r.d.rd === 0 && r.d.rs1 === 1 && this.frames.length) this.frames.pop();
  }

  run(): Status {
    while (this.status === 'ready') this.step();
    return this.status;
  }

  /** The words from sp up to the top of the stack, lowest address first. */
  stackWords(limit = 64): { addr: number; value: number; returnLine?: number }[] {
    const sp = this.regs[2] >>> 0;
    const out: { addr: number; value: number; returnLine?: number }[] = [];
    if (sp % 4 !== 0 || sp >= STACK_TOP || sp < STACK_BASE) return out;
    for (let a = sp; a < STACK_TOP && out.length < limit; a += 4) {
      const value = this.readWord(a);
      out.push({ addr: a, value, returnLine: this.program.lineOf.get(value >>> 0) });
    }
    return out;
  }
}

export type RunResult = { ok: true; machine: Machine } | { ok: false; errors: AsmError[] };

export function runSource(source: string, opts: MachineOptions = {}): RunResult {
  const a = assemble(source);
  if (!a.ok) return { ok: false, errors: a.errors };
  const machine = new Machine(a.program, opts);
  machine.run();
  return { ok: true, machine };
}

/** What each register must hold after a call, by the standard calling convention. */
export const CALLEE_SAVED = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
const CALLER_SAVED = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];
// The psABI's "Unallocatable" pair: "procedures should not modify the integer registers tp and gp".
const RESERVED = ['gp', 'tp'];
// The psABI: sp "shall be aligned to a 128-bit boundary upon procedure entry", and it "must remain
// aligned throughout procedure execution". The machine itself only cares about word alignment,
// so without this check the mission taught 8-byte frames under the name of the convention.
export const STACK_ALIGN = 16;

export type CallResult = { ok: true; value: number; steps: number; machine: Machine } | { ok: false; why: string };

/**
 * Calls one labelled function the way compiled code would: arguments in a0 and up, a return
 * address in ra, and a real stack. Registers the convention says a function may trash start
 * as garbage, so code that reads one uninitialised can't get lucky, and registers it must
 * preserve are checked afterwards. sp is checked on every step, because a frame of the wrong
 * size can be given back correctly and look fine at the end.
 */
export function callFunction(program: Program, label: string, args: number[], opts: { budget?: number; words?: { addr: number; values: number[] }[] } = {}): CallResult {
  const entry = program.labels.get(label);
  if (entry === undefined) return { ok: false, why: `there's no label called ${label} in your program` };
  const regs: Record<string, number> = {};
  CALLER_SAVED.forEach((r, i) => { regs[r] = (0x5a5a0000 + i) | 0; });
  CALLEE_SAVED.forEach((r, i) => { regs[r] = (0x53530000 + i) | 0; });
  RESERVED.forEach((r, i) => { regs[r] = (0x47500000 + i) | 0; });
  ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].forEach((r, i) => { if (i < args.length) regs[r] = args[i] | 0; });
  const m = new Machine(program, { regs, entry, budget: opts.budget, words: opts.words });
  while (m.status === 'ready') {
    const rec = m.step();
    if (rec && m.regs[2] % STACK_ALIGN !== 0) return { ok: false, why: `line ${rec.line}: sp is now ${hexAddr(m.regs[2])}, which isn't a multiple of ${STACK_ALIGN}. The convention keeps sp a multiple of ${STACK_ALIGN} the whole way through a function, so a frame takes ${STACK_ALIGN} bytes, or ${STACK_ALIGN * 2}, even if it needs less` };
  }
  const status = m.status;
  if (status === 'fault') return { ok: false, why: m.fault!.line ? `line ${m.fault!.line}: ${m.fault!.message}` : m.fault!.message };
  if (status === 'budget') return { ok: false, why: `${label}(${args.join(', ')}) never finished: ${m.fault!.message}` };
  if (status === 'stopped') return { ok: false, why: `${label}(${args.join(', ')}) stopped at ebreak instead of returning with ret, so its caller never got control back` };
  if (m.reg('sp') >>> 0 !== STACK_TOP) return { ok: false, why: `${label}(${args.join(', ')}) returned with sp at ${hexAddr(m.reg('sp'))} when it was ${hexAddr(STACK_TOP)} on the way in. A function has to give back the stack it took` };
  for (const [i, r] of CALLEE_SAVED.entries()) {
    if (m.reg(r) !== ((0x53530000 + i) | 0)) return { ok: false, why: `${label}(${args.join(', ')}) changed ${r} and didn't put it back. The convention says a function must preserve s0 to s11: save it on the stack first` };
  }
  for (const [i, r] of RESERVED.entries()) {
    if (m.reg(r) !== ((0x47500000 + i) | 0)) return { ok: false, why: `${label}(${args.join(', ')}) changed ${r}. The convention reserves gp and tp, and a function shouldn't write to them at all` };
  }
  return { ok: true, value: m.reg('a0'), steps: m.steps, machine: m };
}
