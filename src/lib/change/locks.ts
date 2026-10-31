// One PostgreSQL table, its lock queue, and the traffic that uses it. Simulated
// time in 10 ms steps; the workload is invented, the locking rules are
// PostgreSQL's documented ones (explicit-locking chapter):
//
// - A plain SELECT takes ACCESS SHARE, which conflicts only with ACCESS EXCLUSIVE.
// - ALTER TABLE takes ACCESS EXCLUSIVE unless the docs say otherwise for that form.
// - A lock request waits indefinitely unless lock_timeout is set.
// - Requests are granted in order: a new request that conflicts with one already
//   waiting queues behind it. That is the trap - the ALTER is not running yet,
//   but every SELECT that arrives after it waits for it (GoCardless: "having
//   one sat in the queue blocks all other operations").
//
// Simplified: one table, one lock mode per statement, no deadlock detection,
// and the app's queries all touch the table being altered.

export type Mode = 'ACCESS SHARE' | 'ACCESS EXCLUSIVE';
export type Ddl = 'add-column' | 'add-column-volatile-default' | 'add-column-constant-default';
export type PgVersion = 10 | 11;

export const STEP = 10; // ms
export const RUN_MS = 30_000;
export const APP_EVERY = 100; // an app query arrives every 100 ms
export const APP_HOLD = 10; // and holds its lock for 10 ms
export const CLIENT_GIVES_UP = 5_000; // the app's own request timeout
export const REPORT_START = 0, REPORT_HOLD = 12_000; // a long transaction holding ACCESS SHARE
export const DDL_AT = 2_000;
// How long the ALTER holds its lock once granted. A metadata-only change is
// quick; a table rewrite takes as long as copying the table, invented here as
// 15 seconds for a large table.
const QUICK = 300, REWRITE = 15_000;

export const DDL_SQL: Record<Ddl, string> = {
  'add-column': 'ALTER TABLE accounts ADD COLUMN note text;',
  'add-column-constant-default': "ALTER TABLE accounts ADD COLUMN status text DEFAULT 'new';",
  'add-column-volatile-default': 'ALTER TABLE accounts ADD COLUMN seen_at timestamptz DEFAULT clock_timestamp();',
};

/** Does this ALTER rewrite the whole table? PostgreSQL 11 stopped rewriting for
 * a constant default; a volatile default such as clock_timestamp() still does. */
export function rewrites(ddl: Ddl, version: PgVersion) {
  if (ddl === 'add-column') return false;
  if (ddl === 'add-column-volatile-default') return true;
  return version < 11;
}

type Req = { id: number; who: 'app' | 'report' | 'ddl'; mode: Mode; at: number; hold: number; granted?: number; gaveUp?: number };
export type Settings = { ddl: Ddl; version: PgVersion; lockTimeout: number | null; reportRunning: boolean };
export type Outcome = {
  settings: Settings;
  ddl: { waited: number; held: number; result: 'applied' | 'aborted' | 'not run' };
  app: { total: number; waitedOverSecond: number; failed: number; worstWait: number };
  blockedBySecond: number[]; // app queries waiting at each whole second
};

const conflicts = (a: Mode, b: Mode) => a === 'ACCESS EXCLUSIVE' || b === 'ACCESS EXCLUSIVE';

export function simulate(settings: Settings): Outcome {
  const reqs: Req[] = [];
  let id = 0;
  if (settings.reportRunning) reqs.push({ id: id++, who: 'report', mode: 'ACCESS SHARE', at: REPORT_START, hold: REPORT_HOLD });
  const ddlHold = rewrites(settings.ddl, settings.version) ? REWRITE : QUICK;
  const ddl: Req = { id: id++, who: 'ddl', mode: 'ACCESS EXCLUSIVE', at: DDL_AT, hold: ddlHold };
  reqs.push(ddl);
  for (let t = 0; t < RUN_MS; t += APP_EVERY) reqs.push({ id: id++, who: 'app', mode: 'ACCESS SHARE', at: t, hold: APP_HOLD });
  reqs.sort((a, b) => a.at - b.at || a.id - b.id);

  const blockedBySecond = new Array(RUN_MS / 1000).fill(0);
  for (let t = 0; t < RUN_MS; t += STEP) {
    const live = (r: Req) => r.at <= t && r.gaveUp === undefined;
    const granted = reqs.filter((r) => live(r) && r.granted !== undefined && r.granted + r.hold > t);
    const waiting = reqs.filter((r) => live(r) && r.granted === undefined);
    // Give up: lock_timeout for the ALTER, the client's own timeout for the app.
    for (const r of waiting) {
      if (r.who === 'ddl' && settings.lockTimeout !== null && t - r.at >= settings.lockTimeout) r.gaveUp = t;
      if (r.who === 'app' && t - r.at >= CLIENT_GIVES_UP) r.gaveUp = t;
    }
    // Grant in order: compatible with every holder and with everything still
    // waiting ahead of it in the queue.
    const ahead: Req[] = [];
    for (const r of waiting.filter((w) => w.gaveUp === undefined)) {
      const ok = granted.every((g) => !conflicts(g.mode, r.mode)) && ahead.every((w) => !conflicts(w.mode, r.mode));
      if (ok) { r.granted = t; granted.push(r); } else ahead.push(r);
    }
    if (t % 1000 === 0) blockedBySecond[t / 1000] = ahead.filter((r) => r.who === 'app').length;
  }

  const apps = reqs.filter((r) => r.who === 'app' && r.at < RUN_MS - CLIENT_GIVES_UP);
  const wait = (r: Req) => (r.granted ?? r.gaveUp ?? RUN_MS) - r.at;
  return {
    settings,
    ddl: { waited: (ddl.granted ?? ddl.gaveUp ?? RUN_MS) - ddl.at, held: ddl.granted !== undefined ? ddl.hold : 0, result: ddl.granted !== undefined ? 'applied' : ddl.gaveUp !== undefined ? 'aborted' : 'not run' },
    app: { total: apps.length, waitedOverSecond: apps.filter((r) => wait(r) > 1000).length, failed: apps.filter((r) => r.gaveUp !== undefined).length, worstWait: Math.max(0, ...apps.map(wait)) },
    blockedBySecond,
  };
}

/** The learner's runs, for the mission to check. */
export class LockLab {
  settings: Settings = { ddl: 'add-column', version: 11, lockTimeout: null, reportRunning: true };
  runs: Outcome[] = [];
  set(s: Partial<Settings>) { this.settings = { ...this.settings, ...s }; }
  run() { const o = simulate({ ...this.settings }); this.runs.push(o); return o; }
}
