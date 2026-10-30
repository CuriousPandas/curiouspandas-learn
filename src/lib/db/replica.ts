// A primary, an asynchronous streaming replica, a nightly base backup and a
// continuous WAL archive - the moving parts of PostgreSQL replication and
// point-in-time recovery, reduced to the timings that decide what a user sees.
// Behaviour follows the PostgreSQL 17 docs (cited in the lessons): a standby
// replays WAL after the primary commits, so a read there can be behind;
// synchronous_commit = remote_apply makes the commit wait for that replay; and
// recovery replays archived WAL up to recovery_target_time, which by default
// stops just after the target (recovery_target_inclusive = on).

// ---- reading your own writes --------------------------------------------------

export type Route = 'replica' | 'two-replicas' | 'primary' | 'sticky' | 'wait-lsn' | 'sync';

export const ROUTES: Record<Route, string> = {
  replica: 'Every read goes to the replica',
  'two-replicas': 'Add a second replica, reads spread over both',
  primary: 'Send every read to the primary',
  sticky: 'Your own reads go to the primary for a few seconds after you write',
  'wait-lsn': 'The replica read waits until it has replayed your write',
  sync: 'Commit waits until the replica has applied it (synchronous_commit = remote_apply)',
};

export const LAG_MS = 800;
export const READ_AFTER_MS = 200;
const COMMIT_MS = 5;
const READ_MS = 2;

export type ReadOutcome = {
  route: Route; sees: 'new' | 'old'; writeMs: number; readMs: number;
  /** Whether everyone else's reads still land on replicas - the reason they exist. */
  othersOnReplicas: boolean;
};

export function readAfterWrite(route: Route): ReadOutcome {
  const replayedAt = route === 'sync' ? 0 : LAG_MS; // ms after the write is acknowledged
  const fresh = READ_AFTER_MS >= replayedAt;
  switch (route) {
    case 'replica': case 'two-replicas':
      return { route, sees: fresh ? 'new' : 'old', writeMs: COMMIT_MS, readMs: READ_MS, othersOnReplicas: true };
    case 'primary':
      return { route, sees: 'new', writeMs: COMMIT_MS, readMs: READ_MS, othersOnReplicas: false };
    case 'sticky':
      return { route, sees: 'new', writeMs: COMMIT_MS, readMs: READ_MS, othersOnReplicas: true };
    case 'wait-lsn':
      return { route, sees: 'new', writeMs: COMMIT_MS, readMs: Math.max(0, LAG_MS - READ_AFTER_MS) + READ_MS, othersOnReplicas: true };
    case 'sync':
      return { route, sees: 'new', writeMs: COMMIT_MS + LAG_MS, readMs: READ_MS, othersOnReplicas: true };
  }
}

// ---- the dropped table ----------------------------------------------------------

// Clock times as seconds since midnight, shown as HH:MM:SS.
export const hms = (s: number) => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':');
const at = (t: string) => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + s; };

export const BACKUP_AT = at('02:00:00');
export const DROP_AT = at('14:05:00');
export const BEFORE_BACKUP = 4800;
// Today's orders, evenly spread from the backup to the last one before the DROP.
export const TODAY = 312;
const LAST = at('14:04:41');
export const orderTimes = Array.from({ length: TODAY }, (_, i) => Math.round(BACKUP_AT + 1 + (i * (LAST - BACKUP_AT - 1)) / (TODAY - 1)));
export const ALL = BEFORE_BACKUP + TODAY;

export type Method = 'promote' | 'nightly' | 'pitr';
export const METHODS: Record<Method, string> = {
  promote: 'Promote the replica to be the new primary',
  nightly: "Restore last night's base backup (02:00)",
  pitr: 'Restore the base backup, then replay the WAL archive up to a target time',
};
export const TARGETS = ['12:00:00', '14:04:30', '14:04:59', '14:05:30'];

export type Recovered = { method: Method; target?: string; tableExists: boolean; orders: number; lost: number; note: string };

export function recover(method: Method, target = '14:04:59'): Recovered {
  if (method === 'promote') {
    return { method, tableExists: false, orders: 0, lost: ALL, note: `The replica replayed DROP TABLE ${LAG_MS} ms after the primary. It is a faithful copy - of the mistake too.` };
  }
  if (method === 'nightly') {
    return { method, tableExists: true, orders: BEFORE_BACKUP, lost: TODAY, note: `Everything since 02:00 is gone: ${TODAY} of today's orders.` };
  }
  const t = at(target);
  if (t >= DROP_AT) return { method, target, tableExists: false, orders: 0, lost: ALL, note: `Replay went past ${hms(DROP_AT)}, so it replayed the DROP as well.` };
  const kept = orderTimes.filter((o) => o <= t).length;
  return { method, target, tableExists: true, orders: BEFORE_BACKUP + kept, lost: TODAY - kept, note: kept === TODAY ? `Replay stopped at ${target}, one second before the DROP. Every order is back.` : `Replay stopped at ${target}: the ${TODAY - kept} order${TODAY - kept === 1 ? '' : 's'} placed after that are missing.` };
}
