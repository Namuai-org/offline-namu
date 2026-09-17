import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ActivityIndicator, AppState, View, useColorScheme} from 'react-native';
import {I18nextProvider} from 'react-i18next';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import {NamuText} from '../design/components/NamuText';
import {NamuThemeProvider} from '../design/theme';
import {darkColors, lightColors, spacing} from '../design/tokens';
import {setRestartHandler} from '../features/settings/PrivacyScreen';
import {i18n} from '../locales/i18n';
import {Navigation} from './Navigation';
import {ServicesProvider} from './ServicesContext';
import {createAppServices, type AppServices, type PlatformAdapters} from './services';
import {useAppStore, useChatViewStore} from './stores';

/**
 * Composition root. Builds application-scoped services once; the chat
 * controller and the model context belong to the app, not to any screen or
 * navigator (ARC-002).
 */
export default function App({adapters}: {adapters?: PlatformAdapters}): React.JSX.Element {
  const [services, setServices] = useState<AppServices | null>(null);
  const [fatal, setFatal] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [generation, setGeneration] = useState(0);
  const servicesRef = useRef<AppServices | null>(null);
  const scheme = useColorScheme();
  const themePreference = useAppStore(s => s.preferences?.theme ?? 'system');

  useEffect(() => {
    let cancelled = false;
    setServices(null);
    // Native wiring is resolved lazily so tests can inject fakes without ever
    // loading a TurboModule (QA-004).
    const resolved: PlatformAdapters =
      adapters ?? (require('./nativeAdapters') as typeof import('./nativeAdapters')).nativeAdapters();
    void createAppServices(resolved)
      .then(async created => {
        if (cancelled) {
          return;
        }
        servicesRef.current = created;
        setReduceMotion(await created.device.isReduceMotionEnabled().catch(() => false));
        setServices(created);
      })
      .catch(() => {
        if (!cancelled) {
          setFatal(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [adapters, generation]);

  // INF-007: on background, checkpoint, cancel and release the model as soon
  // as the stop is acknowledged. Wired here so it works on every screen.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      const current = servicesRef.current;
      if (!current) {
        return;
      }
      if (state === 'background') {
        current.chat.onBackground();
      } else if (state === 'active') {
        void current.install.refresh().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, []);

  // SEC-006: after "Delete all Namu data" rebuild everything and return to S01.
  const restart = useCallback(() => {
    servicesRef.current?.install.stop();
    servicesRef.current = null;
    useChatViewStore.getState().open(null);
    setGeneration(value => value + 1);
  }, []);
  useEffect(() => setRestartHandler(restart), [restart]);

  if (!services) {
    const colors = scheme === 'dark' ? darkColors : lightColors;
    return (
      <View style={{flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: spacing.xl}}>
        {fatal ? (
          // Never a stack trace or a path (section 17); data is left untouched.
          <NamuText align="center" style={{color: colors.textPrimary}}>
            Namu could not start. Close the app and open it again.
          </NamuText>
        ) : (
          <ActivityIndicator color={colors.action} />
        )}
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <I18nextProvider i18n={i18n}>
        <NamuThemeProvider preference={themePreference}>
          <ServicesProvider services={services}>
            <Navigation key={generation} reduceMotion={reduceMotion} />
          </ServicesProvider>
        </NamuThemeProvider>
      </I18nextProvider>
    </SafeAreaProvider>
  );
}
