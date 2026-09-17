import React, {useEffect, useMemo, useRef} from 'react';
import {
  Animated,
  BackHandler,
  Easing,
  Keyboard,
  PanResponder,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import {useReduceMotion} from '../motion';
import {useNamuTheme} from '../theme';
import {motion} from '../tokens';

const MAX_WIDTH = 340;
const WIDTH_RATIO = 0.84;
/** Invisible strip at the start edge that opens the drawer by swiping. */
const EDGE_ZONE = 24;
const SCRIM_OPACITY = 0.38;

/**
 * Start-edge drawer that pushes the main content aside, the way mobile chat
 * apps present their history. Plain Animated + PanResponder: no gesture
 * library is part of the locked stack. The opening swipe only starts in a thin
 * edge strip, so it never competes with the message list or with horizontally
 * scrolling code blocks. While open, the main content is hidden from assistive
 * technology and a scrim closes the drawer on tap or drag.
 */
export function SideDrawer({
  open,
  onOpenChange,
  drawer,
  children,
  closeLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drawer: React.ReactNode;
  children: React.ReactNode;
  /** Accessible name of the scrim, e.g. "Close menu". */
  closeLabel: string;
}): React.JSX.Element {
  const {colors} = useNamuTheme();
  const reduceMotion = useReduceMotion();
  const {width: windowWidth} = useWindowDimensions();
  const width = Math.min(MAX_WIDTH, Math.round(windowWidth * WIDTH_RATIO));
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;
  const openRef = useRef(open);
  openRef.current = open;
  const widthRef = useRef(width);
  widthRef.current = width;
  const dragStart = useRef(0);

  const settle = (target: 0 | 1) => {
    if (reduceMotion) {
      progress.setValue(target);
    } else {
      Animated.timing(progress, {
        toValue: target,
        duration: motion.standardMs + 60,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }
  };

  useEffect(() => {
    settle(open ? 1 : 0);
    if (open) {
      Keyboard.dismiss();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reduceMotion]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onOpenChange(false);
      return true;
    });
    return () => subscription.remove();
  }, [open, onOpenChange]);

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderGrant: () => {
          dragStart.current = openRef.current ? 1 : 0;
        },
        onPanResponderMove: (_event, gesture) => {
          const next = dragStart.current + gesture.dx / widthRef.current;
          progress.setValue(Math.max(0, Math.min(1, next)));
        },
        onPanResponderRelease: (_event, gesture) => {
          const position = dragStart.current + gesture.dx / widthRef.current;
          const shouldOpen = gesture.vx > 0.35 || (gesture.vx > -0.35 && position > 0.5);
          if (shouldOpen === openRef.current) {
            settle(shouldOpen ? 1 : 0);
          } else {
            onOpenChange(shouldOpen);
          }
        },
        onPanResponderTerminate: () => settle(openRef.current ? 1 : 0),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reduceMotion],
  );

  const contentShift = progress.interpolate({inputRange: [0, 1], outputRange: [0, width]});
  const drawerShift = progress.interpolate({inputRange: [0, 1], outputRange: [-width * 0.3, 0]});
  const scrim = progress.interpolate({inputRange: [0, 1], outputRange: [0, SCRIM_OPACITY]});

  return (
    <View style={{flex: 1, backgroundColor: colors.surface}}>
      <Animated.View
        testID="drawer"
        accessibilityViewIsModal={open}
        accessibilityElementsHidden={!open}
        importantForAccessibility={open ? 'yes' : 'no-hide-descendants'}
        pointerEvents={open ? 'auto' : 'none'}
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width,
          backgroundColor: colors.surface,
          transform: [{translateX: drawerShift}],
        }}>
        {drawer}
      </Animated.View>

      <Animated.View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          transform: [{translateX: contentShift}],
          shadowColor: '#1C1410',
          shadowOpacity: 0.18,
          shadowRadius: 24,
          shadowOffset: {width: -6, height: 0},
        }}>
        <View
          style={{flex: 1}}
          accessibilityElementsHidden={open}
          importantForAccessibility={open ? 'no-hide-descendants' : 'auto'}>
          {children}
        </View>
        {open ? (
          <Animated.View {...responder.panHandlers} style={[StyleSheet.absoluteFill, {backgroundColor: '#1C1410', opacity: scrim}]}>
            <Pressable
              testID="drawer-scrim"
              accessibilityRole="button"
              accessibilityLabel={closeLabel}
              onPress={() => onOpenChange(false)}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        ) : (
          <View {...responder.panHandlers} style={{position: 'absolute', top: 0, bottom: 0, left: 0, width: EDGE_ZONE}} />
        )}
      </Animated.View>
    </View>
  );
}
