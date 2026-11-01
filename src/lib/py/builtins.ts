// The built-in functions and the methods of the built-in types. A method this
// sandbox lacks says so by name, because AttributeError alone would tell a
// learner that real Python doesn't have it either.

import type { PyProgram } from './vm.ts';
import { listsort } from './listsort.ts';
import {
  EXCEPTION_NAMES, MAX_SEQ, PyBound, PyBuiltin, PyClass, PyDict, PyFunction, PyInstance, PyIter, PyList, PyRaise, PyRange, PySet, PySuper, PyTuple, PyView, T,
  binop, compare, dictSet, eq, format, hashKey, hooks, intFloorDiv, intMod, makeExc, raise, repr, setAdd, str, strLen, tname, toFloat, truthy, typeOf, fixed, type Val,
} from './values.ts';

const b = (name: string, fn: (a: Val[], kw: Map<string, Val>) => Val) => new PyBuiltin(name, fn);
const argc = (name: string, a: Val[], lo: number, hi = lo) => {
  if (a.length >= lo && a.length <= hi) return;
  const want = lo === hi ? `exactly ${lo} argument${lo === 1 ? '' : 's'}` : a.length < lo ? `at least ${lo} argument${lo === 1 ? '' : 's'}` : `at most ${hi} argument${hi === 1 ? '' : 's'}`;
  raise('TypeError', `${name}() takes ${want} (${a.length} given)`);
};
const noKw = (name: string, kw: Map<string, Val>) => { if (kw.size) raise('TypeError', `${name}() takes no keyword arguments`); };
const asInt = (v: Val, what: string): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'boolean') return v ? 1n : 0n;
  return raise('TypeError', `${what}: '${tname(v)}' object cannot be interpreted as an integer`);
};

function parseIntText(text: string, base: number): bigint | undefined {
  let s = text.trim().replace(/(?<=[0-9a-zA-Z])_(?=[0-9a-zA-Z])/g, '').toLowerCase(), neg = false;
  if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
  const pre: Record<number, string> = { 16: '0x', 8: '0o', 2: '0b' };
  if (pre[base] && s.startsWith(pre[base])) s = s.slice(2);
  if (!s) return undefined;
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

function ctor(name: string, fn: (a: Val[], kw: Map<string, Val>) => Val) { T[name].ctor = fn; return T[name]; }

export function builtins(vm: PyProgram): Map<string, Val> {
  const env = new Map<string, Val>();
  const def = (name: string, fn: (a: Val[], kw: Map<string, Val>) => Val) => env.set(name, b(name, fn));

  env.set('int', ctor('int', (a, kw) => {
    if (a.length === 0) return 0n;
    const baseV = kw.get('base') ?? a[1];
    const v = a[0];
    if (typeof v === 'string') {
      const base = baseV === undefined ? 10 : Number(asInt(baseV, 'int'));
      const r = parseIntText(v, base);
      if (r === undefined) return raise('ValueError', `invalid literal for int() with base ${base}: ${repr(v)}`);
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
    return raise('TypeError', `int() argument must be a string, a bytes-like object or a real number, not '${tname(v)}'`);
  }));
  env.set('float', ctor('float', (a) => {
    if (a.length === 0) return 0;
    const v = a[0];
    if (typeof v === 'number') return v;
    if (typeof v === 'bigint') return toFloat(v);
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase().replace(/(?<=\d)_(?=\d)/g, '');
      if (/^[-+]?(inf|infinity)$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
      if (/^[-+]?nan$/.test(t)) return NaN;
      if (/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/.test(t)) return Number(t);
      return raise('ValueError', `could not convert string to float: ${repr(v)}`);
    }
    return raise('TypeError', `float() argument must be a string or a real number, not '${tname(v)}'`);
  }));
  env.set('str', ctor('str', (a) => (a.length === 0 ? '' : str(a[0]))));
  env.set('bool', ctor('bool', (a) => (a.length === 0 ? false : truthy(a[0]))));
  env.set('list', ctor('list', (a) => new PyList(a.length ? vm.toList(a[0]) : [])));
  env.set('tuple', ctor('tuple', (a) => new PyTuple(a.length ? vm.toList(a[0]) : [])));
  env.set('dict', ctor('dict', (a, kw) => {
    const d = new PyDict();
    if (a.length) {
      if (a[0] instanceof PyDict) for (const [k, v] of a[0].map.values()) dictSet(d, k, v);
      else for (const pair of vm.toList(a[0])) {
        const p = vm.toList(pair);
        if (p.length !== 2) raise('ValueError', `dictionary update sequence element has length ${p.length}; 2 is required`);
        dictSet(d, p[0], p[1]);
      }
    }
    for (const [k, v] of kw) dictSet(d, k, v);
    return d;
  }));
  env.set('set', ctor('set', (a) => { const s = new PySet(); if (a.length) for (const x of vm.toList(a[0])) setAdd(s, x); return s; }));
  env.set('range', ctor('range', (a) => {
    argc('range', a, 1, 3);
    const n = a.map((x) => asInt(x, 'range'));
    const r = n.length === 1 ? new PyRange(0n, n[0], 1n) : new PyRange(n[0], n[1], n[2] ?? 1n);
    if (r.step === 0n) raise('ValueError', 'range() arg 3 must not be zero');
    return r;
  }));
  env.set('object', T.object);
  env.set('type', ctor('type', (a) => { argc('type', a, 1); return typeOf(a[0]); }));
  for (const n of EXCEPTION_NAMES) env.set(n, T[n]);

  def('print', (a, kw) => {
    for (const k of kw.keys()) if (k !== 'sep' && k !== 'end') raise('SandboxLimit', `real Python's print has ${k}=; this sandbox does not yet`);
    const sep = kw.get('sep') ?? ' ', end = kw.get('end') ?? '\n';
    if (sep !== null && typeof sep !== 'string') raise('TypeError', `sep must be None or a string, not ${tname(sep)}`);
    if (end !== null && typeof end !== 'string') raise('TypeError', `end must be None or a string, not ${tname(end)}`);
    vm.write(a.map(str).join(sep === null ? ' ' : sep as string) + (end === null ? '\n' : end as string));
    return null;
  });
  def('input', () => raise('SandboxLimit', 'real Python has input(); this sandbox does not yet. Set a variable at the top of your program instead'));
  def('len', (a) => {
    argc('len', a, 1);
    const v = a[0];
    if (typeof v === 'string') return BigInt(strLen(v));
    if (v instanceof PyList || v instanceof PyTuple) return BigInt(v.items.length);
    if (v instanceof PyDict || v instanceof PySet) return BigInt(v.map.size);
    if (v instanceof PyRange) return v.len;
    if (v instanceof PyView) return BigInt(v.d.map.size);
    if (v instanceof PyInstance) { const r = hooks.dunder(v, '__len__', []); if (r !== undefined) return r; }
    return raise('TypeError', `object of type '${tname(v)}' has no len()`);
  });
  def('abs', (a) => {
    argc('abs', a, 1);
    const v = a[0];
    if (typeof v === 'bigint') return v < 0n ? -v : v;
    if (typeof v === 'number') return Math.abs(v);
    if (typeof v === 'boolean') return v ? 1n : 0n;
    return raise('TypeError', `bad operand type for abs(): '${tname(v)}'`);
  });
  const extreme = (name: 'min' | 'max', op: '<' | '>') => def(name, (a, kw) => {
    const key = kw.get('key') ?? null, dflt = kw.get('default');
    if (a.length === 0) raise('TypeError', `${name} expected at least 1 argument, got 0`);
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
  def('sum', (a) => {
    argc('sum', a, 1, 2);
    let t: Val = a[1] ?? 0n;
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
  const sortItems = (items: Val[], kw: Map<string, Val>) => {
    for (const k of kw.keys()) if (k !== 'key' && k !== 'reverse') raise('TypeError', `sort() got an unexpected keyword argument '${k}'`);
    vm.sortCalls++;
    const key = kw.get('key') ?? null, rev = truthy(kw.get('reverse') ?? false);
    const out = [...items];
    const keys = key === null ? out : out.map((v) => vm.callValue(key, [v]));
    // CPython's own algorithm, comparing only with <, so a class needs just
    // __lt__ and a counting __lt__ reports the count real Python reports.
    listsort(keys, key === null ? null : out, (x, y) => { vm.charge(1); return compare('<', x, y); }, rev);
    return out;
  };
  def('sorted', (a, kw) => { argc('sorted', a, 1); return new PyList(sortItems(vm.toList(a[0]), kw)); });
  vm.sortItems = sortItems;
  def('reversed', (a) => {
    argc('reversed', a, 1);
    const items = vm.toList(a[0]);
    let i = items.length - 1;
    return new PyIter('reversed', () => (i >= 0 ? items[i--] : undefined));
  });
  def('enumerate', (a, kw) => {
    argc('enumerate', a, 1, 2);
    const it = vm.iter(a[0]);
    let n = asInt(a[1] ?? kw.get('start') ?? 0n, 'enumerate');
    return new PyIter('enumerate', () => { const v = it.next(); if (v === undefined) return undefined; const r = new PyTuple([n, v]); n += 1n; return r; });
  });
  def('zip', (a, kw) => {
    noKw('zip', kw);
    const its = a.map((x) => vm.iter(x));
    return new PyIter('zip', () => {
      if (!its.length) return undefined;
      const row: Val[] = [];
      for (const it of its) { const v = it.next(); if (v === undefined) return undefined; row.push(v); }
      return new PyTuple(row);
    });
  });
  def('map', (a) => {
    argc('map', a, 2);
    const it = vm.iter(a[1]);
    return new PyIter('map', () => { const v = it.next(); return v === undefined ? undefined : vm.callValue(a[0], [v]); });
  });
  def('filter', (a) => {
    argc('filter', a, 2);
    const it = vm.iter(a[1]);
    return new PyIter('filter', () => {
      for (let v = it.next(); v !== undefined; v = it.next()) {
        vm.charge(1);
        if (a[0] === null ? truthy(v) : truthy(vm.callValue(a[0], [v]))) return v;
      }
      return undefined;
    });
  });
  def('any', (a) => { argc('any', a, 1); const it = vm.iter(a[0]); for (let v = it.next(); v !== undefined; v = it.next()) { vm.charge(1); if (truthy(v)) return true; } return false; });
  def('all', (a) => { argc('all', a, 1); const it = vm.iter(a[0]); for (let v = it.next(); v !== undefined; v = it.next()) { vm.charge(1); if (!truthy(v)) return false; } return true; });
  def('iter', (a) => { argc('iter', a, 1); return vm.iter(a[0]); });
  def('next', (a) => {
    argc('next', a, 1, 2);
    const it = a[0];
    if (it instanceof PyInstance) { const r = hooks.dunder(it, '__next__', []); if (r !== undefined) return r; }
    if (!(it instanceof PyIter)) return raise('TypeError', `'${tname(it)}' object is not an iterator`);
    const v = it.next();
    if (v !== undefined) return v;
    if (a.length === 2) return a[1];
    throw new PyRaise(makeExc(T.StopIteration, []));
  });
  def('isinstance', (a) => {
    argc('isinstance', a, 2);
    const types = a[1] instanceof PyTuple ? a[1].items : [a[1]];
    return types.some((t) => {
      if (!(t instanceof PyClass)) return raise('TypeError', 'isinstance() arg 2 must be a type, a tuple of types, or a union');
      return typeOf(a[0]).isSub(t);
    });
  });
  def('issubclass', (a) => { argc('issubclass', a, 2); if (!(a[0] instanceof PyClass) || !(a[1] instanceof PyClass)) return raise('TypeError', 'issubclass() arg 1 must be a class'); return a[0].isSub(a[1]); });
  def('callable', (a) => { argc('callable', a, 1); const v = a[0]; return v instanceof PyFunction || v instanceof PyBuiltin || v instanceof PyBound || v instanceof PyClass || (v instanceof PyInstance && v.cls.lookup('__call__') !== undefined); });
  def('hasattr', (a) => {
    argc('hasattr', a, 2);
    try { vm.getAttr(a[0], a[1] as string); return true; }
    catch (e) { if (e instanceof PyRaise && e.exc.cls.isSub(T.AttributeError)) return false; throw e; }
  });
  def('getattr', (a) => {
    argc('getattr', a, 2, 3);
    try { return vm.getAttr(a[0], a[1] as string); }
    catch (e) { if (a.length === 3 && e instanceof PyRaise && e.exc.cls.isSub(T.AttributeError)) return a[2]; throw e; }
  });
  def('setattr', (a) => { argc('setattr', a, 3); if (!(a[0] instanceof PyInstance)) return raise('AttributeError', `'${tname(a[0])}' object has no attribute '${str(a[1])}'`); a[0].attrs.set(a[1] as string, a[2]); return null; });
  def('ord', (a) => {
    argc('ord', a, 1);
    if (typeof a[0] !== 'string') return raise('TypeError', `ord() expected string of length 1, but ${tname(a[0])} found`);
    if (strLen(a[0]) !== 1) return raise('TypeError', `ord() expected a character, but string of length ${strLen(a[0])} found`);
    return BigInt(a[0].codePointAt(0)!);
  });
  def('chr', (a) => {
    argc('chr', a, 1);
    const n = Number(asInt(a[0], 'chr'));
    if (n < 0 || n > 0x10ffff) return raise('ValueError', 'chr() arg not in range(0x110000)');
    return String.fromCodePoint(n);
  });
  const radix = (name: string, pre: string, base: number) => def(name, (a) => {
    argc(name, a, 1);
    const n = asInt(a[0], name), abs = n < 0n ? -n : n;
    return (n < 0n ? '-' : '') + pre + abs.toString(base);
  });
  radix('bin', '0b', 2); radix('oct', '0o', 8); radix('hex', '0x', 16);
  def('repr', (a) => { argc('repr', a, 1); return repr(a[0]); });
  def('format', (a) => { argc('format', a, 1, 2); return format(a[0], (a[1] as string) ?? ''); });
  def('id', (a) => { argc('id', a, 1); const v = a[0]; return v instanceof PyInstance ? BigInt(v.id) : BigInt(identity(v)); });
  // Real hash() randomises strings per run, so a number shown here would look
  // meaningful and differ on the learner's own machine.
  def('hash', (a) => {
    argc('hash', a, 1);
    hashKey(a[0]);
    if (typeof a[0] === 'bigint') { const m = (1n << 61n) - 1n; const h = a[0] < 0n ? -((-a[0]) % m) : a[0] % m; return h === -1n ? -2n : h; }
    if (typeof a[0] === 'boolean') return a[0] ? 1n : 0n;
    if (typeof a[0] === 'number' && !Number.isNaN(a[0])) return floatHash(a[0]);
    return raise('SandboxLimit', "real Python has hash() on this type, and for strings it changes on every run; write your own hash function here");
  });
  def('round', (a, kw) => {
    argc('round', a, 1, 2);
    const nd = a[1] ?? kw.get('ndigits') ?? null, v = a[0];
    if (typeof v === 'bigint' || typeof v === 'boolean') {
      const x = typeof v === 'boolean' ? (v ? 1n : 0n) : v;
      if (nd === null || (nd as bigint) >= 0n) return x;
      const p = 10n ** -(nd as bigint), q = intFloorDiv(x, p), r = intMod(x, p), twice = r * 2n;
      return (twice > p || (twice === p && intMod(q, 2n) === 1n) ? q + 1n : q) * p;
    }
    if (typeof v !== 'number') return raise('TypeError', `type ${tname(v)} doesn't define __round__ method`);
    if (nd === null) {
      if (Number.isNaN(v)) return raise('ValueError', 'cannot convert float NaN to integer');
      if (!Number.isFinite(v)) return raise('OverflowError', 'cannot convert float infinity to integer');
      const f = Math.floor(v), d = v - f;
      const r = d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1;
      return BigInt(r);
    }
    if (!Number.isFinite(v)) return v;
    const n = Number(nd);
    if (n >= 0) return Number(fixed(v, Math.min(n, 100)));
    const p = 10 ** -n, q = v / p, f = Math.floor(q), d = q - f;
    return (d < 0.5 ? f : d > 0.5 ? f + 1 : f % 2 === 0 ? f : f + 1) * p;
  });
  def('divmod', (a) => { argc('divmod', a, 2); return new PyTuple([binop('//', a[0], a[1]), binop('%', a[0], a[1])]); });
  def('pow', (a) => {
    argc('pow', a, 2, 3);
    if (a.length === 2) return binop('**', a[0], a[1]);
    let base = asInt(a[0], 'pow'), e = asInt(a[1], 'pow');
    const m = asInt(a[2], 'pow');
    if (m === 0n) return raise('ValueError', 'pow() 3rd argument cannot be 0');
    if (e < 0n) return raise('SandboxLimit', 'real Python has pow() with a negative exponent and a modulus; this sandbox does not yet');
    let r = 1n;
    base = intMod(base, m);
    while (e > 0n) { vm.charge(1); if (e & 1n) r = intMod(r * base, m); base = intMod(base * base, m); e >>= 1n; }
    return intMod(r, m);
  });
  env.set('super', b('super', () => raise('RuntimeError', 'super(): no arguments')));
  return env;
}

const ids = new WeakMap<object, number>();
let nextIdentity = 1000;
const identity = (v: Val): number => {
  if (v !== null && typeof v === 'object') { let i = ids.get(v); if (!i) { i = ++nextIdentity; ids.set(v, i); } return i; }
  return typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? v.length + 7 : 1;
};

export function methodOf(vm: PyProgram, o: Val, name: string): Val {
  const m = (fn: (a: Val[], kw: Map<string, Val>) => Val) => b(name, fn);
  const kind = tname(o);
  if (typeof o === 'string') {
    const s = o;
    switch (name) {
      case 'upper': return m(() => s.toUpperCase());
      case 'lower': return m(() => s.toLowerCase());
      case 'title': return m(() => s.toLowerCase().replace(/(^|[^a-zA-Z])([a-z])/g, (_, p, c) => p + c.toUpperCase()));
      case 'capitalize': return m(() => s.slice(0, 1).toUpperCase() + s.slice(1).toLowerCase());
      case 'strip': case 'lstrip': case 'rstrip': return m((a) => {
        const cs = a[0] === undefined || a[0] === null ? null : new Set(a[0] as string);
        const drop = (c: string) => (cs ? cs.has(c) : /\s/.test(c));
        let i = 0, j = s.length;
        if (name !== 'rstrip') while (i < j && drop(s[i])) i++;
        if (name !== 'lstrip') while (j > i && drop(s[j - 1])) j--;
        return s.slice(i, j);
      });
      case 'split': return m((a, kw) => {
        const sep = a[0] ?? kw.get('sep') ?? null;
        const maxs = a[1] ?? kw.get('maxsplit');
        if (maxs !== undefined) return raise('SandboxLimit', 'real Python has split(maxsplit=); this sandbox does not yet');
        vm.charge(s.length);
        if (sep === null) return new PyList(s.split(/\s+/).filter((x) => x.length));
        if (sep === '') return raise('ValueError', 'empty separator');
        return new PyList(s.split(sep as string));
      });
      case 'splitlines': return m(() => { const parts = s.split(/\r\n|\r|\n/); if (parts.at(-1) === '') parts.pop(); return new PyList(parts); });
      case 'join': return m((a) => {
        argc('str.join', a, 1);
        const items = vm.toList(a[0]);
        items.forEach((x, i) => { if (typeof x !== 'string') raise('TypeError', `sequence item ${i}: expected str instance, ${tname(x)} found`); });
        const out = items.join(s);
        vm.charge(out.length);
        return out;
      });
      case 'replace': return m((a) => { argc('replace', a, 2, 3); if (a[2] !== undefined) return raise('SandboxLimit', 'real Python has replace with a count; this sandbox does not yet'); vm.charge(s.length); return s.split(a[0] as string).join(a[1] as string); });
      case 'startswith': return m((a) => { if (a[0] instanceof PyTuple) return a[0].items.some((p) => s.startsWith(p as string)); if (typeof a[0] !== 'string') return raise('TypeError', `startswith first arg must be str or a tuple of str, not ${tname(a[0])}`); return s.startsWith(a[0]); });
      case 'endswith': return m((a) => { if (a[0] instanceof PyTuple) return a[0].items.some((p) => s.endsWith(p as string)); if (typeof a[0] !== 'string') return raise('TypeError', `endswith first arg must be str or a tuple of str, not ${tname(a[0])}`); return s.endsWith(a[0]); });
      case 'find': return m((a) => { vm.charge(s.length); return BigInt(s.indexOf(a[0] as string)); });
      case 'index': return m((a) => { vm.charge(s.length); const i = s.indexOf(a[0] as string); if (i < 0) raise('ValueError', 'substring not found'); return BigInt(i); });
      case 'count': return m((a) => { vm.charge(s.length); const t = a[0] as string; return t === '' ? BigInt(strLen(s) + 1) : BigInt(s.split(t).length - 1); });
      case 'isdigit': return m(() => /^\p{Nd}+$/u.test(s));
      case 'isalpha': return m(() => /^\p{L}+$/u.test(s));
      case 'isalnum': return m(() => /^[\p{L}\p{Nd}]+$/u.test(s));
      case 'isspace': return m(() => /^\s+$/.test(s));
      case 'isupper': return m(() => /\p{Lu}/u.test(s) && !/\p{Ll}/u.test(s));
      case 'islower': return m(() => /\p{Ll}/u.test(s) && !/\p{Lu}/u.test(s));
      case 'zfill': return m((a) => { const w = Number(a[0]); return /^[-+]/.test(s) ? s[0] + s.slice(1).padStart(w - 1, '0') : s.padStart(w, '0'); });
      case 'ljust': return m((a) => s.padEnd(Number(a[0]), (a[1] as string) ?? ' '));
      case 'rjust': return m((a) => s.padStart(Number(a[0]), (a[1] as string) ?? ' '));
      case 'center': return m((a) => { const w = Number(a[0]), pad = Math.max(0, w - s.length), f = (a[1] as string) ?? ' ', l = Math.floor(pad / 2) + (pad & w & 1); return f.repeat(l) + s + f.repeat(pad - l); });
    }
  }
  if (o instanceof PyList) {
    const l = o;
    switch (name) {
      case 'append': return m((a) => { argc('list.append', a, 1); if (l.items.length >= MAX_SEQ) raise('SandboxLimit', 'this sandbox stops at very long lists, to keep your browser tab alive'); l.items.push(a[0]); return null; });
      case 'extend': return m((a) => { argc('list.extend', a, 1); for (const x of vm.toList(a[0])) l.items.push(x); return null; });
      case 'pop': return m((a) => {
        argc('list.pop', a, 0, 1);
        if (!l.items.length) raise('IndexError', 'pop from empty list');
        if (a.length === 0) return l.items.pop()!;
        const n = Number(asInt(a[0], 'pop')), at = n < 0 ? n + l.items.length : n;
        if (at < 0 || at >= l.items.length) raise('IndexError', 'pop index out of range');
        // Everything after the hole moves down one: pop(0) on a long list is
        // the classic accidental quadratic, and the counter has to show that.
        vm.charge(l.items.length - at);
        return l.items.splice(at, 1)[0];
      });
      case 'insert': return m((a) => {
        argc('list.insert', a, 2);
        const n = Number(asInt(a[0], 'insert')), len = l.items.length;
        const at = n < 0 ? Math.max(0, n + len) : Math.min(n, len);
        vm.charge(len - at);
        l.items.splice(at, 0, a[1]);
        return null;
      });
      case 'remove': return m((a) => {
        argc('list.remove', a, 1);
        for (let i = 0; i < l.items.length; i++) {
          vm.charge(1);
          if (eq(l.items[i], a[0])) { vm.charge(l.items.length - i); l.items.splice(i, 1); return null; }
        }
        return raise('ValueError', 'list.remove(x): x not in list');
      });
      case 'index': return m((a) => {
        for (let i = 0; i < l.items.length; i++) { vm.charge(1); if (eq(l.items[i], a[0])) return BigInt(i); }
        return raise('ValueError', `${repr(a[0])} is not in list`);
      });
      case 'count': return m((a) => { let n = 0n; for (const x of l.items) { vm.charge(1); if (eq(x, a[0])) n++; } return n; });
      case 'sort': return m((a, kw) => { if (a.length) raise('TypeError', 'sort() takes no positional arguments'); l.items = vm.sortItems(l.items, kw); return null; });
      case 'reverse': return m(() => { vm.charge(l.items.length); l.items.reverse(); return null; });
      case 'clear': return m(() => { l.items = []; return null; });
      case 'copy': return m(() => { vm.charge(l.items.length); return new PyList([...l.items]); });
    }
  }
  if (o instanceof PyTuple) {
    const l = o;
    switch (name) {
      case 'index': return m((a) => { for (let i = 0; i < l.items.length; i++) { vm.charge(1); if (eq(l.items[i], a[0])) return BigInt(i); } return raise('ValueError', 'tuple.index(x): x not in tuple'); });
      case 'count': return m((a) => { let n = 0n; for (const x of l.items) { vm.charge(1); if (eq(x, a[0])) n++; } return n; });
    }
  }
  if (o instanceof PyDict) {
    const d = o;
    switch (name) {
      case 'get': return m((a) => { argc('get', a, 1, 2); const e = d.map.get(hashKey(a[0])); return e ? e[1] : a[1] ?? null; });
      case 'keys': return m(() => new PyView('keys', d));
      case 'values': return m(() => new PyView('values', d));
      case 'items': return m(() => new PyView('items', d));
      case 'pop': return m((a) => {
        argc('pop', a, 1, 2);
        const k = hashKey(a[0]), e = d.map.get(k);
        if (e) { d.map.delete(k); return e[1]; }
        if (a.length === 2) return a[1];
        throw new PyRaise(makeExc(T.KeyError, [a[0]]));
      });
      case 'setdefault': return m((a) => { const e = d.map.get(hashKey(a[0])); if (e) return e[1]; const v = a[1] ?? null; dictSet(d, a[0], v); return v; });
      case 'update': return m((a, kw) => { if (a[0] instanceof PyDict) for (const [k, v] of a[0].map.values()) dictSet(d, k, v); else if (a.length) for (const p of vm.toList(a[0])) { const q = vm.toList(p); dictSet(d, q[0], q[1]); } for (const [k, v] of kw) dictSet(d, k, v); return null; });
      case 'clear': return m(() => { d.map.clear(); return null; });
      case 'copy': return m(() => { const c = new PyDict(); for (const [k, v] of d.map.values()) dictSet(c, k, v); return c; });
    }
  }
  if (o instanceof PySet) {
    const s = o;
    switch (name) {
      case 'add': return m((a) => { argc('set.add', a, 1); setAdd(s, a[0]); return null; });
      case 'remove': return m((a) => { if (!s.map.delete(hashKey(a[0]))) throw new PyRaise(makeExc(T.KeyError, [a[0]])); return null; });
      case 'discard': return m((a) => { s.map.delete(hashKey(a[0])); return null; });
      case 'clear': return m(() => { s.map.clear(); return null; });
      case 'union': return m((a) => { const r = new PySet(); for (const [k, v] of s.map) r.map.set(k, v); for (const x of vm.toList(a[0])) setAdd(r, x); return r; });
      case 'intersection': return m((a) => { const r = new PySet(); for (const x of vm.toList(a[0])) if (s.map.has(hashKey(x))) setAdd(r, x); return r; });
      case 'difference': return m((a) => { const drop = new Set(vm.toList(a[0]).map(hashKey)); const r = new PySet(); for (const [k, v] of s.map) if (!drop.has(k)) r.map.set(k, v); return r; });
      case 'issubset': return m((a) => { const other = new Set(vm.toList(a[0]).map(hashKey)); return [...s.map.keys()].every((k) => other.has(k)); });
      case 'copy': return m(() => { const r = new PySet(); for (const [k, v] of s.map) r.map.set(k, v); return r; });
    }
  }
  if (typeof o === 'bigint' && name === 'bit_length') return m(() => BigInt((o < 0n ? -o : o) === 0n ? 0 : (o < 0n ? -o : o).toString(2).length));
  if (typeof o === 'number' && name === 'is_integer') return m(() => Number.isInteger(o));
  if (o instanceof PyInstance || o instanceof PyBound || o instanceof PySuper) return raise('AttributeError', `'${kind}' object has no attribute '${name}'`);
  const known = typeof o === 'string' || o instanceof PyList || o instanceof PyDict || o instanceof PySet || o instanceof PyTuple;
  return raise(known ? 'SandboxLimit' : 'AttributeError', known ? `this sandbox's ${kind} has no .${name}; real Python may have it, or you may have a typo` : `'${kind}' object has no attribute '${name}'`);
}

