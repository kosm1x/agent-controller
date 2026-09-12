/**
 * Write-time gate refusals, by source and reason class. Registered on the
 * default prom-client registry that src/observability/prometheus.ts serves.
 */
import client from "prom-client";

/** plan = planner goal (abandoned row) · spec = API/CLI payload (rejected) · declare = the declareGates floor caught a producer that skipped validation. */
export type GateRefusalSource = "plan" | "spec" | "declare";
export type GateRefusalReason = "literal_check" | "unsettleable_expect";

const NAME = "mc_gate_refusals_total";

// Idempotent: a second module identity (dual specifier, resetModules) must
// reuse the registered counter, not throw "already registered" (qa W2).
export const gateRefusalsTotal =
  (client.register.getSingleMetric(NAME) as client.Counter<"source" | "reason"> | undefined) ??
  new client.Counter({
    name: NAME,
    help: "Honest-Done gate specs refused at write time (plan = abandoned row, spec = rejected payload, declare = floor), by reason class",
    labelNames: ["source", "reason"] as const,
  });

export function countGateRefusal(
  source: GateRefusalSource,
  reason: GateRefusalReason,
): void {
  gateRefusalsTotal.inc({ source, reason });
}
