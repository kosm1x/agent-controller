---
name: CCP5 regression fix audit
description: CCP5 riskTier gate fix — task-executor fixed, but registry.execute() still blocks 10 requiresConfirmation tools. Dual-path issue. FAIL
type: project
---

CCP5 regression fix attempted to unblock gmail_send by changing task-executor gate from `riskTier === "high"` to `isDestructiveMcp()`. Task-executor fix is correct but insufficient.

**Why:** `registry.execute()` (line 210-226) still has the original blocking gate: `riskTier === "high" || DESTRUCTIVE_MCP_TOOLS.has(name)`. Since `registry.unlockDestructive()` is NEVER called in production, all `requiresConfirmation: true` tools without explicit `riskTier` are permanently blocked through the registry path. Prometheus executor calls `toolRegistry.execute()` directly (not through task-executor), so the fix doesn't reach it.

**How to apply:** The registry-level gate must be aligned with the task-executor fix: either (a) change registry.execute() to check isDestructiveMcp() instead of riskTier === "high", or (b) remove the blocking gate entirely from registry.execute() since task-executor now owns that responsibility, leaving only the log-only warning.
