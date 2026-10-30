// Missions for the Databases track, in the shape of src/lib/missions.ts. The SQL
// missions check the rows the learner got back, not the words they typed, so any
// correct query counts - and the tempting wrong ones fail on their own results:
// an inner JOIN loses Pip, COUNT(*) gives Ravi one panda, a missing ORDER BY
// comes back in the wrong order, and an index on email leaves lower(email) a scan.

import type { Mission } from '../missions.ts';
import { answers, type Cell, type StmtResult } from './engine.ts';
import { sell, type Sale, type Strategy } from './txn.ts';
import { readAfterWrite, recover, type Method, type ReadOutcome, type Recovered, type Route } from './replica.ts';

export type SqlRun = { sql: string; result?: StmtResult; error?: string };
export type SqlState = { runs: SqlRun[] };

const any = (s: SqlState, ok: (r: StmtResult, sql: string) => boolean) => s.runs.some((r) => r.result && ok(r.result, r.sql));

// The answers, from the zoo dataset. tests/db.test.ts recomputes each one with a
// reference query on the real engine, so these cannot drift from the data.
export const ZOO_ANSWERS: Record<'old' | 'keeperOf' | 'bamboo' | 'perKeeper', Cell[][]> = {
  old: [['Yun', 18], ['Fu', 15], ['Bao', 12], ['Jing', 11]],
  keeperOf: [['Bao', 'Mei'], ['Lin', 'Mei'], ['Fu', 'Tomas'], ['Xiao', 'Aiko'], ['Jing', 'Tomas'], ['Tian', 'Aiko'], ['Yun', 'Mei'], ['Pip', null]],
  bamboo: [['Bao', 23.5], ['Lin', 12.5], ['Fu', 27.5], ['Xiao', 9], ['Jing', 24.5], ['Tian', 6.5], ['Yun', 29.5]],
  perKeeper: [['Mei', 3], ['Tomas', 2], ['Aiko', 2], ['Ravi', 0]],
};

export const ZOO_MISSION: Mission<SqlState> = {
  id: 'db-zoo', title: "The keeper's questions", xp: 60,
  setup: () => ({ runs: [] }),
  steps: [
    { text: 'Look at every panda: all columns, all rows', hint: 'SELECT * FROM pandas;', done: (s) => any(s, (r, sql) => /\bfrom\s+pandas\b/i.test(sql) && r.total === 8) },
    { text: 'Which pandas are older than 10? Oldest first', hint: 'SELECT name, age FROM pandas WHERE age > 10 ORDER BY age DESC;', done: (s) => any(s, (r) => answers(r.rows, ZOO_ANSWERS.old, true)) },
    { text: "List every panda with its keeper's name - including Pip, who has no keeper yet", hint: 'A plain JOIN drops rows with no match. LEFT JOIN keepers k ON k.id = p.keeper_id keeps them', done: (s) => any(s, (r) => answers(r.rows, ZOO_ANSWERS.keeperOf)) },
    { text: 'How many kg of bamboo has each panda eaten?', hint: "SELECT p.name, SUM(f.kg) FROM pandas p JOIN feedings f ON f.panda_id = p.id WHERE f.food = 'bamboo' GROUP BY p.name;", done: (s) => any(s, (r) => answers(r.rows, ZOO_ANSWERS.bamboo)) },
    { text: 'How many pandas does each keeper look after - including Ravi, who has none?', hint: 'LEFT JOIN, then count something that is NULL when there is no panda: COUNT(p.id), not COUNT(*)', done: (s) => any(s, (r) => answers(r.rows, ZOO_ANSWERS.perKeeper)) },
  ],
  debrief: 'Two of those answers had a version that looked right and was not. A plain JOIN quietly dropped Pip, because a row with no match has nothing to join to. And COUNT(*) gave Ravi a panda he does not have: a LEFT JOIN keeps him as one row of NULLs, COUNT(*) counts that row, and COUNT(p.id) skips the NULL. Both mistakes return a tidy table with no error.',
};

export const LOGIN_EMAIL = 'Panda4242@Example.com';

const usesIndex = (r: StmtResult, table: string) => !!r.plan?.some((l) => new RegExp(`SEARCH ${table} USING (COVERING )?INDEX`).test(l));

export const INDEX_MISSION: Mission<SqlState> = {
  id: 'db-index', title: 'Make it jump, not walk', xp: 60,
  setup: () => ({ runs: [] }),
  steps: [
    { text: "Find customer 4242's orders and read the plan: how many rows did SQLite read?", hint: 'SELECT * FROM orders WHERE customer_id = 4242;', done: (s) => any(s, (r, sql) => /customer_id/i.test(sql) && r.total === 10 && r.scanned?.table === 'orders') },
    { text: 'Add an index so the same query jumps straight to those 10 rows (the plan says SEARCH, not SCAN)', hint: 'CREATE INDEX idx_orders_customer ON orders(customer_id);  then run the query again', done: (s) => any(s, (r, sql) => /customer_id/i.test(sql) && r.total === 10 && usesIndex(r, 'orders')) },
    { text: `Log-in finds people with lower(email) = lower('${LOGIN_EMAIL}'), and reads all 20,000 customers. Make it use an index - and still find customer 4242`, hint: 'An index on email does not help a query on lower(email). Index the expression itself: CREATE INDEX idx_email_lower ON customers(lower(email));', done: (s) => any(s, (r) => r.total === 1 && !!r.rows?.[0]?.some((v) => v === 4242 || v === 'panda4242@example.com') && usesIndex(r, 'customers')) },
  ],
  debrief: 'Without an index, finding 10 orders meant reading all 200,000. With one, SQLite walked a sorted tree straight to them - and that difference grows with the table. The log-in query shows the catch: an index on email stores email, not lower(email), so the moment a query wraps the column in a function, the index cannot be used. Index the expression, or store the email already normalised.',
};

// ---- transactions -------------------------------------------------------------------

export type TxnState = { sales: Sale[] };

export const TXN_MISSION: Mission<TxnState> = {
  id: 'db-lost-update', title: 'Two sales, one tee', xp: 60,
  setup: () => ({ sales: [] }),
  steps: [
    { text: 'Both clerks sell a tee at the same moment. Run it and read the final stock', hint: 'Pick "Read the stock, then write the new number", then Run both clerks', done: (s) => s.sales.some((x) => x.strategy === 'none') },
    { text: 'Wrap each clerk in BEGIN ... COMMIT. Does a transaction fix it?', hint: 'Pick the BEGIN ... COMMIT strategy and run it. Watch what clerk B does after A commits', done: (s) => s.sales.some((x) => x.strategy === 'txn') },
    { text: 'Make both sales count: the stock must end at 8, with both clerks told they sold one', hint: 'Lock the row while reading, or let the database do the subtraction', done: (s) => s.sales.some((x) => x.final === 8 && x.sold === 2 && x.lost === 0 && x.strategy !== 'repeatable') },
    { text: "Try REPEATABLE READ: one sale is refused instead of lost. Then make the app retry it", hint: 'Run REPEATABLE READ without retry, read the error, then tick "retry on serialization failure"', done: (s) => s.sales.some((x) => x.strategy === 'repeatable' && x.refused === 1) && s.sales.some((x) => x.strategy === 'repeatable' && x.retry && x.final === 8) },
  ],
  debrief: 'BEGIN and COMMIT alone changed nothing: at PostgreSQL\'s default READ COMMITTED level, clerk B waited for A\'s lock and then wrote the 9 it had already worked out. The fixes all stop B from acting on a stale read - by making B wait before reading (FOR UPDATE), by never reading at all (stock = stock - 1), or by refusing B\'s write so the app can retry (REPEATABLE READ). Every one of these was checked against a real PostgreSQL 17.6.',
};

export const doSale = (s: TxnState, strategy: Strategy, retry: boolean) => { const r = sell(strategy, retry); s.sales.push(r); return r; };

// ---- replication --------------------------------------------------------------------

export type ReplicaState = { reads: ReadOutcome[]; recoveries: Recovered[] };

export const REPLICA_MISSION: Mission<ReplicaState> = {
  id: 'db-replica', title: 'Copies are not backups', xp: 60,
  setup: () => ({ reads: [], recoveries: [] }),
  steps: [
    { text: 'Change your display name, then reload the page with every read on the replica. Which name do you see?', hint: 'Reads: "Every read goes to the replica", then Save and reload', done: (s) => s.reads.some((r) => r.route === 'replica' && r.sees === 'old') },
    { text: 'Make sure you always see your own change - while everyone else\'s reads stay on replicas', hint: 'More replicas does not help, and sending every read to the primary throws the replicas away', done: (s) => s.reads.some((r) => r.sees === 'new' && r.othersOnReplicas && r.route !== 'replica' && r.route !== 'two-replicas') },
    { text: 'At 14:05 someone runs DROP TABLE orders. Promote the replica - how many orders does it have?', hint: 'Recovery: "Promote the replica", then Recover', done: (s) => s.recoveries.some((r) => r.method === 'promote') },
    { text: 'Get every order back', hint: 'Last night\'s backup misses today. Replay the WAL archive up to a moment before 14:05:00 - and after the last order', done: (s) => s.recoveries.some((r) => r.tableExists && r.lost === 0) },
  ],
  debrief: 'A replica is a live copy: it copies your writes a moment late, which is why you saw your old name, and it copies your mistakes a moment late too, which is why promoting it brought back an empty table. Only the backup plus the archived WAL could rewind to a moment before the DROP. Point-in-time recovery needs both, and needs the target time right.',
};

export const doRead = (s: ReplicaState, route: Route) => { const r = readAfterWrite(route); s.reads.push(r); return r; };
export const doRecover = (s: ReplicaState, method: Method, target?: string) => { const r = recover(method, target); s.recoveries.push(r); return r; };

export const DB_MISSIONS = { 'db-zoo': ZOO_MISSION, 'db-index': INDEX_MISSION } as const;
