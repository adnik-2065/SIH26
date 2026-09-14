import type { Detection } from '@mediapipe/tasks-vision';
import { PerceptionResultSchema, type PerceptionResult } from '../contracts';

// MediaPipe returns boxes in input-image pixels. Clip edge faces to the image;
// never silently turn malformed or overflowing output into a successful scan.
export function normalizeFaces(detections: Detection[], observationId: string, width: number, height: number, elapsedMs: number): PerceptionResult {
  const regions = detections.map(detection => {
    const b = detection.boundingBox;
    if (!b || ![b.originX, b.originY, b.width, b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) throw new Error('FACE_INVALID_RESULT');
    const x = Math.max(0, Math.floor(b.originX)), y = Math.max(0, Math.floor(b.originY));
    const right = Math.min(width, Math.ceil(b.originX + b.width)), bottom = Math.min(height, Math.ceil(b.originY + b.height));
    if (right <= x || bottom <= y) throw new Error('FACE_INVALID_RESULT');
    const confidence = detection.categories[0]?.score;
    if (confidence === undefined) throw new Error('FACE_INVALID_RESULT');
    return { kind: 'face' as const, bounds: { x, y, width: right - x, height: bottom - y }, confidence };
  });
  return PerceptionResultSchema.parse({ observationId, source: 'model', regions, elapsedMs });
}
