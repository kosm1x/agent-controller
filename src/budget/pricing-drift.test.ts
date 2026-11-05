/**
 * Cross-repo pricing drift test (W5 audit fix, 2026-05-07).
 *
 * mc and the CRM (Pulso-Aura-Upfront, formerly crm-azteca) each maintain
 * their own pricing tables — the same Fireworks aliases must match
 * across both, or cost reports diverge by
 * model and the operator can't reconcile mc vs CRM spend. This test
 * reads the CRM budget.ts source as text and asserts the Fireworks
 * p-notation entries (input × 1000 == mc's promptCostPer1k × 1000)
 * agree numerically. Catches drift on next provider migration.
 *
 * Skipped when Pulso-Aura-Upfront isn't co-located on disk (CI sandboxes,
 * isolated checkouts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { getPricing } from "./pricing.js";

const CRM_BUDGET_PATH = "/root/claude/Pulso-Aura-Upfront/crm/src/budget.ts";

const FIREWORKS_ALIASES = [
  "minimax-m2p7",
  "kimi-k2p5",
  "kimi-k2p6",
  "qwen3p6-plus",
  "glm-5p1",
  "deepseek-v4-pro",
  // CRM live primary / fallback as of 2026-11-05 (ledger-verified).
  "qwen3p8-max",
  "minimax-m3",
] as const;

interface CrmRate {
  input: number;
  output: number;
}

function parseCrmRate(src: string, alias: string): CrmRate | null {
  // CRM budget.ts uses per-million-token rates: { input: 0.3, output: 1.2 }
  // Anchored to line start (m flag) so a `//`-commented row cannot match.
  const re = new RegExp(
    `^\\s*"${alias}":\\s*\\{\\s*input:\\s*([\\d.]+)\\s*,\\s*output:\\s*([\\d.]+)`,
    "m",
  );
  const m = src.match(re);
  if (!m) return null;
  return { input: parseFloat(m[1]), output: parseFloat(m[2]) };
}

describe("budget pricing drift", () => {
  if (!existsSync(CRM_BUDGET_PATH)) {
    it.skip(
      "Pulso-Aura-Upfront not co-located, skipping drift check",
      () => {},
    );
    return;
  }

  const crmSrc = readFileSync(CRM_BUDGET_PATH, "utf-8");

  for (const alias of FIREWORKS_ALIASES) {
    it(`mc and crm agree on Fireworks alias '${alias}'`, () => {
      const mc = getPricing(alias);
      const crm = parseCrmRate(crmSrc, alias);
      expect(
        crm,
        `${alias}: no \`"${alias}": { input, output }\` row parsed from ${CRM_BUDGET_PATH}`,
      ).not.toBeNull();
      // mc is per-1k; crm is per-1M. Multiply mc by 1000 to compare.
      const mcIn = mc.promptCostPer1k * 1000;
      const mcOut = mc.completionCostPer1k * 1000;
      expect(
        mcIn,
        `${alias} input ($/1M tokens): mission-control src/budget/pricing.ts = ${mcIn}, CRM ${CRM_BUDGET_PATH} = ${crm!.input}`,
      ).toBeCloseTo(crm!.input, 4);
      expect(
        mcOut,
        `${alias} output ($/1M tokens): mission-control src/budget/pricing.ts = ${mcOut}, CRM ${CRM_BUDGET_PATH} = ${crm!.output}`,
      ).toBeCloseTo(crm!.output, 4);
    });
  }
});
