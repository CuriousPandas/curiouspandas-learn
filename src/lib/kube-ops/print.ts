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

/**
 * Flags real kubectl 1.37 accepts that the sandboxes don't model. Answering
 * these with kubectl's own "error: unknown flag" would tell the learner a real
 * flag doesn't exist, which is the one thing a sandbox must never claim. The
 * list was checked, flag by flag, against kubectl 1.37.2's `kubectl options`
 * and the --help of every verb the sandboxes run (2026-11-03).
 */
export const REAL_KUBECTL_FLAGS = new Set(['--context', '--kubeconfig', '--cluster', '--user', '--server', '-s', '--token', '--as', '--as-group', '--request-timeout', '--insecure-skip-tls-verify', '-v', '--v',
  '-n', '--namespace', '-A', '--all-namespaces', '-l', '--selector', '--field-selector', '--all', '-o', '--output', '--show-labels', '-L', '--label-columns', '--sort-by', '--no-headers', '-w', '--watch', '--watch-only',
  '-f', '--filename', '-k', '--kustomize', '-R', '--recursive', '--dry-run', '--server-side', '--force-conflicts', '--field-manager', '--prune', '--wait', '--timeout', '--grace-period', '--now', '--force', '--cascade',
  '--ignore-not-found', '--overwrite', '--type', '-p', '--patch', '--replicas', '--current-replicas', '--image', '-c', '--container', '-i', '--stdin', '-t', '--tty', '-q', '--quiet', '--chunk-size', '--raw', '--subresource',
  '--ignore-daemonsets', '--delete-emptydir-data', '--disable-eviction', '--pod-selector', '--skip-wait-for-delete-timeout', '--min-available', '--max-unavailable', '--client', '--validate', '--save-config', '--edit']);

/** Flags in `--name=value` or `--name value` form, with a list of those that take a value. */
export function parseFlags(args: string[], valued: Set<string>, known: Set<string>, real: Set<string> = REAL_KUBECTL_FLAGS): { pos: string[]; flags: Map<string, string> } {
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i)); break; }
    if (!a.startsWith('-') || a === '-') { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!known.has(name)) {
      if (name === '--context') throw new CmdError('sandbox: --context is real kubectl, and you should always pass it on a real machine. This sandbox has one cluster and does not model it: leave it out here.');
      if (real.has(name)) throw new CmdError(`sandbox: ${name} is a real kubectl flag, but this sandbox does not model it here.\n(the sandbox knows: ${[...known].sort().join(' ')})`);
      throw new CmdError(`error: unknown flag: ${name}\n(the sandbox knows: ${[...known].sort().join(' ')})`);
    }
    if (eq > 0) flags.set(name, a.slice(eq + 1));
    else if (valued.has(name)) {
      if (i + 1 >= args.length) throw new CmdError(`error: flag needs an argument: ${name}`);
      flags.set(name, args[++i]);
    } else flags.set(name, 'true');
  }
  return { pos, flags };
}

/**
 * Go's time.ParseDuration, which is what kubectl uses for --timeout: a sign,
 * then one or more number+unit pairs ("1m30s", "1.5h", "250ms"), or a bare
 * "0". Returns seconds. The messages are Go's, as kubectl 1.37.2 printed them
 * for `drain --timeout=30` and `--timeout=abc`; a strict `\d+(s|m)` used to
 * refuse "1m30s" and "2h", which kubectl accepts.
 */
export function goDuration(s: string): number {
  const q = JSON.stringify(s);
  const units: Record<string, number> = { ns: 1e-9, us: 1e-6, 'µs': 1e-6, 'μs': 1e-6, ms: 1e-3, s: 1, m: 60, h: 3600 };
  let rest = s, sign = 1;
  if (rest[0] === '-' || rest[0] === '+') { if (rest[0] === '-') sign = -1; rest = rest.slice(1); }
  if (rest === '0') return 0;
  if (!rest) throw new CmdError(`time: invalid duration ${q}`);
  let total = 0;
  while (rest) {
    const num = /^(\d*)(\.\d*)?/.exec(rest)!;
    if (!num[0] || num[0] === '.') throw new CmdError(`time: invalid duration ${q}`);
    rest = rest.slice(num[0].length);
    const unit = /^[^\d.]*/.exec(rest)![0];
    if (!unit) throw new CmdError(`time: missing unit in duration ${q}`);
    if (!(unit in units)) throw new CmdError(`time: unknown unit ${JSON.stringify(unit)} in duration ${q}`);
    rest = rest.slice(unit.length);
    total += Number(num[0].startsWith('.') ? '0' + num[0] : num[0]) * units[unit];
  }
  return sign * total;
}

/**
 * Go's Duration.String(), which is how kubectl drain prints its timeout in
 * "global timeout reached: %v": 60s comes back as "1m0s", not "60s".
 */
export function goDurationString(secs: number): string {
  if (secs === 0) return '0s';
  const neg = secs < 0 ? '-' : '';
  let s = Math.abs(secs);
  const trim = (n: number) => String(Number(n.toFixed(9)));
  if (s < 1e-6) return `${neg}${trim(s * 1e9)}ns`;
  if (s < 1e-3) return `${neg}${trim(s * 1e6)}µs`;
  if (s < 1) return `${neg}${trim(s * 1e3)}ms`;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${neg}${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${trim(s)}s`;
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
