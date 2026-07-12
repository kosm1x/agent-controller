/**
 * Model pricing configuration for cost calculation.
 *
 * Defaults cover DashScope models (primary cost driver).
 * Override via BUDGET_PRICING_JSON env var for custom models.
 */

export interface ModelPricing {
  /** USD per 1,000 prompt tokens. */
  promptCostPer1k: number;
  /** USD per 1,000 completion tokens. */
  completionCostPer1k: number;
}

/**
 * Default pricing for known models (USD per 1K tokens).
 * Source: DashScope pricing as of 2026-03.
 */
const DEFAULT_PRICING: Record<string, ModelPricing> = {
  // Qwen series
  "qwen-plus": { promptCostPer1k: 0.0008, completionCostPer1k: 0.002 },
  "qwen3-plus": { promptCostPer1k: 0.0008, completionCostPer1k: 0.002 },
  "qwen3.5-plus": { promptCostPer1k: 0.0008, completionCostPer1k: 0.002 },
  "qwen3.6-plus": { promptCostPer1k: 0.0008, completionCostPer1k: 0.002 },
  "qwen-turbo": { promptCostPer1k: 0.0003, completionCostPer1k: 0.0006 },
  "qwen-max": { promptCostPer1k: 0.002, completionCostPer1k: 0.006 },
  // Qwen coder series
  "qwen3-coder-plus": { promptCostPer1k: 0.0008, completionCostPer1k: 0.002 },
  "qwen3-coder-next": { promptCostPer1k: 0.0008, completionCostPer1k: 0.002 },
  // GLM series (ZhipuAI via DashScope)
  "glm-5": { promptCostPer1k: 0.0005, completionCostPer1k: 0.0015 },
  "glm-4.7": { promptCostPer1k: 0.0005, completionCostPer1k: 0.0015 },
  // Kimi (Moonshot via DashScope)
  "kimi-k2.5": { promptCostPer1k: 0.001, completionCostPer1k: 0.003 },
  // MiniMax
  "MiniMax-M2.5": { promptCostPer1k: 0.001, completionCostPer1k: 0.003 },
  // Fireworks-hosted aliases (post-2026-05-06 provider migration). p-notation
  // is the Fireworks naming convention (e.g. "minimax-m2p7" == "MiniMax-M2.7").
  // Cost source: 2026-05-06 live benchmark on this account, see
  // feedback_fireworks_qwen3p6_retry_storm.md.
  "minimax-m2p7": { promptCostPer1k: 0.0003, completionCostPer1k: 0.0012 },
  "kimi-k2p5": { promptCostPer1k: 0.0006, completionCostPer1k: 0.003 },
  "kimi-k2p6": { promptCostPer1k: 0.00095, completionCostPer1k: 0.004 },
  "qwen3p6-plus": { promptCostPer1k: 0.0008, completionCostPer1k: 0.002 },
  "glm-5p1": { promptCostPer1k: 0.0014, completionCostPer1k: 0.0044 },
  "deepseek-v4-pro": { promptCostPer1k: 0.00174, completionCostPer1k: 0.00348 },
  // DeepSeek series
  "deepseek-v3": { promptCostPer1k: 0.0014, completionCostPer1k: 0.0028 },
  "deepseek-v3.2": { promptCostPer1k: 0.0014, completionCostPer1k: 0.0028 },
  "deepseek-r1": { promptCostPer1k: 0.004, completionCostPer1k: 0.016 },
  // Claude Sonnet (Anthropic) — auth'd via ~/.claude/.credentials.json under
  // Max subscription. The SDK reports `total_cost_usd: 0` in that mode, and
  // recordCost prefers the reported value via costUsdOverride. This entry
  // is the fallback used only if costUsdOverride is absent; set to $0 so we
  // don't double-book phantom API spend against the Max subscription. If a
  // user ever routes Sonnet through metered API, override via
  // BUDGET_PRICING_JSON with the real per-M rates.
  "claude-sonnet-5": { promptCostPer1k: 0, completionCostPer1k: 0 },
  "claude-sonnet-4-6": { promptCostPer1k: 0, completionCostPer1k: 0 },
  "claude-sonnet-4-5": { promptCostPer1k: 0, completionCostPer1k: 0 },
  "claude-opus-4-7": { promptCostPer1k: 0, completionCostPer1k: 0 },
  "claude-opus-4-8": { promptCostPer1k: 0, completionCostPer1k: 0 },
  "claude-haiku-4-5": { promptCostPer1k: 0, completionCostPer1k: 0 },
};

/** Fallback for unknown models. */
const FALLBACK_PRICING: ModelPricing = {
  promptCostPer1k: 0.001,
  completionCostPer1k: 0.003,
};

let _pricingOverride: Record<string, ModelPricing> | null = null;

/**
 * Load custom pricing from a JSON string.
 * Call once at startup if BUDGET_PRICING_JSON is set.
 */
export function loadPricingOverride(json: string): void {
  try {
    _pricingOverride = JSON.parse(json) as Record<string, ModelPricing>;
  } catch {
    console.error(
      "[budget] Failed to parse BUDGET_PRICING_JSON, using defaults",
    );
    _pricingOverride = null;
  }
}

/** Strip known provider path prefixes so callers can pass either bare alias
 * or full path (e.g. "accounts/fireworks/models/minimax-m2p7"). */
function stripFireworksPrefix(model: string): string {
  return model.replace(/^accounts\/fireworks\/models\//, "");
}

/** Get pricing for a model, checking overrides then defaults then fallback. */
export function getPricing(model: string): ModelPricing {
  const normalized = stripFireworksPrefix(model);
  // Check override first — try both raw and normalized so operators can set
  // either form via BUDGET_PRICING_JSON.
  if (_pricingOverride?.[model]) return _pricingOverride[model];
  if (_pricingOverride?.[normalized]) return _pricingOverride[normalized];
  // Check default map (try exact match, then prefix match)
  if (DEFAULT_PRICING[normalized]) return DEFAULT_PRICING[normalized];
  for (const [key, pricing] of Object.entries(DEFAULT_PRICING)) {
    if (normalized.startsWith(key)) return pricing;
  }
  return FALLBACK_PRICING;
}

/** Calculate cost in USD for a given model and token counts. */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const pricing = getPricing(model);
  return (
    (promptTokens / 1000) * pricing.promptCostPer1k +
    (completionTokens / 1000) * pricing.completionCostPer1k
  );
}
