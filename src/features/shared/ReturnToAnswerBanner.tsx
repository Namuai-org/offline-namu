import React from 'react';
import {StackActions, useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {useChatSessionStore, useChatViewStore} from '../../app/stores';
import {StatusNotice} from '../../design/components/StatusNotice';

/**
 * CHAT-006: an active foreground generation stays owned by its original
 * conversation while the user browses elsewhere; this banner leads back.
 * `currentConversationId` is `undefined` on non-chat screens.
 */
export function ReturnToAnswerBanner({
  currentConversationId,
  onNavigate,
}: {
  currentConversationId?: string | null;
  /** Called after the chat was switched, e.g. to close the drawer. */
  onNavigate?: () => void;
}): React.JSX.Element | null {
  const {t} = useTranslation();
  const navigation = useNavigation();
  const active = useChatSessionStore(s => s.session.active);
  const open = useChatViewStore(s => s.open);
  if (!active || active.conversationId === null) {
    return null;
  }
  if (currentConversationId !== undefined && currentConversationId === active.conversationId) {
    return null;
  }
  const target = active.conversationId;
  return (
    <StatusNotice
      tone="info"
      testID="return-to-answer"
      message={t('chat.returnToAnswer')}
      action={{
        label: t('chat.returnAction'),
        onPress: () => {
          open(target);
          onNavigate?.();
          navigation.dispatch(StackActions.popTo('Home'));
        },
      }}
    />
  );
}
