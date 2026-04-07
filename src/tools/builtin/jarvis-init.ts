/**
 * /jarvis-init — bootstrap Jarvis's internal file system by scraping
 * all existing data sources into structured jarvis_files.
 *
 * Idempotent: safe to re-run (upserts via ON CONFLICT).
 * Uses the jarvis-fs infrastructure layer for all writes.
 */

import type { Tool } from "../types.js";
import { getDatabase } from "../../db/index.js";
import { upsertFile } from "../../db/jarvis-fs.js";

export const jarvisInitTool: Tool = {
  name: "jarvis_init",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "jarvis_init",
      description: `Bootstrap your internal file system by scraping all existing data sources.

USE WHEN:
- First run after the file system feature is deployed
- User asks you to re-initialize or refresh your knowledge base
- You notice your knowledge base is empty

This pulls from: user_facts, projects, scheduled_tasks, scope_telemetry, task_outcomes.

IDEMPOTENT: Safe to re-run — updates existing files.`,
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },

  async execute(): Promise<string> {
    const db = getDatabase();
    const created: string[] = [];

    // 1. directives/core.md — core persona and SOPs (Unified FS)
    upsertFile(
      "directives/core.md",
      "Jarvis Core Directives",
      `# Jarvis Core Directives

## Persona
Eres Jarvis, el asistente estratégico personal de Fede (Federico). Habla en español mexicano, conciso y orientado a la acción.

## SOPs
1. **Verifica antes de afirmar.** Usa task_history para verificar qué hiciste, no inventes.
2. **No alucines acciones.** Si no llamaste un tool, no digas que lo hiciste.
3. **Usa tu sistema de archivos.** Lee directives/core.md y archivos relevantes antes de actuar.
4. **Reporta limitaciones.** Si algo falló, dilo. No encubras errores.
5. **Actualiza tu conocimiento.** Cuando aprendas algo nuevo sobre Fede o sus proyectos, guárdalo en jarvis_file_write.

## Tools de conocimiento
- \`jarvis_file_read\` — Lee archivos de tu base de conocimiento
- \`jarvis_file_write\` — Crea/sobreescribe archivos
- \`jarvis_file_update\` — Agrega contenido o cambia metadata
- \`jarvis_file_list\` — Lista archivos por tags/qualifier/prefijo
- \`task_history\` — Consulta tu historial de ejecución real`,
      ["directive", "persona", "sop"],
      "enforce",
      0,
    );
    created.push("directives/core.md");

    // 2. User profile from user_facts
    try {
      const facts = db
        .prepare("SELECT key, value FROM user_facts ORDER BY key")
        .all() as Array<{ key: string; value: string }>;

      if (facts.length > 0) {
        const content =
          "# User Profile — Fede\n\n" +
          facts.map((f) => `- **${f.key}**: ${f.value}`).join("\n");
        upsertFile(
          "knowledge/people/fede-profile.md",
          "User Profile",
          content,
          ["user", "profile"],
          "reference",
          40,
        );
        created.push("knowledge/people/fede-profile.md");
      }
    } catch {
      /* table may not exist */
    }

    // 3. Projects from projects table
    try {
      const projects = db
        .prepare(
          "SELECT name, description, status FROM projects WHERE status = 'active' ORDER BY name",
        )
        .all() as Array<{
        name: string;
        description: string;
        status: string;
      }>;

      if (projects.length > 0) {
        const content =
          "# Active Projects\n\n" +
          projects
            .map(
              (p) => `## ${p.name}\n**Status:** ${p.status}\n${p.description}`,
            )
            .join("\n\n---\n\n");
        upsertFile(
          "knowledge/domain/active-projects.md",
          "Active Projects",
          content,
          ["project", "context"],
          "reference",
          10,
        );
        created.push("knowledge/domain/active-projects.md");
      }
    } catch {
      /* table may not exist */
    }

    // 4. Scheduled tasks
    try {
      const schedules = db
        .prepare(
          "SELECT name, cron_expr, description, delivery, active FROM scheduled_tasks ORDER BY name",
        )
        .all() as Array<{
        name: string;
        cron_expr: string;
        description: string;
        delivery: string;
        active: number;
      }>;

      if (schedules.length > 0) {
        const content =
          "# Scheduled Tasks\n\n" +
          schedules
            .map(
              (s) =>
                `## ${s.name} ${s.active ? "✅" : "⏸️"}\n**Cron:** \`${s.cron_expr}\`\n**Delivery:** ${s.delivery}\n${s.description}`,
            )
            .join("\n\n---\n\n");
        upsertFile(
          "knowledge/domain/active-schedules.md",
          "Active Schedules",
          content,
          ["schedule", "automation"],
          "reference",
          10,
        );
        created.push("knowledge/domain/active-schedules.md");
      }
    } catch {
      /* table may not exist */
    }

    // 5. Top tool usage patterns from scope_telemetry
    try {
      const patterns = db
        .prepare(
          `SELECT tool_chain, COUNT(*) as cnt
           FROM scope_telemetry
           WHERE tool_chain != '' AND created_at >= datetime('now', '-7 days')
           GROUP BY tool_chain ORDER BY cnt DESC LIMIT 10`,
        )
        .all() as Array<{ tool_chain: string; cnt: number }>;

      if (patterns.length > 0) {
        const content =
          "# Common Tool Patterns (last 7 days)\n\n" +
          patterns
            .map((p) => `- **${p.tool_chain}** — ${p.cnt} times`)
            .join("\n");
        upsertFile(
          "knowledge/domain/tool-patterns.md",
          "Common Tool Patterns",
          content,
          ["tools", "patterns"],
          "reference",
          40,
        );
        created.push("knowledge/domain/tool-patterns.md");
      }
    } catch {
      /* table may not exist */
    }

    // 6. Execution success patterns from task_outcomes
    try {
      const outcomes = db
        .prepare(
          `SELECT ran_on,
                  COUNT(*) as total,
                  SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes
           FROM task_outcomes
           WHERE created_at >= datetime('now', '-7 days')
           GROUP BY ran_on`,
        )
        .all() as Array<{
        ran_on: string;
        total: number;
        successes: number;
      }>;

      if (outcomes.length > 0) {
        const content =
          "# Execution Patterns (last 7 days)\n\n" +
          "| Runner | Total | Success | Rate |\n|--------|-------|---------|------|\n" +
          outcomes
            .map(
              (o) =>
                `| ${o.ran_on} | ${o.total} | ${o.successes} | ${((o.successes / o.total) * 100).toFixed(0)}% |`,
            )
            .join("\n");
        upsertFile(
          "knowledge/domain/execution-patterns.md",
          "Execution Patterns",
          content,
          ["execution", "patterns"],
          "reference",
          45,
        );
        created.push("knowledge/domain/execution-patterns.md");
      }
    } catch {
      /* table may not exist */
    }

    // 7. Regenerate INDEX.md (auto-generated, always-read)
    try {
      const { regenerateIndex } = await import("../../db/jarvis-index.js");
      regenerateIndex();
      created.push("INDEX.md");
    } catch {
      /* non-fatal */
    }

    return JSON.stringify({
      success: true,
      filesCreated: created.length,
      files: created,
    });
  },
};
