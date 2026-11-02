// The Bit Lab's logic: a row of switches of a fixed width, read several ways.
//
// The width is emulated. Python's ints and JavaScript's numbers do not stop at 8 or 32
// bits on their own, so "wrapping" here is arithmetic this file does on purpose, with
// plain numbers (everything stays well under 2^53, where a double is exact). The test
// holds it to ctypes, struct, bin, hex and int in real Python.

import type { Mission } from '../missions.ts';

export const WIDTHS = [4, 8, 16, 32] as const;
export type Width = (typeof WIDTHS)[number];
export type Reading = 'unsigned' | 'twos' | 'sign' | 'ones';

export const sizeOf = (w: number) => 2 ** w;
export const maxUnsigned = (w: number) => 2 ** w - 1;
export const maxSigned = (w: number) => 2 ** (w - 1) - 1;
export const minSigned = (w: number) => -(2 ** (w - 1));

/** Any whole number, kept to the low w bits. The result is what the switches hold. */
export const wrap = (n: number, w: number) => {
  const m = 2 ** w;
  return ((n % m) + m) % m;
};
/** The switches read as two's complement: the top bit is worth minus its usual value. */
export const asTwos = (u: number, w: number) => (u >= 2 ** (w - 1) ? u - 2 ** w : u);
export const bitAt = (u: number, i: number) => Math.floor(u / 2 ** i) % 2;
export const flipBit = (u: number, i: number) => (bitAt(u, i) ? u - 2 ** i : u + 2 ** i);
export const flipAll = (u: number, w: number) => maxUnsigned(w) - u;
/** Flip every bit and add 1, wrapped. */
export const negate = (u: number, w: number) => wrap(flipAll(u, w) + 1, w);

export const binaryOf = (u: number, w: number) => u.toString(2).padStart(w, '0');
export const hexOf = (u: number, w: number) => u.toString(16).padStart(Math.ceil(w / 4), '0');
/** Binary split into groups of four, one group per hex digit. */
export const grouped = (u: number, w: number) => binaryOf(u, w).replace(/(.{4})(?=.)/g, '$1 ');

export type Readout = { value: number; text: string };

/** The same bits under the three ways of writing negatives, and with none. "-0" is a real state of two of them, so it's kept apart from 0. */
export function read(u: number, w: number, how: Reading): Readout {
  const top = bitAt(u, w - 1), rest = u - top * 2 ** (w - 1);
  if (how === 'unsigned') return { value: u, text: String(u) };
  if (how === 'twos') { const v = asTwos(u, w); return { value: v, text: String(v) }; }
  if (how === 'sign') return { value: top ? -rest : rest, text: top ? `-${rest}` : String(rest) };
  const mag = top ? flipAll(u, w) : u;
  return { value: top ? -mag : mag, text: top ? `-${mag}` : String(mag) };
}

/** What chr() would give for a byte, or null for the ones with nothing to show. Python's isprintable() is the test's check. */
export function asCharacter(u: number, w: number): string | null {
  if (w !== 8) return null;
  return (u < 32 || (u >= 127 && u <= 160) || u === 173) ? null : String.fromCodePoint(u);
}

export type AddResult = { value: number; carryOut: boolean; signedOverflow: boolean };

/** Addition as a fixed-width adder does it: the same operation for signed and unsigned, and only the reading of the flags differs. */
export function add(a: number, b: number, w: number): AddResult {
  const total = a + b;
  const value = wrap(total, w);
  const sa = asTwos(a, w), sb = asTwos(b, w), exact = sa + sb;
  return { value, carryOut: total >= 2 ** w, signedOverflow: exact > maxSigned(w) || exact < minSigned(w) };
}

/**
 * What an addition did, in words. A carry falling off the top isn't always a failure:
 * under two's complement it's how -3 + 5 gets to 2, so the signed lab has to tell the two
 * apart. `typed` is the number as the learner gave it: adding -1 on an unsigned row is
 * adding the bits of 255, and saying so ("5 + 255 is 260") would be true and baffling.
 */
export function describeAdd(before: number, typed: number, r: AddResult, w: number, signed: boolean): { text: string; kind: 'ok' | 'bad' } {
  if (signed) {
    const a = asTwos(before, w), b = asTwos(wrap(typed, w), w), got = asTwos(r.value, w), exact = a + b, shown = `${a} + ${b < 0 ? `(${b})` : b}`;
    if (r.signedOverflow) return { kind: 'bad', text: `${shown} is ${exact}, which ${w}-bit signed can't hold (${minSigned(w)} to ${maxSigned(w)}). The switches read ${got}. No error is raised. ${r.carryOut ? 'A carry fell off the top too.' : 'No carry fell off the top either: a signed wrap is not a lost carry.'}` };
    return { kind: 'ok', text: `${shown} = ${got}.${r.carryOut ? ' A carry fell off the top, and here that is fine: the answer is right.' : ''}` };
  }
  const exact = before + typed;
  if (typed < 0) {
    if (exact < 0) return { kind: 'bad', text: `${before} - ${-typed} is ${exact}, and these switches have no negatives. It wrapped round to ${r.value}. No error.` };
    return { kind: 'ok', text: `${before} - ${-typed} = ${r.value}.` };
  }
  if (r.carryOut) return { kind: 'bad', text: `${before} + ${typed} is ${exact}, which needs ${w + 1} bits. There is no bit ${w}, so the carry is lost and the switches read ${r.value}. No error.` };
  return { kind: 'ok', text: `${before} + ${typed} = ${r.value}.` };
}

/**
 * Reads what a learner typed. It accepts a plain whole number with an optional sign, or
 * 0b or 0x forms, as Python's int(text, 0) does. Anything else is refused, because
 * guessing would set the switches to a number other than the one on screen.
 */
export function parseWhole(text: string): number | { error: string } {
  const t = text.trim().replace(/^\+/, '');
  if (t === '') return { error: 'Type a whole number first.' };
  const m = /^(-?)(0[bB][01]+|0[xX][0-9a-fA-F]+|0|[1-9][0-9]*)$/.exec(t);
  if (!m) return { error: `"${text.trim()}" is not a whole number. Examples: 13, -3, 0b1101, 0xFF.` };
  const v = Number(m[2]);
  if (!Number.isSafeInteger(v)) return { error: `"${text.trim()}" is far too big for any width here.` };
  return m[1] ? -v : v;
}

/** The switches for a number, or why it doesn't fit. In signed mode a negative is fine, and so is a value only unsigned can hold, because the bits are the same either way. */
export function fit(n: number, w: number, signed: boolean): number | { error: string } {
  const low = signed ? minSigned(w) : 0, high = maxUnsigned(w);
  if (n < low || n > high) {
    return { error: signed
      ? `${n} does not fit in ${w} bits. Signed, they hold ${minSigned(w)} to ${maxSigned(w)}. Read as unsigned, up to ${high}. Nothing was changed.`
      : `${n} does not fit in ${w} bits, which hold 0 to ${high}. Nothing was changed.` };
  }
  return wrap(n, w);
}

/** The digits of a whole number in a base, lowest first in the working, highest first in the result. */
export function digitsOf(n: number, base: number): number[] {
  if (!Number.isInteger(n) || n < 0) throw new Error(`digitsOf: ${n} is not a whole number from 0 up`);
  if (n === 0) return [0];
  const out: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / base)) out.unshift(x % base);
  return out;
}

// ---- The lab's state, and what a mission can see of it --------------------------------

export type BitOp = 'toggle' | 'type' | 'add' | 'neg' | 'flip' | 'width' | 'clear';
export type BitEvent = { op: BitOp; width: number; before: number; value: number; operand?: number; result?: AddResult };
export type BitState = { width: number; value: number; signed: boolean; events: BitEvent[] };

export const bitState = (signed = false): BitState => ({ width: 8, value: 0, signed, events: [] });

const log = (s: BitState, op: BitOp, next: number, extra: Partial<BitEvent> = {}) => {
  s.events.push({ op, width: s.width, before: s.value, value: next, ...extra });
  s.value = next;
};

export const doToggle = (s: BitState, i: number) => log(s, 'toggle', flipBit(s.value, i));
export const doFlipAll = (s: BitState) => log(s, 'flip', flipAll(s.value, s.width));
export const doNegate = (s: BitState) => log(s, 'neg', negate(s.value, s.width));
export const doClear = (s: BitState) => log(s, 'clear', 0);
export function doType(s: BitState, text: string): string | null {
  const n = parseWhole(text);
  if (typeof n !== 'number') return n.error;
  const u = fit(n, s.width, s.signed);
  if (typeof u !== 'number') return u.error;
  log(s, 'type', u);
  return null;
}
export function doAdd(s: BitState, text: string): { error: string } | AddResult {
  const n = parseWhole(text);
  if (typeof n !== 'number') return n;
  const operand = fit(n, s.width, true);
  if (typeof operand !== 'number') return operand;
  const result = add(s.value, operand, s.width);
  log(s, 'add', result.value, { operand, result });
  return result;
}
/** Changing width keeps the low bits, and describeWidth says what that did. Keeping the number would be a different operation, and it wouldn't always fit. */
export function doWidth(s: BitState, w: Width) {
  const kept = wrap(s.value, w);
  s.width = w;
  s.events.push({ op: 'width', width: w, before: s.value, value: kept });
  s.value = kept;
}

const commas = (n: number) => n.toLocaleString('en-US');

/**
 * What a change of width did to the number on screen. The signed lab has to compare the
 * two's complement reading, not the switches: widening -1 from 8 to 16 bits leaves every
 * switch alone and turns -1 into 255, and this once said only "Now 16 bits". Narrowing can do
 * the same to 200, which becomes -56 with its bits untouched.
 */
export function describeWidth(before: number, fromWidth: number, after: number, toWidth: number, signed: boolean): { text: string; kind: '' | 'warn' } {
  const now = `Now ${toWidth} bits.`;
  if (!signed) {
    return before === after ? { kind: '', text: now } : { kind: 'warn', text: `${now} Only the low bits were kept, so the value changed from ${commas(before)} to ${commas(after)}.` };
  }
  const was = asTwos(before, fromWidth), is = asTwos(after, toWidth);
  if (was === is) {
    if (before === after) return { kind: '', text: `${now} It still reads ${is}.` };
    return { kind: '', text: `${now} Only the low bits were kept, and two's complement still reads ${is}, because the bits dropped only repeated the sign. With no negatives, it went from ${commas(before)} to ${commas(after)}.` };
  }
  if (toWidth > fromWidth) return { kind: 'warn', text: `${now} The new top bits are 0, so two's complement changed from ${was} to ${is}, with no bit you had moving. Keeping ${was} takes copying the old top bit into the new ones, called sign extension, and this list doesn't do that. Type ${was} to see that pattern.` };
  return { kind: 'warn', text: `${now} Only the low bits were kept, so two's complement changed from ${was} to ${is}.` };
}

const reached = (s: BitState, width: number, value: number) => s.events.some((e) => e.width === width && e.value === value);
const added = (s: BitState, width: number, before: number, operand: number, value: number) => s.events.some((e) => e.op === 'add' && e.width === width && e.before === before && e.operand === operand && e.value === value);

export const BIT_MISSIONS: Record<string, Mission<BitState>> = {
  'comp-bits-switches': {
    id: 'comp-bits-switches', title: 'Eight switches', xp: 50, setup: () => bitState(false),
    steps: [
      { text: 'Make the number 13 with the switches', hint: '13 is 8 + 4 + 1', done: (s) => reached(s, 8, 13) },
      { text: 'Make the largest number eight switches can hold', hint: 'Turn them all on', done: (s) => reached(s, 8, 255) },
      { text: 'Add 1 to it. Where did the answer go?', hint: 'With 255 showing, press + 1', done: (s) => added(s, 8, 255, 1, 0) },
      { text: 'Set the bits that hex writes as A5', hint: 'A is 1010 and 5 is 0101. Or type 0xA5', done: (s) => reached(s, 8, 0xa5) },
      { text: 'Switch to 16 bits and find the largest number there', hint: 'Choose 16 from the width list, then turn them all on, or type a number', done: (s) => reached(s, 16, 65535) },
    ],
    debrief: 'Each switch is worth twice the one to its right, so n switches count from 0 to 2^n - 1, and every extra switch doubles the range. Hex is the same bits written in groups of four. And 255 + 1 gave 0 because a ninth bit was the only place the answer could go, and there was none. No error, no warning: this page reports the lost carry, and hardware may at most set a flag that a program has to choose to check.',
  },
  'comp-neg-wrap': {
    id: 'comp-neg-wrap', title: 'The number with no opposite', xp: 70, setup: () => bitState(true),
    steps: [
      { text: 'Make -1 in 8 bits. Look at which switches are on', hint: 'Type -1, or turn them all on', done: (s) => reached(s, 8, 255) },
      { text: 'Add 5 to -3, and see that the ordinary adder gets 2 with no special rule for the sign', hint: 'Type -3 and press Set, then type 5 in the add box and press Add', done: (s) => added(s, 8, wrap(-3, 8), 5, 2) },
      { text: 'Go past the top: add 1 to the largest positive 8-bit number', hint: '127, then + 1', done: (s) => added(s, 8, 127, 1, 128) },
      { text: 'Find the most negative 8-bit number, and press Negate on it. What comes back?', hint: 'It is -128: only the top switch is on', done: (s) => s.events.some((e) => e.op === 'neg' && e.width === 8 && e.before === 128 && e.value === 128) },
      { text: 'Do the top-of-range step again at 16 bits, the size of the integer Ariane 5 was converting to', hint: 'Choose 16, type 32767, then + 1', done: (s) => added(s, 16, 32767, 1, 32768) },
    ],
    debrief: 'Two\'s complement needs no separate sign logic: the same adder works for both, and the top bit counting as negative does the rest. It has one more negative than positive, because 0 takes a slot on the positive side, so -128 has no +128 to be, and negating it gives itself. Going past the top lands on the most negative number with no error. Whether a real system wraps, raises an error or stops depends on the language and the instruction, and on 4 June 1996 it stopped.',
  },
};
