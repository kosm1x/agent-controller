---
name: Inference & Prompt Efficiency Audit
description: Full audit of DashScope inference pipeline, token budgets, prompt construction, streaming, degradation routing, hallucination defense — PASS WITH WARNINGS, 3 critical, 7 warnings
type: project
---

Inference & Prompt Efficiency audit (2026-04-09). Verdict: PASS WITH WARNINGS.

Stack: qwen3.5-plus primary, kimi-k2.5 fallback (tools stripped), glm-5 tertiary. DashScope API, 128K context.

3 Critical:

- C1: GLM-5 pricing inconsistent: adapter.ts has 0.5/1.5 per 1M, budget/pricing.ts has 1.0/3.0 per 1M. Dashboard vs spending quotas diverge by 2x.
- C2: TOKEN_BUDGET_CODING=50K checks single-round prompt_tokens, not cumulative. Compaction fires at 108K (0.85\*128K). Wide gap between budget and compaction thresholds.
- C3: max_tokens=4096 conservative for qwen3.5-plus (supports 8K). Causes truncation-salvage cycles.

7 Warnings:

- W1: estimateTokens() ignores tool definitions (~3-5K tokens for 30 tools). Context pressure under-reports by 3-10%.
- W2: list_dir duplicated in CORE_TOOLS and CODING_TOOLS (minor).
- W3: Kimi dual containment (strip tools + skip routing) can still waste 2 rounds on fallback.
- W4: SYSTEM_PROMPT_TOKEN_BUDGET uses 4:1 char/token ratio, Spanish text is ~3.2:1. 25% overrun risk.
- W5: Streaming only for Telegram, WhatsApp users wait with no feedback during 30-90s inference.
- W6: Context advisory fires once per session, never resets after compaction.
- W7: Wrap-up call doesn't specify provider, may hit degraded-provider skip logic.

Key metrics:

- Typical chat prompt: 11-22K tokens first round
- Cost per chat message: ~$0.02-0.05
- System prompt budget: 6000 tokens (24K chars), actual ~7500 tokens due to Spanish ratio
- Tool scope: 27 base (CORE+MISC), up to 112 all groups
- exa_search dual-listing (prior v6.3.1 finding): RESOLVED
