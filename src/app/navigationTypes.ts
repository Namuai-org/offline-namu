export type RootStackParamList = {
  Onboarding: undefined;
  /** Chat with the history drawer (PA-007 replaces the three tabs of UX-001). */
  Home: undefined;
  Settings: undefined;
  /** S02/S03 sit above Home; history and help stay reachable (UX-001). */
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
