# Frontend autocomplete suggestions & Enter-key support — implementation report

Scope: SIH26 browser extension only (frontend). No backend.py, FastAPI, Ollama,
Stage1/Stage2 prompts, backend action normalization, or CFG-008 changes. The
backend's planned `{"action":"keypress","value":"Enter"}` step is already
accepted and translated by this frontend today.

## Files changed

| File | Change |
| --- | --- |
| `extension/src/dom/observe.ts` | Suggestion-candidate extraction (focused selector, `suggestionLabel`, shared id minting, role clamp) |
| `extension/src/dom/act.ts` | `key` action dispatch in the executor |
| `extension/src/contracts.ts` | `key` in `ActionSchema`; `key`/`keypress` in `AgentStepSchema` |
| `extension/src/agent/protocol.ts` | backend `key`/`keypress`+`"Enter"` → local `{type:'key',key:'Enter'}`; other values refused (`MISSING_VALUE`) |
| `extension/src/agent/steps.tsx` | `describe()` → "Press Enter"; key value in action history |
| `extension/src/agent/lifecycle.ts` | `actionSignature` handles `key` (loop detection) |
| `extension/src/privacy/normalize.ts` | `option` joins the exported-role allowlist (suggestions no longer collapse to `"control"`) |
| `extension/src/privacy/text.ts` | `option` joins `safeWords` (a role string can never block the payload) |
| `tests/fixtures/suggestions.html` | NEW generic autocomplete fixture (ARIA combobox + listbox + role=option rows) |
| `extension/tests/unit/suggestions.test.ts` | NEW — 14 unit tests |
| `extension/tests/browser/suggestions.spec.ts` | NEW — Tests A–G end to end |
| `extension/tests/browser/suggestions-typing.spec.ts` | NEW — fresh-observation-after-typing proof (kept as a permanent regression) |

Untouched by design: `background/index.ts` (the ACT gate validates state/observation/origin generically — key forwards like click; `wait` remains the only special case), `wire.ts` (`describePage` renders suggestion rows automatically from the element list), `content.ts`, `ui/main.tsx` (keepalive/lifecycle logging preserved), all backend files.

## Page Info extraction changes

`collect()` runs its existing base pass unchanged (same `candidates` selector,
same 200-element budget, same hiddenCount/truncated accounting), then appends
suggestion candidates from one focused selector:

```
[role="option"],[role="listbox"] > *,[aria-expanded="true"][role="combobox"] + *:not([role="listbox"])
```

## Candidate-selection logic

Exactly three arms — no arbitrary DOM noise:

1. **`role="option"`** anywhere visible — the explicit ARIA suggestion role.
2. **Visible rows of a `role="listbox"`** — its direct children are the
   actionable containers. The listbox wrapper itself is deliberately *not*
   exposed: a click belongs on a row, not on the dropdown.
3. **A non-listbox suggestion bubble hanging directly off an expanded
   combobox** — exposed at container level because it carries no option
   semantics of its own (Google's current DOM does exactly this).

Every element still passes the same `available()` gate as base candidates
(connected, non-zero box, displayed, visible, opaque, not inside
`[hidden]/[inert]/[aria-hidden="true"]`, within the document) — so a closed
dropdown contributes nothing and the pre-typing snapshot stays empty. An
element already examined by the base pass is never duplicated (`elsMap` set);
a suggestion examined but hidden is counted once in `hiddenCount`. Page roles
are echoed only when they are pipeline-safe widget vocabulary
(`option`/`listitem`); anything else reports the generic `option` rather than
leaking a site-specific attribute value. No Google-specific ids, classes or
structures anywhere — the fixture reproduces the scenario with generic ARIA.

Structural context = the standard row format (id, role, label, bounds in the
screenshot's pixel space); a suggestion's `aria-label`/`aria-labelledby`/
visible text becomes its label via `suggestionLabel()` (same 200-char
normalization as `labelFor`), which is what lets the backend match the visible
"wikipedia" row to the exact existing id instead of guessing.

## Privacy / redaction handling

Nothing bypasses the pipeline — suggestion rows *are* ordinary
`ObservedElement`s, so `normalize()` runs `sanitizeText(label,
'element_description')` on each and exports `role`/`description`/`bounds`
through the same path as every control. Two hardening fixes were required so
a suggestion can never block or degrade a payload:

- `normalize.ts`: exported roles come from a fixed allowlist; unknown roles
  collapse to `"control"`. `option` was added so the suggestion semantics
  reach the backend.
- `text.ts`: the exported role string itself is sanitized; `option` was not in
  `safeWords`, so an unsanitizable role could have thrown
  `RAW_DATA_LEAK`-class failures. It is now accepted vocabulary.

Redacted outcome (tested): text withheld to `[EMAIL_1]`/`[DOCUMENT_1]`-style
placeholders while id, role=`option`, bounds and structural row survive —
visual-to-DOM grounding works without the protected text.

## Action-executor changes

`act()` gained one early branch: `{type:'key', key:'Enter'}` dispatches
keydown → keypress → keyup (bubbling, cancelable) to `document.activeElement`,
falling back to `document.body` when nothing is focused, then returns
`{ok:true}`. It resolves no ref and skips the geometry/occlusion checks by
design — Enter does not address an element. Click/type/fill/choose/select/
scroll/wait/done are byte-for-byte unchanged, as is the ACT gate in the
background worker.

## key/keypress implementation for Enter

- No keyboard action existed; the minimal `key` action was added end to end.
- `contracts.ts`: `ActionSchema` accepts exactly `{type:'key', key:'Enter'}` —
  `z.literal('Enter')`, not an open vocabulary, so a malformed value can never
  become arbitrary synthetic input. `AgentStepSchema` now accepts
  `key`/`keypress` server steps.
- `protocol.ts`: `{"action":"keypress","value":"Enter"}` (the backend's
  spelling) *and* `{"action":"key","value":"Enter"}` translate to the local
  action; any other value (`Tab`, empty, …) is refused `MISSING_VALUE`.
  `executableNow` treats it as page-touching (one step per observation) —
  correct, since Enter can navigate.
- `background/index.ts`: no change needed; the generic ACT forward already
  carries it (validated against `ActionSchema` by `PanelCommandSchema`).
- `steps.tsx`: history rows record `action:"key", value:"Enter"`.
- `lifecycle.ts`: `actionSignature` includes the key, so repeated
  state+Enter cycles still trip LOOP_DETECTED.
- Backend-facing rules (`wire.ts`) are untouched; the problem_context
  documents the accepted action names and the backend will use `keypress`.

## Tests added/updated (Tests A–G)

All new, no existing tests modified: **unit** (`tests/unit/suggestions.test.ts`,
14 tests): single option exposure with resolvable ref; id sequence after base
ids; all listbox rows with distinct bounds; hidden option counted not
described; fresh ids per observation with no cross-scan reuse; email-labeled
suggestion redacted to a placeholder while id/role/bounds survive;
key-schema accepts only literal Enter; keypress→key translation; native `key`
spelling; non-Enter/empty keypress refused; Enter dispatch order
(keydown/keypress/keyup) to focused element; body fallback; click-by-id
regression. **Browser** (`tests/browser/suggestions.spec.ts`, Tests A–G):
(A) visible wikipedia option exposed with role/type/label/bounds while the
About link stays a separate link row; (B) three suggestions with per-row
bounds matching the live DOM; (C) redacted suggestion keeps id/role/bounds
with `mira@example.test` withheld; (D) same suggestion gets
`…0001_e5` then `…0002_e5`, only the current id resolves, the stale one
refuses `PAGE_CHANGED`; (E) exposed id clicked through the normal path
navigates to `#opened-wikipedia`; (F) Enter reaches the focused combobox
(`#submitted-query`) with type/click regressions in the same test; (G)
combobox/link/button/textbox rows unchanged and actionable.
`suggestions-typing.spec.ts` proves the fixture page exposes **zero**
options pre-typing and all four post-typing with ids minted from the current
observation, and that the exposed id clicks through.

## Validation results

- `npm run typecheck` (tsc --noEmit): **clean**
- `npx vitest run`: **393/393** (379 prior + 14 new)
- Browser: suggestions 7/7, typing 1/1, act+act-roundtrip+agent-loop+
  observe-act-regressions 18/18, page-change-taxonomy +
  page-change-observation + capture-retry-navigation + execute 31/31,
  privacy.spec + suggestions 26/26
- Production build `npm run build` (typecheck + vite): **clean**; `dist/`
  rebuilt from `src/backend.json` (tunnel URL), no VITE_AGENT_BASE_URL drift
- Known-baseline flakes observed, reproduced on committed HEAD via a
  throwaway worktree A/B (removed afterwards): `privacy-panel` fails
  identically without my changes; `stability` ×2 and `full-page` ×3 fail on
  the same variants documented pre-task. None are caused by this work.
- Incident note: an experimental baseline worktree briefly deleted the real
  `node_modules` through a junction; it was fully restored via `npm ci`
  (153 packages) and every gate above was re-run afterwards.

## Before / after — the "wikipedia" failure

Before (pre-typing search page):

```
Observation obs-1. …
Interactive elements:
- id=obs-1_e1 role=combobox label="Search" box=[…] in a 1280x800 screenshot
- id=obs-1_e2 role=link label="About" box=[…] in a 1280x800 screenshot
- id=obs-1_e3 role=button label="Go" box=[…] in a 1280x800 screenshot
```

The screenshot showed the "wikipedia" suggestion, but no candidate carried it —
the only addressable ids were the search box and unrelated links like About,
so the model clicked `obs-1_e2` and opened the wrong page.

After (type "wiki" → fresh observation):

```
Observation obs-2. …
Interactive elements:
- id=obs-2_e1 role=combobox label="Search" box=[…] in a 1280x800 screenshot
- id=obs-2_e2 role=link label="About" box=[…] in a 1280x800 screenshot
- id=obs-2_e3 role=button label="Go" box=[…] in a 1280x800 screenshot
- id=obs-2_e4 role=textbox label="Plain field" box=[…] in a 1280x800 screenshot
- id=obs-2_e5 role=option label="wikipedia" box=[…] in a 1280x800 screenshot
- id=obs-2_e6 role=option label="wikimedia commons" box=[…] in a 1280x800 screenshot
- id=obs-2_e7 role=option label="wikiHow" box=[…] in a 1280x800 screenshot
```

Backend flow now supported: TYPE query → fresh observation exposes
`id=obs-2_e5 role=option label="wikipedia"` → CLICK `obs-2_e5` → the
suggestion itself activates (the executor's geometry, occlusion and
availability checks apply to suggestion ids exactly as to any reviewed
control) → fresh observation shows results. If no suggestion is exposed, the
backend sends `{"action":"keypress","value":"Enter"}` and the focused search
box submits. Ids stay dynamic per observation (`${observationId}_e${n}`),
never cached, never invented.
