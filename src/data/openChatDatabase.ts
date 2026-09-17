import {Database} from './Database';
import type {SqlDriverFactory} from './driver';
import {MIGRATIONS, type Migration} from './migrations';
import {
  MigrationError,
  applyMigrations,
  planMigrations,
  validateDatabase,
} from './migrations/runner';

export const CHAT_DB_NAME = 'namu.sqlite';
export const MIGRATION_BACKUP_NAME = 'namu-migration-backup.sqlite';
const CLEANUP_FLAG = 'migration_backup_cleanup';

export type OpenResult =
  | {mode: 'normal'; db: Database}
  /** DATABASE_RECOVERY: read-only access with export; nothing is wiped. */
  | {mode: 'recovery'; db: Database | null; reason: string};

export interface OpenOptions {
  factory: SqlDriverFactory;
  directory: string;
  now: () => number;
  migrations?: readonly Migration[];
}

/**
 * Opens namu.sqlite applying DB-006:
 *  - checksum-locked ordered migrations, each transactional;
 *  - a consistent `VACUUM INTO` backup before migrating an existing database
 *    (never a naive file copy of a live WAL database);
 *  - on failure NOTHING is replaced or removed: namu.sqlite and the backup both
 *    stay on disk and the app enters read-only recovery with export. Each
 *    migration is transactional, so a failed apply leaves namu.sqlite at its
 *    last good version; after a failed validation, recovery reads the backup;
 *  - the backup is removed only after validation plus one clean restart.
 */
export async function openChatDatabase(options: OpenOptions): Promise<OpenResult> {
  const {factory, directory, now} = options;
  const migrations = options.migrations ?? MIGRATIONS;

  let driver;
  try {
    driver = await factory.open(directory, CHAT_DB_NAME);
  } catch {
    return recover(options, 'open-failed');
  }

  let plan;
  try {
    plan = await planMigrations(driver, migrations);
  } catch (error) {
    await driver.close().catch(() => undefined);
    return recover(options, error instanceof MigrationError ? error.kind : 'plan-failed');
  }

  const existingDatabase = plan.applied.length > 0;
  if (plan.pending.length === 0) {
    // A backup without the cleanup flag means the previous migration run did
    // not finish validation (failure or process death): validate before use.
    if (existingDatabase && (await factory.exists(directory, MIGRATION_BACKUP_NAME))) {
      const flagged = await driver
        .execute('SELECT 1 FROM preferences WHERE key = ?', [CLEANUP_FLAG])
        .then(r => r.rows.length > 0, () => false);
      if (!flagged) {
        try {
          await validateDatabase(driver, plan.applied[plan.applied.length - 1]!);
        } catch {
          await driver.close().catch(() => undefined);
          return recover(options, 'validation-failed', true);
        }
        await driver.execute('INSERT OR REPLACE INTO preferences (key, value_json) VALUES (?, ?)', [
          CLEANUP_FLAG,
          JSON.stringify({state: 'await-clean-restart'}),
        ]);
        return {mode: 'normal', db: await Database.open(driver)};
      }
    }
    const db = await Database.open(driver);
    await finishDeferredBackupCleanup(db, factory, directory);
    return {mode: 'normal', db};
  }

  let backedUp = false;
  if (existingDatabase) {
    try {
      await factory.remove(directory, MIGRATION_BACKUP_NAME);
      await driver.execute('PRAGMA wal_checkpoint(FULL)');
      await driver.execute('VACUUM INTO ?', [joinPath(directory, MIGRATION_BACKUP_NAME)]);
      backedUp = true;
    } catch {
      // Without a backup the migration is not attempted.
      await driver.close().catch(() => undefined);
      return recover(options, 'backup-failed');
    }
  }

  try {
    await applyMigrations(driver, plan.pending, now);
    await validateDatabase(driver, plan.pending[plan.pending.length - 1]!.version);
  } catch (error) {
    await driver.close().catch(() => undefined);
    const kind = error instanceof MigrationError ? error.kind : 'apply-failed';
    // Nothing is replaced or deleted. A failed apply rolled back, so
    // namu.sqlite is still the last good version; after a failed validation
    // the consistent backup is the safer thing to read for export.
    return recover(options, kind, backedUp && kind === 'validation-failed');
  }

  const db = await Database.open(driver);
  if (backedUp) {
    await db.write(tx =>
      tx.execute('INSERT OR REPLACE INTO preferences (key, value_json) VALUES (?, ?)', [
        CLEANUP_FLAG,
        JSON.stringify({state: 'await-clean-restart'}),
      ]),
    );
  }
  return {mode: 'normal', db};
}

async function finishDeferredBackupCleanup(
  db: Database,
  factory: SqlDriverFactory,
  directory: string,
): Promise<void> {
  const {rows} = await db.read('SELECT value_json FROM preferences WHERE key = ?', [CLEANUP_FLAG]);
  if (rows.length === 0) {
    return;
  }
  // This start needed no migration and opened cleanly: the backup can go.
  await factory.remove(directory, MIGRATION_BACKUP_NAME).catch(() => undefined);
  await db.write(tx => tx.execute('DELETE FROM preferences WHERE key = ?', [CLEANUP_FLAG]));
}

async function recover(options: OpenOptions, reason: string, preferBackup = false): Promise<OpenResult> {
  const {factory, directory} = options;
  const candidates = preferBackup ? [MIGRATION_BACKUP_NAME, CHAT_DB_NAME] : [CHAT_DB_NAME, MIGRATION_BACKUP_NAME];
  for (const name of candidates) {
    try {
      if (await factory.exists(directory, name)) {
        const driver = await factory.openReadOnly(directory, name);
        const db = await Database.open(driver, {readOnly: true});
        await db.read('SELECT COUNT(*) FROM conversations');
        return {mode: 'recovery', db, reason};
      }
    } catch {
      // try the next candidate; nothing is ever deleted here.
    }
  }
  return {mode: 'recovery', db: null, reason};
}

function joinPath(directory: string, name: string): string {
  return directory.endsWith('/') ? `${directory}${name}` : `${directory}/${name}`;
}
