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
  'hub/styles/dashboard-layout.css',
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

test('manager sidebar keeps folded content visible and unfolds into a persistent rail', async ({
  page,
}) => {
  await page.setContent(`<html data-personal-bot-theme="catppuccin"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
    <div class="dashboard-layout pbm-app">
      <header class="dashboard-header hub-header"><button class="hub-btn ghost dashboard-menu-button">☰</button><span>Your agents</span></header>
      <div class="dashboard-content"><main class="pbm-main"><section class="pbm-panel">Your agents go here</section></main></div>
      <aside class="dashboard-sidebar">
        <div class="dashboard-sidebar-heading"><a class="pbm-brand" href="#"><svg class="pbm-brand-mark" aria-hidden="true"></svg><strong>Your agents</strong></a><button class="hub-btn ghost dashboard-menu-button">×</button></div>
        <nav class="dashboard-sidebar-controls">
          <div class="pb-theme-picker pb-theme-picker--compact">
            <label for="sidebar-theme">Theme</label>
            <span class="control-select"><select id="sidebar-theme"><option>Catppuccin Mocha</option></select>
              <svg class="control-select-chevron" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" /></svg>
            </span>
          </div>
          <a class="pbm-button" href="#">Security</a><button class="pbm-button" disabled>Refreshing…</button>
        </nav>
      </aside>
    </div>
  </body></html>`);
  await page.addStyleTag({ content: managerCSS });
  for (const width of [320, 390, 620, 768, 799, 800, 820, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const folded = width < 800;
    await page.locator('.dashboard-sidebar').evaluate((aside, hidden) => {
      (aside as HTMLElement).hidden = hidden;
      aside.querySelector<HTMLButtonElement>('.dashboard-menu-button')!.hidden = !hidden;
    }, folded);
    const content = await page.locator('.dashboard-content').boundingBox();
    if (folded) {
      await expect(page.locator('.dashboard-sidebar')).toBeHidden();
      expect((await page.locator('.dashboard-header').boundingBox())!.height).toBe(48);
      expect(content!.y).toBe(48);
      expect(content!.x).toBe(0);
      await page.locator('.dashboard-sidebar').evaluate((aside) => {
        (aside as HTMLElement).hidden = false;
      });
    } else {
      await expect(page.locator('.dashboard-header')).toBeHidden();
      expect(content!.y).toBe(0);
      expect(content!.x).toBe(224);
    }
    const layout = await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('#sidebar-theme')!;
      const arrow = document.querySelector('.control-select-chevron')!.getBoundingClientRect();
      const box = select.getBoundingClientRect();
      const styles = getComputedStyle(select);
      const canvas = document.createElement('canvas').getContext('2d')!;
      canvas.font = styles.font;
      const textEnd =
        box.left +
        parseFloat(styles.paddingLeft) +
        canvas.measureText(select.selectedOptions[0].text).width;
      const sidebar = document.querySelector('.dashboard-sidebar')!.getBoundingClientRect();
      const controls = [...document.querySelectorAll('.dashboard-sidebar select, .pbm-button')].map(
        (element) => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        },
      );
      return {
        labelClearance: arrow.left - textEnd,
        arrowInset: box.right - arrow.right,
        arrowOffset: Math.abs((arrow.top + arrow.bottom - box.top - box.bottom) / 2),
        controls,
        sidebar: { left: sidebar.left, right: sidebar.right, bottom: sidebar.bottom },
        overflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    const context = `${width}px`;
    expect(layout.labelClearance, context).toBeGreaterThanOrEqual(8);
    expect(layout.arrowInset, context).toBeGreaterThanOrEqual(12);
    expect(layout.arrowOffset, context).toBeLessThanOrEqual(1);
    expect(layout.overflow, context).toBeLessThanOrEqual(1);
    for (const [index, control] of layout.controls.entries()) {
      expect(control.bottom - control.top, context).toBeGreaterThanOrEqual(42);
      expect(control.left, context).toBeGreaterThanOrEqual(layout.sidebar.left);
      expect(control.right, context).toBeLessThanOrEqual(layout.sidebar.right);
      expect(control.bottom, context).toBeLessThanOrEqual(layout.sidebar.bottom);
      for (const other of layout.controls.slice(index + 1))
        expect(other.top - control.bottom, context).toBeGreaterThanOrEqual(12);
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

test('phone header stays compact while sidebar actions keep comfortable touch targets', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><div class="personal-bot">
    <header class="pb-mobile-header">
      <button class="pb-menu-button" aria-label="Open sidebar"><svg aria-hidden="true"></svg></button>
      <div class="pb-brand"><svg class="pb-brand-mark" aria-hidden="true"></svg><span class="pb-brand-name" title="Sammy">Sammy</span></div>
    </header>
    <main class="pb-main"></main>
    <div class="drawer-backdrop drawer-backdrop-left" style="display: none">
      <div class="drawer drawer-left pb-sidebar pb-sidebar-drawer">
        <div class="pb-sidebar-heading">
          <button class="pb-brand" aria-label="Sammy home"><svg class="pb-brand-mark" aria-hidden="true"></svg><span class="pb-brand-name" title="Sammy">Sammy</span></button>
          <button class="pb-menu-button" aria-label="Close sidebar"><svg aria-hidden="true"></svg></button>
        </div>
        <button class="pb-button pb-new-chat"><svg aria-hidden="true"></svg>New conversation</button>
        <nav class="pb-nav" aria-label="Main navigation">
          ${['Home', 'Activity', 'Conversations', 'Routines', 'Widgets'].map((label) => `<button><svg aria-hidden="true"></svg><span>${label}</span></button>`).join('')}
        </nav>
        <div class="pb-recents"><p class="pb-eyebrow">Recent conversations</p><button>Recent task</button></div>
        <div class="pb-sidebar-footer">
          <a class="pb-settings" href="#"><svg aria-hidden="true"></svg>Your agents</a>
          <button class="pb-settings"><svg aria-hidden="true"></svg>Settings</button>
        </div>
      </div>
    </div>
  </div>`);
  await page.addStyleTag({ content: css + personalBotCSS });
  for (const width of [320, 390, 767]) {
    await page.setViewportSize({ width, height: 900 });
    const header = page.locator('.pb-mobile-header');
    const headerBox = await header.boundingBox();
    expect(headerBox!.height, `${width}px header`).toBeLessThan(90);
    await expect(header.getByRole('button')).toHaveCount(1);
    await page.locator('.drawer-backdrop').evaluate((element) => {
      (element as HTMLElement).style.display = '';
    });
    const layout = await page
      .locator(
        '.pb-menu-button, button.pb-brand, .pb-new-chat, .pb-nav button, .pb-recents button, .pb-sidebar-footer > *',
      )
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
      expect(control.height, context).toBeGreaterThanOrEqual(44);
      expect(control.left, context).toBeGreaterThanOrEqual(0);
      expect(control.right, context).toBeLessThanOrEqual(width);
    }
    const buttons = await page.locator('.pb-nav button').evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { left: box.left, top: box.top, bottom: box.bottom };
      }),
    );
    for (let index = 1; index < buttons.length; index++) {
      expect(buttons[index].left, `${width}px vertical navigation`).toBe(buttons[0].left);
      expect(buttons[index].top, `${width}px vertical navigation`).toBeGreaterThanOrEqual(
        buttons[index - 1].bottom,
      );
    }
    for (const name of ['Sammy', 'An assistant with a very long custom name '.repeat(3)]) {
      await page.locator('.pb-brand-name').evaluateAll((elements, name) => {
        for (const element of elements) {
          element.textContent = name;
          element.setAttribute('title', name);
        }
      }, name);
      const brands = await page.locator('.pb-brand-name').evaluateAll((elements) =>
        elements.map((element) => {
          const name = element.getBoundingClientRect();
          const parent = element.parentElement!.getBoundingClientRect();
          return {
            nameRight: name.right,
            parentRight: parent.right,
            clipped: element.scrollWidth > element.clientWidth,
            overflow: getComputedStyle(element).textOverflow,
          };
        }),
      );
      for (const brand of brands) {
        const context = `${width}px, ${name}`;
        expect(brand.nameRight, context).toBeLessThanOrEqual(brand.parentRight + 1);
        expect(brand.parentRight, context).toBeLessThanOrEqual(width + 1);
        expect(brand.clipped, context).toBe(name !== 'Sammy');
        expect(brand.overflow, context).toBe('ellipsis');
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - innerWidth),
      `${width}px`,
    ).toBeLessThanOrEqual(1);
    await page.locator('.drawer-backdrop').evaluate((element) => {
      (element as HTMLElement).style.display = 'none';
    });
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

test('composer status strips keep clearance above the input', async ({ page }) => {
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><footer class="composer"><div class="composer-inner">
    <button class="interaction-attention-banner">Decision waiting — Open</button>
    <div class="attachments"><div class="attachment-chip">notes.txt</div></div>
    <button class="approval-mode-chip">Approvals · Prompt for this chat</button>
    <button class="goal-chip">Goal · active · Review the interface</button>
    <div class="composer-box"><textarea class="prompt" rows="1" aria-label="Message"></textarea></div>
  </div></footer>`);
  await page.addStyleTag({ content: css });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const clearances = await page.locator('.composer-inner').evaluate((element) => {
      const boxes = [...element.children].map((child) => child.getBoundingClientRect());
      return boxes.slice(1).map((box, index) => box.top - boxes[index].bottom);
    });
    for (const clearance of clearances) expect(clearance, `${width}px`).toBeGreaterThanOrEqual(7);
  }
});

test('composer buttons align with the last input line at every size', async ({ page }) => {
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><footer class="composer"><div class="composer-inner"><div class="composer-box">
    <button class="composer-icon-btn attach-btn" aria-label="Add">+</button>
    <textarea class="prompt" rows="1" aria-label="Message"></textarea>
    <div class="composer-actions"><button class="stop-btn visible">Stop</button><button class="composer-icon-btn voice-btn" aria-label="Record">●</button><button class="send-btn" aria-label="Send">↑</button></div>
  </div></div></footer>`);
  await page.addStyleTag({ content: css });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const value of ['Hi', 'A longer\nmessage\nwith lines']) {
      await page.getByRole('textbox', { name: 'Message' }).fill(value);
      const layout = await page.locator('.composer-box').evaluate((element) => {
        const prompt = element.querySelector('textarea')!;
        const input = prompt.getBoundingClientRect();
        const style = getComputedStyle(prompt);
        const lastLineCenter =
          input.bottom - parseFloat(style.paddingBottom) - parseFloat(style.lineHeight) / 2;
        const box = element.getBoundingClientRect();
        return {
          inputWidth: input.width,
          controls: [...element.querySelectorAll('button')].map((button) => {
            const rect = button.getBoundingClientRect();
            return {
              offset: Math.abs(rect.top + rect.height / 2 - lastLineCenter),
              inside: rect.left >= box.left && rect.right <= box.right,
            };
          }),
        };
      });
      expect(layout.inputWidth, `${width}px`).toBeGreaterThan(0);
      for (const control of layout.controls) {
        expect(control.offset, `${width}px, ${value}`).toBeLessThanOrEqual(1);
        expect(control.inside, `${width}px`).toBe(true);
      }
    }
  }
});

test('routine titles and page actions stay inside narrow content columns', async ({ page }) => {
  await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><div class="personal-bot">
    <aside class="pb-sidebar"></aside><main class="pb-main"><div class="pb-page-scroll"><div class="pb-routines">
      <header class="pb-routine-heading"><div><h1>Routines</h1><p>Small things, handled on schedule.</p></div><button class="pb-button">New routine</button></header>
      <div class="pb-routine-list">${[1, 2]
        .map(
          (index) =>
            `<article class="pb-panel pb-routine-card"><div class="pb-routine-heading"><h2>WeeklyPlanning${'AndResearch'.repeat(8)}${index}</h2><span class="pb-routine-status">Schedule finished</span></div><p class="pb-routine-schedule">Every weekday</p><div class="pb-routine-actions"><button class="pb-button">History</button><button class="pb-button">Delete</button></div></article>`,
        )
        .join('')}</div>
      <header class="pb-page-heading"><div><h1>Your widgets</h1><p>Small tools that make your day easier.</p></div><button class="pb-button">Refresh widgets</button></header>
    </div></div></main>
  </div>`);
  await page.addStyleTag({ content: css + personalBotCSS });
  for (const width of [320, 360, 768, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.locator('.pb-page-scroll').evaluate((element) => ({
      overflow: element.scrollWidth - element.clientWidth,
      headings: [...element.querySelectorAll('.pb-routine-heading, .pb-page-heading')].map(
        (heading) => {
          const box = heading.getBoundingClientRect();
          return [...heading.children].every((child) => {
            const rect = child.getBoundingClientRect();
            return rect.left >= box.left - 1 && rect.right <= box.right + 1;
          });
        },
      ),
    }));
    expect(layout.overflow, `${width}px`).toBeLessThanOrEqual(1);
    expect(layout.headings.every(Boolean), `${width}px`).toBe(true);
  }
});

test('settings tabs keep readable labels in a scrollable row', async ({ page }) => {
  await page.setContent(
    `<meta name="viewport" content="width=device-width, initial-scale=1"><div class="modal-overlay"><section class="modal settings-modal"><div class="settings-tabs" role="tablist" aria-label="Settings sections">${['Model', 'Interface', 'Extensions', 'Connection'].map((label) => `<button role="tab">${label}</button>`).join('')}</div></section></div>`,
  );
  await page.addStyleTag({ content: css });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const tab of await page.getByRole('tab').all()) {
      const fits = await tab.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const text = range.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return text.left >= box.left + 4 && text.right <= box.right - 4;
      });
      expect(fits, `${width}px, ${await tab.innerText()}`).toBe(true);
    }
    const last = page.getByRole('tab', { name: 'Connection' });
    await last.scrollIntoViewIfNeeded();
    const bounds = await page.getByRole('tablist').boundingBox();
    const active = await last.boundingBox();
    expect(active!.x, `${width}px`).toBeGreaterThanOrEqual(bounds!.x);
    expect(active!.x + active!.width, `${width}px`).toBeLessThanOrEqual(
      bounds!.x + bounds!.width + 1,
    );
  }
});
