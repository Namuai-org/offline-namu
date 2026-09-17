import type {Database} from '../Database';
import type {SqlDriver} from '../driver';

/**
 * OBS-001: bounded local diagnostic ring — at most 5 MiB and seven days.
 * Lives in its own database file, never uploaded automatically.
 *
 * Privacy is enforced structurally: only allow-listed field names are stored,
 * values must be numbers, booleans or short code-like strings. Free text,
 * message/conversation IDs, headers and paths cannot pass `sanitize`.
 */
export const DIAGNOSTICS_DB_NAME = 'namu-diagnostics.sqlite';
export const DIAGNOSTICS_MAX_BYTES = 5 * 1024 * 1024;
export const DIAGNOSTICS_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

const ALLOWED_FIELDS = new Set([
  'appVersion', 'appBuild', 'runtimeBuildId', 'artifactVersion', 'artifactDigestPrefix',
  'promptVersion', 'schemaVersion', 'osName', 'osVersion', 'deviceModel', 'memoryClassGb',
  'contextTokens', 'promptTokens', 'outputTokens', 'countedTokens', 'evaluatedTokens',
  'durationMs', 'loadMs', 'formatMs', 'tokenizeMs', 'prefillMs', 'firstTokenMs', 'decodeMs',
  'stopMs', 'unloadMs', 'commitMs', 'tokensPerSecond', 'peakMemoryBytes', 'availableMemoryBytes',
  'thermalState', 'memoryLevel', 'finishReason', 'errorCode', 'phase', 'retryCount',
  'committedBytes', 'expectedBytes', 'verifiedBytes', 'freeBytes', 'gpu', 'threads',
  'batch', 'ubatch', 'gpuLayers', 'seed', 'trimmedPairs', 'includedPairs', 'reason', 'mode',
  'accepted', 'configField', 'requested', 'effective',
]);
const CODE_LIKE = /^[A-Za-z0-9_.:+-]{0,64}$/;

export type DiagnosticValue = number | boolean | string | null | undefined;
export type DiagnosticFields = Record<string, DiagnosticValue>;

export function sanitize(fields: DiagnosticFields): Record<string, number | boolean | string> {
  const clean: Record<string, number | boolean | string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(key) || value === null || value === undefined) {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      clean[key] = value;
    } else if (typeof value === 'boolean') {
      clean[key] = value;
    } else if (typeof value === 'string' && CODE_LIKE.test(value)) {
      clean[key] = value;
    }
  }
  return clean;
}

export class DiagnosticsStore {
  private constructor(private readonly db: Database, private readonly now: () => number) {}

  static async open(
    driver: SqlDriver,
    openDatabase: (d: SqlDriver) => Promise<Database>,
    now: () => number,
  ): Promise<DiagnosticsStore> {
    const db = await openDatabase(driver);
    await db.write(async tx => {
      await tx.execute(
        `CREATE TABLE IF NOT EXISTS events (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ts INTEGER NOT NULL,
           code TEXT NOT NULL,
           payload TEXT NOT NULL,
           size INTEGER NOT NULL)`,
      );
      await tx.execute('CREATE INDEX IF NOT EXISTS events_ts ON events(ts)');
    });
    return new DiagnosticsStore(db, now);
  }

  /** Never throws: diagnostics must not break the product path. */
  async record(code: string, fields: DiagnosticFields = {}): Promise<void> {
    if (!CODE_LIKE.test(code)) {
      return;
    }
    try {
      const payload = JSON.stringify(sanitize(fields));
      const ts = this.now();
      await this.db.write(async tx => {
        await tx.execute('INSERT INTO events (ts, code, payload, size) VALUES (?, ?, ?, ?)', [
          ts,
          code,
          payload,
          payload.length + code.length + 24,
        ]);
        await tx.execute('DELETE FROM events WHERE ts < ?', [ts - DIAGNOSTICS_MAX_AGE_MS]);
        const total = await tx.execute('SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM events');
        if (Number(total.rows[0]!.bytes) > DIAGNOSTICS_MAX_BYTES) {
          const drop = Math.max(1, Math.floor(Number(total.rows[0]!.n) / 10));
          await tx.execute(
            'DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id ASC LIMIT ?)',
            [drop],
          );
        }
      });
    } catch {
      // intentionally ignored
    }
  }

  /** Text shown in the Help preview before the user chooses to share it (S08/S09). */
  async exportText(limit = 500): Promise<string> {
    const {rows} = await this.db.read('SELECT ts, code, payload FROM events ORDER BY id DESC LIMIT ?', [limit]);
    return rows
      .map(row => `${new Date(Number(row.ts)).toISOString()} ${String(row.code)} ${String(row.payload)}`)
      .join('\n');
  }

  async clear(): Promise<void> {
    await this.db.write(tx => tx.execute('DELETE FROM events').then(() => undefined));
  }

  /** Trims the ring's journal at quiet moments; never blocks a recording. */
  checkpointTruncate(): Promise<void> {
    return this.db.checkpointTruncate();
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
