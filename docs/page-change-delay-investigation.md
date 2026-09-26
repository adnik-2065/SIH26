# PAGE_CHANGED delay investigation — Tests 1 & 2 (evidence report)

Date: 2026-09-24 · Harness: `extension/tests/investigation/page-change-delay.spec.ts` (standalone,
evidence-only, never part of the test suite; run via
`npx playwright test --config=playwright.investigation.config.ts`).

Protocol constraints honoured: **no model/VLM call was ever made** (the harness drives the worker
directly, exactly as `act-roundtrip.spec.ts` does; only the local capture pipeline ran); the page
was left idle during every delay (no click/scroll/navigate/resize — and **no extension messages
during the delay**, so nothing reset the MV3 service-worker idle timer); the same stable page
(`my-courses.html`) and the same target (the CBE311 Database Security link, `…_e11` in each fresh
observation — the same element the earlier `e17` incident pointed at) were used for all runs;
evidence was recorded as raw JSON (`[PROBE] runs=…`, `[PROBE] snaps=…` in the run transcript).

Static-audit preamble (source, not runtime): there is **no time-based invalidation anywhere in
the ACT/PAGE_CHANGED path** — `background/index.ts` timers are load-settle fallbacks (2s) and the
`wait` action; `lifecycle.ts` has no time logic; `dom/content.ts` invalidates only on navigation
events; the only TTL (5 min, `privacy/contracts.ts LIMITS.ttlMs`) guards the model-request export,
not execution. The one plausible timer was MV3 service-worker idle termination (~30s) + `recover()`
(which deletes the observationId on restart). The investigation tested exactly this.

## 1. TEST 1 RESULTS — threshold matrix (22 runs, no model, idle page)

| Delay | Run | PAGE_CHANGED | Execution Result | Observation Version | Notes |
|-------|-----|--------------|------------------|---------------------|-------|
| 5s  | 1 | false | **ok** (click performed, navigated to page-b) | obs `7be8…` unchanged, gen 1→1 | no restart, DOM hash identical |
| 5s  | 2 | false | **ok** | obs `34ee…` unchanged, gen 5→5 | same |
| 10s | 1 | false | **ok** | obs `e1fb…` unchanged, gen 9→9 | same |
| 10s | 2 | false | **ok** | obs `c0ef…` unchanged, gen 13→13 | same |
| 15s | 1 | false | **ok** | obs `3073…` unchanged, gen 17→17 | same |
| 15s | 2 | false | **ok** | obs `e9bd…` unchanged, gen 21→21 | same |
| 20s | 1 | false | **ok** | obs `9896…` unchanged, gen 25→25 | same |
| 20s | 2 | false | **ok** | obs `aab9…` unchanged, gen 29→29 | same |
| 25s | 1 | false | **ok** | obs `a790…` unchanged, gen 33→33 | same |
| 25s | 2 | false | **ok** | obs `8095…` unchanged, gen 37→37 | same |
| 30s | 1 | false | **ok** | obs `cba7…` unchanged, gen 1→1 | no restart, DOM hash identical |
| 30s | 2 | false | **ok** | obs `3e76…` unchanged, gen 5→5 | same |
| 35s | 1 | false | **ok** | obs `5e60…` unchanged, gen 9→9 | same |
| 35s | 2 | false | **ok** | obs `1f65…` unchanged, gen 13→13 | same |
| 38s | 1 | false | **ok** | obs `b318…` unchanged, gen 17→17 | same |
| 38s | 2 | false | **ok** | obs `e9b3…` unchanged, gen 21→21 | same |
| 40s | 1 | false | **ok** | obs `2668…` unchanged, gen 1→1 | same |
| 40s | 2 | false | **ok** | obs `a888…` unchanged, gen 5→5 | same |
| 42s | 1 | false | **ok** | obs `b3c0…` unchanged, gen 9→9 | same |
| 42s | 2 | false | **ok** | obs `4ae2…` unchanged, gen 13→13 | same |
| 45s | 1 | false | **ok** | obs `b05c…` unchanged, gen 17→17 | same |
| 45s | 2 | false | **ok** | obs `7cb4…` unchanged, gen 21→21 | same |

Per-run fields recorded for every row (raw JSON in the `[PROBE] runs=` dump): URL/title before and
after the delay (identical), `document.readyState` `complete`, DOM count 80→80, interactive count
23→23, FNV DOM/interactive-structure hashes equal, scroll 0/0, viewport 876×840, service-worker
restart monitor (negative in all 22), console errors (only benign TensorFlow/"Estimating
resolution" noise), navigation events during delay: **none** (the recorded `framenavigated` entries
are the deliberate reload before each capture; `postActNav=1` after a successful ACT).

Every successful ACT also proves end-to-end liveness: the click navigated to `page-b.html`
(`postActNav=1`), i.e. the executor really touched the page, not just returned `ok`.

## 2. TEST 1 THRESHOLD

**No threshold exists.** Earliest delay where PAGE_CHANGED appears: **never** — out to 45 s, twice
per delay, executions succeeded. Failures: none, intermittent or otherwise. Per the protocol's
own rule, this must **not** be called a timeout: the evidence demonstrates *absence* of a
time-based threshold on an idle page, including across the ~30 s MV3 idle-termination window
(the `serviceworker` restart event never fired in any run — the worker stayed alive throughout;
and even a restart would have been visible as gen+1 / `RESTARTED` / missing observationId, none
of which occurred).

## 3. TEST 2 SNAPSHOT COMPARISON (5s / 35s / 45s — T0, T1, T2)

All three triplets are structurally identical; representative numbers below.

| Snapshot | URL | Title | readyState | DOM count | Interactive | DOM hash | State (gen / observationId) | Target (CBE311) |
|----------|-----|-------|-----------|-----------|-------------|----------|------------------------------|-----------------|
| T0 (after capture) | /my-courses.html | My courses… | complete | 80 | 23 | `6f150618` | paused, gen N, obs id present | exists, link, bounds x41 y477 202.8×17 |
| T1 (before ACT) | /my-courses.html | My courses… | complete | 80 | 23 | `6f150618` | paused, gen N, **same obs id** | exists, same label, **identical bounds** |
| T2 (after ACT) | **/page-b.html** | Course detail… | complete | **11** | **0** | `11b1edd1` | paused, gen **N+2**, obs id **cleared**, error `PAGE_CHANGED`, detail cause `PAGE_CHANGED_NAVIGATION` | **does not exist** (page changed) |

Two changes observed between T0 and T1, both measured and classified:

1. **Viewport height 840 → 896** (the T1 reading; T0/T2 page snapshots at the same moments show
   840/896 variants across triplets). This is Chrome's capture debugging notice disappearing
   after FINISH_CAPTURE — a documented, whitelisted apparatus artifact, not a page change.
2. **Nothing else.** DOM hash, interactive hash, counts, URL, title, scroll, target bounds and
   node identity were byte-identical T0→T1 at every delay.

## 4. PAGE/DOM CHANGE CLASSIFICATION

- **T0 → T1 (the delay), all delays:** **D — NO MEANINGFUL CHANGE.** URL, title, DOM structure
  hash, counts, scroll, target node, target geometry all identical; the only delta is the
  capture-notice viewport height, an irrelevant apparatus artifact absorbed by the executor's
  viewport-anchored transform (the ACT succeeded with it present). No mutation events, no
  re-renders, no navigation. The observation ID did **not** change across the delay.
- **T1 → T2 (after ACT):** **A — GENUINE PAGE CHANGE** — caused by the action itself. The click
  followed the link to page-b.html; the tab navigated; the extension then correctly recorded
  `PAGE_CHANGED` with detail cause `PAGE_CHANGED_NAVIGATION` ("The tab navigated while its capture
  was active"), bumped the generation and cleared the observation id. This is the *post-success*
  bookkeeping of a *successful* action — the correct, intended behavior (category B in the prior
  audit: navigation caused by another action ⇒ old observation must become invalid).
- **Observation-only change (C):** never observed. The observation id and generation were stable
  across every idle delay; they changed only when a real navigation happened.

## 5. EVIDENCE

- Raw JSON: `[PROBE] runs=` (22 run records) and `[PROBE] snaps=` (9 snapshot records) in the
  investigation transcript; reproducible with the commands above.
- 22/22 ACTs succeeded; each success navigated to page-b (urlBefore ≠ urlAfter, `postActNav=1`).
- 0/22 PAGE_CHANGED, 0/22 worker restarts, 0/22 generation bumps during delays, 0/22 DOM hash
  changes during delays.
- The **only** PAGE_CHANGED in the entire investigation appeared at T2, after a successful click
  navigated the page — with a structured detail cause of `PAGE_CHANGED_NAVIGATION`.
- Static-audit cross-reference: no time-based invalidation exists in the ACT path
  (`background/index.ts`, `agent/lifecycle.ts`, `dom/content.ts`, `dom/act.ts` — inspected this
  round); the sole TTL is on the model-request export path (`privacy/contracts.ts LIMITS.ttlMs`
  = 300 s), which was not exercised because no model call was made.

## 6. CONCLUSION

- **Does PAGE_CHANGED occur without model inference?** No. With no model call and an idle page,
  zero PAGE_CHANGED occurred across 22 runs spanning 5–45 s. The prior hypothesis (MV3 worker
  idle-termination + `recover()` producing a stale-token PAGE_CHANGED) did not materialize — no
  restart was ever observed.
- **At approximately what delay does it begin?** Never, within the tested range. There is no
  time-based threshold on the execution path.
- **Does the DOM actually change during the delay?** No — byte-identical structure hashes, counts,
  URL, title and target geometry at all delays (the sole delta was Chrome's capture-notice
  viewport height, which the executor already absorbs by design).
- **Does the target element actually change?** No. The CBE311 link kept identical bounds and node
  identity T0→T1 at every delay.
- **Is the change meaningful to action execution?** The only meaningful change observed was the
  navigation *caused by the successful action itself* — and the extension handles exactly that
  correctly (invalidate the consumed observation; next round observes the new page).
- **Is the current PAGE_CHANGED detector apparently too sensitive?** On this evidence, no. On an
  idle page it never fires at all; after a real navigation it fires once, with the correct detail
  cause, as intended fail-closed bookkeeping. (This matches the prior audit's measured 100 %
  precision on an actively-mutating matrix; this investigation adds the idle-page half.)
- **Is there evidence that an architectural revalidation/reuse solution is needed?** No — not from
  these tests. If the "~35–40 s" refusals still occur in live use, they are *not* produced by an
  idle-page timer; the mechanism must be looked for in what differs between this harness and live
  use (see §7).

## 7. RECOMMENDED NEXT INVESTIGATION

1. **Instrument the live path, not the happy path.** The most informative next step: on the next
   real occurrence, capture (a) the STATUS snapshot (generation + presence of observationId +
   `state.error`/`errorDetail.cause`) and (b) the panel log timestamps *immediately before* the
   refused ACT. If `errorDetail.cause` is `PAGE_CHANGED_NAVIGATION`, the rejection is real
   navigation/tick activity (a live page's own poller), not staleness. If the ACT returns
   PAGE_CHANGED with `state.error === 'RESTARTED'`, it is worker-restart — absent here, but
   reproducible only under real Chrome memory pressure, not Playwright's Chromium.
2. **Test with the real VLM in the loop but the page idle.** The protocol forbade the model here,
   which isolates the observation lifecycle but cannot see request-path effects (e.g. the 5-minute
   export TTL, or panel-side retry loops firing during inference). A follow-up with the model on
   and the page frozen would complete the isolation matrix.
3. **Long delays beyond 45 s (60/90/120 s)** to fully rule out slower environment-specific timers
   (not expected from the source audit, but cheap to confirm).
4. **A genuinely ticking page** (the fixture's clock variants or a `setInterval` DOM poll) as a
   positive control: it should still NOT produce PAGE_CHANGED (no MutationObserver), proving the
   detector responds only to real navigations — the inverse of this investigation's result.

No production code was modified for this investigation; the only artifacts are the standalone
harness (`extension/tests/investigation/page-change-delay.spec.ts`), its dedicated config
(`extension/playwright.investigation.config.ts`), and this report.
