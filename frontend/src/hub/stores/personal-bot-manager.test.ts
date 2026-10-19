import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/preact';
import { HubAPIError, type PersonalBotClient } from '../../api/hub-client';
import {
  PERSONAL_BOT_THEME_KEY,
  personalBotAgentThemeKey,
  personalBotTheme,
  setPersonalBotTheme,
} from '../../theme/personal-bot-theme';
import type {
  AssistantConnection,
  AssistantOperation,
  ManagedAssistant,
} from '../domain/assistants';
import { PersonalBotManagerStore } from './personal-bot-manager';
import type { HubNode, TestNodeResponse } from '../domain/types';

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
const nativeNode: HubNode = {
  id: 'native',
  name: 'My computer',
  source: 'file',
  connection: 'http',
  url: 'http://computer.test/chat',
  base_path: '/chat',
  proxy_path: '/node/native/',
  new_session_path: '/node/native/?new=1',
  has_token: true,
  status: { reachable: true, state: 'ready', latency_ms: 3 },
};
const existingAssistant = {
  name: 'My computer',
  url: 'http://computer.test/chat',
  token: 'fixture-bearer',
};

function fixture(overrides: Record<string, unknown> = {}) {
  let unauthorized!: () => Promise<void>;
  const removeListener = vi.fn();
  const client = {
    config: { basePath: '' },
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

afterEach(() => {
  personalBotTheme.value = 'system';
});

describe('New assistant themes', () => {
  it('captures the Hub choice before creation finishes and keeps each assistant independent', async () => {
    let finish!: (value: AssistantOperation) => void;
    const create = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<AssistantOperation>((resolve) => (finish = resolve)),
      )
      .mockResolvedValue({ ...operation, action: 'create', name: 'other' });
    const { store } = fixture({ config: { basePath: '/team/hub' }, createAssistant: create });
    try {
      setPersonalBotTheme('nord');
      const pending = store.create('atlas', 'Help');
      setPersonalBotTheme('dracula');
      finish({ ...operation, action: 'create' });
      expect(await pending).toBe(true);
      expect(localStorage.getItem(personalBotAgentThemeKey('/team/hub/node/atlas'))).toBe('nord');
      expect(await store.create('other', 'Help')).toBe(true);
      expect(localStorage.getItem(personalBotAgentThemeKey('/team/hub/node/other'))).toBe(
        'dracula',
      );
      expect(localStorage.getItem(personalBotAgentThemeKey('/team/hub/node/atlas'))).toBe('nord');
      expect(localStorage.getItem(PERSONAL_BOT_THEME_KEY)).toBe('dracula');
      expect(personalBotTheme.value).toBe('dracula');
    } finally {
      store.dispose();
    }
  });

  it.each(['rejected', 'failed'])('does not save a theme after a %s creation', async (outcome) => {
    const create = vi.fn();
    if (outcome === 'rejected') create.mockRejectedValue(new Error('Creation failed.'));
    else create.mockResolvedValue({ ...operation, action: 'create', state: 'failed' });
    const { store } = fixture({ createAssistant: create });
    try {
      setPersonalBotTheme('nord');
      await store.create('atlas', 'Help');
      expect(localStorage.getItem(personalBotAgentThemeKey('/node/atlas'))).toBeNull();
      expect(localStorage.getItem(PERSONAL_BOT_THEME_KEY)).toBe('nord');
    } finally {
      store.dispose();
    }
  });

  it.each(['create', 'connect'])(
    'completes %s when browser theme storage is unavailable',
    async (action) => {
      const { store } = fixture({
        createAssistant: vi.fn(async () => ({ ...operation, action: 'create' })),
        addNode: vi.fn(async () => ({ id: nativeNode.id })),
      });
      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new Error('Storage denied');
      });
      try {
        const result =
          action === 'create'
            ? await store.create('atlas', 'Help')
            : await store.connectExistingAssistant(existingAssistant);
        expect(result).toBe(true);
        expect(store.actionError.value).toBe('');
        expect(store.existingConnectionError.value).toBe('');
      } finally {
        store.dispose();
      }
    },
  );
});

describe('Personal Bot manager lifecycle', () => {
  it('polls general status every fifteen seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { store, client } = fixture();
    try {
      store.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.listAssistants).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(client.listAssistants).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(client.listAssistants).toHaveBeenCalledTimes(2);
    } finally {
      store.dispose();
      vi.useRealTimers();
    }
  });

  it('keeps checking a pending ChatGPT sign-in every two seconds', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const connection = {
      state: 'needs_connection',
      message: '',
      flow: { id: 'flow', state: 'pending' },
    };
    const read = vi.fn(async () => connection);
    const { store, client } = fixture({ assistantConnection: read });
    try {
      store.start();
      await vi.advanceTimersByTimeAsync(0);
      store.select('atlas');
      await vi.advanceTimersByTimeAsync(0);
      const connectionReads = read.mock.calls.length;
      const statusReads = client.listAssistants.mock.calls.length;
      expect(connectionReads).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(read).toHaveBeenCalledTimes(connectionReads);
      await vi.advanceTimersByTimeAsync(1);
      expect(read).toHaveBeenCalledTimes(connectionReads + 1);
      expect(client.listAssistants).toHaveBeenCalledTimes(statusReads);
      store.connection.value = { state: 'authorized', message: 'Signed in.' };
      await vi.advanceTimersByTimeAsync(2_000);
      expect(read).toHaveBeenCalledTimes(connectionReads + 1);
    } finally {
      store.dispose();
      vi.useRealTimers();
    }
  });

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

  it.each([
    { label: 'empty', connections: [], sources: [] },
    {
      label: 'nonempty',
      connections: [{ id: 'account', name: 'Team ChatGPT', provider: 'chatgpt', source: 'hub' }],
      sources: [{ id: 'source', name: 'Saved ChatGPT', kind: 'server', available: true }],
    },
  ])(
    'retains a successful $label connection catalog if a background reload fails',
    async ({ connections, sources }) => {
      const { store } = fixture({
        sharedConnections: vi
          .fn()
          .mockResolvedValueOnce({ connections })
          .mockRejectedValueOnce(new Error('Connections are temporarily unavailable.')),
        connectionSources: vi.fn(async () => ({ sources })),
      });
      try {
        expect(store.connectionsLoaded.value).toBe(false);
        await store.loadSharedConnections();
        expect(store.connectionsLoaded.value).toBe(true);
        await store.loadSharedConnections();
        expect(store.connectionsLoaded.value).toBe(true);
        expect(store.sharedConnections.value).toEqual(connections);
        expect(store.connectionSources.value).toEqual(sources);
        expect(store.connectionsError.value).toBe('Connections are temporarily unavailable.');
        expect(store.connectionsLoading.value).toBe(false);
      } finally {
        store.dispose();
      }
    },
  );

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

  it.each([
    { label: 'successful', assignmentFails: false },
    { label: 'failed', assignmentFails: true },
  ])(
    'keeps an imported account visible after a $label assignment during background reloads',
    async ({ assignmentFails }) => {
      const shared = {
        id: 'imported',
        name: 'Team ChatGPT',
        provider: 'chatgpt',
        source: 'server',
      };
      let finishImport!: (value: typeof shared) => void;
      let finishBackground!: (value: { connections: (typeof shared)[] }) => void;
      let finishDuringImport!: (value: { connections: (typeof shared)[] }) => void;
      const importing = vi.fn(
        () => new Promise<typeof shared>((resolve) => (finishImport = resolve)),
      );
      const catalog = vi
        .fn()
        .mockResolvedValueOnce({ connections: [] })
        .mockImplementationOnce(() => new Promise((resolve) => (finishBackground = resolve)))
        .mockImplementationOnce(() => new Promise((resolve) => (finishDuringImport = resolve)))
        .mockResolvedValue({ connections: [shared] });
      const use = assignmentFails
        ? vi
            .fn()
            .mockRejectedValue(
              new HubAPIError(409, 'Stop the assistant before changing connections.'),
            )
        : vi.fn(async () => ({ ...saved, connection_id: shared.id }));
      const { store } = fixture({
        listAssistants: vi.fn(async () => ({ assistants: [] })),
        importSharedConnection: importing,
        useSharedConnection: use,
        sharedConnections: catalog,
      });
      try {
        store.selected.value = 'atlas';
        await store.loadSharedConnections();
        const background = store.loadSharedConnections();
        const pendingImport = store.importConnection('source', 'model');
        finishBackground({ connections: [] });
        await background;
        await waitFor(() => expect(catalog).toHaveBeenCalledTimes(3));
        finishImport(shared);
        expect(await pendingImport).toBe(!assignmentFails);
        finishDuringImport({ connections: [] });
        await waitFor(() => expect(store.sharedConnections.value).toEqual([shared]));
        expect(importing).toHaveBeenCalledOnce();
        expect(use).toHaveBeenCalledOnce();
      } finally {
        store.dispose();
      }
    },
  );

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

  it('loads the current selection after an older connection request finishes', async () => {
    let finish!: (value: AssistantConnection) => void;
    const read = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<AssistantConnection>((resolve) => (finish = resolve)),
      )
      .mockResolvedValue({ ...saved, message: 'Current assistant connection.' });
    const { store } = fixture({ assistantConnection: read });
    try {
      store.select('atlas');
      store.select('other');
      expect(read).toHaveBeenCalledOnce();
      finish({ state: 'needs_connection', message: 'Old assistant connection.' });
      await waitFor(() =>
        expect(store.connection.value?.message).toBe('Current assistant connection.'),
      );
      expect(read).toHaveBeenLastCalledWith('other', expect.any(AbortSignal));
      expect(store.connectionError.value).toBe('');
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
    store.connectionsLoaded.value = true;
    await unauthorized();
    expect(requestSignal?.aborted).toBe(true);
    finish({ assistants: [assistant] });
    await pending;
    expect(store.authLost.value).toBe(true);
    expect(store.assistants.value).toEqual([]);
    expect(store.connection.value).toBeNull();
    expect(store.sharedConnections.value).toEqual([]);
    expect(store.connectionSources.value).toEqual([]);
    expect(store.connectionsLoaded.value).toBe(false);
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

describe('Connecting existing assistants', () => {
  it('saves credentials server-side and refreshes native nodes without Docker or a provider catalog', async () => {
    const add = vi.fn(async () => ({ id: nativeNode.id }));
    const readNodes = vi.fn(async () => ({ nodes: [nativeNode] }));
    const localWrites = vi.spyOn(localStorage, 'setItem');
    const sessionWrites = vi.spyOn(sessionStorage, 'setItem');
    const { store, client } = fixture({ addNode: add, listNodes: readNodes });
    try {
      store.environment.value = { available: false, can_build: false };
      store.providers.value = [];
      store.selected.value = 'atlas';
      expect(await store.connectExistingAssistant(existingAssistant)).toBe(true);
      expect(add).toHaveBeenCalledExactlyOnceWith(existingAssistant, expect.any(AbortSignal));
      expect(store.nodes.value).toEqual([nativeNode]);
      expect(store.nodesVerified.value).toBe(true);
      expect(store.selected.value).toBe('');
      expect(client.assistantEnvironment).not.toHaveBeenCalled();
      expect(client.assistantProviders).not.toHaveBeenCalled();
      expect(localWrites).toHaveBeenCalledExactlyOnceWith(
        personalBotAgentThemeKey('/node/native'),
        'system',
      );
      expect(sessionWrites).not.toHaveBeenCalled();
    } finally {
      localWrites.mockRestore();
      sessionWrites.mockRestore();
      store.dispose();
    }
  });

  it('captures the Hub theme when connecting and saves it before the node refresh', async () => {
    let finish!: (value: { id: string }) => void;
    const add = vi.fn(() => new Promise<{ id: string }>((resolve) => (finish = resolve)));
    const { store } = fixture({
      config: { basePath: '/team/hub' },
      addNode: add,
      listNodes: vi.fn().mockRejectedValue(new Error('List unavailable.')),
    });
    try {
      setPersonalBotTheme('tokyo-night');
      const pending = store.connectExistingAssistant(existingAssistant);
      setPersonalBotTheme('sage-light');
      finish({ id: nativeNode.id });
      expect(await pending).toBe(true);
      expect(localStorage.getItem(personalBotAgentThemeKey('/team/hub/node/native'))).toBe(
        'tokyo-night',
      );
      expect(localStorage.getItem(PERSONAL_BOT_THEME_KEY)).toBe('sage-light');
      expect(personalBotTheme.value).toBe('sage-light');
      expect(store.existingConnectionWarning.value).toContain('List unavailable.');
    } finally {
      store.dispose();
    }
  });

  it('keeps saved-node and discovery warnings after successful connection', async () => {
    const { store } = fixture({
      addNode: vi.fn(async () => ({ id: 'native', warning: 'Assistant is currently offline.' })),
      listNodes: vi.fn(async () => ({
        nodes: [nativeNode],
        resolver_error: 'Another assistant could not be discovered.',
      })),
    });
    try {
      expect(await store.connectExistingAssistant(existingAssistant)).toBe(true);
      expect(store.existingConnectionWarning.value).toContain('Assistant is currently offline.');
      expect(store.existingConnectionWarning.value).toContain('Another assistant');
      expect(store.existingConnectionError.value).toBe('');
      store.clearExistingConnectionFeedback();
      expect(store.existingConnectionWarning.value).toContain('Assistant is currently offline.');
    } finally {
      store.dispose();
    }
  });

  it('reports a saved connection when refreshing nodes fails without repeating the save', async () => {
    const add = vi.fn(async () => ({ id: 'native' }));
    const { store } = fixture({
      addNode: add,
      listNodes: vi.fn().mockRejectedValue(new Error('List unavailable.')),
    });
    try {
      expect(await store.connectExistingAssistant(existingAssistant)).toBe(true);
      expect(store.existingConnectionWarning.value).toContain('Assistant connected');
      expect(store.existingConnectionWarning.value).toContain('List unavailable.');
      expect(store.nodesVerified.value).toBe(false);
      expect(add).toHaveBeenCalledOnce();
      expect(store.busy.value).toBe('');
    } finally {
      store.dispose();
    }
  });

  it.each([
    [new HubAPIError(409, 'This URL is already connected.'), 'This URL is already connected.'],
    [new Error('Network interrupted.'), 'Refresh to check the server before trying again.'],
  ])('shows connection errors without replaying a failed request', async (error, expected) => {
    const add = vi.fn().mockRejectedValue(error);
    const { store } = fixture({ addNode: add });
    try {
      expect(await store.connectExistingAssistant(existingAssistant)).toBe(false);
      expect(store.existingConnectionError.value).toContain(expected);
      expect(add).toHaveBeenCalledOnce();
      expect(store.busy.value).toBe('');
      expect(localStorage.getItem(personalBotAgentThemeKey('/node/native'))).toBeNull();
    } finally {
      store.dispose();
    }
  });

  it('ignores delayed test results after fields change and prevents overlapping operations', async () => {
    let finish!: (value: TestNodeResponse) => void;
    const test = vi.fn(() => new Promise<TestNodeResponse>((resolve) => (finish = resolve)));
    const add = vi.fn();
    const { store } = fixture({ testNode: test, addNode: add });
    try {
      const pending = store.testExistingAssistant(existingAssistant);
      await store.testExistingAssistant(existingAssistant);
      expect(await store.connectExistingAssistant(existingAssistant)).toBe(false);
      expect(test).toHaveBeenCalledOnce();
      expect(add).not.toHaveBeenCalled();
      store.clearExistingConnectionFeedback();
      finish({ status: nativeNode.status });
      await pending;
      expect(store.existingConnectionStatus.value).toBe('');
      expect(store.existingConnectionError.value).toBe('');
      expect(store.busy.value).toBe('');
    } finally {
      store.dispose();
    }
  });

  it('distinguishes a reachable assistant from a failed bearer or network check', async () => {
    const test = vi
      .fn()
      .mockResolvedValueOnce({ status: { ...nativeNode.status, agent: 'local-agent' } })
      .mockResolvedValueOnce({
        status: { reachable: false, state: 'unreachable', latency_ms: 1, error: 'Unauthorized' },
      })
      .mockRejectedValueOnce(new HubAPIError(502, 'Could not contact the assistant.'));
    const { store } = fixture({ testNode: test });
    try {
      await store.testExistingAssistant(existingAssistant);
      expect(test).toHaveBeenCalledWith(existingAssistant, expect.any(AbortSignal));
      expect(store.existingConnectionStatus.value).toContain('Reachable in 3 ms · local-agent');
      await store.testExistingAssistant(existingAssistant);
      expect(store.existingConnectionStatus.value).toBe('');
      expect(store.existingConnectionError.value).toBe('Not reachable: Unauthorized');
      await store.testExistingAssistant(existingAssistant);
      expect(store.existingConnectionError.value).toBe('Could not contact the assistant.');
    } finally {
      store.dispose();
    }
  });

  it('bounds a stalled connection request and never retries an uncertain save', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const add = vi.fn(
      (_value: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason));
        }),
    );
    const { store } = fixture({ addNode: add });
    try {
      const pending = store.connectExistingAssistant(existingAssistant);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toBe(false);
      expect(store.busy.value).toBe('');
      expect(store.existingConnectionError.value).toContain('Refresh to check the server');
      expect(add).toHaveBeenCalledOnce();
    } finally {
      store.dispose();
      vi.useRealTimers();
    }
  });

  it('aborts testing and clears private feedback when Hub authorization is lost', async () => {
    let finish!: (value: TestNodeResponse) => void;
    let requestSignal: AbortSignal | undefined;
    const test = vi.fn((_value: unknown, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<TestNodeResponse>((resolve) => (finish = resolve));
    });
    const { store, unauthorized } = fixture({ testNode: test });
    try {
      store.start();
      await waitFor(() => expect(store.loading.value).toBe(false));
      const pending = store.testExistingAssistant(existingAssistant);
      store.existingConnectionWarning.value = 'Private node warning';
      await unauthorized();
      expect(requestSignal?.aborted).toBe(true);
      finish({ status: nativeNode.status });
      await pending;
      expect(store.existingConnectionStatus.value).toBe('');
      expect(store.existingConnectionWarning.value).toBe('');
      expect(store.existingConnectionError.value).toBe('');
      expect(await store.connectExistingAssistant(existingAssistant)).toBe(false);
    } finally {
      store.dispose();
    }
  });

  it('aborts and ignores an add response after the manager is disposed', async () => {
    let finish!: (value: { id: string }) => void;
    let requestSignal: AbortSignal | undefined;
    const add = vi.fn((_value: unknown, signal: AbortSignal) => {
      requestSignal = signal;
      return new Promise<{ id: string }>((resolve) => (finish = resolve));
    });
    const { store, client } = fixture({ addNode: add });
    const pending = store.connectExistingAssistant(existingAssistant);
    store.dispose();
    expect(requestSignal?.aborted).toBe(true);
    finish({ id: 'native' });
    expect(await pending).toBe(false);
    expect(client.listNodes).not.toHaveBeenCalled();
    expect(store.nodes.value).toEqual([]);
    expect(localStorage.getItem(personalBotAgentThemeKey('/node/native'))).toBeNull();
  });
});
