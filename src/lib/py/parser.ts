// Recursive descent over the tokens, with Python's own precedence ladder. Each
// feature left out is refused by name (notHere) rather than parsed and ignored.

import { lex, notHere, unescape, PyError, type Tok } from './lexer.ts';

export type Param = { name: string; def?: Expr };
export type CompClause = { target: Expr; iter: Expr; ifs: Expr[] };
export type FPart = string | { e: Expr; conv?: string; spec?: string };
export type Expr = { line: number } & (
  | { k: 'const'; v: bigint | number | boolean | string | null }
  | { k: 'fstr'; parts: FPart[] }
  | { k: 'name'; name: string }
  | { k: 'list' | 'tuple' | 'set'; items: Expr[] }
  // A null key is **spread, with the mapping in the value's place.
  | { k: 'dict'; items: [Expr | null, Expr][] }
  | { k: 'star'; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'unary'; op: string; e: Expr }
  | { k: 'and' | 'or'; l: Expr; r: Expr }
  | { k: 'not'; e: Expr }
  | { k: 'cmp'; first: Expr; rest: { op: string; e: Expr }[] }
  | { k: 'call'; fn: Expr; args: Expr[]; kw: [string, Expr][] }
  | { k: 'index'; obj: Expr; idx: Expr }
  | { k: 'slice'; lo?: Expr; hi?: Expr; step?: Expr }
  | { k: 'attr'; obj: Expr; name: string }
  | { k: 'lambda'; params: Param[]; body: Expr }
  | { k: 'ifexp'; test: Expr; a: Expr; b: Expr }
  | { k: 'comp'; kind: 'list' | 'set' | 'dict'; elt: Expr; val?: Expr; clauses: CompClause[] }
);
export type Stmt = { line: number } & (
  | { k: 'expr'; e: Expr }
  | { k: 'assign'; targets: Expr[]; value: Expr }
  | { k: 'aug'; target: Expr; op: string; value: Expr }
  // x: int with no value. It runs nothing, and in a function it still makes x local.
  | { k: 'annot'; target: Expr }
  | { k: 'if'; test: Expr; body: Stmt[]; orelse: Stmt[] }
  | { k: 'while'; test: Expr; body: Stmt[] }
  | { k: 'for'; target: Expr; iter: Expr; body: Stmt[] }
  | { k: 'def'; name: string; params: Param[]; body: Stmt[] }
  | { k: 'class'; name: string; base?: Expr; body: Stmt[] }
  | { k: 'return'; e?: Expr }
  | { k: 'break' | 'continue' | 'pass' }
  | { k: 'global' | 'nonlocal'; names: string[] }
  | { k: 'try'; body: Stmt[]; handlers: { type?: Expr; name?: string; body: Stmt[]; line: number }[]; orelse: Stmt[]; finalbody: Stmt[] }
  | { k: 'raise'; e?: Expr }
  | { k: 'assert'; test: Expr; msg?: Expr }
  | { k: 'del'; targets: Expr[] }
);

const REFUSED = new Set(['import', 'from', 'with', 'async', 'await', 'yield']);
const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'global', 'if', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', ...REFUSED]);
// What Python calls a thing that can't be assigned to. Undefined for a plain name,
// which gets a different message.
const assignName = (e: Expr): string | undefined => {
  switch (e.k) {
    case 'const': return e.v === true ? 'True' : e.v === false ? 'False' : e.v === null ? 'None' : 'literal';
    case 'attr': return 'attribute';
    case 'index': return 'subscript';
    case 'call': return 'function call';
    case 'cmp': return 'comparison';
    case 'fstr': return 'f-string expression';
    case 'name': return undefined;
    default: return 'expression';
  }
};
const AUG = new Set(['+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '|=', '^=', '@=']);

class Parser {
  toks: Tok[];
  i = 0;
  constructor(toks: Tok[]) { this.toks = toks; }
  get cur() { return this.toks[this.i]; }
  isOp(v: string) { return this.cur.t === 'op' && this.cur.v === v; }
  isKw(v: string) { return this.cur.t === 'name' && this.cur.v === v; }
  eatOp(v: string) { if (this.isOp(v)) { this.i++; return true; } return false; }
  eatKw(v: string) { if (this.isKw(v)) { this.i++; return true; } return false; }
  fail(msg = 'invalid syntax'): never {
    if (this.cur.t === 'name' && REFUSED.has(this.cur.v)) throw notHere(`'${this.cur.v}'`, this.cur.line);
    // Wherever it turns up: print(x := 1) reached this as "invalid syntax" on correct code.
    if (this.isOp(':=')) throw notHere("the ':=' operator", this.cur.line);
    throw new PyError('SyntaxError', msg, this.cur.line);
  }
  needOp(v: string) { if (!this.eatOp(v)) this.fail(v === ':' ? "expected ':'" : 'invalid syntax'); }
  /** `if x = 5:` is the classic slip, and "expected ':'" would point away from it. */
  testColon(test: Expr) {
    if (!this.isOp('=')) return;
    const what = assignName(test);
    this.fail(what ? `cannot assign to ${what} here. Maybe you meant '==' instead of '='?` : "invalid syntax. Maybe you meant '==' or ':=' instead of '='?");
  }
  /** Two expressions side by side inside brackets. */
  closing(close: string) {
    const t = this.cur;
    if (!this.isOp(close) && (t.t === 'num' || t.t === 'str' || t.t === 'fstr' || (t.t === 'name' && (!KEYWORDS.has(t.v) || ['True', 'False', 'None'].includes(t.v))))) this.fail('invalid syntax. Perhaps you forgot a comma?');
    this.needOp(close);
  }
  needKw(v: string) { if (!this.eatKw(v)) this.fail(); }
  ident(): string {
    const t = this.cur;
    if (t.t !== 'name' || KEYWORDS.has(t.v)) this.fail();
    this.i++;
    return t.v;
  }

  file(): Stmt[] {
    const out: Stmt[] = [];
    while (this.cur.t !== 'eof') {
      if (this.cur.t === 'nl') { this.i++; continue; }
      if (this.cur.t === 'indent') throw new PyError('IndentationError', 'unexpected indent', this.cur.line);
      out.push(...this.statement());
    }
    return out;
  }

  /** `after` and `headLine` finish Python's message: "...after 'if' statement on line 2". */
  suite(after: string, headLine: number): Stmt[] {
    this.needOp(':');
    if (this.cur.t !== 'nl') return this.simpleLine();
    this.i++;
    // By index, not this.cur: TypeScript narrows a getter's result across this.i++
    // and would decide the token kind can't have changed.
    const kind = () => this.toks[this.i].t;
    if (kind() !== 'indent') throw new PyError('IndentationError', `expected an indented block after ${after} on line ${headLine}`, kind() === 'eof' ? headLine : this.cur.line);
    this.i++;
    const out: Stmt[] = [];
    while (kind() !== 'dedent' && kind() !== 'eof') {
      if (kind() === 'nl') { this.i++; continue; }
      if (kind() === 'indent') throw new PyError('IndentationError', 'unexpected indent', this.cur.line);
      out.push(...this.statement());
    }
    if (kind() === 'dedent') this.i++;
    return out;
  }

  statement(): Stmt[] {
    const t = this.cur, line = t.line;
    if (t.t === 'op' && t.v === '@') throw notHere('decorators', line);
    if (t.t === 'name') {
      // Soft keywords: match and type are ordinary names until they aren't. Without this,
      // correct code using them read as "invalid syntax", which a beginner believes.
      if (t.v === 'match' && this.opensMatch()) throw notHere("'match' statements", line);
      if (t.v === 'type' && this.toks[this.i + 1].t === 'name' && !KEYWORDS.has(this.toks[this.i + 1].v) && ['=', '['].includes(this.toks[this.i + 2]?.v)) throw notHere("'type' statements", line);
      switch (t.v) {
        case 'if': { this.i++; return [this.ifRest(line)]; }
        case 'while': {
          this.i++;
          const test = this.named();
          this.testColon(test);
          const body = this.suite("'while' statement", line);
          if (this.isKw('else')) throw notHere("'while ... else'", this.cur.line);
          return [{ k: 'while', test, body, line }];
        }
        case 'for': {
          this.i++;
          const target = this.targetList();
          this.needKw('in');
          const iter = this.exprList(), body = this.suite("'for' statement", line);
          if (this.isKw('else')) throw notHere("'for ... else'", this.cur.line);
          return [{ k: 'for', target, iter, body, line }];
        }
        case 'def': {
          this.i++;
          const name = this.ident();
          if (this.isOp('[')) throw notHere("type parameters, as in def f[T](x):,", this.cur.line);
          if (!this.isOp('(')) this.fail("expected '('");
          this.i++;
          const params = this.params(')');
          this.needOp(')');
          if (this.eatOp('->')) this.ternary();
          return [{ k: 'def', name, params, body: this.suite('function definition', line), line }];
        }
        case 'class': {
          this.i++;
          const name = this.ident();
          let base: Expr | undefined;
          if (this.isOp('[')) throw notHere('type parameters, as in class A[T]:,', this.cur.line);
          if (this.eatOp('(')) {
            if (this.isOp('*') || this.isOp('**') || (this.cur.t === 'name' && this.toks[this.i + 1].v === '=' && this.toks[this.i + 1].t === 'op')) throw notHere('class arguments such as metaclass=', this.cur.line);
            if (!this.isOp(')')) base = this.ternary();
            if (this.isOp(',')) throw notHere('multiple inheritance', this.cur.line);
            this.needOp(')');
          }
          return [{ k: 'class', name, base, body: this.suite('class definition', line), line }];
        }
        case 'try': {
          this.i++;
          const body = this.suite("'try' statement", line);
          const handlers: { type?: Expr; name?: string; body: Stmt[]; line: number }[] = [];
          while (this.isKw('except')) {
            const hl = this.cur.line;
            this.i++;
            let type: Expr | undefined, name: string | undefined;
            if (this.isOp('*')) throw notHere("'except*'", hl);
            if (!this.isOp(':')) { type = this.ternary(); if (this.eatKw('as')) name = this.ident(); }
            handlers.push({ type, name, body: this.suite("'except' statement", hl), line: hl });
            // A bare except catches everything, so anything after it could never run.
            if (!type && this.isKw('except')) throw new PyError('SyntaxError', "default 'except:' must be last", hl);
          }
          // else needs an except before it: it means "and nothing was raised".
          const elseLine = this.cur.line;
          const orelse = handlers.length && this.eatKw('else') ? this.suite("'else' statement", elseLine) : [];
          const finallyLine = this.cur.line;
          const finalbody = this.eatKw('finally') ? this.suite("'finally' statement", finallyLine) : [];
          if (!handlers.length && !finalbody.length) this.fail("expected 'except' or 'finally' block");
          return [{ k: 'try', body, handlers, orelse, finalbody, line }];
        }
      }
    }
    return this.simpleLine();
  }

  /** A line starting `match`, ending in a colon, with `case` as the first word of its block. */
  opensMatch(): boolean {
    let j = this.i + 1;
    while (this.toks[j].t !== 'nl' && this.toks[j].t !== 'eof') j++;
    if (j === this.i + 1 || this.toks[j - 1].v !== ':' || this.toks[j - 1].t !== 'op') return false;
    return this.toks[j + 1]?.t === 'indent' && this.toks[j + 2]?.v === 'case';
  }

  ifRest(line: number, word = 'if'): Stmt {
    const test = this.named();
    this.testColon(test);
    const body = this.suite(`'${word}' statement`, line);
    let orelse: Stmt[] = [];
    if (this.isKw('elif')) { const l = this.cur.line; this.i++; orelse = [this.ifRest(l, 'elif')]; }
    else if (this.isKw('else')) { const l = this.cur.line; this.i++; orelse = this.suite("'else' statement", l); }
    return { k: 'if', test, body, orelse, line };
  }

  simpleLine(): Stmt[] {
    const out = [this.simple()];
    while (this.eatOp(';')) { if (this.cur.t === 'nl') break; out.push(this.simple()); }
    if (this.cur.t !== 'nl' && this.cur.t !== 'eof') this.fail();
    if (this.cur.t === 'nl') this.i++;
    return out;
  }

  simple(): Stmt {
    const t = this.cur, line = t.line;
    if (t.t === 'name') {
      if (REFUSED.has(t.v)) this.fail();
      switch (t.v) {
        case 'pass': this.i++; return { k: 'pass', line };
        case 'break': this.i++; return { k: 'break', line };
        case 'continue': this.i++; return { k: 'continue', line };
        case 'return': {
          this.i++;
          return { k: 'return', e: this.cur.t === 'nl' || this.isOp(';') ? undefined : this.exprList(), line };
        }
        case 'global': case 'nonlocal': {
          this.i++;
          const names = [this.ident()];
          while (this.eatOp(',')) names.push(this.ident());
          return { k: t.v, names, line };
        }
        case 'raise': {
          this.i++;
          const e = this.cur.t === 'nl' || this.isOp(';') ? undefined : this.ternary();
          if (this.isKw('from')) throw notHere("'raise ... from'", line);
          return { k: 'raise', e, line };
        }
        case 'assert': {
          this.i++;
          const test = this.ternary();
          return { k: 'assert', test, msg: this.eatOp(',') ? this.ternary() : undefined, line };
        }
        case 'del': {
          this.i++;
          const targets = [this.ternary()];
          while (this.eatOp(',')) targets.push(this.ternary());
          return { k: 'del', targets, line };
        }
      }
    }
    const first = this.exprList();
    // Python 2's spelling, and still what people type first.
    if (first.k === 'name' && first.name === 'print' && (this.cur.t === 'str' || this.cur.t === 'fstr' || this.cur.t === 'num' || (this.cur.t === 'name' && !KEYWORDS.has(this.cur.v)))) {
      throw new PyError('SyntaxError', "Missing parentheses in call to 'print'. Did you mean print(...)?", line);
    }
    // A bare annotation changes nothing at run time, and that is the lesson:
    // Python records it and enforces none of it.
    if (this.isOp(':')) {
      if (first.k === 'tuple' || first.k === 'list') this.fail(`only single target (not ${first.k}) can be annotated`);
      this.i++;
      this.ternary();
      this.checkTarget(first);
      if (!this.eatOp('=')) return first.k === 'name' ? { k: 'annot', target: first, line } : { k: 'pass', line };
      return { k: 'assign', targets: [first], value: this.exprList(), line };
    }
    if (this.cur.t === 'op' && AUG.has(this.cur.v)) {
      const op = this.cur.v.slice(0, -1);
      this.i++;
      if (first.k !== 'name' && first.k !== 'index' && first.k !== 'attr') throw new PyError('SyntaxError', 'illegal expression for augmented assignment', line);
      return { k: 'aug', target: first, op, value: this.exprList(), line };
    }
    if (this.isOp('=')) {
      const targets = [first];
      let value = first;
      while (this.eatOp('=')) { value = this.exprList(); targets.push(value); }
      targets.pop();
      targets.forEach((x) => this.checkTarget(x));
      return { k: 'assign', targets, value, line };
    }
    return { k: 'expr', e: first, line };
  }

  checkTarget(e: Expr) {
    if (e.k === 'tuple' || e.k === 'list') { e.items.forEach((x) => this.checkTarget(x)); return; }
    if (e.k === 'star') { this.checkTarget(e.e); return; }
    if (e.k !== 'name' && e.k !== 'index' && e.k !== 'attr') {
      const what = assignName(e) ?? 'expression';
      throw new PyError('SyntaxError', what === 'True' || what === 'False' || what === 'None' || what === 'comparison' ? `cannot assign to ${what}` : `cannot assign to ${what} here. Maybe you meant '==' instead of '='?`, e.line);
    }
  }

  params(close: string): Param[] {
    const out: Param[] = [];
    let seenDefault = false;
    while (!this.isOp(close)) {
      if (this.isOp('*') || this.isOp('**')) throw notHere('*args and **kwargs', this.cur.line);
      if (this.isOp('/')) throw notHere('positional-only parameters, marked with /,', this.cur.line);
      const name = this.ident();
      if (close === ')' && this.eatOp(':')) this.ternary();
      const def = this.eatOp('=') ? this.ternary() : undefined;
      if (def) seenDefault = true;
      else if (seenDefault) throw new PyError('SyntaxError', 'parameter without a default follows parameter with a default', this.cur.line);
      out.push({ name, def });
      if (!this.eatOp(',')) break;
    }
    return out;
  }

  // for/assignment targets stop before 'in', which is why this isn't exprList.
  targetList(): Expr {
    const line = this.cur.line, items = [this.postfixTarget()];
    if (!this.isOp(',')) return items[0];
    while (this.eatOp(',')) { if (this.isKw('in')) break; items.push(this.postfixTarget()); }
    return { k: 'tuple', items, line };
  }
  postfixTarget(): Expr {
    if (this.isOp('*')) { const line = this.cur.line; this.i++; return { k: 'star', e: this.postfixTarget(), line }; }
    if (this.isOp('(') || this.isOp('[')) {
      const close = this.isOp('(') ? ')' : ']', line = this.cur.line;
      this.i++;
      const items = [this.postfixTarget()];
      while (this.eatOp(',')) { if (this.isOp(close)) break; items.push(this.postfixTarget()); }
      this.needOp(close);
      return items.length === 1 && close === ')' ? items[0] : { k: 'tuple', items, line };
    }
    return this.postfix();
  }

  exprList(): Expr {
    const line = this.cur.line, first = this.starOrNamed();
    if (!this.isOp(',')) return first;
    const items = [first];
    while (this.eatOp(',')) {
      if (this.cur.t === 'nl' || this.isOp('=') || this.isOp(')') || this.isOp(':') || this.isOp(';')) break;
      items.push(this.starOrNamed());
    }
    return { k: 'tuple', items, line };
  }
  /** One item of a list, a tuple or a right-hand side, where *x spreads x out. */
  starOrNamed(): Expr {
    if (this.isOp('*')) { const line = this.cur.line; this.i++; return { k: 'star', e: this.binary(0), line }; }
    return this.named();
  }
  named(): Expr {
    const e = this.ternary();
    if (this.isOp(':=')) throw notHere("the ':=' operator", this.cur.line);
    return e;
  }
  ternary(): Expr {
    const line = this.cur.line;
    if (this.eatKw('lambda')) {
      const params = this.params(':');
      this.needOp(':');
      return { k: 'lambda', params, body: this.ternary(), line };
    }
    const a = this.orTest();
    if (!this.isKw('if')) return a;
    this.i++;
    const test = this.orTest();
    this.needKw('else');
    return { k: 'ifexp', test, a, b: this.ternary(), line };
  }
  orTest(): Expr {
    let l = this.andTest();
    while (this.isKw('or')) { const line = this.cur.line; this.i++; l = { k: 'or', l, r: this.andTest(), line }; }
    return l;
  }
  andTest(): Expr {
    let l = this.notTest();
    while (this.isKw('and')) { const line = this.cur.line; this.i++; l = { k: 'and', l, r: this.notTest(), line }; }
    return l;
  }
  notTest(): Expr {
    if (this.isKw('not')) { const line = this.cur.line; this.i++; return { k: 'not', e: this.notTest(), line }; }
    return this.comparison();
  }
  comparison(): Expr {
    const line = this.cur.line, first = this.binary(0);
    const rest: { op: string; e: Expr }[] = [];
    for (;;) {
      let op: string | undefined;
      if (this.cur.t === 'op' && ['<', '>', '==', '>=', '<=', '!='].includes(this.cur.v)) { op = this.cur.v; this.i++; }
      else if (this.eatKw('in')) op = 'in';
      else if (this.isKw('not') && this.toks[this.i + 1].v === 'in') { this.i += 2; op = 'not in'; }
      else if (this.eatKw('is')) op = this.eatKw('not') ? 'is not' : 'is';
      if (!op) break;
      rest.push({ op, e: this.binary(0) });
    }
    return rest.length ? { k: 'cmp', first, rest, line } : first;
  }
  static LADDER = [['|'], ['^'], ['&'], ['<<', '>>'], ['+', '-'], ['*', '/', '//', '%', '@']];
  binary(level: number): Expr {
    if (level === Parser.LADDER.length) return this.unary();
    let l = this.binary(level + 1);
    while (this.cur.t === 'op' && Parser.LADDER[level].includes(this.cur.v)) {
      const op = this.cur.v, line = this.cur.line;
      this.i++;
      l = { k: 'bin', op, l, r: this.binary(level + 1), line };
    }
    return l;
  }
  unary(): Expr {
    const t = this.cur;
    if (t.t === 'op' && (t.v === '-' || t.v === '+' || t.v === '~')) { this.i++; return { k: 'unary', op: t.v, e: this.unary(), line: t.line }; }
    return this.power();
  }
  power(): Expr {
    const l = this.postfix();
    if (this.isOp('**')) { const line = this.cur.line; this.i++; return { k: 'bin', op: '**', l, r: this.unary(), line }; }
    return l;
  }
  postfix(): Expr {
    let e = this.atom();
    for (;;) {
      const line = this.cur.line;
      if (this.eatOp('(')) { e = this.callRest(e, line); continue; }
      if (this.eatOp('[')) {
        const idx = this.subscript();
        this.needOp(']');
        e = { k: 'index', obj: e, idx, line };
        continue;
      }
      if (this.eatOp('.')) {
        const t = this.cur;
        if (t.t !== 'name') this.fail();
        this.i++;
        e = { k: 'attr', obj: e, name: t.v, line };
        continue;
      }
      return e;
    }
  }
  callRest(fn: Expr, line: number): Expr {
    const args: Expr[] = [], kw: [string, Expr][] = [];
    while (!this.isOp(')')) {
      if (this.isOp('*') || this.isOp('**')) throw notHere('*args and **kwargs', this.cur.line);
      if (this.cur.t === 'name' && this.toks[this.i + 1].t === 'op' && this.toks[this.i + 1].v === '=') {
        const name = this.ident();
        this.i++;
        // A map of them would keep the last and carry on, where Python refuses to compile.
        if (kw.some(([k]) => k === name)) this.fail(`keyword argument repeated: ${name}`);
        kw.push([name, this.ternary()]);
      } else {
        if (kw.length) this.fail('positional argument follows keyword argument');
        args.push(this.ternary());
        if (this.isKw('for')) throw notHere('generator expressions (a list comprehension works here)', this.cur.line);
        if (this.isOp('=')) this.fail('expression cannot contain assignment, perhaps you meant "=="?');
      }
      if (!this.eatOp(',')) break;
    }
    this.closing(')');
    return { k: 'call', fn, args, kw, line };
  }
  subscript(): Expr {
    const line = this.cur.line, one = () => this.isOp(':') || this.isOp(']') || this.isOp(',') ? undefined : this.ternary();
    if (this.isOp('*')) throw notHere('*x inside square brackets', line);
    const lo = one();
    if (!this.isOp(':')) {
      if (!lo) this.fail();
      if (!this.isOp(',')) return lo!;
      const items = [lo!];
      while (this.eatOp(',')) { if (this.isOp(']')) break; items.push(this.ternary()); }
      return { k: 'tuple', items, line };
    }
    this.i++;
    const hi = one();
    const step = this.eatOp(':') ? one() : undefined;
    return { k: 'slice', lo, hi, step, line };
  }
  atom(): Expr {
    const t = this.cur, line = t.line;
    if (t.t === 'num') { this.i++; return { k: 'const', v: t.n!, line }; }
    if (t.t === 'str' || t.t === 'fstr') return this.strings();
    if (this.isOp('...')) throw notHere("'...' (the value called Ellipsis)", line);
    if (t.t === 'name') {
      if (t.v === 'None') { this.i++; return { k: 'const', v: null, line }; }
      if (t.v === 'True') { this.i++; return { k: 'const', v: true, line }; }
      if (t.v === 'False') { this.i++; return { k: 'const', v: false, line }; }
      return { k: 'name', name: this.ident(), line };
    }
    if (this.eatOp('(')) {
      if (this.eatOp(')')) return { k: 'tuple', items: [], line };
      const first = this.starOrNamed();
      if (this.isKw('for')) throw notHere('generator expressions (a list comprehension works here)', this.cur.line);
      if (this.isOp(')') && first.k === 'star') this.fail('cannot use starred expression here');
      if (this.eatOp(')')) return first;
      const items = [first];
      while (this.eatOp(',')) { if (this.isOp(')')) break; items.push(this.starOrNamed()); }
      this.closing(')');
      return { k: 'tuple', items, line };
    }
    if (this.eatOp('[')) {
      if (this.eatOp(']')) return { k: 'list', items: [], line };
      const first = this.starOrNamed();
      if (this.isKw('for')) {
        if (first.k === 'star') this.fail('iterable unpacking cannot be used in comprehension');
        const clauses = this.compClauses();
        this.needOp(']');
        return { k: 'comp', kind: 'list', elt: first, clauses, line };
      }
      const items = [first];
      while (this.eatOp(',')) { if (this.isOp(']')) break; items.push(this.starOrNamed()); }
      this.closing(']');
      return { k: 'list', items, line };
    }
    if (this.eatOp('{')) {
      if (this.eatOp('}')) return { k: 'dict', items: [], line };
      const pair = (): [Expr | null, Expr] => {
        if (this.eatOp('**')) return [null, this.binary(0)];
        const key = this.ternary();
        this.needOp(':');
        return [key, this.ternary()];
      };
      if (this.isOp('**')) {
        const items = [pair()];
        if (this.isKw('for')) this.fail('dict unpacking cannot be used in dict comprehension');
        while (this.eatOp(',')) { if (this.isOp('}')) break; items.push(pair()); }
        this.needOp('}');
        return { k: 'dict', items, line };
      }
      const first = this.isOp('*') ? this.starOrNamed() : this.ternary();
      if (first.k !== 'star' && this.eatOp(':')) {
        const val = this.ternary();
        if (this.isKw('for')) {
          const clauses = this.compClauses();
          this.needOp('}');
          return { k: 'comp', kind: 'dict', elt: first, val, clauses, line };
        }
        const items: [Expr | null, Expr][] = [[first, val]];
        while (this.eatOp(',')) { if (this.isOp('}')) break; items.push(pair()); }
        this.needOp('}');
        return { k: 'dict', items, line };
      }
      if (this.isKw('for')) {
        if (first.k === 'star') this.fail('iterable unpacking cannot be used in comprehension');
        const clauses = this.compClauses();
        this.needOp('}');
        return { k: 'comp', kind: 'set', elt: first, clauses, line };
      }
      const items = [first];
      while (this.eatOp(',')) { if (this.isOp('}')) break; items.push(this.isOp('*') ? this.starOrNamed() : this.ternary()); }
      this.needOp('}');
      return { k: 'set', items, line };
    }
    this.fail();
  }
  compClauses(): CompClause[] {
    const out: CompClause[] = [];
    while (this.eatKw('for')) {
      const target = this.targetList();
      this.needKw('in');
      const iter = this.orTest(), ifs: Expr[] = [];
      while (this.eatKw('if')) ifs.push(this.orTest());
      out.push({ target, iter, ifs });
    }
    return out;
  }
  strings(): Expr {
    const line = this.cur.line, parts: FPart[] = [];
    let anyF = false;
    while (this.cur.t === 'str' || this.cur.t === 'fstr') {
      const t = this.cur;
      this.i++;
      if (t.t === 'str') parts.push(t.v);
      else { anyF = true; parts.push(...fstringParts(t.v, t.line)); }
    }
    if (!anyF) return { k: 'const', v: parts.join(''), line };
    return { k: 'fstr', parts, line };
  }
}

function fstringParts(raw: string, line: number): FPart[] {
  const parts: FPart[] = [];
  let lit = '', i = 0;
  const flush = () => { if (lit) parts.push(unescape(lit, line)); lit = ''; };
  while (i < raw.length) {
    const c = raw[i];
    if (c === '{' && raw[i + 1] === '{') { lit += '{'; i += 2; continue; }
    if (c === '}' && raw[i + 1] === '}') { lit += '}'; i += 2; continue; }
    if (c === '}') throw new PyError('SyntaxError', "f-string: single '}' is not allowed", line);
    if (c !== '{') { lit += c; i++; continue; }
    flush();
    let j = i + 1, depth = 0, quote = '', colon = -1, bang = -1;
    for (; j < raw.length; j++) {
      const d = raw[j];
      if (quote) { if (d === quote) quote = ''; continue; }
      // After the colon it's a format spec, where a quote is a fill character: f"{x:'>5}".
      if (colon < 0 && (d === '"' || d === "'")) { quote = d; continue; }
      if ('([{'.includes(d)) { depth++; continue; }
      if (')]'.includes(d)) { depth--; continue; }
      if (d === '}') { if (depth === 0) break; depth--; continue; }
      if (depth === 0 && d === ':' && colon < 0) colon = j;
      if (depth === 0 && d === '!' && raw[j + 1] !== '=' && colon < 0) bang = j;
    }
    if (j >= raw.length) throw new PyError('SyntaxError', "f-string: expecting '}'", line);
    const exprEnd = bang >= 0 ? bang : colon >= 0 ? colon : j;
    const text = raw.slice(i + 1, exprEnd);
    if (!text.trim()) throw new PyError('SyntaxError', 'f-string: valid expression required before }', line);
    if (/=\s*$/.test(text) && !/[=!<>]=\s*$/.test(text)) throw notHere("f-string '=' debugging", line);
    const spec = colon >= 0 ? raw.slice(colon + 1, j) : undefined;
    if (spec?.includes('{')) throw notHere('nested f-string format specs', line);
    const conv = bang >= 0 ? raw[bang + 1] : undefined;
    if (conv !== undefined && !'rsa'.includes(conv)) throw new PyError('SyntaxError', `f-string: invalid conversion character '${conv}': expected 's', 'r', or 'a'`, line);
    const sub =new Parser(lex(`(${text})`).map((t) => ({ ...t, line })));
    parts.push({ e: sub.ternary(), conv, spec });
    i = j + 1;
  }
  flush();
  return parts;
}

export const parse = (src: string): Stmt[] => new Parser(lex(src)).file();
