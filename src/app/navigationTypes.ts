import type {NavigatorScreenParams} from '@react-navigation/native';

export type TabParamList = {
  Chat: undefined;
  Conversations: undefined;
  Settings: undefined;
};

export type RootStackParamList = {
  Onboarding: undefined;
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  /** S02/S03 sit above the tabs (UX-001). */
  Setup: undefined;
  OfflineStorage: undefined;
  Privacy: undefined;
  Help: undefined;
  AboutAi: undefined;
  LegalText: {document: 'modelLicense' | 'creativeCommons' | 'openSource' | 'fonts'};
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
