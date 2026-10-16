import { expect, test } from '@playwright/test';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.env.TERM_LLM_MANAGER_SMOKE_URL;
const token = process.env.TERM_LLM_MANAGER_SMOKE_TOKEN;
const configRoot = process.env.TERM_LLM_MANAGER_SMOKE_CONFIG;

test.use({ video: 'off' });
test.skip(!root || !token || !configRoot, 'Run scripts/personal_bot_manager_smoke.sh');

test('provisions a private assistant and opens its persistent container workspace', async ({
  page,
}, testInfo) => {
  test.setTimeout(720_000);
  const name = `smoke-${testInfo.project.name}-${Date.now().toString(36)}`;
  const secret = 'sk-test-personal-bot-fixture-only';
  const purpose = 'Keep track of team research and turn it into clear next steps.';
  await page.goto(`${root}?token=${encodeURIComponent(token!)}`);
  await expect(
    page.getByRole('heading', { name: /Your assistants|A little help, always here\./ }),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('assistant-manager.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );

  await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
  const form = page.getByRole('form', { name: 'Create assistant' });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByLabel('Purpose', { exact: true }).fill(purpose);
  await form.getByRole('button', { name: 'Create assistant', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'AI connection', exact: true }).selectOption('openai');
  await page.getByLabel('API key', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(page.getByText(/API key saved privately/)).toBeVisible();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');

  const seed = join(configRoot!, 'containers', name, 'connection', 'term-llm');
  const configPath = join(seed, 'config.yaml');
  expect(await readFile(configPath, 'utf8')).toContain(secret);
  expect((await stat(configPath)).mode & 0o777).toBe(0o600);
  expect(await readFile(join(seed, 'agents', name, 'system.md'), 'utf8')).toContain(purpose);
  const connection = await page.request.get(`${root}api/assistants/${name}/connection`);
  expect(await connection.text()).not.toContain(secret);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(secret);

  // The fixture exercises real key persistence above, then starts a deterministic
  // runtime without contacting a provider or using anyone's credentials.
  await writeFile(
    configPath,
    'default_provider: debug\nprovider_discovery: config\nproviders:\n  debug:\n    model: fast\n',
    { mode: 0o600 },
  );
  await page.getByRole('button', { name: 'Start assistant', exact: true }).click();
  // Reload while Docker is building to prove provisioning belongs to the server.
  await page.reload();
  await page.getByRole('button', { name: `Manage ${name}`, exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open assistant', exact: true })).toBeVisible({
    timeout: 600_000,
  });
  await page.getByRole('link', { name: 'Open assistant', exact: true }).click();
  await expect(page.getByRole('heading', { name: /What can I take/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'All assistants', exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('container-assistant.png'), fullPage: true });
  const caps = await page.request.get(`${root}node/${name}/v1/capabilities`);
  expect(caps.ok()).toBe(true);
  expect((await caps.json()).jobs.enabled).toBe(true);

  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Message', exact: true })
    .fill('Keep this update for the team.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Debug Provider Output' }).last()).toBeVisible({
    timeout: 15_000,
  });
  const conversationURL = page.url();

  // Conversations live in the container's persistent home volume.
  await page.getByRole('link', { name: 'All assistants', exact: true }).click();
  await page.getByRole('button', { name: `Manage ${name}`, exact: true }).click();
  await page.getByRole('button', { name: 'Stop assistant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start assistant', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Start assistant', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Open assistant', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole('button', { name: 'Restart assistant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Restart assistant', exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await expect(page.getByRole('link', { name: 'Open assistant', exact: true })).toBeVisible({
    timeout: 60_000,
  });
  await page.goto(conversationURL);
  await expect(page.getByRole('heading', { name: 'Debug Provider Output' }).last()).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.locator('#messages').getByText('Keep this update for the team.', { exact: true }),
  ).toBeVisible();
});
