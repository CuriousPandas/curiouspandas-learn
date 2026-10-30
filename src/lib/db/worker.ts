// SQLite runs in a Web Worker, not on the page. A learner can type a query that
// never ends (a recursive CTE without a stop, a cross join of 200,000 rows with
// itself); on the page that would freeze the tab. Here the page can terminate
// the worker and start a fresh database instead.
import initSqlJs, { type Database } from 'sql.js';
// Served from this site's own origin, like every other asset: the WebAssembly
// file is part of the build, never fetched from a CDN.
import wasmUrl from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { load, run, schema, indexes, type Dataset } from './engine.ts';

export type Request = { id: number; type: 'open'; dataset: Dataset } | { id: number; type: 'run'; sql: string };

const ready = initSqlJs({ locateFile: () => wasmUrl });
// The project type-checks against the DOM, where self is a Window and
// postMessage wants a target origin; inside a worker it takes just the message.
const post = (m: unknown) => (self as unknown as { postMessage(m: unknown): void }).postMessage(m);
let db: Database | undefined;

self.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  const SQL = await ready;
  if (msg.type === 'open') {
    db?.close();
    db = new SQL.Database();
    load(db, msg.dataset);
    post({ id: msg.id, schema: schema(db), indexes: indexes(db) });
  } else if (db) {
    const result = run(db, msg.sql);
    post({ id: msg.id, result, schema: schema(db), indexes: indexes(db) });
  }
};
