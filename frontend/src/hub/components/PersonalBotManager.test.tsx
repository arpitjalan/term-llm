import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalBotClient } from '../../api/hub-client';
import { personalBotAgentThemeKey } from '../../theme/personal-bot-theme';
import { parseHubConfig } from '../config';
import type {
  AssistantConnection,
  AssistantOperation,
  ManagedAssistant,
} from '../domain/assistants';
import type { HubNode } from '../domain/types';
import { PersonalBotManagerStore } from '../stores/personal-bot-manager';
import { PersonalBotManager } from './PersonalBotManager';

const config = parseHubConfig({
  page: 'dashboard',
  authMode: 'bearer',
  basePath: '/team',
  personalBot: true,
  canAddNodes: true,
});
const assistant: ManagedAssistant = {
  name: 'atlas',
  purpose: 'Help the team',
  state: 'needs_connection',
  needs_connection: true,
  created_at: '',
  node_id: 'atlas',
  ready: false,
  ui_url: '/team/node/atlas/',
};

function node(id: string, overrides: Partial<HubNode> = {}): HubNode {
  return {
    id,
    name: id,
    source: 'contain',
    connection: '',
    url: '',
    base_path: '',
    proxy_path: `/team/node/${id}/`,
    new_session_path: '',
    has_token: true,
    status: { reachable: true, state: 'ready', latency_ms: 1 },
    ...overrides,
  };
}

function fixture(initial: ManagedAssistant[] = [], overrides: Record<string, unknown> = {}) {
  let unauthorized: (() => Promise<void>) | undefined;
  let assistants = initial;
  let connection: AssistantConnection = {
    state: 'needs_connection',
    message: 'Connect an AI account to continue.',
  };
  let operation: AssistantOperation = {
    id: 'op',
    name: 'atlas',
    action: 'create',
    state: 'succeeded',
    started_at: '',
  };
  const client = {
    config,
    onUnauthorized: vi.fn((listener: () => Promise<void>) => {
      unauthorized = listener;
      return () => {
        unauthorized = undefined;
      };
    }),
    listAssistants: vi.fn(async () => ({ assistants })),
    listNodes: vi.fn(async () => ({ nodes: [] })),
    assistantEnvironment: vi.fn(async () => ({ available: true, can_build: false })),
    assistantProviders: vi.fn(async () => ({
      providers: [
        {
          id: 'chatgpt',
          name: 'ChatGPT',
          auth: 'device_code',
          models: ['chat-model'],
          default_model: 'chat-model',
        },
        {
          id: 'openai',
          name: 'OpenAI',
          auth: 'api_key',
          models: ['api-model'],
          default_model: 'api-model',
        },
      ],
    })),
    createAssistant: vi.fn(async (value: { name: string; purpose: string }) => {
      assistants = [{ ...assistant, ...value, operation_id: 'op' }];
      operation = { ...operation, name: value.name };
      return operation;
    }),
    assistantOperation: vi.fn(async () => operation),
    assistantConnection: vi.fn(async () => connection),
    sharedConnections: vi.fn(async () => ({ connections: [] })),
    connectionSources: vi.fn(async () => ({ sources: [] })),
    saveAssistantConnection: vi.fn(async () => {
      connection = {
        state: 'saved_unverified',
        provider: 'openai',
        model: 'api-model',
        message: 'API key saved privately. Start your assistant to use it.',
      };
      assistants = assistants.map((item) => ({
        ...item,
        state: 'stopped',
        needs_connection: false,
      }));
      return connection;
    }),
    assistantLifecycle: vi.fn(async () => {
      assistants = assistants.map((item) => ({ ...item, state: 'running', ready: false }));
      operation = {
        ...operation,
        action: 'start',
        stage: 'preparing_image',
        state: 'running',
      };
      return operation;
    }),
    ...overrides,
  };
  const store = new PersonalBotManagerStore(client as unknown as PersonalBotClient);
  return {
    store,
    client,
    expire: async () => unauthorized?.(),
    ready: () => {
      assistants = assistants.map((item) => ({ ...item, ready: true }));
      operation = { ...operation, state: 'succeeded' };
    },
  };
}

describe('Personal Bot management', () => {
  it.each([
    {
      label: 'saved',
      connections: [{ id: 'team', name: 'Team ChatGPT', provider: 'chatgpt', source: 'server' }],
      mode: 'existing',
      button: 'Use connection',
    },
    { label: 'empty', connections: [], mode: 'new', button: 'Connect ChatGPT' },
  ])(
    'keeps setup steady while refreshing an already loaded $label catalog',
    async ({ connections, mode, button }) => {
      const catalog = vi.fn(async () => ({ connections }));
      const { store } = fixture([assistant], { sharedConnections: catalog });
      render(<PersonalBotManager config={config} store={store} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Manage atlas' }));
      await waitFor(() => expect(store.refreshing.value).toBe(false));
      await waitFor(() => expect(store.connectionsLoading.value).toBe(false));
      const setup = screen.getByRole('combobox', { name: 'ChatGPT setup' });
      expect(setup).toHaveValue(mode);
      setup.focus();
      let finish!: (value: { connections: typeof connections }) => void;
      catalog.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      let refresh!: Promise<void>;
      await act(() => {
        refresh = store.refresh();
      });
      await waitFor(() => expect(store.connectionsLoading.value).toBe(true));
      try {
        expect(screen.queryByText('Checking saved connections…')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: button })).toBeEnabled();
        expect(setup).toHaveFocus();
        expect(setup).toHaveValue(mode);
      } finally {
        await act(async () => {
          finish({ connections });
          await refresh;
        });
      }
      expect(setup).toHaveFocus();
      expect(setup).toHaveValue(mode);
    },
  );

  it('shows visible Open actions for ready, verified agents and preserves management', async () => {
    const { store, client, ready } = fixture([assistant]);
    render(<PersonalBotManager config={config} store={store} />);
    await screen.findByRole('button', { name: 'Manage atlas' });
    expect(screen.queryByRole('link', { name: 'Open atlas', exact: true })).not.toBeInTheDocument();

    await waitFor(() => expect(store.refreshing.value).toBe(false));
    ready();
    await act(() => store.refresh());
    const open = await screen.findByRole('link', { name: 'Open atlas', exact: true });
    expect(open).toHaveAttribute('href', '/team/node/atlas/');
    expect(open).toBeVisible();
    expect(open).toHaveTextContent('Open atlas');

    client.listAssistants.mockRejectedValueOnce(new Error('Cannot verify agent readiness.'));
    await act(() => store.refresh());
    expect(screen.queryByRole('link', { name: 'Open atlas', exact: true })).not.toBeInTheDocument();
    await act(() => store.refresh());
    await screen.findByRole('link', { name: 'Open atlas', exact: true });

    fireEvent.click(screen.getByRole('button', { name: 'Manage atlas' }));
    await screen.findByRole('region', { name: 'Manage atlas' });
    expect(screen.getByRole('combobox', { name: 'AI connection', exact: true })).toBeVisible();
  });

  it('reuses a saved account without starting a device sign-in', async () => {
    let connection: AssistantConnection = {
      state: 'needs_connection',
      message: 'Connect an account.',
    };
    const use = vi.fn(async () => {
      connection = {
        state: 'authorized',
        provider: 'chatgpt',
        message: 'Connection ready.',
        connection_id: 'team-account',
        connection_name: 'Team ChatGPT',
      };
      return connection;
    });
    const device = vi.fn();
    const { store } = fixture([assistant], {
      sharedConnections: vi.fn(async () => ({
        connections: [
          { id: 'team-account', name: 'Team ChatGPT', provider: 'chatgpt', source: 'server' },
        ],
      })),
      assistantConnection: vi.fn(async () => connection),
      useSharedConnection: use,
      startAssistantDeviceLogin: device,
    });
    render(<PersonalBotManager config={config} store={store} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('link', { name: /^Your agents/ })).toHaveAttribute('href', '/team/');
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Manage atlas' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use connection' })).toBeEnabled(),
    );
    expect(screen.getByRole('combobox', { name: 'Saved connection' })).toHaveValue('team-account');
    fireEvent.click(screen.getByRole('button', { name: 'Use connection' }));
    await screen.findByText('Using Team ChatGPT');
    expect(use).toHaveBeenCalledWith(
      'atlas',
      { connection_id: 'team-account', model: 'chat-model' },
      expect.any(AbortSignal),
    );
    expect(device).not.toHaveBeenCalled();
  });

  it('imports an offered sign-in and assigns its reference only after submission', async () => {
    let saved = false;
    let connection: AssistantConnection = { state: 'needs_connection', message: '' };
    const shared = {
      id: 'imported',
      name: 'Research account',
      provider: 'chatgpt',
      source: 'assistant',
    };
    const importConnection = vi.fn(async () => {
      saved = true;
      return shared;
    });
    const use = vi.fn(async () => {
      connection = {
        state: 'authorized',
        provider: 'chatgpt',
        message: 'Connection ready.',
        connection_id: shared.id,
        connection_name: shared.name,
      };
      return connection;
    });
    const { store } = fixture([assistant], {
      sharedConnections: vi.fn(async () => ({ connections: saved ? [shared] : [] })),
      connectionSources: vi.fn(async () => ({
        sources: [
          {
            id: 'missing',
            name: 'Server account',
            kind: 'server',
            available: false,
            message: 'Not signed in',
          },
          { id: 'opaque-source', name: 'Research assistant', kind: 'assistant', available: true },
        ],
      })),
      assistantConnection: vi.fn(async () => connection),
      importSharedConnection: importConnection,
      useSharedConnection: use,
    });
    render(<PersonalBotManager config={config} store={store} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage atlas' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'ChatGPT setup' }), {
      target: { value: 'import' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Import and use connection' })).toBeEnabled(),
    );
    expect(screen.getByRole('option', { name: 'Server account — Not signed in' })).toBeDisabled();
    expect(importConnection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Import and use connection' }));
    await screen.findByText('Using Research account');
    expect(importConnection).toHaveBeenCalledWith(
      { source_id: 'opaque-source' },
      expect.any(AbortSignal),
    );
    expect(use).toHaveBeenCalledWith(
      'atlas',
      { connection_id: 'imported', model: 'chat-model' },
      expect.any(AbortSignal),
    );
    expect(await screen.findByRole('combobox', { name: 'Saved connection' })).toHaveValue(
      'imported',
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('retries saved connection discovery and prevents reassignment while an assistant is running', async () => {
    const list = vi
      .fn()
      .mockRejectedValueOnce(new Error('Connections unavailable.'))
      .mockResolvedValue({
        connections: [{ id: 'saved', name: 'Team account', provider: 'chatgpt', source: 'server' }],
      });
    const use = vi.fn();
    const { store } = fixture([{ ...assistant, state: 'running' }], {
      sharedConnections: list,
      useSharedConnection: use,
    });
    render(<PersonalBotManager config={config} store={store} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage atlas' }));
    await screen.findByText('Connections unavailable.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry connections' }));
    await screen.findByRole('option', { name: 'Team account' });
    expect(screen.getByRole('combobox', { name: 'ChatGPT setup' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Use connection' })).toBeDisabled();
    fireEvent.submit(screen.getByRole('form', { name: 'ChatGPT connection' }));
    expect(use).not.toHaveBeenCalled();
  });

  it('creates, connects and waits for authenticated readiness before offering Open', async () => {
    const { store, client, ready, expire } = fixture();
    const localWrites = vi.spyOn(localStorage, 'setItem');
    const sessionWrites = vi.spyOn(sessionStorage, 'setItem');
    render(<PersonalBotManager config={config} store={store} />);
    const create = await screen.findByRole('button', { name: 'Create assistant' });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    const form = screen.getByRole('form', { name: 'Create assistant' });
    fireEvent.input(within(form).getByLabelText('Name', { exact: true }), {
      target: { value: 'Atlas' },
    });
    fireEvent.input(within(form).getByLabelText('Purpose'), {
      target: { value: 'Prepare useful briefings' },
    });
    fireEvent.submit(form);
    await screen.findByRole('region', { name: 'Manage atlas' });
    expect(client.createAssistant).toHaveBeenCalledWith(
      { name: 'atlas', purpose: 'Prepare useful briefings' },
      expect.any(AbortSignal),
    );
    fireEvent.change(await screen.findByRole('combobox', { name: 'AI connection', exact: true }), {
      target: { value: 'openai' },
    });
    const key = screen.getByLabelText('API key', { exact: true });
    fireEvent.input(key, { target: { value: 'fixture-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save connection' }));
    await waitFor(() => expect(key).toHaveValue(''));
    expect(client.saveAssistantConnection).toHaveBeenCalledWith(
      'atlas',
      { provider: 'openai', api_key: 'fixture-key', model: 'api-model' },
      expect.any(AbortSignal),
    );
    expect(localWrites).toHaveBeenCalledExactlyOnceWith(
      personalBotAgentThemeKey('/team/node/atlas'),
      'system',
    );
    expect(sessionWrites).not.toHaveBeenCalled();
    const start = screen.getByRole('button', { name: 'Start assistant' });
    // A prebuilt image can start without build tooling on the server.
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await screen.findByText('Preparing your assistant runtime…');
    expect(
      screen.getByRole('progressbar', { name: 'Assistant startup in progress' }),
    ).toBeVisible();
    expect(
      screen.getByText(/can take several minutes depending on your download speed/),
    ).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open assistant' })).not.toBeInTheDocument();
    await waitFor(() => expect(store.refreshing.value).toBe(false));
    ready();
    await act(() => store.refresh());
    expect(await screen.findByRole('link', { name: 'Open assistant' })).toHaveAttribute(
      'href',
      '/team/node/atlas/',
    );
    await act(expire);
    expect(await screen.findByRole('link', { name: 'Sign in', exact: true })).toHaveAttribute(
      'href',
      '/team/',
    );
    expect(screen.queryByRole('region', { name: 'Manage atlas' })).not.toBeInTheDocument();
  });

  it('recovers a server-owned device sign-in flow and sends its ID when cancelled', async () => {
    let connection: AssistantConnection = {
      state: 'needs_connection',
      message: 'Finish signing in.',
      flow: {
        id: 'flow-123',
        state: 'pending',
        user_code: 'ABCD-EFGH',
        verification_url: 'https://auth.openai.com/codex/device',
      },
    };
    const cancel = vi.fn(async () => {
      connection = {
        state: 'needs_connection',
        message: 'Sign-in cancelled.',
        flow: { id: 'flow-123', state: 'cancelled', message: 'You can try again.' },
      };
      return connection;
    });
    const { store } = fixture([assistant], {
      assistantConnection: vi.fn(async () => connection),
      cancelAssistantDeviceLogin: cancel,
    });
    render(<PersonalBotManager config={config} store={store} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage atlas' }));
    const signIn = await screen.findByRole('region', { name: 'ChatGPT sign-in' });
    expect(within(signIn).getByText('ABCD-EFGH')).toBeVisible();
    expect(within(signIn).getByRole('link', { name: /Open ChatGPT sign-in/ })).toHaveAttribute(
      'href',
      'https://auth.openai.com/codex/device',
    );
    fireEvent.click(within(signIn).getByRole('button', { name: 'Cancel sign-in' }));
    await screen.findByText('Sign-in cancelled.');
    expect(cancel).toHaveBeenCalledWith('atlas', 'flow-123', expect.any(AbortSignal));
    expect(screen.queryByText('ABCD-EFGH')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect ChatGPT' })).toBeEnabled();
  });

  it('lists managed, container and native agents together without duplicating managed agents', async () => {
    const { store } = fixture(
      [
        {
          ...assistant,
          node_id: 'managed-atlas',
          ui_url: '/team/node/managed-atlas/',
          state: 'running',
          needs_connection: false,
          ready: true,
        },
      ],
      {
        listNodes: vi.fn(async () => ({
          nodes: [
            node('atlas'),
            node('managed-atlas'),
            node('existing'),
            node('remote', {
              source: 'local',
              status: {
                reachable: true,
                state: 'ready',
                latency_ms: 1,
                execution_environment: 'host',
              },
            }),
          ],
        })),
      },
    );
    render(<PersonalBotManager config={config} store={store} />);
    const agents = within(await screen.findByRole('region', { name: 'Your agents' }));
    expect(agents.getAllByRole('article')).toHaveLength(3);
    expect(agents.getByRole('heading', { name: 'atlas', exact: true })).toBeVisible();
    expect(agents.getByRole('heading', { name: 'existing', exact: true })).toBeVisible();
    const openManaged = agents.getByRole('link', { name: 'Open atlas', exact: true });
    expect(
      within(openManaged.closest('article')!).getByText('Container', { exact: true }),
    ).toBeVisible();
    expect(openManaged).toHaveAttribute('href', '/team/node/managed-atlas/');
    expect(openManaged).toHaveTextContent('Open atlas');
    const openExternal = agents.getByRole('link', { name: 'Open existing', exact: true });
    expect(
      within(openExternal.closest('article')!).getByText('Container', { exact: true }),
    ).toBeVisible();
    expect(openExternal).toHaveAttribute('href', '/team/node/existing/');
    expect(openExternal).toHaveTextContent('Open existing');
    expect(within(openExternal.closest('article')!).getByText('Managed externally')).toBeVisible();
    expect(
      within(openManaged.closest('article')!).queryByText('Managed externally'),
    ).not.toBeInTheDocument();
    expect(agents.getByRole('button', { name: 'Manage atlas', exact: true })).toBeVisible();
    expect(agents.queryByRole('button', { name: 'Manage existing' })).not.toBeInTheDocument();
    expect(agents.getAllByText('Managed externally')).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: 'Existing agents' })).not.toBeInTheDocument();
    expect(agents.getByRole('link', { name: 'Open remote', exact: true })).toHaveAttribute(
      'href',
      '/team/node/remote/',
    );
    const host = agents.getByRole('link', { name: 'Open remote', exact: true }).closest('article')!;
    expect(within(host).getByText('Host', { exact: true })).toBeVisible();
    fireEvent.click(agents.getByRole('button', { name: 'Manage atlas', exact: true }));
    const details = within(await screen.findByRole('region', { name: 'Manage atlas' }));
    expect(details.getByText('Container', { exact: true })).toBeVisible();
  });

  it('keeps a native assistant whose display name matches a managed assistant', async () => {
    const { store } = fixture([assistant], {
      listNodes: vi.fn(async () => ({
        nodes: [node('atlas'), node('laptop', { source: 'local', name: 'atlas' })],
      })),
    });
    render(<PersonalBotManager config={config} store={store} />);
    const agents = within(await screen.findByRole('region', { name: 'Your agents' }));
    expect(agents.getAllByRole('article')).toHaveLength(2);
    const open = agents.getByRole('link', { name: 'Open atlas', exact: true });
    expect(open).toHaveAttribute('href', '/team/node/laptop/');
    expect(within(open.closest('article')!).queryByRole('button')).not.toBeInTheDocument();
  });

  it.each([
    { source: 'local', connection: '' },
    { source: 'config', connection: '' },
    { source: 'local', connection: 'reverse' },
  ])(
    'shows a $source assistant using $connection transport without Docker controls',
    async (value) => {
      const { store } = fixture([], {
        listNodes: vi.fn(async () => ({ nodes: [node('native', value)] })),
        assistantEnvironment: vi.fn(async () => ({ available: false, can_build: false })),
      });
      render(<PersonalBotManager config={config} store={store} />);
      const agents = within(await screen.findByRole('region', { name: 'Your agents' }));
      expect(agents.getByRole('link', { name: 'Open native', exact: true })).toHaveAttribute(
        'href',
        '/team/node/native/',
      );
      expect(agents.getByText('Managed externally')).toBeVisible();
      expect(agents.getByText('Environment unknown', { exact: true })).toBeVisible();
      expect(agents.queryByRole('button')).not.toBeInTheDocument();
    },
  );

  it('connects an existing assistant without Docker while keeping container creation primary', async () => {
    let connected = false;
    const add = vi.fn(async () => {
      connected = true;
      return { id: 'native' };
    });
    const { store } = fixture([], {
      addNode: add,
      listNodes: vi.fn(async () => ({
        nodes: connected ? [node('native', { source: 'local' })] : [],
      })),
      assistantEnvironment: vi.fn(async () => ({
        available: false,
        can_build: false,
        error: 'Docker is not running.',
      })),
    });
    render(<PersonalBotManager config={config} store={store} />);
    const connect = await screen.findByRole('button', { name: 'Connect an existing assistant' });
    expect(connect).toBeEnabled();
    expect(connect).not.toHaveClass('pbm-primary');
    const create = screen.getByRole('button', { name: 'Create assistant' });
    expect(create).toBeDisabled();
    expect(create).toHaveClass('pbm-primary');
    fireEvent.click(connect);
    const form = screen.getByRole('form', { name: 'Connect an existing assistant' });
    fireEvent.input(within(form).getByLabelText('Name', { exact: true }), {
      target: { value: 'native' },
    });
    fireEvent.input(within(form).getByLabelText('URL', { exact: true }), {
      target: { value: 'http://127.0.0.1:8181/ui/' },
    });
    fireEvent.input(within(form).getByLabelText(/Bearer token/), {
      target: { value: 'private-node-token' },
    });
    fireEvent.submit(form);
    expect(await screen.findByRole('link', { name: 'Open native', exact: true })).toBeVisible();
    expect(add).toHaveBeenCalledWith(
      { name: 'native', url: 'http://127.0.0.1:8181/ui/', token: 'private-node-token' },
      expect.any(AbortSignal),
    );
    expect(
      screen.queryByRole('form', { name: 'Connect an existing assistant' }),
    ).not.toBeInTheDocument();
  });

  it('hides connection onboarding when node persistence is disabled', async () => {
    const { store } = fixture();
    render(<PersonalBotManager config={{ ...config, canAddNodes: false }} store={store} />);
    await screen.findByRole('button', { name: 'Create assistant' });
    expect(
      screen.queryByRole('button', { name: 'Connect an existing assistant' }),
    ).not.toBeInTheDocument();
  });

  it('keeps native assistant navigation on its Hub proxy route', async () => {
    const { store } = fixture([], {
      listNodes: vi.fn(async () => ({
        nodes: [node('native', { source: 'local', proxy_path: 'https://other.test/native/' })],
      })),
    });
    render(<PersonalBotManager config={config} store={store} />);
    await screen.findByRole('heading', { name: 'native', exact: true });
    expect(
      screen.queryByRole('link', { name: 'Open native', exact: true }),
    ).not.toBeInTheDocument();
  });

  it('uses the same list for external-only agents and only opens verified online agents', async () => {
    const { store, client } = fixture([], {
      listNodes: vi.fn(async () => ({
        nodes: [
          node('existing'),
          node('offline', {
            status: { reachable: false, state: 'offline', latency_ms: 0 },
          }),
        ],
      })),
    });
    render(<PersonalBotManager config={config} store={store} />);
    const agents = within(await screen.findByRole('region', { name: 'Your agents' }));
    expect(agents.getAllByRole('article')).toHaveLength(2);
    expect(agents.getAllByText('Managed externally')).toHaveLength(2);
    expect(agents.queryByRole('button', { name: /^Manage / })).not.toBeInTheDocument();
    expect(agents.getByRole('link', { name: 'Open existing', exact: true })).toBeVisible();
    expect(
      agents.queryByRole('link', { name: 'Open offline', exact: true }),
    ).not.toBeInTheDocument();
    expect(agents.getByText('Offline', { exact: true })).toBeVisible();

    await waitFor(() => expect(store.refreshing.value).toBe(false));
    client.listNodes.mockRejectedValueOnce(new Error('Cannot verify agent availability.'));
    await act(() => store.refresh());
    expect(
      screen.queryByRole('link', { name: 'Open existing', exact: true }),
    ).not.toBeInTheDocument();
    await act(() => store.refresh());
    expect(screen.getByRole('link', { name: 'Open existing', exact: true })).toBeVisible();
    expect(
      screen.queryByRole('link', { name: 'Open offline', exact: true }),
    ).not.toBeInTheDocument();
  });

  it.each(['Docker is not running.', 'Preparing the Linux assistant runtime failed.'])(
    'reports setup failure "%s" without assuming Docker is missing and recovers on retry',
    async (error) => {
      const environment = vi
        .fn()
        .mockResolvedValueOnce({
          available: false,
          can_build: false,
          error,
        })
        .mockResolvedValue({ available: true, can_build: false });
      const { store } = fixture([], { assistantEnvironment: environment });
      render(<PersonalBotManager config={config} store={store} />);
      await screen.findByText(error);
      expect(screen.getByText('Assistant creation needs setup')).toBeVisible();
      expect(screen.queryByText('Creating new assistants needs Docker')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create assistant' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Connect an existing assistant' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Create assistant' })).toBeEnabled(),
      );
      expect(screen.queryByText(error)).not.toBeInTheDocument();
      expect(screen.queryByText('Assistant creation needs setup')).not.toBeInTheDocument();
    },
  );
});
