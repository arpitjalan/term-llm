import { signal } from '@preact/signals';
import { HubAPIError, type PersonalBotClient } from '../../api/hub-client';
import { personalBotTheme, seedPersonalBotAgentTheme } from '../../theme/personal-bot-theme';
import type {
  AssistantConnection,
  AssistantEnvironment,
  AssistantOperation,
  AssistantProvider,
  ManagedAssistant,
  SharedConnection,
  ConnectionSource,
} from '../domain/assistants';
import type { HubNode, NodeFormData } from '../domain/types';

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'The server could not complete the request.';

/** Browser state only. Credentials and device flows are never written to storage. */
export class PersonalBotManagerStore {
  readonly assistants = signal<ManagedAssistant[]>([]);
  readonly nodes = signal<HubNode[]>([]);
  readonly environment = signal<AssistantEnvironment | null>(null);
  readonly providers = signal<AssistantProvider[]>([]);
  readonly selected = signal('');
  readonly connection = signal<AssistantConnection | null>(null);
  readonly sharedConnections = signal<SharedConnection[]>([]);
  readonly connectionSources = signal<ConnectionSource[]>([]);
  readonly connectionsLoading = signal(false);
  readonly connectionsLoaded = signal(false);
  readonly connectionsError = signal('');
  readonly operation = signal<AssistantOperation | null>(null);
  readonly loading = signal(true);
  readonly refreshing = signal(false);
  readonly connectionLoading = signal(false);
  readonly busy = signal('');
  readonly error = signal('');
  readonly connectionError = signal('');
  readonly actionError = signal('');
  readonly authLost = signal(false);
  readonly assistantsVerified = signal(false);
  readonly nodesVerified = signal(false);
  readonly existingConnectionStatus = signal('');
  readonly existingConnectionError = signal('');
  readonly existingConnectionWarning = signal('');
  private live = true;
  private controllers = new Set<AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private deviceTimer?: ReturnType<typeof setInterval>;
  private removeAuthListener?: () => void;
  private revision = 0;
  private providersLoaded = false;
  private existingConnectionRevision = 0;

  constructor(readonly client: PersonalBotClient) {}

  start(): void {
    this.live = true;
    this.removeAuthListener = this.client.onUnauthorized(async () => {
      this.authLost.value = true;
      this.assistants.value = [];
      this.nodes.value = [];
      this.connection.value = null;
      this.sharedConnections.value = [];
      this.connectionSources.value = [];
      this.connectionsLoaded.value = false;
      this.connectionsError.value = '';
      this.operation.value = null;
      this.clearExistingConnectionFeedback();
      this.existingConnectionWarning.value = '';
      this.stopRequests();
    });
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 15_000);
    this.deviceTimer = setInterval(() => {
      if (this.connection.peek()?.flow?.state === 'pending') void this.loadConnection();
    }, 2000);
  }

  private stopRequests(): void {
    clearInterval(this.timer);
    clearInterval(this.deviceTimer);
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }

  dispose(): void {
    this.live = false;
    this.stopRequests();
    this.removeAuthListener?.();
  }

  private async request<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs = 20_000,
  ): Promise<T> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } catch (error) {
      if (controller.signal.aborted && this.live && !this.authLost.peek())
        throw new Error('The server took too long to respond. Refresh to check its latest state.', {
          cause: error,
        });
      throw error;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  private available(): boolean {
    return this.live && !this.authLost.peek();
  }

  async refresh(): Promise<void> {
    if (!this.available() || this.refreshing.peek()) return;
    this.refreshing.value = true;
    const revision = this.revision;
    try {
      const results = await Promise.allSettled([
        this.request((signal) => this.client.listAssistants(signal)),
        this.request((signal) => this.client.listNodes(signal)),
        this.request((signal) => this.client.assistantEnvironment(signal)),
        this.providersLoaded
          ? Promise.resolve({ providers: this.providers.peek() })
          : this.request((signal) => this.client.assistantProviders(signal)),
      ]);
      if (!this.available() || revision !== this.revision) return;
      const [assistants, nodes, environment, providers] = results;
      this.assistantsVerified.value = assistants.status === 'fulfilled';
      this.nodesVerified.value = nodes.status === 'fulfilled';
      if (assistants.status === 'fulfilled')
        this.assistants.value = assistants.value.assistants || [];
      if (nodes.status === 'fulfilled') this.nodes.value = nodes.value.nodes || [];
      this.environment.value = environment.status === 'fulfilled' ? environment.value : null;
      if (providers.status === 'fulfilled') {
        this.providers.value = providers.value.providers || [];
        this.providersLoaded = true;
      }
      this.error.value = [
        ...results
          .filter((result) => result.status === 'rejected')
          .map((result) => message(result.reason)),
        assistants.status === 'fulfilled' && assistants.value.warning,
        nodes.status === 'fulfilled' && nodes.value.resolver_error,
      ]
        .filter(Boolean)
        .join(' ');
      const selected = this.selected.peek();
      const assistant = this.assistants.peek().find((item) => item.name === selected);
      const operationID =
        assistant?.operation_id ||
        (this.operation.peek()?.name === selected ? this.operation.peek()?.id : '');
      if (
        operationID &&
        (this.operation.peek()?.id !== operationID || this.operation.peek()?.state === 'running')
      ) {
        const operation = await this.request((signal) =>
          this.client.assistantOperation(operationID, signal),
        );
        if (this.available() && revision === this.revision) this.operation.value = operation;
      }
      if (assistant && !this.busy.peek()) {
        await Promise.all([this.loadConnection(), this.loadSharedConnections()]);
      }
    } catch (error) {
      if (this.available()) this.error.value = message(error);
    } finally {
      if (this.live) {
        this.loading.value = false;
        this.refreshing.value = false;
      }
    }
  }

  select(name: string): void {
    if (this.busy.peek() || !this.available()) return;
    this.revision++;
    this.selected.value = name;
    this.connection.value = null;
    this.operation.value = null;
    this.connectionError.value = '';
    this.actionError.value = '';
    if (name) {
      void this.loadConnection();
      void this.loadSharedConnections();
      void this.refresh();
    }
  }

  async loadConnection(): Promise<void> {
    const selected = this.selected.peek();
    if (!selected || !this.available() || this.connectionLoading.peek() || this.busy.peek()) return;
    this.connectionLoading.value = true;
    const revision = this.revision;
    try {
      const connection = await this.request((signal) =>
        this.client.assistantConnection(selected, signal),
      );
      if (this.available() && revision === this.revision) {
        const newConnection = connection.connection_id !== this.connection.peek()?.connection_id;
        this.connection.value = connection;
        this.connectionError.value = '';
        if (newConnection) void this.loadSharedConnections();
      }
    } catch (error) {
      if (this.available() && revision === this.revision)
        this.connectionError.value = message(error);
    } finally {
      if (this.live) {
        this.connectionLoading.value = false;
        // A changed selection may have waited behind the invalidated request.
        if (this.available() && revision !== this.revision && this.selected.peek())
          void this.loadConnection();
      }
    }
  }

  async loadSharedConnections(): Promise<void> {
    if (!this.available() || this.connectionsLoading.peek()) return;
    this.connectionsLoading.value = true;
    const revision = this.revision;
    try {
      const [connections, sources] = await Promise.all([
        this.request((signal) => this.client.sharedConnections(signal)),
        this.request((signal) => this.client.connectionSources(signal)),
      ]);
      if (this.available() && revision === this.revision) {
        this.sharedConnections.value = connections.connections || [];
        this.connectionSources.value = sources.sources || [];
        this.connectionsLoaded.value = true;
        this.connectionsError.value = '';
      }
    } catch (error) {
      if (this.available() && revision === this.revision) {
        this.connectionsError.value = message(error);
      }
    } finally {
      if (this.live) {
        this.connectionsLoading.value = false;
        // A selection or save can invalidate an in-flight catalog read.
        // Follow it with a current read so a newly attached account appears.
        if (this.available() && revision !== this.revision && this.selected.peek())
          void this.loadSharedConnections();
      }
    }
  }

  private async mutate<T>(
    label: string,
    run: (signal: AbortSignal) => Promise<T>,
    apply: (value: T) => void,
    timeoutMs?: number,
  ): Promise<boolean> {
    if (!this.available() || this.busy.peek()) return false;
    this.revision++;
    this.busy.value = label;
    this.actionError.value = '';
    try {
      const result = await this.request(run, timeoutMs);
      if (!this.available()) return false;
      apply(result);
      return true;
    } catch (error) {
      if (this.available()) {
        this.actionError.value =
          error instanceof HubAPIError
            ? error.message
            : 'Could not confirm the change. Refresh to check the server before trying again.';
      }
      return false;
    } finally {
      if (this.live) {
        // Polls started during a mutation can contain its previous server state.
        this.revision++;
        this.busy.value = '';
      }
      if (this.available()) void this.refresh();
      if (this.available() && (label === 'reuse' || label === 'import'))
        void this.loadSharedConnections();
    }
  }

  create(name: string, purpose: string): Promise<boolean> {
    const theme = personalBotTheme.peek();
    return this.mutate(
      'create',
      (signal) => this.client.createAssistant({ name, purpose }, signal),
      (operation) => {
        if (operation.state !== 'failed')
          seedPersonalBotAgentTheme(
            `${this.client.config.basePath}/node/${encodeURIComponent(operation.name)}`,
            theme,
          );
        this.selected.value = operation.name;
        this.connection.value = null;
        this.operation.value = operation;
      },
    );
  }

  clearExistingConnectionFeedback(): void {
    this.existingConnectionRevision++;
    this.existingConnectionStatus.value = '';
    this.existingConnectionError.value = '';
  }

  async testExistingAssistant(value: NodeFormData): Promise<void> {
    if (!this.available() || this.busy.peek()) return;
    this.clearExistingConnectionFeedback();
    const revision = this.existingConnectionRevision;
    this.busy.value = 'test-existing';
    try {
      const { status } = await this.request((signal) => this.client.testNode(value, signal));
      if (!this.available() || revision !== this.existingConnectionRevision) return;
      if (status.reachable) {
        this.existingConnectionStatus.value = `Reachable in ${status.latency_ms} ms${status.agent ? ` · ${status.agent}` : ''}${status.version ? ` · ${status.version}` : ''}`;
      } else {
        this.existingConnectionError.value = `Not reachable: ${status.error || status.state}`;
      }
    } catch (error) {
      if (this.available() && revision === this.existingConnectionRevision)
        this.existingConnectionError.value = message(error);
    } finally {
      if (this.live) this.busy.value = '';
    }
  }

  async connectExistingAssistant(value: NodeFormData): Promise<boolean> {
    if (!this.available() || this.busy.peek()) return false;
    const theme = personalBotTheme.peek();
    this.clearExistingConnectionFeedback();
    this.existingConnectionWarning.value = '';
    this.busy.value = 'connect-existing';
    this.revision++;
    try {
      const response = await this.request((signal) => this.client.addNode(value, signal));
      if (!this.available()) return false;
      seedPersonalBotAgentTheme(
        `${this.client.config.basePath}/node/${encodeURIComponent(response.id)}`,
        theme,
      );
      // Invalidate polling reads taken before the node was saved.
      this.revision++;
      this.existingConnectionWarning.value = response.warning || '';
      this.selected.value = '';
      this.connection.value = null;
      this.operation.value = null;
      try {
        const nodes = await this.request((signal) => this.client.listNodes(signal));
        if (!this.available()) return false;
        this.nodes.value = nodes.nodes || [];
        this.nodesVerified.value = true;
        this.existingConnectionWarning.value = [response.warning, nodes.resolver_error]
          .filter(Boolean)
          .join(' ');
      } catch (error) {
        if (!this.available()) return false;
        this.nodesVerified.value = false;
        this.existingConnectionWarning.value = [
          response.warning,
          `Assistant connected, but Your agents could not refresh: ${message(error)}`,
        ]
          .filter(Boolean)
          .join(' ');
      }
      return true;
    } catch (error) {
      if (this.available())
        this.existingConnectionError.value =
          error instanceof HubAPIError
            ? error.message
            : 'Could not confirm the connection. Refresh to check the server before trying again.';
      return false;
    } finally {
      if (this.live) this.busy.value = '';
    }
  }

  lifecycle(name: string, action: 'start' | 'stop' | 'restart'): Promise<boolean> {
    return this.mutate(
      action,
      (signal) => this.client.assistantLifecycle(name, action, signal),
      (operation) => {
        this.operation.value = operation;
      },
    );
  }

  saveConnection(provider: string, apiKey: string, model: string): Promise<boolean> {
    const name = this.selected.peek();
    return this.mutate(
      'connection',
      (signal) =>
        this.client.saveAssistantConnection(name, { provider, api_key: apiKey, model }, signal),
      (connection) => {
        this.connection.value = connection;
      },
    );
  }

  useConnection(connectionID: string, model: string): Promise<boolean> {
    return this.mutate(
      'reuse',
      (signal) =>
        this.client.useSharedConnection(
          this.selected.peek(),
          { connection_id: connectionID, model },
          signal,
        ),
      (connection) => {
        this.connection.value = connection;
      },
    );
  }

  importConnection(sourceID: string, model: string): Promise<boolean> {
    const name = this.selected.peek();
    return this.mutate(
      'import',
      async (signal) => {
        const saved = await this.client.importSharedConnection({ source_id: sourceID }, signal);
        return this.client.useSharedConnection(name, { connection_id: saved.id, model }, signal);
      },
      (connection) => {
        this.connection.value = connection;
      },
      // Import can prepare a helper image within the server's two-minute limit;
      // allow the normal request budget afterward to assign the connection.
      140_000,
    );
  }

  startDeviceLogin(model: string): Promise<boolean> {
    return this.mutate(
      'device',
      (signal) => this.client.startAssistantDeviceLogin(this.selected.peek(), model, signal),
      (connection) => {
        this.connection.value = connection;
      },
    );
  }

  cancelDeviceLogin(): Promise<boolean> {
    const flowID = this.connection.peek()?.flow?.id;
    if (!flowID) return Promise.resolve(false);
    return this.mutate(
      'cancel',
      (signal) => this.client.cancelAssistantDeviceLogin(this.selected.peek(), flowID, signal),
      (connection) => {
        this.connection.value = connection;
      },
    );
  }
}
