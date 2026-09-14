import { test, expect, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { PerceptionResult } from '../../src/vision/contracts';

for (const scenario of [
  { width: 1373, height: 999, dpr: 1 },
  { width: 1920, height: 1080, dpr: 1 },
  { width: 1373, height: 999, dpr: 2 },
  { width: 1373, height: 999, dpr: 1, seam: true },
]) test(`detects one aligned face at ${scenario.width} × ${scenario.height}, DPR ${scenario.dpr}${scenario.seam ? ', across crop boundary' : ''}`, async () => {
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-face-scale-')), {
    channel: 'chromium', headless: true, deviceScaleFactor: scenario.dpr,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/panel.html`);
    const page = await context.newPage();
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await page.goto('http://127.0.0.1:4173/');
    await page.locator('.portrait').evaluate((image: HTMLImageElement) => image.decode());
    if (scenario.seam) await page.locator('.portrait').evaluate(image => { image.style.position = 'fixed'; image.style.left = '380px'; image.style.top = '280px'; });
    const screenshot = (await page.screenshot()).toString('base64');
    const result = await panel.evaluate(async screenshot => {
      const blob = new Blob([Uint8Array.from(atob(screenshot), char => char.charCodeAt(0))], { type: 'image/png' });
      const image = await createImageBitmap(blob);
      const faceWorker = new Worker(chrome.runtime.getURL('vision/face.worker.js'));
      try {
        return await new Promise<PerceptionResult>((resolve, reject) => {
          faceWorker.onerror = () => reject(new Error('Face worker failed'));
          faceWorker.onmessage = ({ data }) => data.type === 'result' ? resolve(data.result) : reject(new Error('Face inference failed'));
          faceWorker.postMessage({ observationId: 'wide_fixture', image, assetRoot: chrome.runtime.getURL('vision') }, [image]);
        });
      } finally { faceWorker.terminate(); image.close(); }
    }, screenshot);
    expect(result.regions).toHaveLength(1);
    const portrait = await page.locator('.portrait').boundingBox();
    const b = result.regions[0].bounds;
    expect(b.x).toBeGreaterThanOrEqual(portrait!.x * scenario.dpr);
    expect(b.y).toBeGreaterThanOrEqual(portrait!.y * scenario.dpr);
    expect(b.x + b.width).toBeLessThanOrEqual((portrait!.x + portrait!.width) * scenario.dpr);
    expect(b.y + b.height).toBeLessThanOrEqual((portrait!.y + portrait!.height) * scenario.dpr);
  } finally { await context.close(); }
});
