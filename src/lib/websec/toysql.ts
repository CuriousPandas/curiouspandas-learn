// A toy database with one table and one query, small enough to read in full.
// It parses the WHERE clause the way a real database would - so input glued
// into the query text really does become part of the query - but it only
// understands =, <>, AND, OR, brackets, strings, numbers and -- comments.

export type Row = { id: number; name: string; role: string; note: string };

export const PANDAS: Row[] = [
  { id: 1, name: 'Mei', role: 'keeper', note: 'feeds the red pandas at 9' },
  { id: 2, name: 'Bao', role: 'keeper', note: 'on the night shift' },
  { id: 3, name: 'Lin', role: 'admin', note: 'vault code EXAMPLE-0000' },
  { id: 4, name: "O'Neil", role: 'visitor', note: 'season ticket holder' },
];

export const PREFIX = 'SELECT name, role FROM pandas WHERE name = ';

export type Result = { query: string; params?: string[]; rows?: Row[]; error?: string };

export class SqlError extends Error {}

type Tok = { t: 'str' | 'num' | 'id' | 'op' | 'kw' | 'lp' | 'rp' | 'end'; v: string };

export function tokenize(sql: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '-' && sql[i + 1] === '-') break; // a comment: the rest of the line is ignored
    if (c === "'") {
      let v = '', j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new SqlError(`unrecognized token: "${sql.slice(i)}"`);
        if (sql[j] === "'" && sql[j + 1] === "'") { v += "'"; j += 2; continue; }
        if (sql[j] === "'") break;
        v += sql[j++];
      }
      out.push({ t: 'str', v }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c)) { let j = i; while (j < sql.length && /[0-9]/.test(sql[j])) j++; out.push({ t: 'num', v: sql.slice(i, j) }); i = j; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const w = sql.slice(i, j);
      out.push(/^(and|or)$/i.test(w) ? { t: 'kw', v: w.toUpperCase() } : { t: 'id', v: w });
      i = j; continue;
    }
    if (c === '=') { out.push({ t: 'op', v: '=' }); i++; continue; }
    if (c === '<' && sql[i + 1] === '>') { out.push({ t: 'op', v: '<>' }); i += 2; continue; }
    if (c === '(') { out.push({ t: 'lp', v: c }); i++; continue; }
    if (c === ')') { out.push({ t: 'rp', v: c }); i++; continue; }
    if (c === ';') throw new SqlError('only one statement is allowed here (found ";")');
    throw new SqlError(`near "${c}": syntax error`);
  }
  out.push({ t: 'end', v: '' });
  return out;
}

type Expr = { k: 'lit'; v: string } | { k: 'col'; v: string } | { k: 'cmp'; op: string; a: Expr; b: Expr } | { k: 'bool'; op: 'AND' | 'OR'; a: Expr; b: Expr };

function parse(toks: Tok[]): Expr {
  let p = 0;
  const peek = () => toks[p];
  const near = () => (peek().t === 'end' ? 'incomplete input' : `near "${peek().v}": syntax error`);
  const atom = (): Expr => {
    const t = toks[p];
    if (t.t === 'str' || t.t === 'num') { p++; return { k: 'lit', v: t.v }; }
    if (t.t === 'id') {
      if (!['id', 'name', 'role', 'note'].includes(t.v.toLowerCase())) throw new SqlError(`no such column: ${t.v}`);
      p++; return { k: 'col', v: t.v.toLowerCase() };
    }
    if (t.t === 'lp') { p++; const e = or(); if (peek().t !== 'rp') throw new SqlError(near()); p++; return e; }
    throw new SqlError(near());
  };
  const cmp = (): Expr => {
    const a = atom();
    if (peek().t === 'op') { const op = toks[p++].v; return { k: 'cmp', op, a, b: atom() }; }
    return a;
  };
  const and = (): Expr => { let e = cmp(); while (peek().t === 'kw' && peek().v === 'AND') { p++; e = { k: 'bool', op: 'AND', a: e, b: cmp() }; } return e; };
  const or = (): Expr => { let e = and(); while (peek().t === 'kw' && peek().v === 'OR') { p++; e = { k: 'bool', op: 'OR', a: e, b: and() }; } return e; };
  const e = or();
  if (peek().t !== 'end') throw new SqlError(near());
  return e;
}

function evaluate(e: Expr, row: Row): string | boolean {
  switch (e.k) {
    case 'lit': return e.v;
    case 'col': return String(row[e.v as keyof Row]);
    case 'cmp': { const a = String(evaluate(e.a, row)), b = String(evaluate(e.b, row)); return e.op === '=' ? a === b : a !== b; }
    case 'bool': { const a = truthy(evaluate(e.a, row)), b = truthy(evaluate(e.b, row)); return e.op === 'AND' ? a && b : a || b; }
  }
}
// SQLite-style: a bare value is true when it is a non-zero number.
const truthy = (v: string | boolean) => (typeof v === 'boolean' ? v : Number(v) !== 0 && !Number.isNaN(Number(v)));

/** The bug: the input is pasted into the query text, so its quotes and
 *  keywords are read as SQL. */
export function concatenated(input: string): Result {
  const query = `${PREFIX}'${input}'`;
  try {
    // Parse everything after WHERE - including the page's own "name =" - so
    // the input is read in exactly the context a database would read it.
    const where = parse(tokenize(query.slice(query.indexOf(' WHERE ') + ' WHERE '.length)));
    return { query, rows: PANDAS.filter((r) => truthy(evaluate(where, r))) };
  } catch (e) {
    if (e instanceof SqlError) return { query, error: e.message };
    throw e;
  }
}

/** The fix: the query text is fixed and the input travels separately as a
 *  value. Nothing in it is ever parsed as SQL. */
export function parameterised(input: string): Result {
  return { query: `${PREFIX}?`, params: [input], rows: PANDAS.filter((r) => r.name === input) };
}
