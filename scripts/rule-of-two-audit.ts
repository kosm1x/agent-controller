/**
 * rule-of-two-audit.ts — V8.5 Phase 5.2 Rule-of-Two audit (mc-ctl rule-of-two).
 *
 * WHAT: renders the per-tool Rule-of-Two matrix ([A] untrusted input · [B]
 * sensitive access · [C] state change) over the tool registry, lists the
 * single-tool trifectas and their structural risk-tier delta, flags anything
 * that fell to the unclassified true/true default, checks the live
 * `capability_autonomy` rows against the structural L1 cap, and runs the
 * Layer-2a RETROSPECTIVE over the last N days of `task_trace_events`: how many
 * runs held A∧B∧C, which C tools were the terminal edge once A∧B was already
 * established, and how many of those edges are gated V8.3 capabilities.
 *
 * SOURCE OF TRUTH: the LIVE registry via `GET /api/admin/tool-annotations`
 * (needs `MC_API_KEY`; mc-ctl passes it). `--offline` builds the HOST registry
 * in-process instead (all builtin groups + Google/Memory/Skills sources; no MCP
 * connections) — the same population `rule-of-two.test.ts` covers.
 *
 * DB: opened READ-ONLY (better-sqlite3 `readonly`) so a running service is
 * never contended for writes. Never mutates anything.
 *
 * Usage:
 *   npx tsx scripts/rule-of-two-audit.ts [--offline] [--days N] [--write]
 *     --write   also writes docs/audit/rule-of-two-matrix-<YYYY-MM-DD>.md
 */

import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import { ToolRegistry } from "../src/tools/registry.js";
import { getToolAnnotations } from "../src/tools/types.js";
import {
  isRuleOfTwoClassified,
  resolveRuleOfTwo,
} from "../src/tools/rule-of-two.js";
import { CAPABILITY_BY_TOOL } from "../src/lib/v8-3/gated-execution.js";
import { CAPABILITY_SEEDS, structuralMaxLevel } from "../src/lib/v8-3/seed.js";
import type { ToolAnnotations } from "../src/tools/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = join(ROOT, "data", "mc.db");
const API_URL = process.env.API_URL ?? "http://localhost:8080";

interface ToolRow extends ToolAnnotations {
  name: string;
  declaredRiskTier: "low" | "medium" | "high";
  classified: boolean;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  if (i < 0) return undefined;
  // `--days` as the LAST argv element must not silently default (qa R2).
  return i + 1 < process.argv.length ? process.argv[i + 1] : "";
}
const OFFLINE = process.argv.includes("--offline");
const WRITE = process.argv.includes("--write");
const DAYS = Number(arg("--days") ?? 30);
if (!Number.isFinite(DAYS) || DAYS <= 0) {
  // qa R1: `--days 30d` ⇒ NaN ⇒ datetime('now','-NaN days') is NULL ⇒ zero
  // rows ⇒ a report that reads exactly like a clean result. Refuse instead.
  console.error(`rule-of-two-audit: --days must be a positive number (got ${arg("--days")})`);
  process.exit(2);
}

async function liveTools(): Promise<ToolRow[]> {
  const key = process.env.MC_API_KEY;
  if (!key)
    throw new Error("MC_API_KEY not set (mc-ctl passes it; or use --offline)");
  const res = await fetch(`${API_URL}/api/admin/tool-annotations`, {
    headers: { "X-Api-Key": key },
  });
  if (!res.ok) throw new Error(`live registry HTTP ${res.status}`);
  const body = (await res.json()) as { tools: ToolRow[] };
  return body.tools;
}

async function offlineTools(): Promise<ToolRow[]> {
  const { BUILTIN_TOOLS, WP_TOOLS, CRM_TOOLS, GWS_TOOLS } =
    await import("../src/tools/sources/builtin.js");
  const { GoogleToolSource } = await import("../src/tools/sources/google.js");
  const { MemoryToolSource } = await import("../src/tools/sources/memory.js");
  const { SkillsToolSource } = await import("../src/tools/sources/skills.js");
  const registry = new ToolRegistry();
  for (const t of [...BUILTIN_TOOLS, ...WP_TOOLS, ...CRM_TOOLS, ...GWS_TOOLS])
    registry.register(t);
  await new GoogleToolSource().registerTools(registry);
  await new MemoryToolSource().registerTools(registry);
  await new SkillsToolSource().registerTools(registry);
  return registry.list().map((name) => {
    const t = registry.get(name)!;
    return {
      name,
      ...getToolAnnotations(t),
      declaredRiskTier: t.riskTier ?? (t.requiresConfirmation ? "high" : "low"),
      classified:
        t.untrustedInputHint !== undefined ||
        t.sensitiveAccessHint !== undefined ||
        isRuleOfTwoClassified(name),
    };
  });
}

function yn(b: boolean): string {
  return b ? "●" : "·";
}

/**
 * SDK-native tools that never enter the registry but DO appear in
 * `task_trace_events`. `ToolSearch` is the API-side catalog lookup (returns
 * tool schemas): no third-party prose, no private data, no state change.
 */
const SDK_NATIVE: Record<string, { A: boolean; B: boolean; C: boolean }> = {
  ToolSearch: { A: false, B: false, C: false },
};

/** Trace names arrive SDK-namespaced from the MCP bridge (`mcp__jarvis__<tool>`). */
function bareName(n: string): string {
  return n.replace(/^mcp__jarvis__/, "");
}

interface RunAgg {
  taskId: string;
  /** Every call in order (NOT deduped — the terminal-edge scan needs a C tool
   *  called AFTER A∧B armed even if the same tool was also called before). */
  calls: string[];
}

function retrospective(
  db: Database.Database,
  byName: Map<string, ToolRow>,
): string[] {
  const out: string[] = [];
  const rows = db
    .prepare(
      `SELECT task_id, tool FROM task_trace_events
        WHERE name = 'tool.called' AND ts > datetime('now', ?) AND tool IS NOT NULL
        ORDER BY task_id, id`,
    )
    .all(`-${DAYS} days`) as Array<{ task_id: string; tool: string }>;
  const runs = new Map<string, RunAgg>();
  for (const r of rows) {
    let run = runs.get(r.task_id);
    if (!run) runs.set(r.task_id, (run = { taskId: r.task_id, calls: [] }));
    run.calls.push(bareName(r.tool));
  }
  // Resolution ladder for a trace name: registry snapshot → SDK-native table →
  // classification/prefix default for A/B with C=unknown⇒true (conservative).
  const defaulted = new Map<string, number>();
  const props = (n: string): { A: boolean; B: boolean; C: boolean } => {
    const t = byName.get(n);
    if (t) return { A: t.untrustedInputHint, B: t.sensitiveAccessHint, C: !t.readOnlyHint };
    if (Object.hasOwn(SDK_NATIVE, n)) return SDK_NATIVE[n];
    defaulted.set(n, (defaulted.get(n) ?? 0) + 1);
    const cls = resolveRuleOfTwo({ name: n });
    return { A: cls.untrustedInput, B: cls.sensitiveAccess, C: true };
  };
  let withA = 0,
    withB = 0,
    withC = 0,
    trifecta = 0,
    trifectaGated = 0;
  const terminalC = new Map<string, number>();
  const aSources = new Map<string, number>(); // which tools SUPPLIED [A] in trifecta runs
  for (const run of runs.values()) {
    let a = false,
      b = false,
      c = false,
      armed = false,
      gatedHere = false;
    const edges = new Set<string>();
    const aHere = new Set<string>();
    for (const n of run.calls) {
      const p = props(n);
      if (p.A) aHere.add(n);
      a ||= p.A;
      b ||= p.B;
      c ||= p.C;
      if (a && b) armed = true;
      // Terminal edge: a C tool invoked at/after the point A∧B was established.
      if (armed && p.C) edges.add(n);
    }
    if (a) withA++;
    if (b) withB++;
    if (c) withC++;
    if (!(a && b && c)) continue;
    trifecta++;
    for (const n of aHere) aSources.set(n, (aSources.get(n) ?? 0) + 1);
    for (const n of edges) {
      terminalC.set(n, (terminalC.get(n) ?? 0) + 1);
      if (Object.hasOwn(CAPABILITY_BY_TOOL, n)) gatedHere = true;
    }
    if (gatedHere) trifectaGated++;
  }
  const total = runs.size;
  const pct = (n: number) => (total ? ((100 * n) / total).toFixed(1) : "0.0");
  out.push(`## Layer 2a — retrospective (last ${DAYS}d of task_trace_events)`);
  out.push("");
  out.push(`- runs with ≥1 tool call: **${total}** (${rows.length} tool.called rows)`);
  out.push(`- runs holding [A]: ${withA} (${pct(withA)}%) · [B]: ${withB} (${pct(withB)}%) · [C]: ${withC} (${pct(withC)}%)`);
  out.push(`- runs holding **A∧B∧C (trifecta): ${trifecta} (${pct(trifecta)}%)** — of which **${trifectaGated}** had a GATED V8.3 capability as a terminal edge`);
  if (defaulted.size) {
    out.push(`- names not in the registry snapshot, resolved from the classification/prefix table with C assumed (conservative): ${[...defaulted.entries()].map(([n, k]) => `\`${n}\`×${k}`).join(", ")}`);
  }
  out.push("");
  out.push("Terminal [C] edges once A∧B was already established (runs, top 15):");
  out.push("");
  out.push("| C tool | trifecta runs | gated capability |");
  out.push("|---|---:|---|");
  for (const [n, k] of [...terminalC.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15))
    out.push(`| \`${n}\` | ${k} | ${Object.hasOwn(CAPABILITY_BY_TOOL, n) ? CAPABILITY_BY_TOOL[n] : "—"} |`);
  out.push("");
  out.push("[A] sources in those trifecta runs (which tool brought the untrusted input; top 10):");
  out.push("");
  out.push("| A tool | trifecta runs |");
  out.push("|---|---:|");
  for (const [n, k] of [...aSources.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10))
    out.push(`| \`${n}\` | ${k} |`);
  out.push("");
  out.push(
    "Reading: the trifecta rate is the share of runs the doctrine would hand to a human at L≥2. " +
      "The run-level predicate (`rule_of_two` demotion) fires only when the terminal edge is a GATED " +
      "capability, so the bold count is the number of runs whose behavior changes at first promotion; " +
      "ungated edges (`shell_exec`, KB writes) stay on the existing confirm/scope gates.",
  );
  return out;
}

async function main(): Promise<void> {
  const tools = OFFLINE ? await offlineTools() : await liveTools();
  tools.sort((x, y) => x.name.localeCompare(y.name));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const today = new Date().toISOString().slice(0, 10);
  const L: string[] = [];
  L.push(
    `# Rule-of-Two matrix — ${today} (${OFFLINE ? "host registry, offline" : "LIVE registry"})`,
  );
  L.push("");
  L.push(
    "Generated by `mc-ctl rule-of-two` (`scripts/rule-of-two-audit.ts`). Doctrine + classification rules: `src/tools/rule-of-two.ts` header.",
  );
  L.push(
    "[A] untrusted input · [B] sensitive access · [C] state change (`!readOnlyHint`). ● = holds. Trifecta = A∧B∧C on ONE tool ⇒ structural `high`/confirm.",
  );
  L.push("");

  // ---- summary
  const cnt = (f: (t: ToolRow) => boolean) => tools.filter(f).length;
  const tri = tools.filter((t) => t.ruleOfTwoTrifecta);
  const unclassified = tools.filter((t) => !t.classified);
  L.push("## Summary");
  L.push("");
  L.push(
    `- tools: **${tools.length}** · [A] ${cnt((t) => t.untrustedInputHint)} · [B] ${cnt((t) => t.sensitiveAccessHint)} · [C] ${cnt((t) => !t.readOnlyHint)} · A∧B (reads that carry both): ${cnt((t) => t.untrustedInputHint && t.sensitiveAccessHint && t.readOnlyHint)}`,
  );
  L.push(
    `- single-tool trifectas: **${tri.length}** — ${tri.map((t) => `\`${t.name}\``).join(", ") || "none"}`,
  );
  L.push(
    `- structural tier delta (declared → effective): ${
      tri
        .filter((t) => t.declaredRiskTier !== "high")
        .map((t) => `\`${t.name}\` ${t.declaredRiskTier}→high`)
        .join(", ") || "none"
    }`,
  );
  L.push(
    `- unclassified (fell to true/true default): ${unclassified.length ? unclassified.map((t) => `\`${t.name}\``).join(", ") : "**0** ✓"}`,
  );
  L.push("");

  // ---- V8.3 capability rows vs structural cap
  L.push("## V8.3 capabilities vs the structural L1 cap");
  L.push("");
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch (e) {
    L.push(`- (mc.db not readable: ${(e as Error).message})`);
  }
  if (db) {
    const rows = db
      .prepare(
        "SELECT capability, level, gate_config_json FROM capability_autonomy ORDER BY capability",
      )
      .all() as Array<{
      capability: string;
      level: number;
      gate_config_json: string;
    }>;
    L.push(
      "| capability | live level | live max_level | structural cap | note |",
    );
    L.push("|---|---:|---:|---:|---|");
    for (const r of rows) {
      const seed = CAPABILITY_SEEDS.find((s) => s.capability === r.capability);
      const cap = seed ? structuralMaxLevel(seed) : null;
      let liveMax = "?";
      try {
        liveMax = String(
          (JSON.parse(r.gate_config_json) as { max_level?: number })
            .max_level ?? "?",
        );
      } catch {
        /* unparseable → shown as ? */
      }
      const drift = cap !== null && Number(liveMax) > cap;
      L.push(
        `| ${r.capability} | ${r.level} | ${liveMax} | ${cap ?? "—"} | ${drift ? "row admits more than the cap — promotion.ts + pipeline enforce the cap from code (INSERT OR IGNORE never rewrites)" : ""} |`,
      );
    }
    L.push("");
  }

  // ---- retrospective
  if (db) {
    L.push(...retrospective(db, byName));
    L.push("");
    db.close();
  }

  // ---- matrix
  L.push("## Matrix");
  L.push("");
  L.push(
    "| tool | A | B | C | trifecta | tier (declared→effective) | classified |",
  );
  L.push("|---|:-:|:-:|:-:|:-:|---|:-:|");
  for (const t of tools) {
    const tier =
      t.declaredRiskTier === t.riskTier
        ? t.riskTier
        : `${t.declaredRiskTier}→**${t.riskTier}**`;
    L.push(
      `| \`${t.name}\` | ${yn(t.untrustedInputHint)} | ${yn(t.sensitiveAccessHint)} | ${yn(!t.readOnlyHint)} | ${t.ruleOfTwoTrifecta ? "**●**" : "·"} | ${tier} | ${t.classified ? "✓" : "**default**"} |`,
    );
  }
  const md = L.join("\n") + "\n";
  process.stdout.write(md);
  if (WRITE) {
    const dir = join(ROOT, "docs", "audit");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, `rule-of-two-matrix-${today}.md`);
    writeFileSync(file, md);
    process.stderr.write(`\nwrote ${file}\n`);
  }
}

main().catch((e) => {
  console.error(`rule-of-two-audit: ${(e as Error).message}`);
  process.exit(1);
});
