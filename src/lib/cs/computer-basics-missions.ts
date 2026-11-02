// Code-lab missions for How a Machine Computes. As everywhere in the code lab, a step
// calls the learner's function on inputs they never saw. Bare builtins would solve some
// of these (bin, for one), so each is shaped so that no builtin does: a list of digits
// in any base, and bytes that this lab's Python can't produce.

import type { CodeMission, CodeState } from './missions.ts';
import { checkCases, toPy } from '../py/lab.ts';
import { PyProgram } from '../py/vm.ts';
import { PyList, repr } from '../py/values.ts';

const blank = (): CodeState => ({ runs: [], growth: [] });
const last = (s: CodeState) => s.runs.at(-1);
const finished = (s: CodeState) => last(s)?.status === 'done';
const passes = (s: CodeState, fn: string, cases: { args: unknown[]; want: string }[]) => {
  const r = last(s);
  return !!r && checkCases(r, fn, cases).ok;
};
const why = (s: CodeState, fn: string, cases: { args: unknown[]; want: string }[]) => {
  const r = last(s);
  return r && r.status === 'done' ? (checkCases(r, fn, cases).ok ? '' : checkCases(r, fn, cases).why) : '';
};

export const TO_DIGITS_CASES = [
  { args: [13, 2], want: '[1, 1, 0, 1]' }, { args: [255, 16], want: '[15, 15]' }, { args: [0, 2], want: '[0]' }, { args: [1, 2], want: '[1]' },
  { args: [8, 2], want: '[1, 0, 0, 0]' }, { args: [1000, 10], want: '[1, 0, 0, 0]' }, { args: [64, 8], want: '[1, 0, 0]' }, { args: [35, 36], want: '[35]' }, { args: [36, 36], want: '[1, 0]' },
];
export const FROM_DIGITS_CASES = [
  { args: [[1, 1, 0, 1], 2], want: '13' }, { args: [[15, 15], 16], want: '255' }, { args: [[0], 2], want: '0' }, { args: [[0, 0, 1], 2], want: '1' },
  { args: [[1, 0, 0, 0], 10], want: '1000' }, { args: [[1, 0, 0], 8], want: '64' }, { args: [[7], 8], want: '7' }, { args: [[1, 0], 36], want: '36' },
];
export const WRAP_CASES = [
  { args: [32768, 16], want: '-32768' }, { args: [32767, 16], want: '32767' }, { args: [128, 8], want: '-128' }, { args: [127, 8], want: '127' }, { args: [255, 8], want: '-1' },
  { args: [256, 8], want: '0' }, { args: [-1, 8], want: '-1' }, { args: [-128, 8], want: '-128' }, { args: [-129, 8], want: '127' }, { args: [8, 4], want: '-8' },
  { args: [-9, 4], want: '7' }, { args: [1000, 8], want: '-24' }, { args: [2147483648, 32], want: '-2147483648' }, { args: [0, 16], want: '0' },
];
export const FITS_CASES = [
  { args: [127, 8], want: 'True' }, { args: [128, 8], want: 'False' }, { args: [-128, 8], want: 'True' }, { args: [-129, 8], want: 'False' },
  { args: [32767, 16], want: 'True' }, { args: [32768, 16], want: 'False' }, { args: [-32768, 16], want: 'True' }, { args: [0, 4], want: 'True' }, { args: [7, 4], want: 'True' }, { args: [-8, 4], want: 'True' }, { args: [-9, 4], want: 'False' },
];
// Passed as raw floats. toPy turns a whole-valued number into a Python int, and then
// 1e20 would be exact and this whole check would be judging integers.
export const CLOSE_CASES: [number, number, boolean][] = [
  [0.1 + 0.2, 0.3, true], [1, 1, true], [1, 1.1, false], [-1, 1, false],
  // Big numbers that differ only by rounding: an absolute tolerance calls these different.
  [1e20, 1e20 + 16384, true], [100, 100.00000000000001, true],
  // Tiny numbers that really differ, by a factor of two or three: an absolute tolerance, or rounding to some places, calls these the same.
  [1e-20, 2e-20, false], [1e-200, 3e-200, false],
  [1000000, 1000001, false], [0, 0, true],
  // Neighbouring doubles either side of a rounding boundary at 16 significant digits. Comparing
  // f"{a:.15e}" texts used to pass this mission, and that's the rounding the lesson calls a different bug.
  [1.0000000000000004, 1.0000000000000007, true],
];
export function closeVerdict(s: CodeState): { ok: boolean; why: string } {
  const r = last(s);
  if (!r || r.status !== 'done') return { ok: false, why: '' };
  for (const [a, b, want] of CLOSE_CASES) {
    const p = new PyProgram(r.src, { maxOps: 2_000_000 });
    p.run();
    const shown = `close(${repr(a)}, ${repr(b)})`;
    const got = p.call('close', [a, b]);
    if (!got.ok) return { ok: false, why: `${shown} raised ${got.error.type}: ${got.error.message}` };
    if (got.value !== want) return { ok: false, why: `${shown} returned ${repr(got.value)}; expected ${want ? 'True' : 'False'}` };
  }
  return { ok: true, why: '' };
}
export const UTF8_LEN_CASES = [
  { args: [''], want: '0' }, { args: ['a'], want: '1' }, { args: ['é'], want: '2' }, { args: ['€'], want: '3' }, { args: ['😀'], want: '4' },
  { args: ['hello'], want: '5' }, { args: ['héllo'], want: '6' }, { args: ['日本語'], want: '9' }, { args: ['a😀é'], want: '7' },
  { args: ['\u007f'], want: '1' }, { args: ['\u0080'], want: '2' }, { args: ['߿'], want: '2' }, { args: ['ࠀ'], want: '3' }, { args: ['￿'], want: '3' }, { args: ['\u{10000}'], want: '4' },
];
export const UTF8_BYTES_CASES = [
  { args: ['a'], want: '[97]' }, { args: ['é'], want: '[195, 169]' }, { args: ['€'], want: '[226, 130, 172]' }, { args: ['😀'], want: '[240, 159, 152, 128]' },
  { args: ['\u007f'], want: '[127]' }, { args: ['\u0080'], want: '[194, 128]' }, { args: ['߿'], want: '[223, 191]' }, { args: ['ࠀ'], want: '[224, 160, 128]' },
  { args: ['￿'], want: '[239, 191, 191]' }, { args: ['\u{10000}'], want: '[240, 144, 128, 128]' }, { args: ['\u{10ffff}'], want: '[244, 143, 191, 191]' },
];

/**
 * Judges a split by what makes it fair, not by one right list: any order of shares counts,
 * and shares that add up to the wrong total don't, however even they look.
 */
export const SPLIT_CASES: [number, number][] = [[100, 3], [100, 4], [1000, 7], [1, 3], [0, 5], [99, 100], [12345, 6], [5, 1]];
export function splitVerdict(s: CodeState): { ok: boolean; why: string } {
  const r = last(s);
  if (!r || r.status !== 'done') return { ok: false, why: '' };
  for (const [total, people] of SPLIT_CASES) {
    const p = new PyProgram(r.src, { maxOps: 2_000_000 });
    p.run();
    const got = p.call('split', [toPy(total), toPy(people)]);
    if (!got.ok) return { ok: false, why: `split(${total}, ${people}) raised ${got.error.type}: ${got.error.message}` };
    if (!(got.value instanceof PyList)) return { ok: false, why: `split(${total}, ${people}) has to return a list.` };
    const items = got.value.items;
    if (items.length !== people) return { ok: false, why: `split(${total}, ${people}) gave ${items.length} shares, for ${people} people.` };
    if (!items.every((x) => typeof x === 'bigint')) return { ok: false, why: `split(${total}, ${people}) has a share that isn't a whole number of cents.` };
    const shares = (items as bigint[]).map(Number);
    const sum = shares.reduce((a, b) => a + b, 0);
    if (sum !== total) return { ok: false, why: `split(${total}, ${people}) adds up to ${sum}, so ${total - sum} cents went missing.` };
    if (Math.max(...shares) - Math.min(...shares) > 1) return { ok: false, why: `split(${total}, ${people}) gave shares more than a cent apart.` };
  }
  return { ok: true, why: '' };
}

export const COMPUTER_A_MISSIONS: Record<string, CodeMission> = {
  'comp-bits-digits': {
    id: 'comp-bits-digits', title: 'Any base you like', xp: 60, setup: blank,
    starter: `# to_digits(13, 2) should give [1, 1, 0, 1]: the digits, biggest place first.
# n % base is the last digit. n // base is what's left to write.
def to_digits(n, base):
    return []

# from_digits([1, 1, 0, 1], 2) should give 13.
def from_digits(digits, base):
    return 0

print(to_digits(13, 2))
print(from_digits([1, 1, 0, 1], 2))
print(bin(13), hex(255), int("1101", 2))
`,
    steps: [
      { text: 'Run it. The last line is Python\'s own conversions, for you to check against', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('0b1101')) },
      { text: 'Write to_digits, for any base from 2 up, including when n is 0', hint: 'while n > 0: put n % base at the front of the list, then n = n // base. And 0 has one digit: [0]', done: (s) => finished(s) && passes(s, 'to_digits', TO_DIGITS_CASES), why: (s) => why(s, 'to_digits', TO_DIGITS_CASES) },
      { text: 'Write from_digits, the other way', hint: 'Start with value = 0. For each digit: value = value * base + digit', done: (s) => finished(s) && passes(s, 'from_digits', FROM_DIGITS_CASES), why: (s) => why(s, 'from_digits', FROM_DIGITS_CASES) },
    ],
    debrief: 'Your functions work in any base because nothing about them is special to 2 or 10. A number isn\'t binary or decimal: those are ways of writing it down. The value is the same, and only the digits change. Hardware uses base 2 because a wire that is either high or low is easy to build and to tell apart.',
  },
  'comp-neg-emulate': {
    id: 'comp-neg-emulate', title: 'Teach Python to overflow', xp: 70, setup: blank,
    starter: `big = 2 ** 15 - 1    # 32767, the largest a 16-bit signed integer holds.
print(big + 1)       # Python's ints don't stop at 16 bits, so this is just 32768.

# wrap(32768, 16) should give -32768: what a signed integer of that many bits would hold.
def wrap(n, bits):
    return n

# fits(32768, 16) should give False, and fits(-32768, 16) should give True.
def fits(n, bits):
    return True

print(wrap(32768, 16))
print(fits(32768, 16))
`,
    steps: [
      { text: 'Run it, and see that Python\'s big + 1 didn\'t wrap', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.startsWith('32768')) },
      { text: 'Write wrap, so Python does what fixed-width hardware does, for any width and for negative n too', hint: 'n % 2 ** bits keeps the low bits. If that\'s at least 2 ** (bits - 1), the top bit is on, so subtract 2 ** bits', done: (s) => finished(s) && passes(s, 'wrap', WRAP_CASES), why: (s) => why(s, 'wrap', WRAP_CASES) },
      { text: 'Write fits, the check Ariane\'s unprotected conversion didn\'t have', hint: 'The range is -(2 ** (bits - 1)) up to 2 ** (bits - 1) - 1. Mind the extra negative', done: (s) => finished(s) && passes(s, 'fits', FITS_CASES), why: (s) => why(s, 'fits', FITS_CASES) },
    ],
    debrief: 'wrap is exact arithmetic on Python\'s unlimited ints, kept to the low bits. Real hardware doesn\'t do a calculation to get there: its register has no place for the extra bits, so the wrap comes for free. And fits is the easy part of the problem. Knowing a value won\'t fit doesn\'t tell you what to do about it, which is a question the Ariane inquiry took seriously: its recommendation R3 was that a sensor must not stop sending best effort data.',
  },
  'comp-float-close': {
    id: 'comp-float-close', title: 'Near enough, and how to share a bill', xp: 70, setup: blank,
    starter: `print(0.1 + 0.2 == 0.3)

# close(0.1 + 0.2, 0.3) should be True. close(1.0, 1.1) should be False.
def close(a, b):
    return a == b

# split(100, 3) should share 100 cents between 3 people: [34, 33, 33], in any order.
def split(cents, people):
    return [cents / people] * people

print(close(0.1 + 0.2, 0.3))
print(split(100, 3))
`,
    steps: [
      { text: 'Run it. == says False, and the bill has fractions of a cent', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.startsWith('False')) },
      { text: 'Write close, so it works for numbers of any size: huge ones that differ only by rounding, and tiny ones that really are different', hint: 'Compare the difference with the size of the numbers: abs(a - b) <= 1e-9 * max(abs(a), abs(b)). If you add an absolute floor, as math.isclose can, it has to be smaller than the numbers you care about: a floor of 1e-12 calls 1e-20 and 2e-20 the same, and this step counts those as different', done: (s) => closeVerdict(s).ok, why: (s) => closeVerdict(s).why },
      { text: 'Write split with whole cents only. The shares must add up to exactly the total, and differ by at most one cent', hint: 'cents // people each, then give one extra cent to the first cents % people people', done: (s) => splitVerdict(s).ok, why: (s) => splitVerdict(s).why },
    ],
    debrief: 'Two different answers to two different problems. A tolerance suits measurements, where nothing was ever exact, and the size of the numbers decides what "near" means. It isn\'t right for every case: a purely relative test calls 1e-20 and 0.0 different, because no difference is small compared with zero, and that\'s why Python\'s math.isclose takes a second, absolute tolerance, which you set to suit your data. Money is the other kind. A cent exists exactly, so you count whole cents, and the remainder is yours to decide about, instead of being rounded away where nobody sees it.',
  },
  'comp-text-utf8': {
    id: 'comp-text-utf8', title: 'Count the bytes yourself', xp: 70, setup: blank,
    starter: `# ord gives a character's number. chr goes the other way.
print(ord("A"), chr(65))
print(ord("é"), ord("€"), ord("😀"))
print(len("😀"))

# utf8_len("é") should give 2: bytes, not code points.
def utf8_len(text):
    return len(text)

# utf8_bytes("é") should give [195, 169], the UTF-8 bytes of one code point.
def utf8_bytes(ch):
    return [ord(ch)]

print(utf8_len("héllo"))
print(utf8_bytes("é"))
`,
    steps: [
      { text: 'Run it. len says 1 for the emoji: Python counts code points, not bytes', hint: 'Press Run', done: (s) => s.runs.some((r) => r.status === 'done' && r.stdout.includes('128512')) },
      { text: 'Write utf8_len, using the table: under 128 is 1 byte, under 2048 is 2, under 65536 is 3, the rest 4', hint: 'Loop over the characters and add up according to ord(c)', done: (s) => finished(s) && passes(s, 'utf8_len', UTF8_LEN_CASES), why: (s) => why(s, 'utf8_len', UTF8_LEN_CASES) },
      { text: 'Write utf8_bytes for one code point, from the table in the lesson', hint: 'For two bytes: [192 + n // 64, 128 + n % 64]. For three: [224 + n // 4096, 128 + (n // 64) % 64, 128 + n % 64]. Four works the same way, starting at 240 with n // 262144', done: (s) => finished(s) && passes(s, 'utf8_bytes', UTF8_BYTES_CASES), why: (s) => why(s, 'utf8_bytes', UTF8_BYTES_CASES) },
    ],
    debrief: 'That\'s a real UTF-8 encoder for every code point except surrogates, which the lesson\'s optional section explains, and this site\'s tests hold its answers to the ones real Python\'s .encode() gives. The first byte says how many bytes this code point takes, and every byte after it starts with the bits 10, so a program that lands in the middle of a code point can find the next one. And code points and bytes are different counts. A file or a network packet is measured in bytes, and a database column may be, so find out which count a limit means.',
  },
};
