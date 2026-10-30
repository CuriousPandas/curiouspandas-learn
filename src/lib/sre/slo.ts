// Error budgets and the alerts that guard them, minute by minute.
//
// Numbers follow the Google SRE Workbook, "Alerting on SLOs": burn rate is how
// fast the service spends its budget relative to the SLO, and the recommended
// multiwindow, multi-burn-rate policy for a 99.9% SLO pages at 14.4x over 1 h
// (with a 5 min short window) or 6x over 6 h (30 min short window), and opens a
// ticket at 1x over 3 days (6 h short window). The simple threshold alert is
// the workbook's first, worst example: good recall, poor precision.

export const MIN_PER_DAY = 24 * 60;

/** Minutes of total outage an SLO allows over a period. 99.9% of 30 days is
 *  43,200 x 0.001 = 43.2 minutes - computed, never typed in. */
export function budgetMinutes(slo: number, days = 30): number {
  return (1 - slo) * days * MIN_PER_DAY;
}

export type Scenario = 'blip' | 'fast' | 'slow';
export type Policy = 'threshold' | 'average' | 'burn';

export const SCENARIOS: Record<Scenario, { label: string; start: number; minutes: number; errorRate: number; story: string }> = {
  // 1% errors for 10 minutes: a burn rate of 10, gone before anyone could act.
  blip: { label: 'A 10-minute blip', start: 3 * MIN_PER_DAY, minutes: 10, errorRate: 0.01, story: 'A deploy hiccup: 1% of requests fail for 10 minutes, then it heals itself.' },
  // 10% errors for 30 minutes: a burn rate of 100, about 7% of the month gone.
  fast: { label: 'A fast burn', start: 3 * MIN_PER_DAY, minutes: 30, errorRate: 0.1, story: 'A bad config: 1 request in 10 fails for half an hour until someone notices.' },
  // 0.2% errors for 2 days: a burn rate of 2. Nobody should be woken for it,
  // but left alone it would spend the whole month's budget in 15 days.
  slow: { label: 'A slow leak', start: 1 * MIN_PER_DAY, minutes: 2 * MIN_PER_DAY, errorRate: 0.002, story: 'A slow leak: 1 request in 500 fails, for two whole days.' },
};

export const POLICIES: Record<Policy, { label: string; rule: string }> = {
  threshold: { label: 'Error rate above the SLO', rule: 'page if the last 5 minutes had more than 0.1% errors' },
  average: { label: 'Average over 3 days', rule: 'page if the last 3 days had more than 0.1% errors' },
  burn: { label: 'Multiwindow burn rate', rule: 'page at 14.4x (1 h and 5 min) or 6x (6 h and 30 min); ticket at 1x (3 days and 6 h)' },
};

export type Alert = { at: number; kind: 'page' | 'ticket'; why: string };
export type RunResult = {
  scenario: Scenario; policy: Policy;
  budgetSpent: number;           // fraction of the 30-day budget the incident spent
  pages: Alert[]; tickets: Alert[];
  firstPageAfter: number | null; // minutes from incident start to the first page
  firstTicketAfter: number | null;
  remaining: number[];           // budget left (fraction) at the end of each hour
};

const SLO = 0.999;
const TIMELINE_MIN = 6 * MIN_PER_DAY;

/** Error rate in each minute of a six-day timeline. Healthy minutes still fail
 *  a little (0.01%): real services are never at zero. */
export function errorSeries(s: Scenario): Float64Array {
  const sc = SCENARIOS[s];
  const out = new Float64Array(TIMELINE_MIN).fill(0.0001);
  for (let m = sc.start; m < sc.start + sc.minutes && m < TIMELINE_MIN; m++) out[m] = sc.errorRate;
  return out;
}

export function run(scenario: Scenario, policy: Policy): RunResult {
  const err = errorSeries(scenario);
  const n = err.length;
  // Prefix sums make every window average O(1); the timeline has 8,640 minutes.
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + err[i];
  const avg = (end: number, len: number) => { const s = Math.max(0, end - len + 1); return (pre[end + 1] - pre[s]) / (end + 1 - s); };
  const burn = (end: number, len: number) => avg(end, len) / (1 - SLO);

  const pages: Alert[] = [], tickets: Alert[] = [];
  let paging = false, ticketing = false;
  for (let m = 60; m < n; m++) {
    let page = false, ticket = false, why = '';
    if (policy === 'threshold') { page = avg(m, 5) > 1 - SLO; why = '5-minute error rate above 0.1%'; }
    else if (policy === 'average') { page = avg(m, 3 * MIN_PER_DAY) > 1 - SLO; why = '3-day error rate above 0.1%'; }
    else {
      if (burn(m, 60) >= 14.4 && burn(m, 5) >= 14.4) { page = true; why = 'burning 14.4x over 1 h and still over 5 min'; }
      else if (burn(m, 360) >= 6 && burn(m, 30) >= 6) { page = true; why = 'burning 6x over 6 h and still over 30 min'; }
      else if (burn(m, 3 * MIN_PER_DAY) >= 1 && burn(m, 360) >= 1) { ticket = true; why = 'burning 1x over 3 days and still over 6 h'; }
    }
    // An alert is one notification when it starts firing, not one per minute.
    if (page && !paging) pages.push({ at: m, kind: 'page', why });
    if (ticket && !ticketing && !page) tickets.push({ at: m, kind: 'ticket', why });
    paging = page; ticketing = ticket;
  }

  // Budget spent by the incident, beyond the healthy background.
  const sc = SCENARIOS[scenario];
  const budget = (1 - SLO) * 30 * MIN_PER_DAY; // in "minutes of total failure"
  const spent = sc.minutes * (sc.errorRate - 0.0001);
  const remaining: number[] = [];
  let used = 0;
  for (let m = 0; m < n; m++) {
    used += err[m];
    if (m % 60 === 59) remaining.push(Math.max(0, 1 - used / budget));
  }
  const after = (a: Alert[]) => (a.length ? a[0].at - sc.start : null);
  return { scenario, policy, budgetSpent: spent / budget, pages, tickets, firstPageAfter: after(pages), firstTicketAfter: after(tickets), remaining };
}

/** What a good alert does with each scenario: wake someone for the fast burn
 *  quickly, leave the blip alone, and turn the slow leak into a ticket. */
export function verdict(r: RunResult): { ok: boolean; note: string } {
  if (r.scenario === 'blip') return r.pages.length ? { ok: false, note: `paged someone for a blip that spent ${(r.budgetSpent * 100).toFixed(2)}% of the budget` } : { ok: true, note: 'stayed quiet - the blip spent almost nothing' };
  if (r.scenario === 'fast') {
    if (r.firstPageAfter === null) return { ok: false, note: `never paged while ${(r.budgetSpent * 100).toFixed(1)}% of the month's budget burned` };
    if (r.firstPageAfter === 0) return { ok: true, note: 'paged within the first minute' };
    return r.firstPageAfter <= 15 ? { ok: true, note: `paged ${r.firstPageAfter} minutes in` } : { ok: false, note: `paged only after ${r.firstPageAfter} minutes` };
  }
  if (r.pages.length) return { ok: false, note: 'paged someone at night for a leak a ticket could handle' };
  return r.tickets.length ? { ok: true, note: `opened a ticket ${Math.round(r.firstTicketAfter! / 60)} hours in` } : { ok: false, note: 'never noticed a leak spending the budget twice as fast as it refills' };
}
