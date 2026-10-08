import { test, expect, chromium, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

declare global { interface Window { stabilityObservations: unknown[]; dynamicTimer?: number } }

let context: BrowserContext, worker: Worker, panel: Page, portal: Page;

test.beforeAll(async () => {
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'sih26-stability-')), {
    channel: 'chromium', headless: true, viewport: null,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`,
      '--enable-unsafe-extension-debugging', '--window-size=1280,1000', '--force-device-scale-factor=1'],
  });
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/panel.html`);
  portal = await context.newPage();
  await portal.goto('http://127.0.0.1:4173/');
  await portal.bringToFront();
  const browserSession = await context.browser()!.newBrowserCDPSession();
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab', exclude: false }, { exclude: true }] });
  const target = targetInfos.find(item => item.url.startsWith('http://127.0.0.1:4173'));
  expect(target).toBeTruthy();
  await browserSession.send('Extensions.triggerAction', { id: extensionId, targetId: target!.targetId });
  await panel.evaluate(() => {
    window.stabilityObservations = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'OBSERVATION') window.stabilityObservations.push(message.observation);
    });
  });
});
test.afterAll(async () => context?.close());

async function capture() {
  await portal.bringToFront();
  await panel.evaluate(() => { window.stabilityObservations = []; });
  const started = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'START', instruction: 'inspect page stability' }));
  expect(started.ok).toBe(true);
  await expect.poll(async () => panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'STATUS' })).state.status),
    { timeout: 20_000 }).not.toBe('observing');
  return panel.evaluate(async () => ({
    state: (await chrome.runtime.sendMessage({ type: 'STATUS' })).state,
    observations: window.stabilityObservations.length,
  }));
}

test('captures a mostly static page', async () => {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(() => { document.body.innerHTML = '<main><h1>Stable page</h1><button>Continue</button></main>'; });
  const result = await capture();
  expect(result.state.error, JSON.stringify(result)).toBeUndefined();
  expect(result.observations).toBe(1);
});

test('captures a framework-style dynamic page with counters, badges, and class churn', async () => {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(() => {
    document.body.innerHTML = '<main><h1>Dashboard</h1><button>Open report</button><span id="counter">0</span><i id="badge">new</i></main>';
    let value = 0;
    window.dynamicTimer = window.setInterval(() => {
      document.getElementById('counter')!.textContent = String(++value);
      document.getElementById('badge')!.classList.toggle('pulse');
      document.body.setAttribute('data-react-render', String(value));
    }, 20);
  });
  const result = await capture();
  expect(result.state.error, JSON.stringify(result)).toBeUndefined();
  expect(result.observations).toBe(1);
});

test('captures a page with CSS animation and non-layout style updates', async () => {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(() => {
    document.body.innerHTML = '<style>@keyframes pulse { from { opacity:.8 } to { opacity:1 } }</style>' +
      '<main><h1>Animated page</h1><button>Continue</button><span id="spinner" style="animation:pulse .1s infinite">Loading</span></main>';
    let on = false;
    window.dynamicTimer = window.setInterval(() => {
      on = !on; document.getElementById('spinner')!.style.color = on ? 'rgb(1, 2, 3)' : 'rgb(3, 2, 1)';
    }, 20);
  });
  const result = await capture();
  expect(result.state.error, JSON.stringify(result)).toBeUndefined();
  expect(result.observations).toBe(1);
});

// A React list re-rendering its rows is the churn this change exists to
// tolerate: the rows come and go, but the page is the same page.
test('captures a page that re-renders a whole list on a timer', async () => {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(() => {
    document.body.innerHTML = '<main><h1>Changing results</h1><button>Continue</button><section id="results"></section></main>';
    let version = 0;
    window.dynamicTimer = window.setInterval(() => {
      const section = document.getElementById('results')!;
      section.replaceChildren(...Array.from({ length: 30 }, (_, index) => {
        const row = document.createElement('div'); row.textContent = `row ${version}-${index}`; return row;
      }));
      version++;
    }, 30);
  });
  const result = await capture();
  expect(result.state.error, JSON.stringify(result)).toBeUndefined();
  expect(result.observations).toBe(1);
});

test('captures a page that keeps appending notification toasts', async () => {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(() => {
    document.body.innerHTML = '<main><h1>Inbox</h1><button id="open">Open</button><div id="toasts"></div></main>';
    let count = 0;
    window.dynamicTimer = window.setInterval(() => {
      const toast = document.createElement('div');
      toast.textContent = `notification ${++count}`;
      toast.style.cssText = 'position:fixed;right:8px;bottom:8px';
      document.getElementById('toasts')!.append(toast);
      setTimeout(() => toast.remove(), 60);
      document.getElementById('open')!.textContent = `Open (${count})`;
    }, 25);
  });
  const result = await capture();
  expect(result.state.error, JSON.stringify(result)).toBeUndefined();
  expect(result.observations).toBe(1);
});

// The major changes that must still stop a scan. Each one is injected once,
// shortly after the capture starts, so it lands between COLLECT and CHECK.
const duringCapture = (script: string) => portal.evaluate(body => {
  window.dynamicTimer = window.setTimeout(() => { new Function(body)(); }, 200);
}, script);

test('still stops when the page navigates during capture', async () => {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(() => { document.body.innerHTML = '<main><h1>Report</h1><button>Continue</button></main>'; });
  await duringCapture('location.hash = "#section-two";');
  const result = await capture();
  expect(result.observations).toBe(0);
  expect(result.state.error).toBe('PAGE_CHANGED');
  expect(result.state.errorDetail?.cause).toBe('PAGE_CHANGED_NAVIGATION');
});

test('still stops when the document changes size drastically during capture', async () => {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(() => { document.body.innerHTML = '<main><h1>Report</h1><button>Continue</button></main>'; });
  await duringCapture('document.body.insertAdjacentHTML("beforeend", "<div style=\'height:4000px\'>tall</div>");');
  const result = await capture();
  expect(result.observations).toBe(0);
  expect(result.state.error).toBe('PAGE_CHANGED');
  expect(result.state.errorDetail?.cause).toBe('PAGE_CHANGED_DOCUMENT_SIZE');
});

test('still stops when the reviewed controls disappear during capture', async () => {
  await portal.goto('http://127.0.0.1:4173/');
  await portal.evaluate(() => {
    document.body.innerHTML = '<main><h1>Form</h1>' +
      Array.from({ length: 8 }, (_, index) => `<button id="b${index}">Action ${index}</button>`).join('') + '</main>';
  });
  await duringCapture('document.querySelectorAll("button").forEach(button => button.remove());');
  const result = await capture();
  expect(result.observations).toBe(0);
  expect(result.state.error).toBe('PAGE_CHANGED');
  expect(result.state.errorDetail?.cause).toBe('PAGE_CHANGED_TARGET_REMOVED');
});
