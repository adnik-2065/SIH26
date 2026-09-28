import { ContentCommandSchema, type PageChangedDetail, type PageChangeReason,
  type StabilitySnapshot } from '../contracts';
import { emptyMutationSummary, pageChangedDetail, type StabilityState } from '../capture/stability';
import { collect } from './observe';
import { act } from './act';
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
    layoutSize?: string; scrollX?: number; scrollY?: number; renderReset?: boolean; noticeHeightPixels?: number;
    invalidated?: PageChangeReason; before?: StabilityState } | undefined;
  let notice: { heightPixels: number; viewportHeightPixels: number; until: number } | undefined;
  let imagePreparation: AbortController | undefined;
  const changed = (detail?: PageChangedDetail) => {
    revision++;
    refs.clear();
    if (observationId) {
      const previous = observationId;
      observationId = undefined;
      void chrome.runtime.sendMessage({ type: 'PAGE_CHANGED', observationId: previous, ...(detail ? { detail } : {}) }).catch(() => {});
    }
  };
  // A page is considered changed only when something happened that the captured
  // pixels cannot survive: the document was navigated or replaced.
  //
  // There is deliberately no MutationObserver here any more. Watching the DOM
  // made every counter tick, badge update, class toggle, React re-render and
  // lazy image count as a changed page, which retired captures faster than the
  // pipeline could finish one. What the capture actually depends on — the URL,
  // the document size, the viewport, the scroll position and whether the
  // controls still exist — is compared directly, once, in `compareCaptureStability`
  // when the screenshots are done. Acting on a control is a separate question,
  // and `act()` still re-checks connection, visibility, disabled state, reviewed
  // geometry and occlusion at the instant of the action.
  const navigated = (category: string) => {
    const summary = emptyMutationSummary();
    summary.total = 1; summary.significant = 1; summary.categories[category] = 1;
    if (capture && !capture.restoreUntil) { capture.invalidated ??= 'PAGE_CHANGED_NAVIGATION'; return; }
    changed(pageChangedDetail('PAGE_CHANGED_NAVIGATION', summary, capture?.before));
  };
  for (const event of ['popstate', 'hashchange', 'pagehide']) {
    window.addEventListener(event, () => navigated(event), { capture: true, passive: true });
  }
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
    // A resize event is not proof that the screenshot is stale: Chrome's
    // debugger notice and its full-page renderer both emit transient ones that
    // have already returned by CHECK. The before/after viewport in
    // `compareCaptureStability` is what decides.
    if (next !== lastSize) lastSize = next;
  };
  // Scrolling — including a container scrolling itself — no longer retires the
  // capture. Only a scroll offset that actually differs between COLLECT and
  // CHECK does, because that is what moves recorded element bounds away from
  // the pixels they describe.
  window.addEventListener('resize', resized, { passive: true });
  visualViewport?.addEventListener('resize', resized);
  const stabilitySnapshot = (snapshot: ReturnType<typeof collect>): StabilitySnapshot => {
    const root = document.documentElement, body = document.body;
    const widths = [root?.scrollWidth, root?.offsetWidth, root?.clientWidth, body?.scrollWidth, body?.offsetWidth, body?.clientWidth]
      .filter((value): value is number => Number.isFinite(value));
    const heights = [root?.scrollHeight, root?.offsetHeight, root?.clientHeight, body?.scrollHeight, body?.offsetHeight, body?.clientHeight]
      .filter((value): value is number => Number.isFinite(value));
    const totalElementCount = document.getElementsByTagName?.('*').length ?? document.querySelectorAll?.('*').length ?? 0;
    return {
      url: location.href, documentId,
      documentWidth: Math.max(0, ...widths), documentHeight: Math.max(0, ...heights),
      scrollWidth: Math.max(0, root?.scrollWidth || 0, body?.scrollWidth || 0),
      scrollHeight: Math.max(0, root?.scrollHeight || 0, body?.scrollHeight || 0),
      viewportWidth: innerWidth, viewportHeight: innerHeight, scrollX, scrollY,
      totalElementCount, interactiveElementCount: snapshot.elements.length,
    };
  };
  const snapshotResponse = (commandObservationId: string) => {
    const snapshot = collect(commandObservationId, documentId, revision, refs);
    return { snapshot, stability: stabilitySnapshot(snapshot), mutations: emptyMutationSummary() };
  };
  chrome.runtime.onMessage.addListener((raw: unknown, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return;
    const parsed = ContentCommandSchema.safeParse(raw);
    if (!parsed.success) { reply({ error: 'INVALID_MESSAGE' }); return; }
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
      // Lazy images are still decoded before the screenshots, so the capture
      // does not photograph half-loaded content. Nothing waits for the DOM to
      // fall quiet any more.
      void prepareImages(imagePreparation.signal).then(() => reply({ ok: true }),
        () => reply({ error: 'CAPTURE_FAILED' }));
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
      // [ACT DEBUG] The command's observation id and the content script's live
      // one ride along for diagnostic logging only; resolution is unchanged.
      reply(act({ action: command.action, refs, expect: command.expect, resolved: command.resolved,
        observationId: command.observationId, currentObservationId: observationId }));
      return;
    }
    if (command.type === 'CHECK' && observationId !== command.observationId) {
      reply({ error: 'PAGE_CHANGED', detail: pageChangedDetail(capture?.invalidated ?? 'PAGE_CHANGED_NAVIGATION',
        emptyMutationSummary(), capture?.before) }); return;
    }
    observationId = command.observationId;
    if (command.type === 'COLLECT' && capture?.observationId === observationId) {
      capture.layoutSize = size(); capture.scrollX = scrollX; capture.scrollY = scrollY;
    }
    const response = snapshotResponse(observationId);
    if (command.type === 'COLLECT' && capture) capture.before = { dom: response.snapshot, stability: response.stability };
    // The only thing that can invalidate a capture from inside the page now is
    // navigation, which is recorded as it happens.
    if (command.type === 'CHECK' && capture?.invalidated) {
      const detail = pageChangedDetail(capture.invalidated, emptyMutationSummary(), capture.before,
        { dom: response.snapshot, stability: response.stability });
      console.warn(`[CAPTURE][${command.observationId}][PAGE_CHANGED] reason=${detail.cause}`);
      reply({ error: 'PAGE_CHANGED', detail }); return;
    }
    reply(response);
  });
}
