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
export function collect(observationId: string, documentId: string, revision: number, refs: Map<string, HTMLElement>): DomSnapshot {
  refs.clear();
  let hiddenCount = 0;
  const elements: ObservedElement[] = [];
  const all = Array.from(document.querySelectorAll<HTMLElement>(candidates));
  for (const el of all.slice(0, 2000)) {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (!r.width || !r.height || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0 ||
      el.closest('[hidden],[inert],[aria-hidden="true"]') || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) {
      hiddenCount++; continue;
    }
    if (elements.length >= 200) continue;
    const type = (el.getAttribute('type') || el.tagName.toLowerCase()).slice(0, 50);
    const sensitive = /password/i.test(type) || /one-time-code|cc-number|cc-csc/i.test(el.getAttribute('autocomplete') || '');
    const id = `${observationId}_e${elements.length + 1}`;
    refs.set(id, el);
    elements.push({ id, type, sensitive, label: sensitive ? 'Sensitive field' : labelFor(el),
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
