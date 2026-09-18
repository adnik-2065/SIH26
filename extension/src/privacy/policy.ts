import type { ObservedElement, VisualCategory } from '../contracts';

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
