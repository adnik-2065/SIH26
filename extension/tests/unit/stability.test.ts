import { describe, expect, it } from 'vitest';
import type { DomSnapshot, StabilitySnapshot } from '../../src/contracts';
import { compareCaptureStability } from '../../src/capture/stability';

const dom = (elements: DomSnapshot['elements'] = []): DomSnapshot => ({
  observationId: 'obs_1', documentId: 'doc_1', revision: 0, origin: 'https://example.test',
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1, visualScale: 1, offsetX: 0, offsetY: 0 },
  elements, hiddenCount: 0, truncated: false,
});
const stable = (change: Partial<StabilitySnapshot> = {}): StabilitySnapshot => ({
  url: 'https://example.test/page', documentId: 'doc_1', documentWidth: 800, documentHeight: 1800,
  scrollWidth: 800, scrollHeight: 1800, viewportWidth: 800, viewportHeight: 600, scrollX: 0, scrollY: 0,
  totalElementCount: 100, interactiveElementCount: 12, ...change,
});
const control = (id: string, change: Partial<DomSnapshot['elements'][number]> = {}) => ({
  id, role: 'button', label: 'Continue', type: 'button', disabled: false, sensitive: false, filled: false,
  bounds: { x: 10, y: 20, width: 100, height: 30 }, ...change,
});
const compare = (before: Partial<StabilitySnapshot>, after: Partial<StabilitySnapshot>,
  beforeDom = dom(), afterDom = dom()) =>
  compareCaptureStability({ dom: beforeDom, stability: stable(before) }, { dom: afterDom, stability: stable(after) });

// The capture is kept unless the page it photographed is gone. Everything in
// this block is ordinary behaviour of a live application.
describe('churn that no longer stops a scan', () => {
  it.each([
    ['an unchanged page', {}],
    ['a revision counter', {}],
    ['a few pixels of layout settle', { documentHeight: 1803, scrollHeight: 1803 }],
    ['content lazily loading in', { documentHeight: 1980, scrollHeight: 1980 }],
    ['a debugger-notice viewport inset that returned', { viewportHeight: 584 }],
    ['sub-pixel scroll drift', { scrollY: 4 }],
    ['new controls appearing', { interactiveElementCount: 30 }],
    ['one control disappearing', { interactiveElementCount: 11 }],
    ['many more DOM nodes', { totalElementCount: 4000 }],
    ['fewer DOM nodes', { totalElementCount: 20 }],
  ])('keeps scanning through %s', (_label, after) => {
    expect(compare({}, after)).toEqual({ stable: true });
  });
  it('ignores element labels, state and geometry entirely', () => {
    // A counter in a label, a button becoming disabled, a re-render moving a
    // control: none of these make the screenshots wrong.
    const before = dom([control('obs_1_e1', { label: 'Inbox (3)' }), control('obs_1_e2')]);
    const after = dom([control('obs_1_e1', { label: 'Inbox (4)', disabled: true, bounds: { x: 90, y: 400, width: 120, height: 44 } }),
      control('obs_1_e2', { role: 'link' })]);
    expect(compare({ interactiveElementCount: 2 }, { interactiveElementCount: 2 }, before, after)).toEqual({ stable: true });
  });
  it('ignores the mutation summary even when it reports significant mutations', () => {
    expect(compareCaptureStability({ dom: dom(), stability: stable() }, { dom: dom(), stability: stable() },
      { total: 400, ignored: 0, significant: 400, categories: { large_subtree: 400 } })).toEqual({ stable: true });
  });
});

describe('major changes that still stop a scan', () => {
  it('reports navigation to another url', () => {
    expect(compare({}, { url: 'https://example.test/other' })).toEqual({ stable: false, reason: 'PAGE_CHANGED_NAVIGATION' });
  });
  it('reports a reload as a new document', () => {
    expect(compare({}, { documentId: 'doc_2' })).toEqual({ stable: false, reason: 'PAGE_CHANGED_NAVIGATION' });
  });
  it('reports a different origin', () => {
    expect(compareCaptureStability({ dom: dom(), stability: stable() },
      { dom: { ...dom(), origin: 'https://elsewhere.test' }, stability: stable() })).toEqual({
      stable: false, reason: 'PAGE_CHANGED_NAVIGATION' });
  });
  it.each([
    ['height', { documentHeight: 3800, scrollHeight: 3800 }],
    ['width', { documentWidth: 2400, scrollWidth: 2400 }],
  ])('reports a drastic document %s change', (_label, after) => {
    expect(compare({}, after)).toEqual({ stable: false, reason: 'PAGE_CHANGED_DOCUMENT_SIZE' });
  });
  it('reports a window resize', () => {
    expect(compare({}, { viewportHeight: 900 })).toEqual({ stable: false, reason: 'PAGE_CHANGED_MAJOR_LAYOUT' });
    expect(compare({}, { viewportWidth: 1200 })).toEqual({ stable: false, reason: 'PAGE_CHANGED_MAJOR_LAYOUT' });
  });
  it('reports the page scrolling under the screenshots', () => {
    expect(compare({}, { scrollY: 400 })).toEqual({ stable: false, reason: 'PAGE_CHANGED_MAJOR_LAYOUT' });
  });
  it('reports controls disappearing', () => {
    expect(compare({ interactiveElementCount: 12 }, { interactiveElementCount: 8 }))
      .toEqual({ stable: false, reason: 'PAGE_CHANGED_TARGET_REMOVED' });
    expect(compare({ interactiveElementCount: 3 }, { interactiveElementCount: 0 }))
      .toEqual({ stable: false, reason: 'PAGE_CHANGED_TARGET_REMOVED' });
  });
});
