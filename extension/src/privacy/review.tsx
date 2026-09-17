import React, { useLayoutEffect, useRef, useState } from 'react';
import type { LocalObservation, TaskState } from '../contracts';
import type { PerceptionResult, PerceptionAdapter } from '../vision/contracts';
import { detectLocalDocuments, mergeDocumentEvidence, type DocumentEvidence } from '../vision/documents';
import { buildSafeStepRequest } from './gateway';
import { LIMITS, type Binding, type ExportResult } from './contracts';

interface Props {
  observation: LocalObservation; instruction: string; ocr?: PerceptionResult; faces?: PerceptionResult;
  modelDocuments?: DocumentEvidence;
  complete: boolean; currentState: () => TaskState; signal?: AbortSignal;
  verificationOcr?: PerceptionAdapter;
}
export function PrivacyReview({ observation, instruction, ocr, faces, modelDocuments, complete, currentState, signal, verificationOcr }: Props) {
  const [result, setResult] = useState<ExportResult>();
  const [busy, setBusy] = useState(false);
  const [rescan, setRescan] = useState(false);
  const [strictTextMasking, setStrictTextMasking] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Clear the previous observation before the new enabled button can be used.
  // A passive effect could otherwise abort a freshly clicked preparation.
  useLayoutEffect(() => {
    const clear = () => { controller.current?.abort(); clearTimeout(timer.current); setResult(undefined); setBusy(false); };
    clear(); signal?.addEventListener('abort', clear); window.addEventListener('pagehide', clear);
    return () => { clear(); signal?.removeEventListener('abort', clear); window.removeEventListener('pagehide', clear); };
  }, [observation, instruction, ocr, faces, complete, signal, rescan, strictTextMasking]);
  const current = (): Binding | undefined => {
    const state = currentState();
    if (signal?.aborted || state.status !== 'paused' || !state.taskId || state.tabId === undefined || state.origin !== observation.dom.origin || state.observationId !== observation.dom.observationId) return;
    return { taskId: state.taskId, tabId: state.tabId, origin: state.origin, observationId: state.observationId,
      generation: state.generation, documentId: observation.dom.documentId, revision: observation.dom.revision };
  };
  async function prepare() {
    controller.current?.abort(); clearTimeout(timer.current);
    const next = new AbortController(); controller.current = next;
    setResult(undefined); setBusy(true);
    const binding = current();
    if (!binding) { setResult({ ok: false, blockedReasons: ['STALE_OBSERVATION'] }); setBusy(false); return; }
    let documents: DocumentEvidence = { status: 'incomplete', required: true, observationId: binding.observationId, regions: [] };
    const ocrTextPolicy = strictTextMasking ? 'all_text' : 'sensitive_only';
    try {
      if (complete && ocr) {
        documents = detectLocalDocuments(observation, ocr, ocrTextPolicy);
        if (modelDocuments) documents = mergeDocumentEvidence(documents, modelDocuments);
      }
    } catch { /* Incomplete evidence blocks export. */ }
    const output = await buildSafeStepRequest({ signal: next.signal, current, verificationOcr: rescan ? verificationOcr : undefined, data: { binding, observation,
      instruction: instruction.trim() || 'Inspect this application form', image: 'optional',
      ocr: { status: complete ? 'complete' : 'incomplete', result: ocr, completedTiles: complete ? observation.tileCount : 0, truncated: false },
      faces: { status: complete ? 'complete' : 'incomplete', result: faces, completedTiles: complete ? observation.tileCount : 0, truncated: false },
      documents, ocrTextPolicy } });
    if (!next.signal.aborted && current()) {
      setResult(output); setBusy(false);
      timer.current = setTimeout(() => { next.abort(); setResult(undefined); }, Math.max(0, LIMITS.ttlMs - (Date.now() - (observation.capturedAt ?? 0))));
    }
  }
  return <section aria-label="Redacted export review" className="preview-card">
    <div className="section-heading"><h2>Redacted export preview</h2><span className="tag">Local only</span></div>
    <p className="hint">The captured view above is the local original. This review creates a separate masked image and the exact version-1 payload. Nothing is sent.</p>
    <p className="hint">Detected PII, faces, controls and identified document regions are masked. Ordinary page text and unrelated images stay visible to preserve context. OCR and local rules can miss sensitive content; no trained document model is installed. Encoded mask pixels are verified before review.</p>
    <label><input type="checkbox" checked={strictTextMasking} disabled={busy} onChange={event => setStrictTextMasking(event.target.checked)} />Strict masking: cover all OCR text and unclassified visual containers (less page context)</label>
    {verificationOcr && <label><input type="checkbox" checked={rescan} disabled={busy} onChange={event => setRescan(event.target.checked)} />Re-scan the redacted image for remaining text PII (slower)</label>}
    <button disabled={!complete || busy} onClick={() => void prepare()}>{busy ? 'Preparing redaction…' : 'Prepare redacted preview'}</button>
    {!complete && <p className="hint">Export is unavailable until both detectors complete.</p>}
    {result && (!result.ok ? <p role="alert" className="notice">Export blocked: {result.blockedReasons.join(', ')}. Capture and scan again.</p> : <>
      <p className="hint">{result.summary.text} text replacements · {result.summary.faces} faces masked · {result.summary.documents} documents masked · {result.summary.masks} masks</p>
      {result.request.sanitizedImage ? <img alt="Newly encoded redacted export" style={{ maxWidth: '100%' }} src={`data:image/png;base64,${result.request.sanitizedImage.base64}`} /> : <p className="hint">Image withheld. Only sanitized instruction and controls are included. {result.withheldReasons.join(', ')}</p>}
      <details><summary>Exact local payload</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto' }}>{JSON.stringify(result.request, null, 2)}</pre></details>
    </>)}
  </section>;
}
