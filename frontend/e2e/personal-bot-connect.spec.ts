import { expect, test, type Page } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import { openDashboardNavigation } from './hub-navigation';
import { openPersonalBotSidebar, selectPersonalBotNavigation } from './personal-bot-navigation';

const root = process.env.TERM_LLM_MANAGER_SMOKE_URL;
const token = process.env.TERM_LLM_MANAGER_SMOKE_TOKEN;
const nodeRoot = process.env.TERM_LLM_CONNECT_SMOKE_NODE_URL;
const nodeToken = process.env.TERM_LLM_CONNECT_SMOKE_NODE_TOKEN;
const nodesFile = process.env.TERM_LLM_CONNECT_SMOKE_NODES_FILE;

test.use({ video: 'off' });
test.skip(
  !root || !token || !nodeRoot || !nodeToken || !nodesFile,
  'Run scripts/personal_bot_connect_smoke.sh',
);

async function chooseHubTheme(page: Page, theme: string): Promise<void> {
  await openDashboardNavigation(page);
  await page.getByRole('combobox', { name: 'Theme', exact: true }).selectOption(theme);
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', theme);
  const closeNavigation = page.getByRole('button', { name: 'Close navigation', exact: true });
  if (await closeNavigation.isVisible()) await closeNavigation.click();
}

test('connects a native assistant privately and preserves its independent theme through the Hub', async ({
  page,
}, testInfo) => {
  const name = `Native ${testInfo.project.name} ${Date.now().toString(36)}`;
  await page.goto(`${root}?token=${encodeURIComponent(token!)}`);
  await expect(page).toHaveTitle('Your agents - term-llm');
  await chooseHubTheme(page, 'nord');
  await expect(page.getByRole('button', { name: 'Create assistant', exact: true })).toHaveClass(
    /pbm-primary/,
  );
  await page.getByRole('button', { name: 'Connect an existing assistant', exact: true }).click();
  const form = page.getByRole('form', { name: 'Connect an existing assistant', exact: true });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('URL', { exact: true }).fill(nodeRoot!);
  const bearer = form.getByLabel(/^Bearer token/);
  await expect(bearer).toHaveAttribute('type', 'password');
  await bearer.fill('invalid-native-assistant-bearer');

  const probe = () =>
    page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/api/nodes/test') &&
        response.request().method() === 'POST',
    );
  const rejected = probe();
  await form.getByRole('button', { name: 'Test connection', exact: true }).click();
  const rejectedResponse = await rejected;
  expect(rejectedResponse.ok()).toBe(true);
  const rejectedBody = await rejectedResponse.text();
  expect(rejectedBody).not.toContain('invalid-native-assistant-bearer');
  expect(JSON.parse(rejectedBody).status.reachable).toBe(false);
  await expect(form.getByRole('alert')).toContainText(/not reachable/i);

  await bearer.fill(nodeToken!);
  const accepted = probe();
  await form.getByRole('button', { name: 'Test connection', exact: true }).click();
  const acceptedResponse = await accepted;
  expect(acceptedResponse.ok()).toBe(true);
  const acceptedBody = await acceptedResponse.text();
  expect(acceptedBody).not.toContain(nodeToken!);
  expect(JSON.parse(acceptedBody).status.reachable).toBe(true);
  await expect(form.getByRole('status')).toContainText(/reachable/i);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath('connect-native-assistant.png'),
    fullPage: true,
  });

  const saved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith('/api/nodes') &&
      response.request().method() === 'POST',
  );
  await form.getByRole('button', { name: 'Connect assistant', exact: true }).click();
  const savedResponse = await saved;
  expect(savedResponse.status()).toBe(201);
  const savedBody = await savedResponse.text();
  expect(savedBody).not.toContain(nodeToken!);
  const id = (JSON.parse(savedBody) as { id: string }).id;
  await expect(form).toBeHidden();
  // The agent inherits the choice at connection time, even if the Hub changes
  // before the agent is opened for the first time.
  await chooseHubTheme(page, 'dracula');

  const disk = JSON.parse(await readFile(nodesFile!, 'utf8')) as {
    nodes: { id: string; token: string }[];
  };
  expect(disk.nodes.find((node) => node.id === id)?.token).toBe(nodeToken);
  expect((await stat(nodesFile!)).mode & 0o777).toBe(0o600);

  const listing = await page.request.get(`${root}api/nodes`);
  expect(listing.ok()).toBe(true);
  const listedBody = await listing.text();
  expect(listedBody).not.toContain(nodeToken!);
  expect(JSON.parse(listedBody).nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ id, source: 'local', has_token: true })]),
  );
  expect(await page.locator('body').textContent()).not.toContain(nodeToken!);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
    ),
  ).not.toContain(nodeToken!);

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'dracula');
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: `Manage ${name}`, exact: true })).toHaveCount(0);
  await expect(
    card.getByRole('button', { name: /^(?:Start|Stop|Restart) assistant$/ }),
  ).toHaveCount(0);
  const open = card.getByRole('link', { name: `Open ${name}`, exact: true });
  await expect(open).toHaveAttribute('href', new URL(`node/${id}/`, root!).pathname);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('native-assistant-card.png'), fullPage: true });
  await open.focus();
  await open.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/node/${id}/`));
  await expect(page.getByRole('region', { name: 'Work overview', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'nord');
  await selectPersonalBotNavigation(page, 'Settings');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Interface', exact: true }).click();
  const agentTheme = settings.getByRole('combobox', { name: 'Theme', exact: true });
  await expect(agentTheme).toHaveValue('nord');
  await agentTheme.selectOption('tokyo-night');
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'tokyo-night');
  await settings.getByRole('button', { name: 'Close Settings', exact: true }).click();
  const capabilities = await page.request.get(`${root}node/${id}/v1/capabilities`);
  expect(capabilities.ok()).toBe(true);
  expect((await capabilities.json()).jobs.enabled).toBe(true);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Work overview', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'tokyo-night');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sidebar = await openPersonalBotSidebar(page);
  await sidebar.getByRole('link', { name: 'Your agents', exact: true }).click();
  await expect(open).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'dracula');
  await open.click();
  await expect(page.getByRole('region', { name: 'Work overview', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-personal-bot-theme', 'tokyo-night');
});

for (const catalog of ['saved', 'empty'] as const) {
  test(`keeps ChatGPT setup steady during a background refresh with a ${catalog} catalog`, async ({
    page,
  }, testInfo) => {
    const name = 'setup-layout-fixture';
    const apiPath = new URL('api/', root!).pathname;
    const connections =
      catalog === 'saved'
        ? [
            {
              id: 'team-account',
              name: 'Team ChatGPT',
              provider: 'chatgpt',
              source: 'server',
              available: true,
            },
          ]
        : [];
    let holdCatalog = false;
    let deferredCatalogRequests = 0;
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    await page.route(
      (url) => url.origin === new URL(root!).origin && url.pathname.startsWith(apiPath),
      async (route) => {
        const path = new URL(route.request().url()).pathname.slice(apiPath.length);
        const responses: Record<string, unknown> = {
          assistants: {
            assistants: [
              {
                name,
                purpose: 'Set up an AI connection without losing your place.',
                state: 'needs_connection',
                needs_connection: true,
                node_id: name,
                created_at: '2026-01-01T00:00:00Z',
                ready: false,
                ui_url: '',
              },
            ],
          },
          nodes: { nodes: [] },
          'assistants/environment': { available: true, can_build: false },
          'assistants/providers': {
            providers: [
              {
                id: 'chatgpt',
                name: 'ChatGPT',
                auth: 'device_code',
                default_model: 'chat-model',
                models: ['chat-model'],
              },
            ],
          },
          [`assistants/${name}/connection`]: {
            state: 'needs_connection',
            message: 'Connect an AI account to continue.',
          },
          'assistants/connections': { connections },
          'assistants/connection-sources': {
            sources: [
              {
                id: 'server-sign-in',
                name: 'Server ChatGPT sign-in',
                kind: 'server',
                available: true,
              },
            ],
          },
        };
        if (!(path in responses)) return route.continue();
        expect(route.request().method()).toBe('GET');
        if (
          holdCatalog &&
          ['assistants/connections', 'assistants/connection-sources'].includes(path)
        ) {
          deferredCatalogRequests++;
          await catalogGate;
        }
        await route.fulfill({ json: responses[path] });
      },
    );
    // Drive polling with the browser clock; the response gate holds the refresh open.
    await page.clock.install();
    await page.goto(`${root}?token=${encodeURIComponent(token!)}`);
    await page.getByRole('button', { name: `Manage ${name}`, exact: true }).click();
    const refresh = () => page.getByRole('button', { name: /^Refresh/, includeHidden: true });
    await expect(refresh()).toBeEnabled();
    const setup = page.getByRole('combobox', { name: 'ChatGPT setup', exact: true });
    await expect(setup).toHaveValue(catalog === 'saved' ? 'existing' : 'new');
    await setup.selectOption('import');
    const source = page.getByRole('combobox', { name: 'Saved sign-in', exact: true });
    await expect(source).toHaveValue('server-sign-in');
    const submit = page.getByRole('button', { name: 'Import and use connection', exact: true });
    await expect(submit).toBeEnabled();
    await setup.focus();
    const bounds = () => Promise.all([setup.boundingBox(), submit.boundingBox()]);
    const before = await bounds();
    for (const box of before) expect(box).not.toBeNull();
    const expectSteadySetup = async () => {
      await expect(setup).toBeFocused();
      await expect(setup).toHaveValue('import');
      await expect(source).toHaveValue('server-sign-in');
      await expect(submit).toBeEnabled();
      await expect(page.getByText('Checking saved connections…', { exact: true })).toHaveCount(0);
      const after = await bounds();
      for (let index = 0; index < after.length; index++) {
        expect(after[index]).not.toBeNull();
        for (const dimension of ['x', 'y', 'width', 'height'] as const) {
          expect(after[index]![dimension]).toBeCloseTo(before[index]![dimension], 1);
        }
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    };
    holdCatalog = true;
    try {
      await page.clock.runFor(15_000);
      await expect.poll(() => deferredCatalogRequests).toBe(2);
      await expectSteadySetup();
      releaseCatalog();
      await expect(refresh()).toBeEnabled();
      await expectSteadySetup();
      await page.screenshot({
        path: testInfo.outputPath(`chatgpt-setup-refresh-${catalog}.png`),
        fullPage: true,
      });
    } finally {
      releaseCatalog();
    }
  });
}
