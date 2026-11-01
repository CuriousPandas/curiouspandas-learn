// Python's values and the rules that make them Python's: arbitrary-size ints,
// floor division, float repr, equality across number types. tests/py-parity.test.ts
// holds this file to the real interpreter, so a rule that differs fails there.

import type { Code } from './compiler.ts';

export class Env {
  vars = new Map<string, Val>();
  parent: Env | null;
  constructor(parent: Env | null) { this.parent = parent; }
}
export class PyList { items: Val[]; constructor(items: Val[] = []) { this.items = items; } }
export class PyTuple { items: Val[]; constructor(items: Val[]) { this.items = items; } }
export class PyDict { map = new Map<string, [Val, Val]>(); }
// Deliberate difference: a set prints and iterates in insertion order here, and
// in an arbitrary order in Python. The lessons say not to rely on set order.
export class PySet { map = new Map<string, Val>(); }
export class PyRange { start: bigint; stop: bigint; step: bigint; constructor(a: bigint, b: bigint, c: bigint) { this.start = a; this.stop = b; this.step = c; } get len() { const n = this.step > 0n ? (this.stop - this.start + this.step - 1n) / this.step : (this.start - this.stop - this.step - 1n) / -this.step; return n < 0n ? 0n : n; } }
export class PySlice { lo: Val; hi: Val; step: Val; constructor(a: Val, b: Val, c: Val) { this.lo = a; this.hi = b; this.step = c; } }
export class PyFunction { code: Code; defaults: Val[]; env: Env; owner?: PyClass; constructor(code: Code, defaults: Val[], env: Env) { this.code = code; this.defaults = defaults; this.env = env; } }
export class PyBuiltin { name: string; fn: (args: Val[], kw: Map<string, Val>) => Val; constructor(name: string, fn: (args: Val[], kw: Map<string, Val>) => Val) { this.name = name; this.fn = fn; } }
export class PyBound { self: Val; fn: Val; constructor(self: Val, fn: Val) { this.self = self; this.fn = fn; } }
export class PySuper { cls: PyClass | null; self: Val; constructor(cls: PyClass | null, self: Val) { this.cls = cls; this.self = self; } }
export class PyClass {
  name: string; base: PyClass | null; attrs = new Map<string, Val>();
  builtin: boolean; ctor?: (args: Val[], kw: Map<string, Val>) => Val;
  constructor(name: string, base: PyClass | null, builtin = false) { this.name = name; this.base = base; this.builtin = builtin; }
  lookup(n: string): Val | undefined { for (let c: PyClass | null = this; c; c = c.base) { const v = c.attrs.get(n); if (v !== undefined) return v; } return undefined; }
  isSub(o: PyClass) { for (let c: PyClass | null = this; c; c = c.base) if (c === o) return true; return false; }
}
let nextId = 0;
export class PyInstance { cls: PyClass; attrs = new Map<string, Val>(); id: number; constructor(cls: PyClass) { this.cls = cls; this.id = ++nextId; } }
// next() returns undefined when exhausted; undefined is never a Python value.
export class PyIter { kind: string; next: () => Val | undefined; constructor(kind: string, next: () => Val | undefined) { this.kind = kind; this.next = next; } }
export class PyView { kind: 'keys' | 'values' | 'items'; d: PyDict; constructor(kind: 'keys' | 'values' | 'items', d: PyDict) { this.kind = kind; this.d = d; } }

export type Val = bigint | number | boolean | string | null | PyList | PyTuple | PyDict | PySet | PyRange | PySlice | PyFunction | PyBuiltin | PyBound | PySuper | PyClass | PyInstance | PyIter | PyView;

export const T: Record<string, PyClass> = {};
const mk = (name: string, base: PyClass | null) => (T[name] = new PyClass(name, base, true));
mk('object', null);
for (const n of ['int', 'float', 'str', 'list', 'tuple', 'dict', 'set', 'range', 'NoneType', 'function', 'builtin_function_or_method', 'method', 'type', 'iterator', 'slice', 'super']) mk(n, T.object);
mk('bool', T.int);
mk('BaseException', T.object);
mk('Exception', T.BaseException);
const EXC: [string, string][] = [['ArithmeticError', 'Exception'], ['ZeroDivisionError', 'ArithmeticError'], ['OverflowError', 'ArithmeticError'], ['LookupError', 'Exception'], ['IndexError', 'LookupError'], ['KeyError', 'LookupError'], ['NameError', 'Exception'], ['UnboundLocalError', 'NameError'], ['TypeError', 'Exception'], ['ValueError', 'Exception'], ['AttributeError', 'Exception'], ['AssertionError', 'Exception'], ['RuntimeError', 'Exception'], ['RecursionError', 'RuntimeError'], ['NotImplementedError', 'RuntimeError'], ['StopIteration', 'Exception'], ['MemoryError', 'Exception']];
for (const [n, b] of EXC) mk(n, T[b]);
export const EXCEPTION_NAMES = ['BaseException', 'Exception', ...EXC.map(([n]) => n)];
// Not offered to programs by name: it marks where this sandbox stops, so it must
// never read as the learner's own error or as something real Python raises.
mk('SandboxLimit', T.Exception);

export class PyRaise { exc: PyInstance; constructor(exc: PyInstance) { this.exc = exc; } }
export const makeExc = (cls: PyClass, args: Val[]) => { const e = new PyInstance(cls); e.attrs.set('args', new PyTuple(args)); return e; };
export const raise = (type: string, msg: string): never => { throw new PyRaise(makeExc(T[type], [msg])); };

// Set by the VM so repr, == and < can reach a class's __repr__, __eq__, __lt__.
export const hooks: { dunder: (o: PyInstance, name: string, args: Val[]) => Val | undefined; charge: (n: number) => void } = { dunder: () => undefined, charge: () => {} };

export function typeOf(v: Val): PyClass {
  if (v === null) return T.NoneType;
  switch (typeof v) {
    case 'bigint': return T.int;
    case 'number': return T.float;
    case 'boolean': return T.bool;
    case 'string': return T.str;
  }
  if (v instanceof PyList) return T.list;
  if (v instanceof PyTuple) return T.tuple;
  if (v instanceof PyDict) return T.dict;
  if (v instanceof PySet) return T.set;
  if (v instanceof PyRange) return T.range;
  if (v instanceof PyFunction) return T.function;
  if (v instanceof PyBuiltin) return T.builtin_function_or_method;
  if (v instanceof PyBound) return T.method;
  if (v instanceof PyClass) return T.type;
  if (v instanceof PyInstance) return v.cls;
  if (v instanceof PySlice) return T.slice;
  if (v instanceof PySuper) return T.super;
  return T.iterator;
}
export const tname = (v: Val): string => {
  if (v instanceof PyIter) return v.kind;
  if (v instanceof PyView) return `dict_${v.kind}`;
  return typeOf(v).name;
};

// Strings index by code point in Python and by UTF-16 unit in JavaScript. The
// fast path matters: this is called on every s[i] in a loop.
const ASTRAL = /[\uD800-\uDBFF]/;
export const chars = (s: string): string[] => (ASTRAL.test(s) ? Array.from(s) : s.split(''));
export const strLen = (s: string) => (ASTRAL.test(s) ? Array.from(s).length : s.length);

export function floatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (!Number.isFinite(x)) return x < 0 ? '-inf' : 'inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  // toExponential() with no argument gives the same shortest round-trip digits
  // Python's repr uses. The two only differ in where they switch to exponents.
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x.toExponential())!;
  const sign = m[1], digits = m[2] + (m[3] ?? ''), exp = Number(m[4]);
  if (exp >= -4 && exp < 16) {
    if (exp < 0) return `${sign}0.${'0'.repeat(-exp - 1)}${digits}`;
    const whole = digits.slice(0, exp + 1).padEnd(exp + 1, '0'), frac = digits.slice(exp + 1);
    return `${sign}${whole}.${frac || '0'}`;
  }
  const e = Math.abs(exp).toString().padStart(2, '0');
  return `${sign}${digits[0]}${digits.length > 1 ? '.' + digits.slice(1) : ''}e${exp < 0 ? '-' : '+'}${e}`;
}

function strRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const c of s) {
    if (c === '\\') out += '\\\\';
    else if (c === q) out += '\\' + c;
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r') out += '\\r';
    else if (c < ' ' || c === '\x7f') out += '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0');
    else out += c;
  }
  return out + q;
}

// Python 3.11 added this limit, so print(2 ** 20000) is an error there. Showing
// the number here would teach something the real interpreter refuses to do.
const MAX_STR_DIGITS = 4300n;
export function intStr(v: bigint): string {
  const abs = v < 0n ? -v : v;
  if (abs >= 10n ** MAX_STR_DIGITS) raise('ValueError', `Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion; use sys.set_int_max_str_digits() to increase the limit`);
  return v.toString();
}

export function repr(v: Val, seen: Set<object> = new Set()): string {
  if (v === null) return 'None';
  switch (typeof v) {
    case 'bigint': return intStr(v);
    case 'number': return floatRepr(v);
    case 'boolean': return v ? 'True' : 'False';
    case 'string': return strRepr(v);
  }
  if (v instanceof PyList || v instanceof PyTuple || v instanceof PyDict || v instanceof PySet) {
    if (seen.has(v)) return v instanceof PyList ? '[...]' : v instanceof PyTuple ? '(...)' : '{...}';
    seen.add(v);
    try {
      if (v instanceof PyList) return `[${v.items.map((x) => repr(x, seen)).join(', ')}]`;
      if (v instanceof PyTuple) return v.items.length === 1 ? `(${repr(v.items[0], seen)},)` : `(${v.items.map((x) => repr(x, seen)).join(', ')})`;
      if (v instanceof PyDict) return `{${[...v.map.values()].map(([k, x]) => `${repr(k, seen)}: ${repr(x, seen)}`).join(', ')}}`;
      return v.map.size ? `{${[...v.map.values()].map((x) => repr(x, seen)).join(', ')}}` : 'set()';
    } finally { seen.delete(v); }
  }
  if (v instanceof PyRange) return v.step === 1n ? `range(${v.start}, ${v.stop})` : `range(${v.start}, ${v.stop}, ${v.step})`;
  if (v instanceof PyView) return `dict_${v.kind}(${repr(new PyList(viewItems(v)), seen)})`;
  if (v instanceof PyFunction) return `<function ${v.code.qualname} at 0x7f00000000>`;
  if (v instanceof PyBuiltin) return `<built-in function ${v.name}>`;
  if (v instanceof PyBound) return `<bound method ${repr(v.fn)}>`;
  if (v instanceof PyClass) return v.builtin ? `<class '${v.name}'>` : `<class '__main__.${v.name}'>`;
  if (v instanceof PySlice) return `slice(${repr(v.lo)}, ${repr(v.hi)}, ${repr(v.step)})`;
  if (v instanceof PyIter) return `<${v.kind} object at 0x7f00000000>`;
  if (v instanceof PySuper) return '<super object>';
  const custom = hooks.dunder(v, '__repr__', []);
  if (custom !== undefined) {
    if (typeof custom !== 'string') raise('TypeError', `__repr__ returned non-string (type ${tname(custom)})`);
    return custom as string;
  }
  if (v.cls.isSub(T.BaseException)) {
    const a = v.attrs.get('args') as PyTuple;
    return `${v.cls.name}(${a.items.map((x) => repr(x)).join(', ')})`;
  }
  return `<__main__.${v.cls.name} object at 0x7f${v.id.toString(16).padStart(8, '0')}>`;
}

export function str(v: Val): string {
  if (typeof v === 'string') return v;
  if (v instanceof PyInstance) {
    const custom = hooks.dunder(v, '__str__', []);
    if (custom !== undefined) {
      if (typeof custom !== 'string') raise('TypeError', `__str__ returned non-string (type ${tname(custom)})`);
      return custom as string;
    }
    if (v.cls.isSub(T.BaseException)) {
      const a = (v.attrs.get('args') as PyTuple).items;
      if (a.length === 0) return '';
      if (a.length > 1) return repr(new PyTuple(a));
      // KeyError shows the key's repr: str(KeyError('a')) is "'a'".
      return v.cls.isSub(T.KeyError) ? repr(a[0]) : str(a[0]);
    }
  }
  return repr(v);
}

export const viewItems = (v: PyView): Val[] => {
  const es = [...v.d.map.values()];
  return v.kind === 'keys' ? es.map(([k]) => k) : v.kind === 'values' ? es.map(([, x]) => x) : es.map(([k, x]) => new PyTuple([k, x]));
};

export function truthy(v: Val): boolean {
  if (v === null || v === false) return false;
  if (v === true) return true;
  switch (typeof v) {
    case 'bigint': return v !== 0n;
    case 'number': return v !== 0;
    case 'string': return v.length > 0;
  }
  if (v instanceof PyList || v instanceof PyTuple) return v.items.length > 0;
  if (v instanceof PyDict || v instanceof PySet) return v.map.size > 0;
  if (v instanceof PyRange) return v.len > 0n;
  if (v instanceof PyView) return v.d.map.size > 0;
  if (v instanceof PyInstance) {
    const b = hooks.dunder(v, '__bool__', []);
    if (b !== undefined) return truthy(b);
    const l = hooks.dunder(v, '__len__', []);
    if (l !== undefined) return truthy(l);
  }
  return true;
}

const isNum = (v: Val): v is bigint | number | boolean => typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean';
const num = (v: bigint | number | boolean): bigint | number => (typeof v === 'boolean' ? (v ? 1n : 0n) : v);

export function eq(a: Val, b: Val): boolean {
  if (a === b) return !(typeof a === 'number' && Number.isNaN(a));
  // bigint == number compares exact values, which is Python's rule.
  if (isNum(a) && isNum(b)) return num(a) == num(b);
  if (a instanceof PyInstance) { const r = hooks.dunder(a, '__eq__', [b]); if (r !== undefined) return truthy(r); return false; }
  if (b instanceof PyInstance) { const r = hooks.dunder(b, '__eq__', [a]); if (r !== undefined) return truthy(r); return false; }
  if (a instanceof PyList && b instanceof PyList || a instanceof PyTuple && b instanceof PyTuple) {
    const x = (a as PyList).items, y = (b as PyList).items;
    if (x.length !== y.length) return false;
    hooks.charge(x.length);
    return x.every((v, i) => eq(v, y[i]));
  }
  if (a instanceof PyDict && b instanceof PyDict) {
    if (a.map.size !== b.map.size) return false;
    for (const [k, [, v]] of a.map) { const o = b.map.get(k); if (!o || !eq(v, o[1])) return false; }
    return true;
  }
  if (a instanceof PySet && b instanceof PySet) {
    if (a.map.size !== b.map.size) return false;
    for (const k of a.map.keys()) if (!b.map.has(k)) return false;
    return true;
  }
  if (a instanceof PyRange && b instanceof PyRange) return a.len === b.len && (a.len === 0n || (a.start === b.start && (a.len === 1n || a.step === b.step)));
  return false;
}

const lexi = (x: number[], y: number[]) => { for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; };
const cmpResult = (op: string, c: number) => (op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : c >= 0);

export function compare(op: '<' | '<=' | '>' | '>=', a: Val, b: Val): boolean {
  if (isNum(a) && isNum(b)) {
    const x = num(a), y = num(b);
    return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
  }
  if (typeof a === 'string' && typeof b === 'string') {
    if (ASTRAL.test(a) || ASTRAL.test(b)) return cmpResult(op, lexi(Array.from(a).map((c) => c.codePointAt(0)!), Array.from(b).map((c) => c.codePointAt(0)!)));
    return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
  }
  if ((a instanceof PyList && b instanceof PyList) || (a instanceof PyTuple && b instanceof PyTuple)) {
    const x = (a as PyList).items, y = (b as PyList).items;
    for (let i = 0; i < Math.min(x.length, y.length); i++) { hooks.charge(1); if (!eq(x[i], y[i])) return compare(op, x[i], y[i]); }
    return cmpResult(op, x.length - y.length);
  }
  const names: Record<string, [string, string]> = { '<': ['__lt__', '__gt__'], '<=': ['__le__', '__ge__'], '>': ['__gt__', '__lt__'], '>=': ['__ge__', '__le__'] };
  if (a instanceof PyInstance) { const r = hooks.dunder(a, names[op][0], [b]); if (r !== undefined) return truthy(r); }
  if (b instanceof PyInstance) { const r = hooks.dunder(b, names[op][1], [a]); if (r !== undefined) return truthy(r); }
  return raise('TypeError', `'${op}' not supported between instances of '${tname(a)}' and '${tname(b)}'`);
}

// Keys collapse the way Python's hash and == do: 1, 1.0 and True are one key.
export function hashKey(v: Val): string {
  if (v === null) return 'n';
  switch (typeof v) {
    case 'bigint': return `i${v}`;
    case 'boolean': return v ? 'i1' : 'i0';
    case 'number': return Number.isInteger(v) ? `i${BigInt(v)}` : `f${v}`;
    case 'string': return `s${v}`;
  }
  if (v instanceof PyTuple) return `t(${v.items.map(hashKey).join(',')})`;
  if (v instanceof PyList || v instanceof PyDict || v instanceof PySet) return raise('TypeError', `unhashable type: '${tname(v)}'`);
  if (v instanceof PyInstance) {
    const h = hooks.dunder(v, '__hash__', []);
    if (h !== undefined) return `h${str(h)}`;
    if (v.cls.lookup('__eq__')) return raise('TypeError', `unhashable type: '${v.cls.name}'`);
    return `o${v.id}`;
  }
  if (v instanceof PyClass) return `c${v.name}`;
  if (v instanceof PyFunction) return `F${v.code.qualname}`;
  if (v instanceof PyBuiltin) return `B${v.name}`;
  return raise('TypeError', `unhashable type: '${tname(v)}'`);
}

export const dictSet = (d: PyDict, k: Val, v: Val) => { const key = hashKey(k), cur = d.map.get(key); d.map.set(key, [cur ? cur[0] : k, v]); };
export const setAdd = (s: PySet, v: Val) => { const key = hashKey(v); if (!s.map.has(key)) s.map.set(key, v); };

// ---- arithmetic -----------------------------------------------------------

const MAX_BITS = 4_000_000;
export const MAX_SEQ = 4_000_000;
const tooBig = (): never => raise('SandboxLimit', 'this sandbox stops at very large values, to keep your browser tab alive; real Python would carry on until it ran out of memory');
const bigBits = (v: bigint) => { const a = v < 0n ? -v : v; return a === 0n ? 0 : a.toString(16).length * 4; };

export function toFloat(v: bigint | number): number {
  if (typeof v === 'number') return v;
  const f = Number(v);
  if (!Number.isFinite(f)) raise('OverflowError', 'int too large to convert to float');
  return f;
}

function floatDivMod(a: number, b: number): [number, number] {
  // CPython's float_divmod, not Math.floor(a / b): 1.0 // 0.1 is 9.0 in Python
  // because 0.1 is slightly above a tenth, and a / b rounds that away to 10.
  let mod = a % b, div = (a - mod) / b;
  if (mod !== 0) { if ((b < 0) !== (mod < 0)) { mod += b; div -= 1; } }
  else mod = b < 0 ? -0 : 0;
  let floordiv: number;
  if (div !== 0) { floordiv = Math.floor(div); if (div - floordiv > 0.5) floordiv += 1; }
  else floordiv = (a / b) < 0 ? -0 : 0;
  return [floordiv, mod];
}

export function intFloorDiv(a: bigint, b: bigint): bigint { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; }
export function intMod(a: bigint, b: bigint): bigint { const m = a % b; return m !== 0n && (m < 0n) !== (b < 0n) ? m + b : m; }

const DUNDER: Record<string, string> = { '+': '__add__', '-': '__sub__', '*': '__mul__', '/': '__truediv__', '//': '__floordiv__', '%': '__mod__', '**': '__pow__' };

export function binop(op: string, a0: Val, b0: Val): Val {
  const bad = (): never => raise('TypeError', `unsupported operand type(s) for ${op === '**' ? '** or pow()' : op}: '${tname(a0)}' and '${tname(b0)}'`);
  if (a0 instanceof PyInstance && DUNDER[op]) { const r = hooks.dunder(a0, DUNDER[op], [b0]); if (r !== undefined) return r; }
  if (b0 instanceof PyInstance && DUNDER[op]) { const r = hooks.dunder(b0, DUNDER[op].replace('__', '__r'), [a0]); if (r !== undefined) return r; }
  if (isNum(a0) && isNum(b0)) {
    const a = num(a0), b = num(b0);
    if (typeof a === 'bigint' && typeof b === 'bigint') {
      switch (op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': {
          // BigInt multiplication is what could freeze the tab in a doubling
          // loop, so only here is size checked: bit length costs a conversion.
          if ((a > 2n ** 64n || a < -(2n ** 64n)) && bigBits(a) + bigBits(b) > MAX_BITS) tooBig();
          return a * b;
        }
        case '/': {
          if (b === 0n) raise('ZeroDivisionError', 'division by zero');
          const fa = Number(a), fb = Number(b);
          if (!Number.isFinite(fa) || !Number.isFinite(fb)) raise('OverflowError', 'integer division result too large for a float');
          return fa / fb;
        }
        case '//': if (b === 0n) raise('ZeroDivisionError', 'integer division or modulo by zero'); return intFloorDiv(a, b);
        case '%': if (b === 0n) raise('ZeroDivisionError', 'integer modulo by zero'); return intMod(a, b);
        case '**': {
          if (b < 0n) {
            if (a === 0n) raise('ZeroDivisionError', 'zero to a negative power');
            return Number(a) ** Number(b);
          }
          if (a !== 0n && a !== 1n && a !== -1n && Number(b) * (bigBits(a) - 3) > MAX_BITS) tooBig();
          return a ** b;
        }
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '<<': if (b < 0n) raise('ValueError', 'negative shift count'); if (a !== 0n && b > BigInt(MAX_BITS)) tooBig(); return a << b;
        case '>>': if (b < 0n) raise('ValueError', 'negative shift count'); return a >> b;
      }
      return bad();
    }
    const x = toFloat(a), y = toFloat(b);
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': if (y === 0) raise('ZeroDivisionError', 'float division by zero'); return x / y;
      case '//': if (y === 0) raise('ZeroDivisionError', 'float floor division by zero'); return floatDivMod(x, y)[0];
      case '%': if (y === 0) raise('ZeroDivisionError', 'float modulo'); return floatDivMod(x, y)[1];
      case '**': {
        if (x === 0 && y < 0) raise('ZeroDivisionError', 'zero to a negative power');
        if (x < 0 && !Number.isInteger(y) && Number.isFinite(y)) raise('SandboxLimit', 'a negative number to a fractional power is a complex number in real Python; this sandbox has no complex numbers');
        const r = x ** y;
        if (!Number.isFinite(r) && Number.isFinite(x) && Number.isFinite(y)) raise('OverflowError', "(34, 'Numerical result out of range')");
        return r;
      }
    }
    return bad();
  }
  if (op === '+') {
    if (typeof a0 === 'string' && typeof b0 === 'string') { hooks.charge(a0.length + b0.length); return a0 + b0; }
    if (typeof a0 === 'string') return raise('TypeError', `can only concatenate str (not "${tname(b0)}") to str`);
    if (a0 instanceof PyList) { if (!(b0 instanceof PyList)) return raise('TypeError', `can only concatenate list (not "${tname(b0)}") to list`); hooks.charge(a0.items.length + b0.items.length); return new PyList([...a0.items, ...b0.items]); }
    if (a0 instanceof PyTuple) { if (!(b0 instanceof PyTuple)) return raise('TypeError', `can only concatenate tuple (not "${tname(b0)}") to tuple`); hooks.charge(a0.items.length + b0.items.length); return new PyTuple([...a0.items, ...b0.items]); }
    return bad();
  }
  if (op === '*') {
    const seq = typeof a0 === 'bigint' || typeof a0 === 'boolean' ? b0 : a0;
    const n = seq === a0 ? b0 : a0;
    if (typeof n === 'bigint' || typeof n === 'boolean') {
      const c = Math.max(0, Number(num(n)));
      if (typeof seq === 'string') { if (seq.length * c > MAX_SEQ) tooBig(); hooks.charge(seq.length * c); return seq.repeat(c); }
      if (seq instanceof PyList || seq instanceof PyTuple) {
        if (seq.items.length * c > MAX_SEQ) tooBig();
        hooks.charge(seq.items.length * c);
        const out: Val[] = [];
        for (let i = 0; i < c; i++) for (const x of seq.items) out.push(x);
        return seq instanceof PyList ? new PyList(out) : new PyTuple(out);
      }
    }
    if (typeof seq === 'string' || seq instanceof PyList || seq instanceof PyTuple) return raise('TypeError', `can't multiply sequence by non-int of type '${tname(n)}'`);
    return bad();
  }
  if (a0 instanceof PySet && b0 instanceof PySet) {
    const out = new PySet();
    if (op === '|') { for (const [k, v] of a0.map) out.map.set(k, v); for (const [k, v] of b0.map) if (!out.map.has(k)) out.map.set(k, v); return out; }
    if (op === '&') { for (const [k, v] of a0.map) if (b0.map.has(k)) out.map.set(k, v); return out; }
    if (op === '-') { for (const [k, v] of a0.map) if (!b0.map.has(k)) out.map.set(k, v); return out; }
  }
  if (op === '%' && typeof a0 === 'string') return raise('SandboxLimit', 'real Python has % string formatting; this sandbox does not yet. Use an f-string');
  return bad();
}

export function unary(op: string, v: Val): Val {
  if (isNum(v)) {
    const x = num(v);
    if (op === '-') return -x;
    if (op === '+') return x;
    if (op === '~' && typeof x === 'bigint') return ~x;
  }
  if (v instanceof PyInstance) { const r = hooks.dunder(v, op === '-' ? '__neg__' : op === '+' ? '__pos__' : '__invert__', []); if (r !== undefined) return r; }
  return raise('TypeError', `bad operand type for unary ${op}: '${tname(v)}'`);
}

// toFixed breaks ties upward; Python's format breaks exact ties to even, so
// f"{0.125:.2f}" is 0.12 there. Testing x * 10**p for .5 would be fooled: 2.675
// is just below that, its product rounds to 267.5, and Python's answer is 2.67.
// x * 10**p = n * 5**p * 2**p / 2**k with n odd, so it is a tie exactly when x
// has p + 1 binary fractional digits. Doubling a float is exact.
export function fixed(x: number, p: number): string {
  let v = Math.abs(x), k = 0;
  while (v !== Math.floor(v) && k <= p + 1) { v *= 2; k++; }
  if (k !== p + 1 || v !== Math.floor(v)) return x.toFixed(p);
  const lower = (BigInt(v) * 5n ** BigInt(p) - 1n) / 2n;
  const even = lower % 2n === 0n ? lower : lower + 1n;
  const digits = even.toString().padStart(p + 1, '0');
  const whole = digits.slice(0, digits.length - p), frac = digits.slice(digits.length - p);
  return (x < 0 ? '-' : '') + whole + (p ? `.${frac}` : '');
}

export function format(v: Val, spec: string): string {
  if (!spec) return str(v);
  const m = /^(?:(.)?([<>^=]))?([-+ ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/.exec(spec);
  if (!m) return raise('ValueError', `Invalid format specifier '${spec}' for object of type '${tname(v)}'`);
  const [, fill, align, sign, alt, zero, width, group, prec, type] = m;
  let body: string, neg = false, numeric = false;
  if (isNum(v) && type !== 's') {
    numeric = true;
    const x = num(v);
    const f = typeof x === 'number' ? x : Number(x);
    if (typeof x === 'bigint' && (!type || 'bdoxX'.includes(type))) {
      if (prec !== undefined) return raise('ValueError', 'Precision not allowed in integer format specifier');
      const a = x < 0n ? -x : x; neg = x < 0n;
      body = type === 'b' ? a.toString(2) : type === 'o' ? a.toString(8) : type === 'x' ? a.toString(16) : type === 'X' ? a.toString(16).toUpperCase() : a.toString();
      if (alt) body = (type === 'b' ? '0b' : type === 'o' ? '0o' : type === 'x' ? '0x' : type === 'X' ? '0X' : '') + body;
    } else {
      neg = f < 0 || Object.is(f, -0);
      const a = Math.abs(f), p = prec === undefined ? 6 : Number(prec);
      if (!Number.isFinite(a)) body = Number.isNaN(a) ? 'nan' : 'inf';
      else if (type === 'f' || type === 'F') body = fixed(a, p);
      else if (type === '%') body = fixed(a * 100, p) + '%';
      else if (type === 'e' || type === 'E') { body = a.toExponential(p).replace(/e([+-])(\d)$/, 'e$10$2'); if (type === 'E') body = body.toUpperCase(); }
      else if (!type && prec === undefined) body = floatRepr(a);
      else return raise('SandboxLimit', `real Python has the format spec '${spec}'; this sandbox does not yet`);
    }
    if (group) { const [i, ...r] = body.split('.'); body = [i.replace(/\B(?=(\d{3})+(?!\d))/g, group), ...r].join('.'); }
  } else {
    if (v === null || v instanceof PyList || v instanceof PyTuple || v instanceof PyDict) return raise('TypeError', `unsupported format string passed to ${tname(v)}.__format__`);
    if (type && type !== 's') return raise('ValueError', `Unknown format code '${type}' for object of type '${tname(v)}'`);
    body = str(v);
    if (prec !== undefined) body = body.slice(0, Number(prec));
  }
  const signStr = neg ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '';
  const w = Number(width ?? 0), pad = Math.max(0, w - strLen(body) - signStr.length);
  const f = fill ?? (zero ? '0' : ' ');
  const a = align ?? (zero ? '=' : numeric ? '>' : '<');
  if (a === '=') return signStr + f.repeat(pad) + body;
  if (a === '<') return signStr + body + f.repeat(pad);
  if (a === '^') { const l = Math.floor(pad / 2); return f.repeat(l) + signStr + body + f.repeat(pad - l); }
  return f.repeat(pad) + signStr + body;
}
