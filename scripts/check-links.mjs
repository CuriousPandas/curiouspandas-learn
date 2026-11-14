// Asks every source a lesson cites whether it is still there.
//
//   node scripts/check-links.mjs            writes .freshness/links.json and report.md
//
// A lesson's `sources` are what a reader is told to check a claim against.
// The full review on 2026-11-11 found most of its 60 problems came from those
// pages changing after the lesson was written, and nothing here was watching.
// The weekly workflow (.github/workflows/freshness.yml) runs this and files
// what it finds.
//
// Three outcomes, kept apart on purpose:
//   gone       the page answered 404 or 410, or its host no longer resolves
//   moved      it answered, from a different address than the one cited
//   unchecked  it could not be asked: the site refused a script (401, 403,
//              429), failed (5xx) or timed out
// "unchecked" is never reported as fine. Plenty of sites refuse anything that
// is not a browser, so a 403 says nothing about the page. Counting those as
// passes would make the report read "all clear" for links nobody looked at.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const LESSONS = 'src/content/lessons';

/**
 * Every cited URL, with the lessons that cite it.
 * @returns {Map<string, string[]>}
 */
export function citedUrls(dir = LESSONS) {
  const cited = new Map();
  for (const track of readdirSync(dir)) for (const file of readdirSync(join(dir, track))) {
    if (!file.endsWith('.mdx')) continue;
    const text = readFileSync(join(dir, track, file), 'utf8');
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) throw new Error(`${track}/${file} has no frontmatter`);
    for (const s of parse(m[1]).sources ?? []) {
      if (!cited.has(s.url)) cited.set(s.url, []);
      cited.get(s.url).push(`${track}/${file.replace(/\.mdx$/, '')}`);
    }
  }
  return cited;
}

// The same page, for our purposes: scheme, a leading www., a trailing slash
// and the #fragment do not make it a different address.
const canon = (u) => {
  const x = new URL(u);
  return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}`;
};

// Redirects that are how the link is meant to work, not a sign it moved.
// Without these the first real run listed 60 "moved" sources, a third of
// them noise, and a report that is mostly noise stops being read.
function sameSource(url, finalUrl) {
  const from = new URL(url), to = new URL(finalUrl);
  if (canon(url) === canon(finalUrl)) return true;
  // A DOI is a permanent name whose whole job is to redirect to the publisher.
  if (/^(dx\.)?doi\.org$/.test(from.hostname)) return true;
  // A GitHub release download answers from a signed, short-lived storage URL.
  if (from.hostname === 'github.com' && /\/releases\/download\//.test(from.pathname)) return true;
  // A sign-in bounce that carries the page it will return to (nature.com).
  if (decodeURIComponent(to.search).includes(from.hostname + from.pathname)) return true;
  // Same page with a query added, such as a docs version (?view=net-11.0).
  return from.hostname.replace(/^www\./, '') === to.hostname.replace(/^www\./, '')
    && from.pathname.replace(/\/+$/, '') === to.pathname.replace(/\/+$/, '');
}

/**
 * What one answer means. `error` is a fetch failure's code or name. `accepted`
 * maps a cited URL to the reason its redirect is expected
 * (scripts/link-check-accept.json).
 * @param {{ url: string, status?: number, finalUrl?: string, error?: string }} answer
 * @param {Record<string, string>} [accepted]
 * @param {Record<string, string>} [unscriptable] hostname to the reason (scripts/link-check-unscriptable.json)
 * @returns {{ kind: 'ok' | 'moved' | 'gone' | 'unchecked', why: string }}
 */
export function classify({ url, status, finalUrl, error }, accepted = {}, unscriptable = {}) {
  // A site known to send every script to its front page (or a challenge)
  // whatever was asked for. Its answer says nothing, so it is not "gone" and
  // it is certainly not "ok".
  const wall = unscriptable[new URL(url).hostname];
  if (wall) return { kind: 'unchecked', why: `this site cannot be checked by a script: ${wall}` };
  if (error) {
    // The host itself is gone. Anything else (reset, timeout, TLS) is a
    // failure to ask, not an answer.
    return /ENOTFOUND|EAI_NONAME/.test(error) ? { kind: 'gone', why: 'host does not resolve' } : { kind: 'unchecked', why: error };
  }
  if (status === 404 || status === 410) return { kind: 'gone', why: `HTTP ${status}` };
  if (status >= 200 && status < 300) {
    if (!finalUrl || sameSource(url, finalUrl)) return { kind: 'ok', why: `HTTP ${status}` };
    if (accepted[url]) return { kind: 'ok', why: `redirects to ${finalUrl}, accepted: ${accepted[url]}` };
    // A deep link that now lands on the site's front page has not moved, it
    // has been dropped, and the redirect hides that behind a 200.
    const lost = new URL(url).pathname.replace(/\/+$/, '') !== '' && new URL(finalUrl).pathname.replace(/\/+$/, '') === '';
    return lost ? { kind: 'gone', why: `redirects to the front page (${finalUrl}); the page itself is probably gone` } : { kind: 'moved', why: `now at ${finalUrl}` };
  }
  return { kind: 'unchecked', why: `HTTP ${status}` };
}

async function ask(url, { timeoutMs = 25000, tries = 3 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, {
        redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
        // A plain browser-like Accept and a name that says what this is. No
        // contact address: it would publish one in every site's logs.
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; curiouspandas-link-check)', accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8' },
      });
      await res.body?.cancel();
      last = { url, status: res.status, finalUrl: res.url };
      // An answer that is an answer. 429 and 5xx are worth one more go.
      if (res.status < 500 && res.status !== 429) return last;
    } catch (e) {
      last = { url, error: e.cause?.code ?? e.name ?? String(e) };
      if (/ENOTFOUND|EAI_NONAME/.test(last.error)) return last;
    }
    await new Promise((ok) => setTimeout(ok, 2000 * (i + 1)));
  }
  return last;
}

/** Runs `job` over `items`, at most `perHost` at a time for any one host. */
async function pooled(items, job, { total = 12, perHost = 2 } = {}) {
  const queue = [...items], busy = new Map(), out = [];
  const next = () => {
    const i = queue.findIndex((u) => (busy.get(new URL(u).hostname) ?? 0) < perHost);
    return i < 0 ? undefined : queue.splice(i, 1)[0];
  };
  await Promise.all(Array.from({ length: total }, async () => {
    for (;;) {
      const u = next();
      if (u === undefined) {
        if (!queue.length) return;
        await new Promise((ok) => setTimeout(ok, 200)); // every waiting URL's host is busy
        continue;
      }
      const h = new URL(u).hostname;
      busy.set(h, (busy.get(h) ?? 0) + 1);
      try { out.push(await job(u)); } finally { busy.set(h, busy.get(h) - 1); }
    }
  }));
  return out;
}

/**
 * @param {{ url: string, kind: string, why: string }[]} results
 * @param {Map<string, string[]>} cited
 * @param {string} when
 */
export function report(results, cited, when) {
  const by = (k) => results.filter((r) => r.kind === k).sort((a, b) => a.url.localeCompare(b.url));
  const line = (r) => `- ${r.url}\n  - ${r.why}\n  - cited in: ${cited.get(r.url).map((l) => `\`${l}\``).join(', ')}`;
  const gone = by('gone'), moved = by('moved'), unchecked = by('unchecked'), ok = by('ok');
  const out = [
    `Checked ${when}: ${results.length} cited sources.`,
    '',
    `| Result | Count |`, `| --- | --- |`,
    `| Gone | ${gone.length} |`, `| Moved | ${moved.length} |`, `| Could not be checked | ${unchecked.length} |`, `| Fine | ${ok.length} |`,
    '',
  ];
  if (gone.length) out.push('## Gone', '', 'The lesson cites a page that is no longer there. Find where it went or replace the source.', '', ...gone.map(line), '');
  if (moved.length) out.push('## Moved', '', 'Still answering, from a new address. Usually just update the link; check a quote still reads the same.', '', ...moved.map(line), '');
  if (unchecked.length) out.push('## Could not be checked', '', 'These refused a script, failed or timed out. That says nothing about the page. Open one by hand if it has been here for weeks.', '', ...unchecked.map(line), '');
  return { text: out.join('\n'), counts: { gone: gone.length, moved: moved.length, unchecked: unchecked.length, ok: ok.length } };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const cited = citedUrls();
  if (cited.size < 100) throw new Error(`only ${cited.size} cited sources found - the lessons or their frontmatter moved; refusing to report on that`);
  const answers = await pooled([...cited.keys()], (u) => ask(u));
  // Redirects someone has looked at and decided to keep citing as they are.
  const accepted = JSON.parse(readFileSync('scripts/link-check-accept.json', 'utf8'));
  for (const u of Object.keys(accepted)) if (!cited.has(u)) throw new Error(`scripts/link-check-accept.json accepts ${u}, which no lesson cites any more; remove it`);
  const unscriptable = JSON.parse(readFileSync('scripts/link-check-unscriptable.json', 'utf8'));
  const hosts = new Set([...cited.keys()].map((u) => new URL(u).hostname));
  for (const h of Object.keys(unscriptable)) if (!hosts.has(h)) throw new Error(`scripts/link-check-unscriptable.json lists ${h}, which no lesson cites any more; remove it`);
  const results = answers.map((a) => ({ ...a, ...classify(a, accepted, unscriptable) }));
  const when = new Date().toISOString().slice(0, 10);
  const { text, counts } = report(results, cited, when);
  // If most of the web could not be reached, the runner had no network, and a
  // report built on that would list hundreds of pages as doubtful or, worse,
  // none as gone. Fail instead.
  if (counts.unchecked > results.length / 2) {
    throw new Error(`${counts.unchecked} of ${results.length} sources could not be checked - this looks like a network problem here, not theirs`);
  }
  mkdirSync('.freshness', { recursive: true });
  writeFileSync('.freshness/links.json', JSON.stringify({ when, counts, results }, null, 2) + '\n');
  writeFileSync('.freshness/report.md', text + '\n');
  console.log(text);
}
