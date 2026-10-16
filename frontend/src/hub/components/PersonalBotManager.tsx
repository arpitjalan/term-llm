import { useEffect, useLayoutEffect, useState } from 'preact/hooks';
import { hubPath, type HubConfig } from '../config';
import { assistantProxyURL, type ManagedAssistant } from '../domain/assistants';
import type { PersonalBotManagerStore } from '../stores/personal-bot-manager';
import { ConnectionForm } from './ConnectionForm';
import { initializePersonalBotTheme } from '../../theme/personal-bot-theme';
import { ThemePicker } from '../../theme/ThemePicker';
import { BrandMark } from '../../components/BrandMark';
import { PendingLabel } from '../../components/PendingLabel';
import '../styles/personal-bot-manager.css';
import '../../theme/personal-bot-theme.css';

function CreateAssistant({ store, close }: { store: PersonalBotManagerStore; close: () => void }) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  return (
    <form
      class="pbm-panel pbm-form"
      aria-label="Create assistant"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await store.create(name.trim(), purpose.trim())) close();
      }}
    >
      <div class="pbm-section-heading">
        <div>
          <p class="pbm-eyebrow">First, make it yours</p>
          <h2>Create an assistant</h2>
        </div>
        <button class="pbm-button" type="button" disabled={!!store.busy.value} onClick={close}>
          Cancel
        </button>
      </div>
      <label>
        Name
        <input
          aria-label="Name"
          required
          maxLength={48}
          pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
          value={name}
          onInput={(event) => setName(event.currentTarget.value.toLowerCase())}
          placeholder="atlas"
          autoComplete="off"
        />
        <small>Use letters, numbers, and dashes. For example, atlas or team-assistant.</small>
      </label>
      <label>
        Purpose
        <textarea
          required
          maxLength={4000}
          rows={4}
          value={purpose}
          onInput={(event) => setPurpose(event.currentTarget.value)}
          placeholder="Help our team stay on top of research, prepare useful briefings, and follow through on recurring work."
        />
      </label>
      <p class="pbm-muted">
        Describe the help you want and how you like to work. You’ll connect an AI account next.
      </p>
      <button
        class="pbm-button pbm-primary"
        type="submit"
        disabled={!!store.busy.value || !store.environment.value?.available}
      >
        <PendingLabel
          pending={store.busy.value === 'create'}
          label="Create assistant"
          pendingLabel="Creating…"
        />
      </button>
    </form>
  );
}

function AssistantDetails({
  store,
  config,
  assistant,
}: {
  store: PersonalBotManagerStore;
  config: HubConfig;
  assistant: ManagedAssistant;
}) {
  const operation = store.operation.value?.name === assistant.name ? store.operation.value : null;
  const pending = operation?.state === 'running';
  const busy = !!store.busy.value || pending;
  const connected =
    store.connection.value?.state === 'authorized' ||
    store.connection.value?.state === 'saved_unverified';
  const link =
    assistant.ready && store.assistantsVerified.value
      ? assistantProxyURL(assistant.ui_url, config.basePath, assistant.node_id)
      : '';
  return (
    <section class="pbm-panel pbm-details" aria-label={`Manage ${assistant.name}`}>
      <div class="pbm-section-heading">
        <div>
          <p class="pbm-eyebrow">Your assistant</p>
          <h2>{assistant.name}</h2>
        </div>
        <button class="pbm-button" disabled={!!store.busy.value} onClick={() => store.select('')}>
          Back to agents
        </button>
      </div>
      <p>{assistant.purpose}</p>
      <ol class="pbm-steps" aria-label="Assistant setup">
        <li>
          1. Create <span>✓</span>
        </li>
        <li aria-current={!connected ? 'step' : undefined}>
          2. Connect AI {connected && <span>✓</span>}
        </li>
        <li aria-current={connected && !assistant.ready ? 'step' : undefined}>
          3. Start {assistant.ready && <span>✓</span>}
        </li>
      </ol>
      {operation && (
        <div
          class={`pbm-operation ${operation.state === 'failed' ? 'pbm-error' : ''}`}
          role={operation.state === 'failed' ? 'alert' : 'status'}
        >
          {operation.state === 'running'
            ? `${operation.action === 'create' ? 'Creating' : operation.action === 'stop' ? 'Stopping' : operation.action === 'restart' ? 'Restarting' : 'Starting'} your assistant…`
            : operation.state === 'failed'
              ? operation.error || 'The operation could not finish. Refresh and try again.'
              : `${operation.action === 'stop' ? 'Assistant stopped.' : operation.action === 'create' ? 'Assistant created.' : 'Startup completed.'}`}
          {pending && (
            <p>
              The first start can take a few minutes. You can leave this page and return to check
              progress.
            </p>
          )}
        </div>
      )}
      {assistant.error && operation?.error !== assistant.error && (
        <p class="pbm-error" role="alert">
          {assistant.error}
        </p>
      )}
      <ConnectionForm key={assistant.name} store={store} assistant={assistant} />
      <section class="pbm-launch" aria-label="Assistant controls">
        <h3>{assistant.ready ? 'Ready when you are' : 'Bring your assistant online'}</h3>
        <p class="pbm-muted">
          Once started, your assistant stays on this server when you close your browser.
        </p>
        <div class="pbm-actions">
          {link && (
            <a class="pbm-button pbm-primary" href={link}>
              Open assistant <span aria-hidden="true">↗</span>
            </a>
          )}
          {assistant.state === 'running' ? (
            <>
              <button
                class="pbm-button"
                disabled={busy}
                onClick={() => void store.lifecycle(assistant.name, 'stop')}
              >
                Stop assistant
              </button>
              <button
                class="pbm-button"
                disabled={busy || !store.environment.value?.available}
                onClick={() => void store.lifecycle(assistant.name, 'restart')}
              >
                Restart assistant
              </button>
            </>
          ) : (
            <button
              class="pbm-button pbm-primary"
              disabled={busy || !connected || !store.environment.value?.available}
              onClick={() => void store.lifecycle(assistant.name, 'start')}
            >
              Start assistant
            </button>
          )}
        </div>
        {assistant.state === 'running' && !assistant.ready && (
          <p role="status">
            The assistant is starting up or temporarily unavailable. Open becomes available when it
            responds.
          </p>
        )}
        {store.connection.value?.state === 'saved_unverified' && (
          <p class="pbm-muted">
            Your API key is saved. Your first conversation will check whether the provider accepts
            it.
          </p>
        )}
      </section>
    </section>
  );
}

export function PersonalBotManager({
  config,
  store,
}: {
  config: HubConfig;
  store: PersonalBotManagerStore;
}) {
  useLayoutEffect(initializePersonalBotTheme, []);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    store.start();
    return () => store.dispose();
  }, [store]);
  const assistants = store.assistants.value;
  const selected = assistants.find((item) => item.name === store.selected.value);
  const managedIDs = new Set(assistants.flatMap((item) => [item.name, item.node_id]));
  const existing = store.nodes.value.filter(
    (node) => node.source === 'contain' && !managedIDs.has(node.id) && !managedIDs.has(node.name),
  );
  const env = store.environment.value;
  return (
    <div class="pbm-app">
      <header class="pbm-header">
        <a class="pbm-brand" href={hubPath(config.basePath, '/')}>
          <BrandMark class="pbm-brand-mark" />
          <strong>
            Your agents<small>A little help, always here.</small>
          </strong>
        </a>
        <div class="pbm-actions">
          <ThemePicker compact />
          {!store.authLost.value && config.passkeyAuth && (
            <a class="pbm-button" href={hubPath(config.basePath, '/auth/security')}>
              Security
            </a>
          )}
          <button
            class="pbm-button"
            disabled={store.refreshing.value || store.authLost.value}
            onClick={() => void store.refresh()}
          >
            <PendingLabel
              pending={store.refreshing.value}
              label="Refresh"
              pendingLabel="Refreshing…"
            />
          </button>
        </div>
      </header>
      <main class="pbm-main">
        {store.authLost.value ? (
          <section class="pbm-panel" role="alert">
            <h1>Sign in to continue</h1>
            <p>Your session is no longer authorized. Sign in again to see your agents.</p>
            <a
              class="pbm-button pbm-primary"
              href={hubPath(config.basePath, config.authMode === 'passkey' ? '/auth/login' : '/')}
            >
              Sign in
            </a>
          </section>
        ) : (
          <>
            {(store.error.value || store.actionError.value) && (
              <div class="pbm-error" role="alert">
                {store.actionError.value || store.error.value}
                <button
                  class="pbm-button"
                  disabled={store.refreshing.value}
                  onClick={() => {
                    store.actionError.value = '';
                    void store.refresh();
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {env && !env.available && (
              <div class="pbm-environment" role="status">
                <strong>One server setup step remains</strong>
                <p>
                  {env.error ||
                    env.build_hint ||
                    'The server is not ready to start assistants. Ask your administrator to check its setup.'}
                </p>
                <button
                  class="pbm-button"
                  disabled={store.refreshing.value}
                  onClick={() => void store.refresh()}
                >
                  Check again
                </button>
              </div>
            )}
            {store.loading.value ? (
              <p class="pbm-loading" role="status">
                Finding your agents…
              </p>
            ) : selected ? (
              <AssistantDetails config={config} store={store} assistant={selected} />
            ) : creating ? (
              <CreateAssistant store={store} close={() => setCreating(false)} />
            ) : (
              <>
                <section class="pbm-welcome">
                  <div class="pbm-orb" aria-hidden="true" />
                  <p class="pbm-eyebrow">Your team, with a little more headspace</p>
                  <h1>
                    {assistants.length || existing.length
                      ? 'Your agents'
                      : 'A little help, always here.'}
                  </h1>
                  <p>
                    Give your assistant a purpose. Connect your AI account.
                    <br />
                    Then give it something to take off your plate.
                  </p>
                  <button
                    class="pbm-button pbm-primary"
                    disabled={!env?.available || !!store.busy.value}
                    onClick={() => {
                      store.select('');
                      setCreating(true);
                    }}
                  >
                    Create assistant <span aria-hidden="true">↗</span>
                  </button>
                </section>
                {!!assistants.length && (
                  <section class="pbm-grid" aria-label="Your agents">
                    {assistants.map((assistant) => {
                      const link =
                        assistant.ready && store.assistantsVerified.value
                          ? assistantProxyURL(assistant.ui_url, config.basePath, assistant.node_id)
                          : '';
                      return (
                        <article class="pbm-panel pbm-card" key={assistant.name}>
                          {link && (
                            <a
                              class="pbm-card-link"
                              href={link}
                              aria-label={`Open ${assistant.name}`}
                            />
                          )}
                          <div class="pbm-section-heading">
                            <h2>{assistant.name}</h2>
                            <span class={`pbm-status ${assistant.ready ? 'is-ready' : ''}`}>
                              {assistant.ready
                                ? 'Ready'
                                : assistant.needs_connection
                                  ? 'Connect AI'
                                  : assistant.state === 'running'
                                    ? 'Starting up'
                                    : assistant.state === 'stopped'
                                      ? 'Stopped'
                                      : 'Unavailable'}
                            </span>
                          </div>
                          <p>{assistant.purpose}</p>
                          <button class="pbm-button" onClick={() => store.select(assistant.name)}>
                            Manage {assistant.name}
                          </button>
                        </article>
                      );
                    })}
                  </section>
                )}
                {!!existing.length && (
                  <section class="pbm-existing">
                    <h2>Existing agents</h2>
                    <p class="pbm-muted">
                      These assistants are already set up on this server. Their setup is managed
                      outside this page.
                    </p>
                    <div class="pbm-grid">
                      {existing.map((node) => {
                        const link =
                          node.status.reachable && store.nodesVerified.value
                            ? assistantProxyURL(node.proxy_path, config.basePath, node.id)
                            : '';
                        return (
                          <article class="pbm-panel pbm-card" key={node.id}>
                            <div class="pbm-section-heading">
                              <h3>{node.name}</h3>
                              <span class={`pbm-status ${node.status.reachable ? 'is-ready' : ''}`}>
                                {node.status.reachable ? 'Online' : 'Offline'}
                              </span>
                            </div>
                            {link ? (
                              <a class="pbm-button" href={link}>
                                Open {node.name} ↗
                              </a>
                            ) : (
                              <p class="pbm-muted">This assistant is not responding yet.</p>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                )}
                {!assistants.length && !existing.length && (
                  <ol class="pbm-intro-steps">
                    <li>
                      <span>01</span>
                      <strong>Make it yours</strong>
                      <p>A name and a purpose. A clear idea of what useful help looks like.</p>
                    </li>
                    <li>
                      <span>02</span>
                      <strong>Connect your AI</strong>
                      <p>Use ChatGPT sign-in or an API key from a supported provider.</p>
                    </li>
                    <li>
                      <span>03</span>
                      <strong>Put it to work</strong>
                      <p>Chat, set up routines, and return to results in your browser.</p>
                    </li>
                  </ol>
                )}
              </>
            )}
            {!selected && store.selected.value && store.operation.value?.state === 'running' && (
              <p role="status">
                Creating {store.selected.value}… This page will update when it is ready.
              </p>
            )}
          </>
        )}
      </main>
      <footer class="pbm-footer">Your workspace. Your assistant. Powered by term-llm.</footer>
    </div>
  );
}
