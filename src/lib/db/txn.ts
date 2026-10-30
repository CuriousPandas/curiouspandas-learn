// Two clerks sell the last panda tees at the same moment. Each strategy below
// replays, statement by statement, what PostgreSQL 17.6 actually did when this
// was run with two real psql sessions (clerk B starting 0.5 s after clerk A).
// Recorded results, by strategy - final stock after two sales from 10:
//   read then write, autocommit       9  (one sale lost)
//   BEGIN ... COMMIT, READ COMMITTED  9  (B's UPDATE waited for A, then wrote 9 anyway)
//   SELECT ... FOR UPDATE             8  (B's SELECT waited, then read 9)
//   UPDATE SET stock = stock - 1      8  (B's UPDATE waited, then returned 8)
//   REPEATABLE READ                   9  (B: "could not serialize access due to concurrent update")
// The simulator is a replay, not a database: it exists so the interleaving can
// be shown step by step in a browser, and tests/db.test.ts pins it to the above.

export type Strategy = 'none' | 'txn' | 'forupdate' | 'atomic' | 'repeatable';
export type Who = 'A' | 'B';
export type TxEvent = { who: Who; sql: string; result: string; kind: 'ok' | 'wait' | 'err' };
export type Sale = { strategy: Strategy; retry: boolean; events: TxEvent[]; final: number; sold: number; refused: number; lost: number };

export const START = 10;

export const STRATEGIES: Record<Strategy, string> = {
  none: 'Read the stock, then write the new number',
  txn: 'The same, inside BEGIN ... COMMIT',
  forupdate: 'Lock the row while reading: SELECT ... FOR UPDATE',
  atomic: 'Let the database do the sum: SET stock = stock - 1',
  repeatable: 'BEGIN ISOLATION LEVEL REPEATABLE READ',
};

const SEL = 'SELECT stock FROM items';
const upd = (n: number) => `UPDATE items SET stock = ${n}`;
const DEC = 'UPDATE items SET stock = stock - 1';
const SERIAL = 'ERROR: could not serialize access due to concurrent update';

export function sell(strategy: Strategy, retry = false): Sale {
  const ev: TxEvent[] = [];
  const e = (who: Who, sql: string, result: string, kind: TxEvent['kind'] = 'ok') => ev.push({ who, sql, result, kind });
  let final = START, sold = 2, refused = 0;
  switch (strategy) {
    case 'none':
      e('A', SEL, '10'); e('B', SEL, '10');
      e('A', upd(9), 'UPDATE 1'); e('B', upd(9), 'UPDATE 1');
      final = 9; break;
    case 'txn':
      e('A', `BEGIN; ${SEL}`, '10'); e('B', `BEGIN; ${SEL}`, '10');
      e('A', upd(9), 'UPDATE 1 - A now holds the row lock');
      e('B', upd(9), 'waiting for A to finish...', 'wait');
      e('A', 'COMMIT', 'COMMIT');
      e('B', upd(9), 'UPDATE 1 - wrote the 9 it worked out earlier');
      e('B', 'COMMIT', 'COMMIT');
      final = 9; break;
    case 'forupdate':
      e('A', `BEGIN; ${SEL} FOR UPDATE`, '10 - row locked for A');
      e('B', `BEGIN; ${SEL} FOR UPDATE`, 'waiting for A to finish...', 'wait');
      e('A', `${upd(9)}; COMMIT`, 'COMMIT');
      e('B', `${SEL} FOR UPDATE`, '9 - read after A committed');
      e('B', `${upd(8)}; COMMIT`, 'COMMIT');
      final = 8; break;
    case 'atomic':
      e('A', `BEGIN; ${DEC} RETURNING stock`, '9');
      e('B', `BEGIN; ${DEC} RETURNING stock`, 'waiting for A to finish...', 'wait');
      e('A', 'COMMIT', 'COMMIT');
      e('B', `${DEC} RETURNING stock`, '8 - re-applied to the committed row');
      e('B', 'COMMIT', 'COMMIT');
      final = 8; break;
    case 'repeatable':
      e('A', `BEGIN ISOLATION LEVEL REPEATABLE READ; ${SEL}`, '10');
      e('B', `BEGIN ISOLATION LEVEL REPEATABLE READ; ${SEL}`, '10');
      e('A', upd(9), 'UPDATE 1');
      e('B', upd(9), 'waiting for A to finish...', 'wait');
      e('A', 'COMMIT', 'COMMIT');
      e('B', upd(9), SERIAL, 'err');
      e('B', 'ROLLBACK', 'ROLLBACK');
      if (retry) {
        e('B', `BEGIN ISOLATION LEVEL REPEATABLE READ; ${SEL}`, '9 - retried with a fresh snapshot');
        e('B', `${upd(8)}; COMMIT`, 'COMMIT');
        final = 8;
      } else { final = 9; sold = 1; refused = 1; }
      break;
  }
  // A lost update is a sale the clerk was told succeeded but the stock never saw.
  const lost = sold - (START - final);
  return { strategy, retry, events: ev, final, sold, refused, lost };
}
