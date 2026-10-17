import { useState } from 'preact/hooks';
import { hubPath, type HubConfig } from '../config';
import type { AuthStore } from '../stores/auth-store';

export function AuthApp({
  config,
  store,
  canonicalURL,
  setupCode = '',
}: {
  config: HubConfig;
  store: AuthStore;
  /** Set when this page is open on an origin where its passkeys cannot work. */
  canonicalURL?: string;
  setupCode?: string;
}) {
  const page = config.passkey;
  const [code, setCode] = useState(setupCode);
  const [displayName, setDisplayName] = useState(page?.defaultName ?? '');
  if (!page) throw new Error('Hub passkey configuration is missing.');
  const fromLink = !!setupCode && !store.error.value;
  const needsCode = page.needsCode && !fromLink;
  if (canonicalURL) {
    return (
      <div class="hub-auth">
        <main class="auth-card">
          <h1>{page.heading}</h1>
          <p role="alert">
            Passkeys for this server only work at {page.origin}. This page is open at{' '}
            {window.location.origin}.
          </p>
          <p>
            <a href={canonicalURL}>Continue at {page.origin}</a>
          </p>
        </main>
      </div>
    );
  }
  if (store.handedOff.value) {
    return (
      <div class="hub-auth">
        <main class="auth-card">
          <h1>Continue in the app</h1>
          <p role="status">
            The app is finishing sign-in. You can close this window. If the app did not open, start
            sign-in again from the app.
          </p>
        </main>
      </div>
    );
  }
  const submit = (event: Event) => {
    event.preventDefault();
    const requested =
      new URLSearchParams(window.location.search).get('return') || hubPath(config.basePath, '/');
    void store.submit(page.mode, {
      code,
      displayName,
      returnPath: requested,
      challenge: page.challenge,
    });
  };
  return (
    <div class="hub-auth">
      <main class="auth-card">
        <h1>{page.heading}</h1>
        <p>{fromLink ? 'Create your first passkey.' : page.description}</p>
        <form onSubmit={submit}>
          {needsCode && (
            <label>
              One-time setup code
              <input
                type="password"
                autoComplete="one-time-code"
                autoFocus
                value={code}
                onInput={(event) => setCode(event.currentTarget.value)}
              />
            </label>
          )}
          {page.needsName && (
            <label>
              Passkey name
              <input
                maxLength={80}
                required
                autoFocus={!needsCode}
                value={displayName}
                onInput={(event) => setDisplayName(event.currentTarget.value)}
              />
            </label>
          )}
          <button type="submit" disabled={store.busy.value}>
            {store.busy.value
              ? 'Waiting for your passkey…'
              : fromLink
                ? 'Create passkey'
                : page.button}
          </button>
        </form>
        <div
          class={`status${store.error.value ? ' error' : ''}`}
          role={store.error.value ? 'alert' : 'status'}
          aria-live="polite"
        >
          {store.error.value}
        </div>
      </main>
    </div>
  );
}
