import { Component, type ComponentChildren } from 'preact';

export function HubFatal({
  title = 'Hub could not start',
  message,
}: {
  title?: string;
  message: string;
}) {
  return (
    <main class="hub-fatal">
      <div role="alert">
        <h1>{title}</h1>
        <p>{message}</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </main>
  );
}

export class HubErrorBoundary extends Component<
  { children: ComponentChildren },
  { error: string }
> {
  state = { error: '' };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error.message : 'The Hub UI could not continue.' };
  }

  render(props: { children: ComponentChildren }, state: { error: string }) {
    if (!state.error) return props.children;
    return <HubFatal message={state.error} />;
  }
}
