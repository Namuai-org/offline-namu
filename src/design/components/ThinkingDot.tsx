import React, {useEffect, useRef} from 'react';
import {Animated, Easing} from 'react-native';
import {useReduceMotion} from '../motion';
import {useNamuTheme} from '../theme';

/** The quiet pulsing dot shown while the answer has not started yet. */
export function ThinkingDot({size = 14}: {size?: number}): React.JSX.Element {
  const {colors} = useNamuTheme();
  const reduceMotion = useReduceMotion();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {toValue: 1, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true}),
        Animated.timing(pulse, {toValue: 0, duration: 650, easing: Easing.inOut(Easing.quad), useNativeDriver: true}),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);

  return (
    <Animated.View
      accessible={false}
      importantForAccessibility="no"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.textPrimary,
        opacity: pulse.interpolate({inputRange: [0, 1], outputRange: [0.35, 1]}),
        transform: [{scale: pulse.interpolate({inputRange: [0, 1], outputRange: [0.8, 1.1]})}],
      }}
    />
  );
}
