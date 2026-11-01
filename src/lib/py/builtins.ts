// The built-in functions and the methods of the built-in types.
//
// Every one of them goes through gate(), which needs its signature, because the failure
// this file used to have was silent: "hello".find("l", 3) dropped the 3 and answered 2,
// where real Python answers 3. So an argument is now used correctly, or refused by name,
// or it's the TypeError real Python gives. tests/py-fuzz.test.ts runs every one of these
// against the real interpreter over a table of arguments, and that is what holds them to it.
//
// A method this sandbox lacks says so by name, because AttributeError alone would tell a
// learner that real Python doesn't have it either.

import type { PyProgram } from './vm.ts';
import { listsort } from './listsort.ts';
import {
  EXCEPTION_ALIASES, EXCEPTION_NAMES, MAX_SEQ, MAX_STR_DIGITS, PyBound, PyBuiltin, PyClass, PyDict, PyFunction, PyInstance, PyIter, PyList, PyRaise, PyRange, PySet, PyTuple, PyView, T,
  binop, chars, compare, dictSet, eq, format, hashKey, hooks, intFloorDiv, intMod, isPrintable, lenHook, makeExc, objectId, raise, repr, setAdd, str, strLen, tname, toFloat, truthy, typeOf, fixed, type Val,
} from './values.ts';

type Kw = Map<string, Val>;
/**
 * What a callable accepts. `names` are the positional parameters real Python also lets you
 * pass by keyword ('' for one it doesn't), and `only` the keyword-only ones. Anything else
 * given by keyword is a TypeError, so no callable can ignore one by forgetting to look.
 */
type Sig = { min: number; max: number; names?: readonly string[]; only?: readonly string[]; anyKw?: boolean };

function wrongCount(qual: string, sig: Sig, n: number): never {
  const short = qual.split('.').at(-1), s = (k: number) => (k === 1 ? '' : 's');
  if (sig.max === 0) return raise('TypeError', `${qual}() takes no arguments (${n} given)`);
  if (sig.min === 1 && sig.max === 1) return raise('TypeError', `${qual}() takes exactly one argument (${n} given)`);
  if (sig.min === sig.max) return raise('TypeError', `${short} expected ${sig.min} argument${s(sig.min)}, got ${n}`);
  if (n < sig.min) return raise('TypeError', `${short} expected at least ${sig.min} argument${s(sig.min)}, got ${n}`);
  return raise('TypeError', `${short} expected at most ${sig.max} argument${s(sig.max)}, got ${n}`);
}

/** Checks a call against its signature and hands back the positional arguments, with any keyword ones moved into their slots. */
function gate(qual: string, sig: Sig, a: Val[], kw: Kw): Val[] {
  if (a.length > sig.max || (a.length < sig.min && !(kw.size && sig.names))) wrongCount(qual, sig, a.length);
  if (!kw.size || sig.anyKw) return a;
  let out = a;
  for (const [k, v] of kw) {
    if (sig.only?.includes(k)) continue;
    const i = k && sig.names ? sig.names.indexOf(k) : -1;
    if (i < 0) {
      if (!sig.names && !sig.only) raise('TypeError', `${qual}() takes no keyword arguments`);
      raise('TypeError', `${qual}() got an unexpected keyword argument '${k}'`);
    }
    if (i < a.length) raise('TypeError', `argument for ${qual}() given by name ('${k}') and position (${i + 1})`);
    if (out === a) out = [...a];
    out[i] = v;
  }
  for (let i = 0; i < sig.min; i++) if (out[i] === undefined) raise('TypeError', `${qual}() missing required argument '${sig.names?.[i]}' (pos ${i + 1})`);
  return out;
}

const INT64 = 2n ** 63n;

/** An int, a bool, or anything with __index__: what Python accepts wherever it wants a whole number. */
export function index(v: Val): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  if (v instanceof PyInstance) {
    const r = hooks.dunder(v, '__index__', []);
    if (r !== undefined) {
      if (typeof r === 'bigint') return r;
      if (typeof r === 'boolean') return r ? 1n : 0n;
      return raise('TypeError', `__index__ returned non-int (type ${tname(r)})`);
    }
  }
  return raise('TypeError', `'${tname(v)}' object cannot be interpreted as an integer`);
}
/** A count or position real Python keeps in a machine word, so a huge one is an OverflowError. */
function ssize(v: Val): number {
  const n = index(v);
  if (n >= INT64 || n < -INT64) raise('OverflowError', 'Python int too large to convert to C ssize_t');
  return Number(n);
}
/** A start or end of a search. Real Python clamps a huge one rather than failing. */
function sliceIndex(v: Val | undefined, allowNone: boolean): number | undefined {
  if (v === undefined || (allowNone && v === null)) return undefined;
  if (typeof v !== 'bigint' && typeof v !== 'boolean' && !(v instanceof PyInstance && v.cls.lookup('__index__') !== undefined)) {
    return raise('TypeError', allowNone ? 'slice indices must be integers or None or have an __index__ method' : 'slice indices must be integers or have an __index__ method');
  }
  return Number(index(v));
}
/** Python's rule for turning a start and end into positions in a sequence of `len`. */
function bounds(len: number, startV: Val | undefined, endV: Val | undefined, allowNone = true): [number, number] {
  let start = sliceIndex(startV, allowNone) ?? 0, end = sliceIndex(endV, allowNone) ?? len;
  if (end > len) end = len;
  else if (end < 0) end = Math.max(0, end + len);
  if (start < 0) start = Math.max(0, start + len);
  return [start, end];
}
const needStr = (v: Val, msg: string): string => (typeof v === 'string' ? v : raise('TypeError', msg));

const ASTRAL = /[\uD800-\uDBFF]/;
/** s[start:end], by code point, as every position a Python string method talks about is. */
const cut = (s: string, start: number, end: number): string => {
  if (start >= end) return '';
  return ASTRAL.test(s) ? Array.from(s).slice(start, end).join('') : s.slice(start, end);
};
/** How many code points come before UTF-16 position `at` of s. find() on "😀a" answered 2 when `a` is at 1. */
const cpAt = (s: string, at: number): number => (ASTRAL.test(s) ? strLen(s.slice(0, at)) : at);

// str.isspace's characters, which aren't JavaScript's \s: \x1c-\x1f and \x85 are whitespace
// in Python and not there, and U+FEFF is the other way round.
const SPACE_CLASS = '\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const IS_SPACE = new RegExp(`^[${SPACE_CLASS}]$`);
const TRIM = new RegExp(`^[${SPACE_CLASS}]+|[${SPACE_CLASS}]+$`, 'g');
const pyTrim = (s: string) => s.replace(TRIM, '');
const NOT_ASCII_DIGIT = /[^\x00-\x7f]/;
const refuseForeignDigits = (s: string, fn: string) => {
  if (NOT_ASCII_DIGIT.test(s) && /\p{Nd}/u.test(s)) raise('SandboxLimit', `real Python's ${fn}() reads digits from other writing systems; this sandbox reads 0 to 9 only`);
};

function parseIntText(text: string, baseIn: number): bigint | undefined {
  refuseForeignDigits(text, 'int');
  let s = pyTrim(text).toLowerCase(), neg = false, base = baseIn;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
  const pre: Record<string, number> = { '0x': 16, '0o': 8, '0b': 2 };
  const prefix = pre[s.slice(0, 2)];
  if (prefix && (base === 0 || base === prefix)) { base = prefix; s = s.slice(2); if (s[0] === '_') s = s.slice(1); }
  else if (base === 0) {
    // With base 0 a leading zero means nothing but zero: int("010", 0) is an error.
    if (/^0[0-9_]*[1-9]/.test(s)) return undefined;
    base = 10;
  }
  if (!/^[0-9a-z]+(_[0-9a-z]+)*$/.test(s)) return undefined;
  s = s.replace(/_/g, '');
  if (!/^(2|4|8|16|32)$/.test(String(base)) && BigInt(s.length) > MAX_STR_DIGITS) raise('ValueError', `Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion: value has ${s.length} digits; use sys.set_int_max_str_digits() to increase the limit`);
  let out = 0n;
  const B = BigInt(base);
  for (const c of s) {
    const d = parseInt(c, 36);
    if (Number.isNaN(d) || d >= base) return undefined;
    out = out * B + BigInt(d);
  }
  return neg ? -out : out;
}

// The rule in Python's docs on hashing numeric types: a float hashes as the exact
// fraction it holds, modulo 2**61 - 1, so 1.0 and 1 agree as == requires. Leaves
// NaN out: its hash depends on the object's identity, and this sandbox's floats have none.
function floatHash(v: number): bigint {
  if (!Number.isFinite(v)) return v > 0 ? 314159n : -314159n;
  const P = (1n << 61n) - 1n, view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, Math.abs(v));
  const bits = view.getBigUint64(0), biased = Number(bits >> 52n);
  const mant = biased === 0 ? bits & ((1n << 52n) - 1n) : (bits & ((1n << 52n) - 1n)) | (1n << 52n);
  // 2**61 is 1 modulo P, so a power of two reduces by taking its exponent modulo 61.
  const e = (biased === 0 ? 1 : biased) - 1075;
  const h = (mant * (1n << BigInt(((e % 61) + 61) % 61))) % P;
  const signed = v < 0 ? -h : h;
  return signed === -1n ? -2n : signed;
}

function makeReversed(vm: PyProgram, v: Val): PyIter {
  // By live index where the original is live: emptying the list mid-loop ends the loop.
  if (v instanceof PyList) { let i = v.items.length - 1; return new PyIter('list_reverseiterator', () => { if (i >= v.items.length) i = -1; return i >= 0 ? v.items[i--] : undefined; }); }
  if (v instanceof PyTuple) { let i = v.items.length - 1; return new PyIter('reversed', () => (i >= 0 ? v.items[i--] : undefined)); }
  if (typeof v === 'string') { const cs = chars(v); let i = cs.length - 1; return new PyIter('reversed', () => (i >= 0 ? cs[i--] : undefined)); }
  if (v instanceof PyRange) return vm.iter(new PyRange(v.start + (v.len - 1n) * v.step, v.start - v.step, -v.step));
  if (v instanceof PyDict) { const es = [...v.map.values()]; let i = es.length - 1; return new PyIter('dict_reversekeyiterator', () => (i >= 0 ? es[i--][0] : undefined)); }
  if (v instanceof PyView) {
    const es = [...v.d.map.values()];
    let i = es.length - 1;
    const kind = v.kind;
    return new PyIter(kind === 'keys' ? 'dict_reversekeyiterator' : kind === 'values' ? 'dict_reversevalueiterator' : 'dict_reverseitemiterator', () => {
      if (i < 0) return undefined;
      const [k, x] = es[i--];
      return kind === 'keys' ? k : kind === 'values' ? x : new PyTuple([k, x]);
    });
  }
  if (v instanceof PyInstance) {
    const r = hooks.dunder(v, '__reversed__', []);
    if (r !== undefined) return vm.iter(r);
    if (v.cls.lookup('__getitem__') !== undefined && v.cls.lookup('__len__') !== undefined) {
      let i = lenHook(v)! - 1n;
      return new PyIter('reversed', () => (i >= 0n ? hooks.dunder(v, '__getitem__', [i--]) : undefined));
    }
  }
  return raise('TypeError', `'${tname(v)}' object is not reversible`);
}

/** dict(), dict.update and |= all read one source the same way. */
function fillDict(vm: PyProgram, d: PyDict, src: Val) {
  if (src instanceof PyDict) { for (const [k, v] of [...src.map.values()]) dictSet(d, k, v); return; }
  if (src instanceof PyInstance && src.cls.lookup('keys') !== undefined) raise('SandboxLimit', 'real Python reads a dict from any object with keys(); this sandbox reads dictionaries and lists of pairs');
  vm.toList(src).forEach((pair, i) => {
    let p: Val[];
    try { p = vm.toList(pair); }
    catch (e) {
      if (e instanceof PyRaise && e.exc.cls === T.TypeError) return raise('TypeError', `cannot convert dictionary update sequence element #${i} to a sequence`);
      throw e;
    }
    if (p.length !== 2) raise('ValueError', `dictionary update sequence element #${i} has length ${p.length}; 2 is required`);
    dictSet(d, p[0], p[1]);
  });
}

const ids = new Map<string, number>();
let nextIdentity = 1000;
/** Values with no JavaScript identity get one per distinct value, so id("ab") != id("cd"). It used to depend only on the length. */
const identity = (v: Val): number => {
  if (v !== null && typeof v === 'object') return v instanceof PyInstance ? v.id : 1_000_000 + objectId(v);
  const key = `${typeof v}:${String(v)}`;
  let i = ids.get(key);
  if (!i) ids.set(key, i = ++nextIdentity);
  return i;
};

export function builtins(vm: PyProgram): Map<string, Val> {
  const env = new Map<string, Val>();
  const def = (name: string, sig: Sig, fn: (a: Val[], kw: Kw) => Val) => env.set(name, new PyBuiltin(name, (a, kw) => fn(gate(name, sig, a, kw), kw)));
  // Per program, not on the shared class: a mission's check builds a second program while
  // the first is still stepping, and list() then charged its steps to the wrong one.
  const ctor = (name: string, sig: Sig, fn: (a: Val[], kw: Kw) => Val) => { vm.ctors.set(T[name], (a, kw) => fn(gate(name, sig, a, kw), kw)); env.set(name, T[name]); };

  ctor('int', { min: 0, max: 2, names: ['', 'base'] }, (a) => {
    const v = a[0], baseV = a[1];
    if (v === undefined) {
      if (baseV !== undefined) return raise('TypeError', 'int() missing string argument');
      return 0n;
    }
    // The base is checked before anything else looks at the value.
    const b = baseV === undefined ? 10n : index(baseV);
    if (b !== 0n && (b < 2n || b > 36n)) return raise('ValueError', 'int() base must be >= 2 and <= 36, or 0');
    if (typeof v === 'string') {
      const r = parseIntText(v, Number(b));
      if (r === undefined) return raise('ValueError', `invalid literal for int() with base ${b}: ${repr(v)}`);
      return r;
    }
    if (baseV !== undefined) return raise('TypeError', "int() can't convert non-string with explicit base");
    if (typeof v === 'bigint') return v;
    if (typeof v === 'boolean') return v ? 1n : 0n;
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return raise('ValueError', 'cannot convert float NaN to integer');
      if (!Number.isFinite(v)) return raise('OverflowError', 'cannot convert float infinity to integer');
      return BigInt(Math.trunc(v));
    }
    if (v instanceof PyInstance) {
      const r = hooks.dunder(v, '__int__', []) ?? hooks.dunder(v, '__index__', []);
      if (r !== undefined) {
        if (typeof r === 'bigint') return r;
        if (typeof r === 'boolean') return r ? 1n : 0n;
        return raise('TypeError', `__int__ returned non-int (type ${tname(r)})`);
      }
    }
    return raise('TypeError', `int() argument must be a string, a bytes-like object or a real number, not '${tname(v)}'`);
  });
  ctor('float', { min: 0, max: 1 }, (a) => {
    if (a.length === 0) return 0;
    const v = a[0];
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return toFloat(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      refuseForeignDigits(v, 'float');
      const t = pyTrim(v).toLowerCase().replace(/(?<=\d)_(?=\d)/g, '');
      if (/^[-+]?(inf|infinity)$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
      if (/^[-+]?nan$/.test(t)) return t[0] === '-' ? -NaN : NaN;
      if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(t)) return Number(t);
      return raise('ValueError', `could not convert string to float: ${repr(v)}`);
    }
    if (v instanceof PyInstance) {
      const r = hooks.dunder(v, '__float__', []);
      if (r !== undefined) { if (typeof r !== 'number') return raise('TypeError', `${v.cls.name}.__float__ returned non-float (type ${tname(r)})`); return r; }
      const n = hooks.dunder(v, '__index__', []);
      if (typeof n === 'bigint' || typeof n === 'boolean') return typeof n === 'boolean' ? (n ? 1 : 0) : toFloat(n);
    }
    return raise('TypeError', `float() argument must be a string or a real number, not '${tname(v)}'`);
  });
  ctor('str', { min: 0, max: 3, names: ['object', 'encoding', 'errors'] }, (a) => {
    // The two-argument form decodes bytes, and this sandbox has none, so it always fails.
    if (a[1] !== undefined || a[2] !== undefined) {
      if (a[1] !== undefined && typeof a[1] !== 'string') return raise('TypeError', `str() argument 'encoding' must be str, not ${tname(a[1])}`);
      if (a[2] !== undefined && typeof a[2] !== 'string') return raise('TypeError', `str() argument 'errors' must be str, not ${tname(a[2])}`);
      if (a[0] === undefined) return '';
      return raise('TypeError', typeof a[0] === 'string' ? 'decoding str is not supported' : `decoding to str: need a bytes-like object, ${tname(a[0])} found`);
    }
    return a[0] === undefined ? '' : str(a[0]);
  });
  ctor('bool', { min: 0, max: 1 }, (a) => (a.length === 0 ? false : truthy(a[0])));
  ctor('list', { min: 0, max: 1 }, (a) => new PyList(a.length ? vm.toList(a[0]) : []));
  ctor('tuple', { min: 0, max: 1 }, (a) => new PyTuple(a.length ? vm.toList(a[0]) : []));
  ctor('dict', { min: 0, max: 1, anyKw: true }, (a, kw) => {
    const d = new PyDict();
    if (a.length) fillDict(vm, d, a[0]);
    for (const [k, v] of kw) dictSet(d, k, v);
    return d;
  });
  ctor('set', { min: 0, max: 1 }, (a) => { const s = new PySet(); if (a.length) for (const x of vm.toList(a[0])) setAdd(s, x); return s; });
  ctor('range', { min: 1, max: 3 }, (a) => {
    const n = a.map(index);
    const r = n.length === 1 ? new PyRange(0n, n[0], 1n) : new PyRange(n[0], n[1], n[2] ?? 1n);
    if (r.step === 0n) raise('ValueError', 'range() arg 3 must not be zero');
    return r;
  });
  env.set('object', T.object);
  ctor('type', { min: 1, max: 3 }, (a) => {
    if (a.length === 3) return raise('SandboxLimit', 'real Python can build a class with type(name, bases, dict); this sandbox does not yet');
    if (a.length !== 1) return raise('TypeError', 'type() takes 1 or 3 arguments');
    return typeOf(a[0]);
  });
  vm.ctors.set(T.NoneType, (a, kw) => { gate('NoneType', { min: 0, max: 0 }, a, kw); return null; });
  for (const n of EXCEPTION_NAMES) env.set(n, T[n]);
  for (const [alias, real] of Object.entries(EXCEPTION_ALIASES)) env.set(alias, T[real]);

  const INF = Number.MAX_SAFE_INTEGER;
  def('print', { min: 0, max: INF, only: ['sep', 'end', 'file', 'flush'] }, (a, kw) => {
    const file = kw.get('file');
    if (file !== undefined && file !== null) raise('SandboxLimit', "real Python's print can write to a file with file=; this sandbox only has the Output box");
    if (kw.has('flush')) truthy(kw.get('flush')!);
    const sep = kw.get('sep') ?? ' ', end = kw.get('end') ?? '\n';
    if (sep !== null && typeof sep !== 'string') raise('TypeError', `sep must be None or a string, not ${tname(sep)}`);
    if (end !== null && typeof end !== 'string') raise('TypeError', `end must be None or a string, not ${tname(end)}`);
    vm.write(a.map(str).join(sep === null ? ' ' : sep as string) + (end === null ? '\n' : end as string));
    return null;
  });
  def('input', { min: 0, max: 1 }, (a) => {
    if (a.length) vm.write(str(a[0]));
    return vm.readLine();
  });
  def('len', { min: 1, max: 1 }, (a) => {
    const v = a[0];
    if (typeof v === 'string') return BigInt(strLen(v));
    if (v instanceof PyList || v instanceof PyTuple) return BigInt(v.items.length);
    if (v instanceof PyDict || v instanceof PySet) return BigInt(v.map.size);
    if (v instanceof PyRange) { const n = v.len; if (n >= INT64) raise('OverflowError', 'Python int too large to convert to C ssize_t'); return n; }
    if (v instanceof PyView) return BigInt(v.d.map.size);
    if (v instanceof PyInstance) { const r = lenHook(v); if (r !== undefined) return r; }
    return raise('TypeError', `object of type '${tname(v)}' has no len()`);
  });
  def('abs', { min: 1, max: 1 }, (a) => {
    const v = a[0];
    if (typeof v === 'bigint') return v < 0n ? -v : v;
    if (typeof v === 'number') return Math.abs(v);
    if (typeof v === 'boolean') return v ? 1n : 0n;
    if (v instanceof PyInstance) { const r = hooks.dunder(v, '__abs__', []); if (r !== undefined) return r; }
    return raise('TypeError', `bad operand type for abs(): '${tname(v)}'`);
  });
  const extreme = (name: 'min' | 'max', op: '<' | '>') => def(name, { min: 1, max: INF, only: ['key', 'default'] }, (a, kw) => {
    const key = kw.get('key') ?? null, dflt = kw.get('default');
    if (a.length > 1 && dflt !== undefined) raise('TypeError', `Cannot specify a default for ${name}() with multiple positional arguments`);
    const items = a.length === 1 ? vm.toList(a[0]) : a;
    if (!items.length) { if (dflt !== undefined) return dflt; return raise('ValueError', `${name}() iterable argument is empty`); }
    let best = items[0], bestK = key === null ? best : vm.callValue(key, [best]);
    for (let i = 1; i < items.length; i++) {
      vm.charge(1);
      const k = key === null ? items[i] : vm.callValue(key, [items[i]]);
      if (compare(op, k, bestK)) { best = items[i]; bestK = k; }
    }
    return best;
  });
  extreme('min', '<'); extreme('max', '>');
  def('sum', { min: 1, max: 2, names: ['', 'start'] }, (a) => {
    let t: Val = a[1] === undefined ? 0n : a[1];
    if (typeof t === 'string') raise('TypeError', "sum() can't sum strings [use ''.join(seq) instead]");
    // Python 3.12 made sum() of floats compensated (Neumaier), so sum([0.1] * 10)
    // is 1.0 there and 0.9999999999999999 on 3.11. Without this the sandbox would
    // teach the old answer. Ints met along the way are added uncompensated, as CPython does.
    let c = 0;
    for (const x of vm.toList(a[0])) {
      vm.charge(1);
      if (typeof t === 'number' && typeof x === 'number') {
        const r: number = t + x;
        c += Math.abs(t) >= Math.abs(x) ? (t - r) + x : (x - r) + t;
        t = r;
      } else if (typeof t === 'number' && (typeof x === 'bigint' || typeof x === 'boolean')) {
        t += toFloat(typeof x === 'boolean' ? (x ? 1n : 0n) : x);
      } else {
        if (typeof t === 'number' && c !== 0 && Number.isFinite(c)) { t += c; c = 0; }
        t = binop('+', t, x);
      }
    }
    if (typeof t === 'number' && c !== 0 && Number.isFinite(c)) t += c;
    return t;
  });
  const sortItems = (items: Val[], kw: Kw) => {
    vm.sortCalls++;
    const key = kw.get('key') ?? null, rev = sortReverse(kw.get('reverse'));
    const out = [...items];
    const keys = key === null ? out : out.map((v) => vm.callValue(key, [v]));
    // CPython's own algorithm, comparing only with <, so a class needs just
    // __lt__ and a counting __lt__ reports the count real Python reports.
    listsort(keys, key === null ? null : out, (x, y) => { vm.charge(1); return compare('<', x, y); }, rev);
    return out;
  };
  def('sorted', { min: 1, max: 1, only: ['key', 'reverse'] }, (a, kw) => new PyList(sortItems(vm.toList(a[0]), kw)));
  vm.sortItems = sortItems;
  ctor('reversed', { min: 1, max: 1 }, (a) => makeReversed(vm, a[0]));
  ctor('enumerate', { min: 1, max: 2, names: ['iterable', 'start'] }, (a) => {
    const it = vm.iter(a[0]);
    let n = index(a[1] === undefined ? 0n : a[1]);
    return new PyIter('enumerate', () => { const v = it.next(); if (v === undefined) return undefined; const r = new PyTuple([n, v]); n += 1n; return r; });
  });
  ctor('zip', { min: 0, max: INF, only: ['strict'] }, (a, kw) => {
    const its = a.map((x) => vm.iter(x)), strict = kw.has('strict') && truthy(kw.get('strict')!);
    return new PyIter('zip', () => {
      if (!its.length) return undefined;
      const row: Val[] = [];
      for (let i = 0; i < its.length; i++) {
        const v = its[i].next();
        if (v === undefined) {
          if (strict) {
            if (i > 0) raise('ValueError', `zip() argument ${i + 1} is shorter than argument${i === 1 ? ' 1' : `s 1-${i}`}`);
            for (let j = 1; j < its.length; j++) if (its[j].next() !== undefined) raise('ValueError', `zip() argument ${j + 1} is longer than argument${j === 1 ? ' 1' : `s 1-${j}`}`);
          }
          return undefined;
        }
        row.push(v);
      }
      return new PyTuple(row);
    });
  });
  // Any number of iterables: map(f, a, b) was a TypeError on correct code.
  vm.ctors.set(T.map, (a, kw) => {
    if (kw.size) raise('TypeError', 'map() takes no keyword arguments');
    if (a.length < 2) raise('TypeError', 'map() must have at least two arguments.');
    const its = a.slice(1).map((x) => vm.iter(x));
    return new PyIter('map', () => {
      const row: Val[] = [];
      for (const it of its) { const v = it.next(); if (v === undefined) return undefined; row.push(v); }
      return vm.callValue(a[0], row);
    });
  });
  env.set('map', T.map);
  ctor('filter', { min: 2, max: 2 }, (a) => {
    const it = vm.iter(a[1]);
    return new PyIter('filter', () => {
      for (let v = it.next(); v !== undefined; v = it.next()) {
        vm.charge(1);
        if (a[0] === null ? truthy(v) : truthy(vm.callValue(a[0], [v]))) return v;
      }
      return undefined;
    });
  });
  def('any', { min: 1, max: 1 }, (a) => { const it = vm.iter(a[0]); for (let v = it.next(); v !== undefined; v = it.next()) { vm.charge(1); if (truthy(v)) return true; } return false; });
  def('all', { min: 1, max: 1 }, (a) => { const it = vm.iter(a[0]); for (let v = it.next(); v !== undefined; v = it.next()) { vm.charge(1); if (!truthy(v)) return false; } return true; });
  const isCallable = (v: Val) => v instanceof PyFunction || v instanceof PyBuiltin || v instanceof PyBound || v instanceof PyClass || (v instanceof PyInstance && v.cls.lookup('__call__') !== undefined);
  def('iter', { min: 1, max: 2 }, (a) => {
    if (a.length === 1) return vm.iter(a[0]);
    if (!isCallable(a[0])) return raise('TypeError', 'iter(v, w): v must be callable');
    return new PyIter('callable_iterator', () => { vm.charge(1); const v = vm.callValue(a[0], []); return eq(v, a[1]) ? undefined : v; });
  });
  def('next', { min: 1, max: 2 }, (a) => {
    const it = a[0];
    if (it instanceof PyInstance) {
      if (it.cls.lookup('__next__') === undefined) return raise('TypeError', `'${tname(it)}' object is not an iterator`);
      try { return hooks.dunder(it, '__next__', [])!; }
      catch (e) { if (a.length === 2 && e instanceof PyRaise && e.exc.cls.isSub(T.StopIteration)) return a[1]; throw e; }
    }
    if (!(it instanceof PyIter)) return raise('TypeError', `'${tname(it)}' object is not an iterator`);
    const v = it.next();
    if (v !== undefined) return v;
    if (a.length === 2) return a[1];
    throw new PyRaise(makeExc(T.StopIteration, []));
  });
  const classCheck = (t: Val, fn: string, test: (c: PyClass) => boolean): boolean => {
    if (t instanceof PyTuple) return t.items.some((x) => classCheck(x, fn, test));
    if (!(t instanceof PyClass)) return raise('TypeError', `${fn}() arg 2 must be a type, a tuple of types, or a union`);
    return test(t);
  };
  def('isinstance', { min: 2, max: 2 }, (a) => classCheck(a[1], 'isinstance', (t) => typeOf(a[0]).isSub(t)));
  def('issubclass', { min: 2, max: 2 }, (a) => {
    const c = a[0];
    if (!(c instanceof PyClass)) return raise('TypeError', 'issubclass() arg 1 must be a class');
    return classCheck(a[1], 'issubclass', (t) => c.isSub(t));
  });
  def('callable', { min: 1, max: 1 }, (a) => isCallable(a[0]));
  const attrName = (v: Val) => needStr(v, `attribute name must be string, not '${tname(v)}'`);
  def('hasattr', { min: 2, max: 2 }, (a) => {
    const name = attrName(a[1]);
    try { vm.getAttr(a[0], name); return true; }
    catch (e) { if (e instanceof PyRaise && e.exc.cls.isSub(T.AttributeError)) return false; throw e; }
  });
  def('getattr', { min: 2, max: 3 }, (a) => {
    const name = attrName(a[1]);
    try { return vm.getAttr(a[0], name); }
    catch (e) { if (a.length === 3 && e instanceof PyRaise && e.exc.cls.isSub(T.AttributeError)) return a[2]; throw e; }
  });
  def('setattr', { min: 3, max: 3 }, (a) => { vm.setAttr(a[0], attrName(a[1]), a[2]); return null; });
  def('ord', { min: 1, max: 1 }, (a) => {
    if (typeof a[0] !== 'string') return raise('TypeError', `ord() expected string of length 1, but ${tname(a[0])} found`);
    if (strLen(a[0]) !== 1) return raise('TypeError', `ord() expected a character, but string of length ${strLen(a[0])} found`);
    return BigInt(a[0].codePointAt(0)!);
  });
  def('chr', { min: 1, max: 1 }, (a) => {
    const big = index(a[0]);
    // Real Python keeps this in a C int, so it overflows before it's out of range.
    if (big >= 2n ** 31n || big < -(2n ** 31n)) return raise('OverflowError', 'Python int too large to convert to C int');
    const n = Number(big);
    if (n < 0 || n > 0x10ffff) return raise('ValueError', 'chr() arg not in range(0x110000)');
    return String.fromCodePoint(n);
  });
  const radix = (name: string, pre: string, base: number) => def(name, { min: 1, max: 1 }, (a) => {
    const n = index(a[0]), abs = n < 0n ? -n : n;
    return (n < 0n ? '-' : '') + pre + abs.toString(base);
  });
  radix('bin', '0b', 2); radix('oct', '0o', 8); radix('hex', '0x', 16);
  def('repr', { min: 1, max: 1 }, (a) => repr(a[0]));
  def('format', { min: 1, max: 2 }, (a) => {
    if (a[1] !== undefined && typeof a[1] !== 'string') return raise('TypeError', `format() argument 2 must be str, not ${tname(a[1])}`);
    return format(a[0], (a[1] as string) ?? '');
  });
  def('id', { min: 1, max: 1 }, (a) => BigInt(identity(a[0])));
  // Real hash() randomises strings per run, so a number shown here would look
  // meaningful and differ on the learner's own machine.
  def('hash', { min: 1, max: 1 }, (a) => {
    hashKey(a[0]);
    if (typeof a[0] === 'bigint') { const m = (1n << 61n) - 1n; const h = a[0] < 0n ? -((-a[0]) % m) : a[0] % m; return h === -1n ? -2n : h; }
    if (typeof a[0] === 'boolean') return a[0] ? 1n : 0n;
    if (typeof a[0] === 'number' && !Number.isNaN(a[0])) return floatHash(a[0]);
    return raise('SandboxLimit', "real Python has hash() on this type, and for strings it changes on every run; write your own hash function here");
  });
  def('round', { min: 1, max: 2, names: ['number', 'ndigits'] }, (a) => {
    const v = a[0], given = a[1] ?? null;
    if (v instanceof PyInstance) {
      const r = hooks.dunder(v, '__round__', a[1] === undefined ? [] : [a[1]]);
      if (r !== undefined) return r;
    }
    if (typeof v !== 'bigint' && typeof v !== 'boolean' && typeof v !== 'number') return raise('TypeError', `type ${tname(v)} doesn't define __round__ method`);
    const nd = given === null ? null : index(given);
    if (typeof v === 'bigint' || typeof v === 'boolean') {
      const x = typeof v === 'boolean' ? (v ? 1n : 0n) : v;
      if (nd === null || nd >= 0n) return x;
      if (-nd > 100_000n) return raise('SandboxLimit', 'this sandbox stops at very large values, to keep your browser tab alive; real Python would carry on until it ran out of memory');
      const p = 10n ** -nd, q = intFloorDiv(x, p), r = intMod(x, p), twice = r * 2n;
      return (twice > p || (twice === p && intMod(q, 2n) === 1n) ? q + 1n : q) * p;
    }
    if (nd === null) {
      if (Number.isNaN(v)) return raise('ValueError', 'cannot convert float NaN to integer');
      if (!Number.isFinite(v)) return raise('OverflowError', 'cannot convert float infinity to integer');
      const f = Math.floor(v), d = v - f;
      const r = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
      return BigInt(r);
    }
    if (!Number.isFinite(v) || v === 0) return v;
    if (nd >= 0n) { const r = Number(fixed(v, nd > 100n ? 100 : Number(nd))); return r === 0 && v < 0 ? -0 : r; }
    // v / 10 ** n in floats is inexact, and a nan came back from round(1.5, -400). This
    // works on the exact whole part: anything after the point only matters to break a tie.
    if (nd < -400n) return v < 0 ? -0 : 0;
    const whole = BigInt(Math.trunc(Math.abs(v))), rest = Math.abs(v) - Math.trunc(Math.abs(v));
    const p = 10n ** -nd, q = whole / p, r = whole % p, twice = r * 2n;
    const up = twice > p || (twice === p && (rest > 0 || q % 2n === 1n));
    const out = Number((up ? q + 1n : q) * p);
    if (!Number.isFinite(out)) return raise('OverflowError', 'rounded value too large to represent');
    return v < 0 ? -out : out;
  });
  def('divmod', { min: 2, max: 2 }, (a) => {
    const [x, y] = a;
    if (x instanceof PyInstance) { const r = hooks.dunder(x, '__divmod__', [y]); if (r !== undefined) return r; }
    if (y instanceof PyInstance) { const r = hooks.dunder(y, '__rdivmod__', [x]); if (r !== undefined) return r; }
    const isNum = (v: Val) => typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean';
    if (!isNum(x) || !isNum(y)) return raise('TypeError', `unsupported operand type(s) for divmod(): '${tname(x)}' and '${tname(y)}'`);
    return new PyTuple([binop('//', x, y), binop('%', x, y)]);
  });
  def('pow', { min: 2, max: 3, names: ['base', 'exp', 'mod'] }, (a) => {
    if (a[2] === undefined || a[2] === null) return binop('**', a[0], a[1]);
    const isInt = (v: Val) => typeof v === 'bigint' || typeof v === 'boolean';
    if (!isInt(a[0]) || !isInt(a[1]) || !isInt(a[2])) return raise('TypeError', 'pow() 3rd argument not allowed unless all arguments are integers');
    let base = index(a[0]), e = index(a[1]);
    const m = index(a[2]);
    if (m === 0n) return raise('ValueError', 'pow() 3rd argument cannot be 0');
    if (e < 0n) {
      // The modular inverse, by the extended Euclid algorithm.
      let [r0, r1, s0, s1] = [intMod(base, m < 0n ? -m : m), m < 0n ? -m : m, 1n, 0n];
      while (r1 !== 0n) { vm.charge(1); const q = r0 / r1; [r0, r1] = [r1, r0 - q * r1]; [s0, s1] = [s1, s0 - q * s1]; }
      if (r0 !== 1n && (m !== 1n && m !== -1n)) return raise('ValueError', 'base is not invertible for the given modulus');
      base = s0;
      e = -e;
    }
    let r = 1n;
    base = intMod(base, m);
    while (e > 0n) { vm.charge(1); if (e & 1n) r = intMod(r * base, m); base = intMod(base * base, m); e >>= 1n; }
    return intMod(r, m);
  });
  env.set('super', new PyBuiltin('super', () => raise('RuntimeError', 'super(): no arguments')));
  return env;
}

// list.sort and sorted test reverse= for truth from 3.12 on; 3.11 demanded an integer. Refusing
// the difference by name would be wrong on both, so this follows 3.12, as the rest of the site does.
const sortReverse = (v: Val | undefined): boolean => (v === undefined ? false : truthy(v));

// ---- Methods. A table each, so a method can't exist without a signature, and str.upper
// as a value (key=str.lower) comes from the same entry as "abc".upper.

type Method = Sig & { fn?: (self: any, a: Val[], kw: Kw, vm: PyProgram) => Val; attr?: (self: any) => Val; onClass?: boolean };
type Table = Record<string, Method>;
const m = (min: number, max: number, fn: Method['fn'], more: Partial<Sig> = {}): Method => ({ min, max, fn, ...more });

/** A fill character: "a".center(5, "xx") and "a".center(5, 1) are both TypeErrors. */
function fillOf(name: string, v: Val | undefined): string {
  if (v === undefined) return ' ';
  if (typeof v !== 'string') return raise('TypeError', `${name}() argument 2 must be a unicode character, not ${tname(v)}`);
  if (strLen(v) !== 1) raise('TypeError', 'The fill character must be exactly one character long');
  return v;
}
/** A target width. The page can't hold a string as long as real Python can, so past that it says so. */
function widthOf(v: Val): number {
  const w = ssize(v);
  if (w > MAX_SEQ) raise('SandboxLimit', 'this sandbox stops at very large values, to keep your browser tab alive; real Python would carry on until it ran out of memory');
  return w;
}

const stripper = (name: 'strip' | 'lstrip' | 'rstrip'): Method => m(0, 1, (s: string, a) => {
  const given = a[0] ?? null;
  if (given !== null && typeof given !== 'string') return raise('TypeError', `${name} arg must be None or str`);
  const set = given === null ? null : new Set(chars(given as string));
  const drop = (c: string) => (set ? set.has(c) : IS_SPACE.test(c));
  const cs = chars(s);
  let i = 0, j = cs.length;
  if (name !== 'rstrip') while (i < j && drop(cs[i])) i++;
  if (name !== 'lstrip') while (j > i && drop(cs[j - 1])) j--;
  return cs.slice(i, j).join('');
});

function splitter(s: string, sepV: Val | undefined, maxV: Val | undefined, fromRight: boolean, vm: PyProgram): Val {
  const sep = sepV ?? null;
  if (sep !== null && typeof sep !== 'string') return raise('TypeError', `must be str or None, not ${tname(sep)}`);
  const max = maxV === undefined ? -1 : ssize(maxV);
  vm.charge(s.length);
  if (sep === '') return raise('ValueError', 'empty separator');
  const limited = max >= 0;
  if (sep !== null) {
    const parts = s.split(sep as string);
    if (!limited || parts.length - 1 <= max) return new PyList(parts);
    if (fromRight) { const keep = parts.length - max; return new PyList([parts.slice(0, keep).join(sep as string), ...parts.slice(keep)]); }
    return new PyList([...parts.slice(0, max), parts.slice(max).join(sep as string)]);
  }
  const out: string[] = [];
  // With a limit, what's left keeps its own spacing: "a b  c ".split(None, 1) ends in "b  c ".
  if (fromRight) {
    let j = s.length;
    while (j > 0) {
      while (j > 0 && IS_SPACE.test(s[j - 1])) j--;
      if (!j) break;
      if (limited && out.length === max) { out.push(s.slice(0, j)); j = 0; break; }
      let i = j;
      while (i > 0 && !IS_SPACE.test(s[i - 1])) i--;
      out.push(s.slice(i, j));
      j = i;
    }
    return new PyList(out.reverse());
  }
  let i = 0;
  while (i < s.length) {
    while (i < s.length && IS_SPACE.test(s[i])) i++;
    if (i >= s.length) break;
    if (limited && out.length === max) { out.push(s.slice(i)); break; }
    let j = i;
    while (j < s.length && !IS_SPACE.test(s[j])) j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return new PyList(out);
}

const finder = (last: boolean, strict: boolean): Method => m(1, 3, (s: string, a, _kw, vm) => {
  const sub = needStr(a[0], `must be str, not ${tname(a[0])}`);
  vm.charge(s.length);
  const [start, end] = bounds(strLen(s), a[1], a[2]);
  let at = -1;
  if (start <= end) {
    const seg = cut(s, start, end), i = last ? seg.lastIndexOf(sub) : seg.indexOf(sub);
    if (i >= 0) at = start + cpAt(seg, i);
  }
  if (at < 0 && strict) raise('ValueError', 'substring not found');
  return BigInt(at);
});

const affix = (name: 'startswith' | 'endswith'): Method => m(1, 3, (s: string, a) => {
  const [start, end] = bounds(strLen(s), a[1], a[2]);
  const one = (p: string) => start <= end && (name === 'startswith' ? cut(s, start, end).startsWith(p) : cut(s, start, end).endsWith(p));
  if (a[0] instanceof PyTuple) {
    for (const p of a[0].items) {
      if (typeof p !== 'string') return raise('TypeError', `tuple for ${name} must only contain str, not ${tname(p)}`);
      if (one(p)) return true;
    }
    return false;
  }
  if (typeof a[0] !== 'string') return raise('TypeError', `${name} first arg must be str or a tuple of str, not ${tname(a[0])}`);
  return one(a[0]);
});

const padder = (name: 'ljust' | 'rjust' | 'center'): Method => m(1, 2, (s: string, a) => {
  const w = widthOf(a[0]), f = fillOf(name, a[1]), pad = Math.max(0, w - strLen(s));
  if (name === 'ljust') return s + f.repeat(pad);
  if (name === 'rjust') return f.repeat(pad) + s;
  const l = Math.floor(pad / 2) + (pad & w & 1);
  return f.repeat(l) + s + f.repeat(pad - l);
});

// Case, by code point. Python keeps one rule for words: a letter straight after a cased
// letter goes lower, and the rest get their title form. The old version treated every
// non-ASCII letter as a gap between words, so "éa".title() gave "éA".
const CASED = /^\p{Cased}$/u;
const TITLE_DIGRAPHS: Record<string, string> = { Ǆ: 'ǅ', ǅ: 'ǅ', ǆ: 'ǅ', Ǉ: 'ǈ', ǈ: 'ǈ', ǉ: 'ǈ', Ǌ: 'ǋ', ǋ: 'ǋ', ǌ: 'ǋ', Ǳ: 'ǲ', ǲ: 'ǲ', ǳ: 'ǲ' };
function titleOf(c: string): string {
  if (TITLE_DIGRAPHS[c]) return TITLE_DIGRAPHS[c];
  // Georgian has capitals, and its title form is the ordinary letter: "ა".title() is unchanged.
  if (/^[ა-ჿ]$/.test(c)) return c;
  // Polytonic Greek with an iota below has title forms of its own, which upper() doesn't give.
  const cp = c.codePointAt(0)!;
  if (cp >= 0x1f80 && cp <= 0x1faf) return String.fromCodePoint(cp | 8);
  if (cp === 0x1fb3 || cp === 0x1fc3 || cp === 0x1ff3) return String.fromCodePoint(cp + 9);
  if (cp === 0x1fbc || cp === 0x1fcc || cp === 0x1ffc) return c;
  const u = c.toUpperCase(), parts = Array.from(u);
  if (parts.length === 1) return u;
  // A letter that upper-cases to several ("ß" to "SS", "ﬁ" to "FI") keeps one capital.
  const first = parts.findIndex((x) => CASED.test(x));
  const rest = parts.slice(first + 1).join('').toLowerCase();
  return parts.slice(0, first + 1).join('') + (cp >= 0x1fb0 && cp <= 0x1fff ? rest.replace(/ι$/, String.fromCharCode(0x345)) : rest);
}

function refuseNumericTable(fn: string): never {
  return raise('SandboxLimit', `real Python's str.${fn}() has its own table for characters like ² and ½; this sandbox has it only for ordinary digits`);
}

function strFormat(template: string, args: Val[], kw: Kw): string {
  let auto = 0, mode = '';
  const pick = (name: string): Val => {
    if (/[.[]/.test(name)) return raise('SandboxLimit', `real Python's str.format can look inside a value with {${name}}; this sandbox does not yet`);
    if (name === '' || /^\d+$/.test(name)) {
      if (name === '') {
        if (mode === 'manual') raise('ValueError', 'cannot switch from manual field specification to automatic field numbering');
        mode = 'auto';
      } else {
        if (mode === 'auto') raise('ValueError', 'cannot switch from automatic field numbering to manual field specification');
        mode = 'manual';
      }
      const i = name === '' ? auto++ : Number(name);
      if (i >= args.length) raise('IndexError', `Replacement index ${i} out of range for positional args tuple`);
      return args[i];
    }
    const v = kw.get(name);
    if (v === undefined) throw new PyRaise(makeExc(T.KeyError, [name]));
    return v;
  };
  const walk = (t: string, depth: number): string => {
    if (depth < 0) raise('ValueError', 'Max string recursion exceeded');
    let out = '', i = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === '}') {
        if (t[i + 1] !== '}') raise('ValueError', "Single '}' encountered in format string");
        out += '}'; i += 2; continue;
      }
      if (c !== '{') { out += c; i++; continue; }
      if (t[i + 1] === '{') { out += '{'; i += 2; continue; }
      if (i + 1 >= t.length) raise('ValueError', "Single '{' encountered in format string");
      let j = i + 1, d = 1;
      for (; j < t.length; j++) {
        if (t[j] === '{') d++;
        else if (t[j] === '}' && --d === 0) break;
      }
      if (d !== 0) raise('ValueError', "expected '}' before end of string");
      const field = t.slice(i + 1, j);
      i = j + 1;
      const stop = field.search(/[!:]/);
      const name = stop < 0 ? field : field.slice(0, stop);
      let rest = stop < 0 ? '' : field.slice(stop), conv: string | undefined;
      if (rest[0] === '!') {
        conv = rest[1];
        if (conv === undefined) raise('ValueError', 'end of string while looking for conversion specifier');
        if (rest.length > 2 && rest[2] !== ':') raise('ValueError', "expected ':' after conversion specifier");
        rest = rest.slice(2);
      }
      // The value first: in "{:{}}" the outer field takes the first automatic number.
      let v = pick(name);
      const spec = rest[0] === ':' ? walk(rest.slice(1), depth - 1) : '';
      if (conv === 'r') v = repr(v);
      else if (conv === 's') v = str(v);
      else if (conv === 'a') raise('SandboxLimit', "real Python has ascii() and !a; this sandbox does not yet");
      else if (conv !== undefined) raise('ValueError', `Unknown conversion specifier ${conv}`);
      out += format(v, spec);
    }
    return out;
  };
  return walk(template, 1);
}

const STR: Table = {
  upper: m(0, 0, (s: string) => s.toUpperCase()),
  lower: m(0, 0, (s: string) => s.toLowerCase()),
  title: m(0, 0, (s: string) => {
    let out = '', prev = false;
    for (const c of s) {
      out += prev ? c.toLowerCase() : titleOf(c);
      prev = CASED.test(c);
    }
    return out;
  }),
  capitalize: m(0, 0, (s: string) => { const cs = Array.from(s); return cs.length ? titleOf(cs[0]) + cs.slice(1).join('').toLowerCase() : ''; }),
  swapcase: m(0, 0, (s: string) => {
    let out = '';
    for (const c of s) out += /^\p{Uppercase}$/u.test(c) ? c.toLowerCase() : /^\p{Lowercase}$/u.test(c) ? c.toUpperCase() : c;
    return out;
  }),
  strip: stripper('strip'), lstrip: stripper('lstrip'), rstrip: stripper('rstrip'),
  split: m(0, 2, (s: string, a, _k, vm) => splitter(s, a[0], a[1], false, vm), { names: ['sep', 'maxsplit'] }),
  rsplit: m(0, 2, (s: string, a, _k, vm) => splitter(s, a[0], a[1], true, vm), { names: ['sep', 'maxsplit'] }),
  splitlines: m(0, 1, (s: string, a) => {
    const keep = a[0] === undefined ? false : truthy(a[0]), re = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]', 'g'), out: string[] = [];
    let at = 0;
    for (let e = re.exec(s); e; e = re.exec(s)) { out.push(s.slice(at, keep ? e.index + e[0].length : e.index)); at = e.index + e[0].length; }
    if (at < s.length) out.push(s.slice(at));
    return new PyList(out);
  }, { names: ['keepends'] }),
  join: m(1, 1, (s: string, a, _k, vm) => {
    let items: Val[];
    try { items = vm.toList(a[0]); }
    catch (e) { if (e instanceof PyRaise && e.exc.cls === T.TypeError && !(a[0] instanceof PyInstance)) return raise('TypeError', 'can only join an iterable'); throw e; }
    items.forEach((x, i) => { if (typeof x !== 'string') raise('TypeError', `sequence item ${i}: expected str instance, ${tname(x)} found`); });
    const out = items.join(s);
    vm.charge(out.length);
    return out;
  }),
  replace: m(2, 3, (s: string, a, kw, vm) => {
    // Python 3.13 made this a keyword as well. It's a TypeError on the 3.12 this site is tested
    // against, and telling someone on a newer install their right code is wrong would be false.
    if (kw.has('count')) raise('SandboxLimit', "Python 3.13 added replace(count=); this sandbox follows 3.12, so pass the count by position");
    const old = needStr(a[0], `replace() argument 1 must be str, not ${tname(a[0])}`), to = needStr(a[1], `replace() argument 2 must be str, not ${tname(a[1])}`);
    const count = a[2] === undefined ? -1 : ssize(a[2]);
    vm.charge(s.length);
    if (count === 0) return s;
    if (old === '') {
      // "abc".replace("", "-") is -a-b-c-: one gap before each character and one at the end.
      const cs = chars(s), n = count < 0 ? cs.length + 1 : Math.min(count, cs.length + 1);
      let out = '';
      for (let i = 0; i < cs.length; i++) out += (i < n ? to : '') + cs[i];
      return out + (cs.length < n ? to : '');
    }
    const parts = s.split(old);
    if (count < 0 || parts.length - 1 <= count) return parts.join(to);
    return parts.slice(0, count + 1).join(to) + old + parts.slice(count + 1).join(old);
  }, { only: ['count'] }),
  startswith: affix('startswith'), endswith: affix('endswith'),
  find: finder(false, false), rfind: finder(true, false),
  index: finder(false, true), rindex: finder(true, true),
  count: m(1, 3, (s: string, a, _k, vm) => {
    const sub = needStr(a[0], `must be str, not ${tname(a[0])}`);
    vm.charge(s.length);
    const [start, end] = bounds(strLen(s), a[1], a[2]);
    if (start > end) return 0n;
    if (sub === '') return BigInt(end - start + 1);
    return BigInt(cut(s, start, end).split(sub).length - 1);
  }),
  partition: m(1, 1, (s: string, a) => {
    const sep = needStr(a[0], `must be str, not ${tname(a[0])}`);
    if (sep === '') return raise('ValueError', 'empty separator');
    const i = s.indexOf(sep);
    return new PyTuple(i < 0 ? [s, '', ''] : [s.slice(0, i), sep, s.slice(i + sep.length)]);
  }),
  rpartition: m(1, 1, (s: string, a) => {
    const sep = needStr(a[0], `must be str, not ${tname(a[0])}`);
    if (sep === '') return raise('ValueError', 'empty separator');
    const i = s.lastIndexOf(sep);
    return new PyTuple(i < 0 ? ['', '', s] : [s.slice(0, i), sep, s.slice(i + sep.length)]);
  }),
  removeprefix: m(1, 1, (s: string, a) => { const p = needStr(a[0], `removeprefix() argument must be str, not ${tname(a[0])}`); return s.startsWith(p) ? s.slice(p.length) : s; }),
  removesuffix: m(1, 1, (s: string, a) => { const p = needStr(a[0], `removesuffix() argument must be str, not ${tname(a[0])}`); return p && s.endsWith(p) ? s.slice(0, s.length - p.length) : s; }),
  expandtabs: m(0, 1, (s: string, a) => {
    const size = a[0] === undefined ? 8 : ssize(a[0]);
    let out = '', col = 0;
    for (const c of s) {
      if (c === '\t') { if (size > 0) { const n = size - (col % size); out += ' '.repeat(n); col += n; } }
      else { out += c; col = c === '\n' || c === '\r' ? 0 : col + 1; }
    }
    return out;
  }, { names: ['tabsize'] }),
  zfill: m(1, 1, (s: string, a) => {
    const w = widthOf(a[0]), pad = Math.max(0, w - strLen(s));
    return /^[-+]/.test(s) ? s[0] + '0'.repeat(pad) + s.slice(1) : '0'.repeat(pad) + s;
  }),
  ljust: padder('ljust'), rjust: padder('rjust'), center: padder('center'),
  format: m(0, Number.MAX_SAFE_INTEGER, (s: string, a, kw) => strFormat(s, a, kw), { anyKw: true }),
  isascii: m(0, 0, (s: string) => /^[\x00-\x7f]*$/.test(s)),
  isdecimal: m(0, 0, (s: string) => /^\p{Nd}+$/u.test(s)),
  isdigit: m(0, 0, (s: string) => {
    if (!/^\p{N}+$/u.test(s)) return false;
    return /^\p{Nd}+$/u.test(s) ? true : refuseNumericTable('isdigit');
  }),
  isnumeric: m(0, 0, (s: string) => {
    if (/^\p{N}+$/u.test(s)) return true;
    return /^[\p{N}\p{Lo}]+$/u.test(s) ? refuseNumericTable('isnumeric') : false;
  }),
  isalpha: m(0, 0, (s: string) => /^\p{L}+$/u.test(s)),
  isalnum: m(0, 0, (s: string) => /^[\p{L}\p{N}]+$/u.test(s)),
  isspace: m(0, 0, (s: string) => s.length > 0 && chars(s).every((c) => IS_SPACE.test(c))),
  isupper: m(0, 0, (s: string) => /\p{Uppercase}/u.test(s) && !/[\p{Lowercase}\p{Lt}]/u.test(s)),
  islower: m(0, 0, (s: string) => /\p{Lowercase}/u.test(s) && !/[\p{Uppercase}\p{Lt}]/u.test(s)),
  istitle: m(0, 0, (s: string) => {
    let cased = false, prev = false;
    for (const c of s) {
      if (/^[\p{Uppercase}\p{Lt}]$/u.test(c)) { if (prev) return false; prev = true; cased = true; }
      else if (/^\p{Lowercase}$/u.test(c)) { if (!prev) return false; prev = true; cased = true; }
      else prev = false;
    }
    return cased;
  }),
  isprintable: m(0, 0, (s: string) => Array.from(s).every(isPrintable)),
  isidentifier: m(0, 0, (s: string) => /^[\p{XID_Start}_]\p{XID_Continue}*$/u.test(s)),
};

const seqIndex = (kind: string): Method => m(1, 3, (l: PyList | PyTuple, a, _k, vm) => {
  const n = l.items.length;
  const [start, end] = bounds(n, a[1], a[2], false);
  for (let i = start; i < end && i < l.items.length; i++) { vm.charge(1); if (eq(l.items[i], a[0])) return BigInt(i); }
  return raise('ValueError', kind === 'list' ? `${repr(a[0])} is not in list` : 'tuple.index(x): x not in tuple');
});
const seqCount: Method = m(1, 1, (l: PyList | PyTuple, a, _k, vm) => { let n = 0n; for (const x of l.items) { vm.charge(1); if (eq(x, a[0])) n++; } return n; });

const LIST: Table = {
  append: m(1, 1, (l: PyList, a) => { if (l.items.length >= MAX_SEQ) raise('SandboxLimit', 'this sandbox stops at very long lists, to keep your browser tab alive'); l.items.push(a[0]); return null; }),
  extend: m(1, 1, (l: PyList, a, _k, vm) => { for (const x of vm.toList(a[0])) l.items.push(x); return null; }),
  pop: m(0, 1, (l: PyList, a, _k, vm) => {
    // The argument's type comes first: [].pop("a") is a TypeError on real Python, not IndexError.
    const n = a.length ? ssize(a[0]) : undefined;
    if (!l.items.length) raise('IndexError', 'pop from empty list');
    if (n === undefined) return l.items.pop()!;
    const at = n < 0 ? n + l.items.length : n;
    if (at < 0 || at >= l.items.length) raise('IndexError', 'pop index out of range');
    // Everything after the hole moves down one: pop(0) on a long list is
    // the classic accidental quadratic, and the counter has to show that.
    vm.charge(l.items.length - at);
    return l.items.splice(at, 1)[0];
  }),
  insert: m(2, 2, (l: PyList, a, _k, vm) => {
    const n = ssize(a[0]), len = l.items.length;
    const at = n < 0 ? Math.max(0, n + len) : Math.min(n, len);
    vm.charge(len - at);
    l.items.splice(at, 0, a[1]);
    return null;
  }),
  remove: m(1, 1, (l: PyList, a, _k, vm) => {
    for (let i = 0; i < l.items.length; i++) {
      vm.charge(1);
      if (eq(l.items[i], a[0])) { vm.charge(l.items.length - i); l.items.splice(i, 1); return null; }
    }
    return raise('ValueError', 'list.remove(x): x not in list');
  }),
  index: seqIndex('list'), count: seqCount,
  sort: m(0, 0, (l: PyList, _a, kw, vm) => { l.items = vm.sortItems(l.items, kw); return null; }, { only: ['key', 'reverse'] }),
  reverse: m(0, 0, (l: PyList, _a, _k, vm) => { vm.charge(l.items.length); l.items.reverse(); return null; }),
  clear: m(0, 0, (l: PyList) => { l.items = []; return null; }),
  copy: m(0, 0, (l: PyList, _a, _k, vm) => { vm.charge(l.items.length); return new PyList([...l.items]); }),
};

const TUPLE: Table = { index: seqIndex('tuple'), count: seqCount };

const DICT: Table = {
  get: m(1, 2, (d: PyDict, a) => { const e = d.map.get(hashKey(a[0])); return e ? e[1] : a[1] ?? null; }),
  keys: m(0, 0, (d: PyDict) => new PyView('keys', d)),
  values: m(0, 0, (d: PyDict) => new PyView('values', d)),
  items: m(0, 0, (d: PyDict) => new PyView('items', d)),
  pop: m(1, 2, (d: PyDict, a) => {
    // An empty dictionary doesn't hash the key at all, so {}.pop([]) is a KeyError, not "unhashable".
    if (!d.map.size) { if (a.length === 2) return a[1]; throw new PyRaise(makeExc(T.KeyError, [a[0]])); }
    const k = hashKey(a[0]), e = d.map.get(k);
    if (e) { d.map.delete(k); return e[1]; }
    if (a.length === 2) return a[1];
    throw new PyRaise(makeExc(T.KeyError, [a[0]]));
  }),
  popitem: m(0, 0, (d: PyDict) => {
    const k = [...d.map.keys()].at(-1);
    if (k === undefined) { throw new PyRaise(makeExc(T.KeyError, ['popitem(): dictionary is empty'])); }
    const [key, v] = d.map.get(k)!;
    d.map.delete(k);
    return new PyTuple([key, v]);
  }),
  setdefault: m(1, 2, (d: PyDict, a) => { const e = d.map.get(hashKey(a[0])); if (e) return e[1]; const v = a[1] ?? null; dictSet(d, a[0], v); return v; }),
  update: m(0, 1, (d: PyDict, a, kw, vm) => { if (a.length) fillDict(vm, d, a[0]); for (const [k, v] of kw) dictSet(d, k, v); return null; }, { anyKw: true }),
  clear: m(0, 0, (d: PyDict) => { d.map.clear(); return null; }),
  copy: m(0, 0, (d: PyDict) => { const c = new PyDict(); for (const [k, v] of d.map.values()) dictSet(c, k, v); return c; }),
  fromkeys: { min: 1, max: 2, onClass: true, fn: (_d: unknown, a: Val[], _k: Kw, vm: PyProgram) => { const c = new PyDict(); for (const k of vm.toList(a[0])) dictSet(c, k, a[1] ?? null); return c; } },
};

const setCopy = (s: PySet) => { const r = new PySet(); for (const [k, v] of s.map) r.map.set(k, v); return r; };
const hashesOf = (vm: PyProgram, v: Val) => (v instanceof PySet ? new Set(v.map.keys()) : new Set(vm.toList(v).map(hashKey)));
// Real Python turns a set argument into a frozen copy for this one lookup, so
// {1}.discard({2}) does nothing and {1}.remove({2}) is a KeyError, not "unhashable".
const setLookup = (v: Val) => (v instanceof PySet ? '\0no such key' : hashKey(v));

const SET: Table = {
  add: m(1, 1, (s: PySet, a) => { setAdd(s, a[0]); return null; }),
  remove: m(1, 1, (s: PySet, a) => { if (!s.map.delete(setLookup(a[0]))) throw new PyRaise(makeExc(T.KeyError, [a[0]])); return null; }),
  discard: m(1, 1, (s: PySet, a) => { s.map.delete(setLookup(a[0])); return null; }),
  clear: m(0, 0, (s: PySet) => { s.map.clear(); return null; }),
  copy: m(0, 0, (s: PySet) => setCopy(s)),
  pop: m(0, 0, (s: PySet) => {
    const first = s.map.entries().next();
    if (first.done) throw new PyRaise(makeExc(T.KeyError, ['pop from an empty set']));
    s.map.delete(first.value[0]);
    return first.value[1];
  }),
  union: m(0, Number.MAX_SAFE_INTEGER, (s: PySet, a, _k, vm) => { const r = setCopy(s); for (const o of a) for (const x of vm.toList(o)) setAdd(r, x); return r; }),
  update: m(0, Number.MAX_SAFE_INTEGER, (s: PySet, a, _k, vm) => { for (const o of a) for (const x of vm.toList(o)) setAdd(s, x); return null; }),
  intersection: m(0, Number.MAX_SAFE_INTEGER, (s: PySet, a, _k, vm) => {
    let r = setCopy(s);
    for (const o of a) { const n = new PySet(); for (const x of vm.toList(o)) if (r.map.has(hashKey(x))) setAdd(n, x); r = n; }
    return r;
  }),
  intersection_update: m(0, Number.MAX_SAFE_INTEGER, (s: PySet, a, _k, vm) => { for (const o of a) { const keep = hashesOf(vm, o); for (const k of [...s.map.keys()]) if (!keep.has(k)) s.map.delete(k); } return null; }),
  difference: m(0, Number.MAX_SAFE_INTEGER, (s: PySet, a, _k, vm) => { const r = setCopy(s); for (const o of a) for (const k of hashesOf(vm, o)) r.map.delete(k); return r; }),
  difference_update: m(0, Number.MAX_SAFE_INTEGER, (s: PySet, a, _k, vm) => { for (const o of a) for (const k of hashesOf(vm, o)) s.map.delete(k); return null; }),
  symmetric_difference: m(1, 1, (s: PySet, a, _k, vm) => {
    const r = setCopy(s), other = new PySet();
    for (const x of vm.toList(a[0])) setAdd(other, x);
    for (const [k, v] of other.map) { if (r.map.has(k)) r.map.delete(k); else r.map.set(k, v); }
    return r;
  }),
  symmetric_difference_update: m(1, 1, (s: PySet, a, _k, vm) => {
    const other = new PySet();
    for (const x of vm.toList(a[0])) setAdd(other, x);
    for (const [k, v] of other.map) { if (s.map.has(k)) s.map.delete(k); else s.map.set(k, v); }
    return null;
  }),
  isdisjoint: m(1, 1, (s: PySet, a, _k, vm) => { for (const k of hashesOf(vm, a[0])) if (s.map.has(k)) return false; return true; }),
  issubset: m(1, 1, (s: PySet, a, _k, vm) => { const other = hashesOf(vm, a[0]); return [...s.map.keys()].every((k) => other.has(k)); }),
  issuperset: m(1, 1, (s: PySet, a, _k, vm) => { for (const k of hashesOf(vm, a[0])) if (!s.map.has(k)) return false; return true; }),
};

const asBig = (v: bigint | boolean) => (typeof v === 'boolean' ? (v ? 1n : 0n) : v);
const bitsOf = (v: bigint) => { const n = v < 0n ? -v : v; return n === 0n ? '' : n.toString(2); };
const INT: Table = {
  bit_length: m(0, 0, (v: bigint | boolean) => BigInt(bitsOf(asBig(v)).length)),
  bit_count: m(0, 0, (v: bigint | boolean) => BigInt(bitsOf(asBig(v)).replace(/0/g, '').length)),
  conjugate: m(0, 0, (v: bigint | boolean) => asBig(v)),
  is_integer: m(0, 0, () => true),
  as_integer_ratio: m(0, 0, (v: bigint | boolean) => new PyTuple([asBig(v), 1n])),
  real: { min: 0, max: 0, attr: asBig }, numerator: { min: 0, max: 0, attr: asBig },
  imag: { min: 0, max: 0, attr: () => 0n }, denominator: { min: 0, max: 0, attr: () => 1n },
};
const FLOAT: Table = {
  is_integer: m(0, 0, (v: number) => Number.isInteger(v)),
  conjugate: m(0, 0, (v: number) => v),
  as_integer_ratio: m(0, 0, (v: number) => {
    if (Number.isNaN(v)) return raise('ValueError', 'cannot convert NaN to integer ratio');
    if (!Number.isFinite(v)) return raise('OverflowError', 'cannot convert Infinity to integer ratio');
    // Doubling a float is exact, so this finds the exact fraction it holds.
    let x = v, d = 1n;
    while (!Number.isInteger(x)) { x *= 2; d *= 2n; }
    return new PyTuple([BigInt(x), d]);
  }),
  real: { min: 0, max: 0, attr: (v: number) => v }, imag: { min: 0, max: 0, attr: () => 0 },
};
const RANGE: Table = {
  start: { min: 0, max: 0, attr: (r: PyRange) => r.start }, stop: { min: 0, max: 0, attr: (r: PyRange) => r.stop }, step: { min: 0, max: 0, attr: (r: PyRange) => r.step },
  count: m(1, 1, (r: PyRange, a, _k, vm) => {
    if (typeof a[0] === 'bigint' || typeof a[0] === 'boolean') return vm.contains(r, typeof a[0] === 'boolean' ? (a[0] ? 1n : 0n) : a[0]) ? 1n : 0n;
    return vm.contains(r, a[0]) ? 1n : 0n;
  }),
  index: m(1, 1, (r: PyRange, a, _k, vm) => {
    const x = a[0];
    if (typeof x === 'bigint' || typeof x === 'boolean') {
      const n = typeof x === 'boolean' ? (x ? 1n : 0n) : x;
      if (vm.contains(r, n)) return (n - r.start) / r.step;
      return raise('ValueError', `${repr(x)} is not in range`);
    }
    let i = 0n;
    const it = vm.iter(r);
    for (let v = it.next(); v !== undefined; v = it.next()) { vm.charge(1); if (eq(v, x)) return i; i++; }
    return raise('ValueError', 'sequence.index(x): x not in sequence');
  }),
};

const TABLES: Record<string, Table> = { str: STR, list: LIST, tuple: TUPLE, dict: DICT, set: SET, int: INT, bool: INT, float: FLOAT, range: RANGE };

// Every public name real Python has on these types, checked against dir() in
// tests/py-beginner-errors.test.ts. A name here with no entry above is refused by name:
// list.push is the learner's mistake and str.casefold is this sandbox's gap, and a beginner
// can't tell them apart: "may have it, or you may have a typo" left it to them.
const REAL_METHODS: Record<string, Set<string>> = {
  str: new Set('capitalize casefold center count encode endswith expandtabs find format format_map index isalnum isalpha isascii isdecimal isdigit isidentifier islower isnumeric isprintable isspace istitle isupper join ljust lower lstrip maketrans partition removeprefix removesuffix replace rfind rindex rjust rpartition rsplit rstrip split splitlines startswith strip swapcase title translate upper zfill'.split(' ')),
  list: new Set('append clear copy count extend index insert pop remove reverse sort'.split(' ')),
  tuple: new Set('count index'.split(' ')),
  dict: new Set('clear copy fromkeys get items keys pop popitem setdefault update values'.split(' ')),
  set: new Set('add clear copy difference difference_update discard intersection intersection_update isdisjoint issubset issuperset pop remove symmetric_difference symmetric_difference_update union update'.split(' ')),
  int: new Set('as_integer_ratio bit_count bit_length conjugate denominator from_bytes imag is_integer numerator real to_bytes'.split(' ')),
  bool: new Set('as_integer_ratio bit_count bit_length conjugate denominator from_bytes imag is_integer numerator real to_bytes'.split(' ')),
  float: new Set('as_integer_ratio conjugate fromhex hex imag is_integer real'.split(' ')),
  range: new Set('count index start step stop'.split(' ')),
  dict_keys: new Set(['isdisjoint', 'mapping']), dict_items: new Set(['isdisjoint', 'mapping']), dict_values: new Set(['mapping']),
};

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** Python keeps a lot behind double underscores, and this sandbox has only the ones its classes use. It doesn't know which of the rest exist, so it says "may". */
export function refuseDunder(name: string, on: string): never {
  return raise('SandboxLimit', `real Python may have ${name} on ${on}; this sandbox only has the double-underscore names it needs for classes`);
}
export const isDunder = (name: string) => /^__\w+__$/.test(name);

export function methodOf(vm: PyProgram, o: Val, name: string): Val {
  const kind = tname(o), table = TABLES[kind];
  if (table && hasOwn(table, name)) {
    const d = table[name];
    if (d.attr) return d.attr(o);
    const qual = `${kind}.${name}`;
    const bound = new PyBuiltin(name, (a, kw) => d.fn!(o, gate(qual, d, a, kw), kw, vm));
    bound.self = o;
    return bound;
  }
  if (name === '__class__') return typeOf(o);
  if (isDunder(name)) refuseDunder(name, `a ${kind}`);
  if (REAL_METHODS[kind]?.has(name)) return raise('SandboxLimit', `real Python has ${kind}.${name}${TABLES[kind] || kind.startsWith('dict_') ? '()' : ''}; this sandbox does not yet`);
  return raise('AttributeError', `'${kind}' object has no attribute '${name}'`);
}

/**
 * str.lower as a value, which is what key=str.lower passes. Undefined for a name the type
 * doesn't have, so the caller can give the same AttributeError for it as for anything else.
 */
export function classAttr(vm: PyProgram, cls: PyClass, name: string): Val | undefined {
  const table = cls.builtin ? TABLES[cls.name] : undefined;
  if (table && hasOwn(table, name)) {
    const d = table[name];
    const key = `${cls.name}.${name}`;
    // Kept per program, so str.lower is str.lower is true, as it is on real Python.
    const descriptors = vm.descriptors;
    let got = descriptors.get(key);
    if (got) return got;
    if (d.attr) return raise('SandboxLimit', `real Python has ${key} as a descriptor on the class; this sandbox has it only on values`);
    if (d.onClass) { const on = new PyBuiltin(name, (a, kw) => d.fn!(null, gate(key, d, a, kw), kw, vm)); on.self = cls; return on; }
    got = new PyBuiltin(name, (a, kw) => {
      if (!a.length) return raise('TypeError', `unbound method ${key}() needs an argument`);
      if (!typeOf(a[0]).isSub(cls)) return raise('TypeError', `descriptor '${name}' for '${cls.name}' objects doesn't apply to a '${tname(a[0])}' object`);
      const rest = a.slice(1);
      return d.fn!(a[0], gate(key, d, rest, kw), kw, vm);
    });
    got.descr = cls.name;
    descriptors.set(key, got);
    return got;
  }
  if (REAL_METHODS[cls.name]?.has(name)) return raise('SandboxLimit', `real Python has ${cls.name}.${name}; this sandbox does not yet`);
  return undefined;
}
