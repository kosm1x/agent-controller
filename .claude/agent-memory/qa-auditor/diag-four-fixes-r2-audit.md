# diag-four-fixes R2 audit — 2026-09-06 (folds of R1 C1/W1/W2)

Verdict **PASS-WITH-NOTES**, 0 Critical, 3 Warnings. All three folds mutation-RED.
223/223 in the five suites, 66/66 adjacent, `npm run -s typecheck` exit 0.

## What was verified

| Fold | Where | Mutation probe | Result |
|---|---|---|---|
| F1 relevance floor | `src/db/user-facts.ts:161-163` | `requireRelevance = false` | RED |
| F2 non-latching hold | `src/messaging/router.ts:656-679` | latching variant | RED |
| F3 masked snippets | `src/lib/file-slicing.ts:33-34` | mask `.test` → false | RED |

Live-corpus numbers: credential-KEYED user_facts injected on the 3 unrelated
messages 9 → 0. Non-latching replay over 6,023 real Jarvis replies: 281 (4.67%)
transient holds, 164 (2.72%) still held at end (all genuine asks), **0 content
lost**; the latching variant loses 117 (1.94%) replies' streaming permanently.
Day-logs: 12,143 entries, 89 masked (0.73%), 70/70 whitespace-bounded
high-entropy snippets caught.

## Doctrine crumbs (the reusable part)

1. **A substring keyword score has no word boundary.** `scoreFact` does
   `text.includes(word)` over ≥3-char tokens, so the Spanish stop word `con`
   matches inside `mexico**con**…` → wait, inside `mexi(con)ecesario` — and
   pulls `mexiconecesario_auth_token` (a 40-char bearer token) into the prompt
   on *«Agenda una reunión con el equipo»*. Measured 2/20 ordinary Spanish
   sentences still inject a key-named secret post-fix. A relevance floor built
   on substring matching is a 90% filter, not a boundary.
2. **A guard that can UN-finalize is not the same as one that no-ops.**
   The pre-fold `onTextChunk` was `appendChunk`, which returns early when
   `finalized`. `holdScopeAsks` calls `reset()`, and
   `TelegramStreamController.reset()` sets `finalized = false` **and** edits the
   message to the placeholder. One late SSE delta after `finalize("🛑 Detenido.")`
   (router.ts:1856) therefore replaces a delivered answer with a permanent ⏳.
   When you swap a callback for one that can call a *state-clearing* method,
   enumerate every method the old one could not reach.
3. **A whitespace-bounded secret regex is defeated by one adjacent character.**
   `(?:^|\s)[A-Za-z0-9%+/=_-]{32,}(?:\s|$)` masks a bare token but LEAKS the
   same token in braces, backticks, a cookie `;` list, a quoted URL, or followed
   by `.`/`,`. Verified live: the ESPN `espn_s2` entry is masked, and the SWID
   two lines below it is not — SHA-256-matched against
   `user_facts.fantasy_2026_swid`. Mask the credential PAIR, not one spelling.
4. **`messageWords.size > 0` as a mode switch — measure the empty case.**
   The floor silently disables itself on a message with no ≥3-char word.
   Live rate over 2,990 operator turns: **1 (0.03%)** — a Recommendation, not a
   Warning. Measure before ranking; the shape of the hole is not its size.
5. **Frequency ranks a latent regression.** `/stop` → `finalize` → late chunk is
   architecturally reachable but `Jarvis: Detenido:` appears **0 times** in the
   7,879-row `mc-jarvis` bank and 0 tasks were cancelled in 30 d. Warning, not
   Critical.

## Test pollution (pre-existing, NOT this bundle)

`src/messaging/router.test.ts:3380` («a normal task still abandons at 11 min»)
calls `router.handleInbound({text: "Revisa todos los PRs abiertos y ciérralos"})`
→ `appendDayLog` (router.ts:2560) → `mirrorToDisk` (router.ts:1278) → real disk.
`router.test.ts` mocks `../db/index.js` but NOT `../db/jarvis-fs.js` and never
sets `JARVIS_KB_MIRROR_DIR`, so `getMirrorDir()` (jarvis-fs.ts:26-28) falls back
to `/root/claude/jarvis-kb`. 11 other suites set the env; this one doesn't.
Because `getFile()` reads the MOCKED db and returns undefined, each inbound
rewrites the live day-log as `header + 1 entry` — the DB row keeps its real
content, so the divergence is disk-only and self-heals on the next real inbound.
Identical at HEAD (81 `handleInbound` calls in both) ⇒ pre-existing.
**Lesson: a suite that constructs a real router writes to real disk unless every
FS-touching module is mocked or redirected — the DB mock is not enough.**
