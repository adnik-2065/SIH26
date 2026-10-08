import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareImages } from '../../src/dom/images';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
function lazyImage(decode = vi.fn().mockResolvedValue(undefined)) {
  return { loading: 'lazy', complete: false, currentSrc: 'https://example.test/portrait.png', decode,
    getAttribute: () => 'lazy', setAttribute(_name: string, value: string) { this.loading = value; } };
}
describe('lazy portraits without scrolling', () => {
  it('decodes deferred images and restores their original loading attributes', async () => {
    const image = lazyImage();
    image.decode.mockImplementation(async () => { expect(image.loading).toBe('eager'); });
    vi.stubGlobal('document', { querySelectorAll: () => [image] });
    await prepareImages(new AbortController().signal);
    expect(image.decode).toHaveBeenCalledOnce();
    expect(image.loading).toBe('lazy');
  });
  it('restores attributes immediately on Stop even if decoding is pending', async () => {
    const image = lazyImage(vi.fn().mockReturnValue(new Promise(() => {})));
    vi.stubGlobal('document', { querySelectorAll: () => [image] });
    const controller = new AbortController();
    const pending = prepareImages(controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('STOPPED');
    expect(image.loading).toBe('lazy');
  });
  it('bounds slow image loading without silently capturing missing portraits', async () => {
    vi.useFakeTimers();
    const image = lazyImage(vi.fn().mockReturnValue(new Promise(() => {})));
    vi.stubGlobal('document', { querySelectorAll: () => [image] });
    const pending = expect(prepareImages(new AbortController().signal)).rejects.toThrow('CAPTURE_FAILED');
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(image.loading).toBe('lazy');
  });
});
