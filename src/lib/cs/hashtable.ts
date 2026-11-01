// The Flood Lab's logic. The code lab's dict is deliberately not a hash table
// underneath (it uses a JavaScript Map) and its hash() refuses strings, so neither
// can show a collision. This is the model that can: CPython's dict rules, read
// from Objects/dictobject.c, with every equality check counted.
//
// tests/hashtable.test.ts runs it against real CPython and asserts the __eq__ count
// exactly. That is a stronger test than the textbook formula, which is wrong here:
// 1,000 keys sharing a hash cost 500,300 __eq__ calls with hash 42, not n(n-1)/2 =
// 499,500, because CPython's probe sequence can revisit a slot it already checked.
//
// Equality checks are not the whole bill. A review found the lab calling a flood
// "calm" because it only counted those: keys with all-different hashes make no
// __eq__ calls and can still walk past thousands of occupied slots per insert. So
// the model counts `probes` too, and calm() needs both numbers to be low. CPython
// has no probe counter to compare with, so the test holds the model's whole slot
// table against the real dict's, read with ctypes, which fixes where every key went.

import type { Mission } from '../missions.ts';
import { rng } from './layout.ts';

export const MIN_SIZE = 8;
const usable = (size: number) => Math.floor((size << 1) / 3);
const PERTURB_SHIFT = 5n;
const U64 = (1n << 64n) - 1n;

/**
 * Insert-only: this models adding keys, which is what a flood does. Deleted-slot
 * markers would add code this lesson has no use for.
 */
export class DictModel {
  size = MIN_SIZE;
  free = usable(MIN_SIZE);
  used = 0;
  /** Equality checks: the number that a real program pays for in __eq__ calls. */
  eq = 0;
  /** Insertion numbers (1-based) at which the table grew. */
  grewAt: number[] = [];
  /** Checks each insert needed. */
  perInsert: number[] = [];
  /** Occupied slots walked past, while inserting and while rebuilding on growth. */
  probes = 0;
  /** Occupied slots each insert walked past, rebuilds not included. Its shape is what the lab draws. */
  probesPerInsert: number[] = [];
  private slots = new Int32Array(MIN_SIZE).fill(-1);
  private hashes: bigint[] = [];
  private hashIds = new Map<bigint, number>();
  private ids: number[] = [];

  /** Adds a key known to be distinct from every other. Returns the checks it took. */
  insert(hash: bigint): number {
    const h = hash & U64;
    let id = this.hashIds.get(h);
    if (id === undefined) { id = this.hashIds.size; this.hashIds.set(h, id); this.hashes[id] = h; }
    // CPython looks up in the OLD table first, then resizes. A model that resized
    // first was off by a few (a test at n=11 catches it).
    let checks = 0, walked = 0, i = this.probeStart(h), perturb = h;
    const mask = this.size - 1;
    while (this.slots[i] >= 0) {
      walked++;
      if (this.ids[this.slots[i]] === id) checks++;
      // Once perturb is spent the sequence needs no big integers, and that is
      // nearly every step in a flood.
      if (perturb > 0n) { perturb >>= PERTURB_SHIFT; i = Number((BigInt(i) * 5n + perturb + 1n) & BigInt(mask)); }
      else i = (i * 5 + 1) & mask;
    }
    if (this.free === 0) {
      this.resize();
      i = this.findEmpty(h);
      this.grewAt.push(this.used + 1);
    } else if (this.used === 0 && this.grewAt.length === 0) {
      // An empty {} holds no table at all: the first key allocates one.
      this.grewAt.push(1);
    }
    this.slots[i] = this.ids.length;
    this.ids.push(id);
    this.free--;
    this.used++;
    this.eq += checks;
    this.probes += walked;
    this.perInsert.push(checks);
    this.probesPerInsert.push(walked);
    return checks;
  }

  /** The table as CPython's dk_indices holds it: for each slot, the entry number, or -1 if empty. */
  table(): number[] { return Array.from(this.slots); }

  private probeStart(h: bigint) { return Number(h & BigInt(this.size - 1)); }

  private findEmpty(h: bigint): number {
    const mask = this.size - 1;
    let i = this.probeStart(h), perturb = h;
    while (this.slots[i] >= 0) {
      this.probes++;
      if (perturb > 0n) { perturb >>= PERTURB_SHIFT; i = Number((BigInt(i) * 5n + perturb + 1n) & BigInt(mask)); }
      else i = (i * 5 + 1) & mask;
    }
    return i;
  }

  // GROWTH_RATE is used*3. Rebuilding makes no __eq__ calls: entries already know
  // they are distinct, so they only need an empty slot.
  private resize() {
    let s = MIN_SIZE;
    while (s < this.used * 3) s *= 2;
    this.size = s;
    this.free = usable(s) - this.used;
    this.slots = new Int32Array(s).fill(-1);
    for (let e = 0; e < this.ids.length; e++) this.slots[this.findEmpty(this.hashes[this.ids[e]])] = e;
  }
}

export function eqCount(n: number, hash: bigint | number): number {
  const d = new DictModel(), h = BigInt(hash);
  for (let i = 0; i < n; i++) d.insert(h);
  return d.eq;
}

export function resizePoints(n: number, hashOf: (i: number) => bigint = (i) => BigInt(i)): number[] {
  const d = new DictModel();
  for (let i = 0; i < n; i++) d.insert(hashOf(i));
  return d.grewAt;
}

// ---- hash functions ---------------------------------------------------------

/** DJBX33A with 32-bit wrap. The start value is a parameter so the lab can try "seeding" it. */
export function djbx33a(s: string, start = 5381): number {
  let h = start >>> 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return h;
}

const rotl = (x: bigint, b: bigint) => ((x << b) | (x >> (64n - b))) & U64;

/** SipHash-1-3, the hash real Python uses for str since 3.11. Checked in tests against real hash() with PYTHONHASHSEED=0. */
export function siphash13(k0: bigint, k1: bigint, bytes: Uint8Array): bigint {
  let v0 = k0 ^ 0x736f6d6570736575n, v1 = k1 ^ 0x646f72616e646f6dn, v2 = k0 ^ 0x6c7967656e657261n, v3 = k1 ^ 0x7465646279746573n;
  const round = () => {
    v0 = (v0 + v1) & U64; v1 = rotl(v1, 13n); v1 ^= v0; v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & U64; v3 = rotl(v3, 16n); v3 ^= v2;
    v0 = (v0 + v3) & U64; v3 = rotl(v3, 21n); v3 ^= v0;
    v2 = (v2 + v1) & U64; v1 = rotl(v1, 17n); v1 ^= v2; v2 = rotl(v2, 32n);
  };
  const whole = bytes.length - (bytes.length % 8);
  for (let i = 0; i < whole; i += 8) {
    let m = 0n;
    for (let j = 7; j >= 0; j--) m = (m << 8n) | BigInt(bytes[i + j]);
    v3 ^= m; round(); v0 ^= m;
  }
  let b = BigInt(bytes.length & 0xff) << 56n;
  for (let j = bytes.length - 1; j >= whole; j--) b |= BigInt(bytes[j]) << BigInt((j - whole) * 8);
  v3 ^= b; round(); v0 ^= b;
  v2 ^= 0xffn;
  round(); round(); round();
  return v0 ^ v1 ^ v2 ^ v3;
}

const encoder = new TextEncoder();
/** What hash(s) would return for an ASCII string under this key, as a signed number. */
export function pythonStrHash(s: string, k0 = 0n, k1 = 0n): bigint {
  if (s.length === 0) return 0n;
  const h = BigInt.asIntN(64, siphash13(k0, k1, encoder.encode(s)));
  return h === -1n ? -2n : h;
}

// ---- traffic ------------------------------------------------------------------

/** Klink & Wälde's building blocks: any mix of these gives the same DJBX33A hash, whatever the start value. */
export const COLLIDING_PAIR = ['Ez', 'FY'] as const;

export function craftedKeys(pairs: number): string[] {
  const out: string[] = [];
  for (let n = 0; n < 2 ** pairs; n++) {
    let s = '';
    for (let b = 0; b < pairs; b++) s += COLLIDING_PAIR[(n >> b) & 1];
    out.push(s);
  }
  return out;
}

/** Same count and length as the crafted keys, so request size can't explain the difference. */
export function ordinaryKeys(pairs: number): string[] {
  const out: string[] = [], letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let seed = 2026;
  for (let n = 0; n < 2 ** pairs; n++) {
    let s = '';
    for (let c = 0; c < pairs * 2; c++) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      s += letters[(seed >>> 8) % letters.length];
    }
    out.push(s);
  }
  return out;
}

export const MERSENNE_61 = (1n << 61n) - 1n;
/** Multiples of 2^61-1 all hash to 0 on 64-bit CPython. No secret is involved, on any run. */
export const intHash = (k: bigint) => k % MERSENNE_61;

/** The largest integer key a "must fit in 32 bits" range check lets through, plus one. */
export const RANGE_LIMIT = 2n ** 32n;

const walkCache = new Map<number, bigint[]>();

/**
 * `count` integer keys below 2^32, all with different hashes, that still make the
 * table walk. An integer's hash is the integer, so the attacker picks each key's
 * whole probe path. Once perturb runs out the recipe is i -> 5i + 1, the same long
 * cycle for every key. So: fill a stretch of that cycle, then keep only keys whose
 * early probes land inside the stretch, so each one walks to the end of it.
 *
 * Sized so the stretch is exactly what fits before the table's last growth, which
 * keeps its keys collision-free in the smaller table too. Deterministic, so a test
 * can run the same list through real Python.
 */
export function walkKeys(count: number): bigint[] {
  const cached = walkCache.get(count);
  if (cached) return cached;
  let m = MIN_SIZE;
  while (usable(m) < count) m *= 2;
  const mask = m - 1, orbit = new Int32Array(m), pos = new Int32Array(m);
  for (let j = 0, i = 0; j < m; j++) { orbit[j] = i; pos[i] = j; i = (5 * i + 1) & mask; }
  const stretch = Math.min(count, usable(m / 2));
  const keys: bigint[] = [];
  const seen = new Set<number>();
  for (let j = 0; j < stretch; j++) { keys.push(BigInt(orbit[j])); seen.add(orbit[j]); }
  const r = rng(61);
  let filled = stretch;
  while (keys.length < count) {
    const x = Math.floor(r() * 2 ** 32);
    if (seen.has(x)) continue;
    let i = x & mask, p = x, inside = true;
    // The same steps as DictModel: test the slot, stop once perturb is spent.
    for (;;) {
      if (pos[i] >= filled) { inside = false; break; }
      if (p === 0) break;
      p = Math.floor(p / 32);
      i = (i * 5 + p + 1) & mask;
    }
    if (!inside) continue;
    keys.push(BigInt(x));
    seen.add(x);
    filled++;
  }
  walkCache.set(count, keys);
  return keys;
}

export type Traffic = 'ordinary' | 'crafted' | 'ints' | 'walk';
export type Defence = 'none' | 'seeded' | 'keyed' | 'trees';
export type LabConfig = { traffic: Traffic; defence: Defence; cap: boolean; intsAsStr: boolean; pairs: number; rangeCheck?: boolean };
export const PARAM_CAP = 1000;

export type FloodRun = LabConfig & {
  /** How many keys the request carried, and how many the server accepted. */
  sent: number; accepted: number;
  /** Keys the range check refused, before the count limit saw them. */
  outOfRange: number;
  bytes: number;
  checks: number;
  /**
   * Occupied slots walked past. Null when the trees sketch ran: it has no slots, so
   * it has no number here, and null keeps "not modelled" apart from "checked, zero".
   */
  probes: number | null;
  /** n(n-1)/2 for the accepted keys: the textbook's figure, drawn beside the real one. */
  textbook: number;
  perInsert: number[];
  worstInsert: number;
  /** What the lab draws: slots walked per insert, or checks per insert for the trees sketch. */
  drawn: number[];
};

/**
 * JEP 180's idea, not Java's code: a bucket of colliding keys kept in order, so a
 * lookup costs about log₂(bucket size) comparisons. Labelled as a sketch in the lab.
 */
function treeBuckets(hashes: bigint[]): { checks: number; perInsert: number[] } {
  const sizes = new Map<bigint, number>(), perInsert: number[] = [];
  let checks = 0;
  for (const h of hashes) {
    const m = sizes.get(h) ?? 0;
    const c = m === 0 ? 0 : Math.ceil(Math.log2(m + 1));
    sizes.set(h, m + 1);
    checks += c;
    perInsert.push(c);
  }
  return { checks, perInsert };
}

export class FloodLab {
  runs: FloodRun[] = [];
  /** The defender's secrets. New per lab, as Python picks new ones per process. */
  k0: bigint; k1: bigint; djbStart: number;

  constructor(rand: () => number = Math.random) {
    const r64 = () => (BigInt(Math.floor(rand() * 2 ** 32)) << 32n) | BigInt(Math.floor(rand() * 2 ** 32));
    this.k0 = r64(); this.k1 = r64();
    this.djbStart = Math.floor(rand() * 2 ** 32) >>> 0;
  }

  send(c: LabConfig): FloodRun {
    // An attacker who knows the limit builds the walk to fit it. Cutting a longer
    // list down would keep only its stretch of harmless keys, and the limit would
    // look far stronger than it is. So that request really is PARAM_CAP keys long.
    const sent = c.traffic === 'walk' && c.cap ? Math.min(2 ** c.pairs, PARAM_CAP) : 2 ** c.pairs;
    let keys: string[] = [], ints: bigint[] = [];
    if (c.traffic === 'crafted') keys = craftedKeys(c.pairs);
    else if (c.traffic === 'ordinary') keys = ordinaryKeys(c.pairs);
    else ints = c.traffic === 'walk' ? walkKeys(sent) : Array.from({ length: sent }, (_, i) => BigInt(i + 1) * MERSENNE_61);
    // Counted before any defence runs: what the attacker sends costs them this much
    // whether or not the server goes on to refuse it.
    const bytes = (ints.length ? ints.map(String) : keys).reduce((t, k) => t + k.length + 3, 0);
    let outOfRange = 0;
    if (c.rangeCheck && ints.length) {
      const kept = ints.filter((k) => k < RANGE_LIMIT);
      outOfRange = ints.length - kept.length;
      ints = kept;
    }
    // Keyed through str() when asked: the same keys, under the hash that has a secret.
    if (c.intsAsStr && ints.length) { keys = ints.map(String); ints = []; }
    const offered = ints.length || keys.length;
    const accepted = c.cap ? Math.min(offered, PARAM_CAP) : offered;
    const hashes: bigint[] = [];
    for (let i = 0; i < accepted; i++) {
      if (ints.length) { hashes.push(intHash(ints[i])); continue; }
      const k = keys[i];
      if (c.defence === 'keyed') hashes.push(pythonStrHash(k, this.k0, this.k1));
      else if (c.defence === 'seeded') hashes.push(BigInt(djbx33a(k, this.djbStart)));
      else hashes.push(BigInt(djbx33a(k)));
    }
    let checks: number, perInsert: number[], probes: number | null, drawn: number[];
    if (c.defence === 'trees') {
      ({ checks, perInsert } = treeBuckets(hashes));
      probes = null;
      drawn = perInsert;
    } else {
      const d = new DictModel();
      for (const h of hashes) d.insert(h);
      checks = d.eq; perInsert = d.perInsert; probes = d.probes; drawn = d.probesPerInsert;
    }
    const r: FloodRun = {
      ...c, sent, accepted, outOfRange, bytes, checks, probes, textbook: accepted * (accepted - 1) / 2,
      perInsert, drawn, worstInsert: drawn.reduce((m, x) => Math.max(m, x), 0),
    };
    this.runs.push(r);
    return r;
  }
}

/** A flood is when the bill is near the textbook's quadratic figure. */
export const flooded = (r: FloodRun) => r.accepted >= 512 && r.checks >= r.textbook * 0.9;
// Ordinary keys cost about one or two walked slots per insert in this model; see the
// test, which pins that margin. 25 per insert is far above that and far below an attack.
export const WALK_PER_KEY = 25;
/** Different hashes, and the table still walks: the attack equality checks can't see. */
export const walked = (r: FloodRun) => r.probes !== null && r.accepted >= 512 && r.probes > WALK_PER_KEY * r.accepted;
/**
 * Calm says this request cost little, on both counts. The trees sketch has no probe
 * count, so it is never calm: "not modelled" must not read as "checked and clear".
 */
export const calm = (r: FloodRun) => r.probes !== null && r.checks <= r.accepted && r.probes <= 4 * r.accepted;

// ---- no attacker needed: Linux's listening table, as Cloudflare described it ----

export const LHTABLE_SIZE = 32;
export const lhBucket = (port: number) => port % LHTABLE_SIZE;
/** Sockets per bucket for a list of [port, count] bindings. */
export function lhTable(bindings: [number, number][]): number[] {
  const t = new Array<number>(LHTABLE_SIZE).fill(0);
  for (const [port, count] of bindings) t[lhBucket(port)] += count;
  return t;
}

export type FloodState = { lab: FloodLab; lhSeen: boolean };

export const FLOOD_MISSION: Mission<FloodState> = {
  id: 'cs-flood-lab', title: 'Survive the flood', xp: 90,
  setup: () => ({ lab: new FloodLab(), lhSeen: false }),
  steps: [
    { text: 'Send an ordinary form with 4,096 fields. How many equality checks did the server make?', hint: 'Traffic: ordinary, defence: none, 4,096 keys, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'ordinary' && r.defence === 'none' && r.sent >= 4096 && calm(r)) },
    { text: 'Send the crafted form: the same number of fields, the same size in bytes', hint: 'Traffic: crafted Ez/FY keys, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'crafted' && r.defence === 'none' && !r.cap && flooded(r)) },
    { text: 'Try the obvious fix: start the hash from a secret random number', hint: 'Defence: secret start value, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'crafted' && r.defence === 'seeded' && !r.cap && flooded(r)) },
    { text: 'Use a hash built to take a secret key, and stop the flood', hint: 'Defence: SipHash with a secret key, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'crafted' && r.defence === 'keyed' && !r.cap && calm(r)) },
    { text: 'Keep that hash on, and send integer keys that are multiples of 2^61-1', hint: 'Traffic: integer keys, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'ints' && r.defence === 'keyed' && !r.cap && !r.intsAsStr && flooded(r)) },
    { text: 'Stop the integer flood without changing the hash: store the keys as strings', hint: 'Tick "store integer keys as strings", then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'ints' && r.defence === 'keyed' && r.intsAsStr && !r.cap && calm(r)) },
    { text: 'Those keys are huge, so try a range check instead: refuse any integer key that does not fit in 32 bits', hint: 'Traffic: multiples of 2^61-1, tick the range check, untick strings, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'ints' && !!r.rangeCheck && !r.intsAsStr && r.accepted === 0 && r.outOfRange === r.sent) },
    { text: 'Keep the range check, and send integers that all fit in 32 bits and all have different hashes. Read the equality checks, then the slots walked', hint: 'Traffic: integer keys that fit in 32 bits, range check on, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'walk' && !!r.rangeCheck && !r.intsAsStr && !r.cap && r.accepted === r.sent && r.outOfRange === 0 && r.checks === 0 && walked(r)) },
    { text: 'Store those keys as strings too, and watch the walk stop', hint: 'Tick "store integer keys as strings", with SipHash on, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'walk' && r.defence === 'keyed' && r.intsAsStr && !r.cap && r.accepted === r.sent && calm(r)) },
    { text: 'Try the bluntest defence on the crafted form: no secret at all, just a limit on how many fields a request may carry', hint: 'Defence: none, traffic: crafted, tick the limit, then Send', done: (s) => s.lab.runs.some((r) => r.traffic === 'crafted' && r.defence === 'none' && r.cap && r.sent > r.accepted && r.checks < r.textbook * 1.1 && r.accepted === PARAM_CAP) },
    { text: 'Now look at a flood with no attacker: bind 16,000 sockets to one port', hint: 'In "No attacker needed", press Bind 16,000 sockets to port 53', done: (s) => s.lhSeen },
  ],
  debrief: "The crafted form and the ordinary one were the same size, and one cost millions of comparisons. A secret start value changed every hash and left every collision in place, because Ez and FY collide from any start. SipHash ended it, since an attacker who can't compute the hash can't aim. Then integers walked straight through, because Python's integer hash has no secret at all, by design. A range check refused those huge keys and looked like the end of it. It wasn't: an attacker can still pick where a 32-bit key goes, so keys with no shared hash and no equality checks still walked thousands of occupied slots. Storing them as strings stopped both integer attacks, because a string goes under the keyed hash. The cap kept the cost small without fixing anything, which is why it is a limit and not a cure. And Cloudflare's table needed no attacker: a fixed 32 buckets and one busy port did it.",
};
