export interface Timing { stage: 'dom' | 'capture' | 'ocr' | 'vision'; milliseconds: number; }
export function summarize(samples: number[]) {
  if (!samples.length) return { count: 0, median: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { count: sorted.length, median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}
