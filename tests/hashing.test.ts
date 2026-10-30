import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, pbkdf2Sync } from 'node:crypto';
import { sha256, pbkdf2, storePassword, buildTable, lookup, crack, formatDuration, WORDLIST } from '../src/lib/crypto/hashing.ts';

// The widget's numbers are only honest if its hashes are the real ones. Check
// against node:crypto (OpenSSL), an independent implementation.
test('SHA-256 and PBKDF2 match node:crypto', async () => {
  assert.equal(await sha256('bamboo'), createHash('sha256').update('bamboo').digest('hex'));
  assert.equal(await pbkdf2('bamboo', 'a1b2c3', 1000), pbkdf2Sync('bamboo', 'a1b2c3', 1000, 32, 'sha256').toString('hex'));
});

test('an unsalted hash of a listed password falls to the dictionary and to the table', async () => {
  const stored = await storePassword('sunshine', { kind: 'sha256', salted: false });
  const r = await crack(stored, WORDLIST, { budgetMs: 10_000 });
  assert.equal(r.found, 'sunshine');
  assert.equal(lookup(stored, await buildTable(WORDLIST)), 'sunshine');
});

test('a salt makes the precomputed table useless, but not the dictionary', async () => {
  const stored = await storePassword('sunshine', { kind: 'sha256', salted: true });
  assert.equal(lookup(stored, await buildTable(WORDLIST)), undefined);
  assert.equal((await crack(stored, WORDLIST, { budgetMs: 10_000 })).found, 'sunshine');
});

test('two users with the same password get different salted hashes', async () => {
  const a = await storePassword('panda123', { kind: 'pbkdf2', iterations: 1000 });
  const b = await storePassword('panda123', { kind: 'pbkdf2', iterations: 1000 });
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
});

test('the attack stops at its time budget instead of freezing the page', async () => {
  const stored = await storePassword('bamboo2024', { kind: 'pbkdf2', iterations: 1000 });
  let t = 0;
  // A fake clock that advances 1s per reading: the budget runs out after a few tries.
  const r = await crack(stored, WORDLIST, { budgetMs: 3000, now: () => (t += 1000) });
  assert.equal(r.gaveUp, true);
  assert.equal(r.found, undefined);
  assert.ok(r.tries < WORDLIST.length);
});

test('a password not in the list is not found, and the attack says so', async () => {
  const stored = await storePassword('correct horse battery staple', { kind: 'sha256', salted: false });
  const r = await crack(stored, WORDLIST, { budgetMs: 10_000 });
  assert.equal(r.found, undefined);
  assert.equal(r.gaveUp, false);
  assert.equal(r.tries, WORDLIST.length);
});

test('durations read like a person would say them', () => {
  assert.equal(formatDuration(0.0004), '1 ms');
  assert.equal(formatDuration(90), '1.5 minutes');
  assert.equal(formatDuration(86400 * 3), '3 days');
  assert.equal(formatDuration(31557600 * 5000), 'over 1,000 years');
});
