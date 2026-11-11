/**
 * Shape of monitoring/alerts.yml, the rules the alert poller turns into owner
 * messages. The repository has no YAML parser dependency, so this reads the
 * file's regular layout line by line: every `- alert:` entry is one rule, and
 * its `expr`, `for`, `labels.severity` and `annotations.summary` follow it at
 * deeper indentation. The poller sends `summary` (or `description`) to the
 * owner and keys reminders off `severity`, so a rule without them pages badly.
 * The same reader flags structure damage inside a rule (see parseRules).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface RuleBlock {
  group: string;
  alert: string;
  expr: string;
  for: string | null;
  severity: string | null;
  summary: string | null;
  /** Structure damage found inside this rule (duplicate key, wrong indent). */
  problems: string[];
}

/** The keys a rule may carry beside `alert`, all at the indent of `alert`. */
const RULE_KEYS = new Set([
  "expr",
  "for",
  "keep_firing_for",
  "labels",
  "annotations",
]);

const BAD_LINE_HINT = `rule keys (${[...RULE_KEYS].join(", ")}) sit at the indent of "alert"; label and annotation keys two spaces deeper; a new rule field of the monitoring server goes in RULE_KEYS`;

const TEXT = readFileSync(
  new URL("../../monitoring/alerts.yml", import.meta.url),
  "utf8",
);

function unquote(v: string): string {
  const t = v.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith("'") && t.endsWith("'")) ||
      (t.startsWith('"') && t.endsWith('"')))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Structure rule, checked on every line of a rule after its `- alert:` line:
 * a key line sits either at the indent of `alert` (after the `- `) and is one
 * of RULE_KEYS, or exactly two spaces deeper directly under `labels` /
 * `annotations`; no key appears twice at the same level of one rule. Keys are
 * `[a-z_][a-z0-9_]*`. The only other lines accepted are comments, blank
 * lines, and the body of a block scalar (a value of `|`, `|-`, `>` or `>-`,
 * plus the `+` forms): every following line indented deeper than its key.
 */
function parseRules(text: string): RuleBlock[] {
  const lines = text.split("\n");
  const rules: RuleBlock[] = [];
  let group = "";
  let current: RuleBlock | null = null;
  let section: "labels" | "annotations" | null = null;
  let block: { indent: number; key: "expr" | "summary" | null } | null = null;
  let keyIndent = 0;
  const seen = new Map<string, Set<string>>();

  for (const line of lines) {
    if (/^\s*#/.test(line) || line.trim() === "") continue;
    const indent = line.length - line.trimStart().length;

    if (block && current) {
      if (indent > block.indent) {
        const k = block.key;
        if (k) current[k] = (current[k] ? current[k] + "\n" : "") + line.trim();
        continue;
      }
      block = null;
    }

    const g = /^\s*- name: (.+)$/.exec(line);
    if (g) {
      group = g[1].trim();
      current = null;
      continue;
    }
    const a = /^(\s*)- alert: (.+)$/.exec(line);
    if (a) {
      current = {
        group,
        alert: a[2].trim(),
        expr: "",
        for: null,
        severity: null,
        summary: null,
        problems: [],
      };
      rules.push(current);
      section = null;
      keyIndent = a[1].length + 2;
      seen.clear();
      continue;
    }
    if (!current) continue;
    const kv = /^\s*([a-z_][a-z0-9_]*):(?:\s(.*))?$/.exec(line);
    const key = kv?.[1] ?? "";
    const value = kv?.[2] ?? "";
    const level: "rule" | "labels" | "annotations" | null =
      indent === keyIndent && RULE_KEYS.has(key)
        ? "rule"
        : indent === keyIndent + 2 && section
          ? section
          : null;
    if (!kv || !level) {
      current.problems.push(
        `bad line ${JSON.stringify(line.trim())} — ${BAD_LINE_HINT}`,
      );
      continue;
    }
    if (level === "rule") section = null;
    const keys: Set<string> = seen.get(level) ?? new Set<string>();
    if (keys.has(key))
      current.problems.push(
        `duplicate ${level} key "${key}" — a key appears once per level in a rule; the monitoring server refuses the whole file otherwise`,
      );
    keys.add(key);
    seen.set(level, keys);
    if (key === "labels" || key === "annotations") {
      section = key;
      continue;
    }
    if (/^[|>][-+]?$/.test(value.trim())) {
      const target =
        key === "expr" && level === "rule"
          ? "expr"
          : key === "summary" && level === "annotations"
            ? "summary"
            : null;
      if (target) current[target] = "";
      block = { indent, key: target };
      continue;
    }
    if (key === "expr") {
      section = null;
      current.expr = value.trim();
    } else if (key === "for") {
      section = null;
      current.for = value.trim();
    } else if (section === "labels" && key === "severity") {
      current.severity = value.trim();
    } else if (section === "annotations" && key === "summary") {
      current.summary = unquote(value);
    }
  }
  return rules;
}

const RULES = parseRules(TEXT);

describe("monitoring/alerts.yml", () => {
  it("has no tab characters (YAML indentation is spaces only)", () => {
    expect(TEXT.includes("\t")).toBe(false);
  });

  it("every rule has a name, an expression, a severity and a summary; names are unique", () => {
    expect(RULES.length).toBe(TEXT.match(/^\s*- alert: /gm)?.length);
    expect(RULES.length).toBeGreaterThan(0);
    for (const r of RULES) {
      expect(r.alert, `rule in group ${r.group}`).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
      expect(r.expr, r.alert).not.toBe("");
      expect(["warning", "critical"], r.alert).toContain(r.severity);
      expect(r.summary, r.alert).toBeTruthy();
    }
    const names = RULES.map((r) => r.alert);
    expect(new Set(names).size).toBe(names.length);
  });

  it("MCProviderFailing: a provider below 50% success over a fresh window of at least 5 calls, for 10m, warning", () => {
    const rule = RULES.find((r) => r.alert === "MCProviderFailing");
    expect(rule).toEqual({
      group: "mission-control",
      alert: "MCProviderFailing",
      expr:
        "mc_provider_success_rate < 0.5 and on(provider) mc_provider_latency_avg_ms and on(provider) mc_provider_requests_total >= 5",
      for: "10m",
      severity: "warning",
      summary: expect.stringContaining("{{ $labels.provider }}"),
      problems: [],
    });
  });

  // The monitoring server refuses a rules file with a duplicate key or broken
  // indentation, which silences every rule in it, not just the damaged one.
  it("inside every rule, each key sits at its level's indent and no key repeats at the same level", () => {
    for (const r of RULES) expect(r.problems, r.alert).toEqual([]);
  });
});
