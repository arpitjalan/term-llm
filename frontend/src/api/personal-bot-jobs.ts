import type { APIClient } from './client';

export interface BotRun {
  id: string;
  job_id: string;
  status: string;
  session_id?: string;
  response?: string;
  error?: string;
  stdout?: string;
  created_at: string;
  finished_at?: string;
  truncated?: boolean;
}

export interface BotJob {
  id: string;
  name: string;
  enabled: boolean;
  runner_type: string;
  runner_config: { instructions?: string };
  trigger_type: string;
  trigger_config: { run_at?: string; expression?: string; timezone?: string };
  schedule_timezone?: string;
  next_run_at?: string;
  last_run?: BotRun;
}

export interface BotList<T> {
  data: T[] | null;
  total: number;
}

export type RoutineSchedule = 'manual' | 'once' | 'daily';

export interface RoutineInput {
  name: string;
  instructions: string;
  agent: string;
  cwd: string;
  schedule: RoutineSchedule;
  timezone: string;
  /** Browser local datetime or ISO timestamp for a once-only run. */
  runAt?: string;
  /** 24-hour local time in timezone for a daily run. */
  time?: string;
}

export function routinePayload(input: RoutineInput, now = Date.now()) {
  const name = input.name.trim();
  const instructions = input.instructions.trim();
  if (!name || !instructions) throw new Error('Give your routine a name and instructions.');
  if (!input.agent.trim()) throw new Error('Choose a configured assistant first.');
  if (!input.cwd.trim()) throw new Error('Choose an available workspace first.');
  let trigger: { run_at?: string; expression?: string; timezone?: string } = {};
  if (input.schedule === 'once') {
    const when = new Date(input.runAt || '');
    if (!Number.isFinite(when.getTime()) || when.getTime() <= now)
      throw new Error('Choose a future date and time.');
    trigger = { run_at: when.toISOString() };
  } else if (input.schedule === 'daily') {
    const match = /^(\d{2}):(\d{2})$/.exec(input.time || '');
    if (!match || Number(match[1]) > 23 || Number(match[2]) > 59)
      throw new Error('Choose a valid daily time.');
    try {
      if (!input.timezone.trim()) throw new Error('empty timezone');
      new Intl.DateTimeFormat('en', { timeZone: input.timezone }).format();
    } catch {
      throw new Error('Enter a valid timezone, such as Asia/Kolkata or UTC.');
    }
    trigger = {
      expression: `${Number(match[2])} ${Number(match[1])} * * *`,
      timezone: input.timezone,
    };
  }
  return {
    name,
    enabled: true,
    runner_type: 'llm',
    runner_config: {
      agent_name: input.agent,
      instructions,
      cwd: input.cwd,
      persist_session: true,
      session_name: name,
    },
    trigger_type: input.schedule === 'daily' ? 'cron' : input.schedule,
    trigger_config: trigger,
    ...(input.schedule === 'daily' ? { schedule_timezone: input.timezone } : {}),
    concurrency_policy: 'forbid',
    max_concurrent_runs: 1,
    retry_policy: { max_attempts: 1 },
    timeout_seconds: 600,
    labels: { source: 'personal-bot' },
  };
}

/** Uses the existing authenticated, prefix-aware client; mutations are never replayed. */
export const personalBotJobs = (api: APIClient) => {
  const mutate = <T>(path: string, body: unknown = {}) =>
    api.json<T>(
      path,
      { method: 'POST', body: JSON.stringify(body) },
      { policy: 'mutation', retries: 0 },
    );
  return {
    available: async (signal?: AbortSignal) => {
      const capabilities = await api.get<{ jobs?: { enabled?: boolean } }>(
        '/v1/capabilities',
        signal,
        { retries: 0 },
      );
      return capabilities.jobs?.enabled === true;
    },
    jobs: (signal?: AbortSignal) =>
      api.get<BotList<BotJob>>('/v2/jobs?limit=100&offset=0', signal, { retries: 0 }),
    runs: (signal?: AbortSignal) =>
      api.get<BotList<BotRun>>('/v2/runs?limit=20&offset=0&summary=1', signal, { retries: 0 }),
    run: (id: string, signal?: AbortSignal) =>
      api.get<BotRun>(`/v2/runs/${encodeURIComponent(id)}`, signal, { retries: 0 }),
    create: (input: RoutineInput) => mutate<BotJob>('/v2/jobs', routinePayload(input)),
    pause: (id: string) => mutate<BotJob>(`/v2/jobs/${encodeURIComponent(id)}/pause`),
    resume: (id: string) => mutate<BotJob>(`/v2/jobs/${encodeURIComponent(id)}/resume`),
    trigger: (id: string) => mutate<BotRun>(`/v2/jobs/${encodeURIComponent(id)}/trigger`),
    cancel: (id: string) => mutate<BotRun>(`/v2/runs/${encodeURIComponent(id)}/cancel`),
  };
};
