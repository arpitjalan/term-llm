import type { Page } from '@playwright/test';

/** Dashboard actions live in a persistent rail or the folded navigation drawer. */
export async function openDashboardNavigation(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: 'Open navigation', exact: true });
  if ((await trigger.isVisible()) && (await trigger.getAttribute('aria-expanded')) !== 'true')
    await trigger.click();
}
