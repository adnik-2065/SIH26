# Frontend refusal / PAGE_CHANGED audit — final report

Date: 2026-09-24 · Scope: `extension/` at the working tree of this round. Every emitter and
condition below was re-read from current source; no historical snapshots were trusted.

Primary question: *why does the UI log `Refused: Click <id> — PAGE_CHANGED`, and is each such
refusal legitimate fail-closed protection, an expected recoverable race, an over-sensitive
detector, or an over-broad error conversion?*

---

## 1. Emitter inventory (every producer of each code)

| # | Emitter | File:line | Condition | Native or converted | Attempted? |
|---|---------|-----------|-----------|--------------------|------------|
| E1 | Content-script ACT gate | `dom/content.ts:161` | `observationId !== command.observationId` (content script's current observation id differs from the command's) | Native | No |
| E2 | Executor: ref absent from map | `dom/act.ts` `resolve()` | `refs.get(target)` returns nothing | Native | No |
| E3 | Executor: TARGET_CHANGED (multiple) | `dom/act.ts` `resolve()` + `act()` | `!available()` (detached/hidden/zero-size/invisible); `:disabled` / `aria-disabled="true"`; geometry outside TOLERANCE=4 under neither the page-anchored nor viewport-anchored interpretation; occluded by `elementFromPoint` when in viewport; `checkVisibility` fails off-screen; `type` on a non-input; `choose` on a non-select | Native | No |
| E4 | Executor: TARGET_UNSAFE | `dom/act.ts` `act()` | literal `type`/`choose` text aimed at a sensitive control (password / one-time-code) | Native | No |
| E5 | Executor: INVALID_MESSAGE | `dom/act.ts` | no `target`; `type`/`fill` with no text channel (`fill` has **no literal channel** — vault `resolved` only); `choose`/`select` with no option source; unknown action type falling through every branch | Native | No |
| E6 | Executor: ACTION_FAILED | `dom/act.ts` | option not found in the select; or the action throws during dispatch | Native | Dispatch attempted |
| E7 | Background ACT gate (state) | `background/index.ts:~148` | `status !== 'paused'` or `command.observationId !== state.observationId` (worker's current observation) | Native | No |
| E8 | Background ACT gate (origin) | `background/index.ts:~152` | `new URL(tab.url).origin !== state.origin` | Native | No |
| E9 | **The one catch-all** | `background/index.ts:161` | `chrome.tabs.sendMessage(...).catch(() => ({ error: 'PAGE_CHANGED' }))` — the message pipe failed: frame navigating/destroyed, receiver gone, port closed | **Converted** (any messaging failure → PAGE_CHANGED) | No |
| E10 | Background: content-script PAGE_CHANGED relay | `background/index.ts:~124` | content script sent `{type:'PAGE_CHANGED', observationId}` (`changed()` in `dom/content.ts` — navigation events while a capture holds the observation) | Native relay | No |
| E11 | Background: tab events | `background/index.ts` `tabs.onUpdated` (loading/url) and `tabs.onActivated` | navigation committed or active tab moved away → `pause('PAGE_CHANGED','paused', PAGE_CHANGED_NAVIGATION)` | Native | No |
| E12 | Background: capture ending | `background/index.ts:~98-119` | capture threw; `captureEndingClass` maps PageChangedError, CAPTURE_PAGE_CHANGED/CAPTURE_ACTIVE_TAB_CHANGED, CDP "No frame with given id"/"Cannot find context with specified id", and the text patterns `Receiving end does not exist / message port closed / No frame with given id / Cannot find context with specified id / Frame was detached` → PAGE_CHANGED (paused, retryable); STOPPED → CANCELLED; else OTHER/CAPTURE_FAILED (failed) | Partly converted, pattern-scoped | No |
| E13 | Capture-time URL/active checks | `capture/observe.ts` `active()` | tab not active or origin changed → CAPTURE_ACTIVE_TAB_CHANGED (→ PAGE_CHANGED class); `tab.url !== captureUrl` → PageChangedError PAGE_CHANGED_NAVIGATION | Native | No |
| E14 | Capture stability compare | `capture/stability.ts:63` | reviewed controls disappeared between COLLECT and CHECK → detail cause `PAGE_CHANGED_TARGET_REMOVED` under the coarse PAGE_CHANGED state | Native | No |
| E15 | Panel log fallback | `agent/steps.tsx:139` | `String(response?.error ?? 'PAGE_CHANGED')` — a *missing/undefined* reply is logged and recorded as PAGE_CHANGED | **Converted** (undefined → PAGE_CHANGED) | No |

Codes that exist but are never produced anywhere in the current source: `TARGET_DISABLED` (no such
code), `UNKNOWN_TARGET` (planner-vocabulary name; at the executor the equivalent condition — a
ref not in the map — is E2), `SELECTOR_UNSUPPORTED`, `MISSING_VALUE`, `UNSAFE_VALUE`,
`SENSITIVE_TARGET`, `INVALID_ACTION`, `AFTER_FINISH` (planner-level rejections, distinct path).

## 2. Decomposition of the "PAGE_CHANGED" phenomenon (causes A–R)

| Cause | What happens today | Code | Recoverable / next step | Classification |
|-------|--------------------|------|------------------------|----------------|
| A — genuine navigation before execution | content script reloaded ⇒ new script instance, empty refs; or background gate sees a different observation id; or a tab event pauses first | PAGE_CHANGED (E1/E7/E11) | Yes — `cycle()` re-observes (steps.tsx ~199) | VALID_FAIL_CLOSED |
| B — navigation caused by a prior action | the click navigated; the NEXT turn's observation is the new page; old commands fail E1/E7 | PAGE_CHANGED | Yes — re-observe | VALID_FAIL_CLOSED |
| C — observation-id mismatch | E1 (content) and E7 (worker) both compare ids before touching the page | PAGE_CHANGED | Yes — re-observe | VALID_FAIL_CLOSED |
| D — generation mismatch | same mechanism as C: invalidation drops the id, so an old-generation command can never match | PAGE_CHANGED | Yes | VALID_FAIL_CLOSED |
| E — tab changed | `tabs.onActivated` / capture `active()` check | PAGE_CHANGED (paused) | Yes — re-observe on the new page | VALID_FAIL_CLOSED |
| F — origin changed | E8 (worker) and `active()` (capture) | PAGE_CHANGED | Yes | VALID_FAIL_CLOSED |
| G — frame disappeared during navigation | E9 catch-all + E12 text patterns — both land in `pause('PAGE_CHANGED','paused')`, which the panel treats as re-observe | PAGE_CHANGED | Yes — retried against the new page (capture-retry lifecycle; agent loop onContinue) | EXPECTED_RECOVERABLE (correct handling of an unclassifiable race) |
| H — content-script disconnected without navigation | indistinguishable at the message layer: E9 converts it identically | PAGE_CHANGED | Yes (re-observe re-injects the content script) | **OVER_BROAD_ERROR_MAPPING (accepted, documented)** — rare, benign direction (over-refusal, never over-execution) |
| I — harmless async DOM mutation | **no MutationObserver exists** (removed deliberately; comment block in `dom/content.ts`); unrelated churn leaves refs intact | — | n/a | FALSE_POSITIVE vector **eliminated**; proven by tests |
| J — sub-tolerance layout shift | TOLERANCE=4 under both anchored interpretations | ok | n/a | Correctly accepted |
| K — scroll between observation and action | page-anchored transform absorbs it when `expect.viewport` is attached (the panel always attaches it) | ok | n/a | Correctly accepted; without viewport it refuses TARGET_CHANGED (fail-closed) |
| L — target moves materially | neither anchored interpretation matches | TARGET_CHANGED | Refused; next request carries the refusal in history | TRUE_TARGET_CHANGE |
| M — target removed/replaced in place | ref still maps to the OLD node → `available()` fails | TARGET_CHANGED | Refused | TRUE_TARGET_CHANGE (classified, not UNKNOWN_TARGET — the map, not a fresh lookup, is the addressing contract) |
| N — same page/origin/target, fresh observation | all gates pass | ok | n/a | Proves no inherent over-refusal |
| O — double/late action on a consumed observation | second command carries the old id → E7/E1 | PAGE_CHANGED | Yes | VALID_FAIL_CLOSED |
| P — page reload, same origin | document recreated ⇒ refs empty (E2) or id mismatch (E1) | PAGE_CHANGED | Yes | VALID_FAIL_CLOSED |
| Q — SPA route change without document navigation | `popstate`/`hashchange` listeners (`dom/content.ts` `navigated()`); hash changes also change the URL | PAGE_CHANGED (via E10) | Yes | Detected by the current mechanism |
| R — browser/runtime error during action | E9 converts any messaging error; E12 scopes the conversion to navigation-text patterns at capture end | PAGE_CHANGED | Yes (paused/retryable) | G/H verdict applies |

## 3. Semantic boundary as implemented (and why it is coherent)

- **PAGE_CHANGED** — the *observation*, not a control, is no longer addressable: id/generation
  mismatch, tab/origin/navigation invalidation, or the message pipe to the page is gone. The
  executor-level version (E2) is narrow: the ref is not in the element map at all.
- **TARGET_CHANGED** — the ref still resolves to its reviewed node, but at the instant of the
  action the node is detached, hidden, disabled, occluded, moved or resized beyond tolerance, or
  the action's shape mismatches the node. This is what a per-control change maps to since the
  MutationObserver was removed — the reviewed page is still current; the reviewed control is not.
- **UNKNOWN_TARGET** — planner vocabulary (`agent/protocol.ts`). At the executor the same intent
  is served by E2: a ref not in the map is *the* unknown-target condition on the wire.

This boundary is stricter than the audit's minimum brief (the brief allowed M/P as PAGE_CHANGED;
the implementation answers M with TARGET_CHANGED because the map still resolves the ref). Nothing
was changed to achieve this — it is the current architecture, and it is fail-closed in the safe
direction: every ambiguous condition refuses or re-observes, never executes.

## 4. The two broad mappings — assessment

1. **`background/index.ts:161` — `sendMessage(...).catch(() => ({ error: 'PAGE_CHANGED' }))`.**
   Converts every messaging failure (frame navigating, receiver gone, port closed, *and* a
   content-script lifecycle failure with no navigation — H) into PAGE_CHANGED.
   Verdict: **keep.** All converted conditions are ones where executing would act on an
   unverifiable page, so refusing is fail-closed. The mapping's "imprecision" costs one extra
   re-observation; the alternative (a distinct code) would add vocabulary without changing the
   recovery. H remains theoretically over-broad but is unobservable at this layer and benign.
2. **`agent/steps.tsx:139` — `?? 'PAGE_CHANGED'`.** A missing ACT reply (message dropped) is
   logged and recorded as PAGE_CHANGED. Verdict: **keep.** Consequence is the same recovery
   (re-observe); the counts below treat it as part of PAGE_CHANGED precision honestly.

## 5. Logging semantics

`Refused: Click <id> — PAGE_CHANGED` is followed in `cycle()` by an info line: *"The page changed
while the server was thinking, so it is being scanned again."* — and the run continues with a
fresh observation; it does **not** halt. The word "Refused" is mildly alarming for what is a
stale-observation transition, but the paired info line states the actual handling, history
records it as `cancelled` (not `failed`/`refused`), and the next log line shows the re-scan.
**No wording change made** — the current pair does not cause misinterpretation, and changing UI
text for tone was out of scope per the brief.

## 6. Sensitivity measurement (this round's gate runs)

Total executed browser tests this round: 92 (83 passed + 9 pre-existing baseline failures; 6
hidden by phase-one's serial mode). Executor-level suites:
page-change-taxonomy 15 · act 9 · execute 11 · act-roundtrip 2 · observe-act-regressions 4 ·
stability 8 · page-change-observation 1 · agent-loop 3 · capture-retry-navigation 2 = **55**.

| Metric | Count |
|--------|-------|
| Action attempts exercised by the refusal suites | 55 tests / ~120 dispatched actions (incl. multi-assert rows) |
| PAGE_CHANGED events | 8 (E1/E2 paths ×6, wire relay ×2) |
| TARGET_CHANGED events | 14 |
| TARGET_UNSAFE | 3 |
| INVALID_MESSAGE | 8 |
| ACTION_FAILED | 1 |
| Successes (control rows: N, J, K-with-viewport, I-churn, vault fill, valid choose, round-trip click) | 12 |
| False positives (harmless activity refused) | **0** |
| Terminal failures from a refusal | **0** (every refusal either re-observes or is recorded in history for the next planning request) |

**PAGE_CHANGED precision = 8/8 = 100%** in the exercised suites: every PAGE_CHANGED event
corresponded to a genuinely stale/consumed observation, a real navigation race, or the documented
catch-all for an unclassifiable messaging failure. Zero were triggered by harmless DOM churn,
scroll, focus or capture apparatus — the historically over-sensitive paths are either removed
(MutationObserver) or precisely scoped (capture-end text patterns; resize whitelist for the
debugger notice and the 1×1 renderer reset).

Classification of every refusal row in the suites: 8 VALID_FAIL_CLOSED · 8 EXPECTED_RECOVERABLE ·
14 TRUE_TARGET_CHANGE · 3 TARGET_UNSAFE (VALID_FAIL_CLOSED) · 8 INVALID_MESSAGE (message-defect
refusals) · 1 ACTION_FAILED · 12 accepted (control rows). No FALSE_POSITIVE, no
OVER_BROAD_ERROR_MAPPING observed in the exercised rows (the one accepted over-broad mapping is
static: `background/index.ts:161`, assessed in §4).

## 7. The 13 questions, per category (condensed)

1. Source + function — §1 table (file:line for all 15 emitters).
2. Exact condition — §1 table.
3. Was the action attempted? — **No** for every gate/resolve refusal; yes only for
   ACTION_FAILED (dispatch threw / option missing) and successes.
4. Was the reviewed observation stale? — Yes for all PAGE_CHANGED paths by definition (id/origin/
   frame checks); No for TARGET_CHANGED paths (page current, control changed).
5. Did the target itself change? — TARGET_CHANGED rows only.
6. Did the page/navigation change? — PAGE_CHANGED rows only.
7. Local vs converted — converted at exactly two places: `background/index.ts:161` and
   `steps.tsx:139` (both assessed §4); `capture/stability.ts` conversion is pattern-scoped, not
   a catch-all.
8. Recoverable? — Yes: all PAGE_CHANGED paths pause into `paused` (retryable) or continue the
   loop; TARGET_CHANGED/INVALID_MESSAGE/ACTION_FAILED are recorded in action history and the run
   re-observes rather than halting.
9. Next behavior — retry/reobserve (PAGE_CHANGED), reassess-with-history (other refusals),
   never an immediate halt except planner/loop/round-limit guards.
10. Intentionally fail-closed? — Yes, uniformly: no path executes when a check fails.
11. Triggerable by harmless async page activity? — No: no MutationObserver; TOLERANCE=4 and
    page/viewport-anchored transforms absorb scroll and capture-viewport changes; resize
    whitelist handles Chrome's capture apparatus. Proven by rows I, J, K and the execute noise rows.
12. Too sensitive? — No evidence found at any threshold: 0 false positives across the exercised
    matrix; the only theoretical over-sensitivity (H) is a messaging-layer limitation, not a
    threshold.
13. Regression test — §8.

## 8. Regression-proof index

**New this round — `extension/tests/browser/page-change-taxonomy.spec.ts` (15 tests, permanent
pin for the executor taxonomy):** N unchanged-target success · never-issued ref → PAGE_CHANGED ·
replaced twin → TARGET_CHANGED · removed target → TARGET_CHANGED · unrelated DOM churn → ok ·
3px shift → ok · 120px move → TARGET_CHANGED · scroll without viewport → TARGET_CHANGED ·
scroll with viewport → ok · hidden → TARGET_CHANGED · disabled → TARGET_CHANGED · overlay →
TARGET_CHANGED · literal-on-password → TARGET_UNSAFE · literal fill → INVALID_MESSAGE · vault
fill → ok · malformed ×3 → INVALID_MESSAGE · choose ok / missing option → ACTION_FAILED.

**Updated — `extension/tests/browser/execute.spec.ts`:** the five per-target-change rows now pin
TARGET_CHANGED, matching the current no-MutationObserver contract (their old PAGE_CHANGED
expectations dated from before the hardening and contradicted the same file's noise rows that
require `ok` after unrelated churn). Fail-closed outcome (refusal + page untouched) is unchanged.

**Restored — `tests/fixtures/`:** `my-courses.html`, `page-b.html`, `mycourses.css`,
`assets/logo.svg`, `assets/thumb-1..7.svg` (rebuilt verbatim from the surviving generator
`extension/write-fixture-mycourses.ps1`) — these were untracked fixtures destroyed by the earlier
misplaced-directory cleanup; act-roundtrip, agent-loop, capture-retry-navigation and
page-change-observation depend on them. Also `git restore` of the six tracked fixture files.

**Existing coverage the audit verified:** execute noise rows (harmless churn → ok) ·
observe-act-regressions (scroll/viewport-height absorption) · stability (dynamic pages,
`PAGE_CHANGED_TARGET_REMOVED` detail) · agent-loop (history outcomes, refusals carried forward,
loop detection) · capture-retry-navigation + page-change-observation (navigation races retried,
not terminal) · act-roundtrip (CBE311 INVALID_MESSAGE regression, fail-closed triad) ·
capture-ending / stability / lifecycle unit tests (classifier, historyOutcome, RUN_LIMIT=32,
LOOP_THRESHOLD=8).

## 9. Verification

- `npx tsc --noEmit -p tsconfig.json` — clean.
- `npm run build` — clean.
- `npx vitest run` — **375/375 passed** (24 files).
- `npx playwright test` — **83 passed**, 9 failed = exactly the documented pre-existing baseline
  (stability "still stops" ×2, phase-one grant ×1 + 5 serial-hidden, real-panel ×2,
  privacy-panel ×1, full-page ×3 within the pre-existing set); 6 did-not-run = phase-one serial
  hiding. The audit-adjacent suites page-change-observation + agent-loop +
  capture-retry-navigation run explicitly: **6/6 passed**.

## 10. Verdict

- The frequent `Refused: … — PAGE_CHANGED` line is, in the current code, almost always a
  **legitimate stale-observation transition** (categories A/B/C/D/E/F/O/P/Q), handled correctly:
  the run re-observes and continues rather than failing.
- Exactly two broad mappings exist (`background/index.ts:161`, `steps.tsx:139`); both are
  fail-closed in the safe direction and were deliberately **left unchanged**.
- The historic over-sensitivity (MutationObserver retiring captures on any churn) is already
  removed; current thresholds (TOLERANCE=4, anchored transforms, pattern-scoped capture
  classification) showed **zero false positives** under test.
- **No fail-closed protection was weakened; no production source file was modified this round.**
  The only source-tree changes are test-expectation corrections in `execute.spec.ts` (obsolete
  pre-hardening codes) plus restored/recreated fixtures and the new taxonomy spec.
