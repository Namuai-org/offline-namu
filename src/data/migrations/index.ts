import {MIGRATION_001_STATEMENTS} from './001_initial';

export interface Migration {
  readonly version: number;
  readonly name: string;
  /** SHA-256 of statements.join(';\n'), locked by tests/data/migrations.test.ts. */
  readonly checksum: string;
  readonly statements: readonly string[];
}

/** Ordered, append-only (DB-006). */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    checksum: 'a4d44f640558dc123969f5e1eb527b3e0f886a2f2626b3e82d0a1e52ff8d7bc0',
    statements: MIGRATION_001_STATEMENTS,
  },
];

export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function migrationSource(migration: Migration): string {
  return migration.statements.join(';\n');
}
