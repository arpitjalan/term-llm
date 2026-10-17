import { useEffect, useRef, useState } from 'preact/hooks';
import { PendingLabel } from '../../components/PendingLabel';
import type { PersonalBotManagerStore } from '../stores/personal-bot-manager';

export function ConnectAssistant({
  store,
  close,
}: {
  store: PersonalBotManagerStore;
  close: () => void;
}) {
  const nameInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [url, setURL] = useState('');
  const [token, setToken] = useState('');
  const busy = !!store.busy.value;
  const payload = () => ({ name: name.trim(), url: url.trim(), token: token.trim() });

  useEffect(() => {
    store.clearExistingConnectionFeedback();
    nameInput.current?.focus();
    return () => store.clearExistingConnectionFeedback();
  }, [store]);

  return (
    <form
      class="pbm-panel pbm-form"
      aria-label="Connect an existing assistant"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await store.connectExistingAssistant(payload())) {
          setToken('');
          close();
        }
      }}
    >
      <div class="pbm-section-heading">
        <div>
          <p class="pbm-eyebrow">Already running term-llm?</p>
          <h2>Connect an existing assistant</h2>
        </div>
        <button class="pbm-button" type="button" disabled={busy} onClick={close}>
          Cancel
        </button>
      </div>
      <p class="pbm-muted">
        Connect an assistant running on your computer, another server, or in Docker. Its AI account
        and files stay in its existing environment.
      </p>
      <label>
        Name
        <input
          ref={nameInput}
          type="text"
          required
          value={name}
          onInput={(event) => {
            setName(event.currentTarget.value);
            store.clearExistingConnectionFeedback();
          }}
          placeholder="My computer"
          autoComplete="off"
          disabled={store.busy.value === 'connect-existing'}
        />
      </label>
      <label>
        URL
        <input
          type="url"
          aria-label="URL"
          required
          value={url}
          onInput={(event) => {
            setURL(event.currentTarget.value);
            store.clearExistingConnectionFeedback();
          }}
          placeholder="http://127.0.0.1:8080/chat"
          autoComplete="off"
          aria-describedby="existing-assistant-url-help"
          disabled={store.busy.value === 'connect-existing'}
        />
        <small id="existing-assistant-url-help">
          Use a URL reachable from the Hub server. localhost refers to that server, which may be
          different from the computer running your browser.
        </small>
      </label>
      <label>
        Bearer token <span class="pbm-muted">(optional, kept server-side)</span>
        <input
          type="password"
          value={token}
          onInput={(event) => {
            setToken(event.currentTarget.value);
            store.clearExistingConnectionFeedback();
          }}
          autoComplete="off"
          disabled={store.busy.value === 'connect-existing'}
        />
      </label>
      {store.existingConnectionStatus.value && (
        <p class="pbm-muted" role="status">
          {store.existingConnectionStatus.value}
        </p>
      )}
      {store.existingConnectionError.value && (
        <p class="pbm-error" role="alert">
          {store.existingConnectionError.value}
        </p>
      )}
      <div class="pbm-actions">
        <button
          class="pbm-button"
          type="button"
          disabled={busy || !url.trim()}
          onClick={() => void store.testExistingAssistant(payload())}
        >
          <PendingLabel
            pending={store.busy.value === 'test-existing'}
            label="Test connection"
            pendingLabel="Testing…"
          />
        </button>
        <button
          class="pbm-button pbm-primary"
          type="submit"
          disabled={busy || !name.trim() || !url.trim()}
        >
          <PendingLabel
            pending={store.busy.value === 'connect-existing'}
            label="Connect assistant"
            pendingLabel="Connecting…"
          />
        </button>
      </div>
    </form>
  );
}
