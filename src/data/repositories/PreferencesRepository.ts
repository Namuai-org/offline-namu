import type {Database} from '../Database';
import type {ResponseLanguage} from '../types';

export type AppLanguage = 'ha' | 'fr' | 'en';
export const APP_LANGUAGES: readonly AppLanguage[] = ['ha', 'fr', 'en'];
export type ThemePreference = 'system' | 'light' | 'dark';

/** DB-003 preference set. Values are stored as JSON under stable keys. */
export interface Preferences {
  appLanguage: AppLanguage;
  /** Default for new conversations; existing ones keep their own setting (S06). */
  responseLanguage: ResponseLanguage;
  theme: ThemePreference;
  meteredDownloads: boolean;
  /** S01 completed (language chosen and introduction acknowledged). */
  onboardingComplete: boolean;
  /** UX-001: reopened after launch without loading the model. */
  lastConversationId: string | null;
  /** ERR-001: set durably before a native load, cleared after it returns. */
  nativeLoadMarker: {startedAt: number; artifactSha256: string} | null;
}

/** App language from the device locale if ha/fr/en, else en (DB-003). */
export function appLanguageFromLocales(locales: readonly string[]): AppLanguage {
  for (const tag of locales) {
    const primary = tag.toLowerCase().split(/[-_]/)[0];
    if (primary === 'ha' || primary === 'fr' || primary === 'en') {
      return primary;
    }
  }
  return 'en';
}

export function defaultPreferences(deviceLocales: readonly string[]): Preferences {
  return {
    appLanguage: appLanguageFromLocales(deviceLocales),
    responseLanguage: 'auto',
    theme: 'system',
    meteredDownloads: false,
    onboardingComplete: false,
    lastConversationId: null,
    nativeLoadMarker: null,
  };
}

export class PreferencesRepository {
  constructor(private readonly db: Database) {}

  async load(deviceLocales: readonly string[]): Promise<Preferences> {
    const prefs: Preferences = defaultPreferences(deviceLocales);
    const {rows} = await this.db.read('SELECT key, value_json FROM preferences');
    const target = prefs as unknown as Record<string, unknown>;
    for (const row of rows) {
      const key = String(row.key);
      if (key in prefs) {
        try {
          target[key] = JSON.parse(String(row.value_json));
        } catch {
          // keep the default for an unreadable value
        }
      }
    }
    return prefs;
  }

  set<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void> {
    return this.db.write(async tx => {
      await tx.execute(
        `INSERT INTO preferences (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
        [key, JSON.stringify(value)],
      );
    });
  }
}
