import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

let context: BrowserContext, worker: Worker, panel: Page, portal: Page;
let extensionId: string;
const externalRequests: string[] = [];
const pageErrors: string[] = [];

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-browser-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--enable-unsafe-extension-debugging', '--window-size=1280,1000', '--force-device-scale-factor=1'],
  });
  context.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:4173/')) externalRequests.push(url);
  });
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  // Emulate only the panel's narrow layout; keep native sizing on the captured portal.
  const panelSession = await context.newCDPSession(panel);
  await panelSession.send('Emulation.setDeviceMetricsOverride', { width: 380, height: 900, deviceScaleFactor: 1, mobile: false });
  portal = await context.newPage();
  await portal.goto('http://127.0.0.1:4173/');
});
test.afterAll(async () => { await context?.close(); });
test.describe.configure({ mode: 'serial' });

async function command(type: 'START' | 'OBSERVE' | 'STOP') {
  await portal.bringToFront();
  if (type !== 'STOP') {
    let previous = '', stable = 0;
    await expect.poll(async () => {
      const viewport = await portal.evaluate(() => `${innerWidth}:${innerHeight}:${devicePixelRatio}:${scrollY}`);
      stable = viewport === previous ? stable + 1 : 0; previous = viewport;
      return stable;
    }, { intervals: [200] }).toBeGreaterThanOrEqual(3);
  }
  return panel.evaluate(async type => chrome.runtime.sendMessage(type === 'START' ? { type, instruction: 'Inspect the synthetic form' } : { type }), type);
}
async function readyObservation() {
  await expect.poll(async () => panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'STATUS' })).state.status)).toBe('paused');
  const result = await panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'STATUS' })).state);
  expect(result.error).toBeUndefined();
  expect(result.observationId).toBeTruthy();
  await expect(panel.locator('canvas')).toBeVisible();
  await expect.poll(async () => panel.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(400);
  return result;
}

async function readyOcr() {
  await expect(panel.locator('.status')).toHaveText('Scan ready to review', { timeout: 90_000 });
  await expect(panel.locator('.ocr-results li').first()).toBeVisible();
}

async function assertImageText(text = 'student@example.test', baseline = 158) {
  const words = await panel.locator('.ocr-results button').evaluateAll(buttons => buttons.map(button => ({
    text: button.querySelector('strong')?.textContent,
    numbers: button.querySelector('.coordinates')!.textContent!.match(/\d+/g)!.map(Number),
  })));
  const image = await portal.locator('.card').boundingBox();
  const vp = await portal.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const pixels = await panel.locator('canvas').evaluate(canvas => ({ width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height }));
  const sx = pixels.width / vp.width, sy = sx;
  // Small screenshot text can split an email into adjacent OCR words.
  const matching: typeof words = [];
  for (let i = 0; i < words.length; i++) for (let count = 1; count <= 4; count++) {
    const parts = words.slice(i, i + count);
    if (parts.map(word => word.text).join('') !== text || parts.some(word => word.numbers[0] < image!.x * sx)) continue;
    const x = Math.min(...parts.map(word => word.numbers[0])), y = Math.min(...parts.map(word => word.numbers[1]));
    const right = Math.max(...parts.map(word => word.numbers[0] + word.numbers[2]));
    const bottom = Math.max(...parts.map(word => word.numbers[1] + word.numbers[3]));
    matching.push({ text, numbers: [x, y, right - x, bottom - y] });
  }
  expect(matching, JSON.stringify(words)).not.toHaveLength(0);
  for (const { numbers: [x, y, width, height] } of matching) {
    expect(x).toBeGreaterThanOrEqual(image!.x * sx);
    expect(x + width).toBeLessThanOrEqual((image!.x + image!.width) * sx + 2);
    expect(y).toBeGreaterThanOrEqual(image!.y * sy);
    expect(y + height).toBeLessThanOrEqual((image!.y + image!.height) * sy + 2);
    // Compare the source text baseline to its rendered screenshot position.
    expect(Math.abs((y + height) / sy - (image!.y + image!.height * baseline / 240))).toBeLessThan(14);
  }
}


async function assertFace() {
  const boxes = await panel.locator('.face-results .coordinates').allTextContents();
  expect(boxes).toHaveLength(1);
  const [x, y, width, height] = boxes[0].match(/\d+/g)!.map(Number);
  const portrait = await portal.locator('.portrait').boundingBox();
  const vp = await portal.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const pixels = await panel.locator('canvas').evaluate(canvas => ({ width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height }));
  const sx = pixels.width / vp.width, sy = sx;
  expect(width).toBeGreaterThan(20); expect(height).toBeGreaterThan(20);
  expect(x).toBeGreaterThanOrEqual(portrait!.x * sx);
  expect(y).toBeGreaterThanOrEqual(portrait!.y * sy);
  expect(x + width).toBeLessThanOrEqual((portrait!.x + portrait!.width) * sx);
  expect(y + height).toBeLessThanOrEqual((portrait!.y + portrait!.height) * sy);
}

test('production extension loads with scoped permissions and bundled OCR', async () => {
  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  expect(manifest.host_permissions).toBeUndefined();
  expect(manifest.permissions).toEqual(['activeTab', 'scripting', 'sidePanel', 'storage', 'debugger']);
  expect(manifest.content_security_policy.extension_pages).toContain("'wasm-unsafe-eval'");
  await expect(panel.getByRole('heading', { name: 'See what’s on the page.' })).toBeVisible();
  await expect(panel.getByText('Your next scan starts here')).toBeVisible();
  expect((await readFile('dist/ocr/lang/eng.traineddata.gz')).byteLength).toBeGreaterThan(1_000_000);
});

test('fixture validates required fields, submits manually, and exposes dynamic cases', async () => {
  await portal.getByRole('button', { name: 'Submit application' }).click();
  await expect(portal.locator('#submission-count')).toHaveText('0');
  await portal.getByLabel('Full name').fill('Demo Student');
  await portal.getByLabel('Email address').fill('student@example.test');
  await portal.getByLabel('Phone number').fill('0000000000');
  await portal.getByLabel('Workshop', { exact: true }).selectOption('web');
  await portal.getByLabel('I agree').check();
  await portal.getByRole('button', { name: 'Submit application' }).click();
  await expect(portal.locator('#submission-count')).toHaveText('1');
  await expect(portal.locator('#result')).toContainText('Application submitted successfully');
  await portal.getByRole('button', { name: 'Toggle phone disabled' }).click();
  await expect(portal.getByLabel('Phone number')).toBeDisabled();
  await portal.getByRole('button', { name: 'Add field after 2 seconds' }).click();
  await expect(portal.getByLabel('College name')).toBeVisible();
  await portal.reload();
});

test('user action grants access; DOM and screenshot are captured locally', async () => {
  await portal.bringToFront();
  // Equivalent to a toolbar click: test the shipped activeTab permission unchanged.
  const browserSession = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
  const tabTarget = targetInfos.find(target => target.url === portal.url());
  expect(tabTarget, JSON.stringify(targetInfos)).toBeTruthy();
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: tabTarget!.targetId });
  await panel.getByText('Scan settings', { exact: true }).click();
  await panel.getByLabel('Optional observation note').fill('Inspect the synthetic form');
  await panel.getByLabel('Analyze text and faces locally').check();
  await portal.bringToFront();
  expect((await command('START')).ok).toBe(true);
  const state = await readyObservation();
  await panel.getByText('Page controls and capture details', { exact: true }).click();
  const labels = await panel.locator('.elements').innerText();
  expect(labels).toContain('Full name'); expect(labels).toContain('Email address');
  expect(labels).toContain('disabled'); expect(labels).not.toContain('Hidden field');
  expect(labels).not.toContain('SYNTHETIC_HIDDEN_VALUE');
  await readyOcr();
  await assertImageText();
  await assertFace();
  const storage = await worker.evaluate(async () => ({ session: await chrome.storage.session.get(null), local: await chrome.storage.local.get(null) }));
  const serialized = JSON.stringify(storage);
  expect(serialized).not.toContain('data:image'); expect(serialized).not.toContain('student@example.test');
  expect(serialized).not.toContain('Inspect the synthetic form'); expect(storage.local).toEqual({});
  expect(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.screenshot({ path: '/tmp/sih26-ocr-panel.png', fullPage: true });
  await writeFile('/tmp/sih26-browser-baseline.json', JSON.stringify({
    browser: context.browser()?.version(), observedAt: new Date().toISOString(),
    viewport: await portal.evaluate(() => ({ width: innerWidth, height: innerHeight, devicePixelRatio })), observationId: state.observationId,
    metrics: await panel.locator('.metrics').innerText(),
    models: 'Tesseract English OCR + MediaPipe BlazeFace; no planner',
  }, null, 2));
  // Read the synthetic preview without focusing/resizing the panel tab, which
  // would correctly invalidate the observed portal's current view.
  const preview = await panel.locator('canvas').evaluate(canvas => (canvas as HTMLCanvasElement).toDataURL('image/png'));
  await writeFile('/tmp/sih26-phase-one-observation.png', Buffer.from(preview.split(',')[1], 'base64'));
});

test('OCR reads changed image pixels and reuses its worker', async () => {
  const originalWorkers = panel.workers();
  expect(originalWorkers.length).toBeGreaterThan(0);
  await portal.evaluate(async () => {
    const image = document.querySelector<HTMLImageElement>('.card')!;
    const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 240;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 720, 240);
    ctx.fillStyle = '#111'; ctx.font = '40px Arial';
    ctx.fillText('pixels-only@example.test', 30, 158);
    image.src = canvas.toDataURL(); await image.decode();
  });
  await expect(panel.locator('canvas')).toHaveCount(0);
  await command('OBSERVE'); await readyObservation(); await readyOcr();
  await assertImageText('pixels-only@example.test');
  expect(panel.workers()).toEqual(originalWorkers);
  // Changing pixels must change recognition; this string is absent from the DOM text.
  expect(await portal.locator('body').innerText()).not.toContain('pixels-only@example.test');
  await portal.evaluate(async () => {
    const image = document.querySelector<HTMLImageElement>('.card')!;
    image.src = '/assets/synthetic-details.svg'; await image.decode();
  });
});

test('zoom and scroll require fresh captures with consistent pixel dimensions', async () => {
  await worker.evaluate(async () => {
    const state = (await chrome.storage.session.get('task')).task;
    await chrome.tabs.setZoom(state.tabId, 1.25);
  });
  await expect(panel.getByRole('alert')).toContainText('page or active tab changed');
  await command('OBSERVE'); await readyObservation();
  await readyOcr(); await assertImageText('Name:DemoStudent', 105); await assertFace();
  const viewport = await portal.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  const pixels = await panel.locator('canvas').evaluate(canvas => ({ width: (canvas as HTMLCanvasElement).width, height: (canvas as HTMLCanvasElement).height }));
  expect(Math.abs(pixels.width - viewport.width * viewport.dpr)).toBeLessThanOrEqual(2);
  expect(pixels.height).toBeGreaterThanOrEqual(viewport.height * viewport.dpr);
  await portal.evaluate(() => window.scrollTo(0, 250));
  await expect(panel.locator('canvas')).toHaveCount(0);
  await command('OBSERVE'); await readyObservation();
  await worker.evaluate(async () => {
    const state = (await chrome.storage.session.get('task')).task;
    await chrome.tabs.setZoom(state.tabId, 1);
  });
  await portal.evaluate(() => window.scrollTo(0, 0));
  await command('OBSERVE'); await readyObservation();
});

test('face review supports selection and reacts to changed portrait pixels', async () => {
  await readyOcr(); await assertFace();
  await panel.getByRole('tab', { name: 'Faces 1' }).click();
  await panel.locator('.face-results button').click();
  await expect(panel.locator('.face-results button')).toHaveAttribute('aria-pressed', 'true');
  await panel.getByText('Scan settings', { exact: true }).click();
  await panel.getByText('Page controls and capture details', { exact: true }).click();
  await panel.screenshot({ path: '/tmp/sih26-vision-panel.png', fullPage: true });
  await portal.evaluate(async () => {
    const image = document.querySelector<HTMLImageElement>('.portrait')!;
    const canvas = document.createElement('canvas'); canvas.width = 220; canvas.height = 220;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 220, 220);
    image.src = canvas.toDataURL(); await image.decode();
  });
  await command('OBSERVE'); await readyObservation();
  await expect(panel.locator('.status')).toHaveText('Scan ready to review', { timeout: 90_000 });
  await expect(panel.getByText('No faces detected.', { exact: false })).toBeVisible();
  await expect(panel.locator('.face-results li')).toHaveCount(0);
  await portal.evaluate(async () => {
    const image = document.querySelector<HTMLImageElement>('.portrait')!;
    image.src = '/assets/synthetic-face.png'; await image.decode();
  });
  await command('OBSERVE'); await readyObservation();
  await panel.getByRole('tab', { name: /^Text/ }).click();
  await readyOcr(); await assertFace();
  await panel.getByLabel('Find detected text').fill('unlikely_word_123');
  await expect(panel.getByText('No words match your search.')).toBeVisible();
  await panel.getByLabel('Find detected text').fill('');
});

test('page changes invalidate observations, and Stop prevents delayed results', async () => {
  await portal.getByRole('button', { name: 'Change layout' }).click();
  await expect(panel.getByRole('alert')).toContainText('page or active tab changed');
  await expect(panel.locator('canvas')).toHaveCount(0);
  await command('OBSERVE'); await readyObservation();
  await expect(panel.locator('.status')).toHaveText('Analyzing on your device…');
  await command('STOP');
  await expect(panel.locator('canvas')).toHaveCount(0);
  await expect(panel.locator('.ocr-results')).toHaveCount(0);
  await expect(panel.locator('.face-results')).toHaveCount(0);
  await expect.poll(() => panel.workers().length).toBe(0);
  await expect.poll(async () => (await panel.evaluate(async () => chrome.runtime.sendMessage({ type: 'STATUS' }))).state.status).toBe('stopped');
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('fresh scan works after Stop and preview opt-out clears OCR', async () => {
  await command('START'); await readyObservation(); await readyOcr();
  await panel.getByText('Scan settings', { exact: true }).click();
  await panel.getByLabel('Analyze text and faces locally').uncheck();
  await expect(panel.locator('canvas')).toHaveCount(0);
  await expect(panel.locator('.ocr-results')).toHaveCount(0);
  await expect(panel.locator('.face-results')).toHaveCount(0);
  await expect.poll(() => panel.workers().length).toBe(0);
  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});


test('missing face model shows an incomplete scan and retry recovers', async () => {
  await panel.getByLabel('Analyze text and faces locally').check();
  // chrome-extension resources bypass HTTP routing. Inject the failure in a
  // temporary worker bootstrap, leaving the production worker/model unchanged.
  const failureWorker = 'dist/vision/failing-face.worker.js';
  await writeFile(failureWorker, `
    const nativeFetch = self.fetch.bind(self);
    self.fetch = (input, init) => String(input).endsWith('/blaze_face_short_range.tflite')
      ? Promise.reject(new Error('Synthetic missing model')) : nativeFetch(input, init);
    importScripts('./face.worker.js');
  `);
  await panel.evaluate(() => {
    const NativeWorker = window.Worker;
    (window as unknown as { restoreWorker: () => void }).restoreWorker = () => { window.Worker = NativeWorker; };
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(String(url).endsWith('/vision/face.worker.js') ? chrome.runtime.getURL('vision/failing-face.worker.js') : url, options);
      }
    };
  });
  try {
    await command('START'); await readyObservation();
    await expect(panel.locator('.status')).toHaveText('Scan needs attention', { timeout: 90_000 });
    await expect(panel.getByRole('alert')).toContainText('Face detection failed');
    await expect(panel.locator('.ocr-results li').first()).toBeVisible();
    await expect(panel.locator('.face-results')).toHaveCount(0);
    await panel.evaluate(() => (window as unknown as { restoreWorker: () => void }).restoreWorker());
    await panel.getByRole('button', { name: 'Retry detection' }).click();
    await readyOcr(); await assertFace();
    expect(externalRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    await command('STOP');
    await expect.poll(() => panel.workers().length).toBe(0);
  } finally {
    await panel.evaluate(() => (window as unknown as { restoreWorker: () => void }).restoreWorker());
    await rm(failureWorker, { force: true });
  }
});
