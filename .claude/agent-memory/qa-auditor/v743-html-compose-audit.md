# v7.4.3 HTML-as-Composition DSL — QA Audit Notes (Session 98, 2026-04-22)

Commit shipped: `5b34477`. Phase γ 13/13, closes γ on original scope.

## Round 1 (FAIL → all fixed)

### Critical

- **C1. `playwright` undeclared in package.json** — `src/video/html-renderer.ts:126` dynamic-imports `playwright` but only `@playwright/mcp` was declared. Tool's runtime availability hinged on transitive hoist. Fix: promoted `playwright ^1.59.1` to direct dependency; CLAUDE.md dep count 14 → 15.
- **C2. `serviceWorkers: "block"` missing from `newContext()`** — a hostile composition could register a SW via data: URI and proxy fetch traffic past `blockExternalRoute`. Route handler's isolation claim was bypassable. Fix: added `serviceWorkers: "block"` to `browser.newContext()` call; added regression test `newContext locks down service workers + downloads`.
- **C3. `renderHtmlComposition` unvalidated jobId in filesystem paths** (defense-in-depth) — exported function accepts `jobId` used in `join(FRAME_ROOT, jobId)` + `rmSync`. Today's caller passes `randomUUID().slice(0,8)`; any future caller that feeds user input triggers traversal. Fix: added `SAFE_JOB_ID = /^[A-Za-z0-9_-]{4,36}$/` guard at entry + 3 negative tests.

### Warnings

- **W1. Parser selector over-match** — `[data-track-index]`/`[data-layer]`-only elements inflated total duration to maxCap (180°-second cap hit on a 2s composition via decorative markers). Fix: restricted `querySelectorAll` to `[data-start], [data-duration]`.
- **W2. Frame dir leaks on error** — `rmSync(frameDir)` only ran on success path; render/ffmpeg failure paths left PNGs on `/root/tmp-video-frames/`. Fix: added `cleanupFramesOnError` helper invoked from every throw path.
- **W3. `html-motion.ts` dead-wired** — tool description referenced "see html-motion catalog" but nothing in production code consumed the catalog. Fix: added `motionVocabSection()` that reads `HTML_MOTION_IDS` at tool-export time and injects the ID list into the description string literal. Test asserts catalog IDs present in description.
- **W4. Stale `composing` rows on crash** (pre-existing from v7.4 S1) — permanently consume MAX_CONCURRENT_JOBS=2 slots. **Deferred with trigger** in impl plan.
- **W5. Scope arm `html[-_\s]composition` over-broad** — matched generic engineering chatter like "html composition engine design". Fix: tightened to `html[-_\s]composition\s+(?:mp4|file|job|render|v[ií]deo)`; added 1 FP-negative + 1 tighten-regression test.
- **W6. Misleading `file://` allow branch** (auditor error) — claim was that route handler only sees network requests. Round 1 fix removed the branch; live smoke proved auditor wrong (see Live Smoke §1). Reverted to `blockExternalRoute(allowedFilePath?: string)` pinning exactly the composition file.
- **W7. `validateViewport` ran AFTER DB side-effect** — bad viewport caused zombie `composing` rows. Fix: moved `validateViewport(width, height)` to tool entry before concurrency gate.
- **W8. `parseHtmlComposition` ran AFTER DB concurrency round-trip** — bad paths paid for a DB query. Fix: parse before gate; DB only touched if parse passes.
- **S2. Square template dropped** — `width >= height ? 'landscape' : 'portrait'` lost the `'square'` category. Fix: three-way ternary.
- **R1. Wall-clock cost buried at end of description** — moved to top (under `COST:` header) for LLM visibility.
- **R3. No handler predicate test** — added direct `blockExternalRoute()` unit tests for data:/http:/https:/ws:/wss:/file:// predicates.

## Round 2 (PASS with 2 minor hardenings)

- **W-R2-1.** No regression test asserted `serviceWorkers: "block"` reached `newContext()`. Added `expect(mocks.newContextMock).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: "block", acceptDownloads: false }))`.
- **W-R2-2.** New `html-composition v[ií]deo` arm missed the top-level `v[ií]deo(?!\s*(?:tag|element|elemento))` lookahead parity. Fixed: `html[-_\s]composition\s+(?:mp4|file|job|render|v[ií]deo(?!\s*(?:tag|element|elemento)))`.

### Round 2 spot-checks that passed

- `randomUUID().slice(0,8)` → 8 lowercase hex, matches `SAFE_JOB_ID`.
- All 13 v7.4.3 scope positive/negative fixtures still pass after W5 tighten.
- `reads trackIndex and layer defaults to 0` test still passes (elements declare `data-start` + `data-duration`).
- Concurrency-test helper writes a real HTML file; passes parse → hits DB gate (W8 order honored).
- `motionVocabSection()` evaluates at Tool-export time; IDs baked into description string literal.
- `blockExternalRoute` dead `file://` branch removed (routed through pinned-path allow instead).
- `playwright ^1.59.1` in `dependencies`; package-lock updated; CLAUDE.md lists 15 core deps.
- Frame-dir cleanup wired into every error path; browser.close() in finally wrapped.
- ffmpeg `execFileSync` with array args → no shell interpolation; SAFE_JOB_ID-gated path.

**Verdict: PASS, ready to ship.**

## Live smoke — caught 2 shipping-blockers neither audit detected

### §1. Playwright DOES intercept `file://` navigation

First deploy failed: `page.goto('file:///root/tmp-video-html/smoke.html')` → `net::ERR_FAILED`. Round 1 auditor claim ("`route` intercepts network requests only; `file://` bypasses at browser level") was wrong on this Playwright version. Reverted: `blockExternalRoute(allowedFilePath)` now pins exactly one `file://` URL (the composition's own path); any other `file://` aborts, including siblings under the same allowlist directory.

### §2. Snap AppArmor blocks `/tmp/` reads

Second deploy failed: `net::ERR_FILE_NOT_FOUND` on `file:///tmp/video-html/smoke.html` even though the file existed and was readable by other processes. v7.4 S1 lesson extended: snap Chromium AppArmor blocks `/tmp/*` reads AND writes (was only known to block writes). Moved `HTML_PATH_ALLOWED_PREFIX` from `/tmp/video-html/` → `/root/tmp-video-html/`. Global sed-replace across 6 files (parser, renderer, 3 tests, impl plan).

### §3. Third smoke: PASS

- Input: `/root/tmp-video-html/smoke.html` (2-element composition with `window.__hf.seek(t)`)
- Invocation: `video_html_compose({html_path, fps: 24, width: 640, height: 360})`
- Output: 48 frames rendered in 2,705 ms
- MP4: `/tmp/video-jobs/5736d175.mp4`, 18,816 bytes
- ffprobe: `duration=2.000000` (exact match to `window.__hf.duration() => 2`)

## Metrics

- Tests: 3573 → 3648 (+75)
- Tools: 245 → 246 (+1, deferred under `video` scope)
- Source files: 368 → 371 (+3: html-parser.ts, html-renderer.ts, html-motion.ts)
- Test files: 207 → 210 (+3)
- CLAUDE.md deps: 14 core → 15 core (playwright promoted)
- Net-new npm deps: 0 (playwright was transitively present)
- Commits: `5b34477` feat + `0e91c45` docs, both pushed to `kosm1x/agent-controller` main
- Phase γ: 12/13 → **13/13 Done on original scope**

## Meta-lesson (folded into `feedback_v743_html_composition.md`)

Three-layer shipping protocol (Round 1 → Round 2 → live smoke) is not redundant. Each layer catches a structurally different class of bug:

- Round 1: design gaps
- Round 2: fix-for-fix regressions
- **Live smoke: environmental + library-quirk surprises that audit can't detect statically**

Never skip live smoke even when both audit rounds PASS.
