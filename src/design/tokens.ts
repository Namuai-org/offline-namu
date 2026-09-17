/**
 * Namu v1 product theme — token revision `namu-brand-1`.
 *
 * Supersedes the PRD section 14 table by owner decision (2026-09-17, see
 * docs/prd-amendments.md PA-005): the UI carries the Namu brand board palette.
 *   Harmattan #F7F0E3  primary background and warmth
 *   Ink       #1C1410  primary type, outlines, dark fields
 *   Sahel     #E8935A  signature accent — a precision accent, never loud
 *   Dry Clay  #EDD9B0 / Kola #6B3E1E / Forest #1A3A2E  depth
 * Proportion target: light space first, then dark structure, then small
 * moments of heat. DS-004 still applies: every pair below is checked by
 * `npm run check:contrast` (text 4.5:1, controls/focus 3:1).
 */
export interface ColorTokens {
  background: string;
  surface: string;
  surfaceAlt: string;
  textPrimary: string;
  textSecondary: string;
  /** Fill of primary controls. */
  action: string;
  onAction: string;
  /** Text-coloured actions: links, text buttons, selected marks. */
  link: string;
  /** Sahel. Decorative heat only on light fields (it is not a text colour there). */
  accent: string;
  outline: string;
  error: string;
  focus: string;
  /** Apple-style glass: tint laid over the blur, hairline edge, and the opaque fallback. */
  glassTint: string;
  glassEdge: string;
  glassFallback: string;
}

export const lightColors: ColorTokens = {
  background: '#F7F0E3',
  surface: '#FFFBF3',
  surfaceAlt: '#EDD9B0',
  textPrimary: '#1C1410',
  textSecondary: '#5E4B3C',
  action: '#1C1410',
  onAction: '#F7F0E3',
  link: '#6B3E1E',
  accent: '#E8935A',
  outline: '#8A7460',
  error: '#9E2B1E',
  focus: '#6B3E1E',
  glassTint: 'rgba(255, 251, 243, 0.58)',
  glassEdge: 'rgba(255, 255, 255, 0.75)',
  glassFallback: 'rgba(255, 251, 243, 0.96)',
};

export const darkColors: ColorTokens = {
  background: '#1C1410',
  surface: '#2A201A',
  surfaceAlt: '#3A2D23',
  textPrimary: '#F7F0E3',
  textSecondary: '#CDBFA8',
  action: '#F7F0E3',
  onAction: '#1C1410',
  link: '#E8935A',
  accent: '#E8935A',
  outline: '#8F7D6A',
  error: '#FFB4A9',
  focus: '#E8935A',
  glassTint: 'rgba(42, 32, 26, 0.52)',
  glassEdge: 'rgba(247, 240, 227, 0.16)',
  glassFallback: 'rgba(42, 32, 26, 0.96)',
};

/** DS-002 */
export const spacing = {xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48} as const;
export const radii = {control: 14, surface: 20, dialog: 28, pill: 999} as const;
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
