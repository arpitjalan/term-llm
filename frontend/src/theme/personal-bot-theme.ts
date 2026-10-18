import { signal } from '@preact/signals';

export const PERSONAL_BOT_THEME_KEY = 'term_llm_personal_bot_theme';

export const personalBotThemeOptions = [
  { value: 'system', label: 'System' },
  { value: 'sage-light', label: 'Sage Light' },
  { value: 'sage-dark', label: 'Sage Dark' },
  { value: 'catppuccin', label: 'Catppuccin Mocha' },
  { value: 'dracula', label: 'Dracula' },
  { value: 'nord', label: 'Nord' },
  { value: 'tokyo-night', label: 'Tokyo Night' },
] as const;

export type PersonalBotTheme = (typeof personalBotThemeOptions)[number]['value'];
const defaultPersonalBotTheme: PersonalBotTheme = 'tokyo-night';
export const personalBotTheme = signal<PersonalBotTheme>(defaultPersonalBotTheme);

let users = 0;
let media: MediaQueryList | undefined;
let detach: (() => void) | undefined;

function isTheme(value: unknown): value is PersonalBotTheme {
  return personalBotThemeOptions.some((option) => option.value === value);
}

function applyTheme(): void {
  if (!users) return;
  const choice = personalBotTheme.peek();
  document.documentElement.dataset.personalBotTheme =
    choice === 'system' ? (media?.matches ? 'sage-dark' : 'sage-light') : choice;
}

/** One non-sensitive, origin-wide preference for the manager and proxied assistants. */
export function setPersonalBotTheme(value: string): void {
  if (!isTheme(value)) return;
  personalBotTheme.value = value;
  applyTheme();
  try {
    window.localStorage.setItem(PERSONAL_BOT_THEME_KEY, value);
  } catch {
    // Private browsing or a full store must not prevent changing this page's theme.
  }
}

/** Apply only while Personal Bot is mounted; ordinary chat and Hub remain unaffected. */
export function initializePersonalBotTheme(): () => void {
  if (users++ === 0) {
    try {
      const saved = window.localStorage.getItem(PERSONAL_BOT_THEME_KEY);
      personalBotTheme.value = isTheme(saved) ? saved : defaultPersonalBotTheme;
    } catch {
      // Keep the in-memory choice when browser storage is inaccessible.
    }
    media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (personalBotTheme.peek() === 'system') applyTheme();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== PERSONAL_BOT_THEME_KEY) return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      personalBotTheme.value = isTheme(event.newValue) ? event.newValue : defaultPersonalBotTheme;
      applyTheme();
    };
    media?.addEventListener('change', onSystemChange);
    window.addEventListener('storage', onStorage);
    detach = () => {
      media?.removeEventListener('change', onSystemChange);
      window.removeEventListener('storage', onStorage);
      media = undefined;
      delete document.documentElement.dataset.personalBotTheme;
    };
    applyTheme();
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--users === 0) {
      detach?.();
      detach = undefined;
    }
  };
}
