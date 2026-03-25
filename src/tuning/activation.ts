/**
 * Variant activation — loads the best variant from the archive at startup
 * and applies its config overrides to the live tool registry and scope patterns.
 *
 * Soft activation: mutates in-memory singletons, no file writes.
 * Restart re-activates from DB. If variant is invalidated, restart reverts to defaults.
 */

import { getBestVariant, markVariantActivated } from "./schema.js";
import { deserializeSandbox } from "./variant-store.js";
import { toolRegistry } from "../tools/registry.js";
import { DEFAULT_SCOPE_PATTERNS } from "../messaging/scope.js";

export interface ActivationResult {
  activated: boolean;
  variantId?: string;
  score?: number;
}

export function activateBestVariant(): ActivationResult {
  const variant = getBestVariant();

  if (!variant) {
    return { activated: false };
  }

  const config = deserializeSandbox(variant.config_json);

  // Apply tool description overrides
  if (config.toolDescriptionOverrides?.size) {
    for (const [toolName, description] of config.toolDescriptionOverrides) {
      const tool = toolRegistry.get(toolName);
      if (tool) {
        tool.definition.function.description = description;
      }
    }
  }

  // Apply scope pattern overrides (replace array contents in-place)
  if (config.scopePatternOverrides?.length) {
    DEFAULT_SCOPE_PATTERNS.length = 0;
    for (const p of config.scopePatternOverrides) {
      DEFAULT_SCOPE_PATTERNS.push(p);
    }
  }

  markVariantActivated(variant.variant_id);

  console.log(
    `[tuning] Activated variant ${variant.variant_id} (gen ${variant.generation}, score ${variant.composite_score.toFixed(1)})`,
  );

  return {
    activated: true,
    variantId: variant.variant_id,
    score: variant.composite_score,
  };
}
