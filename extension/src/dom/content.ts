import { ContentCommandSchema, type Rect } from '../contracts';
import { collect } from './observe';
import { act } from './act';
import { prepareImages } from './images';

// Reinjection must not add another observer or message listener.
const scope = globalThis as typeof globalThis & { __sih26Installed?: boolean };
if (!scope.__sih26Installed) {
  scope.__sih26Installed = true;
  const documentId = crypto.randomUUID();
  const refs = new Map<string, HTMLElement>();
  // Where each reviewed control was when the observation was collected, in
  // viewport pixels. Surrounding churn is judged against this.
  const reviewedRects = new Map<HTMLElement, Rect>();
  let revision = 0;
  let observationId: string | undefined;
  const size = () => `${innerWidth}:${innerHeight}:${devicePixelRatio}:${visualViewport?.scale}:${visualViewport?.offsetLeft}:${visualViewport?.offsetTop}`;
  let lastSize = size();
  let capture: { observationId: string; originalSize: string; restoreUntil: number;
    layoutSize?: string; scrollX?: number; scrollY?: number; renderReset?: boolean; noticeHeightPixels?: number } | undefined;
  let notice: { heightPixels: number; viewportHeightPixels: number; until: number } | undefined;
  let imagePreparation: AbortController | undefined;
  const changed = () => {
    revision++;
    refs.clear();
    reviewedRects.clear();
    if (observationId) {
      const previous = observationId;
      observationId = undefined;
      void chrome.runtime.sendMessage({ type: 'PAGE_CHANGED', observationId: previous }).catch(() => {});
    }
  };
  // Does this mutation touch a control the observation actually described? A
  // reviewed control itself, or something inside it: its label, state or size
  // may have just changed.
  //
  // An ancestor is deliberately not counted. Appending a notification toast to
  // <body>, or toggling a class on <html>, contains every control on the page
  // while changing none of them, and live applications do that every few
  // seconds. Counting containment upwards therefore retired the observation
  // before the reasoning server could answer, so every proposed step came back
  // PAGE_CHANGED and nothing was ever performed. An ancestor change that does
  // move, hide or cover the target is still caught: the executor re-checks
  // connection, visibility, disabled state, geometry and occlusion against the
  // reviewed bounds at the instant of the action.
  const touchesReviewed = (node: Node | null): boolean => {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node as Element : node?.parentElement ?? null;
    if (!element) return true;
    for (const ref of refs.values()) if (ref === element || ref.contains(element)) return true;
    return false;
  };
  // Layout settles by fractions of a pixel between reads; a real change to a
  // container moves its contents by much more than this.
  const DRIFT = 2;
  // Did the surrounding change actually move what the user reviewed? A toast
  // pinned to a corner does not; a container that re-orders, collapses or hides
  // its children does, and then the reviewed screenshot no longer describes the
  // page. Hiding a control zeroes its box, which counts as moved.
  const movedReviewed = () => {
    for (const [element, rect] of reviewedRects) {
      const now = element.getBoundingClientRect();
      if (Math.abs(now.x - rect.x) > DRIFT || Math.abs(now.y - rect.y) > DRIFT ||
        Math.abs(now.width - rect.width) > DRIFT || Math.abs(now.height - rect.height) > DRIFT) return true;
    }
    return false;
  };
  // A reviewed control that was itself detached, re-parented or replaced, named
  // in the record rather than merely surrounded by it.
  const movesReviewed = (nodes: NodeList): boolean => {
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      for (const ref of refs.values()) if (node === ref || (node as Element).contains(ref)) return true;
    }
    return false;
  };
  // Capture remains strict: any mutation can make its DOM snapshot and image
  // describe different moments. Once capture has finished, however, many live
  // applications keep changing unrelated badges, timers and notification
  // containers while the reasoning server is working. Retiring every target
  // for those changes makes a valid server action impossible to execute.
  //
  // After capture, preserve the reviewed element map unless a mutation reaches
  // a reviewed control itself or its contents, moves one, replaces pixels that
  // were reviewed, or shifts a reviewed control on the page. The executor still
  // checks connection, visibility, disabled state, geometry and occlusion at
  // the instant of the action. Navigation, input, scroll and resize continue to
  // invalidate through their dedicated listeners below.
  const significant = (records: MutationRecord[]) => {
    if (capture && !capture.restoreUntil) return records.length > 0;
    if (records.some(record => touchesReviewed(record.target) ||
      record.type === 'childList' && (movesReviewed(record.removedNodes) || movesReviewed(record.addedNodes)) ||
      record.type === 'attributes' && ['src', 'srcset', 'poster'].includes(record.attributeName || ''))) return true;
    return records.length > 0 && movedReviewed();
  };
  const observer = new MutationObserver(records => { if (significant(records)) changed(); });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  for (const event of ['input', 'change', 'popstate', 'hashchange', 'pagehide']) {
    window.addEventListener(event, changed, { capture: true, passive: true });
  }
  for (const event of ['animationstart', 'transitionrun']) window.addEventListener(event, () => {
    // Native capture can restart CSS animations while recalculating its render
    // surface. Motion is paused by the capture stylesheet, and final DOM bounds
    // are compared separately. Input, scroll, resizing and mutations still
    // invalidate immediately; CSS lifecycle tracking resumes after capture.
    if (!capture || capture.restoreUntil > 0) changed();
  }, { capture: true, passive: true });
  const resized = () => {
    // Browser capture may emit resize with identical layout dimensions. Only
    // an actual viewport change makes the observation stale.
    const next = size();
    if (capture && !capture.layoutSize && !capture.restoreUntil) {
      const previous = lastSize.split(':');
      if (Number(previous[0]) !== innerWidth) {
        // The sidebar may finish opening after the debugging notice appears.
        // Its content inset is separate from the notice's measured height.
        const original = next.split(':');
        original[1] = String(Math.round(innerHeight + (capture.noticeHeightPixels || 0) / devicePixelRatio));
        capture.originalSize = original.join(':');
      } else if (Number(previous[2]) === devicePixelRatio && innerHeight < Number(previous[1])) {
        capture.noticeHeightPixels ??= (Number(previous[1]) - innerHeight) * devicePixelRatio;
      }
    }
    // Chrome's full-document renderer briefly uses a 1×1 layout between
    // screenshot sections. Permit only that exact internal reset and its exact
    // return; any other viewport change still cancels the capture.
    if (capture && observationId === capture.observationId && !capture.restoreUntil) {
      if (innerWidth === 1 && innerHeight === 1) { capture.renderReset = true; return; }
      if (capture.renderReset && next === capture.layoutSize) { capture.renderReset = false; lastSize = next; return; }
    }
    // Chrome's temporary debugging notice changes the available height. Permit
    // exactly its return to the pre-capture viewport, once, for this observation.
    // All other resizes, scrolling, input and DOM mutations remain tracked.
    if (capture && observationId === capture.observationId && next === capture.originalSize && performance.now() <= capture.restoreUntil) {
      lastSize = next; capture = undefined; notice = undefined; return;
    }
    if (next !== lastSize) { lastSize = next; changed(); }
  };
  const scrolled = (event: Event) => {
    const root = !!event && (event.target === document || event.target === window || event.target === visualViewport);
    if (root && capture && observationId === capture.observationId && !capture.restoreUntil &&
      (capture.renderReset || size() === capture.layoutSize && scrollX === capture.scrollX && scrollY === capture.scrollY)) return;
    changed();
  };
  window.addEventListener('scroll', scrolled, { capture: true, passive: true });
  window.addEventListener('resize', resized, { passive: true });
  visualViewport?.addEventListener('resize', resized);
  visualViewport?.addEventListener('scroll', scrolled);
  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    const parsed = ContentCommandSchema.safeParse(raw);
    if (!parsed.success) { reply({ error: 'INVALID_MESSAGE' }); return; }
    if (significant(observer.takeRecords())) changed();
    const command = parsed.data;
    if (command.type === 'PREPARE_CAPTURE') {
      // A quick Scan again can start before Chrome removes the previous notice.
      // Carry the genuine pre-notice size across that capture, not the reduced one.
      const dimensions = size().split(':');
      let noticeHeightPixels: number | undefined;
      // A resize event can still be queued after Chrome has already restored
      // the viewport. Only add the notice height if it is actually still there.
      if (notice && notice.until >= performance.now() && Math.abs(innerHeight * devicePixelRatio - notice.viewportHeightPixels) <= devicePixelRatio) {
        dimensions[1] = String(Math.round(innerHeight + notice.heightPixels / devicePixelRatio));
        noticeHeightPixels = notice.heightPixels;
      }
      const originalSize = dimensions.join(':');
      capture = { observationId: command.observationId, originalSize, restoreUntil: 0, noticeHeightPixels };
      imagePreparation?.abort();
      imagePreparation = new AbortController();
      void prepareImages(imagePreparation.signal).then(() => reply({ ok: true }), () => reply({ error: 'CAPTURE_FAILED' }));
      return true;
    }
    if (command.type === 'FINISH_CAPTURE') {
      if (capture?.observationId === command.observationId) {
        capture.restoreUntil = performance.now() + 10_000;
        notice = { heightPixels: Math.max(0, (Number(capture.originalSize.split(':')[1]) - innerHeight) * devicePixelRatio),
          viewportHeightPixels: innerHeight * devicePixelRatio, until: capture.restoreUntil };
      }
      reply({ ok: true }); return;
    }
    if (command.type === 'RELEASE') {
      // Stop can interrupt before FINISH_CAPTURE while Chrome's notice remains
      // visible. Preserve its measured inset for an immediate fresh scan, even
      // if the renderer is currently in its temporary 1×1 layout.
      if (capture && !capture.restoreUntil) {
        const dimensions = (capture.layoutSize || size()).split(':').map(Number);
        notice = { heightPixels: Math.max(0, (Number(capture.originalSize.split(':')[1]) - dimensions[1]) * dimensions[2]),
          viewportHeightPixels: dimensions[1] * dimensions[2], until: performance.now() + 10_000 };
      }
      imagePreparation?.abort(); refs.clear(); observationId = undefined; capture = undefined; reply({ ok: true }); return;
    }
    if (command.type === 'ACT') {
      // takeRecords above already cleared the map for any pending mutation, so
      // an action can only run against the exact page state that was reviewed.
      if (observationId !== command.observationId) { reply({ error: 'PAGE_CHANGED' }); return; }
      reply(act({ action: command.action, refs, expect: command.expect, resolved: command.resolved }));
      return;
    }
    if (command.type === 'CHECK' && observationId !== command.observationId) { reply({ error: 'PAGE_CHANGED' }); return; }
    observationId = command.observationId;
    if (command.type === 'COLLECT' && capture?.observationId === observationId) {
      capture.layoutSize = size(); capture.scrollX = scrollX; capture.scrollY = scrollY;
    }
    const snapshot = collect(observationId, documentId, revision, refs);
    reviewedRects.clear();
    for (const element of snapshot.elements ?? []) {
      const reviewed = refs.get(element.id);
      if (reviewed) reviewedRects.set(reviewed, element.bounds);
    }
    reply(snapshot);
  });
}
