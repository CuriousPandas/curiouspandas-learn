// The database lessons run real SQLite (sql.js, compiled to WebAssembly), not a
// toy parser: a learner's JOIN, GROUP BY or CREATE INDEX is executed by the same
// engine that ships in phones and browsers, and the query plans are SQLite's
// own. This file is the part shared by the browser worker and the tests, so the
// missions are checked against exactly what the page runs.

import type { Database, SqlValue } from 'sql.js';

export type Cell = string | number | null;
export type StmtResult = {
  sql: string;
  columns?: string[];
  rows?: Cell[][];
  total?: number;
  plan?: string[];
  /** Rows of the scanned table when the plan reads all of it; undefined when an index was used. */
  scanned?: { table: string; rows: number };
  changed?: number;
  ms: number;
};
export type RunResult = { statements: StmtResult[]; error?: string };

// Enough rows to read; the full count is reported separately. Sending 200,000
// rows from the worker to the page would freeze the tab it is meant to teach in.
export const MAX_ROWS = 100;

const cell = (v: SqlValue): Cell => (v instanceof Uint8Array ? `<blob ${v.length} bytes>` : v);

/** SQLite's own plan, indented the way the sqlite3 shell prints it. */
export function planOf(db: Database, sql: string): string[] {
  const [res] = db.exec(`EXPLAIN QUERY PLAN ${sql}`);
  if (!res) return [];
  const depth = new Map<number, number>();
  return res.values.map(([id, parent, , detail]) => {
    const d = (depth.get(Number(parent)) ?? -1) + 1;
    depth.set(Number(id), d);
    return `${'  '.repeat(d)}${detail}`;
  });
}

/**
 * Tables the plan reads end to end. In SQLite's plans every "SCAN x" line visits
 * all of x - even "SCAN x USING COVERING INDEX" walks the whole index - while
 * "SEARCH x USING INDEX" jumps to matching rows. CTEs and "CONSTANT ROW" also
 * appear as SCAN; the caller keeps only real tables.
 */
export function fullScans(plan: string[]): string[] {
  return plan.map((l) => l.trim().match(/^SCAN (\S+)/)?.[1]).filter((t): t is string => !!t);
}

/**
 * SQLite's plan names a table by its alias: "FROM pandas p" plans as "SCAN p".
 * Without this map an aliased full scan was reported as "no full table read",
 * which is exactly backwards.
 */
export function aliases(sql: string, tables: Set<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of sql.matchAll(/\b(?:from|join)\s+"?(\w+)"?\s+(?:as\s+)?(\w+)/gi)) {
    if (tables.has(m[1]) && !/^(on|where|join|left|inner|cross|natural|group|order|limit|using)$/i.test(m[2])) map.set(m[2], m[1]);
  }
  return map;
}

export function run(db: Database, sql: string, now: () => number = () => performance.now()): RunResult {
  const statements: StmtResult[] = [];
  try {
    for (const stmt of db.iterateStatements(sql)) {
      const text = stmt.getSQL().trim();
      const columns = stmt.getColumnNames();
      if (columns.length) {
        const plan = /^(select|with|values)\b/i.test(text) ? planOf(db, text) : undefined;
        const rows: Cell[][] = [];
        let total = 0;
        const t0 = now();
        while (stmt.step()) { total++; if (rows.length < MAX_ROWS) rows.push(stmt.get().map(cell)); }
        const ms = now() - t0;
        const tables = new Set(schema(db).map((t) => t.table));
        const alias = aliases(text, tables);
        const big = (plan ? fullScans(plan) : []).map((t) => alias.get(t) ?? t).filter((t) => tables.has(t));
        const scanned = big.length ? { table: big[0], rows: Number(db.exec(`SELECT count(*) FROM "${big[0]}"`)[0].values[0][0]) } : undefined;
        statements.push({ sql: text, columns, rows, total, plan, scanned, ms });
      } else {
        const t0 = now();
        while (stmt.step()) { /* DDL and DML produce no rows */ }
        statements.push({ sql: text, changed: db.getRowsModified(), ms: now() - t0 });
      }
      stmt.free();
    }
  } catch (e) {
    return { statements, error: (e as Error).message };
  }
  return { statements };
}

/** The statement whose rows the learner most likely wants to see. */
export const shown = (r: RunResult) => [...r.statements].reverse().find((s) => s.columns) ?? r.statements.at(-1);

// ---- datasets -------------------------------------------------------------------

export type Dataset = 'zoo' | 'shop';

// Small enough to read whole. Ravi looks after no pandas and Pip has no keeper
// yet: the two rows that INNER JOIN and COUNT(*) quietly get wrong.
const ZOO = `
CREATE TABLE keepers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, shift TEXT NOT NULL);
INSERT INTO keepers VALUES (1,'Mei','morning'),(2,'Tomas','evening'),(3,'Aiko','morning'),(4,'Ravi','night');
CREATE TABLE pandas (id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, keeper_id INTEGER REFERENCES keepers(id), enclosure TEXT NOT NULL);
INSERT INTO pandas VALUES (1,'Bao',12,1,'east'),(2,'Lin',4,1,'east'),(3,'Fu',15,2,'west'),(4,'Xiao',7,3,'west'),
  (5,'Jing',11,2,'north'),(6,'Tian',2,3,'east'),(7,'Yun',18,1,'north'),(8,'Pip',1,NULL,'nursery');
CREATE TABLE feedings (id INTEGER PRIMARY KEY, panda_id INTEGER NOT NULL REFERENCES pandas(id), food TEXT NOT NULL, kg REAL NOT NULL, day TEXT NOT NULL);
INSERT INTO feedings (panda_id, food, kg, day) VALUES
  (1,'bamboo',12.5,'mon'),(1,'bamboo',11.0,'tue'),(1,'apple',0.5,'tue'),(2,'bamboo',6.0,'mon'),(2,'bamboo',6.5,'wed'),
  (3,'bamboo',14.0,'mon'),(3,'carrot',0.4,'mon'),(3,'bamboo',13.5,'thu'),(4,'bamboo',9.0,'tue'),(4,'apple',0.3,'wed'),
  (5,'bamboo',12.0,'wed'),(5,'bamboo',12.5,'fri'),(6,'bamboo',3.0,'mon'),(6,'bamboo',3.5,'thu'),(7,'bamboo',15.0,'tue'),
  (7,'bamboo',14.5,'fri'),(7,'carrot',0.6,'fri'),(8,'milk',0.8,'mon'),(8,'milk',0.9,'tue'),(8,'milk',1.0,'wed');
`;

// 20,000 customers and 200,000 orders, generated inside SQLite so the page
// downloads a few lines of SQL rather than megabytes of data. The multiplications
// scatter values deterministically: every learner gets the same table.
const SHOP = `
CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, country TEXT NOT NULL);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
INSERT INTO customers SELECT i, 'panda' || i || '@example.com', substr('BRINUSFRDE', (i % 5) * 2 + 1, 2) FROM n;
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL NOT NULL, created_at TEXT NOT NULL);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000)
INSERT INTO orders SELECT i, (i * 7919) % 20000 + 1, ((i * 104729) % 50000) / 100.0, date('2023-01-01', '+' || ((i * 31) % 1095) || ' days') FROM n;
`;

export const DATASETS: Record<Dataset, { sql: string; rows: string }> = {
  zoo: { sql: ZOO, rows: '4 keepers, 8 pandas, 20 feedings' },
  shop: { sql: SHOP, rows: '20,000 customers, 200,000 orders' },
};

export function load(db: Database, name: Dataset) { db.exec(DATASETS[name].sql); }

export function schema(db: Database): { table: string; columns: string[] }[] {
  const [t] = db.exec(`SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`);
  return (t?.values ?? []).map(([name]) => ({
    table: String(name),
    columns: (db.exec(`PRAGMA table_info("${name}")`)[0]?.values ?? []).map((c) => String(c[1])),
  }));
}

export function indexes(db: Database): string[] {
  const [r] = db.exec(`SELECT sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`);
  return (r?.values ?? []).map(([s]) => String(s));
}

// ---- answer checking -------------------------------------------------------------

const norm = (v: Cell) => (v === null ? 'NULL' : typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v));

/**
 * Does the learner's result answer the question? Each expected row must appear
 * once, as values inside one learner row - extra columns (an id, a label) are
 * fine, missing or extra rows are not. With `ordered`, rows must also come back
 * in the expected order, so a missing ORDER BY does not pass by luck.
 */
export function answers(got: Cell[][] | undefined, want: Cell[][], ordered = false): boolean {
  if (!got || got.length !== want.length) return false;
  const holds = (row: Cell[], exp: Cell[]) => {
    const pool = row.map(norm);
    return exp.every((v) => { const i = pool.indexOf(norm(v)); if (i < 0) return false; pool.splice(i, 1); return true; });
  };
  if (ordered) return want.every((exp, i) => holds(got[i], exp));
  const left = [...got];
  return want.every((exp) => { const i = left.findIndex((r) => holds(r, exp)); if (i < 0) return false; left.splice(i, 1); return true; });
}
