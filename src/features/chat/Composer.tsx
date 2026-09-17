import React, {useEffect, useRef, useState} from 'react';
import {AppState, Pressable, TextInput, View} from 'react-native';
import {useTranslation} from 'react-i18next';
import {useServices} from '../../app/ServicesContext';
import {DRAFT_MAX_CODE_POINTS, NEW_CHAT_DRAFT_KEY} from '../../data/repositories/DraftRepository';
import {codePointLength} from '../../domain/text/graphemes';
import {GlassSurface} from '../../design/components/GlassSurface';
import {NamuText} from '../../design/components/NamuText';
import {NamuIcon} from '../../design/icons/NamuIcon';
import {useNamuTheme} from '../../design/theme';
import {fonts, sizes, spacing, typeScale} from '../../design/tokens';

const DRAFT_SAVE_DELAY_MS = 300;
const MAX_LINES = 6;
const COUNTER_FROM = DRAFT_MAX_CODE_POINTS * 0.9;
/** One pill: the text field with the round send/stop button inside it. */
const COMPOSER_RADIUS = 28;
const BUTTON_SIZE = 40;
const BUTTON_INSET = 7;
const INPUT_PADDING = 15;

export interface ComposerHandle {
  insert(text: string): void;
}

/**
 * S04 composer: a single rounded field with a round Send button inside it
 * that becomes Stop while Namu answers. Grows from one to six lines, then
 * scrolls. Return inserts a newline; sending is an explicit button (or
 * hardware Ctrl/Cmd+Enter).
 * Drafts are saved 300 ms after a change and on lifecycle transitions
 * (DB-003). A draft typed during generation is kept but cannot be submitted
 * until the active generation ends.
 */
export const Composer = React.forwardRef<
  ComposerHandle,
  {
    conversationId: string | null;
    mode: 'idle' | 'preparing' | 'answering' | 'stopping';
    /** Blocked by device/model state: text can be typed but not sent. */
    blocked: boolean;
    readOnly: boolean;
    onSend: (text: string) => Promise<boolean>;
    onStop: () => void;
  }
>(function Composer({conversationId, mode, blocked, readOnly, onSend, onStop}, ref) {
  const {t} = useTranslation();
  const {colors} = useNamuTheme();
  const services = useServices();
  // Neither platform ships a Hausa dictionary, and autocorrect follows the
  // keyboard, not the app language: with an English keyboard "Sannu! Yaya ake
  // shuka masara?" was sent as "Danny! Yaya ale Shula mascara?". People write
  // Hausa here whatever the UI language is, so the composer never rewrites text.
  const draftKey = conversationId ?? NEW_CHAT_DRAFT_KEY;
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const textRef = useRef('');
  const keyRef = useRef(draftKey);
  /** Text last typed under the current key; read by the cleanup of the draft effect. */
  const latestForKey = useRef('');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sending = useRef(false);
  const [sendingNow, setSendingNow] = useState(false);
  /** The send awaiting its commit; that commit owns the draft row (CHAT-001). */
  const inFlight = useRef<{key: string; value: string} | null>(null);

  const persist = (key: string, value: string) => {
    if (services.drafts && codePointLength(value) <= DRAFT_MAX_CODE_POINTS) {
      void services.drafts.save(key, value, Date.now()).catch(() => undefined);
    }
  };

  // Load the draft for this conversation; flush the previous one first.
  useEffect(() => {
    let cancelled = false;
    keyRef.current = draftKey;
    // Clear synchronously: until this conversation's draft has loaded the
    // field is empty and nothing can be submitted.
    textRef.current = '';
    latestForKey.current = '';
    setText('');
    setDraftLoaded(false);
    void services.drafts
      ?.get(draftKey)
      .then(saved => {
        // Keep anything typed while the draft was loading.
        if (!cancelled && textRef.current.length === 0) {
          textRef.current = saved;
          latestForKey.current = saved;
          setText(saved);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) {
          setDraftLoaded(true);
        }
      });
    if (!services.drafts) {
      setDraftLoaded(true);
    }
    return () => {
      cancelled = true;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      // The first message of a new chat switches this composer to the new
      // conversation while its send is still awaited. The commit has already
      // cleared that draft; saving it again would bring the sent text back.
      const pending = inFlight.current;
      if (!(pending && pending.key === draftKey && pending.value === latestForKey.current)) {
        persist(draftKey, latestForKey.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);

  // Lifecycle transitions save immediately (DB-003).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        persist(keyRef.current, textRef.current);
      }
    });
    return () => subscription.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const change = (value: string) => {
    textRef.current = value;
    latestForKey.current = value;
    setText(value);
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
    }
    saveTimer.current = setTimeout(() => persist(keyRef.current, value), DRAFT_SAVE_DELAY_MS);
  };

  React.useImperativeHandle(ref, () => ({
    // Starter prompts are inserted as editable text; nothing is sent (S04).
    insert: (value: string) => change(textRef.current.length > 0 ? `${textRef.current}\n${value}` : value),
  }));

  const length = codePointLength(text);
  const tooLong = length > DRAFT_MAX_CODE_POINTS;
  const empty = text.trim().length === 0;
  const generating = mode !== 'idle';
  // Send is disabled only when empty, invalid, blocked or stopping (S04).
  const sendDisabled = empty || tooLong || blocked || readOnly || generating || !draftLoaded;

  const submit = async () => {
    if (sendDisabled || sending.current) {
      return;
    }
    sending.current = true;
    setSendingNow(true);
    const value = textRef.current;
    const key = keyRef.current;
    inFlight.current = {key, value};
    try {
      const accepted = await onSend(value);
      if (!accepted && keyRef.current !== key) {
        // Refused after the composer moved on: the text is still the user's draft.
        persist(key, value);
      }
      // Only a durable commit clears the composer (CHAT-001).
      if (accepted && textRef.current === value) {
        if (saveTimer.current) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
        textRef.current = '';
        latestForKey.current = '';
        setText('');
      }
    } finally {
      inFlight.current = null;
      sending.current = false;
      setSendingNow(false);
    }
  };

  const submitRef = useRef(submit);
  submitRef.current = submit;
  useEffect(() => services.device.onSendShortcut(() => void submitRef.current()), [services]);

  const lineHeight = typeScale.body.lineHeight;
  // The optimistic bubble already shows the text while the commit runs; the
  // draft itself is only cleared by a durable commit (CHAT-001).
  const shownText = sendingNow ? '' : text;
  const buttonDisabled = generating ? mode === 'stopping' : sendDisabled;
  return (
    <View style={{gap: spacing.xs, paddingTop: spacing.sm, paddingBottom: spacing.xs}}>
      {tooLong ? (
        <NamuText variant="label" tone="error" accessibilityLiveRegion="polite">
          {t('chat.tooLongInline')}
        </NamuText>
      ) : null}
      <GlassSurface
        floating
        radius={COMPOSER_RADIUS}
        contentStyle={{
          flexDirection: 'row',
          alignItems: 'flex-end',
          borderWidth: tooLong ? 2 : focused ? 1 : undefined,
          borderColor: tooLong ? colors.error : focused ? colors.focus : undefined,
          paddingStart: spacing.lg + 2,
          paddingEnd: BUTTON_INSET,
          minHeight: BUTTON_SIZE + BUTTON_INSET * 2,
        }}>
        <TextInput
          testID="composer-input"
          value={shownText}
          onChangeText={change}
          editable={!readOnly && !sendingNow}
          multiline
          autoCorrect={false}
          spellCheck={false}
          // Mobile Return inserts a newline; it never sends (A11Y-002).
          submitBehavior="newline"
          scrollEnabled
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={t('chat.composerPlaceholder')}
          placeholderTextColor={colors.textSecondary}
          accessibilityLabel={t('chat.composerLabel')}
          selectionColor={colors.accent}
          cursorColor={colors.accent}
          style={{
            flex: 1,
            fontFamily: fonts.regular,
            fontSize: typeScale.body.fontSize,
            lineHeight,
            color: colors.textPrimary,
            paddingTop: INPUT_PADDING,
            paddingBottom: INPUT_PADDING,
            // One to six lines, then the field scrolls. Scales with text size.
            maxHeight: lineHeight * MAX_LINES + INPUT_PADDING * 2,
            textAlignVertical: 'center',
          }}
        />
        {/* Send and Stop share one place, like the rest of the workflow (S04). */}
        <Pressable
          testID={generating ? 'composer-stop' : 'composer-send'}
          accessibilityRole="button"
          accessibilityLabel={generating ? (mode === 'stopping' ? t('chat.stopping') : t('chat.stop')) : t('chat.send')}
          accessibilityState={{disabled: buttonDisabled}}
          disabled={buttonDisabled}
          hitSlop={(sizes.touchTarget - BUTTON_SIZE) / 2}
          onPress={generating ? onStop : submit}
          style={({pressed}) => ({
            width: BUTTON_SIZE,
            height: BUTTON_SIZE,
            borderRadius: BUTTON_SIZE / 2,
            marginBottom: BUTTON_INSET,
            marginStart: spacing.sm,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: buttonDisabled ? colors.surfaceAlt : colors.action,
            opacity: pressed ? 0.75 : 1,
          })}>
          {generating ? (
            <View
              style={{width: 13, height: 13, borderRadius: 3, backgroundColor: buttonDisabled ? colors.textSecondary : colors.onAction}}
            />
          ) : (
            <NamuIcon name="arrow_upward" size={22} color={buttonDisabled ? colors.textSecondary : colors.onAction} />
          )}
        </Pressable>
      </GlassSurface>
      {length >= COUNTER_FROM ? (
        <NamuText variant="label" tone={tooLong ? 'error' : 'secondary'} align="right">
          {t('chat.counter', {count: length, max: DRAFT_MAX_CODE_POINTS})}
        </NamuText>
      ) : null}
    </View>
  );
});
