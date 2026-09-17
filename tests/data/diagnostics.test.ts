import {Database} from '../../src/data/Database';
import {DIAGNOSTICS_MAX_AGE_MS, DiagnosticsStore, sanitize} from '../../src/data/diagnostics/DiagnosticsStore';
import {appLanguageFromLocales, defaultPreferences} from '../../src/data/repositories/PreferencesRepository';
import {memoryDriver} from '../support/NodeSqliteDriver';

describe('OBS-001 diagnostic ring', () => {
  it('stores only allow-listed, code-like fields: never text, IDs, headers or paths', () => {
    expect(
      sanitize({
        promptTokens: 120,
        errorCode: 'MEMORY_LOW',
        gpu: true,
        userText: 'my private question',
        conversationId: '5c0e…',
        reason: '/data/user/0/org.namuai.offline/files/model.gguf',
        thermalState: 'a sentence with spaces',
        authorization: 'Bearer abc',
      }),
    ).toEqual({promptTokens: 120, errorCode: 'MEMORY_LOW', gpu: true});
  });

  it('drops events older than seven days and keeps the export free of content', async () => {
    let clock = 1_000_000_000_000;
    const store = await DiagnosticsStore.open(memoryDriver(), d => Database.open(d), () => clock);
    await store.record('engine.load', {loadMs: 4200, note: 'should vanish'} as never);
    clock += DIAGNOSTICS_MAX_AGE_MS + 1;
    await store.record('generation.end', {outputTokens: 40, finishReason: 'eos'});
    const text = await store.exportText();
    expect(text).toContain('generation.end');
    expect(text).not.toContain('engine.load');
    expect(text).not.toContain('should vanish');
    await store.record('bad code with spaces', {});
    expect(await store.exportText()).not.toContain('bad code');
    await store.close();
  });
});

describe('DB-003 preference defaults', () => {
  it('uses the device language only when it is ha, fr or en', () => {
    expect(appLanguageFromLocales(['ha-NE'])).toBe('ha');
    expect(appLanguageFromLocales(['dje-NE', 'fr-NE'])).toBe('fr');
    expect(appLanguageFromLocales(['ar-EG', 'de-DE'])).toBe('en');
    expect(defaultPreferences(['fr_FR'])).toMatchObject({
      appLanguage: 'fr', responseLanguage: 'auto', theme: 'system', meteredDownloads: false,
    });
  });
});
