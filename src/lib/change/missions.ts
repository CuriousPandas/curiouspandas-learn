// Missions for the Changing Running Software track, in the shape of
// src/lib/missions.ts. Each checks what the learner's runs actually measured,
// and the tempting shortcut leaves the step open: a run with no comparisons
// never counts as "no differences", and a route configured as new but still
// served by legacy has not moved.

import type { Mission } from '../missions.ts';
import { ShadowBench } from './shadow.ts';
import { Strangler, ENDPOINTS } from './strangler.ts';
import { LockLab } from './locks.ts';

// ---- prove it in production -------------------------------------------------

export type ShadowState = { bench: ShadowBench };
const runs = (s: ShadowState) => s.bench.runs;

export const SHADOW_MISSION: Mission<ShadowState> = {
  id: 'shadow-compare', title: 'Make the shadow count', xp: 60,
  setup: () => ({ bench: new ShadowBench() }),
  steps: [
    { text: 'Mirror production traffic to the new system and send five minutes of it. How many answers were compared?', hint: 'Tick "mirror", then Send traffic', done: (s) => runs(s).some((r) => r.config.mirror && !r.config.comparator && r.search.mirrored > 0) },
    { text: 'Turn the comparator on, but have Envoy take the mirror target from the x-shadow-cluster header. Where did the shadow traffic go?', hint: 'Tick "comparator", target: cluster_header, then Send traffic', done: (s) => runs(s).some((r) => r.config.mirror && r.config.comparator && r.config.target === 'header') },
    { text: 'Go back to a fixed target, delete the runtime_fraction (plenty of real configs leave it out), and send traffic. What happened to the new system?', hint: 'Target: shop-v2, fraction: (absent), then Send traffic', done: (s) => runs(s).some((r) => r.config.fraction === 'absent' && (r.search.notCompared['shadow timed out'] ?? 0) > 0) },
    { text: 'Put the fraction back, compare only beta users\' requests, and send traffic', hint: 'Fraction: 10%, sample: beta users only, then Send traffic', done: (s) => runs(s).some((r) => r.config.sample === 'beta' && r.search.mirrored > 0 && r.search.compared === 0) },
    { text: 'Get at least 200 search comparisons with none timed out - and find the real difference', hint: 'Sample: everyone, fraction 10%, comparator on, then Send traffic', done: (s) => runs(s).some((r) => r.search.compared >= 200 && !r.search.notCompared['shadow timed out'] && r.search.differed > 0) },
    { text: 'Compare POST /checkout as well, without charging any customer twice', hint: 'Writes: mirror would run the payment again. Pick the option that stubs side effects, then Send traffic', done: (s) => runs(s).some((r) => r.checkout.compared > 0 && r.doubleCharges === 0) },
  ],
  debrief: 'Mirroring alone checked nothing: the proxy fires the copy and throws the answer away. Then the header target mirrored nothing, the missing fraction mirrored everything into a system sized for a tenth of it, and the beta-only sample compared nobody. Every one of those is valid config, so nothing flagged it. A comparison is only evidence when it says how many it compared. Writes are the sharp edge: a mirrored checkout charges the card again, so a write gets compared with its side effects stubbed, or not at all.',
};

// ---- strangler fig ------------------------------------------------------------

export type StranglerState = { lab: Strangler };
// Everything on the façade's rule list at the start; the export is found later.
const known = ENDPOINTS.filter((e) => !e.monthly).map((e) => e.id);

export const STRANGLER_MISSION: Mission<StranglerState> = {
  id: 'strangler-fig', title: 'Strangle it one route at a time', xp: 90,
  setup: () => ({ lab: new Strangler() }),
  steps: [
    { text: 'Shadow GET /product for a day and read the comparison panel', hint: 'Set GET /product to shadow, then Run a day', done: (s) => s.lab.stats.product.compared > 0 },
    { text: 'Scrub only the fields that are noise - and see what that uncovers', hint: 'The noise lane shows which fields also differ between two copies of legacy. Normaliser: scrub generatedAt and requestId, then run', done: (s) => s.lab.normaliser === 'scrub' && s.lab.seen.has('price') },
    { text: 'Shadow GET /search too, and decide every real difference: fix the new code, or accept that legacy was wrong', hint: 'Read each pair. A discount applied twice is the new code\'s bug; a product listed twice is legacy\'s', done: (s) => s.lab.seen.has('dupes') && s.lab.verdicts.price === 'fix-new' && s.lab.verdicts.dupes === 'legacy-wrong' },
    { text: 'Shadow GET /cart and get real comparisons from it', hint: 'Configured is not served. Compare the rule\'s match with the path it is meant to catch', done: (s) => s.lab.stats.cart.compared > 0 },
    { text: 'Move the cart and its writes to new without losing anyone\'s items, and prove both stores agree', hint: 'Keep the stores in step first (dual writes race; change data capture does not), shadow until each has 500 comparisons, move both, run a day, then Compare stores', done: (s) => s.lab.servedByNew('cart') && s.lab.servedByNew('add') && s.lab.reconciled() && s.lab.harm.lostItems === 0 },
    { text: 'Move every route you know about to new - each with at least 500 comparisons, nobody charged twice, and no wrong answer ever served', hint: 'Writes: compare them with side effects stubbed. Rare bugs need volume: keep shadowing until the counts are there', done: (s) => known.every((id) => s.lab.servedByNew(id) && s.lab.enoughCompared(id)) && s.lab.harm.wrongAnswers === 0 && s.lab.harm.doubleCharges === 0 },
    { text: 'Switch legacy off, keep it off for a whole month with nothing reaching it, archive it, then delete it', hint: 'Something calls legacy only once a month. Read legacy\'s access log after a month end', done: (s) => s.lab.finished() },
  ],
  debrief: 'Every trap in that run reported success while checking nothing. The cart rule said "shadow" and matched no request. "Ignore all numbers" turned a real price bug into a match. The search difference was legacy\'s bug - GitHub\'s merge rewrite found two in old Git the same way. Dual writes diverged without a single error. And the export nobody listed only showed up when legacy went quiet at a month end. The façade made each step reversible; the counters - compared, not compared, served by - are what made each one checkable.',
};

// ---- expand/contract: the lock queue -----------------------------------------

export type LockState = { lab: LockLab };
const lockRuns = (s: LockState) => s.lab.runs;

export const LOCK_MISSION: Mission<LockState> = {
  id: 'lock-queue', title: 'A sub-second migration, a site-wide stall', xp: 60,
  setup: () => ({ lab: new LockLab() }),
  steps: [
    { text: 'Run the 300 ms ADD COLUMN while the report\'s transaction is still open, with no lock_timeout. How long did the app wait?', hint: 'Leave the report running, lock_timeout: none, then Run migration', done: (s) => lockRuns(s).some((r) => r.settings.ddl === 'add-column' && r.settings.reportRunning && r.settings.lockTimeout === null && r.app.failed > 0) },
    { text: 'Set lock_timeout to 2 seconds and run it again. What failed this time - the site, or the migration?', hint: 'lock_timeout: 2s, then Run migration', done: (s) => lockRuns(s).some((r) => r.settings.reportRunning && r.settings.lockTimeout !== null && r.ddl.result === 'aborted' && r.app.failed === 0) },
    { text: 'The report has finished. Retry the migration', hint: 'Untick "report transaction open", then Run migration', done: (s) => lockRuns(s).some((r) => r.settings.ddl === 'add-column' && !r.settings.reportRunning && r.ddl.result === 'applied' && r.app.worstWait <= 1000) },
    { text: 'Add a column with a volatile default, clock_timestamp(), with nothing else running. Does lock_timeout save you?', hint: 'Change: ... DEFAULT clock_timestamp(), report not running, then Run migration', done: (s) => lockRuns(s).some((r) => r.settings.ddl === 'add-column-volatile-default' && !r.settings.reportRunning && r.app.failed > 0) },
    { text: 'Add a column with a constant default on PostgreSQL 10, then on 11', hint: "Change: ... DEFAULT 'new'. Run it with version 10, then version 11", done: (s) => lockRuns(s).some((r) => r.settings.ddl === 'add-column-constant-default' && r.settings.version === 10 && r.app.failed > 0) && lockRuns(s).some((r) => r.settings.ddl === 'add-column-constant-default' && r.settings.version === 11 && r.app.failed === 0) },
  ],
  debrief: 'The ALTER itself took 300 ms. It still stopped the site for ten seconds, because it waited in the lock queue behind a long transaction, and every ordinary SELECT that arrived after it waited behind it. lock_timeout made the migration fail instead of the site: "It\'s better to abort a deploy than take your application down." It could not help with the rewrite, though - that lock is granted at once and then held while the whole table is copied. Whether a default rewrites depends on the default and on the PostgreSQL version, which is why every migration plan should say which version it was checked against.',
};

// ---- decommissioning ------------------------------------------------------------

/** A migration finished the careful way, up to the point where every route the
 * team knows about is served by new. The export nobody listed is still out there. */
export function migratedLab(): Strangler {
  const l = new Strangler();
  l.setMode('product', 'shadow'); l.normaliser = 'scrub'; l.setVerdict('price', 'fix-new');
  l.setMode('search', 'shadow'); l.setMatch('cart', '/cart'); l.setMode('cart', 'shadow');
  l.setSync('cdc'); l.writes = 'stub';
  for (const id of ['add', 'checkout', 'orders']) l.setMode(id, 'shadow');
  l.runDays(10);
  l.setVerdict('dupes', 'legacy-wrong'); l.setVerdict('bigorder', 'fix-new');
  for (const id of known) l.setMode(id, 'new');
  l.runDays(2); l.reconcile();
  l.events = [];
  return l;
}

export const DECOMMISSION_MISSION: Mission<StranglerState> = {
  id: 'decommission', title: 'Switch it off without breaking anyone', xp: 70,
  setup: () => ({ lab: migratedLab() }),
  steps: [
    { text: 'Every route you know about is on new. Find what still needs legacy', hint: 'Run to month end and read legacy\'s access log - or switch legacy off as a planned brownout and see what fails', done: (s) => !!s.lab.rule('export') },
    { text: 'Move it to new, compared at least once first', hint: 'Add its façade rule, shadow it through a month end, then set it to new', done: (s) => s.lab.servedByNew('export') && s.lab.enoughCompared('export') },
    { text: 'Switch legacy off, keep it off for a whole month with nothing reaching it, archive it, then delete it', hint: 'Disable before deleting, and watch a full business cycle', done: (s) => s.lab.finished() },
  ],
  debrief: 'Every route on the team\'s list had moved, and legacy still had a caller: a monthly job nobody wrote down, invisible for 29 days out of 30. Reading legacy\'s own access log over a full cycle finds it; so does a planned brownout, which is why Google describes deprecation outages of increasing length. Switching legacy off was reversible. Deleting it was not - which is why the delete came last, after a clean month and an archive.',
};
