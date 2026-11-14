// The weekly link check is only worth having if its three answers stay apart.
// The failure it guards against is a quiet one: a site that refuses scripts
// answers 403 for a page that is fine, and a checker that files 403 under
// "ok" reports every such source as checked when nobody looked at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citedUrls, classify, report } from '../scripts/check-links.mjs';

const url = 'https://example.org/docs/page/';

test('links: gone means the page said so, or its host no longer exists', () => {
  assert.equal(classify({ url, status: 404 }).kind, 'gone');
  assert.equal(classify({ url, status: 410 }).kind, 'gone');
  assert.equal(classify({ url, error: 'ENOTFOUND' }).kind, 'gone');
});

test('links: a refusal, a server error or a timeout is "unchecked", never "ok"', () => {
  for (const status of [401, 403, 429, 500, 503]) assert.equal(classify({ url, status }).kind, 'unchecked', `HTTP ${status}`);
  for (const error of ['TimeoutError', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT']) assert.equal(classify({ url, error }).kind, 'unchecked', error);
});

test('links: a new address is "moved"; http, www, a trailing slash and a fragment are not', () => {
  assert.equal(classify({ url, status: 200, finalUrl: 'https://example.org/docs/new-page/' }).kind, 'moved');
  assert.equal(classify({ url, status: 200, finalUrl: 'https://other.example/docs/page/' }).kind, 'moved');
  for (const same of ['https://www.example.org/docs/page', 'http://example.org/docs/page/', 'https://example.org/docs/page/#section']) {
    assert.equal(classify({ url, status: 200, finalUrl: same }).kind, 'ok', same);
  }
});

test('links: the report counts every source once and names the lessons that cite it', () => {
  const cited = new Map([['https://a.example/x', ['web/one', 'web/two']], ['https://b.example/y', ['linux/three']], ['https://c.example/z', ['git/four']]]);
  const results = [
    { url: 'https://a.example/x', kind: 'gone', why: 'HTTP 404' },
    { url: 'https://b.example/y', kind: 'unchecked', why: 'HTTP 403' },
    { url: 'https://c.example/z', kind: 'ok', why: 'HTTP 200' },
  ];
  const r = report(results, cited, '2026-11-14');
  assert.deepEqual(r.counts, { gone: 1, moved: 0, unchecked: 1, ok: 1 });
  assert.match(r.text, /cited in: `web\/one`, `web\/two`/);
  assert.match(r.text, /## Could not be checked/);
  assert.doesNotMatch(r.text, /c\.example/, 'a source that is fine is counted, not listed');
});

test('links: the lessons really do cite hundreds of sources', () => {
  // If the frontmatter format changes and this finds nothing, the weekly job
  // would check nothing and say so cheerfully.
  const cited = citedUrls();
  assert.ok(cited.size > 500, `found only ${cited.size}`);
  for (const [u, lessons] of cited) { assert.match(u, /^https?:\/\//); assert.ok(lessons.length > 0); }
});

// The first real run reported 60 sources as moved. About a third were links
// doing what they are for.
test('links: a DOI, a release download, a sign-in bounce and an added query are not "moved"', () => {
  const ok = (u: string, to: string) => assert.equal(classify({ url: u, status: 200, finalUrl: to }).kind, 'ok', u);
  ok('https://doi.org/10.1007/s10869-024-09977-0', 'https://link.springer.com/10.1007/s10869-024-09977-0');
  ok('https://github.com/riscv/riscv-isa-manual/releases/download/20240411/priv-isa-asciidoc.pdf', 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x');
  ok('https://www.nature.com/articles/nature10872', 'https://idp.nature.com/transit?redirect_uri=https%3A%2F%2Fwww.nature.com%2Farticles%2Fnature10872&code=1');
  ok('https://learn.microsoft.com/en-us/dotnet/api/system.array.sort', 'https://learn.microsoft.com/en-us/dotnet/api/system.array.sort?view=net-11.0');
  // A real move on the same site still counts.
  assert.equal(classify({ url: 'https://docs.python.org/3/library/functions.html', status: 200, finalUrl: 'https://docs.python.org/3/builtins/functions.html' }).kind, 'moved');
});

test('links: a deep link that now lands on the front page is gone, not moved', () => {
  const r = classify({ url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', status: 200, finalUrl: 'https://eur-lex.europa.eu/' });
  assert.equal(r.kind, 'gone');
  assert.match(r.why, /front page/);
  // A link that always pointed at the front page is fine.
  assert.equal(classify({ url: 'https://example.org/', status: 200, finalUrl: 'https://example.org/' }).kind, 'ok');
});

test('links: an accepted redirect is fine and says why; an unlisted one is still moved', () => {
  const a = { url: 'https://www.unicode.org/versions/latest/core-spec/chapter-2/', status: 200, finalUrl: 'http://www.unicode.org/versions/Unicode18.0.0/core-spec/chapter-2/' };
  assert.equal(classify(a).kind, 'moved');
  const r = classify(a, { [a.url]: 'always the newest version, on purpose' });
  assert.equal(r.kind, 'ok');
  assert.match(r.why, /on purpose/);
});

// The check's first "gone" was the GDPR text on eur-lex. It was not gone:
// eur-lex sent every address we tried, including an unrelated regulation, to
// its front page. One false alarm a week teaches people to ignore the issue.
test('links: a site that bounces every script is "unchecked", whatever it answered', () => {
  const walls = { 'eur-lex.europa.eu': 'sends every script to its front page' };
  const a = { url: 'https://eur-lex.europa.eu/eli/reg/2016/679/oj', status: 200, finalUrl: 'https://eur-lex.europa.eu/' };
  assert.equal(classify(a).kind, 'gone', 'without the list this is what it looks like');
  const r = classify(a, {}, walls);
  assert.equal(r.kind, 'unchecked');
  assert.match(r.why, /cannot be checked by a script/);
  // Only that host: another site's front-page redirect is still gone.
  assert.equal(classify({ url: 'https://example.org/a/b', status: 200, finalUrl: 'https://example.org/' }, {}, walls).kind, 'gone');
});
