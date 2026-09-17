/**
 * Minimal SQL driver contract (DB-001). The production implementation wraps
 * op-sqlite (src/infrastructure/db/OpSqliteDriver.ts); tests use Node's
 * built-in SQLite so the real SQL, triggers and FTS5 behaviour are exercised.
 * All SQL is parameterized; there is no ORM.
 */
export type SqlValue = string | number | null;
export type SqlRow = Record<string, SqlValue>;

export interface SqlResult {
  rows: SqlRow[];
  rowsAffected: number;
}

export interface SqlExecutor {
  execute(sql: string, params?: SqlValue[]): Promise<SqlResult>;
}

export interface SqlDriver extends SqlExecutor {
  /** Runs `fn` inside one transaction; a thrown error rolls everything back. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface SqlDriverFactory {
  /** Opens (creating if needed) the database file `name` inside `directory`. */
  open(directory: string, name: string): Promise<SqlDriver>;
  /** Opens an existing database read-only (DATABASE_RECOVERY mode). */
  openReadOnly(directory: string, name: string): Promise<SqlDriver>;
  exists(directory: string, name: string): Promise<boolean>;
  /** Deletes `name` and its -wal/-shm siblings. */
  remove(directory: string, name: string): Promise<void>;
  /** Atomically replaces `target` with `source` (both closed). */
  replace(directory: string, source: string, target: string): Promise<void>;
}
