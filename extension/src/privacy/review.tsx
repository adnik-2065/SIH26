import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ExtensionError, LocalObservation, TaskState } from '../contracts';
import type { PerceptionResult, PerceptionAdapter } from '../vision/contracts';
import { detectLocalDocuments, mergeDocumentEvidence, type DocumentEvidence } from '../vision/documents';
import { buildSafeStepRequest } from './gateway';
import { LIMITS, PrivacyError, type Binding, type ExportResult } from './contracts';
import { AgentSteps, TransportFailureNotice } from '../agent/steps';
import type { ActionHistoryEntry, LoopTracker } from '../agent/lifecycle';
import type { ExecutionReport } from '../agent/wire';

interface Props {
  observation: LocalObservation; instruction: string; ocr?: PerceptionResult; faces?: PerceptionResult;
  modelDocuments?: DocumentEvidence;
  complete: boolean; currentState: () => TaskState; signal?: AbortSignal;
  verificationOcr?: PerceptionAdapter;
  // A task running by itself redacts as soon as both detectors finish. The
  // work performed is identical to the button below; only the click is implied.
  auto?: boolean; runId?: string; executionReport?: ExecutionReport; onExecuted?: (report: ExecutionReport) => void;
  onActionOutcome?: (entry: ActionHistoryEntry) => void; actionHistory?: ActionHistoryEntry[];
  loopTracker?: LoopTracker;
  onLoopDetected?: (notice: string) => void;
  onStage?: (stage: 'REDACTING' | 'SENDING' | 'WAITING_RESPONSE' | 'EXECUTING') => void; onContinue?: () => void; onHalt?: (notice: string, error?: ExtensionError) => void;
  onLog?: (kind: 'info' | 'server' | 'action' | 'error', text: string, detail?: unknown) => void;
}
export function PrivacyReview({ observation, instruction, ocr, faces, modelDocuments, complete, currentState, signal, verificationOcr, auto, runId, executionReport, onExecuted, onActionOutcome, actionHistory, loopTracker, onLoopDetected, onStage, onContinue, onHalt, onLog }: Props) {
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
    onStage?.('REDACTING');
    const binding = current();
    if (!binding) { setResult({ ok: false, blockedReasons: ['STALE_OBSERVATION'] }); setBusy(false); return; }
    let documents: DocumentEvidence = { status: 'incomplete', required: true, observationId: binding.observationId, regions: [] };
    const ocrTextPolicy = strictTextMasking ? 'all_text' : 'sensitive_only';
    // A detector that throws is not a detector that found nothing. The export
    // still fails closed on the incomplete evidence above, but the exception is
    // kept and reported instead of being discarded here.
    let documentFailure: ExtensionError | undefined;
    try {
      if (complete && ocr) {
        documents = detectLocalDocuments(observation, ocr, ocrTextPolicy);
        if (modelDocuments) documents = mergeDocumentEvidence(documents, modelDocuments);
      }
    } catch (error) {
      const failure = error instanceof PrivacyError ? error : undefined;
      documentFailure = failure?.detail ?? {
        code: failure?.reason ?? 'DOCUMENT_DETECTION_FAILED', stage: 'DOCUMENT_DETECTION',
        message: 'Local document detection could not complete.',
        cause: error instanceof Error ? error.name : typeof error,
        timestamp: new Date().toISOString(),
        context: { observationId: binding.observationId, errorMessage: error instanceof Error ? error.message.slice(0, 120) : undefined },
      };
      if (runId) documentFailure = { ...documentFailure, runId };
      onLog?.('error', `[${runId ?? 'no run'}] ${documentFailure.code} at ${documentFailure.stage}: ${documentFailure.message}`, documentFailure);
    }
    const output = await buildSafeStepRequest({ signal: next.signal, current, verificationOcr: rescan ? verificationOcr : undefined, data: { binding, observation,
      instruction: instruction.trim() || 'Inspect this application form', image: 'optional',
      ocr: { status: complete ? 'complete' : 'incomplete', result: ocr, completedTiles: complete ? observation.tileCount : 0, truncated: false },
      faces: { status: complete ? 'complete' : 'incomplete', result: faces, completedTiles: complete ? observation.tileCount : 0, truncated: false },
      documents, ocrTextPolicy } });
    if (!next.signal.aborted && current()) {
      // A blocked export names the detector failure that caused it, ahead of
      // the gateway's own refusal.
      setResult(!output.ok && documentFailure
        ? { ...output, blockedReasons: [documentFailure.code as typeof output.blockedReasons[number], ...output.blockedReasons],
            blockedDetails: [documentFailure, ...(output.blockedDetails ?? [])] }
        : output);
      setBusy(false);
      timer.current = setTimeout(() => { next.abort(); setResult(undefined); }, Math.max(0, LIMITS.ttlMs - (Date.now() - (observation.capturedAt ?? 0))));
    }
  }
  const prepared = useRef(false);
  useEffect(() => { prepared.current = false; }, [observation]);
  useEffect(() => {
    if (!auto || !complete || busy || result || prepared.current) return;
    prepared.current = true;
    void prepare();
  }, [auto, complete, observation]);
  // A payload that cannot be redacted safely stops the run; it is never sent.
  useEffect(() => {
    if (!auto || !result) return;
    if (!result.ok) onHalt?.(`Redaction blocked the payload: ${result.blockedReasons.join(', ')}.`);
    else onLog?.('info', `Redacted: ${result.summary.text} text replacements, ${result.summary.faces} faces, ${result.summary.documents} documents, ${result.summary.masks} masks${result.summary.rewritten ? `, ${result.summary.rewritten} text fields rewritten to remove detected values` : ''}.`);
  }, [auto, result]);

  const blocked = result && !result.ok;
  return <section id="privacy-review" aria-label="Redacted export review" className="panel privacy-panel">
    <div className="panel-head">
      <h2>Redacted export</h2>
      <span className={`pill${blocked ? ' is-danger' : result ? ' is-good' : ''}`}>{blocked ? 'Blocked' : result ? 'Ready' : 'Local only'}</span>
    </div>
    <p className="foot-note">The captured view above stays on this device. This builds a separate masked image and the exact payload that would be sent — nothing leaves until you send it.</p>
    <div className="export-options">
      <label className="switch-row">
        <input type="checkbox" checked={strictTextMasking} disabled={busy} onChange={event => setStrictTextMasking(event.target.checked)} />
        <span><strong>Strict masking</strong><small>Cover every OCR word, control and unclassified container. Almost no page context survives.</small></span>
      </label>
      {verificationOcr && <label className="switch-row">
        <input type="checkbox" checked={rescan} disabled={busy} onChange={event => setRescan(event.target.checked)} />
        <span><strong>Re-scan the redacted image</strong><small>Read the masked image back and withhold the image if any text PII remains. Slower.</small></span>
      </label>}
    </div>
    <button type="button" className="btn accent wide" disabled={!complete || busy} onClick={() => void prepare()}>{busy ? 'Preparing redaction…' : 'Prepare redacted preview'}</button>
    {!complete && <p className="foot-note">Export stays unavailable until every local detector has finished.</p>}
    {result && (!result.ok
      ? (result.blockedDetails?.[0]
        ? <TransportFailureNotice error={result.blockedDetails[0]} />
        : <p role="alert" className="banner is-danger">Export blocked: {result.blockedReasons.join(', ')}. Capture and scan again.</p>)
      : <>
        <ul className="summary-stats">
          <li><b>{result.summary.text}</b><span>text</span></li>
          <li><b>{result.summary.faces}</b><span>faces</span></li>
          <li><b>{result.summary.documents}</b><span>documents</span></li>
          <li><b>{result.summary.masks}</b><span>masks</span></li>
        </ul>
        {result.request.sanitizedImage
          ? <img className="masked-preview" alt="Newly encoded redacted export" src={`data:image/png;base64,${result.request.sanitizedImage.base64}`} />
          : <p className="foot-note">Image withheld. Only the sanitized instruction and controls are included. {result.withheldReasons.join(', ')}</p>}
        <details className="payload"><summary>Exact local payload</summary><pre>{JSON.stringify(result.request, null, 2)}</pre></details>
        <AgentSteps request={result.request} observationId={observation.dom.observationId} signal={signal} runId={runId} onStage={onStage}
          auto={auto} executionReport={executionReport} onExecuted={onExecuted} onContinue={onContinue} onHalt={onHalt} onLog={onLog}
          onActionOutcome={onActionOutcome} actionHistory={actionHistory} loopTracker={loopTracker} onLoopDetected={onLoopDetected}
          pageState={{ documentId: observation.dom.documentId, elements: observation.dom.elements }}
          bounds={new Map(observation.dom.elements.map(element => [element.id, { role: element.role, bounds: element.bounds,
            viewport: { scrollX: observation.dom.viewport.scrollX, scrollY: observation.dom.viewport.scrollY,
              height: observation.dom.viewport.height } }]))} />
      </>)}
  </section>;
}
