// Password storage, measured on the learner's own device. Everything here is
// real WebCrypto - the same SHA-256 and PBKDF2 a server would use - so the
// guesses-per-second the lesson shows are this machine's real numbers, not a
// figure we made up. The attack only ever targets a hash made in this page.

export type Scheme = { kind: 'sha256'; salted: boolean } | { kind: 'pbkdf2'; iterations: number };
export type Stored = { scheme: Scheme; salt: string; hash: string };

// A tiny stand-in for the leaked-password lists attackers really use. Common
// choices first, the way real lists are ordered by popularity.
const BASE = [
  '123456', 'password', '123456789', 'qwerty', '12345678', '111111', '1234567', 'iloveyou', 'admin', 'welcome',
  'monkey', 'dragon', 'letmein', 'football', 'sunshine', 'princess', 'abc123', 'master', 'shadow', 'baseball',
  'superman', 'trustno1', 'hello123', 'freedom', 'whatever', 'starwars', 'michael', 'charlie', 'jordan23', 'passw0rd',
  'qwerty123', 'login', 'flower', 'hottie', 'loveme', 'zaq1zaq1', 'password1', 'secret', 'summer2024', 'winter2023',
  'cookie', 'chocolate', 'pepper', 'ginger', 'banana', 'orange', 'purple', 'soccer', 'hockey', 'killer',
  'computer', 'internet', 'samsung', 'google', 'pokemon', 'naruto', 'batman', 'thunder', 'tigger', 'buster',
  'bamboo', 'panda', 'panda123', 'redpanda', 'pandas', 'bamboo123', 'kungfu', 'giantpanda', 'pandabear', 'bamboo2024',
];

// Then the "rules" real cracking tools apply: the same words with the endings
// people add to satisfy a password policy. "pandabear2024" feels clever and
// sits a few hundred guesses in.
export const RULES = ['1', '123', '2024', '!'];
export const WORDLIST = [...new Set([...BASE, ...RULES.flatMap((r) => BASE.map((w) => w + r))])];

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

export async function sha256(text: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

export async function pbkdf2(password: string, salt: string, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256));
}

export function hashWith(scheme: Scheme, salt: string, guess: string): Promise<string> {
  if (scheme.kind === 'pbkdf2') return pbkdf2(guess, salt, scheme.iterations);
  return sha256(scheme.salted ? salt + guess : guess);
}

/** A fresh random salt, as a server would make one per user. */
export function newSalt(): string {
  return hex(crypto.getRandomValues(new Uint8Array(8)).buffer);
}

export async function storePassword(password: string, scheme: Scheme, salt = newSalt()): Promise<Stored> {
  const s = scheme.kind === 'sha256' && !scheme.salted ? '' : salt;
  return { scheme, salt: s, hash: await hashWith(scheme, s, password) };
}

/** The attacker's precomputed table: plain SHA-256 of every word, built once
 *  and reused against every unsalted database they ever steal. */
export async function buildTable(words: string[]): Promise<Map<string, string>> {
  const t = new Map<string, string>();
  for (const w of words) t.set(await sha256(w), w);
  return t;
}

/** A table lookup only works when the stored hash is plain SHA-256 of the
 *  password. Any salt - and any other scheme - makes every entry useless. */
export function lookup(stored: Stored, table: Map<string, string>): string | undefined {
  if (stored.scheme.kind !== 'sha256' || stored.scheme.salted) return undefined;
  return table.get(stored.hash);
}

export type CrackResult = { found?: string; tries: number; ms: number; gaveUp: boolean };

/** Dictionary attack with a time budget, so a slow scheme on a phone stops
 *  instead of freezing the page. Giving up is the result the lesson wants. */
export async function crack(
  stored: Stored, words: string[],
  opts: { budgetMs: number; onProgress?: (tries: number, ms: number) => void; now?: () => number },
): Promise<CrackResult> {
  const now = opts.now ?? (() => performance.now());
  const start = now();
  let tries = 0;
  for (const w of words) {
    if (now() - start > opts.budgetMs) return { tries, ms: now() - start, gaveUp: true };
    tries++;
    if ((await hashWith(stored.scheme, stored.salt, w)) === stored.hash) return { found: w, tries, ms: now() - start, gaveUp: false };
    // Hand the page back to the browser now and then so progress can paint.
    if (tries % 8 === 0) { opts.onProgress?.(tries, now() - start); await new Promise((r) => setTimeout(r, 0)); }
  }
  return { tries, ms: now() - start, gaveUp: false };
}

/** Guesses per second for a scheme on this device, measured for budgetMs. */
export async function measure(scheme: Scheme, budgetMs: number, now: () => number = () => performance.now()): Promise<number> {
  const salt = 'measure-salt';
  const start = now();
  let n = 0;
  while (n < 3 || now() - start < budgetMs) {
    await hashWith(scheme, salt, `guess${n}`);
    n++;
    if (n % 16 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return n / ((now() - start) / 1000);
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'forever';
  const units: [number, string][] = [[31557600, 'year'], [86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']];
  if (seconds < 1) return `${Math.max(1, Math.round(seconds * 1000))} ms`;
  if (seconds > 31557600 * 1000) return 'over 1,000 years';
  for (const [size, name] of units) {
    if (seconds >= size) {
      const v = seconds / size;
      const r = v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
      return `${r} ${name}${r === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}
