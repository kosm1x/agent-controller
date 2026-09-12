/**
 * Variant activation — loads the best variant from the archive at startup
 * and applies its config overrides to the live tool registry and scope patterns.
 *
 * Soft activation: mutates in-memory singletons, no file writes.
 * Restart re-activates from DB. If variant is invalidated, restart reverts to defaults.
 *
 * Drift invalidation (2026-09-12): a variant carries the sha256 of the
 * pristine code scope patterns for the groups it overrides. If the code
 * moved since (fingerprint mismatch) the variant is STALE — it is skipped
 * with a log line and the next best is tried. Rows without a fingerprint
 * predate the column; they activate with a warning unless
 * TUNING_REQUIRE_FINGERPRINT=true, which is the operator's lever to pause
 * every legacy variant without touching the archive.
 *
 * Known limitation (verified 2026-09-12): this runs inside initDatabase,
 * BEFORE any tool source registers, so toolDescriptionOverrides find no
 * tool and never apply at boot. Only scope-pattern overrides are live.
 */

import { getValidVariants, markVariantActivated } from "./schema.js";
import { deserializeSandbox } from "./variant-store.js";
import { toolRegistry } from "../tools/registry.js";
import { DEFAULT_SCOPE_PATTERNS } from "../messaging/scope.js";
import { overriddenGroups, scopeFingerprint } from "./fingerprint.js";
import type { TuneVariant } from "./types.js";

export interface ActivationResult {
  activated: boolean;
  variantId?: string;
  score?: number;
  /** Variants skipped because their code fingerprint no longer matches. */
  skippedStale?: string[];
}

/** How many archive rows (best-first) activation is willing to inspect. */
const MAX_CANDIDATES = 20;

export type FingerprintVerdict = "match" | "stale" | "legacy" | "legacy_blocked";

export function fingerprintVerdict(
  variant: Pick<TuneVariant, "code_fingerprint">,
  groups: string[],
  requireFingerprint = process.env.TUNING_REQUIRE_FINGERPRINT === "true",
): FingerprintVerdict {
  if (groups.length === 0) return "match";
  if (!variant.code_fingerprint) return requireFingerprint ? "legacy_blocked" : "legacy";
  return variant.code_fingerprint === scopeFingerprint(groups) ? "match" : "stale";
}

export function activateBestVariant(): ActivationResult {
  const skippedStale: string[] = [];

  for (const variant of getValidVariants(MAX_CANDIDATES)) {
    const config = deserializeSandbox(variant.config_json);
    const groups = overriddenGroups(config.scopePatternOverrides);
    const verdict = fingerprintVerdict(variant, groups);
    if (verdict === "stale") {
      console.log(
        `[tuning] variant ${variant.variant_id} is STALE: code scope patterns changed for ${groups.length} overridden group(s) since it was generated — not activated (regenerate or invalidate it)`,
      );
      skippedStale.push(variant.variant_id);
      continue;
    }
    if (verdict === "legacy_blocked") {
      console.log(
        `[tuning] variant ${variant.variant_id} has no code fingerprint and TUNING_REQUIRE_FINGERPRINT=true — not activated`,
      );
      skippedStale.push(variant.variant_id);
      continue;
    }
    if (verdict === "legacy") {
      console.warn(
        `[tuning] variant ${variant.variant_id} predates code fingerprints: activating ${groups.length} scope group(s) UNVERIFIED against current defaults (set TUNING_REQUIRE_FINGERPRINT=true to block)`,
      );
    }
    return {
      ...apply(variant, config),
      ...(skippedStale.length && { skippedStale }),
    };
  }

  return { activated: false, ...(skippedStale.length && { skippedStale }) };
}

function apply(
  variant: TuneVariant,
  config: ReturnType<typeof deserializeSandbox>,
): ActivationResult {
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
    // Merge BY GROUP: a variant replaces only the groups it carries; every
    // other group keeps the code default. Before 2026-09-11 this wiped the
    // whole array, so the gen-0 variant from 2026-04-07 (17 groups) silently
    // removed every group added since — utility, seo, ads, chart, finance,
    // xpoz, projects, jarvis_write, … — from the regex fallback at each boot.
    const overridden = new Set(config.scopePatternOverrides.map((p) => p.group));
    const kept = DEFAULT_SCOPE_PATTERNS.filter((p) => !overridden.has(p.group));
    const keptGroups = new Set(kept.map((p) => p.group));
    DEFAULT_SCOPE_PATTERNS.length = 0;
    DEFAULT_SCOPE_PATTERNS.push(...kept, ...config.scopePatternOverrides);
    console.log(
      `[tuning] scope patterns: ${overridden.size} group(s) from variant, ${keptGroups.size} group(s) kept from code defaults`,
    );
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
