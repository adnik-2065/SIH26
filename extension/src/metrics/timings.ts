export interface Timing { stage: 'dom' | 'capture' | 'ocr' | 'vision'; milliseconds: number; }
export function summarize(samples: number[]) {
  if (!samples.length) return { count: 0, median: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return { count: sorted.length, median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
}

// One round's wall-clock stages, read from the run's own stage transitions:
// capture runs from the round's first CAPTURING to its last DETECTING (so a
// capture retry is charged to capture), detection to REDACTING, redaction
// (including the final verification pass) to SENDING, the server to the first
// EXECUTING, and the action to the end of the round. Detector times run from
// the start of detection to each detector's own completion; they overlap.
export type RoundMark = 'CAPTURING' | 'DETECTING' | 'REDACTING' | 'SENDING' | 'EXECUTING';
export type DetectorName = 'ocr' | 'faces' | 'documents';
export interface RoundClock {
  marks: Partial<Record<RoundMark, number>>;
  detectors: Partial<Record<DetectorName, number>>;
  // The accepted capture of this round, from the worker's own measurements.
  capture?: { scope: 'viewport' | 'page'; screenshots: number; domMs: number; captureMs: number };
}
export const newRoundClock = (): RoundClock => ({ marks: {}, detectors: {} });
const keepFirst: ReadonlySet<string> = new Set(['CAPTURING', 'EXECUTING']);
export function markStage(clock: RoundClock, stage: string, at: number) {
  if (!['CAPTURING', 'DETECTING', 'REDACTING', 'SENDING', 'EXECUTING'].includes(stage)) return;
  const mark = stage as RoundMark;
  if (keepFirst.has(mark) && clock.marks[mark] !== undefined) return;
  clock.marks[mark] = at;
  // A new detection pass replaces the one a retry abandoned.
  if (mark === 'DETECTING') clock.detectors = {};
}
export function markDetector(clock: RoundClock, detector: DetectorName, at: number) {
  const started = clock.marks.DETECTING;
  if (started !== undefined) clock.detectors[detector] = at - started;
}
export function formatRoundTimings(round: number, clock: RoundClock, end: number) {
  const { CAPTURING, DETECTING, REDACTING, SENDING, EXECUTING } = clock.marks;
  const span = (from?: number, to?: number) => from !== undefined && to !== undefined && to >= from ? to - from : undefined;
  const show = (ms?: number) => ms === undefined ? '—' : `${(ms / 1000).toFixed(2)} s`;
  const parts: Array<[string, number | undefined]> = [
    ['capture', span(CAPTURING, DETECTING)],
    ['OCR', clock.detectors.ocr], ['faces', clock.detectors.faces], ['documents', clock.detectors.documents],
    ['redaction', span(REDACTING, SENDING)],
    ['server', span(SENDING, EXECUTING)],
    ['action', span(EXECUTING, end)],
    ['total', span(CAPTURING, end)],
  ];
  return `Round ${round} timings: ${parts.map(([name, ms]) => `${name} ${show(ms)}`).join(' · ')}`;
}

// What each detector actually did this round: model runs, results answered
// from identical pixels, and inputs skipped because the detector could not
// have contributed there. Counts and reasons only, never page content.
export interface DetectorWork { runs: number; reused: number; skipped: number }
export type RoundWork = Record<'ocr' | 'faces' | 'smallFaces' | 'documents', DetectorWork>;
const skipReasons: Record<keyof RoundWork, string> = { ocr: 'no tile', faces: 'no tile',
  smallFaces: 'no small picture', documents: 'no image region' };
const workNames: Record<keyof RoundWork, string> = { ocr: 'OCR', faces: 'faces', smallFaces: 'small faces', documents: 'documents' };
export function formatRoundWork(round: number, clock: RoundClock, work: RoundWork) {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const capture = clock.capture
    ? `DOM ${(clock.capture.domMs / 1000).toFixed(2)} s · ${plural(clock.capture.screenshots, 'screenshot')} (${clock.capture.scope}) in ${(clock.capture.captureMs / 1000).toFixed(2)} s`
    : 'no capture';
  const detectors = (Object.keys(workNames) as Array<keyof RoundWork>).map(name => {
    const { runs, reused, skipped } = work[name];
    const parts = [runs ? plural(runs, 'run') : '', reused ? `${reused} REUSED (unchanged pixels)` : '',
      skipped ? `${skipped} SKIPPED (${skipReasons[name]})` : ''].filter(Boolean);
    // Small faces run only on the pictures they pick; the others idle only
    // when the round never reached them.
    return `${workNames[name]} ${parts.length ? parts.join(', ') : name === 'smallFaces' ? `SKIPPED (${skipReasons[name]})` : '—'}`;
  });
  return `Round ${round} work: ${[capture, ...detectors].join(' · ')}`;
}

// How each detector ran this round: the backend its worker chose, the model
// load (timed once per worker), the time inspections spent waiting for that
// load, and the time spent in the model itself. Numbers and backend names
// only, never page content.
export type Backend = 'wasm' | 'webgpu';
// What the document worker found: no WebGPU, a software adapter it will not
// use, or a hardware adapter.
export type GpuAvailability = 'none' | 'software' | 'hardware';
export interface RuntimeSample { backend: Backend; loadMs: number; waitMs: number; inferenceMs: number; gpu?: GpuAvailability }
export interface DetectorRuntime { backends: Set<Backend>; loadMs?: number; waitMs: number; inferenceMs: number; runs: number; gpu?: GpuAvailability }
export const newDetectorRuntime = (): DetectorRuntime => ({ backends: new Set(), waitMs: 0, inferenceMs: 0, runs: 0 });
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
// A worker's report is checked before it is counted; a malformed one is dropped.
export function readRuntimeSample(value: unknown): RuntimeSample | undefined {
  const sample = value as Partial<RuntimeSample> | undefined;
  if (!sample || (sample.backend !== 'wasm' && sample.backend !== 'webgpu') || !finite(sample.loadMs) || !finite(sample.waitMs) || !finite(sample.inferenceMs)) return undefined;
  const gpu = sample.gpu === 'none' || sample.gpu === 'software' || sample.gpu === 'hardware' ? sample.gpu : undefined;
  return { backend: sample.backend, loadMs: sample.loadMs!, waitMs: sample.waitMs!, inferenceMs: sample.inferenceMs!, gpu };
}
export function recordRuntime(runtime: DetectorRuntime, sample: RuntimeSample) {
  runtime.backends.add(sample.backend);
  runtime.loadMs = Math.max(runtime.loadMs ?? 0, sample.loadMs);
  runtime.waitMs = Math.max(runtime.waitMs, sample.waitMs);
  runtime.inferenceMs += sample.inferenceMs; runtime.runs++;
  if (sample.gpu) runtime.gpu = sample.gpu;
}
// Lanes read at the same time, so the round waited for the slowest load, and
// their model time adds up across workers.
export function mergeRuntimes(runtimes: DetectorRuntime[]): DetectorRuntime {
  const merged = newDetectorRuntime();
  for (const runtime of runtimes) {
    runtime.backends.forEach(backend => merged.backends.add(backend));
    if (runtime.loadMs !== undefined) merged.loadMs = Math.max(merged.loadMs ?? 0, runtime.loadMs);
    merged.waitMs = Math.max(merged.waitMs, runtime.waitMs);
    merged.inferenceMs += runtime.inferenceMs; merged.runs += runtime.runs;
    merged.gpu ??= runtime.gpu;
  }
  return merged;
}
export function resetRuntime(runtime: DetectorRuntime) {
  runtime.backends.clear(); runtime.loadMs = undefined; runtime.waitMs = 0; runtime.inferenceMs = 0; runtime.runs = 0; runtime.gpu = undefined;
}
const backendNames: Record<Backend, string> = { wasm: 'WASM', webgpu: 'WebGPU' };
const gpuNames: Record<GpuAvailability, string> = { none: 'unavailable', software: 'software only (not used)', hardware: 'available' };
export function formatRoundRuntime(round: number, detectors: Record<'ocr' | 'faces' | 'documents', { workers: number; runtime: DetectorRuntime }>) {
  const seconds = (ms: number) => `${(ms / 1000).toFixed(2)} s`;
  const names = { ocr: 'OCR', faces: 'faces', documents: 'documents' };
  const parts = (Object.keys(names) as Array<keyof typeof names>).map(name => {
    const { workers, runtime } = detectors[name];
    if (!runtime.runs) return `${names[name]} —`;
    const backend = [...runtime.backends].map(value => backendNames[value]).join('+');
    const load = runtime.loadMs === undefined ? '' : `, load ${seconds(runtime.loadMs)}`;
    return `${names[name]} ${backend} ×${workers} worker${workers === 1 ? '' : 's'}${load}, waited ${seconds(runtime.waitMs)}, model ${seconds(runtime.inferenceMs)} (${runtime.runs} run${runtime.runs === 1 ? '' : 's'})`;
  });
  const gpu = detectors.documents.runtime.gpu;
  return `Round ${round} runtime: ${parts.join(' · ')} · WebGPU ${gpu ? gpuNames[gpu] : '—'}`;
}
