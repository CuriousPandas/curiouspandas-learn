// A proxy that mirrors production traffic to a new system, and a comparator
// that may or may not be looking. Simulated: invented traffic, simplified
// timing. The behaviours are the documented ones:
//
// - Istio and Envoy call mirroring "fire and forget"; Istio discards the mirrored
//   response and NGINX ignores it. Mirroring on its own compares nothing:
//   something else has to receive both answers.
// - Envoy's cluster_header names the mirror target per request: "no shadow
//   request will happen if the value is not found in headers". The docs mention
//   no error for it, and the bench raises none.
// - With the mirror fraction left out, Envoy and Istio mirror everything.
// - Diffy skips POST, PUT and DELETE by default "for safety reasons", and
//   Scientist is "only safe for wrapping methods that aren't changing data": a
//   mirrored write runs its side effects twice.
// - A sampling gate (Scientist's run_if) that matches nobody runs nothing.
//
// The one rule this file exists for: "differed" is never reported without
// "compared" beside it, so zero differences from zero comparisons reads as
// "not checked", not as a pass.

export type Target = 'cluster' | 'header';
export type Fraction = 'absent' | 10 | 1;
export type Sample = 'all' | 'beta';
export type WritePolicy = 'skip' | 'mirror' | 'stub';
export type ShadowConfig = { mirror: boolean; target: Target; fraction: Fraction; comparator: boolean; sample: Sample; writes: WritePolicy };

export const DEFAULT_CONFIG: ShadowConfig = { mirror: false, target: 'cluster', fraction: 10, comparator: false, sample: 'all', writes: 'skip' };

// Five minutes of a small shop: 500 searches and 100 checkouts a minute.
export const PER_MINUTE = { search: 500, checkout: 100 } as const;
export const MINUTES_PER_RUN = 5;
// The new system was sized for a 10% shadow: a fifth of production, with room.
export const SHADOW_CAPACITY_PER_MINUTE = 120;
// One search in fifty hits the new system's real bug: out-of-stock items vanish.
export const BUG_EVERY = 50;
// No real user has the beta flag yet, so a beta-only sample selects nobody.
export const BETA_USERS = 0;

export type Reason = 'no comparator' | 'not mirrored' | 'shadow timed out' | 'outside sample' | 'write skipped';
export type Counts = { requests: number; mirrored: number; compared: number; matched: number; differed: number; notCompared: Partial<Record<Reason, number>> };
export type Run = {
  config: ShadowConfig;
  search: Counts;
  checkout: Counts;
  doubleCharges: number;
  shadowLoad: number; // share of shadow capacity used; above 1 means overloaded
  example?: { legacy: string; candidate: string };
};

const empty = (): Counts => ({ requests: 0, mirrored: 0, compared: 0, matched: 0, differed: 0, notCompared: {} });
const skip = (c: Counts, r: Reason, n = 1) => { c.notCompared[r] = (c.notCompared[r] ?? 0) + n; };

/** Renders the config as the Envoy route a learner would actually read. */
export function envoyYaml(c: ShadowConfig): string {
  const lines = ['route:', '  cluster: legacy'];
  if (c.mirror) {
    lines.push('  request_mirror_policies:');
    lines.push(c.target === 'cluster' ? '  - cluster: shop-v2' : '  - cluster_header: x-shadow-cluster');
    if (c.fraction !== 'absent') lines.push('    runtime_fraction:', `      default_value: { numerator: ${c.fraction}, denominator: HUNDRED }`);
  }
  return lines.join('\n');
}

export class ShadowBench {
  config: ShadowConfig = { ...DEFAULT_CONFIG };
  runs: Run[] = [];
  private searchesCompared = 0; // kept across runs, so the bug lands on the same requests every time

  set(c: Partial<ShadowConfig>) { this.config = { ...this.config, ...c }; }

  run(): Run {
    const c = { ...this.config };
    const run: Run = { config: c, search: empty(), checkout: empty(), doubleCharges: 0, shadowLoad: 0 };
    const share = c.fraction === 'absent' ? 100 : c.fraction;
    const total = (PER_MINUTE.search + PER_MINUTE.checkout) * MINUTES_PER_RUN;
    // The client never sends x-shadow-cluster, so a header-named target mirrors nothing.
    const mirroring = c.mirror && c.target === 'cluster';
    const mirroredTotal = mirroring ? Math.round(total * share / 100) : 0;
    const capacity = SHADOW_CAPACITY_PER_MINUTE * MINUTES_PER_RUN;
    run.shadowLoad = mirroredTotal / capacity;
    let served = 0; // shadow requests the new system managed to answer this run
    // A deterministic fraction, counted per endpoint. One shared counter lined
    // up with the 5:1 search/checkout pattern and mirrored checkouts at twice
    // their share - a biased sample, which is its own silent failure.
    const seen = { search: 0, checkout: 0 }, picked = { search: 0, checkout: 0 };
    for (let i = 0; i < total; i++) {
      const isSearch = i % 6 !== 5; // 5 searches to every checkout
      const cnt = isSearch ? run.search : run.checkout;
      cnt.requests++;
      const kind = isSearch ? 'search' : 'checkout';
      const mirrored = mirroring && Math.floor((++seen[kind] * share) / 100) > picked[kind];
      if (mirrored) picked[kind]++;
      if (!mirrored) { skip(cnt, 'not mirrored'); continue; }
      cnt.mirrored++;
      // The proxy fires the shadow request and forgets it - including its side effects.
      if (!isSearch && c.writes === 'mirror') run.doubleCharges++;
      if (!isSearch && c.writes === 'skip') { skip(cnt, 'write skipped'); continue; }
      // Simplified: a real overloaded service slows down for everyone; here it
      // answers up to its capacity and the rest time out.
      if (served >= capacity) { skip(cnt, 'shadow timed out'); continue; }
      served++;
      if (!c.comparator) { skip(cnt, 'no comparator'); continue; }
      if (c.sample === 'beta' && BETA_USERS === 0) { skip(cnt, 'outside sample'); continue; }
      cnt.compared++;
      // Counted over compared searches, not all requests: the mirror samples
      // every tenth request, and a bug keyed to the request count would line up
      // with the sample and show one search in five differing instead of one in fifty.
      const bug = isSearch && ++this.searchesCompared % BUG_EVERY === 0;
      if (bug) {
        cnt.differed++;
        run.example ??= { legacy: '{"q":"bamboo","results":["mat","shoot","whisk (out of stock)"]}', candidate: '{"q":"bamboo","results":["mat","shoot"]}' };
      } else cnt.matched++;
    }
    this.runs.push(run);
    return run;
  }
}

/** "0 differed" next to "0 compared" is not a pass. */
export function verdict(c: Counts): 'not checked' | 'differences' | 'matched' {
  if (c.compared === 0) return 'not checked';
  return c.differed > 0 ? 'differences' : 'matched';
}
