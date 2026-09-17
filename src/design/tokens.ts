/**
 * Namu v1 product theme (PRD section 14). Values are fixed; a failing contrast
 * pair may only change through a reviewed token revision (DS-004).
 */
export interface ColorTokens {
  background: string;
  surface: string;
  surfaceAlt: string;
  textPrimary: string;
  textSecondary: string;
  action: string;
  onAction: string;
  outline: string;
  error: string;
  focus: string;
}

export const lightColors: ColorTokens = {
  background: '#FAF9F6',
  surface: '#FFFFFF',
  surfaceAlt: '#F0F0EA',
  textPrimary: '#202620',
  textSecondary: '#555F55',
  action: '#365C42',
  onAction: '#FFFFFF',
  outline: '#758173',
  error: '#A52222',
  focus: '#365C42',
};

export const darkColors: ColorTokens = {
  background: '#151715',
  surface: '#202420',
  surfaceAlt: '#2A302A',
  textPrimary: '#F2F4EE',
  textSecondary: '#BCC7B9',
  action: '#B7D5AA',
  onAction: '#192B1C',
  outline: '#81907E',
  error: '#FFB4AB',
  focus: '#B7D5AA',
};

/** DS-002 */
export const spacing = {xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48} as const;
export const radii = {control: 12, surface: 16, dialog: 24} as const;
export const sizes = {
  touchTarget: 48,
  icon: 24,
  phonePadding: 16,
  /** DEV-006: single column, centred, on larger displays. */
  maxContentWidth: 720,
} as const;

/** DS-004 */
export const motion = {standardMs: 180} as const;

/** DS-001: logical font size / line height. */
export const typeScale = {
  body: {fontSize: 16, lineHeight: 24},
  label: {fontSize: 14, lineHeight: 20},
  title: {fontSize: 22, lineHeight: 28},
  largeTitle: {fontSize: 28, lineHeight: 36},
} as const;

/** File name == PostScript name, so one string resolves on both platforms. */
export const fonts = {
  regular: 'DMSans-Regular',
  medium: 'DMSans-Medium',
  semibold: 'DMSans-SemiBold',
  icons: 'MaterialSymbolsRounded-Subset',
} as const;
