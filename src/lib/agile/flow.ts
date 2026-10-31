// The Flow Lab: a small team's board, one day per step. Work arrives, the team
// starts items, four people work on them, and they finish. Simulated: invented
// item sizes and arrival rates, a seeded random number generator so a test and
// a learner see the same days.
//
// Cycle time is never computed from Little's Law. It comes out of the capacity
// model: four workers, one unit of work each per day, at most two on any item.
// That is what lets the documented trap appear by itself - cut WIP until people
// sit idle and throughput falls (Vacanti, "Little's Law for Professional Scrum
// with Kanban", 2018).
//
// Little's finite-window version (Little 2011, "Little's Law as Viewed on Its
// 50th Anniversary", LL.2) defines W as the area under the WIP curve divided by
// the items present, so L = λW is true by construction and checking it alone
// proves nothing. The check here is ours, not Little's: the same item-days are
// counted by two separate paths - the board's WIP on each day, and each item's
// own start and finish days - so it fails if the records lose an item.

export type Item = { id: number; size: number; remaining: number; points: number; arrived: number; start?: number; finish?: number };
export type WipLimit = number | null; // null: start everything that arrives
export type Load = 'steady' | 'overload';

export const WORKERS = 4;
export const MAX_PER_ITEM = 2; // a pair, at most
export const SPRINT = 10; // days
export const WINDOW = 20; // days the panels measure over
export const SLE = { percentile: 85, days: 10 }; // "85% of items finish in 10 days or less"
// Work arriving per day, in units. Capacity is WORKERS units a day.
export const ARRIVALS: Record<Load, number> = { steady: 3.6, overload: 6 };
// Item sizes in units of work. Slicing smaller keeps the work arriving the
// same and splits it into more, smaller items.
const SIZES = { normal: [1, 2, 3, 5, 8], sliced: [1, 1, 2, 2, 3] };
const FIB = [1, 2, 3, 5, 8, 13, 21, 34, 55];
// Constructed: no study measures how fast story points inflate under a velocity
// target, so this rate is invented and the lesson says so.
export const INFLATION_PER_SPRINT = 1.15;

export type Sprint = { n: number; velocity: number; throughput: number; target: boolean };
export type LittleCheck = {
  window: [number, number]; days: number;
  area: number; residence: number; present: number; holds: boolean;
  L: number; lambda: number; W: number;
  // The everyday version: finished items only, throughput instead of arrivals.
  practitioner: { finished: number; throughput: number; cycle: number; predictedWip: number; gap: number };
} | { window: [number, number]; days: number; notMeasured: true };

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fib = (x: number) => FIB.find((f) => f >= x) ?? FIB[FIB.length - 1];

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}

export class FlowBoard {
  day = 0;
  wipLimit: WipLimit = null;
  load: Load = 'steady';
  sliced = false;
  velocityTarget = false;
  items: Item[] = [];
  // Path 1 for Little's Law: the board's WIP count on each day, recorded as it
  // happens. Path 2 is the items' own start and finish days.
  wipByDay: number[] = [];
  sprints: Sprint[] = [];
  inflation = 1;
  answer: string | null = null; // the forecast lesson asks which number to trust
  checks: LittleCheck[] = [];
  history: { day: number; wipLimit: WipLimit; load: Load; sliced: boolean; velocityTarget: boolean }[] = [];
  private rand = rng(42);
  private owed = 0; // fractional work carried to the next day's arrivals
  private nextId = 1;

  get backlog() { return this.items.filter((i) => i.start === undefined); }
  get inProgress() { return this.items.filter((i) => i.start !== undefined && i.finish === undefined); }

  private arrive() {
    this.owed += ARRIVALS[this.load];
    const sizes = this.sliced ? SIZES.sliced : SIZES.normal;
    while (this.owed >= 1) {
      const size = sizes[Math.floor(this.rand() * sizes.length)];
      this.owed -= size;
      this.items.push({ id: this.nextId++, size, remaining: size, points: 0, arrived: this.day });
    }
  }

  step() {
    const d = this.day;
    this.history.push({ day: d, wipLimit: this.wipLimit, load: this.load, sliced: this.sliced, velocityTarget: this.velocityTarget });
    this.arrive();
    // Pull: oldest first, up to the limit. With no limit, everything that has
    // arrived is "started" today - the queue moves onto the board, not away.
    for (const it of this.backlog) {
      if (this.wipLimit !== null && this.inProgress.length >= this.wipLimit) break;
      it.start = d;
      // A rough size-to-points estimate. Under a velocity target the same work
      // is estimated a little bigger every sprint.
      it.points = fib(it.size * this.inflation);
    }
    const active = this.inProgress;
    this.wipByDay[d] = active.length;
    // Work: each worker takes the oldest unfinished item with room for one more.
    const load = new Map<number, number>();
    for (let w = 0; w < WORKERS; w++) {
      const it = active.find((i) => i.remaining > (load.get(i.id) ?? 0) && (load.get(i.id) ?? 0) < MAX_PER_ITEM);
      if (!it) break; // nothing workable: this person is idle today
      load.set(it.id, (load.get(it.id) ?? 0) + 1);
    }
    for (const it of active) {
      it.remaining -= load.get(it.id) ?? 0;
      if (it.remaining <= 0) it.finish = d + 1;
    }
    this.day++;
    if (this.day % SPRINT === 0) this.closeSprint();
  }

  private closeSprint() {
    const from = this.day - SPRINT;
    const done = this.items.filter((i) => i.finish !== undefined && i.finish > from && i.finish <= this.day);
    this.sprints.push({ n: this.sprints.length + 1, velocity: done.reduce((s, i) => s + i.points, 0), throughput: done.length, target: this.velocityTarget });
    if (this.velocityTarget) this.inflation *= INFLATION_PER_SPRINT;
  }

  run(days: number) { for (let i = 0; i < days; i++) this.step(); }

  /** The measurement window: the last WINDOW days, or every day so far if fewer. */
  window(): [number, number] { return [Math.max(0, this.day - WINDOW), this.day]; }

  finishedIn([a, b]: [number, number]) { return this.items.filter((i) => i.finish !== undefined && i.finish > a && i.finish <= b); }
  cycleTimes(w = this.window()) { return this.finishedIn(w).map((i) => i.finish! - i.start!); }
  throughput(w = this.window()) { return this.finishedIn(w).length; }
  ages() { return this.inProgress.map((i) => this.day - i.start!); }

  /** Little's LL.2 over [a, b), from two independently kept records. */
  little(items: Item[] = this.items, w = this.window()): LittleCheck {
    const [a, b] = w;
    const days = b - a;
    let area = 0;
    for (let d = a; d < b; d++) area += this.wipByDay[d] ?? 0;
    let residence = 0, present = 0;
    for (const it of items) {
      if (it.start === undefined) continue;
      const end = it.finish ?? b;
      const inside = Math.min(end, b) - Math.max(it.start, a);
      if (inside > 0) { residence += inside; present++; }
    }
    // Checked-and-clear must never look like never-looked.
    if (days === 0 || present === 0) return { window: w, days, notMeasured: true };
    const L = area / days, lambda = present / days, W = residence / present;
    const finished = items.filter((i) => i.finish !== undefined && i.finish > a && i.finish <= b);
    const cycle = finished.length ? finished.reduce((s, i) => s + i.finish! - i.start!, 0) / finished.length : 0;
    const tp = finished.length / days;
    return {
      window: w, days, area, residence, present, holds: area === residence, L, lambda, W,
      practitioner: { finished: finished.length, throughput: tp, cycle, predictedWip: tp * cycle, gap: L === 0 ? 0 : Math.abs(L - tp * cycle) / L },
    };
  }

  checkLittle() { const c = this.little(); this.checks.push(c); return c; }
}
