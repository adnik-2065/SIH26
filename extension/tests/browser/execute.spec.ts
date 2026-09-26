// The whole execution path, through the shipped extension: the panel asks the
// worker to perform a step, the worker re-checks its own state, and the content
// script performs it on the real page. Everything below happens after capture
// has finished, which is where a live application spends the seconds the local
// detectors and the reasoning server need.
import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import type { CaptureObservation, ErrorCode, ObservedElement } from '../../src/contracts';

declare global { interface Window { observations: CaptureObservation[] } }
let context: BrowserContext, worker: Worker, panel: Page, portal: Page, extensionId: string;
const PAGE = `<h1>College LMS</h1><nav><a id="profile" href="/#profile">Profile</a></nav>
  <div id="feed"><p id="clock">12:00</p><p id="old">Older notice</p></div>`;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-execute-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`,
      '--enable-unsafe-extension-debugging', '--window-size=1280,1000', '--force-device-scale-factor=1'],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  portal = await context.newPage();
  await portal.goto('http://127.0.0.1:4173/');
  await portal.bringToFront();
  // Equivalent to a toolbar click: the shipped activeTab grant, unchanged.
  const browserSession = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
  const tab = targetInfos.find(target => target.url.startsWith('http://127.0.0.1:4173'));
  expect(tab, JSON.stringify(targetInfos)).toBeTruthy();
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: tab!.targetId });
  // The panel keeps published observations so a test can address the exact
  // control ids the redacted payload would have carried to the server.
  await panel.evaluate(() => {
    window.observations = [];
    chrome.runtime.onMessage.addListener((message: { type?: string; observation?: CaptureObservation }) => {
      if (message?.type === 'OBSERVATION' && message.observation) window.observations.push(message.observation);
    });
  });
});
test.afterAll(async () => { await context?.close(); });

async function scan(): Promise<CaptureObservation> {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(markup => { document.body.innerHTML = markup; scrollTo(0, 0); }, PAGE);
  await portal.bringToFront();
  await panel.evaluate(() => { window.observations = []; });
  const started = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START', instruction: 'open profile page' }));
  expect(started.ok, JSON.stringify(started)).toBe(true);
  await expect.poll(async () => panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'STATUS' })).state.status),
    { timeout: 60_000 }).toBe('paused');
  const observation = await panel.evaluate(() => window.observations.at(-1));
  expect(observation, 'no observation was published').toBeTruthy();
  return observation!;
}
// Exactly what the panel dispatches once the server has named a control.
async function click(observation: CaptureObservation): Promise<{ ok?: boolean; error?: ErrorCode }> {
  const element = observation.dom.elements.find(control => control.label === 'Profile');
  expect(element, JSON.stringify(observation.dom.elements)).toBeTruthy();
  return panel.evaluate(([observationId, control]: [string, ObservedElement]) => chrome.runtime.sendMessage({
    type: 'ACT', observationId, action: { type: 'click', target: control.id },
    expect: { role: control.role, bounds: control.bounds },
  }), [observation.dom.observationId, element!] as [string, ObservedElement]);
}

// Ordinary background churn on a live page: a notification toast, a state class
// on the document, a ticking timestamp, a stale item being cleared. None of it
// changes the reviewed link, so the reviewed link must still be clickable — for
// the whole time the detectors and the reasoning server are working.
for (const noise of ['none', 'toast-appended-to-body', 'class-toggled-on-html', 'unrelated-text-edited', 'unrelated-node-removed'] as const) {
  test(`a reviewed control is still performed after ${noise}`, async () => {
    const observation = await scan();
    await portal.evaluate(async kind => {
      if (kind === 'toast-appended-to-body') {
        const toast = document.createElement('div');
        toast.textContent = 'You have 1 new notification';
        toast.style.cssText = 'position:fixed;right:8px;bottom:8px';
        document.body.append(toast);
      }
      if (kind === 'class-toggled-on-html') document.documentElement.classList.add('is-scrolled');
      if (kind === 'unrelated-text-edited') document.getElementById('clock')!.textContent = '12:01';
      if (kind === 'unrelated-node-removed') document.getElementById('old')!.remove();
      await new Promise(resolve => setTimeout(resolve, 200));
    }, noise);
    expect(await click(observation)).toEqual({ ok: true, state: expect.anything() });
    expect(portal.url()).toContain('#profile');
  });
}

// The same leniency must not reach the control itself. Every case below changes
// what was reviewed, so the step is refused and the page is left untouched.
// There is deliberately no MutationObserver: unrelated churn leaves the ref
// usable, and these per-target changes (detached, rewritten, hidden, moved)
// are caught by the executor's availability, geometry and occlusion checks at
// the instant of the click as TARGET_CHANGED — the reviewed page is still
// current, the reviewed control is not. An overlay is refused by the same
// executor, at the same instant, for the same reason.
for (const [change, expected] of [
  ['the reviewed control is detached', 'TARGET_CHANGED'],
  ['its container is rewritten', 'TARGET_CHANGED'],
  ['its own label changes', 'TARGET_CHANGED'],
  ['an ancestor hides it', 'TARGET_CHANGED'],
  ['an ancestor moves it', 'TARGET_CHANGED'],
  ['an overlay covers it', 'TARGET_CHANGED'],
] as const) {
  test(`the step is refused when ${change}`, async () => {
    const observation = await scan();
    await portal.evaluate(async kind => {
      const link = document.getElementById('profile')!, nav = document.querySelector('nav') as HTMLElement;
      if (kind === 'the reviewed control is detached') link.remove();
      if (kind === 'its container is rewritten') nav.innerHTML = '<a id="profile" href="/#elsewhere">Profile</a>';
      if (kind === 'its own label changes') link.textContent = 'My profile';
      if (kind === 'an ancestor hides it') nav.style.display = 'none';
      if (kind === 'an ancestor moves it') nav.style.marginLeft = '200px';
      if (kind === 'an overlay covers it') {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:9';
        document.body.append(overlay);
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }, change);
    const result = await click(observation);
    expect(result.ok).toBe(false);
    expect(result.error).toBe(expected);
    expect(portal.url()).not.toContain('#profile');
  });
}
