import React from 'react';
import {Text, type TextProps, type TextStyle} from 'react-native';
import {useNamuTheme} from '../theme';
import {fonts, typeScale} from '../tokens';

type Variant = keyof typeof typeScale;
type Weight = 'regular' | 'medium' | 'semibold';
type Tone = 'primary' | 'secondary' | 'action' | 'error' | 'onAction';

export interface NamuTextProps extends TextProps {
  variant?: Variant;
  weight?: Weight;
  tone?: Tone;
  align?: TextStyle['textAlign'];
}

/** DS-001: DM Sans with system fallback; system text scaling stays enabled. */
export function NamuText({
  variant = 'body',
  weight,
  tone = 'primary',
  align,
  style,
  ...rest
}: NamuTextProps): React.JSX.Element {
  const {colors} = useNamuTheme();
  const resolvedWeight: Weight = weight ?? (variant === 'title' || variant === 'largeTitle' ? 'semibold' : 'regular');
  const color =
    tone === 'secondary' ? colors.textSecondary
    : tone === 'action' ? colors.link
    : tone === 'error' ? colors.error
    : tone === 'onAction' ? colors.onAction
    : colors.textPrimary;
  return (
    <Text
      {...rest}
      style={[
        {
          fontFamily: fonts[resolvedWeight],
          fontSize: typeScale[variant].fontSize,
          lineHeight: typeScale[variant].lineHeight,
          color,
          textAlign: align,
        },
        style,
      ]}
    />
  );
}
