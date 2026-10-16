import type { APIClient } from './client';

export type AttentionKind = 'input_required' | 'running' | 'unseen';
export interface BotActivity {
  session_id: string;
  response_id: string;
  short_title?: string;
  long_title?: string;
  outcome?: string;
  terminal_at?: string;
  started_at?: string;
  pending_interaction_count?: number;
}
export interface ActivityPage {
  items: BotActivity[];
  has_more: boolean;
  next_cursor?: string;
  snapshot_version: number;
}
export type BotActivityFeed = Record<AttentionKind, ActivityPage>;
export const activityKinds: AttentionKind[] = ['input_required', 'running', 'unseen'];

/** Attention is global, including work outside the currently loaded conversation list. */
export async function loadActivityPage(
  api: APIClient,
  kind: AttentionKind,
  signal?: AbortSignal,
  previous?: ActivityPage,
): Promise<ActivityPage> {
  const params = new URLSearchParams({ kind, limit: '100' });
  if (previous?.next_cursor) {
    params.set('cursor', previous.next_cursor);
    params.set('snapshot_version', String(previous.snapshot_version));
  }
  const page = await api.get<ActivityPage>(`/v1/attention?${params}`, signal, { retries: 0 });
  if (!page || !Array.isArray(page.items) || typeof page.has_more !== 'boolean')
    throw new Error('Activity is not available from this server.');
  return { ...page, items: [...(previous?.items || []), ...page.items] };
}

export async function loadActivity(api: APIClient, signal?: AbortSignal): Promise<BotActivityFeed> {
  const [input_required, running, unseen] = await Promise.all(
    activityKinds.map((kind) => loadActivityPage(api, kind, signal)),
  );
  return { input_required, running, unseen };
}
