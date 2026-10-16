import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { execFile, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const root = process.env.TERM_LLM_MANAGER_SMOKE_URL;
const token = process.env.TERM_LLM_MANAGER_SMOKE_TOKEN;
const configRoot = process.env.TERM_LLM_MANAGER_SMOKE_CONFIG;
const exec = promisify(execFile);
const debugConfig =
  'default_provider: debug\nprovider_discovery: config\nproviders:\n  debug:\n    model: fast\n';
test.use({ video: 'off', actionTimeout: 30_000 });
test.skip(!root || !token || !configRoot, 'Run scripts/personal_bot_manager_smoke.sh');

async function post(api: APIRequestContext, path: string, data: unknown) {
  const response = await api.post(`${root}api/assistants/${path}`, { data });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return response.json();
}

async function ready(api: APIRequestContext, name: string) {
  await expect
    .poll(
      async () => {
        const response = await api.get(`${root}api/assistants/${name}`);
        return response.ok() && (await response.json()).ready;
      },
      { timeout: 600_000 },
    )
    .toBe(true);
}

async function createInBrowser(page: Page, name: string) {
  await page.goto(root!);
  await page.getByRole('button', { name: 'Create assistant', exact: true }).click();
  const form = page.getByRole('form', { name: 'Create assistant' });
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form
    .getByLabel('Purpose', { exact: true })
    .fill('Help with this isolated connection test.');
  await form.getByRole('button', { name: 'Create assistant', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'AI connection', exact: true }).selectOption('chatgpt');
}

async function authStatus(name: string) {
  const { stdout } = await exec(
    'docker',
    [
      'exec',
      '-e',
      'TERM_LLM_CHATGPT_CONNECTION_FILE=/home/agent/.config/term-llm/chatgpt_connection.json',
      `term-llm-contain-${name}-assistant-1`,
      '/usr/local/bin/term-llm',
      'auth',
      'status',
    ],
    { timeout: 90_000 },
  );
  return stdout;
}

async function replaceSourceCredential(name: string, payload: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        '--user',
        '1000:1000',
        `term-llm-contain-${name}-assistant-1`,
        '/bin/sh',
        '-c',
        'umask 077; cat > /home/agent/.config/term-llm/chatgpt_oauth.json',
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Could not update fixture credentials')),
    );
    child.stdin.end(payload);
  });
}

test('imports one source connection for two assistants and survives Hub reload', async ({
  page,
}, testInfo) => {
  test.setTimeout(720_000);
  const suffix = `${testInfo.project.name}-${Date.now().toString(36)}`;
  const sourceName = `smoke-source-${suffix}`;
  const names = [`smoke-one-${suffix}`, `smoke-two-${suffix}`];
  const fixtureCredentials = (account: string) =>
    JSON.stringify({
      access_token: 'fixture-access-not-a-real-token',
      refresh_token: 'fixture-refresh-never-copy',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      account_id: account,
    });
  await page.goto(`${root}?token=${encodeURIComponent(token!)}`);
  const sourceOp = await page.request.post(`${root}api/assistants`, {
    data: { name: sourceName, purpose: 'Existing source fixture' },
  });
  expect(sourceOp.ok()).toBe(true);
  await expect
    .poll(async () => (await page.request.get(`${root}api/assistants/${sourceName}`)).status())
    .toBe(200);
  await post(page.request, `${sourceName}/connection`, {
    provider: 'openai',
    api_key: 'synthetic-source-api-key',
  });
  const sourceSeed = join(configRoot!, 'containers', sourceName, 'connection', 'term-llm');
  await writeFile(join(sourceSeed, 'config.yaml'), debugConfig, { mode: 0o600 });
  await writeFile(join(sourceSeed, 'chatgpt_oauth.json'), fixtureCredentials('source-account'), {
    mode: 0o600,
  });
  await post(page.request, `${sourceName}/start`, {});
  await ready(page.request, sourceName);

  // Server import references a private fixture store and never moves it.
  const hostPath = join(configRoot!, 'chatgpt_oauth.json');
  const hostCredentials = fixtureCredentials('host-account');
  await writeFile(hostPath, hostCredentials, { mode: 0o600 });
  const sources = await (await page.request.get(`${root}api/assistants/connection-sources`)).json();
  const serverSource = sources.sources.find((item: { kind: string }) => item.kind === 'server');
  expect(serverSource?.available).toBe(true);
  await post(page.request, 'connections/import', {
    source_id: serverSource.id,
    name: `Host ${suffix}`,
  });
  expect(await readFile(hostPath, 'utf8')).toBe(hostCredentials);
  const source = sources.sources.find((item: { name: string }) => item.name.includes(sourceName));
  expect(source?.available).toBe(true);

  await createInBrowser(page, names[0]);
  await page.getByRole('combobox', { name: 'ChatGPT setup', exact: true }).selectOption('import');
  await page.getByRole('combobox', { name: 'Saved sign-in', exact: true }).selectOption(source.id);
  await page.getByRole('button', { name: 'Import and use connection', exact: true }).click();
  await expect(page.getByText(/^Using /)).toBeVisible({ timeout: 120_000 });
  const assignment = await (
    await page.request.get(`${root}api/assistants/${names[0]}/connection`)
  ).json();
  expect(assignment.connection_id).toBeTruthy();
  await page.screenshot({
    path: testInfo.outputPath('reusable-chatgpt-connection.png'),
    fullPage: true,
  });

  await createInBrowser(page, names[1]);
  await page.getByRole('combobox', { name: 'ChatGPT setup', exact: true }).selectOption('existing');
  await page
    .getByRole('combobox', { name: 'Saved connection', exact: true })
    .selectOption(assignment.connection_id);
  await page.getByRole('button', { name: 'Use connection', exact: true }).click();
  await expect(page.getByText(/^Using /)).toBeVisible();

  for (const name of names) {
    const seed = join(configRoot!, 'containers', name, 'connection', 'term-llm');
    const bridge = await readFile(join(seed, 'chatgpt_connection.json'), 'utf8');
    expect(bridge).not.toContain('fixture-refresh-never-copy');
    expect(bridge).not.toContain('fixture-access-not-a-real-token');
    await expect(readFile(join(seed, 'chatgpt_oauth.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // Chat stays on the debug provider; auth status alone exercises the real
    // worker -> TLS broker -> source-volume helper without contacting a model.
    await writeFile(join(seed, 'config.yaml'), debugConfig, { mode: 0o600 });
    await post(page.request, `${name}/start`, {});
    await ready(page.request, name);
    expect(await authStatus(name)).toContain('source-account');
  }
  await replaceSourceCredential(sourceName, fixtureCredentials('updated-source-account'));
  for (const name of names) expect(await authStatus(name)).toContain('updated-source-account');
  await post(page.request, `${sourceName}/stop`, {});
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`${root}api/assistants/${sourceName}`)).json()).state,
    )
    .toBe('stopped');
  for (const name of names) expect(await authStatus(name)).toContain('updated-source-account');

  // Changing the source assistant's provider must not erase the shared login
  // from its runtime home when the new connection seed is applied.
  await post(page.request, `${sourceName}/connection`, {
    provider: 'openai',
    api_key: 'synthetic-replacement-api-key',
  });
  await writeFile(join(sourceSeed, 'config.yaml'), debugConfig, { mode: 0o600 });
  await post(page.request, `${sourceName}/start`, {});
  await ready(page.request, sourceName);
  for (const name of names) expect(await authStatus(name)).toContain('updated-source-account');

  const hubPID = Number(process.env.TERM_LLM_MANAGER_SMOKE_PID);
  expect(hubPID).toBeGreaterThan(0);
  process.kill(hubPID, 'SIGUSR2');
  await expect
    .poll(
      async () => {
        try {
          return (await authStatus(names[0])).includes('updated-source-account');
        } catch {
          return false;
        }
      },
      { timeout: 90_000 },
    )
    .toBe(true);
  await page.reload();
  await page.getByRole('button', { name: `Manage ${names[1]}`, exact: true }).click();
  await expect(page.getByText(/^Using /)).toBeVisible();
  expect(await authStatus(names[1])).toContain('updated-source-account');
});
