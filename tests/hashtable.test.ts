// The strongest test in the trail. The Flood Lab's model has to reproduce CPython's
// __eq__ count exactly, for keys with a fixed __hash__, at every size tried. There
// is no timing in this file: the counts are exact and deterministic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eqCount, resizePoints, djbx33a, craftedKeys, ordinaryKeys, pythonStrHash, DictModel, FloodLab, FLOOD_MISSION, flooded, calm, walked, walkKeys, RANGE_LIMIT, lhBucket, lhTable, intHash, MERSENNE_61, PARAM_CAP, type LabConfig } from '../src/lib/cs/hashtable.ts';
import { python, runPython } from './helpers/python.ts';

python();

const K = `import sys
class K:
    eqc = 0
    h = 0
    __slots__ = ("v",)
    def __init__(self, v): self.v = v
    def __hash__(self): return K.h
    def __eq__(self, o):
        K.eqc += 1
        return self.v == o.v
def real(n, H):
    K.h = H
    K.eqc = 0
    d = {}
    for i in range(n):
        d[K(i)] = 1
    return K.eqc
`;

test('the model reproduces CPython __eq__ counts exactly, for every hash at every size', () => {
  const hashes = [42n, 0n, 7n, 12345n, 2n ** 40n + 3n, 2n ** 61n - 2n];
  const sizes = [1, 5, 6, 10, 11, 22, 43, 100, 1000, 4000];
  const src = `${K}
for H in [${hashes.join(',')}]:
    print(",".join(str(real(n, H)) for n in [${sizes.join(',')}]))
`;
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, hashes.length, 'real Python printed every row');
  hashes.forEach((h, i) => {
    const real = lines[i].split(',').map(Number);
    sizes.forEach((n, j) => assert.equal(eqCount(n, h), real[j], `hash ${h}, n=${n}`));
  });
});

// A table full of equal numbers can pass by accident, so pin the anchors too.
test('anchors: 1,000 colliding keys with hash 42 cost 500,300, not the textbook 499,500', () => {
  const textbook = 1000 * 999 / 2;
  assert.equal(textbook, 499_500);
  assert.equal(eqCount(1000, 42), 500_300);
  assert.equal(eqCount(1000, 0), 499_500);
  assert.equal(eqCount(1000, 7), 499_500);
  assert.equal(eqCount(1000, 12345), 500_719);
  assert.equal(eqCount(1000, 2n ** 40n + 3n), 505_835);
  const r = runPython(`${K}\nprint(real(1000, 42), real(1000, 0))\n`);
  assert.equal(r.stdout.trim(), '500300 499500');
});

test('negative hashes probe as unsigned, as CPython does', () => {
  const hs = [-5n, -2n, -(2n ** 40n)];
  const r = runPython(`${K}\nprint([real(500, H) for H in [${hs.join(',')}]])\n`);
  assert.equal(r.stdout.trim(), `[${hs.map((h) => eqCount(500, h)).join(', ')}]`);
});

test('keys with distinct hashes make no __eq__ calls, in the model and in CPython', () => {
  const src = `class D:
    n = 0
    def __init__(self, v): self.v = v
    def __hash__(self): return self.v
    def __eq__(self, o):
        D.n += 1
        return self.v == o.v
for size in [1000, 4000]:
    d = {}
    for i in range(size):
        d[D(i)] = 1
    print(D.n)
`;
  assert.equal(runPython(src).stdout.trim(), '0\n0');
  assert.equal(new FloodLab().send({ traffic: 'ordinary', defence: 'none', cap: false, intsAsStr: false, pairs: 10 }).textbook, 523_776);
});

test('the table grows at the insertions CPython grows at, for int and for str keys', () => {
  const src = `import sys
def points(keys):
    out, last = [], sys.getsizeof({})
    d = {}
    for i, k in enumerate(keys):
        d[k] = 1
        s = sys.getsizeof(d)
        if s != last:
            out.append(i + 1)
            last = s
    return out
print(points(range(200000)))
print(points([str(i) for i in range(200000)]))
`;
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  const [ints, strs] = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as number[]);
  const model = resizePoints(200_000);
  assert.deepEqual(model.slice(0, 7), [1, 6, 11, 22, 43, 86, 171]);
  assert.deepEqual(model, ints);
  assert.deepEqual(model, strs);
});

test('DJBX33A: Ez and FY collide, from any start value', () => {
  assert.equal(djbx33a('Ez'), 5862308);
  assert.equal(djbx33a('FY'), 5862308);
  for (const start of [0, 1, 5381, 0x7fffffff, 0xffffffff, 123456]) {
    assert.equal(djbx33a('Ez', start), djbx33a('FY', start), `start ${start}`);
    assert.equal(djbx33a('EzEz', start), djbx33a('FYFY', start));
    assert.equal(djbx33a('EzFY', start), djbx33a('FYEz', start));
  }
  // A check that passes because every string hashes alike is no check.
  assert.notEqual(djbx33a('Ea'), djbx33a('FY'));
});

test('sixteen pairs make 65,536 keys, one hash, about 2.3 MB of form body: the slide\'s "roughly 2 MB"', () => {
  const keys = craftedKeys(16);
  assert.equal(new Set(keys).size, 65_536);
  assert.equal(new Set(keys.map((k) => djbx33a(k))).size, 1);
  const bytes = keys.reduce((t, k) => t + k.length + 3, 0);
  assert.ok(bytes > 2_000_000 && bytes < 2_400_000, String(bytes));
});

test('SipHash-1-3 matches real hash() under PYTHONHASHSEED=0, the only way to compare without a secret', () => {
  const words = ['curious', 'a', 'ab', 'abcdefg', 'abcdefgh', 'abcdefghi', 'Ez', 'FY', 'EzEzEzEz', 'hello world, this is longer than one block'];
  const src = `import sys
print(sys.hash_info.algorithm)
for w in ${JSON.stringify(words)}:
    print(hash(w))
print(hash(""))
`;
  const r = runPython(src, { PYTHONHASHSEED: '0' });
  assert.equal(r.status, 0, r.stderr);
  const [alg, ...rest] = r.stdout.trim().split('\n');
  assert.equal(alg, 'siphash13');
  words.forEach((w, i) => assert.equal(pythonStrHash(w).toString(), rest[i], w));
  assert.equal(pythonStrHash(''), 0n);
  // The report's anchor value, read from a real run with this seed.
  assert.equal(pythonStrHash('curious').toString(), '-1249554086996642200');
});

test('real Python hashes multiples of 2^61-1 to 0, and the model agrees', () => {
  const r = runPython('P = 2**61 - 1\nprint([hash(k * P) for k in range(1, 9)], hash(P + 5), hash(-1))');
  assert.equal(r.stdout.trim(), '[0, 0, 0, 0, 0, 0, 0, 0] 5 -2');
  for (let k = 1n; k < 9n; k++) assert.equal(intHash(k * MERSENNE_61), 0n);
  // The flood the lab charges for ints is the model's count for hash 0.
  assert.equal(new FloodLab().send({ traffic: 'ints', defence: 'keyed', cap: false, intsAsStr: false, pairs: 10 }).checks, eqCount(1024, 0));
});

const base: LabConfig = { traffic: 'crafted', defence: 'none', cap: false, intsAsStr: false, pairs: 12 };
const seeded = () => { let x = 0.137; return () => { x = (x * 9301 + 0.49297) % 1; return x; }; };

test('crafted keys flood DJBX33A; ordinary keys of the same size and number do not', () => {
  const lab = new FloodLab(seeded());
  const a = lab.send(base), b = lab.send({ ...base, traffic: 'ordinary' });
  assert.equal(a.sent, 4096);
  assert.equal(a.bytes, b.bytes, 'the two requests must be the same size or the comparison is unfair');
  assert.ok(flooded(a), `${a.checks} of ${a.textbook}`);
  assert.ok(a.checks >= a.textbook, 'probing can only add to the textbook count');
  assert.ok(calm(b), String(b.checks));
  assert.equal(new Set(ordinaryKeys(12)).size, 4096);
});

test('a secret start value changes every hash and fixes nothing', () => {
  const lab = new FloodLab(seeded());
  const r = lab.send({ ...base, defence: 'seeded' });
  assert.notEqual(lab.djbStart, 5381);
  assert.notEqual(djbx33a('Ez', lab.djbStart), djbx33a('Ez'), 'the seed must really change the hash, or this test proves nothing');
  assert.ok(flooded(r));
});

test('a keyed hash stops crafted keys, whatever the key', () => {
  for (let i = 0; i < 3; i++) {
    const r = new FloodLab().send({ ...base, defence: 'keyed' });
    assert.ok(calm(r), String(r.checks));
    assert.equal(r.checks, 0);
  }
});

test('a keyed hash does nothing for integer keys; storing them as strings does', () => {
  const lab = new FloodLab(seeded());
  const ints = lab.send({ ...base, traffic: 'ints', defence: 'keyed' });
  assert.ok(flooded(ints));
  const strs = lab.send({ ...base, traffic: 'ints', defence: 'keyed', intsAsStr: true });
  assert.ok(calm(strs));
});

test('the cap bounds the damage and does not remove it: 1,000 colliding keys still cost about n²/2', () => {
  const r = new FloodLab().send({ ...base, cap: true });
  assert.equal(r.accepted, PARAM_CAP);
  assert.equal(r.textbook, 499_500);
  assert.ok(r.checks >= 499_500 && r.checks < 600_000, String(r.checks));
});

test('tree buckets turn a flood into about n log n', () => {
  const r = new FloodLab().send({ ...base, defence: 'trees' });
  assert.ok(r.checks < r.textbook / 50, String(r.checks));
  assert.ok(r.checks <= r.accepted * Math.log2(r.accepted));
  assert.ok(r.checks > r.accepted, 'a tree still costs something, it is not free');
});

// ---- the attack that makes no equality checks ---------------------------------
//
// An accuracy review found the lesson teaching a range check as a defence, and the
// lab reading "calm" under an attack it couldn't see. 87,380 keys below 2^32 took
// about 6.7 s against 0.016 s for random ones, with zero __eq__ calls.

// Reads CPython's own slot table. CPython keeps no probe count, so where each key
// ended up is the most direct evidence there is that the model walked the same path.
const READ_TABLE = `import ctypes, sys
def table(d):
    assert sys.maxsize == 2**63 - 1, "this reader assumes a 64-bit build"
    keys = ctypes.c_void_p.from_address(id(d) + 32).value
    log2_size = ctypes.c_uint8.from_address(keys + 8).value
    log2_index_bytes = ctypes.c_uint8.from_address(keys + 9).value
    nentries = ctypes.c_ssize_t.from_address(keys + 24).value
    size = 1 << log2_size
    width = {8: ctypes.c_int8, 16: ctypes.c_int16, 32: ctypes.c_int32, 64: ctypes.c_int64}[(8 << log2_index_bytes) // size]
    # A layout change in a future Python should fail here, loudly, not compare garbage.
    assert nentries == len(d), (nentries, len(d))
    return [width.from_address(keys + 32 + i * ctypes.sizeof(width)).value for i in range(size)]
`;

test('walkKeys: every key fits in 32 bits, and real Python gives them all different hashes and makes no __eq__ calls', () => {
  for (const n of [1024, 4096, PARAM_CAP]) {
    const keys = walkKeys(n);
    assert.equal(keys.length, n);
    assert.equal(new Set(keys).size, n, 'distinct');
    assert.ok(keys.every((k) => k >= 0n && k < RANGE_LIMIT), 'all pass a 32-bit range check');
  }
  const r = runPython(`class D:
    checks = 0
    def __init__(self, v): self.v = v
    def __hash__(self): return self.v
    def __eq__(self, o):
        D.checks += 1
        return self.v == o.v
keys = ${JSON.stringify(walkKeys(4096).map(Number))}
print(len(keys), len({hash(k) for k in keys}), max(keys) < 2**32)
d = {}
for k in keys:
    d[D(k)] = 1
print(D.checks)
`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '4096 4096 True\n0');
});

test('the model and real CPython put every crafted key in the same slot, at every size through the growth points', () => {
  const keys = walkKeys(4096);
  const sizes = [1, 5, 6, 11, 22, 43, 86, 171, 342, 682, 683, 1365, 1366, 2730, 2731, 4096];
  const model = sizes.map((n) => { const d = new DictModel(); for (const k of keys.slice(0, n)) d.insert(k); return d.table(); });
  const r = runPython(`${READ_TABLE}
keys = ${JSON.stringify(keys.map(Number))}
for n in ${JSON.stringify(sizes)}:
    d = {}
    for k in keys[:n]:
        d[k] = True
    print(table(d))
`);
  assert.equal(r.status, 0, r.stderr);
  const real = r.stdout.trim().split('\n').map((l) => JSON.parse(l) as number[]);
  assert.equal(real.length, sizes.length);
  sizes.forEach((n, i) => assert.deepEqual(model[i], real[i], `${n} keys`));
  // A table full of -1 would pass by accident.
  assert.equal(real.at(-1)!.filter((x) => x >= 0).length, 4096);
  assert.equal(real.at(-1)!.length, 8192);
});

test('the same holds for ordinary random 32-bit keys, so the agreement above is not special to the attack', () => {
  const keys = Array.from({ length: 4096 }, (_, i) => BigInt((Math.imul(i + 1, 2654435761) >>> 0)));
  const d = new DictModel();
  for (const k of keys) d.insert(k);
  const r = runPython(`${READ_TABLE}
d = {}
for k in ${JSON.stringify(keys.map(Number))}:
    d[k] = True
print(table(d))
`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(d.table(), JSON.parse(r.stdout));
});

test('the walk is quadratic with zero equality checks: four times the keys, about sixteen times the slots', () => {
  const lab = new FloodLab(seeded());
  const small = lab.send({ ...base, traffic: 'walk', pairs: 10 }), large = lab.send({ ...base, traffic: 'walk', pairs: 12 });
  assert.equal(small.checks, 0);
  assert.equal(large.checks, 0);
  assert.equal(small.probes, 151_320);
  assert.equal(large.probes, 2_300_319);
  const ratio = large.probes! / small.probes!;
  assert.ok(ratio > 14 && ratio < 17, String(ratio));
});

test('ordinary keys and random 32-bit keys walk about one slot per key: the margin calm() and walked() rely on', () => {
  const lab = new FloodLab(seeded());
  for (const c of [{ traffic: 'ordinary' }, { traffic: 'ordinary', defence: 'keyed' }, { defence: 'keyed' }] as Partial<LabConfig>[]) {
    const r = lab.send({ ...base, ...c });
    assert.ok(r.probes! < 2 * r.accepted, `${JSON.stringify(c)}: ${r.probes}`);
    assert.ok(calm(r));
  }
  const d = new DictModel();
  for (let i = 0; i < 4096; i++) d.insert(BigInt(Math.imul(i + 1, 2654435761) >>> 0));
  assert.ok(d.probes < 2 * 4096, String(d.probes));
});

test('"calm" can\'t read as safe under this attack: zero equality checks with the walk running is not calm', () => {
  const r = new FloodLab(seeded()).send({ ...base, traffic: 'walk' });
  assert.equal(r.checks, 0, 'this is the number that used to read as calm');
  assert.ok(r.checks <= r.accepted, 'the old test, checks <= accepted, passes');
  assert.equal(calm(r), false);
  assert.ok(walked(r));
  assert.equal(flooded(r), false, 'it is not an equal-hash flood, which is why it needed its own test');
});

test('a range check is not a defence: it refuses multiples of 2^61-1, and lets the walk through untouched', () => {
  const lab = new FloodLab(seeded());
  const huge = lab.send({ ...base, traffic: 'ints', defence: 'keyed', rangeCheck: true });
  assert.equal(huge.accepted, 0);
  assert.equal(huge.outOfRange, 4096);
  assert.equal(huge.checks, 0);
  assert.ok(huge.bytes > 0, 'the request was still sent');
  const through = lab.send({ ...base, traffic: 'walk', rangeCheck: true });
  const without = lab.send({ ...base, traffic: 'walk' });
  assert.equal(through.accepted, 4096);
  assert.equal(through.outOfRange, 0);
  assert.equal(through.probes, without.probes, 'the check changes nothing here');
  assert.ok(walked(through));
});

test('the defences the lesson names really work: strings stop the walk, a limit bounds it and does not stop it', () => {
  const lab = new FloodLab(seeded());
  const strs = lab.send({ ...base, traffic: 'walk', defence: 'keyed', intsAsStr: true });
  assert.ok(calm(strs), String(strs.probes));
  assert.equal(strs.accepted, 4096);
  const capped = lab.send({ ...base, traffic: 'walk', cap: true });
  assert.equal(capped.accepted, PARAM_CAP);
  assert.equal(capped.probes, 137_038, 'an attacker who knows the limit fits the walk to it');
  assert.ok(capped.probes! < lab.send({ ...base, traffic: 'walk' }).probes!);
  assert.ok(walked(capped), 'still walking, at a smaller bill');
  // The lesson's "under 2,000 for ordinary keys".
  const ordinary = lab.send({ ...base, traffic: 'ordinary', cap: true });
  assert.equal(ordinary.accepted, PARAM_CAP);
  assert.ok(ordinary.probes! < 2000, String(ordinary.probes));
});

test('the trees sketch reports "not modelled" for the walk, and that is never calm', () => {
  const r = new FloodLab(seeded()).send({ ...base, traffic: 'walk', defence: 'trees' });
  assert.equal(r.probes, null);
  assert.equal(calm(r), false, 'never looked must not render as checked and clear');
  assert.equal(walked(r), false);
});

test("Cloudflare's three ports all land in bucket 21, and one port fills one bucket", () => {
  for (const p of [53, 16725, 63925]) assert.equal(lhBucket(p), 21);
  const t = lhTable([[53, 16000]]);
  assert.equal(t.length, 32);
  assert.equal(t[21], 16000);
  assert.equal(t.filter((x) => x > 0).length, 1);
});

test('the flood mission completes from its hints, and its shortcuts leave steps open', () => {
  const s = FLOOD_MISSION.setup();
  assert.ok(!FLOOD_MISSION.steps.some((st) => st.done(s)), 'nothing is done before anything is sent');
  const send = (c: Partial<LabConfig>) => s.lab.send({ ...base, ...c });
  const done = (i: number) => FLOOD_MISSION.steps[i].done(s);

  // A small send is too small to call a flood, and a capped one isn't the attack.
  send({ pairs: 4 });
  assert.equal(done(1), false, '16 keys is not a flood');
  send({ cap: true });
  assert.equal(done(1), false, 'a capped request does not show the attack');
  send({ defence: 'keyed' });
  assert.equal(done(4), false, 'crafted traffic does not satisfy the integer step');
  send({ traffic: 'ints', defence: 'none' });
  assert.equal(done(4), false, 'the integer flood only counts once the keyed hash is on');
  send({ traffic: 'ints', defence: 'keyed', cap: true });
  assert.equal(done(5), false, 'capping is not the string fix');

  send({ traffic: 'ordinary' }); assert.ok(done(0));
  send({}); assert.ok(done(1));
  send({ defence: 'seeded' }); assert.ok(done(2));
  send({ defence: 'keyed' }); assert.ok(done(3));
  send({ traffic: 'ints', defence: 'keyed' }); assert.ok(done(4));
  send({ traffic: 'ints', defence: 'keyed', intsAsStr: true }); assert.ok(done(5));
  send({ traffic: 'ints', defence: 'keyed', rangeCheck: true }); assert.ok(done(6));
  send({ traffic: 'walk', defence: 'none' });
  assert.equal(done(7), false, 'the walk only counts once the range check has accepted it');
  send({ traffic: 'walk', defence: 'none', rangeCheck: true, pairs: 4 });
  assert.equal(done(7), false, '16 keys is too few to call a walk');
  send({ traffic: 'walk', defence: 'none', rangeCheck: true }); assert.ok(done(7));
  send({ traffic: 'walk', defence: 'keyed' });
  assert.equal(done(8), false, 'a keyed hash does nothing for integers until they are strings');
  send({ traffic: 'walk', defence: 'keyed', intsAsStr: true }); assert.ok(done(8));
  send({ cap: true }); assert.ok(done(9));
  assert.equal(done(10), false, 'the no-attacker step needs its own panel');
  s.lhSeen = true;
  assert.ok(FLOOD_MISSION.steps.every((st) => st.done(s)));
});

test('the Python the lesson gives learners to run prints what the lesson says', () => {
  const src = `class Key:
    checks = 0
    def __init__(self, value):
        self.value = value
    def __hash__(self):
        return 42
    def __eq__(self, other):
        Key.checks += 1
        return self.value == other.value

d = {}
for i in range(1000):
    d[Key(i)] = i
print(Key.checks)
`;
  assert.equal(runPython(src).stdout.trim(), '500300');
});
