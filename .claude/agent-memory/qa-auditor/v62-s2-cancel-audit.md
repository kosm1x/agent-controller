---
name: v6.2 S2 Task Cancellation Audit
description: Audit of Telegram task cancellation feature — FAIL. Status overwrite race (cancelled→failed), abort not handled in fast-runner exitReason, signal not propagated to heavy/swarm runners
type: project
---

v6.2 S2 Task Cancellation from Telegram — FAIL (2 critical)

**C1: Status overwrite race** — When abort fires mid-fetch, `AbortError` cascades through provider retry loop (all providers fail instantly), throws up to `dispatchWithSlot` catch block which overwrites DB status from `cancelled` to `failed`. Root cause: `infer()` treats user-abort same as timeout (retries instead of short-circuiting).

**C2: Signal not propagated to non-fast runners** — heavy-runner, nanoclaw-runner, swarm-runner ignore `input.signal`.

**W4: exitReason "aborted" unhandled in fast-runner** — Clean between-rounds abort returns `exitReason: "aborted"` with content `"[aborted]"` but fast-runner defaults to `success: true`, `status: DONE`.

**Architecture notes:**

- Signal path: router AbortController → dispatcher TaskSubmission.abortController → RunnerInput.signal → fast-runner → inferWithTools → AbortSignal.any([timeout, external]) → fetch
- Two abort paths: between-rounds (line 1038, clean return) vs mid-fetch (AbortError throw, dirty cascade)
- `pendingReplies` keyed by taskId, not channel — multiple tasks possible per channel
- `TelegramStreamController.finalize` has `finalized` guard — double-finalize is safe
- Cancel handler `break`s on first channel match — may cancel background agent instead of chat task

**How to apply:** Fix C1 by adding abort-aware guard in `dispatchWithSlot` catch + short-circuit in `infer()` for external abort. Fix W4 by adding `exitReason === "aborted"` check in fast-runner alongside `provider_failure`.
