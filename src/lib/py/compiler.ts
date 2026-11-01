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
  // Which source this came from, for a traceback. Unset is the learner's program;
  // a lab's given code sets it, because its line numbers count from its own top.
  file?: string;
  params: string[]; ins: Ins[];
  // Python decides a name is local by whether the function assigns it anywhere,
  // before running a line. That rule is why reading x above `x = 1` inside a
  // function is UnboundLocalError and not the global x, so it is computed here.
  locals: Set<string>; globalNames: Set<string>; nonlocals: Set<string>;
  hidden?: boolean;
  doc?: string;
};

const assigned = (t: Expr, out: Set<string>) => {
  if (t.k === 'name') out.add(t.name);
  else if (t.k === 'tuple' || t.k === 'list') t.items.forEach((x) => assigned(x, out));
  else if (t.k === 'star') assigned(t.e, out);
};

function scan(body: Stmt[], locals: Set<string>, globalNames: Set<string>, nonlocals: Set<string>) {
  for (const s of body) {
    switch (s.k) {
      case 'assign': s.targets.forEach((t) => assigned(t, locals)); break;
      case 'aug': assigned(s.target, locals); break;
      case 'annot': assigned(s.target, locals); break;
      case 'for': assigned(s.target, locals); scan(s.body, locals, globalNames, nonlocals); break;
      case 'def': case 'class': locals.add(s.name); break;
      case 'if': scan(s.body, locals, globalNames, nonlocals); scan(s.orelse, locals, globalNames, nonlocals); break;
      case 'while': scan(s.body, locals, globalNames, nonlocals); break;
      case 'try':
        scan(s.body, locals, globalNames, nonlocals); scan(s.orelse, locals, globalNames, nonlocals);
        for (const h of s.handlers) { if (h.name) locals.add(h.name); scan(h.body, locals, globalNames, nonlocals); }
        scan(s.finalbody, locals, globalNames, nonlocals);
        break;
      case 'global': s.names.forEach((n) => globalNames.add(n)); break;
      case 'nonlocal': s.names.forEach((n) => nonlocals.add(n)); break;
      case 'del': s.targets.forEach((t) => assigned(t, locals)); break;
    }
  }
  for (const n of [...globalNames, ...nonlocals]) locals.delete(n);
}

function subExprs(e: Expr): Expr[] {
  switch (e.k) {
    case 'list': case 'tuple': case 'set': return e.items;
    case 'dict': return e.items.flatMap(([k, v]) => (k ? [k, v] : [v]));
    case 'bin': case 'and': case 'or': return [e.l, e.r];
    case 'unary': case 'not': case 'star': return [e.e];
    case 'cmp': return [e.first, ...e.rest.map((r) => r.e)];
    case 'call': return [e.fn, ...e.args, ...e.kw.map(([, v]) => v)];
    case 'index': return [e.obj, e.idx];
    case 'slice': return [e.lo, e.hi, e.step].filter((x): x is Expr => !!x);
    case 'attr': return [e.obj];
    case 'lambda': return [...e.params.flatMap((p) => (p.def ? [p.def] : [])), e.body];
    case 'ifexp': return [e.test, e.a, e.b];
    case 'comp': return [e.elt, ...(e.val ? [e.val] : []), ...e.clauses.flatMap((c) => [c.target, c.iter, ...c.ifs])];
    case 'fstr': return e.parts.flatMap((p) => (typeof p === 'string' ? [] : [p.e]));
    default: return [];
  }
}

/**
 * Python's rules for global and nonlocal, which it enforces before running anything. In the
 * order the statements appear, because the rule is about order: `count = 1` then `global count`
 * ran here and is a SyntaxError on a real install.
 */
function checkDeclarations(body: Stmt[], params: string[], kind: Code['kind']) {
  const used = new Set<string>(), bound = new Set<string>(params), declared = new Map<string, 'global' | 'nonlocal'>();
  const use = (e: Expr | undefined) => {
    if (!e) return;
    if (e.k === 'name') { used.add(e.name); return; }
    // Their bodies are scopes of their own, apart from a lambda's defaults and a comprehension's first iterable.
    if (e.k === 'lambda') { e.params.forEach((p) => use(p.def)); return; }
    if (e.k === 'comp') { use(e.clauses[0].iter); return; }
    subExprs(e).forEach(use);
  };
  const bind = (t: Expr) => {
    if (t.k === 'name') bound.add(t.name);
    else if (t.k === 'tuple' || t.k === 'list') t.items.forEach(bind);
    else if (t.k === 'star') bind(t.e);
    else use(t);
  };
  const walk = (stmts: Stmt[]) => {
    for (const s of stmts) {
      switch (s.k) {
        case 'expr': use(s.e); break;
        case 'assign': s.targets.forEach(bind); use(s.value); break;
        case 'aug': bind(s.target); use(s.value); break;
        case 'annot': bind(s.target); break;
        case 'if': use(s.test); walk(s.body); walk(s.orelse); break;
        case 'while': use(s.test); walk(s.body); break;
        case 'for': bind(s.target); use(s.iter); walk(s.body); break;
        case 'def': s.params.forEach((p) => use(p.def)); bound.add(s.name); break;
        case 'class': use(s.base); bound.add(s.name); break;
        case 'return': use(s.e); break;
        case 'raise': use(s.e); break;
        case 'assert': use(s.test); use(s.msg); break;
        case 'del': s.targets.forEach(bind); break;
        case 'try':
          walk(s.body);
          for (const h of s.handlers) { use(h.type); if (h.name) bound.add(h.name); walk(h.body); }
          walk(s.orelse); walk(s.finalbody);
          break;
        case 'global': case 'nonlocal':
          if (s.k === 'nonlocal' && kind === 'module') throw new PyError('SyntaxError', 'nonlocal declaration not allowed at module level', s.line);
          for (const n of s.names) {
            if (params.includes(n)) throw new PyError('SyntaxError', `name '${n}' is parameter and ${s.k}`, s.line);
            if (used.has(n)) throw new PyError('SyntaxError', `name '${n}' is used prior to ${s.k} declaration`, s.line);
            if (bound.has(n)) throw new PyError('SyntaxError', `name '${n}' is assigned to before ${s.k} declaration`, s.line);
            if (declared.has(n) && declared.get(n) !== s.k) throw new PyError('SyntaxError', `name '${n}' is nonlocal and global`, s.line);
            declared.set(n, s.k);
          }
          break;
      }
    }
  };
  walk(body);
}

/**
 * Inside a class, __x means _ClassName__x, so a.__x from outside is an AttributeError on real
 * Python, and it's the whole point of writing it. Here it quietly worked. In place, at the
 * class's own compile, and only down to the next class, which uses its own name.
 */
function mangleBody(body: Stmt[], cls: string) {
  const fix = (n: string) => (n.startsWith('__') && !n.endsWith('__') && !n.includes('.') ? `_${cls}${n}` : n);
  const params = (ps: Param[]) => ps.forEach((p) => { p.name = fix(p.name); if (p.def) expr(p.def); });
  const expr = (e: Expr | undefined) => {
    if (!e) return;
    if (e.k === 'name' || e.k === 'attr') e.name = fix(e.name);
    if (e.k === 'call') e.kw.forEach((kv) => { kv[0] = fix(kv[0]); });
    if (e.k === 'lambda') params(e.params);
    subExprs(e).forEach(expr);
  };
  const walk = (stmts: Stmt[]) => {
    for (const s of stmts) {
      switch (s.k) {
        case 'expr': expr(s.e); break;
        case 'assign': s.targets.forEach(expr); expr(s.value); break;
        case 'aug': expr(s.target); expr(s.value); break;
        case 'annot': expr(s.target); break;
        case 'if': expr(s.test); walk(s.body); walk(s.orelse); break;
        case 'while': expr(s.test); walk(s.body); break;
        case 'for': expr(s.target); expr(s.iter); walk(s.body); break;
        case 'def': s.name = fix(s.name); params(s.params); walk(s.body); break;
        case 'class': s.name = fix(s.name); expr(s.base); break;
        case 'return': case 'raise': expr(s.e); break;
        case 'assert': expr(s.test); expr(s.msg); break;
        case 'del': s.targets.forEach(expr); break;
        case 'global': case 'nonlocal': s.names = s.names.map(fix); break;
        case 'try':
          walk(s.body);
          for (const h of s.handlers) { expr(h.type); if (h.name) h.name = fix(h.name); walk(h.body); }
          walk(s.orelse); walk(s.finalbody);
          break;
      }
    }
  };
  walk(body);
}

type Loop = { kind: 'loop'; breaks: number[]; head: number; isFor: boolean };
// What the code at this point is inside. Leaving by break, continue or return has
// to undo each one on the way out, and a finally runs its body as part of that.
type Block = Loop | { kind: 'try' } | { kind: 'handler' } | { kind: 'finally'; body: Stmt[] };

class Compiler {
  code: Code;
  blocks: Block[] = [];
  temps = 0;
  parent?: Compiler;
  constructor(code: Code, parent?: Compiler) { this.code = code; this.parent = parent; }

  /**
   * Undoes every block above `depth`, innermost first. A finally's body is compiled
   * again at each way out, as CPython does: there is no single place to jump back
   * from. It compiles as if already outside its own try, so a break or return
   * written in that body acts on what surrounds the try.
   */
  leave(depth: number, line: number) {
    for (let i = this.blocks.length - 1; i >= depth; i--) {
      const b = this.blocks[i];
      if (b.kind === 'try') this.emit('POP_TRY', line);
      else if (b.kind === 'handler') this.emit('EXC_LEAVE', line);
      // Only a return passes through a loop, and its value is safe in a temporary.
      // The iterator has to go, or a `continue` in an outer finally loops over it.
      else if (b.kind === 'loop') { if (b.isFor) this.emit('POP', line); }
      else {
        this.emit('POP_TRY', line);
        const saved = this.blocks;
        this.blocks = saved.slice(0, i);
        this.body(b.body);
        this.blocks = saved;
      }
    }
  }

  /**
   * A value held across a finally body lives in a hidden local, not on the stack:
   * a break in that body has to find the loop's iterator on top. The dot keeps it
   * out of the variables panel and out of reach of any name a program can write.
   */
  temp() {
    const name = `.t${this.temps++}`;
    if (this.code.kind === 'fn') this.code.locals.add(name);
    return name;
  }

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
      case 'pass': case 'annot': break;
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
        const l: Loop = { kind: 'loop', breaks: [], head, isFor: false };
        this.blocks.push(l);
        this.body(s.body);
        this.blocks.pop();
        this.emit('JUMP', line, head);
        this.patch(jf);
        l.breaks.forEach((b) => this.patch(b));
        break;
      }
      case 'for': {
        // Not a LINE: that would stop the stepper twice on the first pass. Without it
        // an error in the header (for x in 5) blamed the line above, or line 0.
        this.emit('SETLINE', line);
        this.expr(s.iter);
        this.emit('GETITER', line);
        const head = this.here();
        this.emit('LINE', line);
        const fi = this.emit('FORITER', line);
        this.store(s.target);
        const l: Loop = { kind: 'loop', breaks: [], head, isFor: true };
        this.blocks.push(l);
        this.body(s.body);
        this.blocks.pop();
        this.emit('JUMP', line, head);
        this.patch(fi);
        l.breaks.forEach((b) => this.patch(b));
        break;
      }
      case 'break': case 'continue': {
        const at = this.blocks.findLastIndex((b) => b.kind === 'loop');
        if (at < 0) throw new PyError('SyntaxError', s.k === 'break' ? "'break' outside loop" : "'continue' not properly in loop", line);
        const l = this.blocks[at] as Loop;
        this.leave(at + 1, line);
        if (s.k === 'continue') { this.emit('JUMP', line, l.head); break; }
        if (l.isFor) this.emit('POP', line);
        l.breaks.push(this.emit('JUMP', line));
        break;
      }
      case 'return':
        if (this.code.kind !== 'fn') throw new PyError('SyntaxError', "'return' outside function", line);
        if (s.e) this.expr(s.e); else this.emit('CONST', line, null);
        if (this.blocks.some((b) => b.kind === 'finally')) {
          // The value is worked out first and the finally runs after: `return f()`
          // calls f, then cleans up, then hands back what f gave.
          const t = this.temp();
          this.emit('STORE', line, t);
          this.leave(0, line);
          this.emit('LOAD', line, t);
        }
        this.emit('RETURN', line);
        break;
      case 'def': {
        this.fn(s.name, s.params, s.body, line);
        this.emit('STORE', line, s.name);
        break;
      }
      case 'class': {
        if (s.base) this.expr(s.base);
        const code = newCode(s.name, this.qual(s.name), 'class', this.code.file);
        const plain = s.name.replace(/^_+/, '');
        if (plain) mangleBody(s.body, plain);
        // Global names only: class bodies assign to their own namespace, not to locals.
        scan(s.body, new Set(), code.globalNames, code.nonlocals);
        checkDeclarations(s.body, [], 'class');
        const c = new Compiler(code, this);
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
      case 'del': s.targets.forEach((t) => this.delTarget(t, line)); break;
    }
  }

  delTarget(t: Expr, line: number) {
    if (t.k === 'name') this.emit('DEL', line, t.name);
    else if (t.k === 'index') { this.expr(t.obj); this.expr(t.idx); this.emit('DELITEM', line); }
    else if (t.k === 'attr') { this.expr(t.obj); this.emit('DELATTR', line, t.name); }
    // del (a, b) and del [a, b] are ordinary Python.
    else if (t.k === 'tuple' || t.k === 'list') t.items.forEach((x) => this.delTarget(x, line));
    else throw new PyError('SyntaxError', 'cannot delete this expression', line);
  }

  tryStmt(s: Extract<Stmt, { k: 'try' }>, line: number) {
    if (!s.finalbody.length) { this.tryExcept(s, line); return; }
    // The finally guards everything inside, handlers and else included, so it is
    // a try of its own wrapped around the try/except.
    const setup = this.emit('SETUP_TRY', line);
    this.blocks.push({ kind: 'finally', body: s.finalbody });
    if (s.handlers.length) this.tryExcept(s, line);
    else this.body(s.body);
    this.blocks.pop();
    this.emit('POP_TRY', line);
    this.body(s.finalbody);
    const end = this.emit('JUMP', line);
    this.patch(setup);
    // Something was raised: run the finally, then carry on raising it. A return or
    // break in the finally jumps past this RERAISE, which is how it discards the
    // exception, in real Python as well. Counts as handling it, so an error in the
    // finally is reported as "during handling of" this one, and a bare raise finds it.
    const t = this.temp();
    this.emit('STORE', line, t);
    this.emit('LOAD', line, t);
    this.emit('EXC_ENTER', line);
    this.blocks.push({ kind: 'handler' });
    this.body(s.finalbody);
    this.blocks.pop();
    this.emit('EXC_LEAVE', line);
    this.emit('LOAD', line, t);
    this.emit('RERAISE', line);
    this.patch(end);
  }

  tryExcept(s: Extract<Stmt, { k: 'try' }>, line: number) {
    const setup = this.emit('SETUP_TRY', line);
    this.blocks.push({ kind: 'try' });
    this.body(s.body);
    this.blocks.pop();
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
      this.emit('EXC_ENTER', h.line, h.name);
      this.blocks.push({ kind: 'handler' });
      this.body(h.body);
      this.blocks.pop();
      this.emit('EXC_LEAVE', h.line);
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
      case 'tuple': case 'list': {
        const stars = t.items.filter((x) => x.k === 'star').length;
        if (stars > 1) throw new PyError('SyntaxError', 'multiple starred expressions in assignment', line);
        if (stars) {
          const at = t.items.findIndex((x) => x.k === 'star');
          this.emit('UNPACK', line, at, t.items.length - at - 1);
        } else this.emit('UNPACK', line, t.items.length);
        t.items.forEach((x) => this.store(x.k === 'star' ? x.e : x));
        break;
      }
      case 'star': throw new PyError('SyntaxError', 'starred assignment target must be in a list or tuple', line);
      // The parser's checkTarget names the real reason first, so this is only a backstop.
      default: throw new PyError('SyntaxError', 'cannot assign to this expression', line);
    }
  }

  qual(name: string) {
    const q = this.code.qualname;
    if (this.code.kind === 'module') return name;
    return this.code.kind === 'class' ? `${q}.${name}` : `${q}.<locals>.${name}`;
  }

  fn(name: string, params: Param[], body: Stmt[] | Expr, line: number) {
    const code = newCode(name, this.qual(name), 'fn', this.code.file);
    code.params = params.map((p) => p.name);
    const seen = new Set<string>();
    for (const p of code.params) {
      if (seen.has(p)) throw new PyError('SyntaxError', `duplicate argument '${p}' in function definition`, line);
      seen.add(p);
    }
    const defaults = params.filter((p) => p.def);
    defaults.forEach((p) => this.expr(p.def!));
    const c = new Compiler(code, this);
    if (Array.isArray(body)) {
      checkDeclarations(body, code.params, 'fn');
      scan(body, code.locals, code.globalNames, code.nonlocals);
      code.params.forEach((p) => code.locals.add(p));
      for (const n of code.nonlocals) {
        let found = false;
        for (let p: Compiler | undefined = this; p && !found; p = p.parent) found = p.code.kind === 'fn' && (p.code.locals.has(n) || p.code.nonlocals.has(n));
        if (!found) throw new PyError('SyntaxError', `no binding for nonlocal '${n}' found`, line);
      }
      const head = body[0];
      if (head?.k === 'expr' && head.e.k === 'const' && typeof head.e.v === 'string') code.doc = head.e.v;
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
      case 'list': case 'tuple': case 'set':
        if (e.items.some((x) => x.k === 'star')) {
          e.items.forEach((x) => this.expr(x.k === 'star' ? x.e : x));
          this.emit('BUILD_STAR', line, e.items.map((x) => x.k === 'star'), e.k);
        } else {
          e.items.forEach((x) => this.expr(x));
          this.emit(e.k === 'list' ? 'BUILD_LIST' : e.k === 'tuple' ? 'BUILD_TUPLE' : 'BUILD_SET', line, e.items.length);
        }
        break;
      case 'dict':
        for (const [k, v] of e.items) { if (k) this.expr(k); this.expr(v); }
        if (e.items.some(([k]) => !k)) this.emit('BUILD_DICT_STAR', line, e.items.map(([k]) => !k));
        else this.emit('BUILD_DICT', line, e.items.length);
        break;
      case 'star': throw new PyError('SyntaxError', "can't use starred expression here", line);
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
    const name = `<${e.kind}comp>`, code = newCode(name, this.qual(name), 'fn', this.code.file);
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

function newCode(name: string, qualname: string, kind: Code['kind'], file?: string): Code {
  return { name, qualname, kind, file, params: [], ins: [], locals: new Set(), globalNames: new Set(), nonlocals: new Set() };
}

export function compile(src: string, file?: string): Code {
  const code = newCode('<module>', '<module>', 'module', file);
  const c = new Compiler(code);
  const body = parse(src);
  checkDeclarations(body, [], 'module');
  const head = body[0];
  if (head?.k === 'expr' && head.e.k === 'const' && typeof head.e.v === 'string') code.doc = head.e.v;
  c.body(body);
  c.emit('CONST', 0, null);
  c.emit('RETURN', 0);
  return code;
}

