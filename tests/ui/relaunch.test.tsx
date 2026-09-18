import React from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import App from '../../src/app/App';
import {useAppStore, useChatSessionStore, useChatViewStore, useDrawerStore, useTransferStore} from '../../src/app/stores';
import {EMPTY_SNAPSHOT} from '../../src/domain/model/transferTypes';
import {makeFakeWorld} from '../support/fakeAdapters';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

/**
 * PA-007: a launch opens a fresh chat; the previous conversation waits in the
 * drawer. Lives in its own file because it renders the app twice against the
 * same on-disk data, which must not bleed into other journeys.
 */
it('opens a fresh chat after a relaunch; the previous one is in the drawer', async () => {
  useAppStore.setState({preferences: null, databaseMode: 'normal', conversationsVersion: 0});
  useTransferStore.setState({snapshot: EMPTY_SNAPSHOT});
  useChatSessionStore.setState({session: {engine: 'unloaded', active: null, blocked: null, lastError: null, unsaved: null}});
  useChatViewStore.setState({conversationId: null, targetOrdinal: null, nonce: 0});
  useDrawerStore.setState({open: false});
  const world = makeFakeWorld();
  world.transfer.installNow();

  await render(<App adapters={world.adapters} />);
  await waitFor(() => screen.getByTestId('onboarding-continue'));
  await fireEvent.press(screen.getByTestId('onboarding-continue'));
  await fireEvent.press(screen.getByTestId('onboarding-start'));
  await waitFor(() => screen.getByTestId('setup-done'));
  await fireEvent.press(screen.getByTestId('setup-done'));
  await waitFor(() => screen.getByTestId('chat-empty'));
  await fireEvent.changeText(screen.getByTestId('composer-input'), 'Yesterday’s question');
  await fireEvent.press(screen.getByTestId('composer-send'));
  await waitFor(() => expect(useChatSessionStore.getState().session.active).toBeNull(), {timeout: 4000});
  await waitFor(() => screen.getByText(/fake/));
  expect(useChatViewStore.getState().conversationId).not.toBeNull();

  // Same on-disk data, new process.
  await act(async () => cleanup());
  useChatViewStore.setState({conversationId: 'stale', targetOrdinal: null, nonce: 0});
  await render(<App adapters={world.adapters} />);
  await waitFor(() => screen.getByTestId('chat-empty'));
  expect(useChatViewStore.getState().conversationId).toBeNull();
  await fireEvent.press(screen.getByTestId('chat-menu'));
  await waitFor(() => screen.getAllByText('Yesterday’s question'));
});
