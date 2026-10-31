import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShadowBench, verdict, envoyYaml, DEFAULT_CONFIG } from '../src/lib/change/shadow.ts';
import { Strangler, ENDPOINTS, MONTH, MIN_COMPARED } from '../src/lib/change/strangler.ts';
import { SHADOW_MISSION, STRANGLER_MISSION, LOCK_MISSION, DECOMMISSION_MISSION, migratedLab } from '../src/lib/change/missions.ts';
import { simulate, rewrites, type Settings as LockSettings } from '../src/lib/change/locks.ts';

// ---- shadow bench -------------------------------------------------------------

test('mirroring with no comparator compares nothing, and says "not checked" rather than "0 differences"', () => {
  const b = new ShadowBench();
  b.set({ mirror: true });
  const r = b.run();
  assert.ok(r.search.mirrored > 0);
  assert.equal(r.search.compared, 0);
  assert.equal(r.search.differed, 0);
  assert.equal(verdict(r.search), 'not checked', 'zero differences from zero comparisons must not read as a pass');
  assert.equal(r.search.notCompared['no comparator'], r.search.mirrored);
});

test('a header-named mirror target mirrors nothing when clients never send the header - silently', () => {
  const b = new ShadowBench();
  b.set({ mirror: true, comparator: true, target: 'header' });
  const r = b.run();
  assert.equal(r.search.mirrored, 0);
  assert.equal(r.search.notCompared['not mirrored'], r.search.requests);
  assert.match(envoyYaml(b.config), /cluster_header: x-shadow-cluster/);
});

test('leaving out the mirror fraction mirrors everything, and a shadow sized for 10% times out', () => {
  const b = new ShadowBench();
  b.set({ mirror: true, comparator: true, fraction: 'absent' });
  const r = b.run();
  assert.equal(r.search.mirrored, r.search.requests);
  assert.ok(r.shadowLoad > 1);
  assert.ok((r.search.notCompared['shadow timed out'] ?? 0) > 0);
  assert.doesNotMatch(envoyYaml(b.config), /runtime_fraction/);
});

test('a sample that selects nobody compares nothing', () => {
  const b = new ShadowBench();
  b.set({ mirror: true, comparator: true, sample: 'beta' });
  const r = b.run();
  assert.ok(r.search.mirrored > 0);
  assert.equal(r.search.compared, 0);
  assert.equal(verdict(r.search), 'not checked');
});

test('a sound shadow compares 1 in 10 searches and finds the 1-in-50 bug at its real rate', () => {
  const b = new ShadowBench();
  b.set({ mirror: true, comparator: true });
  const r = b.run();
  assert.equal(r.search.compared, 250);
  assert.equal(r.search.differed, 5, 'the bug rate must not line up with the mirror sample');
  assert.equal(verdict(r.search), 'differences');
  assert.ok(r.example);
});

test('mirrored writes charge the customer again; skipped writes are never compared; stubbed ones are', () => {
  const on = { ...DEFAULT_CONFIG, mirror: true, comparator: true };
  const mirror = Object.assign(new ShadowBench(), { config: { ...on, writes: 'mirror' as const } }).run();
  assert.ok(mirror.doubleCharges > 0);
  const skip = Object.assign(new ShadowBench(), { config: { ...on, writes: 'skip' as const } }).run();
  assert.equal(skip.checkout.compared, 0);
  assert.equal(verdict(skip.checkout), 'not checked');
  const stub = Object.assign(new ShadowBench(), { config: { ...on, writes: 'stub' as const } }).run();
  assert.ok(stub.checkout.compared > 0);
  assert.equal(stub.doubleCharges, 0);
});

test('shadow mission: completes from its hints, and is not born done', () => {
  const s = SHADOW_MISSION.setup();
  assert.ok(!SHADOW_MISSION.steps.some((st) => st.done(s)));
  const b = s.bench;
  const plays: Partial<typeof b.config>[] = [
    { mirror: true },
    { comparator: true, target: 'header' },
    { target: 'cluster', fraction: 'absent' },
    { fraction: 10, sample: 'beta' },
    { sample: 'all' },
    { writes: 'stub' },
  ];
  plays.forEach((p, i) => {
    b.set(p);
    b.run();
    assert.ok(SHADOW_MISSION.steps[i].done(s), `step ${i + 1} "${SHADOW_MISSION.steps[i].text}" not done after its hint`);
  });
});

// ---- strangler lab ------------------------------------------------------------

test('the planted cart rule never matches: configured shadow, served by legacy, nothing compared', () => {
  const l = new Strangler();
  l.setMode('cart', 'shadow');
  l.runDays(1);
  assert.equal(l.stats.cart.compared, 0);
  assert.equal(l.stats.cart.notCompared['no rule matched'], 150);
  l.setMode('cart', 'new');
  l.runDays(1);
  assert.equal(l.servedByNew('cart'), false, 'configured new is not served by new');
  assert.equal(l.stats.cart.today.legacy, 150);
  l.setMatch('cart', '/cart');
  l.runDays(1);
  assert.equal(l.servedByNew('cart'), true);
});

test('unscrubbed noise makes every product request differ; "ignore numbers" hides the real price bug', () => {
  const l = new Strangler();
  l.setMode('product', 'shadow');
  l.runDays(1);
  assert.equal(l.stats.product.differed, 350);
  const broad = new Strangler();
  broad.setMode('product', 'shadow');
  broad.normaliser = 'numbers';
  broad.runDays(3);
  assert.equal(broad.seen.has('price'), false);
  assert.equal(broad.stats.product.differed, 0, 'an over-broad normaliser reads as a perfect match');
  broad.setMode('product', 'new');
  broad.runDays(1);
  assert.ok(broad.harm.wrongAnswers > 0, 'and the bug it hid reaches customers');
  l.normaliser = 'scrub';
  l.runDays(1);
  assert.ok(l.seen.has('price'));
  assert.ok(l.stats.product.differed < 350 + 350);
});

test('a difference where legacy is wrong: accepting it is right, "fixing" new copies the bug', () => {
  const l = new Strangler();
  l.setMode('search', 'shadow');
  l.runDays(1);
  assert.ok(l.seen.has('dupes'));
  l.setVerdict('dupes', 'fix-new');
  l.setMode('search', 'new');
  l.runDays(1);
  assert.ok(l.harm.wrongAnswers > 0, 'new now reproduces legacy\'s duplicates for real users');
  assert.ok(l.openDiffs().includes('dupes'));
});

test('the rare large-order bug needs volume: one day of shadow misses it, 500 comparisons do not', () => {
  const l = new Strangler();
  l.setMode('orders', 'shadow');
  l.runDays(1);
  assert.equal(l.seen.has('bigorder'), false);
  l.runDays(4);
  assert.ok(l.stats.orders.compared >= MIN_COMPARED.orders);
  assert.ok(l.seen.has('bigorder'));
});

test('dual writes diverge with no error and no harm on the day; only a reconciliation shows it', () => {
  const l = new Strangler();
  l.setSync('dual');
  l.runDays(5);
  assert.equal(l.harm.failedRequests + l.harm.wrongAnswers + l.harm.lostItems, 0);
  assert.ok(l.divergedRows > 0);
  assert.ok(l.reconcile().diverged > 0);
  l.setSync('cdc');
  assert.equal(l.reconcile().diverged, 0);
});

test('with no sync, shadowing the cart shows the new store is empty', () => {
  const l = new Strangler();
  l.setMatch('cart', '/cart');
  l.setMode('cart', 'shadow');
  l.runDays(1);
  assert.equal(l.stats.cart.differed, 150);
  assert.ok(l.seen.has('missing'));
});

test('the export appears only in legacy\'s log, and only after a month end', () => {
  const l = new Strangler();
  l.runDays(MONTH - 1);
  assert.equal(l.legacyLog.has('/export'), false);
  l.runDays(1);
  assert.equal(l.legacyLog.get('/export')?.unmatched, true);
});

test('switching legacy off before the export moves: quiet for weeks, then the month-end export fails and the watch window resets', () => {
  const l = new Strangler();
  l.setMatch('cart', '/cart');
  l.setSync('cdc');
  for (const r of l.rules) l.setMode(r.id, 'new');
  l.runDays(5);
  l.switchLegacy(false);
  l.runDays(MONTH - 6);
  assert.equal(l.harm.failedRequests, 0);
  assert.equal(l.watchDays, MONTH - 6, 'looks clean right up to the month end');
  l.runDays(1);
  assert.equal(l.day % MONTH, 0);
  assert.equal(l.harm.failedRequests, 1, 'only the unlisted export fails');
  assert.equal(l.watchDays, 0, 'and the watch window starts again');
});

test('deleting legacy with no archive is recorded and blocks the finish', () => {
  const l = new Strangler();
  l.switchLegacy(false);
  l.deleteLegacy();
  assert.equal(l.deletedUnarchived, true);
  assert.equal(l.finished(), false);
});

/** The mission played from its hints, the long way a careful learner would. */
function playStrangler() {
  const s = STRANGLER_MISSION.setup();
  const l = s.lab;
  const steps = STRANGLER_MISSION.steps;
  const check = (i: number) => assert.ok(steps[i].done(s), `step ${i + 1} "${steps[i].text}" not done after its hint`);

  l.setMode('product', 'shadow'); l.runDays(1); check(0);
  l.normaliser = 'scrub'; l.runDays(1); check(1);
  l.setVerdict('price', 'fix-new');
  l.setMode('search', 'shadow'); l.runDays(1);
  l.setVerdict('dupes', 'legacy-wrong'); check(2);
  l.setMatch('cart', '/cart'); l.setMode('cart', 'shadow'); l.runDays(1); check(3);
  l.setSync('cdc');
  l.writes = 'stub';
  for (const id of ['add', 'checkout', 'orders']) l.setMode(id, 'shadow');
  l.runDays(10);
  assert.ok(l.seen.has('bigorder'), '10 days of shadow must surface the rare bug');
  l.setVerdict('bigorder', 'fix-new');
  assert.equal(l.openDiffs().length, 0, `open: ${l.openDiffs().join(', ')}`);
  for (const id of ['cart', 'add']) l.setMode(id, 'new');
  l.runDays(1); l.reconcile(); check(4);
  for (const id of ['product', 'search', 'checkout', 'orders']) l.setMode(id, 'new');
  l.runDays(1); check(5);
  // The hidden caller: find it after a month end, shadow it through the next, then move it.
  l.runToMonthEnd();
  assert.ok(l.legacyLog.get('/export')?.unmatched);
  l.addRule('export'); l.setMode('export', 'shadow');
  l.runToMonthEnd();
  l.setMode('export', 'new');
  l.switchLegacy(false);
  l.runDays(MONTH);
  assert.ok(l.watchDays >= MONTH);
  l.archive(); l.deleteLegacy();
  l.runDays(1);
  check(6);
  return s;
}

test('strangler mission: completes from its hints, and is not born done', () => {
  assert.ok(!STRANGLER_MISSION.steps.some((st) => st.done(STRANGLER_MISSION.setup())));
  const s = playStrangler();
  assert.ok(ENDPOINTS.every((e) => s.lab.servedByNew(e.id)));
  assert.equal(s.lab.harm.failedRequests, 0, 'the careful path never needed a failure to find the export');
});

test('strangler: the same careful path with the planted typo left in never finishes', () => {
  const l = new Strangler();
  l.setMode('cart', 'new');
  l.runDays(3);
  assert.equal(l.servedByNew('cart'), false);
  assert.equal(l.stats.cart.compared, 0);
});

// ---- lock queue ---------------------------------------------------------------

const lockRun = (s: Partial<LockSettings>) => simulate({ ddl: 'add-column', version: 11, lockTimeout: null, reportRunning: true, ...s });

test('a 300 ms ALTER queued behind a long transaction stalls every SELECT behind it (GoCardless)', () => {
  const o = lockRun({});
  assert.equal(o.ddl.result, 'applied');
  assert.equal(o.ddl.held, 300, 'the ALTER itself is quick');
  assert.ok(o.ddl.waited >= 9000, 'it waited for the report to finish');
  assert.ok(o.app.failed > 0, 'and the app queries queued behind it gave up');
});

test('without the waiting ALTER, the same long transaction blocks nobody', () => {
  // ACCESS SHARE conflicts only with ACCESS EXCLUSIVE: the report alone is harmless.
  const o = simulate({ ddl: 'add-column', version: 11, lockTimeout: 0, reportRunning: true });
  assert.equal(o.ddl.result, 'aborted', 'a zero timeout aborts at once');
  assert.equal(o.app.worstWait, 0);
});

test('lock_timeout makes the migration fail instead of the site', () => {
  const o = lockRun({ lockTimeout: 2000 });
  assert.equal(o.ddl.result, 'aborted');
  assert.equal(o.app.failed, 0);
  assert.ok(o.app.worstWait <= 2000);
});

test('lock_timeout cannot help a table rewrite: the lock is granted, then held', () => {
  const o = lockRun({ ddl: 'add-column-volatile-default', reportRunning: false, lockTimeout: 2000 });
  assert.equal(o.ddl.waited, 0);
  assert.ok(o.ddl.held >= 10_000);
  assert.ok(o.app.failed > 0);
});

test('a constant default rewrites on PostgreSQL 10 and not on 11; a volatile one rewrites on both', () => {
  assert.equal(rewrites('add-column-constant-default', 10), true);
  assert.equal(rewrites('add-column-constant-default', 11), false);
  assert.equal(rewrites('add-column-volatile-default', 11), true);
  assert.equal(rewrites('add-column', 10), false);
});

test('lock mission: completes from its hints, and is not born done', () => {
  const s = LOCK_MISSION.setup();
  assert.ok(!LOCK_MISSION.steps.some((st) => st.done(s)));
  const l = s.lab;
  const plays: Partial<LockSettings>[] = [
    {},
    { lockTimeout: 2000 },
    { reportRunning: false },
    { ddl: 'add-column-volatile-default' },
    { ddl: 'add-column-constant-default', version: 10 },
  ];
  plays.forEach((p, i) => { l.set(p); l.run(); if (i === 4) { l.set({ version: 11 }); l.run(); } assert.ok(LOCK_MISSION.steps[i].done(s), `step ${i + 1} not done after its hint`); });
});

// ---- decommissioning ------------------------------------------------------------

test('the decommission lab starts finished as far as the team knows, with no harm done and the export unlisted', () => {
  const l = migratedLab();
  for (const e of ENDPOINTS.filter((x) => !x.monthly)) assert.ok(l.servedByNew(e.id), `${e.id} is on new`);
  assert.ok(l.harmless());
  assert.equal(l.rule('export'), undefined);
  assert.ok(l.day % MONTH !== 0 && l.day < MONTH, 'no month end yet, so the export has not run');
});

test('decommission mission: completes the careful way, and the brownout way also works', () => {
  const careful = DECOMMISSION_MISSION.setup();
  assert.ok(!DECOMMISSION_MISSION.steps.some((st) => st.done(careful)));
  const l = careful.lab;
  l.runToMonthEnd();
  assert.ok(l.legacyLog.get('/export')?.unmatched);
  l.addRule('export'); assert.ok(DECOMMISSION_MISSION.steps[0].done(careful));
  l.setMode('export', 'shadow'); l.runToMonthEnd(); l.setMode('export', 'new');
  l.runToMonthEnd();
  assert.ok(DECOMMISSION_MISSION.steps[1].done(careful));
  l.switchLegacy(false); l.runDays(MONTH); l.archive(); l.deleteLegacy(); l.runDays(1);
  assert.ok(DECOMMISSION_MISSION.steps.every((st) => st.done(careful)));

  // A planned brownout finds the same caller by breaking it, reversibly.
  const brown = DECOMMISSION_MISSION.setup().lab;
  brown.switchLegacy(false); brown.runToMonthEnd();
  assert.equal(brown.harm.failedRequests, 1, 'only the unlisted export fails');
  brown.switchLegacy(true); brown.addRule('export');
  brown.setMode('export', 'shadow'); brown.runToMonthEnd(); brown.setMode('export', 'new'); brown.runToMonthEnd();
  brown.switchLegacy(false); brown.runDays(MONTH); brown.archive(); brown.deleteLegacy(); brown.runDays(1);
  assert.ok(brown.finished(), 'a failed request found by a brownout does not block finishing');
});

test('deleting legacy before a full clean month leaves the export broken for good', () => {
  const l = migratedLab();
  l.switchLegacy(false); l.runDays(5); l.archive(); l.deleteLegacy();
  l.runToMonthEnd();
  assert.ok(l.harm.failedRequests > 0);
  assert.equal(l.servedByNew('export'), false);
  assert.equal(l.finished(), false);
  assert.ok(l.deletedAfterWatch < MONTH);
});
