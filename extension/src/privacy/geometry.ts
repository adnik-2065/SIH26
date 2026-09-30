import type { LocalObservation, Rect } from '../contracts';
import { BoundsSchema, LIMITS, PrivacyError, type Mask, type PiiKind } from './contracts';

export function validateBounds(bounds: Rect, width: number, height: number) {
  if (!BoundsSchema.safeParse(bounds).success || !Number.isFinite(width) || !Number.isFinite(height) ||
    bounds.x + bounds.width > width || bounds.y + bounds.height > height) throw new PrivacyError('INVALID_BOUNDS');
  return bounds;
}
export function intersection(a: Rect, b: Rect): Rect | undefined {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : undefined;
}
export function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
export const DEFAULT_PADDING = Object.freeze({ text: 4, face: 12, document: 8 });
export function paddedMask(bounds: Rect, kind: PiiKind, width: number, height: number, padding: { text: number; face: number; document: number } = DEFAULT_PADDING): Mask {
  validateBounds(bounds, width, height);
  const amount = kind === 'face' ? padding.face : kind === 'document' ? padding.document : padding.text;
  if (!Number.isFinite(amount) || amount < 0 || amount > 256) throw new PrivacyError('INVALID_BOUNDS');
  const x = Math.max(0, Math.floor(bounds.x - amount)), y = Math.max(0, Math.floor(bounds.y - amount));
  return { bounds: { x, y, width: Math.min(width, Math.ceil(bounds.x + bounds.width + amount)) - x,
    height: Math.min(height, Math.ceil(bounds.y + bounds.height + amount)) - y }, reasons: [kind] };
}
export function mergeMasks(input: Mask[]): Mask[] {
  if (input.length > LIMITS.masks) throw new PrivacyError('LIMIT_EXCEEDED');
  const output: Mask[] = [];
  for (const mask of input) {
    let next = { bounds: { ...mask.bounds }, reasons: [...mask.reasons] };
    // Restart after a union: its enlarged rectangle can touch earlier masks.
    for (let i = 0; i < output.length;) {
      const a = next.bounds, b = output[i].bounds;
      if (a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height) {
        next = { bounds: union(a, b), reasons: [...new Set([...next.reasons, ...output[i].reasons])] };
        output.splice(i, 1); i = 0;
      } else i++;
    }
    output.push(next);
  }
  return output;
}
// Where a DOM rectangle lands in the delivered image, or undefined when it lies
// wholly outside the captured area: a viewport capture photographs one screen,
// so a control further down the page has no pixels here to mask. Malformed
// bounds still throw.
export function visibleDomBounds(bounds: Rect, observation: LocalObservation): Rect | undefined {
  const { viewport } = observation.dom, capture = observation.captureBounds;
  const scaleX = observation.imageWidth / capture.width, scaleY = observation.imageHeight / capture.height;
  const converted = { x: (bounds.x + viewport.scrollX - viewport.offsetX - capture.x) * scaleX,
    y: (bounds.y + viewport.scrollY - viewport.offsetY - capture.y) * scaleY,
    width: bounds.width * scaleX, height: bounds.height * scaleY };
  // A visible control can straddle the page edge, but malformed source bounds
  // must never be repaired into apparent validity.
  if (![bounds.x, bounds.y, bounds.width, bounds.height, scaleX, scaleY].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || scaleX <= 0 || scaleY <= 0) throw new PrivacyError('INVALID_BOUNDS');
  const clipped = intersection(converted, { x: 0, y: 0, width: observation.imageWidth, height: observation.imageHeight });
  return clipped && validateBounds(clipped, observation.imageWidth, observation.imageHeight);
}
export function domBounds(bounds: Rect, observation: LocalObservation): Rect {
  const visible = visibleDomBounds(bounds, observation);
  if (!visible) throw new PrivacyError('INVALID_BOUNDS');
  return visible;
}
// The whole document, in CSS pixels and in image pixels. Page-scale evidence
// rules measure against this frame whichever part of the page was captured, so
// a viewport capture keeps exactly the decisions a full-page capture made.
export function pageFrame(observation: Pick<LocalObservation, 'captureBounds' | 'pageSize'>) {
  return observation.pageSize ?? observation.captureBounds;
}
export function imagePageFrame(observation: Pick<LocalObservation, 'captureBounds' | 'pageSize' | 'imageWidth' | 'imageHeight'>) {
  const page = pageFrame(observation), capture = observation.captureBounds;
  return { width: page.width * observation.imageWidth / capture.width, height: page.height * observation.imageHeight / capture.height };
}
export function tileMasks(masks: Mask[], tile: { y: number; width: number; height: number }): Mask[] {
  return masks.flatMap(mask => {
    const b = intersection(mask.bounds, { x: 0, y: tile.y, width: tile.width, height: tile.height });
    return b ? [{ bounds: { ...b, y: b.y - tile.y }, reasons: mask.reasons }] : [];
  });
}
