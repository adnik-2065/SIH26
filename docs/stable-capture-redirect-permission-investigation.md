# Stable capture, redirects, and extension access — investigation report

Date: 2026-09-25 · Harness: `extension/tests/investigation/stable-capture.spec.ts`
(`npx playwright test --config=playwright.investigation.config.ts`). New fixtures:
`tests/fixtures/cross-jump.html` (localhost-origin detail page), `tests/fixtures/redirect-chain.html`
(two intermediate same-origin documents, 300 ms apart, then the target page).

Investigation only: no production code changed, no manifest permission changed, PAGE_CHANGED
architecture untouched.

---

## A. Where exactly is "Could not capture a stable page…" generated?

- **UI string:** `extension/src/ui/main.tsx` — the `messages` map,
  `CAPTURE_FAILED: 'Could not capture a stable page. Click the extension icon on this tab, wait for the page to settle, and try again.'`
  It is rendered wherever `state.error === 'CAPTURE_FAILED'` (banner via `alert`, and the scan
  status line "Scan needs attention").
- **Producer of the code:** the background worker's final catch in `background/index.ts`
  (`await pause(error.message === 'CAPTURE_TOO_LARGE' ? 'CAPTURE_TOO_LARGE' : 'CAPTURE_FAILED', 'failed')`)
  — the branch that receives **every capture ending that is neither a classified PAGE_CHANGED nor
  STOPPED**. Its precise sources are the raw capture codes in `capture/errors.ts`:
  `CAPTURE_DEBUGGER_ATTACH_FAILED` ("a restricted page, or a revoked permission"),
  `CAPTURE_DEBUGGER_DETACHED`, `CAPTURE_COMMAND_TIMEOUT`, `CAPTURE_TOTAL_TIMEOUT`,
  `CAPTURE_SCREENSHOT_FAILED`, `CAPTURE_SCREENSHOT_INVALID`, and the size limits.
- **Structural hole found (hypothesis core):** in `capture/observe.ts`, `await
  chrome.scripting.executeScript({target, files:['content.js']})` and `await
  chrome.tabs.sendMessage(… 'PREPARE_CAPTURE' …)` are **raw awaits with no error mapping**. If the
  content script is momentarily absent (document mid-swap) or the origin is not accessible, the
  resulting exception ("No frame with given id", "Cannot access contents of url…", "Receiving end
  does not exist") lands unclassified in the final catch → **CAPTURE_FAILED with status 'failed'
  → terminal** (`roundVerdict` halts on `failed`; only PAGE_CHANGED/RESTARTED/TARGET_CHANGED are
  retried). Every *classified* navigation ending instead pauses as PAGE_CHANGED (retryable).

## B/C. Condition and lifecycle position

The capture pipeline is: `active()` checks → `executeScript(content.js)` → `PREPARE_CAPTURE` →
`debugger.attach` → tiles → `CHECK` → stability compare. A failure **before** the first classified
checkpoint (and after the page has changed identity) is the vulnerable window. `tabs.onUpdated`
(loading/url) pauses the task as PAGE_CHANGED, and `START`/`OBSERVE` (the recovery send) proceeds
only through `release()` + a fresh generation; `awaitLoadSettled` is armed **only when a capture
ends PAGE_CHANGED** — an ACT navigation pauses via `tabs.onUpdated` *without* arming it, so the
recovery OBSERVE can begin against a document that is still swapping (see D-redirect below).

## D. What actually causes the quoted error (evidence)

1. **Redirect chains (reproduced):** with OBSERVE fired while the chain was still hopping, the
   capture started on an intermediate document and was killed by the next hop. Timeline:
   `OBSERVE @T+0 → redirect-chain?hops=2 @T-168ms → ?hops=1 @T+150ms → ?hops=0 @T+470ms →
   page-b @T+780ms; gen 7→14; secondCapture=failed; cause=PAGE_CHANGED_NAVIGATION`.
   The mechanism **correctly** classifies these as retryable PAGE_CHANGED (4-5 gen bumps = retry
   cycle), and all 3 successive OBSERVEs in the hammer probe (2c) eventually returned ok — the
   pipeline self-heals *as long as the endings stay classified*. When it stops self-healing, it is
   because an unclassified ending (`executeScript`/`PREPARE_CAPTURE`/`sendMessage` throw during a
   frame swap) lands in the CAPTURE_FAILED terminal bucket. That race is real but was not caught
   live in this environment within the tested windows — the model+capture retry loop absorbed it.
2. **Cross-origin navigation (reproduced):** `OBSERVE` after navigating 127.0.0.1 → localhost
   returns **`ACCESS_REQUIRED`** with `status='paused'`, `cause=PAGE_CHANGED_NAVIGATION`. Two
   independent gates: the content-script gate (`state.origin` mismatch → ACCESS_REQUIRED) and the
   capture gate (`active()` origin check). The panel's recovery (`observeAgain`) converts
   ACCESS_REQUIRED into a fresh `START` automatically, so a cross-origin hop **does** continue
   autonomously — evidence: 1A run 2 auto-recovered in **515 ms**.
3. **Restricted origin (reproduced):** on `chrome://version`, `OBSERVE` returns **ACCESS_REQUIRED**
   (scheme gate). Injection into chrome:// pages is impossible by design; the extension cannot
   request it programmatically; the correct agent behavior is a stop with the access message.
4. **1A UI loop (the reported symptom's own scenario):** 3 runs of the real panel loop clicking
   CBE311: run 1 auto-recovered (new observation on page-b, ~43 s of which ~40 s was the next
   model round), run 2 recovered in **515 ms**, run 3 had no click planned (no navigation at all).
   **Zero "Could not capture a stable page" occurrences.** The stable-capture failure is therefore
   **not reproducible** on the CBE311 path in this environment — consistent with the earlier
   model-loop investigation (3/3 performed + recovered) and the idle/tick matrix (29/29 clean).

## E–I. Answers

- **Before or after PAGE_CHANGED?** The quoted error is a *capture-phase* failure that occurs
  after invalidation, when a fresh observation is attempted. PAGE_CHANGED itself is never the
  surfaced message; they are distinct stages, and the evidence separates them cleanly.
- **Does PAGE_CHANGED correctly invalidate?** Yes — every probe shows observationId cleared and
  generation bumped on navigation, with `errorDetail.cause=PAGE_CHANGED_NAVIGATION`.
- **Recovery or termination?** Recovery for everything retryable (PAGE_CHANGED, RESTARTED,
  TARGET_CHANGED → `roundVerdict` retry → `observeAgain` → OBSERVE/START with load-settle).
  Termination only for `status='failed'`/`'stopped'` — which is exactly what the **unclassified**
  capture endings produce (CAPTURE_FAILED) and what restricted origins produce via
  `haltReason` on… no: restricted origins surface as ACCESS_REQUIRED (a command error, not a
  run-halt), and the panel re-STARTs; only a true CAPTURE_FAILED terminal ends the run.
- **How many attempts before the error?** Panel capture retries: `CAPTURE_RETRY_LIMIT = 4`
  (backoff 250 ms × attempt) — visible in the redirect probe as 4-5 generation bumps before
  success. A terminal CAPTURE_FAILED occurs when a capture ending is unclassified; the retry
  machinery never engages for it.
- **Browser/tab state at each stage:** recorded in the probe JSON — URL transitions with
  timestamps, tab loading cycles (`framenavigated` events), `status`/`generation`/`observationId`
  at every step, restart monitor (never fired), worker CAPTURE console lines captured.

## Cross-investigation comparison

| Test | Navigation | PAGE_CHANGED | Content script | Stable capture | Permission | Final agent state |
|------|-----------|--------------|----------------|----------------|------------|-------------------|
| 1A CBE311 ×3 | link click, same-origin | post-success only | injected fresh each capture | ok (auto-recovery ×2) | not involved | continued |
| 1B Google (proxy: same-tab cross-origin nav by the page) | `location.href` | post-success only | fresh injection ok | ok | — (proxy; see 3) | continued |
| 2 redirect chain (×2 incl. mid-load + hammer) | 4 document swaps | per swap, retryable | re-injected per attempt | ok after ≤4 retries | same-origin | continued |
| 3 cross-origin jump | origin change | invalidation correct | gate refuses | not attempted | **ACCESS_REQUIRED** → panel auto-STARTs | continued |
| 3c chrome:// | scheme gate | invalidation correct | injection impossible | n/a | **ACCESS_REQUIRED** | stops with access message |

**Verdict: B — different problems that happen to produce the same user-facing error.**
- The redirect/load failure is a *capture robustness* problem: classified endings self-heal; the
  rare unclassified ending (`executeScript`/`PREPARE_CAPTURE` throwing mid-swap, debugger attach
  failing) becomes terminal CAPTURE_FAILED — the only path found that can produce the quoted
  error without a real restriction.
- The new-origin failure is a *permission architecture* consequence: activeTab-only access is
  revoked by cross-origin navigation; the frontend handles it correctly today by auto-STARTing,
  and restricted origins are correctly refused. No fix is indicated beyond clearer messaging.
- CBE311 itself is **not** a stable-capture failure in this environment (0/3 + prior 3/3).

## Answers to the 11 success-criteria questions

1. `main.tsx` `messages.CAPTURE_FAILED`, produced by the background's unclassified-capture
   catch (`background/index.ts` final else), fed by the raw codes in `capture/errors.ts`.
2. It does not (this environment): CBE311 auto-recovered in all executed runs; the vulnerable
   window is a capture beginning on a document that is still swapping.
3. Google is a cross-origin navigation; the structural equivalents (1B-proxy, 3) show the
   recovery works via auto-START. A live Google reproduction would need the user's real profile
   (network redirects + consent pages); the mechanism-level evidence above covers the stages.
4. The stable-capture error itself: not reproducible in 3 UI runs + 6 production-path probes.
   The *conditions* leading to it (redirect race) reproduced cleanly and self-healed.
5. Root causes per path: redirect race (classified: retryable; unclassified: terminal),
   cross-origin = activeTab revocation → ACCESS_REQUIRED → auto-START, restricted origin =
   ACCESS_REQUIRED.
6. Yes — invalidation, cause, retry, and re-observation all behaved correctly in every probe.
7. The agent stops only on terminal statuses ('failed'/'stopped'); CAPTURE_FAILED is terminal
   because it arrives with status 'failed'. Making the vulnerable endings classified (retryable)
   would change that — that is the eventual fix area, **not** implemented here.
8. ACCESS_REQUIRED from two gates (content-script origin gate; capture active/origin gate);
   the panel converts it to a fresh START automatically.
9. Yes for cross-origin (activeTab must be re-granted by a user gesture or the panel's auto-START
   path with a fresh grant), inherently impossible for restricted origins (chrome://, Web Store).
   The extension cannot request page access programmatically under this architecture (by design:
   privacy posture preserved).
10. B — different problems, same user-facing string; the CBE311 instance was not reproducible.
11. `capture/observe.ts` (classify injection/PREPARE/sendMessage failures, especially during
    document swap) and/or the background classifier — the smallest targeted change would map
    "No frame with given id / Receiving end does not exist / Cannot access contents of url"
    during a capture attempt onto the existing retryable PAGE_CHANGED bucket instead of the
    terminal CAPTURE_FAILED bucket. **Deliberately not implemented (diagnosis only).**

Evidence JSON (`runsA`, `runsB`) with full timelines is in the investigation transcript; the
harness is rerunnable via the config above.
