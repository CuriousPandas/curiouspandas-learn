// The web lessons' central claim, as data: an exit-code check and a
// status-code check both pass for broken sites, and only a body check is
// honest about every scenario. If someone "simplifies" a scenario so that
// claim stops holding, the lesson would quietly start lying.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, CHECKS, honest } from '../src/lib/web/journey.ts';

const by = (id: string) => SCENARIOS.find((s) => s.id === id)!;
const check = (id: string) => CHECKS.find((c) => c.id === id)!;

test('exit codes match what real curl returned', () => {
  // Captured 2026-10-29; see the header of src/lib/web/journey.ts.
  const want: Record<string, number> = { ok: 0, dns: 6, refused: 7, timeout: 28, reset: 56, 'tls-name': 60, 'tls-trust': 60, '401': 0, '500': 0, shell: 0 };
  for (const [id, code] of Object.entries(want)) assert.equal(by(id).exit, code, id);
  for (const s of SCENARIOS) {
    const last = s.trace[s.trace.length - 1];
    if (s.exit !== 0) assert.ok(last.startsWith(`curl: (${s.exit})`), `${s.id} trace ends with its own exit code`);
  }
});

test('both TLS failures exit 60; only the verify code tells them apart', () => {
  assert.equal(by('tls-name').exit, by('tls-trust').exit);
  assert.match(by('tls-name').verify!, /62 \(hostname mismatch\)/);
  assert.match(by('tls-trust').verify!, /20 \(unable to get local issuer certificate\)/);
});

test('only the body check is honest about every scenario', () => {
  for (const s of SCENARIOS) assert.ok(honest(check('body'), s), `body check wrong for ${s.id}`);
  assert.ok(!honest(check('exit'), by('500')), 'curl exits 0 on a 500');
  assert.ok(!honest(check('exit'), by('401')), 'curl exits 0 on a 401');
  assert.ok(!honest(check('status'), by('shell')), 'a 200 shell passes a status check');
});

test('a 401 arrived; a reset did not', () => {
  assert.equal(by('401').failedAt, 'http');
  assert.ok(by('401').status !== null, 'the application answered');
  assert.equal(by('reset').status, null, 'no HTTP answer at all');
});

test('every scenario explains itself', () => {
  for (const s of SCENARIOS) assert.ok(s.meaning.length > 40, s.id);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length);
});
