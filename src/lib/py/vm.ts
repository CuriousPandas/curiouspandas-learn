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
  DUNDER, Env, PyBound, PyBuiltin, PyClass, PyDict, PyFunction, PyInstance, PyIter, PyList, PyRaise, PyRange, PySet, PySlice, PySuper, PyTuple, PyView, SandboxStop, T,
  binop, chars, compare, dictSet, eq, format, hashKey, hooks, makeExc, raise, repr, setAdd, str, tname, truthy, unary, viewItems, type Val,
} from './values.ts';
import { builtins, classAttr, index, isDunder, methodOf, refuseDunder } from './builtins.ts';

type TryBlock = { target: number; height: number; handling: number };
type Frame = {
  code: Code; pc: number; stack: Val[]; env: Env; tries: TryBlock[]; line: number;
  // Exceptions whose except block is running, innermost last. A bare `raise`
  // re-raises the last one, from this frame or from whichever called it.
  handling: { exc: PyInstance; name?: string }[];
  fn?: PyFunction;
  // The caller is JavaScript (sorted's key=, a __repr__), which is waiting for
  // this frame's result rather than having it pushed onto a Python stack.
  boundary?: boolean;
  // A constructor's __init__: the call's value is the instance, not its return.
  initSelf?: PyInstance;
};

// 'stopped' is the learner pressing Stop. 'crash' is this engine failing, which has to look
// nothing like 'error': that one means the learner's program, and this one never does.
export type Status = 'ready' | 'paused' | 'done' | 'error' | 'budget' | 'output' | 'stopped' | 'crash';
export type TraceEntry = { fn: string; line: number; file?: string };
export type PyFailure = { type: string; message: string; line: number; stack: TraceEntry[]; context?: PyFailure };
export type VarView = { name: string; value: string; type: string };
export type FrameView = { name: string; line: number; vars: VarView[] };

export const RECURSION_LIMIT = 1000;
export const GIVEN_FILE = '<given>';
// Names real Python defines and this one leaves out on purpose. Without this a
// learner trying open() would be told the name doesn't exist, which is false.
// tests/py-fuzz.test.ts checks every name in real Python's dir(builtins) against this.
const REAL_BUILTINS_NOT_HERE = new Set([
  '__build_class__', '__import__', '__loader__', '__package__', '__spec__', 'aiter', 'anext', 'ascii', 'breakpoint', 'bytearray', 'bytes', 'classmethod', 'compile', 'complex', 'copyright', 'credits', 'delattr', 'dir', 'eval', 'exec', 'exit', 'frozenset', 'globals', 'help', 'license', 'locals', 'memoryview', 'open', 'property', 'quit', 'slice', 'staticmethod', 'vars',
  'Ellipsis', 'NotImplemented', 'SystemExit', 'SyntaxError', 'IndentationError', 'TabError', 'UnicodeDecodeError', 'UnicodeEncodeError', 'UnicodeTranslateError', 'BaseExceptionGroup', 'ExceptionGroup', 'PythonFinalizationError',
  // Not in dir(builtins), but real names in any program run from a file.
  '__file__', '__builtins__', '__cached__', '__annotations__',
  // Only on Windows, as a second name for OSError.
  'WindowsError',
]);
// The attributes every object has on real Python. Reading one gets a refusal by name;
// anything else on a learner's own object really is an AttributeError.
const OBJECT_DUNDERS = new Set(['__class__', '__delattr__', '__dict__', '__dir__', '__doc__', '__eq__', '__format__', '__ge__', '__getattribute__', '__getstate__', '__gt__', '__hash__', '__init__', '__init_subclass__', '__le__', '__lt__', '__module__', '__ne__', '__new__', '__reduce__', '__reduce_ex__', '__repr__', '__setattr__', '__sizeof__', '__str__', '__subclasshook__', '__weakref__']);
const EXCEPTION_ATTRS = new Set(['add_note', 'with_traceback', '__cause__', '__context__', '__notes__', '__suppress_context__', '__traceback__', 'value', 'name', 'obj', 'path', 'msg', 'errno', 'strerror', 'filename', 'filename2', 'characters_written']);
// A class that defines one of these changes how Python treats its instances, and this
// engine would never call it. __slots__ or __setattr__ quietly doing nothing is the same
// failure as a dropped argument, so a class using one is refused when it's created.
const CLASS_NAMES_NOT_HONOURED = new Set(['__getattr__', '__getattribute__', '__setattr__', '__delattr__', '__new__', '__del__', '__slots__', '__get__', '__set__', '__delete__', '__set_name__', '__init_subclass__', '__class_getitem__', '__enter__', '__exit__', '__aenter__', '__aexit__', '__aiter__', '__anext__', '__await__', '__bytes__', '__complex__', '__sizeof__', '__dir__', '__fspath__', '__length_hint__', '__missing__', '__instancecheck__', '__subclasscheck__', '__subclasshook__', '__prepare__', '__mro_entries__', '__match_args__', '__trunc__', '__floor__', '__ceil__', '__reduce__', '__reduce_ex__', '__copy__', '__deepcopy__', '__getstate__', '__setstate__', '__buffer__', '__release_buffer__', '__rmatmul__', '__rpow__']);
const MAX_OUTPUT = 200_000;
class Stop { reason: 'budget' | 'output'; constructor(reason: 'budget' | 'output') { this.reason = reason; } }
// Not a Python exception, so no except can catch it. Real Python would be waiting
// for someone to type, and `except Exception: continue` around input() must not
// turn that wait into a loop that spins until the step budget runs out.
class OutOfInput { message: string; constructor(message: string) { this.message = message; } }

let lastGiven: { src: string; code: Code } | undefined;
const RICH: Record<string, [string, string]> = { '==': ['__eq__', '__eq__'], '!=': ['__ne__', '__ne__'], '<': ['__lt__', '__gt__'], '<=': ['__le__', '__ge__'], '>': ['__gt__', '__lt__'], '>=': ['__ge__', '__le__'] };

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
  /** What calling int, list and the other built-in classes does, in this program. */
  readonly ctors = new Map<PyClass, (a: Val[], kw: Map<string, Val>) => Val>();
  /** str.upper and the like, once looked up. */
  readonly descriptors = new Map<string, PyBuiltin>();
  private builtinEnv: Map<string, Val>;
  /** The lines input() reads. Undefined means this lab has no input box at all. */
  readonly stdin?: string[];
  /** Code run first, in the same globals: what a lab gives the learner read-only. */
  readonly given?: string;
  private nextInput = 0;

  constructor(src: string, opts: { maxOps?: number; stdin?: string[]; given?: string } = {}) {
    this.maxOps = opts.maxOps ?? 5_000_000;
    this.stdin = opts.stdin;
    this.given = opts.given;
    this.builtinEnv = builtins(this);
    // In the table of built-ins and not in globals, so they stay out of the Variables panel
    // and a program can still assign over them. Without __name__, the most common line in
    // the Python a beginner finds and pastes was a NameError, read as their own mistake.
    this.builtinEnv.set('__name__', '__main__');
    this.builtinEnv.set('__debug__', true);
    this.builtinEnv.set('__doc__', null);
    let code: Code;
    try { code = compile(src); }
    catch (e) {
      if (e instanceof PyError) {
        this.status = 'error';
        this.error = { type: e.type, message: e.message, line: e.line, stack: [] };
      } else this.crash(e);
      return;
    }
    if (code.doc !== undefined) this.builtinEnv.set('__doc__', code.doc);
    if (opts.given !== undefined) {
      // Run now and to the end: the learner steps through their code, not this, and
      // a mission's step count must not include it. Given code that fails is the
      // site's bug, so it's reported as one rather than reading as the learner's mistake.
      try {
        // One entry is enough: a mission's checks build many programs on the same given code.
        if (lastGiven?.src !== opts.given) lastGiven = { src: opts.given, code: compile(opts.given, GIVEN_FILE) };
        this.frames = [this.moduleFrame(lastGiven.code)];
      }
      catch (e) { this.crash(new Error(`a lab's given code failed to compile: ${(e as Error).message}`)); return; }
      this.drive(() => false);
      if (this.status !== 'done') { const was = this.error; this.crash(new Error(`a lab's given code failed: ${was?.type}: ${was?.message}`)); return; }
      this.status = 'ready';
      this.ops = 0;
    }
    this.frames = [this.moduleFrame(code)];
  }

  /** This engine failed, not the program. Ends the run whatever state it was in, so nothing can be left looking as if it's still going. */
  private crash(e: unknown) {
    // Plain indexing, on purpose: whatever just broke, this can't be allowed to break as well.
    const line = this.frames[this.frames.length - 1]?.line ?? 0;
    this.frames = [];
    this.status = 'crash';
    this.error = { type: 'SandboxBug', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e), line, stack: [] };
  }

  /** The learner pressed Stop. It counts as a run that didn't finish, not as nothing having happened. */
  stop() { if (!this.finished) { this.frames = []; this.status = 'stopped'; } }

  private moduleFrame(code: Code): Frame { return { code, pc: 0, stack: [], env: this.globals, tries: [], handling: [], line: 0 }; }

  readLine(): string {
    if (this.stdin === undefined) throw new OutOfInput('this lab has no input box, so input() has nothing to read. Set a variable at the top of your program instead. Real Python would wait for you to type');
    if (this.nextInput >= this.stdin.length) throw new OutOfInput('the program asked for more input than this lab was given. Add a line to the input box. Real Python would wait for you to type, or raise EOFError if its input had ended');
    return this.stdin[this.nextInput++];
  }

  /** True while the next line to run belongs to a lab's given code, not the learner's program. */
  get inGiven() { const f = this.frames.at(-1); return !!f && f.code.file === GIVEN_FILE; }

  get line() { return this.frames.at(-1)?.line ?? 0; }
  /** The line about to run, which is what a stepper should highlight. */
  get nextLine() { const f = this.frames.at(-1); return f ? f.code.ins[f.pc]?.line ?? 0 : 0; }
  get finished() { return this.status === 'done' || this.status === 'error' || this.status === 'budget' || this.status === 'output' || this.status === 'stopped' || this.status === 'crash'; }

  charge(n: number) { this.ops += n; if (this.ops > this.maxOps) throw new Stop('budget'); }
  write(s: string) {
    this.stdout += s;
    if (this.stdout.length > MAX_OUTPUT) throw new Stop('output');
  }

  private enter() {
    hooks.charge = (n) => this.charge(n);
    hooks.list = (v) => this.toList(v);
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
      if (ins?.op !== 'LINE') return false;
      // Counted on LINE alone: a program opening with `for` starts on SETLINE, and a
      // press that ran only that showed line 1 highlighted twice.
      if (!first) return true;
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
      if (e instanceof OutOfInput || e instanceof SandboxStop) { this.failType('SandboxLimit', e.message); return this.status; }
      // A very deep structure in repr or == overflows JavaScript's own stack,
      // and CPython reports that same situation as RecursionError.
      if (e instanceof RangeError && /call stack/i.test(e.message)) { this.failType('RecursionError', 'maximum recursion depth exceeded'); return this.status; }
      // Any other RangeError is JavaScript refusing a size ("Invalid string length"). It
      // used to read as a RecursionError, which is false: nothing here was recursing.
      if (e instanceof RangeError) { this.failType('SandboxLimit', 'this sandbox stops at very large values, to keep your browser tab alive; real Python would carry on until it ran out of memory'); return this.status; }
      // Nothing above can have come from the program. A raw exception thrown from here left
      // the browser on "Running…" with Stop hanging, so it ends the run instead, and says whose bug it is.
      this.crash(e);
      return this.status;
    }
    return this.status;
  }

  private failType(type: string, message: string) {
    const stack = this.frames.filter((f) => !f.code.hidden).map((f) => ({ fn: f.code.name, line: f.line, file: f.code.file }));
    this.status = 'error';
    this.error = { type, message, line: stack.at(-1)?.line ?? 0, stack };
  }
  private failure(exc: PyInstance): PyFailure {
    let message: string;
    try { message = str(exc); } catch { message = '<exception str() failed>'; }
    const tb = exc.tb ?? [];
    return { type: exc.cls.name, message, line: tb[0]?.line ?? 0, stack: [...tb].reverse(), context: exc.context && this.failure(exc.context) };
  }
  private fail(e: PyRaise) { this.status = 'error'; this.error = this.failure(e.exc); }

  private handled(): PyInstance | undefined {
    for (let i = this.frames.length - 1; i >= 0; i--) { const h = this.frames[i].handling.at(-1); if (h) return h.exc; }
    return undefined;
  }

  /** Finds the nearest handler at or above frame `base`, or empties the frames and says false. */
  private unwind(e: PyRaise, base: number): boolean {
    const exc = e.exc;
    // Raised while handling another: looked up before the frames go, because
    // unwinding is what ends those handlers.
    if (!exc.tb && !exc.context) { const during = this.handled(); if (during !== exc) exc.context = during; }
    const tb = (exc.tb ??= []);
    let note = !e.again;
    e.again = false;
    while (this.frames.length > base) {
      const f = this.frames.at(-1)!;
      // A comprehension's frame is this engine's detail. Python 3.12 has none.
      if (note && !f.code.hidden) tb.push({ fn: f.code.name, line: f.line, file: f.code.file });
      note = true;
      const t = f.tries.pop();
      if (t) {
        // Leaving those except blocks, and `except E as e` ends the name e with them.
        while (f.handling.length > t.handling) { const h = f.handling.pop()!; if (h.name) f.env.vars.delete(h.name); }
        f.stack.length = t.height;
        f.stack.push(exc);
        f.pc = t.target;
        return true;
      }
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
    const made = this.ctors.get(cls);
    if (made) return made(args, kw);
    if (cls.builtin && cls !== T.object && !cls.isSub(T.BaseException)) raise('TypeError', `cannot create '${cls.name}' instances`);
    const inst = new PyInstance(cls);
    const isExc = cls.isSub(T.BaseException);
    if (isExc) {
      // str(OSError(2, "x")) is "[Errno 2] x" on real Python, and its keyword arguments set
      // fields this has no use for. Printing the plain tuple would be a quiet wrong answer.
      if (cls.isSub(T.OSError) && args.length >= 2) raise('SandboxLimit', "real Python's OSError gives its arguments special meanings; this sandbox does not yet");
      inst.attrs.set('args', new PyTuple(args));
    }
    const init = cls.lookup('__init__');
    if (init === undefined) {
      if (isExc && kw.size) {
        if (cls.isSub(T.ImportError) || cls.isSub(T.AttributeError) || cls.isSub(T.NameError)) raise('SandboxLimit', `real Python's ${cls.name} takes keyword arguments; this sandbox does not yet`);
        raise('TypeError', `${cls.name}() takes no keyword arguments`);
      }
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
    this.frames.push({ code, pc: 0, stack: [], env, tries: [], handling: [], fn, line: code.ins[0]?.line ?? 0 });
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
    if (code.kind === 'class' && name === '__module__') return '__main__';
    if (code.kind === 'class' && name === '__qualname__') return code.qualname;
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
      if (o.cls.isSub(T.BaseException) && EXCEPTION_ATTRS.has(name)) refuseDunder(name, `a ${o.cls.name}`);
      if (OBJECT_DUNDERS.has(name)) refuseDunder(name, `a ${o.cls.name}`);
      return raise('AttributeError', `'${o.cls.name}' object has no attribute '${name}'`);
    }
    if (o instanceof PyClass) {
      if (name === '__name__') return o.name;
      if (name === '__qualname__') return o.qualname;
      if (name === '__class__') return T.type;
      const c = o.lookup(name);
      if (c !== undefined) return c;
      if (name === '__init__' && o.isSub(T.BaseException)) return this.exceptionInit(null);
      for (let k: PyClass | null = o; k; k = k.base) {
        const got = classAttr(this, k, name);
        if (got !== undefined) return got;
      }
      if (isDunder(name) || (o.isSub(T.BaseException) && EXCEPTION_ATTRS.has(name))) refuseDunder(name, `the class ${o.name}`);
      return raise('AttributeError', `type object '${o.name}' has no attribute '${name}'`);
    }
    if (o instanceof PySuper) {
      const c = o.cls?.lookup(name);
      if (c !== undefined) return c instanceof PyFunction ? new PyBound(o.self, c) : c;
      if (name === '__init__') {
        if (o.self instanceof PyInstance && o.self.cls.isSub(T.BaseException)) return this.exceptionInit(o.self);
        // object.__init__ exists in Python, so super().__init__() at the top of a
        // hierarchy must quietly succeed rather than raise, and takes nothing.
        return new PyBuiltin('__init__', (a) => { if (a.length) raise('TypeError', 'object.__init__() takes exactly one argument (the instance to initialize)'); return null; });
      }
      if (OBJECT_DUNDERS.has(name)) refuseDunder(name, 'super()');
      return raise('AttributeError', `'super' object has no attribute '${name}'`);
    }
    if (o instanceof PyFunction) {
      if (name === '__name__') return o.code.name;
      if (name === '__qualname__') return o.code.qualname;
      if (name === '__doc__') return o.code.doc ?? null;
      if (name === '__class__') return T.function;
      const own = o.attrs?.get(name);
      if (own !== undefined) return own;
      if (isDunder(name)) refuseDunder(name, 'a function');
      return raise('AttributeError', `'function' object has no attribute '${name}'`);
    }
    if (o instanceof PyBuiltin) {
      if (name === '__name__' || name === '__qualname__') return o.name;
      if (name === '__self__' && o.self !== undefined) return o.self;
    }
    if (o instanceof PyBound) {
      if (name === '__self__') return o.self;
      if (name === '__func__') return o.fn;
      if (name === '__name__' || name === '__doc__' || name === '__qualname__') return this.getAttr(o.fn, name);
    }
    return methodOf(this, o, name);
  }

  /**
   * What an exception's own __init__ does: it sets args. A no-op here meant that
   * super().__init__(f"bad age: {age}") printed the age and not the message, with no error.
   */
  private exceptionInit(self: PyInstance | null): Val {
    return new PyBuiltin('__init__', (a, kw) => {
      if (kw.size) raise('TypeError', 'Exception() takes no keyword arguments');
      const target = self ?? a[0], args = self ? a : a.slice(1);
      if (!(target instanceof PyInstance) || !target.cls.isSub(T.BaseException)) return raise('TypeError', "descriptor '__init__' requires a 'BaseException' object");
      target.attrs.set('args', new PyTuple(args));
      return null;
    });
  }

  getItem(o: Val, i0: Val): Val {
    // An object with __index__ can stand in for a position. It can't be a slice or a key.
    const i = i0 instanceof PyInstance && !(o instanceof PyDict) && !(o instanceof PyInstance) && o !== null && (o instanceof PyList || o instanceof PyTuple || typeof o === 'string' || o instanceof PyRange) ? this.positionOf(i0) : i0;
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
      if (o instanceof PyRange) {
        // In whole numbers: as a float, range(10 ** 30)[10 ** 29] came back slightly wrong.
        const big = i === true ? 1n : i === false ? 0n : i as bigint, len = o.len, at = big < 0n ? big + len : big;
        if (at < 0n || at >= len) raise('IndexError', 'range object index out of range');
        return o.start + at * o.step;
      }
      const n = Number(i === true ? 1n : i === false ? 0n : i);
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

  private positionOf(v: PyInstance): Val {
    if (v.cls.lookup('__index__') === undefined) return v;
    return index(v);
  }

  private sliceBounds(len: number, s: PySlice): { start: number; stop: number; step: number } {
    const int = (v: Val, d: number) => {
      if (v === null) return d;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (v instanceof PyInstance && v.cls.lookup('__index__') !== undefined) return Number(index(v));
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

  /** Real Python reads a sequence's index before it finds out the sequence can't be changed. */
  private readIndex(o: Val, i: Val) {
    if (typeof o === 'string' || o instanceof PyTuple || o instanceof PyRange || o instanceof PySet || (o instanceof PyInstance && o.cls.lookup('__setitem__') === undefined && o.cls.lookup('__delitem__') === undefined)) {
      if (typeof i === 'bigint' && (i >= 2n ** 63n || i < -(2n ** 63n))) raise('IndexError', "cannot fit 'int' into an index-sized integer");
    }
  }

  private setItem(o: Val, i0: Val, v: Val) {
    const i = o instanceof PyList && i0 instanceof PyInstance ? this.positionOf(i0) : i0;
    this.readIndex(o, i);
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

  private delItem(o: Val, i0: Val) {
    const i = o instanceof PyList && i0 instanceof PyInstance ? this.positionOf(i0) : i0;
    this.readIndex(o, i);
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
      if (typeof i !== 'bigint' && typeof i !== 'boolean') raise('TypeError', `list indices must be integers or slices, not ${tname(i)}`);
      const n = Number(i === true ? 1n : i === false ? 0n : i), at = n < 0 ? n + o.items.length : n;
      if (at < 0 || at >= o.items.length) raise('IndexError', 'list assignment index out of range');
      o.items.splice(at, 1);
      return;
    }
    if (o instanceof PyInstance && o.cls.lookup('__delitem__') !== undefined) { hooks.dunder(o, '__delitem__', [i]); return; }
    raise('TypeError', `'${tname(o)}' object doesn't support item deletion`);
  }

  iter(v: Val): PyIter {
    if (v instanceof PyIter) return v;
    if (v instanceof PyList || v instanceof PyTuple) {
      // By live index, not a copy: appending during a loop extends the loop and
      // removing during one skips items, both of which real Python does.
      let i = 0;
      return new PyIter(v instanceof PyList ? 'list_iterator' : 'tuple_iterator', () => (i < v.items.length ? v.items[i++] : undefined));
    }
    if (v instanceof PyRange) {
      let cur = v.start; const { stop, step } = v;
      return new PyIter('range_iterator', () => { if (step > 0n ? cur >= stop : cur <= stop) return undefined; const r = cur; cur += step; return r; });
    }
    if (typeof v === 'string') { const cs = chars(v); let i = 0; return new PyIter(/^[\x00-\x7f]*$/.test(v) ? 'str_ascii_iterator' : 'str_iterator', () => (i < cs.length ? cs[i++] : undefined)); }
    if (v instanceof PyDict || v instanceof PyView) {
      const d = v instanceof PyDict ? v : v.d;
      const kind = v instanceof PyDict ? 'keys' : v.kind;
      // A live walk, not a snapshot: records-and-maps says changing a value while looping
      // is fine, and a snapshot went on showing the old value. A JavaScript Map's iterator
      // sees later insertions and skips deletions, which is what Python's does as well.
      const live = d.map.values(), size = d.map.size;
      let left = size, done = false;
      return new PyIter(kind === 'keys' ? 'dict_keyiterator' : kind === 'values' ? 'dict_valueiterator' : 'dict_itemiterator', () => {
        if (done) return undefined;
        if (d.map.size !== size) raise('RuntimeError', 'dictionary changed size during iteration');
        const n = live.next();
        if (n.done) { done = true; return undefined; }
        if (left-- <= 0) raise('RuntimeError', 'dictionary keys changed during iteration');
        const [k, x] = n.value;
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
      // The older way to be iterable, and it still works: count up until IndexError.
      if (v.cls.lookup('__getitem__') !== undefined) {
        let i = 0n;
        return new PyIter('iterator', () => {
          try { return hooks.dunder(v, '__getitem__', [i++]); }
          catch (e) { if (e instanceof PyRaise && (e.exc.cls.isSub(T.IndexError) || e.exc.cls.isSub(T.StopIteration))) return undefined; throw e; }
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
    // Real Python looks a set up as a frozen copy of itself. This sandbox has no frozensets,
    // so no set here can hold one, and {1} in {1} is False rather than "unhashable".
    if (c instanceof PySet) return x instanceof PySet ? false : c.map.has(hashKey(x));
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

  private compareOp(op: string, a: Val, b: Val): Val {
    // What a class's __eq__ or __lt__ gives back is the answer, whatever it is: `a < b` is
    // that value on real Python, and turning it into True or False here would change it.
    const pair = RICH[op];
    if (pair && (a instanceof PyInstance || b instanceof PyInstance)) {
      if (a instanceof PyInstance) { const r = hooks.dunder(a, pair[0], [b]); if (r !== undefined) return r; }
      if (b instanceof PyInstance) { const r = hooks.dunder(b, pair[1], [a]); if (r !== undefined) return r; }
    }
    switch (op) {
      case '==': return eq(a, b);
      case '!=': return !eq(a, b);
      case 'is': return this.isSame(a, b);
      case 'is not': return !this.isSame(a, b);
      case 'in': return this.contains(b, a);
      case 'not in': return !this.contains(b, a);
      default: return compare(op as '<', a, b);
    }
  }

  /**
   * For two equal numbers, strings or tuples, real Python's answer to `is` depends on how it
   * happened to store them: "hello world" is " ".join(["hello", "world"]) is False there,
   * and strings have no identity here, so this said True. It won't guess. Two different
   * values can't be the same object, so that much it can answer.
   */
  private isSame(a: Val, b: Val): boolean {
    const refuse = () => raise('SandboxLimit', "real Python's answer to `is` on two equal numbers, strings or tuples depends on how it happened to store them, so this sandbox won't guess. Use == to compare values");
    if ((typeof a === 'string' && typeof b === 'string') || (typeof a === 'bigint' && typeof b === 'bigint')) return a === b ? refuse() : false;
    if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) ? refuse() : false;
    if (a instanceof PyTuple && b instanceof PyTuple && (a === b || eq(a, b))) return a === b ? true : refuse();
    return a === b;
  }

  /** a += b. A class's own __iadd__ comes first, and lists, sets and dicts change in place, so every other name for them sees it. */
  private inPlace(op: string, a: Val, b: Val): Val {
    if (a instanceof PyInstance && DUNDER[op]) { const r = hooks.dunder(a, DUNDER[op].replace('__', '__i'), [b]); if (r !== undefined) return r; }
    if (a instanceof PyList) {
      if (op === '+') { for (const x of this.toList(b)) a.items.push(x); return a; }
      if (op === '*' && (typeof b === 'bigint' || typeof b === 'boolean')) { a.items = (binop('*', a, b) as PyList).items; return a; }
    }
    if (a instanceof PySet && b instanceof PySet && (op === '|' || op === '&' || op === '-' || op === '^')) { a.map = (binop(op, a, b) as PySet).map; return a; }
    if (a instanceof PyDict && op === '|') {
      if (b instanceof PyDict) for (const [k, v] of [...b.map.values()]) dictSet(a, k, v);
      else for (const p of this.toList(b)) {
        const q = this.toList(p);
        if (q.length !== 2) raise('ValueError', 'dictionary update sequence element has the wrong length; 2 is required');
        dictSet(a, q[0], q[1]);
      }
      return a;
    }
    return binop(op, a, b);
  }

  private tick() {
    const f = this.frames.at(-1)!;
    const ins = f.code.ins[f.pc++], s = f.stack;
    switch (ins.op) {
      case 'LINE': f.line = ins.line; this.ops++; if (this.ops > this.maxOps) throw new Stop('budget'); break;
      case 'SETLINE': f.line = ins.line; break;
      case 'CONST': s.push(ins.a); break;
      case 'LOAD': s.push(this.load(f, ins.a)); break;
      case 'STORE': this.store(f, ins.a, s.pop()!); break;
      case 'DEL': {
        const had = f.code.globalNames.has(ins.a) ? this.globals.vars.delete(ins.a) : f.env.vars.delete(ins.a);
        if (!had) raise('NameError', `name '${ins.a}' is not defined`);
        break;
      }
      case 'POP': s.pop(); break;
      case 'DUP': s.push(s.at(-1)!); break;
      case 'DUP2': s.push(s.at(-2)!, s.at(-1)!); break;
      case 'ROT2': { const b = s.pop()!, a = s.pop()!; s.push(b, a); break; }
      case 'ROT3': { const c = s.pop()!, b = s.pop()!, a = s.pop()!; s.push(c, a, b); break; }
      case 'BIN': { const b = s.pop()!, a = s.pop()!; this.ops++; s.push(binop(ins.a, a, b)); break; }
      case 'IBIN': {
        const b = s.pop()!, a = s.pop()!;
        this.ops++;
        s.push(this.inPlace(ins.a, a, b));
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
      case 'BUILD_STAR': {
        // [*a, b]: ins.a says which of the values on the stack to spread.
        const flags: boolean[] = ins.a, vals = flags.length ? s.splice(s.length - flags.length) : [], out: Val[] = [];
        flags.forEach((star, i) => {
          if (!star) { out.push(vals[i]); return; }
          const v = vals[i];
          if (!(v instanceof PyInstance) && !(v instanceof PyIter) && !(v instanceof PyView) && !(typeof v === 'string') && !(v instanceof PyList) && !(v instanceof PyTuple) && !(v instanceof PyDict) && !(v instanceof PySet) && !(v instanceof PyRange)) raise('TypeError', `Value after * must be an iterable, not ${tname(v)}`);
          out.push(...this.toList(v));
        });
        if (ins.b === 'set') { const o = new PySet(); for (const x of out) setAdd(o, x); s.push(o); }
        else s.push(ins.b === 'list' ? new PyList(out) : new PyTuple(out));
        break;
      }
      case 'BUILD_DICT_STAR': {
        // {**a, "k": 1}: one stack value for a spread, two for a pair.
        const flags: boolean[] = ins.a, o = new PyDict();
        const vals = s.splice(s.length - flags.reduce((n, star) => n + (star ? 1 : 2), 0));
        let at = 0;
        for (const star of flags) {
          if (!star) { dictSet(o, vals[at], vals[at + 1]); at += 2; continue; }
          const v = vals[at++];
          if (!(v instanceof PyDict)) raise('TypeError', `'${tname(v)}' object is not a mapping`);
          for (const [k, x] of (v as PyDict).map.values()) dictSet(o, k, x);
        }
        s.push(o);
        break;
      }
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
        else if (ins.b === 'a') raise('SandboxLimit', 'real Python has ascii() and !a; this sandbox does not yet');
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
        const gone = o instanceof PyInstance ? o.attrs.delete(ins.a) : o instanceof PyFunction ? !!o.attrs?.delete(ins.a) : o instanceof PyClass && !o.builtin ? o.attrs.delete(ins.a) : false;
        if (!gone) raise('AttributeError', `'${tname(o)}' object has no attribute '${ins.a}'`);
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
        if (ins.b !== undefined) {
          // a, *b, c = ...: ins.a names go before the star and ins.b after it.
          if (items.length < ins.a + ins.b) raise('ValueError', `not enough values to unpack (expected at least ${ins.a + ins.b}, got ${items.length})`);
          const mid = new PyList(items.slice(ins.a, items.length - ins.b));
          items = [...items.slice(0, ins.a), mid, ...items.slice(items.length - ins.b)];
        } else {
          if (items.length < ins.a) raise('ValueError', `not enough values to unpack (expected ${ins.a}, got ${items.length})`);
          if (items.length > ins.a) raise('ValueError', `too many values to unpack (expected ${ins.a})`);
        }
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
        cls.qualname = ins.a.qualname;
        const env = new Env(f.env);
        this.frames.push({ code: ins.a, pc: 0, stack: [], env, tries: [], handling: [], line: ins.line });
        // Run the body to its end now: a class statement has no stops of its own
        // worth showing, and its namespace must exist before the next statement.
        const base2 = this.frames.length - 1;
        while (this.frames.length > base2) {
          try { this.tick(); }
          catch (e) { if (!(e instanceof PyRaise) || !this.unwind(e, base2)) throw e; }
        }
        for (const [k, v] of env.vars) {
          if (CLASS_NAMES_NOT_HONOURED.has(k)) raise('SandboxLimit', `real Python's classes can define ${k}; this sandbox would never call it, so it won't pretend`);
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
        if (fn instanceof PyBuiltin && fn.name === 'super') {
          if (nkw) raise('TypeError', 'super() takes no keyword arguments');
          s.push(this.makeSuper(f, args));
          break;
        }
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
      case 'SETUP_TRY': f.tries.push({ target: ins.a, height: s.length, handling: f.handling.length }); break;
      case 'POP_TRY': f.tries.pop(); break;
      case 'EXC_ENTER': {
        const exc = s.pop() as PyInstance;
        if (ins.a) this.store(f, ins.a, exc);
        f.handling.push({ exc, name: ins.a });
        break;
      }
      case 'EXC_LEAVE': {
        // Python deletes the name after the handler: reading `e` below it is a
        // NameError, which surprises people, so it has to here too.
        const h = f.handling.pop()!;
        if (h.name) (f.code.globalNames.has(h.name) ? this.globals : f.env).vars.delete(h.name);
        break;
      }
      case 'EXC_MATCH': {
        const type = s.pop()!, e = s.pop()! as PyInstance;
        const types = type instanceof PyTuple ? type.items : [type];
        for (const t of types) if (!(t instanceof PyClass)) raise('TypeError', 'catching classes that do not inherit from BaseException is not allowed');
        s.push(types.some((t) => e.cls.isSub(t as PyClass)));
        break;
      }
      case 'RAISE': {
        if (!ins.a) {
          const during = this.handled();
          if (!during) raise('RuntimeError', 'No active exception to reraise');
          throw new PyRaise(during!, true);
        }
        let e = s.pop() as Val;
        if (e instanceof PyClass && e.isSub(T.BaseException)) e = this.callValue(e, []);
        if (!(e instanceof PyInstance) || !e.cls.isSub(T.BaseException)) raise('TypeError', 'exceptions must derive from BaseException');
        throw new PyRaise(e as PyInstance);
      }
      case 'RERAISE': throw new PyRaise(s.pop() as PyInstance, true);
      default: throw new Error(`unknown instruction ${ins.op}`);
    }
  }

  setAttr(o: Val, name: string, v: Val) {
    if (o instanceof PyInstance) {
      // object() really does refuse attributes on real Python. A class of your own doesn't.
      if (o.cls === T.object) raise('AttributeError', `'object' object has no attribute '${name}'`);
      o.attrs.set(name, v);
      return;
    }
    if (o instanceof PyClass) {
      if (o.builtin) raise('TypeError', `cannot set '${name}' attribute of immutable type '${o.name}'`);
      o.attrs.set(name, v);
      return;
    }
    // def f(): ... then f.count = 0 is ordinary Python.
    if (o instanceof PyFunction) { (o.attrs ??= new Map()).set(name, v); return; }
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
      if (e instanceof OutOfInput || e instanceof SandboxStop) { this.frames = []; return { ok: false, error: { type: 'SandboxLimit', message: e.message, line: 0, stack: [] } }; }
      if (e instanceof PyRaise) { this.frames = []; return { ok: false, error: { ...this.failure(e.exc), stack: [] } }; }
      // A mission's check reaches the engine through here, and a raw exception would stop
      // the panel updating with no message. It reports as the site's bug, like a run does.
      this.frames = [];
      return { ok: false, error: { type: 'SandboxBug', message: e instanceof Error ? `${e.name}: ${e.message}` : String(e), line: 0, stack: [] } };
    }
    finally { this.status = 'done'; }
  }
}

