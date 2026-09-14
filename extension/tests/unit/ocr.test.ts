import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Page } from 'tesseract.js';
import { normalizeOcr } from '../../src/vision/ocr/normalize';
import { TesseractAdapter } from '../../src/vision/ocr/tesseract';

function data(words = [{ text: 'student@example.test', confidence: 96, bbox: { x0: 210, y0: 320, x1: 390, y1: 345 } }]) {
  return { blocks: [{ paragraphs: [{ lines: [{ words }] }] }] } as unknown as Pick<Page, 'blocks'>;
}
const result = () => normalizeOcr(data(), 'obs_1', 800, 600, 12);

describe('OCR normalization', () => {
  it('converts real word fields to original-pixel boxes and 0–1 confidence', () => {
    expect(result()).toEqual({ observationId: 'obs_1', source: 'model', elapsedMs: 12, regions: [
      { kind: 'text', text: 'student@example.test', confidence: .96, bounds: { x: 210, y: 320, width: 180, height: 25 } },
    ] });
  });
  it('distinguishes no text from missing layout output', () => {
    expect(normalizeOcr({ blocks: [] }, 'obs_1', 800, 600, 0).regions).toEqual([]);
    expect(() => normalizeOcr({ blocks: null }, 'obs_1', 800, 600, 0)).toThrow('OCR_LAYOUT_MISSING');
  });
  it('rejects out-of-image coordinates, invalid confidence, and overflowing output', () => {
    expect(() => normalizeOcr(data(), 'obs_1', 100, 100, 0)).toThrow('OCR_INVALID_BOUNDS');
    expect(() => normalizeOcr(data([{ text: 'word', confidence: 101, bbox: { x0: 0, y0: 0, x1: 2, y1: 2 } }]), 'obs_1', 10, 10, 0)).toThrow();
    const word = { text: 'word', confidence: 99, bbox: { x0: 0, y0: 0, x1: 2, y1: 2 } };
    expect(() => normalizeOcr(data(Array.from({ length: 501 }, () => word)), 'obs_1', 10, 10, 0)).toThrow('OCR_TOO_MUCH_TEXT');
  });
});

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  reply(data: unknown) { this.onmessage?.({ data }); }
}
function setup() {
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } });
  const image = { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap;
  return { image, observationId: 'obs_1' };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeWorker.instances = []; });
describe('OCR worker lifecycle', () => {
  it('reuses a successful worker and closes input bitmaps', async () => {
    const input = setup(), adapter = new TesseractAdapter();
    const first = adapter.inspect(input, new AbortController().signal);
    FakeWorker.instances[0].reply({ type: 'result', result: result() });
    await expect(first).resolves.toEqual(result());
    const second = adapter.inspect(input, new AbortController().signal);
    FakeWorker.instances[0].reply({ type: 'result', result: result() });
    await second;
    expect(FakeWorker.instances).toHaveLength(1);
    expect(input.image.close).toHaveBeenCalledTimes(2);
    adapter.dispose();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it('cancels during startup, ignores late responses, and creates a fresh worker', async () => {
    const input = setup(), adapter = new TesseractAdapter(), controller = new AbortController();
    const pending = adapter.inspect(input, controller.signal);
    const rejected = expect(pending).rejects.toThrow('STOPPED');
    controller.abort();
    await rejected;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    FakeWorker.instances[0].reply({ type: 'result', result: result() });
    const next = adapter.inspect(input, new AbortController().signal);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].reply({ type: 'result', result: result() });
    await next; adapter.dispose();
  });
  it('times out and terminates a hung worker', async () => {
    vi.useFakeTimers();
    const input = setup(), adapter = new TesseractAdapter(() => {}, 100);
    const pending = expect(adapter.inspect(input, new AbortController().signal)).rejects.toThrow('OCR_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(input.image.close).toHaveBeenCalledOnce();
  });
  it('rejects stale observation IDs and cleans up after errors', async () => {
    const input = setup(), adapter = new TesseractAdapter();
    const pending = adapter.inspect(input, new AbortController().signal);
    FakeWorker.instances[0].reply({ type: 'result', result: { ...result(), observationId: 'old' } });
    await expect(pending).rejects.toThrow('OCR_INVALID_RESULT');
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it('closes already aborted inputs and rejects concurrent scans', async () => {
    const input = setup(), adapter = new TesseractAdapter(), controller = new AbortController();
    controller.abort();
    await expect(adapter.inspect(input, controller.signal)).rejects.toThrow('STOPPED');
    expect(FakeWorker.instances).toHaveLength(0);
    const pending = adapter.inspect(input, new AbortController().signal);
    await expect(adapter.inspect(setup(), new AbortController().signal)).rejects.toThrow('OCR_BUSY');
    const rejected = expect(pending).rejects.toThrow('STOPPED');
    adapter.dispose(); await rejected;
  });
});
