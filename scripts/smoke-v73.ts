/**
 * Live smoke for v7.3 Phase 2+3+5 tools.
 * Usage: npx tsx scripts/smoke-v73.ts
 */

import { initDatabase } from "../src/db/index.js";
import { seoRobotsAuditTool } from "../src/tools/builtin/seo-robots-audit.js";
import { seoLlmsTxtGenerateTool } from "../src/tools/builtin/seo-llms-txt-generate.js";
import { seoTelemetryTool } from "../src/tools/builtin/seo-telemetry.js";
import { aiOverviewTrackTool } from "../src/tools/builtin/ai-overview-track.js";
import { readFileSync } from "node:fs";

try {
  const env = readFileSync("./.env", "utf-8");
  for (const line of env.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {
  /* no .env is fine */
}

async function smoke(label: string, promise: Promise<unknown>) {
  console.log(`\n=== ${label} ===`);
  try {
    const raw = (await promise) as string;
    const out = typeof raw === "string" ? raw : JSON.stringify(raw);
    // Print a truncated preview
    console.log(out.length > 600 ? out.slice(0, 600) + "\n…(truncated)" : out);
  } catch (err) {
    console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
  }
}

async function main() {
  initDatabase("./data/mc.db");

  await smoke(
    "seo_robots_audit anthropic.com",
    seoRobotsAuditTool.execute({ url: "https://www.anthropic.com/" }),
  );

  await smoke(
    "seo_llms_txt_generate mycommit.net",
    seoLlmsTxtGenerateTool.execute({ url: "https://www.mycommit.net/" }),
  );

  await smoke(
    "seo_telemetry mycommit.net (PSI only)",
    seoTelemetryTool.execute({
      url: "https://www.mycommit.net/",
      include: ["psi"],
    }),
  );

  await smoke(
    "ai_overview_track 'claude code'",
    aiOverviewTrackTool.execute({ query: "claude code" }),
  );
}

main().catch((err) => {
  console.error("[smoke] FATAL:", err);
  process.exit(1);
});
