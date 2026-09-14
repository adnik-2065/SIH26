import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectPage, pageSections } from '../../src/vision/page';
import type { PerceptionResult } from '../../src/vision/contracts';

afterEach(() => { vi.unstubAllGlobals(); });
const image = {} as HTMLImageElement;
const text = (y: number, value = 'faculty'): PerceptionResult['regions'][number] => ({
  kind: 'text', text: value, bounds: { x: 10, y, width: 50, height: 20 },
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
