import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommit, bumpFor, nextVersion, changelog, caretAccepts, type Commit } from '../src/lib/delivery/conventional.ts';
import { RepoSim } from '../src/lib/delivery/releasesim.ts';

const ok = (m: string): Commit => {
  const r = parseCommit(m);
  assert.ok(r.ok, `should parse: ${m} (${!r.ok ? r.error : ''})`);
  return r.commit;
};
const bad = (m: string) => { const r = parseCommit(m); assert.equal(r.ok, false, `should be rejected: ${m}`); return !r.ok ? r.error : ''; };

// Every example below is from conventionalcommits.org/en/v1.0.0 "Examples".
test('the spec examples parse, with breaking changes from either ! or the footer', () => {
  const footer = ok('feat: allow provided config object to extend other configs\n\nBREAKING CHANGE: `extends` key in config file is now used for extending other config files');
  assert.equal(footer.type, 'feat'); assert.equal(footer.breaking, true);
  assert.equal(footer.breakingNote, '`extends` key in config file is now used for extending other config files');
  const bang = ok('feat!: send an email to the customer when a product is shipped');
  assert.equal(bang.breaking, true); assert.equal(bang.breakingNote, 'send an email to the customer when a product is shipped');
  const scoped = ok('feat(api)!: send an email to the customer when a product is shipped');
  assert.equal(scoped.scope, 'api'); assert.equal(scoped.breaking, true);
  const both = ok('feat!: drop support for Node 6\n\nBREAKING CHANGE: use JavaScript features not available in Node 6.');
  assert.equal(both.breakingNote, 'use JavaScript features not available in Node 6.');
  assert.equal(ok('docs: correct spelling of CHANGELOG').breaking, false);
  assert.equal(ok('feat(lang): add Polish language').scope, 'lang');
  const multi = ok('fix: prevent racing of requests\n\nIntroduce a request id and a reference to latest request. Dismiss\nincoming responses other than from latest request.\n\nRemove timeouts which were used to mitigate the racing issue but are\nobsolete now.\n\nReviewed-by: Z\nRefs: #123');
  assert.deepEqual(multi.footers, [{ token: 'Reviewed-by', value: 'Z' }, { token: 'Refs', value: '#123' }]);
  assert.match(multi.body!, /^Introduce a request id/);
  assert.equal(multi.breaking, false);
});

test('BREAKING-CHANGE is a synonym; a lowercase "breaking change" footer is not', () => {
  assert.equal(ok('fix: x\n\nBREAKING-CHANGE: y').breaking, true);
  assert.equal(ok('fix: x\n\nbreaking change: y').breaking, false);
});

test('types are not case-sensitive', () => assert.equal(ok('Fix: typo').type, 'fix'));

test('messages that are not conventional are rejected with the reason', () => {
  assert.match(bad('Fixed stuff'), /no type/);
  assert.match(bad('fix:typo'), /followed by a space/);
  assert.match(bad('fix: '), /no description/);
  assert.match(bad('fix(): typo'), /empty scope/);
  assert.match(bad('fix: typo\nbody without a blank line'), /blank line/);
});

test('bumps follow release-please defaults: breaking > feat > fix; chores alone release nothing', () => {
  assert.equal(bumpFor([ok('fix: a')]), 'patch');
  assert.equal(bumpFor([ok('fix: a'), ok('feat: b')]), 'minor');
  assert.equal(bumpFor([ok('feat: b'), ok('fix!: c')]), 'major');
  assert.equal(bumpFor([ok('chore: a'), ok('docs: b'), ok('refactor: c')]), null);
  assert.equal(bumpFor([ok('docs: a\n\nBREAKING CHANGE: the CLI flag is gone')]), 'major', 'any type with a breaking footer is major');
});

test('semver: minor resets patch, major resets both; pre-1.0 options change only the major case', () => {
  assert.equal(nextVersion('1.4.2', 'patch'), '1.4.3');
  assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0');
  assert.equal(nextVersion('v1.4.2', 'major'), '2.0.0');
  assert.equal(nextVersion('0.3.1', 'major'), '1.0.0');
  assert.equal(nextVersion('0.3.1', 'major', { bumpMinorPreMajor: true }), '0.4.0');
});

test('the changelog leads with breaking changes, then Features and Bug Fixes; chores are hidden', () => {
  const s = changelog([ok('fix(api): handle empty carts'), ok('feat: CSV export'), ok('chore: tidy'), ok('feat(api)!: rename user to account')]);
  assert.deepEqual(s.map((x) => x.heading), ['⚠ BREAKING CHANGES', 'Features', 'Bug Fixes']);
  assert.deepEqual(s[1].items, ['CSV export', '**api:** rename user to account']);
});

test('npm caret ranges take minors and patches automatically, never a major', () => {
  // node-semver: ^1.2.3 := >=1.2.3 <2.0.0-0, ^0.2.3 := >=0.2.3 <0.3.0-0, ^0.0.3 := >=0.0.3 <0.0.4-0
  assert.ok(caretAccepts('^1.2.3', '1.9.0')); assert.ok(!caretAccepts('^1.2.3', '2.0.0')); assert.ok(!caretAccepts('^1.2.3', '1.2.2'));
  assert.ok(caretAccepts('^0.2.3', '0.2.9')); assert.ok(!caretAccepts('^0.2.3', '0.3.0'));
  assert.ok(caretAccepts('^0.0.3', '0.0.3')); assert.ok(!caretAccepts('^0.0.3', '0.0.4'));
});

test('mission: shipping the API rename as a fix breaks users and does not pass; marking it breaking does', () => {
  const wrong = new RepoSim();
  wrong.commit('rename', 'fix: rename the user field to account in the API');
  const r1 = wrong.mergeRelease()!;
  assert.equal(r1.version, '1.4.3');
  assert.equal(r1.brokeUsers, true, 'users on ^1.4.2 pick up 1.4.3 automatically and their code breaks');
  assert.equal(wrong.shippedBreakingSafely(), false);

  const right = new RepoSim();
  right.commit('rename', 'feat(api)!: rename the user field to account');
  const r2 = right.mergeRelease()!;
  assert.equal(r2.version, '2.0.0');
  assert.equal(r2.brokeUsers, false);
  assert.equal(right.shippedBreakingSafely(), true);
});

test('a malformed commit lands in history but the release PR ignores it', () => {
  const s = new RepoSim();
  s.commit('typo', 'Fixed stuff');
  assert.equal(s.pending().bump, null);
  assert.equal(s.mergeRelease(), null, 'nothing to release');
  s.commit('typo', 'fix: correct the typo in the error message');
  assert.equal(s.pending().next, '1.4.3');
});
