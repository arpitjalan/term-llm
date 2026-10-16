import { useState } from 'preact/hooks';
import { deviceVerificationURL, type ManagedAssistant } from '../domain/assistants';
import type { PersonalBotManagerStore } from '../stores/personal-bot-manager';
import { ChatGPTConnectionPicker } from './ChatGPTConnectionPicker';

export function ConnectionForm({
  store,
  assistant,
}: {
  store: PersonalBotManagerStore;
  assistant: ManagedAssistant;
}) {
  const providers = store.providers.value;
  const [providerID, setProviderID] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setAPIKey] = useState('');
  const connection = store.connection.value;
  const provider =
    providers.find((item) => item.id === providerID) ||
    providers.find((item) => item.id === connection?.provider) ||
    providers.find((item) => item.id === 'chatgpt') ||
    providers[0];
  const chosenModel =
    model ||
    (connection?.provider === provider?.id ? connection?.model : '') ||
    provider?.default_model ||
    '';
  const flow = connection?.flow;
  const pending = flow?.state === 'pending';
  const busy =
    !!store.busy.value ||
    (store.operation.value?.name === assistant.name && store.operation.value.state === 'running');
  const running = assistant.state === 'running';
  const deviceURL = deviceVerificationURL(flow?.verification_url);
  return (
    <section class="pbm-connection" aria-label="AI connection">
      <h3>Connect your AI account</h3>
      <p class="pbm-muted">
        Choose how your assistant gets its intelligence. Your connection is stored on this server.
      </p>
      {connection && (
        <p class="pbm-connection-message" role="status">
          {connection.message}
        </p>
      )}
      {store.connectionError.value && (
        <div class="pbm-error" role="alert">
          {store.connectionError.value}
          <button
            class="pbm-button"
            disabled={store.connectionLoading.value}
            onClick={() => void store.loadConnection()}
          >
            Check connection
          </button>
        </div>
      )}
      {store.connectionLoading.value && !connection && <p role="status">Checking connection…</p>}
      {pending ? (
        <section class="pbm-device" aria-label="ChatGPT sign-in">
          <p>Open ChatGPT sign-in and enter this code.</p>
          <strong class="pbm-device-code">{flow.user_code}</strong>
          {deviceURL ? (
            <a
              class="pbm-button pbm-primary"
              href={deviceURL}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open ChatGPT sign-in ↗
            </a>
          ) : (
            <p class="pbm-error">The sign-in link is unavailable. Cancel and try again.</p>
          )}
          <p class="pbm-muted">
            Waiting for you to finish signing in. You can keep this page open.
          </p>
          {flow.expires_at && (
            <p class="pbm-muted">Code expires {new Date(flow.expires_at).toLocaleTimeString()}.</p>
          )}
          <button class="pbm-button" disabled={busy} onClick={() => void store.cancelDeviceLogin()}>
            Cancel sign-in
          </button>
        </section>
      ) : (
        <>
          {flow?.message && flow.state !== 'succeeded' && <p role="status">{flow.message}</p>}
          {running && (
            <p class="pbm-muted">Stop this assistant before changing its AI connection.</p>
          )}
          {provider ? (
            <div class="pbm-form">
              <label>
                AI connection
                <select
                  disabled={busy || running}
                  value={provider.id}
                  onChange={(event) => {
                    setProviderID(event.currentTarget.value);
                    setModel('');
                    setAPIKey('');
                  }}
                >
                  {providers.map((item) => (
                    <option value={item.id} key={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              {!!provider.models.length && (
                <label>
                  Model
                  <select
                    value={chosenModel}
                    disabled={busy || running}
                    onChange={(event) => setModel(event.currentTarget.value)}
                  >
                    {[...new Set([provider.default_model, ...provider.models])]
                      .filter(Boolean)
                      .map((value) => (
                        <option key={value} value={value}>
                          {value}
                          {value === provider.default_model ? ' · recommended' : ''}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              {provider.auth === 'api_key' ? (
                <form
                  class="pbm-form"
                  aria-label="Connect AI"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    if (await store.saveConnection(provider.id, apiKey, chosenModel)) setAPIKey('');
                  }}
                >
                  <label>
                    API key
                    <input
                      aria-label="API key"
                      required
                      type="password"
                      value={apiKey}
                      autoComplete="off"
                      spellcheck={false}
                      disabled={busy || running}
                      onInput={(event) => setAPIKey(event.currentTarget.value)}
                      placeholder="Paste your API key"
                    />
                    <small>
                      The key is sent directly to your server and is never saved in browser storage.
                    </small>
                  </label>
                  <button class="pbm-button" disabled={busy || running} type="submit">
                    {store.busy.value === 'connection' ? 'Connecting…' : 'Save connection'}
                  </button>
                </form>
              ) : (
                <ChatGPTConnectionPicker
                  store={store}
                  model={chosenModel}
                  disabled={busy || running}
                />
              )}
            </div>
          ) : (
            !store.refreshing.value && (
              <p class="pbm-muted">
                AI connection options could not be loaded. Refresh to try again.
              </p>
            )
          )}
        </>
      )}
    </section>
  );
}
