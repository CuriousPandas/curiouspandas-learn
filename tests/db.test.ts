import { test } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { load, run, shown, answers, fullScans, indexes, MAX_ROWS } from '../src/lib/db/engine.ts';
import { sell, START } from '../src/lib/db/txn.ts';
import { readAfterWrite, recover, ALL, TODAY, BEFORE_BACKUP, orderTimes, LAG_MS } from '../src/lib/db/replica.ts';
import { ZOO_ANSWERS, ZOO_MISSION, INDEX_MISSION, TXN_MISSION, REPLICA_MISSION, LOGIN_EMAIL, doSale, doRead, doRecover, type SqlState } from '../src/lib/db/missions.ts';

const SQL = await initSqlJs();
const zoo = () => { const db = new SQL.Database(); load(db, 'zoo'); return db; };
const shop = (() => { let db: ReturnType<typeof zoo> | undefined; return () => { if (!db) { db = new SQL.Database(); load(db, 'shop'); } return db; }; })();
const q = (db: ReturnType<typeof zoo>, sql: string) => shown(run(db, sql))!;

// ---- engine ---------------------------------------------------------------------------

test('the zoo answers are what reference queries return on the real engine', () => {
  const db = zoo();
  assert.deepEqual(q(db, 'SELECT name, age FROM pandas WHERE age > 10 ORDER BY age DESC').rows, ZOO_ANSWERS.old);
  assert.ok(answers(q(db, 'SELECT p.name, k.name FROM pandas p LEFT JOIN keepers k ON k.id = p.keeper_id').rows, ZOO_ANSWERS.keeperOf));
  assert.ok(answers(q(db, "SELECT p.name, SUM(f.kg) FROM pandas p JOIN feedings f ON f.panda_id = p.id WHERE f.food = 'bamboo' GROUP BY p.id").rows, ZOO_ANSWERS.bamboo));
  assert.ok(answers(q(db, 'SELECT k.name, COUNT(p.id) FROM keepers k LEFT JOIN pandas p ON p.keeper_id = k.id GROUP BY k.id').rows, ZOO_ANSWERS.perKeeper));
});

test('the tempting wrong queries return tidy tables that do not answer the question', () => {
  const db = zoo();
  // No ORDER BY: the right rows in table order, which is not oldest first.
  assert.equal(answers(q(db, 'SELECT name, age FROM pandas WHERE age > 10').rows, ZOO_ANSWERS.old, true), false);
  // An inner JOIN drops Pip, who has no keeper.
  assert.equal(answers(q(db, 'SELECT p.name, k.name FROM pandas p JOIN keepers k ON k.id = p.keeper_id').rows, ZOO_ANSWERS.keeperOf), false);
  // COUNT(*) counts the LEFT JOIN's row of NULLs: Ravi gets one panda.
  const star = q(db, 'SELECT k.name, COUNT(*) FROM keepers k LEFT JOIN pandas p ON p.keeper_id = k.id GROUP BY k.id');
  assert.deepEqual(star.rows!.find((r) => r[0] === 'Ravi'), ['Ravi', 1]);
  assert.equal(answers(star.rows, ZOO_ANSWERS.perKeeper), false);
});

test('answers() accepts extra columns and any row order, but not extra or missing rows', () => {
  assert.ok(answers([[3, 'Mei', 'x'], [4, 'Ravi', 'y']], [['Ravi', 4], ['Mei', 3]]));
  assert.equal(answers([['Mei', 3]], [['Mei', 3], ['Ravi', 0]]), false);
  assert.equal(answers([['Mei', 3], ['Mei', 3]], [['Mei', 3], ['Ravi', 0]]), false);
});

test('an index turns a full scan into a search, with the same answer', () => {
  const db = shop();
  const before = q(db, 'SELECT * FROM orders WHERE customer_id = 4242');
  assert.equal(before.total, 10);
  assert.deepEqual(before.plan, ['SCAN orders']);
  assert.deepEqual(before.scanned, { table: 'orders', rows: 200000 });
  run(db, 'CREATE INDEX idx_orders_customer ON orders(customer_id)');
  const after = q(db, 'SELECT * FROM orders WHERE customer_id = 4242');
  assert.equal(after.total, 10);
  assert.match(after.plan![0], /^SEARCH orders USING INDEX idx_orders_customer \(customer_id=\?\)$/);
  assert.equal(after.scanned, undefined);
  assert.deepEqual(after.rows, before.rows);
});

test('a function on the column hides it from an index on that column; an expression index does not', () => {
  const db = shop();
  const login = `SELECT * FROM customers WHERE lower(email) = lower('${LOGIN_EMAIL}')`;
  run(db, 'CREATE INDEX idx_email ON customers(email)');
  const plain = q(db, login);
  assert.equal(plain.total, 1);
  assert.equal(plain.scanned?.table, 'customers');
  run(db, 'CREATE INDEX idx_email_lower ON customers(lower(email))');
  const expr = q(db, login);
  assert.equal(expr.total, 1);
  assert.match(expr.plan![0], /^SEARCH customers USING INDEX idx_email_lower/);
  assert.ok(indexes(db).some((s) => /lower\(email\)/.test(s)));
});

test('an aliased full scan is still reported as a full scan', () => {
  // "FROM pandas p" plans as "SCAN p"; it was once reported as no table read.
  const r = q(zoo(), 'SELECT p.name, k.name FROM pandas p LEFT JOIN keepers k ON k.id = p.keeper_id');
  assert.equal(r.plan![0], 'SCAN p');
  assert.deepEqual(r.scanned, { table: 'pandas', rows: 8 });
  const as = q(zoo(), 'SELECT * FROM pandas AS x WHERE x.age > 3');
  assert.deepEqual(as.scanned, { table: 'pandas', rows: 8 });
});

test('every SCAN line is a full read; SEARCH is not', () => {
  assert.deepEqual(fullScans(['SCAN orders', '  SEARCH c USING INTEGER PRIMARY KEY (rowid=?)', 'SCAN orders USING COVERING INDEX i']), ['orders', 'orders']);
});

test('results are capped for the page but the full count is kept; errors are reported, not thrown', () => {
  const r = q(shop(), 'SELECT id FROM orders');
  assert.equal(r.total, 200000);
  assert.equal(r.rows!.length, MAX_ROWS);
  const bad = run(zoo(), 'SELECT * FROM nope');
  assert.match(bad.error!, /no such table: nope/);
});

test('several statements run in order, and DDL reports what it changed', () => {
  const r = run(zoo(), "INSERT INTO keepers VALUES (5, 'Nia', 'day'); SELECT count(*) FROM keepers;");
  assert.equal(r.statements[0].changed, 1);
  assert.deepEqual(r.statements[1].rows, [[5]]);
});

// ---- the missions, played the way a learner would --------------------------------------

const play = (db: ReturnType<typeof zoo>, s: SqlState, sql: string) => { const r = run(db, sql); s.runs.push({ sql, result: shown(r), error: r.error }); };
const ticked = <S>(m: { steps: { done: (s: S) => boolean }[] }, s: S) => m.steps.filter((st) => st.done(s)).length;

test('the zoo mission passes with its own hints, and not with the tempting queries', () => {
  const db = zoo(); const s = ZOO_MISSION.setup();
  play(db, s, 'SELECT * FROM pandas');
  play(db, s, 'SELECT name, age FROM pandas WHERE age > 10');
  play(db, s, 'SELECT p.name, k.name FROM pandas p JOIN keepers k ON k.id = p.keeper_id');
  play(db, s, 'SELECT k.name, COUNT(*) FROM keepers k LEFT JOIN pandas p ON p.keeper_id = k.id GROUP BY k.id');
  assert.deepEqual(ZOO_MISSION.steps.map((st) => st.done(s)), [true, false, false, false, false]);
  play(db, s, ZOO_MISSION.steps[1].hint!);
  play(db, s, 'SELECT p.name, k.name FROM pandas p LEFT JOIN keepers k ON k.id = p.keeper_id');
  play(db, s, ZOO_MISSION.steps[3].hint!);
  play(db, s, 'SELECT k.name, COUNT(p.id) FROM keepers k LEFT JOIN pandas p ON p.keeper_id = k.id GROUP BY k.name');
  assert.equal(ticked(ZOO_MISSION, s), 5);
});

test('the index mission: an index on email does not make lower(email) fast', () => {
  const db = new SQL.Database(); load(db, 'shop'); const s = INDEX_MISSION.setup();
  play(db, s, INDEX_MISSION.steps[0].hint!);
  play(db, s, 'CREATE INDEX idx_orders_customer ON orders(customer_id)');
  play(db, s, INDEX_MISSION.steps[0].hint!);
  play(db, s, 'CREATE INDEX idx_email ON customers(email)');
  play(db, s, `SELECT * FROM customers WHERE lower(email) = lower('${LOGIN_EMAIL}')`);
  assert.deepEqual(INDEX_MISSION.steps.map((st) => st.done(s)), [true, true, false]);
  play(db, s, 'CREATE INDEX idx_email_lower ON customers(lower(email))');
  play(db, s, `SELECT email FROM customers WHERE lower(email) = lower('${LOGIN_EMAIL}')`);
  assert.equal(ticked(INDEX_MISSION, s), 3);
});

// ---- transactions: pinned to what PostgreSQL 17.6 did with two real sessions -------------

test('lost update: read-then-write loses a sale with or without BEGIN ... COMMIT', () => {
  for (const strategy of ['none', 'txn'] as const) {
    const r = sell(strategy);
    assert.equal(r.final, 9, strategy);
    assert.equal(r.sold, 2);
    assert.equal(r.lost, 1);
  }
  // Under READ COMMITTED, B's UPDATE waited for A's lock - and then still wrote 9.
  assert.ok(sell('txn').events.some((e) => e.who === 'B' && e.kind === 'wait'));
});

test('FOR UPDATE and stock = stock - 1 both end at 8 with both sales counted', () => {
  for (const strategy of ['forupdate', 'atomic'] as const) {
    const r = sell(strategy);
    assert.deepEqual([r.final, r.sold, r.lost], [8, 2, 0], strategy);
  }
  assert.ok(sell('forupdate').events.some((e) => e.who === 'B' && /^9/.test(e.result)), 'B reads 9 after waiting');
});

test('REPEATABLE READ refuses the second write instead of losing it; a retry completes it', () => {
  const r = sell('repeatable');
  assert.deepEqual([r.final, r.sold, r.refused, r.lost], [9, 1, 1, 0]);
  assert.ok(r.events.some((e) => e.result === 'ERROR: could not serialize access due to concurrent update'));
  const again = sell('repeatable', true);
  assert.deepEqual([again.final, again.sold, again.lost], [8, 2, 0]);
  assert.equal(START, 10);
});

test('the lost-update mission: a transaction alone and REPEATABLE READ without retry do not pass step 3', () => {
  const s = TXN_MISSION.setup();
  doSale(s, 'none', false); doSale(s, 'txn', false); doSale(s, 'repeatable', false); doSale(s, 'repeatable', true);
  assert.deepEqual(TXN_MISSION.steps.map((st) => st.done(s)), [true, true, false, true]);
  doSale(s, 'atomic', false);
  assert.equal(ticked(TXN_MISSION, s), 4);
});

// ---- replication and recovery ---------------------------------------------------------

test('reading your own write: a lagging replica shows the old value; extra replicas do not help', () => {
  assert.equal(readAfterWrite('replica').sees, 'old');
  assert.equal(readAfterWrite('two-replicas').sees, 'old');
  assert.deepEqual([readAfterWrite('primary').sees, readAfterWrite('primary').othersOnReplicas], ['new', false]);
  assert.equal(readAfterWrite('sticky').sees, 'new');
  assert.ok(readAfterWrite('wait-lsn').readMs > LAG_MS / 2, 'waiting for replay costs read latency');
  assert.ok(readAfterWrite('sync').writeMs > LAG_MS, 'remote_apply costs write latency');
});

test('a dropped table: the replica copies the DROP; only PITR before the DROP gets everything back', () => {
  assert.equal(orderTimes.length, TODAY);
  assert.deepEqual([recover('promote').tableExists, recover('promote').lost], [false, ALL]);
  assert.deepEqual([recover('nightly').orders, recover('nightly').lost], [BEFORE_BACKUP, TODAY]);
  assert.equal(recover('pitr', '14:04:59').lost, 0);
  assert.equal(recover('pitr', '14:05:30').tableExists, false);
  assert.ok(recover('pitr', '12:00:00').lost > 0);
  assert.ok(recover('pitr', '14:04:30').lost > 0, 'stopping before the last order loses it');
});

test('the replica mission: more replicas, all reads on the primary, and the nightly restore do not pass', () => {
  const s = REPLICA_MISSION.setup();
  doRead(s, 'replica'); doRead(s, 'two-replicas'); doRead(s, 'primary');
  doRecover(s, 'promote'); doRecover(s, 'nightly'); doRecover(s, 'pitr', '14:05:30');
  assert.deepEqual(REPLICA_MISSION.steps.map((st) => st.done(s)), [true, false, true, false]);
  doRead(s, 'sticky'); doRecover(s, 'pitr', '14:04:59');
  assert.equal(ticked(REPLICA_MISSION, s), 4);
});
