# Usability Phase 1 R1 — "kill the magic-word protocol" (2026-08-23)

Scope: `src/messaging/scope-miss.ts` (+test), `scope-classifier.ts` (VALID_GROUPS export),
`router.ts` (sticky union + scope-miss re-run + `armPendingTimers`), `prompt-sections.ts`,
`router.test.ts`. Plan §2 Phase 1 of `docs/planning/jarvis-usability-plan-2026-08-22.md`.

**Verdict: FAIL — 4 Critical, 10 Warnings.** tsc clean; 107 scoped tests pass.

## Doctrine (transferable)

1. **A swallowed reply is not an undelivered reply when the channel streams.**
   Telegram `TelegramStreamController` edits a live placeholder as chunks arrive; the
   Phase 1.2 re-run path `return`s without `finalize()`, so the very text the feature
   exists to hide stays on the operator's screen with the `▍` caret, forever, and the
   re-run's answer arrives as a SECOND message. The tests only drove the `whatsapp`
   adapter (no stream controller) → the defect is invisible to the suite.
   **Rule: when a change adds an early `return` on a delivery path, enumerate every
   side-channel already opened for that turn (placeholder, typing state, ack) and
   close each one. Test on the channel that has the richest side-channel, not the
   simplest.**
2. **A prompt fix is a two-site edit when the same prompt states the rule twice.**
   `identitySection()` spans prompt-sections.ts:68–152. Phase 1 rewrote the sentence at
   :103 but `## REGLA CRÍTICA: Solo usa herramientas disponibles` at :132–134 still
   teaches the magic word verbatim (`pídemelo con "usa shell_exec"`) — and it is the
   LATER, more specific instruction. **Grep the whole prompt-builder for the BEHAVIOUR
   you are removing, not for the sentence you edited.**
3. **`groupsForTool` over always-on tools returns EVERY group.** `file_read` is in
   `CORE_TOOLS` (scope.ts:25), so activating any single group yields it →
   `groupsForTool("file_read")` = all 23 groups = 173/216 tools, incl. `gmail_send`,
   `tweet_post`, `delete_schedule`, `wp_publish`. A real corpus hit (#12415) resolves
   `[file_edit,file_read,file_write,shell_exec]`. **Rule: a "which group supplies X"
   probe must subtract the BASELINE set (`scope(∅)`) before attributing X to a group.**
4. **Score a detector against the CORPUS for RECALL too, not just precision.**
   Replay of 392 delivered router replies (30 d): 9 hits, 8 true / 1 mid-narration FP,
   and **9 real scope-asks MISSED** (~50 % recall) — the exit criterion is 0 delivered
   scope-asks. Regex root causes worth remembering: an alternation that requires a
   literal connective (`p[íi]deme con "usa`) misses the far commoner connective-less
   shape (`Pídeme "usa X"`, `Dime "usa X"`); `no tengo (activo|disponible)` misses the
   dominant corpus shape `No tengo \`X\` en este scope`; a line-anchored + backtick-
   required `necesito \`X\`` misses mid-sentence `Necesito shell_exec para …`.
5. **A "sliding TTL" stamped on every store never expires for an active thread.**
   `previousScopeAt.set(tk, Date.now())` on every turn + a monotone union ⇒ groups
   accumulate for the whole session. Measured on 1585 real scope decisions / 415
   sessions: turn 3 median 55 tools vs 29 pre-change, turn 5 → 76, turn 10 → 80,
   max 160 (`meta`). The code comment claiming "bounded by the TTL, not accumulated
   forever" is false. Phase 1.4's token-budget gate was never run.
6. **A union of prior∪current kills every detector that tests for DISJOINTNESS.**
   `detectImplicitFeedback` (intelligence/feedback.ts:130) emits `positive` only when
   current ∩ previous = ∅ → structurally dead. Frequency: 3 `implicit_positive` rows
   in 45 d, so low blast radius, but the signal is gone silently.
7. **A swallowed turn still writes telemetry against the ORIGINAL tags.**
   `trackTaskOutcome` reads tags from task metadata (outcome-tracker.ts:48-57) and
   calls `updateSkillTracking(tags,false)` (:102) → every matched `skill:<id>` gets a
   FAILURE for a turn that was merely re-run, and the re-run drops `skill:` tags
   (`tags: ["messaging", channel]`) so nothing ever offsets it.

## Verified-good (do not re-flag)

- Re-run cannot loop: re-run pending carries `rerunOf` and NO `rerunSpec`; the guard
  `rerunSpec && !rerunOf` makes a third submission impossible.
- Thread buffer / day-log / JME / hindsight retain correctly skipped for the swallowed
  turn; the re-run answer is recorded against `pending.originalText`.
- `armPendingTimers` is behaviour-identical to the removed inline timers (same strings,
  same delete-on-abandon, same 20 min coding / 11 min other split).
- Map lifecycle parity: `previousScopeAt` deleted alongside the other two at the single
  eviction site (router.ts:951-953).

## Reproduction commands

- Corpus replay: `sqlite3 -json data/mc.db "SELECT content FROM conversations WHERE
  source='router' AND created_at > datetime('now','-30 days')"` → split on `\nJarvis:`,
  feed `detectScopeMiss(text, getAllAvailableTools({hasGoogle:true,hasWordpress:true,
  hasMemory:false,hasCrm:false}))`.
- Sticky accumulation: replay `scope_telemetry.active_groups` ordered by `created_at`,
  reset the union on a >45 min gap, size each prefix with `scopeToolsForMessage("",[],
  DEFAULT_SCOPE_PATTERNS,opts,union)`.
