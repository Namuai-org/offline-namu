import {useEffect, useState} from 'react';
import {Keyboard, Platform} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

/** Glass frame geometry shared by the floating top bar and the screens under it. */
export const TOP_BAR_HEIGHT = 56;
/** Height of the floating glass top bar including the status-bar inset. */
export function useTopBarSpace(): number {
  return useSafeAreaInsets().top + TOP_BAR_HEIGHT;
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
