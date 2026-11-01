// Runs the bytecode. Frames are an explicit list, so a program can stop between
// any two instructions: that is the stepper, the time slicing that keeps a tab
// alive, and the budget that stops `while True`.
//
// ops counts work, including work a single line hides. `x in xs` scans the list
// and `xs.pop(0)` shifts it, so both charge what they cost. Without that the
// counter would call a quadratic loop linear, which is the mistake it teaches.

import { compile, type Code, type Ins } from './compiler.ts';
import { PyError } from './lexer.ts';
import {
  Env, PyBound, PyBuiltin, PyClass, PyDict, PyFunction, PyInstance, PyIter, PyList, PyRaise, PyRange, PySet, PySlice, PySuper, PyTuple, PyView, T,
  binop, chars, compare, dictSet, eq, format, hashKey, hooks, makeExc, raise, repr, setAdd, str, tname, truthy, unary, viewItems, type Val,
} from './values.ts';
import { builtins, methodOf } from './builtins.ts';

type TryBlock = { target: number; height: number };
type Frame = {
  code: Code; pc: number; stack: Val[]; env: Env; tries: TryBlock[]; line: number;
  fn?: PyFunction;
  // The caller is JavaScript (sorted's key=, a __repr__), which is waiting for
  // this frame's result rather than having it pushed onto a Python stack.
  boundary?: boolean;
  // A constructor's __init__: the call's value is the instance, not its return.
  initSelf?: PyInstance;
};

export type Status = 'ready' | 'paused' | 'done' | 'error' | 'budget' | 'output';
export type PyFailure = { type: string; message: string; line: number; stack: { fn: string; line: number }[] };
export type VarView = { name: string; value: string; type: string };
export type FrameView = { name: string; line: number; vars: VarView[] };

export const RECURSION_LIMIT = 1000;
// Names real Python defines and this one leaves out on purpose. Without this a
// learner trying open() would be told the name doesn't exist, which is false.
const REAL_BUILTINS_NOT_HERE = new Set(['__import__', 'ascii', 'breakpoint', 'bytearray', 'bytes', 'classmethod', 'compile', 'complex', 'delattr', 'dir', 'eval', 'exec', 'frozenset', 'globals', 'help', 'locals', 'memoryview', 'open', 'property', 'slice', 'staticmethod', 'vars']);
const MAX_OUTPUT = 200_000;
class Stop { reason: 'budget' | 'output'; constructor(reason: 'budget' | 'output') { this.reason = reason; } }

export class PyProgram {
  status: Status = 'ready';
  error?: PyFailure;
  ops = 0;
  maxOps: number;
  stdout = '';
  globals = new Env(null);
  frames: Frame[] = [];
  retval: Val = null;
  maxDepth = 1;
  sortItems!: (items: Val[], kw: Map<string, Val>) => Val[];
  /** Calls to sorted() and list.sort(). A mission that asks for a hand-written sort reads this. */
  sortCalls = 0;
  private builtinEnv: Map<string, Val>;
  private trace: { fn: string; line: number }[] = [];

  constructor(src: string, opts: { maxOps?: number } = {}) {
    this.maxOps = opts.maxOps ?? 5_000_000;
    this.builtinEnv = builtins(this);
    try {
      const code = compile(src);
      this.frames = [{ code, pc: 0, stack: [], env: this.globals, tries: [], line: 0 }];
    } catch (e) {
      if (!(e instanceof PyError)) throw e;
      this.status = 'error';
      this.error = { type: e.type, message: e.message, line: e.line, stack: [] };
    }
  }

  get line() { return this.frames.at(-1)?.line ?? 0; }
  /** The line about to run, which is what a stepper should highlight. */
  get nextLine() { const f = this.frames.at(-1); return f ? f.code.ins[f.pc]?.line ?? 0 : 0; }
  get finished() { return this.status === 'done' || this.status === 'error' || this.status === 'budget' || this.status === 'output'; }

  charge(n: number) { this.ops += n; if (this.ops > this.maxOps) throw new Stop('budget'); }
  write(s: string) {
    this.stdout += s;
    if (this.stdout.length > MAX_OUTPUT) throw new Stop('output');
  }

  private enter() {
    hooks.charge = (n) => this.charge(n);
    hooks.dunder = (o, name, args) => {
      const f = o.cls.lookup(name);
      return f === undefined ? undefined : this.callValue(f, [o, ...args]);
    };
  }

  /** Runs until the program ends or `slice` instructions pass. */
  run(slice = Infinity) { return this.drive(() => --slice <= 0); }

  /** Runs up to and including the next statement boundary: one press of Step. */
  stepLine() {
    let first = true;
    return this.drive((ins) => {
      if (ins?.op === 'LINE' && !first) return true;
      first = false;
      return false;
    }, true);
  }

  private drive(stop: (next: Ins) => boolean, before = false): Status {
    if (this.finished) return this.status;
    this.enter();
    try {
      while (this.frames.length) {
        try {
          for (;;) {
            if (before) {
              const f = this.frames.at(-1)!;
              if (stop(f.code.ins[f.pc])) { this.status = 'paused'; return this.status; }
            }
            this.tick();
            if (!this.frames.length) break;
            if (!before && stop(null as unknown as Ins)) { this.status = 'paused'; return this.status; }
          }
        } catch (e) {
          if (!(e instanceof PyRaise)) throw e;
          if (!this.unwind(e, 0)) { this.fail(e); return this.status; }
        }
      }
      this.status = 'done';
    } catch (e) {
      if (e instanceof Stop) { this.status = e.reason; return this.status; }
      // A very deep structure in repr or == overflows JavaScript's own stack,
      // and CPython reports that same situation as RecursionError.
      if (e instanceof RangeError) { this.failType('RecursionError', 'maximum recursion depth exceeded'); return this.status; }
      throw e;
    }
    return this.status;
  }

  private failType(type: string, message: string) { this.status = 'error'; this.error = { type, message, line: this.line, stack: this.trace }; }
  private fail(e: PyRaise) {
    let message: string;
    try { message = str(e.exc); } catch { message = '<exception str() failed>'; }
    this.status = 'error';
    this.error = { type: e.exc.cls.name, message, line: this.trace[0]?.line ?? 0, stack: [...this.trace].reverse() };
  }

  /** Finds the nearest handler at or above frame `base`, or empties the frames and says false. */
  private unwind(e: PyRaise, base: number): boolean {
    this.trace = [];
    while (this.frames.length > base) {
      const f = this.frames.at(-1)!;
      const t = f.tries.pop();
      if (t) {
        f.stack.length = t.height;
        f.stack.push(e.exc);
        f.pc = t.target;
        return true;
      }
      this.trace.push({ fn: f.code.name, line: f.line });
      this.frames.pop();
    }
    return false;
  }

  /** Calls a Python value from JavaScript and waits for it. */
  callValue(fn: Val, args: Val[], kw: Map<string, Val> = new Map()): Val {
    if (fn instanceof PyBuiltin) return fn.fn(args, kw);
    if (fn instanceof PyBound) return this.callValue(fn.fn, [fn.self, ...args], kw);
    if (fn instanceof PyFunction) {
      const base = this.frames.length;
      this.pushFrame(fn, args, kw);
      this.frames.at(-1)!.boundary = true;
      while (this.frames.length > base) {
        try { this.tick(); }
        catch (e) {
          if (!(e instanceof PyRaise)) throw e;
          if (!this.unwind(e, base)) throw e;
        }
      }
      return this.retval;
    }
    if (fn instanceof PyClass) return this.construct(fn, args, kw, true);
    if (fn instanceof PyInstance) {
      const f = fn.cls.lookup('__call__');
      if (f !== undefined) return this.callValue(f, [fn, ...args], kw);
    }
    return raise('TypeError', `'${tname(fn)}' object is not callable`);
  }

  private construct(cls: PyClass, args: Val[], kw: Map<string, Val>, nested: boolean): Val {
    if (cls.builtin && cls.ctor) return cls.ctor(args, kw);
    const inst = new PyInstance(cls);
    const isExc = cls.isSub(T.BaseException);
    if (isExc) inst.attrs.set('args', new PyTuple(args));
    const init = cls.lookup('__init__');
    if (init === undefined) {
      if (!isExc && (args.length || kw.size)) raise('TypeError', `${cls.name}() takes no arguments`);
      return inst;
    }
    if (nested) { this.callValue(init, [inst, ...args], kw); return inst; }
    this.pushFrame(init as PyFunction, [inst, ...args], kw);
    this.frames.at(-1)!.initSelf = inst;
    return undefined as unknown as Val;
  }

  private pushFrame(fn: PyFunction, args: Val[], kw: Map<string, Val>) {
    if (this.frames.length >= RECURSION_LIMIT) raise('RecursionError', 'maximum recursion depth exceeded');
    this.ops++;
    if (this.ops > this.maxOps) throw new Stop('budget');
    const code = fn.code, env = new Env(fn.env), P = code.params, n = P.length, name = code.qualname;
    if (args.length > n) {
      const nd = fn.defaults.length;
      const takes = nd ? `from ${n - nd} to ${n} positional arguments` : `${n} positional argument${n === 1 ? '' : 's'}`;
      raise('TypeError', `${name}() takes ${takes} but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`);
    }
    for (let i = 0; i < args.length; i++) env.vars.set(P[i], args[i]);
    for (const [k, v] of kw) {
      if (!P.includes(k)) raise('TypeError', `${name}() got an unexpected keyword argument '${k}'`);
      if (env.vars.has(k)) raise('TypeError', `${name}() got multiple values for argument '${k}'`);
      env.vars.set(k, v);
    }
    const firstDefault = n - fn.defaults.length, missing: string[] = [];
    for (let i = 0; i < n; i++) {
      if (env.vars.has(P[i])) continue;
      if (i >= firstDefault) env.vars.set(P[i], fn.defaults[i - firstDefault]);
      else missing.push(`'${P[i]}'`);
    }
    if (missing.length) {
      const list = missing.length === 1 ? missing[0] : missing.length === 2 ? missing.join(' and ') : `${missing.slice(0, -1).join(', ')}, and ${missing.at(-1)}`;
      raise('TypeError', `${name}() missing ${missing.length} required positional argument${missing.length === 1 ? '' : 's'}: ${list}`);
    }
    this.frames.push({ code, pc: 0, stack: [], env, tries: [], fn, line: code.ins[0]?.line ?? 0 });
    if (this.frames.length > this.maxDepth) this.maxDepth = this.frames.length;
  }

  private doCall(fn: Val, args: Val[], kw: Map<string, Val>, stack: Val[]) {
    if (fn instanceof PyBound) { args = [fn.self, ...args]; fn = fn.fn; }
    if (fn instanceof PyFunction) { this.pushFrame(fn, args, kw); return; }
    if (fn instanceof PyBuiltin) { stack.push(fn.fn(args, kw)); return; }
    if (fn instanceof PyClass) {
      const r = this.construct(fn, args, kw, false);
      if (r !== undefined) stack.push(r);
      return;
    }
    if (fn instanceof PySuper) raise('TypeError', "'super' object is not callable");
    stack.push(this.callValue(fn, args, kw));
  }

  private load(f: Frame, name: string): Val {
    const code = f.code;
    if (code.kind === 'fn' && code.locals.has(name)) {
      const v = f.env.vars.get(name);
      if (v === undefined) raise('UnboundLocalError', `cannot access local variable '${name}' where it is not associated with a value`);
      return v!;
    }
    if (!code.globalNames.has(name)) {
      for (let e: Env | null = code.kind === 'fn' ? f.env.parent : f.env; e; e = e.parent) {
        const v = e.vars.get(name);
        if (v !== undefined) return v;
      }
    } else {
      const v = this.globals.vars.get(name);
      if (v !== undefined) return v;
    }
    const b = this.builtinEnv.get(name);
    if (b !== undefined) return b;
    if (REAL_BUILTINS_NOT_HERE.has(name)) raise('SandboxLimit', `real Python has ${name}; this sandbox does not yet`);
    return raise('NameError', `name '${name}' is not defined`);
  }

  private store(f: Frame, name: string, v: Val) {
    const code = f.code;
    if (code.globalNames.has(name)) { this.globals.vars.set(name, v); return; }
    if (code.nonlocals.has(name)) {
      for (let e = f.env.parent; e && e !== this.globals; e = e.parent) if (e.vars.has(name)) { e.vars.set(name, v); return; }
      raise('NameError', `no binding for nonlocal '${name}' found`);
    }
    f.env.vars.set(name, v);
  }

  getAttr(o: Val, name: string): Val {
    if (o instanceof PyInstance) {
      const own = o.attrs.get(name);
      if (own !== undefined) return own;
      const c = o.cls.lookup(name);
      if (c !== undefined) return c instanceof PyFunction ? new PyBound(o, c) : c;
      if (name === '__class__') return o.cls;
      return raise('AttributeError', `'${o.cls.name}' object has no attribute '${name}'`);
    }
    if (o instanceof PyClass) {
      if (name === '__name__') return o.name;
      const c = o.lookup(name);
      if (c !== undefined) return c;
      return raise('AttributeError', `type object '${o.name}' has no attribute '${name}'`);
    }
    if (o instanceof PySuper) {
      const c = o.cls?.lookup(name);
      if (c !== undefined) return c instanceof PyFunction ? new PyBound(o.self, c) : c;
      // object.__init__ exists in Python, so super().__init__() at the top of a
      // hierarchy must quietly succeed rather than raise.
      if (name === '__init__') return new PyBuiltin('__init__', () => null);
      return raise('AttributeError', `'super' object has no attribute '${name}'`);
    }
    if (o instanceof PyFunction && name === '__name__') return o.code.name;
    if (o instanceof PyBuiltin && name === '__name__') return o.name;
    return methodOf(this, o, name);
  }

  getItem(o: Val, i: Val): Val {
    if (o instanceof PyInstance) {
      const r = hooks.dunder(o, '__getitem__', [i]);
      if (r !== undefined) return r;
      return raise('TypeError', `'${o.cls.name}' object is not subscriptable`);
    }
    if (o instanceof PyDict) {
      const e = o.map.get(hashKey(i));
      if (!e) throw new PyRaise(makeExc(T.KeyError, [i]));
      return e[1];
    }
    if (o instanceof PyList || o instanceof PyTuple || typeof o === 'string' || o instanceof PyRange) {
      const kind = tname(o);
      if (i instanceof PySlice) return this.slice(o, i);
      if (typeof i !== 'bigint' && typeof i !== 'boolean') {
        return raise('TypeError', kind === 'str' ? `string indices must be integers, not '${tname(i)}'` : kind === 'range' ? `range indices must be integers or slices, not ${tname(i)}` : `${kind} indices must be integers or slices, not ${tname(i)}`);
      }
      const n = Number(i === true ? 1n : i === false ? 0n : i);
      if (o instanceof PyRange) {
        const len = Number(o.len), at = n < 0 ? n + len : n;
        if (at < 0 || at >= len) raise('IndexError', 'range object index out of range');
        return o.start + BigInt(at) * o.step;
      }
      if (typeof o === 'string') {
        const cs = chars(o), at = n < 0 ? n + cs.length : n;
        if (at < 0 || at >= cs.length) raise('IndexError', 'string index out of range');
        return cs[at];
      }
      const at = n < 0 ? n + o.items.length : n;
      if (at < 0 || at >= o.items.length) raise('IndexError', `${kind} index out of range`);
      return o.items[at];
    }
    return raise('TypeError', `'${tname(o)}' object is not subscriptable`);
  }

  private sliceBounds(len: number, s: PySlice): { start: number; stop: number; step: number } {
    const int = (v: Val, d: number) => {
      if (v === null) return d;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v !== 'bigint') return raise('TypeError', 'slice indices must be integers or None or have an __index__ method');
      return Number(v);
    };
    const step = int(s.step, 1);
    if (step === 0) raise('ValueError', 'slice step cannot be zero');
    const clamp = (v: number, lo: number, hi: number) => (v < 0 ? Math.max(v + len, lo) : Math.min(v, hi));
    const start = step > 0 ? clamp(int(s.lo, 0), 0, len) : clamp(int(s.lo, len - 1), -1, len - 1);
    const stop = step > 0 ? clamp(int(s.hi, len), 0, len) : s.hi === null ? -1 : clamp(int(s.hi, -1), -1, len - 1);
    return { start, stop, step };
  }

  private slice(o: Val, s: PySlice): Val {
    if (o instanceof PyRange) {
      const { start, stop, step } = this.sliceBounds(Number(o.len), s);
      return new PyRange(o.start + BigInt(start) * o.step, o.start + BigInt(stop) * o.step, o.step * BigInt(step));
    }
    const items: any[] = typeof o === 'string' ? chars(o) : (o as PyList).items;
    const { start, stop, step } = this.sliceBounds(items.length, s);
    const out: any[] = [];
    for (let i = start; step > 0 ? i < stop : i > stop; i += step) out.push(items[i]);
    this.charge(out.length);
    if (typeof o === 'string') return out.join('');
    return o instanceof PyList ? new PyList(out) : new PyTuple(out);
  }

  private setItem(o: Val, i: Val, v: Val) {
    if (o instanceof PyDict) { dictSet(o, i, v); return; }
    if (o instanceof PyList) {
      if (i instanceof PySlice) {
        const { start, stop, step } = this.sliceBounds(o.items.length, i);
        const vals = this.toList(v);
        if (step === 1) { this.charge(o.items.length); o.items.splice(start, Math.max(0, stop - start), ...vals); return; }
        const idx: number[] = [];
        for (let k = start; step > 0 ? k < stop : k > stop; k += step) idx.push(k);
        if (idx.length !== vals.length) raise('ValueError', `attempt to assign sequence of size ${vals.length} to extended slice of size ${idx.length}`);
        idx.forEach((k, j) => { o.items[k] = vals[j]; });
        return;
      }
      if (typeof i !== 'bigint' && typeof i !== 'boolean') raise('TypeError', `list indices must be integers or slices, not ${tname(i)}`);
      const n = Number(i === true ? 1n : i === false ? 0n : i), at = n < 0 ? n + o.items.length : n;
      if (at < 0 || at >= o.items.length) raise('IndexError', 'list assignment index out of range');
      o.items[at] = v;
      return;
    }
    if (o instanceof PyInstance) {
      if (o.cls.lookup('__setitem__') !== undefined) { hooks.dunder(o, '__setitem__', [i, v]); return; }
      raise('TypeError', `'${o.cls.name}' object does not support item assignment`);
    }
    raise('TypeError', `'${tname(o)}' object does not support item assignment`);
  }

  private delItem(o: Val, i: Val) {
    if (o instanceof PyDict) {
      if (!o.map.delete(hashKey(i))) throw new PyRaise(makeExc(T.KeyError, [i]));
      return;
    }
    if (o instanceof PyList) {
      this.charge(o.items.length);
      if (i instanceof PySlice) {
        const { start, stop, step } = this.sliceBounds(o.items.length, i);
        const drop = new Set<number>();
        for (let k = start; step > 0 ? k < stop : k > stop; k += step) drop.add(k);
        o.items = o.items.filter((_, k) => !drop.has(k));
        return;
      }
      if (typeof i !== 'bigint') raise('TypeError', `list indices must be integers or slices, not ${tname(i)}`);
      const n = Number(i), at = n < 0 ? n + o.items.length : n;
      if (at < 0 || at >= o.items.length) raise('IndexError', 'list assignment index out of range');
      o.items.splice(at, 1);
      return;
    }
    raise('TypeError', `'${tname(o)}' object doesn't support item deletion`);
  }

  iter(v: Val): PyIter {
    if (v instanceof PyIter) return v;
    if (v instanceof PyList || v instanceof PyTuple) {
      // By live index, not a copy: appending during a loop extends the loop and
      // removing during one skips items, both of which real Python does.
      let i = 0;
      return new PyIter('list_iterator', () => (i < v.items.length ? v.items[i++] : undefined));
    }
    if (v instanceof PyRange) {
      let cur = v.start; const { stop, step } = v;
      return new PyIter('range_iterator', () => { if (step > 0n ? cur >= stop : cur <= stop) return undefined; const r = cur; cur += step; return r; });
    }
    if (typeof v === 'string') { const cs = chars(v); let i = 0; return new PyIter('str_iterator', () => (i < cs.length ? cs[i++] : undefined)); }
    if (v instanceof PyDict || v instanceof PyView) {
      const d = v instanceof PyDict ? v : v.d;
      const kind = v instanceof PyDict ? 'keys' : v.kind;
      const es = [...d.map.values()], size = d.map.size;
      let i = 0;
      return new PyIter('dict_keyiterator', () => {
        if (d.map.size !== size) raise('RuntimeError', 'dictionary changed size during iteration');
        if (i >= es.length) return undefined;
        const [k, x] = es[i++];
        return kind === 'keys' ? k : kind === 'values' ? x : new PyTuple([k, x]);
      });
    }
    if (v instanceof PySet) {
      const es = [...v.map.values()], size = v.map.size;
      let i = 0;
      return new PyIter('set_iterator', () => {
        if (v.map.size !== size) raise('RuntimeError', 'Set changed size during iteration');
        return i < es.length ? es[i++] : undefined;
      });
    }
    if (v instanceof PyInstance) {
      const it = hooks.dunder(v, '__iter__', []);
      if (it !== undefined) {
        if (it instanceof PyIter) return it;
        if (!(it instanceof PyInstance)) raise('TypeError', `iter() returned non-iterator of type '${tname(it)}'`);
        return new PyIter('iterator', () => {
          try { return hooks.dunder(it as PyInstance, '__next__', []); }
          catch (e) { if (e instanceof PyRaise && e.exc.cls.isSub(T.StopIteration)) return undefined; throw e; }
        });
      }
    }
    return raise('TypeError', `'${tname(v)}' object is not iterable`);
  }

  toList(v: Val): Val[] {
    if (v instanceof PyList || v instanceof PyTuple) { this.charge(v.items.length); return [...v.items]; }
    if (v instanceof PyView) { this.charge(v.d.map.size); return viewItems(v); }
    const it = this.iter(v), out: Val[] = [];
    for (let x = it.next(); x !== undefined; x = it.next()) { this.charge(1); out.push(x); }
    return out;
  }

  contains(c: Val, x: Val): boolean {
    if (c instanceof PyDict) return c.map.has(hashKey(x));
    if (c instanceof PySet) return c.map.has(hashKey(x));
    if (c instanceof PyView && c.kind === 'keys') return c.d.map.has(hashKey(x));
    if (typeof c === 'string') {
      if (typeof x !== 'string') raise('TypeError', `'in <string>' requires string as left operand, not ${tname(x)}`);
      this.charge(c.length);
      return c.includes(x as string);
    }
    if (c instanceof PyRange && typeof x === 'bigint') {
      const { start, stop, step } = c;
      return step > 0n ? x >= start && x < stop && (x - start) % step === 0n : x <= start && x > stop && (start - x) % -step === 0n;
    }
    if (c instanceof PyInstance && c.cls.lookup('__contains__') !== undefined) return truthy(hooks.dunder(c, '__contains__', [x])!);
    const it = this.iter(c);
    for (let v = it.next(); v !== undefined; v = it.next()) { this.charge(1); if (v === x || eq(v, x)) return true; }
    return false;
  }

  private compareOp(op: string, a: Val, b: Val): boolean {
    switch (op) {
      case '==': return eq(a, b);
      case '!=': return !eq(a, b);
      case 'is': return a === b || (typeof a === 'number' && typeof b === 'number' && Object.is(a, b));
      case 'is not': return !(a === b || (typeof a === 'number' && typeof b === 'number' && Object.is(a, b)));
      case 'in': return this.contains(b, a);
      case 'not in': return !this.contains(b, a);
      default: return compare(op as '<', a, b);
    }
  }

  private tick() {
    const f = this.frames.at(-1)!;
    const ins = f.code.ins[f.pc++], s = f.stack;
    switch (ins.op) {
      case 'LINE': f.line = ins.line; this.ops++; if (this.ops > this.maxOps) throw new Stop('budget'); break;
      case 'CONST': s.push(ins.a); break;
      case 'LOAD': s.push(this.load(f, ins.a)); break;
      case 'STORE': this.store(f, ins.a, s.pop()!); break;
      case 'DEL': {
        const had = f.code.globalNames.has(ins.a) ? this.globals.vars.delete(ins.a) : f.env.vars.delete(ins.a);
        if (!had) raise('NameError', `name '${ins.a}' is not defined`);
        break;
      }
      case 'DEL_QUIET': f.env.vars.delete(ins.a); break;
      case 'POP': s.pop(); break;
      case 'DUP': s.push(s.at(-1)!); break;
      case 'DUP2': s.push(s.at(-2)!, s.at(-1)!); break;
      case 'ROT2': { const b = s.pop()!, a = s.pop()!; s.push(b, a); break; }
      case 'ROT3': { const c = s.pop()!, b = s.pop()!, a = s.pop()!; s.push(c, a, b); break; }
      case 'BIN': { const b = s.pop()!, a = s.pop()!; this.ops++; s.push(binop(ins.a, a, b)); break; }
      case 'IBIN': {
        const b = s.pop()!, a = s.pop()!;
        this.ops++;
        // += on a list changes it in place, so every other name for that list
        // sees the change. `a = a + b` makes a new list and they do not.
        if (a instanceof PyList && ins.a === '+') { const v = this.toList(b); for (const x of v) a.items.push(x); s.push(a); }
        else if (a instanceof PyDict && ins.a === '|') raise('SandboxLimit', 'real Python has |= on dicts; this sandbox does not yet');
        else if (a instanceof PySet && (ins.a === '|' || ins.a === '&' || ins.a === '-')) {
          const r = binop(ins.a, a, b) as PySet;
          a.map = r.map;
          s.push(a);
        } else s.push(binop(ins.a, a, b));
        break;
      }
      case 'UN': s.push(unary(ins.a, s.pop()!)); break;
      case 'NOT': s.push(!truthy(s.pop()!)); break;
      case 'CMP': { const b = s.pop()!, a = s.pop()!; this.ops++; s.push(this.compareOp(ins.a, a, b)); break; }
      case 'JUMP': f.pc = ins.a; break;
      case 'JIF': if (!truthy(s.pop()!)) f.pc = ins.a; break;
      case 'JIT': if (truthy(s.pop()!)) f.pc = ins.a; break;
      case 'JIF_KEEP': if (!truthy(s.at(-1)!)) f.pc = ins.a; else s.pop(); break;
      case 'JIT_KEEP': if (truthy(s.at(-1)!)) f.pc = ins.a; else s.pop(); break;
      case 'BUILD_LIST': s.push(new PyList(ins.a ? s.splice(s.length - ins.a) : [])); break;
      case 'BUILD_TUPLE': s.push(new PyTuple(ins.a ? s.splice(s.length - ins.a) : [])); break;
      case 'BUILD_SET': { const o = new PySet(); for (const x of ins.a ? s.splice(s.length - ins.a) : []) setAdd(o, x); s.push(o); break; }
      case 'BUILD_DICT': {
        const o = new PyDict(), vals = ins.a ? s.splice(s.length - ins.a * 2) : [];
        for (let i = 0; i < vals.length; i += 2) dictSet(o, vals[i], vals[i + 1]);
        s.push(o);
        break;
      }
      case 'BUILD_SLICE': { const c = s.pop()!, b = s.pop()!, a = s.pop()!; s.push(new PySlice(a, b, c)); break; }
      case 'COMP_ADD': {
        if (ins.a === 'dict') { const v = s.pop()!, k = s.pop()!, d = s.pop() as PyDict; dictSet(d, k, v); }
        else { const x = s.pop()!, c = s.pop()!; if (c instanceof PySet) setAdd(c, x); else (c as PyList).items.push(x); }
        this.ops++;
        break;
      }
      case 'FORMAT': {
        let v = s.pop()!;
        if (ins.b === 'r') v = repr(v);
        else if (ins.b === 's') v = str(v);
        s.push(format(v, ins.a));
        break;
      }
      case 'JOIN': s.push((s.splice(s.length - ins.a) as string[]).join('')); break;
      case 'GETITEM': { const i = s.pop()!, o = s.pop()!; this.ops++; s.push(this.getItem(o, i)); break; }
      case 'SETITEM': { const i = s.pop()!, o = s.pop()!, v = s.pop()!; this.ops++; this.setItem(o, i, v); break; }
      case 'SETITEM_AUG': { const v = s.pop()!, i = s.pop()!, o = s.pop()!; this.ops++; this.setItem(o, i, v); break; }
      case 'DELITEM': { const i = s.pop()!, o = s.pop()!; this.ops++; this.delItem(o, i); break; }
      case 'GETATTR': s.push(this.getAttr(s.pop()!, ins.a)); break;
      case 'SETATTR': { const o = s.pop()!, v = s.pop()!; this.setAttr(o, ins.a, v); break; }
      case 'SETATTR_AUG': { const v = s.pop()!, o = s.pop()!; this.setAttr(o, ins.a, v); break; }
      case 'DELATTR': {
        const o = s.pop()!;
        if (!(o instanceof PyInstance) || !o.attrs.delete(ins.a)) raise('AttributeError', `'${tname(o)}' object has no attribute '${ins.a}'`);
        break;
      }
      case 'GETITER': s.push(this.iter(s.pop()!)); break;
      case 'FORITER': {
        const v = (s.at(-1) as PyIter).next();
        this.ops++;
        if (v === undefined) { s.pop(); f.pc = ins.a; } else s.push(v);
        break;
      }
      case 'UNPACK': {
        const v = s.pop()!;
        let items: Val[];
        if (v instanceof PyList || v instanceof PyTuple) items = v.items;
        else {
          try { items = this.toList(v); }
          catch (e) { if (e instanceof PyRaise && e.exc.cls === T.TypeError) raise('TypeError', `cannot unpack non-iterable ${tname(v)} object`); throw e; }
        }
        if (items.length < ins.a) raise('ValueError', `not enough values to unpack (expected ${ins.a}, got ${items.length})`);
        if (items.length > ins.a) raise('ValueError', `too many values to unpack (expected ${ins.a})`);
        for (let i = items.length - 1; i >= 0; i--) s.push(items[i]);
        break;
      }
      case 'MAKE_FN': {
        const defaults = ins.b ? s.splice(s.length - ins.b) : [];
        // A function in a class body closes over what surrounds the class, not
        // the class's own namespace: methods must say self.x, never bare x.
        const env = f.code.kind === 'class' ? f.env.parent! : f.env;
        s.push(new PyFunction(ins.a, defaults, env));
        break;
      }
      case 'MAKE_CLASS': {
        const base = ins.b ? s.pop()! : T.object;
        if (!(base instanceof PyClass)) raise('TypeError', 'a class can only inherit from a class');
        if ((base as PyClass).builtin && !(base as PyClass).isSub(T.BaseException) && base !== T.object) raise('SandboxLimit', `real Python can subclass ${(base as PyClass).name}; this sandbox does not yet`);
        const cls = new PyClass(ins.a.name, base as PyClass);
        const env = new Env(f.env);
        this.frames.push({ code: ins.a, pc: 0, stack: [], env, tries: [], line: ins.line });
        // Run the body to its end now: a class statement has no stops of its own
        // worth showing, and its namespace must exist before the next statement.
        const base2 = this.frames.length - 1;
        while (this.frames.length > base2) {
          try { this.tick(); }
          catch (e) { if (!(e instanceof PyRaise) || !this.unwind(e, base2)) throw e; }
        }
        for (const [k, v] of env.vars) {
          if (v instanceof PyFunction) v.owner = cls;
          cls.attrs.set(k, v);
        }
        s.push(cls);
        break;
      }
      case 'CALL': {
        const kwn: string[] = ins.b, nkw = kwn.length;
        const kw = new Map<string, Val>();
        if (nkw) { const vals = s.splice(s.length - nkw); kwn.forEach((k, i) => kw.set(k, vals[i])); }
        const args = ins.a ? s.splice(s.length - ins.a) : [];
        const fn = s.pop()!;
        this.ops++;
        if (fn instanceof PyBuiltin && fn.name === 'super') { s.push(this.makeSuper(f, args)); break; }
        this.doCall(fn, args, kw, s);
        break;
      }
      case 'RETURN': {
        const v = s.pop() ?? null;
        this.frames.pop();
        const result = f.initSelf ?? v;
        if (f.initSelf && v !== null) raise('TypeError', `__init__() should return None, not '${tname(v)}'`);
        this.retval = result;
        if (!f.boundary && this.frames.length && f.code.kind !== 'class') this.frames.at(-1)!.stack.push(result);
        break;
      }
      case 'SETUP_TRY': f.tries.push({ target: ins.a, height: s.length }); break;
      case 'POP_TRY': f.tries.pop(); break;
      case 'EXC_MATCH': {
        const type = s.pop()!, e = s.pop()! as PyInstance;
        const types = type instanceof PyTuple ? type.items : [type];
        for (const t of types) if (!(t instanceof PyClass)) raise('TypeError', 'catching classes that do not inherit from BaseException is not allowed');
        s.push(types.some((t) => e.cls.isSub(t as PyClass)));
        break;
      }
      case 'RAISE': {
        if (!ins.a) raise('RuntimeError', 'No active exception to reraise');
        let e = s.pop() as Val;
        if (e instanceof PyClass && e.isSub(T.BaseException)) e = this.callValue(e, []);
        if (!(e instanceof PyInstance) || !e.cls.isSub(T.BaseException)) raise('TypeError', 'exceptions must derive from BaseException');
        throw new PyRaise(e as PyInstance);
      }
      case 'RERAISE': throw new PyRaise(s.pop() as PyInstance);
      default: throw new Error(`unknown instruction ${ins.op}`);
    }
  }

  private setAttr(o: Val, name: string, v: Val) {
    if (o instanceof PyInstance) { o.attrs.set(name, v); return; }
    if (o instanceof PyClass && !o.builtin) { o.attrs.set(name, v); return; }
    raise('AttributeError', `'${tname(o)}' object has no attribute '${name}'`);
  }

  private makeSuper(f: Frame, args: Val[]): Val {
    if (args.length) raise('SandboxLimit', 'real Python has super() with arguments; this sandbox only has plain super()');
    if (!f.fn?.owner) raise('RuntimeError', 'super(): no arguments');
    const self = f.env.vars.get(f.code.params[0]);
    if (self === undefined) raise('RuntimeError', 'super(): no arguments');
    return new PySuper(f.fn!.owner!.base, self!);
  }

  /** What the variables panel shows, innermost frame last. Comprehensions stay out of it. */
  view(): FrameView[] {
    const out: FrameView[] = [];
    this.enter();
    // Once the program has ended its frames are gone, and the panel should still
    // show what it left behind rather than look as if nothing ever ran.
    const shown = this.frames.length ? this.frames : [{ code: { name: '<module>', hidden: false }, env: this.globals, line: 0 } as unknown as Frame];
    for (const f of shown) {
      if (f.code.hidden) continue;
      const vars: VarView[] = [];
      for (const [name, v] of f.env.vars) {
        if (name.startsWith('.')) continue;
        let value: string;
        // Running a learner's __repr__ from a display panel would add steps and
        // could raise, so an object shows as its class name.
        try { value = v instanceof PyFunction ? 'def' : v instanceof PyClass ? 'class' : v instanceof PyInstance ? `<${v.cls.name}>` : repr(v); }
        catch { value = '<cannot show>'; }
        vars.push({ name, value: value.length > 200 ? value.slice(0, 200) + '…' : value, type: tname(v) });
      }
      out.push({ name: f.code.name, line: f.line, vars });
    }
    return out;
  }

  /** Calls a function the program defined, after it ran: how missions test the learner's code. */
  call(name: string, args: Val[]): { ok: true; value: Val } | { ok: false; error: PyFailure } {
    const fn = this.globals.vars.get(name);
    if (fn === undefined) return { ok: false, error: { type: 'NameError', message: `name '${name}' is not defined`, line: 0, stack: [] } };
    this.enter();
    this.status = 'ready';
    try { return { ok: true, value: this.callValue(fn, args) }; }
    catch (e) {
      if (e instanceof Stop) { this.status = e.reason; return { ok: false, error: { type: 'Budget', message: 'used up the step budget', line: 0, stack: [] } }; }
      if (e instanceof PyRaise) { this.frames = []; let m = ''; try { m = str(e.exc); } catch { /* the type name is still reported */ } return { ok: false, error: { type: e.exc.cls.name, message: m, line: this.trace[0]?.line ?? 0, stack: [] } }; }
      throw e;
    }
    finally { this.status = 'done'; }
  }
}

