import { captureError, CAPTURE_LIMITS } from './errors';

// Keep the existing single-image path for ordinary pages. Large pages use
// overlapping, bounded images at the same resolution, never one giant canvas.
export function captureTiles(width: number, height: number, viewportHeight = 8192) {
  // The limits are unchanged; which one stopped the capture is now reported.
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw captureError('CAPTURE_SCREENSHOT_INVALID', 'The page reported dimensions that cannot be captured.',
      { width, height }, 'page dimensions are not usable integers');
  }
  if (width > CAPTURE_LIMITS.maxSide) {
    throw captureError('CAPTURE_DIMENSION_LIMIT_EXCEEDED',
      `The page is ${width} px wide, over the ${CAPTURE_LIMITS.maxSide} px maximum.`,
      { width, height, maximumSide: CAPTURE_LIMITS.maxSide }, 'page width over limit');
  }
  if (height <= 32_767 && width * height <= 32_000_000) return [{ y: 0, height, start: 0, end: height }];
  // Repeated native captures must keep the rendering surface the same size.
  // Changing tile height can expose Chrome's temporary 1×1 layout override on
  // high-DPI displays. Keep first/last tiles the same size as the middle ones.
  const tileHeight = Math.max(1, Math.min(Math.round(viewportHeight), 8192, Math.floor(8_000_000 / width)));
  const margin = Math.min(256, Math.floor(tileHeight / 4));
  const bandHeight = tileHeight - margin * 2;
  const count = Math.ceil(height / bandHeight);
  if (count > 2048) {
    throw captureError('CAPTURE_PIXEL_LIMIT_EXCEEDED',
      `The page needs ${count} tiles, over the 2048 tile maximum.`,
      { width, height, tiles: count, maximumTiles: 2048 }, 'tile count over limit');
  }
  return Array.from({ length: count }, (_, index) => {
    const start = index * bandHeight, end = Math.min(height, start + bandHeight);
    const y = Math.min(Math.max(0, start - margin), height - tileHeight);
    return { y, height: tileHeight, start, end };
  });
}

// ---------------------------------------------------------------------------
// Tile validation
//
// The panel reassembles a page image from tiles delivered one message at a
// time. A gap, an overlap, a missing tile or a width change all mean the image
// would not be the page — so each one is still refused, but each one now says
// which tile and what it saw. Strictness is unchanged: any failure here stops
// the capture from reaching OCR, face detection or the privacy gateway.
export type TileErrorCode = 'TILE_COUNT_MISMATCH' | 'TILE_MISSING' | 'TILE_WIDTH_MISMATCH' | 'TILE_GAP_DETECTED'
  | 'TILE_OVERLAP_DETECTED' | 'TILE_FINAL_BOUND_MISMATCH' | 'TILE_INVALID_COORDINATES';
export interface TileValidationError {
  code: TileErrorCode; stage: 'TILE_VALIDATION'; message: string; cause?: string;
  context: Record<string, unknown>; timestamp: string;
}
export type TileValidation = { ok: true } | { ok: false; error: TileValidationError };
interface DeliveredTile { width: number; height: number; y: number; start: number; end: number }
interface TileExpectation { tileCount: number; imageWidth: number; imageHeight: number }

const tileError = (code: TileErrorCode, message: string, context: Record<string, unknown>, cause?: string): TileValidation =>
  ({ ok: false, error: { code, stage: 'TILE_VALIDATION', message, context, timestamp: new Date().toISOString(), ...(cause ? { cause } : {}) } });

export function validateDeliveredTiles(tiles: Array<DeliveredTile | undefined>, expected: TileExpectation): TileValidation {
  if (tiles.length !== expected.tileCount) {
    return tileError('TILE_COUNT_MISMATCH', `The capture delivered ${tiles.length} of ${expected.tileCount} tiles.`,
      { expectedCount: expected.tileCount, receivedCount: tiles.length }, 'tile count differs from the capture');
  }
  let expectedStart = 0;
  for (let index = 0; index < expected.tileCount; index++) {
    const tile = tiles[index];
    if (!tile) {
      return tileError('TILE_MISSING', `Tile ${index + 1} of ${expected.tileCount} never arrived.`,
        { tileIndex: index, expectedCount: expected.tileCount }, 'a delivered tile is absent');
    }
    if (![tile.width, tile.height, tile.y, tile.start, tile.end].every(Number.isFinite) ||
      tile.y < 0 || tile.start < tile.y || tile.end <= tile.start || tile.end > tile.y + tile.height) {
      return tileError('TILE_INVALID_COORDINATES', `Tile ${index + 1} describes an impossible region.`,
        { tileIndex: index, y: tile.y, start: tile.start, end: tile.end, height: tile.height },
        'tile coordinates are not a band inside its own image');
    }
    if (tile.width !== expected.imageWidth) {
      return tileError('TILE_WIDTH_MISMATCH', `Tile ${index + 1} is ${tile.width} px wide, expected ${expected.imageWidth} px.`,
        { tileIndex: index, expectedWidth: expected.imageWidth, actualWidth: tile.width }, 'tile width differs from the page image');
    }
    if (tile.start > expectedStart) {
      return tileError('TILE_GAP_DETECTED', `Tile ${index + 1} starts at ${tile.start} px, leaving a ${tile.start - expectedStart} px gap.`,
        { tileIndex: index, expectedStart, actualStart: tile.start, gapPx: tile.start - expectedStart }, 'rows of the page were never captured');
    }
    if (tile.start < expectedStart) {
      return tileError('TILE_OVERLAP_DETECTED', `Tile ${index + 1} starts at ${tile.start} px, ${expectedStart - tile.start} px before the previous tile ended.`,
        { tileIndex: index, expectedStart, actualStart: tile.start, overlapPx: expectedStart - tile.start }, 'two tiles claim the same rows');
    }
    expectedStart = tile.end;
  }
  if (expectedStart !== expected.imageHeight) {
    return tileError('TILE_FINAL_BOUND_MISMATCH', `The tiles cover ${expectedStart} px of a ${expected.imageHeight} px page image.`,
      { expectedEnd: expected.imageHeight, actualEnd: expectedStart }, 'assembled height differs from the captured image');
  }
  return { ok: true };
}
