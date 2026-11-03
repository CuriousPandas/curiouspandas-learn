// A small YAML reader for the manifests the networking and packaging widgets
// accept. It reads the block style Kubernetes manifests are written in and
// refuses, by name, everything else. It never guesses.
//
// Two YAML readers disagree about plain words like `yes`, `on`, `0777` and
// `1_000`: YAML 1.1 (PyYAML, and the go-yaml behind kubectl) turns them into
// booleans and numbers, YAML 1.2 does not. A manifest whose meaning depends on
// that is a trap on a real cluster too, so this reader refuses those words and
// asks for quotes instead of picking a side. Everything it does accept is
// pinned against PyYAML 6.0.3 in tests/kube-net-yaml.test.ts.

export type Yaml = null | boolean | number | string | Yaml[] | { [k: string]: Yaml };

export class YamlError extends Error {
  line: number;
  constructor(line: number, msg: string) { super(`line ${line}: ${msg}`); this.line = line; }
}

type Line = { n: number; indent: number; text: string };

const AMBIGUOUS = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;

/** Splits a stream into documents and parses each. Empty documents are dropped, as kubectl does. */
export function parseAll(src: string): Yaml[] {
  if (src.includes('\t')) {
    const n = src.slice(0, src.indexOf('\t')).split('\n').length;
    throw new YamlError(n, 'a tab character; YAML indentation must be spaces');
  }
  const docs: Line[][] = [[]];
  src.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    if (/^---\s*(#.*)?$/.test(raw)) { docs.push([]); return; }
    if (/^\.\.\.\s*$/.test(raw)) throw new YamlError(i + 1, 'the "..." document end marker is not supported here');
    if (/^%/.test(raw)) throw new YamlError(i + 1, 'YAML directives (%) are not supported here');
    docs[docs.length - 1].push({ n: i + 1, indent: raw.length - raw.trimStart().length, text: raw });
  });
  return docs.map(parseDoc).filter((d): d is Exclude<Yaml, null> => d !== null);
}

export function parse(src: string): Yaml {
  const all = parseAll(src);
  if (all.length > 1) throw new YamlError(1, 'more than one document; this field takes one');
  return all[0] ?? null;
}

function parseDoc(lines: Line[]): Yaml {
  const p = new Parser(lines);
  p.skip();
  if (p.done()) return null;
  const v = p.node(p.peek().indent);
  p.skip();
  if (!p.done()) throw new YamlError(p.peek().n, 'unexpected indentation');
  return v;
}

/** Strips a trailing comment: a # that starts the line or follows a space, outside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) { if (q === "'" && s[i + 1] === "'") { i++; continue; } q = null; }
      else if (q === '"' && c === '\\') i++;
    } else if (c === '"' || c === "'") {
      // A quote only opens a quoted scalar at the start of a value.
      const before = s.slice(0, i).trimEnd();
      if (before === '' || /[:\-,[{]$/.test(before)) q = c;
    } else if (c === '#' && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i).trimEnd();
  }
  return s.trimEnd();
}

class Parser {
  i = 0;
  private lines: Line[];
  constructor(lines: Line[]) { this.lines = lines; }
  done() { return this.i >= this.lines.length; }
  peek() { return this.lines[this.i]; }
  /** Skips blank and comment-only lines. */
  skip() {
    while (!this.done() && stripComment(this.peek().text).trim() === '') this.i++;
  }

  node(indent: number): Yaml {
    this.skip();
    const l = this.peek();
    const body = stripComment(l.text).slice(l.indent);
    if (body === '-' || body.startsWith('- ')) return this.seq(l.indent);
    if (splitKey(body, l.n)) return this.map(l.indent);
    // A lone scalar at block level, e.g. a document that is just a word.
    this.i++;
    void indent;
    return this.inlineValue(body, l.n, l.indent - 1);
  }

  seq(indent: number): Yaml[] {
    const out: Yaml[] = [];
    for (;;) {
      this.skip();
      if (this.done()) break;
      const l = this.peek();
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError(l.n, 'unexpected indentation inside a list');
      const body = stripComment(l.text).slice(l.indent);
      if (!(body === '-' || body.startsWith('- '))) break;
      const rest = body.slice(1).trimStart();
      if (rest === '') {
        this.i++;
        this.skip();
        out.push(!this.done() && this.peek().indent > indent ? this.node(this.peek().indent) : null);
        continue;
      }
      // "- key: v" opens a mapping whose keys line up with "key". Rewrite this
      // line in place so the mapping reader sees an ordinary indented line.
      const col = l.indent + (body.length - rest.length);
      if (rest.startsWith('- ') || rest === '-' || splitKey(rest, l.n)) {
        this.lines[this.i] = { n: l.n, indent: col, text: ' '.repeat(col) + rest };
        out.push(this.node(col));
      } else {
        this.i++;
        out.push(this.inlineValue(rest, l.n, indent));
      }
    }
    return out;
  }

  map(indent: number): { [k: string]: Yaml } {
    const out: { [k: string]: Yaml } = {};
    for (;;) {
      this.skip();
      if (this.done()) break;
      const l = this.peek();
      if (l.indent < indent) break;
      if (l.indent > indent) throw new YamlError(l.n, 'unexpected indentation inside a mapping');
      const body = stripComment(l.text).slice(l.indent);
      if (body === '-' || body.startsWith('- ')) break;
      const kv = splitKey(body, l.n);
      if (!kv) throw new YamlError(l.n, `expected "key: value", found "${body}"`);
      const [k, rest] = kv;
      if (Object.prototype.hasOwnProperty.call(out, k)) throw new YamlError(l.n, `duplicate key "${k}"`);
      this.i++;
      if (rest === '') {
        this.skip();
        if (this.done()) { out[k] = null; continue; }
        const nx = this.peek();
        const nb = stripComment(nx.text).slice(nx.indent);
        // A list may sit at the same indent as its key: "ports:\n- 80".
        if (nx.indent > indent || (nx.indent === indent && (nb === '-' || nb.startsWith('- ')))) out[k] = this.node(nx.indent);
        else out[k] = null;
      } else {
        out[k] = this.inlineValue(rest, l.n, indent);
      }
    }
    return out;
  }

  /** A value written on the same line as its key or dash: a scalar, a flow collection or a block scalar. */
  inlineValue(rest: string, n: number, parentIndent: number): Yaml {
    if (/^[|>]/.test(rest)) return this.blockScalar(rest, n, parentIndent);
    if (rest.startsWith('[') || rest.startsWith('{')) {
      const f = new Flow(rest, n);
      const v = f.value();
      f.end();
      return v;
    }
    return scalar(rest, n);
  }

  blockScalar(head: string, n: number, parentIndent: number): string {
    const m = /^\|([+-]?)$/.exec(head);
    if (!m) {
      if (head.startsWith('>')) throw new YamlError(n, 'folded block scalars (>) are not supported here; use |');
      throw new YamlError(n, `block scalar header "${head}" is not supported here; use | or |-`);
    }
    if (m[1] === '+') throw new YamlError(n, 'the |+ keep indicator is not supported here; use | or |-');
    const body: string[] = [];
    let ind = -1;
    while (!this.done()) {
      const l = this.lines[this.i];
      if (l.text.trim() === '') { body.push(''); this.i++; continue; }
      if (l.indent <= parentIndent) break;
      if (ind < 0) ind = l.indent;
      if (l.indent < ind) break;
      body.push(l.text.slice(ind));
      this.i++;
    }
    // Trailing blank lines are dropped by both | (clip) and |- (strip).
    while (body.length && body[body.length - 1] === '') body.pop();
    if (!body.length) return '';
    return body.join('\n') + (m[1] === '-' ? '' : '\n');
  }
}

/** "key: rest" → [key, rest], or null if this is not a mapping line. */
function splitKey(body: string, n: number): [string, string] | null {
  if (body.startsWith('? ')) throw new YamlError(n, 'complex keys (?) are not supported here');
  let key: string, rest: string;
  if (body.startsWith('"') || body.startsWith("'")) {
    const q = body[0];
    let j = 1;
    for (; j < body.length; j++) {
      if (q === '"' && body[j] === '\\') { j++; continue; }
      if (body[j] === q) { if (q === "'" && body[j + 1] === "'") { j++; continue; } break; }
    }
    const after = body.slice(j + 1);
    if (!/^:( |$)/.test(after)) return null;
    key = String(scalar(body.slice(0, j + 1), n));
    rest = after.slice(1).trim();
    return [key, rest];
  }
  if (/^[[{]/.test(body)) return null;
  const m = /^([^#]*?):(?: (.*)|$)/.exec(body);
  if (!m) return null;
  key = m[1].trim();
  rest = (m[2] ?? '').trim();
  if (!key) throw new YamlError(n, 'a mapping key is empty');
  checkPlain(key, n);
  return [key, rest];
}

function checkPlain(s: string, n: number) {
  if (/^&/.test(s)) throw new YamlError(n, `anchors (${s.split(' ')[0]}) are not supported here`);
  if (/^\*/.test(s)) throw new YamlError(n, `aliases (${s.split(' ')[0]}) are not supported here`);
  if (/^!/.test(s)) throw new YamlError(n, `tags (${s.split(' ')[0]}) are not supported here`);
  if (/^[@`]/.test(s)) throw new YamlError(n, `a plain value cannot start with ${s[0]}; quote it`);
  if (/^[%]/.test(s)) throw new YamlError(n, `a plain value cannot start with %; quote it`);
}

/** Resolves one scalar the way YAML 1.1 and 1.2 agree on, refusing where they don't. */
export function scalar(raw: string, n: number): Yaml {
  const s = raw.trim();
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new YamlError(n, 'an unterminated double-quoted string');
    let out = '';
    for (let i = 1; i < s.length - 1; i++) {
      const c = s[i];
      if (c === '"') throw new YamlError(n, 'text after a closing quote');
      if (c !== '\\') { out += c; continue; }
      const e = s[++i];
      const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/', r: '\r', '0': '\0' };
      if (e in map) out += map[e];
      else throw new YamlError(n, `the escape \\${e} is not supported here`);
    }
    return out;
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new YamlError(n, 'an unterminated single-quoted string');
    const inner = s.slice(1, -1);
    if (/(^|[^'])'([^']|$)/.test(inner.replace(/''/g, ''))) throw new YamlError(n, 'text after a closing quote');
    return inner.replace(/''/g, "'");
  }
  checkPlain(s, n);
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (AMBIGUOUS.test(s)) throw new YamlError(n, `"${s}" means true or false to some YAML readers and a string to others; quote it`);
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(s)) return Number(s);
  if (/^[-+]?(0|[1-9][0-9]*)\.[0-9]+$/.test(s)) return Number(s);
  // Octal, hex, underscores, exponents, sexagesimal, inf and nan: readers differ.
  if (/^[-+]?(0[0-9]+|0[xXoObB][0-9a-fA-F_]+|[0-9][0-9_]*_[0-9_]*|[0-9.]+[eE][-+]?[0-9]+|[0-9]+(:[0-5]?[0-9])+(\.[0-9]*)?|\.[0-9]+|[0-9]+\.)$/.test(s) || /^[-+]?\.(inf|Inf|INF)$/.test(s) || /^\.(nan|NaN|NAN)$/.test(s))
    throw new YamlError(n, `"${s}" is read as a number by some YAML readers and a string by others; quote it`);
  if (/: |\s#/.test(s)) throw new YamlError(n, `"${s}" has ": " or " #" inside a plain value; quote it`);
  if (/:$/.test(s)) throw new YamlError(n, `"${s}" ends with ":"; quote it`);
  if (/^[-?:,[\]{}|>]( |$)/.test(s) || /^[,[\]{}]/.test(s)) throw new YamlError(n, `a plain value cannot start with "${s[0]}"; quote it`);
  return s;
}

/** Flow collections: [a, b] and {k: v}, nesting allowed, on one line. */
class Flow {
  i = 0;
  private s: string;
  private n: number;
  constructor(s: string, n: number) { this.s = s; this.n = n; }
  ws() { while (this.s[this.i] === ' ') this.i++; }
  end() {
    this.ws();
    if (this.i < this.s.length) throw new YamlError(this.n, `unexpected "${this.s.slice(this.i)}" after a flow collection`);
  }
  value(): Yaml {
    this.ws();
    const c = this.s[this.i];
    if (c === '[') return this.seq();
    if (c === '{') return this.map();
    return scalar(this.token(), this.n);
  }
  token(): string {
    this.ws();
    const start = this.i;
    const q = this.s[this.i];
    if (q === '"' || q === "'") {
      this.i++;
      while (this.i < this.s.length) {
        if (q === '"' && this.s[this.i] === '\\') { this.i += 2; continue; }
        if (this.s[this.i] === q) { if (q === "'" && this.s[this.i + 1] === "'") { this.i += 2; continue; } this.i++; break; }
        this.i++;
      }
      return this.s.slice(start, this.i);
    }
    while (this.i < this.s.length && !/[,\]}]/.test(this.s[this.i]) && !(this.s[this.i] === ':' && /[ ,\]}]/.test(this.s[this.i + 1] ?? ' '))) this.i++;
    return this.s.slice(start, this.i).trim();
  }
  seq(): Yaml[] {
    this.i++;
    const out: Yaml[] = [];
    this.ws();
    if (this.s[this.i] === ']') { this.i++; return out; }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = this.s[this.i++];
      if (c === ']') return out;
      if (c !== ',') throw new YamlError(this.n, 'expected "," or "]" in a flow list');
      this.ws();
      if (this.s[this.i] === ']') { this.i++; return out; }
    }
  }
  map(): { [k: string]: Yaml } {
    this.i++;
    const out: { [k: string]: Yaml } = {};
    this.ws();
    if (this.s[this.i] === '}') { this.i++; return out; }
    for (;;) {
      const k = scalar(this.token(), this.n);
      if (typeof k !== 'string') throw new YamlError(this.n, 'flow mapping keys must be strings here');
      this.ws();
      let v: Yaml = null;
      if (this.s[this.i] === ':') { this.i++; v = this.value(); }
      if (Object.prototype.hasOwnProperty.call(out, k)) throw new YamlError(this.n, `duplicate key "${k}"`);
      out[k] = v;
      this.ws();
      const c = this.s[this.i++];
      if (c === '}') return out;
      if (c !== ',') throw new YamlError(this.n, 'expected "," or "}" in a flow mapping');
      this.ws();
      if (this.s[this.i] === '}') { this.i++; return out; }
    }
  }
}

/** Writes a value back as block YAML, keys in the order given, the way kubectl prints. */
export function dump(v: Yaml, indent = 0): string {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    return v.map((x) => {
      if (x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length) {
        const inner = dump(x, indent + 2).slice(indent + 2);
        return `${pad}- ${inner}`;
      }
      if (Array.isArray(x) && x.length) return `${pad}-\n${dump(x, indent + 2)}`;
      return `${pad}- ${dumpScalar(x)}`;
    }).join('\n');
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) return '{}';
    return keys.map((k) => {
      const x = v[k];
      const key = needsQuote(k) ? JSON.stringify(k) : k;
      if (x && typeof x === 'object' && (Array.isArray(x) ? x.length : Object.keys(x).length)) {
        // kubectl prints a list at the same indent as its key.
        return Array.isArray(x) ? `${pad}${key}:\n${dump(x, indent)}` : `${pad}${key}:\n${dump(x, indent + 2)}`;
      }
      return `${pad}${key}: ${dumpScalar(x)}`;
    }).join('\n');
  }
  return pad + dumpScalar(v);
}

function needsQuote(s: string) {
  if (s === '' || /[\x00-\x1f"'#]/.test(s) || s !== s.trim()) return true;
  try { return scalar(s, 0) !== s; } catch { return true; }
}

function dumpScalar(x: Yaml): string {
  if (x === null) return 'null';
  if (Array.isArray(x)) return '[]';
  if (typeof x === 'object') return '{}';
  if (typeof x === 'string') return needsQuote(x) || x.includes('\n') ? JSON.stringify(x) : x;
  return String(x);
}
