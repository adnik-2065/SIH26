# Reliability implementation report — capture races and capture-UI geometry

Date: 2026-09-25 · Base: commit `8f9ccea` working tree. All changes follow the constraints:
smallest targeted diffs, no chrome.debugger removal, no manifest/permission changes, no tolerance
increase, no blanket PAGE_CHANGED re-labeling, no arbitrary sleeps.

## 1. Root cause confirmed

1. **Capture/document-swap race (terminal CAPTURE_FAILED):** `capture/observe.ts` awaited
   `chrome.scripting.executeScript` and the `PREPARE_CAPTURE`/`COLLECT`/`CHECK`/`FINISH_CAPTURE`
   messages **raw**. During a document swap the browser throws ambiguous frame errors
   ("Cannot access contents of url", "Frame no longer exists", …). Idle, that wording means a
   genuinely restricted page (a real failure); mid-swap it means the document was replaced under
   the capture — but the background's final catch had no evidence to tell the two apart, so the
   mid-swap case landed in the terminal bucket (status 'failed'), which the panel cannot retry
   (`roundVerdict` halts on 'failed').
2. **ACT-navigation settlement gap:** the load-settle mechanism (`awaitLoadSettled`,
   `awaitingLoad`) was armed **only** when a *capture* ended PAGE_CHANGED. An ACT's own
   navigation pauses the task via `tabs.onUpdated` **without** arming it, so the recovery OBSERVE
   could race the tail of the swap.
3. **Capture-UI viewport change (measured 840 → 896):** the executor reconciled page-anchored and
   top-anchored (viewport-anchored) layouts only. A **centered** layout (modal, google's search
   box) moves by half the height delta, which neither interpretation explains — and the real
   Google drift finding (10 px) showed the tolerance must NOT be widened. (The prior
   investigation found the 10 px drift produced correct TARGET_CHANGED refusals; the geometry
   interpretation added here does not cover it, by design — it only reconciles a viewport-height
   change, with an unchanged viewport it reduces to the plain bounds comparison.)

## 2. Files changed (production)

| File | Change |
|------|--------|
| `src/capture/stability.ts` | `captureEndingClass` accepts an optional `CaptureEndEvidence` (`navigationInFlight`). The ambiguous frame-error family ("Cannot access contents of url", "Frame no longer exists", "Frame with given id was detached", "Inspected target navigated", "The tab was closed") is re-labeled PAGE_CHANGED **only when a navigation is in flight**; without the evidence they stay OTHER (genuine). |
| `src/capture/observe.ts` | New `captureStep` wrapper around `executeScript`/`PREPARE_CAPTURE`/`COLLECT`/`CHECK`/`FINISH_CAPTURE`. It re-labels **only the ambiguous family** (deliberately NOT the already-unambiguous "Receiving end does not exist" family, which the classifier already handles and whose text fidelity an existing test pins) to `CAPTURE_PAGE_CHANGED` when the tab still reports `status === 'loading'` at throw time. Evidence is taken in the catch. |
| `src/background/index.ts` | (a) The final catch reads the tab status at throw time and passes `{ navigationInFlight }` into the classifier. (b) `tabs.onUpdated` now **arms `awaitingLoad`/`settleMs`** for every task-tab navigation pause — including ACT-triggered ones — so the recovery OBSERVE waits for the browser's own load-complete signal (bounded fallback 2 s) before re-observing. |
| `src/dom/act.ts` | Geometry check gains a third page-wide interpretation, **center-anchored** (`expectedY + heightDelta / 2`) alongside page-anchored and viewport-anchored. Adds no tolerance; with an unchanged viewport it is identical to the previous behavior. |

## 3. Exact behavioral change

- **Before:** ambiguous frame error mid-swap → unclassified → CAPTURE_FAILED (status 'failed') →
  run terminates.
- **After:** the same error while the tab is still loading → `CAPTURE_PAGE_CHANGED` →
  `captureEndingClass` → PAGE_CHANGED (status 'paused', retryable) → panel retries with
  load-settlement → fresh observation on the settled document. **Unchanged:** timeouts, limits,
  debugger-refused attach, and every ambiguous error with no navigation in flight remain genuine
  failures (terminal CAPTURE_FAILED). "Receiving end does not exist"/"No frame with given id" and
  siblings keep their existing unconditional PAGE_CHANGED classification.
- **Before:** ACT navigation → pause without settlement arming → recovery OBSERVE could race the
  swap tail.
- **Change:** ACT navigations now arm the same bounded settlement the capture path uses — no new
  timer, the existing mechanism is finally applied to this path.
- **Before:** centered targets + capture-notice height change → false TARGET_CHANGED.
- **After:** reconciled by the center-anchored transform; genuine moves still refuse.

## 4. Capture-race classification logic

Evidence-gated at two layers. `captureStep` (observe.ts) samples `chrome.tabs.get(tabId).status`
in the catch and re-labels only the ambiguous family. The background classifier additionally
gates on the same evidence so even raw errors escaping the wrapper are decided by tab state, not
by message text alone. Without navigation evidence the ambiguous family stays a genuine failure;
already-unambiguous browser wordings keep their existing unconditional treatment. Genuine
capture failures (timeouts, limits, attach-refused) remain terminal CAPTURE_FAILED.

## 5. Navigation-settlement behavior

`tabs.onUpdated` (loading/url) pauses as before, and now arms `awaitingLoad` + `settleMs =
SETTLE_FALLBACK_MS (2000)`; the next START/OBSERVE consumes it via the existing
`awaitLoadSettled` (browser 'complete' event or 2 s bounded fallback), then mints the fresh
observation id. The capture-path arming (phase-sized fallbacks) is unchanged. No new timers, no
sleeps.

## 6. Geometry transformation logic

`act.ts` `resolve()` now checks the reviewed bounds against three page-wide interpretations:
page-anchored (`bounds.y − (scrollY − planned.scrollY)`), viewport-anchored
(`bounds.y + heightDelta`), and **center-anchored** (`bounds.y + heightDelta / 2`) — the last
covers Chrome's debugging-notice height change for centered layouts. All three use TOLERANCE = 4
(unchanged) and identical x/size checks. A genuine ~10 px displacement matches none of the three
and still refuses TARGET_CHANGED (proven by CASE B below and the full taxonomy matrix).

## 7. Tests added/changed

- `tests/unit/capture-ending.test.ts`: +4 unit tests — ambiguous-with-navigation → PAGE_CHANGED;
  ambiguous-without → OTHER; observeTab-level deterministic race test (tab 'loading' → error
  becomes CAPTURE_PAGE_CHANGED); same error on a settled tab keeps its original identity.
- `tests/browser/page-change-taxonomy.spec.ts`: +2 browser rows — CASE A (840 → 896 viewport,
  centered target → ok) and CASE B (genuine 10 px move of a centered target → TARGET_CHANGED).
- Investigation harness type fixes (tests/investigation/*) to keep `tsc --noEmit` clean.

## 8. Existing regression results (after the changes)

- `npx tsc --noEmit` clean; `npm run build` clean; `npx vitest run` **379/379**.
- Browser: page-change-taxonomy **17/17**, and the combined
  page-change-taxonomy + act + execute + act-roundtrip + observe-act-regressions +
  page-change-observation + agent-loop + capture-retry-navigation run **49/49** — this covers
  unchanged→success, scroll-with-viewport→success, genuine move→TARGET_CHANGED, replaced/removed
  target→TARGET_CHANGED, reload→PAGE_CHANGED, SPA/hash→PAGE_CHANGED, stale/late action→PAGE_CHANGED,
  hidden/disabled/covered→TARGET_CHANGED, password→TARGET_UNSAFE, malformed→INVALID_MESSAGE,
  choose missing option→ACTION_FAILED, harmless churn→ok.
- stability + full-page + pipeline-errors: **11 passed / 5 failed** — the stability ×2 are the
  documented pre-existing baseline ("still stops" ×2); the full-page ×3 are the environment-flaky
  baseline whose membership varies run-to-run (verified: the failing "zoom 1, DPR 2, long false"
  row **passes when run individually** with the new build).

## 9. Real-world validation (new dist, production paths)

- **CBE311 UI flow:** click performed → auto-recovery onto page-b (gen 0→7 through the retry
  lifecycle; 46 s including the round-2 model inference). Continues.
- **Redirect chain** (2 intermediate documents + target): capture killed per hop, retry lifecycle
  re-observes, gen 1→7, eventual stable observation. Continues.
- **Cross-origin navigation:** ACCESS_REQUIRED (both gates), fail-closed intact.
- **Restricted pages:** the scheme gate refused chrome:// as before (the 3b harness row navigates
  by script, which Chrome blocks pre-extension — the genuine scheme-gate behavior was proven in
  the prior investigation and is unchanged by these diffs).
- **Google/validation note:** the two-stage model loop on Google was validated in the previous
  round (3/3 runs, refusals root-caused as genuine 10 px drift → correctly refused; the
  center-anchored transform deliberately does not cover genuine drift).

## 10. Remaining limitations

- The mid-swap race was never reproduced end-to-end live (the retry lifecycle kept absorbing it);
  the classification is therefore proven at the unit level (deterministic observeTab tests with
  tab-status evidence) and by preserved behavior everywhere else, not by a live reproduction.
- The 840→896 capture-notice geometry case is proven in the browser (CASE A) at the executor
  level; the debugger-notice lifecycle itself was already whitelisted upstream (content.ts
  resized / FINISH_CAPTURE).
- full-page ×3 remain environment-flaky (pass individually; membership varies run-to-run);
  stability "still stops" ×2 remain the documented pre-existing baseline.
- The ambiguous family's "The tab was closed" wording, and any Chrome-version-specific error
  strings beyond the listed set, are not covered; the evidence gate is conservative by design.
