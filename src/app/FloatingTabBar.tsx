import React from 'react';
import {Pressable, View} from 'react-native';
import type {BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {GlassSurface} from '../design/components/GlassSurface';
import {NamuText} from '../design/components/NamuText';
import {NamuIcon, type IconName} from '../design/icons/NamuIcon';
import {TAB_BAR_HEIGHT, TAB_BAR_MARGIN, useKeyboardVisible} from '../design/layout';
import {useNamuTheme} from '../design/theme';
import {radii, sizes} from '../design/tokens';

const ICONS: Record<string, IconName> = {Chat: 'chat_bubble', Conversations: 'forum', Settings: 'settings'};

/**
 * Floating glass tab bar (UX-001: Chat, Conversations, Settings). The active
 * tab is marked by weight, colour AND a Sahel dot — never colour alone
 * (DS-005). Hidden while the keyboard is open.
 */
export function FloatingTabBar({state, descriptors, navigation}: BottomTabBarProps): React.JSX.Element | null {
  const {colors} = useNamuTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardVisible();
  if (keyboard) {
    return null;
  }
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: Math.max(insets.bottom, TAB_BAR_MARGIN),
        alignItems: 'center',
        paddingHorizontal: sizes.phonePadding,
      }}>
      <GlassSurface floating radius={radii.pill} style={{width: '100%', maxWidth: 420}}>
        <View accessibilityRole="tablist" style={{flexDirection: 'row', height: TAB_BAR_HEIGHT, alignItems: 'center'}}>
          {state.routes.map((route, index) => {
            const focused = state.index === index;
            const options = descriptors[route.key]!.options;
            const label = typeof options.title === 'string' ? options.title : route.name;
            const color = focused ? colors.textPrimary : colors.textSecondary;
            return (
              <Pressable
                key={route.key}
                testID={options.tabBarButtonTestID}
                accessibilityRole="tab"
                accessibilityState={{selected: focused}}
                accessibilityLabel={label}
                onPress={() => {
                  const event = navigation.emit({type: 'tabPress', target: route.key, canPreventDefault: true});
                  if (!focused && !event.defaultPrevented) {
                    navigation.navigate(route.name, route.params);
                  }
                }}
                style={({pressed}) => ({flex: 1, height: TAB_BAR_HEIGHT, alignItems: 'center', justifyContent: 'center', gap: 2, opacity: pressed ? 0.6 : 1})}>
                <NamuIcon name={ICONS[route.name] ?? 'chat_bubble'} color={color} />
                <NamuText variant="label" weight={focused ? 'semibold' : 'regular'} style={{color, fontSize: 12, lineHeight: 16}} numberOfLines={1}>
                  {label}
                </NamuText>
                <View style={{width: 5, height: 5, borderRadius: 3, backgroundColor: focused ? colors.accent : 'transparent'}} />
              </Pressable>
            );
          })}
        </View>
      </GlassSurface>
    </View>
  );
}
