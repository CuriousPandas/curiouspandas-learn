// Missions for the Changing Running Software track, in the shape of
// src/lib/missions.ts. Each checks what the learner's runs actually measured,
// and the tempting shortcut leaves the step open: a run with no comparisons
// never counts as "no differences", and a route configured as new but still
// served by legacy has not moved.

import type { Mission } from '../missions.ts';
import { ShadowBench } from './shadow.ts';
import { Strangler, ENDPOINTS } from './strangler.ts';

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
