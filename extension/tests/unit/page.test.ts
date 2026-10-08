import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectCapturedPage, inspectPage, pageSections } from '../../src/vision/page';
import type { PerceptionResult } from '../../src/vision/contracts';
import type { LocalObservation } from '../../src/contracts';

afterEach(() => { vi.unstubAllGlobals(); });
const image = {} as HTMLImageElement;
const text = (y: number, value = 'faculty'): PerceptionResult['regions'][number] => ({
  kind: 'text', text: value, bounds: { x: 10, y, width: 50, height: 20 },
});

describe('analysis across capture tiles', () => {
  const observation: LocalObservation = {
    dom: { observationId: 'obs', documentId: 'doc', revision: 0, origin: 'https://example.test',
      viewport: { width: 200, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0, visualScale: 1, offsetX: 0, offsetY: 0 },
      elements: [], hiddenCount: 0, truncated: false },
    captureBounds: { x: 0, y: 0, width: 200, height: 200 }, imageWidth: 200, imageHeight: 200, tileCount: 2, captureMs: 1, domMs: 1,
    tiles: [{ screenshot: 'first', width: 200, height: 125, y: 0, start: 0, end: 100 },
      { screenshot: 'second', width: 200, height: 125, y: 75, start: 100, end: 200 }],
  };
  it('decodes one tile at a time and keeps a boundary word and face exactly once at page coordinates', async () => {
    const decoded: Array<{ src: string }> = [];
    vi.stubGlobal('Image', class {
      src = '';
      async decode() { expect(decoded.every(image => !image.src)).toBe(true); decoded.push(this); }
    });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    const face = (y: number): PerceptionResult['regions'][number] => ({ kind: 'face', bounds: { x: 80, y, width: 20, height: 20 } });
    const inspect = vi.fn().mockResolvedValueOnce({ regions: [text(90), face(90)], elapsedMs: 10 })
      .mockResolvedValueOnce({ regions: [text(15), face(15), text(90, 'bottom')], elapsedMs: 20 });
    const partial = vi.fn(), progress = vi.fn();
    const result = await inspectCapturedPage(observation, { inspect }, new AbortController().signal, partial, progress);
    expect(result.regions).toEqual([text(90), face(90), text(165, 'bottom')]);
    expect(result.elapsedMs).toBe(30);
    expect(partial).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls).toEqual([[0, 2], [1, 2]]);
    expect(decoded).toHaveLength(2);
    expect(decoded.every(image => !image.src)).toBe(true);
  });
  it('releases the source tile and never decodes the next one after Stop', async () => {
    const controller = new AbortController(), decoded: Array<{ src: string }> = [];
    vi.stubGlobal('Image', class { src = ''; async decode() { decoded.push(this); } });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    const inspect = vi.fn().mockResolvedValue({ regions: [], elapsedMs: 1 });
    await expect(inspectCapturedPage(observation, { inspect }, controller.signal, () => controller.abort())).rejects.toThrow('STOPPED');
    expect(decoded).toHaveLength(1);
    expect(decoded[0].src).toBe('');
    expect(inspect).toHaveBeenCalledOnce();
  });
});
describe('sectioned full-page analysis', () => {
  it('covers the entire page with bounded crops and no gaps in ownership', () => {
    const bands = pageSections(1200, 8000, 900);
    expect(bands[0].start).toBe(0);
    expect(bands.at(-1)!.end).toBe(8000);
    for (const [i, band] of bands.entries()) {
      expect(band.y).toBeLessThanOrEqual(band.start);
      expect(band.y + band.height).toBeGreaterThanOrEqual(band.end);
      expect(band.height).toBeLessThanOrEqual(1350);
      if (i) expect(bands[i - 1].end).toBe(band.start);
    }
  });
  it('publishes early results, keeps overlap detections once, and translates their coordinates', async () => {
    const partial = vi.fn();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap));
    const inspect = vi.fn().mockImplementationOnce(async () => ({ observationId: 'obs', source: 'model', regions: [text(90)], elapsedMs: 10 }))
      .mockImplementationOnce(async () => {
        expect(partial).toHaveBeenCalledOnce();
        return { observationId: 'obs', source: 'model', regions: [text(15)], elapsedMs: 20 };
      });
    // The word straddles the y=100 band boundary; both crops see it.
    const result = await inspectPage(image, 200, 200, 100, 'obs', { inspect }, new AbortController().signal, partial);
    expect(result.regions).toEqual([text(90)]);
    expect(result.elapsedMs).toBe(30);
    expect(partial).toHaveBeenCalledTimes(2);
    expect(createImageBitmap).toHaveBeenNthCalledWith(1, image, 0, 0, 200, 125);
    expect(createImageBitmap).toHaveBeenNthCalledWith(2, image, 0, 75, 200, 125);
  });
  it('can aggregate more than the per-inference 500-word limit without dropping page results', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    const inspect = vi.fn().mockResolvedValue({ observationId: 'obs', source: 'model', regions: Array.from({ length: 300 }, () => text(40)), elapsedMs: 1 });
    const result = await inspectPage(image, 200, 200, 100, 'obs', { inspect }, new AbortController().signal, () => {});
    expect(result.regions).toHaveLength(600);
  });
  it('Stop prevents allocation or inference for the remaining page', async () => {
    const controller = new AbortController();
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    const inspect = vi.fn().mockResolvedValue({ observationId: 'obs', source: 'model', regions: [], elapsedMs: 1 });
    await expect(inspectPage(image, 200, 1000, 100, 'obs', { inspect }, controller.signal, () => controller.abort())).rejects.toThrow('STOPPED');
    expect(inspect).toHaveBeenCalledOnce();
    expect(createImageBitmap).toHaveBeenCalledOnce();
  });
  it('releases a crop if stopped during asynchronous bitmap creation', async () => {
    const controller = new AbortController(), close = vi.fn(), inspect = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn().mockImplementation(async () => { controller.abort(); return { close }; }));
    await expect(inspectPage(image, 200, 1000, 100, 'obs', { inspect }, controller.signal, () => {})).rejects.toThrow('STOPPED');
    expect(close).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
  });
});
