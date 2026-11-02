// The latency lesson's numbers and its budget lab. Each row carries where it came from, when,
// and what kind of number it is, because the honest answer to "how long does X take?" is always
// "on what, and when?". Nothing here is rounded by this site except where `kind` says so.
//
// Date-sensitive by nature: a row is a claim about its date, not about today.

import type { Mission } from '../missions.ts';

export type Kind = 'round' | 'datasheet' | 'measured' | 'arithmetic';
export const KIND_LABEL: Record<Kind, string> = {
  round: 'round figure from a talk or essay',
  datasheet: 'vendor\'s data sheet',
  measured: 'measured',
  arithmetic: 'worked out here',
};

export type LatencyRow = { id: string; label: string; ns: number; kind: Kind; source: string; url: string; date: string; holds: string };

const NORVIG = 'https://norvig.com/21-days.html';
const DEAN = 'https://www.cs.cornell.edu/projects/ladis2009/talks/dean-keynote-ladis2009.pdf';
const AZURE = 'https://learn.microsoft.com/en-us/azure/networking/azure-network-latency';
const AZURE_DATE = '30 days to 2026-07-30';
const AZURE_HOLDS = 'Median round trip across Azure\'s own network, in that direction. Your route will differ.';

export const LATENCIES: LatencyRow[] = [
  { id: 'l1', label: 'Read from the L1 cache', ns: 0.5, kind: 'round', source: 'Norvig; Dean', url: DEAN, date: '2009 or earlier', holds: 'A rough "typical PC" of its time.' },
  { id: 'mispredict', label: 'Wrong branch guess', ns: 5, kind: 'round', source: 'Norvig; Dean', url: DEAN, date: '2009 or earlier', holds: 'Depends on the pipeline\'s length and the clock.' },
  { id: 'l2', label: 'Read from the L2 cache', ns: 7, kind: 'round', source: 'Norvig; Dean', url: DEAN, date: '2009 or earlier', holds: 'A rough "typical PC" of its time.' },
  { id: 'mem', label: 'Read from main memory', ns: 100, kind: 'round', source: 'Norvig; Dean', url: DEAN, date: '2009 or earlier', holds: 'A rough "typical PC" of its time.' },
  { id: 'walk', label: 'One scattered step through 64 MB', ns: 112, kind: 'measured', source: 'This site: Node 24, Xeon E5-2695 v3, the median of nine runs from 100 to 130 ns', url: '/learn/computer/caches/', date: '2026-11-01', holds: 'That kind of machine, and it moved with the load on it. It includes whatever address translation cost, which wasn\'t measured separately.' },
  { id: 'ssd', label: 'Random 4 KB read from a fast SSD', ns: 80_000, kind: 'datasheet', source: 'Micron 7450 specification, typical (median), queue depth 1, read second-hand through a search index', url: 'https://www.micron.com/products/storage/ssd/data-center-ssd/7450-ssd', date: 'read 2026-11-01', holds: 'One data-centre drive with nothing else queued. A busy drive is slower.' },
  { id: 'dc', label: 'Round trip inside a data centre', ns: 500_000, kind: 'round', source: 'Dean', url: DEAN, date: '2009', holds: 'Google\'s data centres as of that talk. Newer networks can be much faster.' },
  { id: 'spin', label: 'Half a turn of a 7,200 RPM disk', ns: 4_160_000, kind: 'datasheet', source: 'Seagate Exos X18 data sheet, "Average Latency (ms)", 4.16', url: 'https://www.seagate.com/www-content/datasheets/pdfs/exos-x18-channel-DS2045-1-2007GB-en_GB.pdf', date: 'July 2020', holds: 'Set by physics: half of 60/7,200 of a second. Moving the head costs extra.' },
  { id: 'region', label: 'East US to East US 2, there and back', ns: 8_000_000, kind: 'measured', source: 'Azure network round-trip statistics', url: AZURE, date: AZURE_DATE, holds: AZURE_HOLDS },
  { id: 'seek', label: 'Disk seek', ns: 10_000_000, kind: 'round', source: 'Dean. Norvig says 8 ms for the same thing', url: DEAN, date: '2009', holds: 'Spinning disks of the time. An SSD has no head to move.' },
  { id: 'coast', label: 'East US to West US, there and back', ns: 69_000_000, kind: 'measured', source: 'Azure network round-trip statistics', url: AZURE, date: AZURE_DATE, holds: AZURE_HOLDS },
  { id: 'atlantic', label: 'East US to West Europe, there and back', ns: 83_000_000, kind: 'measured', source: 'Azure network round-trip statistics', url: AZURE, date: AZURE_DATE, holds: AZURE_HOLDS },
  { id: 'asia', label: 'East US to Southeast Asia, there and back', ns: 224_000_000, kind: 'measured', source: 'Azure network round-trip statistics', url: AZURE, date: AZURE_DATE, holds: AZURE_HOLDS },
];

export const rowById = (id: string) => LATENCIES.find((r) => r.id === id)!;
export { NORVIG };

/** Light in a vacuum goes exactly this far in a second, by the definition of the metre. */
export const LIGHT_M_PER_S = 299_792_458;
/** How far light can get and back in this many nanoseconds, in metres. No signal does better. */
export const lightRoundTripMetres = (ns: number) => (LIGHT_M_PER_S * (ns / 1e9)) / 2;

/** A duration in the unit a person would pick. */
export function humanTime(ns: number): string {
  const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(2).replace(/\.?0+$/, ''));
  if (ns < 1000) return `${fmt(ns)} ns`;
  if (ns < 1e6) return `${fmt(ns / 1000)} µs`;
  if (ns < 1e9) return `${fmt(ns / 1e6)} ms`;
  return `${fmt(ns / 1e9)} s`;
}

/** What a stretch of real time feels like if `unit` nanoseconds were one second. */
export function scaled(ns: number, unit: number): string {
  const s = ns / unit;
  const fmt = (v: number) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v >= 10 ? (Math.round(v * 10) / 10).toString() : (Math.round(v * 100) / 100).toString());
  const plural = (v: number, name: string) => `${fmt(v)} ${name}${fmt(v) === '1' ? '' : 's'}`;
  if (s < 90) return plural(s, 'second');
  if (s < 5400) return plural(s / 60, 'minute');
  if (s < 129600) return plural(s / 3600, 'hour');
  if (s < 86400 * 365 * 2) return plural(s / 86400, 'day');
  return plural(s / (86400 * 365.25), 'year');
}

// ---- the budget ------------------------------------------------------------------

export const BUDGET_MS = 300; // Invented for the lab, as a limit someone might set for one page.
export const PLAN_WRITES = 40;
export type Place = 'dc' | 'region' | 'coast';
export const PLACES: { id: Place; label: string; rtMs: number }[] = [
  { id: 'dc', label: 'same data centre (0.5 ms, Dean 2009)', rtMs: 0.5 },
  { id: 'region', label: 'nearby region (8 ms, Azure 2026)', rtMs: 8 },
  { id: 'coast', label: 'across the country (69 ms, Azure 2026)', rtMs: 69 },
];

export type Plan = { writes: number; place: Place; batch: number };
export type PlanCost = { roundTrips: number; ms: number; fits: boolean };

/** One round trip per batch, one after another. No queues, retries, locks or disks: the lab says it can't see them. */
export function planCost(p: Plan): PlanCost {
  if (!Number.isInteger(p.writes) || p.writes < 0) throw new Error(`a page can't do ${p.writes} writes`);
  if (!Number.isInteger(p.batch) || p.batch < 1) throw new Error(`a batch has to hold at least one write, not ${p.batch}`);
  const place = PLACES.find((x) => x.id === p.place);
  if (!place) throw new Error(`no place called ${p.place}`);
  const roundTrips = Math.ceil(p.writes / p.batch);
  const ms = roundTrips * place.rtMs;
  return { roundTrips, ms, fits: ms <= BUDGET_MS };
}

export type BudgetState = { tried: (Plan & PlanCost)[] };

export const LATENCY_MISSION: Mission<BudgetState> = {
  id: 'latency-budget', title: 'Move the database, keep the page', xp: 60,
  setup: () => ({ tried: [] }),
  steps: [
    { text: `One page does ${PLAN_WRITES} writes, one at a time, to a database in the same data centre. Check that it fits the ${BUDGET_MS} ms budget`, hint: `Set ${PLAN_WRITES} writes, one at a time, same data centre`, done: (s) => s.tried.some((t) => t.writes === PLAN_WRITES && t.batch === 1 && t.place === 'dc' && t.fits) },
    { text: 'A failover moves the database across the country. Nothing else changes. Now what?', hint: 'Change only the place', done: (s) => s.tried.some((t) => t.writes === PLAN_WRITES && t.batch === 1 && t.place === 'coast' && !t.fits) },
    { text: `Get back under budget with the database still across the country, and still doing all ${PLAN_WRITES} writes`, hint: 'You can\'t make the country smaller, and you can\'t skip the writes. How many writes can go in one round trip?', done: (s) => s.tried.some((t) => t.writes === PLAN_WRITES && t.place === 'coast' && t.fits), why: (s) => { const l = s.tried.at(-1); return l && l.place === 'coast' && l.writes !== PLAN_WRITES && l.fits ? `That fits by doing only ${l.writes} of the ${PLAN_WRITES} writes, so ${PLAN_WRITES - l.writes} never happen.` : ''; } },
  ],
  debrief: 'Code that was fine at half a millisecond per trip took 2.76 seconds at 69 ms, and nothing in it had changed. Only the distance had. No code can talk faster than the distance allows, so the fix had to send fewer round trips: that\'s a change to how the program talks, and it usually needs doing before the emergency. "Under budget" here only means these sums come out under 300. This lab can\'t see queues, retries, locks, or what a batch does when one write in it fails, and all of those are real.',
};
