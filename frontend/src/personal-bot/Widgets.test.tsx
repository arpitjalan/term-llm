import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { signal } from '@preact/signals';
import { APIError } from '../api/client';
import type { AppStore } from '../stores/app-store';
import type { AppStoreServices } from '../stores/app-store-services';
import { WidgetStore } from '../stores/widget-store';
import { Widgets } from './Widgets';

const dashboard = {
  id: 'dashboard-id',
  mount: 'dashboard',
  title: 'My dashboard',
  description: 'A widget I created earlier.',
  state: 'running',
};

function setup(prefix = '/ui') {
  const endpoints = {
    widgetStatus: vi.fn(async (): Promise<Record<string, unknown>> => ({ widgets: [dashboard] })),
    reloadWidgets: vi.fn(async () => ({ ok: true })),
    stopWidget: vi.fn(async (_mount: string) => ({ ok: true })),
  };
  const widgetStore = new WidgetStore({
    config: { prefix },
    endpoints,
  } as unknown as AppStoreServices);
  const state = {
    endpoints,
    widgetStore,
    widgets: widgetStore.widgets,
    startupDone: signal(true),
    authRequired: signal(false),
    toast: vi.fn(),
  };
  return { state, store: state as unknown as AppStore, endpoints };
}

describe('personal assistant widgets', () => {
  it.each(['/ui', '/hub/node/assistant'])(
    'opens existing widgets under %s and stops them',
    async (prefix) => {
      const { store, endpoints } = setup(prefix);
      render(<Widgets store={store} />);
      expect(
        await screen.findByRole('link', { name: 'Open My dashboard, Running' }),
      ).toHaveAttribute('href', `${prefix}/widgets/dashboard/`);
      expect(screen.getByText(dashboard.description)).toBeVisible();
      expect(endpoints.reloadWidgets).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Stop My dashboard' }));
      await screen.findByRole('link', { name: 'Open My dashboard', exact: true });
      expect(endpoints.stopWidget).toHaveBeenCalledExactlyOnceWith('dashboard');
    },
  );

  it('reloads the registry to discover newly created widgets', async () => {
    const { store, endpoints } = setup();
    endpoints.widgetStatus.mockResolvedValueOnce({ widgets: [] });
    render(<Widgets store={store} />);
    await screen.findByText('No widgets available');
    expect(screen.getByText(/Ask your assistant to create a widget/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh widgets' }));
    await screen.findByRole('link', { name: 'Open My dashboard, Running' });
    expect(endpoints.reloadWidgets).toHaveBeenCalledTimes(1);
    expect(endpoints.reloadWidgets.mock.invocationCallOrder[0]).toBeLessThan(
      endpoints.widgetStatus.mock.invocationCallOrder[1]!,
    );
  });

  it('refreshes status when Back restores the page from the browser cache', async () => {
    const { store, endpoints } = setup();
    endpoints.widgetStatus.mockResolvedValueOnce({ widgets: [{ ...dashboard, state: 'stopped' }] });
    render(<Widgets store={store} />);
    await screen.findByRole('link', { name: 'Open My dashboard', exact: true });
    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    fireEvent(window, event);
    await screen.findByRole('button', { name: 'Stop My dashboard' });
    expect(endpoints.reloadWidgets).not.toHaveBeenCalled();
  });

  it('keeps last-known widgets visible on failure and recovers through retry', async () => {
    const { store, endpoints } = setup();
    render(<Widgets store={store} />);
    await screen.findByRole('link', { name: 'Open My dashboard, Running' });
    endpoints.reloadWidgets.mockRejectedValueOnce(new Error('Server unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh widgets' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Server unavailable');
    expect(screen.getByRole('link', { name: 'Open My dashboard, Running' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('shows manifest errors alongside valid widgets', async () => {
    const { store, endpoints } = setup();
    endpoints.widgetStatus.mockResolvedValue({
      widgets: [dashboard],
      load_errors: ['broken/widget.yaml: title is required'],
    });
    render(<Widgets store={store} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'broken/widget.yaml: title is required',
    );
    expect(screen.getByRole('link', { name: 'Open My dashboard, Running' })).toBeVisible();
  });

  it('does not let a delayed status read undo a completed Stop', async () => {
    const { store, endpoints } = setup();
    store.widgetStore.apply({ widgets: [dashboard] });
    let resolve!: (value: Record<string, unknown>) => void;
    endpoints.widgetStatus.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    endpoints.widgetStatus.mockResolvedValue({ widgets: [{ ...dashboard, state: 'stopped' }] });
    render(<Widgets store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop My dashboard' }));
    await screen.findByRole('link', { name: 'Open My dashboard', exact: true });
    await act(async () => {
      resolve({ widgets: [dashboard] });
    });
    await waitFor(() => expect(endpoints.widgetStatus).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Stop My dashboard' })).not.toBeInTheDocument();
  });

  it('distinguishes disabled widgets from an empty catalog', async () => {
    const { store, endpoints } = setup();
    endpoints.widgetStatus.mockRejectedValue(new APIError('Not found', 404));
    render(<Widgets store={store} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Widgets are unavailable on this server',
    );
    expect(screen.queryByText('No widgets available')).not.toBeInTheDocument();
  });

  it('waits for startup and authentication before loading', async () => {
    const { state, store, endpoints } = setup();
    state.startupDone.value = false;
    const { rerender } = render(<Widgets store={store} />);
    await act(async () => {});
    expect(endpoints.widgetStatus).not.toHaveBeenCalled();
    state.startupDone.value = true;
    state.authRequired.value = true;
    rerender(<Widgets store={store} />);
    await act(async () => {});
    expect(endpoints.widgetStatus).not.toHaveBeenCalled();
    state.authRequired.value = false;
    rerender(<Widgets store={store} />);
    await screen.findByRole('link', { name: 'Open My dashboard, Running' });
  });

  it('does not show an empty catalog while loading or apply a response after leaving', async () => {
    const { store, endpoints } = setup();
    let resolve!: (value: Record<string, unknown>) => void;
    endpoints.widgetStatus.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { unmount } = render(<Widgets store={store} />);
    await screen.findByText('Loading widgets…');
    expect(screen.queryByText('No widgets available')).not.toBeInTheDocument();
    unmount();
    await act(async () => {
      resolve({ widgets: [dashboard] });
    });
    expect(store.widgets.peek()).toEqual([]);
  });
});
