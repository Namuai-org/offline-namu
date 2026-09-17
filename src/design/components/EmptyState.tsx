import React from 'react';
import {View} from 'react-native';
import {NamuIcon, type IconName} from '../icons/NamuIcon';
import {useNamuTheme} from '../theme';
import {spacing} from '../tokens';
import {NamuButton} from './NamuButton';
import {NamuText} from './NamuText';

export function EmptyState({
  icon,
  title,
  message,
  action,
  children,
  testID,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  action?: {label: string; onPress: () => void; icon?: IconName};
  children?: React.ReactNode;
  testID?: string;
}): React.JSX.Element {
  const {colors} = useNamuTheme();
  return (
    <View testID={testID} style={{alignItems: 'center', gap: spacing.md, padding: spacing.xl}}>
      {icon ? <NamuIcon name={icon} size={40} color={colors.textSecondary} /> : null}
      <NamuText variant="title" align="center" accessibilityRole="header">
        {title}
      </NamuText>
      {message ? (
        <NamuText tone="secondary" align="center">
          {message}
        </NamuText>
      ) : null}
      {children}
      {action ? <NamuButton label={action.label} icon={action.icon} onPress={action.onPress} /> : null}
    </View>
  );
}
