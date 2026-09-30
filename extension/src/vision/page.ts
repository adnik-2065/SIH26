import type { PerceptionAdapter, PerceptionResult } from './contracts';
import type { LocalObservation } from '../contracts';
import { tileDigest, type ResultCache } from './reuse';

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

type Section = ReturnType<typeof pageSections>[number];
// A strip of a section, also cut into columns: it owns the detections whose
// centre lies in [left, right) × [start, end), read from its crop.
type Piece = Section & { left: number; right: number; x: number; width: number };

// A row (or column) whose pixels all match its first within this tolerance
// carries no ink: no glyph crosses it, so a crop cut through it splits no text.
const INK_TOLERANCE = 8;
// Gaps narrower than this leave a word too little blank margin at the crop edge.
const MIN_GAP = 4;
// Blank margin a piece's crop keeps past its cut; the rest of a wide gap is
// left out, since it holds nothing to read.
const GAP_MARGIN = 16;
// Pieces smaller than this cost more in engine overhead than they save.
const MIN_STRIP = 120;

const same = (pixels: Uint8ClampedArray, a: number, b: number) => Math.abs(pixels[a] - pixels[b]) <= INK_TOLERANCE &&
  Math.abs(pixels[a + 1] - pixels[b + 1]) <= INK_TOLERANCE && Math.abs(pixels[a + 2] - pixels[b + 2]) <= INK_TOLERANCE;

export function blankRows(pixels: Uint8ClampedArray, width: number, height: number): boolean[] {
  return Array.from({ length: height }, (_, y) => {
    const row = y * width * 4;
    for (let i = row + 4; i < row + width * 4; i += 4) if (!same(pixels, i, row)) return false;
    return true;
  });
}

// Columns blank over rows [top, top + height) of the image.
export function blankColumns(pixels: Uint8ClampedArray, width: number, top: number, height: number): boolean[] {
  return Array.from({ length: width }, (_, x) => {
    const first = (top * width + x) * 4;
    for (let y = top + 1; y < top + height; y++) if (!same(pixels, (y * width + x) * 4, first)) return false;
    return true;
  });
}

// Up to `parts - 1` blank runs through which [from, to) can be cut into
// roughly even pieces. `blank[0]` is position `from`. Where no run lies near an
// even cut, fewer cuts are made.
function blankCuts(blank: boolean[], from: number, to: number, parts: number) {
  const gaps: Array<{ start: number; end: number; middle: number }> = [];
  for (let i = 0; i < blank.length;) {
    if (!blank[i]) { i++; continue; }
    const start = i;
    while (i < blank.length && blank[i]) i++;
    const middle = Math.floor((start + i) / 2);
    if (i - start >= MIN_GAP) gaps.push({ start: from + Math.max(start, middle - GAP_MARGIN), end: from + Math.min(i, middle + GAP_MARGIN), middle: from + middle });
  }
  const length = to - from;
  const cuts: typeof gaps = [];
  for (let part = 1; part < parts; part++) {
    const target = from + length * part / parts;
    const floor = (cuts.at(-1)?.middle ?? from) + MIN_STRIP;
    const best = gaps.filter(gap => gap.middle >= floor && gap.middle <= to - MIN_STRIP)
      .sort((a, b) => Math.abs(a.middle - target) - Math.abs(b.middle - target))[0];
    if (best && Math.abs(best.middle - target) <= length / parts / 2) cuts.push(best);
  }
  return cuts;
}

// Divides a section's owned rows into up to `parts` strips, cutting only
// through runs of blank rows (`blank[0]` is the section's first owned row).
// Each strip's crop keeps up to GAP_MARGIN blank rows past its cut, and the
// outer strips keep the section's own margins. A section with
// no blank run near a cut stays whole.
export function blankStrips(section: Section, blank: boolean[], parts: number): Section[] {
  const cuts = blankCuts(blank, section.start, section.end, parts);
  const bottom = section.y + section.height;
  return [...cuts, undefined].map((cut, index) => {
    const before = cuts[index - 1];
    const start = before?.middle ?? section.start, end = cut?.middle ?? section.end;
    const y = before?.start ?? section.y;
    return { start, end, y, height: (cut?.end ?? bottom) - y };
  });
}

// Divides a strip side by side into up to `parts` pieces through runs of
// columns blank over the strip's whole crop, the same way.
export function blankPieces(strip: Section, blank: boolean[], width: number, parts: number): Piece[] {
  const cuts = blankCuts(blank, 0, width, parts);
  return [...cuts, undefined].map((cut, index) => {
    const before = cuts[index - 1];
    const x = before?.start ?? 0;
    return { ...strip, left: before?.middle ?? 0, right: cut?.middle ?? width, x, width: (cut?.end ?? width) - x };
  });
}

// An adapter with several lanes reads a section as pieces side by side: strips
// between blank rows, and where those are too few, columns between blank columns.
async function inspectStrips(image: HTMLImageElement, width: number, sections: Section[], observationId: string,
  adapter: PerceptionAdapter, lanes: number, signal: AbortSignal, onPartial: (result: PerceptionResult) => void,
  onSection: (index: number, count: number) => void): Promise<PerceptionResult> {
  const pieces: Piece[] = [];
  for (const section of sections) {
    if (signal.aborted) throw new Error('STOPPED');
    const whole = (strip: Section): Piece => ({ ...strip, left: 0, right: width, x: 0, width });
    const canvas = new OffscreenCanvas(width, section.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) { pieces.push(whole(section)); continue; }
    context.drawImage(image, 0, section.y, width, section.height, 0, 0, width, section.height);
    const pixels = context.getImageData(0, 0, width, section.height).data;
    canvas.width = 0; canvas.height = 0;
    const rows = blankRows(pixels, width, section.height).slice(section.start - section.y, section.end - section.y);
    const strips = blankStrips(section, rows, lanes);
    const columns = Math.ceil(lanes / strips.length);
    for (const strip of strips) {
      pieces.push(...(columns > 1 ? blankPieces(strip, blankColumns(pixels, width, strip.y - section.y, strip.height), width, columns) : [whole(strip)]));
    }
  }
  // One piece failing stops the others rather than leaving lanes busy.
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener('abort', stop, { once: true });
  const found: Array<PerceptionResult['regions'] | undefined> = pieces.map(() => undefined);
  let next = 0, done = 0, elapsedMs = 0;
  const collected = () => found.flatMap(regions => regions ?? []);
  const lane = async () => {
    while (next < pieces.length) {
      const index = next++, piece = pieces[index];
      const bitmap = await createImageBitmap(image, piece.x, piece.y, piece.width, piece.height);
      if (controller.signal.aborted) { bitmap.close(); throw new Error('STOPPED'); }
      const result = await adapter.inspect({ image: bitmap, observationId }, controller.signal);
      if (controller.signal.aborted) throw new Error('STOPPED');
      elapsedMs += result.elapsedMs;
      found[index] = result.regions.flatMap(region => {
        const bounds = { ...region.bounds, x: region.bounds.x + piece.x, y: region.bounds.y + piece.y };
        const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
        return x >= piece.left && x < piece.right && y >= piece.start && y < piece.end ? [{ ...region, bounds }] : [];
      });
      done++;
      onSection(Math.min(sections.length - 1, Math.floor(done * sections.length / pieces.length)), sections.length);
      onPartial({ observationId, source: 'model', regions: collected(), elapsedMs });
    }
  };
  try {
    onSection(0, sections.length);
    await Promise.all(Array.from({ length: Math.min(lanes, pieces.length) }, () => lane().catch(error => { stop(); throw error; })));
  } finally { signal.removeEventListener('abort', stop); }
  if (signal.aborted) throw new Error('STOPPED');
  return { observationId, source: 'model', regions: collected(), elapsedMs };
}

export async function inspectPage(image: HTMLImageElement, width: number, height: number, viewportHeight: number,
  observationId: string, adapter: PerceptionAdapter, signal: AbortSignal,
  onPartial: (result: PerceptionResult) => void,
  onSection: (index: number, count: number) => void = () => {}): Promise<PerceptionResult> {
  const sections = pageSections(width, height, viewportHeight);
  const lanes = Math.max(1, Math.floor(adapter.lanes ?? 1));
  if (lanes > 1) return inspectStrips(image, width, sections, observationId, adapter, lanes, signal, onPartial, onSection);
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

// `cache` must belong to this adapter alone: it maps a tile's pixels to what
// this detector found in them, in tile coordinates.
export async function inspectCapturedPage(observation: LocalObservation, adapter: PerceptionAdapter, signal: AbortSignal,
  onPartial: (result: PerceptionResult) => void,
  onSection: (index: number, count: number) => void = () => {}, cache?: ResultCache<PerceptionResult>): Promise<PerceptionResult> {
  const { tiles, dom: { observationId } } = observation;
  const viewportHeight = observation.dom.viewport.height * observation.imageHeight / observation.captureBounds.height;
  const counts = tiles.map(tile => pageSections(tile.width, tile.height, viewportHeight).length);
  const count = counts.reduce((sum, value) => sum + value, 0);
  const regions: PerceptionResult['regions'] = [];
  let elapsedMs = 0, completedSections = 0;
  for (const [index, tile] of tiles.entries()) {
    if (signal.aborted) throw new Error('STOPPED');
    const translate = (result: PerceptionResult) => result.regions.flatMap(region => {
      const bounds = { ...region.bounds, y: region.bounds.y + tile.y };
      const center = bounds.y + bounds.height / 2;
      return center >= tile.start && center < tile.end ? [{ ...region, bounds }] : [];
    });
    // Section crops follow from the tile size and viewport height, so those
    // complete the key along with the pixels.
    const key = cache && `${await tileDigest(tile)}|${tile.width}x${tile.height}|${viewportHeight}`;
    const reused = key ? cache!.get(key) : undefined;
    if (reused) {
      for (let section = 0; section < counts[index]; section++) onSection(completedSections + section, count);
      regions.push(...translate(reused));
      completedSections += counts[index];
      onPartial({ observationId, source: 'model', regions: [...regions], elapsedMs });
      continue;
    }
    const image = new Image();
    const release = () => { image.src = ''; };
    signal.addEventListener('abort', release, { once: true });
    try {
      image.src = tile.screenshot;
      await image.decode();
      const result = await inspectPage(image, tile.width, tile.height, viewportHeight, observationId, adapter, signal,
        partial => onPartial({ observationId, source: 'model', regions: [...regions, ...translate(partial)], elapsedMs: elapsedMs + partial.elapsedMs }),
        section => onSection(completedSections + section, count));
      if (key) cache!.set(key, result);
      regions.push(...translate(result));
      elapsedMs += result.elapsedMs;
      completedSections += counts[index];
    } finally {
      signal.removeEventListener('abort', release);
      release();
    }
  }
  return { observationId, source: 'model', regions, elapsedMs };
}
