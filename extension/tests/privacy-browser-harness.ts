import { captureTiles } from '../src/capture/tiles';
import { fixture } from './privacy-fixture';
export { buildSafeStepRequest, LocalValueVault } from '../src/privacy';
export { normalize } from '../src/privacy/normalize';
export { redactImage } from '../src/privacy/image';
export { Placeholders } from '../src/privacy/text';
export { LIMITS } from '../src/privacy/contracts';
export { fixture } from './privacy-fixture';
export { inspectDocumentTiles, detectLocalDocuments } from '../src/vision/documents';
export { collect } from '../src/dom/observe';
export { act } from '../src/dom/act';
export { planActions, executableNow } from '../src/agent/protocol';

export function visualFixture(scale = 1, long = false) {
  const data = fixture();
  const width = 200 * scale, height = (long ? 40000 : 200) * scale;
  data.image = 'required';
  data.observation.imageWidth = width; data.observation.imageHeight = height;
  data.observation.captureBounds.height = height / scale;
  data.observation.dom.viewport.devicePixelRatio = scale;
  const bands = long ? captureTiles(width, height, 500 * scale) :
    [{ y: 0, height: Math.ceil(125 * scale), start: 0, end: 100 * scale },
      { y: Math.floor(75 * scale), height: height - Math.floor(75 * scale), start: 100 * scale, end: height }];
  const seam = bands[0].end;
  data.ocr.result!.regions = [
    { kind: 'text', text: 'mira', confidence: .99, bounds: { x: 10 * scale, y: seam - 10 * scale, width: 30 * scale, height: 10 * scale } },
    { kind: 'text', text: '@', confidence: .99, bounds: { x: 45 * scale, y: seam - 10 * scale, width: 10 * scale, height: 10 * scale } },
    { kind: 'text', text: 'example.test', confidence: .99, bounds: { x: 10 * scale, y: seam + 2 * scale, width: 80 * scale, height: 10 * scale } },
    { kind: 'text', text: 'ABCDE1234F', confidence: .99, bounds: { x: 10 * scale, y: height - 20 * scale, width: 80 * scale, height: 10 * scale } },
  ];
  data.faces.result!.regions[0].bounds = { x: 70 * scale, y: seam - 10 * scale, width: 25 * scale, height: 25 * scale };
  data.documents.status = 'complete';
  data.documents.regions = [{ kind: 'document', confidence: .95, bounds: { x: 60 * scale, y: seam - 20 * scale, width: 50 * scale, height: 50 * scale } }];
  data.observation.tiles = bands.map(band => {
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = band.height;
    const context = canvas.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, width, band.height);
    context.fillStyle = '#ff00ff';
    for (const region of [...data.ocr.result!.regions, ...data.faces.result!.regions, ...data.documents.regions]) {
      const b = region.bounds; context.fillRect(b.x, b.y - band.y, b.width, b.height);
    }
    context.fillStyle = '#000'; context.font = `${8 * scale}px Arial`;
    for (const region of data.ocr.result!.regions) context.fillText(region.text!, region.bounds.x, region.bounds.y - band.y + 8 * scale);
    const screenshot = canvas.toDataURL('image/png'); canvas.width = 0; canvas.height = 0;
    return { ...band, width, screenshot };
  });
  data.observation.tileCount = bands.length; data.ocr.completedTiles = bands.length; data.faces.completedTiles = bands.length;
  return data;
}
