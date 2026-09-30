import type { Rect } from '../contracts';
import type { PerceptionResult } from '../vision/contracts';
import { canonical, openRedactionCandidates } from './openredaction';
import { LIMITS, privacyError, PrivacyError, type ExportData, type Finding, type Mask } from './contracts';
import { DEFAULT_PADDING, mergeMasks, paddedMask, union, validateBounds, visibleDomBounds } from './geometry';
import { controlIsMasked } from './policy';
import { Placeholders, sanitizeText } from './text';

// The kinds worth re-detecting with whitespace removed: fixed formats that OCR
// splits at arbitrary characters.
export const compactKinds: readonly string[] = ['email', 'phone', 'pan', 'aadhaar', 'payment_card', 'ifsc', 'passport', 'bank_account'];

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
      // A word region with no readable text means the detector's output cannot
      // be reconstructed, so its coverage of the page is unknown.
      if (!value) throw privacyError('INCOMPLETE_DETECTION_OCR', 'PRIVACY_NORMALIZATION',
        'A text region carried no readable word, so the page text cannot be reconstructed.',
        { wordIndex, lineIndex, regionBounds: { width: word.bounds.width, height: word.bounds.height } },
        'empty text region');
      if (wordIndex) text += ' ';
      const start = text.length; text += value;
      if (text.length > LIMITS.pageText) throw new PrivacyError('LIMIT_EXCEEDED');
      spans.push({ start, end: text.length, bounds: word.bounds });
    }
  }
  return { text, spans };
}

// Long pages read to more text than one detection call accepts. Refusing them
// stopped every run on a long page, so the text is split at line boundaries
// (a word boundary for a single oversized line) into pieces detection accepts.
// A value is only split if one line is longer than the limit.
export function textChunks(text: string, limit: number = LIMITS.text) {
  const chunks: Array<{ start: number; text: string }> = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + limit);
    if (end < text.length) {
      const line = text.lastIndexOf('\n', end - 1), space = text.lastIndexOf(' ', end - 1);
      end = line > start ? line + 1 : space > start ? space + 1 : end;
    }
    chunks.push({ start, text: text.slice(start, end) });
    start = end;
  }
  return chunks;
}

export function normalize(data: ExportData, placeholders: Placeholders) {
  const { observation } = data, { imageWidth: width, imageHeight: height } = observation;
  const textPolicy = data.ocrTextPolicy ?? 'all_text';
  const controlPadding = textPolicy === 'all_text' ? DEFAULT_PADDING : { ...DEFAULT_PADDING, document: 2 };
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
    // A control outside the captured screen has no pixels to mask; its label
    // is still sanitized below and it is listed without an image box.
    const bounds = visibleDomBounds(element.bounds, observation);
    const result = sanitizeText(element.label, 'element_description', placeholders, textPolicy);
    result.findings.forEach(finding => append({ ...finding, bounds, elementId: element.id }));
    if (element.sensitive || /password|otp|token|secret/i.test(element.type)) append({ id: 'pending', source: 'dom', kind: 'password',
      confidence: 1, bounds, elementId: element.id, exportPolicy: 'withhold', redactText: true, redactPixels: true });
    // Control values are intentionally absent from DOM metadata, so a control
    // that holds input is masked on the strength of that fact alone. Empty
    // boxes, buttons and links keep their pixels: blanking them removed the
    // whole form, and its visible labels, without hiding any private value.
    // Context mode also trims the document padding: 8px around each of a stack
    // of form rows bridges the gaps and re-creates the single black slab.
    if (bounds && controlIsMasked(element, textPolicy)) masks.push(paddedMask(bounds, 'document', width, height, controlPadding));
    // 'option' is the autocomplete suggestion row exposed by the observer;
    // collapsing it into 'control' would hide the suggestion semantics the
    // server needs to click the visible option instead of guessing.
    const roles = ['textbox', 'combobox', 'button', 'checkbox', 'radio', 'link', 'spinbutton', 'slider', 'listbox', 'switch', 'option'];
    return { id: element.id, role: roles.includes(element.role) ? element.role : 'control',
      description: element.sensitive || element.label.length >= 200 || /password|otp|token|secret/i.test(element.type) ? 'Sensitive field' : result.sanitized || 'Unlabelled control',
      // Credential fields (password, one-time code, login identifier) carry
      // their filled state to the server as a boolean — the one bit login
      // readiness needs. The value itself exists nowhere in this pipeline.
      // An element without the bit (or without a known state) exposes nothing.
      ...(element.credential || /password|otp|token|secret/i.test(element.type) ? { filled: element.filled === true } : {}),
      // The control's position in the delivered image's pixels. page_info
      // lists it so a visible control whose label the redaction replaced can
      // be matched by position to this exact existing id. Coordinates only:
      // no label, href or attribute value travels with it.
      ...(bounds ? { bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } } : {}) };
  });
  const words = data.ocr.result!.regions;
  for (const region of words) {
    validateBounds(region.bounds, width, height);
    if (region.kind !== 'text' || !region.text || region.confidence === undefined) {
      throw privacyError('INCOMPLETE_DETECTION_OCR', 'PRIVACY_NORMALIZATION',
        'A text region did not carry the fields the redaction plan needs.',
        { kind: region.kind, hasText: !!region.text, hasConfidence: region.confidence !== undefined },
        'incomplete text region');
    }
    // Strict mode covers every word. Context mode masks only the words whose
    // text OpenRedaction classifies as PII (below). OCR confidence is not
    // evidence: a badly read article count ('2781 000+' at 12%) looked like an
    // identifier fragment and was blanked, though nothing classified it.
    if (textPolicy === 'all_text') masks.push(paddedMask(region.bounds, 'document', width, height));
  }
  const reconstructed = reconstructOcr(words);
  for (const chunk of textChunks(reconstructed.text)) {
    const result = sanitizeText(chunk.text, 'ocr', placeholders, textPolicy);
    result.findings.forEach((finding, index) => {
      const span = result.spans[index], start = chunk.start + span.start, end = chunk.start + span.end;
      const boxes = reconstructed.spans.filter(box => box.start < end && box.end > start).map(box => box.bounds);
      if (!boxes.length) throw new PrivacyError('INVALID_BOUNDS');
      append({ ...finding, ...(finding.textRange ? { textRange: { start, end } } : {}), bounds: boxes.reduce(union) });
    });
    // Also classify compact OCR: emails/IDs may split at arbitrary characters,
    // line wraps or capture seams. Keep an offset map back to every source box.
    // Compact detection runs in both policies: whitespace-collapsed text is
    // where split emails and identifiers rejoin, and its offset map keeps every
    // mask on the source OCR boxes.
    for (const block of chunk.text.matchAll(/[^\n]+(?:\n(?!\n)[^\n]+)*/g)) {
      const blockStart = chunk.start + block.index!;
      const compact = block[0].replace(/\s/g, '');
      const offsets: number[] = [];
      for (let i = 0; i < block[0].length; i++) if (!/\s/.test(block[0][i])) offsets.push(blockStart + i);
      // Compact only format-based candidates. Ordinary prose becomes a long
      // opaque-looking token when spaces are removed; that is not token evidence.
      const spans = openRedactionCandidates(compact).filter(span => compactKinds.includes(span.kind));
      spans.forEach(span => {
        const start = offsets[span.start], end = offsets[span.end - 1] + 1;
        // The same block with its real spaces restored was already offered to
        // detection above. If that pass found a value of this kind inside the
        // compact candidate, the compact form is prose glued onto an already
        // detected value, and keeping it would widen the mask from the value's
        // own boxes to the whole block. Only genuinely split values survive.
        const value = compact.slice(span.start, span.end);
        if (openRedactionCandidates(block[0]).some(other => other.kind === span.kind &&
          value.includes(block[0].slice(other.start, other.end).replace(/\s/g, '')))) return;
        const boxes = reconstructed.spans.filter(box => box.start < end && box.end > start).map(box => box.bounds);
        if (!boxes.length) throw new PrivacyError('INVALID_BOUNDS');
        append({ id: 'pending', source: 'ocr', kind: span.kind, confidence: 1, text: value,
          textRange: { start, end }, detector: span.detector ?? 'openredaction',
          exportPolicy: 'replace', redactText: true, redactPixels: true, bounds: boxes.reduce(union) });
      });
    }
  }
  for (const region of data.faces.result!.regions) {
    validateBounds(region.bounds, width, height);
    if (region.kind !== 'face' || region.confidence === undefined) {
      throw privacyError('INCOMPLETE_DETECTION_FACE', 'PRIVACY_NORMALIZATION',
        'A face region did not carry the fields the redaction plan needs.',
        { kind: region.kind, hasConfidence: region.confidence !== undefined }, 'incomplete face region');
    }
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
