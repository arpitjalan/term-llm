import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { expect, it, vi } from 'vitest';
import { StoreContext } from '../app/context';
import { AppStore } from '../stores/app-store';
import { testConfig } from '../stores/store-test-fixtures';
import { Settings } from './SettingsModal';

vi.mock('./LinkedDevicesSettings', () => ({
  LinkedDevicesSettings: ({ active }: { active: boolean }) => (
    <p data-testid="linked-devices-loaded">
      {active ? 'linked devices active' : 'linked devices inactive'}
    </p>
  ),
}));

it('hides owner-only tabs and push controls for a linked-device client', () => {
  const store = new AppStore(testConfig);
  store.linkedDevicesMode.value = true;
  try {
    render(
      <StoreContext.Provider value={store}>
        <Settings />
      </StoreContext.Provider>,
    );
    expect(screen.queryByRole('tab', { name: 'Extensions' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Linked devices' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Connection' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Interface' }));
    expect(
      screen.getByText('Push notifications are not available through Linked devices.'),
    ).toBeVisible();
    expect(screen.queryByText('Show widgets in sidebar')).toBeNull();
  } finally {
    store.dispose();
  }
});

it('registers the lazy linked-devices settings tab with its stable slug', async () => {
  const store = new AppStore(testConfig);
  try {
    render(
      <StoreContext.Provider value={store}>
        <Settings />
      </StoreContext.Provider>,
    );
    const tab = screen.getByRole('tab', { name: 'Linked devices' });
    expect(tab).toHaveAttribute('id', 'settings-linked-devices-tab');
    expect(tab).toHaveAttribute('aria-controls', 'settings-linked-devices-panel');
    expect(screen.queryByTestId('linked-devices-loaded')).toBeNull();

    fireEvent.click(tab);
    expect(await screen.findByText('linked devices active')).toBeVisible();
    expect(document.getElementById('settings-linked-devices-panel')).not.toHaveAttribute('hidden');

    // It stays mounted (but inactive) so a pairing in progress survives.
    fireEvent.click(screen.getByRole('tab', { name: 'Model' }));
    expect(screen.getByTestId('linked-devices-loaded')).toHaveTextContent(
      'linked devices inactive',
    );
    expect(document.getElementById('settings-linked-devices-panel')).toHaveAttribute('hidden');
  } finally {
    store.dispose();
  }
});

it('shows footer actions only on sections that save and supports vertical arrows', () => {
  const store = new AppStore(testConfig);
  try {
    render(
      <StoreContext.Provider value={store}>
        <Settings />
      </StoreContext.Provider>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Model' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save' })).toBeVisible();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Model' }), { key: 'ArrowDown' });
    expect(screen.getByRole('tab', { name: 'Interface' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Interface' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 3, name: 'Interface' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();

    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('tab', { name: 'Interface' }), { key: 'ArrowUp' });
    expect(screen.getByRole('tab', { name: 'Model' })).toHaveFocus();
  } finally {
    store.dispose();
  }
});

it('keeps Cancel disabled while settings are saving', async () => {
  const store = new AppStore(testConfig);
  store.modal.value = 'settings';
  let finish: () => void = () => {};
  store.saveSettings = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    render(
      <StoreContext.Provider value={store}>
        <Settings />
      </StoreContext.Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => finish());
  } finally {
    store.dispose();
  }
});

it('announces the tab list orientation that matches the layout', () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(width >= 720px)',
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const store = new AppStore(testConfig);
  try {
    render(
      <StoreContext.Provider value={store}>
        <Settings />
      </StoreContext.Provider>,
    );
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  } finally {
    vi.unstubAllGlobals();
    store.dispose();
  }
});

it('turns widgets on and off for the server from the Widgets tab', async () => {
  const store = new AppStore(testConfig);
  store.widgets.value = [
    {
      id: 'notes',
      name: 'Notes',
      url: '/ui/widgets/notes/',
      mount: 'notes',
      description: 'Markdown notes',
      state: 'running',
    },
    { id: 'jobs', name: 'Jobs', url: '/ui/widgets/jobs/', mount: 'jobs', state: 'disabled' },
  ];
  store.endpoints.setWidgetDisabled = vi.fn(async () => ({ ok: true }));
  try {
    render(
      <StoreContext.Provider value={store}>
        <Settings />
      </StoreContext.Provider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Widgets' }));
    const notes = screen.getByRole('checkbox', { name: 'Notes Markdown notes' });
    const jobs = screen.getByRole('checkbox', { name: 'Jobs /jobs' });
    expect(notes).toBeChecked();
    expect(jobs).not.toBeChecked();
    expect(store.widgetStore.enabled.value.map(({ id }) => id)).toEqual(['notes']);

    fireEvent.click(notes);
    await waitFor(() =>
      expect(store.endpoints.setWidgetDisabled).toHaveBeenCalledWith('notes', true),
    );
    await waitFor(() => expect(store.widgetStore.enabled.value).toEqual([]));
    expect(notes).not.toBeChecked();

    fireEvent.click(jobs);
    await waitFor(() =>
      expect(store.endpoints.setWidgetDisabled).toHaveBeenCalledWith('jobs', false),
    );
    await waitFor(() =>
      expect(store.widgetStore.enabled.value.map(({ id }) => id)).toEqual(['jobs']),
    );
    expect(jobs).toBeChecked();
  } finally {
    store.dispose();
  }
});

it('offers the Widgets tab only when the server has widgets', () => {
  const store = new AppStore(testConfig);
  try {
    render(
      <StoreContext.Provider value={store}>
        <Settings />
      </StoreContext.Provider>,
    );
    expect(screen.queryByRole('tab', { name: 'Widgets' })).toBeNull();
    act(() => {
      store.widgets.value = [
        { id: 'jobs', name: 'Jobs', url: '/ui/widgets/jobs/', mount: 'jobs', state: 'disabled' },
      ];
    });
    expect(screen.getByRole('tab', { name: 'Widgets' })).toBeVisible();
  } finally {
    store.dispose();
  }
});
