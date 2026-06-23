/**
 * Pure display formatters for the `mc-ctl judgments` inspector
 * (`scripts/judgments.ts`). Extracted so the defensive JSON-parsing contracts
 * — which degrade on null/malformed producer blobs — are unit-testable without
 * importing the self-executing script. No I/O, no DB.
 */

const CONF_SHORT: Record<string, string> = {
  green: "grn",
  yellow: "yel",
  red: "red",
};

/** Three-letter confidence tag for the list view; "—" when unset. */
export function confShort(confidence: string | null): string {
  if (!confidence) return "—";
  return CONF_SHORT[confidence] ?? confidence;
}

/** Relative age of an ISO timestamp, coarse-grained (s/m/h/d). "?" if unparseable. */
export function relAge(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "?";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Right-pad to a fixed width (never truncates — layout only). */
export function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Collapse whitespace and cap at n chars (… elision). */
export function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : flat.slice(0, n - 1) + "…";
}

/** Parse the producer's `critic_trail_json` for its terminal verdict (mirrors
 *  the §17 gate's parse). Returns "—" when absent/malformed/verdict-less. */
export function criticVerdict(json: string | null): string {
  if (!json) return "—";
  try {
    const t: unknown = JSON.parse(json);
    const v = (t as { verdict?: unknown }).verdict;
    return typeof v === "string" ? v : "—";
  } catch {
    return "—";
  }
}

/** Parse `confidence_basis_json` ({distinct_sources, contradiction_count,
 *  stale_count}) into a compact string for the detail view. */
export function confidenceBasis(json: string | null): string {
  if (!json) return "(no basis recorded)";
  try {
    const b = JSON.parse(json) as {
      distinct_sources?: number;
      contradiction_count?: number;
      stale_count?: number;
    };
    return `sources=${b.distinct_sources ?? "?"} contradictions=${b.contradiction_count ?? "?"} stale=${b.stale_count ?? "?"}`;
  } catch {
    return "(unparseable basis)";
  }
}

/** Render proposed RAPID-D options. Each item carries a one-letter `label` (the
 *  tag) + a `summary` (the substance); fall back to A/B/C index tags and a
 *  best-effort body. Degrades to [] on null / non-array / malformed JSON. */
export function renderOptions(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr: unknown = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr.map((o, i) => {
      const fallbackTag = String.fromCharCode(65 + i); // A, B, C
      if (o && typeof o === "object") {
        const obj = o as Record<string, unknown>;
        const tag =
          typeof obj.label === "string" && obj.label.length <= 3
            ? obj.label
            : fallbackTag;
        const body =
          (typeof obj.summary === "string" && obj.summary) ||
          (typeof obj.title === "string" && obj.title) ||
          (typeof obj.label === "string" && obj.label) ||
          truncate(JSON.stringify(o), 160);
        return `${tag}. ${truncate(String(body), 160)}`;
      }
      return `${fallbackTag}. ${truncate(String(o), 160)}`;
    });
  } catch {
    return [];
  }
}
