import type { Rect, VisualCategory } from '../contracts';

export const ONNX_INPUT_SIZE = 640;
export const ONNX_MODEL_CLASSES = ['id_docs', 'fingerprints', 'signatures', 'financial'] as const;
export type OnnxClass = typeof ONNX_MODEL_CLASSES[number];

export const onnxCategory = (name: OnnxClass): VisualCategory => ({
  id_docs: 'identity_card', fingerprints: 'private_document', signatures: 'signature', financial: 'financial_document',
}[name] as VisualCategory);

export interface Candidate { category: VisualCategory; confidence: number; bounds: Rect }

export function decodeOnnxOutput(data: Float32Array, count: number, imageWidth: number, imageHeight: number,
  scale: number, padX: number, padY: number, threshold = .25): Candidate[] {
  const candidates: Candidate[] = [];
  for (let i = 0; i < count; i++) {
    let best = 0, confidence = 0;
    for (let classIndex = 0; classIndex < ONNX_MODEL_CLASSES.length; classIndex++) {
      const raw = Number(data[(4 + classIndex) * count + i]);
      const score = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
      if (score > confidence) { confidence = score; best = classIndex; }
    }
    if (confidence < threshold) continue;
    const cx = Number(data[i]), cy = Number(data[count + i]), width = Number(data[2 * count + i]), height = Number(data[3 * count + i]);
    const left = (cx - width / 2 - padX) / scale, top = (cy - height / 2 - padY) / scale;
    const right = (cx + width / 2 - padX) / scale, bottom = (cy + height / 2 - padY) / scale;
    const x = Math.max(0, Math.floor(left)), y = Math.max(0, Math.floor(top));
    const r = Math.min(imageWidth, Math.ceil(right)), b = Math.min(imageHeight, Math.ceil(bottom));
    if ([x, y, r, b].every(Number.isFinite) && r > x && b > y) candidates.push({ category: onnxCategory(ONNX_MODEL_CLASSES[best]), confidence, bounds: { x, y, width: r - x, height: b - y } });
  }
  return nonMaxSuppression(candidates);
}

export function iou(a: Rect, b: Rect) {
  const area = (r: Rect) => r.width * r.height;
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = x * y;
  return intersection / Math.max(1, area(a) + area(b) - intersection);
}

export function nonMaxSuppression(candidates: Candidate[], threshold = .45) {
  const kept: Candidate[] = [];
  for (const candidate of [...candidates].sort((a, b) => b.confidence - a.confidence)) {
    if (!kept.some(other => other.category === candidate.category && iou(other.bounds, candidate.bounds) >= threshold)) kept.push(candidate);
    if (kept.length > 500) break;
  }
  return kept;
}
