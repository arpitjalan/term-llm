import { useCallback, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { APIError } from '../api/client';
import { WidgetLauncher } from '../components/WidgetLauncher';
import type { AppStore } from '../stores/app-store';
import './widgets.css';

export function Widgets({ store }: { store: AppStore }) {
  const ready = store.startupDone.value && !store.authRequired.value;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadErrors, setLoadErrors] = useState<string[]>([]);
  const activeRequest = useRef<symbol | null>(null);
  const busy = useRef(false);
  const load = useCallback(
    async (reload = false) => {
      if (!ready || busy.current) return;
      const current = Symbol();
      activeRequest.current = current;
      busy.current = true;
      setLoading(true);
      setError('');
      try {
        if (reload) await store.endpoints.reloadWidgets();
        if (activeRequest.current !== current) return;
        let snapshot = store.widgets.peek();
        let status = await store.endpoints.widgetStatus();
        // A Stop may finish while this read is in flight. Read again so its
        // earlier running snapshot cannot undo the completed action.
        while (activeRequest.current === current && store.widgets.peek() !== snapshot) {
          snapshot = store.widgets.peek();
          status = await store.endpoints.widgetStatus();
        }
        if (activeRequest.current !== current) return;
        store.widgetStore.apply(status);
        setLoadErrors(
          Array.isArray(status.load_errors)
            ? status.load_errors.filter((value): value is string => typeof value === 'string')
            : [],
        );
      } catch (reason) {
        if (activeRequest.current !== current) return;
        setError(
          reason instanceof APIError && reason.status === 404
            ? 'Widgets are unavailable on this server. They may be disabled.'
            : reason instanceof Error
              ? reason.message
              : 'Could not load widgets.',
        );
      } finally {
        if (activeRequest.current === current) {
          busy.current = false;
          setLoading(false);
        }
      }
    },
    [ready, store],
  );
  useLayoutEffect(() => {
    void load();
    const resume = (event: PageTransitionEvent) => {
      if (event.persisted) void load();
    };
    addEventListener('pageshow', resume);
    return () => {
      activeRequest.current = null;
      busy.current = false;
      removeEventListener('pageshow', resume);
    };
  }, [load]);

  return (
    <section class="pb-page pb-widgets">
      <div class="pb-page-heading">
        <div>
          <p class="pb-eyebrow">Made for your workspace</p>
          <h1>Widgets</h1>
          <p class="pb-muted">The tools and apps you’ve created with your assistant.</p>
        </div>
        <button class="pb-button" disabled={!ready || loading} onClick={() => void load(true)}>
          Refresh widgets
        </button>
      </div>
      {error && (
        <div class="pb-error" role="alert">
          <span>
            {store.widgets.value.length > 0 && 'Showing last-known widgets. '}
            {error}
          </span>
          <button class="pb-button" disabled={!ready || loading} onClick={() => void load(true)}>
            Retry
          </button>
        </div>
      )}
      {loadErrors.length > 0 && (
        <div class="pb-error pb-widget-load-errors" role="alert">
          <strong>Some widgets could not be loaded</strong>
          <ul>
            {loadErrors.map((message, index) => (
              <li key={`${index}-${message}`}>{message}</li>
            ))}
          </ul>
        </div>
      )}
      {loading && ready && (
        <p class="pb-muted" role="status">
          Loading widgets…
        </p>
      )}
      <WidgetLauncher
        store={store}
        autoFocus={false}
        showEmpty={ready && !loading && !error && loadErrors.length === 0}
        emptyDescription="Ask your assistant to create a widget, then select Refresh widgets."
      />
    </section>
  );
}
