import { ContentCommandSchema } from '../contracts';
import { collect } from './observe';
import { prepareImages } from './images';

// Reinjection must not add another observer or message listener.
const scope = globalThis as typeof globalThis & { __sih26Installed?: boolean };
if (!scope.__sih26Installed) {
  scope.__sih26Installed = true;
  const documentId = crypto.randomUUID();
  const refs = new Map<string, HTMLElement>();
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
    if (observationId) {
      const previous = observationId;
      observationId = undefined;
      void chrome.runtime.sendMessage({ type: 'PAGE_CHANGED', observationId: previous }).catch(() => {});
    }
  };
  const observer = new MutationObserver(changed);
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
    if (observer.takeRecords().length) changed();
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
    if (command.type === 'CHECK' && observationId !== command.observationId) { reply({ error: 'PAGE_CHANGED' }); return; }
    observationId = command.observationId;
    if (command.type === 'COLLECT' && capture?.observationId === observationId) {
      capture.layoutSize = size(); capture.scrollX = scrollX; capture.scrollY = scrollY;
    }
    reply(collect(observationId, documentId, revision, refs));
  });
}
