import React, {useMemo} from 'react';
import {DarkTheme, DefaultTheme, NavigationContainer, type Theme} from '@react-navigation/native';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useTranslation} from 'react-i18next';
import {useNamuTheme} from '../design/theme';
import {Platform} from 'react-native';
import {fonts, motion} from '../design/tokens';
import {FloatingTabBar} from './FloatingTabBar';
import {AboutAiScreen} from '../features/about/AboutAiScreen';
import {LegalTextScreen} from '../features/about/LegalTextScreen';
import {ChatScreen} from '../features/chat/ChatScreen';
import {ConversationsScreen} from '../features/conversations/ConversationsScreen';
import {HelpScreen} from '../features/settings/HelpScreen';
import {OfflineStorageScreen} from '../features/settings/OfflineStorageScreen';
import {PrivacyScreen} from '../features/settings/PrivacyScreen';
import {SettingsScreen} from '../features/settings/SettingsScreen';
import {OnboardingScreen} from '../features/setup/OnboardingScreen';
import {SetupScreen} from '../features/setup/SetupScreen';
import type {RootStackParamList, TabParamList} from './navigationTypes';
import {useAppStore} from './stores';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

/** UX-001: three bottom tabs — Chat, Conversations, Settings — in a floating glass bar. */
function TabNavigator(): React.JSX.Element {
  const {t} = useTranslation();
  return (
    <Tabs.Navigator tabBar={props => <FloatingTabBar {...props} />} screenOptions={{headerShown: false}}>
      <Tabs.Screen name="Chat" component={ChatScreen} options={{title: t('tabs.chat'), tabBarButtonTestID: 'tab-chat'}} />
      <Tabs.Screen name="Conversations" component={ConversationsScreen} options={{title: t('tabs.conversations'), tabBarButtonTestID: 'tab-conversations'}} />
      <Tabs.Screen name="Settings" component={SettingsScreen} options={{title: t('tabs.settings'), tabBarButtonTestID: 'tab-settings'}} />
    </Tabs.Navigator>
  );
}

export function Navigation({reduceMotion}: {reduceMotion: boolean}): React.JSX.Element {
  const {t} = useTranslation();
  const theme = useNamuTheme();
  const onboarded = useAppStore(s => s.preferences?.onboardingComplete === true);

  const navigationTheme = useMemo<Theme>(() => {
    const base = theme.dark ? DarkTheme : DefaultTheme;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.colors.link,
        background: theme.colors.background,
        card: theme.colors.surface,
        text: theme.colors.textPrimary,
        border: theme.colors.surfaceAlt,
        notification: theme.colors.error,
      },
    };
  }, [theme]);

  return (
    <NavigationContainer theme={navigationTheme}>
      <Stack.Navigator
        initialRouteName={onboarded ? 'Tabs' : 'Onboarding'}
        screenOptions={{
          // Glass frame: content scrolls under a translucent, blurred header with
          // a centred DM Sans title. Android has no system blur: near-opaque tint.
          headerTransparent: true,
          headerBlurEffect: theme.dark ? 'systemThinMaterialDark' : 'systemThinMaterialLight',
          headerStyle: {backgroundColor: Platform.OS === 'ios' ? 'transparent' : theme.colors.glassFallback},
          headerTintColor: theme.colors.textPrimary,
          headerTitleAlign: 'center',
          headerTitleStyle: {fontFamily: fonts.semibold, fontSize: 18},
          headerShadowVisible: false,
          headerBackButtonDisplayMode: 'minimal',
          contentStyle: {backgroundColor: theme.colors.background},
          // DS-004: 180 ms standard transitions; none when reduced motion is on.
          animation: reduceMotion ? 'none' : 'default',
          animationDuration: motion.standardMs,
        }}>
        <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{headerShown: false}} />
        <Stack.Screen name="Tabs" component={TabNavigator} options={{headerShown: false}} />
        {/* Setup and recovery sit above the tabs; history/help stay reachable (UX-001). */}
        <Stack.Screen name="Setup" component={SetupScreen} options={{headerShown: false, presentation: 'modal', gestureEnabled: false}} />
        <Stack.Screen name="OfflineStorage" component={OfflineStorageScreen} options={{title: t('storage.title')}} />
        <Stack.Screen name="Privacy" component={PrivacyScreen} options={{title: t('privacy.title')}} />
        <Stack.Screen name="Help" component={HelpScreen} options={{title: t('help.title')}} />
        <Stack.Screen name="AboutAi" component={AboutAiScreen} options={{title: t('about.title')}} />
        <Stack.Screen name="LegalText" component={LegalTextScreen} options={{title: ''}} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
