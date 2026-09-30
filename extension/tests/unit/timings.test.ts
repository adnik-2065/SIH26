import { expect, it } from 'vitest';
import { formatRoundRuntime, formatRoundTimings, formatRoundWork, markDetector, markStage, mergeRuntimes, newDetectorRuntime, newRoundClock,
  readRuntimeSample, recordRuntime, resetRuntime, summarize } from '../../src/metrics/timings';
it('reports sample count, median, and nearest-rank p95 without mutating samples', () => {
  const samples = [40, 10, 30, 20];
  expect(summarize(samples)).toEqual({ count: 4, median: 25, p95: 40 });
  expect(samples).toEqual([40, 10, 30, 20]);
  expect(summarize([])).toEqual({ count: 0, median: 0, p95: 0 });
});

it('formats one line of per-stage round timings from stage transitions', () => {
  const clock = newRoundClock();
  markStage(clock, 'CAPTURING', 1000);
  markStage(clock, 'DETECTING', 1400);
  markDetector(clock, 'ocr', 1600);
  // A capture retry restarts detection but keeps the round's first capture.
  markStage(clock, 'CAPTURING', 1700);
  markStage(clock, 'DETECTING', 2000);
  markDetector(clock, 'ocr', 3200);
  markDetector(clock, 'faces', 2500);
  markDetector(clock, 'documents', 2100);
  markStage(clock, 'REDACTING', 3300);
  markStage(clock, 'SENDING', 3400);
  markStage(clock, 'WAITING_RESPONSE', 3450);
  markStage(clock, 'EXECUTING', 4400);
  markStage(clock, 'EXECUTING', 4600);
  expect(formatRoundTimings(3, clock, 5000)).toBe('Round 3 timings: capture 1.00 s · OCR 1.20 s · faces 0.50 s · documents 0.10 s · ' +
    'redaction 0.10 s · server 1.00 s · action 0.60 s · total 4.00 s');
});

it('marks stages a round never reached as missing', () => {
  const clock = newRoundClock();
  markStage(clock, 'CAPTURING', 0);
  expect(formatRoundTimings(1, clock, 250)).toBe('Round 1 timings: capture — · OCR — · faces — · documents — · ' +
    'redaction — · server — · action — · total 0.25 s');
});

it('counts each detector\'s runs, reuses and skips with their reasons', () => {
  const clock = newRoundClock();
  clock.capture = { scope: 'viewport', screenshots: 1, domMs: 31, captureMs: 612 };
  expect(formatRoundWork(2, clock, { ocr: { runs: 1, reused: 0, skipped: 0 }, faces: { runs: 0, reused: 1, skipped: 0 },
    smallFaces: { runs: 0, reused: 0, skipped: 0 }, documents: { runs: 0, reused: 0, skipped: 1 } }))
    .toBe('Round 2 work: DOM 0.03 s · 1 screenshot (viewport) in 0.61 s · OCR 1 run · faces 1 REUSED (unchanged pixels) · ' +
      'small faces SKIPPED (no small picture) · documents 1 SKIPPED (no image region)');
});

it('reports each detector backend, model load, wait and model time, and drops malformed worker reports', () => {
  expect(readRuntimeSample({ backend: 'cuda', loadMs: 1, waitMs: 0, inferenceMs: 1 })).toBeUndefined();
  expect(readRuntimeSample({ backend: 'wasm', loadMs: -1, waitMs: 0, inferenceMs: 1 })).toBeUndefined();
  expect(readRuntimeSample({ backend: 'wasm', loadMs: 1, waitMs: Number.NaN, inferenceMs: 1 })).toBeUndefined();
  expect(readRuntimeSample({ backend: 'webgpu', loadMs: 1, waitMs: 0, inferenceMs: 1, gpu: 'quantum', text: 'secret' }))
    .toEqual({ backend: 'webgpu', loadMs: 1, waitMs: 0, inferenceMs: 1, gpu: undefined });
  const lanes = [newDetectorRuntime(), newDetectorRuntime()];
  recordRuntime(lanes[0], { backend: 'wasm', loadMs: 900, waitMs: 400, inferenceMs: 700 });
  recordRuntime(lanes[0], { backend: 'wasm', loadMs: 900, waitMs: 0, inferenceMs: 500 });
  recordRuntime(lanes[1], { backend: 'wasm', loadMs: 1100, waitMs: 600, inferenceMs: 800 });
  const documents = newDetectorRuntime();
  recordRuntime(documents, { backend: 'webgpu', loadMs: 2400, waitMs: 0, inferenceMs: 105, gpu: 'hardware' });
  expect(formatRoundRuntime(3, { ocr: { workers: 4, runtime: mergeRuntimes(lanes) }, faces: { workers: 1, runtime: newDetectorRuntime() },
    documents: { workers: 1, runtime: documents } })).toBe('Round 3 runtime: OCR WASM ×4 workers, load 1.10 s, waited 0.60 s, model 2.00 s (3 runs) · ' +
    'faces — · documents WebGPU ×1 worker, load 2.40 s, waited 0.00 s, model 0.10 s (1 run) · WebGPU available');
  resetRuntime(documents);
  expect(documents).toEqual({ ...newDetectorRuntime(), loadMs: undefined, gpu: undefined });
});
