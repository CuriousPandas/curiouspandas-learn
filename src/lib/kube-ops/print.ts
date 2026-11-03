// Printing and parsing shared by the ops and storage sandboxes. Column layout,
// ages and the Events table follow kubectl 1.37 against a 1.36 server, copied
// from real output while these lessons were written; tests pin each shape.

export type Out = { text: string; kind: 'out' | 'err' | 'dim' };
export const out = (text: string): Out[] => (text ? [{ text, kind: 'out' }] : []);
export const err = (text: string): Out[] => [{ text, kind: 'err' }];

export class CmdError extends Error {}

/** kubectl's columns: each padded to its widest cell plus three spaces, the last left ragged. */
export function table(rows: string[][]): string {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i] + 3))).join('').trimEnd()).join('\n');
}

/** k8s.io/apimachinery duration.HumanDuration, which is what the AGE column uses. */
export function human(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 10) return s % 60 ? `${m}m${s % 60}s` : `${m}m`;
  if (m < 180) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 8) return m % 60 ? `${h}h${m % 60}m` : `${h}h`;
  if (h < 48) return `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d${h % 24}h` : `${d}d`;
}

export type Ev = { type: 'Normal' | 'Warning'; reason: string; from: string; message: string; first: number; last: number; count: number };

/** Record an event, folding a repeat into the previous one the way the API's event deduplication does. */
export function record(list: Ev[], now: number, type: Ev['type'], reason: string, from: string, message: string) {
  const prev = list.find((e) => e.reason === reason && e.message === message && e.from === from);
  if (prev) { prev.count++; prev.last = now; return; }
  list.push({ type, reason, from, message, first: now, last: now, count: 1 });
}

/** The Events block at the bottom of `kubectl describe`. */
export function eventsBlock(list: Ev[], nowSeconds: number, secondsPerTick: number): string {
  if (!list.length) return 'Events:                      <none>';
  const age = (e: Ev) => {
    const a = human(nowSeconds - e.last * secondsPerTick);
    return e.count > 1 ? `${a} (x${e.count} over ${human(nowSeconds - e.first * secondsPerTick)})` : a;
  };
  const rows = [['Type', 'Reason', 'Age', 'From', 'Message'], ['----', '------', '----', '----', '-------'],
    ...[...list].sort((a, b) => a.last - b.last).map((e) => [e.type, e.reason, age(e), e.from, e.message])];
  return 'Events:\n' + table(rows).split('\n').map((l) => '  ' + l).join('\n');
}

/** Split a command line the way a shell would, for the subset the sandboxes accept. */
export function tokenize(line: string): string[] {
  const outp: string[] = [];
  let cur = '', q: string | null = null, had = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { q = c; had = true; continue; }
    if (c === ' ' || c === '\t') { if (cur || had) outp.push(cur); cur = ''; had = false; continue; }
    // A pipe or a redirect outside quotes would run another program on a real
    // shell. The sandboxes have no other programs, so they say so instead of
    // quietly passing `| grep` on to kubectl as an argument.
    if (c === '|' || c === '>' || c === '<' || c === ';' || c === '&' || c === '`' || (c === '$' && line[i + 1] === '(')) {
      throw new CmdError(`sandbox: "${c === '$' ? '$(' : c}" needs a real shell; this one runs one command at a time (no pipes, redirects or chains)`);
    }
    cur += c;
  }
  if (q) throw new CmdError(`sandbox: unterminated ${q} quote`);
  if (cur || had) outp.push(cur);
  return outp;
}

/** Flags in `--name=value` or `--name value` form, with a list of those that take a value. */
export function parseFlags(args: string[], valued: Set<string>, known: Set<string>): { pos: string[]; flags: Map<string, string> } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i)); break; }
    if (!a.startsWith('-') || a === '-') { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!known.has(name)) throw new CmdError(`error: unknown flag: ${name}\n(the sandbox knows: ${[...known].sort().join(' ')})`);
    if (eq > 0) flags.set(name, a.slice(eq + 1));
    else if (valued.has(name)) {
      if (i + 1 >= args.length) throw new CmdError(`error: flag needs an argument: ${name}`);
      flags.set(name, args[++i]);
    } else flags.set(name, 'true');
  }
  return { pos, flags };
}

/** A pseudo-random suffix that is stable for a given seed, so tests see the same pod names every run. */
export function suffixer(seed: number) {
  let s = seed >>> 0;
  const alphabet = 'bcdfghjklmnpqrstvwxz2456789';
  return (len: number) => {
    let r = '';
    for (let i = 0; i < len; i++) { s = (Math.imul(s, 1103515245) + 12345) >>> 0; r += alphabet[(s >>> 16) % alphabet.length]; }
    return r;
  };
}
