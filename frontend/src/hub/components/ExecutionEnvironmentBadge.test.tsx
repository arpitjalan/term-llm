import { render, screen } from '@testing-library/preact';
import { expect, it } from 'vitest';
import type { HubClient } from '../../api/hub-client';
import type { HubNode } from '../domain/types';
import { HubStore } from '../stores/hub-store';
import { NodeCard } from './NodeCard';

it.each([
  { source: 'contain', environment: undefined, label: 'Container' },
  { source: 'contain', environment: 'host', label: 'Container' },
  { source: 'local', environment: 'host', label: 'Host' },
  { source: 'config', environment: 'host', label: 'Host' },
  { source: 'local', environment: 'container', connection: 'reverse', label: 'Container' },
  { source: 'local', environment: undefined, label: 'Environment unknown' },
  { source: 'config', environment: undefined, label: 'Environment unknown' },
  { source: 'local', environment: undefined, connection: 'reverse', label: 'Environment unknown' },
  { source: 'local', environment: 'future-runtime', label: 'Environment unknown' },
])(
  'labels a $source agent reporting $environment as $label',
  ({ source, environment, connection, label }) => {
    const node: HubNode = {
      id: 'agent',
      name: 'My agent',
      source,
      connection: connection || 'direct',
      url: '',
      base_path: '/chat',
      proxy_path: '/hub/node/agent/',
      new_session_path: '/hub/node/agent/?new=1',
      has_token: true,
      status: { reachable: true, state: 'ok', latency_ms: 1, execution_environment: environment },
    };
    const store = new HubStore({} as HubClient);
    store.nodesVerified.value = true;
    render(<NodeCard node={node} store={store} />);
    expect(screen.getByText(label, { exact: true })).toBeVisible();
    expect(screen.getByRole('link', { name: 'New', exact: true })).toHaveAttribute(
      'href',
      '/hub/node/agent/?new=1',
    );
  },
);
