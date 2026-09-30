import type { Action, ErrorCode, Rect } from '../contracts';
import { available, credentialControl, sensitiveControl } from './observe';

export interface ActInput {
  action: Action;
  refs: Map<string, HTMLElement>;
  // Geometry the reviewed observation recorded for this control, plus the
  // viewport it was collected under (scroll and height). The panel already
  // holds both in the observation snapshot; the scroll offset and the capture
  // viewport height are what distinguish a harmless shift from a moved control.
  expect?: { role: string; bounds: Rect; viewport?: { scrollX: number; scrollY: number; height: number } };
  // A vault reference resolved by the panel immediately before dispatch. It
  // travels only through extension messaging and is never stored here.
  resolved?: string;
  // [ACT DEBUG] Diagnostic context only: the observation the ACT command names
  // and the content script's live observation id at execution time. Never used
  // for resolution — logging evidence for id-stability questions.
  observationId?: string;
  currentObservationId?: string;
}
export type ActResult = { ok: true } | { error: ErrorCode };
// Layout settles by fractions of a pixel between capture and execution.
const TOLERANCE = 4;

// The element map is rebuilt on every scan and cleared by any mutation, scroll
// or navigation, so a ref that still resolves proves the page has not moved
// since the user reviewed it. The geometry check then catches the rest: a
// control that was animated, resized or replaced in place.
function resolve(input: ActInput): HTMLElement | ErrorCode {
  const target = 'target' in input.action ? input.action.target : undefined;
  if (!target) return 'INVALID_MESSAGE';
  const element = input.refs.get(target);
  if (!element) return 'PAGE_CHANGED';
  if (!available(element)) return 'TARGET_CHANGED';
  if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return 'TARGET_CHANGED';
  const rect = element.getBoundingClientRect();
  // The reviewed bounds are viewport coordinates of the observation moment.
  // Between COLLECT and the action, two harmless things can move every control
  // without the page the user reviewed having changed:
  //   1. the page was scrolled — page-anchored controls shift by the scroll delta;
  //   2. Chrome's capture apparatus (debugger notice, full-document renderer)
  //      transiently changed the viewport height — bottom-anchored layout
  //      (chat composers, sticky footers) shifts by the height delta.
  // Each interpretation is a documented, page-wide transform; a control that
  // was genuinely replaced, animated or resized matches NEITHER. Fail-closed:
  // no match within tolerance refuses the action exactly as before.
  const expect = input.expect;
  if (expect) {
    const planned = expect.viewport;
    const pageAnchoredY = planned ? expect.bounds.y - (scrollY - planned.scrollY) : expect.bounds.y;
    const pageAnchoredX = planned ? expect.bounds.x - (scrollX - planned.scrollX) : expect.bounds.x;
    const heightDelta = planned ? innerHeight - planned.height : 0;
    const viewportAnchoredY = planned ? expect.bounds.y + heightDelta : expect.bounds.y;
    // Chrome's debugging notice changes the available height while it is up
    // (measured 840 → 896 across a capture). Top-anchored and page-anchored
    // layouts are covered above; a CENTERED layout — modal dialogs, google's
    // search box — moves by HALF the height delta instead, which neither
    // interpretation explains. The center-anchored reading is that third
    // page-wide transform: the control kept its position relative to the
    // viewport's vertical center. It adds no tolerance: with an unchanged
    // viewport it reduces to the plain bounds comparison, so a genuinely
    // moved control refuses exactly as before.
    const centerAnchoredY = planned ? expect.bounds.y + heightDelta / 2 : expect.bounds.y;
    const within = (actual: number, expected: number) => Math.abs(actual - expected) <= TOLERANCE;
    const sizeSame = within(rect.width, expect.bounds.width) && within(rect.height, expect.bounds.height);
    const pageAnchored = within(rect.x, pageAnchoredX) && within(rect.y, pageAnchoredY) && sizeSame;
    const viewportAnchored = within(rect.x, pageAnchoredX) && within(rect.y, viewportAnchoredY) && sizeSame;
    const centerAnchored = within(rect.x, pageAnchoredX) && within(rect.y, centerAnchoredY) && sizeSame;
    if (!pageAnchored && !viewportAnchored && !centerAnchored) return 'TARGET_CHANGED';
  }
  // Something drawn on top would receive the click instead. A wrapping label
  // or a child of the control itself is the same control for this purpose.
  // A control outside the visual viewport cannot be hit-tested — the browser
  // returns null for any point beyond the viewport, on the very elements the
  // capture legitimately photographed below the fold. Rendering checks answer
  // for them instead: a fixed-position overlay can only ever cover the
  // viewport, never an off-screen document region.
  const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
  if (centerX >= 0 && centerX <= innerWidth && centerY >= 0 && centerY <= innerHeight) {
    const top = document.elementFromPoint(centerX, centerY);
    if (!top || (top !== element && !element.contains(top) && !top.contains(element))) return 'TARGET_CHANGED';
  } else {
    if (!element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true })) return 'TARGET_CHANGED';
  }
  return element;
}

// React and similar frameworks track the native value property, so assigning
// through the prototype setter is what makes them observe the change.
function writeValue(element: HTMLElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(element, value); else (element as HTMLInputElement).value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

function pressPointer(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const position = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true, composed: true };
  element.dispatchEvent(new PointerEvent('pointerdown', { ...position, isPrimary: true }));
  element.dispatchEvent(new MouseEvent('mousedown', position));
  if (element.matches('a,button,input,select,textarea,[tabindex]') || element.isContentEditable) element.focus();
  element.dispatchEvent(new PointerEvent('pointerup', { ...position, isPrimary: true }));
  element.dispatchEvent(new MouseEvent('mouseup', position));
  // The activation itself: one click event, following links and submitting
  // forms exactly as the browser does for a real press.
  element.click();
}

// [ACT DEBUG] Live DOM facts of the element the executor is about to touch —
// read from the element itself, never from Page Info. Read-only.
function elementFacts(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const anchor = element.matches('a') && element.getAttribute('href') !== null ? element as HTMLAnchorElement
    : element.closest('a[href]') as HTMLAnchorElement | null;
  return `tag=${element.tagName}\ntext=${(element.textContent ?? '').trim().slice(0, 120) || '(empty)'}\nhref=${anchor?.href ?? 'none'}\nrole=${element.getAttribute('role') ?? 'none'}\naria-label=${element.getAttribute('aria-label') ?? 'none'}\nbounds=${JSON.stringify({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) })}`;
}

export function act(input: ActInput): ActResult {
  const { action } = input;
  if (action.type === 'done') return { ok: true };
  // Opening an address is the worker's job (chrome.tabs.update); a page script
  // is never asked to navigate itself.
  if (action.type === 'navigate') return { error: 'INVALID_MESSAGE' };
  // The key action does not address an element: it dispatches Enter to whatever
  // the reviewed flow left focused, exactly as a person pressing the key would.
  if (action.type === 'key') {
    // Duck-typed rather than instanceof: the unit environment has no HTMLElement.
    const active = document.activeElement;
    const focused = active && typeof (active as HTMLElement).dispatchEvent === 'function' ? active as HTMLElement : document.body;
    try {
      // Chrome seeds keyCode/charCode/which only for real input, so a bare
      // constructed event arrives as keyCode 0 — invisible to the many site
      // scripts that read e.keyCode. Filling them makes the synthetic key
      // legible to page scripts; it does not make it trusted, so the default
      // action below is still ours to perform.
      const init: KeyboardEventInit = { key: action.key, code: action.key === 'Enter' ? 'Enter' : '',
        keyCode: action.key === 'Enter' ? 13 : 0, charCode: 0, bubbles: true, cancelable: true };
      const keydown = new KeyboardEvent('keydown', init);
      focused.dispatchEvent(keydown);
      // A page that handles Enter itself (preventDefault) keeps ownership:
      // deliver the rest of the sequence but never double-submit.
      if (!keydown.defaultPrevented) {
        focused.dispatchEvent(new KeyboardEvent('keypress', init));
        // Enter's default action on a form control is the HTML implicit
        // submission, and an untrusted keydown fires none. requestSubmit is
        // exactly that default — validation, submit event, navigation — not a
        // synthesized click and not a selector guess.
        // Tag-name check rather than `instanceof HTMLFormElement`, which the
        // unit environment (bare node) does not even define.
        const form = (focused.tagName === 'FORM' ? focused : focused.closest?.('form')) as HTMLFormElement | null;
        if (action.key === 'Enter' && form) form.requestSubmit();
      }
      focused.dispatchEvent(new KeyboardEvent('keyup', init));
    } catch { return { error: 'ACTION_FAILED' }; }
    return { ok: true };
  }
  // Back is the server's wrong-destination recovery: exactly one browser
  // history step, never a synthesized click, an id lookup or an arbitrary URL.
  // The navigation it causes flows through the existing PAGE_CHANGED pipeline,
  // which retires this observation and produces the fresh one.
  if (action.type === 'back') {
    try {
      // With no earlier entry there is nothing to go back to; fail safely
      // instead of pretending the recovery happened.
      if (history.length <= 1) {
        console.log(`[ACT DEBUG] BACK NAVIGATION\nrequested=true\nexecuted=false\nhistoryLength=${history.length}`);
        return { error: 'ACTION_FAILED' };
      }
      console.log(`[ACT DEBUG] BACK NAVIGATION\nrequested=true\nexecuted=true\nhistoryLength=${history.length}`);
      history.back();
      return { ok: true };
    } catch { return { error: 'ACTION_FAILED' }; }
  }
  if (action.type === 'scroll') {
    scrollBy({ top: action.direction === 'down' ? action.pixels : -action.pixels, behavior: 'instant' });
    return { ok: true };
  }
  const element = resolve(input);
  // [ACT DEBUG] A click whose id no longer resolves is exactly the stale-id
  // case this investigation must distinguish, so the refusal is logged too.
  if (typeof element === 'string') {
    if (action.type === 'click') {
      const target = action.target;
      console.log(`[ACT DEBUG] ID STABILITY\nrequested_id=${target}\nexists_in_current_refs=${input.refs.has(target)}\nobservation_id=${input.observationId ?? 'unavailable'}\ncurrent_observation_id=${input.currentObservationId ?? 'unavailable'}`);
      console.log(`[ACT DEBUG] RESOLUTION\nrequested_id=${target}\nresolved=false\nerror=${element}\nobservation_id=${input.observationId ?? 'unavailable'}`);
    }
    return { error: element };
  }
  // Literal server text must never reach a password, one-time-code or login
  // identifier field, no matter how the planner labelled it: the server never
  // learns credential values, so any text it sends for a credential field is
  // by definition not the user's credential. The deterministic refusal lives
  // in the executor, not in a prompt. Vault-backed fill stays allowed — the
  // user approved that value locally and it never crossed the wire.
  const literal = action.type === 'type' || action.type === 'choose';
  if (literal && (sensitiveControl(element) || credentialControl(element))) return { error: 'TARGET_UNSAFE' };
  try {
    if (action.type === 'click') {
      // [ACT DEBUG] The executor's own resolution evidence, immediately before
      // dispatch: the exact element pressPointer is about to click.
      const target = action.target;
      console.log(`[ACT DEBUG] ID STABILITY\nrequested_id=${target}\nexists_in_current_refs=${input.refs.has(target)}\nobservation_id=${input.observationId ?? 'unavailable'}\ncurrent_observation_id=${input.currentObservationId ?? 'unavailable'}`);
      console.log(`[ACT DEBUG] RESOLUTION\nrequested_id=${target}\nresolved=true\n${elementFacts(element)}\nobservation_id=${input.observationId ?? 'unavailable'}`);
      pressPointer(element);
      return { ok: true };
    }
    if (action.type === 'type' || action.type === 'fill') {
      const text = action.type === 'type' ? action.text : input.resolved;
      if (text === undefined) return { error: 'INVALID_MESSAGE' };
      element.focus();
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) writeValue(element, text);
      else if (element.isContentEditable) {
        element.textContent = text;
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      } else return { error: 'TARGET_CHANGED' };
      return { ok: true };
    }
    if (action.type === 'choose' || action.type === 'select') {
      const wanted = action.type === 'choose' ? action.optionText : input.resolved;
      if (wanted === undefined) return { error: 'INVALID_MESSAGE' };
      if (!(element instanceof HTMLSelectElement)) return { error: 'TARGET_CHANGED' };
      const normalized = wanted.trim().toLowerCase();
      const option = Array.from(element.options).find(item => item.text.trim().toLowerCase() === normalized) ??
        Array.from(element.options).find(item => item.value.trim().toLowerCase() === normalized);
      if (!option) return { error: 'ACTION_FAILED' };
      element.focus(); writeValue(element, option.value);
      return { ok: true };
    }
  } catch { return { error: 'ACTION_FAILED' }; }
  // `wait` is held by the caller, which owns the task's abort signal.
  return { error: 'INVALID_MESSAGE' };
}
