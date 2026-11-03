// What each sample image *does*, so failures come from behaviour, not from
// scripted outcomes. A real image's behaviour lives in its entrypoint; here it
// lives in this table, which is why `command:` and `args:` are refused rather
// than ignored (spec.ts).

export type Behaviour =
  | 'serve'        // runs until killed
  | 'greeter'      // logs GREETING from its environment, forever
  | 'reads-file'   // logs every file under its mounts, forever
  | 'wait-for-db'  // an init container: loops until a Ready pod labelled app=db exists in its namespace
  | 'batch';       // runs for runTicks, then exits with exitCode

export type Image = {
  startTicks: number;
  memUse: number;
  log: string[];
  needsEnv?: string;
  behaviour?: Behaviour;
  runTicks?: number;
  exitCode?: number;
  /** The user the image's Dockerfile runs as. 0 is root, as the official nginx image is. */
  user?: number;
  /** A directory the process writes to at start. A read-only root filesystem breaks it unless a volume is mounted there. */
  writes?: string;
};

export const IMAGES: Record<string, Image> = {
  'panda/hello:1.0': { startTicks: 1, memUse: 24, log: ['listening on :8080', 'GET / 200 (hello from v1)'], writes: '/tmp' },
  'panda/hello:2.0': { startTicks: 1, memUse: 26, log: ['listening on :8080', 'GET / 200 (hello from v2)'], writes: '/tmp' },
  'panda/greedy:1.0': { startTicks: 1, memUse: 200, log: ['loading bamboo index into memory...', 'allocated 120Mi', 'allocated 200Mi'] },
  'panda/slowpoke:1.0': { startTicks: 12, memUse: 40, log: ['warming caches (this takes about a minute)...'] },
  'panda/needs-config:1.0': { startTicks: 1, memUse: 30, needsEnv: 'DATABASE_URL', log: ['starting'] },
  // The same app built with `USER 1000` in its Dockerfile.
  'panda/hello-nonroot:1.0': { startTicks: 1, memUse: 24, log: ['listening on :8080', 'GET / 200 (hello from v1, uid 1000)'], user: 1000, writes: '/tmp' },
  'panda/greeter:1.0': { startTicks: 1, memUse: 20, log: ['greeter starting'], behaviour: 'greeter' },
  'panda/reads-file:1.0': { startTicks: 1, memUse: 20, log: ['watching mounted files'], behaviour: 'reads-file' },
  'panda/db:1.0': { startTicks: 2, memUse: 60, log: ['database starting', 'ready to accept connections'] },
  'panda/log-shipper:1.0': { startTicks: 1, memUse: 16, log: ['shipping /var/log/app/*.log'], behaviour: 'serve' },
  'panda/wait-for-db:1.0': { startTicks: 0, memUse: 8, log: [], behaviour: 'wait-for-db' },
  'panda/migrate:1.0': { startTicks: 0, memUse: 16, log: ['running migrations', 'migrated 3 tables'], needsEnv: 'DATABASE_URL', behaviour: 'batch', runTicks: 2, exitCode: 0 },
  'panda/report:1.0': { startTicks: 0, memUse: 30, log: ['writing nightly report', 'report written to /reports/today.csv'], behaviour: 'batch', runTicks: 3, exitCode: 0 },
  'panda/slow-report:1.0': { startTicks: 0, memUse: 30, log: ['writing nightly report (slow: about 90 seconds)', 'report written to /reports/today.csv'], behaviour: 'batch', runTicks: 18, exitCode: 0 },
  'panda/flaky-report:1.0': { startTicks: 0, memUse: 30, log: ['writing nightly report', 'error: could not reach the warehouse'], behaviour: 'batch', runTicks: 1, exitCode: 1 },
};
