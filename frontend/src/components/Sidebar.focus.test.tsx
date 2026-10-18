import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreContext } from '../app/context';
import { overlayManager } from '../platform/overlay-manager';
import { AppStore } from '../stores/app-store';
import { testConfig } from '../stores/store-test-fixtures';
import { Sidebar } from './Sidebar';

let store: AppStore;
afterEach(() => {
  store?.dispose();
  overlayManager.reset();
});

function setup({ mobile = false, collapsed = false } = {}) {
  const media = new EventTarget() as MediaQueryList;
  Object.defineProperty(media, 'matches', { value: mobile, configurable: true });
  vi.mocked(window.matchMedia).mockImplementation((query) =>
    query === '(max-width: 767px)'
      ? media
      : ({
          matches: false,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        } as unknown as MediaQueryList),
  );
  store = new AppStore(testConfig);
  store.sidebarCollapsed.value = collapsed;
  store.projectsEnabled.value = false;
  const view = render(
    <StoreContext.Provider value={store}>
      <div id="appShell">
        <Sidebar />
        <main>
          <button onClick={() => (store.sidebarOpen.value = true)}>Open sidebar</button>
          <input aria-label="Composer" />
        </main>
      </div>
    </StoreContext.Provider>,
  );
  return {
    ...view,
    setMobile: (next: boolean) => {
      act(() => {
        Object.defineProperty(media, 'matches', { value: next });
        media.dispatchEvent(new Event('change'));
      });
    },
  };
}

describe('sidebar keyboard focus', () => {
  it('excludes the inactive desktop branch and keeps keyboard focus on the replacement toggle', async () => {
    const { container } = setup();
    const rail = container.querySelector('.sidebar-rail')!;
    const panel = container.querySelector('.sidebar-panel')!;
    expect(rail).toHaveAttribute('inert');
    expect(panel).not.toHaveAttribute('inert');

    screen.getByRole('button', { name: 'Collapse sidebar' }).focus();
    await userEvent.keyboard('{Enter}');

    const expand = screen.getByRole('button', { name: 'Expand sidebar' });
    expect(panel).toHaveAttribute('inert');
    expect(rail).not.toHaveAttribute('inert');
    expect(expand).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    expect(rail).toHaveAttribute('inert');
    expect(panel).not.toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toHaveFocus();
  });

  it('traps mobile focus among visible controls and restores focus when dismissed', async () => {
    const { container } = setup({ mobile: true, collapsed: true });
    const opener = screen.getByRole('button', { name: 'Open sidebar' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Sessions' });
    await waitFor(() => expect(dialog).toHaveFocus());

    expect(container.querySelector('.sidebar-rail')).toHaveAttribute('inert');
    expect(container.querySelector('.sidebar-panel')).not.toHaveAttribute('inert');
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull();

    const first = container.querySelector<HTMLButtonElement>('#settingsBtn')!;
    const last = container.querySelector<HTMLButtonElement>('#newChatBtn')!;
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
    expect(store.sidebarOpen.value).toBe(false);
  });

  it('keeps the mobile panel usable when the desktop sidebar was collapsed', () => {
    const { container, setMobile } = setup({ collapsed: true });
    const rail = container.querySelector('.sidebar-rail')!;
    const panel = container.querySelector('.sidebar-panel')!;
    expect(panel).toHaveAttribute('inert');
    expect(rail).not.toHaveAttribute('inert');

    setMobile(true);
    expect(panel).not.toHaveAttribute('inert');
    expect(rail).toHaveAttribute('inert');
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull();

    setMobile(false);
    expect(panel).toHaveAttribute('inert');
    expect(rail).not.toHaveAttribute('inert');
  });

  it('wraps mobile focus through the selected footer tab, skipping the inactive tab', async () => {
    const { container } = setup({ mobile: true });
    act(() => {
      store.projectsEnabled.value = true;
    });
    await userEvent.click(screen.getByRole('button', { name: 'Open sidebar' }));
    const dialog = screen.getByRole('dialog', { name: 'Sessions' });
    await waitFor(() => expect(dialog).toHaveFocus());
    const first = container.querySelector<HTMLButtonElement>('#settingsBtn')!;
    const selected = screen.getByRole('tab', { name: 'Recent' });
    expect(screen.getByRole('tab', { name: 'Projects' })).toHaveAttribute('tabindex', '-1');

    selected.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(selected).toHaveFocus();
  });
});
