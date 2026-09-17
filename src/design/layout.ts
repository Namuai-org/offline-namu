import {useEffect, useState} from 'react';
import {Keyboard, Platform} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {spacing} from './tokens';

/** Glass frame geometry shared by the floating bars and the screens under them. */
export const TOP_BAR_HEIGHT = 56;
export const TAB_BAR_HEIGHT = 64;
export const TAB_BAR_MARGIN = spacing.md;

/** Height of the floating glass top bar including the status-bar inset. */
export function useTopBarSpace(): number {
  return useSafeAreaInsets().top + TOP_BAR_HEIGHT;
}

/** Space the floating glass tab bar occupies at the bottom of tab screens. */
export function useTabBarSpace(): number {
  const {bottom} = useSafeAreaInsets();
  return TAB_BAR_HEIGHT + TAB_BAR_MARGIN + Math.max(bottom, TAB_BAR_MARGIN);
}

export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide', () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
