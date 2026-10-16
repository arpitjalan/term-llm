import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

test.use({ video: 'off' });

function stylesheet(path: string): string {
  return readFileSync(path, 'utf8').replace(
    /@import\s+['"]([^'"]+)['"];/g,
    (_, specifier: string) => stylesheet(resolve(dirname(path), specifier)),
  );
}

const css = stylesheet(resolve(import.meta.dirname, '../src/styles/app.css'));
if (/@import\b/.test(css)) throw new Error('Unsupported CSS import in browser style fixture');

const managerCSS = [
  'hub/styles/hub.css',
  'hub/styles/personal-bot-manager.css',
  'theme/personal-bot-theme.css',
  'theme/theme-picker.css',
  'components/select-control.css',
  'components/pending-label.css',
]
  .map((path) => stylesheet(resolve(import.meta.dirname, '../src', path)))
  .join('\n');

const personalBotCSS = [
  'personal-bot/personal-bot.css',
  'personal-bot/routines.css',
  'theme/personal-bot-theme.css',
  'components/select-control.css',
]
  .map((path) => stylesheet(resolve(import.meta.dirname, '../src', path)))
  .join('\n');

test('nested errors keep the same spacing as neighboring form rows', async ({ page }) => {
  for (const [surface, error, gap] of [
    ['pbm-form', 'pbm-error', 20],
    ['pbm-connection', 'pbm-error', 20],
    ['pbm-details', 'pbm-error', 20],
    ['pb-routine-form', 'pb-error', 18],
    ['pb-routines', 'pb-error', 24],
  ] as const) {
    await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><div class="pbm-app"><div class="${surface}">
      <div>Before the error</div>
      <div class="${error}" role="alert">The connection could not be saved.</div>
      <div>Next field</div>
    </div></div>`);
    await page.addStyleTag({ content: managerCSS + personalBotCSS });
    const spacing = await page.locator(`.${surface}`).evaluate((element) => {
      const [before, error, after] = [...element.children].map((child) =>
        child.getBoundingClientRect(),
      );
      return { above: error.top - before.bottom, below: after.top - error.bottom };
    });
    expect(spacing.above, surface).toBeCloseTo(gap, 0);
    expect(spacing.below, surface).toBeCloseTo(gap, 0);
  }
});

test('manager header controls keep clear labels and aligned spacing at every width', async ({
  page,
}) => {
  for (const security of [false, true]) {
    await page.setContent(`<html data-personal-bot-theme="catppuccin"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
      <div class="pbm-app"><header class="pbm-header">
        <a class="pbm-brand" href="#"><svg class="pbm-brand-mark" aria-hidden="true"></svg><strong>Your agents<small>A little help, always here.</small></strong></a>
        <div class="pbm-actions">
          <div class="pb-theme-picker pb-theme-picker--compact">
            <label for="header-theme">Theme</label>
            <span class="control-select">
              <select id="header-theme"><option>Catppuccin Mocha</option></select>
              <svg class="control-select-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
            </span>
          </div>
          ${security ? '<a class="pbm-button" href="#">Security</a>' : ''}
          <button class="pbm-button" disabled>Refreshing…</button>
        </div>
      </header></div>
    </body></html>`);
    await page.addStyleTag({ content: managerCSS });
    await expect(page.getByRole('combobox', { name: 'Theme' })).toHaveCSS('appearance', 'none');
    for (const width of [320, 390, 620, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await page.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>('#header-theme')!;
        const arrow = document.querySelector('.control-select-chevron')!.getBoundingClientRect();
        const box = select.getBoundingClientRect();
        const styles = getComputedStyle(select);
        const canvas = document.createElement('canvas').getContext('2d')!;
        canvas.font = styles.font;
        const textEnd =
          box.left +
          parseFloat(styles.borderLeftWidth) +
          parseFloat(styles.paddingLeft) +
          canvas.measureText(select.selectedOptions[0].text).width;
        const header = document.querySelector('.pbm-header')!.getBoundingClientRect();
        const controls = [...document.querySelectorAll('.pbm-actions select, .pbm-button')].map(
          (control) => {
            const rect = control.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          },
        );
        return {
          labelClearance: arrow.left - textEnd,
          arrowInset: box.right - arrow.right,
          arrowOffset: Math.abs((arrow.top + arrow.bottom - box.top - box.bottom) / 2),
          selectHeight: box.height,
          controls,
          header: { left: header.left, right: header.right, bottom: header.bottom },
          overflow: document.documentElement.scrollWidth - innerWidth,
        };
      });
      const context = `${width}px, security ${security}`;
      expect(layout.labelClearance, context).toBeGreaterThanOrEqual(8);
      expect(layout.arrowInset, context).toBeGreaterThanOrEqual(12);
      expect(layout.arrowOffset, context).toBeLessThanOrEqual(1);
      expect(layout.overflow, context).toBeLessThanOrEqual(1);
      if (!security) {
        expect(layout.controls[0].top, context).toBe(layout.controls[1].top);
      }
      for (const [index, control] of layout.controls.entries()) {
        expect(control.bottom - control.top, context).toBeCloseTo(layout.selectHeight, 0);
        expect(control.left, context).toBeGreaterThanOrEqual(layout.header.left);
        expect(control.right, context).toBeLessThanOrEqual(layout.header.right);
        expect(control.bottom, context).toBeLessThanOrEqual(layout.header.bottom);
        for (const other of layout.controls.slice(index + 1)) {
          if (control.top < other.bottom && other.top < control.bottom) {
            expect(other.left - control.right, context).toBeGreaterThanOrEqual(8);
          }
        }
      }
    }
  }
});

test('manager, routine and settings dropdowns reserve space for the arrow and long choices', async ({
  page,
}) => {
  const fields = [
    ['AI connection', 'ChatGPT'],
    ['Model', 'GPT-6 · recommended'],
    ['Saved sign-in', 'A saved connection with a long descriptive account name'],
    ['Workspace', 'A workspace with a long descriptive project name'],
    ['Schedule', 'Every day'],
  ];
  for (const [surface, styles, selectClass] of [
    ['pbm-panel pbm-form', managerCSS, ''],
    ['pb-panel pb-routine-form', css + personalBotCSS, ''],
    [
      'settings-field',
      css + stylesheet(resolve(import.meta.dirname, '../src/components/select-control.css')),
      'settings-select',
    ],
  ]) {
    await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><main class="pbm-main"><section class="${surface}">
      ${fields
        .map(
          ([label, choice], index) => `<label class="pb-field">${label}
          <span class="control-select">
            <select class="${selectClass}" ${index === 2 ? 'disabled' : ''}><option>${choice}</option><option>Another choice</option></select>
            <svg class="control-select-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
          </span>
        </label>`,
        )
        .join('')}
    </section></main>`);
    await page.addStyleTag({ content: styles });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [label] of fields) {
        const select = page.getByRole('combobox', { name: label, exact: true });
        await expect(select).toHaveCSS('appearance', 'none');
        const layout = await select.evaluate((select) => {
          const box = select.getBoundingClientRect();
          const arrow = select.nextElementSibling!.getBoundingClientRect();
          const styles = getComputedStyle(select);
          return {
            arrowInset: box.right - arrow.right,
            labelClearance: arrow.left - (box.right - parseFloat(styles.paddingRight)),
            arrowOffset: Math.abs((arrow.top + arrow.bottom - box.top - box.bottom) / 2),
            left: box.left,
            right: box.right,
          };
        });
        const context = `${width}px, ${surface}, ${label}`;
        expect(layout.arrowInset, context).toBeGreaterThanOrEqual(12);
        expect(layout.labelClearance, context).toBeGreaterThanOrEqual(8);
        expect(layout.arrowOffset, context).toBeLessThanOrEqual(1);
        expect(layout.left, context).toBeGreaterThanOrEqual(0);
        expect(layout.right, context).toBeLessThanOrEqual(width);
      }
      const schedule = page.getByRole('combobox', { name: 'Schedule', exact: true });
      await schedule.selectOption({ label: 'Another choice' });
      await expect(schedule).toHaveValue('Another choice');
    }
  }
});

test('loading labels keep buttons and neighboring content in place', async ({ page }) => {
  for (const [idle, busy] of [
    ['Refresh', 'Refreshing…'],
    ['Use connection', 'Connecting…'],
    ['Connect ChatGPT', 'Connecting…'],
    ['Import and use connection', 'Connecting…'],
    ['Save connection', 'Connecting…'],
  ]) {
    await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><div class="pbm-app"><main class="pbm-main">
      <section class="pbm-panel pbm-form">
        <label>Model<input value="GPT-6" /></label>
        <button class="pbm-button"><span class="pending-label"><span aria-hidden="false">${idle}</span><span aria-hidden="true">${busy}</span></span></button>
        <p>Keep this server running.</p>
      </section>
    </main></div>`);
    await page.addStyleTag({ content: managerCSS });
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const button = page.getByRole('button');
      await button.locator('.pending-label > span').evaluateAll((spans) => {
        spans[0].setAttribute('aria-hidden', 'false');
        spans[1].setAttribute('aria-hidden', 'true');
      });
      await expect(button).toHaveAccessibleName(idle);
      const idleBox = await button.boundingBox();
      const note = page.getByText('Keep this server running.', { exact: true });
      const idleNoteBox = await note.boundingBox();
      await button.evaluate((button: HTMLButtonElement) => {
        button.disabled = true;
        const spans = button.querySelectorAll('.pending-label > span');
        spans[0].setAttribute('aria-hidden', 'true');
        spans[1].setAttribute('aria-hidden', 'false');
      });
      await expect(button).toHaveAccessibleName(busy);
      const busyBox = await button.boundingBox();
      const context = `${width}px, ${idle}`;
      expect(busyBox, context).toEqual(idleBox);
      expect(await note.boundingBox(), context).toEqual(idleNoteBox);
      expect(busyBox!.x + busyBox!.width, context).toBeLessThanOrEqual(width);
    }
  }
});

test('phone navigation and nearby actions share a comfortable control height', async ({ page }) => {
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><div class="personal-bot"><aside class="pb-sidebar">
    <button class="pb-brand"><svg class="pb-brand-mark" aria-hidden="true"></svg><span class="pb-brand-copy"><span class="pb-brand-name">Your assistant</span><span class="pb-brand-caption">A little help, always here.</span></span></button>
    <button class="pb-button pb-new-chat"><svg aria-hidden="true"></svg>New conversation</button>
    <nav class="pb-nav" aria-label="Main navigation">
      ${['Home', 'Activity', 'Routines'].map((label) => `<button><svg aria-hidden="true"></svg><span>${label}</span></button>`).join('')}
    </nav>
    <div class="pb-mobile-tools">
      <button class="pb-text-button">All conversations</button>
      <a class="pb-settings" href="#" aria-label="Your agents"><svg aria-hidden="true"></svg></a>
      <button class="pb-settings" aria-label="Settings"><svg aria-hidden="true"></svg></button>
    </div>
  </aside><main class="pb-main"></main></div>`);
  await page.addStyleTag({ content: css + personalBotCSS });
  for (const width of [320, 390, 767]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page
      .locator('.pb-new-chat, .pb-nav button, .pb-mobile-tools > *')
      .evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return {
            label: element.getAttribute('aria-label') || element.textContent,
            height: box.height,
            left: box.left,
            right: box.right,
          };
        }),
      );
    for (const control of layout) {
      const context = `${width}px, ${control.label}`;
      expect(control.height, context).toBeCloseTo(44, 0);
      expect(control.left, context).toBeGreaterThanOrEqual(0);
      expect(control.right, context).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      `${width}px`,
    ).toBeLessThanOrEqual(1);
  }
});

test('diff layout retains grid rows, line markers and comment placement', async ({ page }) => {
  await page.setContent(`<div class="diff-file-body">
    <div class="diff-row add"><span class="diff-ln">1</span><span class="diff-ln">2</span><span class="diff-code">added</span><button class="diff-comment-affordance">+</button></div>
    <div class="diff-row del"><span class="diff-code">deleted</span></div>
    <div class="diff-row hunk"><span class="diff-ln">1</span><span class="diff-ln">2</span><span class="diff-code">hunk</span></div>
    <div class="diff-comment-panel">Comment</div>
  </div>`);
  await page.addStyleTag({ content: css });
  const styles = await page.evaluate(() => {
    const style = (selector: string, pseudo?: string) =>
      getComputedStyle(document.querySelector(selector)!, pseudo);
    return {
      rowDisplay: style('.diff-row').display,
      rowAlign: style('.diff-row').alignItems,
      rowWhitespace: style('.diff-row').whiteSpace,
      codeOrder: style('.diff-code').order,
      addMarker: style('.add .diff-code', '::before').content,
      deleteMarker: style('.del .diff-code', '::before').content,
      hunkSecondNumber: style('.hunk .diff-ln:nth-child(2)').display,
      commentColumn: style('.diff-comment-panel').gridColumn,
      commentWhitespace: style('.diff-comment-panel').whiteSpace,
    };
  });
  expect(styles).toEqual({
    rowDisplay: 'grid',
    rowAlign: 'stretch',
    rowWhitespace: 'pre-wrap',
    codeOrder: '0',
    addMarker: '"+"',
    deleteMarker: '"−"',
    hunkSecondNumber: 'none',
    commentColumn: '3 / -1',
    commentWhitespace: 'normal',
  });
});

test('MCP, widget and project labels retain ellipsis clipping', async ({ page }) => {
  const classes = [
    'mcp-row-name',
    'mcp-row-meta',
    'widget-card-name',
    'widget-card-meta',
    'widget-card-error',
    'project-choice-name',
    'project-choice-path',
  ];
  await page.setContent(classes.map((name) => `<div class="${name}">Long label</div>`).join(''));
  await page.addStyleTag({ content: css });
  // The MCP modal loads its stylesheet separately from the main app stylesheet.
  await page.addStyleTag({
    content: stylesheet(resolve(import.meta.dirname, '../src/styles/features/mcp.css')),
  });
  for (const name of classes) {
    await expect(page.locator(`.${name}`)).toHaveCSS('overflow', 'hidden');
    await expect(page.locator(`.${name}`)).toHaveCSS('text-overflow', 'ellipsis');
    await expect(page.locator(`.${name}`)).toHaveCSS('white-space', 'nowrap');
  }
});
