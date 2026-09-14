import { test, expect, chromium } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

for (const { zoom, dpr } of [{ zoom: 1, dpr: 1 }, { zoom: 1.25, dpr: 1 }, { zoom: 1, dpr: 2 }]) test(`full-page capture preserves scroll and focus while reading below the fold at zoom ${zoom}, DPR ${dpr}`, async () => {
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
    await portal.evaluate(() => {
      const tail = document.createElement('section');
      tail.style.cssText = 'padding-top:3000px;background:white;color:black';
      tail.innerHTML = '<p style="font:32px Arial">EndOfFacultyList</p><img loading="lazy" src="/assets/synthetic-face.png" width="220" height="220">';
      document.body.append(tail);
      document.querySelector<HTMLInputElement>('#name')!.focus({ preventScroll: true });
      window.scrollTo(0, 250);
    });
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
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START', instruction: 'Inspect faculty' }));
    await expect.poll(async () => (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }))).state.status).not.toBe('observing');
    const state = (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'STATUS' }))).state;
    const events = await portal.evaluate(() => (window as unknown as { captureEvents: unknown[] }).captureEvents);
    const messages = await worker.evaluate(() => (globalThis as unknown as { captureMessages: unknown[] }).captureMessages);
    expect(state.error, JSON.stringify({ state, events, messages })).toBeUndefined();
    expect(await portal.evaluate(() => ({ x: scrollX, y: scrollY, focus: document.activeElement?.id, width: innerWidth })) ).toEqual({ x: before.x, y: before.y, focus: before.focus, width: before.width });
    expect(events.filter(event => (event as { type: string }).type !== 'resize')).toEqual([]);
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
    expect(messages.filter(message => {
      const event = message as { method?: string; stage?: string };
      return event.method === 'Page.captureScreenshot' && event.stage === 'start';
    })).toHaveLength(1);
    // Playwright is still attached; check that the extension's own session ended.
    expect(await worker.evaluate(async tabId => chrome.debugger.sendCommand({ tabId }, 'Page.getLayoutMetrics').then(() => true, () => false), state.tabId)).toBe(false);
    console.log('Full-page capture metrics:', await panel.locator('.metrics').innerText());
  } finally { await context.close(); }
});
