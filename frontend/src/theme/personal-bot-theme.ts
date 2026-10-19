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
export const personalBotTheme = signal<PersonalBotTheme>('system');

let users = 0;
let activeKey = PERSONAL_BOT_THEME_KEY;
let media: MediaQueryList | undefined;
let detach: (() => void) | undefined;

function isTheme(value: unknown): value is PersonalBotTheme {
  return personalBotThemeOptions.some((option) => option.value === value);
}

/** Full UI mounts distinguish agents, including separate Hubs on the same origin. */
export function personalBotAgentThemeKey(prefix: string): string {
  return `${PERSONAL_BOT_THEME_KEY}:agent:${encodeURIComponent(prefix.replace(/\/+$/, '') || '/')}`;
}

function readTheme(key: string): PersonalBotTheme | undefined {
  try {
    const saved = window.localStorage.getItem(key);
    return isTheme(saved) ? saved : undefined;
  } catch {
    return undefined;
  }
}

function saveTheme(key: string, value: PersonalBotTheme): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private browsing or a full store must not prevent changing this page's theme.
  }
}

/** Snapshot the manager's choice without changing the manager's own appearance. */
export function seedPersonalBotAgentTheme(prefix: string, theme: PersonalBotTheme): void {
  saveTheme(personalBotAgentThemeKey(prefix), theme);
}

function applyTheme(): void {
  if (!users) return;
  const choice = personalBotTheme.peek();
  document.documentElement.dataset.personalBotTheme =
    choice === 'system' ? (media?.matches ? 'sage-dark' : 'sage-light') : choice;
}

/** Update only the mounted manager or agent's browser-local preference. */
export function setPersonalBotTheme(value: string): void {
  if (!isTheme(value)) return;
  personalBotTheme.value = value;
  applyTheme();
  saveTheme(activeKey, value);
}

/** Apply only while Personal Bot is mounted; ordinary chat and Hub remain unaffected. */
export function initializePersonalBotTheme(agentPrefix?: string): () => void {
  if (users++ === 0) {
    activeKey =
      agentPrefix === undefined ? PERSONAL_BOT_THEME_KEY : personalBotAgentThemeKey(agentPrefix);
    const saved = readTheme(activeKey);
    personalBotTheme.value = saved ?? readTheme(PERSONAL_BOT_THEME_KEY) ?? 'system';
    if (agentPrefix !== undefined && saved === undefined) {
      // Preserve the old shared choice once for existing agents or a new browser.
      seedPersonalBotAgentTheme(agentPrefix, personalBotTheme.peek());
    }
    media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystemChange = () => {
      if (personalBotTheme.peek() === 'system') applyTheme();
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== activeKey) return;
      try {
        if (event.storageArea && event.storageArea !== window.localStorage) return;
      } catch {
        return;
      }
      personalBotTheme.value = isTheme(event.newValue) ? event.newValue : 'system';
      applyTheme();
    };
    media?.addEventListener('change', onSystemChange);
    window.addEventListener('storage', onStorage);
    detach = () => {
      media?.removeEventListener('change', onSystemChange);
      window.removeEventListener('storage', onStorage);
      media = undefined;
      activeKey = PERSONAL_BOT_THEME_KEY;
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
