import type { LocalObservation, Rect } from '../../contracts';
import type { PerceptionAdapter, PerceptionResult } from '../contracts';
import { domBounds, intersection } from '../../privacy/geometry';
import { pngBytes } from '../../privacy/image';
import { mergeFaces } from './tiles';
import { tileDigest, type ResultCache } from '../reuse';

// BlazeFace short-range sees a 128px input. The page pass feeds it crops of at
// least 512px, so a face much under ~96px wide shrinks below what it can find:
// avatars, profile thumbnails and the photo on an ID card were all missed.
// This pass crops each small picture the DOM reports (<img>, canvas, video,
// CSS background image), enlarges it, and inspects it on its own. Boxes are
// mapped back to page pixels and merged with the page result. Crops come from
// the page's own image regions only, so the work is bounded by its pictures.
// SVG artwork is skipped: enlarged, round logos and icons scored 0.51-0.68 as
// faces on wikipedia.org, the same range as some real photographs (0.60 for a
// small historical portrait), so no score threshold separates them.
export const SMALL_FACE = Object.freeze({ minSide: 12, maxSide: 320, target: 256, crops: 150, padding: .25 });

type Region = PerceptionResult['regions'][number];

export function smallImages(observation: LocalObservation, faces: Region[]): Rect[] {
  const picked: Rect[] = [];
  for (const region of observation.dom.visualRegions ?? []) {
    if (region.category === 'form_control' || region.vector) continue;
    let box: Rect;
    // A region outside the capture has no pixels to inspect.
    try { box = domBounds(region.bounds, observation); } catch { continue; }
    const side = Math.max(box.width, box.height);
    if (Math.min(box.width, box.height) < SMALL_FACE.minSide || side > SMALL_FACE.maxSide) continue;
    // Already covered by a face from the page pass, or the same picture twice.
    const covered = (other: Rect) => {
      const shared = intersection(box, other);
      return !!shared && shared.width * shared.height >= box.width * box.height * .8;
    };
    if (faces.some(face => covered(face.bounds)) || picked.some(covered)) continue;
    picked.push(box);
    if (picked.length >= SMALL_FACE.crops) break;
  }
  return picked;
}

// `cache` maps one enlarged crop of a tile's pixels to the faces found in it,
// in crop coordinates.
export async function inspectSmallFaces(observation: LocalObservation, adapter: PerceptionAdapter, signal: AbortSignal,
  base: PerceptionResult, cache?: ResultCache<Region[]>): Promise<PerceptionResult> {
  const { imageWidth, imageHeight, dom: { observationId } } = observation;
  const crops = smallImages(observation, base.regions);
  if (!crops.length) return base;
  const found: Region[] = [];
  let elapsedMs = base.elapsedMs;
  const check = () => { if (signal.aborted) throw new Error('STOPPED'); };
  for (const tile of observation.tiles) {
    const owned = crops.filter(box => box.y + box.height / 2 >= tile.start && box.y + box.height / 2 < tile.end);
    if (!owned.length) continue;
    check();
    const digest = cache && await tileDigest(tile);
    // Decoded only when some crop of this tile is not already answered.
    let source: ImageBitmap | undefined;
    try {
      for (const box of owned) {
        check();
        const pad = Math.round(Math.max(box.width, box.height) * SMALL_FACE.padding);
        const left = Math.max(0, Math.floor(box.x - pad)), right = Math.min(tile.width, Math.ceil(box.x + box.width + pad));
        const top = Math.max(0, Math.floor(box.y - tile.y - pad)), bottom = Math.min(tile.height, Math.ceil(box.y - tile.y + box.height + pad));
        const width = right - left, height = bottom - top;
        if (width <= 0 || height <= 0) continue;
        const scale = Math.max(1, SMALL_FACE.target / Math.max(width, height));
        const resizeWidth = Math.round(width * scale), resizeHeight = Math.round(height * scale);
        const key = digest && `${digest}|${tile.width}x${tile.height}|${left},${top},${width},${height}|${resizeWidth}x${resizeHeight}`;
        let regions = key ? cache!.get(key) : undefined;
        if (!regions) {
          source ??= await createImageBitmap(new Blob([pngBytes(tile.screenshot, tile.width, tile.height)], { type: 'image/png' }));
          const image = await createImageBitmap(source, left, top, width, height, { resizeWidth, resizeHeight, resizeQuality: 'high' });
          const result = await adapter.inspect({ image, observationId }, signal);
          check();
          elapsedMs += result.elapsedMs;
          regions = result.regions;
          if (key) cache!.set(key, regions);
        }
        for (const region of regions) {
          if (region.kind !== 'face') continue;
          const b = region.bounds, sx = width / resizeWidth, sy = height / resizeHeight;
          const x = Math.max(0, Math.floor(left + b.x * sx)), y = Math.max(0, Math.floor(tile.y + top + b.y * sy));
          const r = Math.min(imageWidth, Math.ceil(left + (b.x + b.width) * sx)), bottom = Math.min(imageHeight, Math.ceil(tile.y + top + (b.y + b.height) * sy));
          if (r > x && bottom > y) found.push({ ...region, bounds: { x, y, width: r - x, height: bottom - y } });
        }
        // Allow paint and input between crops.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } finally { source?.close(); }
  }
  return { observationId, source: 'model', regions: mergeFaces([...base.regions, ...found]), elapsedMs };
}
