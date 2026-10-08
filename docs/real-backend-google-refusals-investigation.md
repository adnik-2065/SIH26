# Real-backend investigation — Google stable-capture and refused actions

Date: 2026-09-25 · Harness: `extension/tests/investigation/real-backend-google-refusals.spec.ts`
(`npx playwright test --config=playwright.investigation.config.ts`). Investigation only: no
production code or manifest modified; all actions on the real pages came from the real model.

## 1. Executive summary

- **Problem A (Google stable capture): NOT reproduced** — 0 occurrences of the quoted error in
  3 real Google runs + 1 control through the full real pipeline. The exact CAPTURE_FAILED path
  therefore remains unreproduced (consistent with the previous investigation).
- **Problem B (refused actions): reproduced and root-caused on Google.** The real model's `type`
  action into google.com's searchbox was refused `TARGET_CHANGED` on **consecutive fresh
  observations** (runs A1/A2: 2 refusals each, run A3: 1 refusal, 3/3 runs affected). The cause is
  **genuine page drift**: google.com's search page moves its search box 10 px vertically within a
  minute of load (measured 367→377 over 45 s, node NOT replaced). The executor's geometry check
  (TOLERANCE = 4) correctly refuses the stale reviewed bounds. **This is correct fail-closed
  behavior against a really-moving target, not a frontend defect** — but it explains the
  "refusals repeat until the run breaks" experience on Google: the drift keeps exceeding the
  tolerance for every observation captured at a different drift phase.
- **Refusal persistence is stateless by design:** a refusal does not consume or poison the
  observation (obsKept=true, generation delta 0, identical refusal on retry), and the identical
  action with correct bounds on the *same* observation succeeds (R3=ok ×3). A genuinely fresh
  observation also recovers (F=ok ×3). Persistence comes from the *page condition* (drift),
  not from frontend state.
- **Model-grounding refusals also observed:** "Refused step #1: UNKNOWN_TARGET" (planner-level,
  `steps=0 rejected=1`) when the model proposed an id that does not exist in the current Page
  Info (page-b has no interactive elements). This halts the round until the next observation.

## 2. Environment

Chromium 153.0.8010.12 (Playwright, headless, fresh temp profile, 1280×1000, DPR 1) ·
extension build at commit `8f9ccea` (dist as built from the working tree) · backend: production
tunnel from `src/backend.json` (https://specially-tomorrow-nascar-saint.trycloudflare.com/agent),
manifest connect-src/host_permissions generated for it · fixtures server 127.0.0.1:4173 ·
two-stage model pipeline untouched · tests: google.com live + synthetic portal fixtures.

## 3. Google test results (real loop: panel → capture → detectors → model → executor)

| Run | Round 1 | Round 2 | Round 3 | End state |
|-----|---------|---------|---------|-----------|
| A1 | Refused: Type "wikipedia" into …_e7 — TARGET_CHANGED (gen 1→2, fresh obs) | Refused: Type "wikipedia" into …_e7 — TARGET_CHANGED (gen 2→3, fresh obs) | Performed: Click …_e1 (gen 3→4) → navigated to about.google | paused, PAGE_CHANGED_NAVIGATION (post-success) |
| A2 | identical shape to A1 (2 type refusals, then click performed) | | | same |
| A3 | Refused: Type …_e7 — TARGET_CHANGED | Performed: Click …_e1 | — | paused on google.com, PAGE_CHANGED_NAVIGATION (post-success) |
| A0 control (portal) | Performed: Click …_e11 (40.6 s inference) | Refused step #1: UNKNOWN_TARGET (planner; page-b has no controls) | — | halted round; observation valid |

Every run: real model decisions (transport logs show `response validated steps=N`,
`totalMs≈37–41 s`), no capture failures, no worker restarts, no RESTARTED, no mid-loop
CAPTURE_FAILED, and each successful action's own navigation produced the usual
PAGE_CHANGED_NAVIGATION bookkeeping.

## 4. Was the exact CAPTURE_FAILED reproduced?

**No.** Across 3 Google runs + control + 10 executor probes + earlier investigations, the quoted
"Could not capture a stable page…" did not occur. The vulnerable window identified previously
(unclassified `executeScript`/`PREPARE_CAPTURE` failures during a document swap) remains
**unreproduced**; Google's own post-submit transition was absorbed by the retry lifecycle every
time (post-success PAGE_CHANGED → fresh observation → next round).

## 5–6. Originating exception / code path

Not applicable (not reproduced). The static path is unchanged from the previous report:
`main.tsx messages.CAPTURE_FAILED` ← background's unclassified-capture catch ← raw
`capture/observe.ts` awaits (`executeScript`, `PREPARE_CAPTURE`) or debugger/timeout codes in
`capture/errors.ts`.

## 7–13. Refused-action results (executor probes, production ACT path)

- **B1 clicks (real model round-1 actions replayed as experiments):** R=ok; the *identical*
  action against the same (now consumed) observation correctly refuses PAGE_CHANGED.
- **B2 type (real textbox from the observation):** ok ×2 (gen 19, 22) — type into a stable
  textbox works; no systemic type refusal off Google.
- **B3/B7 first-refusal persistence (drift-bounds refusal, ×3):** R1=TARGET_CHANGED,
  R2 (identical retry)=TARGET_CHANGED, R3 (same observation, correct bounds)=**ok**,
  F (fresh observation, same logical action)=**ok**; **obsKept=true, genDelta=0** every time.
  A refusal changes NO frontend state (observation id, generation, refs, task state all intact);
  persistence is purely the persistence of the page condition that caused it.
- **B4 fresh-observation recovery:** recovers the executor whenever the page condition is gone
  (stable pages: always). On Google it does *not* guarantee recovery because each new observation
  is captured at a new drift phase — measured as consecutive refusals on fresh observations (A1/A2).
- **B5 post-navigation:** old observation after a same-document hash change → PAGE_CHANGED;
  fresh observation → ok. Correct stale-observation handling; first post-navigation action is not
  disproportionately refused when the observation is genuinely fresh.
- **B6 post-scroll:** click with pre-scroll geometry after a 200 px scroll → **ok** (the
  page-anchored transform absorbs user scroll; no coordinate-conversion refusal). The fresh leg
  was not needed — scroll does not refuse.

## 14. Model-vs-frontend classification (Part C)

| Observed refusal | Class | Evidence |
|------------------|-------|----------|
| `TARGET_CHANGED` on google `type` (×5 across A1–A3) | **Frontend fail-closed against genuine page drift** | 10 px measured drift > TOLERANCE 4; node identity stable; refusals on fresh observations; same observation + correct bounds performs (R3) |
| `Refused step #1: UNKNOWN_TARGET` (control round 2) | **Model/action-grounding** | planner-level (`steps=0 rejected=1`); proposed id absent from the new page's Page Info (page-b has no interactive elements) |
| `PAGE_CHANGED` after every successful click | Expected bookkeeping | cause=PAGE_CHANGED_NAVIGATION, observation consumed correctly |
| Executor TARGET_CHANGED/PAGE_CHANGED in probes | Correct validation | each traced to bounds/observation state at the moment of ACT |

No executor refusal was found to be wrong: every refusal traced to a real condition (drift,
consumed observation, stale bounds). The model produced structurally valid actions in all
observed rounds; its one real defect class was grounding to the *current* page's ids
(UNKNOWN_TARGET), which the panel correctly refuses and survives.

## 15. Event timelines (failures)

A1 (representative): 21:25:27 submitted → gen1 observing → 21:25:28 paused (obs 8f4459c8) →
~40 s inference → 21:26:12 `Refused: Type …_e7 — TARGET_CHANGED` → gen2 fresh obs 8600d5e9 →
~40 s → 21:26:55 `Refused: Type …_e7 — TARGET_CHANGED` → gen3 fresh obs 3df74793 → 21:27:38
`Performed: Click …_e1` → nav to about.google → PAGE_CHANGED_NAVIGATION, obs cleared.

B-G2 (drift measurement): T0 textarea[name=q] y=367 (44 interactive) → 45 s idle → T1 same node
(`sameNode=true`) y=377 → drift 10 px > 4 px tolerance.

## 16. First state transition that makes a run fail

Two distinct terminal transitions observed: (1) planner `UNKNOWN_TARGET` halts the round when the
model addresses an id that the current Page Info cannot satisfy (recovers on the next observation
if the model re-plans); (2) a terminal run failure would be `CAPTURE_FAILED` (status 'failed') —
not reached in any run here. Consecutive `TARGET_CHANGED` refusals never halt a run by themselves
(the loop re-observes each time, bounded by the round/loop limits).

## 17. Deterministic vs intermittent

- Google type refusal: **deterministic given the drift** (3/3 runs; drift reproduced on demand in
  B-G2). It is intermittent only from the user's viewpoint because it depends on capture-vs-drift
  phase timing.
- UNKNOWN_TARGET: page-dependent (only when the model plans onto an id the new page lacks) —
  reproduced on page-b, absent on richer pages.
- CAPTURE_FAILED: absent in this environment (0 reproductions across all investigations).

## 18. Minimal suspected root cause (evidence-backed only)

Problem B on Google = page drift vs a fixed 4 px geometry tolerance on fresh observations; the
refusal itself is correct and stateless. Problem A remains unreproduced; the only credible
mechanism stays the previously identified unclassified mid-swap capture ending (terminal
CAPTURE_FAILED), which Google's real flow did not trigger here.

## 19. Recommended next investigation/fix boundary

- The drift finding points at **policy, not safety**: whether the executor should widen the
  anchored-interpretation tolerance for controls whose node identity is proven stable (the node
  was NOT replaced) is a product decision; any change must keep genuine target replacement
  refused (the TARGET_CHANGED matrix must stay green).
- For the model-grounding refusal: the panel already survives it; the improvement area is
  prompt/payload side (not investigated per scope) or clearer UI copy.
- For Problem A: the unclassified-ending hypothesis remains the fix boundary
  (`capture/observe.ts` injection/PREPARE classification), still unreproduced and still not
  implemented.

## 20. Explicitly NOT proven

- That the user's original CAPTURE_FAILED was caused by Google specifically (error never
  reproduced in any environment by this investigation series).
- That google.com drifts a fixed amount on every load/viewport (one viewport/profile measured;
  drift magnitude/phase vary and were not characterized).
- That no user-visible CAPTURE_FAILED can occur on real hardware (Playwright Chromium ≠ user
  profile/real network; the live-Google runs used the real backend but the harness browser).
- Model-side behavior beyond what the transport logs show (Stage-1/Stage-2 internals are opaque
  to this harness; only validated outputs were recorded).

Evidence JSON: `runsA` (4 records with full loop event timelines), `runsB` (9 probe records), and
`agentStages` (transport trails) in the investigation transcript; harness rerunnable via the
config above.
