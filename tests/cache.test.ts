// The Cache Lab's counts are exact, so they're held against a separate implementation in real
// Python, and the learner's Python cache simulator is played through the code lab's engine. The
// "your machine" panel is timing on someone's hardware, and nothing here asserts it. The lesson's
// fifty times is a labelled measurement from one machine, for the same reason.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accesses, arraysOverlap, CACHE_MISSION, DEFAULT_CONFIG, ELEMENT_BYTES, fullWays, HIT_NS, MISS_PENALTY_NS, runPattern, shapeOf, simulateCache, splitAddress, type CacheConfig, type CacheState, type Pattern } from '../src/lib/cs/cache.ts';
import { COMPUTER_MISSIONS, DIRECT_CASES, LRU_CASES } from '../src/lib/cs/computer-cache-missions.ts';
import { summarise } from '../src/lib/py/lab.ts';
import { PyProgram } from '../src/lib/py/vm.ts';
import { python } from './helpers/python-json.ts';

const cfg = (over: Partial<CacheConfig> = {}): CacheConfig => ({ ...DEFAULT_CONFIG, ...over });

test('a hand-worked direct-mapped cache: exact hits, misses and kinds', () => {
  // 2 lines of 16 bytes, direct-mapped. Lines 0, 0, 2, 0, 1, 2: lines 0 and 2 both want set 0.
  // Line 0 again is a conflict: two lines fit, so only the placement rule threw it out. Line 2
  // the second time is capacity: by then a fully associative cache has also pushed it out for line 1.
  const c = cfg({ sizeBytes: 32, lineBytes: 16, ways: 1 });
  const r = simulateCache([0, 4, 32, 0, 16, 32], c);
  assert.deepEqual([r.accesses, r.hits, r.misses], [6, 1, 5]);
  assert.deepEqual([r.cold, r.capacity, r.conflict], [3, 1, 1]);
  // Fully associative with the same two lines: no conflict, by definition.
  const f = simulateCache([0, 4, 32, 0, 16, 32], cfg({ sizeBytes: 32, lineBytes: 16, ways: 2 }));
  assert.equal(f.conflict, 0);
  assert.equal(f.cold, 3);
});

test('the matrix loops: rows first misses once per line, and columns first can miss every time', () => {
  const rows = runPattern('rows', 256, 2, cfg()).result, cols = runPattern('cols', 256, 2, cfg()).result;
  assert.deepEqual([rows.accesses, rows.misses, rows.cold, rows.capacity, rows.conflict], [131072, 8192, 4096, 4096, 0]);
  assert.deepEqual([cols.accesses, cols.misses, cols.cold, cols.capacity, cols.conflict], [131072, 131072, 4096, 4096, 122880]);
  assert.equal(rows.amatNs, 6.75);
  assert.equal(cols.amatNs, 100.5);
  // 16 elements to a 64-byte line, so one miss in 16: the model's ratio in misses is exactly that.
  assert.equal(cols.misses / rows.misses, 16);
});

test('columns first in the default cache is mostly conflict, and full associativity shows it', () => {
  // Stepping 1,024 bytes at a time uses only 4 of the 64 sets, so 32 lines of a 512-line cache.
  const full = runPattern('cols', 256, 2, cfg({ ways: fullWays(DEFAULT_CONFIG) })).result;
  assert.equal(full.conflict, 0);
  assert.deepEqual([full.misses, full.cold, full.capacity], [8192, 4096, 4096]);
});

test('a cache that holds the whole matrix has only cold misses, whichever way it reads', () => {
  const big = cfg({ sizeBytes: 256 * 1024 });
  for (const p of ['rows', 'cols'] as Pattern[]) {
    const r = runPattern(p, 256, 2, big).result;
    assert.deepEqual([r.misses, r.cold, r.capacity, r.conflict], [4096, 4096, 0, 0], p);
  }
});

test('two arrays one cache size apart: all conflict when direct-mapped, gone with 2 ways', () => {
  const dm = runPattern('two-arrays', 64, 2, cfg({ ways: 1 })).result, two = runPattern('two-arrays', 64, 2, cfg({ ways: 2 })).result;
  assert.deepEqual([dm.accesses, dm.hits, dm.misses, dm.conflict], [8192, 0, 8192, 7936]);
  assert.deepEqual([two.misses, two.cold, two.conflict], [256, 256, 0]);
});

test('with oldest-in, a fully associative cache has no conflict misses: it showed 2,275 at a side of 128', () => {
  // The shadow was LRU whatever the cache did, so FIFO's own replacement choices came out labelled as
  // the placement rule's fault, in a cache that has no placement rule.
  const full = (side: number, passes: number) => { const c = cfg({ policy: 'fifo', ways: fullWays(DEFAULT_CONFIG) }); return runPattern('walk-scattered', side, passes, c).result; };
  assert.equal(full(128, 2).conflict, 0);
  assert.equal(full(256, 2).conflict, 0);
  assert.equal(full(128, 2).capacity + full(128, 2).cold, full(128, 2).misses);
  // By hand, 4 lines of 16 bytes: 0, 16, 32, 48 fill it, 64 evicts the oldest (0, even though it was
  // just read), and the last 0 misses because it's gone. Under this rule that's capacity.
  const hand = simulateCache([0, 16, 32, 48, 0, 64, 0], cfg({ sizeBytes: 64, lineBytes: 16, ways: 4, policy: 'fifo' }));
  assert.deepEqual([hand.misses, hand.cold, hand.capacity, hand.conflict], [6, 5, 1, 0]);
  // Under LRU the same reads keep 0 alive, and a set-associative FIFO can still have real conflicts.
  assert.deepEqual([simulateCache([0, 16, 32, 48, 0, 64, 0], cfg({ sizeBytes: 64, lineBytes: 16, ways: 4 })).misses], [5]);
  const twoWay = simulateCache([0, 32, 64, 0], cfg({ sizeBytes: 64, lineBytes: 16, ways: 2, policy: 'fifo' }));
  assert.equal(twoWay.conflict, 1, 'lines 0, 2 and 4 all want set 0 of 2 sets, and 4 lines would have kept them');
  // And LRU's numbers don't move, so the lesson's table still holds.
  assert.equal(runPattern('cols', 256, 2, cfg()).result.conflict, 122880);
});

test('more ways can mean more misses: "more ways make fewer accidents" and a loop just bigger than the cache', () => {
  const loop = [0, 64, 128, 192, 256, 0, 64, 128, 192, 256, 0, 64, 128, 192, 256];
  const at = (ways: number) => simulateCache(loop, cfg({ sizeBytes: 256, lineBytes: 64, ways })).misses;
  assert.deepEqual([at(1), at(2), at(4)], [9, 11, 15]);
});

test('next-line prefetch halves the cold misses of an in-order walk, and does little for a scattered one', () => {
  const off = cfg(), on = cfg({ prefetch: true });
  const inOff = runPattern('walk-order', 256, 1, off).result, inOn = runPattern('walk-order', 256, 1, on).result;
  assert.equal(inOff.misses, 4096);
  assert.equal(inOn.misses, 2048);
  const scOff = runPattern('walk-scattered', 256, 1, off).result, scOn = runPattern('walk-scattered', 256, 1, on).result;
  assert.ok(scOn.misses / scOff.misses > 0.9, `${scOn.misses} vs ${scOff.misses}`);
  // Exact, so a change to the walk or the prefetcher can't drift unseen.
  assert.deepEqual([scOff.misses, scOn.misses], [57800, 57517]);
});

test('an address is cut into tag, set and offset', () => {
  const c = cfg();
  const p = splitAddress(0x12345, c);
  assert.deepEqual(p, { offset: 0x05, set: 0x0d, tag: 0x12, offsetBits: 6, indexBits: 6 });
  assert.deepEqual(shapeOf(c), { lines: 512, sets: 64, offsetBits: 6, indexBits: 6 });
  // Put together again, the pieces are the address.
  assert.equal((p.tag * 64 + p.set) * 64 + p.offset, 0x12345);
});

test('a shape that can\'t be a cache is refused, not rounded', () => {
  assert.throws(() => shapeOf(cfg({ lineBytes: 48 })), /line size has to be a power of two/);
  assert.throws(() => shapeOf(cfg({ ways: 3 })), /ways has to be a power of two/);
  assert.throws(() => shapeOf(cfg({ sizeBytes: 3000 })), /cache size has to be a power of two/);
  assert.throws(() => shapeOf(cfg({ sizeBytes: 64, lineBytes: 64, ways: 2 })), /too few/);
});

test('a separate cache in real Python gets the same counts on every loop and shape', () => {
  const cases: { p: Pattern; side: number; passes: number; cfg: CacheConfig; addrs: number[]; want: number[] }[] = [];
  for (const p of ['rows', 'cols', 'walk-order', 'walk-scattered', 'two-arrays'] as Pattern[]) {
    for (const [sizeBytes, lineBytes, ways] of [[1024, 16, 1], [1024, 64, 2], [4096, 32, 4], [4096, 64, 8], [4096, 64, 64], [32768, 64, 8]]) {
      for (const policy of ['lru', 'fifo'] as const) {
        for (const prefetch of [false, true]) {
          const c = { sizeBytes, lineBytes, ways, policy, prefetch };
          const addrs = [...accesses(p, 32, 2, c)];
          const r = simulateCache(addrs, c);
          cases.push({ p, side: 32, passes: 2, cfg: c, addrs, want: [r.accesses, r.hits, r.misses, r.cold, r.capacity, r.conflict, r.prefetches] });
        }
      }
    }
  }
  const out = python(`
import json, sys
from collections import OrderedDict, deque
for job in json.load(sys.stdin):
    c = job["cfg"]
    line_bytes, ways = c["lineBytes"], c["ways"]
    lines = c["sizeBytes"] // line_bytes
    sets = lines // ways
    # Each set an OrderedDict, oldest first, instead of the TypeScript's arrays.
    table = [OrderedDict() for _ in range(sets)]
    shadow = OrderedDict()
    seen = set()
    hits = cold = capacity = conflict = prefetches = 0
    def bring_in(line):
        s = table[line % sets]
        if len(s) == ways:
            s.popitem(last=False)
        s[line] = True
    def touch_shadow(line):
        had = line in shadow
        if had:
            if c["policy"] == "lru":
                shadow.move_to_end(line)
        else:
            if len(shadow) == lines:
                shadow.popitem(last=False)
            shadow[line] = True
        return had
    for a in job["addrs"]:
        line = a // line_bytes
        s = table[line % sets]
        had_shadow = touch_shadow(line)
        if line in s:
            hits += 1
            if c["policy"] == "lru":
                s.move_to_end(line)
            continue
        if line not in seen:
            cold += 1
        elif had_shadow:
            conflict += 1
        else:
            capacity += 1
        seen.add(line)
        bring_in(line)
        if c["prefetch"]:
            n = line + 1
            if n not in table[n % sets]:
                prefetches += 1
                bring_in(n)
                seen.add(n)
                touch_shadow(n)
    total = len(job["addrs"])
    print(total, hits, total - hits, cold, capacity, conflict, prefetches)
`, JSON.stringify(cases));
  const rows = out.trim().split(/\r?\n/).map((l) => l.split(' ').map(Number));
  assert.equal(rows.length, cases.length);
  assert.equal(cases.length, 5 * 6 * 2 * 2);
  rows.forEach((row, i) => assert.deepEqual(row, cases[i].want, `${cases[i].p} ${JSON.stringify(cases[i].cfg)}`));
});

test('every loop reads the same number of elements, so only the order differs', () => {
  for (const p of ['rows', 'cols', 'walk-order', 'walk-scattered', 'two-arrays'] as Pattern[]) {
    assert.equal([...accesses(p, 32, 1, DEFAULT_CONFIG)].length, 32 * 32, p);
  }
  const both = new Set([...accesses('rows', 32, 1, DEFAULT_CONFIG)]);
  assert.equal(both.size, 32 * 32);
  assert.deepEqual(new Set([...accesses('cols', 32, 1, DEFAULT_CONFIG)]), both, 'and they read the very same addresses');
  assert.equal(ELEMENT_BYTES, 4);
  assert.deepEqual([HIT_NS, MISS_PENALTY_NS], [0.5, 100]);
});

test('the fitting step can\'t be ticked by shrinking the matrix, and a fair try gets a reason', () => {
  const s: CacheState = CACHE_MISSION.setup();
  const step = CACHE_MISSION.steps[1];
  // "Change only the cache": a side of 32 in the default cache ticked this, with nothing changed.
  s.runs.push(runPattern('cols', 32, 2, cfg()));
  assert.equal(step.done(s), false, 'a smaller matrix isn\'t a change to the cache');
  assert.match(step.why!(s), /already fits/);
  // One pass with a big enough cache stayed unticked in silence.
  const quiet: CacheState = CACHE_MISSION.setup();
  quiet.runs.push(runPattern('cols', 256, 2, cfg()));
  quiet.runs.push(runPattern('cols', 256, 1, cfg({ sizeBytes: 256 * 1024 })));
  assert.equal(step.done(quiet), false);
  assert.match(step.why!(quiet), /One pass can hide/);
  // And it's a fair rule: one pass really does hide them. 512 lines of fully associative cache hold
  // a column's worth, so a first read shows nothing, and only the second shows the matrix doesn't fit.
  const hidden = cfg({ ways: fullWays(DEFAULT_CONFIG) });
  assert.equal(runPattern('cols', 256, 1, hidden).result.capacity, 0);
  assert.ok(runPattern('cols', 256, 2, hidden).result.capacity > 0);
  quiet.runs.push(runPattern('cols', 256, 2, cfg({ sizeBytes: 256 * 1024 })));
  assert.equal(step.done(quiet), true);
  assert.equal(step.why!(quiet), '');
  // A differently shaped right answer passes: any cache that really holds it, at any size that didn't fit.
  const other: CacheState = CACHE_MISSION.setup();
  other.runs.push(runPattern('cols', 128, 2, cfg()));
  assert.equal(step.done(other), false);
  other.runs.push(runPattern('cols', 128, 3, cfg({ sizeBytes: 1024 * 1024, ways: 4 })));
  assert.equal(step.done(other), true);
});

test('the "two arrays" loop is flagged where they overlap: at the default side they aren\'t two arrays', () => {
  // Side 256 and 32 KB: each array is 128 KB and they start 32 KB apart, so cold is 160 KB of lines, not 256 KB.
  assert.equal(arraysOverlap(256, 32 * 1024), true);
  assert.equal(runPattern('two-arrays', 256, 2, cfg()).result.cold, (160 * 1024) / 64);
  assert.equal(arraysOverlap(64, 32 * 1024), false, 'the size the mission\'s hint uses');
  assert.equal(arraysOverlap(256, 128 * 1024), false, 'exactly end to end isn\'t an overlap');
  assert.equal(runPattern('two-arrays', 64, 2, cfg()).result.cold, (16 * 1024) / 64);
});

test('the mission plays start to finish, no tick is lost, and looking at one loop isn\'t enough', () => {
  const s: CacheState = CACHE_MISSION.setup();
  const ticks = () => { let n = 0; for (const st of CACHE_MISSION.steps) { if (!st.done(s)) break; n++; } return n; };
  assert.equal(ticks(), 0);
  s.runs.push(runPattern('rows', 256, 2, cfg()));
  assert.equal(ticks(), 0);
  s.runs.push(runPattern('cols', 128, 2, cfg()));
  assert.equal(ticks(), 0, 'a different size isn\'t the same reads');
  s.runs.push(runPattern('cols', 256, 2, cfg()));
  assert.equal(ticks(), 1);
  s.runs.push(runPattern('cols', 256, 2, cfg({ sizeBytes: 64 * 1024 })));
  assert.equal(ticks(), 1, 'still too small');
  s.runs.push(runPattern('cols', 256, 2, cfg({ sizeBytes: 256 * 1024 })));
  assert.equal(ticks(), 2);
  s.runs.push(runPattern('two-arrays', 64, 2, cfg({ ways: 1 })));
  assert.equal(ticks(), 2);
  s.runs.push(runPattern('two-arrays', 64, 2, cfg({ ways: 2 })));
  assert.equal(ticks(), 3);
  s.runs.push(runPattern('walk-order', 256, 1, cfg()));
  s.runs.push(runPattern('walk-order', 256, 1, cfg({ prefetch: true })));
  assert.equal(ticks(), 3, 'the mission asks for both walks');
  s.runs.push(runPattern('walk-scattered', 256, 1, cfg()));
  s.runs.push(runPattern('walk-scattered', 256, 1, cfg({ prefetch: true })));
  assert.equal(ticks(), 4);
});

// ---- the learner's own simulator, through the same engine as the code lab -------------

const m = COMPUTER_MISSIONS['computer-cache-sim'];
type CodeRun = ReturnType<typeof summarise>;
const runIn = (src: string): CodeRun => { const p = new PyProgram(src); p.run(); return summarise(p, src); };
const ticksFor = (...srcs: string[]) => {
  const s = { runs: [] as CodeRun[], growth: [] };
  const seen: number[] = [];
  for (const src of srcs) {
    s.runs.push(runIn(src));
    let n = 0;
    for (const st of m.steps) { if (!st.done(s as never)) break; n++; }
    seen.push(n);
  }
  return seen;
};
const DIRECT = `def count_misses(addresses, lines, line_size):
    cache = [None] * lines
    misses = 0
    for address in addresses:
        line = address // line_size
        slot = line % lines
        if cache[slot] != line:
            misses += 1
            cache[slot] = line
    return misses

print(count_misses([0, 4, 8, 64, 0], 4, 64))
`;
const LRU = `def count_misses_lru(addresses, lines, line_size):
    cache = []
    misses = 0
    for address in addresses:
        line = address // line_size
        if line in cache:
            cache.remove(line)
        else:
            misses += 1
            if len(cache) == lines:
                cache.pop(0)
        cache.append(line)
    return misses
`;

test('the mission\'s wanted answers come from a separate reference in real Python', () => {
  const out = python(`
import json, sys
from collections import OrderedDict
def direct(addrs, lines, size):
    slots = {}
    n = 0
    for a in addrs:
        l = a // size
        if slots.get(l % lines) != l:
            n += 1
            slots[l % lines] = l
    return n
def lru(addrs, lines, size):
    d = OrderedDict()
    n = 0
    for a in addrs:
        l = a // size
        if l in d:
            d.move_to_end(l)
        else:
            n += 1
            if len(d) == lines:
                d.popitem(last=False)
            d[l] = True
    return n
job = json.load(sys.stdin)
print(json.dumps([[direct(*c) for c in job["direct"]], [lru(*c) for c in job["lru"]]]))
`, JSON.stringify({ direct: DIRECT_CASES.map((c) => c.args), lru: LRU_CASES.map((c) => c.args) }));
  const [d, l] = JSON.parse(out) as number[][];
  assert.deepEqual(d.map(String), DIRECT_CASES.map((c) => c.want));
  assert.deepEqual(l.map(String), LRU_CASES.map((c) => c.want));
});

test('the Python mission plays start to finish, in the code lab\'s own engine', () => {
  const starter = runIn(m.starter!);
  assert.equal(starter.status, 'done');
  assert.deepEqual(ticksFor(m.starter!, DIRECT, `${DIRECT}\n${LRU}`), [0, 1, 2]);
  const r = runIn(DIRECT);
  assert.match(r.stdout, /^2\n$/);
});

test('the debrief\'s claim runs in the learner\'s own functions: LRU misses all 15, and direct-mapped misses 9', () => {
  // "The difference between your two functions is the definition of a conflict miss" read as if LRU never lost.
  const r = runIn(`${DIRECT}\n${LRU}\nloop = [0, 64, 128, 192, 256] * 3\nprint(count_misses(loop, 4, 64), count_misses_lru(loop, 4, 64))\n`);
  assert.equal(r.status, 'done');
  assert.match(r.stdout, /9 15\n$/);
  assert.match(m.debrief, /LRU misses all 15 reads, and direct-mapped misses 9/);
});

test('the Python mission\'s shortcuts fail: distinct lines, every read, and LRU that\'s really direct-mapped', () => {
  const distinct = `def count_misses(addresses, lines, line_size):\n    seen = set()\n    for a in addresses:\n        seen.add(a // line_size)\n    return len(seen)\n`;
  const everyRead = `def count_misses(addresses, lines, line_size):\n    return len(addresses)\n`;
  // They have to fail for being wrong. One that doesn't run at all would pass this test for the wrong reason, as a generator expression here once did: this engine refuses those.
  for (const src of [distinct, everyRead]) assert.equal(runIn(src).status, 'done', src);
  assert.deepEqual(ticksFor(distinct), [0]);
  assert.deepEqual(ticksFor(everyRead), [0]);
  const notLru = `${DIRECT}\ndef count_misses_lru(addresses, lines, line_size):\n    return count_misses(addresses, lines, line_size)\n`;
  assert.deepEqual(ticksFor(notLru), [1]);
  const fifo = `${DIRECT}\n${LRU.replace('            cache.remove(line)\n', '            continue\n')}`;
  assert.deepEqual(ticksFor(fifo), [1], 'oldest-in isn\'t least-recently-used');
  const differently = `def count_misses(addresses, lines, line_size):\n    where = {}\n    total = 0\n    for a in addresses:\n        l = a // line_size\n        if where.get(l % lines) != l:\n            where[l % lines] = l\n            total = total + 1\n    return total\n\ndef count_misses_lru(addresses, lines, line_size):\n    used = {}\n    clock = 0\n    total = 0\n    for a in addresses:\n        l = a // line_size\n        clock += 1\n        if l not in used:\n            total += 1\n            if len(used) == lines:\n                oldest = min(used, key=lambda k: used[k])\n                del used[oldest]\n        used[l] = clock\n    return total\n`;
  assert.deepEqual(ticksFor(differently), [2], 'a dictionary and a clock is a right answer too');
});
