import React, {useCallback} from 'react';
import {useNavigation} from '@react-navigation/native';
import {useTranslation} from 'react-i18next';
import {SideDrawer} from '../design/components/SideDrawer';
import {ChatScreen} from '../features/chat/ChatScreen';
import {ConversationsPanel} from '../features/conversations/ConversationsPanel';
import {useDrawerStore} from './stores';

/**
 * PA-007: the chat owns the whole screen; history, search and Settings live in
 * a start-edge drawer instead of bottom tabs.
 */
export function HomeScreen(): React.JSX.Element {
  const {t} = useTranslation();
  const navigation = useNavigation();
  const open = useDrawerStore(s => s.open);
  const setOpen = useDrawerStore(s => s.setOpen);
  const close = useCallback(() => setOpen(false), [setOpen]);

  return (
    <SideDrawer
      open={open}
      onOpenChange={setOpen}
      closeLabel={t('chat.closeMenu')}
      drawer={
        <ConversationsPanel
          visible={open}
          onClose={close}
          onOpenSettings={() => {
            close();
            navigation.navigate('Settings');
          }}
        />
      }>
      <ChatScreen />
    </SideDrawer>
  );
}
