// Tokens for the Python subset the programming and CS lessons run. Typed code
// is parsed by this and executed by the VM beside it; it is never handed to
// JavaScript's eval, so a program can reach nothing but what the VM exposes.

import { isPrintable } from './values.ts';

export class PyError extends Error {
  type: string;
  line: number;
  constructor(type: string, message: string, line: number) { super(message); this.type = type; this.line = line; }
}

// A feature real Python has and this sandbox lacks must never look like the
// learner's mistake, and must never be quietly ignored.
export const notHere = (what: string, line: number) => new PyError('SandboxLimit', `real Python has ${what}; this sandbox does not yet`, line);

export type Tok = { t: 'name' | 'num' | 'str' | 'fstr' | 'op' | 'nl' | 'indent' | 'dedent' | 'eof'; v: string; n?: bigint | number; line: number };

const OPS = ['**=', '//=', '>>=', '<<=', '...', '**', '//', '>>', '<<', '<=', '>=', '==', '!=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', ':=', '+','-', '*', '/', '%', '<', '>', '=', '(', ')', '[', ']', '{', '}', ',', ':', '.', ';', '&', '|', '^', '~', '@'];
const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };

export function unescape(s: string, line: number): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const c = s[++i];
    if (c === '\n') continue;
    if (c === 'x') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; continue; }
    if (c === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; continue; }
    // Left as an "unknown escape", \U0001F600 printed as ten characters of text with
    // no error, which is the wrong answer to every question the text lesson asks.
    if (c === 'U') { out += String.fromCodePoint(parseInt(s.slice(i + 1, i + 9), 16)); i += 8; continue; }
    // Real Python looks these up in the Unicode names table, which is not here.
    if (c === 'N') throw notHere('\\N{...} character names', line);
    if (/[0-7]/.test(c)) {
      const m = /^[0-7]{1,3}/.exec(s.slice(i))![0];
      out += String.fromCharCode(parseInt(m, 8));
      i += m.length - 1;
      continue;
    }
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
  // Python measures indentation twice, counting a tab as 8 and as 1. Lines that
  // only agree under one count are a TabError: without this, a pasted tab beside
  // spaces ran here and failed on the learner's own machine.
  const altIndents = [0];
  const tabError = (l: number) => new PyError('TabError', 'inconsistent use of tabs and spaces in indentation', l);
  // Which bracket is open and where: Python's messages name both.
  const open: { c: string; line: number }[] = [];
  const PAIR: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let i = 0, line = 1, depth = 0, atLineStart = true;
  // A byte order mark from a pasted file means nothing to real Python.
  const s = (src.charCodeAt(0) === 0xfeff ? src.slice(1) : src).replace(/\r\n/g, '\n');
  while (i < s.length) {
    if (atLineStart && depth === 0) {
      let w = 0, alt = 0, j = i;
      for (; j < s.length && (s[j] === ' ' || s[j] === '\t'); j++) { w = s[j] === '\t' ? w + 8 - (w % 8) : w + 1; alt++; }
      // Blank and comment-only lines carry no indentation meaning.
      if (s[j] === '\n' || s[j] === '#' || j >= s.length) {
        while (j < s.length && s[j] !== '\n') j++;
        i = j + 1; line++;
        continue;
      }
      i = j;
      atLineStart = false;
      if (w === indents.at(-1)!) { if (alt !== altIndents.at(-1)!) throw tabError(line); }
      else if (w > indents.at(-1)!) {
        if (alt <= altIndents.at(-1)!) throw tabError(line);
        indents.push(w); altIndents.push(alt);
        toks.push({ t: 'indent', v: '', line });
      } else {
        while (w < indents.at(-1)!) {
          indents.pop(); altIndents.pop();
          if (w > indents.at(-1)!) throw new PyError('IndentationError', 'unindent does not match any outer indentation level', line);
          toks.push({ t: 'dedent', v: '', line });
        }
        if (alt !== altIndents.at(-1)!) throw tabError(line);
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
    // Only Python's real prefixes. Any two letters before a quote used to count, so
    // the apostrophe in 'it's' reported "real Python has s'' strings", which is false.
    const prefix = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])(?=['"])/.exec(s.slice(i, i + 3))?.[0] ?? '';
    if (c === '"' || c === "'" || prefix) {
      const p = prefix.toLowerCase();
      // u"" is an ordinary string, kept for old code. The rest need bytes, or raw f-strings.
      if (p && p !== 'f' && p !== 'r' && p !== 'u') throw notHere(`${prefix}'' strings`, line);
      let j = i + prefix.length;
      const q = s[j], triple = s.slice(j, j + 3) === q.repeat(3);
      const close = triple ? q.repeat(3) : q;
      const startLine = line;
      j += close.length;
      const start = j;
      // Inside an f-string's {...}, quotes belong to the expression: f"{d["a"]}" is valid from
      // Python 3.12 on, and this used to end the string at the second quote and call it a
      // SyntaxError. After a colon at the top of a field it's a format spec, where a quote is
      // a fill character and only { and } mean anything. fields is a stack: specs can nest.
      const fields: { mode: 'expr' | 'spec'; depth: number }[] = [];
      for (;;) {
        if (j >= s.length) throw new PyError('SyntaxError', triple ? `unterminated triple-quoted string literal (detected at line ${s.endsWith('\n') ? line - 1 : line})` : `unterminated string literal (detected at line ${startLine})`, startLine);
        const field = fields.at(-1);
        if (field?.mode === 'expr') {
          const d = s[j];
          if (d === '"' || d === "'") {
            const inner = s.slice(j, j + 3) === d.repeat(3) ? d.repeat(3) : d;
            let k = j + inner.length;
            while (k < s.length && !s.startsWith(inner, k)) { if (s[k] === '\\') k++; if (s[k] === '\n') line++; k++; }
            j = k + inner.length;
            continue;
          }
          if (d === '}' && field.depth === 0) fields.pop();
          else if (d === ':' && field.depth === 0) field.mode = 'spec';
          else if ('([{'.includes(d)) field.depth++;
          else if (')]}'.includes(d)) field.depth--;
          else if (d === '\n') line++;
          j++;
          continue;
        }
        if (field?.mode === 'spec') {
          if (s[j] === '{') { fields.push({ mode: 'expr', depth: 0 }); j++; continue; }
          if (s[j] === '}') { fields.pop(); j++; continue; }
        } else if (p === 'f' && s[j] === '{') {
          if (s[j + 1] === '{') { j += 2; continue; }
          fields.push({ mode: 'expr', depth: 0 });
          j++;
          continue;
        }
        if (s[j] === '\\') { if (s[j + 1] === '\n') line++; j += 2; continue; }
        if (s[j] === '\n') { if (!triple) throw new PyError('SyntaxError', `unterminated string literal (detected at line ${startLine})`, startLine); line++; }
        if (s.startsWith(close, j)) break;
        j++;
      }
      const raw = s.slice(start, j);
      toks.push(p === 'f' ? { t: 'fstr', v: raw, line: startLine } : { t: 'str', v: p === 'r' ? raw : unescape(raw, startLine), line: startLine });
      i = j + close.length;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:[0-9][0-9_]*)?\.?[0-9_]*(?:[eE][+-]?[0-9][0-9_]*)?)/.exec(s.slice(i))!;
      const text = m[1], clean = text.replace(/_/g, '');
      i += text.length;
      if (/^[jJ]/.test(s[i] ?? '')) throw notHere('complex numbers', line);
      // 1if x else 2 is legal, if unkind to read: a keyword may follow a number directly.
      if (/[A-Za-z_]/.test(s[i] ?? '') && !/^(and|else|for|if|in|is|not|or)\b/.test(s.slice(i, i + 5))) throw new PyError('SyntaxError', 'invalid decimal literal', line);
      if (/__|_$|_[.eE]|[.eE]_|[eE][-+]_/.test(/^0[xXbBoO]_?/.test(text) ? text.replace(/^0[xXbBoO]_?/, '') : text)) throw new PyError('SyntaxError', 'invalid decimal literal', line);
      const isInt = /^(0[xXbBoO]|[0-9]+$)/.test(clean);
      if (isInt && /^0[0-9]*[1-9]/.test(clean) && !/^0[xXbBoO]/.test(clean)) throw new PyError('SyntaxError', 'leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers', line);
      toks.push({ t: 'num', v: text, n: isInt ? BigInt(clean) : Number(clean), line });
      continue;
    }
    // By code point, with Python's own identifier classes, then normalised as Python does:
    // ﬁ = 1 and print(fi) are one name there. By UTF-16 unit, a letter outside the first
    // plane or a combining accent was an "invalid character".
    const cp = String.fromCodePoint(s.codePointAt(i)!);
    if (/^[\p{XID_Start}_]$/u.test(cp)) {
      let j = i + cp.length;
      while (j < s.length) {
        const next = String.fromCodePoint(s.codePointAt(j)!);
        if (!/^\p{XID_Continue}$/u.test(next)) break;
        j += next.length;
      }
      toks.push({ t: 'name', v: s.slice(i, j).normalize('NFKC'), line });
      i = j;
      continue;
    }
    const op = OPS.find((o) => s.startsWith(o, i));
    if (!op) {
      if (c === '\\') throw new PyError('SyntaxError', 'unexpected character after line continuation character', line);
      const hex = cp.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      if (!isPrintable(cp)) throw new PyError('SyntaxError', `invalid non-printable character U+${hex}`, line);
      // Real Python's tokenizer has no word for $, ? and ! on their own: only a character
      // outside ASCII gets called invalid, and that message names its code.
      throw new PyError('SyntaxError', cp.codePointAt(0)! < 128 ? 'invalid syntax' : `invalid character '${cp}' (U+${hex})`, line);
    }
    if ('([{'.includes(op)) { depth++; open.push({ c: op, line }); }
    if (')]}'.includes(op)) {
      const top = open.pop();
      if (!top) throw new PyError('SyntaxError', `unmatched '${op}'`, line);
      if (top.c !== PAIR[op]) throw new PyError('SyntaxError', `closing parenthesis '${op}' does not match opening parenthesis '${top.c}'${top.line === line ? '' : ` on line ${top.line}`}`, line);
      depth--;
    }
    toks.push({ t: 'op', v: op, line });
    i += op.length;
  }
  // The line it was opened on, as Python reports it. The end of the file is where it
  // was noticed, which would send a learner to the wrong line.
  if (open.length) throw new PyError('SyntaxError', `'${open.at(-1)!.c}' was never closed`, open.at(-1)!.line);
  if (toks.length && toks.at(-1)!.t !== 'nl') toks.push({ t: 'nl', v: '', line });
  while (indents.length > 1) { indents.pop(); toks.push({ t: 'dedent', v: '', line }); }
  toks.push({ t: 'eof', v: '', line });
  return toks;
}
