import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelEventSchema, TaskStateSchema, type CaptureTile, type ErrorCode, type LocalObservation, type TaskState } from '../contracts';
import { initialState } from '../agent/lifecycle';
import { TesseractAdapter, type OcrProgress } from '../vision/ocr/tesseract';
import { MediaPipeAdapter } from '../vision/face/mediapipe';
import { inspectCapturedPage } from '../vision/page';
import { inspectDocumentTiles, type DocumentEvidence } from '../vision/documents';
import { OnnxDocumentAdapter } from '../vision/documents/onnx';
import { PagePreview } from './preview';
import { PrivacyReview } from '../privacy/review';
import type { PerceptionResult } from '../vision/contracts';
import './styles.css';

const messages: Record<ErrorCode, string> = {
  ACCESS_REQUIRED: 'Open a webpage, then click the extension icon on that tab to grant access.',
  PAGE_CHANGED: 'The page or active tab changed. Observe again to read the updated page.',
  STOPPED: 'Stopped. The screenshot and detections have been cleared.',
  CAPTURE_FAILED: 'Could not capture a stable page. Click the extension icon on this tab, wait for the page to settle, and try again.',
  CAPTURE_TOO_LARGE: 'This page exceeds the local scan capacity. Try narrowing the page content and scan again.',
  INVALID_MESSAGE: 'A component returned an invalid message.', BUSY: 'An observation is already running.',
  RESTARTED: 'The background worker restarted. Observe again to capture a fresh view.',
};
const ocrErrors: Record<string, string> = {
  OCR_TIMEOUT: 'Reading took too long. Try again, or capture a smaller browser window.',
  OCR_TOO_MUCH_TEXT: 'This view exceeds the 500-word limit. Make the browser window smaller and observe again.',
};

function App() {
  const [state, setState] = useState<TaskState>(initialState);
  const stateRef = useRef(state);
  const [instruction, setInstruction] = useState('Inspect this application form');
  const [observation, setObservation] = useState<LocalObservation>();
  const [preview, setPreview] = useState(true);
  const previewRef = useRef(true);
  const [error, setError] = useState('');
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

  const clearDetections = () => {
    controllerRef.current?.abort();
    setFaces(undefined); setFaceBusy(false); setFaceError(''); setSelectedFace(undefined); setQuery('');
    setDocuments(undefined); setDocumentBusy(false); setDocumentError('');
    setOcr(undefined); setOcrBusy(false); setProgress(undefined); setOcrError(''); setSelected(undefined);
  };
  const applyState = (next: TaskState) => {
    if (next.generation !== stateRef.current.generation || next.observationId !== stateRef.current.observationId || next.status === 'stopped') {
      clearDetections(); setObservation(undefined); captureTilesRef.current = []; setCaptureProgress(undefined);
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
      if (event.type === 'OBSERVATION') {
        const tiles = captureTilesRef.current;
        captureTilesRef.current = []; setCaptureProgress(undefined);
        if (previewRef.current && !stopPending.current) {
          const info = event.observation;
          if (tiles.length !== info.tileCount || Array.from({ length: info.tileCount }, (_, i) => tiles[i]).some((tile, i) =>
            !tile || tile.width !== info.imageWidth || tile.start !== (i ? tiles[i - 1]?.end : 0)) || tiles.at(-1)?.end !== info.imageHeight) {
            setError(messages.CAPTURE_FAILED); return;
          }
          setObservation({ ...info, tiles });
        }
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    void chrome.runtime.sendMessage({ type: 'STATUS' }).then(reply => {
      const parsed = TaskStateSchema.safeParse(reply?.state);
      if (parsed.success && parsed.data.generation >= stateRef.current.generation) applyState(parsed.data);
    }).catch(() => setError('Reload the extension and open the panel again.'));
    const dispose = () => { controllerRef.current?.abort(); adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); documentAdapterRef.current?.dispose(); };
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
    adapterRef.current ??= new TesseractAdapter(p => {
      const { index, count } = ocrSectionRef.current;
      setProgress(p.status === 'recognizing text' ? { ...p, progress: (index + p.progress) / count } : p);
    });
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
          if (kind === 'text') setOcrError(ocrErrors[reason instanceof Error ? reason.message : ''] || 'Text reading failed. Retry the scan, or rebuild and reload the extension.');
          else setFaceError(reason instanceof Error && reason.message === 'FACE_TIMEOUT' ? 'Face detection took too long. Retry with a smaller browser window.' : 'Face detection failed. Retry the scan, or rebuild and reload the extension.');
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
        if (current()) setDocumentError(reason instanceof Error && reason.message === 'VISION_TIMEOUT' ? 'Document scan took too long. Retry the scan.' : 'Document detection failed. Retry the scan or rebuild the extension.');
      } finally { if (current()) setDocumentBusy(false); }
    };
    void Promise.allSettled([inspect('text'), inspect('face'), inspectDocuments()]);
    return () => controller.abort();
  }, [observation, retry]);

  async function command(type: 'START' | 'OBSERVE' | 'STOP') {
    setError(''); captureTilesRef.current = []; setCaptureProgress(undefined);
    if (type === 'STOP') { stopPending.current = true; clearDetections(); adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); documentAdapterRef.current?.dispose(); setObservation(undefined); }
    else { stopPending.current = false; clearDetections(); setObservation(undefined); }
    try {
      const response = await chrome.runtime.sendMessage(type === 'START' ? { type, instruction: instruction.trim() || 'Read visible page text' } : { type });
      const parsed = TaskStateSchema.safeParse(response?.state);
      if (parsed.success && parsed.data.generation >= stateRef.current.generation) applyState(parsed.data);
      if (!response?.ok) setError(messages[response?.error as ErrorCode] || 'The operation could not be completed.');
    } catch { setError('The extension disconnected. Reload it and reopen the panel.'); }
  }

  const busy = state.status === 'observing' || ocrBusy || faceBusy || documentBusy;
  const complete = !!ocr && !!faces && !!documents && !ocrBusy && !faceBusy && !documentBusy && !ocrError && !faceError && !documentError;
  const status = state.status === 'observing' ? 'Capturing full page…' : busy ? 'Analyzing on your device…' : ocrError || faceError || documentError ? 'Scan needs attention' : complete ? 'Scan ready to review' : state.status === 'stopped' ? 'Stopped' : state.error ? 'A fresh capture is needed' : state.observationId ? 'Observation ready' : 'Ready to capture';
  const recognizing = progress?.status === 'recognizing text';
  const filteredWords = ocr?.regions.map((region, index) => ({ region, index })).filter(({ region }) => region.text?.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <main>
    <header className="app-header"><span className="mark" aria-hidden="true">S<span /></span><div className="brand"><strong>SIH26</strong><span>Vision workspace</span></div><span className="badge"><i />Local only</span></header>
    <div className="workspace-title"><p className="eyebrow">WORKSPACE / PAGE INSPECTION</p><h1>See what’s on the page.</h1><p>Capture a view. Find text and faces. Review everything on your device.</p></div>
    <section className="workflow" aria-label="Detection workflow">
      <div className="section-heading"><h2>Page inspection</h2><span className="tag">Manual run</span></div>
      <ol className="steps" aria-label="How it works">
        <li className={observation ? 'complete' : 'active'}><span className="node-icon">▣</span><strong>Capture</strong><small>Full page</small></li>
        <li className={complete ? 'complete' : ocrBusy || faceBusy ? 'active' : ''}><span className="node-icon">⌘</span><strong>Detect</strong><small>Text + faces</small></li>
        <li className={complete ? 'active' : ''}><span className="node-icon">≡</span><strong>Review</strong><small>Local results</small></li>
      </ol>
      <div className="engine-list"><div><span className="engine-icon text-icon">Aa</span><span><strong>Text recognition</strong><small>Tesseract · English</small></span><span className={`engine-state ${ocrError ? 'failed' : ''}`}>{ocrBusy ? 'Reading…' : ocrError ? 'Failed' : ocr ? `${ocr.regions.length} words` : 'Ready'}</span></div><div><span className="engine-icon face-icon">◎</span><span><strong>Face detection</strong><small>MediaPipe · BlazeFace</small></span><span className={`engine-state ${faceError ? 'failed' : ''}`}>{faceBusy ? 'Detecting…' : faceError ? 'Failed' : faces ? `${faces.regions.length} ${faces.regions.length === 1 ? 'face' : 'faces'}` : 'Ready'}</span></div><div><span className="engine-icon face-icon">▧</span><span><strong>Document detection</strong><small>ONNX · local model</small></span><span className={`engine-state ${documentError ? 'failed' : ''}`}>{documentBusy ? 'Detecting…' : documentError ? 'Failed' : documents ? `${documents.regions.length} regions` : 'Ready'}</span></div></div>
      <details className="task-details"><summary>Scan settings</summary><label className="check"><input type="checkbox" checked={preview} onChange={e => {
        previewRef.current = e.target.checked; setPreview(e.target.checked);
        if (!e.target.checked) { captureTilesRef.current = []; clearDetections(); adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); setObservation(undefined); }
      }} />Analyze text and faces locally</label><p className="hint">Turning this off clears the screenshot and detections. Capture will collect page controls only.</p><label htmlFor="instruction">Optional observation note</label><textarea id="instruction" maxLength={2000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="What are you inspecting?" /><p className="hint">Kept locally. This note does not change detection.</p></details>
      <div className="actions"><button className="primary" disabled={busy} onClick={() => void command(!state.taskId || state.status === 'stopped' ? 'START' : 'OBSERVE')}><span aria-hidden="true">▶</span> {busy ? 'Scanning…' : state.taskId && state.status !== 'stopped' ? 'Scan again' : 'Scan current page'}</button><button className="stop" onClick={() => void command('STOP')}>Stop</button></div>
      <div className="status" role="status" aria-live="polite"><span className={`dot ${busy ? 'observing' : complete ? 'paused' : state.status}`} />{status}</div>
      {state.origin && <p className="origin">{state.origin}</p>}
      {(error || state.error || documentError) && <p role="alert" className="notice">{error || documentError || (state.error && messages[state.error])}</p>}
      {state.status === 'observing' && captureProgress && captureProgress.count > 1 && <div className="progress"><div className="progress-label"><span>Capturing full page</span><span>{Math.round(captureProgress.index / captureProgress.count * 100)}%</span></div><progress aria-label="Capture progress" max={captureProgress.count} value={captureProgress.index} /></div>}
      {ocrBusy && <div className="progress"><div className="progress-label"><span>{recognizing ? 'Reading English text' : 'Loading text engine'}</span>{recognizing && <span>{Math.round(progress.progress * 100)}%</span>}</div><progress aria-label="OCR progress" max={1} value={recognizing ? progress.progress : undefined} /></div>}
      {state.observationId && !preview && <p className="hint">Page controls captured. Enable local analysis in Scan settings, then scan again to see text and faces.</p>}
    </section>
    <aside className="privacy-note"><span aria-hidden="true">◈</span><div><strong>Local original preview</strong><p>The captured view is unredacted. Prepare a separate redacted export preview below. Server export is not enabled.</p></div></aside>
    {observation && preview ? <>
      <section aria-label="Local observation" className="preview-card">
        <div className="section-heading"><h2>Captured view</h2><span className="tag">Original · local</span></div>
        <div className="overlay-options"><label className="check"><input type="checkbox" checked={showText} onChange={e => setShowText(e.target.checked)} />Text</label><label className="check face-toggle"><input type="checkbox" checked={showFaces} onChange={e => setShowFaces(e.target.checked)} />Faces</label><label className="check"><input type="checkbox" checked={showControls} onChange={e => setShowControls(e.target.checked)} />Controls</label><label className="check"><input type="checkbox" checked={fullSize} onChange={e => setFullSize(e.target.checked)} />Full size</label></div>
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
        <p className="hint legend"><span>● Text</span><span>● Faces</span><span>{observation.imageWidth} × {observation.imageHeight} px</span></p>
        <div className="metrics"><span>Capture<b>{Math.round(observation.captureMs)} ms</b></span><span>Text<b>{ocr ? `${(ocr.elapsedMs / 1000).toFixed(1)} s` : ocrBusy ? 'Reading…' : '—'}</b></span><span>Faces<b>{faces ? faces.elapsedMs < 1000 ? `${Math.round(faces.elapsedMs)} ms` : `${(faces.elapsedMs / 1000).toFixed(1)} s` : faceBusy ? 'Scanning…' : '—'}</b></span></div>
      </section>
      <PrivacyReview observation={observation} instruction={instruction} ocr={ocr} faces={faces} modelDocuments={documents} complete={complete} currentState={() => stateRef.current} signal={controllerRef.current?.signal} verificationOcr={adapterRef.current ?? undefined} />
      <section aria-label="Detection results">
        <div className="section-heading"><h2>Detection results</h2><span className="tag">{busy ? 'Running' : complete ? 'Complete' : 'Incomplete'}</span></div>
        {(ocrError || faceError) && <div role="alert" className="notice"><p>{ocrError}</p><p>{faceError}</p><button disabled={busy} onClick={() => setRetry(value => value + 1)}>Retry detection</button></div>}
        <div className="result-tabs" role="tablist" aria-label="Detection type" onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'text' : event.key === 'End' ? 'faces' : resultTab === 'text' ? 'faces' : 'text';
          setResultTab(next); document.getElementById(`${next}-tab`)?.focus();
        }}><button id="text-tab" role="tab" tabIndex={resultTab === 'text' ? 0 : -1} aria-selected={resultTab === 'text'} aria-controls="text-results" onClick={() => setResultTab('text')}>Text <span>{ocr?.regions.length ?? '—'}</span></button><button id="faces-tab" role="tab" tabIndex={resultTab === 'faces' ? 0 : -1} aria-selected={resultTab === 'faces'} aria-controls="face-results" onClick={() => setResultTab('faces')}>Faces <span>{faces?.regions.length ?? '—'}</span></button></div>
        <div id="text-results" role="tabpanel" aria-labelledby="text-tab" hidden={resultTab !== 'text'}>
          <label className="search-label" htmlFor="word-search">Find detected text</label><input id="word-search" className="search" type="search" placeholder="Search words…" value={query} onChange={e => setQuery(e.target.value)} />
          {ocrBusy && <p className="empty-text">Reading the screenshot. Words will appear here.</p>}
          {ocr && <>{ocr.regions.length === 0 ? <p className="empty-text">No readable text found. Zoom in on the page and scan again.</p> : <><p className="hint">Select a word to locate it in the captured view. Scores are estimates.</p><ol className="ocr-results">{filteredWords.map(({ region, index: i }) => <li key={i}><button aria-pressed={selected === i} onClick={() => { setSelected(i); setSelectedFace(undefined); setShowText(true); }}><span className="word-heading"><strong>{region.text}</strong><span className={`confidence ${(region.confidence ?? 0) < .7 ? 'uncertain' : ''}`}>{Math.round((region.confidence ?? 0) * 100)}%</span></span><span className="coordinates">x {region.bounds.x} · y {region.bounds.y} · {region.bounds.width} × {region.bounds.height} px</span></button></li>)}</ol>{filteredWords.length === 0 && <p className="empty-text">No words match your search.</p>}</>}</>}
        </div>
        <div id="face-results" role="tabpanel" aria-labelledby="faces-tab" hidden={resultTab !== 'faces'}>
          <p className="hint">Faces are located, not identified. Small, angled, or obscured faces may be missed.</p>
          {faceBusy && <p className="empty-text">Looking for faces in the screenshot…</p>}
          {faces && (faces.regions.length === 0 ? <p className="empty-text">No faces detected. This does not mean the page contains no private information.</p> : <ol className="face-results">{faces.regions.map((region, i) => <li key={i}><button aria-pressed={selectedFace === i} onClick={() => { setSelectedFace(i); setSelected(undefined); setShowFaces(true); }}><span className="word-heading"><strong>Face {i + 1}</strong><span className="confidence">{Math.round((region.confidence ?? 0) * 100)}%</span></span><span className="coordinates">x {region.bounds.x} · y {region.bounds.y} · {region.bounds.width} × {region.bounds.height} px</span></button></li>)}</ol>)}
        </div>
      </section>
      <details className="technical"><summary>Page controls and capture details</summary><p className="hint">Controls come from the page structure. Coordinates in detection results use original screenshot pixels.</p><p className="hint">DOM: {observation.domMs.toFixed(1)} ms · {observation.dom.hiddenCount} hidden/offscreen controls omitted. {observation.dom.truncated ? 'Control limit reached.' : ''}</p><ol className="elements">{observation.dom.elements.map(el => <li key={el.id}><strong>{el.label || 'Unlabelled control'}</strong><span>{el.role} · {el.type}{el.disabled ? ' · disabled' : ''}</span></li>)}</ol></details>
    </> : <section className="empty-state"><span className="scan-icon" aria-hidden="true">⌗</span><h2>Your next scan starts here</h2><p>Open a webpage and click the extension’s toolbar icon to connect it. Then scan the current view.</p><div className="empty-chips"><span>Text in images</span><span>Faces</span><span>Page controls</span></div></section>}
    <details className="roadmap"><summary>What’s coming next?</summary><p>Your trained model will add Aadhaar, PAN, passport, card, and document regions to local redaction. Server transport and browser actions remain future work.</p><span className="tag">Planned · not active</span></details>
    <footer><span className="privacy-dot" />On-device processing · Nothing sent to a server</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
