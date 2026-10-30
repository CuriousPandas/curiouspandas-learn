// The README's "How it is sandboxed" section makes claims about what the site's
// code never does. This pins them: each rule names the claim it protects, so a
// change that breaks one fails here instead of quietly making the README false.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : /\.(ts|astro|mjs|js)$/.test(f) ? [p] : [];
});

// Match code, not prose. The XSS lesson's sample payloads ("steal(document.cookie)")
// and labels ("as HTML (innerHTML)") failed the first, word-matching version of
// this test. So only an .astro file's frontmatter and <script> blocks count, and
// string literals and comments are blanked out before matching (a template
// literal keeps its ${...} expressions, which are code).
export function codeOf(path: string, text: string): string {
  // Script blocks come from the template only: the XSS lab's frontmatter holds
  // the string '<script>steal(document.cookie)</script>', which a whole-file
  // search read as a real script block.
  const [, front = '', ...rest] = text.split(/^---$/m);
  const parts = path.endsWith('.astro')
    ? [front, ...[...rest.join('---').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])]
    : [text];
  return parts.join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, (t) => '`' + [...t.matchAll(/\$\{([^}]*)\}/g)].map((m) => m[1]).join(';') + '`');
}

const src = files('src').map((p) => {
  const text = readFileSync(p, 'utf8');
  return { p: p.replace(/\\/g, '/'), text, code: codeOf(p, text) };
});
const hits = (re: RegExp) => src.filter((f) => re.test(f.code)).map((f) => f.p);

test('nothing a learner types is ever run as code', () => {
  assert.deepEqual(hits(/\beval\s*\(|new Function\s*\(|set(Timeout|Interval)\s*\(\s*['"`]/), []);
});

test('the site makes no network calls of its own: no backend, no analytics', () => {
  assert.deepEqual(hits(/\bfetch\s*\(|XMLHttpRequest|new WebSocket|EventSource|navigator\.sendBeacon/), []);
});

test('no cookies: progress lives in localStorage only', () => {
  assert.deepEqual(hits(/document\.cookie/), []);
});

// innerHTML is reviewed by hand: each of these builds markup from the site's own
// strings and numbers, never from typed text or an imported file. A new use has
// to be added here deliberately, after the same review.
const REVIEWED_INNER_HTML = [
  'src/components/GitOpsSim.astro',
  'src/components/KVCacheSim.astro',
  'src/components/KVCalc.astro',
  'src/components/LayerCache.astro',
  'src/components/ScrapeSim.astro',
  'src/layouts/Base.astro',
  'src/pages/progress/index.astro',
];

test('HTML is only ever built from the site\'s own strings (reviewed list)', () => {
  // set:html is template syntax, so it is matched across the whole file.
  const found = [...new Set([
    ...hits(/\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\s*\(|document\.write\s*\(/),
    ...src.filter((f) => /set:html/.test(f.text)).map((f) => f.p),
  ])].sort();
  const unreviewed = found.filter((p) => !REVIEWED_INNER_HTML.includes(p));
  assert.deepEqual(unreviewed, [], `review these for user-controlled input, then add them to REVIEWED_INNER_HTML: ${unreviewed.join(', ')}`);
});

test('the matcher ignores strings and comments but still sees code', () => {
  assert.equal(/document\.cookie/.test(codeOf('a.ts', `const s = 'steal(document.cookie)'; // innerHTML`)), false);
  assert.equal(/\.innerHTML\s*=/.test(codeOf('a.ts', 'el.innerHTML = `<b>${name}</b>`;')), true);
  assert.equal(/fetch\s*\(/.test(codeOf('a.astro', '---\nconst x = 1;\n---\n<p>fetch(it)</p>\n<script>fetch(`/x`)</script>')), true);
});
