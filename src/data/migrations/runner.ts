import type {SqlDriver} from '../driver';
import type {Migration} from './index';

export type MigrationFailureKind =
  | 'checksum-mismatch'
  | 'newer-schema'
  | 'apply-failed'
  | 'validation-failed';

export class MigrationError extends Error {
  readonly code = 'DATABASE_RECOVERY' as const;
  constructor(readonly kind: MigrationFailureKind, readonly version: number, readonly causedBy?: unknown) {
    super(`migration ${version}: ${kind}`);
  }
}

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`;

export interface MigrationPlan {
  applied: number[];
  pending: Migration[];
}

/** Verifies the checksum lock and returns what still has to run (DB-006). */
export async function planMigrations(
  driver: SqlDriver,
  migrations: readonly Migration[],
): Promise<MigrationPlan> {
  await driver.execute(CREATE_MIGRATIONS_TABLE);
  const {rows} = await driver.execute(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  const byVersion = new Map(migrations.map(m => [m.version, m]));
  const applied: number[] = [];
  for (const row of rows) {
    const version = Number(row.version);
    const bundled = byVersion.get(version);
    if (!bundled) {
      // Written by a newer app build; never down-migrate (REL-006).
      throw new MigrationError('newer-schema', version);
    }
    if (bundled.checksum !== row.checksum) {
      throw new MigrationError('checksum-mismatch', version);
    }
    applied.push(version);
  }
  const pending = migrations.filter(m => !applied.includes(m.version));
  return {applied, pending};
}

/** Applies each pending migration in its own transaction, in order. */
export async function applyMigrations(
  driver: SqlDriver,
  pending: readonly Migration[],
  now: () => number,
): Promise<void> {
  for (const migration of pending) {
    try {
      await driver.transaction(async tx => {
        for (const statement of migration.statements) {
          await tx.execute(statement);
        }
        await tx.execute(
          'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
          [migration.version, migration.checksum, now()],
        );
      });
    } catch (error) {
      throw new MigrationError('apply-failed', migration.version, error);
    }
  }
}

/** Post-migration validation before the backup may be scheduled for removal. */
export async function validateDatabase(driver: SqlDriver, version: number): Promise<void> {
  let ok = false;
  let foreignKeyViolations = 1;
  try {
    const integrity = await driver.execute('PRAGMA quick_check');
    ok = integrity.rows.length === 1 && Object.values(integrity.rows[0]!)[0] === 'ok';
    foreignKeyViolations = (await driver.execute('PRAGMA foreign_key_check')).rows.length;
  } catch (error) {
    throw new MigrationError('validation-failed', version, error);
  }
  if (!ok || foreignKeyViolations > 0) {
    throw new MigrationError('validation-failed', version);
  }
}
