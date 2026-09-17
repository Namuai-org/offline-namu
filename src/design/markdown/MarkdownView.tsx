import React, {useMemo} from 'react';
import {Platform, ScrollView, Text, View} from 'react-native';
import {useNamuTheme} from '../theme';
import {fonts, radii, spacing, typeScale} from '../tokens';
import {detectDirection} from './direction';
import {parseMarkdown, type BlockNode, type InlineNode} from './parseMarkdown';

const MONO = Platform.select({ios: 'Menlo', default: 'monospace'});

export interface MarkdownViewProps {
  source: string;
  /** Links never open directly: the caller shows the Open link confirmation (S04). */
  onLinkPress: (href: string, hostname: string) => void;
}

/**
 * Namu-owned React Native token renderer (PRD section 2). Parsed once per
 * completed message; streaming text is rendered as plain text elsewhere.
 * Body text is never shrunk to fit: wide tables scroll horizontally.
 */
export const MarkdownView = React.memo(function MarkdownView({source, onLinkPress}: MarkdownViewProps) {
  const {colors} = useNamuTheme();
  const parsed = useMemo(() => parseMarkdown(source), [source]);
  const direction = useMemo(() => detectDirection(source), [source]);

  const base = {
    fontFamily: fonts.regular,
    fontSize: typeScale.body.fontSize,
    lineHeight: typeScale.body.lineHeight,
    color: colors.textPrimary,
    writingDirection: direction,
    textAlign: direction === 'rtl' ? ('right' as const) : ('left' as const),
  };

  const inline = (nodes: InlineNode[], keyPrefix: string): React.ReactNode[] =>
    nodes.map((node, index) => {
      const key = `${keyPrefix}-${index}`;
      switch (node.type) {
        case 'text':
          return node.value;
        case 'break':
          return '\n';
        case 'strong':
          return (
            <Text key={key} style={{fontFamily: fonts.semibold}}>
              {inline(node.children, key)}
            </Text>
          );
        case 'em':
          return (
            <Text key={key} style={{fontStyle: 'italic'}}>
              {inline(node.children, key)}
            </Text>
          );
        case 'strike':
          return (
            <Text key={key} style={{textDecorationLine: 'line-through'}}>
              {inline(node.children, key)}
            </Text>
          );
        case 'code':
          return (
            <Text key={key} style={{fontFamily: MONO, backgroundColor: colors.surfaceAlt}}>
              {node.value}
            </Text>
          );
        case 'link':
          return (
            <Text
              key={key}
              accessibilityRole="link"
              onPress={() => onLinkPress(node.href, node.hostname)}
              style={{color: colors.link, textDecorationLine: 'underline'}}>
              {inline(node.children, key)}
            </Text>
          );
      }
    });

  const blocks = (nodes: BlockNode[], keyPrefix: string): React.ReactNode[] =>
    nodes.map((node, index) => {
      const key = `${keyPrefix}-${index}`;
      switch (node.type) {
        case 'paragraph':
          return (
            <Text key={key} selectable style={base}>
              {inline(node.children, key)}
            </Text>
          );
        case 'heading':
          return (
            <Text
              key={key}
              selectable
              accessibilityRole="header"
              style={[
                base,
                {fontFamily: fonts.semibold},
                node.level <= 2 ? {fontSize: typeScale.title.fontSize, lineHeight: typeScale.title.lineHeight} : null,
              ]}>
              {inline(node.children, key)}
            </Text>
          );
        case 'list':
          return (
            <View key={key} style={{gap: spacing.xs}}>
              {node.items.map((item, itemIndex) => (
                <View key={`${key}-i${itemIndex}`} style={{flexDirection: direction === 'rtl' ? 'row-reverse' : 'row', gap: spacing.sm}}>
                  <Text style={[base, {minWidth: 20}]}>{node.ordered ? `${node.start + itemIndex}.` : '•'}</Text>
                  <View style={{flex: 1, gap: spacing.xs}}>{blocks(item, `${key}-i${itemIndex}`)}</View>
                </View>
              ))}
            </View>
          );
        case 'blockquote':
          return (
            <View
              key={key}
              style={{borderStartWidth: 3, borderStartColor: colors.outline, paddingStart: spacing.md, gap: spacing.sm}}>
              {blocks(node.children, key)}
            </View>
          );
        case 'codeBlock':
          return (
            <ScrollView
              key={key}
              horizontal
              style={{backgroundColor: colors.surfaceAlt, borderRadius: radii.control}}
              contentContainerStyle={{padding: spacing.md}}>
              <Text selectable style={[base, {fontFamily: MONO, writingDirection: 'ltr', textAlign: 'left'}]}>
                {node.value}
              </Text>
            </ScrollView>
          );
        case 'rule':
          return <View key={key} style={{height: 1, backgroundColor: colors.outline}} />;
        case 'table':
          return (
            <ScrollView key={key} horizontal>
              <View style={{borderWidth: 1, borderColor: colors.outline, borderRadius: radii.control}}>
                {[node.header, ...node.rows].map((row, rowIndex) => (
                  <View
                    key={`${key}-r${rowIndex}`}
                    style={{
                      flexDirection: 'row',
                      borderTopWidth: rowIndex === 0 ? 0 : 1,
                      borderTopColor: colors.outline,
                      backgroundColor: rowIndex === 0 ? colors.surfaceAlt : undefined,
                    }}>
                    {row.map((cell, cellIndex) => (
                      <Text
                        key={`${key}-r${rowIndex}-c${cellIndex}`}
                        selectable
                        style={[
                          base,
                          {minWidth: 120, maxWidth: 280, padding: spacing.sm},
                          rowIndex === 0 ? {fontFamily: fonts.semibold} : null,
                        ]}>
                        {inline(cell, `${key}-r${rowIndex}-c${cellIndex}`)}
                      </Text>
                    ))}
                  </View>
                ))}
              </View>
            </ScrollView>
          );
      }
    });

  return <View style={{gap: spacing.md}}>{blocks(parsed.blocks, 'md')}</View>;
});
