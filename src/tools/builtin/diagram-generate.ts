/**
 * v7.12 — diagram_generate tool.
 *
 * Renders diagrams from a DSL (graphviz dot) or from natural language via
 * the LLM. Two formats at MVP: `graphviz` (binary dispatch via execFile)
 * and `svg_html` (pure inline LLM with the Cocoon palette + layout
 * prompt). Mermaid is deferred to v7.12.1 — its mmdc CLI hangs on this
 * VPS's puppeteer/Chromium combination.
 *
 * Security: `execFile(dot, [args...])` with argv array (no shell).
 * Output lands in /tmp or /workspace only. Description is capped at
 * 8000 chars before reaching either the LLM or dot. Generated DSL is
 * written to a fresh `/tmp` file by the handler — no user-supplied
 * path reaches the binary.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  writeFileSync,
  statSync,
  existsSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { resolve, basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { Tool } from "../types.js";
import { infer } from "../../inference/adapter.js";
import { svgHtmlSystemPrompt } from "./diagram-svg-prompt.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_DESCRIPTION_CHARS = 8000;

const OUTPUT_ALLOW_PREFIXES = ["/tmp/", "/workspace/"];

const FORMATS = ["graphviz", "svg_html"] as const;
type DiagramFormat = (typeof FORMATS)[number];

const DIAGRAM_TYPES = [
  "architecture",
  "flowchart",
  "sequence",
  "er",
  "class",
  "state",
] as const;
type DiagramType = (typeof DIAGRAM_TYPES)[number];

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

const EMIT_MODES = ["render", "source"] as const;
type EmitMode = (typeof EMIT_MODES)[number];

/** Raw-DSL detectors — skip the LLM NL→DSL step when input already looks
 *  like valid DSL. Cheaper + lower-latency when caller passes hand-written
 *  source. Anchored to the head of the trimmed description so mid-sentence
 *  DSL mentions ("I want something like digraph G { ... }") don't bypass
 *  the LLM path. */
function looksLikeDot(text: string): boolean {
  const head = text.trim().slice(0, 400);
  return /^(?:strict\s+)?(?:di)?graph\s+[\w"]*\s*\{/.test(head);
}

function looksLikeHtml(text: string): boolean {
  const head = text.trim().slice(0, 100).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function isUnderPrefix(abs: string, prefixes: readonly string[]): boolean {
  // Audit W4: previously allowed `abs === "/tmp"` via exact match. Accepting
  // a bare directory path is user-error-prone (writeFileSync EISDIR) and
  // the validator should reflect actual intent: must be UNDER the prefix.
  return prefixes.some((p) => abs.startsWith(p));
}

function resolveOutputPath(
  outputRaw: string | undefined,
  format: DiagramFormat,
): { ok: true; abs: string } | { ok: false; error: string } {
  const ext = format === "svg_html" ? "html" : "svg";
  if (!outputRaw) {
    return { ok: true, abs: `/tmp/diagram-${randomUUID()}.${ext}` };
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

/** NL description → graphviz DOT source via LLM. Short, opinionated prompt
 *  — the binary will complain loudly if the output is invalid, which gives
 *  us a clean error surface instead of fake-success. */
async function nlToDotDsl(
  description: string,
  diagramType: DiagramType,
  theme: Theme,
): Promise<string> {
  const themeColors =
    theme === "dark"
      ? 'bgcolor="#0f172a", node [shape=box, style="rounded,filled", fillcolor="#1e293b", color="#334155", fontcolor="#e2e8f0", fontname="JetBrains Mono"], edge [color="#94a3b8", fontcolor="#94a3b8", fontname="JetBrains Mono"]'
      : 'bgcolor="#fafafa", node [shape=box, style="rounded,filled", fillcolor="#ffffff", color="#d4d4d8", fontcolor="#18181b", fontname="JetBrains Mono"], edge [color="#71717a", fontcolor="#71717a", fontname="JetBrains Mono"]';

  const sys = `You are a Graphviz DOT source generator. Output valid DOT syntax only — no markdown fences, no explanation, raw DOT source starting with "digraph" or "graph".

Apply this theme config as graph-level attributes:
${themeColors}

Diagram type hint: ${diagramType}. Use shape=ellipse for states, shape=record for ER/class, shape=diamond for decision nodes in flowcharts. Prefer rankdir=LR for flowcharts and architecture, rankdir=TB for class/ER hierarchies.

Return ONLY the DOT source. The renderer will parse it directly.`;
  const response = await infer({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: description.slice(0, MAX_DESCRIPTION_CHARS) },
    ],
    temperature: 0.3,
    max_tokens: 2000,
  });
  const text = (response.content ?? "").trim();
  // Strip accidental code fences if the model ignored our instruction.
  const fenceMatch = text.match(/```(?:dot|graphviz)?\s*([\s\S]*?)\s*```/);
  return (fenceMatch?.[1] ?? text).trim();
}

/** NL description → full self-contained HTML doc with inline SVG via LLM. */
async function nlToSvgHtml(
  description: string,
  diagramType: DiagramType,
  theme: Theme,
): Promise<string> {
  const sys = svgHtmlSystemPrompt(theme);
  const userPrompt = `Diagram type: ${diagramType}

Description:
${description.slice(0, MAX_DESCRIPTION_CHARS)}

Render this as a single self-contained HTML file per the system instructions. Start with <!doctype html>.`;
  const response = await infer({
    messages: [
      { role: "system", content: sys },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.4,
    max_tokens: 6000,
  });
  const text = (response.content ?? "").trim();
  const fenceMatch = text.match(/```(?:html)?\s*([\s\S]*?)\s*```/);
  return (fenceMatch?.[1] ?? text).trim();
}

export const diagramGenerateTool: Tool = {
  name: "diagram_generate",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "diagram_generate",
      description: `Render a diagram from a natural-language description or raw DSL. Two formats at MVP:

FORMATS:
- graphviz: DOT-based auto-layout. Best for architecture, ER, class, state, topology with labeled edges. Renders via \`dot -Tsvg\` (sub-second, deterministic layout).
- svg_html: LLM-generated single-file HTML with inline SVG + Cocoon palette + JetBrains Mono. Best for architecture sketches where hand-placed layout + semantic colors matter (shipped/deprecated/degraded/etc.).

USE WHEN:
- Visualizing components, data flow, state machines, ER, or any node+edge structure
- Producing a single shareable .svg or .html artifact (not interactive)
- You have a description or a rough spec, not tabular data (for data viz → use \`chart\`)

DO NOT USE for:
- Charts/graphs of numeric data → use \`chart\` (QuickChart)
- Mermaid-format diagrams → deferred to v7.12.1 (mmdc CLI hangs on this VPS)
- Editing an existing diagram → not supported; regenerate from new description

PARAMS:
- description: NL or raw DSL (valid DOT \`digraph ... {\` starts the render directly, bypassing LLM)
- format: "graphviz" | "svg_html"
- diagram_type: "architecture" | "flowchart" | "sequence" | "er" | "class" | "state"
- theme: "dark" (default) | "light"
- output_path: absolute path under /tmp/ or /workspace/ (default /tmp/diagram-<uuid>.<ext>)
- emit: "render" (default, produces output file) | "source" (returns DSL/HTML text only, no render)

Output file is overwritten if present.`,
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description:
              "Describe what to diagram (NL) or paste raw DSL. NL is routed through the LLM to generate DOT / HTML. Raw DSL (starts with digraph/graph/<!doctype html>/<html>) renders directly.",
          },
          format: {
            type: "string",
            enum: [...FORMATS],
            description:
              "Rendering backend. graphviz = dot CLI. svg_html = inline LLM with Cocoon palette.",
          },
          diagram_type: {
            type: "string",
            enum: [...DIAGRAM_TYPES],
            description:
              "Hints shape/layout defaults. Optional; defaults to 'architecture'.",
          },
          theme: {
            type: "string",
            enum: [...THEMES],
            description: "Color scheme. Default 'dark'.",
          },
          output_path: {
            type: "string",
            description:
              "Optional absolute path under /tmp/ or /workspace/. Defaults to /tmp/diagram-<uuid>.<ext>.",
          },
          emit: {
            type: "string",
            enum: [...EMIT_MODES],
            description:
              "'render' produces the output file (default). 'source' returns DSL/HTML text without invoking the renderer.",
          },
        },
        required: ["description", "format"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const description =
      typeof args.description === "string" ? args.description : "";
    const format = args.format as DiagramFormat;
    const diagramType = (args.diagram_type as DiagramType) ?? "architecture";
    const theme = (args.theme as Theme) ?? "dark";
    const emit = (args.emit as EmitMode) ?? "render";
    const outputRaw = args.output_path as string | undefined;

    if (!description.trim()) {
      return JSON.stringify({ error: "description must be non-empty" });
    }
    if (description.length > MAX_DESCRIPTION_CHARS) {
      return JSON.stringify({
        error: `description too long (${description.length} chars, max ${MAX_DESCRIPTION_CHARS})`,
      });
    }
    if (!FORMATS.includes(format)) {
      return JSON.stringify({
        error: `format must be one of: ${FORMATS.join(", ")}`,
      });
    }
    if (!DIAGRAM_TYPES.includes(diagramType)) {
      return JSON.stringify({
        error: `diagram_type must be one of: ${DIAGRAM_TYPES.join(", ")}`,
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

    const outputCheck = resolveOutputPath(outputRaw, format);
    if (!outputCheck.ok) return JSON.stringify({ error: outputCheck.error });

    const start = Date.now();
    try {
      if (format === "graphviz") {
        const dslSource = looksLikeDot(description)
          ? description
          : await nlToDotDsl(description, diagramType, theme);
        if (emit === "source") {
          return `diagram_generate (graphviz source):
${dslSource}`;
        }
        const sourcePath = `/tmp/diagram-src-${randomUUID()}.dot`;
        writeFileSync(sourcePath, dslSource, "utf8");
        try {
          await execFileAsync(
            "dot",
            ["-Tsvg", sourcePath, "-o", outputCheck.abs],
            { timeout: DEFAULT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
          );
        } finally {
          // Audit W2: remove the DOT source temp regardless of render outcome.
          try {
            unlinkSync(sourcePath);
          } catch {
            /* best-effort cleanup */
          }
        }
        if (!existsSync(outputCheck.abs)) {
          return JSON.stringify({
            error: "dot exited cleanly but produced no output",
          });
        }
        const bytes = statSync(outputCheck.abs).size;
        return `diagram_generate: ${diagramType} via graphviz
  output: ${outputCheck.abs}
  bytes:  ${bytes}
  dur_ms: ${Date.now() - start}
  binary: dot
  source_bytes: ${Buffer.byteLength(dslSource, "utf8")}`;
      }

      // svg_html path
      const html = looksLikeHtml(description)
        ? description
        : await nlToSvgHtml(description, diagramType, theme);
      if (emit === "source") {
        return `diagram_generate (svg_html source):
${html}`;
      }
      // Write to a temp name and rename so the advertised output_path appears
      // atomically — matches the v7.10 file_convert rename pattern.
      const tmpPath = `/tmp/diagram-tmp-${randomUUID()}.html`;
      writeFileSync(tmpPath, html, "utf8");
      try {
        renameSync(tmpPath, outputCheck.abs);
      } catch {
        // Audit W3: different filesystem OR permission error. Clean up the
        // tmp file (best-effort) before falling back to a direct write so
        // we don't orphan it next to the final output.
        try {
          unlinkSync(tmpPath);
        } catch {
          /* best-effort cleanup */
        }
        writeFileSync(outputCheck.abs, html, "utf8");
      }
      const bytes = statSync(outputCheck.abs).size;
      return `diagram_generate: ${diagramType} via svg_html
  output: ${outputCheck.abs}
  bytes:  ${bytes}
  dur_ms: ${Date.now() - start}
  binary: inline`;
    } catch (err) {
      const e = err as Error & {
        code?: number | string;
        killed?: boolean;
        signal?: string;
      };
      if (e.code === "ENOENT") {
        return JSON.stringify({
          error: `binary not installed. Run \`apt install graphviz\` on the VPS.`,
        });
      }
      if (e.killed && e.signal === "SIGTERM") {
        return JSON.stringify({
          error: `diagram rendering timed out after ${DEFAULT_TIMEOUT_MS}ms`,
        });
      }
      return JSON.stringify({
        error: `diagram generation failed: ${e.message || String(err)}`,
        format,
      });
    }
  },
};

export { looksLikeDot as _looksLikeDot, looksLikeHtml as _looksLikeHtml };
export { FORMATS as _FORMATS, DIAGRAM_TYPES as _DIAGRAM_TYPES };
void basename; // keep import reserved for future outputs-to-basename display
