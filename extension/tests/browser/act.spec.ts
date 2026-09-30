import { test, expect } from '@playwright/test';
import { build } from 'vite';
import type * as Harness from '../privacy-browser-harness';

declare global { interface Window { PrivacyHarness: typeof Harness } }
let script = '';
test.beforeAll(async () => {
  const built = await build({ configFile: false, logLevel: 'silent', build: { write: false, minify: false,
    lib: { entry: 'tests/privacy-browser-harness.ts', name: 'PrivacyHarness', formats: ['iife'] } } });
  const output = Array.isArray(built) ? built[0] : built;
  if (!('output' in output)) throw new Error('Harness build failed');
  script = output.output.filter(chunk => chunk.type === 'chunk').map(chunk => chunk.code).join('\n');
});
test.beforeEach(async ({ page }) => {
  await page.goto('http://127.0.0.1:4173/');
  await page.addScriptTag({ content: script });
  // One scanned page shared by the cases below: the element map and the ids in
  // it are exactly what a redacted payload would have carried to a server.
  await page.evaluate(() => {
    document.body.innerHTML = `<form id="demo" onsubmit="event.preventDefault(); document.title = 'submitted'">
      <label>Full name<input id="name"></label>
      <label>Password<input id="secret" type="password"></label>
      <label>Session<select id="session"><option value="">Choose</option><option value="am">Morning</option><option value="pm">Afternoon</option></select></label>
      <div id="notes" role="textbox" contenteditable="true" style="width:200px;height:24px;border:1px solid"></div>
      <a id="profile" href="#profile-page">Profile</a>
      <button id="submit" type="submit">Submit</button>
    </form>`;
    const scope = window as unknown as { scan: () => Record<string, string>; refs: Map<string, HTMLElement> };
    scope.refs = new Map();
    scope.scan = () => {
      const snapshot = window.PrivacyHarness.collect('obs_1', 'doc_1', 0, scope.refs);
      const byElement: Record<string, string> = {};
      for (const [opaque, element] of scope.refs) byElement[element.id] = opaque;
      (window as unknown as { snapshot: unknown }).snapshot = snapshot;
      return byElement;
    };
  });
});
const run = (page: import('@playwright/test').Page, action: unknown, extra: object = {}) => page.evaluate(([action, extra]) => {
  const scope = window as unknown as { refs: Map<string, HTMLElement> };
  return window.PrivacyHarness.act({ action, refs: scope.refs, ...extra } as Parameters<typeof window.PrivacyHarness.act>[0]);
}, [action, extra] as const);

test('typing, choosing and clicking drive the page the way a person would', async ({ page }) => {
  const ids = await page.evaluate(() => (window as unknown as { scan: () => Record<string, string> }).scan());
  // Frameworks listen for input/change rather than reading .value on a timer,
  // so the events matter as much as the resulting value.
  const seen = await page.evaluate(([name, session]) => {
    const events: string[] = [];
    for (const type of ['input', 'change']) document.addEventListener(type, event => events.push(`${type}:${(event.target as HTMLElement).id}`), true);
    const scope = window as unknown as { refs: Map<string, HTMLElement> };
    const typed = window.PrivacyHarness.act({ action: { type: 'type', target: name, text: 'Demo Student' }, refs: scope.refs });
    const chosen = window.PrivacyHarness.act({ action: { type: 'choose', target: session, optionText: 'Morning' }, refs: scope.refs });
    return { typed, chosen, events };
  }, [ids.name, ids.session] as const);
  expect(seen.typed).toEqual({ ok: true });
  expect(seen.chosen).toEqual({ ok: true });
  expect(seen.events).toEqual(['input:name', 'change:name', 'input:session', 'change:session']);
  expect(await page.locator('#name').inputValue()).toBe('Demo Student');
  expect(await page.locator('#session').inputValue()).toBe('am');
  expect(await run(page, { type: 'click', target: ids.submit })).toEqual({ ok: true });
  await expect(page).toHaveTitle('submitted');
});

test('a select is matched on the visible option text, not an invented value', async ({ page }) => {
  const ids = await page.evaluate(() => (window as unknown as { scan: () => Record<string, string> }).scan());
  expect(await run(page, { type: 'choose', target: ids.session, optionText: 'afternoon' })).toEqual({ ok: true });
  expect(await page.locator('#session').inputValue()).toBe('pm');
  expect(await run(page, { type: 'choose', target: ids.session, optionText: 'Evening' })).toEqual({ error: 'ACTION_FAILED' });
  expect(await page.locator('#session').inputValue()).toBe('pm');
});

test('a reviewed profile link is activated from the server click action', async ({ page }) => {
  const ids = await page.evaluate(() => (window as unknown as { scan: () => Record<string, string> }).scan());
  expect(await run(page, { type: 'click', target: ids.profile })).toEqual({ ok: true });
  await expect(page).toHaveURL(/#profile-page$/);
});

test('literal server text cannot be keyed into a password field', async ({ page }) => {
  const ids = await page.evaluate(() => (window as unknown as { scan: () => Record<string, string> }).scan());
  expect(await run(page, { type: 'type', target: ids.secret, text: 'hunter2' })).toEqual({ error: 'TARGET_UNSAFE' });
  expect(await page.locator('#secret').inputValue()).toBe('');
  // The same field is reachable through an approved reference, which the vault
  // only mints for destinations it has already judged.
  expect(await run(page, { type: 'fill', target: ids.secret, valueRef: 'value_1' }, { resolved: 'from-vault' })).toEqual({ ok: true });
  expect(await page.locator('#secret').inputValue()).toBe('from-vault');
});

test('an element the page replaced or moved is refused rather than guessed at', async ({ page }) => {
  const ids = await page.evaluate(() => (window as unknown as { scan: () => Record<string, string> }).scan());
  const bounds = await page.evaluate(id => {
    const rect = (window as unknown as { refs: Map<string, HTMLElement> }).refs.get(id)!.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, ids.name);
  expect(await run(page, { type: 'type', target: ids.name, text: 'Demo' }, { expect: { role: 'textbox', bounds } })).toEqual({ ok: true });
  // Same ref, different geometry: the control the user reviewed is not the one
  // that would be typed into now.
  await page.evaluate(() => { document.getElementById('name')!.style.marginLeft = '120px'; });
  expect(await run(page, { type: 'type', target: ids.name, text: 'Demo' }, { expect: { role: 'textbox', bounds } })).toEqual({ error: 'TARGET_CHANGED' });
  // A ref from a retired scan resolves to nothing at all.
  expect(await run(page, { type: 'click', target: 'obs_9_e1' })).toEqual({ error: 'PAGE_CHANGED' });
});

test('a control hidden, disabled or covered after the scan is refused', async ({ page }) => {
  const ids = await page.evaluate(() => (window as unknown as { scan: () => Record<string, string> }).scan());
  await page.evaluate(() => { (document.getElementById('submit') as HTMLButtonElement).disabled = true; });
  expect(await run(page, { type: 'click', target: ids.submit })).toEqual({ error: 'TARGET_CHANGED' });
  await page.evaluate(() => {
    (document.getElementById('submit') as HTMLButtonElement).disabled = false;
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9';
    document.body.append(overlay);
  });
  expect(await run(page, { type: 'click', target: ids.submit })).toEqual({ error: 'TARGET_CHANGED' });
  await expect(page).not.toHaveTitle('submitted');
  await page.evaluate(() => { document.getElementById('name')!.style.display = 'none'; });
  expect(await run(page, { type: 'type', target: ids.name, text: 'Demo' })).toEqual({ error: 'TARGET_CHANGED' });
});

test('a custom editable widget receives text as an input event', async ({ page }) => {
  const ids = await page.evaluate(() => (window as unknown as { scan: () => Record<string, string> }).scan());
  const seen = await page.evaluate(async id => {
    const events: string[] = [];
    document.getElementById('notes')!.addEventListener('input', event => events.push((event as InputEvent).inputType ?? 'input'));
    const scope = window as unknown as { refs: Map<string, HTMLElement> };
    const result = window.PrivacyHarness.act({ action: { type: 'type', target: id, text: 'Prefers morning' }, refs: scope.refs });
    return { result, events, text: document.getElementById('notes')!.textContent };
  }, ids.notes);
  expect(seen.result).toEqual({ ok: true });
  expect(seen.text).toBe('Prefers morning');
  expect(seen.events).toEqual(['insertText']);
});

test('scroll and done need no target and touch no control', async ({ page }) => {
  await page.evaluate(() => { document.body.style.height = '4000px'; scrollTo(0, 0); });
  expect(await run(page, { type: 'scroll', direction: 'down', pixels: 400 })).toEqual({ ok: true });
  expect(await page.evaluate(() => scrollY)).toBe(400);
  expect(await run(page, { type: 'scroll', direction: 'up', pixels: 150 })).toEqual({ ok: true });
  expect(await page.evaluate(() => scrollY)).toBe(250);
  expect(await run(page, { type: 'done' })).toEqual({ ok: true });
});

test('a whole server reply runs its field entries and at most one page-touching step', async ({ page }) => {
  const ids = await page.evaluate(() => (window as unknown as { scan: () => Record<string, string> }).scan());
  const result = await page.evaluate(ids => {
    const request = { protocolVersion: 1 as const, requestId: 'request_1', taskId: 'task_1', observationId: 'obs_1',
      sanitizedInstruction: 'Register for the workshop',
      elements: [{ id: ids.name, role: 'textbox', description: 'Full name' }, { id: ids.submit, role: 'button', description: 'Submit' }],
      valueRefs: [] };
    const plan = window.PrivacyHarness.planActions({ thought: 'Fill the name, then submit.', output: [
      { action: 'type', id: ids.name, className: 'form-control', xpath: '//input[@id="name"]', value: 'Demo Student' },
      { action: 'click', id: ids.submit, className: null, xpath: null, value: null },
      { action: 'finish', id: null, className: null, xpath: null, value: null },
    ] }, request);
    if (!plan.ok) return { ok: false as const };
    const { runnable, deferred } = window.PrivacyHarness.executableNow(plan.steps);
    const scope = window as unknown as { refs: Map<string, HTMLElement> };
    const outcomes = runnable.map(step => window.PrivacyHarness.act({ action: step.action, refs: scope.refs }));
    return { ok: true as const, thought: plan.thought, outcomes, deferred: deferred.map(step => step.action.type),
      value: (document.getElementById('name') as HTMLInputElement).value, title: document.title };
  }, ids);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.outcomes).toEqual([{ ok: true }, { ok: true }]);
  expect(result.value).toBe('Demo Student');
  // Typing leaves the reviewed form in place, so the submit runs on the same
  // scan. `finish` waits for a fresh observation of the page the click left.
  expect(result.deferred).toEqual(['done']);
  expect(result.title).toBe('submitted');
});
