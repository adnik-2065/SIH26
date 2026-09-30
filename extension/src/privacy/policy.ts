import type { ObservedElement, VisualCategory } from '../contracts';
import type { PerceptionResult } from '../vision/contracts';

export type TextPolicy = 'all_text' | 'sensitive_only';

// One owner for "which pixels must disappear". The planner and the final
// verifier both read these predicates, so a relaxed rule can never produce a
// plan the gateway then rejects, and a tightened rule can never be planned
// without being checked.

// Strict mode covers every control. In context mode a control only hides its
// own pixels when it can actually be showing a private value: a secret field,
// or one that currently holds user input. DOM metadata never carries the value
// itself, so `filled` is the single bit that separates "Full name: Mira" from
// an empty box under a visible "Full name" label.
export function controlIsMasked(element: ObservedElement, policy: TextPolicy) {
  if (policy === 'all_text') return true;
  // An observation without the flag predates it; withhold rather than expose.
  return element.sensitive || element.filled !== false || /password|otp|token|secret/i.test(element.type);
}

// `sensitive_image` is every unlabelled picture and `form_control` is every
// input box. Masking both is right for strict mode and destroys the page in
// context mode, where controls are already handled by controlIsMasked and
// ordinary images stay visible on purpose.
export function visualIsMasked(category: VisualCategory, policy: TextPolicy) {
  return policy === 'all_text' || (category !== 'sensitive_image' && category !== 'form_control');
}

// A DOM region covering essentially the whole capture is page layout, not
// evidence: a body or wrapper element sized to the page must never become a
// page-scale document mask. Legitimate documents are bounded artefacts, and
// the model pipeline still inspects the whole page through the tiles. The
// document detector and the mask verifier must agree on this predicate, so a
// rejected region can never leave an export unverified.
export function visualRegionIsEvidence(bounds: { width: number; height: number }, capture: { width: number; height: number }) {
  if (!(capture.width > 0) || !(capture.height > 0)) return false;
  return bounds.width * bounds.height < capture.width * capture.height * .6 &&
    bounds.width <= capture.width * .95;
}

// Acceptance for vision_model document detections. Measured failure this gate
// closes (tests/browser/mask-trace.spec.ts): the real document model emits
// `identity_card` boxes at 0.25–0.35 confidence covering 46–57% of plain login
// pages, and every downstream transform was measured faithful — the giant
// slabs are raw model output accepted as evidence. The model is the only
// visual document detector, so the fix is not a threshold change but
// corroboration: a detection that stays small relative to the capture is
// accepted as before, and one that covers a sizeable fraction of the page must
// be text-dense in the OCR the same capture already produced. A genuine
// document artefact is full of words; ordinary page-scale UI (a login card,
// navigation, a hero photograph) is not.
//
// Density is measured per effective pixel area — box area divided by
// devicePixelRatio² — because rendered documents and UI scale together with
// the capture's DPR: the word count of a given artefact is roughly
// DPR-invariant while its pixel area is not.
const LARGE_MODEL_REGION = .35;
const MIN_WORDS_PER_100K = 12;

export function documentRegionIsEvidence(bounds: { x: number; y: number; width: number; height: number },
  capture: { width: number; height: number }, devicePixelRatio: number, ocrRegions: PerceptionResult['regions']) {
  const area = bounds.width * bounds.height;
  if (!(capture.width > 0) || !(capture.height > 0) || !(devicePixelRatio > 0) || !(area > 0)) return false;
  const fraction = area / (capture.width * capture.height);
  // Small detections: accepted without corroboration, behavior unchanged.
  if (fraction < LARGE_MODEL_REGION) return true;
  const effectiveArea = area / (devicePixelRatio * devicePixelRatio);
  const words = ocrRegions.filter(region => region.kind === 'text' &&
    region.bounds.x + region.bounds.width > bounds.x &&
    region.bounds.x < bounds.x + bounds.width &&
    region.bounds.y + region.bounds.height > bounds.y &&
    region.bounds.y < bounds.y + bounds.height).length;
  return words / (effectiveArea / 100_000) >= MIN_WORDS_PER_100K;
}
