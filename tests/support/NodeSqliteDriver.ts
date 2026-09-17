import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {SqlDriver, SqlDriverFactory, SqlExecutor, SqlResult, SqlValue} from '../../src/data/driver';

/**
 * Test driver backed by Node's built-in SQLite so repository SQL, triggers,
 * foreign keys and FTS5 run for real under Jest. Loaded through
 * process.getBuiltinModule because Jest's resolver does not know `node:sqlite`.
 */
type Statement = {
  all(...params: SqlValue[]): Record<string, SqlValue>[];
  run(...params: SqlValue[]): {changes: number | bigint};
};
type DatabaseSync = {
  prepare(sql: string): Statement;
  exec(sql: string): void;
  close(): void;
};
const sqlite = (
  process as unknown as {getBuiltinModule(id: string): {DatabaseSync: new (file: string, options?: object) => DatabaseSync}}
).getBuiltinModule('node:sqlite');

const RETURNS_ROWS = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)/i;

export interface FaultPlan {
  /** Throw when a statement containing this text executes. */
  failOn?: string;
}

export class NodeSqliteDriver implements SqlDriver {
  private inTransaction = false;
  constructor(private readonly db: DatabaseSync, public faults: FaultPlan = {}) {}

  private run(sql: string, params: SqlValue[] = []): SqlResult {
    if (this.faults.failOn && sql.includes(this.faults.failOn)) {
      throw new Error(`injected fault: ${this.faults.failOn}`);
    }
    const statement = this.db.prepare(sql);
    if (RETURNS_ROWS.test(sql)) {
      const rows = statement.all(...params).map(row => ({...row}));
      return {rows, rowsAffected: 0};
    }
    const info = statement.run(...params);
    return {rows: [], rowsAffected: Number(info.changes)};
  }

  async execute(sql: string, params?: SqlValue[]): Promise<SqlResult> {
    return this.run(sql, params);
  }

  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      throw new Error('nested transaction');
    }
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn({execute: async (sql, params) => this.run(sql, params)});
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export class NodeSqliteFactory implements SqlDriverFactory {
  readonly opened: NodeSqliteDriver[] = [];
  faults: FaultPlan = {};

  async open(directory: string, name: string): Promise<SqlDriver> {
    const driver = new NodeSqliteDriver(new sqlite.DatabaseSync(path.join(directory, name)), this.faults);
    this.opened.push(driver);
    return driver;
  }

  async openReadOnly(directory: string, name: string): Promise<SqlDriver> {
    return new NodeSqliteDriver(new sqlite.DatabaseSync(path.join(directory, name), {readOnly: true}));
  }

  async exists(directory: string, name: string): Promise<boolean> {
    return fs.existsSync(path.join(directory, name));
  }

  async remove(directory: string, name: string): Promise<void> {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(directory, name + suffix), {force: true});
    }
  }

  async replace(directory: string, source: string, target: string): Promise<void> {
    await this.remove(directory, target);
    fs.renameSync(path.join(directory, source), path.join(directory, target));
  }
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'namu-test-'));
}

export function memoryDriver(): NodeSqliteDriver {
  return new NodeSqliteDriver(new sqlite.DatabaseSync(':memory:'));
}
