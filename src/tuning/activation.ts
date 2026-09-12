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
 * with a warning and the next best is tried. Rows without a fingerprint
 * predate the column and cannot be verified; they are BLOCKED by default
 * (structural-safety rule: a must-hold property refuses, it does not warn)
 * and activate only under TUNING_ALLOW_LEGACY_VARIANTS=true. qa-audit
 * 2026-09-12: the only valid row today is the April-2026 variant, which is
 * exactly the population this guard exists for.
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
  allowLegacy = process.env.TUNING_ALLOW_LEGACY_VARIANTS === "true",
): FingerprintVerdict {
  if (groups.length === 0) return "match";
  if (!variant.code_fingerprint) return allowLegacy ? "legacy" : "legacy_blocked";
  return variant.code_fingerprint === scopeFingerprint(groups) ? "match" : "stale";
}

export function activateBestVariant(): ActivationResult {
  const skippedStale: string[] = [];

  for (const variant of getValidVariants(MAX_CANDIDATES)) {
    let config: ReturnType<typeof deserializeSandbox>;
    try {
      config = deserializeSandbox(variant.config_json);
    } catch (err) {
      // A malformed archived row must not abort boot (this runs inside
      // initDatabase); skip it like a stale one.
      console.warn(
        `[tuning] variant ${variant.variant_id} has an unreadable config (${err instanceof Error ? err.message : String(err)}) — not activated`,
      );
      skippedStale.push(variant.variant_id);
      continue;
    }
    const groups = overriddenGroups(config.scopePatternOverrides);
    const verdict = fingerprintVerdict(variant, groups);
    if (verdict === "stale") {
      console.warn(
        `[tuning] variant ${variant.variant_id} is STALE: code scope patterns changed for ${groups.length} overridden group(s) since it was generated — not activated (regenerate or invalidate it)`,
      );
      skippedStale.push(variant.variant_id);
      continue;
    }
    if (verdict === "legacy_blocked") {
      console.warn(
        `[tuning] variant ${variant.variant_id} has no code fingerprint (generated before 2026-09-12) — not activated; code defaults stay live. Regenerate it, or set TUNING_ALLOW_LEGACY_VARIANTS=true to run it unverified`,
      );
      skippedStale.push(variant.variant_id);
      continue;
    }
    if (verdict === "legacy") {
      console.warn(
        `[tuning] variant ${variant.variant_id} predates code fingerprints: activating ${groups.length} scope group(s) UNVERIFIED against current defaults (TUNING_ALLOW_LEGACY_VARIANTS=true)`,
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
