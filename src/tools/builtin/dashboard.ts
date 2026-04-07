/**
 * Dashboard Generation + Serving (v6.3 DB1 + DB2)
 *
 * Generates interactive ECharts dashboards from data.
 * Pattern: LLM generates ECharts option JSON → template assembles HTML.
 * Source: Anton (MindsDB) visualization prompt patterns.
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import type { Tool } from "../types.js";

const DASHBOARD_DIR = "/tmp/dashboards";

const DASHBOARD_PROMPT = `You are a data visualization expert. Given data and a question, generate ECharts 5 chart configuration.

RULES:
- Return ONLY valid JSON — no markdown, no commentary
- JSON must be an object with: { "title": "...", "kpis": [...], "charts": [...] }
- kpis: array of { "label": "...", "value": "...", "delta": "+X%" or "-X%" }
- charts: array of { "type": "line|bar|pie|scatter|heatmap", "title": "...", "option": {...} }
- The "option" field must be a valid ECharts option object (xAxis, yAxis, series, etc.)
- Use dark theme colors: background #0d1117, text #c9d1d9, accent #58a6ff
- Add dataZoom for time series
- Add markLine for thresholds when relevant

LAYOUT ORDER:
1. KPI hero cards at top (large numbers with delta arrows)
2. Main narrative chart (the primary answer to the question)
3. Supporting charts below`;

const HTML_TEMPLATE = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>{{TITLE}}</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif; padding: 24px; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .kpi { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; }
  .kpi-value { font-size: 32px; font-weight: 700; color: #f0f6fc; }
  .kpi-label { font-size: 14px; color: #8b949e; margin-top: 4px; }
  .kpi-delta { font-size: 14px; margin-top: 4px; }
  .kpi-delta.positive { color: #3fb950; }
  .kpi-delta.negative { color: #f85149; }
  .chart-container { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .chart-title { font-size: 16px; font-weight: 600; margin-bottom: 12px; color: #f0f6fc; }
  .chart { width: 100%; height: 400px; }
</style>
</head>
<body>
<h1 style="margin-bottom:24px;font-size:24px;color:#f0f6fc">{{TITLE}}</h1>
<div class="kpi-grid" id="kpis"></div>
<div id="charts"></div>
<script>
const D = {{DATA}};
const C = {{CONFIG}};

// Render KPIs
const kpiGrid = document.getElementById('kpis');
(C.kpis || []).forEach(k => {
  const isPos = (k.delta || '').startsWith('+');
  kpiGrid.innerHTML += '<div class="kpi"><div class="kpi-value">' + k.value +
    '</div><div class="kpi-label">' + k.label +
    '</div><div class="kpi-delta ' + (isPos ? 'positive' : 'negative') + '">' +
    k.delta + '</div></div>';
});

// Render charts
const chartsDiv = document.getElementById('charts');
(C.charts || []).forEach((c, i) => {
  const id = 'chart-' + i;
  chartsDiv.innerHTML += '<div class="chart-container"><div class="chart-title">' +
    c.title + '</div><div class="chart" id="' + id + '"></div></div>';
  setTimeout(() => {
    const chart = echarts.init(document.getElementById(id), 'dark');
    chart.setOption(c.option || {});
    window.addEventListener('resize', () => chart.resize());
  }, 100);
});
</script>
</body>
</html>`;

export const dashboardGenerateTool: Tool = {
  name: "dashboard_generate",
  definition: {
    type: "function",
    function: {
      name: "dashboard_generate",
      description: `Generate an interactive ECharts dashboard from data.

USE WHEN:
- User asks to visualize data, create a chart, or build a dashboard
- After querying data from sheets, CRM, or databases
- Creating reports with KPI cards + charts

Input: data (CSV/JSON string) + question (what to visualize).
Output: self-contained HTML file with interactive ECharts charts.
Serve via: GET /dashboard/{id}`,
      parameters: {
        type: "object",
        properties: {
          data: {
            type: "string",
            description: "Data to visualize (CSV or JSON string)",
          },
          question: {
            type: "string",
            description:
              "What to visualize (e.g. 'monthly revenue trend with targets')",
          },
          title: {
            type: "string",
            description: "Dashboard title (default: auto-generated)",
          },
        },
        required: ["data", "question"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const data = args.data as string;
    const question = args.question as string;
    if (!data) return JSON.stringify({ error: "data is required" });
    if (!question) return JSON.stringify({ error: "question is required" });

    const title = (args.title as string) || question.slice(0, 60);
    const dashId = randomUUID().slice(0, 8);

    try {
      const { infer } = await import("../../inference/adapter.js");

      // LLM generates ECharts config JSON
      const result = await infer(
        {
          messages: [
            { role: "system", content: DASHBOARD_PROMPT },
            {
              role: "user",
              content: `Data:\n${data.slice(0, 5000)}\n\nQuestion: ${question}`,
            },
          ],
          temperature: 0.3,
          max_tokens: 2000,
        },
        { providerName: "fallback" },
      );

      let config: unknown;
      try {
        // Strip markdown code fences if present
        const raw = (result.content ?? "")
          .replace(/```json\s*/g, "")
          .replace(/```\s*/g, "")
          .trim();
        config = JSON.parse(raw);
      } catch {
        return JSON.stringify({
          error:
            "LLM returned invalid JSON. Try simplifying the question or data.",
          raw: (result.content ?? "").slice(0, 500),
        });
      }

      // Assemble HTML
      mkdirSync(DASHBOARD_DIR, { recursive: true });
      const html = HTML_TEMPLATE.replace(/\{\{TITLE\}\}/g, title)
        .replace("{{DATA}}", JSON.stringify(data))
        .replace("{{CONFIG}}", JSON.stringify(config));

      const outputPath = join(DASHBOARD_DIR, `${dashId}.html`);
      writeFileSync(outputPath, html, "utf-8");

      return JSON.stringify({
        id: dashId,
        path: outputPath,
        url: `/dashboard/${dashId}`,
        title,
      });
    } catch (err) {
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};

// ---------------------------------------------------------------------------
// dashboard_list
// ---------------------------------------------------------------------------

export const dashboardListTool: Tool = {
  name: "dashboard_list",
  definition: {
    type: "function",
    function: {
      name: "dashboard_list",
      description: `List generated dashboards.

USE WHEN:
- User wants to see previously generated dashboards
- Looking up a dashboard URL`,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  async execute(): Promise<string> {
    if (!existsSync(DASHBOARD_DIR)) {
      return JSON.stringify({ dashboards: [], count: 0 });
    }

    const files = readdirSync(DASHBOARD_DIR)
      .filter((f) => f.endsWith(".html"))
      .map((f) => ({
        id: f.replace(".html", ""),
        url: `/dashboard/${f.replace(".html", "")}`,
        file: join(DASHBOARD_DIR, f),
      }));

    return JSON.stringify({ count: files.length, dashboards: files });
  },
};
