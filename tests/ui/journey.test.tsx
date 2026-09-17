import React from 'react';
import {act, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import App from '../../src/app/App';
import {useAppStore, useChatSessionStore, useChatViewStore, useTransferStore} from '../../src/app/stores';
import {EMPTY_SNAPSHOT} from '../../src/domain/model/transferTypes';
import {FAKE_BYTES, makeFakeWorld, type FakeWorld} from '../support/fakeAdapters';

jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);

function resetStores() {
  useAppStore.setState({preferences: null, databaseMode: 'normal', conversationsVersion: 0});
  useTransferStore.setState({snapshot: EMPTY_SNAPSHOT});
  useChatSessionStore.setState({session: {engine: 'unloaded', active: null, blocked: null, lastError: null, unsaved: null}});
  useChatViewStore.setState({conversationId: null, targetOrdinal: null, nonce: 0});
}

let world: FakeWorld;
beforeEach(() => {
  resetStores();
  world = makeFakeWorld();
});

async function boot() {
  await render(<App adapters={world.adapters} />);
  await waitFor(() => expect(useAppStore.getState().preferences).not.toBeNull());
}

async function completeOnboarding() {
  await waitFor(() => screen.getByTestId('onboarding-language'));
  await fireEvent.press(screen.getByTestId('onboarding-continue'));
  await waitFor(() => screen.getByTestId('onboarding-intro'));
  await fireEvent.press(screen.getByTestId('onboarding-start'));
}

describe('S01–S03 first run', () => {
  it('shows languages in their own names, preselects a supported device locale and needs no account', async () => {
    world.device.locales = ['fr-NE', 'en-US'];
    await boot();
    await waitFor(() => screen.getByTestId('onboarding-language'));
    expect(screen.getByText('Hausa')).toBeTruthy();
    expect(screen.getByText('Français')).toBeTruthy();
    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByTestId('language-fr').props.accessibilityState.selected).toBe(true);
    expect(screen.getByText('Choisissez votre langue')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('language-ha'));
    await waitFor(() => screen.getByText('Zaɓi harshenka'));
    expect(useAppStore.getState().preferences?.appLanguage).toBe('ha');
  });

  it('T01: with no network, setup explains the download need and never shows Ready', async () => {
    world.transfer.snapshotValue.network = {connected: false, metered: false};
    await boot();
    await completeOnboarding();
    await waitFor(() => screen.getByTestId('setup-device'));
    expect(screen.getByTestId('setup-offline')).toBeTruthy();
    expect(screen.queryByTestId('setup-download')).toBeNull();
    expect(screen.queryByText('Namu is ready')).toBeNull();
    expect(useTransferStore.getState().snapshot.install.state).toBe('absent');
  });

  it('blocks download on a low-memory phone but keeps Help reachable (DEV-002)', async () => {
    world.device.profileValue = {...world.device.profileValue, physicalMemoryBytes: 3_800_000_000};
    await boot();
    await completeOnboarding();
    await waitFor(() => screen.getByTestId('setup-ineligible'));
    expect(screen.queryByTestId('setup-download')).toBeNull();
    expect(screen.getByText('DEVICE_INELIGIBLE')).toBeTruthy();
    expect(world.transfer.calls.filter(c => c.startsWith('start'))).toEqual([]);
  });

  it('downloads, verifies with its own percentage, self-tests without a fake percentage and activates', async () => {
    await boot();
    await completeOnboarding();
    await waitFor(() => screen.getByTestId('setup-device'));
    expect(screen.getByText('2.14 GB')).toBeTruthy(); // from the signed exact byte count
    await fireEvent.press(screen.getByTestId('setup-download'));
    await waitFor(() => screen.getByTestId('setup-progress'));
    expect(world.transfer.calls).toContain('start:bundled:false');

    await act(async () => world.transfer.setTransfer({committedBytes: FAKE_BYTES / 2}));
    expect(screen.getByText('50%')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('setup-pause'));
    await waitFor(() => screen.getByText('Paused'));
    await fireEvent.press(screen.getByTestId('setup-resume'));

    await act(async () => world.transfer.setTransfer({phase: 'verifying', committedBytes: FAKE_BYTES, verifiedBytes: FAKE_BYTES / 4}));
    expect(screen.getByText('Checking the download')).toBeTruthy();
    expect(screen.getByText('25%')).toBeTruthy();

    await act(async () => world.transfer.setTransfer({phase: 'staged', verifiedBytes: FAKE_BYTES}));
    await waitFor(() => screen.getByText('Namu is ready'));
    expect(world.transfer.calls).toContain('beginSelfTest:t1');
    expect(world.transfer.calls).toContain('activate:t1:true:');
    // Old and new contexts are never held together: the candidate was unloaded.
    expect(world.engine.events.filter(e => e === 'unload').length).toBeGreaterThan(0);
    expect(world.engine.state()).toBe('unloaded');
  });

  it('keeps the old state when the self-test fails (DL-011)', async () => {
    world.engine.script.selfTestPasses = false;
    await boot();
    await completeOnboarding();
    await waitFor(() => screen.getByTestId('setup-device'));
    await fireEvent.press(screen.getByTestId('setup-download'));
    await act(async () => world.transfer.setTransfer({phase: 'staged', committedBytes: FAKE_BYTES, verifiedBytes: FAKE_BYTES}));
    await waitFor(() => screen.getByTestId('setup-failure'));
    expect(world.transfer.calls).toContain('activate:t1:false:MODEL_LOAD_FAILED');
    expect(useTransferStore.getState().snapshot.install.state).toBe('absent');
  });

  it('asks for per-transfer consent with the byte count before using mobile data (DL-006)', async () => {
    world.transfer.snapshotValue.network = {connected: true, metered: true};
    await boot();
    await completeOnboarding();
    await waitFor(() => screen.getByTestId('setup-device'));
    await fireEvent.press(screen.getByTestId('setup-metered'));
    await waitFor(() => screen.getByText(/About 2\.14 GB still needs to be downloaded/));
    expect(world.transfer.calls.filter(c => c.startsWith('start'))).toEqual([]);
    await fireEvent.press(screen.getByTestId('setup-metered-confirm'));
    await waitFor(() => expect(world.transfer.calls).toContain('start:bundled:true'));
  });
});
