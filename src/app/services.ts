import {Platform} from 'react-native';
import {Database} from '../data/Database';
import {DIAGNOSTICS_DB_NAME, DiagnosticsStore} from '../data/diagnostics/DiagnosticsStore';
import type {SqlDriverFactory} from '../data/driver';
import {openChatDatabase} from '../data/openChatDatabase';
import {ChatRepository} from '../data/repositories/ChatRepository';
import {ConversationRepository} from '../data/repositories/ConversationRepository';
import {DraftRepository} from '../data/repositories/DraftRepository';
import {PreferencesRepository, defaultPreferences, type Preferences} from '../data/repositories/PreferencesRepository';
import {SearchRepository} from '../data/repositories/SearchRepository';
import {ChatSessionController} from '../domain/chat/ChatSessionController';
import {EngineOwnership} from '../domain/inference/EngineOwnership';
import type {NamuEngine} from '../domain/inference/InferenceEngine';
import {resolveParameters} from '../domain/inference/productionConfig';
import {ModelInstallController} from '../domain/model/ModelInstallController';
import type {AppInfo, DeviceService, ExportService, TransferService} from '../domain/model/services';
import {i18n, initI18n} from '../locales/i18n';
import {useAppStore, useChatSessionStore, useChatViewStore, useTransferStore} from './stores';

export interface AppServices {
  info: AppInfo;
  device: DeviceService;
  transfer: TransferService;
  exporter: ExportService;
  database: Database | null;
  databaseMode: 'normal' | 'recovery';
  chatRepository: ChatRepository | null;
  conversations: ConversationRepository | null;
  drafts: DraftRepository | null;
  preferences: PreferencesRepository | null;
  search: SearchRepository | null;
  diagnostics: DiagnosticsStore | null;
  engine: NamuEngine;
  ownership: EngineOwnership;
  chat: ChatSessionController;
  install: ModelInstallController;
  /** Persists a preference and mirrors it for the UI. */
  setPreference<K extends keyof Preferences>(key: K, value: Preferences[K]): Promise<void>;
  /** SEC-006 Delete all Namu data. Resolves false when deletion was deferred. */
  deleteAllData(): Promise<boolean>;
  announce(message: string): void;
  /** Folds the SQLite journals at a quiet moment (answer ended, app backgrounded). */
  trimJournals(): Promise<void>;
  /** Detaches native listeners; called before services are rebuilt (SEC-006 restart). */
  dispose(): void;
}

export interface PlatformAdapters {
  device: DeviceService;
  transfer: TransferService;
  createExporter(chatDataDirectory: string): ExportService;
  sqlite: SqlDriverFactory;
  createEngine(options: {
    info: AppInfo;
    logicalCpuCount: number;
    transfer: TransferService;
    diagnostics: {record(code: string, fields?: Record<string, number | string | boolean | null | undefined>): void};
  }): NamuEngine | Promise<NamuEngine>;
  announce(message: string): void;
}

/**
 * Composition root (src/app, PRD section 4). Everything that touches native
 * code arrives through `adapters`, so tests and simulator journeys can supply
 * fakes (QA-004). No network call exists anywhere on this path (ARC-004,
 * NFR-012): the transfer service only talks to the network on explicit user
 * actions.
 */
export async function createAppServices(adapters: PlatformAdapters): Promise<AppServices> {
  const {device, transfer} = adapters;
  const info = device.info();
  const now = () => Date.now();

  // Chat history first: nothing below may delay reading chats (DL-014).
  const directory = await device.prepareChatDataDirectory();
  const opened = await openChatDatabase({factory: adapters.sqlite, directory, now});
  const database = opened.db;
  const writable = opened.mode === 'normal' && database !== null;

  const chatRepository = database ? new ChatRepository(database) : null;
  const conversations = database ? new ConversationRepository(database) : null;
  const drafts = database ? new DraftRepository(database) : null;
  const preferencesRepo = database ? new PreferencesRepository(database) : null;
  const search = database ? new SearchRepository(database) : null;

  const locales = device.preferredLocales();
  let preferences: Preferences;
  try {
    preferences = preferencesRepo ? await preferencesRepo.load(locales) : defaultPreferences(locales);
  } catch {
    preferences = defaultPreferences(locales);
  }
  await initI18n(preferences.appLanguage);

  // CHAT-003: in-flight attempts from a previous process become interrupted.
  if (writable && chatRepository) {
    await chatRepository.recoverInterruptedAttempts(now()).catch(() => undefined);
  }

  let diagnostics: DiagnosticsStore | null = null;
  try {
    const driver = await adapters.sqlite.open(directory, DIAGNOSTICS_DB_NAME);
    diagnostics = await DiagnosticsStore.open(driver, d => Database.open(d), now);
  } catch {
    diagnostics = null;
  }
  const baseFields = {
    appVersion: info.appVersion,
    appBuild: info.appBuild,
    osName: info.osName,
    osVersion: info.osVersion,
    deviceModel: info.deviceModel,
  };
  const record = (code: string, fields: Record<string, number | string | boolean | null | undefined> = {}) => {
    void diagnostics?.record(code, {...baseFields, ...fields});
  };

  const profile = await device.profile().catch(() => null);
  const logicalCpuCount = profile?.logicalCpuCount ?? 4;
  const platform = Platform.OS === 'ios' ? 'ios' : 'android';
  const engine = await adapters.createEngine({info, logicalCpuCount, transfer, diagnostics: {record}});
  const ownership = new EngineOwnership();

  const setPreference = async <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    useAppStore.getState().patchPreferences({[key]: value} as Partial<Preferences>);
    if (writable && preferencesRepo) {
      await preferencesRepo.set(key, value);
    }
    if (key === 'appLanguage') {
      await i18n.changeLanguage(value as string);
    }
  };

  // ERR-001: a marker that survived the previous process means the native load
  // took the process down. Start in safe mode; never auto-load.
  const safeModeAtStart = preferences.nativeLoadMarker !== null;
  if (safeModeAtStart) {
    record('engine.load.crashMarker', {reason: 'process-ended-during-load'});
  }
  const loadMarker = {
    set: async (artifactSha256: string) => {
      if (writable && preferencesRepo) {
        await preferencesRepo.set('nativeLoadMarker', {startedAt: now(), artifactSha256});
      }
    },
    clear: async () => {
      if (writable && preferencesRepo) {
        await preferencesRepo.set('nativeLoadMarker', null);
      }
    },
  };

  // The install controller needs the chat controller lazily (they reference each other).
  const lazy: {chat: ChatSessionController | null} = {chat: null};
  const install = new ModelInstallController({
    transfer,
    engine,
    ownership,
    chat: () => lazy.chat!,
    loadMarker,
    diagnostics: {record},
  });

  const chat = new ChatSessionController({
    engine,
    ownership,
    // In recovery mode there is no writable repository; sends are refused upstream.
    chat: chatRepository as ChatRepository,
    conversations: conversations as ConversationRepository,
    installedArtifact: () => (writable ? install.installedArtifact() : null),
    defaultResponseLanguage: () => useAppStore.getState().preferences?.responseLanguage ?? 'auto',
    parameters: resolveParameters(platform, logicalCpuCount),
    newId: () => device.randomUUID(),
    now,
    loadMarker,
    diagnostics: {record},
    onSuccessfulAnswer: () => void transfer.noteSuccessfulForegroundSession().catch(() => undefined),
    onActiveLoadFailed: artifactId => install.handleActiveLoadFailure(artifactId),
    // A11Y-001: announced once per generation, never per token.
    onAnswering: () => adapters.announce(i18n.t('chat.announceAnswering')),
    onTerminal: status => {
      adapters.announce(i18n.t(status === 'complete' ? 'chat.announceComplete' : 'chat.announceInterrupted'));
      // DS-004: haptics only on terminal success/error, never per token.
      device.haptic(status === 'complete' ? 'success' : status === 'stopped' ? 'action' : 'error');
      useAppStore.getState().touchConversations();
      void trimJournals();
    },
    safeModeAtStart,
  });

  lazy.chat = chat;

  // The answer is committed by now; folding the journals here keeps the
  // on-device chat size honest and costs nothing the user can feel.
  async function trimJournals(): Promise<void> {
    if (writable) {
      await database?.checkpointTruncate().catch(() => undefined);
    }
    await diagnostics?.checkpointTruncate().catch(() => undefined);
  }

  // Mirrors for the UI.
  useAppStore.getState().setPreferences(preferences);
  useAppStore.getState().setDatabaseMode(opened.mode);
  useChatSessionStore.getState().setSession(chat.getState());
  chat.subscribe(state => useChatSessionStore.getState().setSession(state));
  install.subscribe(snapshot => useTransferStore.getState().setSnapshot(snapshot));
  await install.start().catch(() => undefined);

  // INF-007: native memory/thermal events reach the controller even when no
  // React screen is mounted — subscriptions live here, not in components.
  const unsubscribeMemory = device.onMemoryPressure(level => chat.onMemoryPressure(level));
  const unsubscribeThermal = device.onThermalState(state => chat.onThermalState(state));
  device.thermalState().then(state => chat.onThermalState(state)).catch(() => undefined);

  // PA-007: a launch opens a fresh chat; history is one swipe away in the
  // drawer. (UX-001's "reopen the last viewed conversation" is withdrawn.)
  useChatViewStore.getState().open(null);

  const exporter = adapters.createExporter(directory);
  void exporter.sweep().catch(() => undefined); // SEC-005

  const deleteAllData = async (): Promise<boolean> => {
    // SEC-006: cancel transfers, await inference shutdown, then remove
    // DB/journal/models/exports/preferences. Never delete mmap'd files that a
    // running engine may still use.
    const quiet = await chat.quiesce();
    if (!quiet) {
      return false;
    }
    const current = install.snapshot().transfer;
    if (current) {
      await transfer.cancel(current.transferId).catch(() => undefined);
    }
    await transfer.deleteAllTransferData();
    await exporter.deleteAll().catch(() => undefined);
    await diagnostics?.close().catch(() => undefined);
    await database?.close().catch(() => undefined);
    await device.deleteChatData();
    return true;
  };

  return {
    info,
    device,
    transfer,
    exporter,
    database,
    databaseMode: opened.mode,
    chatRepository: writable || database ? chatRepository : null,
    conversations,
    drafts: writable ? drafts : null,
    preferences: preferencesRepo,
    search,
    diagnostics,
    engine,
    ownership,
    chat,
    install,
    setPreference,
    deleteAllData,
    announce: adapters.announce,
    trimJournals,
    dispose: () => {
      unsubscribeMemory();
      unsubscribeThermal();
      install.stop();
    },
  };
}
