import type { DomSnapshot, MutationSummary, PageChangedDetail, PageChangeReason, StabilitySnapshot } from '../contracts';

// What a capture actually depends on, and how far each value may drift before
// the screenshots stop describing the page.
//
// These are deliberately generous. The previous thresholds treated a two-pixel
// layout settle, one extra element, or any classified DOM mutation as a changed
// page, which is true of an idle React application several times a second. A
// capture is only unusable when the page it photographed is gone: a different
// document, a document that grew or shrank substantially, a viewport that was
// resized, a page that scrolled under the screenshots, or controls that
// disappeared.
export const CAPTURE_STABILITY = Object.freeze({
  // A real window resize, not a debugger-notice inset that has already returned.
  maxViewportDeltaPx: 24,
  // Content loading in is normal; the document changing size by a quarter is not.
  maxDocumentDimensionDeltaPx: 256,
  maxDocumentDimensionDeltaRatio: 0.25,
  // Scrolling moves every recorded element bound away from the pixels it
  // describes, so it is checked tightly — but only as an actual offset
  // difference between COLLECT and CHECK, never as a scroll event.
  maxScrollDeltaPx: 8,
  // Controls vanishing is the one DOM change that still matters here.
  maxInteractiveLossCount: 2,
  maxInteractiveLossRatio: 0.25,
});

export interface StabilityState { dom: DomSnapshot; stability: StabilitySnapshot }
export type StabilityDecision = { stable: true } | { stable: false; reason: PageChangeReason };

const delta = (a: number, b: number) => Math.abs(a - b);
const beyond = (a: number, b: number, absolute: number, ratio = 0) =>
  delta(a, b) > Math.max(absolute, Math.max(Math.abs(a), Math.abs(b)) * ratio);

// A lightweight semantic comparison of the values the capture depends on. It
// deliberately ignores element labels, roles, ordering, per-element geometry,
// total node counts and every DOM mutation: all of those change constantly on a
// live page without making the screenshots wrong.
export function compareCaptureStability(before: StabilityState, after: StabilityState,
  _mutations?: MutationSummary): StabilityDecision {
  const a = before.stability, b = after.stability;
  // The document itself was replaced: a different URL, a reload (new document
  // id), or a different origin.
  if (a.url !== b.url || a.documentId !== b.documentId || before.dom.origin !== after.dom.origin)
    return { stable: false, reason: 'PAGE_CHANGED_NAVIGATION' };
  // The page grew or shrank substantially while it was being photographed.
  if (beyond(a.documentHeight, b.documentHeight, CAPTURE_STABILITY.maxDocumentDimensionDeltaPx, CAPTURE_STABILITY.maxDocumentDimensionDeltaRatio) ||
    beyond(a.documentWidth, b.documentWidth, CAPTURE_STABILITY.maxDocumentDimensionDeltaPx, CAPTURE_STABILITY.maxDocumentDimensionDeltaRatio) ||
    beyond(a.scrollHeight, b.scrollHeight, CAPTURE_STABILITY.maxDocumentDimensionDeltaPx, CAPTURE_STABILITY.maxDocumentDimensionDeltaRatio) ||
    beyond(a.scrollWidth, b.scrollWidth, CAPTURE_STABILITY.maxDocumentDimensionDeltaPx, CAPTURE_STABILITY.maxDocumentDimensionDeltaRatio))
    return { stable: false, reason: 'PAGE_CHANGED_DOCUMENT_SIZE' };
  // The window was resized, or the page moved under the screenshots. Either
  // way the recorded element bounds no longer line up with the captured pixels.
  if (beyond(a.viewportWidth, b.viewportWidth, CAPTURE_STABILITY.maxViewportDeltaPx) ||
    beyond(a.viewportHeight, b.viewportHeight, CAPTURE_STABILITY.maxViewportDeltaPx) ||
    beyond(a.scrollX, b.scrollX, CAPTURE_STABILITY.maxScrollDeltaPx) ||
    beyond(a.scrollY, b.scrollY, CAPTURE_STABILITY.maxScrollDeltaPx))
    return { stable: false, reason: 'PAGE_CHANGED_MAJOR_LAYOUT' };
  // Controls the observation described have gone. New ones appearing is
  // ordinary lazy loading and is not a reason to discard the capture.
  const lost = a.interactiveElementCount - b.interactiveElementCount;
  if (lost > Math.max(CAPTURE_STABILITY.maxInteractiveLossCount, a.interactiveElementCount * CAPTURE_STABILITY.maxInteractiveLossRatio))
    return { stable: false, reason: 'PAGE_CHANGED_TARGET_REMOVED' };
  return { stable: true };
}

const summaryOf = (state?: StabilityState) => state && ({
  documentWidth: state.stability.documentWidth, documentHeight: state.stability.documentHeight,
  scrollWidth: state.stability.scrollWidth, scrollHeight: state.stability.scrollHeight,
  viewportWidth: state.stability.viewportWidth, viewportHeight: state.stability.viewportHeight,
  totalElements: state.stability.totalElementCount,
  interactiveElements: state.stability.interactiveElementCount,
});

export function pageChangedDetail(reason: PageChangeReason, mutations: MutationSummary,
  before?: StabilityState, after?: StabilityState, message = 'The page changed enough that the capture no longer represents its current state.'): PageChangedDetail {
  return {
    code: 'PAGE_CHANGED', stage: 'Capture Stability', cause: reason, message,
    context: { before: summaryOf(before), after: summaryOf(after), mutations },
    timestamp: new Date().toISOString(),
  };
}

export class PageChangedError extends Error {
  constructor(public readonly detail: PageChangedDetail) { super('PAGE_CHANGED'); this.name = 'PageChangedError'; }
}

export const emptyMutationSummary = (): MutationSummary => ({ total: 0, ignored: 0, significant: 0, categories: {} });
