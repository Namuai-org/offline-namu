import React from 'react';
import {Text} from 'react-native';
import {fonts, sizes} from '../tokens';
import glyphs from './glyphs.json';

export type IconName = keyof typeof glyphs;

/**
 * Material Symbols Rounded (bundled subset font, Apache-2.0; DS-003).
 * Icons are decorative: the accessible name always comes from the control
 * that contains them, so the glyph itself is hidden from screen readers.
 */
export function NamuIcon({
  name,
  color,
  size = sizes.icon,
}: {
  name: IconName;
  color?: string;
  size?: number;
}): React.JSX.Element {
  const codePoint = glyphs[name];
  return (
    <Text
      allowFontScaling={false}
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no"
      style={{
        fontFamily: fonts.icons,
        fontSize: size,
        lineHeight: size,
        width: size,
        height: size,
        color,
        textAlign: 'center',
        includeFontPadding: false,
      }}>
      {codePoint ? String.fromCodePoint(codePoint) : ''}
    </Text>
  );
}
