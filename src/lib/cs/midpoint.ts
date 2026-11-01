// The Midpoint Lab's logic. It searches a virtual array, where a[i] is simply i,
// so a length of two billion allocates nothing.
//
// The wrap is emulated. Neither JavaScript's numbers nor Python's ints wrap at 32
// bits, so nothing here "really" overflows: wrap() does the arithmetic a 32-bit
// signed int would. The test holds it against ctypes.c_int32 in real Python.

import type { Mission } from '../missions.ts';

export type IntModel = 'int32' | 'int64' | 'python';
export type Formula = 'sum' | 'diff' | 'ushift';
export type Target = 'last' | 'first';

export const MAX_LENGTH = 2 ** 31 - 1;
export const SHORTEST_BREAKING = 2 ** 30 + 1;
export const MODELS: { id: IntModel; label: string }[] = [
  { id: 'int32', label: '32-bit int (wrap emulated here)' },
  { id: 'int64', label: '64-bit int' },
  { id: 'python', label: 'Python int (never wraps)' },
];
export const FORMULAS: { id: Formula; label: string }[] = [
  { id: 'sum', label: '(low + high) / 2' },
  { id: 'diff', label: 'low + (high - low) / 2' },
  { id: 'ushift', label: '(low + high) >>> 1' },
];

/** Two's complement wrap to `bits` bits. Below 53 bits a double holds every value involved exactly. */
export function wrap(x: number, bits = 32): number {
  const m = 2 ** bits, half = m / 2;
  const r = ((x % m) + m) % m;
  return r >= half ? r - m : r;
}

const bitsOf = (model: IntModel) => (model === 'int32' ? 32 : null);

/**
 * One midpoint. `sum` is what the int holds after adding, shown because that's
 * where the bug is visible. Division truncates toward zero, as Java's does.
 * >>> reads the wrapped bits as unsigned, which undoes the wrap. Python has no
 * >>>, and its >> gives the same answer on an unwrapped positive sum.
 */
export function midpoint(low: number, high: number, model: IntModel, formula: Formula, bits = bitsOf(model)): { sum: number; mid: number; wrapped: boolean } {
  const fit = (x: number) => (bits === null ? x : wrap(x, bits));
  if (formula === 'diff') {
    const d = fit(high - low);
    return { sum: d, mid: fit(low + Math.trunc(d / 2)), wrapped: false };
  }
  const exact = low + high, sum = fit(exact), wrapped = sum !== exact;
  if (formula === 'sum') return { sum, mid: Math.trunc(sum / 2), wrapped };
  const unsigned = bits === null ? sum : ((sum % 2 ** bits) + 2 ** bits) % 2 ** bits;
  return { sum, mid: Math.floor(unsigned / 2), wrapped };
}

export type Probe = { low: number; high: number; sum: number; mid: number; wrapped: boolean };
export type SearchResult = { length: number; target: number; status: 'found' | 'absent' | 'out-of-bounds'; index: number; reads: number; probes: Probe[] };

/** Bloch's loop, on a virtual array. A probe outside the array stops the run, as ArrayIndexOutOfBoundsException does. */
export function search(length: number, targetValue: number, model: IntModel, formula: Formula, bits = bitsOf(model)): SearchResult {
  let low = 0, high = length - 1, reads = 0;
  const probes: Probe[] = [];
  while (low <= high) {
    const m = midpoint(low, high, model, formula, bits);
    probes.push({ low, high, sum: m.sum, mid: m.mid, wrapped: m.wrapped });
    if (m.mid < 0 || m.mid >= length) return { length, target: targetValue, status: 'out-of-bounds', index: m.mid, reads, probes };
    reads++;
    if (m.mid < targetValue) low = m.mid + 1;
    else if (m.mid > targetValue) high = m.mid - 1;
    else return { length, target: targetValue, status: 'found', index: m.mid, reads, probes };
  }
  return { length, target: targetValue, status: 'absent', index: -(low + 1), reads, probes };
}

export const targetValue = (length: number, t: Target) => (t === 'last' ? length - 1 : 0);

/**
 * How many of `count` targets, chosen at random from values in the array, make the
 * search crash. At the shortest breaking length one value in a billion does: the last.
 * That isn't the whole set of keys that crash. A key bigger than the last element
 * isn't in the array and crashes there too, so a test for "missing, past the end"
 * would find it on an array that long. Nobody's test had one. Seeded, so a test can
 * assert the count.
 */
export function randomTargets(length: number, count: number, model: IntModel, formula: Formula, seed = 1): number {
  let a = seed >>> 0, crashes = 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i++) if (search(length, Math.floor(next() * length), model, formula).status === 'out-of-bounds') crashes++;
  return crashes;
}

/** Worst-case reads, ⌈log₂(n+1)⌉, which is n's length in binary: Math.log2 rounds badly near powers of two. */
export function worstReads(n: bigint): number {
  return n.toString(2).length;
}

// ---- Unsorted input ------------------------------------------------------

/** A port of bisect.bisect_left. The test compares it with the real one, wrong answers included. */
export function bisectLeft(a: number[], x: number): { index: number; reads: number } {
  let lo = 0, hi = a.length, reads = 0;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    reads++;
    if (a[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return { index: lo, reads };
}

export const isSorted = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1] <= v);

export type UnsortedRun = { items: number[]; target: number; index: number; found: boolean; present: boolean; sorted: boolean };

/** What a caller of bisect_left would conclude, next to the truth a plain scan gives. No error in either case: that's the failure. */
export function lookup(items: number[], target: number): UnsortedRun {
  const { index } = bisectLeft(items, target);
  return { items, target, index, found: index < items.length && items[index] === target, present: items.includes(target), sorted: isSorted(items) };
}

/** Refuses anything that isn't a plain list of numbers: quietly dropping a typo would search a different list from the one on screen. */
export function parseItems(text: string): { items: number[] } | { error: string } {
  const parts = text.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (!parts.length) return { error: 'Type at least one number, separated by commas.' };
  if (parts.length > 40) return { error: 'Keep it to 40 numbers, so the trace fits.' };
  const bad = parts.find((p) => !/^-?\d+$/.test(p));
  if (bad !== undefined) return { error: `"${bad}" is not a whole number.` };
  return { items: parts.map(Number) };
}

// ---- The mission ---------------------------------------------------------

export type MidpointState = { runs: (SearchResult & { model: IntModel; formula: Formula; targetKind: Target })[]; unsorted: UnsortedRun[] };

const original = (r: MidpointState['runs'][number]) => r.model === 'int32' && r.formula === 'sum' && r.targetKind === 'last';

export const MIDPOINT_MISSION: Mission<MidpointState> = {
  id: 'alg-midpoint-shortest', title: 'Find the shortest array that breaks it', xp: 70,
  setup: () => ({ runs: [], unsorted: [] }),
  steps: [
    { text: 'Search for the last element with the original formula on 32-bit ints, on an array of a million. It works', hint: 'Length 1000000, target "last element", then Search', done: (s) => s.runs.some((r) => original(r) && r.status === 'found' && r.length >= 1000) },
    { text: 'Make it crash. Keep the same settings and make the array longer', hint: 'Try the longest array the slider allows', done: (s) => s.runs.some((r) => original(r) && r.status === 'out-of-bounds') },
    { text: 'Find the shortest length that crashes: that length fails and one less works. You can binary search for it', hint: 'Pick a length halfway between one that works and one that crashes, and repeat. It takes about 31 tries at most. +1 and -1 finish the job', done: (s) => s.runs.some((r) => original(r) && r.length === SHORTEST_BREAKING && r.status === 'out-of-bounds') && s.runs.some((r) => original(r) && r.length === SHORTEST_BREAKING - 1 && r.status === 'found') },
    { text: 'Fix it without leaving 32-bit ints: the same length must now find the last element', hint: 'Change the midpoint formula', done: (s) => s.runs.some((r) => r.model === 'int32' && r.formula !== 'sum' && r.targetKind === 'last' && r.length >= SHORTEST_BREAKING && r.status === 'found') },
    { text: 'Now the bug you are more likely to meet. In the second panel, make a search say "not there" about a number that is in the list', hint: 'The list 3, 1, 2 and the target 3 does it', done: (s) => s.unsorted.some((u) => u.present && !u.found) },
  ],
  debrief: 'The shortest array is 1,073,741,825 elements, which is 2^30 + 1. Bloch wrote 2^30, one too low: at exactly 2^30 the largest possible sum is 2^31 - 2, which fits. At that length only a search that ends at the very end crashes: the last element, or a missing key bigger than everything before it. A random target from inside the array almost never gets there, and arrays that long were rare, so the code passed every test it was given for years. The unsorted list is worse in one way. It crashes nothing, and the answer looks fine.',
};
