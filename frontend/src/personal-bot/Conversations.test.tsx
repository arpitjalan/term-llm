import { signal } from '@preact/signals';
import { act, fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { AppStore } from '../stores/app-store';
import type { Session } from '../domain/types';
import { Conversations } from './Conversations';

const session = (id: string, title: string): Session => ({
  id,
  title,
  name: '',
  mode: 'chat',
  origin: 'web',
  archived: false,
  pinned: false,
  created: 100,
  lastMessageAt: 100,
  messages: [],
});

function setup() {
  const store = {
    sidebarSearch: signal(''),
    searchLoading: signal(false),
    searchError: signal(''),
    searchResults: signal<Session[] | null>(null),
    startupDone: signal(true),
    authRequired: signal(false),
    showArchived: signal(false),
    sessions: signal(
      Array.from({ length: 12 }, (_, index) => session(`s${index}`, `Conversation ${index + 1}`)),
    ),
    projectsEnabled: signal(true),
    recentCursor: signal('older'),
    noProjectCursor: signal(''),
    search: vi.fn(async (_query: string) => {}),
    loadMoreRecent: vi.fn(async () => {}),
    loadMoreNoProject: vi.fn(async () => {}),
    archiveSession: vi.fn(async (_session: Session) => {}),
    toast: vi.fn(),
  };
  return { state: store, store: store as unknown as AppStore };
}

describe('personal assistant conversation catalog', () => {
  it.each(['catalog', 'search'])('honors the archived setting in %s results', (source) => {
    const { state, store } = setup();
    const archived = { ...session('archived', 'Archived research'), archived: true };
    state.sessions.value = [archived, session('draft_one', 'Unsent draft')];
    if (source === 'search') {
      state.sidebarSearch.value = 'research';
      state.searchResults.value = state.sessions.peek();
    }
    const open = vi.fn();
    const { rerender } = render(<Conversations store={store} open={open} />);
    expect(screen.queryByRole('button', { name: /^Archived research/ })).not.toBeInTheDocument();
    state.showArchived.value = true;
    rerender(<Conversations store={store} open={open} />);
    fireEvent.click(screen.getByRole('button', { name: /^Archived research/ }));
    expect(open).toHaveBeenCalledWith('archived');
    expect(screen.queryByRole('button', { name: /^Unsent draft/ })).not.toBeInTheDocument();
  });

  it('restores an archived conversation through the shared session store', async () => {
    const { state, store } = setup();
    const archived = { ...session('archived', 'Archived research'), archived: true };
    state.showArchived.value = true;
    state.sessions.value = [archived];
    state.archiveSession.mockImplementation(async (value) => {
      state.sessions.value = [{ ...value, archived: false }];
    });
    const open = vi.fn();
    render(<Conversations store={store} open={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Archived research' }));
    await act(async () => {});
    expect(state.archiveSession).toHaveBeenCalledExactlyOnceWith(archived);
    expect(open).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Restore Archived research' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Archived research/ })).toBeInTheDocument();
  });

  it('reports restore failures and keeps the archived conversation available', async () => {
    const { state, store } = setup();
    state.showArchived.value = true;
    state.sessions.value = [{ ...session('archived', 'Archived research'), archived: true }];
    const error = new Error('Could not restore conversation');
    state.archiveSession.mockRejectedValue(error);
    render(<Conversations store={store} open={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore Archived research' }));
    await act(async () => {});
    expect(state.toast).toHaveBeenCalledExactlyOnceWith(error, 'error');
    expect(screen.getByRole('button', { name: 'Restore Archived research' })).toBeInTheDocument();
  });

  it('keeps conversations beyond the sidebar limit reachable and loads older pages', async () => {
    const { state, store } = setup();
    const open = vi.fn();
    render(<Conversations store={store} open={open} />);
    fireEvent.click(screen.getByRole('button', { name: /Conversation 12/ }));
    expect(open).toHaveBeenCalledWith('s11');
    fireEvent.click(screen.getByRole('button', { name: 'Load older conversations' }));
    await act(async () => {});
    expect(state.loadMoreRecent).toHaveBeenCalledTimes(1);
    expect(state.loadMoreNoProject).not.toHaveBeenCalled();
  });

  it('searches the server catalog and clears its request when leaving', async () => {
    const { state, store } = setup();
    const open = vi.fn();
    state.search.mockImplementation(async (query) => {
      state.sidebarSearch.value = query;
      state.searchResults.value = query ? [session('old-result', 'Earlier research')] : null;
    });
    const { unmount } = render(<Conversations store={store} open={open} />);
    fireEvent.input(screen.getByRole('searchbox', { name: 'Search conversations' }), {
      target: { value: 'research' },
    });
    fireEvent.click(await screen.findByRole('button', { name: /Earlier research/ }));
    expect(state.search).toHaveBeenCalledWith('research');
    expect(open).toHaveBeenCalledWith('old-result');
    expect(
      screen.queryByRole('button', { name: 'Load older conversations' }),
    ).not.toBeInTheDocument();
    await act(() => {
      unmount();
    });
    expect(state.search).toHaveBeenLastCalledWith('');
  });

  it('shows search failures instead of claiming the catalog is empty', () => {
    const { state, store } = setup();
    state.sidebarSearch.value = 'research';
    state.searchError.value = 'Server unavailable';
    render(<Conversations store={store} open={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Server unavailable');
    expect(screen.queryByText('No matching conversations')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(state.search).toHaveBeenCalledWith('research');
  });

  it('uses ungrouped pagination when projects are disabled and keeps failures recoverable', async () => {
    const { state, store } = setup();
    state.projectsEnabled.value = false;
    state.noProjectCursor.value = 'older-flat';
    state.loadMoreNoProject.mockRejectedValue(new Error('Could not load history'));
    render(<Conversations store={store} open={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load older conversations' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load history');
    expect(state.loadMoreNoProject).toHaveBeenCalledTimes(1);
    expect(state.loadMoreRecent).not.toHaveBeenCalled();
  });
});
