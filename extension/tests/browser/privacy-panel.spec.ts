import { test, expect, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

test('real OCR/MediaPipe review sanitizes the payload and clears it on lifecycle exits without storage or network leaks', async () => {
  test.setTimeout(180_000);
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-privacy-panel-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--enable-unsafe-extension-debugging', '--window-size=1280,1000'],
  });
  const requests: string[] = [], logs: string[] = [];
  context.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4173/')) requests.push(request.url() + (request.postData() ?? '')); });
  context.on('console', message => logs.push(message.text()));
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage(); await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await panel.evaluate(() => {
      const originals: string[] = [];
      (window as unknown as { testOriginals: string[] }).testOriginals = originals;
      chrome.runtime.onMessage.addListener(message => { if (message.type === 'CAPTURE_TILE') originals.push(message.tile.screenshot.slice(22)); });
    });
    const portal = await context.newPage(); await portal.goto('http://127.0.0.1:4173/');
    await portal.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 700; canvas.height = 100;
      const context = canvas.getContext('2d')!; context.fillStyle = 'white'; context.fillRect(0, 0, 700, 100);
      context.fillStyle = 'black'; context.font = '30px Arial'; context.fillText('mira@example.test', 20, 60);
      const image = new Image(); image.src = canvas.toDataURL(); image.style.cssText = 'display:block;margin-top:3000px';
      document.body.append(image);
    });
    await portal.locator('img').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    const browser = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browser.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    await browser.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfos.find(target => target.url === portal.url())!.targetId });
    const review = panel.getByRole('region', { name: 'Redacted export review' });
    const scan = async () => {
      await panel.evaluate(() => document.querySelector<HTMLButtonElement>('.primary')!.click());
    await expect(panel.locator('.status')).toHaveText('Scan ready to review', { timeout: 90_000 });
    };
    let preparation = 0;
    const prepare = async () => {
      preparation++;
      await review.getByRole('button', { name: 'Prepare redacted preview' }).click();
      await expect.poll(async () => ({ count: await review.locator('pre').count() + await review.getByRole('alert').count(),
        status: await panel.locator('.status').textContent(), reviewPresent: await review.count(),
        preparing: await review.getByRole('button', { name: 'Preparing redaction…' }).count() }), { timeout: 30_000 }).toEqual({ count: 1, status: 'Scan ready to review', reviewPresent: 1, preparing: 0 });
      expect(await review.getByRole('alert').allTextContents(), `Preparation ${preparation}`).toEqual([]);
      await expect(review.locator('pre')).toHaveCount(1);
    };
    await scan();
    expect(await portal.locator('body').innerText()).not.toContain('mira@example.test');
    await expect(panel.locator('.ocr-results')).toContainText('mira');
    await review.getByRole('checkbox', { name: /Re-scan the redacted image/ }).check();
    await prepare();
    const payloadToggle = review.getByText('Exact local payload', { exact: true });
    await payloadToggle.focus(); await payloadToggle.press('Enter');
    await expect(review.locator('pre')).toBeVisible();
    await payloadToggle.press('Enter');
    const evidence = await panel.evaluate(() => {
      const json = document.querySelector('[aria-label="Redacted export review"] pre')!.textContent!;
      const originals = (window as unknown as { testOriginals: string[] }).testOriginals;
      const request = JSON.parse(json);
      return { leaked: ['mira@example.test', 'student@example.test', 'Demo Student', ...originals].some(value => json.includes(value)),
        image: !!request.sanitizedImage, keys: Object.keys(request).sort() };
    });
    expect(evidence.leaked).toBe(false); expect(evidence.image).toBe(true);
    expect(evidence.keys).toEqual(['elements', 'observationId', 'protocolVersion', 'requestId', 'sanitizedImage', 'sanitizedInstruction', 'taskId', 'valueRefs']);
    await panel.setViewportSize({ width: 380, height: 900 });
    await review.screenshot({ path: '/tmp/sih26-redacted-review.png' });
    await panel.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(review).toHaveCount(0);
    await scan(); await prepare();
    await portal.evaluate(() => window.scrollTo(0, 150));
    await expect(review).toHaveCount(0);
    await scan(); await prepare();
    await panel.getByText('Scan settings', { exact: true }).click();
    await panel.getByLabel('Analyze text and faces locally').uncheck();
    await expect(review).toHaveCount(0);
    await panel.getByLabel('Analyze text and faces locally').check();
    await scan(); await prepare();
    await portal.locator('#layout').click();
    await expect(review).toHaveCount(0);
    await scan(); await prepare();
    await worker.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); await chrome.tabs.setZoom(tab.id!, 1.25); });
    await expect(review).toHaveCount(0);
    await scan(); await prepare();
    const other = await context.newPage(); await other.goto('http://127.0.0.1:4173/');
    await expect(review).toHaveCount(0);
    const storageLeak = await panel.evaluate(async () => {
      const stored = JSON.stringify(await Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null), chrome.storage.sync.get(null)]));
      const originals = (window as unknown as { testOriginals: string[] }).testOriginals;
      return ['mira@example.test', 'student@example.test', 'Demo Student', 'value_', ...originals].some(raw => stored.includes(raw));
    });
    expect(storageLeak).toBe(false); expect(requests).toEqual([]);
    expect(logs.some(log => ['mira@example.test', 'student@example.test', 'data:image/png;base64,'].some(raw => log.includes(raw)))).toBe(false);
    await panel.close();
  } finally { await context.close(); }
});
