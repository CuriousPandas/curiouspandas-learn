// A small YAML reader for the storage sandbox's manifests. Real kubectl takes
// full YAML 1.2; this takes the shape Kubernetes manifests are written in and
// refuses everything else by name, so a learner who types an anchor or a
// block scalar is told the sandbox cannot read it rather than getting a
// quietly different object. tests/kube-storage.test.ts holds it to the `yaml`
// package on every fixture and on mutations of them.
//
// Read: block mappings, block sequences, flow sequences of scalars ([a, b]),
// the empty flow map {}, plain and quoted scalars, comments and `---`.
// Refused: anchors, aliases, tags, block scalars (| and >), flow mappings with
// content, multi-line scalars, tabs for indentation, duplicate keys.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };

export class YamlError extends Error {}

type Line = { n: number; indent: number; text: string };

const refuse = (n: number, what: string): never => { throw new YamlError(`error: line ${n}: ${what}`); };

/** Strip a comment that starts at a `#` preceded by whitespace (or at the line start), outside quotes. */
function stripComment(s: string, n: number): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) {
        // '' inside single quotes is an escaped quote, not the end.
        if (q === "'" && s[i + 1] === "'") { i++; continue; }
        q = null;
      } else if (q === '"' && c === '\\') i++;
    } else if (c === '"' || c === "'") {
      // A quote only opens a quoted scalar at the start of a value.
      const before = s.slice(0, i).trimEnd();
      if (before === '' || before.endsWith(':') || before.endsWith('-') || before.endsWith('[') || before.endsWith(',')) q = c;
    } else if (c === '#' && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i).trimEnd();
  }
  if (q) refuse(n, `unterminated ${q} quote (the sandbox reads one-line strings only)`);
  return s.trimEnd();
}

function lex(src: string): Line[][] {
  const docs: Line[][] = [[]];
  src.replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const n = i + 1;
    if (/^\t/.test(raw) || /^ *\t/.test(raw)) refuse(n, 'tabs cannot indent YAML; use spaces');
    if (/^---\s*(#.*)?$/.test(raw)) { if (docs[docs.length - 1].length) docs.push([]); return; }
    if (/^\.\.\.\s*$/.test(raw)) return refuse(n, 'the "..." document end marker is not supported here');
    if (/^%/.test(raw)) return refuse(n, 'YAML directives (%) are not supported here');
    const text = stripComment(raw, n);
    if (!text.trim()) return;
    const indent = text.length - text.trimStart().length;
    docs[docs.length - 1].push({ n, indent, text: text.trimStart() });
  });
  return docs.filter((d) => d.length);
}

const PLAIN_SPECIAL = /^[&*!|>%@`]/;

function scalar(s: string, n: number): YamlValue {
  s = s.trim();
  if (s === '') return null;
  if (s[0] === '"') {
    if (!s.endsWith('"') || s.length < 2) refuse(n, 'a double-quoted string must end on the same line');
    const body = s.slice(1, -1);
    let out = '';
    for (let i = 0; i < body.length; i++) {
      if (body[i] === '"') refuse(n, 'stray " inside a double-quoted string');
      if (body[i] !== '\\') { out += body[i]; continue; }
      const e = body[++i];
      if (e === '"' || e === '\\' || e === '/') out += e;
      else if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else refuse(n, `the escape \\${e ?? ''} is not supported here`);
    }
    return out;
  }
  if (s[0] === "'") {
    if (!s.endsWith("'") || s.length < 2) refuse(n, "a single-quoted string must end on the same line");
    const body = s.slice(1, -1);
    if (/(^|[^'])'(?!')/.test(body.replace(/''/g, ''))) refuse(n, "stray ' inside a single-quoted string");
    return body.replace(/''/g, "'");
  }
  if (s[0] === '&') refuse(n, 'anchors (&) are not supported here');
  if (s[0] === '*') refuse(n, 'aliases (*) are not supported here');
  if (s[0] === '!') refuse(n, 'tags (!) are not supported here');
  if (s[0] === '|' || s[0] === '>') refuse(n, 'block scalars (| and >) are not supported here: put the text on one line');
  if (s[0] === '{') { if (/^\{\s*\}$/.test(s)) return {}; refuse(n, 'flow mappings ({...}) are not supported here: write one key per line'); }
  if (s[0] === '[') return flowSeq(s, n);
  if (PLAIN_SPECIAL.test(s)) refuse(n, `a plain value cannot start with ${s[0]}; quote it`);
  if (/: |:$/.test(s)) refuse(n, `"${s}" looks like a key inside a value; quote it or put it on its own line`);
  if (/ #/.test(s)) refuse(n, 'unexpected comment');
  // kubectl reads manifests through go-yaml, which follows YAML 1.1 for plain
  // values: there `yes` and `on` are true, `010` is eight and `1:20` is
  // eighty. The `yaml` package follows 1.2 and reads all of those as other
  // things, so the sandbox cannot be faithful to both and refuses them.
  if (/^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/.test(s)) refuse(n, `"${s}" means true or false to kubectl but text to other YAML readers; quote it, or write true or false`);
  if (/^[-+]?0[0-9]+$/.test(s) || /^[-+]?[0-9][0-9_]*_[0-9_]*$/.test(s) || /^[-+]?[0-9]+(:[0-5]?[0-9])+$/.test(s)) refuse(n, `"${s}" is a different number to kubectl's YAML reader than to others; quote it if you meant text`);
  if (/^\d{4}-\d\d?-\d\d?([Tt ]|$)/.test(s)) refuse(n, `"${s}" reads as a date to kubectl's YAML reader; quote it`);
  // The YAML 1.2 core schema, as the `yaml` package resolves it.
  if (/^(null|Null|NULL|~)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) {
    const v = Number(s);
    if (!Number.isSafeInteger(v)) refuse(n, `the number ${s} is too large for the sandbox; quote it`);
    return v;
  }
  if (/^0o[0-7]+$|^0x[0-9a-fA-F]+$|^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$|^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/.test(s))
    refuse(n, `"${s}" reads as a number that the sandbox does not handle; quote it if you meant text`);
  return s;
}

function flowSeq(s: string, n: number): YamlValue[] {
  if (!s.endsWith(']')) refuse(n, 'a flow sequence [...] must end on the same line');
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  if (/[[\]{}]/.test(inner.replace(/"[^"]*"|'[^']*'/g, ''))) refuse(n, 'nested flow collections are not supported here');
  const parts: string[] = [];
  let cur = '', q: string | null = null;
  for (const c of inner) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if (c === ',') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  // A trailing comma is legal YAML: [a, b,] has two items.
  if (parts.length > 1 && !parts[parts.length - 1].trim()) parts.pop();
  return parts.map((p) => {
    if (!p.trim()) refuse(n, 'empty item in a flow sequence');
    if (/^\s*[^"'\s][^:]*:\s/.test(p) || /:$/.test(p.trim())) refuse(n, 'key: value pairs inside [...] are not supported here');
    return scalar(p, n);
  });
}

/** Split "key: rest" at the first ": " (or a trailing ":") outside quotes. */
function splitKey(t: string): { key: string; rest: string } | null {
  if (t[0] === '"' || t[0] === "'") {
    const end = t.indexOf(t[0], 1);
    if (end < 0) return null;
    const after = t.slice(end + 1);
    const m = /^\s*:(\s|$)/.exec(after);
    if (!m) return null;
    return { key: scalar(t.slice(0, end + 1), 0) as string, rest: after.slice(m[0].length) };
  }
  const m = /^([^\s#'"[\]{},:][^:]*?|[^\s#'"[\]{}]+?):(\s+|$)/.exec(t);
  if (!m) return null;
  return { key: m[1].trimEnd(), rest: t.slice(m[0].length) };
}

class Parser {
  i = 0;
  lines: Line[];
  constructor(lines: Line[]) { this.lines = lines; }
  peek() { return this.lines[this.i]; }

  block(indent: number): YamlValue {
    const l = this.peek();
    if (!l) return null;
    if (l.text === '-' || l.text.startsWith('- ')) return this.seq(l.indent);
    if (splitKey(l.text)) return this.map(l.indent);
    // A lone scalar on its own line, e.g. a whole document that is just text.
    this.i++;
    if (this.peek() && this.peek()!.indent > indent) refuse(this.peek()!.n, 'multi-line plain values are not supported here');
    return scalar(l.text, l.n);
  }

  map(indent: number): { [k: string]: YamlValue } {
    const out: { [k: string]: YamlValue } = {};
    while (this.peek() && this.peek()!.indent === indent) {
      const l = this.peek()!;
      if (l.text === '-' || l.text.startsWith('- ')) refuse(l.n, 'a list item where a key was expected');
      const kv = splitKey(l.text);
      if (!kv) refuse(l.n, `expected "key: value", got "${l.text}"`);
      const { key, rest } = kv!;
      if (key === '<<') refuse(l.n, 'merge keys (<<) are not supported here');
      if (Object.prototype.hasOwnProperty.call(out, key)) refuse(l.n, `duplicate key "${key}"`);
      this.i++;
      if (rest.trim()) {
        out[key] = scalar(rest, l.n);
        const nx = this.peek();
        if (nx && nx.indent > indent) refuse(nx.n, `"${key}" already has a value on its own line, so this line cannot belong to it`);
      } else {
        const nx = this.peek();
        // A sequence may sit at the same indent as its parent key: Kubernetes
        // manifests write `containers:` then `- name:` directly under it.
        if (nx && (nx.indent > indent || (nx.indent === indent && (nx.text === '-' || nx.text.startsWith('- '))))) out[key] = this.block(nx.indent);
        else out[key] = null;
      }
    }
    const nx = this.peek();
    if (nx && nx.indent > indent) refuse(nx.n, 'this line is indented more than anything it could belong to');
    return out;
  }

  seq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (this.peek() && this.peek()!.indent === indent && (this.peek()!.text === '-' || this.peek()!.text.startsWith('- '))) {
      const l = this.peek()!;
      const body = l.text === '-' ? '' : l.text.slice(2);
      const lead = l.text.length - l.text.slice(1).trimStart().length; // "-" plus its spaces
      if (!body.trim()) {
        this.i++;
        const nx = this.peek();
        out.push(nx && nx.indent > indent ? this.block(nx.indent) : null);
        continue;
      }
      if (body.trimStart().startsWith('- ') || body.trim() === '-') refuse(l.n, 'nested "- -" lists are not supported here: put the inner list on its own lines');
      // "- key: value" opens a mapping whose keys line up after the dash.
      if (splitKey(body.trimStart())) {
        this.lines[this.i] = { n: l.n, indent: indent + lead, text: body.trimStart() };
        out.push(this.map(indent + lead));
      } else {
        this.i++;
        out.push(scalar(body, l.n));
        const nx = this.peek();
        if (nx && nx.indent > indent) refuse(nx.n, 'multi-line plain values are not supported here');
      }
    }
    return out;
  }
}

/** Every document in the text, in order. Throws YamlError naming the line. */
export function parseYaml(src: string): YamlValue[] {
  return lex(src).map((lines) => {
    const p = new Parser(lines);
    const v = p.block(lines[0].indent);
    const rest = p.peek();
    if (rest) refuse(rest.n, rest.indent < lines[0].indent ? 'this line is indented less than the start of the document' : 'unexpected line');
    return v;
  });
}
