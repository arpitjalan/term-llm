import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppStore } from '../stores/app-store';
import {
  activityKinds,
  loadActivity,
  loadActivityPage,
  type AttentionKind,
  type BotActivityFeed,
} from '../api/personal-bot-attention';

export const activityLabels: Record<AttentionKind, string> = {
  input_required: 'Needs your input',
  running: 'In progress',
  unseen: 'Ready to review',
};

export function useActivity(store: AppStore, enabled: boolean) {
  const [feed, setFeed] = useState<BotActivityFeed | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const request = useRef<AbortController | null>(null);
  const ready = enabled && store.startupDone.value && !store.authRequired.value;
  useEffect(() => {
    if (!ready) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(() => void refresh(), 15_000);
        return;
      }
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      try {
        const next = await loadActivity(store.api, controller.signal);
        if (live && !controller.signal.aborted) {
          setFeed(next);
          setError('');
        }
      } catch (reason) {
        if (live && !controller.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Could not refresh activity.');
      } finally {
        if (live && !controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 15_000);
        }
      }
    };
    void refresh();
    return () => {
      live = false;
      clearTimeout(timer);
      request.current?.abort();
    };
  }, [store, ready, revision]);
  const more = async (kind: AttentionKind) => {
    if (!feed || loading) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const next = await loadActivityPage(store.api, kind, controller.signal, feed[kind]);
      if (!controller.signal.aborted) {
        setFeed((old) => old && { ...old, [kind]: next });
        setError('');
      }
    } catch (reason) {
      if (!controller.signal.aborted)
        setError(
          `${reason instanceof Error ? reason.message : 'Could not load more activity.'} Refresh to get the latest list.`,
        );
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  return { feed, error, loading, refresh: () => setRevision((value) => value + 1), more };
}

export type ActivityState = ReturnType<typeof useActivity>;
export function ActivityNotice({ activity }: { activity: ActivityState }) {
  return activity.error ? (
    <div class="pb-error" role="alert">
      <span>
        {activity.feed ? 'Showing last-known activity. ' : ''}
        {activity.error}
      </span>
      <button class="pb-button" onClick={activity.refresh}>
        Retry
      </button>
    </div>
  ) : !activity.feed ? (
    <p class="pb-muted" role="status">
      Loading activity…
    </p>
  ) : null;
}

export function Activity({
  activity,
  open,
}: {
  activity: ActivityState;
  open: (id: string) => void;
}) {
  const total =
    activity.feed &&
    activityKinds.reduce((sum, kind) => sum + activity.feed![kind].items.length, 0);
  return (
    <section class="pb-page pb-activity">
      <div class="pb-page-heading">
        <div>
          <p class="pb-eyebrow">A little less to keep track of</p>
          <h1>Your assistant at work</h1>
          <p class="pb-muted">See what’s moving, what’s finished, and where you’re needed.</p>
        </div>
        <button class="pb-button" disabled={activity.loading} onClick={activity.refresh}>
          Refresh
        </button>
      </div>
      <ActivityNotice activity={activity} />
      {activity.feed && total === 0 && !activity.error && (
        <div class="pb-panel pb-empty">
          <span class="pb-empty-mark" aria-hidden="true">
            ✓
          </span>
          <h2>All caught up</h2>
          <p>As your assistant works, updates and requests for your input will appear here.</p>
          <p class="pb-muted">Scheduled routine results are in Routines.</p>
        </div>
      )}
      {activity.feed &&
        activityKinds.map((kind) => {
          const page = activity.feed![kind];
          if (!page.items.length) return null;
          return (
            <section class="pb-activity-group" key={kind} aria-label={activityLabels[kind]}>
              <h2>
                {activityLabels[kind]}{' '}
                <span>
                  {page.items.length}
                  {page.has_more ? '+' : ''}
                </span>
              </h2>
              <div class="pb-panel pb-activity-list">
                {page.items.map((item) => (
                  <button
                    class="pb-activity-row"
                    key={item.response_id}
                    onClick={() => open(item.session_id)}
                  >
                    <span class={`pb-status-dot pb-status-${kind}`} aria-hidden="true" />
                    <span>
                      <strong>{item.short_title || item.long_title || 'Conversation'}</strong>
                      <small>
                        {kind === 'unseen' ? outcomeLabel(item.outcome) : activityLabels[kind]}
                      </small>
                    </span>
                    <span class="pb-row-arrow" aria-hidden="true">
                      ↗
                    </span>
                  </button>
                ))}
              </div>
              {page.has_more && (
                <button
                  class="pb-button"
                  disabled={activity.loading}
                  onClick={() => void activity.more(kind)}
                >
                  Load more
                </button>
              )}
            </section>
          );
        })}
    </section>
  );
}

function outcomeLabel(outcome?: string): string {
  if (outcome === 'completed') return 'Finished · open to review';
  if (outcome === 'failed') return 'Could not finish · open for details';
  if (outcome === 'cancelled') return 'Stopped';
  if (outcome === 'orphaned') return 'Interrupted · open for details';
  return 'New update · open to review';
}
