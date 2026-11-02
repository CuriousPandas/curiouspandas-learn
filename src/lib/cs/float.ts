// The Float Lab's logic: the 64 bits of an IEEE 754 double, which is what a Python float
// is on the machines this site's readers use, and what a JavaScript number always is.
//
// Nothing here models floating point: the arithmetic is the browser's own, and the bits
// come from a DataView. What the page adds is showing them, and writing out the exact
// value stored, which neither language prints by default. The test holds every function
// to struct, Decimal, float.hex and math.nextafter in real Python.

import type { Mission } from '../missions.ts';

const buffer = new DataView(new ArrayBuffer(8));
export const toBits = (x: number): bigint => { buffer.setFloat64(0, x); return buffer.getBigUint64(0); };
export const fromBits = (b: bigint): number => { buffer.setBigUint64(0, BigInt.asUintN(64, b)); return buffer.getFloat64(0); };

export type Kind = 'zero' | 'subnormal' | 'normal' | 'infinity' | 'nan';
export type Fields = { sign: number; exponentBits: number; fraction: bigint; kind: Kind; bits: string };

export const fieldsOf = (x: number): Fields => fieldsOfBits(toBits(x));

export function fieldsOfBits(b: bigint): Fields {
  const exponentBits = Number((b >> 52n) & 0x7ffn), fraction = b & ((1n << 52n) - 1n), sign = Number(b >> 63n);
  const kind: Kind = exponentBits === 0x7ff ? (fraction === 0n ? 'infinity' : 'nan') : exponentBits === 0 ? (fraction === 0n ? 'zero' : 'subnormal') : 'normal';
  return { sign, exponentBits, fraction, kind, bits: b.toString(2).padStart(64, '0') };
}

/** value = significand * 2^exponent, both whole, for a finite double. */
function parts(x: number): { negative: boolean; significand: bigint; exponent: number } {
  const f = fieldsOf(x);
  const hidden = f.exponentBits === 0 ? 0n : 1n << 52n;
  return { negative: f.sign === 1, significand: hidden + f.fraction, exponent: Math.max(f.exponentBits, 1) - 1075 };
}

/** The exact value stored, in full decimal. Every finite double has a finite decimal expansion, because it's a whole number over a power of 2. */
export function exactDecimal(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const { negative, significand, exponent } = parts(x);
  let text: string;
  if (exponent >= 0) text = (significand << BigInt(exponent)).toString();
  else {
    // n / 2^k = n * 5^k / 10^k, so the digits of n * 5^k with the point k places in.
    const k = -exponent;
    const digits = (significand * 5n ** BigInt(k)).toString().padStart(k + 1, '0');
    const whole = digits.slice(0, -k), frac = digits.slice(-k).replace(/0+$/, '');
    text = frac ? `${whole}.${frac}` : whole;
  }
  return (negative ? '-' : '') + text;
}

/** What Python's float.hex() prints. */
export function pyHex(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const f = fieldsOf(x), s = f.sign ? '-' : '';
  if (f.kind === 'zero') return `${s}0x0.0p+0`;
  const lead = f.kind === 'subnormal' ? 0 : 1, e = f.kind === 'subnormal' ? -1022 : f.exponentBits - 1023;
  return `${s}0x${lead}.${f.fraction.toString(16).padStart(13, '0')}p${e >= 0 ? '+' : ''}${e}`;
}

/** math.nextafter(x, math.inf) or math.nextafter(x, -math.inf). */
export function nextFloat(x: number, up: boolean): number {
  if (Number.isNaN(x)) return x;
  if (x === (up ? Infinity : -Infinity)) return x;
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  const b = toBits(x);
  return fromBits((x > 0) === up ? b + 1n : b - 1n);
}

/** math.ulp: the gap from x's size up to the next double. */
export function ulp(x: number): number {
  if (Number.isNaN(x)) return x;
  const a = Math.abs(x);
  if (a === Infinity) return Infinity;
  const n = nextFloat(a, true);
  return n === Infinity ? a - nextFloat(a, false) : n - a;
}

const NUMBER = /^[+-]?(\d+(_\d+)*\.?(\d+(_\d+)*)?|\.\d+(_\d+)*)([eE][+-]?\d+(_\d+)*)?$/;

/** Reads text as Python's float() does for ordinary numbers, inf and nan. Anything else is refused. */
export function parseFloatText(text: string): number | { error: string } {
  const t = text.trim();
  if (t === '') return { error: 'Type a number first.' };
  const low = t.toLowerCase();
  if (/^[+-]?(inf|infinity)$/.test(low)) return low.startsWith('-') ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(low)) return NaN;
  if (!NUMBER.test(t)) return { error: `"${t}" is not a number this lab reads. Examples: 0.1, 2.5e3, -7, 1e309.` };
  return Number(t.replace(/_/g, ''));
}

/**
 * The decimal a learner typed, as exact text in the same form as exactDecimal, or null if it's
 * too far out to write down. The limit is on where the digits land, not on the exponent as
 * typed: "0e9999" is plainly zero and was once called "Not exact", and a 1 followed by 2,001
 * zeros and "e-2001" is plainly 1. Anything that lands past 10^400 or below 10^-400 is outside
 * every double's range, so null can only mean "can't be stored exactly".
 */
export function typedDecimal(text: string): string | null {
  const t = text.trim().replace(/_/g, '').toLowerCase();
  const m = /^([+-]?)(\d*)\.?(\d*)(?:e([+-]?\d+))?$/.exec(t);
  if (!m) return null;
  const all = m[2] + m[3];
  const leading = /^0*/.exec(all)![0].length;
  if (leading === all.length) return '0';
  const e = Number(m[4] ?? 0);
  const digits = all.slice(leading).replace(/0+$/, '');
  const point = m[2].length + e - leading;
  if (!(Math.abs(point) <= 400)) return null;
  const whole = (point <= 0 ? '0' : digits.padEnd(point, '0').slice(0, point)).replace(/^0+(?=\d)/, '');
  const frac = (point < 0 ? '0'.repeat(-point) + digits : digits.slice(Math.max(point, 0))).replace(/0+$/, '');
  const body = frac ? `${whole || '0'}.${frac}` : (whole || '0');
  return (m[1] === '-' && !/^0(\.0*)?$/.test(body) ? '-' : '') + body;
}

/** Whether the double really holds what was typed, or only something near it. */
export function isExact(text: string, x: number): boolean {
  if (!Number.isFinite(x)) return false;
  const typed = typedDecimal(text);
  if (typed === null) return false;
  // -0 and 0 are the same decimal: the sign bit is a separate fact.
  return typed === exactDecimal(x).replace(/^-(?=0$)/, '');
}

export const isWholeText = (text: string): boolean => {
  const typed = typedDecimal(text);
  return typed !== null && !typed.includes('.');
};

// ---- State and mission ---------------------------------------------------------------

export type FloatEvent =
  | { op: 'type'; text: string; value: number; exact: boolean; whole: boolean }
  | { op: 'next'; before: number; value: number }
  | { op: 'flip'; before: number; value: number };
// The 64 bits are held as bits, not read back out of the number. A JavaScript engine may replace
// any NaN with one standard NaN: WebKit and Firefox did on every flip, and Chromium did part way
// through a loop. So on an iPhone, flipping a fraction bit of a NaN changed nothing on screen,
// under a status that said it had flipped, and the exponent flip that made the NaN wiped the fraction.
export type FloatState = { value: number; bits: bigint; events: FloatEvent[] };

export const floatState = (): FloatState => ({ value: 0.1, bits: toBits(0.1), events: [] });

export function doTypeFloat(s: FloatState, text: string): string | null {
  const v = parseFloatText(text);
  if (typeof v !== 'number') return v.error;
  s.events.push({ op: 'type', text: text.trim(), value: v, exact: isExact(text, v), whole: isWholeText(text) });
  s.value = v;
  s.bits = toBits(v);
  return null;
}
export function doNext(s: FloatState, up: boolean) {
  const v = nextFloat(s.value, up);
  s.events.push({ op: 'next', before: s.value, value: v });
  s.value = v;
  // NaN has no next number, so nothing moved, and its bits stay as they are.
  if (!Number.isNaN(v)) s.bits = toBits(v);
}
/** Bit 0 is the leftmost, the sign, as the page draws them. */
export function doFlipFloat(s: FloatState, i: number) {
  const bits = s.bits ^ (1n << BigInt(63 - i));
  const v = fromBits(bits);
  s.events.push({ op: 'flip', before: s.value, value: v });
  s.value = v;
  s.bits = bits;
}

/** What storing a typed number did. Typing "inf" stores infinity, and the mission's last step doesn't count it, so the lab says why rather than leaving a learner staring at an unticked step. */
export function describeStored(typed: string, e: Extract<FloatEvent, { op: 'type' }>, show: (x: number) => string): { text: string; kind: 'ok' | 'warn' } {
  if (Number.isNaN(e.value)) return { kind: 'warn', text: `Stored ${show(e.value)}.` };
  if (!Number.isFinite(e.value)) {
    return /\d/.test(typed)
      ? { kind: 'warn', text: `"${typed}" is outside what 64 bits can hold, so it became ${show(e.value)}. No error.` }
      : { kind: 'warn', text: `Stored ${show(e.value)}. That asks for it by name, so it isn't running out of numbers: for that, type a number too big to hold, or flip bits.` };
  }
  if (e.exact) return { kind: 'ok', text: `Stored exactly: ${typed} is a whole number over a power of 2.` };
  return { kind: 'warn', text: `Not exact. ${typed} can't be held in 64 bits, so the nearest number that can was stored.` };
}

/** What flipping a bit did. "It is a different number now" was false for NaN, which isn't a number, and for 0.0 and -0.0, which are equal. */
export function describeFlip(i: number, before: number, after: number): string {
  if (Number.isNaN(after)) return `Flipped bit ${i}. It is NaN now, "not a number": the exponent bits are all 1 and the fraction isn't 0.`;
  if (!Number.isFinite(after)) return `Flipped bit ${i}. It is infinity now: the exponent bits are all 1 and the fraction is 0.`;
  if (after === before) return `Flipped bit ${i}. The bits differ, but 0.0 and -0.0 compare as equal.`;
  return `Flipped bit ${i}. It is a different number now.`;
}

export const FLOAT_MISSION: Mission<FloatState> = {
  id: 'comp-float-look', title: 'What is really stored', xp: 70, setup: floatState,
  steps: [
    { text: 'Type 0.1 and press Store. Read what was really stored', hint: 'Type 0.1, press Store, and read the "exactly" line', done: (s) => s.events.some((e) => e.op === 'type' && e.value === 0.1 && !e.exact) },
    { text: 'Find a number with a fractional part that is stored exactly', hint: 'Halves, quarters and eighths work: try 0.75', done: (s) => s.events.some((e) => e.op === 'type' && e.exact && Number.isFinite(e.value) && !Number.isInteger(e.value)) },
    { text: 'Find a whole number that can\'t be stored exactly', hint: 'Whole numbers are safe up to 2 to the power 53. Try 9007199254740993', done: (s) => s.events.some((e) => e.op === 'type' && e.whole && !e.exact && Number.isFinite(e.value)) },
    { text: 'See how far apart the numbers are out there: at that size, press Next up and read the gap', hint: 'With 9007199254740992 showing, press Next up', done: (s) => s.events.some((e) => e.op === 'next' && Number.isFinite(e.value) && Number.isFinite(e.before) && Math.abs(e.value - e.before) >= 2) },
    { text: 'Run out of numbers: make it infinity, by typing a number or by flipping bits', hint: 'Type 1e309, which is too big to hold', done: (s) => s.events.some((e) => (e.op === 'type' ? /\d/.test(e.text) : Math.abs(e.before) !== Infinity) && Math.abs(e.value) === Infinity) },
  ],
  debrief: 'A double is a sign, a power of 2 and 52 bits of fraction. So it stores numbers of the form "whole number over a power of 2", and 0.1 isn\'t one, so it stores the nearest that is. Whole numbers are all there up to 2^53, and past that only every second one, then every fourth. The numbers don\'t run out evenly: they get further apart as they get bigger, by about the same percentage at every size. Rounding is built into the format, not a bug in your program.',
};
