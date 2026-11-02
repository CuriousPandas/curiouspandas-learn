// The bit-level widgets, each held to real Python on inputs built to hit their edges and
// on a seeded fuzz. Nothing here skips when Python is missing: python() throws, because a
// ground-truth test that quietly skips reads as a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BIT_MISSIONS, WIDTHS, add, asCharacter, asTwos, binaryOf, bitAt, bitState, describeAdd, describeWidth, digitsOf, doAdd, doClear, doFlipAll, doNegate, doToggle, doType, doWidth, fit, flipAll, flipBit, grouped, hexOf, maxSigned, maxUnsigned, minSigned, negate, parseWhole, read, wrap, type BitState,
} from '../src/lib/cs/bits.ts';
import {
  FLOAT_MISSION, describeFlip, describeStored, doFlipFloat, doNext, doTypeFloat, exactDecimal, fieldsOf, fieldsOfBits, floatState, fromBits, isExact, nextFloat, parseFloatText, pyHex, toBits, typedDecimal, ulp, type FloatState,
} from '../src/lib/cs/float.ts';
import {
  PICTURE_BYTES, PICTURE_MISSION, PICTURE_WIDTH, REPLACEMENT, TEXT_MISSION, applySettings, codePoints, decode, describeCount, describePicture, doRepair, encode, layout, logRead, paint, pictureState, rawSize, readBack, repair, textState, utf8Of, type Encoding, type PictureState, type TextState,
} from '../src/lib/cs/bytes.ts';
import { python, runPython } from './helpers/python.ts';

python();

function py(src: string): string {
  const r = runPython(src);
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const lines = (src: string) => py(src).trimEnd().split('\n');

/** A small seeded generator, so a failure names an input and reruns the same. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Integers ------------------------------------------------------------------------

test('binary and hex agree with bin, hex and int on every 8-bit value, and on random 32-bit ones', () => {
  const r = rng(7);
  const cases: [number, number][] = [];
  for (let v = 0; v < 256; v++) cases.push([v, 8]);
  for (let v = 0; v < 16; v++) cases.push([v, 4]);
  for (let i = 0; i < 500; i++) { const w = WIDTHS[Math.floor(r() * 4)]; cases.push([Math.floor(r() * 2 ** w), w]); }
  cases.push([0, 32], [2 ** 32 - 1, 32], [2 ** 31, 32], [65535, 16]);
  const got = lines(`import json
for v, w in ${JSON.stringify(cases)}:
    b = bin(v)[2:].zfill(w)
    h = hex(v)[2:].zfill((w + 3) // 4)
    assert int(b, 2) == v and int(h, 16) == v
    print(b, h)
`);
  cases.forEach(([v, w], i) => assert.equal(`${binaryOf(v, w)} ${hexOf(v, w)}`, got[i], `${v} at ${w} bits`));
  assert.equal(grouped(0xa5, 8), '1010 0101');
  assert.equal(grouped(0xa5a5, 16), '1010 0101 1010 0101');
});

test('wrap and the two\'s complement reading agree with ctypes on every width and on values far outside it', () => {
  const r = rng(11);
  const cases: [number, number][] = [];
  for (const w of WIDTHS) {
    for (const v of [0, 1, -1, maxSigned(w), maxSigned(w) + 1, minSigned(w), minSigned(w) - 1, maxUnsigned(w), maxUnsigned(w) + 1, 2 ** w, -(2 ** w)]) cases.push([v, w]);
    for (let i = 0; i < 200; i++) cases.push([Math.floor((r() - 0.5) * 2 ** 40), w]);
  }
  const got = lines(`import ctypes
def wrapped(v, w):
    kinds = {8: (ctypes.c_uint8, ctypes.c_int8), 16: (ctypes.c_uint16, ctypes.c_int16), 32: (ctypes.c_uint32, ctypes.c_int32)}
    if w == 4:
        # ctypes has no 4-bit type. The rule, done by hand on Python's exact ints.
        u = v % 16
        return u, (u - 16 if u >= 8 else u)
    uk, sk = kinds[w]
    return uk(v).value, sk(v).value
for v, w in ${JSON.stringify(cases)}:
    print(*wrapped(v, w))
`);
  cases.forEach(([v, w], i) => {
    const u = wrap(v, w);
    assert.equal(`${u} ${asTwos(u, w)}`, got[i], `${v} at ${w} bits`);
  });
});

test('addition agrees with real wrapped arithmetic, and its flags are right, on every pair at 4 bits and random pairs above', () => {
  const r = rng(13);
  const cases: [number, number, number][] = [];
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) cases.push([a, b, 4]);
  for (let i = 0; i < 1000; i++) { const w = [8, 16, 32][i % 3]; cases.push([Math.floor(r() * 2 ** w), Math.floor(r() * 2 ** w), w]); }
  const got = lines(`
for a, b, w in ${JSON.stringify(cases)}:
    m = 2 ** w
    sa = a - m if a >= m // 2 else a
    sb = b - m if b >= m // 2 else b
    print((a + b) % m, int(a + b >= m), int(not (-(m // 2) <= sa + sb < m // 2)))
`);
  cases.forEach(([a, b, w], i) => {
    const x = add(a, b, w);
    assert.equal(`${x.value} ${Number(x.carryOut)} ${Number(x.signedOverflow)}`, got[i], `${a} + ${b} at ${w}`);
  });
});

test('describeAdd tells a lost answer from a carry that does no harm', () => {
  const say = (a: number, b: number, signed: boolean) => describeAdd(a, b, add(a, b, 8), 8, signed);
  assert.match(say(255, 1, false).text, /256, which needs 9 bits.*read 0/);
  assert.equal(say(255, 1, false).kind, 'bad');
  assert.equal(say(13, 2, false).kind, 'ok');
  // -3 + 5: the carry falls off and the signed answer is right.
  const fine = say(wrap(-3, 8), 5, true);
  assert.equal(fine.kind, 'ok');
  assert.match(fine.text, /-3 \+ 5 = 2\. A carry fell off the top/);
  const over = say(127, 1, true);
  assert.equal(over.kind, 'bad');
  assert.match(over.text, /127 \+ 1 is 128.*reads? -128/);
  assert.match(say(5, wrap(-2, 8), true).text, /5 \+ \(-2\) = 3/);
  // The "- 1" button on an unsigned row once read "5 + 255 is 260": the same bits, and baffling.
  const minus = (a: number) => describeAdd(a, -1, add(a, 255, 8), 8, false);
  assert.deepEqual(minus(5), { kind: 'ok', text: '5 - 1 = 4.' });
  assert.match(minus(0).text, /0 - 1 is -1, and these switches have no negatives\. It wrapped round to 255/);
  assert.equal(minus(0).kind, 'bad');
  assert.equal(say(wrap(-128, 8), wrap(-1, 8), true).kind, 'bad', 'going under the bottom is overflow too');
});

test('negate agrees with -x wrapped by ctypes, and -128 really has no opposite', () => {
  const got = lines(`import ctypes
for v in range(256):
    print(ctypes.c_uint8(-ctypes.c_int8(v).value).value)
`);
  for (let v = 0; v < 256; v++) assert.equal(String(negate(v, 8)), got[v], `-${v}`);
  assert.equal(negate(128, 8), 128);
  assert.equal(asTwos(negate(128, 8), 8), -128);
  assert.equal(negate(0, 8), 0);
  assert.equal(negate(2 ** 31, 32), 2 ** 31);
});

test('the bits flip one at a time, and all at once', () => {
  assert.equal(flipBit(0, 3), 8);
  assert.equal(flipBit(8, 3), 0);
  assert.equal(flipBit(2 ** 31, 31), 0);
  assert.equal(flipBit(0, 31), 2 ** 31);
  assert.equal(flipAll(0, 8), 255);
  assert.equal(flipAll(0xa5, 8), 0x5a);
  assert.equal(bitAt(0b101, 2), 1);
  assert.equal(bitAt(0b101, 1), 0);
  assert.equal(bitAt(2 ** 31, 31), 1, 'no 32-bit signed shift trouble');
});

test('the readings of the same bits, including the two zeros that only the older schemes have', () => {
  const t = (u: number, how: Parameters<typeof read>[2]) => read(u, 8, how).text;
  assert.equal(t(0b10000000, 'unsigned'), '128');
  assert.equal(t(0b10000000, 'twos'), '-128');
  assert.equal(t(0b10000000, 'sign'), '-0');
  assert.equal(t(0b11111111, 'ones'), '-0');
  assert.equal(t(0, 'sign'), '0');
  assert.equal(t(0b11111111, 'twos'), '-1');
  assert.equal(t(0b11111111, 'sign'), '-127');
  assert.equal(t(0b10000001, 'ones'), '-126');
  assert.equal(t(0b00000101, 'ones'), '5');
  // Two ways to write zero in each, one in two's complement, across every 8-bit pattern.
  const zeros = (how: Parameters<typeof read>[2]) => Array.from({ length: 256 }, (_, u) => read(u, 8, how).value).filter((v) => v === 0).length;
  assert.equal(zeros('twos'), 1);
  assert.equal(zeros('sign'), 2);
  assert.equal(zeros('ones'), 2);
});

test('asCharacter agrees with chr and isprintable on all 256 byte values, and says nothing at other widths', () => {
  const got = lines(`
for v in range(256):
    c = chr(v)
    print(ord(c) if c.isprintable() else -1)
`);
  for (let v = 0; v < 256; v++) {
    const c = asCharacter(v, 8);
    assert.equal(c === null ? '-1' : String(c.codePointAt(0)), got[v], `byte ${v}`);
  }
  assert.equal(asCharacter(65, 16), null);
});

test('parseWhole agrees with int(text, 0) on what it accepts, and refuses by name what it does not', () => {
  const good = ['13', '-3', '+7', '0', '0b1101', '0B11', '0xff', '0XA5', '-0x10', ' 42 '];
  for (const t of good) {
    const want = Number(py(`print(int(${JSON.stringify(t)}, 0))`).trim());
    assert.equal(parseWhole(t), want, t);
  }
  for (const t of ['', 'abc', '1.5', '1e3', '0b2', '0xg', '--3', '13 14', '٣']) assert.ok(typeof parseWhole(t) === 'object', t);
  // int('010', 0) raises in Python, and the old-style octal reading must not sneak in here.
  assert.ok(typeof parseWhole('010') === 'object');
  assert.equal(runPython('int("010", 0)').status, 1);
  assert.match((parseWhole('99999999999999999999') as { error: string }).error, /too big/);
});

test('fit refuses what does not fit by name, and never quietly clamps', () => {
  assert.equal(fit(255, 8, false), 255);
  assert.match((fit(256, 8, false) as { error: string }).error, /does not fit in 8 bits/);
  assert.match((fit(-1, 8, false) as { error: string }).error, /does not fit/);
  assert.equal(fit(-1, 8, true), 255);
  assert.equal(fit(255, 8, true), 255, 'the same bits as -1, so a signed lab accepts it');
  assert.equal(fit(-128, 8, true), 128);
  assert.match((fit(-129, 8, true) as { error: string }).error, /-128 to 127/);
});

test('digitsOf agrees with Python\'s own bases where it has them', () => {
  const r = rng(17);
  const nums = [0, 1, 2, 255, 256, 65535, 2 ** 32, 2 ** 53 - 1];
  for (let i = 0; i < 200; i++) nums.push(Math.floor(r() * 2 ** 40));
  const got = lines(`
for n in ${JSON.stringify(nums)}:
    print(bin(n)[2:], oct(n)[2:], hex(n)[2:], n)
`);
  const write = (ds: number[]) => ds.map((d) => d.toString(36)).join('');
  nums.forEach((n, i) => assert.equal(`${write(digitsOf(n, 2))} ${write(digitsOf(n, 8))} ${write(digitsOf(n, 16))} ${write(digitsOf(n, 10))}`, got[i], `${n}`));
  assert.throws(() => digitsOf(-1, 2), /whole number/);
});

// Each step is judged on what happened, so going on to the next step can't untick it.
const bitTicks = (id: string, s: BitState) => { let ok = true; return BIT_MISSIONS[id].steps.map((st) => (ok = ok && st.done(s))); };

test('mission "Eight switches" plays to the end by clicking switches, and by typing', () => {
  const s = bitState(false);
  for (const i of [3, 2, 0]) doToggle(s, i);
  assert.equal(s.value, 13);
  doClear(s);
  for (let i = 0; i < 8; i++) doToggle(s, i);
  assert.deepEqual(bitTicks('comp-bits-switches', s), [true, true, false, false, false]);
  assert.equal((doAdd(s, '1') as { carryOut: boolean }).carryOut, true);
  assert.equal(s.value, 0);
  doClear(s);
  for (const i of [7, 5, 2, 0]) doToggle(s, i);
  assert.equal(hexOf(s.value, 8), 'a5');
  doWidth(s, 16);
  assert.deepEqual(bitTicks('comp-bits-switches', s), [true, true, true, true, false]);
  for (let i = 8; i < 16; i++) doToggle(s, i);
  doClear(s);
  for (let i = 0; i < 16; i++) doToggle(s, i);
  assert.ok(bitTicks('comp-bits-switches', s).every(Boolean));

  const t = bitState(false);
  for (const x of ['13', '0xff']) assert.equal(doType(t, x), null);
  doAdd(t, '1');
  assert.equal(doType(t, '0b10100101'), null);
  doWidth(t, 16);
  assert.equal(doType(t, '65535'), null);
  assert.ok(bitTicks('comp-bits-switches', t).every(Boolean));
});

test('"Eight switches": 255 reached at 16 bits is not the 8-bit limit, and a refused number sets nothing', () => {
  const s = bitState(false);
  doWidth(s, 16);
  assert.equal(doType(s, '255'), null);
  doToggle(s, 0);
  assert.equal(BIT_MISSIONS['comp-bits-switches'].steps[1].done(s), false);
  const t = bitState(false);
  assert.match(doType(t, '256')!, /does not fit/);
  assert.equal(t.value, 0);
  assert.equal(t.events.length, 0);
  assert.match(doType(t, '-1')!, /does not fit/, 'an unsigned lab has no negatives');
});

test('mission "The number with no opposite" plays to the end by more than one route', () => {
  const s = bitState(true);
  assert.equal(doType(s, '-1'), null);
  assert.equal(doType(s, '-3'), null);
  doAdd(s, '5');
  assert.equal(s.value, 2);
  assert.equal(doType(s, '127'), null);
  const over = doAdd(s, '1') as { signedOverflow: boolean; carryOut: boolean };
  assert.equal(over.signedOverflow, true);
  assert.equal(over.carryOut, false);
  assert.equal(doType(s, '-128'), null);
  doNegate(s);
  assert.equal(s.value, 128);
  doWidth(s, 16);
  assert.equal(doType(s, '32767'), null);
  doAdd(s, '1');
  assert.equal(asTwos(s.value, 16), -32768);
  assert.ok(bitTicks('comp-neg-wrap', s).every(Boolean));

  // The same with switches, flip-all and + 1, not typing.
  const t = bitState(true);
  doFlipAll(t);
  assert.equal(asTwos(t.value, 8), -1);
  doClear(t);
  doFlipAll(t);
  doAdd(t, '-2');
  assert.equal(asTwos(t.value, 8), -3);
  doAdd(t, '5');
  doClear(t);
  for (let i = 0; i < 7; i++) doToggle(t, i);
  doAdd(t, '1');
  doNegate(t);
  doWidth(t, 16);
  doClear(t);
  for (let i = 0; i < 15; i++) doToggle(t, i);
  doAdd(t, '1');
  assert.ok(bitTicks('comp-neg-wrap', t).every(Boolean));
});

test('"The number with no opposite": negating anything else, or reaching -128 without negating, does not pass that step', () => {
  const s = bitState(true);
  doType(s, '-128');
  assert.equal(BIT_MISSIONS['comp-neg-wrap'].steps[3].done(s), false);
  doType(s, '5');
  doNegate(s);
  assert.equal(BIT_MISSIONS['comp-neg-wrap'].steps[3].done(s), false);
});

test('changing width keeps the low bits, and says nothing happened only when nothing did', () => {
  const s = bitState(true);
  doType(s, '-1');
  doWidth(s, 4);
  assert.equal(s.value, 15);
  assert.equal(asTwos(s.value, 4), -1);
  const t = bitState(false);
  doType(t, '200');
  doWidth(t, 4);
  assert.equal(t.value, 8, 'high bits really are gone');
  doWidth(t, 8);
  assert.equal(t.value, 8, 'and not coming back');
});

test('-1 widened to 16 bits silently became 255 under "Now 16 bits": the lab now says what happened', () => {
  const s = bitState(true);
  doType(s, '-1');
  doWidth(s, 16);
  assert.equal(s.value, 255, 'the bits you had did not move');
  assert.equal(asTwos(s.value, 16), 255);
  const d = describeWidth(255, 8, s.value, 16, true);
  assert.equal(d.kind, 'warn');
  assert.match(d.text, /^Now 16 bits\. The new top bits are 0, so two's complement changed from -1 to 255/);
  assert.match(d.text, /sign extension/);
  assert.match(describeWidth(128, 8, 128, 16, true).text, /changed from -128 to 128/);
  // Narrowing can do it with no switch changing either: 200 at 16 bits is -56 at 8.
  const n = describeWidth(200, 16, 200, 8, true);
  assert.equal(n.kind, 'warn');
  assert.match(n.text, /changed from 200 to -56/);
  // And it can drop bits and change nothing a signed reader cares about. It must say both.
  const same = describeWidth(65535, 16, 255, 8, true);
  assert.equal(same.kind, '');
  assert.match(same.text, /still reads -1.*65,535 to 255/);
});

test('what the lab says when you type -1 at 16 bits is the sign-extended pattern real Python gives, and the width list really does not sign-extend', () => {
  const got = lines(`import ctypes, struct
print(struct.pack('>h', ctypes.c_int8(-1).value).hex())
print(int.from_bytes(struct.pack('>b', -1), 'big'))
`);
  const s = bitState(true);
  doWidth(s, 16);
  doType(s, '-1');
  assert.equal(hexOf(s.value, 16), got[0], 'ffff');
  const t = bitState(true);
  doType(t, '-1');
  doWidth(t, 16);
  assert.equal(String(t.value), got[1], 'zero-extended: the bits of the byte, read as a bigger number');
});

test('a change of width never leaves the two\'s complement or plain reading changed without saying so, at any pair of widths', () => {
  const r = rng(53);
  for (const from of WIDTHS) {
    const values = from <= 8 ? Array.from({ length: 2 ** from }, (_, i) => i) : [0, 1, maxUnsigned(from), maxSigned(from), maxSigned(from) + 1, ...Array.from({ length: 300 }, () => Math.floor(r() * 2 ** from))];
    for (const to of WIDTHS) {
      if (to === from) continue;
      for (const u of values) {
        const s = bitState(true);
        s.width = from;
        s.value = u;
        doWidth(s, to);
        const was = asTwos(u, from), is = asTwos(s.value, to);
        const signed = describeWidth(u, from, s.value, to, true);
        const where = `${u} from ${from} to ${to}`;
        if (was !== is) {
          assert.equal(signed.kind, 'warn', where);
          assert.ok(signed.text.includes(`from ${was} to ${is}`), `${where}: ${signed.text}`);
        } else assert.ok(signed.text.includes(`reads ${is}`), `${where}: ${signed.text}`);
        const plain = describeWidth(u, from, s.value, to, false);
        if (u !== s.value) { assert.equal(plain.kind, 'warn', where); assert.match(plain.text, /low bits/); } else assert.equal(plain.text, `Now ${to} bits.`, where);
      }
    }
  }
});

test('the signed wrap\'s message said "the adder has no idea anything happened", against the flag the adder lesson describes, and it now tells a wrap from a lost carry', () => {
  const up = describeAdd(127, 1, add(127, 1, 8), 8, true);
  assert.doesNotMatch(up.text, /no idea/);
  assert.match(up.text, /No error is raised\. No carry fell off the top either/);
  const down = describeAdd(128, 255, add(128, 255, 8), 8, true);
  assert.equal(down.kind, 'bad');
  assert.match(down.text, /A carry fell off the top too/);
});

// ---- Floats ---------------------------------------------------------------------------

function floatCases() {
  const r = rng(23);
  const xs = [0, -0, 1, -1, 0.1, 0.2, 0.3, 0.1 + 0.2, 0.5, 0.75, 1.5, 100, 1e16, 1e23, 1e308, 1.7976931348623157e308, 5e-324, 2.2250738585072014e-308, 2.225073858507201e-308, 2 ** 52, 2 ** 53, 2 ** 53 + 2, 1 / 3, -2.5, 3.141592653589793];
  const view = new DataView(new ArrayBuffer(8));
  for (let i = 0; i < 400; i++) {
    view.setUint32(0, Math.floor(r() * 2 ** 32));
    view.setUint32(4, Math.floor(r() * 2 ** 32));
    const x = view.getFloat64(0);
    if (Number.isFinite(x)) xs.push(x);
  }
  for (let i = 0; i < 200; i++) xs.push((r() - 0.5) * 10 ** Math.floor(r() * 40 - 20));
  return xs;
}
// repr-through-hex so no decimal shortest-form logic stands between the two sides.
const hexes = (xs: number[]) => JSON.stringify(xs.map((x) => pyHex(x)));

test('pyHex agrees with float.hex, read back by real Python, across the whole range', () => {
  const xs = floatCases();
  const got = lines(`
import json
for r in ${JSON.stringify(xs.map((x) => (Object.is(x, -0) ? '-0.0' : String(x))))}:
    print(float(r).hex())
`);
  xs.forEach((x, i) => assert.equal(pyHex(x), got[i], `${x}`));
  assert.equal(pyHex(Infinity), 'inf');
  assert.equal(pyHex(-Infinity), '-inf');
  assert.equal(pyHex(NaN), 'nan');
});

test('the 64 bits agree with struct.pack, field by field', () => {
  const xs = floatCases();
  const got = lines(`
import struct
for h in ${hexes(xs)}:
    b = struct.unpack('>Q', struct.pack('>d', float.fromhex(h)))[0]
    print(format(b, '064b'), b >> 63, (b >> 52) & 0x7ff, b & ((1 << 52) - 1))
`);
  xs.forEach((x, i) => {
    const f = fieldsOf(x);
    assert.equal(`${f.bits} ${f.sign} ${f.exponentBits} ${f.fraction}`, got[i], `${x}`);
    assert.ok(Object.is(fromBits(toBits(x)), x), 'round trip');
  });
});

test('exactDecimal is the exact stored value: it agrees with Decimal on every case', () => {
  const xs = floatCases();
  const got = lines(`
from decimal import Decimal
for h in ${hexes(xs)}:
    print(format(Decimal(float.fromhex(h)), 'f'))
`);
  // Decimal keeps a form like "1.0E+16" as digits and a zero exponent as "100", so format 'f' is the shared plain form.
  xs.forEach((x, i) => assert.equal(exactDecimal(x), got[i], `${x}`));
});

test('the numbers the lesson prints', () => {
  assert.equal(exactDecimal(0.1), '0.1000000000000000055511151231257827021181583404541015625');
  assert.equal(exactDecimal(0.3), '0.299999999999999988897769753748434595763683319091796875');
  assert.equal(exactDecimal(0.1 + 0.2), '0.3000000000000000444089209850062616169452667236328125');
  assert.equal(exactDecimal(0.5), '0.5');
  assert.equal(exactDecimal(2 ** 53), '9007199254740992');
  assert.equal(exactDecimal(Number('9007199254740993')), '9007199254740992', 'rounds to even, so it lands below');
  assert.equal(pyHex(0.1), '0x1.999999999999ap-4');
  assert.equal(py('print(0.1 .hex(), (0.1).as_integer_ratio())').trim(), '0x1.999999999999ap-4 (3602879701896397, 36028797018963968)');
});

test('nextFloat and ulp agree with math.nextafter and math.ulp', () => {
  const xs = floatCases();
  const got = lines(`
import math
for h in ${hexes(xs)}:
    x = float.fromhex(h)
    print(math.nextafter(x, math.inf).hex(), math.nextafter(x, -math.inf).hex(), math.ulp(x).hex())
`);
  xs.forEach((x, i) => {
    assert.equal(`${pyHex(nextFloat(x, true))} ${pyHex(nextFloat(x, false))} ${pyHex(ulp(x))}`, got[i], `${x}`);
  });
  assert.equal(nextFloat(1.7976931348623157e308, true), Infinity);
  assert.equal(nextFloat(Infinity, true), Infinity);
  assert.equal(nextFloat(Infinity, false), 1.7976931348623157e308);
  assert.equal(nextFloat(0, true), 5e-324);
  assert.equal(nextFloat(-0, true), 5e-324);
  assert.equal(nextFloat(5e-324, false), 0);
  assert.equal(ulp(2 ** 53), 2);
  assert.equal(ulp(1), 2 ** -52);
  assert.ok(Number.isNaN(nextFloat(NaN, true)));
  assert.equal(ulp(1.7976931348623157e308), 2 ** 971, 'the gap at the top is the gap below it: math.ulp says the same, above');
});

test('parseFloatText agrees with float() on what it accepts and refuses', () => {
  const good = ['0.1', '-0.1', '+5', '5.', '.5', '1e3', '1E3', '1e-3', '1.5e+3', '1_000.5', '1e1_0', '0', '-0', '007', 'inf', '-inf', 'Infinity', 'NaN', '-nan', ' 0.5 ', '1e309', '-1e309', '1e-400', '9007199254740993'];
  const got = lines(`
for t in ${JSON.stringify(good)}:
    print(float(t).hex())
`);
  good.forEach((t, i) => {
    const v = parseFloatText(t);
    assert.ok(typeof v === 'number', t);
    assert.equal(pyHex(v as number).replace('-nan', 'nan'), got[i], t);
  });
  const bad = ['', 'abc', '1.2.3', '1e', 'e5', '0x10', '1__0', '_1', '1_', '1,5', '--1', 'infin', '.', '.e5', '1_.5', '1._5'];
  for (const t of bad) {
    assert.ok(typeof parseFloatText(t) === 'object', `refuses ${t}`);
    assert.notEqual(runPython(`float(${JSON.stringify(t)})`).status, 0, `Python refuses ${t} too`);
  }
  // Real Python reads digits from other writing systems. This lab refuses them by name, the honest way to differ, and doesn't guess.
  assert.equal(py(`print(float("٣"))`).trim(), '3.0');
  assert.ok(typeof parseFloatText('٣') === 'object');
});

test('isExact against Decimal: whether the double really holds the decimal that was typed', () => {
  const texts = ['0.1', '0.5', '0.75', '0.125', '1.1', '3', '100', '0.3', '1e3', '2.5e-1', '1.5', '9007199254740992', '9007199254740993', '1e22', '1e23', '-0.5', '-0', '0', '0.0', '.5', '5.', '007', '1_000', '0.1000000000000000055511151231257827021181583404541015625'];
  const got = lines(`
from decimal import Decimal
for t in ${JSON.stringify(texts)}:
    print(int(Decimal(float(t)) == Decimal(t.replace('_', ''))))
`);
  texts.forEach((t, i) => {
    const v = parseFloatText(t) as number;
    assert.equal(String(Number(isExact(t, v))), got[i], t);
  });
  assert.equal(typedDecimal('1.5e-3'), '0.0015');
  assert.equal(typedDecimal('1e3'), '1000');
  assert.equal(isExact('inf', Infinity), false);
  assert.equal(isExact('1e400', Infinity), false);
});

test('"0e9999" was called "Not exact" although zero is exact: wild exponents, against Decimal', () => {
  const texts = ['0e9999', '-0e9999', '0.000e-5000', '00.0e2001', `1${'0'.repeat(2001)}e-2001`, `0.${'0'.repeat(2000)}1e2001`, `5${'0'.repeat(3000)}e-3001`, '1e-9999', '1e9999', '3e-400', '5e-324', '1e308'];
  const got = lines(`from decimal import Decimal, getcontext
getcontext().prec = 4000
for t in ${JSON.stringify(texts)}:
    print(int(Decimal(float(t)) == Decimal(t)) if float(t) not in (float('inf'), float('-inf')) else 0)
`);
  texts.forEach((t, i) => {
    const v = parseFloatText(t) as number;
    assert.equal(String(Number(isExact(t, v))), got[i], t.slice(0, 20));
  });
  assert.equal(typedDecimal('0e9999'), '0');
  assert.equal(typedDecimal('1e-9999'), null, 'past every double: null can only mean it is not exact');
  assert.equal(typedDecimal('1e99999999999999999999'), null);
  const s = floatState();
  doTypeFloat(s, '0e9999');
  const e = s.events[0];
  assert.ok(e.op === 'type');
  assert.match(describeStored('0e9999', e as Extract<typeof e, { op: 'type' }>, String).text, /^Stored exactly/);
});

test('the lesson once said every row of its table could be typed into the Float Lab, and "0.1 + 0.2" can\'t: what it says to type instead is the same double', () => {
  assert.ok(typeof parseFloatText('0.1 + 0.2') === 'object');
  assert.equal(parseFloatText('0.30000000000000004'), 0.1 + 0.2);
  assert.equal(py('print(repr(0.1 + 0.2))').trim(), '0.30000000000000004');
});

test('flipping bits to infinity through NaN ticked nothing, on the route the lesson describes', () => {
  const step = FLOAT_MISSION.steps[4];
  const s = floatState();
  doTypeFloat(s, '0.1');
  for (let i = 1; i < 12; i++) if (fieldsOfBits(s.bits).bits[i] === '0') doFlipFloat(s, i);
  assert.ok(Number.isNaN(s.value), 'all 1s in the exponent, with a fraction: NaN');
  assert.equal(step.done(s), false, 'not there yet');
  for (let i = 12; i < 64; i++) if (fieldsOfBits(s.bits).bits[i] === '1') doFlipFloat(s, i);
  assert.equal(s.value, Infinity);
  assert.equal(step.done(s), true);
  // Flipping the sign of an infinity already there isn't running out of numbers.
  const t = floatState();
  doTypeFloat(t, 'inf');
  doFlipFloat(t, 0);
  assert.equal(t.value, -Infinity);
  assert.equal(step.done(t), false);
  // And coming back from a typed inf to infinity by way of a finite number does count.
  doFlipFloat(t, 11);
  assert.ok(Number.isFinite(t.value));
  doFlipFloat(t, 11);
  assert.equal(step.done(t), true);
  // Typing the word stays unticked, and the lab says why rather than leaving the step unexplained.
  const u = floatState();
  doTypeFloat(u, 'inf');
  assert.equal(step.done(u), false);
  const e = u.events[0] as Extract<(typeof u.events)[number], { op: 'type' }>;
  assert.match(describeStored('inf', e, String).text, /asks for it by name/);
});

test('a NaN\'s fraction bits are held by the lab: engines may replace any NaN with a standard one, and flips on an iPhone then did nothing under "Flipped bit N"', () => {
  const s = floatState();
  doTypeFloat(s, '0.1');
  for (let i = 1; i < 12; i++) if (fieldsOfBits(s.bits).bits[i] === '0') doFlipFloat(s, i);
  // 0.1's own fraction, kept: this is what WebKit and Firefox wiped to 7ff8000000000000.
  assert.equal(s.bits.toString(16), '7ff999999999999a');
  // Even a value that has really been replaced with the standard NaN leaves the bits alone.
  s.value = NaN;
  doFlipFloat(s, 63);
  assert.equal(s.bits.toString(16), '7ff999999999999b', 'a flip changes exactly the bit it names');
  assert.ok(Number.isNaN(s.value));
  doNext(s, true);
  assert.equal(s.bits.toString(16), '7ff999999999999b', 'NaN has no next number, so nothing moved');
  // Real Python keeps the same bits through struct, so the pattern on screen is a real double's.
  assert.equal(py(`import struct
print(struct.pack('>Q', 0x7ff999999999999b).hex(), struct.unpack('>d', bytes.fromhex('7ff999999999999b'))[0])`).trim(), '7ff999999999999b nan');
  assert.equal(fieldsOfBits(s.bits).kind, 'nan');
  // Typing or moving resets the bits to what the number holds, so they can't go stale.
  doTypeFloat(s, '1');
  assert.equal(s.bits, toBits(1));
  doNext(s, true);
  assert.equal(s.bits, toBits(1 + 2 ** -52));
  assert.equal(fieldsOfBits(s.bits).bits, fieldsOf(1 + 2 ** -52).bits);
});

test('"It is a different number now" was false for NaN and for -0.0', () => {
  assert.match(describeFlip(1, 1, NaN), /NaN now/);
  assert.match(describeFlip(11, 1, Infinity), /infinity now/);
  assert.match(describeFlip(0, 0, -0), /compare as equal/);
  assert.match(describeFlip(0, 1, -1), /different number/);
  assert.equal(py('print(0.0 == -0.0)').trim(), 'True');
});

const floatTicks = (s: FloatState) => { let ok = true; return FLOAT_MISSION.steps.map((st) => (ok = ok && st.done(s))); };

test('mission "What is really stored" plays to the end, ending with every step ticked at once', () => {
  const s = floatState();
  assert.deepEqual(floatTicks(s), [false, false, false, false, false], 'the 0.1 already showing has not been typed');
  assert.equal(doTypeFloat(s, '0.1'), null);
  assert.equal(doTypeFloat(s, '0.75'), null);
  assert.equal(doTypeFloat(s, '9007199254740993'), null);
  assert.equal(s.value, 2 ** 53);
  doNext(s, true);
  assert.equal(s.value, 2 ** 53 + 2);
  assert.equal(doTypeFloat(s, '1e309'), null);
  assert.equal(s.value, Infinity);
  assert.ok(floatTicks(s).every(Boolean));
});

test('"What is really stored": fair both ways', () => {
  const steps = FLOAT_MISSION.steps;
  const after = (...texts: string[]) => { const s = floatState(); for (const t of texts) doTypeFloat(s, t); return s; };
  // A whole number stored exactly is not a fraction, and is not a whole number stored wrongly.
  assert.equal(steps[1].done(after('5')), false);
  assert.equal(steps[2].done(after('5')), false);
  // 1.1 is a fraction but isn't exact.
  assert.equal(steps[1].done(after('1.1')), false);
  // 1e23 is a differently shaped right answer for "a whole number that can't be stored".
  assert.equal(steps[2].done(after('1e23')), true);
  assert.equal(steps[2].done(after('1.1')), false, 'not a whole number');
  // Typing the word inf isn't running out of numbers.
  assert.equal(steps[4].done(after('inf')), false);
  // Flipping bits is another route to infinity: the top of the exponent, all on, fraction clear.
  const s = floatState();
  doTypeFloat(s, '1');
  for (let i = 1; i < 12; i++) if (fieldsOf(s.value).bits[i] === '0') doFlipFloat(s, i);
  for (let i = 12; i < 64; i++) if (fieldsOf(s.value).bits[i] === '1') doFlipFloat(s, i);
  assert.equal(s.value, Infinity);
  assert.equal(steps[4].done(s), true);
  // A small next-up is not a gap.
  const n = floatState();
  doTypeFloat(n, '1');
  doNext(n, true);
  assert.equal(steps[3].done(n), false);
  // Next up from the largest finite number reaches infinity, and is not a gap of a finite size.
  const m = floatState();
  doTypeFloat(m, '1.7976931348623157e308');
  doNext(m, true);
  assert.equal(steps[3].done(m), false);
  assert.equal(steps[4].done(m), true, 'but it did run out');
  // A refused text changes nothing.
  const bad = floatState();
  assert.match(doTypeFloat(bad, 'pizza')!, /not a number/);
  assert.equal(bad.value, 0.1);
  assert.equal(bad.events.length, 0);
});

test('the sandbox Python and this page agree about floats, so a learner can check one against the other', () => {
  assert.equal(py('print(0.1 + 0.2, 1e16 + 1, 2.0 ** 53 + 1)').trim(), '0.30000000000000004 1e+16 9007199254740992.0');
});

// ---- Text ------------------------------------------------------------------------------

function textCases() {
  const r = rng(31);
  const cs: string[] = ['', 'a', 'Café', 'é', '€', '日本語', '😀', 'a😀é', '\u0000', '\u007f', '\u0080', '߿', 'ࠀ', '￿', '\u{10000}', '\u{10ffff}', '�', 'Á', 'Â', 'ÃÃ', '퟿', ''];
  const pick = () => {
    const b = r();
    const cp = b < 0.3 ? Math.floor(r() * 128) : b < 0.6 ? Math.floor(r() * 0x800) : b < 0.9 ? Math.floor(r() * 0x10000) : Math.floor(r() * 0x110000);
    return cp >= 0xd800 && cp <= 0xdfff ? 0x61 : cp;
  };
  for (let i = 0; i < 400; i++) cs.push(String.fromCodePoint(...Array.from({ length: 1 + Math.floor(r() * 6) }, pick)));
  return cs;
}
const asPy = (s: string) => JSON.stringify(codePoints(s));

test('UTF-8 encoding agrees with str.encode on every case, boundaries included', () => {
  const cs = textCases();
  const got = lines(`import json
for cps in json.loads(${JSON.stringify(JSON.stringify(cs.map((s) => codePoints(s))))}):
    print(list(''.join(map(chr, cps)).encode('utf-8')))
`);
  cs.forEach((s, i) => {
    const e = encode(s, 'utf-8');
    assert.ok(e.ok);
    assert.equal(JSON.stringify(e.ok && e.bytes).replace(/,/g, ', '), got[i], asPy(s));
  });
});

test('a surrogate is refused, as real Python refuses it, and not encoded anyway', () => {
  assert.equal(utf8Of(0xd800), null);
  assert.equal(utf8Of(0xdfff), null);
  assert.equal(utf8Of(0xd7ff)!.length, 3);
  assert.equal(utf8Of(0xe000)!.length, 3);
  assert.equal(utf8Of(0x110000), null);
  assert.equal(runPython('chr(0xd800).encode("utf-8")').status, 1);
  const e = encode('a\ud800', 'utf-8');
  assert.ok(!e.ok);
  assert.equal(!e.ok && e.at, 1);
});

test('encoding as Latin-1 and Windows-1252 agrees with Python, refusals included', () => {
  const cs = textCases();
  const got = lines(`import json
def attempt(s, enc):
    try:
        return list(s.encode(enc))
    except UnicodeEncodeError as e:
        return 'at', e.start
for cps in json.loads(${JSON.stringify(JSON.stringify(cs.map((s) => codePoints(s))))}):
    s = ''.join(map(chr, cps))
    print(json.dumps([attempt(s, 'latin-1'), attempt(s, 'cp1252')]))
`);
  cs.forEach((s, i) => {
    const show = (enc: Encoding) => { const e = encode(s, enc); return e.ok ? e.bytes : ['at', e.at]; };
    assert.deepEqual([show('latin-1'), show('cp1252')], JSON.parse(got[i]), asPy(s));
  });
});

function byteCases() {
  const r = rng(41);
  const all: number[][] = [Array.from({ length: 256 }, (_, i) => i)];
  // Every lead byte with short, long, overlong and out-of-range tails.
  for (let b = 0x80; b < 0x100; b++) for (const t of [[], [0x80], [0xa0], [0x90, 0x80], [0xbf, 0xbf, 0xbf], [0x41], [0xc0], [0xbf, 0x41], [0x8f, 0x80, 0x80], [0x9f, 0xbf]]) all.push([b, ...t]);
  // Surrogates, overlongs, and the top of the range, as bytes.
  all.push([0xed, 0xa0, 0x80], [0xed, 0x9f, 0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0x80], [0xe0, 0x9f, 0xbf], [0xf0, 0x80, 0x80, 0x80], [0xf0, 0x8f, 0xbf, 0xbf], [0xf4, 0x90, 0x80, 0x80], [0xf4, 0x8f, 0xbf, 0xbf], [0xf5, 0x80, 0x80, 0x80]);
  for (let i = 0; i < 1500; i++) {
    const biased = r() < 0.7;
    all.push(Array.from({ length: Math.floor(r() * 9) }, () => (biased ? [0x41, 0x80, 0xa0, 0xbf, 0xc2, 0xe0, 0xed, 0xf0, 0xf4, 0xff][Math.floor(r() * 10)] : Math.floor(r() * 256))));
  }
  return all;
}

test('decoding random and hostile bytes agrees with bytes.decode(errors="replace"), in all three encodings', () => {
  const all = byteCases();
  const got = lines(`import json
for b in json.loads(${JSON.stringify(JSON.stringify(all))}):
    b = bytes(b)
    print(json.dumps([[ord(c) for c in b.decode(enc, errors='replace')] for enc in ('utf-8', 'latin-1', 'cp1252')]))
`);
  all.forEach((b, i) => {
    const mine = (['utf-8', 'latin-1', 'cp1252'] as const).map((enc) => codePoints(decode(b, enc).text));
    assert.deepEqual(mine, JSON.parse(got[i]), JSON.stringify(b));
  });
  assert.ok(all.length > 2500, 'really ran the hostile set');
});

test('the mojibake and the repair the lesson shows, against real Python', () => {
  const got = lines(`
s = 'Café'
print(s.encode('utf-8').decode('cp1252'))
print(s.encode('utf-8').decode('cp1252').encode('cp1252').decode('utf-8'))
print(s.encode('utf-8').decode('cp1252').encode('utf-8').decode('cp1252'))
print(list(s.encode('utf-8')))
print('Á'.encode('utf-8').decode('cp1252', errors='replace') == 'Ã\\ufffd')
`);
  const mine = decode((encode('Café', 'utf-8') as { bytes: number[] }).bytes, 'cp1252').text;
  assert.equal(mine, 'CafÃ©');
  assert.equal(mine, got[0]);
  const fixed = repair(mine, 'cp1252');
  assert.ok(fixed.ok);
  assert.equal(fixed.ok && fixed.result, got[1]);
  const twice = decode((encode(mine, 'utf-8') as { bytes: number[] }).bytes, 'cp1252').text;
  assert.equal(twice, got[2]);
  assert.equal(twice, 'CafÃƒÂ©');
  assert.equal(got[3], '[67, 97, 102, 195, 169]');
  assert.equal(got[4], 'True');
});

test('the repair refuses what can\'t be repaired, for the real reason', () => {
  const lost = decode((encode('Á', 'utf-8') as { bytes: number[] }).bytes, 'cp1252');
  assert.equal(lost.text, `Ã${String.fromCodePoint(REPLACEMENT)}`);
  assert.equal(lost.replaced, 1);
  const r = repair(lost.text, 'cp1252');
  assert.ok(!r.ok);
  assert.match(!r.ok ? r.why : '', /replacement character/);
  // Latin-1 never loses a byte, so the same word can be repaired from there.
  const kept = decode((encode('Á', 'utf-8') as { bytes: number[] }).bytes, 'latin-1');
  const ok = repair(kept.text, 'latin-1');
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.result, 'Á');
  // Text that was never mis-decoded isn't made valid by this.
  const nope = repair('é', 'cp1252');
  assert.ok(!nope.ok);
  assert.match(!nope.ok ? nope.why : '', /not valid UTF-8/);
  assert.equal(runPython(`'é'.encode('cp1252').decode('utf-8')`).status, 1, 'Python agrees those bytes are invalid');
});

const textTicks = (s: TextState) => { let ok = true; return TEXT_MISSION.steps.map((st) => (ok = ok && st.done(s))); };
const typed = (s: TextState, text: string, encoding: Encoding) => { s.text = text; s.encoding = encoding; logRead(s); };

test('mission "The bytes were fine" plays to the end, with every step ticked at once', () => {
  const s = textState();
  assert.deepEqual(textTicks(s), [false, false, false, false, false]);
  typed(s, '€', 'utf-8');
  typed(s, 'Café', 'cp1252');
  typed(s, 'Cafe', 'cp1252');
  typed(s, 'Café', 'cp1252');
  assert.deepEqual(doRepair(s), { ok: true, result: 'Café' });
  typed(s, 'Á', 'cp1252');
  assert.equal(doRepair(s)!.ok, false);
  assert.ok(textTicks(s).every(Boolean));
});

test('"The bytes were fine": fair both ways', () => {
  const steps = TEXT_MISSION.steps;
  const s = textState();
  typed(s, 'é', 'utf-8');
  assert.equal(steps[0].done(s), false, 'two bytes is not three');
  typed(s, '😀', 'latin-1');
  assert.equal(steps[0].done(s), true, 'four bytes, read any way, counts');
  // Reading correctly isn't a misreading, even when the text is fine.
  const t = textState();
  typed(t, 'Cafe', 'utf-8');
  assert.equal(steps[2].done(t), false);
  typed(t, 'Cafe', 'latin-1');
  assert.equal(steps[2].done(t), true, 'latin-1 counts as wrong too');
  typed(t, '', 'latin-1');
  // Empty text surviving isn't a finding.
  const u = textState();
  typed(u, '', 'cp1252');
  assert.equal(steps[2].done(u), false);
  // Repairing text that never broke isn't a repair.
  const v = textState();
  typed(v, 'Cafe', 'cp1252');
  doRepair(v);
  assert.equal(steps[3].done(v), false);
});

test('the step that says "as Windows-1252" ticked on Latin-1; a Latin-1 repair is still a real repair, and that step names no encoding', () => {
  const steps = TEXT_MISSION.steps;
  const s = textState();
  typed(s, 'Café', 'latin-1');
  assert.equal(steps[1].done(s), false);
  assert.deepEqual(doRepair(s), { ok: true, result: 'Café' });
  assert.equal(steps[3].done(s), true);
  typed(s, 'Café', 'cp1252');
  assert.equal(steps[1].done(s), true);
});

test('the lab called the UK flag "2 characters": it counts code points, as real Python\'s len does', () => {
  const samples = ['\u{1F1EC}\u{1F1E7}', '\u{1F468}‍\u{1F469}‍\u{1F467}', 'é', 'Café', '€', ''];
  const got = lines(`for cps in ${JSON.stringify(samples.map(codePoints))}:
    s = ''.join(map(chr, cps))
    print(len(s), len(s.encode('utf-8')))
`);
  samples.forEach((t, i) => {
    const [n, b] = got[i].split(' ');
    assert.equal(describeCount(t), `${n} code point${n === '1' ? '' : 's'}, ${b} byte${b === '1' ? '' : 's'} in UTF-8.`);
  });
  assert.equal(describeCount('\u{1F1EC}\u{1F1E7}'), '2 code points, 8 bytes in UTF-8.');
  assert.equal(describeCount('\u{1F468}‍\u{1F469}‍\u{1F467}'), '5 code points, 18 bytes in UTF-8.');
  assert.equal(describeCount('\ud800'), null, 'no bytes to count');
});

test('readBack uses the text as it stands', () => {
  const s = textState();
  s.encoding = 'cp1252';
  assert.equal(readBack(s)!.text, 'CafÃ©');
  s.text = '\ud800';
  assert.equal(readBack(s), null, 'a lone surrogate has no bytes, so there is nothing to read back');
});

test('JavaScript strings count UTF-16 units, which is why the lab has to walk code points and not .length', () => {
  assert.equal('😀'.length, 2);
  assert.equal(codePoints('😀').length, 1);
  assert.equal(py('print(len("😀"), len("😀".encode("utf-16-le")), len("😀".encode("utf-8")))').trim(), '1 4 4');
});

// ---- Pictures --------------------------------------------------------------------------

test('layout agrees with slicing the same bytes in real Python, for every setting', () => {
  const settings: [number, 1 | 3, number][] = [[8, 3, 0], [7, 3, 0], [9, 3, 0], [8, 1, 0], [24, 1, 0], [8, 3, 1], [8, 3, 2], [1, 3, 0], [50, 3, 0]];
  const got = lines(`import json
data = bytes(${JSON.stringify(PICTURE_BYTES)})
for w, c, o in ${JSON.stringify(settings)}:
    d = data[o:]
    n = len(d) // c
    px = [list(d[i * c:i * c + c]) if c == 3 else [d[i], d[i], d[i]] for i in range(n)]
    rows = [px[i:i + w] for i in range(0, n, w)]
    print(json.dumps({'rows': rows, 'left': len(d) - n * c}))
`);
  settings.forEach(([w, c, o], i) => {
    const g = layout(PICTURE_BYTES, w, c, o);
    const want = JSON.parse(got[i]);
    assert.deepEqual(g.rows, want.rows, `w=${w} c=${c} o=${o}`);
    assert.equal(g.leftover, want.left);
  });
});

test('the picture is what the lesson says: 8 by 8, 3 bytes a pixel', () => {
  assert.equal(PICTURE_WIDTH, 8);
  assert.equal(PICTURE_BYTES.length, 192);
  assert.equal(rawSize(8, 8, 3), 192);
  assert.equal(rawSize(3840, 2160, 3), 24_883_200);
  assert.equal(py('print(3840 * 2160 * 3)').trim(), '24883200');
  assert.ok(PICTURE_BYTES.every((b) => Number.isInteger(b) && b >= 0 && b <= 255));
  assert.equal(layout(PICTURE_BYTES, 8, 3, 0).rows.length, 8);
  assert.equal(layout(PICTURE_BYTES, 8, 3, 0).rows[0].length, 8);
  assert.throws(() => layout(PICTURE_BYTES, 0, 3, 0), /width/);
});

const pictureTicks = (s: PictureState) => { let ok = true; return PICTURE_MISSION.steps.map((st) => (ok = ok && st.done(s))); };

test('mission "The same bytes, read wrongly" plays to the end, in any order of its settings', () => {
  const s = pictureState();
  const see = (width: number, channels: 1 | 3, offset: number) => { s.width = width; s.channels = channels; s.offset = offset; s.seen.push({ width, channels, offset }); };
  assert.deepEqual(pictureTicks(s), [false, false, false, false, false]);
  see(7, 3, 0);
  see(7, 1, 0);
  see(7, 3, 1);
  assert.equal(paint(s, 0, 0, [255, 0, 0]), false, 'no painting under a wrong reading');
  assert.deepEqual(s.bytes, PICTURE_BYTES);
  see(8, 3, 0);
  assert.equal(paint(s, 1, 2, [255, 0, 0]), true);
  assert.deepEqual(s.bytes.slice(30, 33), [255, 0, 0], 'row 1, column 2: 3 x (8 + 2)');
  assert.equal(s.bytes.length, 192);
  assert.ok(pictureTicks(s).every(Boolean));
  assert.notEqual(PICTURE_BYTES[30], 255, 'and the shared original was not touched');
});

test('"The same bytes": a skip of three whole bytes is a pixel off, not a slip of colours, and painting green is not painting red', () => {
  const s = pictureState();
  s.seen.push({ width: 8, channels: 3, offset: 3 });
  assert.equal(PICTURE_MISSION.steps[2].done(s), false);
  s.seen.push({ width: 8, channels: 3, offset: 0 });
  paint(s, 0, 0, [0, 255, 0]);
  assert.equal(PICTURE_MISSION.steps[4].done(s), false);
  paint(s, 99, 0, [255, 0, 0]);
  assert.equal(PICTURE_MISSION.steps[4].done(s), false, 'a pixel off the picture paints nothing');
});

test('the status said "The bytes have not changed" right after a paint: each claim about the bytes now belongs to the action, and is true of it', () => {
  const s = pictureState();
  assert.equal(describePicture(s, 'none'), '192 bytes read as 64 pixels, 8 wide and 8 tall.');
  // A setting really changes no byte, at any setting the lab offers.
  for (const width of [1, 7, 8, 9, 24]) for (const channels of [1, 3] as const) for (const offset of [0, 1, 2, 3]) {
    assert.equal(applySettings(s, width, channels, offset), null);
    assert.deepEqual(s.bytes, PICTURE_BYTES);
    assert.match(describePicture(s, 'settings'), /That changed the reading, and not one byte\.$/);
  }
  // A refused width changes nothing at all, and doesn't count as having been seen.
  const seen = s.seen.length, width = s.width;
  assert.match(applySettings(s, 99, 3, 0)!, /whole number from 1 to 24/);
  assert.match(applySettings(s, 7.5, 3, 0)!, /whole number/);
  assert.equal(s.seen.length, seen);
  assert.equal(s.width, width);
  // Under a wrong reading nothing is painted, and it says so.
  applySettings(s, 7, 3, 0);
  assert.equal(paint(s, 0, 0, [255, 0, 0]), false);
  assert.deepEqual(s.bytes, PICTURE_BYTES);
  assert.match(describePicture(s, 'refused'), /Nothing was painted, so not one byte changed\.$/);
  // A paint is compared with what it replaced. Row 1, column 2 is white fur.
  applySettings(s, 8, 3, 0);
  assert.equal(paint(s, 1, 2, [255, 0, 0]), true);
  const text = describePicture(s, 'painted');
  assert.doesNotMatch(text, /have not changed/);
  assert.match(text, /Painting wrote bytes 30, 31 and 32: F5 F5 F5 became FF 00 00\. The other 189 bytes are as they were\.$/);
  const differ = s.bytes.flatMap((b, i) => (b === PICTURE_BYTES[i] ? [] : [i]));
  assert.deepEqual(differ, [30, 31, 32], 'and that is exactly what happened');
  // Painting the same colour again, the comparison is with the last paint and not the original.
  assert.equal(paint(s, 1, 2, [255, 0, 0]), true);
  assert.match(describePicture(s, 'painted'), /already held FF 00 00, so no byte changed\.$/);
  assert.equal(paint(s, 1, 2, [0, 255, 0]), true);
  assert.match(describePicture(s, 'painted'), /FF 00 00 became 00 FF 00/);
  // And a setting after a paint still only claims what that setting did.
  applySettings(s, 7, 3, 0);
  assert.match(describePicture(s, 'settings'), /not one byte/);
  assert.notDeepEqual(s.bytes, PICTURE_BYTES);
});

test('"Put all three settings back" ticked once the width went 7 then 8, before the other two were even broken', () => {
  const steps = PICTURE_MISSION.steps;
  const s = pictureState();
  applySettings(s, 7, 3, 0);
  applySettings(s, 8, 3, 0);
  assert.equal(steps[3].done(s), false, 'only the width was ever wrong');
  applySettings(s, 8, 1, 0);
  applySettings(s, 8, 3, 0);
  assert.equal(steps[3].done(s), false, 'the skip has not been tried');
  applySettings(s, 8, 3, 1);
  assert.equal(steps[3].done(s), false, 'and it is still wrong now');
  applySettings(s, 8, 3, 0);
  assert.equal(steps[3].done(s), true, 'each broken and put back in turn is a right answer');
  assert.equal(paint(s, 0, 0, [255, 0, 0]), true);
  assert.ok(pictureTicks(s).every(Boolean));
  // Breaking something again afterwards doesn't untick it.
  applySettings(s, 7, 3, 0);
  assert.ok(pictureTicks(s).every(Boolean));
});
