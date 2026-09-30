import { afterEach, describe, expect, it, vi } from 'vitest';
import { blankColumns, blankPieces, blankRows, blankStrips, inspectCapturedPage, inspectPage, pageSections } from '../../src/vision/page';
import type { PerceptionResult } from '../../src/vision/contracts';
import type { LocalObservation } from '../../src/contracts';
import { ResultCache } from '../../src/vision/reuse';

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

describe('strips read side by side', () => {
  // White rows, with ink (a dark pixel) on every row outside the blank ranges.
  const pixels = (width: number, height: number, blank: Array<[number, number]>) => {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) if (!blank.some(([from, to]) => y >= from && y < to)) data.fill(0, (y * width + 3) * 4, (y * width + 3) * 4 + 3);
    return data;
  };
  it('treats a row as blank only when every pixel matches its first', () => {
    const data = pixels(10, 3, [[0, 1], [2, 3]]);
    data[(2 * 10 + 9) * 4] = 250;
    expect(blankRows(data, 10, 3)).toEqual([true, false, true]);
    data[(2 * 10 + 9) * 4] = 200;
    expect(blankRows(data, 10, 3)).toEqual([true, false, false]);
  });
  it('cuts only through blank runs, giving each strip the run on its side as margin', () => {
    const section = { start: 0, end: 1000, y: 0, height: 1000 };
    const blank = Array.from({ length: 1000 }, (_, y) => [240, 490, 740].some(from => y >= from && y < from + 20));
    expect(blankStrips(section, blank, 4)).toEqual([
      { start: 0, end: 250, y: 0, height: 260 }, { start: 250, end: 500, y: 240, height: 270 },
      { start: 500, end: 750, y: 490, height: 270 }, { start: 750, end: 1000, y: 740, height: 260 }]);
    // Of a wide run, a crop keeps only 16 rows past the cut.
    const wide = Array.from({ length: 1000 }, (_, y) => y >= 300 && y < 700);
    expect(blankStrips(section, wide, 2)).toEqual([{ start: 0, end: 500, y: 0, height: 516 }, { start: 500, end: 1000, y: 484, height: 516 }]);
  });
  it('keeps a section whole when no blank run lies near a cut, and keeps its outer margins', () => {
    const section = { start: 100, end: 1000, y: 50, height: 1000 };
    expect(blankStrips(section, Array(900).fill(false), 4)).toEqual([section]);
    // Runs too narrow to leave a word any margin are not cuts either.
    expect(blankStrips(section, Array.from({ length: 900 }, (_, y) => y === 450), 2)).toEqual([section]);
    const blank = Array.from({ length: 900 }, (_, y) => y >= 440 && y < 460);
    expect(blankStrips(section, blank, 2)).toEqual([{ start: 100, end: 550, y: 50, height: 510 }, { start: 550, end: 1000, y: 540, height: 510 }]);
  });
  it('reads strips on several lanes at once and keeps each word once at page coordinates', async () => {
    const data = pixels(200, 600, [[190, 210], [390, 410]]);
    vi.stubGlobal('OffscreenCanvas', class { width = 0; height = 0;
      getContext() { return { drawImage: vi.fn(), getImageData: () => ({ data }) }; } });
    const crops: number[] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async (_image, _x, y: number) => { crops.push(y); return { close: vi.fn() }; }));
    let running = 0, most = 0;
    const inspect = vi.fn(async ({ image }: { image: ImageBitmap }) => {
      const y = crops[inspect.mock.calls.findIndex(([input]) => input.image === image)];
      running++; most = Math.max(most, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      // Every strip reports a word near its top; the middle one also sees its neighbour's.
      return { observationId: 'obs', source: 'model' as const, regions: y === 190 ? [text(15), text(215)] : [text(15)], elapsedMs: 1 };
    });
    const partial = vi.fn();
    const result = await inspectPage(image, 200, 600, 600, 'obs', { inspect, lanes: 3 }, new AbortController().signal, partial);
    expect(crops).toEqual([0, 190, 390]);
    expect(most).toBe(3);
    expect(result.regions).toEqual([text(15), text(205), text(405)]);
    expect(partial).toHaveBeenCalledTimes(3);
  });
  it('treats a column as blank only over the rows it is asked about', () => {
    // Ink at x=1 on row 0 only.
    const data = new Uint8ClampedArray(3 * 3 * 4).fill(255);
    data.fill(0, 4, 7);
    expect(blankColumns(data, 3, 0, 3)).toEqual([true, false, true]);
    expect(blankColumns(data, 3, 1, 2)).toEqual([true, true, true]);
  });
  it('cuts a strip into columns through blank columns only', () => {
    const strip = { start: 250, end: 500, y: 240, height: 270 };
    const blank = Array.from({ length: 800 }, (_, x) => x >= 390 && x < 410);
    expect(blankPieces(strip, blank, 800, 2)).toEqual([{ ...strip, left: 0, right: 400, x: 0, width: 410 },
      { ...strip, left: 400, right: 800, x: 390, width: 410 }]);
    expect(blankPieces(strip, Array(800).fill(false), 800, 2)).toEqual([{ ...strip, left: 0, right: 800, x: 0, width: 800 }]);
  });
  it('reads side-by-side columns when a screen has no blank rows', async () => {
    // Text-like ink at the left and right edges, with every row inked and
    // columns 15–585 blank.
    const width = 600, height = 400, data = new Uint8ClampedArray(width * height * 4).fill(255);
    for (let y = 0; y < height; y++) for (const x of [10 + y % 5, 589 - y % 5]) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    vi.stubGlobal('OffscreenCanvas', class { width = 0; height = 0;
      getContext() { return { drawImage: vi.fn(), getImageData: () => ({ data }) }; } });
    const crops: number[][] = [];
    vi.stubGlobal('createImageBitmap', vi.fn(async (_image, x: number, y: number, w: number, h: number) => { crops.push([x, y, w, h]); return { close: vi.fn() }; }));
    const word = (x: number, width = 40) => ({ kind: 'text' as const, text: 'word', bounds: { x, y: 50, width, height: 20 } });
    // The gap's middle is x=300, and each crop keeps 16 blank columns past it.
    // A box the right piece reports left of the cut belongs to the left piece.
    const inspect = vi.fn().mockResolvedValueOnce({ observationId: 'obs', source: 'model', regions: [word(20)], elapsedMs: 1 })
      .mockResolvedValueOnce({ observationId: 'obs', source: 'model', regions: [word(0, 10), word(100)], elapsedMs: 1 });
    const result = await inspectPage(image, width, height, height, 'obs', { inspect, lanes: 2 }, new AbortController().signal, () => {});
    expect(crops).toEqual([[0, 0, 316, 400], [284, 0, 316, 400]]);
    expect(result.regions).toEqual([word(20), word(384)]);
  });
  it('stops the other lanes when one strip fails', async () => {
    const data = pixels(200, 600, [[190, 210], [390, 410]]);
    vi.stubGlobal('OffscreenCanvas', class { width = 0; height = 0;
      getContext() { return { drawImage: vi.fn(), getImageData: () => ({ data }) }; } });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    const stopped: boolean[] = [];
    const inspect = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('OCR_TIMEOUT'); })
      .mockImplementation((_input, signal: AbortSignal) => new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => { stopped.push(true); reject(new Error('STOPPED')); })));
    await expect(inspectPage(image, 200, 600, 600, 'obs', { inspect, lanes: 3 }, new AbortController().signal, () => {}))
      .rejects.toThrow('OCR_TIMEOUT');
    expect(stopped).toEqual([true, true]);
  });
});

describe('detector results reused for unchanged tile pixels', () => {
  const observation = (screenshots: string[], observationId = 'obs'): LocalObservation => ({
    dom: { observationId, documentId: 'doc', revision: 0, origin: 'https://example.test',
      viewport: { width: 200, height: 600, devicePixelRatio: 1, scrollX: 0, scrollY: 0, visualScale: 1, offsetX: 0, offsetY: 0 },
      elements: [], hiddenCount: 0, truncated: false },
    captureBounds: { x: 0, y: 0, width: 200, height: 200 }, imageWidth: 200, imageHeight: 200, tileCount: 2, captureMs: 1, domMs: 1,
    tiles: [{ screenshot: screenshots[0], width: 200, height: 125, y: 0, start: 0, end: 100 },
      { screenshot: screenshots[1], width: 200, height: 125, y: 75, start: 100, end: 200 }],
  });
  it('answers an identical tile from the cache and inspects a changed one again', async () => {
    vi.stubGlobal('Image', class { src = ''; async decode() {} });
    vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close: vi.fn() }));
    const inspect = vi.fn().mockImplementation(async () => ({ regions: [text(15)], elapsedMs: 5 }));
    const cache = new ResultCache<PerceptionResult>();
    const signal = new AbortController().signal;
    const first = await inspectCapturedPage(observation(['first', 'second']), { inspect }, signal, vi.fn(), vi.fn(), cache);
    expect(inspect).toHaveBeenCalledTimes(2);
    const progress = vi.fn(), partial = vi.fn();
    const again = await inspectCapturedPage(observation(['first', 'second'], 'obs_2'), { inspect }, signal, partial, progress, cache);
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(again).toEqual({ ...first, observationId: 'obs_2', elapsedMs: 0 });
    expect(progress.mock.calls).toEqual([[0, 2], [1, 2]]);
    expect(partial).toHaveBeenCalledTimes(2);
    expect(cache.hits).toBe(2);
    // One changed tile is inspected again; the other is still reused.
    await inspectCapturedPage(observation(['first', 'changed']), { inspect }, signal, vi.fn(), vi.fn(), cache);
    expect(inspect).toHaveBeenCalledTimes(3);
  });
  it('keeps a bounded number of entries, evicting the least recently used', () => {
    const cache = new ResultCache<number>(2);
    cache.set('a', 1); cache.set('b', 2);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3);
    expect(cache.get('b')).toBeUndefined();
    expect([cache.get('a'), cache.get('c'), cache.size]).toEqual([1, 3, 2]);
    cache.clear();
    expect([cache.size, cache.hits]).toEqual([0, 0]);
  });
});
