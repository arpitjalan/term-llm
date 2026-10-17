import { expect, type Locator, type Page } from '@playwright/test';

export async function openPersonalBotSidebar(page: Page): Promise<Locator> {
  await expect(page.locator('.personal-bot')).toBeVisible();
  if (await page.evaluate(() => matchMedia('(max-width: 767px)').matches)) {
    const trigger = page.getByRole('button', {
      name: 'Open sidebar',
      exact: true,
      includeHidden: true,
    });
    await expect(trigger).toBeVisible();
    if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
    const sidebar = page.getByRole('dialog', { name: 'Agent navigation', exact: true });
    await expect(sidebar).toBeVisible();
    await expect
      .poll(() => sidebar.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
    return sidebar;
  }
  const sidebar = page.locator('.pb-sidebar');
  await expect(sidebar).toBeVisible();
  return sidebar;
}

export async function closePersonalBotSidebar(page: Page): Promise<void> {
  const sidebar = page.getByRole('dialog', { name: 'Agent navigation', exact: true });
  if (await sidebar.isVisible()) {
    await sidebar.getByRole('button', { name: 'Close sidebar', exact: true }).click();
    await expect(sidebar).toBeHidden();
  }
}

export async function selectPersonalBotNavigation(page: Page, name: string): Promise<void> {
  const sidebar = await openPersonalBotSidebar(page);
  await sidebar
    .getByRole('button', {
      name: name === 'Settings' ? /^Settings(?: term-llm)?$/ : name,
      exact: true,
    })
    .click();
  await expect(page.getByRole('dialog', { name: 'Agent navigation', exact: true })).toBeHidden();
}

export async function expectPersonalBotCurrent(page: Page, name: string): Promise<void> {
  const sidebar = await openPersonalBotSidebar(page);
  await expect(sidebar.getByRole('button', { name, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await closePersonalBotSidebar(page);
}
