import { signal } from '@preact/signals';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../domain/types';
import type { AppStore } from '../stores/app-store';
import type { BotView } from './navigation';
import { PersonalBotSidebar } from './PersonalBotSidebar';

const session = (id: string, title: string): Session => ({
  id,
  title,
  name: '',
  mode: 'chat',
  origin: 'web',
  archived: false,
  pinned: false,
  created: 100,
  lastMessageAt: 100,
  messages: [],
});

function setup({ ready = true, opening = false } = {}) {
  let mobile = true;
  const listeners = new Set<() => void>();
  vi.spyOn(window, 'matchMedia').mockReturnValue({
    get matches() {
      return mobile;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  } as unknown as MediaQueryList);
  const state = {
    config: { title: 'Sammy', hub: { url: '/hub/' } },
    sessions: signal([session('recent', 'Research notes')]),
    activeSessionId: signal('recent'),
    networkState: signal('online'),
    modal: signal(''),
  };
  const navigate = vi.fn();
  const openConversation = vi.fn(async (_id?: string) => {});
  const fixture = (view: BotView = 'home') => (
    <div id="appShell">
      <PersonalBotSidebar
        store={state as unknown as AppStore}
        view={view}
        ready={ready}
        opening={opening}
        navigate={navigate}
        openConversation={openConversation}
      />
      <main>
        <button>Send message</button>
      </main>
    </div>
  );
  const rendered = render(fixture());
  return {
    ...rendered,
    state,
    navigate,
    openConversation,
    rerenderView: (view: BotView) => rendered.rerender(fixture(view)),
    setMobile: async (next: boolean) => {
      await act(() => {
        mobile = next;
        listeners.forEach((listener) => listener());
      });
    },
    listeners,
  };
}

function openSidebar() {
  const trigger = screen.getByRole('button', { name: 'Open sidebar' });
  trigger.focus();
  fireEvent.click(trigger);
  return trigger;
}

describe('personal assistant mobile sidebar', () => {
  it('keeps navigation and workspace controls in a named drawer', () => {
    setup();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New conversation' })).not.toBeInTheDocument();

    const trigger = openSidebar();
    const drawer = screen.getByRole('dialog', { name: 'Agent navigation' });
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(drawer).toHaveAttribute('id', trigger.getAttribute('aria-controls'));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Your agents' })).toHaveAttribute('href', '/hub/');
    expect(screen.getByText('Connected to your workspace')).toBeInTheDocument();
  });

  it.each(['home', 'activity', 'conversations', 'routines', 'widgets'] as const)(
    'closes the drawer when navigating to %s',
    (view) => {
      const { navigate } = setup();
      openSidebar();
      fireEvent.click(
        screen.getByRole('button', { name: view[0].toUpperCase() + view.slice(1), exact: true }),
      );
      expect(navigate).toHaveBeenCalledExactlyOnceWith(view);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    },
  );

  it('closes the drawer when starting or reopening a conversation and opening settings', () => {
    const { state, openConversation } = setup();
    openSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }));
    expect(openConversation).toHaveBeenLastCalledWith(undefined);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Research notes' }));
    expect(openConversation).toHaveBeenLastCalledWith('recent');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    openSidebar();
    fireEvent.click(screen.getByRole('button', { name: /^Settings/ }));
    expect(state.modal.value).toBe('settings');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    { ready: false, opening: false },
    { ready: true, opening: true },
  ])('disables conversation actions while ready=$ready and opening=$opening', async (options) => {
    const { openConversation } = setup(options);
    openSidebar();
    const newConversation = screen.getByRole('button', { name: 'New conversation' });
    const recent = screen.getByRole('button', { name: 'Research notes' });
    expect(newConversation).toBeDisabled();
    expect(recent).toBeDisabled();
    await userEvent.click(newConversation);
    await userEvent.click(recent);
    expect(openConversation).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('dismisses with the close control and an outside pointer gesture', () => {
    setup();
    const trigger = openSidebar();
    fireEvent.click(screen.getByRole('button', { name: 'Close sidebar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    openSidebar();
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.pointerDown(backdrop, { pointerId: 7 });
    fireEvent.pointerUp(backdrop, { pointerId: 7 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('traps keyboard focus, blocks background controls, and restores them on Escape', async () => {
    const { container } = setup();
    const trigger = openSidebar();
    const drawer = screen.getByRole('dialog');
    const first = screen.getByRole('button', { name: 'Sammy home' });
    const last = screen.getByRole('button', { name: /^Settings/ });
    await waitFor(() => expect(first).toHaveFocus());
    expect(container.querySelector<HTMLElement>('main')?.inert).toBe(true);
    expect(container.querySelector<HTMLElement>('.pb-mobile-header')?.inert).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');

    fireEvent.keyDown(drawer, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(drawer, { key: 'Tab' });
    expect(first).toHaveFocus();
    fireEvent.keyDown(drawer, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector<HTMLElement>('main')?.inert).toBe(false);
    expect(container.querySelector<HTMLElement>('.pb-mobile-header')?.inert).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('releases the page when resized to desktop and returns to a closed mobile drawer', async () => {
    const { container, setMobile, listeners, unmount } = setup();
    await act(() => {});
    openSidebar();
    await setMobile(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Agent navigation' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New conversation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).not.toBeInTheDocument();
    expect(container.querySelector<HTMLElement>('main')?.inert).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');

    await setMobile(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await act(() => {
      unmount();
    });
    expect(listeners.size).toBe(0);
  });

  it('closes the drawer when the current view changes externally', async () => {
    const { container, rerenderView } = setup();
    openSidebar();
    await act(() => rerenderView('conversation'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(container.querySelector<HTMLElement>('main')?.inert).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
  });
});
