export function ExecutionEnvironmentBadge({
  environment,
  source,
}: {
  environment?: string;
  source?: string;
}) {
  const container = source === 'contain' || environment === 'container';
  const host = environment === 'host';
  return (
    <span class="cap-chip" title="Where this agent runs">
      {container ? 'Container' : host ? 'Host' : 'Environment unknown'}
    </span>
  );
}
