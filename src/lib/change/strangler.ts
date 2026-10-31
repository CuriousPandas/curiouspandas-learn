// The Strangler Lab: a shop's legacy app behind a façade, and a new system
// taking its routes one at a time until the legacy app can be switched off.
// Simulated: invented traffic, a day per click, simplified data sync. Each trap
// is either documented in a primary source (named beside it) or marked
// "constructed" - a plausible failure with no published incident behind it.
//
// Two rules hold everywhere:
// - "differed" is never shown without "compared", so a route nobody checked
//   reads as "not checked", never as "0 differences".
// - "served by" is measured per request, not read from the configured mode,
//   so a façade rule that never matches shows as configured new, served legacy.

export type Mode = 'legacy' | 'shadow' | 'new';
export type Normaliser = 'none' | 'scrub' | 'numbers';
export type WritePolicy = 'skip' | 'mirror' | 'stub';
export type Sync = 'none' | 'dual' | 'cdc';
export type Verdict = 'fix-new' | 'legacy-wrong';
export type Side = 'legacy' | 'new';

export type Endpoint = { id: string; method: 'GET' | 'POST'; path: (n: number) => string; label: string; write?: boolean; perDay: number; monthly?: boolean };

export const ENDPOINTS: Endpoint[] = [
  { id: 'product', method: 'GET', path: (n) => `/product/${(n % 90) + 1}`, label: 'GET /product/:id', perDay: 350 },
  { id: 'search', method: 'GET', path: () => '/search', label: 'GET /search', perDay: 250 },
  { id: 'cart', method: 'GET', path: () => '/cart', label: 'GET /cart', perDay: 150 },
  { id: 'add', method: 'POST', path: () => '/cart/items', label: 'POST /cart/items', write: true, perDay: 100 },
  { id: 'checkout', method: 'POST', path: () => '/checkout', label: 'POST /checkout', write: true, perDay: 50 },
  { id: 'orders', method: 'GET', path: () => '/orders', label: 'GET /orders', perDay: 100 },
  // Nobody on the team knows about this one. Finance's batch job calls it once
  // a month, so it has no façade rule and only shows up in legacy's access log.
  { id: 'export', method: 'GET', path: () => '/export', label: 'GET /export', perDay: 0, monthly: true },
];
export const endpoint = (id: string) => ENDPOINTS.find((e) => e.id === id)!;

export const MONTH = 30;
export const MIN_COMPARED: Record<string, number> = { product: 500, search: 500, cart: 500, add: 500, checkout: 500, orders: 500, export: 1 };

// Difference classes. kind 'bug' needs a verdict, 'noise' needs scrubbing, and
// 'data' goes away only when the stores are kept in step.
export type DiffClass = { id: string; endpoint: string; kind: 'bug' | 'noise' | 'data'; wrongSide?: Side; title: string; legacy: string; candidate: string; source: string };
export const DIFFS: Record<string, DiffClass> = {
  noise: { id: 'noise', endpoint: 'product', kind: 'noise', title: 'generatedAt and requestId differ', legacy: '{"id":42,"price":12.00,"generatedAt":"09:14:03.118","requestId":"a91f"}', candidate: '{"id":42,"price":12.00,"generatedAt":"09:14:03.162","requestId":"c07d"}', source: 'Shopify: time and randomness make byte-equal responses impossible' },
  price: { id: 'price', endpoint: 'product', kind: 'bug', wrongSide: 'new', title: 'sale price differs', legacy: '{"id":17,"price":8.00,"sale":true}', candidate: '{"id":17,"price":6.40,"sale":true}', source: 'constructed: the discount is applied twice in the new code' },
  dupes: { id: 'dupes', endpoint: 'search', kind: 'bug', wrongSide: 'legacy', title: 'legacy lists one product twice', legacy: '{"results":["mat","mat","whisk"]}', candidate: '{"results":["mat","whisk"]}', source: 'GitHub: the comparison found two bugs in the old code, not the new' },
  bigorder: { id: 'bigorder', endpoint: 'orders', kind: 'bug', wrongSide: 'new', title: 'large orders cut off at 50 lines', legacy: '{"order":881,"lines":64}', candidate: '{"order":881,"lines":50}', source: 'SRE Workbook ch. 16: do not stop after a handful of queries' },
  missing: { id: 'missing', endpoint: 'cart', kind: 'data', title: "new store doesn't have this cart", legacy: '{"cart":5120,"items":3}', candidate: '{"cart":5120,"items":0}', source: 'Azure: the façade must keep data consistent across both systems' },
  drift: { id: 'drift', endpoint: 'cart', kind: 'data', title: 'stores disagree on a cart', legacy: '{"cart":7311,"items":2}', candidate: '{"cart":7311,"items":1}', source: 'Kleppmann: dual writes diverge with no errors logged' },
};

// Every Nth request of an endpoint hits the case. Counters, not random numbers,
// so a test and a learner see the same thing on the same day.
const EVERY = { sale: 25, dupes: 16, bigorder: 500, drift: 40 } as const;

export type Rule = { id: string; method: 'GET' | 'POST'; match: string; mode: Mode };
export type Stats = { total: number; served: Record<Side, number>; compared: number; matched: number; differed: number; explained: number; notCompared: Record<string, number>; today: Record<Side, number> };
export type Harm = { wrongAnswers: number; doubleCharges: number; lostItems: number; failedRequests: number };
export type Reconcile = { day: number; rows: number; diverged: number };
export type Event = { day: number; text: string; kind: 'info' | 'warn' | 'bad' | 'ok' };

const stats = (): Stats => ({ total: 0, served: { legacy: 0, new: 0 }, compared: 0, matched: 0, differed: 0, explained: 0, notCompared: {}, today: { legacy: 0, new: 0 } });

export class Strangler {
  day = 0;
  rules: Rule[] = [
    { id: 'product', method: 'GET', match: '/product/', mode: 'legacy' },
    { id: 'search', method: 'GET', match: '/search', mode: 'legacy' },
    // Planted: a teammate's rule with a trailing slash. "/cart" does not start
    // with "/cart/", so this rule never matches and the catch-all sends every
    // cart request to legacy whatever mode it says. Constructed: no published
    // incident documents it, but it is the configured-but-inert shape exactly.
    { id: 'cart', method: 'GET', match: '/cart/', mode: 'legacy' },
    { id: 'add', method: 'POST', match: '/cart/items', mode: 'legacy' },
    { id: 'checkout', method: 'POST', match: '/checkout', mode: 'legacy' },
    { id: 'orders', method: 'GET', match: '/orders', mode: 'legacy' },
  ];
  normaliser: Normaliser = 'none';
  writes: WritePolicy = 'skip';
  sync: Sync = 'none';
  verdicts: Partial<Record<string, Verdict>> = {};
  stats: Record<string, Stats> = Object.fromEntries(ENDPOINTS.map((e) => [e.id, stats()]));
  seen = new Map<string, { firstDay: number; lastDay: number; count: number }>();
  harm: Harm = { wrongAnswers: 0, doubleCharges: 0, lostItems: 0, failedRequests: 0 };
  // Legacy's own access log: every path it answered, rule or no rule.
  legacyLog = new Map<string, { count: number; lastDay: number; unmatched: boolean }>();
  legacyOn = true;
  offSince: number | null = null; // first day of the current clean watch window
  archived = false;
  deleted = false;
  deletedUnarchived = false;
  divergedRows = 0;
  reconciles: Reconcile[] = [];
  movedToNew = new Map<string, number>(); // endpoint -> day its rule was last set to new
  events: Event[] = [];
  private n: Record<string, number> = Object.fromEntries(ENDPOINTS.map((e) => [e.id, 0]));
  private writesSeen = 0;
  private lastServed: Record<string, Side | undefined> = {};
  deletedAfterWatch = 0; // clean watch-window days when legacy was deleted
  copiedLegacyBug = false;

  rule(id: string) { return this.rules.find((r) => r.id === id); }

  setMode(id: string, mode: Mode) {
    const r = this.rule(id);
    if (!r) return;
    r.mode = mode;
    if (mode === 'new') this.movedToNew.set(id, this.day + 1);
  }
  setMatch(id: string, match: string) { const r = this.rule(id); if (r) r.match = match.trim(); }

  /** Adds a façade rule for an endpoint found in legacy's access log. */
  addRule(id: string) {
    const e = endpoint(id);
    if (this.rule(id)) return;
    this.rules.push({ id, method: e.method, match: e.path(0), mode: 'legacy' });
    this.log('info', `Added a façade rule for ${e.label}.`);
  }

  setVerdict(id: string, v: Verdict) {
    this.verdicts[id] = v;
    // "Fixing" the new code to agree with legacy's duplicate results copies the bug.
    this.copiedLegacyBug = this.verdicts.dupes === 'fix-new';
  }

  setSync(s: Sync) {
    if (s === this.sync) return;
    this.sync = s;
    // Change data capture starts with a snapshot, then streams every change
    // from whichever side took the write. Simplified: real CDC is one-way per
    // stream and has lag; this one is both ways and instant.
    if (s === 'cdc') { this.divergedRows = 0; this.log('ok', 'CDC: snapshot copied, changes now stream between the stores.'); }
  }

  reconcile(): Reconcile {
    const r = { day: this.day, rows: 10000 + this.writesSeen, diverged: this.sync === 'none' ? 10000 + this.writesSeen : this.divergedRows };
    this.reconciles.push(r);
    return r;
  }

  switchLegacy(on: boolean) {
    if (this.deleted) return;
    this.legacyOn = on;
    this.offSince = on ? null : this.day + 1;
    this.log(on ? 'warn' : 'info', on ? 'Legacy switched back on.' : 'Legacy switched off. Watching for anything that still calls it.');
  }

  archive() { if (!this.deleted) { this.archived = true; this.log('ok', 'Legacy database archived (soft delete: restorable).'); } }

  deleteLegacy() {
    if (this.deleted || this.legacyOn) return;
    this.deleted = true;
    this.deletedUnarchived = !this.archived;
    this.deletedAfterWatch = this.watchDays;
    this.log(this.archived ? 'info' : 'bad', this.archived ? 'Legacy deleted. The archive is the only way back now.' : 'Legacy deleted with no archive. Its data is gone for good.');
  }

  /** Days the legacy app has been off with nothing reaching it. */
  get watchDays() { return this.offSince === null ? 0 : Math.max(0, this.day - this.offSince + 1); }

  private match(method: string, path: string): Rule | undefined {
    return this.rules.find((r) => r.method === method && r.match !== '' && path.startsWith(r.match));
  }

  private log(kind: Event['kind'], text: string) { this.events.push({ day: this.day, text, kind }); if (this.events.length > 60) this.events.shift(); }

  /** Which differences this request shows, before normalising and verdicts. */
  private raw(e: Endpoint, k: number): string[] {
    const out: string[] = [];
    if (e.id === 'product') {
      out.push('noise');
      if (k % EVERY.sale === 7 && this.verdicts.price !== 'fix-new') out.push('price');
    }
    if (e.id === 'search' && k % EVERY.dupes === 3 && !this.copiedLegacyBug) out.push('dupes');
    if (e.id === 'orders' && k % EVERY.bigorder === 250 && this.verdicts.bigorder !== 'fix-new') out.push('bigorder');
    if (e.id === 'cart') {
      if (this.sync === 'none') out.push('missing');
      else if (this.sync === 'dual' && this.divergedRows > 0 && k % EVERY.drift === 5) out.push('drift');
    }
    return out;
  }

  /** Is the new system's answer wrong for the user? Noise is not wrong, and
   * neither is disagreeing with a legacy bug - unless new was made to copy it. */
  private newIsWrong(e: Endpoint, k: number, classes: string[]) {
    if (e.id === 'search' && this.copiedLegacyBug && k % EVERY.dupes === 3) return true;
    return classes.some((c) => DIFFS[c].kind !== 'noise' && DIFFS[c].wrongSide !== 'legacy');
  }

  private serve(e: Endpoint) {
    const k = this.n[e.id]++;
    const st = this.stats[e.id];
    const path = e.path(k);
    const rule = this.match(e.method, path);
    const mode: Mode = rule?.mode ?? 'legacy';
    st.total++;
    const side: Side = mode === 'new' ? 'new' : 'legacy';
    const nc = (r: string) => { st.notCompared[r] = (st.notCompared[r] ?? 0) + 1; };

    if (side === 'legacy') {
      const l = this.legacyLog.get(path.replace(/\/\d+$/, '/:id')) ?? { count: 0, lastDay: 0, unmatched: !rule };
      l.count++; l.lastDay = this.day; l.unmatched = !rule;
      this.legacyLog.set(path.replace(/\/\d+$/, '/:id'), l);
      if (!this.legacyOn) {
        this.harm.failedRequests++;
        if (this.offSince !== null) this.offSince = this.day + 1;
        this.log('bad', `${e.label} reached legacy while it was off: request failed. Watch window reset.`);
        nc('legacy was off');
        st.today.legacy++; this.lastServed[e.id] = 'legacy';
        return;
      }
    }
    st.served[side]++; st.today[side]++; this.lastServed[e.id] = side;

    // Writes and the data they leave behind.
    if (e.write) {
      this.writesSeen++;
      if (e.id === 'add' && this.sync === 'dual' && this.writesSeen % EVERY.drift === 13) this.divergedRows++;
    }
    // A cart read from one store, written to the other, with nothing copying between them.
    if (e.id === 'cart' && this.sync === 'none') {
      const addSide: Side = (this.rule('add')?.mode === 'new') ? 'new' : 'legacy';
      if (addSide !== side && k % 10 === 0) this.harm.lostItems++;
    }

    const classes = this.raw(e, k);
    if (side === 'new') {
      if (this.newIsWrong(e, k, classes)) this.harm.wrongAnswers++;
      nc('served by new');
      return;
    }
    if (!rule) { nc('no rule matched'); return; }
    if (mode !== 'shadow') { nc('not shadowed'); return; }
    if (e.write && this.writes === 'skip') { nc('write skipped'); return; }
    if (e.id === 'checkout' && this.writes === 'mirror') this.harm.doubleCharges++;

    st.compared++;
    const shown = classes.filter((c) => {
      if (c === 'noise') return this.normaliser === 'none';
      if (c === 'price') return this.normaliser !== 'numbers'; // an over-broad normaliser hides a real bug
      return true;
    });
    for (const c of shown) {
      const s = this.seen.get(c) ?? { firstDay: this.day, lastDay: this.day, count: 0 };
      s.lastDay = this.day; s.count++;
      this.seen.set(c, s);
    }
    const unexplained = shown.filter((c) => !(DIFFS[c].kind === 'bug' && this.verdicts[c] === 'legacy-wrong'));
    if (unexplained.length) st.differed++;
    else if (shown.length) st.explained++;
    else st.matched++;
  }

  runDays(days: number) {
    for (let d = 0; d < days; d++) {
      this.day++;
      for (const st of Object.values(this.stats)) st.today = { legacy: 0, new: 0 };
      for (const e of ENDPOINTS) {
        const count = e.monthly ? (this.day % MONTH === 0 ? 1 : 0) : e.perDay;
        for (let i = 0; i < count; i++) this.serve(e);
      }
      if (this.day % MONTH === 0) this.log('info', `Month end (day ${this.day}): finance's export ran.`);
    }
  }

  runToMonthEnd() { this.runDays(MONTH - (this.day % MONTH)); }

  // ---- what the learner has achieved ------------------------------------------

  /** Served by new on its latest traffic - measured per request, not read from the
   * configured mode. The monthly export is judged by its last call. */
  servedByNew(id: string) {
    const st = this.stats[id];
    if (endpoint(id).monthly) return this.lastServed[id] === 'new';
    return st.today.new > 0 && st.today.legacy === 0;
  }

  /** Every difference class either fixed, accepted correctly, scrubbed, or gone. */
  openDiffs(): string[] {
    return [...this.seen.keys()].filter((c) => {
      const d = DIFFS[c];
      if (d.kind === 'noise') return this.normaliser !== 'scrub';
      if (d.kind === 'data') return this.sync !== 'cdc';
      return this.verdicts[c] !== (d.wrongSide === 'new' ? 'fix-new' : 'legacy-wrong');
    });
  }

  enoughCompared(id: string) { return this.stats[id].compared >= MIN_COMPARED[id]; }
  // Failed requests are left out on purpose: switching legacy off is how you
  // find the caller nobody listed (Google's "planned outages"), and switching it
  // back on recovers. Wrong answers, double charges and lost items reached
  // customers and cannot be taken back.
  harmless() { const h = this.harm; return h.wrongAnswers === 0 && h.doubleCharges === 0 && h.lostItems === 0; }

  /** The whole migration: the win condition the lab's last step checks. */
  finished() {
    return ENDPOINTS.every((e) => this.servedByNew(e.id) && this.enoughCompared(e.id))
      && this.openDiffs().length === 0 && this.reconciled() && this.harmless()
      && this.deleted && !this.deletedUnarchived && this.deletedAfterWatch >= MONTH;
  }

  reconciled() {
    const last = this.reconciles.at(-1);
    const moved = Math.max(this.movedToNew.get('add') ?? Infinity, this.movedToNew.get('cart') ?? Infinity);
    return !!last && last.diverged === 0 && last.rows > 0 && moved !== Infinity && last.day >= moved;
  }
}
