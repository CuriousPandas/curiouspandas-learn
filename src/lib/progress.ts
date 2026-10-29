// Progress lives in the learner's browser and nowhere else: no account, no
// server, nothing to breach and nothing to bill. Two rules follow from that.
//
//  - A store that will not parse is never overwritten. Starting empty and
//    saving over it would silently delete someone's weeks of streak; instead
//    the raw text is kept, a banner says so, and only an explicit reset or
//    import replaces it.
//  - "Not saving" and "saved" never look the same. In a private window or with
//    storage blocked, the header says progress is not being kept.

export const KEY = 'curiouspandas.progress.v1';

export type Progress = {
  v: 1;
  xp: number;
  lessons: Record<string, string>;
  quizzes: Record<string, string>;
  missions: Record<string, string>;
  real: Record<string, string>;
  days: string[];
};

export type StoreState = 'ok' | 'unavailable' | 'corrupt';

export const empty = (): Progress => ({ v: 1, xp: 0, lessons: {}, quizzes: {}, missions: {}, real: {}, days: [] });

export const RANKS = [
  { xp: 0, name: 'Curious Cub' },
  { xp: 150, name: 'Bamboo Hacker' },
  { xp: 450, name: 'Forest Engineer' },
  { xp: 1000, name: 'Peak Panda' },
  { xp: 2000, name: 'Legendary Panda' },
];

export function rank(xp: number) {
  let i = 0;
  while (i + 1 < RANKS.length && xp >= RANKS[i + 1].xp) i++;
  const next = RANKS[i + 1];
  return { ...RANKS[i], level: i + 1, next, toNext: next ? next.xp - xp : 0, pct: next ? (xp - RANKS[i].xp) / (next.xp - RANKS[i].xp) : 1 };
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Consecutive days with activity, ending today or yesterday (a streak survives until a full day is missed). */
export function streak(days: string[], today = new Date()) {
  const set = new Set(days);
  const d = new Date(today);
  if (!set.has(day(d))) d.setDate(d.getDate() - 1);
  let n = 0;
  while (set.has(day(d))) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function valid(x: unknown): x is Progress {
  const p = x as Progress;
  return !!p && p.v === 1 && typeof p.xp === 'number' && Number.isFinite(p.xp) &&
    ['lessons', 'quizzes', 'missions', 'real'].every((k) => typeof (p as any)[k] === 'object' && (p as any)[k] !== null) &&
    Array.isArray(p.days);
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export class Store {
  state: StoreState = 'ok';
  raw: string | null = null;
  data: Progress = empty();
  private storage: StorageLike | null;
  private listeners = new Set<(p: Progress) => void>();

  constructor(storage?: StorageLike | null) {
    this.storage = storage === undefined ? Store.browserStorage() : storage;
    this.load();
  }

  static browserStorage(): StorageLike | null {
    try {
      const s = window.localStorage;
      const probe = '__cp_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch { return null; }
  }

  load() {
    if (!this.storage) { this.state = 'unavailable'; return; }
    let raw: string | null;
    try { raw = this.storage.getItem(KEY); } catch { this.state = 'unavailable'; return; }
    if (raw === null) { this.state = 'ok'; this.data = empty(); return; }
    try {
      const parsed = JSON.parse(raw);
      if (!valid(parsed)) throw new Error('shape');
      this.data = parsed;
      this.state = 'ok';
    } catch {
      this.state = 'corrupt';
      this.raw = raw;
      this.data = empty();
    }
  }

  private save() {
    // Refusing to save is the point when corrupt: see the header comment.
    if (this.state !== 'ok' || !this.storage) return;
    try { this.storage.setItem(KEY, JSON.stringify(this.data)); } catch { this.state = 'unavailable'; }
  }

  private touch() {
    const today = day(new Date());
    if (!this.data.days.includes(today)) this.data.days = [...this.data.days, today].slice(-400);
  }

  /** Award once per id. Returns the XP actually added (0 if already earned). */
  award(kind: 'lessons' | 'quizzes' | 'missions' | 'real', id: string, xp: number): number {
    if (this.data[kind][id]) return 0;
    this.data[kind][id] = new Date().toISOString();
    this.data.xp += xp;
    this.touch();
    this.save();
    this.emit();
    return xp;
  }

  has(kind: 'lessons' | 'quizzes' | 'missions' | 'real', id: string) { return !!this.data[kind][id]; }

  exportJson() { return JSON.stringify(this.data, null, 2); }

  importJson(text: string) {
    const parsed = JSON.parse(text);
    if (!valid(parsed)) throw new Error('That file is not a Curious Pandas progress export.');
    this.data = parsed;
    if (this.state === 'corrupt') this.state = 'ok';
    this.save();
    this.emit();
  }

  reset() {
    this.data = empty();
    if (this.state === 'corrupt') this.state = 'ok';
    this.raw = null;
    this.save();
    this.emit();
  }

  subscribe(fn: (p: Progress) => void) { this.listeners.add(fn); fn(this.data); return () => this.listeners.delete(fn); }
  private emit() { for (const fn of this.listeners) fn(this.data); }
}

let shared: Store | null = null;
/** One store per page, so every widget sees the same numbers. */
export function store(): Store {
  if (!shared) shared = new Store();
  return shared;
}
