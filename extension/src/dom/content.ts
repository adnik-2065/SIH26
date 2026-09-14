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
  let capture: { observationId: string; originalSize: string; restoreUntil: number } | undefined;
  let notice: { heightPixels: number; until: number } | undefined;
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
  for (const event of ['input', 'change', 'scroll', 'popstate', 'hashchange', 'pagehide', 'animationstart', 'transitionrun']) {
    window.addEventListener(event, changed, { capture: true, passive: true });
  }
  const resized = () => {
    // Browser capture may emit resize with identical layout dimensions. Only
    // an actual viewport change makes the observation stale.
    const next = size();
    // Chrome's temporary debugging notice changes the available height. Permit
    // exactly its return to the pre-capture viewport, once, for this observation.
    // All other resizes, scrolling, input and DOM mutations remain tracked.
    if (capture && observationId === capture.observationId && next === capture.originalSize && performance.now() <= capture.restoreUntil) {
      lastSize = next; capture = undefined; notice = undefined; return;
    }
    if (next !== lastSize) { lastSize = next; changed(); }
  };
  window.addEventListener('resize', resized, { passive: true });
  visualViewport?.addEventListener('resize', resized);
  visualViewport?.addEventListener('scroll', changed);
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
      if (notice && notice.until >= performance.now()) dimensions[1] = String(Math.round(innerHeight + notice.heightPixels / devicePixelRatio));
      const originalSize = dimensions.join(':');
      capture = { observationId: command.observationId, originalSize, restoreUntil: 0 };
      imagePreparation?.abort();
      imagePreparation = new AbortController();
      void prepareImages(imagePreparation.signal).then(() => reply({ ok: true }), () => reply({ error: 'CAPTURE_FAILED' }));
      return true;
    }
    if (command.type === 'FINISH_CAPTURE') {
      if (capture?.observationId === command.observationId) {
        capture.restoreUntil = performance.now() + 10_000;
        notice = { heightPixels: Math.max(0, (Number(capture.originalSize.split(':')[1]) - innerHeight) * devicePixelRatio), until: capture.restoreUntil };
      }
      reply({ ok: true }); return;
    }
    if (command.type === 'RELEASE') { imagePreparation?.abort(); refs.clear(); observationId = undefined; capture = undefined; reply({ ok: true }); return; }
    if (command.type === 'CHECK' && observationId !== command.observationId) { reply({ error: 'PAGE_CHANGED' }); return; }
    observationId = command.observationId;
    reply(collect(observationId, documentId, revision, refs));
  });
}
