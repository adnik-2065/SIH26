import type { PerceptionAdapter, PerceptionResult } from './contracts';

// Ownership bands do not overlap, but their image crops do. This preserves
// words/faces at a seam while assigning each detection to one band only.
export function pageSections(width: number, height: number, viewportHeight: number) {
  const bandHeight = Math.max(1, Math.min(Math.ceil(viewportHeight), 1600, Math.floor(1_500_000 / width)));
  const margin = Math.min(256, Math.floor(bandHeight / 4));
  return Array.from({ length: Math.ceil(height / bandHeight) }, (_, index) => {
    const start = index * bandHeight, end = Math.min(height, start + bandHeight);
    const y = Math.max(0, start - margin);
    return { start, end, y, height: Math.min(height, end + margin) - y };
  });
}

export async function inspectPage(image: HTMLImageElement, width: number, height: number, viewportHeight: number,
  observationId: string, adapter: PerceptionAdapter, signal: AbortSignal,
  onPartial: (result: PerceptionResult) => void,
  onSection: (index: number, count: number) => void = () => {}): Promise<PerceptionResult> {
  const sections = pageSections(width, height, viewportHeight);
  const regions: PerceptionResult['regions'] = [];
  let elapsedMs = 0;
  const check = () => { if (signal.aborted) throw new Error('STOPPED'); };
  for (const [index, section] of sections.entries()) {
    check();
    onSection(index, sections.length);
    // Allocate only the next crop. Each adapter releases its transferred bitmap
    // before another is allocated; the source image is decoded once by the UI.
    const bitmap = await createImageBitmap(image, 0, section.y, width, section.height);
    if (signal.aborted) { bitmap.close(); check(); }
    const result = await adapter.inspect({ image: bitmap, observationId }, signal);
    check();
    elapsedMs += result.elapsedMs;
    for (const region of result.regions) {
      const bounds = { ...region.bounds, y: region.bounds.y + section.y };
      const center = bounds.y + bounds.height / 2;
      if (center >= section.start && center < section.end) regions.push({ ...region, bounds });
    }
    onPartial({ observationId, source: 'model', regions: [...regions], elapsedMs });
    // Allow paint and input between sections; there is no fixed capture delay.
    if (index + 1 < sections.length) await new Promise(resolve => setTimeout(resolve, 0));
  }
  return { observationId, source: 'model', regions, elapsedMs };
}
