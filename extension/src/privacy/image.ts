import type { LocalObservation } from '../contracts';
import { LIMITS, PrivacyError, type Mask } from './contracts';
import { tileMasks, validateBounds } from './geometry';
import { verifyOpaquePixels } from './verification';

export function validateTiles(observation: LocalObservation) {
  const { tiles, imageWidth, imageHeight } = observation;
  const { captureBounds: capture, dom: { viewport } } = observation;
  if (![...Object.values(viewport), ...Object.values(capture)].every(Number.isFinite) || capture.x < 0 || capture.y < 0 ||
    capture.width <= 0 || capture.height <= 0 || viewport.width <= 0 || viewport.height <= 0 || viewport.devicePixelRatio <= 0 || viewport.visualScale <= 0) throw new PrivacyError('INVALID_BOUNDS');
  if (tiles.length !== observation.tileCount || !tiles.length || tiles.length > LIMITS.tiles ||
    !Number.isSafeInteger(imageWidth) || !Number.isSafeInteger(imageHeight) || imageWidth <= 0 || imageHeight <= 0) throw new PrivacyError('INVALID_BOUNDS');
  let end = 0;
  for (const tile of tiles) {
    if (tile.width !== imageWidth || tile.start !== end || tile.end <= tile.start || tile.y > tile.start ||
      tile.y + tile.height < tile.end || tile.y + tile.height > imageHeight || tile.width * tile.height > LIMITS.sourcePixels) throw new PrivacyError('INVALID_BOUNDS');
    end = tile.end;
  }
  if (end !== imageHeight) throw new PrivacyError('INVALID_BOUNDS');
}
function paint(context: OffscreenCanvasRenderingContext2D, masks: Mask[]) {
  context.globalAlpha = 1; context.globalCompositeOperation = 'source-over'; context.fillStyle = '#000000';
  for (const { bounds: b } of masks) context.fillRect(Math.floor(b.x), Math.floor(b.y), Math.ceil(b.x + b.width) - Math.floor(b.x), Math.ceil(b.y + b.height) - Math.floor(b.y));
}
export function pngBytes(screenshot: string, width: number, height: number) {
  const encoded = screenshot.slice('data:image/png;base64,'.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4) throw new PrivacyError('MASKING_FAILED');
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  // Reject mismatched PNG dimensions *before* decode, including decompression
  // bombs disguised as small capture tiles.
  const view = new DataView(bytes.buffer);
  if (bytes.length < 33 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a ||
    view.getUint32(12) !== 0x49484452 || view.getUint32(16) !== width || view.getUint32(20) !== height) throw new PrivacyError('MASKING_FAILED');
  return bytes;
}
export function bounded<T>(work: Promise<T>, signal: AbortSignal | undefined, releaseLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = (reason: 'STOPPED' | 'MASKING_FAILED') => { if (!settled) { settled = true; cleanup(); reject(new PrivacyError(reason)); } };
    const abort = () => fail('STOPPED');
    const timer = setTimeout(() => fail('MASKING_FAILED'), 30_000);
    signal?.addEventListener('abort', abort, { once: true });
    work.then(value => {
      if (settled) { releaseLate?.(value); return; }
      settled = true; cleanup(); resolve(value);
    }, () => fail('MASKING_FAILED'));
    if (signal?.aborted) abort();
  });
}
export async function redactImage(observation: LocalObservation, masks: Mask[], check: () => void, signal?: AbortSignal) {
  validateTiles(observation); check();
  for (const mask of masks) validateBounds(mask.bounds, observation.imageWidth, observation.imageHeight);
  const scale = Math.min(1, LIMITS.summarySide / observation.imageWidth, LIMITS.summarySide / observation.imageHeight,
    Math.sqrt(LIMITS.summaryPixels / (observation.imageWidth * observation.imageHeight)));
  const width = Math.max(1, Math.floor(observation.imageWidth * scale)), height = Math.max(1, Math.floor(observation.imageHeight * scale));
  const output = new OffscreenCanvas(width, height), target = output.getContext('2d', { alpha: false });
  if (!target) throw new PrivacyError('MASKING_FAILED');
  target.fillStyle = '#000'; target.fillRect(0, 0, width, height);
  try {
    for (const tile of observation.tiles) {
      check();
      let bitmap: ImageBitmap | undefined, canvas: OffscreenCanvas | undefined;
      try {
        const bytes = pngBytes(tile.screenshot, tile.width, tile.height);
        bitmap = await bounded(createImageBitmap(new Blob([bytes], { type: 'image/png' })), signal, image => image.close()); check();
        if (bitmap.width !== tile.width || bitmap.height !== tile.height) throw new PrivacyError('MASKING_FAILED');
        canvas = new OffscreenCanvas(tile.width, tile.height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new PrivacyError('MASKING_FAILED');
        context.fillStyle = '#000'; context.fillRect(0, 0, tile.width, tile.height);
        context.drawImage(bitmap, 0, 0); bitmap.close(); bitmap = undefined;
        paint(context, tileMasks(masks, tile)); check();
        const sy = height / observation.imageHeight;
        // Every source tile is masked in full, including both overlap margins.
        // Ownership bands alone are composited into the bounded summary.
        target.drawImage(canvas, 0, tile.start - tile.y, tile.width, tile.end - tile.start,
          0, tile.start * sy, width, (tile.end - tile.start) * sy);
      } finally { bitmap?.close(); if (canvas) { canvas.width = 0; canvas.height = 0; } }
      // Give Stop/invalidation a turn before decoding another tile.
      await new Promise(resolve => setTimeout(resolve, 0)); check();
    }
    const sx = width / observation.imageWidth, sy = height / observation.imageHeight;
    // Repaint projected masks with an extra output pixel around every edge.
    paint(target, masks.map(mask => ({ ...mask, bounds: { x: mask.bounds.x * sx - 1, y: mask.bounds.y * sy - 1,
      width: mask.bounds.width * sx + 2, height: mask.bounds.height * sy + 2 } })));
    check();
    const blob = await bounded(output.convertToBlob({ type: 'image/png' }), signal); check();
    if (blob.type !== 'image/png' || !blob.size) throw new PrivacyError('MASKING_FAILED');
    if (blob.size > LIMITS.imageBytes) throw new PrivacyError('IMAGE_TOO_LARGE');
    const encodedHeader = new DataView(await bounded(blob.slice(0, 24).arrayBuffer(), signal)); check();
    if (encodedHeader.byteLength < 24 || encodedHeader.getUint32(0) !== 0x89504e47 || encodedHeader.getUint32(4) !== 0x0d0a1a0a ||
      encodedHeader.getUint32(12) !== 0x49484452 || encodedHeader.getUint32(16) !== width || encodedHeader.getUint32(20) !== height)
      throw new PrivacyError('VERIFICATION_FAILED');
    let verified: ImageBitmap | undefined;
    let verificationCanvas: OffscreenCanvas | undefined;
    try {
      verified = await bounded(createImageBitmap(blob), signal, image => image.close()); check();
      if (verified.width !== width || verified.height !== height) throw new PrivacyError('VERIFICATION_FAILED');
      // Preserve decoded alpha: an opaque destination could conceal a broken,
      // transparent export by compositing its pixels against black.
      verificationCanvas = new OffscreenCanvas(width, height);
      const verificationContext = verificationCanvas.getContext('2d', { willReadFrequently: true });
      if (!verificationContext) throw new PrivacyError('VERIFICATION_FAILED');
      verificationContext.drawImage(verified, 0, 0);
      verifyOpaquePixels(verificationContext, masks, observation, width, height, check);
    } catch { check(); throw new PrivacyError('VERIFICATION_FAILED'); }
    finally { verified?.close(); if (verificationCanvas) { verificationCanvas.width = 0; verificationCanvas.height = 0; } }
    const bytes = new Uint8Array(await bounded(blob.arrayBuffer(), signal)); check();
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    const base64 = btoa(binary);
    if (base64.length > LIMITS.base64) throw new PrivacyError('IMAGE_TOO_LARGE');
    if (observation.tiles.some(tile => tile.screenshot.slice(22) === base64)) throw new PrivacyError('RAW_DATA_LEAK');
    return { mimeType: 'image/png' as const, base64 };
  } finally { output.width = 0; output.height = 0; }
}
