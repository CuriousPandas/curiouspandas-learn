// Tokens for the Python subset the programming and CS lessons run. Typed code
// is parsed by this and executed by the VM beside it; it is never handed to
// JavaScript's eval, so a program can reach nothing but what the VM exposes.

export class PyError extends Error {
  type: string;
  line: number;
  constructor(type: string, message: string, line: number) { super(message); this.type = type; this.line = line; }
}

// A feature real Python has and this sandbox lacks must never look like the
// learner's mistake, and must never be quietly ignored.
export const notHere = (what: string, line: number) => new PyError('SandboxLimit', `real Python has ${what}; this sandbox does not yet`, line);

export type Tok = { t: 'name' | 'num' | 'str' | 'fstr' | 'op' | 'nl' | 'indent' | 'dedent' | 'eof'; v: string; n?: bigint | number; line: number };

const OPS = ['**=', '//=', '>>=', '<<=', '...', '**', '//', '>>', '<<', '<=', '>=', '==', '!=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', ':=', '+', '-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '&', '|', '^', '~', '@'];
const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };

export function unescape(s: string, line: number): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const c = s[++i];
    if (c === '\n') continue;
    if (c === 'x') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; continue; }
    if (c === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; continue; }
    if (c in ESC) out += ESC[c];
    // An unknown escape stays as written, backslash included, as in Python.
    else out += '\\' + c;
  }
  if (out.includes('￿')) throw new PyError('SyntaxError', 'bad escape', line);
  return out;
}

export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  const indents = [0];
  let i = 0, line = 1, depth = 0, atLineStart = true;
  const s = src.replace(/\r\n/g, '\n');
  while (i < s.length) {
    if (atLineStart && depth === 0) {
      let w = 0, j = i;
      for (; j < s.length && (s[j] === ' ' || s[j] === '\t'); j++) w = s[j] === '\t' ? w + 8 - (w % 8) : w + 1;
      // Blank and comment-only lines carry no indentation meaning.
      if (s[j] === '\n' || s[j] === '#' || j >= s.length) {
        while (j < s.length && s[j] !== '\n') j++;
        i = j + 1; line++;
        continue;
      }
      i = j;
      atLineStart = false;
      if (w > indents.at(-1)!) { indents.push(w); toks.push({ t: 'indent', v: '', line }); }
      while (w < indents.at(-1)!) {
        indents.pop();
        if (w > indents.at(-1)!) throw new PyError('IndentationError', 'unindent does not match any outer indentation level', line);
        toks.push({ t: 'dedent', v: '', line });
      }
    }
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '#') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '\\' && s[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '\n') {
      i++;
      if (depth === 0) { toks.push({ t: 'nl', v: '', line }); atLineStart = true; }
      line++;
      continue;
    }
    const prefix = /^[A-Za-z]{1,2}(?=['"])/.exec(s.slice(i, i + 3))?.[0] ?? '';
    if (c === '"' || c === "'" || prefix) {
      const p = prefix.toLowerCase();
      if (p && p !== 'f' && p !== 'r') throw notHere(`${prefix}'' strings`, line);
      let j = i + prefix.length;
      const q = s[j], triple = s.slice(j, j + 3) === q.repeat(3);
      const close = triple ? q.repeat(3) : q;
      const startLine = line;
      j += close.length;
      const start = j;
      for (;;) {
        if (j >= s.length) throw new PyError('SyntaxError', triple ? 'unterminated triple-quoted string literal' : 'unterminated string literal', startLine);
        if (s[j] === '\\') { if (s[j + 1] === '\n') line++; j += 2; continue; }
        if (s[j] === '\n') { if (!triple) throw new PyError('SyntaxError', 'unterminated string literal', startLine); line++; }
        if (s.startsWith(close, j)) break;
        j++;
      }
      const raw = s.slice(start, j);
      toks.push(p === 'f' ? { t: 'fstr', v: raw, line: startLine } : { t: 'str', v: p === 'r' ? raw : unescape(raw, startLine), line: startLine });
      i = j + close.length;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*)?\.?[0-9_]*(?:[eE][+-]?[0-9]+)?)/.exec(s.slice(i))!;
      const text = m[1], clean = text.replace(/_/g, '');
      i += text.length;
      if (/[A-Za-z_]/.test(s[i] ?? '')) throw new PyError('SyntaxError', 'invalid decimal literal', line);
      const isInt = /^(0[xXbBoO]|[0-9]+$)/.test(clean);
      if (isInt && /^0[0-9]*[1-9]/.test(clean) && !/^0[xXbBoO]/.test(clean)) throw new PyError('SyntaxError', 'leading zeros in decimal integer literals are not permitted', line);
      toks.push({ t: 'num', v: text, n: isInt ? BigInt(clean) : Number(clean), line });
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      let j = i + 1;
      while (j < s.length && /[\p{L}\p{N}_]/u.test(s[j])) j++;
      toks.push({ t: 'name', v: s.slice(i, j), line });
      i = j;
      continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (!op) throw new PyError('SyntaxError', `invalid character '${c}'`, line);
    if ('([{'.includes(op)) depth++;
    if (')]}'.includes(op)) depth = Math.max(0, depth - 1);
    toks.push({ t: 'op', v: op, line });
    i += op.length;
  }
  if (depth > 0) throw new PyError('SyntaxError', 'a bracket was opened and never closed', line);
  if (toks.length && toks.at(-1)!.t !== 'nl') toks.push({ t: 'nl', v: '', line });
  while (indents.length > 1) { indents.pop(); toks.push({ t: 'dedent', v: '', line }); }
  toks.push({ t: 'eof', v: '', line });
  return toks;
}
