// sql.js ships no types. This declares only what the database lessons use, so a
// call outside this list fails `astro check` instead of being guessed at.
declare module 'sql.js' {
  export type SqlValue = number | string | Uint8Array | null;
  export interface QueryExecResult { columns: string[]; values: SqlValue[][] }
  export interface Statement {
    step(): boolean;
    get(): SqlValue[];
    getColumnNames(): string[];
    getSQL(): string;
    free(): boolean;
  }
  export interface StatementIterator extends Iterable<Statement> { getRemainingSQL(): string }
  export interface Database {
    exec(sql: string): QueryExecResult[];
    run(sql: string, params?: SqlValue[]): Database;
    iterateStatements(sql: string): StatementIterator;
    getRowsModified(): number;
    close(): void;
  }
  export interface SqlJsStatic { Database: new (data?: Uint8Array) => Database }
  export default function initSqlJs(config?: { locateFile?: (file: string) => string }): Promise<SqlJsStatic>;
}
