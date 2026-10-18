import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  closePersonalBotSidebar,
  openPersonalBotSidebar,
  selectPersonalBotNavigation,
} from './personal-bot-navigation';

// Run against the real, isolated debug-provider server supplied by the smoke
// script. No Docker containers, user credentials, or external models are used.
test.skip(
  process.env.TERM_LLM_PERSONAL_BOT_SMOKE !== '1',
  'Run with scripts/personal_bot_smoke.sh to start the Personal Bot server.',
);
test.use({ video: 'off' });

const themes = ['sage-light', 'sage-dark', 'catppuccin', 'dracula', 'nord', 'tokyo-night'] as const;

async function openConversation(page: Page): Promise<void> {
  await page.goto('./?new=1');
  await selectPersonalBotNavigation(page, 'New conversation');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
}

async function openThemeSettings(page: Page): Promise<Locator> {
  await selectPersonalBotNavigation(page, 'Settings');
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.getByRole('tab', { name: 'Interface', exact: true }).click();
  return dialog.getByRole('combobox', { name: 'Theme', exact: true });
}

async function expectTokenColor(
  element: Locator,
  property: 'background-color' | 'border-bottom-color' | 'color',
  token: string,
): Promise<void> {
  // Resolve the semantic token through the browser's CSS engine. This checks
  // actual painted surfaces without fixing six palettes to brittle RGB values.
  const expected = await element.evaluate(
    (target, { property, token }) => {
      const value = getComputedStyle(target).getPropertyValue(token).trim();
      if (!value) throw new Error(`Missing theme token ${token}`);
      const probe = document.createElement('span');
      probe.style.setProperty(property, value);
      document.body.append(probe);
      const color = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return color;
    },
    { property, token },
  );
  await expect(element).toHaveCSS(property, expected);
}

async function expectConversationPalette(page: Page): Promise<void> {
  const sidebar = await openPersonalBotSidebar(page);
  await expectTokenColor(sidebar, 'background-color', '--pb-sidebar');
  await closePersonalBotSidebar(page);
  await expectTokenColor(page.locator('.pb-conversation'), 'background-color', '--bg');
  await expectTokenColor(page.locator('.main-header'), 'background-color', '--surface');
  await expectTokenColor(page.locator('.composer'), 'background-color', '--bg');
  await expectTokenColor(page.locator('.composer-box'), 'background-color', '--surface-2');
  const prompt = page.getByRole('textbox', { name: 'Message', exact: true });
  await prompt.focus();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveCSS('outline-style', 'none');
  await expectTokenColor(page.locator('.composer-box'), 'border-bottom-color', '--border-strong');
  await expectTokenColor(prompt, 'color', '--text');
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1);
}

for (const theme of themes) {
  test(`${theme} colors the conversation and settings consistently`, async ({ page }, testInfo) => {
    await page.setViewportSize(
      testInfo.project.name === 'desktop'
        ? { width: 1440, height: 1000 }
        : { width: 390, height: 844 },
    );
    // Deliberately choose the opposite OS appearance to catch leftover media
    // queries overriding the user's explicit choice on shared chat components.
    await page.emulateMedia({ colorScheme: theme === 'sage-light' ? 'dark' : 'light' });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await openConversation(page);
    const picker = await openThemeSettings(page);
    await expect(picker.locator('option')).toHaveCount(themes.length + 1);
    expect(
      await picker
        .locator('option')
        .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
    ).toEqual(['system', ...themes]);
    await picker.selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', theme);
    await expect(page.locator('html')).toHaveCSS(
      'color-scheme',
      theme === 'sage-light' ? 'light' : 'dark',
    );
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
    await expectTokenColor(dialog, 'background-color', '--surface');
    await expectTokenColor(dialog, 'color', '--text');
    await expectTokenColor(
      dialog.getByRole('tab', { name: 'Interface', exact: true }),
      'border-bottom-color',
      '--accent',
    );
    await expect(picker).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`${theme}-settings.png`), fullPage: true });
    await dialog.getByRole('button', { name: 'Close Settings', exact: true }).click();
    await expectConversationPalette(page);
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`${theme}-conversation.png`),
      fullPage: true,
    });

    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', theme);
    await expectConversationPalette(page);
    await expect(await openThemeSettings(page)).toHaveValue(theme);
    expect(errors).toEqual([]);
  });
}

test('Tokyo Night is the default and System follows appearance changes when selected', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openConversation(page);
  const picker = await openThemeSettings(page);
  await expect(picker).toHaveValue('tokyo-night');
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'tokyo-night');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(picker).toHaveValue('tokyo-night');
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'tokyo-night');
  await page.emulateMedia({ colorScheme: 'light' });
  await picker.selectOption('system');
  await expect(picker).toHaveValue('system');
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'sage-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'sage-dark');
  await picker.selectOption('nord');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'nord');
  await picker.selectOption('system');
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'sage-light');
  await page.reload();
  await expect(await openThemeSettings(page)).toHaveValue('system');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'sage-dark');
  await expectTokenColor(
    page.getByRole('dialog', { name: 'Settings', exact: true }),
    'background-color',
    '--surface',
  );
  await expectNoHorizontalOverflow(page);
});

test('each named theme supplies a distinct shared palette', async ({ page }) => {
  await openConversation(page);
  const picker = await openThemeSettings(page);
  const palettes = new Set<string>();
  for (const theme of themes) {
    await picker.selectOption(theme);
    await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', theme);
    const palette = await page.locator('html').evaluate((root) => {
      const styles = getComputedStyle(root);
      return ['--pb-bg', '--pb-text', '--pb-accent'].map((token) =>
        styles.getPropertyValue(token).trim(),
      );
    });
    expect(palette.every(Boolean), `${theme} must supply all shared palette tokens`).toBe(true);
    palettes.add(JSON.stringify(palette));
  }
  expect(palettes.size).toBe(themes.length);
});
