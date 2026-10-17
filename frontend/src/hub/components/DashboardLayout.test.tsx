import { act, fireEvent, render, screen } from '@testing-library/preact';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardLayout } from './DashboardLayout';

function fixture() {
  return render(
    <DashboardLayout
      title="Your agents"
      className="pbm-app"
      brand={<a href="/">Your agents</a>}
      navigation={(close) => <button onClick={close}>Refresh</button>}
    >
      <main>
        <button>Open assistant</button>
      </main>
    </DashboardLayout>,
  );
}

// jsdom cannot enter the top layer. The browser smoke covers native dialog
// focus trapping and background inertness; here we verify its lifecycle.
beforeEach(() => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.setAttribute('open', '');
  });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (
    this: HTMLDialogElement,
  ) {
    this.removeAttribute('open');
  });
});

describe('Dashboard sidebar', () => {
  it('uses the native modal lifecycle and restores focus when the browser cancels it', () => {
    fixture();
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    trigger.focus();
    fireEvent.click(trigger);
    const drawer = screen.getByRole('dialog', { name: 'Your agents navigation' });
    expect(HTMLDialogElement.prototype.showModal).toHaveBeenCalledOnce();
    expect(drawer).toHaveAttribute('open');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(document.documentElement.style.overflow).toBe('hidden');
    fireEvent(drawer, new Event('cancel', { cancelable: true }));
    expect(HTMLDialogElement.prototype.close).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('dismisses an outside click and the explicit close control', () => {
    fixture();
    const trigger = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(trigger);
    const drawer = screen.getByRole('dialog');
    fireEvent.click(drawer, { clientX: 500, clientY: 200 });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('reconciles an open folded drawer into a persistent unfolded rail and releases scroll', async () => {
    let wide = false;
    const listeners = new Set<() => void>();
    const media = {
      get matches() {
        return wide;
      },
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    } as unknown as MediaQueryList;
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    const { unmount } = fixture();
    await act(() => {});
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    await act(() => {
      wide = true;
      listeners.forEach((listener) => listener());
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Your agents controls' })).toBeVisible();
    expect(document.documentElement.style.overflow).toBe('');
    expect(screen.queryByRole('button', { name: 'Close navigation' })).not.toBeInTheDocument();
    await act(() => {
      wide = false;
      listeners.forEach((listener) => listener());
    });
    expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
    await act(() => {
      unmount();
    });
    expect(listeners.size).toBe(0);
  });
});
