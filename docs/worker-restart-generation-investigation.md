# Worker RESTARTED / Generation Invalidation During Long Agent Calls

Investigation report — protocol: `SIH26 Worker Restart / Generation Investigation Prompt` (16 sections).
Date: 2026-09-25. Environment: Chromium (Playwright `chromium` channel, headless), fixtures `127.0.0.1:4173`, git `8f9ccea` + the uncommitted reliability round in the working tree.

**Stated limitation: the Cloudflare tunnel was DOWN (curl exit 000) for this entire investigation, so no real-model run was possible. Every think window below is simulated** — either by pure elapsed time (Tests A–E) or by a local delayed `/agent` endpoint holding the request open 50 s with a valid production-wire reply (Test F). Prior rounds measured real-model latency at 40.1–41.4 s, so 50 s bounds the reported window.

Harnesses (evidence-only, run explicitly):
- `extension/tests/investigation/worker-restart.spec.ts` — Tests A/B/E/D, `npx playwright test --config=playwright.investigation.config.ts -g "A:|B:|E:|D:"`.
- `extension/tests/investigation/worker-restart-ui-loop.spec.ts` — Test F, real panel UI loop against a simulated model.

---

## 1. Exact root cause of the RESTARTED event

**RESTARTED has exactly one production producer: service-worker cold start.** `recover()` (`extension/src/agent/lifecycle.ts:20`) — the only code path emitting `RESTARTED` — runs at the top of the worker's `ready` IIFE (`background/index.ts`) whenever a *persisted* task is found in `chrome.storage.session` with status `observing` or `paused`:

```
worker cold start
  → recover(saved)
  → invalidate(state, 'paused', 'RESTARTED')   // lifecycle.ts:9
      generation := generation + 1
      delete observationId
  → persist()  → publish STATE
```

The worker does not restart while the page navigates or while the debugger is attached. It restarts because **MV3 terminates an idle service worker (~30 s without events), and during a long agent request the worker receives zero events**: the agent request runs **in the panel** (`requestStep` in `transport.ts` fetches from the panel context via `PrivacyReview → AgentSteps`), so between `fetch started` and the reply the only thing that would keep the worker alive is an external message — and the production loop sends none. When the reply arrives and `perform()` posts `ACT`, an already-terminated worker cold-starts first, `recover()` invalidates the still-persisted paused task, and the panel's `applyState` aborts the in-flight request.

## 2. Exact source/call chain

Statically traced and **live-reproduced (Test D, §4)**:

```
panel: AgentSteps.ask() → requestStep() fetch (PANEL context, 40–50 s)
       worker: receives no events → MV3 idle termination kills the worker
       storage.session survives (paused task, generation N, observationId X)
model reply arrives → perform() → chrome.runtime.sendMessage({type:'ACT', observationId: X})
  → wakes a FRESH service worker
  → ready IIFE (background/index.ts) → recover(persisted paused task)
      → invalidate(): generation N+1, observationId DELETED, error 'RESTARTED'
  → persist() → publish STATE
panel: applyState(next) sees generation/observationId change (main.tsx)
  → clearDetections('task_replaced', `the worker published generation ${N+1} after RESTARTED`)
  → abortWith(controllerRef, 'task_replaced', …)        ← the exact user console line
executor ACT reaches the worker gate (background/index.ts ACT branch):
  status === 'paused' but command.observationId (X) !== state.observationId (undefined)
  → { ok: false, error: 'PAGE_CHANGED', state }
panel: perform() logs "Refused: <action> — PAGE_CHANGED"
```

Callers of `invalidate()` through `pause()` (navigation/STOP/tab events) and `START/OBSERVE` also bump the generation, but none of them produces `RESTARTED`; the string exists only in `recover()`.

## 3. Debugger popup: causal, correlated, or unrelated?

**Correlated, not causal.** Evidence:

- The debugger is attached only inside a capture (`observe.ts` attach at :165, detach in `finally` at :294, `onDetach` handler at :134). Every attach/detach in the harness timelines brackets a capture and produces **zero generation changes**: generation moves only at OBSERVE (a new capture, legitimately) and at invalidations.
- In Test D the full RESTARTED → task_replaced → PAGE_CHANGED chain was reproduced with **no debugger session active at all** (previous capture detached long before; popup long gone).
- The popup appears when the capture attaches and disappears when it detaches — i.e. it tracks *capture* lifecycle, which ends *before* the agent request starts. The worker restart happens *during* the request, ~40 s after the popup vanished. The user-observed ordering (popup disappears → later refusal) is exactly this correlation; the ~40 s gap in between is the idle-termination window.
- Tests A/B show the popup lifecycle alone (attach, capture, detach) never bumps the generation.

## 4. Generation timeline from a failing run (Test D — live reproduction)

```
t (UTC)              event
04:39:01.427  panel_task_replaced status="observing" generation=13 taskId=02fe82c7 observationId=d9dda40d   (capture launched)
04:39:02.791  D-before: gen=13 status=paused obs=d9dda40d err=none                       ← observation ready, model "thinking"
04:39:02.794  terminate: Target.closeTarget(service worker 05EE4222…)                    ← forced MV3-style termination
04:39:03.100  panel_task_replaced status="paused" generation=14 error="RESTARTED"        ← cold start → recover() → invalidate
04:39:03.167  [AGENT][no-run][ABORT] source=task_replaced reason="the worker published generation 14 after RESTARTED"
04:39:03.184  STATUS reply: gen=14 status=paused obs=none err=RESTARTED latencyMs=341    ← observationId deleted
04:39:03.203  ACT raw reply: {"ok":false,"error":"PAGE_CHANGED","state":{…,"generation":14,"error":"RESTARTED"}}
```

This is the user's report, byte for byte: `source=task_replaced`, `reason="the worker published generation 14 after RESTARTED"`, `Refused: … — PAGE_CHANGED`. Note the ACT gate refusal carries the worker's own restarted state in the reply — proof it was refused at the gate with `observationId` deleted, not by a dead worker.

## 5. Observation lifecycle timeline

| Stage | generation | status | observationId | error |
|---|---|---|---|---|
| START scan | N+1 (e.g. 13) | observing → paused | X (e.g. d9dda40d…) | — |
| panel: agent request in flight (40–50 s, zero worker messages) | N+1 | paused | X | — |
| *(failing path)* worker terminated + ACT wakes it | N+2 (14) | paused | **deleted** | RESTARTED |
| panel: task_replaced abort of the in-flight request | — | — | — | — |
| executor gate: `command.observationId !== state.observationId` | — | — | — | **PAGE_CHANGED** |
| *(healthy path, Test F)* reply arrives, worker alive | N+1 | paused | X | — → click performs |

## 6. Why the current PAGE_CHANGED refusal occurs

The ACT gate in the worker (`background/index.ts`) accepts an action only when `status === 'paused'` **and** `command.observationId === state.observationId`. After a cold-start `recover()`, the observation id is deliberately deleted, so any in-flight action whose plan was built on observation X can never match — it refuses `PAGE_CHANGED` even though the page itself never changed. The panel independently aborts its own in-flight agent request when the STATE publish shows a new generation (`task_replaced`), so a run that is mid-think is interrupted before its action can even be attempted.

## 7. Is the stale-observation protection behaving correctly?

**Yes — and it must not be weakened.** The protection is doing exactly what it is designed to do: an observation that cannot be proven current is refused. The defect is not the protection but the *cause* of the invalidation: a worker lifecycle event that has nothing to do with the page. The invariant "same page + same observation + no meaningful document change must NOT become PAGE_CHANGED merely because of an internal worker/capture lifecycle event" was being violated **by the worker's own death**, and the fix below removes that trigger without touching any check.

## 8. Minimal fix (evidence-gated, implemented)

**MV3 keepalive during active runs — panel-side, 20 s heartbeat (`extension/src/ui/main.tsx`).** While a run is active (`taskRunning`), the panel sends one `STATUS` round-trip every 20 s (each event resets Chrome's 5-minute worker idle window; 20 s is far inside it and adds no perceptible load), lifecycle-logged as `panel_keepalive_beat` and self-terminating when the run goes inactive. This closes the only zero-message window: the one the panel itself creates by running the agent request locally.

- Why the panel: the request runs there; the worker cannot keep itself alive while it is idle, and adding worker-side timers would be exactly the kind of work-arounds MV3 forbids.
- What it does **not** do: no manifest change, no tolerance change, no removal of chrome.debugger, no weakening of PAGE_CHANGED/TARGET_CHANGED/stale checks, no ignoring of RESTARTED (it still fires on genuine cold starts, e.g. browser restart), no arbitrary sleeps. A real navigation during inference still pauses the task normally (Test E re-verified after the fix).

## 9. Files changed

| File | Change |
|---|---|
| `extension/src/ui/main.tsx` | the keepalive effect; `panel_task_replaced` + `panel_keepalive_beat` lifecycle logs |
| `extension/src/agent/lifecycle.ts` | `lifecycleLog()` / `lifecycleStateLog()` helpers (timestamped, structure-only, same `[AGENT]`-style console convention; no debug flag exists in this codebase) |
| `extension/src/background/index.ts` | logs: `worker_cold_start_recover`/`_timing`, `generation_invalidate`, `generation_observe`, `observation_launched`, `act_gate_refuse`, `tabs_onUpdated`, `tabs_onActivated` |
| `extension/src/capture/observe.ts` | logs: `debugger_attached`, `debugger_detach`, `debugger_onDetach`, `debugger_attach_failed` |
| `extension/scripts/fixtures.mjs` | investigation-only delayed `/agent` route (simulated model; never used by the suite or production) |
| `extension/tests/investigation/worker-restart.spec.ts` | **new** — Tests A/B/E/D |
| `extension/tests/investigation/worker-restart-ui-loop.spec.ts` | **new** — Test F |

## 10. Tests added/changed

- **Test A — no-model-delay baseline**: OBSERVE → immediate ACT performs; no RESTARTED, no generation change from the action itself. *(A successful click navigates the fixture, which legitimately bumps the generation afterwards through the navigation pause path — documented, not a restart.)*
- **Test B — long in-flight window (50 s, zero worker messages), then ACT**: **no restart occurred** — same worker target id throughout, STATUS latency 3–10 ms (no wake spike), generation stable, ACT performed. Elapsed model time alone does not restart the worker **in this environment**; see §12.
- **Test E — navigation during the window**: legitimate `PAGE_CHANGED` refusal of the stale action, generation invalidated through `pause()` (navigation), **no** RESTARTED. Confirms category-A protection is intact.
- **Test D — forced worker termination mid-request** (browser-level CDP `Target.closeTarget`, preserving `storage.session` — the MV3-termination semantics): reproduced the **entire reported chain live** (§4 timeline): RESTARTED, gen N→N+1, observationId deleted, exact `task_replaced` abort line, ACT refused `PAGE_CHANGED` at the gate with the restarted worker state in the reply.
- **Test F — real UI loop with a 50 s simulated model** (post-fix): full shipped-panel loop; keepalive beats at +20 s/+40 s during `WAITING_RESPONSE`; reply validated (`steps=1 rejected=0`); **`Performed: Click …_e1`**; zero RESTARTED; zero task_replaced aborts during the think window.

## 11. Classification of every observed restart (protocol §11)

| Restart observed | Category | Source |
|---|---|---|
| Test B (50 s idle, no messages) — **none occurred** | — | environment keeps the worker alive (see §12) |
| Test D (forced SW termination) | **D/G** — internal worker lifecycle | cold-start `recover()`; not page-caused |
| Every navigation in A/B/E/F | **A** — legitimate | `pause('PAGE_CHANGED')` via `tabs.onUpdated` |
| OBSERVE commands between rounds | **B** — explicit re-observe | `generation_observe` log |
| Debugger attach/detach events | **E** — none: **zero restarts or generation changes** traced to debugger lifecycle | popup correlated only |

## 12. Remaining uncertainty

1. **Live MV3 idle termination was never observed in this harness.** Test B held a real worker idle for 50 s with no messages and it survived (Playwright's automation context evidently keeps extension workers alive; 22 idle runs in prior rounds plus 25 here saw zero spontaneous restarts). Consequently Test F cannot demonstrate a *prevented* restart here — it proves the fix's heartbeat fires during the exact window and that the loop is healthy. The failure mode itself is proven by Test D's forced termination, which exercises the identical code path (cold start + surviving `storage.session`). Production users on normal Chrome profiles remain the place where the spontaneous variant should be confirmed via the new `worker_cold_start_recover` log.
2. **The real tunnel was down all session**, so the 39–41 s real-model shape was simulated (50 s bounded it). If the real backend also streams or chunks differently, only the latency matters here — the worker sees the same silence either way.
3. If restarts persist in production despite the keepalive (e.g. panel closed via `pagehide` kills the heartbeat mid-run — the panel is the request's host anyway, so a closed panel kills the request too), the `worker_cold_start_*` logs now make the trigger visible per run.
4. The worker-side `act_gate_refuse` / `worker_cold_start_*` lines log to the service-worker console, which this harness cannot capture; the worker's side of Test D is proven via the refusal reply's embedded state instead.

## 13. Secondary factors (confirmed not causal)

Geometry/center-anchored transform, screenshot dimensions, OCR, model quality, the `odml.pa.googleapis.com` CSP warning, and Cloudflare latency all remain **non-causal** for this refusal: the agent request itself succeeded (HTTP 200, valid runnable plan) in every case, and no refusal occurred before the generation bump.

## 14. Regression verification (§15 checklist + gates)

- Real navigation → PAGE_CHANGED: **Test E ✅** (re-run post-fix ✅)
- Reload/cold-start still invalidates stale observations: **Test D ✅** (RESTARTED still fires and must fire)
- SPA/hash change, stale/double action → PAGE_CHANGED: `page-change-taxonomy` **26/26 ✅**, `act-roundtrip` + `agent-loop` + `observe-act-regressions` **23/23 ✅**, `capture-retry-navigation` + `page-change-observation` **3/3 ✅**, `execute.spec` **11/11 ✅**
- User cancellation / new OBSERVE replaces old observation: covered by the above suites ✅
- Long model latency alone does not cause restart: **Tests B & F ✅**
- Debugger popup appearance/disappearance does not falsely invalidate: **Test A/B timelines ✅** (zero generation changes at attach/detach)
- Genuine geometry drift → TARGET_CHANGED: taxonomy suite ✅ (TOLERANCE unchanged at 4)
- `npx tsc --noEmit` ✅ · `npm run build` ✅ (manifest regenerated for `src/backend.json`; investigation builds with `VITE_AGENT_BASE_URL=http://127.0.0.1:4173` must rebuild without it before committing — the config unit tests catch it) · `npx vitest run` **379/379 ✅**

## 15. Answer to the protocol's key question

> "Why does the worker publish a new generation after RESTARTED while the agent is still thinking, even though the page did not intentionally navigate?"

Because the worker **died and came back**. The agent request runs in the panel, so while the model thinks for ~40 s the service worker receives no events and MV3 terminates it; when the reply arrives and the executor posts ACT, the freshly cold-started worker finds the previous task persisted in `chrome.storage.session`, runs `recover()`, and publishes generation N+1 with the observation id deleted and error `RESTARTED`. The panel then aborts the in-flight request (`task_replaced`) and the worker's ACT gate refuses the action `PAGE_CHANGED` — all without the page changing at all. The debugger popup only marks the capture that preceded the request; it is correlated, never causal. The fix keeps the worker alive through exactly that window with a panel-side heartbeat and leaves every stale-observation protection untouched.
