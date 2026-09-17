import type {SqlDriver, SqlExecutor, SqlResult, SqlValue} from './driver';

export class StorageWriteError extends Error {
  readonly code = 'STORAGE_WRITE_FAILED' as const;
  constructor(readonly cause: unknown) {
    super('STORAGE_WRITE_FAILED');
  }
}

export class DatabaseReadOnlyError extends Error {
  readonly code = 'DATABASE_RECOVERY' as const;
  constructor() {
    super('DATABASE_RECOVERY');
  }
}

/**
 * Connection wrapper enforcing DB-001: WAL, FULL synchronous, foreign keys,
 * 5 s busy timeout and one serialized asynchronous write queue. Reads bypass
 * the queue (WAL readers do not block the writer).
 */
export class Database {
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(
    private readonly driver: SqlDriver,
    readonly readOnly: boolean,
  ) {}

  static async open(driver: SqlDriver, options: {readOnly?: boolean} = {}): Promise<Database> {
    const readOnly = options.readOnly === true;
    await driver.execute('PRAGMA foreign_keys = ON');
    await driver.execute('PRAGMA busy_timeout = 5000');
    if (!readOnly) {
      await driver.execute('PRAGMA journal_mode = WAL');
      await driver.execute('PRAGMA synchronous = FULL');
    }
    return new Database(driver, readOnly);
  }

  read(sql: string, params?: SqlValue[]): Promise<SqlResult> {
    return this.driver.execute(sql, params);
  }

  /** Serialized write transaction. Failures surface as StorageWriteError. */
  write<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    if (this.readOnly) {
      return Promise.reject(new DatabaseReadOnlyError());
    }
    const run = async (): Promise<T> => {
      if (this.closed) {
        throw new StorageWriteError(new Error('database closed'));
      }
      try {
        return await this.driver.transaction(fn);
      } catch (error) {
        if (error instanceof DomainRuleError) {
          throw error;
        }
        throw new StorageWriteError(error);
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Runs a statement that cannot execute inside a transaction (VACUUM, checkpoint). */
  maintenance(sql: string, params?: SqlValue[]): Promise<SqlResult> {
    const run = () => this.driver.execute(sql, params);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** SEC-007: truncate the WAL after user deletion when it is safe to do so. */
  async checkpointTruncate(): Promise<void> {
    if (!this.readOnly) {
      await this.maintenance('PRAGMA wal_checkpoint(TRUNCATE)');
    }
  }

  async close(): Promise<void> {
    await this.queue.catch(() => undefined);
    this.closed = true;
    await this.driver.close();
  }
}

/**
 * Thrown by repositories for expected rule violations (not storage faults),
 * e.g. retry requested on a turn that is no longer the latest.
 */
export class DomainRuleError extends Error {
  constructor(readonly rule: string) {
    super(rule);
  }
}
