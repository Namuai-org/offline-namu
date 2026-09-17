import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {MIGRATIONS, migrationSource, type Migration} from '../../src/data/migrations';
import {CHAT_DB_NAME, MIGRATION_BACKUP_NAME, openChatDatabase} from '../../src/data/openChatDatabase';
import {NodeSqliteFactory, makeTempDir} from '../support/NodeSqliteDriver';

const now = () => 1234;

function migration2(statements: string[]): Migration {
  const m = {version: 2, name: 'test', statements, checksum: ''};
  m.checksum = crypto.createHash('sha256').update(statements.join(';\n')).digest('hex');
  return m;
}

describe('DB-006 migrations', () => {
  it('locks every bundled migration checksum', () => {
    for (const m of MIGRATIONS) {
      const actual = crypto.createHash('sha256').update(migrationSource(m)).digest('hex');
      expect({version: m.version, checksum: actual}).toEqual({version: m.version, checksum: m.checksum});
    }
    expect(MIGRATIONS.map(m => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('creates a fresh database with WAL, FULL sync and foreign keys (DB-001)', async () => {
    const dir = makeTempDir();
    const factory = new NodeSqliteFactory();
    const opened = await openChatDatabase({factory, directory: dir, now});
    expect(opened.mode).toBe('normal');
    const db = opened.db!;
    expect((await db.read('PRAGMA journal_mode')).rows[0]).toEqual({journal_mode: 'wal'});
    expect((await db.read('PRAGMA synchronous')).rows[0]).toEqual({synchronous: 2});
    expect((await db.read('PRAGMA foreign_keys')).rows[0]).toEqual({foreign_keys: 1});
    expect((await db.read('SELECT version FROM schema_migrations')).rows).toEqual([{version: 1}]);
    expect(fs.existsSync(path.join(dir, MIGRATION_BACKUP_NAME))).toBe(false);
    await db.close();
  });

  it('migrates an existing database behind a consistent backup and removes it after one clean restart', async () => {
    const dir = makeTempDir();
    const factory = new NodeSqliteFactory();
    const v1 = await openChatDatabase({factory, directory: dir, now});
    await v1.db!.write(tx => tx.execute("INSERT INTO preferences (key, value_json) VALUES ('theme', '\"dark\"')"));
    await v1.db!.close();

    const migrations = [...MIGRATIONS, migration2(['ALTER TABLE drafts ADD COLUMN note TEXT'])];
    const v2 = await openChatDatabase({factory, directory: dir, now, migrations});
    expect(v2.mode).toBe('normal');
    expect(fs.existsSync(path.join(dir, MIGRATION_BACKUP_NAME))).toBe(true);
    await v2.db!.close();

    const restart = await openChatDatabase({factory, directory: dir, now, migrations});
    expect(restart.mode).toBe('normal');
    expect(fs.existsSync(path.join(dir, MIGRATION_BACKUP_NAME))).toBe(false);
    expect((await restart.db!.read("SELECT value_json FROM preferences WHERE key = 'theme'")).rows).toHaveLength(1);
    await restart.db!.close();
  });

  it('preserves the prior database and enters read-only recovery when a migration fails (T21)', async () => {
    const dir = makeTempDir();
    const factory = new NodeSqliteFactory();
    const v1 = await openChatDatabase({factory, directory: dir, now});
    await v1.db!.write(tx =>
      tx.execute(
        "INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c1', 'Precious chat', 1, 1)",
      ),
    );
    await v1.db!.close();

    const broken = [...MIGRATIONS, migration2(['CREATE TABLE ok_table (x)', 'THIS IS NOT SQL'])];
    const result = await openChatDatabase({factory, directory: dir, now, migrations: broken});
    expect(result.mode).toBe('recovery');
    expect(result.db).not.toBeNull();
    expect(result.db!.readOnly).toBe(true);
    // History is still readable for export; the partial migration left nothing behind.
    expect((await result.db!.read('SELECT title FROM conversations')).rows).toEqual([{title: 'Precious chat'}]);
    expect((await result.db!.read("SELECT name FROM sqlite_master WHERE name = 'ok_table'")).rows).toEqual([]);
    await expect(result.db!.write(tx => tx.execute('DELETE FROM conversations'))).rejects.toMatchObject({
      code: 'DATABASE_RECOVERY',
    });
    await result.db!.close();
    expect(fs.existsSync(path.join(dir, CHAT_DB_NAME))).toBe(true);
  });

  it('refuses a database written by a newer app instead of down-migrating (REL-006)', async () => {
    const dir = makeTempDir();
    const factory = new NodeSqliteFactory();
    const newer = [...MIGRATIONS, migration2(['CREATE TABLE future (x)'])];
    const v2 = await openChatDatabase({factory, directory: dir, now, migrations: newer});
    await v2.db!.close();
    const older = await openChatDatabase({factory, directory: dir, now});
    expect(older).toMatchObject({mode: 'recovery', reason: 'newer-schema'});
    await older.db?.close();
  });

  it('detects an edited migration through the checksum lock', async () => {
    const dir = makeTempDir();
    const factory = new NodeSqliteFactory();
    const first = await openChatDatabase({factory, directory: dir, now});
    await first.db!.close();
    const tampered = [{...MIGRATIONS[0]!, checksum: 'f'.repeat(64)}];
    const result = await openChatDatabase({factory, directory: dir, now, migrations: tampered});
    expect(result).toMatchObject({mode: 'recovery', reason: 'checksum-mismatch'});
    await result.db?.close();
  });
});
