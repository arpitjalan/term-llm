export interface ManagedAssistant {
  name: string;
  purpose: string;
  state: 'needs_connection' | 'stopped' | 'running' | 'unavailable';
  needs_connection: boolean;
  node_id: string;
  created_at: string;
  operation_id?: string;
  error?: string;
  ready: boolean;
  ui_url: string;
}

export interface AssistantOperation {
  id: string;
  name: string;
  action: 'create' | 'start' | 'stop' | 'restart';
  stage?: 'preparing_image' | 'starting_container';
  state: 'running' | 'succeeded' | 'failed';
  error?: string;
  started_at: string;
  finished_at?: string;
}

export interface AssistantEnvironment {
  available: boolean;
  error?: string;
  can_build: boolean;
  build_hint?: string;
}

export interface AssistantProvider {
  id: string;
  name: string;
  auth: 'api_key' | 'device_code';
  default_model: string;
  models: string[];
}

export interface AssistantConnection {
  state: 'needs_connection' | 'saved_unverified' | 'authorized';
  provider?: string;
  model?: string;
  connection_id?: string;
  connection_name?: string;
  message: string;
  flow?: {
    id: string;
    state: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'expired';
    verification_url?: string;
    user_code?: string;
    expires_at?: string;
    message?: string;
  };
}

export interface SharedConnection {
  id: string;
  name: string;
  provider: 'chatgpt';
  source: string;
  available?: boolean;
}

export interface ConnectionSource {
  id: string;
  name: string;
  kind: 'server' | 'assistant';
  available: boolean;
  message?: string;
}

/** Keep assistant navigation on the authenticated Hub proxy, including subpath mounts. */
export function assistantProxyURL(raw: string, basePath: string, nodeID: string): string {
  const prefix = `${basePath}/node/${encodeURIComponent(nodeID)}/`;
  if (!nodeID || !raw.startsWith(prefix) || raw.includes('\\')) return '';
  const parsed = new URL(raw, 'https://hub.invalid');
  return parsed.origin === 'https://hub.invalid' && parsed.pathname.startsWith(prefix)
    ? `${parsed.pathname}${parsed.search}${parsed.hash}`
    : '';
}

export function deviceVerificationURL(raw?: string): string {
  try {
    const url = new URL(raw || '');
    return url.protocol === 'https:' && url.hostname === 'auth.openai.com' ? url.href : '';
  } catch {
    return '';
  }
}
