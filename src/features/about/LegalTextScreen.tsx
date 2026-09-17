import React from 'react';
import {useRoute, type RouteProp} from '@react-navigation/native';
import type {RootStackParamList} from '../../app/navigationTypes';
import {NamuText} from '../../design/components/NamuText';
import {Screen} from '../../design/components/Screen';
import {FONT_NOTICES, OPEN_SOURCE_NOTICES} from './notices/bundledNotices';
import {CC_BY_NC_4_LEGAL_CODE, MODEL_LICENSE_TEXT} from './notices/modelLicenseText';

/**
 * S10: bundled licence text and notices, readable offline. Legal text is
 * shown verbatim in its original language and is never injected remotely
 * (the signed descriptor only names a bundled notice ID).
 */
const DOCUMENTS: Record<RootStackParamList['LegalText']['document'], {title: string; text: string}> = {
  modelLicense: {title: 'CC-BY-NC 4.0 License with Acceptable Use Addendum', text: MODEL_LICENSE_TEXT},
  creativeCommons: {title: 'Creative Commons BY-NC 4.0 — Legal Code', text: CC_BY_NC_4_LEGAL_CODE},
  openSource: {title: 'Open-source notices', text: OPEN_SOURCE_NOTICES},
  fonts: {title: 'DM Sans · Material Symbols', text: FONT_NOTICES},
};

/** Long texts are split so no single Text node grows unbounded. */
function chunks(text: string, size = 4000): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) {
      cut = size;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  return parts;
}

export function LegalTextScreen(): React.JSX.Element {
  const route = useRoute<RouteProp<RootStackParamList, 'LegalText'>>();
  const document = DOCUMENTS[route.params.document];
  return (
    <Screen testID="legal-screen">
      <NamuText variant="title" accessibilityRole="header">
        {document.title}
      </NamuText>
      {chunks(document.text).map((part, index) => (
        <NamuText key={index} variant="label" tone="secondary" selectable>
          {part}
        </NamuText>
      ))}
    </Screen>
  );
}
