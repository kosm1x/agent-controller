# Audit: skill-discovery Auto-skill → fast runner (e42705b, 2026-07-06)

Verdict: PASS WITH WARNINGS. 0 Critical / 1 Warning / 2 Recs.

Fix: skill-discovery.ts:153 changed `agentType:"auto"` → `"fast"` so the auto-save
task (skill_save/skill_list = host-only mc.db writers) stops routing to the
nanoclaw sandbox (the description names "git commit + git push" → `\bgit\b` matched
STRONG_CODING_PATTERNS). Same misroute CLASS as foreign-project-name + code-read-explain
guards: route by what a task DOES, not what its surface text looks like.

## Verified-safe (adversarial hypotheses that CLEARED)
- Interactive-default confirmation stall: DOESN'T fire. Internal task is
  interactive=true (submitTask never sets `interactive`; fast-runner `input.interactive!==false`),
  BUT skill_save has no riskTier/requiresConfirmation → getEffectiveRiskTier="low"
  (registry.ts:171-177); the gate at task-executor.ts:93 fires ONLY on "high". No hang.
- Explicit agentType override honored at classifier.ts:411; retries reuse
  agent_type="fast" (reactions/manager.ts:201,234), tools survive via metadata
  persistence (dispatcher.ts:351-357), bounded MAX_RETRIES=2 (rules.ts:28). No loop/re-misroute.
- fast runner in-process → saveSkill()→getDatabase()=host mc.db, no throwaway /tmp indirection.
- Explicit `tools:[...]` bypass scope-group gating; 2≤6 → skipDeferral → full schemas.

## W1 (the residual, DOCTRINE): routing fix ≠ end-to-end persistence
The task's own prompt instructions (skill-discovery.ts:136-142) drift from
skill_save's schema: say `trigger_text` (actual param = `trigger`, skills.ts:58)
and OMIT the required `description`. DB cols are NOT NULL (schema.sql:138-139).
If the LLM follows prose over JSON-schema `required`, saveSkill binds undefined to
a NOT NULL col → INSERT throws → {error}. Routing to `fast` removes the BLOCKER but
persistence still depends on (a) LLM-conservative-save judgment and (b) correct
tool args. "0 skills persisted" metric won't necessarily flip to >0 from a routing
fix alone. When auditing a "route it to the right runner" fix, always ask the
SECOND question: once it's on the right runner, does the actual write still succeed
end-to-end? (arg-shape drift, NOT NULL cols, LLM no-op paths).

## Test quality
skill-discovery.test.ts:102-109 asserts submitTask called with objectContaining
agentType:"fast" — fails if reverted to "auto". Guards the CALLER (right layer);
real classify() override covered by classifier tests. New dispatcher mock is a net
improvement (previously proposeSkill hit real submitTask, swallowed by try/catch).
