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
});

for (const scale of [1, 1.25, 2]) test(`opaque text/face/document masks across tiles at scale ${scale}`, async ({ page }) => {
  const result = await page.evaluate(async scale => {
    const h = window.PrivacyHarness, data = h.visualFixture(scale), before = data.observation.tiles.map(t => t.screenshot);
    const plan = h.normalize(data, new h.Placeholders());
    const result = await h.buildSafeStepRequest({ data, signal: new AbortController().signal, current: () => data.binding });
    if (!result.ok || !result.request.sanitizedImage) return { ok: false, result };
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(result.request.sanitizedImage.base64), c => c.charCodeAt(0))], { type: 'image/png' }));
    const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0); image.close();
    let opaque = true;
    for (const { bounds: b } of plan.masks) {
      const pixels = context.getImageData(Math.ceil(b.x), Math.ceil(b.y), Math.floor(b.width), Math.floor(b.height)).data;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] !== 0 || pixels[i + 1] !== 0 || pixels[i + 2] !== 0 || pixels[i + 3] !== 255) opaque = false;
    }
    const publicPixel = [...context.getImageData(190 * scale, 40 * scale, 1, 1).data];
    const json = JSON.stringify(result.request);
    const leaks = ['mira@example.test', '9876543210', 'ABCDE1234F', 'rawOcr', 'screenshot', 'expiresAt', ...before.map(s => s.slice(22))].some(raw => json.includes(raw));
    const unchanged = before.every((raw, i) => raw === data.observation.tiles[i].screenshot);
    canvas.width = 0; canvas.height = 0;
    return { ok: true, opaque, publicPixel, leaks, unchanged, keys: Object.keys(result.request), count: result.summary };
  }, scale);
  expect(result.ok).toBe(true); expect(result.opaque).toBe(true); expect(result.leaks).toBe(false); expect(result.unchanged).toBe(true);
  expect(result.publicPixel).toEqual([255, 255, 255, 255]);
  expect(result.count?.faces).toBe(1); expect(result.count?.documents).toBe(1);
});

test('long-page masking bounds allocations, repaints downscaled masks and preserves focus/scroll', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = window.PrivacyHarness, data = h.visualFixture(1, true), allocations: number[] = [], canvases: OffscreenCanvas[] = [];
    document.querySelector<HTMLInputElement>('#name')!.focus(); scrollTo(0, 100);
    const before = { x: scrollX, y: scrollY, focus: document.activeElement?.id };
    const Native = window.OffscreenCanvas;
    window.OffscreenCanvas = class extends Native { constructor(w: number, h: number) { super(w, h); allocations.push(w * h); canvases.push(this); } };
    const output = await h.buildSafeStepRequest({ data, signal: new AbortController().signal, current: () => data.binding });
    window.OffscreenCanvas = Native;
    if (!output.ok || !output.request.sanitizedImage) return { ok: false, output };
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(output.request.sanitizedImage.base64), c => c.charCodeAt(0))], { type: 'image/png' }));
    const canvas = new Native(image.width, image.height), context = canvas.getContext('2d')!; context.drawImage(image, 0, 0); image.close();
    const sx = canvas.width / data.observation.imageWidth, sy = canvas.height / data.observation.imageHeight;
    const masked = data.ocr.result!.regions.every(({ bounds: b }) => {
      const pixel = context.getImageData(Math.floor((b.x + b.width / 2) * sx), Math.floor((b.y + b.height / 2) * sy), 1, 1).data;
      return pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0 && pixel[3] === 255;
    });
    const summaryPixels = canvas.width * canvas.height; canvas.width = 0; canvas.height = 0;
    return { ok: true, masked, summaryPixels, maxAllocation: Math.max(...allocations), count: data.observation.tileCount,
      released: canvases.every(c => c.width === 0 && c.height === 0), before, after: { x: scrollX, y: scrollY, focus: document.activeElement?.id } };
  });
  expect(result.ok).toBe(true); expect(result.masked).toBe(true); expect(result.count).toBeGreaterThan(1);
  expect(result.maxAllocation).toBeLessThanOrEqual(1_000_000); expect(result.summaryPixels).toBeLessThanOrEqual(1_000_000);
  expect(result.released).toBe(true); expect(result.after).toEqual(result.before);
});

for (const stage of ['decode', 'mask', 'encode'] as const) test(`Stop during ${stage} discards output, releases buffers, and permits a clean retry`, async ({ page }) => {
  const result = await page.evaluate(async stage => {
    const h = window.PrivacyHarness, data = h.visualFixture(), controller = new AbortController();
    const nativeDecode = window.createImageBitmap, nativeEncode = OffscreenCanvas.prototype.convertToBlob;
    const nativeFill = OffscreenCanvasRenderingContext2D.prototype.fillRect;
    const Native = window.OffscreenCanvas, canvases: OffscreenCanvas[] = [];
    window.OffscreenCanvas = class extends Native { constructor(w: number, h: number) { super(w, h); canvases.push(this); } };
    let calls = 0;
    if (stage === 'decode') window.createImageBitmap = (async (...args: Parameters<typeof createImageBitmap>) => {
      calls++; controller.abort(); await new Promise(resolve => setTimeout(resolve, 20));
      return nativeDecode(...args);
    }) as typeof createImageBitmap;
    if (stage === 'encode') OffscreenCanvas.prototype.convertToBlob = async function(options) {
      calls++; const output = nativeEncode.call(this, options); controller.abort();
      await new Promise(resolve => setTimeout(resolve, 20)); return output;
    };
    if (stage === 'mask') OffscreenCanvasRenderingContext2D.prototype.fillRect = function(...args) {
      nativeFill.apply(this, args); calls++; if (calls === 3) controller.abort();
    };
    const stopped = await h.buildSafeStepRequest({ data, signal: controller.signal, current: () => data.binding });
    window.createImageBitmap = nativeDecode; OffscreenCanvas.prototype.convertToBlob = nativeEncode;
    OffscreenCanvasRenderingContext2D.prototype.fillRect = nativeFill; window.OffscreenCanvas = Native;
    const retry = await h.buildSafeStepRequest({ data, signal: new AbortController().signal, current: () => data.binding });
    await new Promise(resolve => setTimeout(resolve, 30));
    return { stopped, retried: retry.ok, calls, released: canvases.every(c => !c.width && !c.height) };
  }, stage);
  expect(result.stopped).toMatchObject({ ok: false, blockedReasons: ['STOPPED'] }); expect(result.retried).toBe(true);
  expect(result.calls).toBeGreaterThan(0); expect(result.released).toBe(true);
});

test('incomplete coverage, late invalidation, failed masking and oversized encoding fail closed', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = window.PrivacyHarness;
    const run = (data: ReturnType<typeof h.fixture>, current = () => data.binding) => h.buildSafeStepRequest({ data, signal: new AbortController().signal, current });
    const incomplete = h.visualFixture(); incomplete.ocr.status = 'incomplete';
    const timeout = h.visualFixture(); timeout.faces.result = undefined;
    const truncated = h.visualFixture(); truncated.ocr.truncated = true;
    const missing = h.visualFixture(); missing.observation.tiles.pop();
    const invalid = h.visualFixture(); invalid.faces.result!.regions[0].bounds.x = -1;
    const results = await Promise.all([incomplete, timeout, truncated, missing, invalid].map(data => run(data)));
    const nativeEncode = OffscreenCanvas.prototype.convertToBlob;
    const oversized = h.visualFixture();
    OffscreenCanvas.prototype.convertToBlob = async () => new Blob([new Uint8Array(3_000_001)], { type: 'image/png' });
    results.push(await run(oversized)); oversized.image = 'optional'; const withheld = await run(oversized);
    const stale = h.visualFixture(); let active = true;
    OffscreenCanvas.prototype.convertToBlob = async function(options) { const blob = await nativeEncode.call(this, options); active = false; return blob; };
    results.push(await run(stale, () => ({ ...stale.binding, generation: active ? 1 : 2 })));
    OffscreenCanvas.prototype.convertToBlob = async () => { throw new Error('fictional-secret-42'); };
    results.push(await run(h.visualFixture()));
    OffscreenCanvas.prototype.convertToBlob = nativeEncode;
    return { results, withheld, leakedError: JSON.stringify(results).includes('fictional-secret-42') };
  });
  expect(result.results.every(r => !r.ok)).toBe(true); expect(result.leakedError).toBe(false);
  expect(result.withheld.ok && result.withheld.decision).toBe('safe_without_image');
  if (result.withheld.ok) expect(result.withheld.request.sanitizedImage).toBeUndefined();
});

test('document model boxes retain both tile overlaps and mask a multi-tile document', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = window.PrivacyHarness, data = h.visualFixture(1, true);
    let calls = 0;
    data.documents = await h.inspectDocumentTiles(data.observation, { inspect: async ({ observationId, image }) => {
      calls++;
      const box = { x: 0, y: 0, width: image.width, height: image.height }; image.close();
      return { observationId, truncated: false, detections: [{ type: 'financial_document', source: 'vision_model', confidence: .01, bbox: box }] };
    } }, new AbortController().signal);
    const plan = h.normalize(data, new h.Placeholders());
    const result = await h.buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal });
    return { ok: result.ok, calls, tiles: data.observation.tileCount, masks: plan.masks };
  });
  expect(result.ok).toBe(true);
  expect(result.calls).toBe(result.tiles);
  expect(result.masks).toHaveLength(1);
  expect(result.masks[0].bounds).toEqual({ x: 0, y: 0, width: 200, height: 40000 });
});

test('document adapter rejects failure, stale output, malformed bounds and cancellation', async ({ page }) => {
  const failures = await page.evaluate(async () => {
    const h = window.PrivacyHarness, data = h.visualFixture();
    const failures: string[] = [];
    for (const mode of ['failure', 'stale', 'bounds', 'stop']) {
      const abort = new AbortController();
      try {
        await h.inspectDocumentTiles(data.observation, { inspect: async ({ observationId, image }) => {
          image.close();
          if (mode === 'failure') throw new Error('private-model-error');
          if (mode === 'stop') abort.abort();
          return { observationId: mode === 'stale' ? 'other' : observationId, truncated: false,
            detections: [{ type: 'signature', source: 'vision_model', confidence: .7, bbox: { x: -1, y: 1, width: 5, height: 5 } }] };
        } }, abort.signal);
      } catch (error) { failures.push((error as Error).message); }
    }
    return failures;
  });
  expect(failures).toHaveLength(4);
  expect(failures).not.toContain('private-model-error');
  expect(failures.at(-1)).toBe('STOPPED');
});

for (const corruption of ['white', 'transparent', 'dimensions']) test(`encoded-output verification blocks ${corruption} mask corruption`, async ({ page }) => {
  const result = await page.evaluate(async corruption => {
    const h = window.PrivacyHarness, data = h.visualFixture();
    data.image = 'optional'; // Verification failure must not be downgraded to success.
    const encode = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = async function(options) {
      const canvas = new OffscreenCanvas(this.width + (corruption === 'dimensions' ? 1 : 0), this.height), context = canvas.getContext('2d')!;
      context.drawImage(this, 0, 0);
      if (corruption === 'white') { context.fillStyle = '#fff'; context.fillRect(20, 95, 1, 1); }
      else if (corruption === 'transparent') context.clearRect(20, 95, 1, 1);
      try { return await encode.call(canvas, options); } finally { canvas.width = 0; canvas.height = 0; }
    };
    try { return await h.buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal }); }
    finally { OffscreenCanvas.prototype.convertToBlob = encode; }
  }, corruption);
  expect(result).toMatchObject({ ok: false, blockedReasons: ['VERIFICATION_FAILED'] });
});

test('optional OCR verifies sanitized output and blocks remaining PII, failures and stale results', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const h = window.PrivacyHarness, results = [];
    for (const mode of ['safe', 'pii', 'failure', 'stale']) {
      const data = h.visualFixture();
      results.push(await h.buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal,
        verificationOcr: { inspect: async ({ image, observationId }) => {
          image.close();
          if (mode === 'failure') throw new Error('mira@example.test');
          return { observationId: mode === 'stale' ? 'old' : observationId, source: 'model', elapsedMs: 1,
            regions: mode === 'pii' ? [{ kind: 'text', confidence: .9, text: 'mira@example.test', bounds: { x: 1, y: 1, width: 10, height: 10 } }] : [] };
        } } }));
    }
    return results;
  });
  expect(results[0].ok).toBe(true);
  for (const result of results.slice(1)) expect(result).toMatchObject({ ok: false, blockedReasons: ['VERIFICATION_FAILED'] });
  expect(JSON.stringify(results)).not.toContain('mira@example.test');
});

test('DOM visual metadata covers offscreen containers without copying raw attributes or control values', async ({ page }) => {
  const evidence = await page.evaluate(() => {
    document.body.innerHTML = `<input value="fictional-input-secret" title="fictional-title-secret" data-private="fictional-data-secret">
      <textarea>fictional-textarea-secret</textarea><select><option selected>fictional-option-secret</option></select>
      <div id="description">fictional-description-secret</div><input aria-describedby="description">
      <img alt="Aadhaar fictional-image-secret" width="100" height="100" style="position:absolute;top:2000px">
      <canvas title="signature fictional-signature-secret" width="100" height="40"></canvas>
      <div style="width:100px;height:100px;background-image:url('data:image/png;base64,eA==')"></div>`;
    const snapshot = window.PrivacyHarness.collect('observation', 'document', 0, new Map());
    return { json: JSON.stringify(snapshot), regions: snapshot.visualRegions };
  });
  for (const raw of ['input', 'title', 'data', 'textarea', 'option', 'description', 'image', 'signature'])
    expect(evidence.json).not.toContain(`fictional-${raw}-secret`);
  expect(evidence.regions?.some(r => r.category === 'aadhaar_card' && r.bounds.y >= 2000)).toBe(true);
  expect(evidence.regions?.some(r => r.category === 'signature')).toBe(true);
  expect(evidence.regions!.length).toBeGreaterThanOrEqual(7);
});

test('the filled flag reports that a control holds input, never the input itself', async ({ page }) => {
  const elements = await page.evaluate(() => {
    document.body.innerHTML = `<input id="empty" placeholder="Full name">
      <input id="typed" value="fictional-typed-secret"><textarea id="blank"></textarea>
      <input id="unchecked" type="checkbox"><input id="checked" type="checkbox" checked>
      <select id="chosen"><option selected>fictional-option-secret</option></select>
      <button id="press">Submit</button><a id="away" href="/next">Next</a>
      <div id="widget" role="textbox" style="width:120px;height:20px">fictional-widget-secret</div>
      <div id="idle" role="textbox" style="width:120px;height:20px"></div>`;
    const refs = new Map<string, HTMLElement>();
    const snapshot = window.PrivacyHarness.collect('observation', 'document', 0, refs);
    const named = new Map([...refs].map(([id, element]) => [element.id, snapshot.elements.find(e => e.id === id)!.filled]));
    return { filled: Object.fromEntries(named), json: JSON.stringify(snapshot) };
  });
  expect(elements.filled).toEqual({ empty: false, typed: true, blank: false, unchecked: false, checked: true,
    chosen: true, press: false, away: false, widget: true, idle: false });
  for (const raw of ['typed', 'option', 'widget']) expect(elements.json).not.toContain(`fictional-${raw}-secret`);
});

test('context mode preserves safe page pixels while masking PII; strict mode masks the same OCR line', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const h = window.PrivacyHarness, data = h.visualFixture();
    const source = document.createElement('canvas'); source.width = 200; source.height = 200;
    const sourceContext = source.getContext('2d')!;
    sourceContext.fillStyle = '#ffffff'; sourceContext.fillRect(0, 0, 200, 200);
    sourceContext.fillStyle = '#d0e8ff'; sourceContext.fillRect(130, 20, 60, 20);
    sourceContext.fillStyle = '#000000'; sourceContext.font = '10px sans-serif';
    sourceContext.fillText('Workshop application', 130, 35);
    sourceContext.fillText('mira@example.test', 10, 70);
    data.observation.tiles = data.observation.tiles.map(tile => {
      const crop = document.createElement('canvas'); crop.width = tile.width; crop.height = tile.height;
      crop.getContext('2d')!.drawImage(source, 0, tile.y);
      const screenshot = crop.toDataURL('image/png'); crop.width = 0; crop.height = 0;
      return { ...tile, screenshot };
    });
    data.ocr.result!.regions = [
      { kind: 'text', text: 'Workshop application', confidence: .99, bounds: { x: 130, y: 20, width: 60, height: 20 } },
      { kind: 'text', text: 'mira@example.test', confidence: .99, bounds: { x: 10, y: 60, width: 100, height: 15 } },
    ];
    data.documents = h.detectLocalDocuments(data.observation, data.ocr.result!, 'sensitive_only');
    data.ocrTextPolicy = 'sensitive_only';
    const run = async () => {
      const result = await h.buildSafeStepRequest({ data, current: () => data.binding, signal: new AbortController().signal });
      if (!result.ok || !result.request.sanitizedImage) return { ok: false };
      const image = await createImageBitmap(new Blob([Uint8Array.from(atob(result.request.sanitizedImage.base64), c => c.charCodeAt(0))], { type: 'image/png' }));
      const output = new OffscreenCanvas(image.width, image.height), ctx = output.getContext('2d')!;
      ctx.drawImage(image, 0, 0); image.close();
      const contextPixel = [...ctx.getImageData(132, 22, 1, 1).data];
      const piiPixel = [...ctx.getImageData(30, 67, 1, 1).data];
      output.width = 0; output.height = 0;
      return { ok: true, contextPixel, piiPixel };
    };
    const context = await run();
    data.ocrTextPolicy = 'all_text';
    const strict = await run();
    source.width = 0; source.height = 0;
    return { context, strict };
  });
  expect(result.context.ok).toBe(true);
  expect(result.context.contextPixel).toEqual([208, 232, 255, 255]);
  expect(result.context.piiPixel).toEqual([0, 0, 0, 255]);
  expect(result.strict.contextPixel).toEqual([0, 0, 0, 255]);
});
