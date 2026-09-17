import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FlatList, Pressable, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useServices} from '../../app/ServicesContext';
import {useAppStore, useChatViewStore} from '../../app/stores';
import {CONVERSATION_PAGE_SIZE} from '../../data/repositories/ConversationRepository';
import {SEARCH_MIN_CHARACTERS} from '../../data/search/ftsQuery';
import type {ConversationListItem, SearchHit} from '../../data/types';
import {validateRename} from '../../domain/chat/title';
import {ActionSheet, type ActionSheetItem} from '../../design/components/ActionSheet';
import {EmptyState} from '../../design/components/EmptyState';
import {GlassHeader} from '../../design/components/GlassHeader';
import {NamuDialog} from '../../design/components/NamuDialog';
import {NamuIconButton} from '../../design/components/NamuIconButton';
import {NamuText} from '../../design/components/NamuText';
import {NamuTextField} from '../../design/components/NamuTextField';
import {StatusNotice} from '../../design/components/StatusNotice';
import {NamuIcon} from '../../design/icons/NamuIcon';
import {markdownToPlainText} from '../../design/markdown/parseMarkdown';
import {useTabBarSpace, useTopBarSpace} from '../../design/layout';
import {useNamuTheme} from '../../design/theme';
import {sizes, spacing} from '../../design/tokens';
import {useDebounced, useFormatters} from '../shared/hooks';
import {ReturnToAnswerBanner} from '../shared/ReturnToAnswerBanner';
import {useExport} from '../shared/useExport';

/** DB-005 */
const SEARCH_DEBOUNCE_MS = 250;

/** S05 — Conversations: newest first, local search, rename/export/delete. */
export function ConversationsScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const {colors} = useNamuTheme();
  const navigation = useNavigation();
  const services = useServices();
  const format = useFormatters();
  const exporter = useExport();
  const version = useAppStore(s => s.conversationsVersion);
  const readOnly = useAppStore(s => s.databaseMode === 'recovery');
  const openChat = useChatViewStore(s => s.open);
  const currentChatId = useChatViewStore(s => s.conversationId);

  const [items, setItems] = useState<ConversationListItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebounced(query, SEARCH_DEBOUNCE_MS);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [menuFor, setMenuFor] = useState<ConversationListItem | null>(null);
  const [renaming, setRenaming] = useState<ConversationListItem | null>(null);
  const [renameText, setRenameText] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ConversationListItem | null>(null);
  const [working, setWorking] = useState(false);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const loading = useRef(false);
  const topSpace = useTopBarSpace();
  const tabSpace = useTabBarSpace();

  const reload = useCallback(async () => {
    if (!services.conversations) {
      return;
    }
    try {
      const page = await services.conversations.listPage(null);
      setItems(page);
      setHasMore(page.length === CONVERSATION_PAGE_SIZE);
    } catch {
      // the database went away (data deletion in progress)
    }
  }, [services]);

  useEffect(() => {
    void reload();
  }, [reload, version]);

  useEffect(() => navigation.addListener('focus', () => void reload()), [navigation, reload]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!hasMore || !last || loading.current || !services.conversations) {
      return;
    }
    loading.current = true;
    try {
      // DB-004 keyset page of 30 on (updated_at, id).
      const page = await services.conversations.listPage({updatedAt: last.updatedAt, id: last.id});
      setItems(current => [...current, ...page]);
      setHasMore(page.length === CONVERSATION_PAGE_SIZE);
    } catch {
      // keep what is already listed
    } finally {
      loading.current = false;
    }
  };

  // Local search: starts after two characters, debounced 250 ms (DB-005).
  useEffect(() => {
    let cancelled = false;
    const trimmed = debouncedQuery.trim();
    if (Array.from(trimmed).length < SEARCH_MIN_CHARACTERS || !services.search) {
      setHits(null);
      return;
    }
    void services.search
      .search(trimmed)
      .then(result => {
        if (!cancelled) {
          setHits(result);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, services, version]);

  const open = (conversationId: string, ordinal: number | null = null) => {
    openChat(conversationId, ordinal);
    navigation.navigate('Tabs', {screen: 'Chat'});
  };

  const submitRename = async () => {
    if (!renaming || !services.conversations) {
      return;
    }
    const result = validateRename(renameText);
    if (!result.ok) {
      setRenameError(t(result.reason === 'empty' ? 'conversations.renameEmpty' : 'conversations.renameTooLong'));
      return;
    }
    try {
      await services.conversations.rename(renaming.id, result.title);
    } catch {
      setRenameError(t('errors.STORAGE_WRITE_FAILED.title'));
      return;
    }
    setRenaming(null);
    useAppStore.getState().touchConversations();
  };

  const confirmDelete = async () => {
    if (!deleting || !services.conversations) {
      return;
    }
    setWorking(true);
    try {
      // S05/T22: the active generating conversation is not deleted until the
      // stop has been acknowledged.
      if (services.chat.isGeneratingIn(deleting.id)) {
        const stopped = await services.chat.quiesce();
        if (!stopped) {
          setDeleteNotice(t('conversations.deleteDeferred'));
          return;
        }
      }
      await services.conversations.delete(deleting.id);
      await services.database?.checkpointTruncate().catch(() => undefined); // SEC-007
      if (currentChatId === deleting.id) {
        openChat(null);
        void services.setPreference('lastConversationId', null);
      }
      useAppStore.getState().touchConversations();
    } catch {
      setDeleteNotice(t('errors.STORAGE_WRITE_FAILED.title'));
    } finally {
      setWorking(false);
      setDeleting(null);
    }
  };

  const renderItem = ({item}: {item: ConversationListItem}) => (
    <View style={{flexDirection: 'row', alignItems: 'center'}}>
      <Pressable
        testID={`conversation-${item.id}`}
        onPress={() => open(item.id)}
        accessibilityRole="button"
        accessibilityLabel={`${item.title}. ${format.dateTime(item.updatedAt)}. ${markdownToPlainText(item.preview, 80)}`}
        style={({pressed}) => ({flex: 1, paddingVertical: spacing.md, gap: 2, opacity: pressed ? 0.6 : 1, minHeight: sizes.touchTarget})}>
        <View style={{flexDirection: 'row', gap: spacing.sm, alignItems: 'baseline'}}>
          <NamuText weight="semibold" numberOfLines={1} style={{flex: 1}}>
            {item.title}
          </NamuText>
          <NamuText variant="label" tone="secondary">
            {format.dateTime(item.updatedAt)}
          </NamuText>
        </View>
        <NamuText variant="label" tone="secondary" numberOfLines={2}>
          {markdownToPlainText(item.preview)}
        </NamuText>
      </Pressable>
      <NamuIconButton
        icon="more_vert"
        label={t('conversations.menu', {title: item.title})}
        onPress={() => setMenuFor(item)}
        testID={`conversation-menu-${item.id}`}
      />
    </View>
  );

  const menuItems: ActionSheetItem[] = menuFor
    ? [
        ...(readOnly
          ? []
          : [
              {
                key: 'rename',
                label: t('conversations.rename'),
                icon: 'edit' as const,
                testID: 'menu-rename',
                onPress: () => {
                  setRenameText(menuFor.title);
                  setRenameError(null);
                  setRenaming(menuFor);
                  setMenuFor(null);
                },
              },
            ]),
        {
          key: 'export',
          label: t('conversations.export'),
          icon: 'ios_share' as const,
          testID: 'menu-export',
          onPress: () => {
            exporter.request({kind: 'conversation', id: menuFor.id});
            setMenuFor(null);
          },
        },
        ...(readOnly
          ? []
          : [
              {
                key: 'delete',
                label: t('conversations.delete'),
                icon: 'delete' as const,
                destructive: true,
                testID: 'menu-delete',
                onPress: () => {
                  setDeleting(menuFor);
                  setMenuFor(null);
                },
              },
            ]),
      ]
    : [];

  const kindLabel = {title: t('conversations.inTitle'), user: t('conversations.inYou'), assistant: t('conversations.inNamu')};
  const renderHit = ({item}: {item: SearchHit}) => (
    <Pressable
      onPress={() => open(item.conversationId, item.ordinal)}
      accessibilityRole="button"
      style={({pressed}) => ({paddingVertical: spacing.md, gap: 2, opacity: pressed ? 0.6 : 1, minHeight: sizes.touchTarget})}>
      <NamuText weight="semibold" numberOfLines={1}>
        {item.conversationTitle}
      </NamuText>
      <NamuText variant="label" tone="secondary" numberOfLines={2}>
        {kindLabel[item.kind]} · {item.snippet}
      </NamuText>
    </Pressable>
  );

  const separator = () => <View style={{height: 1, backgroundColor: colors.surfaceAlt}} />;

  return (
    <SafeAreaView edges={['left', 'right']} style={{flex: 1, backgroundColor: colors.background}} testID="conversations-screen">
      <View style={{flex: 1, width: '100%', maxWidth: sizes.maxContentWidth, alignSelf: 'center', paddingHorizontal: sizes.phonePadding, gap: spacing.sm}}>
        <View style={{height: topSpace}} />
        <ReturnToAnswerBanner />
        {deleteNotice ? <StatusNotice tone="error" message={deleteNotice} testID="conversations-notice" /> : null}
        <NamuTextField
          testID="conversation-search"
          label={t('conversations.searchLabel')}
          showLabel={false}
          placeholder={t('conversations.searchPlaceholder')}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          returnKeyType="search"
          leading={<NamuIcon name="search" color={colors.textSecondary} />}
          trailing={query.length > 0 ? <NamuIconButton icon="close" label={t('common.close')} onPress={() => setQuery('')} /> : undefined}
        />
        {hits !== null ? (
          <FlatList
            data={hits}
            keyExtractor={(hit, index) => `${hit.conversationId}-${hit.turnId ?? 'title'}-${hit.kind}-${index}`}
            renderItem={renderHit}
            ItemSeparatorComponent={separator}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{paddingBottom: tabSpace}}
            ListEmptyComponent={<EmptyState icon="search" title={t('conversations.noResults', {query: debouncedQuery.trim()})} />}
          />
        ) : (
          <FlatList
            data={items}
            keyExtractor={item => item.id}
            renderItem={renderItem}
            ItemSeparatorComponent={separator}
            onEndReached={() => void loadMore()}
            onEndReachedThreshold={0.5}
            contentContainerStyle={{paddingBottom: tabSpace}}
            keyboardShouldPersistTaps="handled"
            ListEmptyComponent={
              <EmptyState
                icon="forum"
                testID="conversations-empty"
                title={t('conversations.emptyTitle')}
                message={t('conversations.emptyBody')}
                action={{
                  label: t('chat.newChat'),
                  icon: 'edit_square',
                  onPress: () => {
                    openChat(null);
                    navigation.navigate('Tabs', {screen: 'Chat'});
                  },
                }}
              />
            }
          />
        )}
      </View>

      {/* S05 overflow menu: Rename, Export conversation, Delete. */}
      <ActionSheet
        visible={menuFor !== null}
        title={menuFor?.title ?? ''}
        cancelLabel={t('common.cancel')}
        onDismiss={() => setMenuFor(null)}
        items={menuItems}
      />
      <GlassHeader
        title={t('conversations.title')}
        end={
          <NamuIconButton
            icon="edit_square"
            label={t('chat.newChat')}
            onPress={() => {
              openChat(null);
              navigation.navigate('Tabs', {screen: 'Chat'});
            }}
          />
        }
      />
      <NamuDialog
        visible={renaming !== null}
        title={t('conversations.renameTitle')}
        onDismiss={() => setRenaming(null)}
        actions={[
          {label: t('common.save'), variant: 'primary', onPress: () => void submitRename(), testID: 'rename-save'},
          {label: t('common.cancel'), onPress: () => setRenaming(null)},
        ]}>
        <NamuTextField
          testID="rename-input"
          label={t('conversations.renameLabel')}
          value={renameText}
          onChangeText={value => {
            setRenameText(value);
            setRenameError(null);
          }}
          error={renameError}
          autoFocus
        />
      </NamuDialog>
      <NamuDialog
        visible={deleting !== null}
        title={t('conversations.deleteTitle')}
        message={
          deleting
            ? [
                t('conversations.deleteBody', {title: deleting.title}),
                services.chat.isGeneratingIn(deleting.id) ? t('conversations.deleteStopFirst') : null,
              ]
                .filter(Boolean)
                .join('\n\n')
            : undefined
        }
        dismissable={!working}
        onDismiss={() => setDeleting(null)}
        actions={[
          {label: t('conversations.delete'), variant: 'destructive', loading: working, onPress: () => void confirmDelete(), testID: 'delete-confirm'},
          {label: t('common.cancel'), disabled: working, onPress: () => setDeleting(null)},
        ]}
      />
      {exporter.dialogs}
    </SafeAreaView>
  );
}
