import {open, type DB, type Scalar} from '@op-engineering/op-sqlite';
import type {SqlDriver, SqlDriverFactory, SqlExecutor, SqlResult, SqlRow, SqlValue} from '../../data/driver';

/**
 * Production SQLite driver (op-sqlite, FTS5 enabled through the `op-sqlite`
 * key in package.json). Asynchronous API only: no synchronous database call is
 * ever made from a render function (DB-001).
 */
function toResult(result: {rows?: Array<Record<string, Scalar>>; rowsAffected?: number}): SqlResult {
  return {rows: (result.rows ?? []) as SqlRow[], rowsAffected: result.rowsAffected ?? 0};
}

class OpSqliteDriver implements SqlDriver {
  constructor(private readonly db: DB) {}

  async execute(sql: string, params?: SqlValue[]): Promise<SqlResult> {
    return toResult(await this.db.execute(sql, params));
  }

  /**
   * Asynchronous BEGIN/COMMIT so the `synchronous=FULL` fsync never runs on
   * the JS thread (NFR-006). op-sqlite's own `transaction()` issues BEGIN and
   * COMMIT synchronously. Callers are already serialized by Database.write().
   */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    await this.db.execute('BEGIN IMMEDIATE');
    try {
      const value = await fn({
        execute: async (sql, params) => toResult(await this.db.execute(sql, params)),
      });
      await this.db.execute('COMMIT');
      return value;
    } catch (error) {
      await this.db.execute('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.db.closeAsync();
  }
}

export class OpSqliteFactory implements SqlDriverFactory {
  async open(directory: string, name: string): Promise<SqlDriver> {
    return new OpSqliteDriver(open({name, location: directory}));
  }

  async openReadOnly(directory: string, name: string): Promise<SqlDriver> {
    return new OpSqliteDriver(open({name, location: directory, readOnly: true, failOnCreate: true}));
  }

  async exists(directory: string, name: string): Promise<boolean> {
    try {
      const db = open({name, location: directory, failOnCreate: true});
      await db.closeAsync();
      return true;
    } catch {
      return false;
    }
  }

  async remove(directory: string, name: string): Promise<void> {
    if (!(await this.exists(directory, name))) {
      return;
    }
    const db = open({name, location: directory});
    db.delete();
  }

  /**
   * File replacement without a filesystem API: the target is deleted, then the
   * source database is copied into place with `VACUUM INTO`, which writes a
   * complete, consistent database file (DB-006).
   */
  async replace(directory: string, source: string, target: string): Promise<void> {
    await this.remove(directory, target);
    const db = open({name: source, location: directory, failOnCreate: true});
    try {
      const separator = directory.endsWith('/') ? '' : '/';
      await db.execute('VACUUM INTO ?', [`${directory}${separator}${target}`]);
    } finally {
      await db.closeAsync();
    }
    await this.remove(directory, source);
  }
}
