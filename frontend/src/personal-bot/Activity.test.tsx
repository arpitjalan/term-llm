import { signal } from '@preact/signals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { APIClient } from '../api/client';
import type { ActivityPage, BotActivityFeed } from '../api/personal-bot-attention';
import type { AppStore } from '../stores/app-store';
import { Activity, useActivity, type ActivityState } from './Activity';

const emptyPage: ActivityPage = { items: [], has_more: false, snapshot_version: 1 };
const readyPage: ActivityPage = {
  items: [
    {
      session_id: 'old-session',
      response_id: 'response-1',
      short_title: 'Research findings',
      outcome: 'completed',
    },
  ],
  has_more: false,
  snapshot_version: 1,
};
const feed: BotActivityFeed = {
  input_required: emptyPage,
  running: emptyPage,
  unseen: readyPage,
};

function setup() {
  const get = vi.fn(async (path: string) =>
    new URL(path, 'https://example.test').searchParams.get('kind') === 'unseen'
      ? readyPage
      : emptyPage,
  );
  const store = {
    api: { get } as unknown as APIClient,
    startupDone: signal(true),
    authRequired: signal(false),
  } as unknown as AppStore;
  return { store, get };
}

function LiveActivity({ store, enabled = true }: { store: AppStore; enabled?: boolean }) {
  return <Activity activity={useActivity(store, enabled)} open={() => {}} />;
}

describe('personal assistant activity', () => {
  it('opens the durable conversation without acknowledging work from the inbox', () => {
    const open = vi.fn();
    const more = vi.fn();
    const state: ActivityState = {
      feed: { ...feed, unseen: { ...readyPage, has_more: true, next_cursor: 'next' } },
      loading: false,
      error: '',
      refresh: vi.fn(),
      more,
    };
    render(<Activity activity={state} open={open} />);
    fireEvent.click(screen.getByRole('button', { name: /Research findings/ }));
    expect(open).toHaveBeenCalledExactlyOnceWith('old-session');
    expect(screen.getByText('Finished · open to review')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(more).toHaveBeenCalledExactlyOnceWith('unseen');
  });

  it('keeps last-known work visible when refresh fails and offers recovery', async () => {
    const { store, get } = setup();
    render(<LiveActivity store={store} />);
    await screen.findByText('Research findings');
    get.mockRejectedValueOnce(new Error('The server is offline.'));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Showing last-known activity. The server is offline.');
    expect(screen.getByText('Research findings')).toBeInTheDocument();
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });

  it('waits for startup and authentication before requesting activity', async () => {
    const { store, get } = setup();
    store.startupDone.value = false;
    const { rerender } = render(<LiveActivity store={store} />);
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
    store.startupDone.value = true;
    store.authRequired.value = true;
    rerender(<LiveActivity store={store} />);
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
    store.authRequired.value = false;
    rerender(<LiveActivity store={store} />);
    await screen.findByText('Research findings');
    expect(get).toHaveBeenCalledTimes(3);
  });

  it('polls at a bounded interval, skips hidden tabs, and stops after leaving', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      const { store, get } = setup();
      const { rerender, unmount } = render(<LiveActivity store={store} />);
      await act(async () => {});
      expect(get).toHaveBeenCalledTimes(3);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(get).toHaveBeenCalledTimes(6);
      visibility.mockReturnValue('hidden');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(get).toHaveBeenCalledTimes(6);
      visibility.mockReturnValue('visible');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(15_000);
      });
      expect(get).toHaveBeenCalledTimes(9);
      rerender(<LiveActivity store={store} enabled={false} />);
      await act(async () => {});
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(get).toHaveBeenCalledTimes(9);
      await act(() => {
        unmount();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts pending reads and ignores results arriving after the view is disabled', async () => {
    const { store, get } = setup();
    const pending: Array<(page: ActivityPage) => void> = [];
    get.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
    const { rerender } = render(<LiveActivity store={store} />);
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(3);
    const signals = get.mock.calls.map((call) => (call as unknown[])[1] as AbortSignal);
    rerender(<LiveActivity store={store} enabled={false} />);
    await act(async () => {
      for (const resolve of pending) resolve(readyPage);
    });
    expect(signals.every((request) => request.aborted)).toBe(true);
    expect(screen.queryByText('Research findings')).not.toBeInTheDocument();
  });
});
