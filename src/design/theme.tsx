import React, {createContext, useContext, useMemo} from 'react';
import {useColorScheme} from 'react-native';
import {MD3DarkTheme, MD3LightTheme, PaperProvider, configureFonts, type MD3Theme} from 'react-native-paper';
import {NamuIcon, type IconName} from './icons/NamuIcon';
import {darkColors, fonts, lightColors, radii, type ColorTokens} from './tokens';

export type ThemePreference = 'system' | 'light' | 'dark';

export interface NamuTheme {
  dark: boolean;
  colors: ColorTokens;
}

const ThemeContext = createContext<NamuTheme>({dark: false, colors: lightColors});

export function useNamuTheme(): NamuTheme {
  return useContext(ThemeContext);
}

/** React Native Paper is themed exclusively through Namu tokens (PRD section 2). */
function paperTheme(theme: NamuTheme): MD3Theme {
  const base = theme.dark ? MD3DarkTheme : MD3LightTheme;
  const c = theme.colors;
  return {
    ...base,
    dark: theme.dark,
    roundness: radii.control / 4,
    fonts: configureFonts({config: {fontFamily: fonts.regular}}),
    colors: {
      ...base.colors,
      primary: c.action,
      onPrimary: c.onAction,
      primaryContainer: c.surfaceAlt,
      onPrimaryContainer: c.textPrimary,
      secondary: c.link,
      onSecondary: c.onAction,
      secondaryContainer: c.surfaceAlt,
      onSecondaryContainer: c.textPrimary,
      tertiary: c.accent,
      onTertiary: c.onAction,
      background: c.background,
      onBackground: c.textPrimary,
      surface: c.surface,
      onSurface: c.textPrimary,
      surfaceVariant: c.surfaceAlt,
      onSurfaceVariant: c.textSecondary,
      surfaceDisabled: c.surfaceAlt,
      onSurfaceDisabled: c.textSecondary,
      outline: c.outline,
      outlineVariant: c.outline,
      error: c.error,
      onError: theme.dark ? darkColors.background : lightColors.surface,
      errorContainer: c.surfaceAlt,
      onErrorContainer: c.error,
      inverseSurface: c.textPrimary,
      inverseOnSurface: c.background,
      inversePrimary: c.link,
      backdrop: 'rgba(28,20,16,0.45)',
      elevation: {
        level0: 'transparent',
        level1: c.surface,
        level2: c.surface,
        level3: c.surface,
        level4: c.surface,
        level5: c.surface,
      },
    },
  };
}

export function NamuThemeProvider({
  preference,
  children,
}: {
  preference: ThemePreference;
  children: React.ReactNode;
}): React.JSX.Element {
  const system = useColorScheme();
  const dark = preference === 'system' ? system === 'dark' : preference === 'dark';
  const theme = useMemo<NamuTheme>(() => ({dark, colors: dark ? darkColors : lightColors}), [dark]);
  const paper = useMemo(() => paperTheme(theme), [theme]);
  return (
    <ThemeContext.Provider value={theme}>
      <PaperProvider
        theme={paper}
        settings={{
          // One icon set everywhere, including inside Paper components (DS-003).
          icon: ({name, color, size}) => <NamuIcon name={name as IconName} color={color} size={size} />,
        }}>
        {children}
      </PaperProvider>
    </ThemeContext.Provider>
  );
}
