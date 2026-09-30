import { test, expect, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

for (const { zoom, dpr, long } of [{ zoom: 1, dpr: 1, long: false }, { zoom: 1.25, dpr: 1, long: false }, { zoom: 1, dpr: 2, long: false }, { zoom: 1, dpr: 1, long: true }, { zoom: 1.25, dpr: 1, long: true }, { zoom: 1, dpr: 2, long: true }]) test(`full-page capture preserves scroll and focus while reading below the fold at zoom ${zoom}, DPR ${dpr}, long ${long}`, async () => {
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-full-page-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--enable-unsafe-extension-debugging', '--window-size=1280,1000', `--force-device-scale-factor=${dpr}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const portal = await context.newPage();
    await portal.goto('http://127.0.0.1:4173/');
    await portal.evaluate(long => {
      const tail = document.createElement('section');
      tail.style.cssText = `padding-top:${long ? 37000 : 3000}px;background:white;color:black`;
      tail.innerHTML = '<p style="font:32px Arial">EndOfFacultyList</p><img loading="lazy" src="/assets/synthetic-face.png" width="220" height="220">';
      document.body.append(tail);
      if (long) {
        const branding = document.createElement('div');
        branding.innerHTML = '<style>@keyframes facultyBrand { from { color: #000 } to { color: #222 } } .faculty-brand { position:absolute;top:0;animation:facultyBrand 5s infinite alternate } #name { transition: margin-bottom .2s } @media(max-width:600px) { .faculty-brand { animation:none } #name { margin-bottom:20px } }</style><span class="faculty-brand">Faculty Directory</span>';
        document.body.append(branding);
      }
      document.querySelector<HTMLInputElement>('#name')!.focus({ preventScroll: true });
      window.scrollTo(0, 250);
    }, long);
    await portal.locator('img:not([loading])').evaluateAll(images => Promise.all(images.map(image => (image as HTMLImageElement).decode())));
    const browserSession = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    const target = targetInfos.find(item => item.url === portal.url())!;
    await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
    await worker.evaluate(async zoom => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.setZoom(tab.id!, zoom);
    }, zoom);
    await portal.waitForTimeout(600);
    const before = await portal.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id, width: innerWidth, height: innerHeight }));
    await portal.evaluate(() => {
      const events: unknown[] = [];
      (window as unknown as { captureEvents: unknown[] }).captureEvents = events;
      for (const type of ['scroll', 'resize', 'input', 'focusin', 'focusout']) window.addEventListener(type, () => events.push({ type, x: scrollX, y: scrollY, w: innerWidth, h: innerHeight }), true);
    });
    await worker.evaluate(() => {
      const messages: unknown[] = [];
      (globalThis as unknown as { captureMessages: unknown[] }).captureMessages = messages;
      chrome.runtime.onMessage.addListener(message => { if (message.type === 'PAGE_CHANGED') messages.push(message); });
      const send = chrome.debugger.sendCommand.bind(chrome.debugger);
      chrome.debugger.sendCommand = (async (target: chrome.debugger.Debuggee, method: string, params?: object) => {
        messages.push({ method, stage: 'start' });
        const result = await send(target, method, params);
        const data = (result as { data?: string })?.data;
        const view = data ? new DataView(Uint8Array.from(atob(data.slice(0, 44)), c => c.charCodeAt(0)).buffer) : undefined;
        messages.push({ method, stage: 'end', params, result: method === 'Page.getLayoutMetrics' ? result : view ? { width: view.getUint32(16), height: view.getUint32(20) } : undefined });
        return result;
      }) as typeof chrome.debugger.sendCommand;
    });
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START', instruction: 'Inspect faculty', scope: 'page' }));
    await expect.poll(async () => (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }))).state.status, { timeout: 60_000 }).not.toBe('observing');
    const state = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }))).state;
    const events = await portal.evaluate(() => (window as unknown as { captureEvents: unknown[] }).captureEvents);
    const messages = await worker.evaluate(() => (globalThis as unknown as { captureMessages: unknown[] }).captureMessages);
    expect(state.error, JSON.stringify({ state, events, messages })).toBeUndefined();
    expect(await portal.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id, width: innerWidth })) ).toEqual({ x: before.x, y: before.y, focus: before.focus, width: before.width });
    // Chrome can queue a no-op root scroll after resetting its capture surface.
    // Assert actual displacement and interaction, not that event count is zero.
    expect(events.filter(event => {
      const item = event as { type: string; x: number; y: number };
      return item.type !== 'resize' && (item.type !== 'scroll' || item.x !== before.x || item.y !== before.y);
    })).toEqual([]);
    await expect(panel.locator('.status')).toHaveText('Scan ready to review', { timeout: 90_000 });
    await expect(panel.locator('.ocr-results')).toContainText('EndOfFacultyList');
    await expect(panel.locator('.face-results li')).toHaveCount(2);
    await expect(portal.locator('img[loading]')).toHaveAttribute('loading', 'lazy');
    const portrait = await portal.locator('img[loading]').evaluate(image => {
      const box = image.getBoundingClientRect();
      return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height, dpr: devicePixelRatio };
    });
    const boxes = (await panel.locator('.face-results .coordinates').allTextContents()).map(value => value.match(/\d+/g)!.map(Number));
    const [x, y, width, height] = boxes.sort((a, b) => b[1] - a[1])[0];
    expect(x).toBeGreaterThanOrEqual(portrait.x * portrait.dpr - 2);
    expect(y).toBeGreaterThanOrEqual(portrait.y * portrait.dpr - 2);
    expect(x + width).toBeLessThanOrEqual((portrait.x + portrait.width) * portrait.dpr + 2);
    expect(y + height).toBeLessThanOrEqual((portrait.y + portrait.height) * portrait.dpr + 2);
    const captures = messages.filter(message => {
      const event = message as { method?: string; stage?: string };
      return event.method === 'Page.captureScreenshot' && event.stage === 'start';
    });
    if (long) {
      expect(captures.length).toBeGreaterThan(1);
      expect(await portal.locator('.faculty-brand').evaluate(element => getComputedStyle(element).animationPlayState)).toBe('running');
      expect(await portal.locator('#name').evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0.2s');
      await panel.getByLabel('Full size', { exact: true }).check();
      await panel.locator('canvas').last().scrollIntoViewIfNeeded();
      await expect.poll(() => panel.locator('canvas').last().evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBeGreaterThan(0);
      await expect.poll(() => panel.locator('canvas').first().evaluate(canvas => (canvas as HTMLCanvasElement).width)).toBe(0);
      const pixel = await panel.locator('canvas').last().evaluate(canvas => {
        const source = canvas as HTMLCanvasElement;
        const pixels = source.getContext('2d')!.getImageData(0, 0, source.width, source.height).data;
        return pixels.some((value, i) => i % 4 === 3 && value > 0);
      });
      expect(pixel).toBe(true);
      await panel.getByLabel('Full size', { exact: true }).uncheck();
      expect(await portal.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id }))).toEqual({ x: before.x, y: before.y, focus: before.focus });
    } else expect(captures).toHaveLength(1);
    // Playwright is still attached; check that the extension's own session ended.
    expect(await worker.evaluate(async tabId => chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics').then(() => true, () => false), state.tabId)).toBe(false);
    console.log('Full-page capture metrics:', await panel.locator('.metrics').innerText());
  } finally { await context.close(); }
});

for (const { zoom, dpr } of [{ zoom: 1, dpr: 1 }, { zoom: 1.25, dpr: 1 }, { zoom: 1, dpr: 2 }]) test(`viewport capture photographs one screen at the scroll position and aligns detections at zoom ${zoom}, DPR ${dpr}`, async () => {
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-viewport-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--enable-unsafe-extension-debugging', '--window-size=1280,1000', `--force-device-scale-factor=${dpr}`],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const portal = await context.newPage();
    await portal.goto('http://127.0.0.1:4173/');
    await portal.evaluate(() => {
      const tail = document.createElement('section');
      tail.style.cssText = 'padding-top:3000px;padding-bottom:3000px;background:white;color:black';
      tail.innerHTML = '<p style="font:32px Arial">MidPageMarker</p><img id="portrait" src="/assets/synthetic-face.png" width="220" height="220">';
      document.body.append(tail);
    });
    await portal.locator('#portrait').evaluate(image => (image as HTMLImageElement).decode());
    const browserSession = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    const target = targetInfos.find(item => item.url === portal.url())!;
    await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: target.targetId });
    await worker.evaluate(async zoom => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      await chrome.tabs.setZoom(tab.id!, zoom);
    }, zoom);
    await portal.waitForTimeout(600);
    await portal.locator('#portrait').evaluate(image => image.scrollIntoView({ block: 'center' }));
    await portal.waitForTimeout(300);
    await worker.evaluate(() => {
      const shots: unknown[] = [];
      (globalThis as unknown as { shots: unknown[] }).shots = shots;
      const send = chrome.debugger.sendCommand.bind(chrome.debugger);
      chrome.debugger.sendCommand = (async (target: chrome.debugger.Debuggee, method: string, params?: object) => {
        if (method === 'Page.captureScreenshot') shots.push(params);
        return send(target, method, params);
      }) as typeof chrome.debugger.sendCommand;
    });
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START', instruction: 'Inspect faculty' }));
    await expect(panel.locator('.status')).toHaveText('Scan ready to review', { timeout: 90_000 });
    const state = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }))).state;
    expect(state.error).toBeUndefined();
    const shots = await worker.evaluate(() => (globalThis as unknown as { shots: unknown[] }).shots);
    expect(shots).toHaveLength(1);
    await expect(panel.locator('.ocr-results')).toContainText('MidPageMarker');
    const portrait = await portal.locator('#portrait').evaluate(image => {
      const box = image.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, dpr: devicePixelRatio, innerHeight };
    });
    // Image pixels start at the top of the screen, not of the document.
    const boxes = (await panel.locator('.face-results .coordinates').allTextContents()).map(value => value.match(/\d+/g)!.map(Number));
    expect(boxes.length).toBeGreaterThan(0);
    const [x, y, width, height] = boxes.find(([, top]) => top >= portrait.y * portrait.dpr - 2 && top <= (portrait.y + portrait.height) * portrait.dpr)!;
    expect(x).toBeGreaterThanOrEqual(portrait.x * portrait.dpr - 2);
    expect(x + width).toBeLessThanOrEqual((portrait.x + portrait.width) * portrait.dpr + 2);
    expect(y + height).toBeLessThanOrEqual((portrait.y + portrait.height) * portrait.dpr + 2);
    for (const [, top, , tall] of boxes) expect(top + tall).toBeLessThanOrEqual(Math.ceil(portrait.innerHeight * portrait.dpr) + 2);
  } finally { await context.close(); }
});

test('a viewport capture of a page with more controls than the limit describes every control on screen without truncating', async () => {
  const context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-controls-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`, '--enable-unsafe-extension-debugging', '--window-size=1280,1000', '--force-device-scale-factor=1'],
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    const portal = await context.newPage();
    await portal.goto('http://127.0.0.1:4173/');
    await portal.evaluate(() => {
      const list = document.createElement('section');
      list.style.cssText = 'padding-top:4000px';
      list.innerHTML = Array.from({ length: 600 }, (_, i) => `<a href="#far${i}" style="display:block">FarLink${i}</a>`).join('');
      document.body.append(list);
      window.scrollTo(0, 0);
    });
    const onScreen = await portal.evaluate(() => [...document.querySelectorAll('input,textarea,select,button,a[href]')]
      .filter(el => { const r = el.getBoundingClientRect(); return r.width && r.height && r.bottom > 0 && r.top < innerHeight; }).length);
    expect(onScreen).toBeGreaterThan(0);
    const browserSession = await context.browser()!.newBrowserCDPSession();
    const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
    await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: targetInfos.find(item => item.url === portal.url())!.targetId });
    const scan = async (scope: 'viewport' | 'page') => {
      await portal.bringToFront();
      await panel.evaluate(scope => chrome.runtime.sendMessage({ type: 'START', instruction: 'Inspect faculty', scope }), scope);
      await expect(panel.locator('.status')).toHaveText('Scan ready to review', { timeout: 90_000 });
      return panel.locator('.technical .foot-note').last().textContent();
    };
    expect(await scan('viewport')).not.toContain('Control limit reached');
    const labels = await panel.locator('.elements li strong').allTextContents();
    expect(labels.length).toBeLessThanOrEqual(200);
    // Every control on the photographed screen is described; the nearest far links fill the rest.
    expect(labels.filter(label => !/^FarLink/.test(label)).length).toBeGreaterThanOrEqual(onScreen);
    expect(labels).toContain('FarLink0');
    expect(labels).not.toContain('FarLink599');
    // The whole document is still refused when it does not fit.
    expect(await scan('page')).toContain('Control limit reached');
  } finally { await context.close(); }
});
