import type { z } from 'zod';
import type { CaptureScope, VisualRegionSchema, VisualCategorySchema } from '../contracts';

// Labels classify a container locally; no label, URL or image value leaves here.
export function documentCategory(label: string): z.infer<typeof VisualCategorySchema> | undefined {
  if (/aadhaar|aadhar|uidai/i.test(label)) return 'aadhaar_card';
  if (/\bpan\b|permanent account|income tax/i.test(label)) return 'pan_card';
  if (/passport/i.test(label)) return 'passport';
  if (/identity|identification|\bid card\b|driving licen[cs]e/i.test(label)) return 'identity_card';
  // A bare word like "financial" or "bank" matches ordinary page wording
  // (course titles, nav links) and blanked legitimate UI at runtime. The
  // label evidence must name a document artefact, mirroring the OCR cue
  // rules that already refuse common-word triggers.
  if (/financial\s+(?:document|record|statement)|bank\s+statement|\b(?:invoice|cheque|checkbook)\b/i.test(label)) return 'financial_document';
  if (/signature|signed by/i.test(label)) return 'signature';
  if (/\bqr\b|barcode|bar code/i.test(label)) return 'qr_barcode';
  if (/confidential|private document|medical record/i.test(label)) return 'private_document';
}

// OCR document cues need specific phrases. Common words such as "bank" or
// "statement" on a general page must not mask the entire screenshot.
const cues: Array<[z.infer<typeof VisualCategorySchema>, RegExp]> = [
  ['aadhaar_card', /\b(?:aadhaar|aadhar|uidai)\s+(?:card|number|no\.?|enrolment|enrollment)\b/i],
  ['pan_card', /\bpan\s+card\b|permanent\s+account\s+number/i],
  ['passport', /\bpassport\s+(?:number|no\.?|authority|expiry|issued)\b/i],
  ['financial_document', /\b(?:bank|credit|debit)\s+statement\b|\bcheque\s+book\b/i],
  ['private_document', /\bconfidential\s+(?:document|record)|\bprivate\s+medical\s+record\b/i],
];
// Offsets let a caller mask where the cue is instead of the whole capture.
export function ocrDocumentCue(text: string) {
  for (const [category, expression] of cues) {
    const match = expression.exec(text);
    if (match) return { category, start: match.index, end: match.index + match[0].length };
  }
}
export function ocrDocumentCategory(text: string): z.infer<typeof VisualCategorySchema> | undefined {
  return ocrDocumentCue(text)?.category;
}

// SVG artwork is drawn, not photographed: logos, icons and sprite sheets. An
// <svg> element, an <img> whose source is SVG (or a raster rendition of one,
// '/logo.svg/60px-logo.svg.png'), or a background made only of SVG images.
const svgSource = /^data:image\/svg\+xml|^[^?#]*\.svg(?:[/?#]|$)/i;
function isVector(node: Element, style: CSSStyleDeclaration) {
  if (node.matches('svg')) return true;
  if (node instanceof HTMLImageElement) return svgSource.test(node.currentSrc || node.src);
  if (node.matches('canvas,video,object,embed,iframe')) return false;
  const sources = [...style.backgroundImage.matchAll(/url\((['"]?)(.*?)\1\)/g)].map(match => match[2]);
  return sources.length > 0 && sources.every(source => svgSource.test(source));
}

// A viewport capture needs every visual region on the photographed screen and
// none of the others, so it walks a larger document and measures the box first:
// a region off that screen has no pixels to mask and costs no style lookup.
export function collectVisualRegions(scope: CaptureScope = 'page') {
  const regions: z.infer<typeof VisualRegionSchema>[] = [];
  const nodes = document.querySelectorAll<HTMLElement>('*');
  const scanLimit = scope === 'viewport' ? 100_000 : 10_000;
  let truncated = nodes.length > scanLimit;
  for (const node of Array.from(nodes).slice(0, scanLimit)) {
    const box = node.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    if (scope === 'viewport' && (box.bottom <= -2 || box.top >= innerHeight + 2)) continue;
    // SVG children are covered by their root. Backgrounds on ordinary elements
    // matter too; a document need not use an <img> tag.
    if (node.parentElement?.closest('svg')) continue;
    const style = getComputedStyle(node);
    const visual = node.matches('img,svg,canvas,video,object,embed,iframe,input,textarea,select,[contenteditable]') || style.backgroundImage !== 'none';
    if (!visual || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
    if (regions.length >= 500) { truncated = true; break; }
    const label = ['alt', 'aria-label', 'title'].map(name => node.getAttribute(name) ?? '').join(' ').slice(0, 2000);
    const category = node.matches('input,textarea,select,[contenteditable]') ? 'form_control' : documentCategory(label);
    regions.push({ category: category ?? 'sensitive_image', confidence: category ? .8 : .5,
      bounds: { x: box.x, y: box.y, width: box.width, height: box.height }, ...(isVector(node, style) ? { vector: true } : {}) });
  }
  return { regions, truncated };
}
