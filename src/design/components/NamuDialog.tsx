import React, {useEffect, useRef} from 'react';
import {AccessibilityInfo, ScrollView, View, findNodeHandle} from 'react-native';
import {Dialog, Portal} from 'react-native-paper';
import {useNamuTheme} from '../theme';
import {radii, sizes, spacing} from '../tokens';
import {NamuButton} from './NamuButton';
import {NamuText} from './NamuText';

export interface NamuDialogAction {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'text' | 'destructive';
  loading?: boolean;
  disabled?: boolean;
  testID?: string;
}

export interface NamuDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  children?: React.ReactNode;
  actions: NamuDialogAction[];
  onDismiss: () => void;
  /** Control that opened the dialog; focus returns to it on close (DS-005). */
  returnFocusTo?: React.RefObject<unknown>;
  dismissable?: boolean;
  testID?: string;
}

export function NamuDialog({
  visible,
  title,
  message,
  children,
  actions,
  onDismiss,
  returnFocusTo,
  dismissable = true,
  testID,
}: NamuDialogProps): React.JSX.Element {
  const {colors} = useNamuTheme();
  const wasVisible = useRef(false);

  useEffect(() => {
    if (wasVisible.current && !visible && returnFocusTo?.current) {
      const node = findNodeHandle(returnFocusTo.current as never);
      if (node) {
        AccessibilityInfo.setAccessibilityFocus(node);
      }
    }
    wasVisible.current = visible;
  }, [visible, returnFocusTo]);

  return (
    <Portal>
      <Dialog
        visible={visible}
        onDismiss={onDismiss}
        dismissable={dismissable}
        testID={testID}
        style={{
          backgroundColor: colors.surface,
          borderRadius: radii.dialog,
          maxWidth: sizes.maxContentWidth - spacing.xxl * 2,
          width: '90%',
          alignSelf: 'center',
        }}>
        <Dialog.Title>
          <NamuText variant="title" accessibilityRole="header">
            {title}
          </NamuText>
        </Dialog.Title>
        <Dialog.ScrollArea style={{borderColor: 'transparent', paddingHorizontal: 0}}>
          <ScrollView contentContainerStyle={{paddingHorizontal: spacing.xl, gap: spacing.md}}>
            {message ? <NamuText tone="secondary">{message}</NamuText> : null}
            {children}
          </ScrollView>
        </Dialog.ScrollArea>
        <View style={{padding: spacing.lg, gap: spacing.sm}}>
          {actions.map(action => (
            <NamuButton key={action.label} {...action} variant={action.variant ?? 'text'} />
          ))}
        </View>
      </Dialog>
    </Portal>
  );
}
