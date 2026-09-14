import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PanelEventSchema, TaskStateSchema, type ErrorCode, type LocalObservation, type TaskState } from '../contracts';
import { initialState } from '../agent/lifecycle';
import { TesseractAdapter, type OcrProgress } from '../vision/ocr/tesseract';
import { MediaPipeAdapter } from '../vision/face/mediapipe';
import { inspectPage } from '../vision/page';
import type { PerceptionResult } from '../vision/contracts';
import './styles.css';

const messages: Record<ErrorCode, string> = {
  ACCESS_REQUIRED: 'Open a webpage, then click the extension icon on that tab to grant access.',
  PAGE_CHANGED: 'The page or active tab changed. Observe again to read the updated page.',
  STOPPED: 'Stopped. The screenshot and detections have been cleared.',
  CAPTURE_FAILED: 'Could not capture a stable page. Click the extension icon on this tab, wait for the page to settle, and try again.',
  CAPTURE_TOO_LARGE: 'This page is too large to scan safely at this zoom. Zoom out and scan again.',
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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopPending = useRef(false);

  const clearDetections = () => {
    controllerRef.current?.abort();
    setFaces(undefined); setFaceBusy(false); setFaceError(''); setSelectedFace(undefined); setQuery('');
    setOcr(undefined); setOcrBusy(false); setProgress(undefined); setOcrError(''); setSelected(undefined);
  };
  const applyState = (next: TaskState) => {
    if (next.generation !== stateRef.current.generation || next.observationId !== stateRef.current.observationId || next.status === 'stopped') {
      clearDetections(); setObservation(undefined);
    }
    stateRef.current = next; setState(next);
    if (next.status === 'stopped') { adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); setInstruction(''); }
  };

  useEffect(() => {
    const listener = (raw: unknown, sender: chrome.runtime.MessageSender) => {
      if (sender.id !== chrome.runtime.id || sender.tab) return;
      const parsed = PanelEventSchema.safeParse(raw);
      if (!parsed.success) return;
      const event = parsed.data;
      if (event.state.generation < stateRef.current.generation) return;
      applyState(event.state);
      if (event.type === 'OBSERVATION' && previewRef.current && !stopPending.current) setObservation(event.observation);
    };
    chrome.runtime.onMessage.addListener(listener);
    void chrome.runtime.sendMessage({ type: 'STATUS' }).then(reply => {
      const parsed = TaskStateSchema.safeParse(reply?.state);
      if (parsed.success && parsed.data.generation >= stateRef.current.generation) applyState(parsed.data);
    }).catch(() => setError('Reload the extension and open the panel again.'));
    const dispose = () => { controllerRef.current?.abort(); adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); };
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
    const image = new Image();
    image.src = observation.screenshot;
    const decoded = image.decode();
    // Both pipelines share the decoded source, but transfer separate small crops.
    const inspect = async (kind: 'text' | 'face') => {
      try {
        await decoded;
        if (!current()) return;
        const adapter = kind === 'text' ? adapterRef.current! : faceAdapterRef.current!;
        const update = (result: PerceptionResult) => { if (current()) { if (kind === 'text') setOcr(result); else setFaces(result); } };
        const result = await inspectPage(image, observation.imageWidth, observation.imageHeight,
          observation.dom.viewport.height * observation.imageHeight / observation.captureBounds.height,
          observation.dom.observationId, adapter, controller.signal, update,
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
    void Promise.allSettled([inspect('text'), inspect('face')]).then(() => { image.src = ''; });
    return () => controller.abort();
  }, [observation, retry]);

  useEffect(() => {
    if (!observation || !canvasRef.current) return;
    const canvas = canvasRef.current;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      canvas.width = observation.imageWidth; canvas.height = observation.imageHeight;
      const context = canvas.getContext('2d'); if (!context) return;
      context.drawImage(image, 0, 0);
      const vp = observation.dom.viewport;
      const sx = canvas.width / observation.captureBounds.width, sy = canvas.height / observation.captureBounds.height;
      context.lineWidth = Math.max(2, sx * 2); context.font = `${12 * sx}px sans-serif`;
      if (showControls) for (const [i, element] of observation.dom.elements.entries()) {
        const box = element.bounds;
        context.strokeStyle = element.disabled ? '#c77a13' : '#16816a'; context.fillStyle = context.strokeStyle;
        const x = (box.x + vp.scrollX - vp.offsetX) * sx, y = (box.y + vp.scrollY - vp.offsetY) * sy;
        context.strokeRect(x, y, box.width * sx, box.height * sy);
        context.fillText(String(i + 1), x + 3, y + 13 * sy);
      }
      if (showFaces && faces?.observationId === observation.dom.observationId) for (const [i, region] of faces.regions.entries()) {
        const b = region.bounds;
        context.strokeStyle = '#e44e70'; context.lineWidth = selectedFace === i ? 4 : 2;
        context.strokeRect(b.x, b.y, b.width, b.height);
        if (selectedFace === i) { context.fillStyle = '#e44e7022'; context.fillRect(b.x, b.y, b.width, b.height); }
        context.fillStyle = '#be2448'; context.fillText(`Face ${i + 1}`, b.x, Math.max(14, b.y - 5));
      }
      if (showText && ocr?.observationId === observation.dom.observationId) for (const [i, region] of ocr.regions.entries()) {
        const b = region.bounds;
        context.strokeStyle = selected === i ? '#b34408' : '#5d4bdd';
        context.lineWidth = selected === i ? 3 : 1.5;
        context.strokeRect(b.x, b.y, b.width, b.height);
        if (selected === i) { context.fillStyle = '#ffc35d55'; context.fillRect(b.x, b.y, b.width, b.height); }
      }
    };
    image.src = observation.screenshot;
    return () => { cancelled = true; image.src = ''; canvas.width = 0; canvas.height = 0; };
  }, [observation, ocr, faces, selected, selectedFace, showControls, showText, showFaces]);

  async function command(type: 'START' | 'OBSERVE' | 'STOP') {
    setError('');
    if (type === 'STOP') { stopPending.current = true; clearDetections(); adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); setObservation(undefined); }
    else { stopPending.current = false; clearDetections(); setObservation(undefined); }
    try {
      const response = await chrome.runtime.sendMessage(type === 'START' ? { type, instruction: instruction.trim() || 'Read visible page text' } : { type });
      const parsed = TaskStateSchema.safeParse(response?.state);
      if (parsed.success && parsed.data.generation >= stateRef.current.generation) applyState(parsed.data);
      if (!response?.ok) setError(messages[response?.error as ErrorCode] || 'The operation could not be completed.');
    } catch { setError('The extension disconnected. Reload it and reopen the panel.'); }
  }

  const busy = state.status === 'observing' || ocrBusy || faceBusy;
  const complete = !!ocr && !!faces && !ocrBusy && !faceBusy && !ocrError && !faceError;
  const status = state.status === 'observing' ? 'Capturing full page…' : ocrBusy || faceBusy ? 'Analyzing on your device…' : ocrError || faceError ? 'Scan needs attention' : complete ? 'Scan ready to review' : state.status === 'stopped' ? 'Stopped' : state.error ? 'A fresh capture is needed' : state.observationId ? 'Observation ready' : 'Ready to capture';
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
      <div className="engine-list"><div><span className="engine-icon text-icon">Aa</span><span><strong>Text recognition</strong><small>Tesseract · English</small></span><span className={`engine-state ${ocrError ? 'failed' : ''}`}>{ocrBusy ? 'Reading…' : ocrError ? 'Failed' : ocr ? `${ocr.regions.length} words` : 'Ready'}</span></div><div><span className="engine-icon face-icon">◎</span><span><strong>Face detection</strong><small>MediaPipe · BlazeFace</small></span><span className={`engine-state ${faceError ? 'failed' : ''}`}>{faceBusy ? 'Detecting…' : faceError ? 'Failed' : faces ? `${faces.regions.length} ${faces.regions.length === 1 ? 'face' : 'faces'}` : 'Ready'}</span></div></div>
      <details className="task-details"><summary>Scan settings</summary><label className="check"><input type="checkbox" checked={preview} onChange={e => {
        previewRef.current = e.target.checked; setPreview(e.target.checked);
        if (!e.target.checked) { clearDetections(); adapterRef.current?.dispose(); faceAdapterRef.current?.dispose(); setObservation(undefined); }
      }} />Analyze text and faces locally</label><p className="hint">Turning this off clears the screenshot and detections. Capture will collect page controls only.</p><label htmlFor="instruction">Optional observation note</label><textarea id="instruction" maxLength={2000} value={instruction} onChange={e => setInstruction(e.target.value)} placeholder="What are you inspecting?" /><p className="hint">Kept locally. This note does not change detection.</p></details>
      <div className="actions"><button className="primary" disabled={busy} onClick={() => void command(!state.taskId || state.status === 'stopped' ? 'START' : 'OBSERVE')}><span aria-hidden="true">▶</span> {busy ? 'Scanning…' : state.taskId && state.status !== 'stopped' ? 'Scan again' : 'Scan current page'}</button><button className="stop" onClick={() => void command('STOP')}>Stop</button></div>
      <div className="status" role="status" aria-live="polite"><span className={`dot ${busy ? 'observing' : complete ? 'paused' : state.status}`} />{status}</div>
      {state.origin && <p className="origin">{state.origin}</p>}
      {(error || state.error) && <p role="alert" className="notice">{error || (state.error && messages[state.error])}</p>}
      {ocrBusy && <div className="progress"><div className="progress-label"><span>{recognizing ? 'Reading English text' : 'Loading text engine'}</span>{recognizing && <span>{Math.round(progress.progress * 100)}%</span>}</div><progress aria-label="OCR progress" max={1} value={recognizing ? progress.progress : undefined} /></div>}
      {state.observationId && !preview && <p className="hint">Page controls captured. Enable local analysis in Scan settings, then scan again to see text and faces.</p>}
    </section>
    <aside className="privacy-note"><span aria-hidden="true">◈</span><div><strong>Detection is the first step</strong><p>Screenshots are still unredacted. PII redaction and server export are not enabled.</p></div></aside>
    {observation && preview ? <>
      <section aria-label="Local observation" className="preview-card">
        <div className="section-heading"><h2>Captured view</h2><span className="tag">Original · local</span></div>
        <div className="overlay-options"><label className="check"><input type="checkbox" checked={showText} onChange={e => setShowText(e.target.checked)} />Text</label><label className="check face-toggle"><input type="checkbox" checked={showFaces} onChange={e => setShowFaces(e.target.checked)} />Faces</label><label className="check"><input type="checkbox" checked={showControls} onChange={e => setShowControls(e.target.checked)} />Controls</label><label className="check"><input type="checkbox" checked={fullSize} onChange={e => setFullSize(e.target.checked)} />Full size</label></div>
        <div className={`preview-scroll ${fullSize ? 'full-size' : ''}`}><canvas ref={canvasRef} aria-label="Local screenshot with text and face bounding boxes" onClick={event => {
          const canvas = event.currentTarget, rect = canvas.getBoundingClientRect();
          const x = (event.clientX - rect.left) * canvas.width / rect.width, y = (event.clientY - rect.top) * canvas.height / rect.height;
          const hit = ({ bounds: b }: PerceptionResult['regions'][number]) => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
          const faceIndex = showFaces ? faces?.regions.findIndex(hit) : undefined;
          const textIndex = showText ? ocr?.regions.findIndex(hit) : undefined;
          setSelectedFace(faceIndex !== undefined && faceIndex >= 0 ? faceIndex : undefined);
          setSelected(textIndex !== undefined && textIndex >= 0 ? textIndex : undefined);
          if (faceIndex !== undefined && faceIndex >= 0) setResultTab('faces');
          else if (textIndex !== undefined && textIndex >= 0) setResultTab('text');
        }} /></div>
        <p className="hint legend"><span>● Text</span><span>● Faces</span><span>{observation.imageWidth} × {observation.imageHeight} px</span></p>
        <div className="metrics"><span>Capture<b>{Math.round(observation.captureMs)} ms</b></span><span>Text<b>{ocr ? `${(ocr.elapsedMs / 1000).toFixed(1)} s` : ocrBusy ? 'Reading…' : '—'}</b></span><span>Faces<b>{faces ? faces.elapsedMs < 1000 ? `${Math.round(faces.elapsedMs)} ms` : `${(faces.elapsedMs / 1000).toFixed(1)} s` : faceBusy ? 'Scanning…' : '—'}</b></span></div>
      </section>
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
    <details className="roadmap"><summary>What’s coming next?</summary><p>Your trained model will add Aadhaar, PAN, passport, card, and document regions alongside these detectors. Text and pixel redaction will then prepare safe context for the server.</p><span className="tag">Planned · not active</span></details>
    <footer><span className="privacy-dot" />On-device processing · Nothing sent to a server</footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
