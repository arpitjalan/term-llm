import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  initializePersonalBotTheme,
  PERSONAL_BOT_THEME_KEY,
  personalBotAgentThemeKey,
  personalBotTheme,
  seedPersonalBotAgentTheme,
  setPersonalBotTheme,
} from './personal-bot-theme';

const disposers: Array<() => void> = [];
function initialize(prefix?: string) {
  const dispose = initializePersonalBotTheme(prefix);
  disposers.push(dispose);
  return dispose;
}

function systemAppearance(initialDark = false) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_event: string, listener: () => void) =>
      listeners.delete(listener),
    ),
  };
  vi.spyOn(window, 'matchMedia').mockReturnValue(query as unknown as MediaQueryList);
  return {
    query,
    listeners,
    change(value: boolean) {
      dark = value;
      for (const listener of listeners) listener();
    },
  };
}

function storageEvent(key: string | null, value: string | null, area?: Storage) {
  const event = new StorageEvent('storage', { key, newValue: value });
  if (area) Object.defineProperty(event, 'storageArea', { value: area });
  window.dispatchEvent(event);
}

afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  personalBotTheme.value = 'system';
  delete document.documentElement.dataset.personalBotTheme;
});

describe('Personal Bot theme preference', () => {
  it('follows device appearance only while System is selected', () => {
    const system = systemAppearance();
    initialize();
    expect(personalBotTheme.value).toBe('system');
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-light');
    system.change(true);
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-dark');
    setPersonalBotTheme('nord');
    system.change(false);
    expect(document.documentElement.dataset.personalBotTheme).toBe('nord');
    setPersonalBotTheme('system');
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-light');
  });

  it('restores the manager preference across mounts using the existing key', () => {
    systemAppearance();
    const dispose = initialize();
    setPersonalBotTheme('catppuccin');
    expect(localStorage.getItem(PERSONAL_BOT_THEME_KEY)).toBe('catppuccin');
    expect(localStorage.length).toBe(1);
    dispose();
    personalBotTheme.value = 'system';
    initialize();
    expect(personalBotTheme.value).toBe('catppuccin');
    expect(document.documentElement.dataset.personalBotTheme).toBe('catppuccin');
  });

  it('keeps each agent and the manager independent across mounts', () => {
    systemAppearance();
    const manager = initialize();
    setPersonalBotTheme('nord');
    seedPersonalBotAgentTheme('/hub/node/atlas/', personalBotTheme.peek());
    seedPersonalBotAgentTheme('/hub/node/iris/', personalBotTheme.peek());
    setPersonalBotTheme('dracula');
    manager();

    const atlas = initialize('/hub/node/atlas');
    expect(personalBotTheme.value).toBe('nord');
    setPersonalBotTheme('catppuccin');
    expect(localStorage.getItem(PERSONAL_BOT_THEME_KEY)).toBe('dracula');
    atlas();
    const iris = initialize('/hub/node/iris');
    expect(personalBotTheme.value).toBe('nord');
    iris();
    const reopened = initialize('/hub/node/atlas/');
    expect(personalBotTheme.value).toBe('catppuccin');
    reopened();
    initialize();
    expect(personalBotTheme.value).toBe('dracula');
  });

  it('inherits the old shared preference once for an existing agent', () => {
    systemAppearance();
    localStorage.setItem(PERSONAL_BOT_THEME_KEY, 'tokyo-night');
    const agent = initialize('/node/existing');
    expect(personalBotTheme.value).toBe('tokyo-night');
    expect(localStorage.getItem(personalBotAgentThemeKey('/node/existing'))).toBe('tokyo-night');
    agent();
    localStorage.setItem(PERSONAL_BOT_THEME_KEY, 'sage-light');
    initialize('/node/existing');
    expect(personalBotTheme.value).toBe('tokyo-night');
  });

  it('keeps identical node IDs at different Hub mounts and standalone agents separate', () => {
    systemAppearance();
    seedPersonalBotAgentTheme('/first/node/atlas', 'nord');
    seedPersonalBotAgentTheme('/second/node/atlas', 'dracula');
    seedPersonalBotAgentTheme('/chat', 'catppuccin');
    for (const [prefix, theme] of [
      ['/first/node/atlas', 'nord'],
      ['/second/node/atlas', 'dracula'],
      ['/chat', 'catppuccin'],
    ]) {
      const dispose = initialize(prefix);
      expect(personalBotTheme.value).toBe(theme);
      dispose();
    }
  });

  it('synchronizes only tabs for the same agent and honors removal and clear events', () => {
    systemAppearance(true);
    seedPersonalBotAgentTheme('/node/atlas', 'nord');
    initialize('/node/atlas');
    const write = vi.spyOn(localStorage, 'setItem');
    storageEvent(PERSONAL_BOT_THEME_KEY, 'dracula');
    storageEvent(personalBotAgentThemeKey('/node/iris'), 'catppuccin');
    expect(personalBotTheme.value).toBe('nord');
    storageEvent(personalBotAgentThemeKey('/node/atlas'), 'tokyo-night', sessionStorage);
    expect(personalBotTheme.value).toBe('nord');
    storageEvent(personalBotAgentThemeKey('/node/atlas'), 'tokyo-night', localStorage);
    expect(document.documentElement.dataset.personalBotTheme).toBe('tokyo-night');
    storageEvent(personalBotAgentThemeKey('/node/atlas'), null, localStorage);
    expect(personalBotTheme.value).toBe('system');
    storageEvent(personalBotAgentThemeKey('/node/atlas'), 'sage-light', localStorage);
    storageEvent(null, null, localStorage);
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-dark');
    expect(write).not.toHaveBeenCalled();
  });

  it('preserves System as an independent agent preference', () => {
    const system = systemAppearance();
    seedPersonalBotAgentTheme('/node/atlas', 'system');
    localStorage.setItem(PERSONAL_BOT_THEME_KEY, 'dracula');
    initialize('/node/atlas');
    expect(personalBotTheme.value).toBe('system');
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-light');
    system.change(true);
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-dark');
    expect(localStorage.getItem(PERSONAL_BOT_THEME_KEY)).toBe('dracula');
  });

  it('updates from another tab without writing back and honors clear events', () => {
    systemAppearance(true);
    initialize();
    const write = vi.spyOn(localStorage, 'setItem');
    storageEvent('unrelated-key', 'dracula');
    expect(personalBotTheme.value).toBe('system');
    storageEvent(PERSONAL_BOT_THEME_KEY, 'dracula', sessionStorage);
    expect(personalBotTheme.value).toBe('system');
    storageEvent(PERSONAL_BOT_THEME_KEY, 'dracula', localStorage);
    expect(personalBotTheme.value).toBe('dracula');
    expect(document.documentElement.dataset.personalBotTheme).toBe('dracula');
    storageEvent(null, null, localStorage);
    expect(personalBotTheme.value).toBe('system');
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-dark');
    expect(write).not.toHaveBeenCalled();
  });

  it('falls back safely for invalid saved choices and ignores invalid selections', () => {
    systemAppearance();
    localStorage.setItem(PERSONAL_BOT_THEME_KEY, 'unknown-theme');
    initialize();
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-light');
    setPersonalBotTheme('tokyo-night');
    setPersonalBotTheme('unknown-theme');
    expect(document.documentElement.dataset.personalBotTheme).toBe('tokyo-night');
    expect(localStorage.getItem(PERSONAL_BOT_THEME_KEY)).toBe('tokyo-night');
    storageEvent(PERSONAL_BOT_THEME_KEY, 'unknown-theme');
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-light');
  });

  it('still changes appearance when access to localStorage throws', () => {
    systemAppearance();
    const descriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('Storage denied');
      },
    });
    try {
      expect(() => initialize()).not.toThrow();
      expect(() => setPersonalBotTheme('sage-dark')).not.toThrow();
      expect(document.documentElement.dataset.personalBotTheme).toBe('sage-dark');
    } finally {
      Object.defineProperty(window, 'localStorage', descriptor);
    }
  });

  it('shares listeners across mounts and removes its attribute after the last cleanup', () => {
    const system = systemAppearance();
    const first = initialize();
    const second = initialize();
    expect(system.query.addEventListener).toHaveBeenCalledOnce();
    first();
    first(); // Cleanup is idempotent.
    system.change(true);
    expect(document.documentElement.dataset.personalBotTheme).toBe('sage-dark');
    second();
    expect(system.listeners.size).toBe(0);
    expect(document.documentElement).not.toHaveAttribute('data-personal-bot-theme');
    storageEvent(PERSONAL_BOT_THEME_KEY, 'nord');
    expect(personalBotTheme.value).toBe('system');
    setPersonalBotTheme('dracula');
    expect(document.documentElement).not.toHaveAttribute('data-personal-bot-theme');
  });
});
