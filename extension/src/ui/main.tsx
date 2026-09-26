import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelEventSchema, TaskStateSchema, type CaptureTile, type ErrorCode, type LocalObservation, type TaskState } from '../contracts';
import { CAPTURE_RETRY_BACKOFF_MS, CAPTURE_RETRY_LIMIT, initialState, lifecycleStateLog, newActionHistory, newLoopTracker, nextCaptureRetry, nextRound, recordActionHistory, resetActionHistory, roundVerdict, RUN_LIMIT, type ActionHistoryEntry } from '../agent/lifecycle';
import { TesseractAdapter, type OcrProgress } from '../vision/ocr/tesseract';
import { MediaPipeAdapter } from '../vision/face/mediapipe';
import { inspectCapturedPage } from '../vision/page';
import { validateDeliveredTiles } from '../capture/tiles';
import { AGENT_ENDPOINT, runtimePermissions, validateAgentEndpoint } from '../config';
import { advance, beginRun, type RunStage, type RunState } from '../agent/run';
import { inspectDocumentTiles, type DocumentEvidence } from '../vision/documents';
import { OnnxDocumentAdapter } from '../vision/documents/onnx';
import { PagePreview } from './preview';
import { PrivacyReview } from '../privacy/review';
import { TransportFailureNotice } from '../agent/steps';
import { abortWith } from '../agent/diagnostics';
import type { AbortSource, ExtensionError } from '../contracts';
import type { PerceptionResult } from '../vision/contracts';
import type { ExecutionReport } from '../agent/wire';
import './styles.css';

const messages: Record<ErrorCode, string> = {
  ACCESS_REQUIRED: 'Open a webpage, then click the extension icon on that tab to grant access.',
  PAGE_CHANGED: 'The page or active tab changed. Observe again to read the updated page.',
  STOPPED: 'Stopped. The screenshot and detections have been cleared.',
  CAPTURE_FAILED: 'Could not capture a stable page. Click the extension icon on this tab, wait for the page to settle, and try again.',
  CAPTURE_TOO_LARGE: 'This page exceeds the local scan capacity. Try narrowing the page content and scan again.',
  INVALID_MESSAGE: 'A component returned an invalid message.', BUSY: 'An observation is already running.',
  RESTARTED: 'The background worker restarted. Observe again to capture a fresh view.',
  TARGET_CHANGED: 'That control moved or is no longer reachable. Observe again before acting.',
  TARGET_UNSAFE: 'The step targeted a password or one-time-code field. It was not performed.',
  ACTION_FAILED: 'The step could not be completed on this page.',
};
// One 16px icon set, drawn inline: the panel loads no remote font or sprite.
const paths: Record<string, string> = {
  send: 'M4 11.5 12 3.5M12 3.5v6M12 3.5H6',
  square: 'M4.5 4.5h7v7h-7z',
  scan: 'M2.5 5.5v-3h3M10.5 2.5h3v3M13.5 10.5v3h-3M5.5 13.5h-3v-3M2.5 8h11',
  check: 'M3 8.4l3.2 3.1L13 4.8',
  alert: 'M8 5.2v3.6M8 11.3v.2M8 2.4 1.9 13.1h12.2z',
  shield: 'M8 2.2 13.2 4v4.1c0 3-2.2 4.8-5.2 5.7-3-.9-5.2-2.7-5.2-5.7V4z',
  activity: 'M2.5 8.4h2.8l1.7-4.6 2.6 8.4 1.6-3.8h2.3',
  settings: 'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 1.8v1.6M8 12.6v1.6M2.6 8H1M15 8h-1.6M4.2 4.2 3 3M13 13l-1.2-1.2M11.8 4.2 13 3M3 13l1.2-1.2',
  more: 'M4 8h.01M8 8h.01M12 8h.01',
  close: 'M4 4l8 8M12 4l-8 8',
};
function Glyph({ name }: { name: keyof typeof paths | string }) {
  return <svg className="glyph" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
    strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
function Meter({ label, value, max, detail }: { label: string; value?: number; max: number; detail?: string }) {
  return <div className="meter">
    <div className="meter-label"><span>{label}</span>{detail && <span>{detail}</span>}</div>
    <progress aria-label={label} max={max} value={value} />
  </div>;
}
interface LogLine { at: string; kind: 'info' | 'server' | 'action' | 'error'; text: string }
type DetailView = 'activity' | 'privacy' | 'settings';
// Every detector code the pipeline can raise, mapped to one sentence. An
// unmapped code still shows the code itself rather than a generic sentence.
const detectorErrors: Record<string, string> = {
  OCR_TIMEOUT: 'Reading took too long. Try again, or capture a smaller browser window.',
  OCR_TOO_MUCH_TEXT: 'This view exceeds the 500-word limit. Make the browser window smaller and observe again.',
  OCR_WORKER_INIT_FAILED: 'The text engine could not start. Rebuild and reload the extension.',
  OCR_EXECUTION_FAILED: 'The text engine failed while reading this capture.',
  OCR_INVALID_OBSERVATION: 'Text results arrived for a different capture and were discarded.',
  OCR_INVALID_BOUNDS: 'Text results fell outside the captured image and were discarded.',
  OCR_NORMALIZATION_FAILED: 'Text results could not be converted into the local contract.',
  OCR_BUSY: 'The text engine was still busy with the previous scan.',
  FACE_TIMEOUT: 'Face detection took too long. Retry with a smaller browser window.',
  FACE_BUSY: 'Face detection was still busy with the previous scan.',
  VISION_TIMEOUT: 'Document detection took too long. Retry the scan.',
  VISION_BUSY: 'Document detection was still busy with the previous scan.',
  STOPPED: 'The scan was stopped before this detector finished.',
};
const detectorMessage = (code: string, fallback: string) => detectorErrors[code] ? `${detectorErrors[code]} (${code})` : `${fallback} (${code})`;

function App() {
  const [state, setState] = useState<TaskState>(initialState);
  const stateRef = useRef(state);
  const [instruction, setInstruction] = useState('');
  const [observation, setObservation] = useState<LocalObservation>();
  const [preview, setPreview] = useState(true);
  const previewRef = useRef(true);
  const [error, setError] = useState('');
  const [autoRun, setAutoRun] = useState(false);
  const [round, setRound] = useState(1);
    const [executionReport, setExecutionReport] = useState<ExecutionReport>();
  // The generation this round's capture was launched at, and the generation a
  // retry has already been issued for. See `roundVerdict`.
  const [roundGeneration, setRoundGeneration] = useState<number | undefined>(undefined);
  const retriedGeneration = useRef<number | undefined>(undefined);
  const retries = useRef(0);
  const retryReasons = useRef<string[]>([]);
  const [runNotice, setRunNotice] = useState('');
  const [runId, setRunId] = useState<string>();
  const [runStage, setRunStage] = useState<RunStage>('IDLE');
  const runRef = useRef<RunState | undefined>(undefined);
  // Action history and loop tracking live for the whole task, across the
  // per-round remounts of the scan pipeline, and reset only when a new task
  // starts. History is written by the executor's actual result (through
  // `recordActionHistory`); the loop tracker counts equivalent state+action
  // cycles across rounds.
  const actionHistoryRef = useRef<ActionHistoryEntry[]>(newActionHistory());
  const loopTrackerRef = useRef(newLoopTracker());
  const [lastFailure, setLastFailure] = useState<ExtensionError>();
  const runIdRef = useRef<string | undefined>(undefined);
  const [log, setLog] = useState<LogLine[]>([]);
  const [detailView, setDetailView] = useState<DetailView>();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const addLog = (kind: LogLine['kind'], text: string, detail?: unknown) => {
    // The panel has its own devtools console (right-click the panel → Inspect),
    // which is the only place the untruncated server reply can be read.
    console.info(`[SIH26] ${kind}: ${text}`, detail ?? '');
    setLog(lines => [...lines, { at: new Date().toLocaleTimeString(), kind, text }].slice(-200));
  };
  const [ocr, setOcr] = useState<PerceptionResult>();
  const [faces, setFaces] = useState<PerceptionResult>();
  const [faceBusy, setFaceBusy] = useState(false);
  const [faceError, setFaceError] = useState('');
  const [documents, setDocuments] = useState<DocumentEvidence>();
  const [documentBusy, setDocumentBusy] = useState(false);
  const [documentError, setDocumentError] = useState('');
  const [showFaces, setShowFaces] = useState(true);
  const [selectedFace, setSelectedFace] = useState<number>();
  const [resultTab, setResultTab] = useState<'text' | 'faces'>('text');
  const [query, setQuery] = useState('');
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrError, setOcrError] = useState('');
  const [progress, setProgress] = useState<OcrProgress>();
  const [selected, setSelected] = useState<number>();
  const [ocrAdapter, setOcrAdapter] = useState<TesseractAdapter>();
  const [showText, setShowText] = useState(true);
  const [showControls, setShowControls] = useState(false);
  const [fullSize, setFullSize] = useState(false);
  const [retry, setRetry] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const adapterRef = useRef<TesseractAdapter | null>(null);
  const ocrSectionRef = useRef({ index: 0, count: 1 });
  const faceAdapterRef = useRef<MediaPipeAdapter | null>(null);
  const documentAdapterRef = useRef<OnnxDocumentAdapter | null>(null);
  const captureTilesRef = useRef<CaptureTile[]>([]);
  const [captureProgress, setCaptureProgress] = useState<{ index: number; count: number }>();
  const stopPending = useRef(false);

  // This controller is what the agent request listens to, so every caller says
  // why it is cancelling. Without a source an aborted request is reported as an
  // unreachable server, which is how a task restart came to look like a network
  // failure.
  const clearDetections = (source: AbortSource = 'task_replaced', reason = 'the panel cleared the current detections') => {
    if (controllerRef.current) abortWith(controllerRef.current, source, reason, { runId: runIdRef.current, scope: 'detections' });
    setFaces(undefined); setFaceBusy(false); setFaceError(''); setSelectedFace(undefined); setQuery('');
    setDocuments(undefined); setDocumentBusy(false); setDocumentError('');
    setOcr(undefined); setOcrBusy(false); setProgress(undefined); setOcrError(''); setSelected(undefined);
  };
  const applyState = (next: TaskState) => {
    if (next.generation !== stateRef.current.generation || next.observationId !== stateRef.current.observationId || next.status === 'stopped') {
      // The exact user-visible refusal line, now timestamped with the old and
      // new generation so a task_replaced abort can be tied to the event that
      // published it.
      lifecycleStateLog('panel_task_replaced', next);
      clearDetections(next.status === 'stopped' ? 'user_cancel' : 'task_replaced',
        next.status === 'stopped' ? 'the task was stopped' : `the worker published generation ${next.generation}${next.error ? ` after ${next.error}` : ''}`); setObservation(undefined); captureTilesRef.current = []; setCaptureProgress(undefined);
    }
    stateRef.current = next; setState(next);
    if (next.status === 'stopped') { adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); documentAdapterRef.current?.dispose(); setInstruction(''); }
  };

  useEffect(() => {
    const listener = (raw: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab) return;
      const parsed = PanelEventSchema.safeParse(raw);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.state.generation < stateRef.current.generation) return;
      applyState(event.state);
      if (event.type === 'CAPTURE_TILE' && !stopPending.current) {
        setCaptureProgress({ index: event.index + 1, count: event.count });
        if (previewRef.current) captureTilesRef.current[event.index] = event.tile;
      }
      if (event.type === 'CAPTURE_TILE') stage('CAPTURING');
      if (event.type === 'OBSERVATION') {
        const tiles = captureTilesRef.current;
        captureTilesRef.current = []; setCaptureProgress(undefined);
        if (previewRef.current && !stopPending.current) {
          const info = event.observation;
          // Same strictness, but the refusal now names the tile and the
          // mismatch instead of collapsing into one capture failure.
          const validation = validateDeliveredTiles(Array.from({ length: info.tileCount }, (_, i) => tiles[i]), info);
          if (!validation.ok) {
            addLog('error', `${validation.error.code} at ${validation.error.stage}: ${validation.error.message}`, validation.error);
            setLastFailure(runIdRef.current ? { ...validation.error, runId: runIdRef.current } : validation.error);
            setError(`${validation.error.message} (${validation.error.code})`);
            return;
          }
          stage('DETECTING');
          setObservation({ ...info, tiles });
        }
      }
    };
    // The endpoint, the host permission and connect-src are one configuration.
    // Checking them when the panel opens turns "the request failed" into a
    // sentence about the packaged extension, before any request is made.
    const endpointProblem = validateAgentEndpoint(AGENT_ENDPOINT, runtimePermissions());
    if (endpointProblem) {
      setLastFailure(endpointProblem);
      setError(`${endpointProblem.message} (${endpointProblem.code})`);
    }
    chrome.runtime.onMessage.addListener(listener);
    void chrome.runtime.sendMessage({ type: 'STATUS' }).then(reply => {
      const parsed = TaskStateSchema.safeParse(reply?.state);
      if (parsed.success && parsed.data.generation >= stateRef.current.generation) applyState(parsed.data);
    }).catch(() => setError('Reload the extension and open the panel again.'));
    const dispose = (event?: Event) => {
      if (controllerRef.current) abortWith(controllerRef.current, event?.type === 'pagehide' ? 'pagehide' : 'panel_unmount',
        event?.type === 'pagehide' ? 'the panel document was hidden' : 'the panel unmounted', { runId: runIdRef.current, scope: 'detections' });
      adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); documentAdapterRef.current?.dispose(); };
    window.addEventListener('pagehide', dispose);
    return () => { chrome.runtime.onMessage.removeListener(listener); window.removeEventListener('pagehide', dispose); dispose(); };
  }, []);

  useEffect(() => {
    if (!observation) return;
    const controller = new AbortController(); controllerRef.current = controller;
    const generation = stateRef.current.generation;
    const current = () => !controller.signal.aborted && !stopPending.current && previewRef.current &&
      stateRef.current.generation === generation && stateRef.current.observationId === observation.dom.observationId;
    setOcrBusy(true); setOcr(undefined); setOcrError(''); setProgress(undefined); setSelected(undefined);
    setFaceBusy(true); setFaces(undefined); setFaceError(''); setSelectedFace(undefined); setQuery('');
    ocrSectionRef.current = { index: 0, count: 1 };
    if (!adapterRef.current) {
      adapterRef.current = new TesseractAdapter(p => {
        const { index, count } = ocrSectionRef.current;
        setProgress(p.status === 'recognizing text' ? { ...p, progress: (index + p.progress) / count } : p);
      });
      setOcrAdapter(adapterRef.current);
    }
    faceAdapterRef.current ??= new MediaPipeAdapter();
    documentAdapterRef.current ??= new OnnxDocumentAdapter();
    // Decode only the current capture tile in each pipeline.
    const inspect = async (kind: 'text' | 'face') => {
      try {
        if (!current()) return;
        const adapter = kind === 'text' ? adapterRef.current! : faceAdapterRef.current!;
        const update = (result: PerceptionResult) => { if (current()) { if (kind === 'text') setOcr(result); else setFaces(result); } };
        const result = await inspectCapturedPage(observation, adapter, controller.signal, update,
          (index, count) => { if (kind === 'text') ocrSectionRef.current = { index, count }; });
        if (current()) { if (kind === 'text') setOcr(result); else setFaces(result); }
      } catch (reason) {

        if (current()) {
          const code = reason instanceof Error ? reason.message : String(reason);
          if (kind === 'text') setOcrError(detectorMessage(code, 'Text reading failed. Retry the scan, or rebuild and reload the extension.'));
          else setFaceError(detectorMessage(code, 'Face detection failed. Retry the scan, or rebuild and reload the extension.'));
        }
      } finally {
        if (current()) { if (kind === 'text') setOcrBusy(false); else setFaceBusy(false); }
      }
    };
    setDocumentBusy(true); setDocuments(undefined); setDocumentError('');
    const inspectDocuments = async () => {
      try {
        const result = await inspectDocumentTiles(observation, documentAdapterRef.current!, controller.signal);
        if (current()) setDocuments(result);
      } catch (reason) {
        if (current()) {
          const failure = reason as { reason?: string; detail?: { code?: string; message?: string } };
          const code = failure?.detail?.code ?? failure?.reason ?? (reason instanceof Error ? reason.message : String(reason));
          setDocumentError(failure?.detail?.message
            ? `${failure.detail.message} (${code})`
            : detectorMessage(code, 'Document detection failed. Retry the scan or rebuild the extension.'));
        }
      } finally { if (current()) setDocumentBusy(false); }
    };
    void Promise.allSettled([inspect('text'), inspect('face'), inspectDocuments()]);
    return () => abortWith(controller, 'task_replaced', 'a newer observation replaced this one', { runId: runIdRef.current, scope: 'detections' });
  }, [observation, retry]);

  // A run is a chain of ordinary rounds, each one a scan the user could have
  // asked for by hand. The cap stops a model that keeps proposing steps.
  // The run registry is a ref, so a second submit in the same tick sees the
  // first one. React state cannot do that: `taskRunning` is still false until
  // the next render, which is exactly the window a double click lands in.
  const stage = (next: RunStage) => {
    if (!runRef.current) return;
    runRef.current = advance(runRef.current, next, { log: entry => addLog('info', `[${entry.runId}] ${entry.message}`) });
    setRunStage(runRef.current.stage);
  };
  function startRun() {
    if (!instruction.trim()) { setRunNotice('Describe the task first.'); return; }
    const outcome = beginRun(runRef.current, { log: entry => addLog(entry.reason === 'DUPLICATE_RUN_IGNORED' ? 'error' : 'info',
      `[${entry.runId}] ${entry.message}${entry.reason ? ` (${entry.reason}, stage ${entry.stage})` : ''}`) });
    if (!outcome.started) {
      setRunNotice(`A run is already in progress (${outcome.active.runId}, stage ${outcome.active.stage}).`);
      return;
    }
    runRef.current = outcome.run;
    setRunStage(outcome.run.stage);
    setRunNotice(''); setRound(1); setExecutionReport(undefined); setAutoRun(true); setLog([]);
    // A new task starts with no actions performed and no repetition history.
    actionHistoryRef.current = resetActionHistory();
    loopTrackerRef.current = newLoopTracker();
    setRoundGeneration(undefined); retriedGeneration.current = undefined; retries.current = 0; retryReasons.current = [];
    runIdRef.current = outcome.run.runId; setRunId(outcome.run.runId); setLastFailure(undefined);
    addLog('info', `Run ${outcome.run.runId} started.`);
    void command(!state.taskId || state.status === 'stopped' ? 'START' : 'OBSERVE');
  }
  // A halted run keeps its structured failure, so the panel can still say what
  // failed after the observation (and the section that reported it) is gone.
  function stopRun(notice: string, failure?: ExtensionError) {
    stage(failure ? 'FAILED' : /stopped|cancel/i.test(notice) ? 'CANCELLED' : 'COMPLETED');
    setAutoRun(false); setRunNotice(notice); setLastFailure(failure);
    addLog(failure ? 'error' : 'info', failure ? `${notice} [${failure.code} at ${failure.stage}]` : notice);
  }

  async function command(type: 'START' | 'OBSERVE' | 'STOP'): Promise<ErrorCode | undefined> {
    setError(''); captureTilesRef.current = []; setCaptureProgress(undefined);
    if (type !== 'STOP') stage('CAPTURING');
    if (type === 'STOP') { stopPending.current = true; clearDetections('user_cancel', 'the user stopped the task'); adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); documentAdapterRef.current?.dispose(); setObservation(undefined); }
    else { stopPending.current = false; clearDetections('task_restart', `a new ${type} scan was requested`); setObservation(undefined); }
    try {
      const response = await chrome.runtime.sendMessage(type === 'START' ? { type, instruction: instruction.trim() || 'Read visible page text' } : { type });
      const parsed = TaskStateSchema.safeParse(response?.state);
      // The generation the worker accepted this command at is what later marks
      // an error as this round's own. It is recorded even when the panel keeps
      // a newer state, because the round still began here.
      if (parsed.success) { if (parsed.data.generation >= stateRef.current.generation) applyState(parsed.data); if (response?.ok && type !== 'STOP') setRoundGeneration(parsed.data.generation); }
      if (!response?.ok) { setError(messages[response?.error as ErrorCode] || 'The operation could not be completed.'); setAutoRun(false); return (response?.error as ErrorCode) ?? 'INVALID_MESSAGE'; }
    } catch { setError('The extension disconnected. Reload it and reopen the panel.'); setAutoRun(false); return 'RESTARTED'; }
    return undefined;
  }
  // Scan the page again inside a run that is already going. A move that crossed
  // an origin is refused by OBSERVE — the paused task still describes the site
  // the user left — so the honest recovery there is a fresh task, not a dead run.
  async function observeAgain() {
    const refused = await command(state.taskId && state.status !== 'stopped' ? 'OBSERVE' : 'START');
    if (refused === 'ACCESS_REQUIRED') { setError(''); setAutoRun(true); await command('START'); }
  }

  const busy = state.status === 'observing' || ocrBusy || faceBusy || documentBusy;
  const complete = !!ocr && !!faces && !!documents && !ocrBusy && !faceBusy && !documentBusy && !ocrError && !faceError && !documentError;
  const taskRunning = autoRun || busy;
  // MV3 keepalive for the inference window. The agent request runs in the
  // panel (requestStep fetches from here), so while the model thinks the
  // worker receives zero messages and can be terminated; an ACT that follows
  // a mid-think termination wakes a fresh worker whose recover() has already
  // invalidated the observation — RESTARTED → task_replaced → the refusal of
  // record (reproduced in docs/worker-restart-generation-investigation.md).
  // While a run is active, a single chrome.runtime.sendMessage round-trip per
  // 20 s keeps the worker continuously alive (5-min window reset per event);
  // lifecycle-logged so the timeline shows the keepalive, and self-terminating
  // the moment the run goes inactive. Observations still invalidate on any
  // real navigation or STOP — this only prevents a restart the page never caused.
  useEffect(() => {
    if (!taskRunning) return;
    let stopped = false;
    const beat = async () => {
      while (!stopped) {
        await new Promise(resolve => setTimeout(resolve, 20_000));
        if (stopped) return;
        try {
          const reply = await chrome.runtime.sendMessage({ type: 'STATUS' });
          const parsed = TaskStateSchema.safeParse(reply?.state);
          if (parsed.success) {
            lifecycleStateLog('panel_keepalive_beat', parsed.data);
            if (parsed.data.generation >= stateRef.current.generation) applyState(parsed.data);
          }
        } catch { /* a dead worker here is exactly what the beat prevents */ }
      }
    };
    void beat();
    return () => { stopped = true; };
  }, [taskRunning]);
  // Escape closes whatever is on top before it reaches the run: a menu, then a
  // drawer, and only then the task itself.
  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (menuOpen) { event.preventDefault(); setMenuOpen(false); return; }
      if (detailView) { event.preventDefault(); setDetailView(undefined); return; }
      if (!taskRunning) return;
      event.preventDefault();
      stopRun('Task stopped');
      void command('STOP');
    };
    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [taskRunning, menuOpen, detailView]);
  useEffect(() => {
    if (!detailView) return;
    drawerRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => menuButtonRef.current?.focus();
  }, [detailView]);
  useEffect(() => {
    if (!menuOpen) return;
    const dismiss = (event: MouseEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    window.addEventListener('mousedown', dismiss);
    return () => window.removeEventListener('mousedown', dismiss);
  }, [menuOpen]);
  useEffect(() => {
    if (!autoRun) return;
    // Detector errors are cleared at the start of every round, so they always
    // belong to this one. A task error counts only from `roundGeneration` on,
    // for the reason spelled out in `roundVerdict`.
    const outcome = roundVerdict({ detectorError: ocrError || faceError || documentError,
      status: state.status, error: state.error, generation: state.generation, roundGeneration });
    if (outcome.verdict === 'halt') { stopRun(outcome.notice); return; }
    // A capture that published an observation earns the round a clean slate.
    if (outcome.verdict === 'continue') {
      if (state.observationId && roundGeneration !== undefined && state.generation >= roundGeneration) {
        retries.current = 0; retryReasons.current = [];
      }
      return;
    }
    // One retry per invalidated generation. Without the guard an unrelated
    // re-render would send a second OBSERVE, which the worker answers with BUSY
    // and which would stop the run for no reason.
    if (retriedGeneration.current === state.generation) return;
    retriedGeneration.current = state.generation;
    // Retries are counted apart from rounds. A round is a step performed on the
    // page; a retry is the same round starting over because the page would not
    // hold still. Letting retries spend rounds would end a run silently, having
    // done nothing, which is exactly the failure this whole path exists to fix.
    const reason = state.errorDetail?.cause || 'PAGE_CHANGED_UNKNOWN';
    retryReasons.current.push(reason);
    const retry = nextCaptureRetry(retries.current);
    if (!retry.retry) {
      const reasons = Array.from(new Set(retryReasons.current)).join(', ');
      stopRun(`The page kept changing while it was being scanned, so the run stopped after ${CAPTURE_RETRY_LIMIT} retries. Reasons: ${reasons}. Let it finish loading, then run the task again.`);
      return;
    }
    retries.current = retry.completedRetries;
    addLog('info', `${outcome.notice} Reason: ${reason}. (attempt ${retries.current} of ${CAPTURE_RETRY_LIMIT})`);
    const timer = window.setTimeout(() => void observeAgain(), CAPTURE_RETRY_BACKOFF_MS * retries.current);
    return () => window.clearTimeout(timer);
  }, [autoRun, ocrError, faceError, documentError, state.status, state.error, state.errorDetail, state.generation, state.observationId, roundGeneration]);
  const status = state.status === 'observing' ? 'Capturing full page…' : busy ? 'Analyzing on your device…' : ocrError || faceError || documentError ? 'Scan needs attention' : complete ? 'Scan ready to review' : state.status === 'stopped' ? 'Stopped' : state.error ? 'A fresh capture is needed' : state.observationId ? 'Observation ready' : 'Ready to capture';
  const recognizing = progress?.status === 'recognizing text';
  const filteredWords = ocr?.regions.map((region, index) => ({ region, index })).filter(({ region }) => region.text?.toLowerCase().includes(query.toLowerCase())) ?? [];
  const recentActivity = [...log].reverse().filter(line => line.kind === 'action' || line.kind === 'error' || /finished|stopped/i.test(line.text)).slice(0, 3);
  const workingLabel = state.status === 'observing' ? 'Protecting page…' : ocrBusy || faceBusy || documentBusy ? 'Understanding page…' : 'Working on your request…';
  const openDetail = (view: DetailView) => { setDetailView(view); setMenuOpen(false); };
  const togglePreview = (checked: boolean) => {
    previewRef.current = checked; setPreview(checked);
    if (!checked) { captureTilesRef.current = []; clearDetections('user_cancel', 'local analysis was switched off'); adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); documentAdapterRef.current?.dispose(); setObservation(undefined); }
  };
  // The dot never reports success while something needs attention: a green dot
  // over "A fresh capture is needed" is the kind of detail that makes a panel
  // feel untrustworthy.
  const dot = state.status === 'observing' ? 'observing'
    : error || state.error || ocrError || faceError || documentError ? 'failed'
    : complete ? 'paused' : state.status;
  const scanLabel = busy ? 'Scanning…' : state.taskId && state.status !== 'stopped' ? 'Scan again' : 'Scan current page';
  const host = state.origin ? state.origin.replace(/^https?:\/\//, '') : 'Current page';
  const drawerTitle = detailView === 'activity' ? 'Task activity' : detailView === 'privacy' ? 'Privacy details' : 'Settings';
  const pageChangeReason = state.error === 'PAGE_CHANGED' && state.errorDetail?.cause
    ? ` Reason: ${state.errorDetail.cause}.` : '';
  const alert = error || documentError || (state.error && `${messages[state.error]}${pageChangeReason}`) || '';
  return <div className="app">
    <header className="app-bar">
      <div className="identity">
        <span className="logo" aria-hidden="true">S</span>
        <span className="identity-text"><strong>SIH26</strong><small>Private browser agent</small></span>
      </div>
      <div className="bar-actions">
        <span className={`shield${complete || taskRunning ? ' is-on' : ''}`}><i aria-hidden="true" />{complete || taskRunning ? 'Protected' : 'Local'}</span>
        <div className="menu-host" ref={menuRef}>
          <button type="button" className="icon-button" ref={menuButtonRef} aria-label="Open menu" aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => setMenuOpen(open => !open)}><Glyph name="more" /></button>
          {menuOpen && <div className="menu" role="menu">
            <button type="button" role="menuitem" onClick={() => openDetail('activity')}><Glyph name="activity" />Activity</button>
            <button type="button" role="menuitem" onClick={() => openDetail('privacy')}><Glyph name="shield" />Privacy details</button>
            <button type="button" role="menuitem" onClick={() => openDetail('settings')}><Glyph name="settings" />Settings</button>
          </div>}
        </div>
      </div>
    </header>

    <main className="column">
      <section className="panel task-panel" aria-label="Task">
        <h1 className="headline">{taskRunning ? 'Working on it' : 'What can I do for you?'}</h1>
        <p className="sub">{taskRunning ? 'Everything is inspected and redacted on this device first.' : 'Describe what should happen on the page you have open.'}</p>
        <form className={`composer${taskRunning ? ' is-running' : ''}`} onSubmit={event => { event.preventDefault(); if (!taskRunning) startRun(); }}>
          <label className="sr-only" htmlFor="instruction">What should be done on this page?</label>
          <textarea id="instruction" maxLength={2000} value={instruction} disabled={taskRunning} rows={3}
            onChange={event => setInstruction(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); if (!taskRunning) startRun(); } }}
            placeholder="Ask SIH26 to do something on this page…" />
          <div className="composer-bar">
            <span className="page-chip" title={state.origin || undefined}><i aria-hidden="true" />{host}</span>
            {!taskRunning
              ? <button className="run-action" type="submit" aria-label="Run task" disabled={!instruction.trim()}><Glyph name="send" /></button>
              : <button className="stop-task" type="button" aria-label="Stop task" title="Stop task"
                  onClick={() => { stopRun('Task stopped'); void command('STOP'); }}><Glyph name="square" /></button>}
          </div>
        </form>
        {!taskRunning && !instruction && <div className="suggestions" aria-label="Suggested tasks">
          {['Summarize this page', 'Find information', 'Complete a task'].map(suggestion =>
            <button type="button" key={suggestion} onClick={() => setInstruction(suggestion)}>{suggestion}</button>)}
        </div>}
      </section>

      {taskRunning && <section className="panel run-panel" aria-label="Run progress">
        <div className="run-head">
          <span className="spinner" aria-hidden="true" />
          <div><strong>{workingLabel}</strong><small>Round {round} of {RUN_LIMIT} · {runStage.toLowerCase().replace(/_/g, ' ')}</small></div>
        </div>
        <ol className="stages">
          <li className={state.status !== 'observing' ? 'done' : 'active'}>Protected</li>
          <li className={state.status === 'observing' ? '' : complete ? 'done' : 'active'}>Understanding</li>
          <li className={complete ? 'active' : ''}>Acting</li>
        </ol>
        {recentActivity[0] && <p className="run-line">{recentActivity[0].text}</p>}
      </section>}

      <section className="panel scan-panel" aria-label="Page scan">
        <div className="status" role="status" aria-live="polite"><span className={`dot ${dot}`} />{status}</div>
        <div className="scan-actions">
          <button type="button" className="btn primary scan-action" disabled={busy}
            onClick={() => void command(!state.taskId || state.status === 'stopped' ? 'START' : 'OBSERVE')}><Glyph name="scan" />{scanLabel}</button>
          <button type="button" className="btn stop" title="Stop and clear this run"
            onClick={() => { stopRun('Stopped.'); void command('STOP'); }}><Glyph name="square" /><span className="stop-label">Stop</span></button>
        </div>
        {state.status === 'observing' && captureProgress && captureProgress.count > 1 &&
          <Meter label="Capturing full page" value={captureProgress.index} max={captureProgress.count}
            detail={`${Math.round(captureProgress.index / captureProgress.count * 100)}%`} />}
        {ocrBusy && <Meter label={recognizing ? 'Reading English text' : 'Loading text engine'} value={recognizing ? progress!.progress : undefined} max={1}
          detail={recognizing ? `${Math.round(progress!.progress * 100)}%` : undefined} />}
        <details className="scan-settings">
          <summary>Scan settings</summary>
          <label className="switch-row">
            <input type="checkbox" checked={preview} onChange={event => togglePreview(event.target.checked)} />
            <span><strong>Analyze text and faces locally</strong><small>Turning this off clears the screenshot and detections. Capture then collects page controls only.</small></span>
          </label>
          <button type="button" className="link" onClick={() => openDetail('privacy')}>What leaves this device?</button>
        </details>
        {state.origin && <p className="origin" title={state.origin}>{state.origin}</p>}
      </section>

      {alert && <p role="alert" className="banner is-danger"><Glyph name="alert" />{alert}</p>}
      {!alert && runNotice && !taskRunning && !lastFailure && <p className="banner"><Glyph name={/stopped/i.test(runNotice) ? 'square' : 'check'} />{runNotice}</p>}
      {lastFailure && !taskRunning && <section className="panel" aria-label="Run failure"><TransportFailureNotice error={lastFailure} /></section>}

      {observation && preview ? <>
        <section id="page-view" className="panel" aria-label="Captured view">
          <div className="panel-head"><h2>Captured view</h2><span className="pill">Original · local</span></div>
          <div className="overlay-options">
            <label className="chip"><input type="checkbox" checked={showText} onChange={e => setShowText(e.target.checked)} />Text</label>
            <label className="chip"><input type="checkbox" checked={showFaces} onChange={e => setShowFaces(e.target.checked)} />Faces</label>
            <label className="chip"><input type="checkbox" checked={showControls} onChange={e => setShowControls(e.target.checked)} />Controls</label>
            <label className="chip"><input type="checkbox" checked={fullSize} onChange={e => setFullSize(e.target.checked)} />Full size</label>
          </div>
          <PagePreview observation={observation} ocr={ocr} faces={faces} selected={selected} selectedFace={selectedFace}
            showControls={showControls} showText={showText} showFaces={showFaces} fullSize={fullSize} onSelect={(x, y) => {
            const hit = ({ bounds: b }: PerceptionResult['regions'][number]) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
            const faceIndex = showFaces ? faces?.regions.findIndex(hit) : undefined;
            const textIndex = showText ? ocr?.regions.findIndex(hit) : undefined;
            setSelectedFace(faceIndex !== undefined && faceIndex >= 0 ? faceIndex : undefined);
            setSelected(textIndex !== undefined && textIndex >= 0 ? textIndex : undefined);
            if (faceIndex !== undefined && faceIndex >= 0) setResultTab('faces');
            else if (textIndex !== undefined && textIndex >= 0) setResultTab('text');
          }} />
          <p className="legend"><span className="key key-text">Text</span><span className="key key-face">Faces</span><span className="key-size">{observation.imageWidth} × {observation.imageHeight} px</span></p>
          <div className="metrics">
            <span>Capture<b>{Math.round(observation.captureMs)} ms</b></span>
            <span>Text<b>{ocr ? `${(ocr.elapsedMs / 1000).toFixed(1)} s` : ocrBusy ? 'Reading…' : '—'}</b></span>
            <span>Faces<b>{faces ? faces.elapsedMs < 1000 ? `${Math.round(faces.elapsedMs)} ms` : `${(faces.elapsedMs / 1000).toFixed(1)} s` : faceBusy ? 'Scanning…' : '—'}</b></span>
          </div>
        </section>

        <section className="panel" aria-label="Detection results">
          <div className="panel-head"><h2>Detection results</h2><span className={`pill${ocrError || faceError ? ' is-danger' : complete ? ' is-good' : ''}`}>{busy ? 'Running' : complete ? 'Complete' : 'Incomplete'}</span></div>
          {(ocrError || faceError) && <div role="alert" className="banner is-danger">
            <Glyph name="alert" />
            <span>{ocrError}{ocrError && faceError ? ' ' : ''}{faceError}</span>
            <button type="button" className="btn ghost" disabled={busy} onClick={() => setRetry(value => value + 1)}>Retry detection</button>
          </div>}
          <div className="tabs" role="tablist" aria-label="Detection type" onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'text' : event.key === 'End' ? 'faces' : resultTab === 'text' ? 'faces' : 'text';
            setResultTab(next); document.getElementById(`${next}-tab`)?.focus();
          }}>
            <button id="text-tab" role="tab" tabIndex={resultTab === 'text' ? 0 : -1} aria-selected={resultTab === 'text'} aria-controls="text-results" onClick={() => setResultTab('text')}>Text <span>{ocr?.regions.length ?? '—'}</span></button>
            <button id="faces-tab" role="tab" tabIndex={resultTab === 'faces' ? 0 : -1} aria-selected={resultTab === 'faces'} aria-controls="face-results" onClick={() => setResultTab('faces')}>Faces <span>{faces?.regions.length ?? '—'}</span></button>
          </div>
          <div id="text-results" role="tabpanel" aria-labelledby="text-tab" hidden={resultTab !== 'text'}>
            <label className="sr-only" htmlFor="word-search">Find detected text</label>
            <input id="word-search" className="search" type="search" placeholder="Find detected text…" value={query} onChange={e => setQuery(e.target.value)} />
            {ocrBusy && <p className="empty-text">Reading the screenshot. Words will appear here.</p>}
            {ocr && (ocr.regions.length === 0
              ? <p className="empty-text">No readable text found. Zoom in on the page and scan again.</p>
              : <><ol className="ocr-results">{filteredWords.map(({ region, index: i }) => <li key={i}>
                  <button type="button" aria-pressed={selected === i} onClick={() => { setSelected(i); setSelectedFace(undefined); setShowText(true); }}>
                    <span className="word-heading"><strong>{region.text}</strong><span className={`confidence${(region.confidence ?? 0) < .7 ? ' uncertain' : ''}`}>{Math.round((region.confidence ?? 0) * 100)}%</span></span>
                    <span className="coordinates">x {region.bounds.x} · y {region.bounds.y} · {region.bounds.width} × {region.bounds.height} px</span>
                  </button></li>)}</ol>
                {filteredWords.length === 0 && <p className="empty-text">No words match your search.</p>}</>)}
          </div>
          <div id="face-results" role="tabpanel" aria-labelledby="faces-tab" hidden={resultTab !== 'faces'}>
            {faceBusy && <p className="empty-text">Looking for faces in the screenshot…</p>}
            {faces && (faces.regions.length === 0
              ? <p className="empty-text">No faces detected. This does not mean the page contains no private information.</p>
              : <ol className="face-results">{faces.regions.map((region, i) => <li key={i}>
                  <button type="button" aria-pressed={selectedFace === i} onClick={() => { setSelectedFace(i); setSelected(undefined); setShowFaces(true); }}>
                    <span className="word-heading"><strong>Face {i + 1}</strong><span className="confidence">{Math.round((region.confidence ?? 0) * 100)}%</span></span>
                    <span className="coordinates">x {region.bounds.x} · y {region.bounds.y} · {region.bounds.width} × {region.bounds.height} px</span>
                  </button></li>)}</ol>)}
            <p className="foot-note">Faces are located, not identified. Small, angled or obscured faces may be missed.</p>
          </div>
        </section>

        <PrivacyReview observation={observation} instruction={instruction} ocr={ocr} faces={faces} modelDocuments={documents} complete={complete}
          currentState={() => stateRef.current} signal={controllerRef.current?.signal} verificationOcr={ocrAdapter}
          auto={autoRun} runId={runId} executionReport={executionReport} onExecuted={setExecutionReport} onStage={stage} onHalt={stopRun}
          actionHistory={actionHistoryRef.current} loopTracker={loopTrackerRef.current}
          onActionOutcome={(entry) => { recordActionHistory(actionHistoryRef.current, entry); }}
          onLoopDetected={(notice) => stopRun(notice)} onLog={addLog} onContinue={() => {
            const next = nextRound(round, RUN_LIMIT);
            if (!next.continue) { stopRun(next.notice); return; }
            setRound(next.round);
            addLog('info', `Round ${round} done. Observing the page again.`);
            void command('OBSERVE');
          }} />

        <details className="panel technical">
          <summary>Page controls and capture details</summary>
          <p className="foot-note">Controls come from the page structure. Coordinates in detection results use original screenshot pixels.</p>
          <p className="foot-note">DOM {observation.domMs.toFixed(1)} ms · {observation.dom.hiddenCount} hidden or offscreen controls omitted.{observation.dom.truncated ? ' Control limit reached.' : ''}</p>
          <ol className="elements">{observation.dom.elements.map(el => <li key={el.id}>
            <strong>{el.label || 'Unlabelled control'}</strong><span>{el.role} · {el.type}{el.disabled ? ' · disabled' : ''}</span>
          </li>)}</ol>
        </details>
      </> : <section className="panel empty-state">
        <span className="empty-mark" aria-hidden="true"><Glyph name="scan" /></span>
        <h2>{state.observationId && !preview ? 'Page controls captured' : 'Your next scan starts here'}</h2>
        <p>{state.observationId && !preview
          ? 'Local analysis is off, so no screenshot or detections are kept. Turn it on in scan settings, then scan again.'
          : 'Open a webpage, click the extension icon on that tab, then run a task or scan the current view.'}</p>
        <div className="empty-chips"><span>Text in images</span><span>Faces</span><span>Page controls</span></div>
      </section>}

      <section className="panel recent" aria-label="Recent activity">
        <div className="panel-head"><h2>Recent</h2>{log.length > 0 && <button type="button" className="link" onClick={() => openDetail('activity')}>View activity</button>}</div>
        {recentActivity.length
          ? <ol className="feed">{recentActivity.map((line, index) => <li key={`${line.at}-${index}`} className={line.kind === 'error' ? 'is-error' : ''}>
              <span className="feed-mark" aria-hidden="true"><Glyph name={line.kind === 'error' ? 'alert' : 'check'} /></span>
              <div><strong>{line.text}</strong><small>{index === 0 ? 'Just now' : line.at}</small></div>
            </li>)}</ol>
          : <p className="muted">Completed tasks will appear here.</p>}
      </section>

      <footer className="app-foot"><span className="privacy-dot" aria-hidden="true" />Detection and redaction run on this device</footer>
    </main>

    {detailView && <div className="scrim" onMouseDown={event => { if (event.target === event.currentTarget) setDetailView(undefined); }}>
      <aside className="drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={drawerTitle}>
        <header className="drawer-head">
          <div><small>{detailView === 'privacy' ? 'Protection' : detailView === 'activity' ? 'Diagnostics' : 'Preferences'}</small><h2>{drawerTitle}</h2></div>
          <button type="button" className="icon-button" aria-label="Close details" onClick={() => setDetailView(undefined)}><Glyph name="close" /></button>
        </header>
        <div className="drawer-body">
          {detailView === 'activity' && <>
            <ul className="diagnostic-list">
              <li><span>Capture</span><b>{observation ? 'Completed' : state.status === 'observing' ? 'Working…' : 'Waiting'}</b></li>
              <li><span>Text recognition</span><b>{ocr ? 'Completed' : ocrBusy ? 'Working…' : ocrError ? 'Needs attention' : 'Waiting'}</b></li>
              <li><span>Face detection</span><b>{faces ? 'Completed' : faceBusy ? 'Working…' : faceError ? 'Needs attention' : 'Waiting'}</b></li>
              <li><span>Document detection</span><b>{documents ? 'Completed' : documentBusy ? 'Working…' : documentError ? 'Needs attention' : 'Waiting'}</b></li>
              <li><span>PII redaction</span><b>{complete ? 'Protected' : 'Waiting'}</b></li>
              <li><span>Server reasoning</span><b>{log.some(line => line.kind === 'server') ? 'Completed' : autoRun ? 'Working…' : 'Waiting'}</b></li>
              <li><span>Action execution</span><b>{log.some(line => line.kind === 'action') ? 'Completed' : 'Waiting'}</b></li>
            </ul>
            {log.length > 0 ? <div className="raw-log">
              <div className="panel-head"><h3>Run log</h3><button type="button" className="link" onClick={() => void navigator.clipboard.writeText(log.map(line => `${line.at} [${line.kind}] ${line.text}`).join('\n'))}>Copy</button></div>
              <ol>{log.map((line, index) => <li key={index} className={`is-${line.kind}`}><small>{line.at} · {line.kind}</small><span>{line.text}</span></li>)}</ol>
              <p className="foot-note">The untruncated server reply is printed to the panel console: right-click the panel and choose Inspect.</p>
            </div> : <p className="muted">No run has started yet.</p>}
          </>}
          {detailView === 'privacy' && <div className="privacy-details">
            <h3>Processed locally</h3>
            <ul><li>Screenshot analysis</li><li>OCR text extraction</li><li>DOM inspection</li><li>Face detection</li><li>Sensitive document detection</li><li>PII detection and redaction</li></ul>
            <h3>Sent for reasoning</h3>
            <ul><li>Sanitized page context</li><li>Sanitized user instruction</li><li>A separately masked screenshot</li></ul>
            <h3 className="never">Never sent</h3>
            <ul className="never-list"><li>Original detected PII</li><li>Password and one-time-code fields</li><li>The original screenshot</li></ul>
          </div>}
          {detailView === 'settings' && <div className="settings-list">
            <label className="switch-row">
              <input type="checkbox" checked={preview} onChange={event => togglePreview(event.target.checked)} />
              <span><strong>Local page analysis</strong><small>Read text, locate faces and detect documents on this device.</small></span>
            </label>
            <button type="button" className="btn" disabled={busy} onClick={() => { setDetailView(undefined); void command(!state.taskId || state.status === 'stopped' ? 'START' : 'OBSERVE'); }}>{scanLabel}</button>
            <dl className="meta-list">
              <div><dt>Connected page</dt><dd>{state.origin || 'None'}</dd></div>
              <div><dt>Task state</dt><dd>{state.status}</dd></div>
              <div><dt>Rounds allowed</dt><dd>{RUN_LIMIT} per run</dd></div>
            </dl>
          </div>}
        </div>
      </aside>
    </div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
