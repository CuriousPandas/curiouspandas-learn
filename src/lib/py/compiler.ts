// AST to a small stack bytecode. A VM rather than a tree walker for three
// reasons the lessons rely on: recursion lives in an explicit frame list, so
// RecursionError comes from the limit and not from JavaScript's stack; a program
// can stop at any instruction, which is what the stepper is; and the bytecode
// is itself something the compiler lesson can show.

import { PyError } from './lexer.ts';
import { parse, type Expr, type Param, type Stmt } from './parser.ts';

export type Ins = { op: string; a?: any; b?: any; line: number };
export type Code = {
  name: string; qualname: string; kind: 'module' | 'fn' | 'class';
  params: string[]; ins: Ins[];
  // Python decides a name is local by whether the function assigns it anywhere,
  // before running a line. That rule is why reading x above `x = 1` inside a
  // function is UnboundLocalError and not the global x, so it is computed here.
  locals: Set<string>; globalNames: Set<string>; nonlocals: Set<string>;
  hidden?: boolean;
};

const assigned = (t: Expr, out: Set<string>) => {
  if (t.k === 'name') out.add(t.name);
  else if (t.k === 'tuple' || t.k === 'list') t.items.forEach((x) => assigned(x, out));
};

function scan(body: Stmt[], locals: Set<string>, globalNames: Set<string>, nonlocals: Set<string>) {
  for (const s of body) {
    switch (s.k) {
      case 'assign': s.targets.forEach((t) => assigned(t, locals)); break;
      case 'aug': assigned(s.target, locals); break;
      case 'for': assigned(s.target, locals); scan(s.body, locals, globalNames, nonlocals); break;
      case 'def': case 'class': locals.add(s.name); break;
      case 'if': scan(s.body, locals, globalNames, nonlocals); scan(s.orelse, locals, globalNames, nonlocals); break;
      case 'while': scan(s.body, locals, globalNames, nonlocals); break;
      case 'try':
        scan(s.body, locals, globalNames, nonlocals); scan(s.orelse, locals, globalNames, nonlocals);
        for (const h of s.handlers) { if (h.name) locals.add(h.name); scan(h.body, locals, globalNames, nonlocals); }
        break;
      case 'global': s.names.forEach((n) => globalNames.add(n)); break;
      case 'nonlocal': s.names.forEach((n) => nonlocals.add(n)); break;
      case 'del': s.targets.forEach((t) => assigned(t, locals)); break;
    }
  }
  for (const n of [...globalNames, ...nonlocals]) locals.delete(n);
}

type Loop = { breaks: number[]; head: number; isFor: boolean; tries: number };

class Compiler {
  code: Code;
  loops: Loop[] = [];
  tries = 0;
  constructor(code: Code) { this.code = code; }
  emit(op: string, line: number, a?: any, b?: any) { this.code.ins.push({ op, a, b, line }); return this.code.ins.length - 1; }
  here() { return this.code.ins.length; }
  patch(i: number) { this.code.ins[i].a = this.here(); }

  body(stmts: Stmt[]) { for (const s of stmts) this.stmt(s); }

  stmt(s: Stmt) {
    const line = s.line;
    // LINE is one stop for the stepper. Compound statements place their own at
    // the test, so a loop header is revisited on each pass as it is in a debugger.
    if (s.k !== 'if' && s.k !== 'while' && s.k !== 'for') this.emit('LINE', line);
    switch (s.k) {
      case 'expr': this.expr(s.e); this.emit('POP', line); break;
      case 'pass': break;
      case 'assign':
        this.expr(s.value);
        s.targets.forEach((t, i) => { if (i < s.targets.length - 1) this.emit('DUP', line); this.store(t); });
        break;
      case 'aug': this.aug(s, line); break;
      case 'if': {
        this.emit('LINE', line);
        this.expr(s.test);
        const jf = this.emit('JIF', line);
        this.body(s.body);
        if (s.orelse.length) {
          const end = this.emit('JUMP', line);
          this.patch(jf);
          this.body(s.orelse);
          this.patch(end);
        } else this.patch(jf);
        break;
      }
      case 'while': {
        const head = this.here();
        this.emit('LINE', line);
        this.expr(s.test);
        const jf = this.emit('JIF', line);
        const l: Loop = { breaks: [], head, isFor: false, tries: this.tries };
        this.loops.push(l);
        this.body(s.body);
        this.loops.pop();
        this.emit('JUMP', line, head);
        this.patch(jf);
        l.breaks.forEach((b) => this.patch(b));
        break;
      }
      case 'for': {
        this.expr(s.iter);
        this.emit('GETITER', line);
        const head = this.here();
        this.emit('LINE', line);
        const fi = this.emit('FORITER', line);
        this.store(s.target);
        const l: Loop = { breaks: [], head, isFor: true, tries: this.tries };
        this.loops.push(l);
        this.body(s.body);
        this.loops.pop();
        this.emit('JUMP', line, head);
        this.patch(fi);
        l.breaks.forEach((b) => this.patch(b));
        break;
      }
      case 'break': case 'continue': {
        const l = this.loops.at(-1);
        if (!l) throw new PyError('SyntaxError', `'${s.k}' outside loop`, line);
        for (let i = this.tries; i > l.tries; i--) this.emit('POP_TRY', line);
        if (s.k === 'continue') { this.emit('JUMP', line, l.head); break; }
        if (l.isFor) this.emit('POP', line);
        l.breaks.push(this.emit('JUMP', line));
        break;
      }
      case 'return':
        if (this.code.kind !== 'fn') throw new PyError('SyntaxError', "'return' outside function", line);
        if (s.e) this.expr(s.e); else this.emit('CONST', line, null);
        this.emit('RETURN', line);
        break;
      case 'def': {
        this.fn(s.name, s.params, s.body, line);
        this.emit('STORE', line, s.name);
        break;
      }
      case 'class': {
        if (s.base) this.expr(s.base);
        const code = newCode(s.name, this.qual(s.name), 'class');
        const c = new Compiler(code);
        c.body(s.body);
        c.emit('CONST', line, null);
        c.emit('RETURN', line);
        this.emit('MAKE_CLASS', line, code, !!s.base);
        this.emit('STORE', line, s.name);
        break;
      }
      case 'global': case 'nonlocal': break;
      case 'try': this.tryStmt(s, line); break;
      case 'raise':
        if (s.e) this.expr(s.e);
        this.emit('RAISE', line, !!s.e);
        break;
      case 'assert': {
        this.expr(s.test);
        const ok = this.emit('JIT', line);
        this.emit('LOAD', line, 'AssertionError');
        if (s.msg) { this.expr(s.msg); this.emit('CALL', line, 1, []); } else this.emit('CALL', line, 0, []);
        this.emit('RAISE', line, true);
        this.patch(ok);
        break;
      }
      case 'del':
        for (const t of s.targets) {
          if (t.k === 'name') this.emit('DEL', line, t.name);
          else if (t.k === 'index') { this.expr(t.obj); this.expr(t.idx); this.emit('DELITEM', line); }
          else if (t.k === 'attr') { this.expr(t.obj); this.emit('DELATTR', line, t.name); }
          else throw new PyError('SyntaxError', 'cannot delete this expression', line);
        }
        break;
    }
  }

  tryStmt(s: Extract<Stmt, { k: 'try' }>, line: number) {
    const setup = this.emit('SETUP_TRY', line);
    this.tries++;
    this.body(s.body);
    this.tries--;
    this.emit('POP_TRY', line);
    this.body(s.orelse);
    const toEnd = [this.emit('JUMP', line)];
    this.patch(setup);
    for (const h of s.handlers) {
      this.emit('LINE', h.line);
      let next = -1;
      if (h.type) {
        this.emit('DUP', h.line);
        this.expr(h.type);
        this.emit('EXC_MATCH', h.line);
        next = this.emit('JIF', h.line);
      }
      if (h.name) this.emit('STORE', h.line, h.name); else this.emit('POP', h.line);
      this.body(h.body);
      // Python deletes the name after the handler: reading `e` below it is a
      // NameError, which surprises people, so it has to here too.
      if (h.name) this.emit('DEL_QUIET', h.line, h.name);
      toEnd.push(this.emit('JUMP', h.line));
      if (next >= 0) this.patch(next);
    }
    this.emit('RERAISE', line);
    toEnd.forEach((j) => this.patch(j));
  }

  aug(s: Extract<Stmt, { k: 'aug' }>, line: number) {
    const t = s.target;
    if (t.k === 'name') {
      this.emit('LOAD', line, t.name);
      this.expr(s.value);
      this.emit('IBIN', line, s.op);
      this.emit('STORE', line, t.name);
    } else if (t.k === 'index') {
      this.expr(t.obj); this.expr(t.idx);
      this.emit('DUP2', line);
      this.emit('GETITEM', line);
      this.expr(s.value);
      this.emit('IBIN', line, s.op);
      this.emit('SETITEM_AUG', line);
    } else if (t.k === 'attr') {
      this.expr(t.obj);
      this.emit('DUP', line);
      this.emit('GETATTR', line, t.name);
      this.expr(s.value);
      this.emit('IBIN', line, s.op);
      this.emit('SETATTR_AUG', line, t.name);
    }
  }

  store(t: Expr) {
    const line = t.line;
    switch (t.k) {
      case 'name': this.emit('STORE', line, t.name); break;
      case 'index': this.expr(t.obj); this.expr(t.idx); this.emit('SETITEM', line); break;
      case 'attr': this.expr(t.obj); this.emit('SETATTR', line, t.name); break;
      case 'tuple': case 'list':
        this.emit('UNPACK', line, t.items.length);
        t.items.forEach((x) => this.store(x));
        break;
      default: throw new PyError('SyntaxError', 'cannot assign to this expression', line);
    }
  }

  qual(name: string) {
    const q = this.code.qualname;
    if (this.code.kind === 'module') return name;
    return this.code.kind === 'class' ? `${q}.${name}` : `${q}.<locals>.${name}`;
  }

  fn(name: string, params: Param[], body: Stmt[] | Expr, line: number) {
    const code = newCode(name, this.qual(name), 'fn');
    code.params = params.map((p) => p.name);
    const seen = new Set<string>();
    for (const p of code.params) {
      if (seen.has(p)) throw new PyError('SyntaxError', `duplicate argument '${p}' in function definition`, line);
      seen.add(p);
    }
    const defaults = params.filter((p) => p.def);
    defaults.forEach((p) => this.expr(p.def!));
    const c = new Compiler(code);
    if (Array.isArray(body)) {
      scan(body, code.locals, code.globalNames, code.nonlocals);
      code.params.forEach((p) => code.locals.add(p));
      c.body(body);
      c.emit('CONST', line, null);
      c.emit('RETURN', line);
    } else {
      code.params.forEach((p) => code.locals.add(p));
      c.emit('LINE', line);
      c.expr(body);
      c.emit('RETURN', line);
    }
    this.emit('MAKE_FN', line, code, defaults.length);
  }

  expr(e: Expr) {
    const line = e.line;
    switch (e.k) {
      case 'const': this.emit('CONST', line, e.v); break;
      case 'name': this.emit('LOAD', line, e.name); break;
      case 'fstr': {
        for (const p of e.parts) {
          if (typeof p === 'string') this.emit('CONST', line, p);
          else { this.expr(p.e); this.emit('FORMAT', line, p.spec ?? '', p.conv); }
        }
        this.emit('JOIN', line, e.parts.length);
        break;
      }
      case 'list': e.items.forEach((x) => this.expr(x)); this.emit('BUILD_LIST', line, e.items.length); break;
      case 'tuple': e.items.forEach((x) => this.expr(x)); this.emit('BUILD_TUPLE', line, e.items.length); break;
      case 'set': e.items.forEach((x) => this.expr(x)); this.emit('BUILD_SET', line, e.items.length); break;
      case 'dict': for (const [k, v] of e.items) { this.expr(k); this.expr(v); } this.emit('BUILD_DICT', line, e.items.length); break;
      case 'bin': this.expr(e.l); this.expr(e.r); this.emit('BIN', line, e.op); break;
      case 'unary': this.expr(e.e); this.emit('UN', line, e.op); break;
      case 'not': this.expr(e.e); this.emit('NOT', line); break;
      case 'and': { this.expr(e.l); const j = this.emit('JIF_KEEP', line); this.expr(e.r); this.patch(j); break; }
      case 'or': { this.expr(e.l); const j = this.emit('JIT_KEEP', line); this.expr(e.r); this.patch(j); break; }
      case 'ifexp': {
        this.expr(e.test);
        const jf = this.emit('JIF', line);
        this.expr(e.a);
        const end = this.emit('JUMP', line);
        this.patch(jf);
        this.expr(e.b);
        this.patch(end);
        break;
      }
      case 'cmp': {
        this.expr(e.first);
        const outs: number[] = [];
        e.rest.forEach((r, i) => {
          this.expr(r.e);
          if (i < e.rest.length - 1) {
            // a < b < c evaluates b once: keep a copy underneath for the next link.
            this.emit('DUP', line); this.emit('ROT3', line);
            this.emit('CMP', line, r.op);
            outs.push(this.emit('JIF_KEEP', line));
          } else this.emit('CMP', line, r.op);
        });
        if (outs.length) {
          const end = this.emit('JUMP', line);
          outs.forEach((o) => this.patch(o));
          this.emit('ROT2', line); this.emit('POP', line);
          this.patch(end);
        }
        break;
      }
      case 'call':
        this.expr(e.fn);
        e.args.forEach((a) => this.expr(a));
        e.kw.forEach(([, v]) => this.expr(v));
        this.emit('CALL', line, e.args.length, e.kw.map(([k]) => k));
        break;
      case 'index': this.expr(e.obj); this.expr(e.idx); this.emit('GETITEM', line); break;
      case 'slice':
        for (const p of [e.lo, e.hi, e.step]) { if (p) this.expr(p); else this.emit('CONST', line, null); }
        this.emit('BUILD_SLICE', line);
        break;
      case 'attr': this.expr(e.obj); this.emit('GETATTR', line, e.name); break;
      case 'lambda': this.fn('<lambda>', e.params, e.body, line); break;
      case 'comp': this.comp(e, line); break;
    }
  }

  comp(e: Extract<Expr, { k: 'comp' }>, line: number) {
    const name = `<${e.kind}comp>`, code = newCode(name, this.qual(name), 'fn');
    code.hidden = true;
    code.params = ['.0'];
    code.locals.add('.0'); code.locals.add('.r');
    for (const c of e.clauses) assigned(c.target, code.locals);
    const c = new Compiler(code);
    c.emit(e.kind === 'list' ? 'BUILD_LIST' : e.kind === 'set' ? 'BUILD_SET' : 'BUILD_DICT', line, 0);
    c.emit('STORE', line, '.r');
    const level = (i: number) => {
      const cl = e.clauses[i];
      if (i === 0) c.emit('LOAD', line, '.0'); else c.expr(cl.iter);
      c.emit('GETITER', line);
      const head = c.here();
      const fi = c.emit('FORITER', line);
      c.store(cl.target);
      for (const f of cl.ifs) { c.expr(f); const skip = c.emit('JIF', line); code.ins[skip].a = head; }
      if (i + 1 < e.clauses.length) level(i + 1);
      else {
        c.emit('LOAD', line, '.r');
        c.expr(e.elt);
        if (e.val) c.expr(e.val);
        c.emit('COMP_ADD', line, e.kind);
      }
      c.emit('JUMP', line, head);
      c.patch(fi);
    };
    level(0);
    c.emit('LOAD', line, '.r');
    c.emit('RETURN', line);
    this.emit('MAKE_FN', line, code, 0);
    this.expr(e.clauses[0].iter);
    this.emit('CALL', line, 1, []);
  }
}

function newCode(name: string, qualname: string, kind: Code['kind']): Code {
  return { name, qualname, kind, params: [], ins: [], locals: new Set(), globalNames: new Set(), nonlocals: new Set() };
}

export function compile(src: string): Code {
  const code = newCode('<module>', '<module>', 'module');
  const c = new Compiler(code);
  c.body(parse(src));
  c.emit('CONST', 0, null);
  c.emit('RETURN', 0);
  return code;
}

