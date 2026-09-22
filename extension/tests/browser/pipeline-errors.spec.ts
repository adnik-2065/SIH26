// End-to-end checks for the failures this audit was about: a page whose text is
// Unicode, a second submission while a run is live, and a refusal that has to
// name its stage. Each drives the shipped extension, not a harness copy.
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

let context: BrowserContext, worker: Worker, panel: Page, portal: Page, extensionId: string;
const panelLog: string[] = [];

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-pipeline-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`,
      '--enable-unsafe-extension-debugging', '--window-size=1280,1000', '--force-device-scale-factor=1'],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  panel.on('console', message => panelLog.push(message.text()));
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  portal = await context.newPage();
  await portal.goto('http://127.0.0.1:4173/');
  await portal.bringToFront();
  const browser = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await browser.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
  await browser.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfos.find(t => t.url.startsWith('http://127.0.0.1:4173'))!.targetId });
});
test.afterAll(async () => { await context?.close(); });
test.describe.configure({ mode: 'serial' });

const scan = async () => {
  await portal.bringToFront();
  await panel.evaluate(() => document.querySelector<HTMLButtonElement>('.primary')!.click());
  await expect(panel.locator('.status')).toHaveText('Scan ready to review', { timeout: 120_000 });
};

test('a page written in rupees, Devanagari and emoji still produces a redacted payload', async () => {
  await portal.evaluate(() => {
    document.body.innerHTML = `<h1>शुल्क भुगतान</h1>
      <p id="price">पाठ्यक्रम शुल्क ₹4,999 — José Álvarez ✅</p>
      <label>नाम<input id="name"></label>
      <button id="pay">भुगतान करें</button>`;
    scrollTo(0, 0);
  });
  await scan();
  const review = panel.getByRole('region', { name: 'Redacted export review' });
  await review.getByRole('button', { name: 'Prepare redacted preview' }).evaluate((button: HTMLButtonElement) => button.click());
  // Before this change the whole export was refused for containing ₹.
  await expect(review.locator('pre')).toHaveCount(1, { timeout: 30_000 });
  await expect(review.getByRole('alert')).toHaveCount(0);
  const payload = await panel.evaluate(() => document.querySelector('[aria-label="Redacted export review"] pre')!.textContent!);
  expect(payload).toContain('"protocolVersion": 1');
  // Unknown words in every script are still withheld as placeholders.
  expect(payload).not.toContain('José');
  expect(payload).not.toContain('भुगतान करें');
});

test('a second submission while a run is live is ignored, not duplicated', async () => {
  await panel.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>('#instruction')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'open the payment page');
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await portal.bringToFront();
  // Two submits inside one tick: the window a double click lands in.
  const submitted = await panel.evaluate(() => {
    const form = document.querySelector<HTMLFormElement>('.composer')!;
    form.requestSubmit(); form.requestSubmit(); form.requestSubmit();
    return true;
  });
  expect(submitted).toBe(true);
  await expect.poll(() => panelLog.filter(line => line.includes('Run started.')).length, { timeout: 30_000 }).toBe(1);
  expect(panelLog.filter(line => line.includes('DUPLICATE_RUN_IGNORED')).length).toBeGreaterThanOrEqual(1);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STOP' }));
});
