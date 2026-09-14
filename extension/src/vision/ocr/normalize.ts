import type { Page } from 'tesseract.js';
import { PerceptionResultSchema, type PerceptionResult } from '../contracts';

// No resize, crop, or rotation: Tesseract's pixel coordinates map directly to the capture.
export function normalizeOcr(data: Pick<Page, 'blocks'>, observationId: string, width: number, height: number, elapsedMs: number): PerceptionResult {
  if (!data.blocks) throw new Error('OCR_LAYOUT_MISSING');
  const regions = data.blocks.flatMap(block => block.paragraphs.flatMap(paragraph => paragraph.lines.flatMap(line => line.words)))
    .filter(word => word.text.trim()).map(word => {
      const { x0, y0, x1, y1 } = word.bbox;
      if (![x0, y0, x1, y1, word.confidence].every(Number.isFinite) || x0 < 0 || y0 < 0 || x1 > width || y1 > height || x1 <= x0 || y1 <= y0) {
        throw new Error('OCR_INVALID_BOUNDS');
      }
      return { kind: 'text' as const, text: word.text.trim(), confidence: word.confidence / 100,
        bounds: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } };
    });
  // Fail explicitly instead of silently omitting words beyond the shared contract limit.
  if (regions.length > 500) throw new Error('OCR_TOO_MUCH_TEXT');
  return PerceptionResultSchema.parse({ observationId, source: 'model', regions, elapsedMs });
}
