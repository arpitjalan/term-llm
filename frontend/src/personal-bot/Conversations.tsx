import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppStore } from '../stores/app-store';
import { compareSessionsByActivity } from '../stores/store-utils';
import './conversations.css';

export function Conversations({ store, open }: { store: AppStore; open: (id: string) => void }) {
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState('');
  const mounted = useRef(true);
  const paging = useRef(false);
  const query = store.sidebarSearch.value;
  const searching = !!query.trim();
  const loading = store.searchLoading.value;
  const searchError = store.searchError.value;
  const ready = store.startupDone.value && !store.authRequired.value;
  const showArchived = store.showArchived.value;
  const sessions = (searching ? store.searchResults.value || [] : store.sessions.value)
    .filter((session) => (showArchived || !session.archived) && !session.id.startsWith('draft_'))
    .sort(compareSessionsByActivity);
  const hasMore = store.projectsEnabled.value
    ? !!store.recentCursor.value
    : !!store.noProjectCursor.value;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Search owns a cancellable request and debounce timer in the shared store.
      void store.search('');
    };
  }, [store]);

  const loadMore = async () => {
    if (!ready || paging.current) return;
    paging.current = true;
    setLoadingMore(true);
    setPageError('');
    try {
      if (store.projectsEnabled.peek()) await store.loadMoreRecent();
      else await store.loadMoreNoProject();
    } catch (error) {
      if (mounted.current)
        setPageError(
          error instanceof Error ? error.message : 'Could not load older conversations.',
        );
    } finally {
      paging.current = false;
      if (mounted.current) setLoadingMore(false);
    }
  };

  return (
    <section class="pb-page pb-conversation-catalog">
      <div class="pb-page-heading">
        <div>
          <p class="pb-eyebrow">Pick up where you left off</p>
          <h1>Conversations</h1>
          <p class="pb-muted">Your questions, work, and results, all in one place.</p>
        </div>
      </div>
      <label class="pb-field">
        Search conversations
        <input
          type="search"
          value={query}
          disabled={!ready}
          placeholder="Search titles and messages…"
          onInput={(event) => void store.search(event.currentTarget.value)}
        />
      </label>
      {(searchError || (pageError && !searching)) && (
        <div class="pb-error" role="alert">
          <span>{searchError || pageError}</span>
          <button
            class="pb-button"
            disabled={loadingMore || loading || !ready}
            onClick={() => (searching ? void store.search(query) : void loadMore())}
          >
            Retry
          </button>
        </div>
      )}
      {loading && (
        <p class="pb-muted" role="status">
          Searching conversations…
        </p>
      )}
      {!!sessions.length && (
        <div class="pb-panel pb-conversation-list">
          {sessions.map((session) => (
            <div class="pb-conversation-item" key={session.id}>
              <button
                class="pb-conversation-row"
                disabled={!ready}
                onClick={() => open(session.id)}
              >
                <span>
                  <strong>{session.title || session.name || 'Conversation'}</strong>
                  <small>
                    {session.archived ? 'Archived · ' : ''}
                    {session.projectName ? `${session.projectName} · ` : ''}
                    {new Date(session.lastMessageAt || session.created).toLocaleDateString()}
                  </small>
                </span>
                <span class="pb-conversation-meta">
                  {session.activeRun ? 'In progress' : session.attentionUnseen ? 'New result' : ''}
                  <span aria-hidden="true">↗</span>
                </span>
              </button>
              {session.archived && (
                <button
                  class="pb-button"
                  disabled={!ready}
                  aria-label={`Restore ${session.title || session.name || 'Conversation'}`}
                  onClick={() =>
                    void store.archiveSession(session).catch((error) => store.toast(error, 'error'))
                  }
                >
                  Restore
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {!sessions.length && !loading && !searchError && (
        <div class="pb-panel pb-empty">
          <h2>{searching ? 'No matching conversations' : 'Your conversations will live here'}</h2>
          <p>
            {searching
              ? 'Try another title, phrase, or topic.'
              : 'Start a conversation with your assistant, then return here whenever you need it.'}
          </p>
        </div>
      )}
      {!searching && hasMore && (
        <button class="pb-button" disabled={loadingMore || !ready} onClick={() => void loadMore()}>
          {loadingMore ? 'Loading conversations…' : 'Load older conversations'}
        </button>
      )}
    </section>
  );
}
