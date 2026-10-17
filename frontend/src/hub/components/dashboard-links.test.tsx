import { fireEvent, render, screen } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { HubClient, PersonalBotClient } from '../../api/hub-client';
import { parseHubConfig } from '../config';
import { HubStore } from '../stores/hub-store';
import { PersonalBotManagerStore } from '../stores/personal-bot-manager';
import { HubNavigation } from './HubNavigation';
import { PersonalBotManager } from './PersonalBotManager';

describe.each(['', '/team/nested'])('dashboard links mounted at %j', (basePath) => {
  const config = parseHubConfig({
    page: 'dashboard',
    authMode: 'none',
    basePath,
    personalBot: true,
  });

  it('opens the Hub dashboard from agent management and closes mobile navigation', () => {
    const store = new PersonalBotManagerStore(new PersonalBotClient(config));
    vi.spyOn(store, 'start').mockImplementation(() => undefined);
    render(<PersonalBotManager config={config} store={store} />);

    const trigger = screen.getByRole('button', { name: 'Open navigation', exact: true });
    fireEvent.click(trigger);
    const link = screen.getByRole('link', { name: 'Hub dashboard', exact: true });
    expect(link).toBeVisible();
    expect(link).toHaveAttribute('href', `${basePath}/dashboard/`);
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByRole('dialog', { name: 'Your agents navigation' }),
    ).not.toBeInTheDocument();
  });

  it('returns from the Hub dashboard to agent management at the same mount', () => {
    const close = vi.fn();
    render(
      <HubNavigation config={config} store={new HubStore(new HubClient(config))} close={close} />,
    );

    const link = screen.getByRole('link', { name: 'Your agents', exact: true });
    expect(link).toBeVisible();
    expect(link).toHaveAttribute('href', `${basePath}/`);
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not offer agent management on an ordinary Hub', () => {
    const ordinary = { ...config, personalBot: false };
    render(
      <HubNavigation
        config={ordinary}
        store={new HubStore(new HubClient(ordinary))}
        close={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole('link', { name: 'Your agents', exact: true }),
    ).not.toBeInTheDocument();
  });
});
