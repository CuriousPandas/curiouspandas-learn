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
export class PyFunction { code: Code; defaults: Val[]; env: Env; owner?: PyClass; attrs?: Map<string, Val>; constructor(code: Code, defaults: Val[], env: Env) { this.code = code; this.defaults = defaults; this.env = env; } }
export class PyBuiltin {
  name: string; fn: (args: Val[], kw: Map<string, Val>) => Val;
  // Only for how it prints and what type() says: "abc".upper and str.upper are different
  // kinds of thing in Python, and a program can print either.
  self?: Val; descr?: string;
  constructor(name: string, fn: (args: Val[], kw: Map<string, Val>) => Val) { this.name = name; this.fn = fn; }
}
export class PyBound { self: Val; fn: Val; constructor(self: Val, fn: Val) { this.self = self; this.fn = fn; } }
export class PySuper { cls: PyClass | null; self: Val; constructor(cls: PyClass | null, self: Val) { this.cls = cls; this.self = self; } }
export class PyClass {
  name: string; base: PyClass | null; attrs = new Map<string, Val>();
  builtin: boolean;
  /** A.B for a class inside a class: how it prints, as real Python prints it. */
  qualname: string;
  constructor(name: string, base: PyClass | null, builtin = false) { this.name = name; this.base = base; this.builtin = builtin; this.qualname = name; }
  lookup(n: string): Val | undefined { for (let c: PyClass | null = this; c; c = c.base) { const v = c.attrs.get(n); if (v !== undefined) return v; } return undefined; }
  isSub(o: PyClass) { for (let c: PyClass | null = this; c; c = c.base) if (c === o) return true; return false; }
}
let nextId = 0;
export class PyInstance {
  cls: PyClass; attrs = new Map<string, Val>(); id: number;
  // On the exception, as in CPython, so a re-raise keeps the frames it already
  // passed through and the traceback still points at where it started.
  tb?: { fn: string; line: number; file?: string }[];
  // The exception being handled when this one was raised.
  context?: PyInstance;
  constructor(cls: PyClass) { this.cls = cls; this.id = ++nextId; }
}
// next() returns undefined when exhausted; undefined is never a Python value.
export class PyIter { kind: string; next: () => Val | undefined; constructor(kind: string, next: () => Val | undefined) { this.kind = kind; this.next = next; } }
export class PyView { kind: 'keys' | 'values' | 'items'; d: PyDict; constructor(kind: 'keys' | 'values' | 'items', d: PyDict) { this.kind = kind; this.d = d; } }

export type Val = bigint | number | boolean | string | null | PyList | PyTuple | PyDict | PySet | PyRange | PySlice | PyFunction | PyBuiltin | PyBound | PySuper | PyClass | PyInstance | PyIter | PyView;

export const T: Record<string, PyClass> = Object.create(null);
const mk = (name: string, base: PyClass | null) => (T[name] = new PyClass(name, base, true));
mk('object', null);
for (const n of ['int', 'float', 'str', 'list', 'tuple', 'dict', 'set', 'range', 'NoneType', 'function', 'builtin_function_or_method', 'method', 'method_descriptor', 'type', 'slice', 'super', 'enumerate', 'zip', 'map', 'filter', 'reversed']) mk(n, T.object);
mk('bool', T.int);
mk('BaseException', T.object);
mk('Exception', T.BaseException);
// The whole family a program can name in an except clause, even the ones nothing here
// raises: `except FileNotFoundError:` was a NameError, on code that is correct. Left out
// on purpose, and refused by name in vm.ts: SystemExit, which has to end a program with
// no error, and the Syntax and Unicode errors, whose constructors take fields this lacks.
const EXC: [string, string][] = [
  ['EOFError', 'Exception'], ['ArithmeticError', 'Exception'], ['ZeroDivisionError', 'ArithmeticError'], ['OverflowError', 'ArithmeticError'], ['FloatingPointError', 'ArithmeticError'],
  ['LookupError', 'Exception'], ['IndexError', 'LookupError'], ['KeyError', 'LookupError'], ['NameError', 'Exception'], ['UnboundLocalError', 'NameError'],
  ['TypeError', 'Exception'], ['ValueError', 'Exception'], ['UnicodeError', 'ValueError'], ['AttributeError', 'Exception'], ['AssertionError', 'Exception'],
  ['RuntimeError', 'Exception'], ['RecursionError', 'RuntimeError'], ['NotImplementedError', 'RuntimeError'], ['StopIteration', 'Exception'], ['StopAsyncIteration', 'Exception'], ['MemoryError', 'Exception'],
  ['BufferError', 'Exception'], ['ReferenceError', 'Exception'], ['SystemError', 'Exception'], ['ImportError', 'Exception'], ['ModuleNotFoundError', 'ImportError'],
  ['OSError', 'Exception'], ['BlockingIOError', 'OSError'], ['ChildProcessError', 'OSError'], ['ConnectionError', 'OSError'], ['BrokenPipeError', 'ConnectionError'], ['ConnectionAbortedError', 'ConnectionError'],
  ['ConnectionRefusedError', 'ConnectionError'], ['ConnectionResetError', 'ConnectionError'], ['FileExistsError', 'OSError'], ['FileNotFoundError', 'OSError'], ['InterruptedError', 'OSError'],
  ['IsADirectoryError', 'OSError'], ['NotADirectoryError', 'OSError'], ['PermissionError', 'OSError'], ['ProcessLookupError', 'OSError'], ['TimeoutError', 'OSError'],
  ['KeyboardInterrupt', 'BaseException'], ['GeneratorExit', 'BaseException'], ['Warning', 'Exception'], ['BytesWarning', 'Warning'], ['DeprecationWarning', 'Warning'], ['EncodingWarning', 'Warning'],
  ['FutureWarning', 'Warning'], ['ImportWarning', 'Warning'], ['PendingDeprecationWarning', 'Warning'], ['ResourceWarning', 'Warning'], ['RuntimeWarning', 'Warning'], ['SyntaxWarning', 'Warning'], ['UnicodeWarning', 'Warning'], ['UserWarning', 'Warning'],
];
for (const [n, b] of EXC) mk(n, T[b]);
export const EXCEPTION_NAMES = ['BaseException', 'Exception', ...EXC.map(([n]) => n)];
// Two spellings of one class in real Python: `IOError is OSError` is true there.
export const EXCEPTION_ALIASES: Record<string, string> = { IOError: 'OSError', EnvironmentError: 'OSError' };

// Where this sandbox stops. Thrown past every except clause, and that is the point:
// `except Exception:` used to catch it, so a program whose try block reached something
// this sandbox lacks took its except branch and printed a confident wrong answer.
export class SandboxStop { message: string; constructor(message: string) { this.message = message; } }

export class PyRaise {
  exc: PyInstance;
  // A bare `raise` or an unmatched except carries on with the same exception, and
  // CPython adds no traceback entry for the frame doing that. `raise e` does add one.
  again: boolean;
  constructor(exc: PyInstance, again = false) { this.exc = exc; this.again = again; }
}
export const makeExc = (cls: PyClass, args: Val[]) => { const e = new PyInstance(cls); e.attrs.set('args', new PyTuple(args)); return e; };
export const raise = (type: string, msg: string): never => {
  if (type === 'SandboxLimit') throw new SandboxStop(msg);
  throw new PyRaise(makeExc(T[type], [msg]));
};

// Set by the VM so repr, == and < can reach a class's __repr__, __eq__, __lt__, and a
// dict view's | and & can walk whatever iterable is on the other side.
export const hooks: { dunder: (o: PyInstance, name: string, args: Val[]) => Val | undefined; charge: (n: number) => void; list: (v: Val) => Val[] } = { dunder: () => undefined, charge: () => {}, list: () => [] };

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
  if (v instanceof PyBuiltin) return v.descr ? T.method_descriptor : T.builtin_function_or_method;
  if (v instanceof PyBound) return T.method;
  if (v instanceof PyClass) return T.type;
  if (v instanceof PyInstance) return v.cls;
  if (v instanceof PySlice) return T.slice;
  if (v instanceof PySuper) return T.super;
  // type(enumerate("a")) printed <class 'iterator'>, a type real Python doesn't have.
  const named = v instanceof PyView ? `dict_${v.kind}` : (v as PyIter).kind;
  return T[named] ?? mk(named, T.object);
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

// What str.isprintable calls not printable, and repr writes as an escape: the invisible
// joiner inside an emoji family has to show in a list, and would look absent otherwise.
const UNPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;
export const isPrintable = (c: string) => c === ' ' || !UNPRINTABLE.test(c);

function strRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const c of s) {
    if (c === '\\') out += '\\\\';
    else if (c === q) out += '\\' + c;
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r') out += '\\r';
    else if (isPrintable(c)) out += c;
    else {
      const n = c.codePointAt(0)!;
      out += n < 0x100 ? '\\x' + n.toString(16).padStart(2, '0') : n < 0x10000 ? '\\u' + n.toString(16).padStart(4, '0') : '\\U' + n.toString(16).padStart(8, '0');
    }
  }
  return out + q;
}

// Python 3.11 added this limit, so print(2 ** 20000) is an error there. Showing
// the number here would teach something the real interpreter refuses to do.
export const MAX_STR_DIGITS = 4300n;
const INT_STR_FAST = 2n ** 64n;
export function intStr(v: bigint): string {
  const abs = v < 0n ? -v : v;
  if (abs >= INT_STR_FAST && abs >= 10n ** MAX_STR_DIGITS) raise('ValueError', `Exceeds the limit (${MAX_STR_DIGITS} digits) for integer string conversion; use sys.set_int_max_str_digits() to increase the limit`);
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
  if (v instanceof PyBuiltin) {
    if (v.descr) return `<method '${v.name}' of '${v.descr}' objects>`;
    return v.self === undefined ? `<built-in function ${v.name}>` : `<built-in method ${v.name} of ${tname(v.self)} object at 0x7f00000000>`;
  }
  if (v instanceof PyBound) return `<bound method ${v.fn instanceof PyFunction ? v.fn.code.qualname : repr(v.fn)} of ${repr(v.self, seen)}>`;
  if (v instanceof PyClass) return v.builtin ? `<class '${v.name}'>` : `<class '__main__.${v.qualname}'>`;
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
  return `<${v.cls.builtin ? v.cls.name : `__main__.${v.cls.qualname}`} object at 0x7f${v.id.toString(16).padStart(8, '0')}>`;
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
    if (b !== undefined) {
      if (typeof b !== 'boolean') raise('TypeError', `__bool__ should return bool, returned ${tname(b)}`);
      return b as boolean;
    }
    const l = lenHook(v);
    if (l !== undefined) return l > 0n;
  }
  return true;
}

/** What __len__ gave, checked the way len() and truth testing both check it. */
export function lenHook(v: PyInstance): bigint | undefined {
  const l = hooks.dunder(v, '__len__', []);
  if (l === undefined) return undefined;
  if (typeof l !== 'bigint' && typeof l !== 'boolean') return raise('TypeError', `'${tname(l)}' object cannot be interpreted as an integer`);
  const n = typeof l === 'boolean' ? (l ? 1n : 0n) : l as bigint;
  if (n < 0n) raise('ValueError', '__len__() should return >= 0');
  return n;
}

const isNum =(v: Val): v is bigint | number | boolean => typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean';
const num = (v: bigint | number | boolean): bigint | number => (typeof v === 'boolean' ? (v ? 1n : 0n) : v);

export function eq(a: Val, b: Val): boolean {
  if (a === b) return !(typeof a === 'number' && Number.isNaN(a));
  // bigint == number compares exact values, which is Python's rule.
  if (isNum(a) && isNum(b)) return num(a) == num(b);
  // A left side with no __eq__ of its own still asks the right side, as Python does.
  if (a instanceof PyInstance) { const r = hooks.dunder(a, '__eq__', [b]); if (r !== undefined) return truthy(r); }
  if (b instanceof PyInstance) { const r = hooks.dunder(b, '__eq__', [a]); if (r !== undefined) return truthy(r); return false; }
  if (a instanceof PyInstance) return false;
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
  // d.keys() == e.keys() was False for two equal dictionaries, because a view compared by
  // identity. Keys and items compare as sets. Values really do compare by identity.
  const x = setLike(a), y = setLike(b);
  if (x && y) {
    if (x.size !== y.size) return false;
    for (const k of x.keys()) if (!y.has(k)) return false;
    return true;
  }
  return false;
}

/** A set, or a dict view that behaves as one: its hash keys, or undefined for anything else. */
function setLike(v: Val): Map<string, Val> | undefined {
  if (v instanceof PySet) return v.map;
  if (v instanceof PyView && v.kind !== 'values') {
    const m = new Map<string, Val>();
    for (const x of viewItems(v)) m.set(hashKey(x), x);
    return m;
  }
  return undefined;
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
  // {1} < {1, 2} is a question about subsets, and it was a TypeError on correct code.
  const p = setLike(a), q = setLike(b);
  if (p && q) {
    const inside = (m: Map<string, Val>, n: Map<string, Val>) => { for (const k of m.keys()) if (!n.has(k)) return false; return true; };
    if (op === '<') return p.size < q.size && inside(p, q);
    if (op === '<=') return inside(p, q);
    if (op === '>') return p.size > q.size && inside(q, p);
    return inside(q, p);
  }
  const names: Record<string, [string, string]> = { '<': ['__lt__', '__gt__'], '<=': ['__le__', '__ge__'], '>': ['__gt__', '__lt__'], '>=': ['__ge__', '__le__'] };
  if (a instanceof PyInstance) { const r = hooks.dunder(a, names[op][0], [b]); if (r !== undefined) return truthy(r); }
  if (b instanceof PyInstance) { const r = hooks.dunder(b, names[op][1], [a]); if (r !== undefined) return truthy(r); }
  return raise('TypeError', `'${op}' not supported between instances of '${tname(a)}' and '${tname(b)}'`);
}

// An equal hash doesn't make two keys the same key: == decides. Using the hash
// alone as the key silently merged every colliding key into one, so a dict of
// five keys sharing a __hash__ had length 1 and answered True for keys it never
// held. Each class keeps its own list per hash value, which dies with the program.
// The scan is what real Python's collisions cost in kind, but not in exact count:
// this finds a key in the order keys first appeared, so n colliding inserts make
// n(n-1)/2 __eq__ calls here, while CPython's probing makes a slightly different
// number. src/lib/cs/hashtable.ts holds the exact model.
const collisions = new WeakMap<PyClass, Map<string, PyInstance[]>>();
function collidingKey(v: PyInstance, h: string): string {
  let owner = v.cls;
  for (let c: PyClass | null = v.cls; c; c = c.base) if (c.attrs.has('__hash__')) { owner = c; break; }
  let table = collisions.get(owner);
  if (!table) collisions.set(owner, table = new Map());
  let keys = table.get(h);
  if (!keys) table.set(h, keys = []);
  for (let i = 0; i < keys.length; i++) if (keys[i] === v || eq(keys[i], v)) return `h${h}#${i}`;
  keys.push(v);
  return `h${h}#${keys.length - 1}`;
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
  // Each part carries its length: joined bare, ("a,sb",) and ("a", "b") were one key.
  if (v instanceof PyTuple) return `t(${v.items.map((x) => { const k = hashKey(x); return `${k.length}:${k}`; }).join(',')})`;
  // Keys and items views aren't hashable, and a values view is, by identity. Python's own quirk.
  if (v instanceof PyList || v instanceof PyDict || v instanceof PySet || (v instanceof PyView && v.kind !== 'values')) return raise('TypeError', `unhashable type: '${tname(v)}'`);
  // Python 3.12 made slices hashable, by what they hold.
  if (v instanceof PySlice) return `S(${[v.lo, v.hi, v.step].map(hashKey).join(',')})`;
  if (v instanceof PyInstance) {
    const h = hooks.dunder(v, '__hash__', []);
    if (h !== undefined) return collidingKey(v, str(h));
    if (v.cls.lookup('__eq__')) return raise('TypeError', `unhashable type: '${v.cls.name}'`);
    return `o${v.id}`;
  }
  if (v instanceof PyRange) return v.len === 0n ? 'r0' : v.len === 1n ? `r1,${v.start}` : `r${v.len},${v.start},${v.step}`;
  // By identity: by name, two different functions called f were one key.
  return `o#${objectId(v)}`;
}

const objectIds = new WeakMap<object, number>();
let nextObjectId = 0;
export function objectId(v: object): number {
  let i = objectIds.get(v);
  if (i === undefined) objectIds.set(v, i = ++nextObjectId);
  return i;
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
  else floordiv = (a / b) < 0 || Object.is(a / b, -0) ? -0 : 0;
  return [floordiv, mod];
}

export function intFloorDiv(a: bigint, b: bigint): bigint { const q = a / b; return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q; }
export function intMod(a: bigint, b: bigint): bigint { const m = a % b; return m !== 0n && (m < 0n) !== (b < 0n) ? m + b : m; }

export const DUNDER: Record<string, string> = { '+': '__add__', '-': '__sub__', '*': '__mul__', '/': '__truediv__', '//': '__floordiv__', '%': '__mod__', '**': '__pow__', '&': '__and__', '|': '__or__', '^': '__xor__', '<<': '__lshift__', '>>': '__rshift__', '@': '__matmul__' };

const bitLength = (v: bigint) => (v === 0n ? 0 : v.toString(2).length);
// Correctly rounded, as CPython's is. Number(a) / Number(b) called 10 ** 400 / 10 ** 399
// an overflow when the answer is 10.0, and rounded twice for anything above 2 ** 53.
function intTrueDiv(a: bigint, b: bigint): number {
  const LIMIT = 1n << 53n, abs = (v: bigint) => (v < 0n ? -v : v), x = abs(a), y = abs(b);
  if (x <= LIMIT && y <= LIMIT) return Number(a) / Number(b);
  // A quotient of 66 bits or more, with a sticky bit for whatever the division left over,
  // so Number() rounds it the way the exact fraction would round.
  const shift = bitLength(y) - bitLength(x) + 66;
  const num = shift >= 0 ? x << BigInt(shift) : x, den = shift >= 0 ? y : y << BigInt(-shift);
  let q = num / den;
  if (q * den !== num) q |= 1n;
  // Two factors, because 2 ** shift alone can leave a float's range before the result does.
  const half = Math.trunc(shift / 2);
  const r = Number(q) * 2 ** -half * 2 ** -(shift - half);
  if (!Number.isFinite(r)) raise('OverflowError', 'integer division result too large for a float');
  return (a < 0n) !== (b < 0n) ? -r : r;
}

export function binop(op: string, a0: Val, b0: Val): Val {
  const bad = (): never => raise('TypeError', `unsupported operand type(s) for ${op === '**' ? '** or pow()' : op}: '${tname(a0)}' and '${tname(b0)}'`);
  if (a0 instanceof PyInstance && DUNDER[op]) { const r = hooks.dunder(a0, DUNDER[op], [b0]); if (r !== undefined) return r; }
  if (b0 instanceof PyInstance && DUNDER[op]) { const r = hooks.dunder(b0, DUNDER[op].replace('__', '__r'), [a0]); if (r !== undefined) return r; }
  if (isNum(a0) && isNum(b0)) {
    const a = num(a0), b = num(b0);
    // True & False is a bool: & | ^ are the one place two bools stay bools.
    if (typeof a0 === 'boolean' && typeof b0 === 'boolean') {
      if (op === '&') return a0 && b0;
      if (op === '|') return a0 || b0;
      if (op === '^') return a0 !== b0;
    }
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
          return intTrueDiv(a, b);
        }
        case '//': if (b === 0n) raise('ZeroDivisionError', 'integer division or modulo by zero'); return intFloorDiv(a, b);
        case '%': if (b === 0n) raise('ZeroDivisionError', 'integer modulo by zero'); return intMod(a, b);
        case '**': {
          if (b < 0n) {
            if (a === 0n) raise('ZeroDivisionError', 'zero to a negative power');
            return toFloat(a) ** toFloat(b);
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
      const count = num(n) as bigint;
      // [] * 10 ** 30 froze the tab here: nothing to copy, so no size check fired, and a loop
      // of 10 ** 30 passes began. Real Python keeps the count in a machine word, so a count
      // that big is an OverflowError even for an empty list.
      if ((typeof seq === 'string' || seq instanceof PyList || seq instanceof PyTuple) && (count >= 2n ** 63n || count < -(2n ** 63n))) raise('OverflowError', "cannot fit 'int' into an index-sized integer");
      const empty = typeof seq === 'string' ? seq.length === 0 : seq instanceof PyList || seq instanceof PyTuple ? seq.items.length === 0 : false;
      const c = empty ? 0 : Math.max(0, Number(count));
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
  if (a0 instanceof PySet && b0 instanceof PySet) { const r = setOp(op, a0.map, b0.map); if (r) return r; }
  // A dict's keys and items take any iterable on the other side, and give a plain set.
  if ((op === '|' || op === '&' || op === '-' || op === '^') && ((a0 instanceof PyView && a0.kind !== 'values') || (b0 instanceof PyView && b0.kind !== 'values'))) {
    const asMap = (v: Val) => { const m = new Map<string, Val>(); for (const x of hooks.list(v)) m.set(hashKey(x), x); return m; };
    return setOp(op, asMap(a0), asMap(b0))!;
  }
  if (a0 instanceof PyDict && b0 instanceof PyDict && op === '|') {
    const out = new PyDict();
    for (const [k, v] of a0.map.values()) dictSet(out, k, v);
    for (const [k, v] of b0.map.values()) dictSet(out, k, v);
    return out;
  }
  // int | str is a type union, which isinstance accepts and this sandbox doesn't have.
  if (op === '|' && (a0 instanceof PyClass || a0 === null) && (b0 instanceof PyClass || b0 === null) && !(a0 === null && b0 === null)) return raise('SandboxLimit', 'real Python has | between types, as in int | str; this sandbox does not yet. isinstance also takes a tuple: (int, str)');
  if (op === '%' && typeof a0 === 'string') return raise('SandboxLimit', 'real Python has % string formatting; this sandbox does not yet. Use an f-string');
  return bad();
}

function setOp(op: string, a: Map<string, Val>, b: Map<string, Val>): PySet | undefined {
  const out = new PySet();
  if (op === '|') { for (const [k, v] of a) out.map.set(k, v); for (const [k, v] of b) if (!out.map.has(k)) out.map.set(k, v); return out; }
  if (op === '&') { for (const [k, v] of a) if (b.has(k)) out.map.set(k, v); return out; }
  if (op === '-') { for (const [k, v] of a) if (!b.has(k)) out.map.set(k, v); return out; }
  if (op === '^') { for (const [k, v] of a) if (!b.has(k)) out.map.set(k, v); for (const [k, v] of b) if (!a.has(k)) out.map.set(k, v); return out; }
  return undefined;
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
  // toFixed gives up at 1e21 and answers in exponent form: f"{1e30:.2f}" printed 1e+30.
  // A float that size is a whole number, so its digits are exact as an integer.
  if (Math.abs(x) >= 1e21) return (x < 0 ? '-' : '') + BigInt(Math.abs(x)).toString() + (p ? `.${'0'.repeat(p)}` : '');
  let v = Math.abs(x), k = 0;
  while (v !== Math.floor(v) && k <= p + 1) { v *= 2; k++; }
  if (k !== p + 1 || v !== Math.floor(v)) return x.toFixed(p);
  const lower = (BigInt(v) * 5n ** BigInt(p) - 1n) / 2n;
  const even = lower % 2n === 0n ? lower : lower + 1n;
  const digits = even.toString().padStart(p + 1, '0');
  const whole = digits.slice(0, digits.length - p), frac = digits.slice(digits.length - p);
  return (x < 0 ? '-' : '') + whole + (p ? `.${frac}` : '');
}

// x.toExponential(p) breaks exact ties upward, and Python's format breaks them to even, so
// f"{2.5:.0e}" is 2e+00 there. A hundred digits is the exact value for every float a program
// is likely to meet, and more than enough to tell a tie from a near miss.
function expFormat(a: number, p: number): string {
  if (a === 0) return `${(0).toFixed(p)}e+00`;
  const m = /^(\d)\.(\d+)e([+-]\d+)$/.exec(a.toExponential(100))!;
  const digits = m[1] + m[2];
  let e = Number(m[3]);
  const head = digits.slice(0, p + 1), rest = digits.slice(p + 1);
  let n = BigInt(head);
  const half = '5' + '0'.repeat(rest.length - 1);
  if (rest > half || (rest === half && n % 2n === 1n)) n += 1n;
  let shown = n.toString();
  if (shown.length > head.length) { shown = shown.slice(0, head.length); e += 1; }
  const exp = `e${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  return shown[0] + (p > 0 ? `.${shown.slice(1)}` : '') + exp;
}

export function format(v: Val, spec: string): string {
  if (v instanceof PyInstance) {
    const r = hooks.dunder(v, '__format__', [spec]);
    if (r !== undefined) {
      if (typeof r !== 'string') raise('TypeError', `__format__ must return a str, not ${tname(r)}`);
      return r as string;
    }
  }
  if (!spec) return str(v);
  // Only numbers and strings have format specs of their own. Printing str(v) here ignored
  // the spec, so f"{[1]:>5}" was silent where real Python raises.
  if (!isNum(v) && typeof v !== 'string') return raise('TypeError', `unsupported format string passed to ${tname(v)}.__format__`);
  const notYet = (): never => raise('SandboxLimit', `real Python has the format spec '${spec}'; this sandbox does not yet`);
  if (/^(?:.?[<>^=])?[-+ ]?z/su.test(spec)) notYet();
  const m = /^(?:(.)?([<>^=]))?([-+ ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/su.exec(spec);
  if (!m) return raise('ValueError', `Invalid format specifier '${spec}' for object of type '${tname(v)}'`);
  const [, fill, align, sign, alt, zero, width, group, prec, type] = m;
  const unknown = (): never => raise('ValueError', `Unknown format code '${type}' for object of type '${tname(v)}'`);
  let body: string, prefix = '', neg = false;
  if (typeof v === 'string') {
    if (type && type !== 's') unknown();
    if (sign) raise('ValueError', 'Sign not allowed in string format specifier');
    if (alt) raise('ValueError', 'Alternate form (#) not allowed in string format specifier');
    if (align === '=') raise('ValueError', "'=' alignment not allowed in string format specifier");
    if (group) raise('ValueError', `Cannot specify '${group}' with 's'.`);
    body = prec === undefined ? v : Array.from(v).slice(0, Number(prec)).join('');
  } else {
    const x = num(v), isInt = typeof x === 'bigint';
    if (type && !'eEfFgGn%'.includes(type) && !(isInt && 'bcdoxX'.includes(type))) unknown();
    if (type === 'g' || type === 'G' || type === 'n') notYet();
    if (group && zero) notYet();
    if (isInt && (!type || 'bcdoxX'.includes(type))) {
      if (prec !== undefined) return raise('ValueError', 'Precision not allowed in integer format specifier');
      const big = x as bigint;
      neg = big < 0n;
      const abs = neg ? -big : big;
      if (type === 'c') {
        if (sign) raise('ValueError', "Sign not allowed with integer format specifier 'c'");
        if (alt) raise('ValueError', "Alternate form (#) not allowed with integer format specifier 'c'");
        if (group) raise('ValueError', `Cannot specify '${group}' with 'c'.`);
        if (neg || abs > 0x10ffffn) raise('OverflowError', '%c arg not in range(0x110000)');
        body = String.fromCodePoint(Number(abs));
        neg = false;
      } else {
        const radix = type === 'b' ? 2 : type === 'o' ? 8 : type === 'x' || type === 'X' ? 16 : 10;
        if (group === ',' && radix !== 10) raise('ValueError', `Cannot specify ',' with '${type}'.`);
        body = abs.toString(radix);
        if (group) body = body.replace(radix === 10 ? /\B(?=(\d{3})+$)/g : /\B(?=([0-9a-f]{4})+$)/g, group);
        if (type === 'X') body = body.toUpperCase();
        if (alt) prefix = radix === 2 ? '0b' : radix === 8 ? '0o' : type === 'X' ? '0X' : radix === 16 ? '0x' : '';
      }
    } else {
      const f = toFloat(x);
      if (alt || (prec !== undefined && !type)) notYet();
      if (prec !== undefined && Number(prec) > 100) notYet();
      neg = f < 0 || Object.is(f, -0);
      const a = Math.abs(f), p = prec === undefined ? 6 : Number(prec);
      if (!Number.isFinite(a)) {
        body = Number.isNaN(a) ? 'nan' : 'inf';
        if (type === 'E' || type === 'F') body = body.toUpperCase();
        if (type === '%') body += '%';
      }
      else if (type === 'f' || type === 'F') body = fixed(a, p);
      else if (type === '%') body = fixed(a * 100, p) + '%';
      else if (type === 'e' || type === 'E') { body = expFormat(a, p); if (type === 'E') body = body.toUpperCase(); }
      else body = floatRepr(a);
      if (group) { const [i, ...r] = body.split('.'); body = [i.replace(/\B(?=(\d{3})+(?!\d))/g, group), ...r].join('.'); }
    }
  }
  const signStr = (neg ? '-' : sign === '+' ? '+' : sign === ' ' ? ' ' : '') + prefix;
  const w = Number(width ?? 0), pad = Math.max(0, w - strLen(body) - signStr.length);
  const f = fill ?? (zero ? '0' : ' ');
  const a = align ?? (typeof v === 'string' ? '<' : zero ? '=' : '>');
  if (a === '=') return signStr + f.repeat(pad) + body;
  if (a === '<') return signStr + body + f.repeat(pad);
  if (a === '^') { const l = Math.floor(pad / 2); return f.repeat(l) + signStr + body + f.repeat(pad - l); }
  return f.repeat(pad) + signStr + body;
}
