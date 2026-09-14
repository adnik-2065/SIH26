import type { Rect } from '../../contracts';
import type { PerceptionResult } from '../contracts';

// A whole desktop screenshot shrinks small portraits too far for BlazeFace.
// Overlapping crops preserve their scale; the whole-image pass retains large faces.
// At most 5 × 5 tiles, even for high-DPI captures. No page/DOM-specific hints.
export function faceTiles(width: number, height: number): Rect[] {
  const side = Math.max(512, Math.ceil(Math.max(width, height) / 4));
  if (width <= side && height <= side) return [];
  const positions = (length: number) => {
    const remaining = Math.max(0, length - side);
    const steps = Math.ceil(remaining / (side * .75));
    return Array.from({ length: steps + 1 }, (_, i) => steps ? Math.round(i * remaining / steps) : 0);
  };
  return positions(height).flatMap(y => positions(width).map(x => ({ x, y, width: Math.min(side, width), height: Math.min(side, height) })));
}

type Region = PerceptionResult['regions'][number];
export function mergeFaces(regions: Region[]): Region[] {
  const kept: Region[] = [];
  for (const region of [...regions].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))) {
    const a = region.bounds;
    const duplicate = kept.some(({ bounds: b }) => {
      const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
        Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      const aArea = a.width * a.height, bArea = b.width * b.height;
      // Whole-page inference can produce a loose box containing the more precise
      // crop result. IoU alone misses these duplicates because their sizes differ.
      return intersection / (aArea + bArea - intersection) >= .3 || intersection / Math.min(aArea, bArea) >= .85;
    });
    if (!duplicate) kept.push(region);
    if (kept.length > 500) throw new Error('FACE_INVALID_RESULT');
  }
  return kept;
}
