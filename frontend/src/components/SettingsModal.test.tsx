import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StoreContext } from '../app/context';
import { AppStore } from '../stores/app-store';
import { testConfig } from '../stores/store-test-fixtures';
import { Settings } from './SettingsModal';

let store: AppStore;
afterEach(() => store?.dispose());

describe('settings section navigation', () => {
  it('reveals the whole focused or clicked tab in a horizontally scrolling tablist', async () => {
    store = new AppStore(testConfig);
    render(
      <StoreContext.Provider value={store}>
        <Settings />
      </StoreContext.Provider>,
    );
    const first = screen.getByRole('tab', { name: 'Model' });
    const last = screen.getByRole('tab', { name: 'Connection' });
    const revealFirst = vi.fn();
    const revealLast = vi.fn();
    first.scrollIntoView = revealFirst;
    last.scrollIntoView = revealLast;
    await waitFor(() => expect(first).toHaveFocus());
    revealFirst.mockClear();

    fireEvent.keyDown(first, { key: 'End' });
    expect(last).toHaveFocus();
    expect(last).toHaveAttribute('aria-selected', 'true');
    expect(revealLast).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });

    fireEvent.keyDown(last, { key: 'Home' });
    expect(first).toHaveFocus();
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(revealFirst).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });

    // Touch/pointer activation need not focus buttons. Selecting a partly
    // clipped section still reveals its label, including repeated selection.
    revealLast.mockClear();
    fireEvent.click(last);
    fireEvent.click(last);
    expect(last).toHaveAttribute('aria-selected', 'true');
    expect(revealLast).toHaveBeenCalledTimes(2);
    expect(revealLast).toHaveBeenLastCalledWith({ block: 'nearest', inline: 'nearest' });
  });
});
