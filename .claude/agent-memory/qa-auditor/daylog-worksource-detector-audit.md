---
name: daylog-worksource-detector-audit
description: NorthStar→day-log work-source switch (2026-06-23/24) — detectStalledProjects replaces 4 legacy detectors; FAIL — nightly-close ritual missed
metadata:
  type: project
---

# Day-log work-source switch audit (2026-06-24) — FAIL (one missed production path)

Operator ruling 2026-06-23: Telegram day-log (`jarvis_files` path `logs/day-logs/%`) is the ONLY work-truth. NorthStar + task table are NOT. Change retires 4 detectors (`detectStalledTasks`/`detectDormantObjectives`/`detectImplicitDeadlines`/`detectRecurringBlockers`), adds `detectStalledProjects` (`src/detection/stalled-projects.ts`), de-NorthStars morning ritual + briefing construct + judgment-prompt, gates proactive nudge off (`PROACTIVE_NUDGE_ENABLED`), disables weekly-review.

## C1 — `rituals/nightly.ts` (`nightly-close`, enabled:true, 22:00 daily, gmail_send DELIVERED) STILL grounds in NorthStar as work-truth — MISSED
- nightly.ts:18 "NorthStar is the **compass**"; :22 "Read NorthStar/INDEX.md ... scan for today's active tasks"; :23 "the 3-5 NorthStar tasks with today's **due date** or highest priority"; :25 "completed or pending? carry over"; body :36 "✅ Completado hoy (N tareas)".
- This is EXACTLY the NorthStar-task-count/completion-claim class the morning ritual was hardened against ("70+ overdue tasks" hallucination). The change de-NorthStarred morning.ts but not its sibling nightly close. scheduler.ts:102 dispatches it; config.ts:39 enabled:true. Same grep-sweep-miss pattern as prior bundles.
- Fix: rewrite nightly prompt to ground in TODAY's day-log + active projects (mirror morning.ts:60-72 guard), OR disable like weekly-review (config.ts:74) pending rewrite.

## W1 — detector FN: common name/slug tokens silently SUPPRESS genuine stalls
- `matchTermsFor` (stalled-projects.ts:51-65) adds every name/slug token ≥4 chars (MIN_TOKEN_LEN). Live active projects produce noise tokens that appear in everyday day-log dialogue independent of the project: `data-intelligence`→"data"; `local-brain`→"local"/"brain"/"agente"/"studio"; `plan-2027`→"plan"; `personal-branding`→"personal". A coincidental mention marks a truly-stalled project as ACTIVE → never surfaced.
- Header comment (stalled-projects.ts:16-21) claims FNs "read as stalled; that is the safe direction" — BACKWARDS. The over-match direction is the UNSAFE one (suppresses, doesn't surface). Doc is wrong about its own failure mode.
- test stalled-projects.test.ts:68-73 BAKES IN the over-match ("voice" suppresses `salon-voice-outreach`) as intended — so the FN is asserted-correct, never caught.
- Also slug cross-contamination: `salones-wa` + `salon-voice-outreach` both →"salon"/"salones"; `obsidian-brain` + `local-brain` both →"brain".

## VERIFIED CLEAN
- Retired detectors: ZERO production call sites (grep — only index.ts re-exports + defs + comments). runDetection()=stalled only.
- Session-end day-log writer SURVIVES: proactive.ts:41 `startSessionEndWriter(router)` unconditional, BEFORE the PROACTIVE_NUDGE_ENABLED gate (:47). session-end-writer.ts:87/111 writes+appends `logs/day-logs/`. Load-bearing source intact.
- construct.ts: only NorthStar read (objectives) repointed to `projects WHERE status='active'` (:122-133). No other NorthStar read in construct (one stale comment :393 "no NorthStar objectives loaded" — cosmetic).
- morning.ts step-numbering INTACT after rewrite: steps 0-9, step 8 (submit_report) cites "steps 0-7", step 9 (gmail_send). requiredTools=[jarvis_file_read,gmail_send] (submit_report deliberately prose-only, not required — avoids double-send retry). No dangling step refs.
- SQL parameterized: detector uses `?` for SCAN_WINDOW; slug/name interpolated only into SUMMARY STRING not SQL (come from DB anyway). No injection.
- daysSinceMention math correct: daysBetween(latestDate, hit.date) → days BEFORE newest log; ≤staleDays skips; null (never mentioned in 30d window)→flagged. Reference "today"=newest day-log present (sidesteps tz). Tests :59-66 confirm 13d.
- weekly-review enabled:false (config.ts:74) + scheduler honors ritual.enabled (:215). Won't fire.
- 62/62 changed tests pass. Live DB: 22 active projects (detector non-empty).

## Doctrine
- De-NorthStar bundles: grep ALL enabled rituals that gmail_send, not just morning. nightly-close is morning's twin and was missed. The "N tareas / completado / due date" body strings are the tell.
- Token-match stall detector: a name tokenized to a COMMON word makes the stall un-flaggable. FN direction = suppression (unsafe), not surfacing. Don't trust a header that calls its own FN "safe" — trace which direction the coincidental match pushes.
