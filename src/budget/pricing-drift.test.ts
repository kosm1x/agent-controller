/**
 * Cross-repo pricing drift test (W5 audit fix, 2026-05-07).
 *
 * mc and crm-azteca each maintain their own pricing tables — the same
 * Fireworks aliases must match across both, or cost reports diverge by
 * model and the operator can't reconcile mc vs CRM spend. This test
 * reads the CRM budget.ts source as text and asserts the Fireworks
 * p-notation entries (input × 1000 == mc's promptCostPer1k × 1000)
 * agree numerically. Catches drift on next provider migration.
 *
 * Skipped when crm-azteca isn't co-located on disk (CI sandboxes,
 * isolated checkouts).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { getPricing } from "./pricing.js";

const CRM_BUDGET_PATH = "/root/claude/crm-azteca/crm/src/budget.ts";

const FIREWORKS_ALIASES = [
  "minimax-m2p7",
  "kimi-k2p5",
  "kimi-k2p6",
  "qwen3p6-plus",
  "glm-5p1",
  "deepseek-v4-pro",
] as const;

interface CrmRate {
  input: number;
  output: number;
}

function parseCrmRate(src: string, alias: string): CrmRate | null {
  // CRM budget.ts uses per-million-token rates: { input: 0.3, output: 1.2 }
  const re = new RegExp(
    `"${alias}":\\s*\\{\\s*input:\\s*([\\d.]+)\\s*,\\s*output:\\s*([\\d.]+)`,
  );
  const m = src.match(re);
  if (!m) return null;
  return { input: parseFloat(m[1]), output: parseFloat(m[2]) };
}

describe("budget pricing drift", () => {
  if (!existsSync(CRM_BUDGET_PATH)) {
    it.skip("crm-azteca not co-located, skipping drift check", () => {});
    return;
  }

  const crmSrc = readFileSync(CRM_BUDGET_PATH, "utf-8");

  for (const alias of FIREWORKS_ALIASES) {
    it(`mc and crm agree on Fireworks alias '${alias}'`, () => {
      const mc = getPricing(alias);
      const crm = parseCrmRate(crmSrc, alias);
      expect(crm, `${alias} missing from CRM pricing table`).not.toBeNull();
      // mc is per-1k; crm is per-1M. Multiply mc by 1000 to compare.
      expect(mc.promptCostPer1k * 1000).toBeCloseTo(crm!.input, 4);
      expect(mc.completionCostPer1k * 1000).toBeCloseTo(crm!.output, 4);
    });
  }
});
