// The Cache Lab's model: a set-associative cache with a configurable size, line size and number
// of ways, fed the exact memory addresses a loop reads. Every count is arithmetic, not timing, so
// it's the same on every machine and tests/cache.test.ts can hold it against a separate
// implementation in real Python. Its time is only ever Norvig's round numbers, labelled as his.
//
// It's one level with no TLB, no real prefetcher and no other core. That's part of why the measured
// gap in the lesson, 43x to 60x at 64 MB and up, is bigger than this model's misses alone predict.
// The lesson says what else might be in that number, and which of it hasn't been measured.

import type { Mission } from '../missions.ts';
import { makeCycle } from './layout.ts';

export const HIT_NS = 0.5;
export const MISS_PENALTY_NS = 100;
export const ELEMENT_BYTES = 4;

export type Policy = 'lru' | 'fifo';
export type CacheConfig = { sizeBytes: number; lineBytes: number; ways: number; policy: Policy; prefetch: boolean };
export const DEFAULT_CONFIG: CacheConfig = { sizeBytes: 32 * 1024, lineBytes: 64, ways: 8, policy: 'lru', prefetch: false };
export const SIZE_CHOICES = [1024, 4096, 16 * 1024, 32 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024];
export const LINE_CHOICES = [16, 32, 64, 128];
export const WAY_CHOICES = [1, 2, 4, 8];
/** The number of ways that makes this cache fully associative: any line can go anywhere. */
export const fullWays = (cfg: Pick<CacheConfig, 'sizeBytes' | 'lineBytes'>) => cfg.sizeBytes / cfg.lineBytes;

const isPowerOfTwo = (n: number) => n > 0 && (n & (n - 1)) === 0;

export type Shape = { lines: number; sets: number; offsetBits: number; indexBits: number };
/** Refuses a shape that can't be a cache, rather than rounding it into a different cache. */
export function shapeOf(cfg: CacheConfig): Shape {
  if (!isPowerOfTwo(cfg.lineBytes)) throw new Error(`a line size has to be a power of two, not ${cfg.lineBytes}`);
  if (!isPowerOfTwo(cfg.ways)) throw new Error(`the number of ways has to be a power of two, not ${cfg.ways}`);
  if (!isPowerOfTwo(cfg.sizeBytes)) throw new Error(`a cache size has to be a power of two, not ${cfg.sizeBytes}`);
  const lines = cfg.sizeBytes / cfg.lineBytes;
  if (!Number.isInteger(lines) || lines < cfg.ways) throw new Error(`a ${cfg.sizeBytes}-byte cache has ${lines} lines of ${cfg.lineBytes} bytes, too few for ${cfg.ways} ways`);
  const sets = lines / cfg.ways;
  return { lines, sets, offsetBits: Math.log2(cfg.lineBytes), indexBits: Math.log2(sets) };
}

/** An address cut the way this cache cuts it: which set it can go in, and what's stored to recognise it. */
export function splitAddress(addr: number, cfg: CacheConfig) {
  const { sets, offsetBits, indexBits } = shapeOf(cfg);
  const offset = addr & (cfg.lineBytes - 1);
  const line = Math.floor(addr / cfg.lineBytes);
  return { offset, set: line % sets, tag: Math.floor(line / sets), offsetBits, indexBits };
}

export type CacheResult = {
  accesses: number; hits: number; misses: number;
  /** First time this line has been near the cache: no cache could have helped, short of fetching ahead. */
  cold: number;
  /** A fully associative cache of the same size would have missed too: there's too much data. */
  capacity: number;
  /** A fully associative cache of the same size and the same replacement rule would have hit: only the placement rule cost this. */
  conflict: number;
  prefetches: number;
  amatNs: number;
};

/**
 * Plays the addresses through the cache. Each miss is sorted into the classic three kinds by a
 * shadow: a fully associative cache with the same number of lines and the same replacement rule.
 * The shadow used to be LRU whatever the cache was, so a fully associative FIFO cache, which has no
 * placement rule to blame, showed 2,275 "conflict" misses at a side of 128. A prefetched line counts
 * as seen, so a prefetch that works removes a miss from the cold column.
 */
export function simulateCache(addrs: Iterable<number>, cfg: CacheConfig): CacheResult {
  const { lines, sets } = shapeOf(cfg);
  const table: number[][] = Array.from({ length: sets }, () => []);
  const shadow = new Map<number, true>();
  const seen = new Set<number>();
  let accesses = 0, hits = 0, cold = 0, capacity = 0, conflict = 0, prefetches = 0;

  const touchShadow = (line: number) => {
    if (shadow.has(line)) {
      // Oldest first, as in the real sets: LRU refreshes a hit, and FIFO leaves it where it entered.
      if (cfg.policy === 'lru') { shadow.delete(line); shadow.set(line, true); }
      return true;
    }
    if (shadow.size === lines) shadow.delete(shadow.keys().next().value!);
    shadow.set(line, true);
    return false;
  };
  const insert = (line: number) => {
    const s = table[line % sets];
    if (s.length === cfg.ways) s.shift();
    s.push(line);
  };

  for (const a of addrs) {
    accesses++;
    const line = Math.floor(a / cfg.lineBytes);
    const s = table[line % sets];
    const at = s.indexOf(line);
    const shadowHad = touchShadow(line);
    if (at >= 0) {
      hits++;
      // Oldest first in the array, so LRU moves a hit to the end. FIFO leaves it where it entered.
      if (cfg.policy === 'lru') { s.splice(at, 1); s.push(line); }
      continue;
    }
    if (!seen.has(line)) cold++;
    else if (shadowHad) conflict++;
    else capacity++;
    seen.add(line);
    insert(line);
    if (cfg.prefetch) {
      // Next-line prefetch: on a miss, also fetch the line after it. The simplest real scheme there is.
      const next = line + 1;
      if (!table[next % sets].includes(next)) {
        prefetches++;
        insert(next);
        seen.add(next);
        touchShadow(next);
      }
    }
  }
  const misses = accesses - hits;
  return { accesses, hits, misses, cold, capacity, conflict, prefetches, amatNs: accesses ? HIT_NS + (misses / accesses) * MISS_PENALTY_NS : 0 };
}

// ---- the loops ----------------------------------------------------------------------

export type Pattern = 'rows' | 'cols' | 'walk-order' | 'walk-scattered' | 'two-arrays';
export const PATTERNS: { id: Pattern; label: string }[] = [
  { id: 'rows', label: 'matrix: rows first' },
  { id: 'cols', label: 'matrix: columns first' },
  { id: 'walk-order', label: 'walk: next item is the next address' },
  { id: 'walk-scattered', label: 'walk: next item is anywhere' },
  { id: 'two-arrays', label: 'two arrays, one cache size apart' },
];
export const SIDES = [32, 64, 128, 256, 512];

/**
 * The byte addresses a loop reads, in order. `side` is the matrix's side, and the other loops
 * read the same number of elements as that matrix has, so every loop does the same work.
 */
export function* accesses(p: Pattern, side: number, passes: number, cfg: Pick<CacheConfig, 'sizeBytes'>, seed = 1): Generator<number> {
  const n = side * side;
  for (let pass = 0; pass < passes; pass++) {
    switch (p) {
      case 'rows':
        for (let r = 0; r < side; r++) for (let c = 0; c < side; c++) yield (r * side + c) * ELEMENT_BYTES;
        break;
      case 'cols':
        for (let c = 0; c < side; c++) for (let r = 0; r < side; r++) yield (r * side + c) * ELEMENT_BYTES;
        break;
      case 'walk-order':
        for (let i = 0; i < n; i++) yield i * ELEMENT_BYTES;
        break;
      case 'walk-scattered': {
        const next = makeCycle(n, seed);
        for (let i = 0, at = 0; i < n; i++, at = next[at]) yield at * ELEMENT_BYTES;
        break;
      }
      case 'two-arrays': {
        // Half as many of each, read in turn. b starts exactly one cache size after a, so in a
        // direct-mapped cache a[i] and b[i] always want the same slot.
        for (let i = 0; i < Math.floor(n / 2); i++) { yield i * ELEMENT_BYTES; yield cfg.sizeBytes + i * ELEMENT_BYTES; }
        break;
      }
    }
  }
}

/** At a large side the "two arrays" loop's arrays run into each other: each is half the matrix, and they start one cache size apart. */
export const arraysOverlap = (side: number, sizeBytes: number) => Math.floor((side * side) / 2) * ELEMENT_BYTES > sizeBytes;

export type CacheRun = { pattern: Pattern; side: number; passes: number; cfg: CacheConfig; result: CacheResult };
export function runPattern(pattern: Pattern, side: number, passes: number, cfg: CacheConfig): CacheRun {
  return { pattern, side, passes, cfg: { ...cfg }, result: simulateCache(accesses(pattern, side, passes, cfg), cfg) };
}

// ---- the mission -----------------------------------------------------------------------

export type CacheState = { runs: CacheRun[] };
const sameCache = (a: CacheConfig, b: CacheConfig) => a.sizeBytes === b.sizeBytes && a.lineBytes === b.lineBytes && a.ways === b.ways && a.policy === b.policy && a.prefetch === b.prefetch;
const pair = (s: CacheState, a: Pattern, b: Pattern, test: (x: CacheRun, y: CacheRun) => boolean) =>
  s.runs.some((x) => x.pattern === a && s.runs.some((y) => y.pattern === b && y.side === x.side && y.passes === x.passes && test(x, y)));
const clean = (r: CacheRun) => r.result.capacity === 0 && r.result.conflict === 0;
// Compared against an earlier run of the same matrix that did show those misses. Without that, a
// side of 32 in the default cache ticked "change only the cache", by shrinking the matrix instead.
const fixedByCache = (s: CacheState) => s.runs.some((good) => good.pattern === 'cols' && good.passes >= 2 && clean(good) && s.runs.some((bad) => bad.pattern === 'cols' && bad.side === good.side && !clean(bad)));
const whyNotFixed = (s: CacheState) => {
  const last = s.runs.at(-1);
  if (!last || last.pattern !== 'cols' || !clean(last) || fixedByCache(s)) return '';
  if (last.passes < 2) return 'One pass can hide those misses, because a line that was thrown out only shows up when it\'s read again. Set passes to 2.';
  return `A side of ${last.side} already fits this cache, so nothing has been fixed yet. Keep the matrix from the first step, which didn't fit, and change only the cache.`;
};

export const CACHE_MISSION: Mission<CacheState> = {
  id: 'cache-same-loop', title: 'Same loop, different bill', xp: 70,
  setup: () => ({ runs: [] }),
  steps: [
    { text: 'Run rows first and columns first on the same matrix with the same cache. Same reads, same answer. Compare the misses', hint: 'Keep the default cache, use a side of 256, and run each pattern once', done: (s) => pair(s, 'rows', 'cols', (x, y) => sameCache(x.cfg, y.cfg) && x.result.accesses === y.result.accesses && y.result.misses > x.result.misses) },
    { text: 'Leave columns first alone and change only the cache until, over 2 passes, no miss is a capacity or conflict miss', hint: 'The matrix has to fit. A side of 256 is 256 KB of data', done: fixedByCache, why: whyNotFixed },
    { text: 'Two arrays one cache size apart: run them in a direct-mapped cache (1 way), then with 2 ways and the same total size. Watch the conflict misses', hint: 'Pattern "two arrays". A side of 64 and a 32 KB cache fit in both, so only the ways change', done: (s) => s.runs.some((a) => a.pattern === 'two-arrays' && a.cfg.ways === 1 && a.result.conflict > 0 && s.runs.some((b) => b.pattern === 'two-arrays' && b.cfg.ways === 2 && b.side === a.side && b.passes === a.passes && b.cfg.sizeBytes === a.cfg.sizeBytes && b.cfg.lineBytes === a.cfg.lineBytes && b.result.conflict === 0 && b.result.misses < a.result.misses)) },
    { text: 'Switch on the prefetcher and run both walks. It helps one a lot. Does it help the other?', hint: 'Run each walk with Prefetch on and with it off, at the same side and passes', done: (s) => {
      const seen = (p: Pattern, on: boolean) => s.runs.filter((r) => r.pattern === p && r.cfg.prefetch === on);
      return seen('walk-order', true).some((a) => seen('walk-order', false).some((b) => a.side === b.side && a.passes === b.passes && a.result.misses < b.result.misses))
        && seen('walk-scattered', true).some((a) => seen('walk-scattered', false).some((b) => a.side === b.side && a.passes === b.passes));
    } },
  ],
  debrief: 'Every loop here read the same number of elements, so big-O, which only counts how the steps grow, calls them all the same. The misses came from three places, and each has a different cure. Cold misses go with fetching ahead, capacity misses with less data or more cache, and conflict misses with more ways. You can only cure the one you can name. These are exact counts from a small model. Real caches have more levels and smarter prefetchers, and your CPU also has to translate addresses, which is why a real measurement, like the panel below, can show more than this model does.',
};
