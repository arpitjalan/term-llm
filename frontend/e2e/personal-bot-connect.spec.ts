import { expect, test } from '@playwright/test';
import { readFile, stat } from 'node:fs/promises';
import { openPersonalBotSidebar } from './personal-bot-navigation';

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

test('connects a native assistant privately and reopens it through the Hub', async ({
  page,
}, testInfo) => {
  const name = `Native ${testInfo.project.name} ${Date.now().toString(36)}`;
  await page.goto(`${root}?token=${encodeURIComponent(token!)}`);
  await expect(page).toHaveTitle('Your agents - term-llm');
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
  const capabilities = await page.request.get(`${root}node/${id}/v1/capabilities`);
  expect(capabilities.ok()).toBe(true);
  expect((await capabilities.json()).jobs.enabled).toBe(true);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Work overview', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const sidebar = await openPersonalBotSidebar(page);
  await sidebar.getByRole('link', { name: 'Your agents', exact: true }).click();
  await expect(open).toBeVisible();
});
