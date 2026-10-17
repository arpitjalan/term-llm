import { expect, test, type Page } from '@playwright/test';
import { homeTaglines } from '../src/personal-bot/home-taglines';
import {
  closePersonalBotSidebar,
  expectPersonalBotCurrent,
  openPersonalBotSidebar,
  selectPersonalBotNavigation,
} from './personal-bot-navigation';

// The ordinary chat smoke starts a different shell. This suite is opt-in through
// scripts/personal_bot_smoke.sh, which uses an isolated, real debug-provider server.
test.skip(
  process.env.TERM_LLM_PERSONAL_BOT_SMOKE !== '1',
  'Run with scripts/personal_bot_smoke.sh to start the Personal Bot server.',
);
// Screenshots and failure traces capture this demo without requiring Playwright's
// separate ffmpeg download when an installed Chrome is used locally.
test.use({ video: 'off' });

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);
}

async function openHome(page: Page): Promise<void> {
  await page.goto('./?new=1');
  await selectPersonalBotNavigation(page, 'Home');
  const sidebar = await openPersonalBotSidebar(page);
  const navigation = sidebar.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('button')).toHaveText([
    'Home',
    'Activity',
    'Conversations',
    'Routines',
    'Widgets',
  ]);
  await expect(navigation.getByRole('button', { name: 'Home', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(
    page.getByRole('button', { name: 'All conversations', exact: true, includeHidden: true }),
  ).toHaveCount(0);
  await expect(
    sidebar.getByRole('button', { name: 'New conversation', exact: true }),
  ).toBeVisible();
  await closePersonalBotSidebar(page);
  const heading = page.locator('.pb-hero h1');
  await expect(heading).toBeVisible();
  expect(homeTaglines.map((lines) => lines.join(' '))).toContain(
    (await heading.innerText()).replace(/\s+/g, ' ').trim(),
  );
  await expect(page.getByText('A little help, always here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('A little more headspace', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /^(Make a plan|Do the research|Move work forward)/ }),
  ).toHaveCount(0);
}

test('cycles homepage taglines on refresh and keeps them steady during navigation', async ({
  page,
}) => {
  await openHome(page);
  const heading = page.locator('.pb-hero h1');
  for (const lines of [...homeTaglines, homeTaglines[0]]) {
    const tagline = lines.join(' ');
    await expect(heading).toHaveText(tagline);
    await expectNoHorizontalOverflow(page);
    await selectPersonalBotNavigation(page, 'Activity');
    await expect(page.getByRole('heading', { name: 'Your assistant at work' })).toBeVisible();
    await selectPersonalBotNavigation(page, 'Home');
    await expect(heading).toHaveText(tagline);
    await page.reload();
  }
});

test('sends real work and restores its saved conversation after returning', async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  if (testInfo.project.name === 'desktop')
    await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: 'light' });
  await openHome(page);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('personal-bot-home-light.png'),
    fullPage: true,
  });
  if (testInfo.project.name === 'desktop') {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({
      path: testInfo.outputPath('personal-bot-home-dark.png'),
      fullPage: true,
    });
    await page.emulateMedia({ colorScheme: 'light' });
    // The first viewport starts with the smoke's fresh database.
    await selectPersonalBotNavigation(page, 'Activity');
    await expect(page.getByRole('heading', { name: 'All caught up', exact: true })).toBeVisible();
    await selectPersonalBotNavigation(page, 'Home');
  }

  const sidebar = await openPersonalBotSidebar(page);
  await expect(
    sidebar.getByRole('button', { name: 'New conversation', exact: true }),
  ).toBeEnabled();
  await closePersonalBotSidebar(page);
  await page.getByRole('button', { name: 'Tell me what you have in mind…', exact: true }).click();
  const prompt = `Save a brief update for the ${testInfo.project.name} demo team.`;
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue('');
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Debug Provider Output' }).last()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[^/?]+/);
  const conversationURL = page.url();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('personal-bot-conversation.png'),
    fullPage: true,
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Debug Provider Output' }).last()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator('#messages').getByText(prompt, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(conversationURL);
  const draft = 'Keep this follow-up while I review other work.';
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(draft);

  await selectPersonalBotNavigation(page, 'Activity');
  await expect(page.getByRole('heading', { name: 'Your assistant at work' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('personal-bot-activity.png'), fullPage: true });

  await selectPersonalBotNavigation(page, 'Home');
  await expect(page.locator('.pb-hero h1')).toBeVisible();
  const recentSidebar = await openPersonalBotSidebar(page);
  await recentSidebar.locator('.pb-recents button').first().click();
  await expect(page.getByRole('dialog', { name: 'Agent navigation', exact: true })).toBeHidden();
  await expect(page.locator('#messages').getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);
  // A deep link must also recover the result without relying on this tab's state.
  await page.goto(conversationURL);
  await expect(page.getByRole('heading', { name: 'Debug Provider Output' }).last()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);

  await selectPersonalBotNavigation(page, 'Conversations');
  await expectPersonalBotCurrent(page, 'Conversations');
  await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
  const searched = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/v1/sessions/search'),
  );
  await page.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill(prompt);
  expect((await searched).ok()).toBe(true);
  await page.getByRole('main').getByRole('button').filter({ hasText: prompt }).click();
  await expect(page.locator('#messages').getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Debug Provider Output' }).last()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('finds and restores archived conversations when the setting is enabled', async ({
  page,
  request,
}, testInfo) => {
  await openHome(page);
  await selectPersonalBotNavigation(page, 'New conversation');
  const title = `Archived research ${testInfo.project.name}`;
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(title);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Debug Provider Output' }).last()).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/chat\/[^/?]+/);
  const slug = new URL(page.url()).pathname.split('/').at(-1)!;
  const archived = await request.patch(`v1/sessions/${slug}`, {
    data: { archived: true, generated_short_title: title },
  });
  expect(archived.ok(), await archived.text()).toBe(true);

  await openHome(page);
  await selectPersonalBotNavigation(page, 'Conversations');
  const catalog = page.locator('.pb-conversation-catalog');
  const row = catalog.locator('.pb-conversation-item').filter({ hasText: title });
  await expect(row).toHaveCount(0);
  await selectPersonalBotNavigation(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Interface', exact: true }).click();
  await settings.getByRole('checkbox', { name: 'Show archived sessions' }).check();
  await page.keyboard.press('Escape');
  await expect(row).toBeVisible();
  await expect(row).toContainText('Archived ·');
  await expectNoHorizontalOverflow(page);

  const searched = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname.endsWith('/v1/sessions/search') &&
      url.searchParams.get('include_archived') === '1'
    );
  });
  await catalog.getByRole('searchbox', { name: 'Search conversations', exact: true }).fill(title);
  expect((await searched).ok()).toBe(true);
  await expect(row).toBeVisible();
  const restored = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.includes('/v1/sessions/') &&
      response.request().method() === 'PATCH',
  );
  await row.getByRole('button', { name: `Restore ${title}`, exact: true }).click();
  expect((await restored).ok()).toBe(true);
  await expect(row.getByRole('button', { name: `Restore ${title}`, exact: true })).toBeHidden();
  const snapshot = await request.get(`v1/sessions?selected_only=1&selected_session=${slug}`);
  expect(snapshot.ok()).toBe(true);
  expect((await snapshot.json()).selected_session).toMatchObject({ archived: false });
});

test('keeps navigation and the composer usable at a narrow phone width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openHome(page);
  for (const [destination, heading] of [
    ['Activity', 'Your assistant at work'],
    ['Conversations', 'Conversations'],
    ['Routines', 'Routines'],
    ['Widgets', 'Widgets'],
  ]) {
    await selectPersonalBotNavigation(page, destination);
    await expectPersonalBotCurrent(page, destination);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  await selectPersonalBotNavigation(page, 'Home');
  await selectPersonalBotNavigation(page, 'New conversation');
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('This draft stays available while I review ongoing work.');
  await expect(composer).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test('opens mobile navigation from a compact header and releases it on dismissal and resize', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openHome(page);
  const trigger = page.getByRole('button', {
    name: 'Open sidebar',
    exact: true,
    includeHidden: true,
  });
  const drawer = page.getByRole('dialog', { name: 'Agent navigation', exact: true });
  const main = page.locator('#appMain');
  const initialOverflow = await page.evaluate(() => document.documentElement.style.overflow);
  await expect(trigger).toHaveAttribute('aria-controls', 'personalBotSidebar');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: /^Settings(?: term-llm)?$/ })).toBeHidden();
  const headerBounds = await page.locator('.pb-mobile-header').boundingBox();
  expect(headerBounds).not.toBeNull();
  expect(headerBounds!.height).toBeLessThan(90);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('personal-bot-mobile-sidebar-closed.png'),
    fullPage: true,
  });

  await openPersonalBotSidebar(page);
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(drawer).toHaveAttribute('id', 'personalBotSidebar');
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  await expect(
    drawer.getByRole('navigation', { name: 'Main navigation' }).getByRole('button'),
  ).toHaveText(['Home', 'Activity', 'Conversations', 'Routines', 'Widgets']);
  await expect(drawer.getByText('Recent conversations', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /^Settings(?: term-llm)?$/ })).toBeVisible();
  await expect.poll(() => main.evaluate((element) => (element as HTMLElement).inert)).toBe(true);
  await expect
    .poll(() => drawer.evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('personal-bot-mobile-sidebar-open.png'),
    fullPage: true,
    animations: 'disabled',
  });

  const actions = drawer.locator('button:not([disabled]), a[href]');
  await actions.last().focus();
  await page.keyboard.press('Tab');
  await expect(actions.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(actions.last()).toBeFocused();
  await closePersonalBotSidebar(page);
  await expect(trigger).toBeFocused();
  await expect.poll(() => main.evaluate((element) => (element as HTMLElement).inert)).toBe(false);

  await openPersonalBotSidebar(page);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  await openPersonalBotSidebar(page);
  await page.locator('.drawer-backdrop-left').click({ position: { x: 355, y: 100 } });
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.overflow))
    .toBe(initialOverflow);

  await selectPersonalBotNavigation(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings).toContainText('Settings');
  await settings.getByRole('button', { name: 'Close Settings', exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect.poll(() => main.evaluate((element) => (element as HTMLElement).inert)).toBe(false);

  await page.setViewportSize({ width: 640, height: 360 });
  await openPersonalBotSidebar(page);
  const settingsButton = drawer.getByRole('button', { name: /^Settings(?: term-llm)?$/ });
  await settingsButton.scrollIntoViewIfNeeded();
  await expect(settingsButton).toBeInViewport();
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect.poll(() => main.evaluate((element) => (element as HTMLElement).inert)).toBe(false);
  await expect
    .poll(() => page.evaluate(() => document.documentElement.style.overflow))
    .toBe(initialOverflow);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(drawer).toBeHidden();
  await expectNoHorizontalOverflow(page);
});

test('opens a discovered widget in a new tab and manages its process from the Widgets tab', async ({
  page,
  request,
}, testInfo) => {
  const stopped = await request.post('admin/widgets/smoke-dashboard/stop');
  expect(stopped.ok(), await stopped.text()).toBe(true);
  await openHome(page);
  await selectPersonalBotNavigation(page, 'Widgets');
  await expect(page.getByRole('heading', { name: 'Widgets', exact: true })).toBeVisible();
  await expectPersonalBotCurrent(page, 'Widgets');
  await expect(page).toHaveURL(/[?&]bot_view=widgets(?:&|$)/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Widgets', exact: true })).toBeVisible();
  const widget = page.getByRole('link', { name: 'Open Smoke dashboard', exact: true });
  await expect(widget).toHaveAttribute('href', '/ui/widgets/smoke-dashboard/');
  await expect(widget).toHaveAttribute('target', '_blank');
  await expect(widget).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.getByRole('button', { name: 'Stop Smoke dashboard' })).toBeHidden();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('personal-bot-widgets.png'), fullPage: true });

  const widgetsURL = page.url();
  const [widgetPage] = await Promise.all([page.waitForEvent('popup'), widget.click()]);
  await expect(widgetPage).toHaveURL(/\/ui\/widgets\/smoke-dashboard\/$/);
  await expect(
    widgetPage.getByRole('heading', { name: 'Your local widget is running' }),
  ).toBeVisible();
  await expect(page).toHaveURL(widgetsURL);
  await expect(page.getByRole('heading', { name: 'Widgets', exact: true })).toBeVisible();
  await expectPersonalBotCurrent(page, 'Widgets');
  await widgetPage.close();
  await page.getByRole('button', { name: 'Refresh widgets', exact: true }).click();
  await expect(
    page.getByRole('link', { name: 'Open Smoke dashboard, Running', exact: true }),
  ).toBeVisible();
  const stopping = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/admin/widgets/smoke-dashboard/stop') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Stop Smoke dashboard' }).click();
  expect((await stopping).ok()).toBe(true);
  await expect(page.getByRole('button', { name: 'Stop Smoke dashboard' })).toBeHidden();
  await expect(page.getByRole('link', { name: 'Open Smoke dashboard', exact: true })).toBeVisible();

  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/admin/widgets/reload') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Refresh widgets', exact: true }).click();
  expect((await refreshed).ok()).toBe(true);
  await expect(page.getByRole('link', { name: 'Open Smoke dashboard', exact: true })).toBeVisible();
  const status = await request.get('admin/widgets/status');
  expect(status.ok()).toBe(true);
  expect((await status.json()).widgets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ mount: 'smoke-dashboard', state: 'stopped' }),
    ]),
  );
  await expectNoHorizontalOverflow(page);
});

test('shows an actionable starting point when no routines exist', async ({ page }, testInfo) => {
  await openHome(page);
  await selectPersonalBotNavigation(page, 'Routines');
  await expect(page.getByRole('heading', { name: 'Routines', exact: true })).toBeVisible();
  await expect(page.getByText('Your first routine starts here', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New routine', exact: true })).toBeEnabled();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('personal-bot-routines.png'), fullPage: true });
});

test('explains unavailable routines while conversations remain reachable', async ({ page }) => {
  // Only this failure-path test substitutes an unavailable jobs endpoint. Chat,
  // startup, assets, and the recovered jobs response still use the real server.
  await page.route(/\/v2\/(?:jobs|runs)(?:\?|$)/, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Jobs are not enabled.' } }),
    }),
  );
  await openHome(page);
  await selectPersonalBotNavigation(page, 'Routines');
  await expect(page.getByRole('heading', { name: 'Routines are not enabled yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New routine', exact: true })).toBeDisabled();
  await expect(page.getByText('Your first routine starts here', { exact: true })).toBeHidden();
  await selectPersonalBotNavigation(page, 'Home');
  await selectPersonalBotNavigation(page, 'New conversation');
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toBeVisible();
});

test('reports an activity failure and recovers after retrying', async ({ page }) => {
  const attentionURL = /\/v1\/attention(?:\?|$)/;
  await page.route(attentionURL, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Activity is temporarily unavailable.' } }),
    }),
  );
  await openHome(page);
  await selectPersonalBotNavigation(page, 'Activity');
  const alert = page.getByRole('alert').filter({ hasText: 'Activity is temporarily unavailable.' });
  await expect(alert).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All caught up', exact: true })).toBeHidden();
  await page.unroute(attentionURL);
  await alert.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(alert).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Your assistant at work' })).toBeVisible();
});

test('creates a routine, runs it on the server, and returns to its result', async ({
  page,
  request,
}, testInfo) => {
  const workspace = process.env.TERM_LLM_PERSONAL_BOT_WORKSPACE;
  expect(workspace, 'The smoke script must supply its isolated workspace.').toBeTruthy();
  const project = await request.post('v1/projects', {
    data: { name: 'Demo workspace', path: workspace },
  });
  // Each viewport shares this isolated workspace. Later viewports find the same
  // registered project, rather than creating a second copy of its directory.
  expect([200, 201, 409]).toContain(project.status());

  await openHome(page);
  await selectPersonalBotNavigation(page, 'Routines');
  await page.getByRole('button', { name: 'New routine', exact: true }).click();
  const form = page.getByRole('form', { name: 'Create routine', exact: true });
  const name = `Demo briefing ${testInfo.project.name}`;
  await form.getByLabel('Routine name', { exact: true }).fill(name);
  await form
    .getByLabel('Instructions', { exact: true })
    .fill('Summarize the current demo workflow.');
  await form
    .getByRole('combobox', { name: 'Workspace', exact: true })
    .selectOption({ label: 'Demo workspace' });
  await form
    .getByRole('combobox', { name: 'Assistant', exact: true })
    .selectOption({ label: 'developer' });
  await form
    .getByRole('combobox', { name: 'Schedule', exact: true })
    .selectOption({ label: 'When I run it' });
  await expectNoHorizontalOverflow(page);
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/v2/jobs') &&
      response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Create routine', exact: true }).click();
  const response = await created;
  expect(response.ok(), await response.text()).toBe(true);
  const job = (await response.json()) as { id: string };
  const waitForFinishedRun = (id: string) =>
    expect
      .poll(
        async () => {
          const current = await request.get(`v2/runs/${encodeURIComponent(id)}`);
          expect(current.ok()).toBe(true);
          return ((await current.json()) as { status: string }).status;
        },
        { timeout: 20_000 },
      )
      .toBe('succeeded');
  try {
    const card = page.getByRole('article', { name, exact: true });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeDisabled();
    await card.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Run now', exact: true })).toBeEnabled();

    const triggered = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname.endsWith(`/v2/jobs/${job.id}/trigger`) &&
        result.request().method() === 'POST',
    );
    await card.getByRole('button', { name: 'Run now', exact: true }).click();
    const trigger = await triggered;
    expect(trigger.ok(), await trigger.text()).toBe(true);
    const run = (await trigger.json()) as { id: string };
    // Close the interface that initiated the run. Completion must not depend on
    // an open page, and the result must survive opening a fresh one afterward.
    const context = page.context();
    await page.close();
    await waitForFinishedRun(run.id);
    // A second real run leaves another history row below the opened result.
    // This catches results that appear only after the entire history list.
    const repeated = await request.post(`v2/jobs/${encodeURIComponent(job.id)}/trigger`);
    expect(repeated.ok(), await repeated.text()).toBe(true);
    await waitForFinishedRun(((await repeated.json()) as { id: string }).id);
    const returned = await context.newPage();
    await returned.goto('./');
    await selectPersonalBotNavigation(returned, 'Routines');
    const runs = returned
      .getByRole('region', { name: 'Recent routine runs', exact: true })
      .locator('.pb-routine-run');
    const latestRun = runs.first();
    const viewResult = latestRun.getByRole('button', {
      name: `View result for ${name}`,
      exact: true,
    });
    await expect(viewResult).toHaveAttribute('aria-expanded', 'false');
    await viewResult.click();
    const result = latestRun.getByRole('region', { name: 'Routine result', exact: true });
    await expect(result).toContainText('Debug Provider Output');
    await expect(viewResult).toHaveAttribute('aria-expanded', 'true');
    expect(await result.evaluate((element) => element.parentElement?.id)).toBe(
      await viewResult.getAttribute('aria-controls'),
    );
    const [headerBounds, resultBounds, followingRunBounds] = await Promise.all([
      latestRun.locator('.pb-routine-run-heading').boundingBox(),
      result.boundingBox(),
      runs.nth(1).boundingBox(),
    ]);
    expect(headerBounds).not.toBeNull();
    expect(resultBounds).not.toBeNull();
    expect(followingRunBounds).not.toBeNull();
    expect(resultBounds!.y).toBeGreaterThanOrEqual(headerBounds!.y + headerBounds!.height);
    expect(resultBounds!.y + resultBounds!.height).toBeLessThanOrEqual(followingRunBounds!.y);
    await result.getByRole('button', { name: 'Close result', exact: true }).click();
    await expect(result).toBeHidden();
    await expect(viewResult).toHaveAttribute('aria-expanded', 'false');
    await viewResult.click();
    await expect(result).toContainText('Debug Provider Output');
    await expect(viewResult).toHaveAttribute('aria-expanded', 'true');
    await expectNoHorizontalOverflow(returned);
    await returned.screenshot({
      path: testInfo.outputPath('personal-bot-result.png'),
      fullPage: true,
    });
  } finally {
    const removed = await request.delete(
      `v2/jobs/${encodeURIComponent(job.id)}?cancel_active=true`,
    );
    expect(removed.ok()).toBe(true);
  }
});
