# `/compress <focus>` vs `compact-jarvis` — Research Note

**Status:** Research deliverable, 2026-05-23. Closes Hermes April Tier-2 #3 ("Evaluate `/compress <focus>` guided compression vs our compact-jarvis skill"). No code change.

**Sources consulted** (all source-verified per [[websearch-summary-hallucinations]] always-on rule)

- Our `compact-jarvis` skill — `/root/.claude/plugins/local/kosm1x-workflows/skills/compact-jarvis/SKILL.md`
- Our compaction pipeline — `src/prometheus/compaction-pipeline.ts`
- [Hermes `/compress` reference](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/reference/slash-commands.md) (verbatim quotes below)

---

## 1. Reframing — the task description had it wrong

The to-do entry framed this as "compact-jarvis compresses at operator level; theirs does at agent level." **That's wrong.** `compact-jarvis` is read-only: it doesn't compress anything. From the skill's own description: _"Check Jarvis context health and compaction state. Useful for: Monitoring long-running tasks that may be approaching context limits / Diagnosing tasks that failed due to context exhaustion / Verifying compaction pipeline is working after changes / Reviewing compaction history."_

It's a diagnostic surface for the operator to inspect Jarvis's automatic compaction — same shape as `mc-ctl status` for service state. The comparison isn't operator-vs-agent compression; it's **"operator has no compression command"** vs Hermes's `/compress [focus topic]`.

## 2. What each thing actually does

|                | `compact-jarvis` (ours)                                                                                   | `/compress [focus topic]` (Hermes)                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who invokes    | Operator inspecting state                                                                                 | Operator (CLI or messaging)                                                                                                                             |
| What it does   | Reads journalctl, queries `jarvis_files` for compaction summaries, prints context pressure per recent run | Verbatim from source: _"Manually compress conversation context (flush memories + summarize). Optional focus topic narrows what the summary preserves."_ |
| Mutates state  | **No** — pure read                                                                                        | **Yes** — drives a compression cycle on the current conversation                                                                                        |
| Focus argument | N/A                                                                                                       | Optional. Without it: summarizes the entire conversation. With it: prioritizes content relevant to the topic.                                           |

These are two different categories of tool. `compact-jarvis` is read-only diagnostics for Jarvis's _automatic_ compaction (L0-L3 pipeline runs on its own when threshold hit). `/compress` is an operator-driven _manual trigger_ on a live session.

## 3. Does the manual-trigger use case exist in our stack?

The interaction modes where `/compress <focus>` shines:

1. **Mid-thread context reclamation in a long live session** — the operator has a multi-turn IDE-like conversation, notices context bloat, calls `/compress` to free budget. (Hermes ships a separate `/steer` command for actually redirecting the agent's focus mid-flight; `/compress` is the compression primitive, `/steer` is the steering primitive. They stack. This note is about `/compress` only.)
2. **Proactive flush before a context-heavy sub-task** — operator about to ask for a big task, runs `/compress` to free room.
3. **Focus refinement** — operator has a long mixed-topic thread, calls `/compress <focus>` to drop irrelevant strands.

Our interaction model:

- Each user message → one task → fast/heavy/swarm runner → done. Tasks are short-lived (fast: 15-90s; heavy: minutes; swarm: 10-30 min ceiling).
- The "conversation" lives in the messaging history (Telegram/WhatsApp thread, channel buffer). Each round is independent at the runner level — context isn't accumulated across rounds the way it is in a Hermes session.
- Long Prometheus tasks have multi-round internal contexts. The operator CAN abort a running task via the messaging cancel surface (`router.ts:1410` recognizes "cancela"/"detente"/"stop"), but there is no _steering_ surface — only cancel-and-restart. Hermes's separate `/steer` slash command is the closer analog to mid-flight steering; this note is about `/compress` specifically.

**The use cases don't transfer to our interaction model.** There's no live multi-turn session for the operator to steer mid-flight. Each turn starts fresh; auto-compaction handles the in-task pressure.

## 4. What's actually missing — and what's not

Missing (acknowledged, but the missing feature is something OTHER than this):

- **Focus-topic-aware summarization on automatic L2 compression.** Already queued as a cherry-pick in [[pluggable-context-engine-design]] §7 — add an optional `focusTopic` parameter to `compress()` directly. Pairs naturally with the scope-classifier output: if active scope is `coding`, the L2 prompt could carry `focusTopic: "coding artifacts (file paths, errors, diffs)"`. **This is the part of `/compress` worth borrowing — but at the AUTO-COMPACTION layer, not as an operator slash command.**
- **Operator-driven re-compaction of a long Telegram/WhatsApp thread.** Not currently a surfaced need; the thread truncation in the messaging layer handles bounded history. Could be a future "/refocus" command if a user reports drift, but no incident has surfaced.

NOT missing:

- **`/compress` as an operator command.** The interaction mode it serves doesn't exist in our stack.
- **Manual compression trigger.** The auto-threshold fires when needed; the operator doesn't need to predict it.

## 5. Decision

**Don't ship `/compress <focus>` as an operator command.** The interaction mode it serves (operator interactively steering a live session) doesn't exist in our stack. Our compaction is per-task and automatic; the operator-driven manual trigger would have no surface to fire from in normal use.

**Already queued (no new action this commit):** add an optional `focusTopic` parameter to `compress()` directly, per [[pluggable-context-engine-design]] §7 cherry-pick. This borrows the _interesting bit_ of Hermes's `/compress` (focus-targeted summarization) at the auto-compaction layer where we actually use it.

## 6. Re-evaluation triggers

- An operator reports drift in a long messaging thread that wasn't caught by auto-compaction — that surfaces "/refocus" as a real need.
- We adopt a multi-turn interactive session mode (e.g., a Telegram inline-bot style "stay in this thread" where context accumulates server-side across user messages). At that point the use case Hermes ships against would exist for us too.
- We implement the `focusTopic` cherry-pick from [[pluggable-context-engine-design]] §7 and want to expose it to the operator for manual override — that's the lowest-cost path to an operator-facing `/refocus` if the need materializes.
- Quarterly cadence check, next ~2026-08-23.

Memory pointer: `feedback_compress_focus_vs_compact_jarvis.md` (created in same ship).
