import { useState } from 'preact/hooks';
import type { PersonalBotManagerStore } from '../stores/personal-bot-manager';

export function ChatGPTConnectionPicker({
  store,
  model,
  disabled,
}: {
  store: PersonalBotManagerStore;
  model: string;
  disabled: boolean;
}) {
  const [choice, setChoice] = useState('');
  const [connectionID, setConnectionID] = useState('');
  const [sourceID, setSourceID] = useState('');
  const connections = store.sharedConnections.value;
  const sources = store.connectionSources.value;
  const mode =
    choice || (connections.some((item) => item.available !== false) ? 'existing' : 'new');
  const connection =
    connections.find((item) => item.id === connectionID) ||
    connections.find((item) => item.id === store.connection.value?.connection_id) ||
    connections.find((item) => item.available !== false);
  const source =
    sources.find((item) => item.id === sourceID) || sources.find((item) => item.available);
  const unavailable =
    mode === 'existing'
      ? !connection || connection.available === false
      : mode === 'import'
        ? !source?.available
        : false;
  return (
    <form
      class="pbm-form"
      aria-label="ChatGPT connection"
      onSubmit={async (event) => {
        event.preventDefault();
        if (disabled || unavailable) return;
        if (mode === 'existing' && connection) await store.useConnection(connection.id, model);
        else if (mode === 'import' && source) {
          if (await store.importConnection(source.id, model)) {
            setConnectionID('');
            setChoice('existing');
          }
        } else await store.startDeviceLogin(model);
      }}
    >
      {store.connection.value?.connection_name && (
        <p role="status">Using {store.connection.value.connection_name}</p>
      )}
      <label>
        ChatGPT setup
        <select
          value={mode}
          disabled={disabled}
          onChange={(event) => setChoice(event.currentTarget.value)}
        >
          <option value="existing">Use existing connection</option>
          <option value="new">Connect new account</option>
          <option value="import">Import saved sign-in</option>
        </select>
      </label>
      {store.connectionsLoading.value && <p role="status">Checking saved connections…</p>}
      {store.connectionsError.value && (
        <div role="alert" class="pbm-error">
          {store.connectionsError.value}
          <button
            class="pbm-button"
            type="button"
            disabled={store.connectionsLoading.value}
            onClick={() => void store.loadSharedConnections()}
          >
            Retry connections
          </button>
        </div>
      )}
      {mode === 'existing' ? (
        <>
          <label>
            Saved connection
            <select
              value={connection?.id || ''}
              disabled={disabled || !connections.length}
              onChange={(event) => setConnectionID(event.currentTarget.value)}
            >
              {!connection && <option value="">No available connections</option>}
              {connections.map((item) => (
                <option key={item.id} value={item.id} disabled={item.available === false}>
                  {item.name}
                  {item.available === false ? ' — unavailable' : ''}
                </option>
              ))}
            </select>
          </label>
          {!connections.length && !store.connectionsLoading.value && (
            <p class="pbm-muted">
              No saved connections yet. Connect an account or import a saved sign-in.
            </p>
          )}
        </>
      ) : mode === 'import' ? (
        <>
          <label>
            Saved sign-in
            <select
              value={source?.id || ''}
              disabled={disabled || !sources.length}
              onChange={(event) => setSourceID(event.currentTarget.value)}
            >
              {!source && <option value="">No available sign-ins</option>}
              {sources.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.available}>
                  {item.name}
                  {!item.available ? ` — ${item.message || 'unavailable'}` : ''}
                </option>
              ))}
            </select>
          </label>
          {!sources.length && !store.connectionsLoading.value && (
            <p class="pbm-muted">No saved sign-ins were found on this server or its assistants.</p>
          )}
          <p class="pbm-muted">
            Reuse a sign-in already saved on this server or one of its assistants. There is no key
            to paste.
          </p>
        </>
      ) : (
        <p class="pbm-muted">
          Sign in once with ChatGPT to use this account across your assistants. Device-code sign-in
          must be enabled for your account.
        </p>
      )}
      <button
        class="pbm-button"
        type="submit"
        disabled={disabled || unavailable || (mode !== 'new' && store.connectionsLoading.value)}
      >
        {store.busy.value === 'device' ||
        store.busy.value === 'reuse' ||
        store.busy.value === 'import'
          ? 'Connecting…'
          : mode === 'existing'
            ? 'Use connection'
            : mode === 'import'
              ? 'Import and use connection'
              : 'Connect ChatGPT'}
      </button>
      <p class="pbm-muted">
        Keep this server running. Removing the original saved sign-in or signing out disconnects
        assistants using it.
      </p>
    </form>
  );
}
