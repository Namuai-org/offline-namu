import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useServices} from '../../app/ServicesContext';
import {useAppStore, useChatSessionStore, useChatViewStore, useTransferStore} from '../../app/stores';
import {TURN_PAGE_SIZE} from '../../data/repositories/ChatRepository';
import {RESPONSE_LANGUAGES, type Attempt, type Conversation, type ResponseLanguage, type Turn} from '../../data/types';
import type {ProductErrorCode} from '../../domain/inference/failures';
import {ActionSheet} from '../../design/components/ActionSheet';
import {AssistantMessage, UserMessage, type AssistantAction} from '../../design/components/ChatMessage';
import {EmptyState} from '../../design/components/EmptyState';
import {NamuButton} from '../../design/components/NamuButton';
import {NamuDialog} from '../../design/components/NamuDialog';
import {NamuIconButton} from '../../design/components/NamuIconButton';
import {NamuText} from '../../design/components/NamuText';
import {StatusNotice} from '../../design/components/StatusNotice';
import {NamuIcon} from '../../design/icons/NamuIcon';
import {safeLinkHost} from '../../design/markdown/parseMarkdown';
import {useNamuTheme} from '../../design/theme';
import {sizes, spacing} from '../../design/tokens';
import {useErrorCopy} from '../shared/hooks';
import {ReturnToAnswerBanner} from '../shared/ReturnToAnswerBanner';
import {ActiveAnswer} from './ActiveAnswer';
import {Composer, type ComposerHandle} from './Composer';

/** S04: auto-scroll only within 80 logical pixels of the bottom. */
const NEAR_BOTTOM_PX = 80;
/** Errors shown as a notice above the composer (others are inline labels). */
const NOTICE_CODES: ProductErrorCode[] = [
  'MODEL_LOAD_FAILED', 'MEMORY_LOW', 'DEVICE_HOT', 'INPUT_TOO_LONG', 'STORAGE_WRITE_FAILED', 'CANCEL_TIMEOUT',
];

export function ChatScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const {colors} = useNamuTheme();
  const navigation = useNavigation();
  const services = useServices();
  const errorCopy = useErrorCopy();
  const {conversationId, targetOrdinal, nonce, open} = useChatViewStore();
  const session = useChatSessionStore(s => s.session);
  const install = useTransferStore(s => s.snapshot.install);
  const databaseMode = useAppStore(s => s.databaseMode);
  const defaultLanguage = useAppStore(s => s.preferences?.responseLanguage ?? 'auto');

  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]); // newest first (inverted list)
  const [hasOlder, setHasOlder] = useState(false);
  const [hasNewer, setHasNewer] = useState(false);
  const [newChatLanguage, setNewChatLanguage] = useState<ResponseLanguage | null>(null);
  const [languageMenu, setLanguageMenu] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [link, setLink] = useState<{href: string; host: string} | null>(null);
  const [busyDialog, setBusyDialog] = useState(false);
  const [attemptsFor, setAttemptsFor] = useState<{turn: Turn; attempts: Attempt[]} | null>(null);

  const listRef = useRef<FlatList<Turn>>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const loadToken = useRef(0);
  const readOnly = databaseMode === 'recovery';

  // ------------------------------------------------------------------ loading

  const loadLatest = useCallback(
    async (id: string) => {
      if (!services.chatRepository || !services.conversations) {
        return;
      }
      const token = ++loadToken.current;
      let meta;
      let page;
      try {
        [meta, page] = await Promise.all([
          services.conversations.get(id),
          services.chatRepository.getTurnsBefore(id, null),
        ]);
      } catch {
        return; // the database went away (data deletion in progress)
      }
      if (token !== loadToken.current) {
        return;
      }
      if (!meta) {
        open(null); // UX-001: a deleted conversation shows the empty Chat.
        return;
      }
      setConversation(meta);
      setTurns(page);
      setHasOlder(page.length === TURN_PAGE_SIZE);
      setHasNewer(false);
    },
    [open, services],
  );

  useEffect(() => {
    setShowJump(false);
    setNewChatLanguage(null);
    if (!conversationId) {
      loadToken.current++;
      setConversation(null);
      setTurns([]);
      setHasOlder(false);
      setHasNewer(false);
      return;
    }
    void services.setPreference('lastConversationId', conversationId).catch(() => undefined);
    if (targetOrdinal !== null && services.chatRepository && services.conversations) {
      // DB-005: open the matching turn from search, in a window around it.
      const token = ++loadToken.current;
      void Promise.all([
        services.conversations.get(conversationId),
        services.chatRepository.getTurnsBefore(conversationId, targetOrdinal + 6),
        services.chatRepository.getLatestTurn(conversationId),
      ]).then(([meta, page, latest]) => {
        if (token !== loadToken.current || !meta) {
          return;
        }
        setConversation(meta);
        setTurns(page);
        setHasOlder(page.length === TURN_PAGE_SIZE);
        setHasNewer(latest !== null && page[0] !== undefined && latest.ordinal > page[0].ordinal);
      }).catch(() => undefined);
      return;
    }
    void loadLatest(conversationId);
  }, [conversationId, targetOrdinal, nonce, loadLatest, services]);

  const loadOlder = async () => {
    const oldest = turns[turns.length - 1];
    if (!hasOlder || !oldest || !conversationId || !services.chatRepository) {
      return;
    }
    const page = await services.chatRepository.getTurnsBefore(conversationId, oldest.ordinal).catch(() => null);
    if (!page) {
      return;
    }
    setTurns(current => [...current, ...page.filter(p => !current.some(c => c.id === p.id))]);
    setHasOlder(page.length === TURN_PAGE_SIZE);
  };

  const loadNewer = async () => {
    const newest = turns[0];
    if (!hasNewer || !newest || !conversationId || !services.chatRepository) {
      return;
    }
    const page = await services.chatRepository.getTurnsAfter(conversationId, newest.ordinal).catch(() => null);
    if (!page) {
      return;
    }
    setTurns(current => [...page.reverse().filter(p => !current.some(c => c.id === p.id)), ...current]);
    setHasNewer(page.length === TURN_PAGE_SIZE);
  };

  // Refresh from SQLite when a generation for this conversation starts or ends.
  const activeKey = session.active ? `${session.active.attemptId}:${session.active.phase === 'preparing'}` : 'idle';
  useEffect(() => {
    if (conversationId && !hasNewer) {
      void loadLatest(conversationId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // ------------------------------------------------------------------ actions

  const activeHere =
    session.active !== null &&
    (session.active.conversationId === conversationId ||
      (session.active.conversationId === null && conversationId === null));
  const mode = !activeHere || !session.active ? 'idle' : session.active.phase;

  const send = async (text: string): Promise<boolean> => {
    services.device.haptic('action');
    const outcome = await services.chat.send(conversationId, text, {
      newConversationLanguage: newChatLanguage ?? undefined,
    });
    if (outcome.accepted) {
      useAppStore.getState().touchConversations();
      if (outcome.isNewConversation || outcome.conversationId !== conversationId) {
        open(outcome.conversationId);
      } else {
        void loadLatest(outcome.conversationId);
      }
      listRef.current?.scrollToOffset({offset: 0, animated: false});
      return true;
    }
    if (outcome.code === 'BUSY') {
      setBusyDialog(true); // CHAT-006: explicit Stop current answer
    } else if (outcome.code === 'MODEL_MISSING') {
      navigation.navigate('Setup');
    }
    return false; // the draft stays in the composer
  };

  const retry = async (turn: Turn) => {
    services.device.haptic('action');
    const outcome = await services.chat.retry(turn.conversationId, turn.id);
    if (!outcome.accepted && outcome.code === 'BUSY') {
      setBusyDialog(true);
    } else if (!outcome.accepted && outcome.code === 'MODEL_MISSING') {
      navigation.navigate('Setup');
    }
  };

  const copy = useCallback(
    (text: string) => {
      // Clipboard copying occurs only after a user action (SEC-007).
      services.device.copyToClipboard(text);
      services.device.haptic('action');
      services.announce(t('common.copied'));
    },
    [services, t],
  );

  const onLinkPress = useCallback((href: string, host: string) => setLink({href, host}), []);

  const openLink = () => {
    const target = link;
    setLink(null);
    // Only http/https ever reach here; re-checked before leaving the app.
    if (target && safeLinkHost(target.href)) {
      void Linking.openURL(target.href).catch(() => undefined);
    }
  };

  const showAttempts = async (turn: Turn) => {
    const attempts = await services.chatRepository?.getAttempts(turn.id).catch(() => null);
    if (attempts) {
      setAttemptsFor({turn, attempts});
    }
  };

  const chooseAttempt = async (turn: Turn, attempt: Attempt) => {
    await services.chatRepository?.selectAttempt(turn.id, attempt.id).catch(() => undefined);
    setAttemptsFor(null);
    void loadLatest(turn.conversationId);
  };

  const changeLanguage = (language: ResponseLanguage) => {
    setLanguageMenu(false);
    if (conversation && services.conversations && !readOnly) {
      // CTX-006: affects the next answer, not existing text.
      void services.conversations.setResponseLanguage(conversation.id, language).catch(() => undefined);
      setConversation({...conversation, responseLanguage: language});
    } else {
      setNewChatLanguage(language);
    }
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Inverted list: offset 0 is the latest message.
    setShowJump(event.nativeEvent.contentOffset.y > NEAR_BOTTOM_PX);
  };

  // ------------------------------------------------------------------- render

  const latestTurnId = hasNewer ? null : turns[0]?.id ?? null;

  const renderTurn = useCallback(
    ({item: turn}: {item: Turn}) => {
      const active = session.active;
      const streamingHere = active !== null && active.turnId === turn.id && active.attemptId !== null;
      const attempt = turn.displayAttempt;
      const isLatest = turn.id === latestTurnId;
      const unsaved = session.unsaved && attempt && session.unsaved.attemptId === attempt.id ? session.unsaved.text : null;

      let answer: React.ReactNode = null;
      if (streamingHere && active) {
        answer = (
          <View style={{gap: spacing.xs}}>
            <ActiveAnswer
              key={active.attemptId!}
              attemptId={active.attemptId!}
              initialText={attempt?.id === active.attemptId ? attempt.content : ''}
              statusLabel={active.phase === 'stopping' ? t('chat.stopping') : t('chat.answering')}
              actions={[]}
              onLinkPress={onLinkPress}
            />
            {active.contextTrimmed ? <StatusNotice tone="info" quiet message={t('chat.trimmedNotice')} /> : null}
          </View>
        );
      } else if (attempt) {
        const text = unsaved ?? attempt.content;
        let statusLabel: string | undefined;
        let statusTone: 'secondary' | 'error' = 'secondary';
        if (unsaved !== null) {
          statusLabel = t('chat.labelUnsaved');
          statusTone = 'error';
        } else if (attempt.status === 'stopped') {
          statusLabel = t('chat.labelStopped');
        } else if (attempt.status === 'interrupted') {
          statusLabel = t('chat.labelInterrupted');
        } else if (attempt.status === 'failed') {
          statusLabel = t('chat.labelFailed');
          statusTone = 'error';
        } else if (attempt.finishReason === 'length') {
          statusLabel = t('chat.labelLength'); // CTX-005 visible limit label
        }
        const actions: AssistantAction[] = [];
        if (text.length > 0) {
          actions.push({icon: 'content_copy', label: t('chat.copyAnswer'), onPress: () => copy(text)});
        }
        if (isLatest && !readOnly && session.active === null) {
          actions.push({icon: 'refresh', label: t('chat.tryAgain'), showLabel: true, onPress: () => void retry(turn), testID: 'try-again'});
        }
        if (turn.attemptCount > 1) {
          actions.push({
            icon: 'history',
            label: t('chat.earlierAnswersCount', {count: turn.attemptCount - 1}),
            showLabel: true,
            onPress: () => void showAttempts(turn),
          });
        }
        answer = (
          <AssistantMessage
            text={text}
            streaming={false}
            statusLabel={statusLabel}
            statusTone={statusTone}
            actions={actions}
            onLinkPress={onLinkPress}
          />
        );
      }

      return (
        <View style={{gap: spacing.md, paddingVertical: spacing.md}}>
          <UserMessage
            text={turn.userText}
            authorLabel={t('chat.you')}
            copyLabel={t('chat.copyMessage')}
            onCopy={() => copy(turn.userText)}
          />
          {answer}
        </View>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.active, session.unsaved, latestTurnId, readOnly, t, copy, onLinkPress],
  );

  const notice = useMemo(() => {
    if (session.blocked === 'SAFE_MODE') {
      return {code: 'MODEL_LOAD_FAILED' as ProductErrorCode, safeMode: true};
    }
    if (session.blocked === 'CANCEL_TIMEOUT') {
      return {code: 'CANCEL_TIMEOUT' as ProductErrorCode, safeMode: false};
    }
    if (session.blocked === 'DEVICE_HOT') {
      return {code: 'DEVICE_HOT' as ProductErrorCode, safeMode: false};
    }
    const last = session.lastError;
    if (last && NOTICE_CODES.includes(last.code) && (last.conversationId === conversationId || last.conversationId === null)) {
      return {code: last.code, safeMode: false};
    }
    return null;
  }, [session.blocked, session.lastError, conversationId]);

  const language = conversation?.responseLanguage ?? newChatLanguage ?? defaultLanguage;
  const modelBlocked = install.state !== 'installed' || session.blocked !== null;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{flex: 1, backgroundColor: colors.background}} testID="chat-screen">
      <KeyboardAvoidingView style={{flex: 1}} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{flex: 1, width: '100%', maxWidth: sizes.maxContentWidth, alignSelf: 'center', paddingHorizontal: sizes.phonePadding}}>
          {/* Header: Namu, quiet "On this device", answer language, new chat */}
          <View style={{flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: spacing.sm}}>
            <View style={{flex: 1}}>
              <NamuText variant="title" accessibilityRole="header" numberOfLines={1}>
                {t('chat.title')}
              </NamuText>
              <View style={{flexDirection: 'row', alignItems: 'center', gap: spacing.xs}}>
                <NamuIcon name="smartphone" size={16} color={colors.textSecondary} />
                <NamuText variant="label" tone="secondary">
                  {t('chat.onDevice')}
                </NamuText>
              </View>
            </View>
            <NamuIconButton
              icon="language"
              testID="chat-language"
              label={`${t('responseLanguage.label')}: ${t(`responseLanguage.${language}`)}`}
              onPress={() => setLanguageMenu(true)}
            />
            <NamuIconButton icon="edit_square" label={t('chat.newChat')} onPress={() => open(null)} testID="chat-new" />
          </View>

          <ReturnToAnswerBanner currentConversationId={conversationId} />
          {readOnly ? (
            <StatusNotice
              tone="warning"
              title={errorCopy('DATABASE_RECOVERY').title}
              message={t('chat.recoveryReadOnly')}
              code="DATABASE_RECOVERY"
              action={{label: errorCopy('DATABASE_RECOVERY').action, onPress: () => navigation.navigate('Privacy')}}
            />
          ) : null}
          {!readOnly && install.state === 'absent' ? (
            <StatusNotice
              tone="info"
              testID="chat-needs-setup"
              title={t('chat.needsSetupTitle')}
              message={t('chat.needsSetupBody')}
              action={{label: t('chat.needsSetupAction'), onPress: () => navigation.navigate('Setup')}}
            />
          ) : null}
          {!readOnly && install.state === 'needsRepair' ? (
            <StatusNotice
              tone="warning"
              title={t('chat.needsRepairTitle')}
              message={errorCopy('MODEL_LOAD_FAILED').body}
              action={{label: t('chat.needsRepairAction'), onPress: () => navigation.navigate('OfflineStorage')}}
            />
          ) : null}

          {turns.length === 0 && !conversationId ? (
            <View style={{flex: 1, justifyContent: 'center'}}>
              <EmptyState title={t('chat.emptyTitle')} testID="chat-empty">
                <View style={{gap: spacing.sm, alignSelf: 'stretch'}}>
                  {/* Suggestions insert an editable localized prompt; they never send (S04). */}
                  <NamuButton variant="secondary" icon="lightbulb" label={t('chat.suggestExplain')} onPress={() => composerRef.current?.insert(t('chat.promptExplain'))} testID="suggest-explain" />
                  <NamuButton variant="secondary" icon="translate" label={t('chat.suggestTranslate')} onPress={() => composerRef.current?.insert(t('chat.promptTranslate'))} />
                  <NamuButton variant="secondary" icon="summarize" label={t('chat.suggestSummarize')} onPress={() => composerRef.current?.insert(t('chat.promptSummarize'))} />
                </View>
              </EmptyState>
            </View>
          ) : (
            <View style={{flex: 1}}>
              <FlatList
                ref={listRef}
                testID="chat-list"
                data={turns}
                inverted
                keyExtractor={turn => turn.id}
                renderItem={renderTurn}
                onScroll={onScroll}
                scrollEventThrottle={100}
                onEndReached={() => void loadOlder()}
                onEndReachedThreshold={0.4}
                onStartReached={() => void loadNewer()}
                // Keeps the reading position when content is added while the
                // user has scrolled away; tokens never steal focus (S04).
                maintainVisibleContentPosition={{minIndexForVisible: 0}}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
                initialNumToRender={8}
                windowSize={9}
                removeClippedSubviews={Platform.OS === 'android'}
                ListFooterComponent={hasOlder ? <NamuText variant="label" tone="secondary" align="center">{t('chat.loadOlder')}</NamuText> : null}
              />
              {showJump || hasNewer ? (
                <View style={{position: 'absolute', bottom: spacing.sm, alignSelf: 'center'}}>
                  <NamuButton
                    testID="jump-to-latest"
                    variant="secondary"
                    icon="arrow_downward"
                    label={t('chat.jumpToLatest')}
                    style={{backgroundColor: colors.surface}}
                    onPress={() => {
                      if (hasNewer && conversationId) {
                        void loadLatest(conversationId);
                      }
                      listRef.current?.scrollToOffset({offset: 0, animated: true});
                    }}
                  />
                </View>
              ) : null}
            </View>
          )}

          {activeHere && session.active?.phase === 'preparing' ? (
            <StatusNotice tone="info" quiet message={t('chat.preparing')} />
          ) : null}
          {notice ? (
            <StatusNotice
              tone="error"
              testID={`chat-error-${notice.code}`}
              title={errorCopy(notice.code).title}
              message={errorCopy(notice.code).body}
              code={notice.code}
              action={
                notice.safeMode
                  ? {label: errorCopy('MODEL_LOAD_FAILED').action, onPress: () => services.chat.leaveSafeMode()}
                  : notice.code === 'STORAGE_WRITE_FAILED' && session.unsaved
                    ? {label: errorCopy(notice.code).action, onPress: () => copy(session.unsaved!.text)}
                    : notice.code === 'MODEL_LOAD_FAILED'
                      ? {label: t('errors.MODEL_LOAD_FAILED.secondary'), onPress: () => navigation.navigate('OfflineStorage')}
                      : undefined
              }
            />
          ) : null}

          <Composer
            ref={composerRef}
            conversationId={conversationId}
            mode={mode}
            blocked={modelBlocked && install.state === 'installed'}
            readOnly={readOnly}
            onSend={send}
            onStop={() => {
              services.device.haptic('action');
              services.chat.stop();
            }}
          />
        </View>
      </KeyboardAvoidingView>

      {/* Response-language menu: no model terminology (S06). */}
      <ActionSheet
        visible={languageMenu}
        title={t('responseLanguage.label')}
        cancelLabel={t('common.cancel')}
        onDismiss={() => setLanguageMenu(false)}
        items={RESPONSE_LANGUAGES.map(option => ({
          key: option,
          label: t(`responseLanguage.${option}`),
          icon: 'language' as const,
          selected: option === language,
          onPress: () => changeLanguage(option),
          testID: `response-language-${option}`,
        }))}
      />
      <NamuDialog
        visible={link !== null}
        title={t('chat.linkTitle')}
        message={link ? t('chat.linkBody', {host: link.host}) : undefined}
        onDismiss={() => setLink(null)}
        actions={[
          {label: t('chat.linkOpen'), variant: 'primary', onPress: openLink, testID: 'open-link-confirm'},
          {label: t('common.cancel'), onPress: () => setLink(null)},
        ]}
      />
      <NamuDialog
        visible={busyDialog}
        title={t('chat.busyTitle')}
        message={t('chat.busyBody')}
        onDismiss={() => setBusyDialog(false)}
        actions={[
          {
            label: t('chat.busyConfirm'),
            variant: 'primary',
            onPress: () => {
              setBusyDialog(false);
              services.chat.stop();
            },
          },
          {label: t('common.cancel'), onPress: () => setBusyDialog(false)},
        ]}
      />
      <NamuDialog
        visible={attemptsFor !== null}
        title={t('chat.earlierAnswers')}
        onDismiss={() => setAttemptsFor(null)}
        actions={[{label: t('common.close'), onPress: () => setAttemptsFor(null)}]}>
        {attemptsFor?.attempts.map(attempt => {
          const selected = attemptsFor.turn.selectedAttemptId === attempt.id;
          const canSelect =
            !selected && !readOnly && attemptsFor.turn.id === latestTurnId && session.active === null &&
            ['complete', 'stopped', 'interrupted'].includes(attempt.status) && attempt.content.length > 0;
          return (
            <View key={attempt.id} style={{gap: spacing.xs, paddingVertical: spacing.sm}}>
              <NamuText weight="semibold">
                {t('chat.attemptNumber', {number: attempt.attemptNumber})}
                {selected ? ` · ${t('chat.currentAnswer')}` : ''}
              </NamuText>
              <NamuText tone="secondary" numberOfLines={6} selectable>
                {attempt.content.length > 0 ? attempt.content : t('chat.labelFailed')}
              </NamuText>
              <View style={{flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm}}>
                {attempt.content.length > 0 ? (
                  <NamuButton variant="text" icon="content_copy" label={t('common.copy')} onPress={() => copy(attempt.content)} />
                ) : null}
                {/* CHAT-005: selection is read-only once a newer turn exists. */}
                {canSelect ? (
                  <NamuButton variant="text" icon="check" label={t('chat.useThisAnswer')} onPress={() => void chooseAttempt(attemptsFor.turn, attempt)} />
                ) : null}
              </View>
            </View>
          );
        })}
      </NamuDialog>
    </SafeAreaView>
  );
}
