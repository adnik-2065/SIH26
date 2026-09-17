import type { Rect } from '../contracts';
import type { PerceptionResult } from '../vision/contracts';
import { canonical, classify } from './classify';
import { LIMITS, PrivacyError, type ExportData, type Finding, type Mask } from './contracts';
import { domBounds, mergeMasks, paddedMask, union, validateBounds } from './geometry';
import { Placeholders, sanitizeText } from './text';

export function reconstructOcr(regions: PerceptionResult['regions']) {
  const lines: Array<{ bounds: Rect; words: PerceptionResult['regions'] }> = [];
  for (const word of [...regions].sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x)) {
    const line = lines.find(line => Math.abs(line.bounds.y - word.bounds.y) <= Math.min(line.bounds.height, word.bounds.height) * .5);
    if (line) { line.words.push(word); line.bounds = union(line.bounds, word.bounds); }
    else lines.push({ bounds: { ...word.bounds }, words: [word] });
  }
  let text = '';
  const spans: Array<{ start: number; end: number; bounds: Rect }> = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (text) {
      const previous = lines[lineIndex - 1].bounds;
      text += line.bounds.y - previous.y - previous.height > Math.max(previous.height, line.bounds.height) * 2 ? '\n\n' : '\n';
    }
    for (const [wordIndex, word] of line.words.sort((a, b) => a.bounds.x - b.bounds.x).entries()) {
      const value = canonical(word.text ?? '');
      if (!value) throw new PrivacyError('INCOMPLETE_DETECTION');
      if (wordIndex) text += ' ';
      const start = text.length; text += value;
      if (text.length > LIMITS.text) throw new PrivacyError('LIMIT_EXCEEDED');
      spans.push({ start, end: text.length, bounds: word.bounds });
    }
  }
  return { text, spans };
}

export function normalize(data: ExportData, placeholders: Placeholders) {
  const { observation } = data, { imageWidth: width, imageHeight: height } = observation;
  const textPolicy = data.ocrTextPolicy ?? 'all_text';
  const findings: Finding[] = [], masks: Mask[] = [];
  const append = (finding: Finding) => {
    // Suppress repeated normal/compact OCR and DOM/OCR findings only when
    // category and geometry agree. Never discard a larger covering rectangle.
    const duplicate = finding.bounds && findings.find(existing => existing.kind === finding.kind && existing.bounds &&
      existing.bounds.x === finding.bounds!.x && existing.bounds.y === finding.bounds!.y &&
      existing.bounds.width === finding.bounds!.width && existing.bounds.height === finding.bounds!.height &&
      (existing.text ?? '').replace(/\s/g, '') === (finding.text ?? '').replace(/\s/g, ''));
    if (duplicate) { duplicate.confidence = Math.max(duplicate.confidence, finding.confidence); return; }
    findings.push({ ...finding, id: `finding_${findings.length}` });
    if (findings.length > LIMITS.findings) throw new PrivacyError('LIMIT_EXCEEDED');
    if (finding.redactPixels && finding.bounds) masks.push(paddedMask(finding.bounds, finding.kind, width, height));
  };
  const instruction = sanitizeText(data.instruction, 'instruction', placeholders);
  instruction.findings.forEach(append);
  const elements = observation.dom.elements.map(element => {
    const bounds = domBounds(element.bounds, observation);
    const result = sanitizeText(element.label, 'element_description', placeholders);
    result.findings.forEach(finding => append({ ...finding, bounds, elementId: element.id }));
    if (element.sensitive || /password|otp|token|secret/i.test(element.type)) append({ id: 'pending', source: 'dom', kind: 'password',
      confidence: 1, bounds, elementId: element.id, exportPolicy: 'withhold', redactText: true, redactPixels: true });
    // Control values are intentionally absent from DOM metadata. Mask every
    // control, including ordinary filled name/address fields and placeholders.
    masks.push(paddedMask(bounds, 'document', width, height));
    const roles = ['textbox', 'combobox', 'button', 'checkbox', 'radio', 'link', 'spinbutton', 'slider', 'listbox', 'switch'];
    return { id: element.id, role: roles.includes(element.role) ? element.role : 'control',
      description: element.sensitive || element.label.length >= 200 || /password|otp|token|secret/i.test(element.type) ? 'Sensitive field' : result.sanitized || 'Unlabelled control' };
  });
  const words = data.ocr.result!.regions;
  for (const region of words) {
    validateBounds(region.bounds, width, height);
    if (region.kind !== 'text' || !region.text || region.confidence === undefined) throw new PrivacyError('INCOMPLETE_DETECTION');
    if (textPolicy === 'all_text' || region.confidence < 0.35) masks.push(paddedMask(region.bounds, 'document', width, height));
  }
  const reconstructed = reconstructOcr(words);
  const result = sanitizeText(reconstructed.text, 'ocr', placeholders, textPolicy);
  result.findings.forEach((finding, index) => {
    const span = result.spans[index];
    const boxes = reconstructed.spans.filter(box => box.start < span.end && box.end > span.start).map(box => box.bounds);
    if (!boxes.length) throw new PrivacyError('INVALID_BOUNDS');
    append({ ...finding, bounds: boxes.reduce(union) });
  });
  // Also classify compact OCR: emails/IDs may split at arbitrary characters,
  // line wraps or capture seams. Keep an offset map back to every source box.
  if (textPolicy === 'all_text') for (const block of reconstructed.text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)) {
    const compact = block[0].replace(/\s/g, '');
    const offsets: number[] = [];
    for (let i = 0; i < block[0].length; i++) if (!/\s/.test(block[0][i])) offsets.push(block.index! + i);
    // Compact only format-based candidates. Ordinary prose becomes a long
    // opaque-looking token when spaces are removed; that is not token evidence.
    const spans = classify(compact).filter(span => ['email', 'phone', 'pan', 'aadhaar', 'payment_card', 'ifsc', 'passport'].includes(span.kind));
    spans.forEach(span => {
      const start = offsets[span.start], end = offsets[span.end - 1] + 1;
      const boxes = reconstructed.spans.filter(box => box.start < end && box.end > start).map(box => box.bounds);
      if (!boxes.length) throw new PrivacyError('INVALID_BOUNDS');
      append({ id: 'pending', source: 'ocr', kind: span.kind, confidence: 1, text: compact.slice(span.start, span.end),
        textRange: { start, end }, detector: span.detector ?? 'existing_text_detector',
        exportPolicy: 'replace', redactText: true, redactPixels: true, bounds: boxes.reduce(union) });
    });
  }
  for (const region of data.faces.result!.regions) {
    validateBounds(region.bounds, width, height);
    if (region.kind !== 'face' || region.confidence === undefined) throw new PrivacyError('INCOMPLETE_DETECTION');
    append({ id: 'pending', source: 'face', kind: 'face', confidence: region.confidence, bounds: region.bounds,
      exportPolicy: 'mask', redactText: false, redactPixels: true });
  }
  for (const region of data.documents.regions) append({ id: 'pending', source: 'document', kind: region.kind,
    detector: data.documents.detector,
    confidence: region.confidence, bounds: validateBounds(region.bounds, width, height),
    exportPolicy: 'mask', redactText: false, redactPixels: true });
  // In context mode, keep overlapping masks as separate padded rectangles.
  // A bounding-box merge can fill large unmasked gaps between a face, nearby
  // text and a form control, obscuring most of a page. Strict mode keeps the
  // existing conservative merge behavior.
  return { findings, masks: textPolicy === 'all_text' ? mergeMasks(masks) : masks,
    sanitizedInstruction: instruction.sanitized, sanitizedElements: elements };
}
