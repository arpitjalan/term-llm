import { describe, expect, it, vi } from 'vitest';
import { readInjectedConfig } from '../app/config';
import { APIClient } from './client';
import { personalBotJobs, routinePayload, type RoutineInput } from './personal-bot-jobs';

const input: RoutineInput = {
  name: ' Morning briefing ',
  instructions: ' Summarize the workspace changes. ',
  cwd: '/company/workspace',
  agent: 'jarvis',
  schedule: 'manual',
  timezone: 'Asia/Kolkata',
};

describe('personal assistant job requests', () => {
  it('creates a persistent manual routine without expanding tools or permissions', () => {
    expect(routinePayload(input)).toEqual({
      name: 'Morning briefing',
      enabled: true,
      runner_type: 'llm',
      runner_config: {
        agent_name: 'jarvis',
        instructions: 'Summarize the workspace changes.',
        cwd: '/company/workspace',
        persist_session: true,
        session_name: 'Morning briefing',
      },
      trigger_type: 'manual',
      trigger_config: {},
      concurrency_policy: 'forbid',
      max_concurrent_runs: 1,
      retry_policy: { max_attempts: 1 },
      timeout_seconds: 600,
      labels: { source: 'personal-bot' },
    });
  });

  it('preserves daily local wall time and timezone, including midnight', () => {
    for (const [time, expression] of [
      ['09:30', '30 9 * * *'],
      ['00:00', '0 0 * * *'],
    ]) {
      expect(routinePayload({ ...input, schedule: 'daily', time })).toMatchObject({
        trigger_type: 'cron',
        trigger_config: { expression, timezone: 'Asia/Kolkata' },
        schedule_timezone: 'Asia/Kolkata',
      });
    }
  });

  it('converts one-time timestamps to UTC and refuses past or invalid schedules', () => {
    const now = Date.parse('2026-10-16T00:00:00Z');
    expect(
      routinePayload({ ...input, schedule: 'once', runAt: '2026-10-17T09:00:00+05:30' }, now),
    ).toMatchObject({
      trigger_type: 'once',
      trigger_config: { run_at: '2026-10-17T03:30:00.000Z' },
    });
    for (const runAt of ['2026-10-15T00:00:00Z', 'invalid', '']) {
      expect(() => routinePayload({ ...input, schedule: 'once', runAt }, now)).toThrow(
        'future date',
      );
    }
    expect(() => routinePayload({ ...input, schedule: 'daily', time: '24:30' })).toThrow(
      'valid daily time',
    );
    expect(() =>
      routinePayload({ ...input, schedule: 'daily', time: '09:00', timezone: 'bad/zone' }),
    ).toThrow('valid timezone');
    expect(() => routinePayload({ ...input, cwd: '' })).toThrow('workspace');
    expect(() => routinePayload({ ...input, agent: '' })).toThrow('assistant');
  });

  it('uses encoded authenticated routes and forbids mutation retries', async () => {
    const json = vi.fn(async () => ({}));
    const get = vi.fn(async () => ({}));
    const api = personalBotJobs({ json, get } as unknown as APIClient);
    const controller = new AbortController();
    await api.jobs(controller.signal);
    await api.runs(controller.signal);
    await api.run('run/one', controller.signal);
    expect(get.mock.calls).toEqual([
      ['/v2/jobs?limit=100&offset=0', controller.signal, { retries: 0 }],
      ['/v2/runs?limit=20&offset=0&summary=1', controller.signal, { retries: 0 }],
      ['/v2/runs/run%2Fone', controller.signal, { retries: 0 }],
    ]);
    await api.create(input);
    expect(json).toHaveBeenLastCalledWith(
      '/v2/jobs',
      { method: 'POST', body: JSON.stringify(routinePayload(input)) },
      { policy: 'mutation', retries: 0 },
    );
    for (const [action, path] of [
      [() => api.pause('job/one'), '/v2/jobs/job%2Fone/pause'],
      [() => api.resume('job/one'), '/v2/jobs/job%2Fone/resume'],
      [() => api.trigger('job/one'), '/v2/jobs/job%2Fone/trigger'],
      [() => api.cancel('run/one'), '/v2/runs/run%2Fone/cancel'],
    ] as const) {
      await action();
      expect(json).toHaveBeenLastCalledWith(
        path,
        { method: 'POST', body: '{}' },
        { policy: 'mutation', retries: 0 },
      );
    }
  });

  it('preserves deployment prefix and bearer credentials without replaying a failed trigger', async () => {
    const transport = vi.fn(
      async () => new Response('{"error":{"message":"Busy"}}', { status: 503 }),
    );
    vi.stubGlobal('fetch', transport);
    const client = new APIClient(
      { ...readInjectedConfig(), prefix: '/assistant' },
      { getToken: () => 'demo-token', onAuthRequired: vi.fn() },
    );
    await expect(personalBotJobs(client).trigger('job-one')).rejects.toThrow('Busy');
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, request] = transport.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/assistant/v2/jobs/job-one/trigger');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer demo-token');
  });
});
