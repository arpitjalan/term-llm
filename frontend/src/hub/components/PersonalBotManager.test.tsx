import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import type { PersonalBotClient } from '../../api/hub-client';
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
      operation = { ...operation, action: 'start', state: 'running' };
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
    expect(localWrites).not.toHaveBeenCalled();
    expect(sessionWrites).not.toHaveBeenCalled();
    const start = screen.getByRole('button', { name: 'Start assistant' });
    // A prebuilt image can start without build tooling on the server.
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await screen.findByText('Starting your assistant…');
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

  it('keeps existing container assistants read-only and excludes duplicates and unrelated nodes', async () => {
    const node = (id: string, source = 'contain'): HubNode => ({
      id,
      name: id,
      source,
      connection: '',
      url: '',
      base_path: '',
      proxy_path: `/team/node/${id}/`,
      new_session_path: '',
      has_token: true,
      status: { reachable: true, state: 'ready', latency_ms: 1 },
    });
    const { store } = fixture([assistant], {
      listNodes: vi.fn(async () => ({
        nodes: [node('atlas'), node('existing'), node('remote', 'manual')],
      })),
    });
    render(<PersonalBotManager config={config} store={store} />);
    expect(await screen.findByRole('link', { name: 'Open existing ↗' })).toHaveAttribute(
      'href',
      '/team/node/existing/',
    );
    expect(screen.getAllByRole('button', { name: /Manage/ })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'Open atlas ↗' })).not.toBeInTheDocument();
    expect(screen.queryByText('remote')).not.toBeInTheDocument();
  });

  it('reports server setup failure and recovers with a deliberate retry', async () => {
    const environment = vi
      .fn()
      .mockResolvedValueOnce({
        available: false,
        can_build: false,
        error: 'Docker is not running.',
      })
      .mockResolvedValue({ available: true, can_build: false });
    const { store } = fixture([], { assistantEnvironment: environment });
    render(<PersonalBotManager config={config} store={store} />);
    await screen.findByText('Docker is not running.');
    expect(screen.getByRole('button', { name: 'Create assistant' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create assistant' })).toBeEnabled(),
    );
    expect(screen.queryByText('Docker is not running.')).not.toBeInTheDocument();
  });
});
