/**
 * Chart generation tool — QuickChart API (free, no auth).
 *
 * Generates chart image URLs from data using Chart.js config.
 * Returns a shareable URL that renders as a PNG image.
 */

import type { Tool } from "../types.js";

const API_URL = "https://quickchart.io/chart";
const TIMEOUT_MS = 15_000;

export const chartGenerateTool: Tool = {
  name: "chart_generate",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "chart_generate",
      description: `Generate a chart image URL from data.

USE WHEN:
- User asks for a visual chart, graph, or diagram
- Need to visualize data (bar, line, pie, doughnut, radar, scatter)
- Creating reports or summaries that benefit from visuals
- User wants to compare data visually

DO NOT USE WHEN:
- Simple tabular data that doesn't need visualization
- User explicitly asks for text-only output
- Need interactive charts (this produces static PNG images)

Returns a URL to a PNG chart image. The URL can be shared or embedded in documents.
Accepts simplified parameters — you don't need to know Chart.js syntax.`,
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["bar", "line", "pie", "doughnut", "radar", "scatter"],
            description: "Chart type",
          },
          title: {
            type: "string",
            description: "Chart title (optional)",
          },
          labels: {
            type: "array",
            items: { type: "string" },
            description: "X-axis labels or category names",
          },
          datasets: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                data: { type: "array", items: { type: "number" } },
              },
              required: ["data"],
            },
            description: "Data series. Each has a label and array of numbers.",
          },
          width: {
            type: "number",
            description: "Image width in pixels (default: 500, max: 1200)",
          },
          height: {
            type: "number",
            description: "Image height in pixels (default: 300, max: 800)",
          },
        },
        required: ["type", "labels", "datasets"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const chartType = (args.type as string) ?? "bar";
    const title = args.title as string | undefined;
    const labels = (args.labels as string[]) ?? [];
    const datasets =
      (args.datasets as Array<{ label?: string; data: number[] }>) ?? [];
    const width = Math.min((args.width as number) ?? 500, 1200);
    const height = Math.min((args.height as number) ?? 300, 800);

    if (!labels.length || !datasets.length) {
      return JSON.stringify({
        error:
          "labels (string[]) and datasets (array of {label, data}) are required",
      });
    }

    const chartConfig = {
      type: chartType,
      data: {
        labels,
        datasets: datasets.map((ds) => ({
          label: ds.label ?? "",
          data: ds.data,
        })),
      },
      options: {
        ...(title
          ? { plugins: { title: { display: true, text: title } } }
          : {}),
      },
    };

    const body = JSON.stringify({
      chart: JSON.stringify(chartConfig),
      width,
      height,
      format: "png",
      backgroundColor: "white",
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        return JSON.stringify({
          error: `QuickChart API error: ${response.status}`,
        });
      }

      // Build a shareable GET URL
      const encodedConfig = encodeURIComponent(JSON.stringify(chartConfig));
      const chartUrl = `${API_URL}?c=${encodedConfig}&w=${width}&h=${height}&bkg=white`;

      return JSON.stringify({
        chart_url: chartUrl,
        type: chartType,
        width,
        height,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `Chart generation failed: ${message}` });
    } finally {
      clearTimeout(timeout);
    }
  },
};
