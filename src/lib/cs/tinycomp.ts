// The tiny compiler of "A tiny compiler" parts one and two: text to tokens to tree to
// instructions, for arithmetic. Its arithmetic is the Python engine's own binop, which
// tests/py-parity.test.ts already holds to real Python, and tests/tinycomp.test.ts holds
// this whole pipeline to real Python by differential fuzz, errors and error positions
// included. The operators and their precedence were taken from Python's grammar, so a
// disagreement with Python is a bug here, never a difference of taste.
//
// The targets are two small machines invented for this lesson, not any real chip: TSM, a
// stack machine, and TRM, a register machine. The lesson says so. Neither has branches or
// calls, because the language has no way to ask for them.

import { binop, unary, repr, PyRaise, SandboxStop, type PyTuple, type Val } from '../py/values.ts';

export type Num = bigint | number;
export type Tree =
  | { k: 'num'; value: Num; start: number; end: number }
  | { k: 'name'; name: string; start: number; end: number }
  | { k: 'un'; op: '-' | '+'; x: Tree; start: number; end: number }
  | { k: 'bin'; op: BinOp; l: Tree; r: Tree; at: number; start: number; end: number };
export type BinOp = '+' | '-' | '*' | '/' | '//' | '%' | '**';

export type Token = { t: 'num' | 'name' | 'op' | 'end' | 'bad'; text: string; at: number };

/** A problem with the text, and the column it belongs to (0 is the first character). */
export class TinySyntaxError extends Error {
  readonly col: number;
  /** syntax: not a sentence of this language. refused: real Python has it, this tiny language leaves it out. */
  readonly kind: 'syntax' | 'refused' | 'name';
  constructor(kind: 'syntax' | 'refused' | 'name', col: number, message: string) { super(message); this.kind = kind; this.col = col; }
}

const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9';
const isNameStart = (c: string | undefined) => c !== undefined && /^[A-Za-z_]$/.test(c);
const isNamePart = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9_]$/.test(c);
const isLetter = (c: string | undefined) => c !== undefined && /^[A-Za-z]$/.test(c);

// Python's numeric literals, from its lexical grammar, so the lab can say which of them real
// Python reads. A looser pattern here told learners that 1_ and 0b12 were numbers in real
// Python, when both are syntax errors. tests/tinycomp.test.ts fuzzes this against Python.
const D = '[0-9](?:_?[0-9])*';
const POINT = `(?:(?:${D})?\\.${D}|${D}\\.)`;
const EXP = `[eE][+-]?${D}`;
const FLOAT = `(?:${POINT}(?:${EXP})?|${D}${EXP})`;
const PY_LITERAL = new RegExp(`^(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|[1-9](?:_?[0-9])*|0+(?:_?0)*|${FLOAT}|(?:${FLOAT}|${D})[jJ])$`);
/** Would real Python read this whole text as one number? */
export const isPythonNumber = (text: string) => PY_LITERAL.test(text);

// Characters people reach for that aren't operators here. Silently reading any of them as
// the nearest operator would make the compiler answer a question nobody asked.
const NOT_HERE: Record<string, string> = {
  '^': "^ isn't a power in Python, it's a bitwise operation, and this tiny language leaves it out. Python's power is **",
  '×': 'This language multiplies with *',
  '÷': 'This language divides with /',
  '−': 'That is a typographic minus sign, which Python refuses too. Use the - on your keyboard',
  '=': 'This language has expressions only: it has no = and no comparisons',
  '<': 'This language has no comparisons',
  '>': 'This language has no comparisons',
  '!': 'This language has no comparisons',
  ',': 'This language has no lists or arguments, so nothing here uses a comma',
  '&': 'This language has arithmetic only: no bitwise operators',
  '|': 'This language has arithmetic only: no bitwise operators',
  '~': 'This language has arithmetic only: no bitwise operators',
  '[': 'This language has no lists',
  ']': 'This language has no lists',
  '{': 'This language has no sets or dictionaries',
  '}': 'This language has no sets or dictionaries',
  '"': 'This language has numbers only: no strings',
  "'": 'This language has numbers only: no strings',
};

/** The tokens as far as they go, and the problem that stopped them if one did. */
export function scan(text: string): { tokens: Token[]; error: TinySyntaxError | null } {
  const out: Token[] = [];
  try { readTokens(text, out); return { tokens: out, error: null }; }
  catch (e) { if (e instanceof TinySyntaxError) return { tokens: out, error: e }; throw e; }
}

export function tokenize(text: string): Token[] {
  const { tokens, error } = scan(text);
  if (error) throw error;
  return tokens;
}

function readTokens(text: string, out: Token[]): void {
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      const start = i;
      while (isDigit(text[i])) i++;
      if (text[i] === '.') { i++; while (isDigit(text[i])) i++; }
      const word = text.slice(start, i);
      if (text[i] === '_' || isNameStart(text[i])) {
        // 1e5, 0x10, 1_000 and 2x all arrive here. Real Python reads the first three as
        // numbers, so calling them syntax errors would be wrong: they're refused by name.
        const j = literalEnd(text, start, i, word.includes('.'));
        const whole = text.slice(start, j);
        if (isPythonNumber(whole)) throw new TinySyntaxError('refused', start, `Real Python reads ${whole} as a number. This tiny language only has plain numbers like 12 and 1.5`);
        // Shaped like a number, and real Python refuses it: 1_, 0b12, 1e. Saying "did you mean
        // 1 * _" here would send someone off after a variable they never meant.
        if (/^[0-9.]*_/.test(whole) || /^0[xXoObB]/.test(whole) || /^[0-9.]+[eE][+-]?[0-9_]*$/.test(whole)) throw new TinySyntaxError('syntax', start, `Real Python refuses ${whole} too: it isn't a valid number there. This tiny language only has plain numbers like 12 and 1.5`);
        // Python points at the last digit here, so this does too.
        throw new TinySyntaxError('syntax', i - 1, `A number can't run straight into letters. Did you mean ${word} * ${whole.slice(word.length)}? This language needs the *`);
      }
      // Python's own rule: 007 is an error, because old Python read it as octal. This has to
      // come after the check above: 007e5 and 007j are valid numbers in real Python.
      if (/^0[0-9]+$/.test(word) && !/^0+$/.test(word)) throw new TinySyntaxError('syntax', start, 'A whole number can\'t start with 0. Python refuses this too');
      out.push({ t: 'num', text: word, at: start });
      continue;
    }
    if (isNameStart(c)) {
      const start = i;
      while (isNamePart(text[i])) i++;
      out.push({ t: 'name', text: text.slice(start, i), at: start });
      continue;
    }
    if (c === '*' && text[i + 1] === '*') { out.push({ t: 'op', text: '**', at: i }); i += 2; continue; }
    if (c === '/' && text[i + 1] === '/') { out.push({ t: 'op', text: '//', at: i }); i += 2; continue; }
    if ('+-*/%()'.includes(c)) { out.push({ t: 'op', text: c, at: i }); i++; continue; }
    const why = NOT_HERE[c];
    if (why) throw new TinySyntaxError('refused', i, why);
    throw new TinySyntaxError('syntax', i, `This language has no use for the character ${JSON.stringify(c)}`);
  }
  out.push({ t: 'end', text: '', at: text.length });
}

/**
 * Where a run of characters that could be one number ends. A sign counts only straight after
 * an exponent's e with a digit behind it, and never after a 0x: 0xe+1 is 0xe plus 1 in real
 * Python, where the old scan took the +1 as part of the number and called the lot a mistake.
 */
function literalEnd(text: string, start: number, from: number, hasDot: boolean): number {
  const prefixed = /^0[xXoObB]/.test(text.slice(start, start + 2));
  let j = from, dot = hasDot;
  while (j < text.length) {
    const c = text[j];
    if (isNamePart(c)) { j++; continue; }
    if (prefixed) break;
    const sofar = text.slice(start, j);
    if (c === '.' && !dot && !/[eE]/.test(sofar) && !isLetter(text[j + 1])) { dot = true; j++; continue; }
    if ((c === '+' || c === '-') && /^[0-9_.]*[eE]$/.test(sofar) && isDigit(text[j + 1])) { j++; continue; }
    break;
  }
  return j;
}

/**
 * The parsers a learner can pick. Only 'correct' is meant to work. The others are the
 * mistakes the lesson is about, each a real way to write this wrong: 'flat' has one
 * precedence level for + - * / // %, 'right' groups + and - from the right, and 'excel' follows
 * the order in Microsoft's published table for Excel, where negation comes before the power and
 * equal operators go left to right. It's a rule another program really has, not a bug in that
 * program, which is why the widget calls this one a different rule. It borrows only the
 * grouping: the marks and the arithmetic stay this page's, and Excel itself was never run.
 */
export type ParserMode = 'correct' | 'flat' | 'right' | 'excel';

const KEYWORD = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);

class Parser {
  toks: Token[];
  i = 0;
  mode: ParserMode;
  /** Where each still-open ( is, innermost last. */
  open: number[] = [];
  badToken: TinySyntaxError | null;
  constructor(text: string, mode: ParserMode) {
    const { tokens, error } = scan(text);
    this.toks = error ? [...tokens, { t: 'bad', text: '', at: error.col }] : tokens;
    // On the Excel rule, "^ isn't a power in Python" answers the wrong question.
    this.badToken = mode === 'excel' && error && text[error.col] === '^' ? new TinySyntaxError('refused', error.col, 'Excel writes its power as ^. This rule keeps the rest of the lab\'s marks, so type ** here: only the order comes from Excel\'s table') : error;
    this.mode = mode;
  }
  // A bad character only stops the parser when reading reaches it, so the first thing wrong
  // in reading order is what gets reported, as a person reading along would find it.
  get cur() {
    const c = this.toks[this.i];
    if (c.t === 'bad') throw this.badToken!;
    return c;
  }
  isOp(...ops: string[]) { return this.cur.t === 'op' && ops.includes(this.cur.text); }
  atEnd() { return this.cur.t === 'end'; }

  /** Every way to continue is wrong here, so say what was found, at the place it was found. */
  unexpected(wanted: string): never {
    throw new TinySyntaxError('syntax', this.cur.at, `Expected ${wanted}, and found ${this.cur.text}`);
  }

  /** The text ran out. With a bracket open, that bracket is the news: it's what Python points at, and usually the real mistake. */
  ranOut(wanted: string): never {
    if (this.open.length) throw new TinySyntaxError('syntax', this.open.at(-1)!, 'This ( is never closed');
    throw new TinySyntaxError('syntax', this.cur.at, `The text ended here, and ${wanted} was still needed`);
  }

  parseAll(): Tree {
    if (this.atEnd()) throw new TinySyntaxError('syntax', 0, 'There is nothing here to read yet');
    const t = this.expr();
    if (!this.atEnd()) {
      if (this.cur.text === ')') throw new TinySyntaxError('syntax', this.cur.at, 'This ) has no ( to close');
      throw new TinySyntaxError('syntax', this.cur.at, `Expected an operator here, and found ${this.cur.text}`);
    }
    return t;
  }

  expr(): Tree {
    if (this.mode === 'flat') return this.flat();
    if (this.mode === 'right') return this.rightSum();
    let l = this.term();
    while (this.isOp('+', '-')) {
      const op = this.cur.text as BinOp, at = this.cur.at;
      this.i++;
      const r = this.term();
      l = { k: 'bin', op, l, r, at, start: l.start, end: r.end };
    }
    return l;
  }

  flat(): Tree {
    let l = this.factor();
    while (this.isOp('+', '-', '*', '/', '//', '%', '**')) {
      const op = this.cur.text as BinOp, at = this.cur.at;
      this.i++;
      const r = this.factor();
      l = { k: 'bin', op, l, r, at, start: l.start, end: r.end };
    }
    return l;
  }

  rightSum(): Tree {
    const l = this.term();
    if (!this.isOp('+', '-')) return l;
    const op = this.cur.text as BinOp, at = this.cur.at;
    this.i++;
    const r = this.rightSum();
    return { k: 'bin', op, l, r, at, start: l.start, end: r.end };
  }

  term(): Tree {
    let l = this.factor();
    while (this.isOp('*', '/', '//', '%')) {
      // Excel's % is a percent mark and it has no //, so neither has a place in its table as
      // an operator between two values. Answering with Python's remainder under "Excel's
      // table" would present this page's choice as Excel's.
      if (this.mode === 'excel' && this.isOp('//', '%')) throw new TinySyntaxError('refused', this.cur.at, `Excel's table has no ${this.cur.text} between two values (its % is a percent mark), so this rule refuses it. Use the correct parser for Python's ${this.cur.text}`);
      const op = this.cur.text as BinOp, at = this.cur.at;
      this.i++;
      const r = this.factor();
      l = { k: 'bin', op, l, r, at, start: l.start, end: r.end };
    }
    return l;
  }

  // Python's grammar: a sign on the left of ** wraps the whole power, so -2**2 is -(2**2),
  // while a sign on the right is part of the exponent, so 2**-1 is fine.
  factor(): Tree {
    // Before any sign is read: the Excel rule owns its signs. This line once sat after the sign
    // was consumed, which threw the sign away: -5 gave 5, 2 * -3 gave 6, -3 ** 3 gave 27, and
    // the widget said "Neither program is broken". Only -2 ** 2 was tested, where dropping the
    // minus gives the right answer from the wrong tree.
    if (this.mode === 'excel') return this.excelPowers(this.signed());
    if (this.isOp('-', '+')) {
      const op = this.cur.text as '-' | '+', start = this.cur.at;
      this.i++;
      const x = this.factor();
      return { k: 'un', op, x, start, end: x.end };
    }
    return this.power();
  }

  /** A sign and what it's stuck to, for the 'excel' rule: the sign binds first. */
  signed(): Tree {
    // Microsoft's table lists negation and nothing about a leading +, so where that sign
    // would group is something this rule doesn't know and won't guess.
    if (this.isOp('+')) throw new TinySyntaxError('refused', this.cur.at, 'Microsoft\'s table lists negation and doesn\'t mention a leading +, so this rule refuses it');
    if (this.isOp('-')) {
      const op = this.cur.text as '-' | '+', start = this.cur.at;
      this.i++;
      const x = this.signed();
      return { k: 'un', op, x, start, end: x.end };
    }
    return this.atom();
  }

  excelPowers(first: Tree): Tree {
    let l = first;
    while (this.isOp('**')) {
      const at = this.cur.at;
      this.i++;
      const r = this.signed();
      l = { k: 'bin', op: '**', l, r, at, start: l.start, end: r.end };
    }
    return l;
  }

  power(): Tree {
    const base = this.atom();
    if (!this.isOp('**')) return base;
    const at = this.cur.at;
    this.i++;
    const r = this.factor();
    return { k: 'bin', op: '**', l: base, r, at, start: base.start, end: r.end };
  }

  atom(): Tree {
    const c = this.cur;
    if (c.t === 'num') {
      this.i++;
      this.noCall(c);
      const value: Num = /\./.test(c.text) ? Number(c.text) : BigInt(c.text);
      return { k: 'num', value, start: c.at, end: c.at + c.text.length };
    }
    if (c.t === 'name') {
      if (KEYWORD.has(c.text)) throw new TinySyntaxError('refused', c.at, `${c.text} is a word Python keeps for itself, and this tiny language doesn't use it`);
      this.i++;
      this.noCall(c);
      return { k: 'name', name: c.text, start: c.at, end: c.at + c.text.length };
    }
    if (this.isOp('(')) {
      // A deep enough stack of brackets overflows this recursion. Real Python stops much
      // the same text with its own limit, so refuse instead of crashing into a sandbox bug.
      if (this.open.length >= 150) throw new TinySyntaxError('refused', c.at, 'That is more brackets inside brackets than this page will follow');
      this.open.push(c.at);
      this.i++;
      // () is real Python, an empty tuple, so it isn't a syntax error to call it one.
      if (this.isOp(')')) throw new TinySyntaxError('refused', c.at, '() is an empty tuple in real Python. This tiny language only has numbers, so brackets need something inside');
      const inner = this.expr();
      if (!this.isOp(')')) {
        if (this.atEnd()) this.ranOut('a )');
        this.unexpected('an operator or )');
      }
      this.open.pop();
      const close = this.cur;
      this.i++;
      this.noCall(close);
      return inner;
    }
    if (c.t === 'end') this.ranOut('a number or a name');
    if (c.text === ')') throw new TinySyntaxError('syntax', c.at, this.toks.slice(0, this.i).some((t) => t.text === '(') ? 'Expected a number or a name before this )' : 'This ) has no ( to close');
    throw new TinySyntaxError('syntax', c.at, `Expected a number, a name or (, and found ${c.text}`);
  }

  /** 2(3) is a call of a number in real Python, a TypeError at run time. It's never the multiplication it looks like. */
  noCall(c: Token) {
    if (this.isOp('(')) throw new TinySyntaxError('refused', this.cur.at, `A bracket straight after ${c.text} means a call in Python, not multiplication, and this tiny language has no calls. Put a * between them`);
  }
}

/** Long enough for anyone typing, and short enough that the tree-walks can't overflow a stack. */
export const MAX_TEXT = 1000;

export function parse(text: string, mode: ParserMode = 'correct'): Tree {
  if (text.length > MAX_TEXT) throw new TinySyntaxError('refused', MAX_TEXT, `This page stops at ${MAX_TEXT} characters`);
  return new Parser(text, mode).parseAll();
}

/**
 * Names are checked against what's bound before any code is generated. This is where the
 * tiny compiler is stricter than Python, which compiles an unknown name happily and raises
 * NameError only if that line runs. It's a choice, and the lesson says which it made.
 */
export function checkNames(t: Tree, env: Record<string, Num>): void {
  if (t.k === 'name') { if (!Object.hasOwn(env, t.name)) throw new TinySyntaxError('name', t.start, `Nothing called ${t.name} is defined. This compiler knows: ${Object.keys(env).join(', ')}`); }
  else if (t.k === 'un') checkNames(t.x, env);
  else if (t.k === 'bin') { checkNames(t.l, env); checkNames(t.r, env); }
}

// ---- Values and failure at run time

export type RunFailure = { type: string; message: string };
export type Outcome = { ok: true; value: Num; text: string } | { ok: false; error: RunFailure };

export function arith(op: BinOp, a: Num, b: Num): Num { return binop(op, a as Val, b as Val) as Num; }
export function negate(op: '-' | '+', a: Num): Num { return unary(op, a as Val) as Num; }

function outcomeOf(f: () => Num): Outcome {
  try { const value = f(); return { ok: true, value, text: repr(value as Val) }; }
  catch (e) {
    if (e instanceof PyRaise) { const args = e.exc.attrs.get('args') as PyTuple | undefined; return { ok: false, error: { type: e.exc.cls.name, message: String(args?.items[0] ?? '') } }; }
    if (e instanceof SandboxStop) return { ok: false, error: { type: 'SandboxLimit', message: e.message } };
    throw e;
  }
}

/** The tree read directly, with no instructions at all: an interpreter, kept as the check on the compiler. */
export function evaluate(t: Tree, env: Record<string, Num> = {}): Outcome {
  const go = (n: Tree): Num => {
    switch (n.k) {
      case 'num': return n.value;
      case 'name': return env[n.name];
      case 'un': return negate(n.op, go(n.x));
      case 'bin': { const l = go(n.l), r = go(n.r); return arith(n.op, l, r); }
    }
  };
  return outcomeOf(() => go(t));
}

// ---- Target 1: TSM, the Tiny Stack Machine

export const STACK_OP: Record<BinOp, string> = { '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '//': 'FLOORDIV', '%': 'MOD', '**': 'POW' };
const OP_OF: Record<string, BinOp> = Object.fromEntries(Object.entries(STACK_OP).map(([k, v]) => [v, k as BinOp]));

export type StackInstr =
  | { op: 'PUSH'; value: Num }
  | { op: 'LOAD'; name: string }
  | { op: 'NEG' | 'POS' }
  | { op: 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'FLOORDIV' | 'MOD' | 'POW' };

export type GenMode = 'correct' | 'swapped';

/**
 * Left, then right, then the operator: on the way out of the tree, children before parent.
 * 'swapped' is the bug a learner has to find, right before left. It still passes on + and *.
 */
export function genStack(t: Tree, mode: GenMode = 'correct'): StackInstr[] {
  switch (t.k) {
    case 'num': return [{ op: 'PUSH', value: t.value }];
    case 'name': return [{ op: 'LOAD', name: t.name }];
    case 'un': return [...genStack(t.x, mode), { op: t.op === '-' ? 'NEG' : 'POS' }];
    case 'bin': {
      const l = genStack(t.l, mode), r = genStack(t.r, mode);
      return [...(mode === 'swapped' ? r : l), ...(mode === 'swapped' ? l : r), { op: STACK_OP[t.op] as 'ADD' }];
    }
  }
}

export type StackStep = { pc: number; instr: StackInstr; stack: Num[]; error?: RunFailure };
export type StackRun = { outcome: Outcome; trace: StackStep[]; maxDepth: number };

export function runStack(program: StackInstr[], env: Record<string, Num> = {}): StackRun {
  const stack: Num[] = [];
  const trace: StackStep[] = [];
  let maxDepth = 0;
  for (let pc = 0; pc < program.length; pc++) {
    const ins = program[pc];
    const stepped = outcomeOf(() => {
      if (ins.op === 'PUSH') stack.push(ins.value);
      else if (ins.op === 'LOAD') stack.push(env[ins.name]);
      else if (ins.op === 'NEG' || ins.op === 'POS') stack.push(negate(ins.op === 'NEG' ? '-' : '+', stack.pop()!));
      else { const b = stack.pop()!, a = stack.pop()!; stack.push(arith(OP_OF[ins.op], a, b)); }
      return 0n;
    });
    maxDepth = Math.max(maxDepth, stack.length);
    if (!stepped.ok) {
      trace.push({ pc, instr: ins, stack: [...stack], error: stepped.error });
      return { outcome: stepped, trace, maxDepth };
    }
    trace.push({ pc, instr: ins, stack: [...stack] });
  }
  // A compiler bug must never read as an answer: exactly one value is what a right program leaves.
  if (stack.length !== 1) throw new Error(`a tiny-compiler bug: the program left ${stack.length} values on the stack`);
  return { outcome: outcomeOf(() => stack[0]), trace, maxDepth };
}

// ---- Target 2: TRM, the Tiny Register Machine

export type RegInstr =
  | { op: 'SET'; d: number; value: Num }
  | { op: 'GET'; d: number; name: string }
  | { op: 'NEG' | 'POS'; d: number; a: number }
  | { op: 'ADD' | 'SUB' | 'MUL' | 'DIV' | 'FLOORDIV' | 'MOD' | 'POW'; d: number; a: number; b: number }
  | { op: 'SAVE'; slot: number; a: number }
  | { op: 'RESTORE'; d: number; slot: number };

export const MIN_REGISTERS = 2;
export type RegProgram = { code: RegInstr[]; registers: number; spills: number; result: number };

/**
 * Register allocation at its simplest: the value being built goes in the next free register.
 * The last register is kept back as scratch, because when the others are full a saved value
 * has to come back somewhere to be used. Evaluation stays left to right even when going
 * right first would need fewer registers: with errors in play, reordering changes which
 * error you get, so it wouldn't be the same program. Real allocators work far harder.
 */
export function genRegisters(t: Tree, registers: number): RegProgram {
  if (!Number.isInteger(registers) || registers < MIN_REGISTERS) throw new RangeError(`This machine needs at least ${MIN_REGISTERS} registers`);
  const usable = registers - 1, scratch = registers - 1;
  const code: RegInstr[] = [];
  let spills = 0, slotsInUse = 0;
  const go = (n: Tree, d: number): void => {
    switch (n.k) {
      case 'num': code.push({ op: 'SET', d, value: n.value }); return;
      case 'name': code.push({ op: 'GET', d, name: n.name }); return;
      case 'un': go(n.x, d); code.push({ op: n.op === '-' ? 'NEG' : 'POS', d, a: d }); return;
      case 'bin': {
        go(n.l, d);
        const op = STACK_OP[n.op] as 'ADD';
        if (d + 1 < usable) {
          go(n.r, d + 1);
          code.push({ op, d, a: d, b: d + 1 });
        } else {
          const slot = slotsInUse++;
          spills++;
          code.push({ op: 'SAVE', slot, a: d });
          go(n.r, d);
          code.push({ op: 'RESTORE', d: scratch, slot });
          slotsInUse--;
          code.push({ op, d, a: scratch, b: d });
        }
      }
    }
  };
  go(t, 0);
  return { code, registers, spills, result: 0 };
}

export function runRegisters(p: RegProgram, env: Record<string, Num> = {}): Outcome {
  const regs: Num[] = new Array(p.registers).fill(0n);
  const slots: Num[] = [];
  const out = outcomeOf(() => {
    for (const ins of p.code) {
      switch (ins.op) {
        case 'SET': regs[ins.d] = ins.value; break;
        case 'GET': regs[ins.d] = env[ins.name]; break;
        case 'NEG': regs[ins.d] = negate('-', regs[ins.a]); break;
        case 'POS': regs[ins.d] = negate('+', regs[ins.a]); break;
        case 'SAVE': slots[ins.slot] = regs[ins.a]; break;
        case 'RESTORE': regs[ins.d] = slots[ins.slot]; break;
        default: regs[ins.d] = arith(OP_OF[ins.op], regs[ins.a], regs[ins.b]);
      }
    }
    return regs[p.result];
  });
  return out;
}

/**
 * For the stack display. Python's own repr refuses an int over 4,300 digits, which is right
 * for the answer and would be a crash here, in a view that only has to show which number it is.
 */
export const showValue = (v: Num) => {
  if (typeof v !== 'bigint') return repr(v as Val);
  const t = v.toString();
  return t.length > 40 ? `${t.slice(0, 12)}... (${t.length} digits)` : t;
};
export const showStack = (i: StackInstr) => (i.op === 'PUSH' ? `PUSH ${repr(i.value as Val)}` : i.op === 'LOAD' ? `LOAD ${i.name}` : i.op);
export const showReg = (i: RegInstr) => {
  switch (i.op) {
    case 'SET': return `SET r${i.d}, ${repr(i.value as Val)}`;
    case 'GET': return `GET r${i.d}, ${i.name}`;
    case 'NEG': case 'POS': return `${i.op} r${i.d}, r${i.a}`;
    case 'SAVE': return `SAVE slot${i.slot}, r${i.a}`;
    case 'RESTORE': return `RESTORE r${i.d}, slot${i.slot}`;
    default: return `${i.op} r${i.d}, r${i.a}, r${i.b}`;
  }
};

// ---- A small optimisation: constant folding

const FOLD_LIMIT = 2n ** 256n;
const worthKeeping = (v: Num) => (typeof v === 'bigint' ? v < FOLD_LIMIT && v > -FOLD_LIMIT : true);

/**
 * Work out at compile time what can't change at run time. A sum that would fail stays in
 * the program: 1/0 inside a branch that never runs must not stop the compile, and a failure
 * has to happen when the program runs it, not when it's built. CPython's own folder holds
 * back the same way, and also from a result too big to store, as this does.
 */
export function fold(t: Tree): Tree {
  if (t.k === 'un') {
    const x = fold(t.x);
    if (x.k === 'num') {
      const r = outcomeOf(() => negate(t.op, x.value));
      if (r.ok && worthKeeping(r.value)) return { k: 'num', value: r.value, start: t.start, end: t.end };
    }
    return { ...t, x };
  }
  if (t.k === 'bin') {
    const l = fold(t.l), r = fold(t.r);
    if (l.k === 'num' && r.k === 'num') {
      const v = outcomeOf(() => arith(t.op, l.value, r.value));
      if (v.ok && worthKeeping(v.value)) return { k: 'num', value: v.value, start: t.start, end: t.end };
    }
    return { ...t, l, r };
  }
  return t;
}

// ---- Showing a tree

/** The tree written with every bracket, which is what it means. */
export function bracketed(t: Tree): string {
  switch (t.k) {
    case 'num': return repr(t.value as Val);
    case 'name': return t.name;
    case 'un': return `(${t.op}${bracketed(t.x)})`;
    case 'bin': return `(${bracketed(t.l)} ${t.op} ${bracketed(t.r)})`;
  }
}

/** The same shape, ignoring where in the text each part came from. */
export const sameTree = (a: Tree, b: Tree) => bracketed(a) === bracketed(b);

export type Placed = { label: string; x: number; y: number; kind: Tree['k']; parent: number | null };
/** Leaves evenly along the bottom, each parent over its children. Pure, so a test can read it. */
export function layout(t: Tree): { nodes: Placed[]; width: number; depth: number } {
  const nodes: Placed[] = [];
  let leaves = 0, depth = 0;
  const go = (n: Tree, y: number, parent: number | null): number => {
    depth = Math.max(depth, y);
    const index = nodes.length;
    const label = n.k === 'num' ? repr(n.value as Val) : n.k === 'name' ? n.name : n.op;
    nodes.push({ label, x: 0, y, kind: n.k, parent });
    if (n.k === 'num' || n.k === 'name') nodes[index].x = leaves++;
    else if (n.k === 'un') nodes[index].x = go(n.x, y + 1, index);
    else { const a = go(n.l, y + 1, index), b = go(n.r, y + 1, index); nodes[index].x = (a + b) / 2; }
    return nodes[index].x;
  };
  go(t, 0, null);
  return { nodes, width: Math.max(1, leaves), depth };
}

// ---- The lab behind the widget and its missions

export type CompileResult =
  | { ok: false; error: TinySyntaxError; tokens: Token[] }
  | { ok: true; tokens: Token[]; tree: Tree; outcome: Outcome };

export const LAB_ENV: Record<string, Num> = { x: 7n, y: 2n };

export function compile(text: string, mode: ParserMode = 'correct', env: Record<string, Num> = LAB_ENV): CompileResult {
  const tokens = scan(text).tokens;
  try {
    const tree = parse(text, mode);
    checkNames(tree, env);
    return { ok: true, tokens, tree, outcome: runStack(genStack(tree), env).outcome };
  } catch (e) {
    if (e instanceof TinySyntaxError) return { ok: false, error: e, tokens };
    throw e;
  }
}

export type Attempt = {
  text: string; mode: ParserMode; result: CompileResult;
  /** What the correct parser makes of the same text: what the mode is being compared to. */
  truth: CompileResult;
};

export class ParseLab {
  attempts: Attempt[] = [];
  try(text: string, mode: ParserMode = 'correct'): Attempt {
    const a = { text, mode, result: compile(text, mode), truth: compile(text, 'correct') };
    this.attempts.push(a);
    return a;
  }
}

export const LIMIT_NOTE = 'Refused, and nothing was computed: real Python would give a complex number here, or try to build a number too large for this page.';
/** Real Python's limit is on turning a huge int into text. Without saying so, the value in the Step view and the ValueError beside it read as a contradiction. */
export const PRINT_NOTE = 'The arithmetic worked. What failed is printing: Python refuses to turn an int of more than 4,300 digits into text, and this lab does the same.';

export type Verdict = { cls: 'ok' | 'warn' | 'bad'; text: string };

/**
 * What the parser lab may say about one comparison. Each branch has to be true of everything
 * that reaches it: "a different answer" isn't true when one side refused to give an answer, and
 * "the tree is wrong" isn't true of the correct parser, or of a rule that's only different.
 */
export function parseVerdict(mode: ParserMode, mine: Outcome, py: { ok: boolean; text: string }, sameShape: boolean): Verdict {
  const mineLimit = !mine.ok && mine.error.type === 'SandboxLimit', pyLimit = !py.ok && py.text === 'SandboxLimit';
  if (mineLimit && pyLimit) return { cls: 'warn', text: LIMIT_NOTE };
  if (mineLimit || pyLimit) return { cls: 'warn', text: `${mineLimit ? 'This reading asks' : 'Python\'s reading asks'} for something this page refuses: a complex number, or a number too large. The other reading doesn't, so there aren't two answers to compare.` };
  const sameAnswer = mine.ok ? py.ok && mine.text === py.text : !py.ok && mine.error.type === py.text;
  if (sameAnswer) {
    if (!mine.ok && mine.error.type === 'ValueError' && /limit/.test(mine.error.message)) return { cls: 'warn', text: `${PRINT_NOTE}${sameShape ? '' : ' The trees differ, though.'}` };
    if (sameShape) return { cls: 'ok', text: mode === 'excel' ? 'Same answer and the same tree as Python\'s rule, for this one expression. The two rules only part where a minus meets a power, or powers meet each other: try one.' : 'Same answer and the right tree for this one expression. That doesn\'t make a parser correct: try more.' };
    return { cls: 'warn', text: mode === 'excel' ? 'Same answer from a different tree: this rule groups the text differently, and the two happen to agree here.' : 'Same answer from the wrong tree. A test that only checked this answer would pass.' };
  }
  // The same tree can't give a different answer, and neither can the correct parser: both would be bugs here, and must read as bugs.
  if (sameShape || mode === 'correct') return { cls: 'bad', text: 'A different answer from Python on the same tree: this is a bug in this page, please report it.' };
  const failed = !mine.ok || !py.ok;
  if (mode === 'excel') return { cls: 'bad', text: `A different ${failed ? 'result' : 'answer'} from the same text, because this rule groups it differently. Going by Microsoft's published table, which we read and didn't run in Excel, neither program is broken: they mean different things by it.` };
  return { cls: 'bad', text: `A different ${failed ? 'result' : 'answer'} from the same text. The arithmetic is fine. The tree is wrong.` };
}

const hasNoBrackets = (a: Attempt) => !a.text.includes('(');
const sumOverProduct = (t: Tree): boolean => {
  if (t.k === 'bin' && (t.op === '+' || t.op === '-')) return [t.l, t.r].some((c) => c.k === 'bin' && ['*', '/', '//', '%'].includes(c.op)) || sumOverProduct(t.l) || sumOverProduct(t.r);
  if (t.k === 'bin') return sumOverProduct(t.l) || sumOverProduct(t.r);
  if (t.k === 'un') return sumOverProduct(t.x);
  return false;
};

export const parseSawPrecedence = (l: ParseLab) => l.attempts.some((a) => a.mode === 'correct' && a.result.ok && hasNoBrackets(a) && sumOverProduct(a.result.tree));
export const parseSawPointer = (l: ParseLab) => l.attempts.some((a) => !a.result.ok && a.result.error.kind === 'syntax' && a.result.error.col > 0);
/** Different answer from the same text, both finished: a real wrong answer, not a difference in a refusal. */
export const parseCaught = (l: ParseLab, mode: ParserMode) => l.attempts.some((a) => a.mode === mode && a.result.ok && a.truth.ok && a.result.outcome.ok && a.truth.outcome.ok && a.result.outcome.text !== a.truth.outcome.text);
/** The tree is wrong and the answer is right: the case a test on answers can't see. */
export const parseHidden = (l: ParseLab, mode: ParserMode) => l.attempts.some((a) => a.mode === mode && a.result.ok && a.truth.ok && !sameTree(a.result.tree, a.truth.tree) && a.result.outcome.ok && a.truth.outcome.ok && a.result.outcome.text === a.truth.outcome.text);

export type GenState = {
  text: string; fold: boolean; mode: GenMode; registers: number;
  tree: Tree; foldedTree: Tree; stack: StackInstr[]; plain: StackInstr[];
  run: StackRun; truth: Outcome; reg: RegProgram; regOutcome: Outcome;
};

/** Everything the generate lab shows for one expression. Null means the text never got as far as a tree. */
export function generate(text: string, opts: { fold?: boolean; mode?: GenMode; registers?: number } = {}, env: Record<string, Num> = LAB_ENV): GenState | TinySyntaxError {
  const registers = opts.registers ?? 4, mode = opts.mode ?? 'correct', folding = !!opts.fold;
  try {
    const tree = parse(text);
    checkNames(tree, env);
    const foldedTree = folding ? fold(tree) : tree;
    const stack = genStack(foldedTree, mode), plain = genStack(tree);
    const run = runStack(stack, env);
    const truth = evaluate(tree, env);
    const reg = genRegisters(foldedTree, registers);
    return { text, fold: folding, mode, registers, tree, foldedTree, stack, plain, run, truth, reg, regOutcome: runRegisters(reg, env) };
  } catch (e) {
    if (e instanceof TinySyntaxError) return e;
    throw e;
  }
}

export class GenLab {
  history: GenState[] = [];
  /** Which programs were walked to the end by hand, one Step at a time. */
  steppedToEnd: GenState[] = [];
  errors = 0;
  build(text: string, opts: { fold?: boolean; mode?: GenMode; registers?: number } = {}): GenState | TinySyntaxError {
    const g = generate(text, opts);
    if (g instanceof TinySyntaxError) this.errors++;
    else this.history.push(g);
    return g;
  }
}

const binaryOps = (p: StackInstr[]) => p.filter((i) => i.op !== 'PUSH' && i.op !== 'LOAD' && i.op !== 'NEG' && i.op !== 'POS').length;
export const genSawStack = (l: GenLab) => l.steppedToEnd.some((g) => binaryOps(g.stack) >= 2);
export const genCaughtSwap = (l: GenLab) => l.history.some((g) => g.mode === 'swapped' && g.run.outcome.ok && g.truth.ok && g.run.outcome.text !== g.truth.text);
export const genFolded = (l: GenLab) => l.history.some((g) => g.fold && g.mode === 'correct' && g.stack.length < g.plain.length && g.run.outcome.ok && g.truth.ok && g.run.outcome.text === g.truth.text);
export const genFoldKeptError = (l: GenLab) => l.history.some((g) => g.fold && g.mode === 'correct' && !g.run.outcome.ok && g.run.outcome.error.type === 'ZeroDivisionError');
export const genSpilled = (l: GenLab) => l.history.some((g) => g.mode === 'correct' && g.reg.spills > 0 && g.regOutcome.ok && g.truth.ok && g.regOutcome.text === g.truth.text);
