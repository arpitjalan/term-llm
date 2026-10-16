import { describe, expect, it, vi } from 'vitest';
import { readInjectedConfig } from '../app/config';
import { APIClient, APIError } from './client';
import { loadActivity, loadActivityPage, type ActivityPage } from './personal-bot-attention';

const firstPage: ActivityPage = {
  items: [{ session_id: 'older-session', response_id: 'response-1', short_title: 'Research' }],
  has_more: true,
  next_cursor: 'cursor/with+symbols=',
  snapshot_version: 12,
};

describe('personal assistant activity requests', () => {
  it('loads global activity through the deployment prefix with bearer authentication', async () => {
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({ items: [], has_more: false, snapshot_version: 12 }),
      );
    const client = new APIClient(
      { ...readInjectedConfig(), prefix: '/assistant' },
      { getToken: () => 'demo-token', onAuthRequired: vi.fn() },
    );
    const result = await loadActivity(client);
    expect(Object.keys(result)).toEqual(['input_required', 'running', 'unseen']);
    expect(transport).toHaveBeenCalledTimes(3);
    for (const [request, init] of transport.mock.calls) {
      const url = new URL(String(request), 'https://example.test');
      expect(url.pathname).toBe('/assistant/v1/attention');
      expect(url.searchParams.get('limit')).toBe('100');
      expect(url.searchParams.has('session_id')).toBe(false);
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer demo-token');
    }
  });

  it('pins pagination to the server snapshot and preserves the already loaded page', async () => {
    const next = { session_id: 'another-session', response_id: 'response-2' };
    const get = vi.fn().mockResolvedValue({
      items: [next],
      has_more: false,
      snapshot_version: 12,
    });
    const client = { get } as unknown as APIClient;
    const controller = new AbortController();
    const result = await loadActivityPage(client, 'unseen', controller.signal, firstPage);
    const [path, signal, controls] = get.mock.calls[0];
    const params = new URL(String(path), 'https://example.test').searchParams;
    expect(params.get('cursor')).toBe(firstPage.next_cursor);
    expect(params.get('snapshot_version')).toBe('12');
    expect(signal).toBe(controller.signal);
    expect(controls).toEqual({ retries: 0 });
    expect(result.items).toEqual([...firstPage.items, next]);
    expect(firstPage.items).toHaveLength(1);
    expect(result.has_more).toBe(false);
  });

  it('surfaces a changed snapshot without retrying the stale cursor', async () => {
    const transport = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json(
          { error: { message: 'Attention snapshot changed; restart pagination' } },
          { status: 409 },
        ),
      );
    const client = new APIClient(readInjectedConfig(), {
      getToken: () => '',
      onAuthRequired: vi.fn(),
    });
    await expect(loadActivityPage(client, 'unseen', undefined, firstPage)).rejects.toEqual(
      expect.objectContaining<Partial<APIError>>({ status: 409 }),
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(firstPage.items).toHaveLength(1);
  });

  it('rejects a missing activity endpoint rather than displaying an empty inbox', async () => {
    const client = {
      get: vi.fn().mockResolvedValue('<html>App shell</html>'),
    } as unknown as APIClient;
    await expect(loadActivityPage(client, 'unseen')).rejects.toThrow('not available');
  });
});
