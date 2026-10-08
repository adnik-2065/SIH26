import { describe, expect, it } from 'vitest';
import { faceTiles, mergeFaces } from '../../src/vision/face/tiles';
import type { PerceptionResult } from '../../src/vision/contracts';

describe('face crops', () => {
  it.each([[1373, 999], [1920, 1080], [3840, 2160], [999, 1373], [10000, 1200]])('covers %i × %i pixels with bounded, overlapping crops', (width, height) => {
    const tiles = faceTiles(width, height);
    expect(tiles.length).toBeLessThanOrEqual(25);
    expect(tiles.some(b => b.x === 0 && b.y === 0)).toBe(true);
    expect(tiles.some(b => b.x + b.width === width && b.y + b.height === height)).toBe(true);
    for (const b of tiles) {
      expect(b.x).toBeGreaterThanOrEqual(0); expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.width).toBeLessThanOrEqual(width); expect(b.y + b.height).toBeLessThanOrEqual(height);
    }
    const row = tiles.filter(b => b.y === 0);
    for (let i = 1; i < row.length; i++) expect(row[i - 1].x + row[i - 1].width - row[i].x).toBeGreaterThanOrEqual(Math.floor(row[i].width * .25));
  });
  it('avoids repeating an already small image', () => { expect(faceTiles(400, 300)).toEqual([]); });
});

describe('face deduplication', () => {
  const face = (x: number, confidence: number): PerceptionResult['regions'][number] => ({ kind: 'face', bounds: { x, y: 100, width: 100, height: 100 }, confidence });
  it('keeps the strongest repeated box while retaining separate faces', () => {
    expect(mergeFaces([face(100, .6), face(105, .9), face(300, .8)])).toEqual([face(105, .9), face(300, .8)]);
  });
  it('retains an empty scan and fails instead of silently dropping excess faces', () => {
    expect(mergeFaces([])).toEqual([]);
    expect(() => mergeFaces(Array.from({ length: 501 }, (_, i) => face(i * 200, .8)))).toThrow();
  });
  it('merges a loose whole-page box containing a stronger crop detection', () => {
    const precise = face(100, .98);
    const loose = { ...face(50, .53), bounds: { x: 50, y: 50, width: 250, height: 250 } };
    expect(mergeFaces([loose, precise, face(350, .8)])).toEqual([precise, face(350, .8)]);
  });
});
