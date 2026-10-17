import { render } from 'preact';
import { PersonalBotClient } from '../api/hub-client';
import { HubErrorBoundary, HubFatal } from './components/HubErrorBoundary';
import { PersonalBotManager } from './components/PersonalBotManager';
import { readHubConfig } from './config';
import { PersonalBotManagerStore } from './stores/personal-bot-manager';
import './styles/hub.css';

// This opt-in entry is selected by the authenticated Hub shell. Login and
// passkey screens continue to use the ordinary Hub entry and its assets.
function bootstrap(): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('Agent manager application mount is missing.');
  const config = readHubConfig(root);
  if (config.page !== 'dashboard' || !config.personalBot) {
    throw new Error('Agent management is not enabled for this page.');
  }
  const client = new PersonalBotClient(config);
  render(
    <HubErrorBoundary>
      <PersonalBotManager config={config} store={new PersonalBotManagerStore(client)} />
    </HubErrorBoundary>,
    root,
  );
}

queueMicrotask(() => {
  try {
    bootstrap();
  } catch (error) {
    const root = document.getElementById('root');
    if (root) {
      const detail = error instanceof Error ? error.message : 'Agent manager could not start.';
      render(<HubFatal title="Agent manager could not start" message={detail} />, root);
    }
    console.error(error);
  }
});
