import React, {useEffect, useRef} from 'react';
import {AccessibilityInfo, View} from 'react-native';
import {ProgressBar} from 'react-native-paper';
import {useNamuTheme} from '../theme';
import {radii, spacing} from '../tokens';
import {GlassSurface} from './GlassSurface';
import {NamuText} from './NamuText';

/**
 * S03 single progress surface. `fraction === null` renders an indeterminate
 * bar with no percentage (self-test must not show a fake percentage).
 * A11Y-001: announces at 10 % milestones or on a stage change only.
 */
export function DownloadProgress({
  stageLabel,
  detail,
  fraction,
  percentLabel,
  announce,
  testID,
}: {
  stageLabel: string;
  detail?: string;
  fraction: number | null;
  percentLabel?: string;
  /** Builds the spoken text for a milestone, e.g. "Downloading, 40 percent". */
  announce: (stage: string, percent: number | null) => string;
  testID?: string;
}): React.JSX.Element {
  const {colors} = useNamuTheme();
  const lastStage = useRef<string | null>(null);
  const lastDecile = useRef<number>(-1);

  useEffect(() => {
    const decile = fraction === null ? -1 : Math.floor(Math.min(1, Math.max(0, fraction)) * 10);
    const stageChanged = lastStage.current !== stageLabel;
    if (stageChanged || (decile > lastDecile.current && decile >= 0)) {
      AccessibilityInfo.announceForAccessibility(announce(stageLabel, decile < 0 ? null : decile * 10));
    }
    if (stageChanged) {
      lastDecile.current = decile;
    } else if (decile > lastDecile.current) {
      lastDecile.current = decile;
    }
    lastStage.current = stageLabel;
  }, [announce, fraction, stageLabel]);

  return (
    <GlassSurface radius={radii.surface}>
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={stageLabel}
      accessibilityValue={
        fraction === null ? {text: stageLabel} : {min: 0, max: 100, now: Math.round(fraction * 100)}
      }
      style={{gap: spacing.md, padding: spacing.lg}}>
      <View style={{flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md}}>
        <NamuText weight="semibold" style={{flex: 1}}>
          {stageLabel}
        </NamuText>
        {percentLabel ? <NamuText weight="medium">{percentLabel}</NamuText> : null}
      </View>
      <ProgressBar
        progress={fraction ?? 0}
        indeterminate={fraction === null}
        color={colors.link}
        style={{height: 8, borderRadius: 4, backgroundColor: colors.surfaceAlt}}
      />
      {detail ? (
        <NamuText variant="label" tone="secondary">
          {detail}
        </NamuText>
      ) : null}
    </View>
    </GlassSurface>
  );
}
