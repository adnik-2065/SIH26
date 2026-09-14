import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Detection } from '@mediapipe/tasks-vision';
import { normalizeFaces } from '../../src/vision/face/normalize';
import { MediaPipeAdapter } from '../../src/vision/face/mediapipe';

const detection = (originX = 10): Detection => ({ boundingBox: { originX, originY: 20, width: 60, height: 80, angle: 0 }, categories: [{ score: .9, index: 0, categoryName: '', displayName: '' }], keypoints: [] });
const result = () => normalizeFaces([detection()], 'obs_1', 800, 600, 12);

describe('face normalization', () => {
  it('maps boxes to original-image pixels and clips partly visible faces', () => {
    expect(result().regions[0]).toEqual({ kind: 'face', confidence: .9, bounds: { x: 10, y: 20, width: 60, height: 80 } });
    expect(normalizeFaces([detection(-10)], 'obs_1', 800, 600, 0).regions[0].bounds).toEqual({ x: 0, y: 20, width: 50, height: 80 });
  });
  it('accepts a completed empty scan but rejects malformed or overflowing output', () => {
    expect(normalizeFaces([], 'obs_1', 800, 600, 0).regions).toEqual([]);
    expect(() => normalizeFaces([detection(NaN)], 'obs_1', 800, 600, 0)).toThrow();
    expect(() => normalizeFaces([detection(900)], 'obs_1', 800, 600, 0)).toThrow();
    expect(() => normalizeFaces([{ ...detection(), categories: [] }], 'obs_1', 800, 600, 0)).toThrow();
    expect(() => normalizeFaces(Array.from({ length: 501 }, () => detection()), 'obs_1', 800, 600, 0)).toThrow();
  });
});
class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn(); postMessage = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
  reply(data: unknown) { this.onmessage?.({ data }); }
}
function input() {
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('chrome', { runtime: { getURL: (path: string) => `chrome-extension://test/${path}` } });
  return { observationId: 'obs_1', image: { width: 800, height: 600, close: vi.fn() } as unknown as ImageBitmap };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); FakeWorker.instances = []; });
describe('MediaPipe worker lifecycle', () => {
  it('reuses the engine after successful scans and closes inputs', async () => {
    const adapter = new MediaPipeAdapter(), first = input();
    const pending = adapter.inspect(first, new AbortController().signal);
    FakeWorker.instances[0].reply({ type: 'result', result: result() });
    await expect(pending).resolves.toEqual(result());
    expect(first.image.close).toHaveBeenCalledOnce();
    const next = adapter.inspect(input(), new AbortController().signal);
    FakeWorker.instances[0].reply({ type: 'result', result: result() });
    await next; expect(FakeWorker.instances).toHaveLength(1); adapter.dispose();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it('terminates startup on cancellation, ignores late output, and restarts', async () => {
    const adapter = new MediaPipeAdapter(), controller = new AbortController();
    const pending = expect(adapter.inspect(input(), controller.signal)).rejects.toThrow('STOPPED');
    controller.abort(); await pending;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    FakeWorker.instances[0].reply({ type: 'result', result: result() });
    const next = adapter.inspect(input(), new AbortController().signal);
    expect(FakeWorker.instances).toHaveLength(2);
    FakeWorker.instances[1].reply({ type: 'result', result: result() });
    await next; adapter.dispose();
  });
  it('times out hung inference and closes its bitmap', async () => {
    vi.useFakeTimers();
    const adapter = new MediaPipeAdapter(100), frame = input();
    const pending = expect(adapter.inspect(frame, new AbortController().signal)).rejects.toThrow('FACE_TIMEOUT');
    await vi.advanceTimersByTimeAsync(100); await pending;
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(frame.image.close).toHaveBeenCalledOnce();
  });
  it.each([
    { ...result(), observationId: 'stale' },
    { ...result(), regions: [{ kind: 'text', bounds: { x: 0, y: 0, width: 1, height: 1 } }] },
    { ...result(), regions: [{ kind: 'face', bounds: { x: 799, y: 0, width: 20, height: 20 } }] },
  ])('rejects stale or invalid worker results', async invalid => {
    const adapter = new MediaPipeAdapter();
    const pending = adapter.inspect(input(), new AbortController().signal);
    FakeWorker.instances[0].reply({ type: 'result', result: invalid });
    await expect(pending).rejects.toThrow('FACE_INVALID_RESULT');
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
  it('rejects aborted/concurrent work and disposes pending inference', async () => {
    const adapter = new MediaPipeAdapter(), controller = new AbortController(); controller.abort();
    await expect(adapter.inspect(input(), controller.signal)).rejects.toThrow('STOPPED');
    const pending = expect(adapter.inspect(input(), new AbortController().signal)).rejects.toThrow('STOPPED');
    await expect(adapter.inspect(input(), new AbortController().signal)).rejects.toThrow('FACE_BUSY');
    adapter.dispose(); await pending;
  });
  it('handles worker load failures without leaking inputs', async () => {
    const adapter = new MediaPipeAdapter(), frame = input();
    const pending = expect(adapter.inspect(frame, new AbortController().signal)).rejects.toThrow('FACE_FAILED');
    FakeWorker.instances[0].onerror?.(); await pending;
    expect(frame.image.close).toHaveBeenCalledOnce();
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
  });
});
