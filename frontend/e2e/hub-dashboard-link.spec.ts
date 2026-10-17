import { expect, test } from '@playwright/test';
import { openDashboardNavigation } from './hub-navigation';

const root = process.env.TERM_LLM_MANAGER_SMOKE_URL;
const token = process.env.TERM_LLM_MANAGER_SMOKE_TOKEN;

test.use({ video: 'off' });
test.skip(
  !root || !token,
  'Start an isolated Personal Bot Hub and set the management smoke URL/token.',
);

test('agent management and the Hub dashboard share authentication and their mounted API', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${root}?token=${encodeURIComponent(token!)}`);
  await expect(page).toHaveURL(root!);
  await expect(page).toHaveTitle('Your agents - term-llm');
  await expect(page.locator('.pbm-app')).toBeVisible();

  await openDashboardNavigation(page);
  const dashboard = page.getByRole('link', { name: 'Hub dashboard', exact: true });
  await expect(dashboard).toBeVisible();
  const dashboardURL = new URL('dashboard/', root!);
  await expect(dashboard).toHaveAttribute('href', dashboardURL.pathname);
  const nodesRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === new URL('api/nodes', root!).pathname,
  );
  await dashboard.click();
  await nodesRequest;
  await expect(page).toHaveURL(dashboardURL.href);
  await expect(page).toHaveTitle('Hub - term-llm');
  await expect(page.locator('.hub-dashboard')).toBeVisible();
  await expect(page.locator('.pbm-app')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await openDashboardNavigation(page);
  const agents = page.getByRole('link', { name: 'Your agents', exact: true });
  await expect(agents).toBeVisible();
  await expect(agents).toHaveAttribute('href', new URL(root!).pathname);
  await page.screenshot({
    path: testInfo.outputPath('hub-dashboard-navigation.png'),
    fullPage: true,
  });
  await agents.click();
  await expect(page).toHaveURL(root!);
  await expect(page).toHaveTitle('Your agents - term-llm');
  await expect(page.locator('.pbm-app')).toBeVisible();
  await expect(page.locator('.hub-dashboard')).toHaveCount(0);
  expect(errors).toEqual([]);
});
