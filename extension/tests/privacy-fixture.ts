import type { Binding, ExportData } from '../src/privacy/contracts';

export const fictional = ['mira@example.test', '9876543210', 'ABCDE1234F', '4111 1111 1111 1111', 'fictional-secret-42'];
export const binding: Binding = { taskId: '10000000-0000-4000-8000-000000000001', observationId: '20000000-0000-4000-8000-000000000002', origin: 'https://example.test',
  documentId: '30000000-0000-4000-8000-000000000003', revision: 0, generation: 1, tabId: 1 };
export function fixture(): ExportData {
  return { binding: { ...binding }, instruction: 'Contact Mira at mira@example.test before 9876543210.', image: 'none',
    observation: { dom: { observationId: binding.observationId, documentId: binding.documentId, revision: 0, origin: binding.origin,
      viewport: { width: 200, height: 100, scrollX: 0, scrollY: 0, offsetX: 0, offsetY: 0, devicePixelRatio: 1, visualScale: 1 },
      elements: [{ id: `${binding.observationId}_e1`, role: 'textbox', type: 'email', label: 'Email mira@example.test', sensitive: false, disabled: false,
        bounds: { x: 10, y: 10, width: 100, height: 20 } }], truncated: false, hiddenCount: 0 },
      captureBounds: { x: 0, y: 0, width: 200, height: 200 }, imageWidth: 200, imageHeight: 200, tileCount: 2, captureMs: 1, domMs: 1, capturedAt: Date.now(),
      tiles: [{ screenshot: 'data:image/png;base64,Zmlyc3Q=', y: 0, width: 200, height: 125, start: 0, end: 100 },
        { screenshot: 'data:image/png;base64,c2Vjb25k', y: 75, width: 200, height: 125, start: 100, end: 200 }] },
    ocr: { status: 'complete', completedTiles: 2, truncated: false, result: { observationId: binding.observationId, source: 'model', elapsedMs: 1,
      regions: [{ kind: 'text', text: 'mira', confidence: .99, bounds: { x: 10, y: 90, width: 30, height: 10 } },
        { kind: 'text', text: '@', confidence: .99, bounds: { x: 45, y: 90, width: 10, height: 10 } },
        { kind: 'text', text: 'example.test', confidence: .99, bounds: { x: 10, y: 102, width: 80, height: 10 } }] } },
    faces: { status: 'complete', completedTiles: 2, truncated: false, result: { observationId: binding.observationId, source: 'model', elapsedMs: 1,
      regions: [{ kind: 'face', confidence: .95, bounds: { x: 70, y: 90, width: 25, height: 25 } }] } },
    documents: { status: 'not_enabled', required: false, observationId: binding.observationId, regions: [] } };
}
