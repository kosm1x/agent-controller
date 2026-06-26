/**
 * V8.3 Phase 2 — ODD (Operational Design Domain) evaluator.
 *
 * Deterministic, no-LLM evaluation of an `ODDPredicate` against a constructed
 * decision-context object. Per spec §6 (R2 #3), predicates are NOT evaluated
 * against raw table columns but against an object the resolver assembles, whose
 * `field`s are dotted paths (e.g. "task.priority", "edit_kind", "days_extended").
 *
 * Fail-safe rule: a missing field, or a non-numeric value in a numeric
 * comparison, fails its leaf. Uncertainty ⇒ out-of-ODD ⇒ the decision falls back
 * to operator confirmation rather than acting autonomously on bad data.
 */

import type { ODDPredicate } from "./types.js";

/**
 * The constructed decision-context an ODD predicate is evaluated against.
 * Free-form nested map — some fields are pipeline-derived, not columns.
 */
export type DecisionContext = Record<string, unknown>;

/**
 * Resolve a dotted field path ("task.priority") against the context object.
 * Returns `undefined` for any missing/non-object segment (treated as out-of-ODD).
 */
export function resolveField(context: DecisionContext, field: string): unknown {
  let cursor: unknown = context;
  for (const segment of field.split(".")) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/** Structural equality for ODD leaf comparisons (primitives, arrays, plain objects). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined)
    return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/** Hour (0-23) of `date` in the given IANA timezone. */
function hourInZone(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    hour12: false,
    timeZone: tz,
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  // Intl can emit "24" for midnight under hour12:false — normalize to 0.
  return h === 24 ? 0 : h;
}

/**
 * Evaluate an ODD predicate against a decision context. Returns true iff the
 * context is INSIDE the operational design domain.
 *
 * @param now injected clock for `time_window` leaves (defaults to current time)
 */
export function evaluateODD(
  predicate: ODDPredicate,
  context: DecisionContext,
  now: Date = new Date(),
): boolean {
  switch (predicate.op) {
    case "eq":
      return deepEqual(resolveField(context, predicate.field), predicate.value);
    case "neq":
      return !deepEqual(
        resolveField(context, predicate.field),
        predicate.value,
      );
    case "lt":
    case "gt":
    case "lte":
    case "gte": {
      const raw = resolveField(context, predicate.field);
      // fail-safe: a non-number on either side falls out of the ODD
      if (typeof raw !== "number" || typeof predicate.value !== "number") {
        return false;
      }
      if (predicate.op === "lt") return raw < predicate.value;
      if (predicate.op === "gt") return raw > predicate.value;
      if (predicate.op === "lte") return raw <= predicate.value;
      return raw >= predicate.value;
    }
    case "in": {
      const raw = resolveField(context, predicate.field);
      return predicate.values.some((v) => deepEqual(raw, v));
    }
    case "and":
      return predicate.clauses.every((c) => evaluateODD(c, context, now));
    case "or":
      return predicate.clauses.some((c) => evaluateODD(c, context, now));
    case "not":
      return !evaluateODD(predicate.clause, context, now);
    case "time_window": {
      const h = hourInZone(now, predicate.tz);
      // Non-wrapping window (start<=end): [start, end). Wrapping (e.g. 22..6):
      // h>=start OR h<end.
      return predicate.start_hour <= predicate.end_hour
        ? h >= predicate.start_hour && h < predicate.end_hour
        : h >= predicate.start_hour || h < predicate.end_hour;
    }
    default:
      // Compile-time exhaustiveness; a malformed op from JSON fails safe.
      return ((_x: never) => false)(predicate);
  }
}
