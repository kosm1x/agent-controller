/**
 * v7.14 — infographic_generate tool.
 *
 * Editorial data-storytelling via AntV Infographic (@antv/infographic).
 * Uses the package's `/ssr` subpath to render in pure Node (linkedom DOM
 * shim) — no Chromium, no puppeteer, no network. Output is SVG text
 * written to /tmp or /workspace.
 *
 * Dispatch decision:
 *  1. `data` provided → renderToString({ template, data, theme, ... })
 *     — skips LLM; caller already structured the content
 *  2. `description` starts with `infographic ` → renderToString(dsl, ...)
 *     — raw DSL short-circuit; skips LLM
 *  3. Else → LLM converts NL → AntV DSL with curated-template hints,
 *     then renderToString(dsl, ...)
 *
 * Security: pure in-process JS (no execFile, no shell). Output path
 * absolute + canonical + under /tmp or /workspace. Description capped
 * at MAX_DESCRIPTION_CHARS. Template name validated against the full
 * runtime catalog to block typos or injection attempts.
 */

import { writeFileSync, statSync, renameSync, unlinkSync } from "node:fs";
import { resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tool } from "../types.js";
import { infer } from "../../inference/adapter.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DESCRIPTION_CHARS = 8000;

const OUTPUT_ALLOW_PREFIXES = ["/tmp/", "/workspace/"];

const THEMES = ["light", "dark", "hand-drawn"] as const;
type Theme = (typeof THEMES)[number];

const EMIT_MODES = ["render", "source"] as const;
type EmitMode = (typeof EMIT_MODES)[number];

/**
 * Curated 15-template subset of AntV's 276. These cover the Jarvis use
 * cases identified in the roadmap: briefing cards, KPI grids, comparisons,
 * timelines, rankings, charts-with-narrative. The tool description lists
 * these for LLM prompt guidance; the handler validates against the full
 * runtime catalog (`getTemplates()`) so exotic templates remain reachable
 * when an LLM picks one outside the curation.
 */
const CURATED_TEMPLATES: Array<{ name: string; useCase: string }> = [
  { name: "list-row-simple-horizontal-arrow", useCase: "step flow / process" },
  { name: "list-column-done-list", useCase: "checklist / status list" },
  { name: "list-grid-badge-card", useCase: "KPI grid (badge cards)" },
  { name: "list-grid-candy-card-lite", useCase: "KPI grid (lite)" },
  { name: "compare-binary-horizontal-simple-fold", useCase: "A/B comparison" },
  {
    name: "compare-quadrant-quarter-simple-card",
    useCase: "2x2 quadrant matrix",
  },
  { name: "compare-swot", useCase: "SWOT analysis" },
  { name: "list-row-horizontal-icon-arrow", useCase: "horizontal timeline" },
  { name: "list-zigzag-up-compact-card", useCase: "zigzag sequence" },
  {
    name: "list-pyramid-rounded-rect-node",
    useCase: "pyramid / hierarchy ranking",
  },
  { name: "list-sector-simple", useCase: "radial ranking" },
  {
    name: "hierarchy-mindmap-branch-gradient-lined-palette",
    useCase: "mindmap",
  },
  { name: "hierarchy-structure", useCase: "org / system structure" },
  { name: "chart-pie-compact-card", useCase: "pie chart + card" },
  { name: "chart-column-simple", useCase: "column / bar chart" },
];

function isUnderPrefix(abs: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => abs.startsWith(p));
}

function resolveOutputPath(
  outputRaw: string | undefined,
): { ok: true; abs: string } | { ok: false; error: string } {
  if (!outputRaw) {
    return { ok: true, abs: `/tmp/infographic-${randomUUID()}.svg` };
  }
  if (!outputRaw.startsWith("/")) {
    return { ok: false, error: "output_path must be absolute" };
  }
  const abs = resolve(outputRaw);
  if (abs !== outputRaw) {
    return { ok: false, error: "output_path must be canonical" };
  }
  if (!isUnderPrefix(abs, OUTPUT_ALLOW_PREFIXES)) {
    return {
      ok: false,
      error: `output_path must be under one of: ${OUTPUT_ALLOW_PREFIXES.join(", ")}`,
    };
  }
  return { ok: true, abs };
}

function looksLikeAntvDsl(text: string): boolean {
  return /^infographic\s+[\w-]+/.test(text.trim());
}

/** NL → AntV DSL via LLM. Description capped + template/theme hints in
 *  the system prompt. Strips accidental code fences. */
async function nlToAntvDsl(
  description: string,
  template: string | undefined,
  theme: Theme,
): Promise<string> {
  const curatedList = CURATED_TEMPLATES.map(
    (t) => `  - ${t.name} (${t.useCase})`,
  ).join("\n");

  const templateHint = template
    ? `\nTemplate: ${template} (required — use exactly this one).`
    : `\nTemplate: choose the most appropriate from the curated list below. Prefer list-grid-badge-card for KPI grids, compare-binary-horizontal-simple-fold for A/B, list-row-simple-horizontal-arrow for step flows.`;

  const sys = `You are an AntV Infographic DSL generator. Output ONLY the DSL — no markdown fences, no explanation.

DSL SHAPE (indent-based, two spaces):
infographic <template-name>
theme ${theme}
data
  <field>
    - <item> <value>
      <sub-field> <value>
    - <item> <value>

EXAMPLE (step flow, 3 items):
infographic list-row-simple-horizontal-arrow
theme ${theme}
data
  lists
    - label Step 1
      desc Start
    - label Step 2
      desc In Progress
    - label Step 3
      desc Complete

Curated templates (prefer these):
${curatedList}
${templateHint}

Return only the DSL starting with "infographic ". No preamble.`;

  const response = await infer({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: description.slice(0, MAX_DESCRIPTION_CHARS) },
    ],
    temperature: 0.3,
    max_tokens: 2000,
  });
  const text = (response.content ?? "").trim();
  const fenceMatch = text.match(/```(?:antv|dsl)?\s*([\s\S]*?)\s*```/);
  return (fenceMatch?.[1] ?? text).trim();
}

/** Lazy-load the renderer + catalog. Imports only when the tool executes,
 *  keeping boot-time TypeScript compilation simple. */
async function loadAntv() {
  const [ssr, main] = await Promise.all([
    import("@antv/infographic/ssr"),
    import("@antv/infographic"),
  ]);
  return {
    renderToString: ssr.renderToString,
    getTemplates: main.getTemplates as () => string[],
  };
}

export const infographicGenerateTool: Tool = {
  name: "infographic_generate",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "infographic_generate",
      description: `Generate an editorial infographic (SVG) via AntV Infographic. Use for visual briefings, KPI summaries, comparison tables, step flows, ranking charts, and other data-storytelling where a text wall would be worse.

USE WHEN:
- Summary / hero moments in a briefing where a visual compresses 5+ items into one glance
- KPI grids for daily/weekly recaps
- Comparisons (A/B, SWOT, quadrant matrix)
- Timelines / process steps
- Rankings / leaderboards

DO NOT USE for:
- Data charts with precise numeric axes → use \`chart_generate\` (QuickChart)
- System / architecture diagrams → use \`diagram_generate\` (graphviz / svg_html)
- Text-heavy content that benefits from prose → just write text
- Every briefing — infographics are for the hero/summary moment, not every paragraph

CURATED TEMPLATE RECOMMENDATIONS (15 from AntV's full 276):
${CURATED_TEMPLATES.map((t) => `- ${t.name} → ${t.useCase}`).join("\n")}

You can also specify any of AntV's 276 templates by exact name; validated at runtime against the full catalog.

PARAMS:
- description: NL describing the infographic, OR raw AntV DSL (starts with "infographic <template>"), OR a JSON options literal
- template: optional exact template name (validated against full 276)
- theme: "light" | "dark" | "hand-drawn" (default "dark")
- data: optional structured data object — if provided, skips LLM and renders directly
- output_path: absolute under /tmp or /workspace (default /tmp/infographic-<uuid>.svg)
- emit: "render" (default) | "source" (returns DSL text without rendering)
- width / height: optional canvas dimensions

Output is SVG. Raw DSL bypasses the LLM; structured \`data\` also bypasses the LLM. Output file is overwritten if present.`,
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "Describe the infographic (NL) OR provide raw AntV DSL ('infographic <template>\\ndata\\n...'). NL runs through the LLM.",
          },
          template: {
            type: "string",
            description:
              "Optional exact template name. Validated against the full AntV catalog. If omitted, the LLM picks from the curated list.",
          },
          theme: {
            type: "string",
            enum: [...THEMES],
            description: "Color theme. Default 'dark'.",
          },
          data: {
            type: "object",
            description:
              "Structured data object matching the template's expected schema. If supplied, the LLM is bypassed entirely and the renderer uses this data directly.",
          },
          output_path: {
            type: "string",
            description:
              "Optional absolute path under /tmp/ or /workspace/. Defaults to /tmp/infographic-<uuid>.svg.",
          },
          emit: {
            type: "string",
            enum: [...EMIT_MODES],
            description:
              "'render' writes SVG (default). 'source' returns DSL text without rendering.",
          },
          width: {
            type: "number",
            description: "Canvas width in pixels. Optional.",
          },
          height: {
            type: "number",
            description: "Canvas height in pixels. Optional.",
          },
        },
        required: ["description"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const description =
      typeof args.description === "string" ? args.description : "";
    const template =
      typeof args.template === "string" ? args.template : undefined;
    const theme = (args.theme as Theme) ?? "dark";
    const emit = (args.emit as EmitMode) ?? "render";
    const outputRaw = args.output_path as string | undefined;
    const data = args.data as Record<string, unknown> | undefined;
    const width =
      typeof args.width === "number" &&
      Number.isFinite(args.width) &&
      args.width > 0 &&
      args.width < 10000
        ? args.width
        : undefined;
    const height =
      typeof args.height === "number" &&
      Number.isFinite(args.height) &&
      args.height > 0 &&
      args.height < 10000
        ? args.height
        : undefined;

    if (!description.trim() && !data) {
      return JSON.stringify({
        error: "description required (or provide structured data)",
      });
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      return JSON.stringify({
        error: `description too long (${description.length} chars, max ${MAX_DESCRIPTION_CHARS})`,
      });
    }
    if (!THEMES.includes(theme)) {
      return JSON.stringify({
        error: `theme must be one of: ${THEMES.join(", ")}`,
      });
    }
    if (!EMIT_MODES.includes(emit)) {
      return JSON.stringify({
        error: `emit must be one of: ${EMIT_MODES.join(", ")}`,
      });
    }

    const outputCheck = resolveOutputPath(outputRaw);
    if (!outputCheck.ok) return JSON.stringify({ error: outputCheck.error });

    let antv: Awaited<ReturnType<typeof loadAntv>>;
    try {
      antv = await loadAntv();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: `@antv/infographic not available: ${msg}. Run \`npm install @antv/infographic@0.2.17\`.`,
      });
    }

    if (template !== undefined) {
      const allTemplates = antv.getTemplates();
      if (!allTemplates.includes(template)) {
        return JSON.stringify({
          error: `template "${template}" not found. 276 templates available; see the curated list in the tool description for common options.`,
        });
      }
    }

    const start = Date.now();

    // Pick dispatch strategy
    let dslOrOptions: string | Record<string, unknown>;
    let dispatchMode: "data" | "dsl" | "llm";
    if (data) {
      dispatchMode = "data";
      dslOrOptions = {
        data,
        ...(template ? { template } : {}),
        theme,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      };
    } else if (looksLikeAntvDsl(description)) {
      dispatchMode = "dsl";
      dslOrOptions = description;
    } else {
      dispatchMode = "llm";
      try {
        dslOrOptions = await nlToAntvDsl(description, template, theme);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return JSON.stringify({
          error: `LLM DSL generation failed: ${msg}`,
        });
      }
    }

    if (emit === "source") {
      if (typeof dslOrOptions === "string") {
        return `infographic_generate (dsl source, mode=${dispatchMode}):
${dslOrOptions}`;
      }
      return `infographic_generate (options source, mode=${dispatchMode}):
${JSON.stringify(dslOrOptions, null, 2)}`;
    }

    // Render with outer timeout guard. AntV has a 10s internal timeout; our
    // 30s belt-and-suspenders surfaces a cleaner error message if something
    // else in the render path hangs.
    let svg: string;
    try {
      const init = {
        theme,
        ...(width ? { width } : {}),
        ...(height ? { height } : {}),
      };
      const renderPromise =
        typeof dslOrOptions === "string"
          ? antv.renderToString(dslOrOptions, init)
          : antv.renderToString(dslOrOptions);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("outer render timeout (30s)")),
          DEFAULT_TIMEOUT_MS,
        ),
      );
      svg = await Promise.race([renderPromise, timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        error: `renderToString failed: ${msg}`,
        mode: dispatchMode,
      });
    }

    // Write via tmp + rename for atomic visibility. Matches the v7.10 /
    // v7.12 pattern. Fallback to direct write on cross-fs EXDEV.
    const tmpPath = `/tmp/infographic-tmp-${randomUUID()}.svg`;
    writeFileSync(tmpPath, svg, "utf8");
    try {
      renameSync(tmpPath, outputCheck.abs);
    } catch {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort */
      }
      writeFileSync(outputCheck.abs, svg, "utf8");
    }

    const bytes = statSync(outputCheck.abs).size;
    return `infographic_generate: ${dispatchMode}-mode
  output: ${outputCheck.abs}
  bytes:  ${bytes}
  dur_ms: ${Date.now() - start}
  template: ${template ?? "(inferred by LLM or dsl)"}
  theme: ${theme}`;
  },
};

void basename;
export {
  CURATED_TEMPLATES as _CURATED_TEMPLATES,
  looksLikeAntvDsl as _looksLikeAntvDsl,
  THEMES as _THEMES,
};
