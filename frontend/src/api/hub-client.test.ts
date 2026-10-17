import { describe, expect, it, vi } from 'vitest';
import type { SerializedPublicKeyCredential } from '../hub/domain/types';
import { HubAPIError, HubClient, PersonalBotClient } from './hub-client';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('HubClient', () => {
  it('routes assistant setup through the mounted operator session without persisting credentials', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({}, 202));
    const client = new PersonalBotClient(
      { basePath: '/team', authMode: 'bearer' },
      { fetch: fetcher },
    );
    const controller = new AbortController();
    const key = 'fixture-key';
    const storage = vi.spyOn(localStorage, 'setItem');
    await client.listAssistants(controller.signal);
    await client.assistantEnvironment(controller.signal);
    await client.assistantProviders(controller.signal);
    await client.createAssistant(
      { name: 'atlas', purpose: 'Keep track of research' },
      controller.signal,
    );
    await client.assistantOperation('operation/id', controller.signal);
    await client.assistantLifecycle('a/b', 'restart', controller.signal);
    await client.assistantConnection('a/b', controller.signal);
    await client.saveAssistantConnection(
      'a/b',
      { provider: 'openai', api_key: key, model: 'fixture' },
      controller.signal,
    );
    await client.startAssistantDeviceLogin('a/b', 'fixture', controller.signal);
    await client.cancelAssistantDeviceLogin('a/b', 'flow-id', controller.signal);
    await client.sharedConnections(controller.signal);
    await client.connectionSources(controller.signal);
    await client.importSharedConnection({ source_id: 'offered-source' }, controller.signal);
    await client.useSharedConnection(
      'a/b',
      { connection_id: 'saved-connection', model: 'fixture' },
      controller.signal,
    );
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/team/api/assistants',
      '/team/api/assistants/environment',
      '/team/api/assistants/providers',
      '/team/api/assistants',
      '/team/api/assistants/operations/operation%2Fid',
      '/team/api/assistants/a%2Fb/restart',
      '/team/api/assistants/a%2Fb/connection',
      '/team/api/assistants/a%2Fb/connection',
      '/team/api/assistants/a%2Fb/connection/chatgpt/start',
      '/team/api/assistants/a%2Fb/connection/cancel',
      '/team/api/assistants/connections',
      '/team/api/assistants/connection-sources',
      '/team/api/assistants/connections/import',
      '/team/api/assistants/a%2Fb/connection/use',
    ]);
    for (const [, request] of fetcher.mock.calls) {
      expect(request).toMatchObject({ credentials: 'same-origin', signal: controller.signal });
      expect((request!.headers as Headers).get('Authorization')).toBeNull();
    }
    expect(fetcher.mock.calls[7][1]?.body).toBe(
      JSON.stringify({ provider: 'openai', api_key: key, model: 'fixture' }),
    );
    expect(fetcher.mock.calls[9][1]?.body).toBe(JSON.stringify({ flow_id: 'flow-id' }));
    expect(fetcher.mock.calls[12][1]?.body).toBe(JSON.stringify({ source_id: 'offered-source' }));
    expect(fetcher.mock.calls[13][1]?.body).toBe(
      JSON.stringify({ connection_id: 'saved-connection', model: 'fixture' }),
    );
    expect(storage).not.toHaveBeenCalled();
    fetcher.mockRejectedValueOnce(new Error('connection lost'));
    await expect(client.assistantLifecycle('atlas', 'start')).rejects.toThrow('connection lost');
    expect(fetcher).toHaveBeenCalledTimes(15);
  });

  it('owns mounted same-origin JSON transport for reads and mutations', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ nodes: [] }));
    const client = new HubClient(
      { basePath: '/hub', authMode: 'bearer' },
      { fetch: fetcher as unknown as typeof fetch },
    );
    await client.listNodes();
    expect(fetcher).toHaveBeenCalledOnce();
    const url = fetcher.mock.calls[0][0];
    const request = fetcher.mock.calls[0][1]!;
    expect(url).toBe('/hub/api/nodes');
    expect(request).toMatchObject({ method: 'GET', credentials: 'same-origin' });
    expect((request.headers as Headers).get('Accept')).toBe('application/json');

    fetcher.mockResolvedValueOnce(jsonResponse({ id: 'alpha' }));
    await client.addNode({ name: 'Alpha', url: 'http://node.test', token: 'secret' });
    const mutationURL = fetcher.mock.calls[1][0];
    const mutation = fetcher.mock.calls[1][1]!;
    expect(mutationURL).toBe('/hub/api/nodes');
    expect(mutation).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ name: 'Alpha', url: 'http://node.test', token: 'secret' }),
    });
    expect((mutation.headers as Headers).get('Content-Type')).toBe('application/json');
  });

  it('clears the full server inbox with an empty operator-authenticated JSON body', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ cleared: 75, failed: 2 }))
      .mockRejectedValueOnce(new Error('network failed'));
    const client = new HubClient({ basePath: '/hub', authMode: 'bearer' }, { fetch: fetcher });
    await expect(client.clearAttention()).resolves.toEqual({ cleared: 75, failed: 2 });
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('/hub/api/attention/clear');
    expect(request).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin' });
    const headers = request!.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('X-Term-LLM-Node-ID')).toBeNull();
    await expect(client.clearAttention()).rejects.toThrow('network failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('saves the node order as the operator, never with node credentials', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ node_ids: ['beta', 'alpha', 'gamma'] }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              message: 'a listed node was not found; refresh and try again',
              type: 'node_not_found',
            },
          },
          404,
        ),
      );
    const client = new HubClient(
      { basePath: '/hub', authMode: 'bearer' },
      { fetch: fetcher as unknown as typeof fetch },
    );
    await expect(client.reorderNodes(['beta', 'alpha', 'gamma'])).resolves.toEqual({
      node_ids: ['beta', 'alpha', 'gamma'],
    });
    const [url, request] = fetcher.mock.calls[0];
    expect(url).toBe('/hub/api/nodes/order');
    expect(request).toMatchObject({
      method: 'PATCH',
      credentials: 'same-origin',
      body: JSON.stringify({ node_ids: ['beta', 'alpha', 'gamma'] }),
    });
    const headers = request!.headers as Headers;
    expect(headers.get('Content-Type')).toBe('application/json');
    // The dashboard is the Hub operator: it never claims a node identity or
    // handles a node token.
    expect(headers.get('X-Term-LLM-Node-ID')).toBeNull();
    expect(headers.get('Authorization')).toBeNull();

    await expect(client.reorderNodes(['ghost'])).rejects.toEqual(
      expect.objectContaining({ name: 'HubAPIError', status: 404, type: 'node_not_found' }),
    );
  });

  it('forwards cancellation to reads and never retries a failed mutation', async () => {
    const controller = new AbortController();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ nodes: [] }))
      .mockRejectedValueOnce(new Error('network failed'));
    const client = new HubClient(
      { basePath: '/hub', authMode: 'none' },
      { fetch: fetcher as unknown as typeof fetch },
    );

    await client.listNodes(controller.signal);
    expect(fetcher.mock.calls[0][1]?.signal).toBe(controller.signal);
    await expect(
      client.addNode({ name: 'Alpha', url: 'http://node.test', token: '' }),
    ).rejects.toThrow('network failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('forwards cancellation to existing assistant tests and saves without persisting bearer tokens', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({ id: 'native' }));
    const client = new PersonalBotClient(
      { basePath: '/personal', authMode: 'bearer' },
      { fetch: fetcher },
    );
    const value = { name: 'My computer', url: 'http://computer.test/chat', token: 'fixture-token' };
    const localWrites = vi.spyOn(localStorage, 'setItem');
    const sessionWrites = vi.spyOn(sessionStorage, 'setItem');
    try {
      await client.testNode(value, controller.signal);
      await client.addNode(value, controller.signal);
      expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
        '/personal/api/nodes/test',
        '/personal/api/nodes',
      ]);
      for (const [, request] of fetcher.mock.calls) {
        expect(request).toMatchObject({
          method: 'POST',
          credentials: 'same-origin',
          signal: controller.signal,
          body: JSON.stringify(value),
        });
        expect((request!.headers as Headers).get('Authorization')).toBeNull();
      }
      expect(localWrites).not.toHaveBeenCalled();
      expect(sessionWrites).not.toHaveBeenCalled();
    } finally {
      localWrites.mockRestore();
      sessionWrites.mockRestore();
    }
  });

  it('keeps every task route under the injected mount', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => jsonResponse({}));
    const client = new HubClient(
      { basePath: '/ops', authMode: 'none' },
      { fetch: fetcher as unknown as typeof fetch },
    );
    const credential = { id: 'credential' } as SerializedPublicKeyCredential;
    const calls: Array<() => Promise<unknown>> = [
      () => client.listAttention(),
      () => client.listDelegations(),
      () => client.testNode({ name: '', url: '', token: '' }),
      () => client.removeNode('a/b'),
      () => client.reorderNodes(['alpha']),
      () => client.registrationInfo(),
      () => client.listCredentials(),
      () => client.session(),
      () => client.renameCredential('record/id', 'New'),
      () => client.removeCredential('record/id'),
      () => client.revokeOtherSessions(),
      () => client.logout(),
      () => client.verifyGrant('/api/auth/recovery', 'code'),
      () => client.beginGrantRegistration('/api/auth/bootstrap', 'Primary'),
      () => client.finishGrantRegistration('/api/auth/recovery', credential),
      () =>
        client.finishGrantRegistration('/api/auth/bootstrap', credential, '/ops/auth/native/a b'),
      () => client.beginLogin('/hub/node/alpha/'),
      () => client.finishLogin(credential),
      () => client.beginReauthentication(),
      () => client.finishReauthentication(credential),
      () => client.authorizeNative('challenge'),
      () => client.beginAdditionalRegistration('Backup'),
      () => client.finishAdditionalRegistration(credential),
    ];
    for (const call of calls) await call();
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      '/ops/api/attention',
      '/ops/api/delegations',
      '/ops/api/nodes/test',
      '/ops/api/nodes/a%2Fb',
      '/ops/api/nodes/order',
      '/ops/api/registration-info',
      '/ops/api/auth/credentials',
      '/ops/api/auth/session',
      '/ops/api/auth/credentials/record%2Fid',
      '/ops/api/auth/credentials/record%2Fid',
      '/ops/api/auth/sessions/revoke-others',
      '/ops/api/auth/logout',
      '/ops/api/auth/recovery/verify',
      '/ops/api/auth/bootstrap/register/begin',
      '/ops/api/auth/recovery/register/finish',
      '/ops/api/auth/bootstrap/register/finish?return=%2Fops%2Fauth%2Fnative%2Fa%20b',
      '/ops/api/auth/login/begin',
      '/ops/api/auth/login/finish',
      '/ops/api/auth/reauth/begin',
      '/ops/api/auth/reauth/finish',
      '/ops/api/auth/native/authorize',
      '/ops/api/auth/credentials/register/begin',
      '/ops/api/auth/credentials/register/finish',
    ]);
  });

  it('decodes structured and plain-text errors and rejects malformed success bodies', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'specific failure' } }, 409))
      .mockResolvedValueOnce(new Response('plain failure', { status: 400 }))
      .mockResolvedValueOnce(
        new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    const client = new HubClient(
      { basePath: '', authMode: 'none' },
      { fetch: fetcher as unknown as typeof fetch },
    );
    await expect(client.listNodes()).rejects.toEqual(
      expect.objectContaining({ name: 'HubAPIError', status: 409, message: 'specific failure' }),
    );
    await expect(client.listNodes()).rejects.toThrow('plain failure');
    await expect(client.listNodes()).rejects.toThrow('empty response');
  });

  it('redirects protected passkey 401s without relying on the login header', async () => {
    const navigate = vi.fn();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'expired' } }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'expired' } }, 401, {
          'X-Term-LLM-Login-URL': '/custom/login',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'expired' } }, 401, {
          'X-Term-LLM-Login-URL': '//evil.example/login',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: { message: 'expired' } }, 401, {
          'X-Term-LLM-Login-URL': '/\\evil.example/login',
        }),
      );
    const client = new HubClient(
      { basePath: '/hub', authMode: 'passkey' },
      { fetch: fetcher as unknown as typeof fetch, navigate },
    );
    await expect(client.listNodes()).rejects.toBeInstanceOf(HubAPIError);
    await expect(client.listCredentials()).rejects.toBeInstanceOf(HubAPIError);
    await expect(client.listNodes()).rejects.toBeInstanceOf(HubAPIError);
    await expect(client.listNodes()).rejects.toBeInstanceOf(HubAPIError);
    expect(navigate.mock.calls).toEqual([
      ['/hub/auth/login'],
      ['/custom/login'],
      ['/hub/auth/login'],
      ['/hub/auth/login'],
    ]);
  });

  it('does not turn an invalid public setup grant into a login redirect', async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn(async () => jsonResponse({ error: { message: 'invalid code' } }, 401));
    const client = new HubClient(
      { basePath: '/hub', authMode: 'passkey' },
      { fetch: fetcher as unknown as typeof fetch, navigate },
    );
    await expect(client.verifyGrant('/api/auth/bootstrap', 'bad')).rejects.toThrow('invalid code');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('leaves native approval 401s to the approval page but keeps the default elsewhere', async () => {
    const navigate = vi.fn();
    const fetcher = vi.fn(async () => jsonResponse({ error: { message: 'expired' } }, 401));
    const client = new HubClient(
      { basePath: '/hub', authMode: 'passkey' },
      { fetch: fetcher as unknown as typeof fetch, navigate },
    );
    const credential = { id: 'credential' } as SerializedPublicKeyCredential;
    await expect(client.authorizeNative('challenge')).rejects.toBeInstanceOf(HubAPIError);
    await expect(client.beginReauthentication(false)).rejects.toBeInstanceOf(HubAPIError);
    await expect(client.finishReauthentication(credential, false)).rejects.toBeInstanceOf(
      HubAPIError,
    );
    expect(navigate).not.toHaveBeenCalled();
    await expect(client.beginReauthentication()).rejects.toBeInstanceOf(HubAPIError);
    expect(navigate).toHaveBeenCalledWith('/hub/auth/login');
  });
});
