import { describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/preact';
import { HubAPIError, type PersonalBotClient } from '../../api/hub-client';
import type {
  AssistantConnection,
  AssistantOperation,
  ManagedAssistant,
} from '../domain/assistants';
import { PersonalBotManagerStore } from './personal-bot-manager';

const assistant: ManagedAssistant = {
  name: 'atlas',
  purpose: 'Help the team',
  state: 'stopped',
  needs_connection: false,
  node_id: 'atlas',
  ready: false,
  ui_url: '/node/atlas/',
  created_at: '',
  operation_id: 'op-1',
};
const operation: AssistantOperation = {
  id: 'op-1',
  name: 'atlas',
  action: 'start',
  state: 'running',
  started_at: '',
};
const saved: AssistantConnection = {
  state: 'saved_unverified',
  provider: 'openai',
  message: 'Key saved.',
};

function fixture(overrides: Record<string, unknown> = {}) {
  let unauthorized!: () => Promise<void>;
  const removeListener = vi.fn();
  const client = {
    onUnauthorized: vi.fn((listener: () => Promise<void>) => {
      unauthorized = listener;
      return removeListener;
    }),
    listAssistants: vi.fn<PersonalBotClient['listAssistants']>(async () => ({
      assistants: [assistant],
    })),
    listNodes: vi.fn(async () => ({ nodes: [] })),
    assistantEnvironment: vi.fn(async () => ({ available: true, can_build: true })),
    assistantProviders: vi.fn(async () => ({ providers: [] })),
    assistantConnection: vi.fn(async () => saved),
    sharedConnections: vi.fn(async () => ({ connections: [] })),
    connectionSources: vi.fn(async () => ({ sources: [] })),
    assistantOperation: vi.fn(async () => operation),
    ...overrides,
  };
  const store = new PersonalBotManagerStore(client as unknown as PersonalBotClient);
  return { store, client, unauthorized: () => unauthorized(), removeListener };
}

describe('Personal Bot manager lifecycle', () => {
  it.each([
    { label: 'empty', providers: [] },
    {
      label: 'nonempty',
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          auth: 'api_key' as const,
          default_model: 'model',
          models: ['model'],
        },
      ],
    },
  ])(
    'loads a successful $label provider catalog once while polling dynamic state',
    async ({ providers }) => {
      const read = vi.fn(async () => ({ providers }));
      const { store, client } = fixture({ assistantProviders: read });
      try {
        await store.refresh();
        await store.refresh();
        expect(store.providers.value).toEqual(providers);
        expect(read).toHaveBeenCalledOnce();
        expect(client.listAssistants).toHaveBeenCalledTimes(2);
        expect(client.listNodes).toHaveBeenCalledTimes(2);
        expect(client.assistantEnvironment).toHaveBeenCalledTimes(2);
      } finally {
        store.dispose();
      }
    },
  );

  it('retries a failed provider catalog read and retains the successful result', async () => {
    const read = vi
      .fn()
      .mockRejectedValueOnce(new Error('Provider choices are unavailable.'))
      .mockResolvedValue({ providers: [] });
    const { store } = fixture({ assistantProviders: read });
    try {
      await store.refresh();
      expect(store.error.value).toContain('Provider choices are unavailable.');
      await store.refresh();
      expect(store.error.value).toBe('');
      await store.refresh();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      store.dispose();
    }
  });

  it('allows a slow sign-in import to finish preparing its helper before assigning it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const shared = { id: 'imported', name: 'Team ChatGPT', provider: 'chatgpt', source: 'server' };
    const importing = vi.fn(
      (_value: unknown, signal: AbortSignal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve(shared), 45_000);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason);
          });
        }),
    );
    const use = vi.fn(async () => saved);
    const { store } = fixture({ importSharedConnection: importing, useSharedConnection: use });
    try {
      store.selected.value = 'atlas';
      const pending = store.importConnection('offered-source', 'model');
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await pending).toBe(true);
      expect(importing).toHaveBeenCalledOnce();
      expect(use).toHaveBeenCalledExactlyOnceWith(
        'atlas',
        { connection_id: shared.id, model: 'model' },
        expect.any(AbortSignal),
      );
      expect(store.connection.value).toEqual(saved);
    } finally {
      store.dispose();
      vi.useRealTimers();
    }
  });

  it('still bounds an unresponsive sign-in import without retrying it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const importing = vi.fn(
      (_value: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const use = vi.fn(async () => saved);
    const { store } = fixture({ importSharedConnection: importing, useSharedConnection: use });
    try {
      store.selected.value = 'atlas';
      const pending = store.importConnection('offered-source', 'model');
      await vi.advanceTimersByTimeAsync(150_000);
      expect(await pending).toBe(false);
      expect(importing).toHaveBeenCalledOnce();
      expect(use).not.toHaveBeenCalled();
      expect(store.busy.value).toBe('');
      expect(store.actionError.value).toContain('Refresh to check the server');
    } finally {
      store.dispose();
      vi.useRealTimers();
    }
  });

  it('refreshes the catalog when device sign-in attaches a reusable account', async () => {
    const catalog = vi.fn(async () => ({
      connections: [
        { id: 'new-account', name: 'Team ChatGPT', provider: 'chatgpt', source: 'hub' },
      ],
    }));
    const { store } = fixture({
      assistantConnection: vi.fn(async () => ({
        state: 'authorized',
        provider: 'chatgpt',
        connection_id: 'new-account',
        message: 'Signed in.',
        flow: { id: 'flow', state: 'succeeded' },
      })),
      sharedConnections: catalog,
    });
    try {
      store.selected.value = 'atlas';
      store.connection.value = {
        state: 'needs_connection',
        message: '',
        flow: { id: 'flow', state: 'pending' },
      };
      await store.loadConnection();
      await waitFor(() => expect(store.sharedConnections.value[0]?.id).toBe('new-account'));
      expect(catalog).toHaveBeenCalledOnce();
    } finally {
      store.dispose();
    }
  });

  it('keeps a successful import discoverable if assigning it fails without repeating the import', async () => {
    const shared = { id: 'imported', name: 'Team ChatGPT', provider: 'chatgpt', source: 'server' };
    const importing = vi.fn(async () => shared);
    const catalog = vi.fn(async () => ({ connections: [shared] }));
    const { store } = fixture({
      importSharedConnection: importing,
      useSharedConnection: vi
        .fn()
        .mockRejectedValue(new HubAPIError(409, 'Stop the assistant before changing connections.')),
      sharedConnections: catalog,
    });
    try {
      store.selected.value = 'atlas';
      expect(await store.importConnection('offered-source', 'model')).toBe(false);
      await waitFor(() => expect(store.sharedConnections.value[0]?.id).toBe('imported'));
      expect(store.actionError.value).toContain('Stop the assistant');
      expect(importing).toHaveBeenCalledOnce();
    } finally {
      store.dispose();
    }
  });

  it('restores an in-progress operation after selection and stops polling terminal operations', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(operation)
      .mockResolvedValue({ ...operation, state: 'succeeded' });
    const { store } = fixture({ assistantOperation: read });
    try {
      await store.refresh();
      store.select('atlas');
      await waitFor(() => expect(store.operation.value?.state).toBe('running'));
      await waitFor(() => expect(store.refreshing.value).toBe(false));
      await store.refresh();
      expect(store.operation.value?.state).toBe('succeeded');
      await store.refresh();
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      store.dispose();
    }
  });

  it('does not let an old connection read replace a newly saved key status', async () => {
    let finish!: (value: AssistantConnection) => void;
    const connection = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<AssistantConnection>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(saved);
    const { store } = fixture({
      assistantConnection: connection,
      saveAssistantConnection: vi.fn(async () => saved),
    });
    try {
      await store.refresh();
      store.select('atlas');
      await store.saveConnection('openai', 'fixture-key', 'fixture-model');
      expect(store.connection.value?.state).toBe('saved_unverified');
      finish({ state: 'needs_connection', message: 'Old response' });
      await waitFor(() => expect(store.connectionLoading.value).toBe(false));
      expect(store.connection.value?.state).toBe('saved_unverified');
    } finally {
      store.dispose();
    }
  });

  it('shows partial-list warnings and never replays an uncertain mutation', async () => {
    const create = vi.fn().mockRejectedValue(new Error('connection lost'));
    const { store } = fixture({
      listAssistants: vi.fn(async () => ({
        assistants: [assistant],
        warning: 'Docker is unavailable.',
      })),
      listNodes: vi.fn(async () => ({
        nodes: [],
        resolver_error: 'Some existing assistants could not be found.',
      })),
      createAssistant: create,
    });
    try {
      await store.refresh();
      expect(store.error.value).toContain('Docker is unavailable.');
      expect(store.error.value).toContain('Some existing assistants');
      expect(await store.create('new', 'Help')).toBe(false);
      expect(store.actionError.value).toContain('Refresh to check the server');
      await store.refresh();
      expect(create).toHaveBeenCalledOnce();
    } finally {
      store.dispose();
    }
  });

  it('clears private state on auth loss, aborts pending requests and ignores late responses', async () => {
    const { store, client, unauthorized, removeListener } = fixture();
    store.start();
    await waitFor(() => expect(store.loading.value).toBe(false));
    store.select('atlas');
    await waitFor(() => expect(store.connection.value).toEqual(saved));
    await waitFor(() => expect(store.refreshing.value).toBe(false));
    let finish!: (value: { assistants: ManagedAssistant[] }) => void;
    let requestSignal: AbortSignal | undefined;
    client.listAssistants.mockImplementationOnce((signal?: AbortSignal) => {
      requestSignal = signal;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const pending = store.refresh();
    store.sharedConnections.value = [
      { id: 'private', name: 'Private account', provider: 'chatgpt', source: 'server' },
    ];
    store.connectionSources.value = [
      { id: 'source', name: 'Private sign-in', kind: 'server', available: true },
    ];
    await unauthorized();
    expect(requestSignal?.aborted).toBe(true);
    finish({ assistants: [assistant] });
    await pending;
    expect(store.authLost.value).toBe(true);
    expect(store.assistants.value).toEqual([]);
    expect(store.connection.value).toBeNull();
    expect(store.sharedConnections.value).toEqual([]);
    expect(store.connectionSources.value).toEqual([]);
    expect(store.operation.value).toBeNull();
    store.dispose();
    expect(removeListener).toHaveBeenCalledOnce();
  });

  it('keeps server action errors actionable and cancels only the current device flow', async () => {
    const cancel = vi
      .fn()
      .mockRejectedValue(new HubAPIError(409, 'The sign-in flow changed. Refresh and try again.'));
    const { store } = fixture({ cancelAssistantDeviceLogin: cancel });
    try {
      store.selected.value = 'atlas';
      store.connection.value = {
        state: 'needs_connection',
        message: '',
        flow: { id: 'current', state: 'pending' },
      };
      expect(await store.cancelDeviceLogin()).toBe(false);
      expect(cancel).toHaveBeenCalledWith('atlas', 'current', expect.any(AbortSignal));
      expect(store.actionError.value).toContain('sign-in flow changed');
    } finally {
      store.dispose();
    }
  });
});
