# PAGE_CHANGED delay investigation — Tests 3 & 4 (evidence report)

Date: 2026-09-24 · Harness: `extension/tests/investigation/model-loop-tick.spec.ts`
(`npx playwright test --config=playwright.investigation.config.ts -g "model run N"` / `-g "4A|4B"`).
New fixture: `tests/fixtures/ticking.html` (stable target link + isolated counter ticking every
1000 ms; no other dynamics).

Constraints honoured: no production code modified; no PAGE_CHANGED logic touched; the request was
built and sent by the shipped production panel (`requestStep` → full redacted Page Info + masked
screenshot flow, `toAgentBody` wire format, unchanged prompts/configuration); the page was never
touched during inference; the target and page are identical to Tests 1–2. The dist build already
targets the protocol endpoint (`src/backend.json` = the trycloudflare URL, with the build-generated
manifest `connect-src` + `host_permissions` matching), so the real endpoint was used with **zero
configuration changes**.

---

## 1. TEST 3 — MODEL LOOP (real Qwen/Gemma pipeline via the production panel, page frozen)

The harness types the instruction into the real panel UI and presses Run; the panel's auto-run
performs START → capture → local OCR/face/document detection → privacy export → `requestStep` to
the real tunnel → and the panel itself executes the planned step through the production executor.
TM0/TM1 come from the transport's own stage logs (`fetch started`, `transport completed
totalMs=…`); the ACT verdict comes from the panel run log.

| Run | TM0 (request) | TM1 (reply) | modelMs | Planned step | ACT result | PAGE_CHANGED before ACT | Restarts | Gen during inference |
|-----|---------------|-------------|---------|--------------|------------|-------------------------|----------|----------------------|
| 1 | 19:23:42.946 | 19:24:23.281 | **40 336** | Click CBE311 (`…_e11`) | **Performed** at 19:24:23.318 (+37 ms) — navigated to page-b | none | 0 | 0→0 (stable) |
| 2 | 19:28:00.591 | 19:28:40.744 | **40 129** | Click CBE311 (`…_e11`) | **Performed** at 19:28:40.796 (+52 ms) — navigated to page-b | none | 0 | 0→0 (stable) |
| 3 | 19:29:07.211 | 19:29:48.521 | **41 313** | Click CBE311 (`…_e11`) | **Performed** at 19:29:48.545 (+24 ms) — navigated to page-b | none | 0 | 0→0 (stable) |

Raw evidence preserved: `runs3` JSON in the transcript, including the complete `[AGENT]` stage
trail per run (request initialized elements=23 imageAttached=true → payload serialized 142 680
bytes → fetch started → response received status=200 → reply unwrapped keys=[thought,output] →
response validated steps=1 → transport completed), plus `markers`, page errors (none), navigation
events (only the deliberate reload before each run and the ACT's own navigation to page-b), and
the service-worker restart monitor (never fired).

Exact state transitions: `generation` stable across the whole 40 s inference window in all three
runs; `observationId` present and unchanged; `state.error` undefined at T1 in run 1 and, in runs
2–3, only set **after** the successful click (the executor's own post-navigation
`PAGE_CHANGED_NAVIGATION` bookkeeping — identical to Tests 1–2). `errorDetail.cause` was never a
pre-ACT invalidation cause; no RESTARTED state occurred (`state.error === 'RESTARTED'` never
observed); no tabs.onUpdated/loading events during inference; no observation superseded; no
timeout/abort events (every request completed with status 200 within the 120 s ceiling).

**TEST 3 CLASSIFICATION: T3-A.** All three runs: model inference ran ~40–41.4 s on a frozen page,
the observation remained valid the entire time, and the ACT executed successfully within
24–52 ms of the reply. This exactly reproduces the reported "35–40+ s" window **without any
refusal** — the strongest possible isolation result.

## 2. TEST 4 — TICKING PAGE (positive control, counter tick interval = 1000 ms)

Fixture: `ticking.html` — stable `<a id="cbe311">CBE311 Database Security</a>` target plus an
isolated `counter`/`tick-stamp` pair updated by `setInterval(…, 1000)`. No navigation, no worker
restart, no user interaction.

**4A — observe without executing (×2):** captured T0, waited for ≥3 ticks (observed exactly 3),
re-read state. Counter advanced `counter: 0 → counter: 3`; DOM/interactive-structure hashes
remained identical (the digest deliberately excludes text content, so the hash proves structure
stability while the counter text churned); generation unchanged (1→1, 4→4); observation id
present and unchanged; `state.error` none; no navigation events.

**4B — execute after ≥3 ticks (×2):** same capture flow, waited for 3 ticks, then ACT
`click …_e1`. Result: **ok** both times — the click performed and navigated to page-b. Post-ACT
state showed gen +2 and `errorDetail.cause = PAGE_CHANGED_NAVIGATION`, which is again the
executor's bookkeeping for the click's own successful navigation, not a tick-driven refusal.

**TEST 4 CLASSIFICATION: T4-B.** Ticking DOM mutations are real, visible, and continued for the
whole wait — and the observation remained valid and actionable. This is the documented,
deliberate design: irrelevant DOM mutations do not retire an observation (the MutationObserver
was removed for exactly this reason). T4-B is explicitly "not automatically a bug" per the
protocol; the evidence shows it is the intended behavior. Note the mechanism is not "blind": the
same executor refuses on genuine target-level changes (detached/moved/covered — the TARGET_CHANGED
matrix), and the capture-time stability compare still catches reviewed-control disappearance.

## 3. COMPARISON

| Condition | Window | Runs | Observation state before ACT | ACT result |
|-----------|--------|------|------------------------------|------------|
| Idle page, no model (Tests 1–2) | 5–45 s | 22 | valid, gen stable | **22/22 ok** |
| **Real model loop, frozen page (Test 3)** | **40.1–41.4 s** | 3 | valid, gen stable | **3/3 Performed** |
| Ticking page (Test 4) | 3 ticks / ~3 s | 4 | valid, gen stable | 2/2 ok (+2 observe-only, no invalidation) |

The 40-second model latency and 40 seconds of idle time produce the same result: a valid
observation and a successful action. PAGE_CHANGED never preceded an ACT in any condition. Every
PAGE_CHANGED observed across all 29 runs of the whole investigation (22 idle + 3 model + 4
ticking) occurred **after** a successful action's own navigation, with the structured cause
`PAGE_CHANGED_NAVIGATION`.

## 4. ROOT-CAUSE CLASSIFICATION

Strongest evidence-supported category: **neither latency, nor the model-request lifecycle, nor
DOM mutation, nor worker restart, nor detector sensitivity produces a pre-ACT PAGE_CHANGED.**
Across every condition tested — including the exact reported 35–40 s inference window with the
real production endpoint — the observation stayed valid and the action executed.

Therefore, if `Refused: … — PAGE_CHANGED` still appears in live use, it is caused by something
outside every controlled condition here. The evidence now eliminates: elapsed time, model
latency, request lifecycle events, ticking/irrelevant DOM mutations, idle pages, and MV3 worker
restarts (in this environment). What remains, ordered by plausibility: (a) a genuine
navigation/tab/origin event from the live page or user (which the detector is *supposed* to
catch — matching the prior audit's finding that such refusals are legitimate fail-closed
behavior), or (b) an environment factor present in real usage but not in this harness (a
different Chrome build's worker-lifetime policy, real network conditions on the fetch, another
tab stealing focus, extension reload mid-run).

## 5. EVIDENCE

- Test 3 raw JSON: `runs3` (3 records) with complete per-run `[AGENT]` stage trails and
  timestamps; Test 4 raw JSON: `runs4` (4 records). Both in the investigation transcript.
- Key timestamps (run 2): TM0 19:28:00.591 → TM1 19:28:40.744 (`totalMs=40155` per the
  transport's own log; wall-clock delta 40 129 ms) → ACT reply handled by 19:28:40.796 →
  navigation to page-b at 19:28:40.796+. Generation 0 throughout inference; gen 4→6 across the
  click's own navigation bookkeeping.
- All timestamps, generation transitions, DOM hashes, counter values, navigation events and
  restart counts are in the `[PROBE]` dumps; the harness is rerunnable with the commands above.

## 6. NEXT ACTION

The isolation matrix is now complete and **no defect was found in the PAGE_CHANGED mechanism**:
it ignores latency, idle time, model inference and irrelevant DOM mutations; it fires only on
real navigations (including the action's own). The smallest targeted next steps, in order:

1. **Instrument one live occurrence.** On the next real `Refused: … — PAGE_CHANGED`, read
   `state.errorDetail.cause` from STATUS at that moment. `PAGE_CHANGED_NAVIGATION` ⇒ a real
   navigation/tab event happened (correct behavior; look at what navigated — e.g. the page's own
   redirect or a background tab discard). `RESTARTED` ⇒ worker-lifetime policy of the user's
   Chrome profile (test on the affected machine; not reproducible here).
2. **If cause is navigation:** add a temporary capture-side log of `tabs.onUpdated` URLs
   (diagnostic build only) to identify which navigation races the ACT; the fix area would be
   scheduling (e.g. not acting across a known redirect), not the detector.
3. **If no live occurrence is available:** run Test 3 on the affected machine/profile, where the
   40 s inference now provably holds the observation valid — any refusal there will carry a
   structured cause that names the actual mechanism.

Diagnosis only; no fix was implemented, per protocol.
