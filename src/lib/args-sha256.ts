/**
 * Exact-action identity for a gated call's args. A leaf module so the
 * execution context (queue 4l dedup) and the confirmation store share one
 * definition without an import cycle.
 */
import { createHash } from "crypto";

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Exact-action identity: sha256 over sorted-key JSON (order-insensitive, lossless). */
export function argsSha256(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}
