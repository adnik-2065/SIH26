import type { Action, ObservedElement } from '../contracts';

export function preparationOnly(instruction: string) {
  return /\bdraft\b|\bprepare\b|(?:don['’]?t|do not|never|without)\s+(?:\w+\s+){0,2}(?:submit|send|publish|apply|confirm|order)/i.test(instruction);
}
// HTML semantics first. Unknown buttons require review, since labels alone
// cannot establish whether an application-specific command is reversible.
export function consequential(action: Action, element?: Pick<ObservedElement, 'role' | 'type' | 'label'>) {
  if (action.type === 'key') return true; // Enter can implicitly submit a form.
  if (action.type !== 'click') return false;
  if (!element) return true;
  if (/^(submit|reset|image)$/i.test(element.type)) return true;
  if (/\b(send|submit|confirm|order|purchase|pay|publish|delete|remove|apply|register|sign up|accept|authorize)\b/i.test(element.label)) return true;
  return (element.role === 'button' || element.type === 'button') &&
    !/^(next|previous|back|continue|cancel|close|search|find|open|show|hide|add)(\b|$)/i.test(element.label.trim());
}
