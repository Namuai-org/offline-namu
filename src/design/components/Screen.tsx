import React from 'react';
import {ScrollView, View, type StyleProp, type ViewStyle} from 'react-native';
import {SafeAreaView, type Edge} from 'react-native-safe-area-context';
import {useNamuTheme} from '../theme';
import {sizes, spacing} from '../tokens';

/**
 * DEV-006: one single-column layout everywhere; on larger displays the column
 * is centred with a maximum content width of 720 logical pixels. Safe areas
 * are respected; start/end rules are used instead of left/right (A11Y-002).
 */
export function Screen({
  children,
  scroll = true,
  edges = ['left', 'right'],
  contentStyle,
  footer,
  topInset = 0,
  bottomInset = 0,
  testID,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  edges?: Edge[];
  contentStyle?: StyleProp<ViewStyle>;
  footer?: React.ReactNode;
  /** Space reserved under a floating/transparent glass header. */
  topInset?: number;
  /** Extra space reserved at the bottom of the content. */
  bottomInset?: number;
  testID?: string;
}): React.JSX.Element {
  const {colors} = useNamuTheme();
  const column: ViewStyle = {
    width: '100%',
    maxWidth: sizes.maxContentWidth,
    alignSelf: 'center',
    paddingHorizontal: sizes.phonePadding,
  };
  return (
    <SafeAreaView testID={testID} edges={edges} style={{flex: 1, backgroundColor: colors.background}}>
      {scroll ? (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[
            column,
            {paddingTop: spacing.lg + topInset, paddingBottom: spacing.lg + bottomInset, gap: spacing.md},
            contentStyle,
          ]}
          scrollIndicatorInsets={{top: topInset, bottom: bottomInset}}>
          {children}
        </ScrollView>
      ) : (
        <View style={[column, {flex: 1, paddingTop: topInset, paddingBottom: bottomInset}, contentStyle]}>{children}</View>
      )}
      {footer ? <View style={[column, {paddingVertical: spacing.md, gap: spacing.sm}]}>{footer}</View> : null}
    </SafeAreaView>
  );
}
