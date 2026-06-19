/**
 * Triage sub-agent — given detected anomalies, root-cause them and emit a
 * structured report. Forced structured output via an inline SDK tool (the
 * `submit_*` closure-sink pattern from `sycophancy.ts` / `critic.ts`): no
 * free-text fallback. Returns `null` if the model never called the tool —
 * conservative, a failed analysis writes NO report rather than a fabricated one.
 *
 * READ-ONLY: the system prompt forbids remediation, and nothing downstream
 * executes `recommendedActions`. Runs on Haiku (cheap; this is a read-only
 * diagnosis, not a generation task).
 */

import { tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  queryClaudeSdk,
  HAIKU_MODEL_ID,
  type InlineSdkTool,
} from "../../inference/claude-sdk.js";
import { randomUUID } from "node:crypto";
import { recordCost } from "../../budget/service.js";
import type { Anomaly, Severity, TriageReport } from "./types.js";

const SUBMIT_TOOL = "submit_triage_report";

const triageSchema = {
  severity: z
    .enum(["critical", "high", "medium", "low"])
    .describe("overall severity of the root cause for the operator"),
  root_cause: z
    .string()
    .describe(
      "the single most likely root-cause hypothesis, citing the anomalies",
    ),
  affected_components: z
    .array(z.string())
    .describe(
      "subsystems implicated (e.g. inference, dispatcher, runners, messaging, db, kb)",
    ),
  recommended_actions: z
    .array(z.string())
    .describe(
      "actions FOR THE HUMAN OPERATOR to take by hand. Diagnosis only — nothing here is auto-executed.",
    ),
  confidence: z
    .enum(["high", "medium", "low"])
    .describe("confidence in the root-cause hypothesis given the evidence"),
};

interface TriageCapture {
  severity: Severity;
  root_cause: string;
  affected_components: string[];
  recommended_actions: string[];
  confidence: "high" | "medium" | "low";
}

const SYSTEM_PROMPT = `You are a READ-ONLY root-cause analyst for Mission Control, an AI agent orchestrator (TypeScript, SQLite, multi-provider inference, Docker runners, WhatsApp/Telegram messaging).

You receive a set of detected health anomalies. Diagnose the single most likely root cause across layers: infrastructure, inference providers, tools, dispatcher/runners, messaging, database, knowledge base.

HARD RULES:
- You DIAGNOSE only. You NEVER remediate, and nothing you output is auto-executed.
- "recommended_actions" are for a HUMAN OPERATOR to run by hand AFTER reviewing your report.
- Do NOT propose destructive actions (DB resets, force-restarts that kill in-flight tasks, deletes). If a fix is risky, say so and defer explicitly to the operator.
- Reason ONLY from the anomaly data given; never invent metrics you weren't shown.
- Call ${SUBMIT_TOOL} exactly once. The schema IS your output.`;

export interface TriageAnalysisContext {
  /** recent failed-task error strings, for grounding (optional). */
  recentErrors?: string[];
}

export interface TriageAnalysisOutput {
  report: TriageReport;
  costUsd: number;
  model: string;
}

export async function runTriageAnalysis(
  anomalies: Anomaly[],
  ctx: TriageAnalysisContext = {},
  opts: { model?: string } = {},
): Promise<TriageAnalysisOutput | null> {
  const sink: { captured: TriageCapture | null } = { captured: null };

  const submit = sdkTool(
    SUBMIT_TOOL,
    "Submit the triage report. Call exactly once. The schema IS your output.",
    triageSchema,
    async (args: TriageCapture) => {
      if (!sink.captured) sink.captured = args;
      return {
        content: [{ type: "text" as const, text: "Triage report recorded." }],
      };
    },
  ) as unknown as InlineSdkTool;

  const prompt = [
    "Detected anomalies:",
    ...anomalies.map(
      (a) =>
        `- [${a.severity}] ${a.kind}: ${a.detail} (observed ${a.observed}, threshold ${a.threshold})`,
    ),
    ctx.recentErrors && ctx.recentErrors.length > 0
      ? `\nRecent failed-task errors:\n${ctx.recentErrors.map((e) => `- ${e}`).join("\n")}`
      : "",
    `\nDiagnose the single most likely root cause, then call ${SUBMIT_TOOL}.`,
  ]
    .filter(Boolean)
    .join("\n");

  const result = await queryClaudeSdk({
    prompt,
    systemPrompt: SYSTEM_PROMPT,
    toolNames: [],
    extraTools: [submit],
    maxTurns: 6,
    model: opts.model ?? HAIKU_MODEL_ID,
  });

  // Record the monitor's own spend. These calls run OUTSIDE the dispatcher (like
  // recordReflectionCost), so without this they're invisible to the cost ledger
  // AND to this monitor's own budget_overrun check. Never let a ledger write
  // break triage.
  try {
    recordCost({
      runId: randomUUID(),
      taskId: "self-healing-triage",
      agentType: "self-healing-triage",
      model: result.model,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      costUsdOverride: result.costUsd,
      cacheReadTokens: result.usage.cacheReadTokens,
      cacheCreationTokens: result.usage.cacheCreationTokens,
    });
  } catch {
    /* cost-ledger write must never break triage */
  }

  if (!sink.captured) return null;
  return {
    report: {
      severity: sink.captured.severity,
      rootCause: sink.captured.root_cause,
      affectedComponents: sink.captured.affected_components,
      recommendedActions: sink.captured.recommended_actions,
      confidence: sink.captured.confidence,
    },
    costUsd: result.costUsd,
    model: result.model,
  };
}
