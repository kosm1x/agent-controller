/**
 * crm_query — queries the CRM Azteca REST API for sales pipeline data.
 *
 * Jarvis uses this to answer questions about pipeline, quotas, revenue,
 * activities, team, and alerts without needing the CRM's full tool set.
 *
 * v5.0 S4: A2A mesh — Jarvis ↔ CRM bidirectional integration.
 */

import type { Tool } from "../types.js";

function getCrmConfig() {
  return {
    baseUrl: process.env.CRM_API_URL ?? "http://localhost:3000",
    token: process.env.CRM_API_TOKEN ?? "",
  };
}

const VALID_ENDPOINTS = [
  "pipeline",
  "cuota",
  "descarga",
  "actividades",
  "equipo",
  "alertas",
  "vp-glance",
] as const;

type CrmEndpoint = (typeof VALID_ENDPOINTS)[number];

export const crmQueryTool: Tool = {
  name: "crm_query",
  definition: {
    type: "function",
    function: {
      name: "crm_query",
      description: `Query the CRM sales system for real-time business data.

USE WHEN:
- User asks about sales pipeline, quotas, revenue, billing, deals
- User asks about team activities, performance, alerts
- User asks about clients, prospects, or proposals
- User wants a VP-level business overview

ENDPOINTS:
- "vp-glance" — Executive dashboard: revenue pulse, pipeline health, quota heatmap, sentiment, alerts, inventory. START HERE for broad business questions.
- "pipeline" — All active proposals: stage, value, client, assigned AE, days in stage
- "cuota" — Weekly quota performance: target vs actual by person
- "descarga" — Weekly billing: planned vs invoiced, gap analysis by account
- "actividades" — Recent activities: calls, emails, meetings, proposals sent
- "equipo" — Team roster: roles, reporting lines, active status
- "alertas" — Active alerts: stalled deals, missed quotas, overdue tasks

DO NOT USE WHEN:
- You need to CREATE or MODIFY CRM data (this is read-only)
- The question is about COMMIT tasks, goals, or personal productivity`,
      parameters: {
        type: "object",
        properties: {
          endpoint: {
            type: "string",
            enum: VALID_ENDPOINTS as unknown as string[],
            description:
              'Which CRM data view to query. Use "vp-glance" for broad questions, specific endpoints for targeted queries.',
          },
        },
        required: ["endpoint"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const endpoint = args.endpoint as CrmEndpoint;

    if (!VALID_ENDPOINTS.includes(endpoint)) {
      return JSON.stringify({
        error: `Invalid endpoint: ${endpoint}. Valid: ${VALID_ENDPOINTS.join(", ")}`,
      });
    }

    const { baseUrl, token } = getCrmConfig();
    if (!token) {
      return JSON.stringify({
        error:
          "CRM integration not configured. Set CRM_API_TOKEN environment variable.",
      });
    }

    const url = `${baseUrl}/api/v1/${endpoint}`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return JSON.stringify({
          error: `CRM API returned ${response.status}: ${body.slice(0, 200)}`,
        });
      }

      const text = await response.text();
      try {
        const data = JSON.parse(text);
        return JSON.stringify(data);
      } catch {
        return JSON.stringify({
          error: `CRM returned non-JSON: ${text.slice(0, 200)}`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({ error: `CRM query failed: ${message}` });
    }
  },
};
