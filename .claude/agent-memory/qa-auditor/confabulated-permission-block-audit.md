# Confabulated permission-block fix audit (2026-06-16)

Bundle: anti-confabulation fix for Jarvis falsely refusing gmail_send/MCP tools as
"bloqueado en modo don't ask". 3 surfaces: prompt-sections.ts (2 additions),
router.ts (4 new POISONED_RESPONSE_PATTERNS + export isPoisonedExchange), tests.

Verdict: PASS WITH WARNINGS.

## Confirmed facts (reusable)
- `isPoisonedExchange` gates ONLY the in-memory thread buffer, never user delivery.
  Call sites: router.ts pushToThread (~728, drops from buffer) and getThreadTurns
  (~858, drops assistant turn, KEEPS user turn). FP = degraded context, not dropped msg.
- gmail_send has a REAL code-level confirmation gate, not just prompt:
  task-executor.ts:93-110 — `interactive` + riskTier='high' → returns
  CONFIRMATION_REQUIRED + setPendingConfirmation. gmail_send is requiresConfirmation:true
  + destructiveHint:true (google-gmail.ts:16,20). This gate is INDEPENDENT of the SDK
  fast-path's permissionMode:"dontAsk" (claude-sdk.ts:446). The two paths gate differently.

## Findings that recur
- **Prompt absolute-claim vs code contradiction (High):** prompt told model "No hay
  ningún gate de permisos ... llámala y ya" — TRUE for SDK dontAsk path, FALSE for
  task-executor CONFIRMATION_REQUIRED path. When a shared prompt section makes an
  absolute claim about tool behavior, check ALL runner paths — gating is path-dependent.
- **Unbounded-alternation regex FP (Medium x2):** new poison patterns keyed on
  noun(herramienta|tool|gmail|supabase|el correo) + bloqueado, and bloqueado + (modo|
  permiso|...). FALSE-matched legit external-block reports: "La herramienta de WhatsApp
  está bloqueada por rate-limit", "El tool fue bloqueado por Cloudflare", "Gmail tiene
  la cuenta bloqueada por actividad sospechosa", "necesitas permiso del dueño",
  "cambiar el modo de contacto". `modo`/`permiso` are domain-common → too generic.
  Confabulation's distinguishing feature = tool blocked from being CALLED by a
  permission/session gate, NOT blocked by an external service. The other patterns in
  this same file DO use sentence-start anchors + bounded spans (router.ts:774-776
  comment) to avoid exactly this — new patterns didn't follow that discipline.
- Negative tests existed but didn't cover the noun-adjacent / modo-permiso FP classes
  → green tests gave false confidence. Always add the FP strings you found as failing
  negative assertions.

Method: extract regexes to a node harness, run vs confabulation set (must match) +
~30 benign Spanish set (must not match). Fast, deterministic, surfaces FPs at report time.
