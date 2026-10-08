import { describe, expect, it } from 'vitest';
import { validateDeliveredTiles } from '../../src/capture/tiles';

// One page image of 1000 × 300, delivered as three contiguous bands.
const expected = { tileCount: 3, imageWidth: 1000, imageHeight: 300 };
const band = (start: number, end: number) => ({ width: 1000, height: end - start, y: start, start, end });
type Delivered = ReturnType<typeof band> | undefined;
const tiles = (): Delivered[] => [band(0, 100), band(100, 200), band(200, 300)];

describe('reassembling a page image from delivered tiles', () => {
  it('accepts contiguous tiles that cover the whole image', () => {
    expect(validateDeliveredTiles(tiles(), expected)).toEqual({ ok: true });
  });
  it('reports a count mismatch with both counts', () => {
    const result = validateDeliveredTiles(tiles().slice(0, 2), expected);
    expect(result).toMatchObject({ ok: false, error: { code: 'TILE_COUNT_MISMATCH', stage: 'TILE_VALIDATION',
      context: { expectedCount: 3, receivedCount: 2 } } });
  });
  it('reports the index of a tile that never arrived', () => {
    const delivered = tiles(); delivered[1] = undefined;
    expect(validateDeliveredTiles(delivered, expected)).toMatchObject({ ok: false,
      error: { code: 'TILE_MISSING', context: { tileIndex: 1 } } });
  });
  it('reports a width change against the page image', () => {
    const delivered = tiles(); delivered[2] = { ...band(200, 300), width: 998 };
    expect(validateDeliveredTiles(delivered, expected)).toMatchObject({ ok: false,
      error: { code: 'TILE_WIDTH_MISMATCH', context: { tileIndex: 2, expectedWidth: 1000, actualWidth: 998 } } });
  });
  it('separates a gap from an overlap, and measures it', () => {
    const gap = tiles(); gap[1] = band(120, 200);
    expect(validateDeliveredTiles(gap, expected)).toMatchObject({ ok: false,
      error: { code: 'TILE_GAP_DETECTED', context: { tileIndex: 1, expectedStart: 100, actualStart: 120, gapPx: 20 } } });
    const overlap = tiles(); overlap[1] = band(80, 200);
    expect(validateDeliveredTiles(overlap, expected)).toMatchObject({ ok: false,
      error: { code: 'TILE_OVERLAP_DETECTED', context: { tileIndex: 1, expectedStart: 100, actualStart: 80, overlapPx: 20 } } });
  });
  it('reports a final bound that does not reach the captured height', () => {
    expect(validateDeliveredTiles([band(0, 100), band(100, 200), band(200, 280)], expected)).toMatchObject({ ok: false,
      error: { code: 'TILE_FINAL_BOUND_MISMATCH', context: { expectedEnd: 300, actualEnd: 280 } } });
  });
  it.each([
    ['a band outside its own image', { width: 1000, height: 50, y: 0, start: 0, end: 100 }],
    ['an empty band', { width: 1000, height: 100, y: 0, start: 0, end: 0 }],
    ['a start before the image', { width: 1000, height: 100, y: 50, start: 0, end: 100 }],
  ])('refuses %s', (_label, broken) => {
    expect(validateDeliveredTiles([broken, band(100, 200), band(200, 300)], expected)).toMatchObject({ ok: false,
      error: { code: 'TILE_INVALID_COORDINATES', context: { tileIndex: 0 } } });
  });
  it('keeps page content out of the diagnostics', () => {
    const result = validateDeliveredTiles(tiles().slice(0, 1), expected);
    expect(JSON.stringify(result)).not.toContain('data:image');
  });
});
