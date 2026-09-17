import {useCallback, useEffect, useRef, useState} from 'react';
import {useTranslation} from 'react-i18next';
import type {ProductErrorCode} from '../../domain/inference/failures';
import {formatBytes, formatDateTime} from '../../locales/format';

/** Localized formatters bound to the current app language (LOC-001). */
export function useFormatters() {
  const {t, i18n} = useTranslation();
  const language = i18n.language;
  return {
    bytes: useCallback((n: number) => formatBytes(n, t, language), [t, language]),
    dateTime: useCallback((ms: number) => formatDateTime(ms, language), [language]),
  };
}

/** Localized copy for a stable product error code (PRD section 17). */
export function useErrorCopy() {
  const {t} = useTranslation();
  return useCallback(
    (code: ProductErrorCode, values: Record<string, string> = {}) => ({
      title: t(`errors.${code}.title`, values),
      body: t(`errors.${code}.body`, values),
      action: t(`errors.${code}.action`, values),
      code,
    }),
    [t],
  );
}

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

export function useIsMounted(): () => boolean {
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return useCallback(() => mounted.current, []);
}
