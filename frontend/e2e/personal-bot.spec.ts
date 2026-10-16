import { expect, test, type Page } from '@playwright/test';

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
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'What can I take off your plate?' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
}

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
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'All caught up', exact: true })).toBeVisible();
  }

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const prompt = `Save a brief update for the ${testInfo.project.name} demo team.`;
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

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your assistant at work' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('personal-bot-activity.png'), fullPage: true });

  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New conversation', exact: true })).toBeVisible();
  // A deep link must also recover the result without relying on this tab's state.
  await page.goto(conversationURL);
  await expect(page.getByRole('heading', { name: 'Debug Provider Output' }).last()).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(draft);

  await page.getByRole('button', { name: 'All conversations', exact: true }).click();
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

test('keeps navigation and the composer usable at a narrow phone width', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await openHome(page);
  for (const [destination, heading] of [
    ['Activity', 'Your assistant at work'],
    ['Routines', 'Routines'],
  ]) {
    await page.getByRole('button', { name: destination, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  const composer = page.getByRole('textbox', { name: 'Message', exact: true });
  await composer.fill('This draft stays available while I review ongoing work.');
  await expect(composer).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test('shows an actionable starting point when no routines exist', async ({ page }, testInfo) => {
  await openHome(page);
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
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
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Routines are not enabled yet' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New routine', exact: true })).toBeDisabled();
  await expect(page.getByText('Your first routine starts here', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
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
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
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
  await page.getByRole('button', { name: 'Routines', exact: true }).click();
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
    await expect
      .poll(
        async () => {
          const current = await request.get(`v2/runs/${encodeURIComponent(run.id)}`);
          expect(current.ok()).toBe(true);
          return ((await current.json()) as { status: string }).status;
        },
        { timeout: 20_000 },
      )
      .toBe('succeeded');
    const returned = await context.newPage();
    await returned.goto('./');
    await returned.getByRole('button', { name: 'Routines', exact: true }).click();
    await returned.getByRole('button', { name: `View result for ${name}`, exact: true }).click();
    const result = returned.getByRole('region', { name: 'Routine result', exact: true });
    await expect(result).toContainText('Debug Provider Output');
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
