import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { expect, it } from 'vitest';
import { ThemePicker } from './ThemePicker';
import { initializePersonalBotTheme, PERSONAL_BOT_THEME_KEY } from './personal-bot-theme';

it('offers all presets accessibly and keeps compact and settings controls synchronized', async () => {
  const dispose = initializePersonalBotTheme();
  try {
    render(
      <>
        <ThemePicker />
        <ThemePicker compact />
      </>,
    );
    const [settings, compact] = screen.getAllByRole('combobox', { name: 'Theme', exact: true });
    expect(settings).not.toHaveAttribute('id', compact.id);
    expect(settings).toHaveValue('tokyo-night');
    expect(compact).toHaveValue('tokyo-night');
    expect([...settings.querySelectorAll('option')].map((option) => option.textContent)).toEqual([
      'System',
      'Sage Light',
      'Sage Dark',
      'Catppuccin Mocha',
      'Dracula',
      'Nord',
      'Tokyo Night',
    ]);
    fireEvent.change(compact, { target: { value: 'dracula' } });
    await waitFor(() => expect(settings).toHaveValue('dracula'));
    expect(document.documentElement.dataset.personalBotTheme).toBe('dracula');
    expect(localStorage.getItem(PERSONAL_BOT_THEME_KEY)).toBe('dracula');
    fireEvent.change(settings, { target: { value: 'sage-light' } });
    await waitFor(() => expect(compact).toHaveValue('sage-light'));
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-light');
  } finally {
    dispose();
  }
});
