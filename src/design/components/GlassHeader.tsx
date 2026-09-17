import React from 'react';
import {View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {TOP_BAR_HEIGHT} from '../layout';
import {sizes, spacing} from '../tokens';
import {GlassSurface} from './GlassSurface';
import {NamuText} from './NamuText';

/**
 * Floating glass top bar for the tab screens: centred title, optional quiet
 * badge under it, and up to one control on each side. Content scrolls
 * beneath it.
 */
export function GlassHeader({
  title,
  badge,
  start,
  end,
}: {
  title: string;
  badge?: React.ReactNode;
  start?: React.ReactNode;
  end?: React.ReactNode;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View
      pointerEvents="box-none"
      style={{position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10, alignItems: 'center'}}>
      <GlassSurface
        radius={0}
        style={{alignSelf: 'stretch'}}
        contentStyle={{
          borderTopWidth: 0,
          borderLeftWidth: 0,
          borderRightWidth: 0,
          paddingTop: insets.top,
        }}>
        <View
          style={{
            height: TOP_BAR_HEIGHT,
            width: '100%',
            maxWidth: sizes.maxContentWidth,
            alignSelf: 'center',
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: spacing.sm,
          }}>
          <View style={{minWidth: sizes.touchTarget * 2, flexDirection: 'row', justifyContent: 'flex-start'}}>{start}</View>
          <View style={{flex: 1, alignItems: 'center', justifyContent: 'center'}}>
            <NamuText variant="body" weight="semibold" align="center" accessibilityRole="header" numberOfLines={1} style={{fontSize: 18}}>
              {title}
            </NamuText>
            {badge}
          </View>
          <View style={{minWidth: sizes.touchTarget * 2, flexDirection: 'row', justifyContent: 'flex-end'}}>{end}</View>
        </View>
      </GlassSurface>
    </View>
  );
}
