import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import App from '../../src/app/App';
import {useAppStore, useChatSessionStore, useChatViewStore, useDrawerStore, useTransferStore} from '../../src/app/stores';
import {EMPTY_SNAPSHOT} from '../../src/domain/model/transferTypes';
import {makeFakeWorld, type FakeWorld} from '../support/fakeAdapters';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

let world: FakeWorld;
beforeEach(() => {
  useAppStore.setState({preferences: null, databaseMode: 'normal', conversationsVersion: 0});
  useTransferStore.setState({snapshot: EMPTY_SNAPSHOT});
  useChatSessionStore.setState({session: {engine: 'unloaded', active: null, blocked: null, lastError: null, unsaved: null}});
  useChatViewStore.setState({conversationId: null, targetOrdinal: null, nonce: 0});
  useDrawerStore.setState({open: false});
  world = makeFakeWorld();
});

/** Installed model, onboarding done, Chat tab visible. Network is OFF (T02). */
async function bootIntoChat() {
  world.transfer.installNow();
  world.transfer.snapshotValue.network = {connected: false, metered: false};
  await render(<App adapters={world.adapters} />);
  await waitFor(() => screen.getByTestId('onboarding-continue'));
  await fireEvent.press(screen.getByTestId('onboarding-continue'));
  await fireEvent.press(screen.getByTestId('onboarding-start'));
  await waitFor(() => screen.getByTestId('setup-done'));
  await fireEvent.press(screen.getByTestId('setup-done'));
  await waitFor(() => screen.getByTestId('chat-empty'));
}

/** PA-007: history and Settings live in the drawer behind the menu button. */
async function openDrawer() {
  await fireEvent.press(screen.getByTestId('chat-menu'));
  await waitFor(() => expect(useDrawerStore.getState().open).toBe(true));
}

async function openSettings() {
  await openDrawer();
  await fireEvent.press(screen.getByTestId('drawer-settings'));
  await waitFor(() => screen.getByTestId('settings-screen'));
}

async function idle() {
  await waitFor(() => expect(useChatSessionStore.getState().session.active).toBeNull(), {timeout: 4000});
}

async function sendMessage(text: string) {
  await fireEvent.changeText(screen.getByTestId('composer-input'), text);
  await fireEvent.press(screen.getByTestId('composer-send'));
}

describe('T02 / NFR-012 local chat journey in airplane mode', () => {
  it('chats, stops, retries and keeps history without any network request', async () => {
    await bootIntoChat();
    expect(screen.getByText('How can I help?')).toBeTruthy();
    expect(screen.getByText('On this device')).toBeTruthy();
    // The model is not loaded just because the app opened (UX-001, INF-007).
    expect(world.engine.loadCount).toBe(0);

    // Starter prompts insert editable text and never send.
    await fireEvent.press(screen.getByTestId('suggest-explain'));
    expect(screen.getByTestId('composer-input').props.value).toBe('Explain this in simple words: ');
    expect(world.engine.prompts).toHaveLength(0);

    await sendMessage('Explain this in simple words: rain');
    await idle();
    await waitFor(() => screen.getByText(/fake/));
    expect(screen.getByTestId('composer-input').props.value).toBe(''); // cleared only after commit
    expect(world.engine.loadCount).toBe(1);
    expect(world.announcements).toEqual(['Answering', 'Answer complete']); // once each, never per token

    // Stop keeps partial output (CHAT-004).
    world.engine.script.tokenDelayMs = 20;
    world.engine.script.tokens = Array.from({length: 200}, (_, i) => `w${i} `);
    await sendMessage('second question');
    await waitFor(() => screen.getByTestId('composer-stop'));
    await act(async () => new Promise(resolve => setTimeout(resolve, 70)));
    await fireEvent.press(screen.getByTestId('composer-stop'));
    await idle();
    await waitFor(() => screen.getByText('Stopped'));

    // Try again exists on the latest turn and preserves the earlier attempt.
    world.engine.script.tokenDelayMs = 0;
    world.engine.script.tokens = ['A ', 'better ', 'answer.'];
    await fireEvent.press(screen.getByTestId('try-again'));
    await idle();
    await waitFor(() => screen.getByText('A better answer.'));
    expect(screen.getByText('1 earlier answer')).toBeTruthy();

    // Zero app-originated network activity during the whole local journey.
    expect(world.transfer.calls.filter(c => c.startsWith('start') || c === 'checkForUpdate')).toEqual([]);
    expect(world.transfer.calls).toContain('sessionSuccess');
  });

  it('does not bring the first message of a chat back as the new-chat draft', async () => {
    await bootIntoChat();
    await sendMessage('Sannu');
    await idle();
    await waitFor(() => screen.getByText(/fake/));
    await fireEvent.press(screen.getByTestId('chat-new'));
    await waitFor(() => screen.getByTestId('chat-empty'));
    // Let the draft load settle, then the composer must still be empty.
    await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
    expect(screen.getByTestId('composer-input').props.value).toBe('');
  });

  it('opens a fresh chat after a relaunch; the previous one is in the drawer (PA-007)', async () => {
    await bootIntoChat();
    await sendMessage('Yesterday’s question');
    await idle();
    await waitFor(() => screen.getByText(/fake/));
    expect(useChatViewStore.getState().conversationId).not.toBeNull();

    // Same on-disk data, new process.
    screen.unmount();
    useChatViewStore.setState({conversationId: 'stale', targetOrdinal: null, nonce: 0});
    await render(<App adapters={world.adapters} />);
    await waitFor(() => screen.getByTestId('chat-empty'));
    expect(useChatViewStore.getState().conversationId).toBeNull();
    await openDrawer();
    await waitFor(() => screen.getAllByText('Yesterday’s question'));
  });

  it('keeps the draft and shows INPUT_TOO_LONG when the prompt budget overflows (T19)', async () => {
    await bootIntoChat();
    const long = 'word '.repeat(2300);
    await sendMessage(long);
    await waitFor(() => screen.getByTestId('chat-error-INPUT_TOO_LONG'));
    expect(screen.getByTestId('composer-input').props.value).toBe(long);
    await idle();
  });

  it('never opens a link without the hostname confirmation (S04)', async () => {
    await bootIntoChat();
    world.engine.script.tokens = ['See [the site](https://example.org/page) and [bad](javascript:alert(1)).'];
    await sendMessage('link please');
    await idle();
    await waitFor(() => screen.getByText('the site'));
    await fireEvent.press(screen.getByText('the site'));
    await waitFor(() => screen.getByText('This opens example.org in your browser and uses internet.'));
    expect(screen.getByText(/bad/)).toBeTruthy(); // javascript: link degraded to plain text
  });

  it('blocks new answers while the phone is hot and says why (DEVICE_HOT)', async () => {
    await bootIntoChat();
    await act(async () => world.device.emitThermal('critical'));
    await waitFor(() => screen.getByTestId('chat-error-DEVICE_HOT'));
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'hello');
    expect(screen.getByTestId('composer-send').props.accessibilityState.disabled).toBe(true);
  });

  it('sends with the hardware Ctrl/Cmd+Enter shortcut (A11Y-002)', async () => {
    await bootIntoChat();
    await fireEvent.changeText(screen.getByTestId('composer-input'), 'line one\nline two');
    await act(async () => world.device.pressSendShortcut());
    await idle();
    await waitFor(() => screen.getByText('line one\nline two'));
  });
});

describe('S05–S08 history and data controls', () => {
  it('lists, searches, renames, exports with a warning and deletes a conversation', async () => {
    await bootIntoChat();
    await sendMessage('Ƙasar Hausa da tarihinta');
    await idle();
    await openDrawer();
    await waitFor(() => screen.getAllByText('Ƙasar Hausa da tarihinta'));
    const id = useChatViewStore.getState().conversationId!;

    await fireEvent.changeText(screen.getByTestId('conversation-search'), 'ƙasar');
    await waitFor(() => screen.getAllByText(/Your message|Title/), {timeout: 3000});
    await fireEvent.changeText(screen.getByTestId('conversation-search'), '');

    await waitFor(() => screen.getByTestId(`conversation-menu-${id}`));
    await fireEvent.press(screen.getByTestId(`conversation-menu-${id}`));
    await fireEvent.press(screen.getByTestId('menu-rename'));
    await fireEvent.changeText(screen.getByTestId('rename-input'), '   ');
    await fireEvent.press(screen.getByTestId('rename-save'));
    await waitFor(() => screen.getByText('Enter a name.'));
    await fireEvent.changeText(screen.getByTestId('rename-input'), 'Tarihin Hausa');
    await fireEvent.press(screen.getByTestId('rename-save'));
    await waitFor(() => screen.getByText('Tarihin Hausa'));

    await fireEvent.press(screen.getByTestId(`conversation-menu-${id}`));
    await fireEvent.press(screen.getByTestId('menu-export'));
    await waitFor(() => screen.getByText('Export leaves Namu\'s protection'));
    expect(world.exporter.calls.filter(c => c.startsWith('conversation'))).toEqual([]); // nothing before consent
    await fireEvent.press(screen.getByTestId('export-confirm'));
    await waitFor(() => expect(world.exporter.calls).toContain('cleanup:export-1:true'));
    expect(world.exporter.calls).toEqual(expect.arrayContaining([`conversation:${id}:You`, 'share:export-1']));

    await fireEvent.press(screen.getByTestId(`conversation-menu-${id}`));
    await fireEvent.press(screen.getByTestId('menu-delete'));
    await waitFor(() => screen.getByText(/“Tarihin Hausa” and all its messages will be deleted/));
    await fireEvent.press(screen.getByTestId('delete-confirm'));
    await waitFor(() => screen.getByTestId('conversations-empty'));
    expect(useChatViewStore.getState().conversationId).toBeNull();
  });

  it('changes language and theme in Settings, and never checks for updates on its own (SIG-005)', async () => {
    await bootIntoChat();
    await openSettings();
    expect(screen.queryByText(/temperature|top.?p|threads|quantization|model selector/i)).toBeNull(); // PRD-002
    await fireEvent.press(screen.getByTestId('settings-appearance'));
    await fireEvent.press(screen.getByTestId('settings-theme-dark'));
    expect(useAppStore.getState().preferences?.theme).toBe('dark');
    await fireEvent.press(screen.getByTestId('settings-app-language'));
    await fireEvent.press(screen.getByTestId('settings-language-fr'));
    await waitFor(() => screen.getByText('Général')); // the native header title is not rendered under Jest
    expect(screen.getByText('Langue des réponses')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('settings-storage'));
    await waitFor(() => screen.getByTestId('storage-screen'));
    expect(screen.getByText('Prête')).toBeTruthy();
    expect(world.transfer.calls).not.toContain('checkForUpdate');
  });

  it('deletes all conversations with a scoped confirmation and keeps model and settings (SEC-006)', async () => {
    await bootIntoChat();
    await sendMessage('to be deleted');
    await idle();
    await openSettings();
    await fireEvent.press(screen.getByTestId('settings-privacy'));
    await waitFor(() => screen.getByTestId('privacy-screen'));
    await fireEvent.press(screen.getByTestId('privacy-delete-conversations'));
    await waitFor(() => screen.getByText(/The offline AI and your settings stay/));
    await fireEvent.press(screen.getByTestId('confirm-delete-conversations'));
    await waitFor(() => screen.getByTestId('privacy-message'));
    expect(useTransferStore.getState().snapshot.install.state).toBe('installed');
    expect(useAppStore.getState().preferences?.onboardingComplete).toBe(true);
    expect(world.transfer.calls).not.toContain('deleteAllTransferData');
  });

  it('delete all Namu data removes everything and returns to S01', async () => {
    await bootIntoChat();
    await openSettings();
    await fireEvent.press(screen.getByTestId('settings-privacy'));
    await fireEvent.press(screen.getByTestId('privacy-delete-everything'));
    await waitFor(() => screen.getByText(/returns Namu to its first screen/));
    await fireEvent.press(screen.getByTestId('confirm-delete-everything'));
    await waitFor(() => expect(world.device.deleted).toBe(true));
    expect(world.transfer.calls).toContain('deleteAllTransferData');
    expect(world.exporter.calls).toContain('deleteAll');
  });
});
