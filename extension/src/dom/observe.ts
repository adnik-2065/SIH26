import type { DomSnapshot, ObservedElement } from '../contracts';
import { collectVisualRegions } from './visuals';

export const candidates = 'input,textarea,select,button,a[href],[role="button"],[role="textbox"],[role="combobox"],[role="checkbox"]';
function labelText(element: Element | null): string {
  if (!element || element.matches('input,textarea,select,script,style')) return '';
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('input,textarea,select,script,style').forEach(child => child.remove());
  return copy.textContent || '';
}
function labelFor(el: HTMLElement) {
  const control = el as HTMLInputElement;
  const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => labelText(document.getElementById(id))).join(' ');
  const label = el.getAttribute('aria-label') || labelled || Array.from(control.labels || []).map(labelText).join(' ') ||
    ((el.matches('button,a,[role="button"]')) ? el.textContent : '') || el.getAttribute('placeholder') || '';
  return label.replace(/\s+/g, ' ').trim().slice(0, 200);
}
// One local boolean, never the value. A checkbox/radio reports the constant
// "on" through .value, so only a checked state counts as user input there.
function hasValue(el: HTMLElement) {
  const control = el as HTMLInputElement;
  if (el.matches('input[type="checkbox"],input[type="radio"],[role="checkbox"]')) return control.checked === true || el.getAttribute('aria-checked') === 'true';
  if (el.matches('input,textarea,select')) return Boolean(control.value);
  // A custom widget has no .value; whatever it renders is its value.
  if (el.matches('[role="textbox"],[role="combobox"]')) return Boolean(el.textContent?.trim());
  return Boolean(el.isContentEditable && el.textContent?.trim());
}
// The observer hides these labels and the executor refuses to key literal
// server text into them. One predicate so the two can never disagree.
export function controlType(el: HTMLElement) { return (el.getAttribute('type') || el.tagName.toLowerCase()).slice(0, 50); }
export function sensitiveControl(el: HTMLElement) {
  return /password/i.test(controlType(el)) || /one-time-code|cc-number|cc-csc/i.test(el.getAttribute('autocomplete') || '');
}
// Visible, on screen and interactive: the same gate the observer applies when
// it decides a control is worth describing at all.
export function available(el: HTMLElement) {
  const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
  return Boolean(el.isConnected) && Boolean(rect.width) && Boolean(rect.height) && style.visibility !== 'hidden' &&
    style.display !== 'none' && Number(style.opacity) !== 0 && !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
}
export function collect(observationId: string, documentId: string, revision: number, refs: Map<string, HTMLElement>): DomSnapshot {
  refs.clear();
  let hiddenCount = 0;
  const elements: ObservedElement[] = [];
  const all = Array.from(document.querySelectorAll<HTMLElement>(candidates));
  for (const el of all.slice(0, 2000)) {
    const r = el.getBoundingClientRect();
    if (!available(el)) { hiddenCount++; continue; }
    if (elements.length >= 200) continue;
    const type = controlType(el);
    const sensitive = sensitiveControl(el);
    const id = `${observationId}_e${elements.length + 1}`;
    refs.set(id, el);
    elements.push({ id, type, sensitive, filled: hasValue(el), label: sensitive ? 'Sensitive field' : labelFor(el),
      role: (el.getAttribute('role') || (el.matches('button') ? 'button' : el.matches('select') ? 'combobox' : el.matches('a') ? 'link' : type === 'checkbox' ? 'checkbox' : 'textbox')).slice(0, 50),
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
    });
  }
  const visuals = collectVisualRegions();
  return { observationId, documentId, revision, origin: location.origin, elements, hiddenCount,
    visualRegions: visuals.regions, truncated: visuals.truncated || all.length > 2000 || refs.size === 200,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio,
      visualScale: visualViewport?.scale || 1, offsetX: visualViewport?.offsetLeft || 0, offsetY: visualViewport?.offsetTop || 0 },
  };
}
