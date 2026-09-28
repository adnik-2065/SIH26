import type { DomSnapshot, ObservedElement } from '../contracts';
import { collectVisualRegions } from './visuals';

export const candidates = 'input,textarea,select,button,a[href],[role="button"],[role="textbox"],[role="combobox"],[role="checkbox"]';

// ---------------------------------------------------------------------------
// Autocomplete / search-suggestion candidates.
//
// A visible autocomplete option (role="option", a listbox item, a suggestion
// row under an active search field) is actionable for the user but matches no
// selector in `candidates`, so the observation never exposed it and a server
// that could see the suggestion in the screenshot had to guess among unrelated
// controls. These candidates are deliberately focused: only elements with
// explicit suggestion semantics are described — never arbitrary divs, spans
// or text nodes.
const SUGGESTION_ROLES = 'option';
// Three focused arms: an explicit option anywhere; the visible rows of a
// listbox (the actionable containers — the listbox wrapper itself is never a
// click target); and a non-listbox suggestion bubble hanging directly off an
// expanded combobox, exposed at container level because it has no option
// semantics of its own. Visibility is still decided per element by
// available(), so a closed dropdown contributes nothing.
const suggestionSelector = `[role="${SUGGESTION_ROLES}"],[role="listbox"] > *,[aria-expanded="true"][role="combobox"] + *:not([role="listbox"])`;
function labelText(element: Element | null): string {
  if (!element || element.matches('input,textarea,select,script,style')) return '';
  const copy = element.cloneNode(true) as Element;
  copy.querySelectorAll('input,textarea,select,script,style').forEach(child => child.remove());
  return copy.textContent || '';
}
// A suggestion's accessible name: aria-label, then aria-labelledby, then its
// visible text. A suggestion row carries no <label for>, so the standard path
// would leave it nameless and the server could not match the visible text it
// just read from the screenshot. Same 200-char normalization as labelFor; the
// result still travels through the redaction pipeline.
export function suggestionLabel(el: HTMLElement) {
  const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(id => labelText(document.getElementById(id))).join(' ');
  const label = el.getAttribute('aria-label') || labelled || el.textContent || '';
  return label.replace(/\s+/g, ' ').trim().slice(0, 200);
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
// Credential fields the agent must never type into and whose filled state the
// server may learn (as a boolean, never a value). Password and one-time-code
// controls are unambiguous. A username/email identifier is credential only
// inside a login form — one that contains a password field — so search boxes,
// newsletter emails and every ordinary text input on ordinary pages stay
// agent-typeable. The classification is read at scan time from DOM semantics:
// input type, the autocomplete attribute, and the field's name/id inside the
// form context. No site-specific selectors.
export function credentialControl(el: HTMLElement) {
  if (sensitiveControl(el)) return true;
  const form = el.closest?.('form');
  if (!form) return false;
  const hasPassword = Boolean(form.querySelector?.('input[type="password"]'));
  if (!hasPassword) return false;
  const autocomplete = el.getAttribute('autocomplete') || '';
  if (/^(username|email|one-time-code|tel)$/.test(autocomplete)) return true;
  const control = el as HTMLInputElement;
  // A bare <input> is a text input by definition; type="email" is the classic
  // login-identifier markup. The field's name or id must then BE a credential
  // name — the whole identifier, not a prefix, so 'user_comment' and
  // 'email_visible' on ordinary pages never match.
  if (!['text', 'input', 'email'].includes(controlType(el))) return false;
  const identifier = (control.name || control.id || '').trim().toLowerCase().replace(/[-_ ]?(input|field|id)$/, '');
  return ['username', 'user', 'login', 'logon', 'log', 'email', 'emailaddress', 'account', 'accountname',
    'userid', 'loginname', 'useremail', 'loginemail'].includes(identifier);
}
// Visible and interactive: the same gate the observer applies when it decides
// a control is worth describing at all. The capture photographs the whole
// document, not just the viewport, so "on screen" means "inside the document".
// getBoundingClientRect is viewport-relative, so the document-space extent is
// reconstructed with the scroll offsets: a course row below the fold or above
// it after a scroll is still in the screenshot's document and stays described.
// Off-document parked nodes (above or beside the page) stay excluded, as do
// hidden, invisible and aria-hidden controls.
export function available(el: HTMLElement) {
  const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
  const documentHeight = document.documentElement.scrollHeight || innerHeight;
  const documentWidth = document.documentElement.scrollWidth || innerWidth;
  const documentTop = rect.top + scrollY, documentBottom = rect.bottom + scrollY;
  const documentLeft = rect.left + scrollX, documentRight = rect.right + scrollX;
  return Boolean(el.isConnected) && Boolean(rect.width) && Boolean(rect.height) && style.visibility !== 'hidden' &&
    style.display !== 'none' && Number(style.opacity) !== 0 && !el.closest('[hidden],[inert],[aria-hidden="true"]') &&
    documentBottom > 0 && documentRight > 0 &&
    documentTop < documentHeight && documentLeft < documentWidth;
}
export function collect(observationId: string, documentId: string, revision: number, refs: Map<string, HTMLElement>): DomSnapshot {
  refs.clear();
  let hiddenCount = 0;
  const elements: ObservedElement[] = [];
  // Elements already examined by the base pass — described or counted hidden —
  // so suggestion candidates never duplicate a base candidate and a listbox
  // never yields an option and its wrapper. Insertion order keeps the
  // outermost container.
  const elsMap = new Set<HTMLElement>();
  let truncated = false;
  const all = Array.from(document.querySelectorAll<HTMLElement>(candidates));
  for (const el of all.slice(0, 2000)) {
    elsMap.add(el);
    const r = el.getBoundingClientRect();
    if (!available(el)) { hiddenCount++; continue; }
    if (elements.length >= 200) { truncated = true; continue; }
    const type = controlType(el);
    const sensitive = sensitiveControl(el);
    const id = `${observationId}_e${elements.length + 1}`;
    refs.set(id, el);
    elements.push({ id, type, sensitive, filled: hasValue(el), credential: credentialControl(el),
      label: sensitive ? 'Sensitive field' : labelFor(el),
      role: (el.getAttribute('role') || (el.matches('button') ? 'button' : el.matches('select') ? 'combobox' : el.matches('a') ? 'link' : type === 'checkbox' ? 'checkbox' : 'textbox')).slice(0, 50),
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
    });
  }
  // Suggestion candidates join the same observation: one scan, one shared
  // 200-element budget, one id sequence. Nothing already exposed by the base
  // pass is dropped, hidden or renumbered — the ids below begin where the
  // base ids end, so every existing candidate keeps its exact id.
  const suggestions = document.querySelectorAll<HTMLElement>(suggestionSelector);
  for (const el of Array.from(suggestions)) {
    if (elements.length >= 200) { truncated = true; break; }
    if (elsMap.has(el)) continue; // already examined by the base pass
    if (!available(el)) { hiddenCount++; continue; }
    elsMap.add(el);
    const r = el.getBoundingClientRect();
    const id = `${observationId}_e${elements.length + 1}`;
    refs.set(id, el);
    elements.push({ id, type: 'option', sensitive: false, filled: false, credential: false,
      label: suggestionLabel(el),
      // Page-supplied roles are echoed only when they are widget vocabulary
      // the pipeline can carry; anything else is reported as the generic
      // 'option' rather than leaking a site-specific attribute value.
      role: (['option', 'listitem'].includes(el.getAttribute('role') || '') ? el.getAttribute('role')! : 'option'),
      disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
      bounds: { x: r.x, y: r.y, width: r.width, height: r.height },
    });
  }
  const visuals = collectVisualRegions();
  return { observationId, documentId, revision, origin: location.origin, elements, hiddenCount,
    visualRegions: visuals.regions, truncated: truncated || visuals.truncated || all.length > 2000,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, devicePixelRatio,
      visualScale: visualViewport?.scale || 1, offsetX: visualViewport?.offsetLeft || 0, offsetY: visualViewport?.offsetTop || 0 },
  };
}
