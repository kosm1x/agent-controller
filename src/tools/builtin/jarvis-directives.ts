/**
 * Directive Evolution — v6.0 S3.
 *
 * Jarvis proposes changes to his own SOPs/directives. User approves via Telegram.
 * Proposals stored in knowledge/proposals/. Applied only after explicit approval.
 * Changelog in logs/decisions/.
 */

import type { Tool } from "../types.js";
import {
  upsertFile,
  getFile,
  deleteFile,
  listFiles,
} from "../../db/jarvis-fs.js";

const PROPOSALS_PREFIX = "knowledge/proposals/";
const DECISIONS_PREFIX = "logs/decisions/";

// ---------------------------------------------------------------------------
// jarvis_propose_directive
// ---------------------------------------------------------------------------

export const jarvisProposeTool: Tool = {
  name: "jarvis_propose_directive",
  definition: {
    type: "function",
    function: {
      name: "jarvis_propose_directive",
      description: `Propose a change to your own directives or SOPs. Does NOT apply immediately — requires user approval.

USE WHEN:
- You notice a recurring pattern that should be a directive (e.g., hallucination nudge keeps firing)
- You want to add/modify a Knowledge Base SOP based on experience
- Overnight tuning identifies a behavioral improvement

WORKFLOW:
1. Call jarvis_propose_directive with the proposal
2. User receives notification in Telegram
3. User says "aprueba la propuesta" → you call jarvis_apply_proposal
4. Change is applied + logged in decisions/

CONSTRAINT: You can ONLY propose. You CANNOT modify directives directly.
Proposals go to knowledge/proposals/ where the user reviews them.

AFTER PROPOSING: Tell the user what you proposed and ask for approval.`,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              'Short title for the proposal (e.g., "Add anti-amplification directive")',
          },
          target_path: {
            type: "string",
            description:
              'Path of the file to modify (e.g., "directives/core.md", "knowledge/procedures/sync-protocol.md")',
          },
          change_type: {
            type: "string",
            enum: ["add", "modify", "remove"],
            description:
              "Type of change: add new content, modify existing, or remove",
          },
          current_content: {
            type: "string",
            description:
              "The current content that would be replaced (for modify/remove). Omit for add.",
          },
          proposed_content: {
            type: "string",
            description:
              "The new content to add or replace with. Omit for remove.",
          },
          reason: {
            type: "string",
            description:
              "Why this change is needed — what pattern triggered it, what it fixes.",
          },
        },
        required: ["title", "target_path", "change_type", "reason"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const title = args.title as string;
    const targetPath = args.target_path as string;
    const changeType = args.change_type as "add" | "modify" | "remove";
    const currentContent = (args.current_content as string) ?? "";
    const proposedContent = (args.proposed_content as string) ?? "";
    const reason = args.reason as string;

    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 50);
    const date = new Date().toISOString().slice(0, 10);
    const proposalPath = `${PROPOSALS_PREFIX}${date}-${slug}.md`;

    const content = [
      `# Proposal: ${title}`,
      "",
      `**Target:** ${targetPath}`,
      `**Type:** ${changeType}`,
      `**Date:** ${new Date().toISOString()}`,
      `**Status:** pending`,
      "",
      `## Reason`,
      reason,
      "",
      ...(changeType !== "add" && currentContent
        ? [
            "## Current Content",
            "<<<CURRENT>>>",
            currentContent,
            "<<<END_CURRENT>>>",
            "",
          ]
        : []),
      ...(changeType !== "remove" && proposedContent
        ? [
            "## Proposed Content",
            "<<<PROPOSED>>>",
            proposedContent,
            "<<<END_PROPOSED>>>",
            "",
          ]
        : []),
      `## To approve`,
      `Say: "aprueba la propuesta ${slug}"`,
    ].join("\n");

    upsertFile(
      proposalPath,
      `Proposal: ${title}`,
      content,
      ["proposal", "directive"],
      "reference",
      10,
    );

    return [
      `📝 **Propuesta creada:** ${title}`,
      `Archivo: ${proposalPath}`,
      `Target: ${targetPath} (${changeType})`,
      `Razón: ${reason.slice(0, 200)}`,
      "",
      `Para aprobar: "aprueba la propuesta ${slug}"`,
    ].join("\n");
  },
};

// ---------------------------------------------------------------------------
// jarvis_apply_proposal
// ---------------------------------------------------------------------------

export const jarvisApplyProposalTool: Tool = {
  name: "jarvis_apply_proposal",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "jarvis_apply_proposal",
      description: `Apply an approved directive proposal. Only call this AFTER the user explicitly approves.

USE WHEN:
- User says "aprueba la propuesta X" or "aprueba" after reviewing a proposal

NEVER call this without explicit user approval in the current message.`,
      parameters: {
        type: "object",
        properties: {
          proposal_slug: {
            type: "string",
            description:
              "The slug from the proposal (shown in the approval instruction).",
          },
        },
        required: ["proposal_slug"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const slug = args.proposal_slug as string;

    // Find the proposal
    const proposals = listFiles({ prefix: PROPOSALS_PREFIX });
    const match = proposals.find((p) => p.path.includes(slug));
    if (!match) {
      return `❌ Proposal "${slug}" not found in knowledge/proposals/.`;
    }

    const proposal = getFile(match.path);
    if (!proposal) {
      return `❌ Could not read proposal at ${match.path}.`;
    }

    // Parse target and change type
    const targetMatch = proposal.content.match(/\*\*Target:\*\*\s*(.+)/);
    const typeMatch = proposal.content.match(/\*\*Type:\*\*\s*(\w+)/);
    const proposedMatch = proposal.content.match(
      /<<<PROPOSED>>>\n([\s\S]*?)\n<<<END_PROPOSED>>>/,
    );
    const currentMatch = proposal.content.match(
      /<<<CURRENT>>>\n([\s\S]*?)\n<<<END_CURRENT>>>/,
    );

    const targetPath = targetMatch?.[1]?.trim();
    const changeType = typeMatch?.[1]?.trim();

    if (!targetPath || !changeType) {
      return `❌ Could not parse proposal — missing target or type.`;
    }

    // Apply the change
    try {
      const existing = getFile(targetPath);

      if (changeType === "add") {
        const newContent = proposedMatch?.[1] ?? "";
        if (existing) {
          // Append to existing file
          upsertFile(
            targetPath,
            existing.title,
            existing.content + "\n" + newContent,
            (() => {
              try {
                return JSON.parse(existing.tags ?? "[]");
              } catch {
                return [];
              }
            })(),
            existing.qualifier,
            existing.priority,
          );
        } else {
          upsertFile(targetPath, targetPath, newContent, [], "reference", 50);
        }
      } else if (changeType === "modify") {
        if (!existing) return `❌ Target file ${targetPath} not found.`;
        const oldText = currentMatch?.[1] ?? "";
        const newText = proposedMatch?.[1] ?? "";
        // replaceAll: if the pattern appears multiple times, change all of them
        const updated = existing.content.split(oldText).join(newText);
        upsertFile(
          targetPath,
          existing.title,
          updated,
          (() => {
            try {
              return JSON.parse(existing.tags ?? "[]");
            } catch {
              return [];
            }
          })(),
          existing.qualifier,
          existing.priority,
        );
      } else if (changeType === "remove") {
        if (!existing) return `❌ Target file ${targetPath} not found.`;
        const oldText = currentMatch?.[1] ?? "";
        const updated = existing.content.split(oldText).join("").trim();
        upsertFile(
          targetPath,
          existing.title,
          updated,
          (() => {
            try {
              return JSON.parse(existing.tags ?? "[]");
            } catch {
              return [];
            }
          })(),
          existing.qualifier,
          existing.priority,
        );
      }

      // Log the decision
      const date = new Date().toISOString().slice(0, 10);
      const decisionPath = `${DECISIONS_PREFIX}${date}-${slug}.md`;
      upsertFile(
        decisionPath,
        `Decision: ${slug}`,
        [
          `# Decision: Applied proposal "${slug}"`,
          "",
          `**Date:** ${new Date().toISOString()}`,
          `**Target:** ${targetPath}`,
          `**Type:** ${changeType}`,
          `**Applied by:** Jarvis (user-approved)`,
          "",
          `## Proposal`,
          proposal.content,
        ].join("\n"),
        ["decision", "directive"],
        "reference",
        50,
      );

      // Remove the proposal (consumed)
      deleteFile(match.path);

      return [
        `✅ **Propuesta aplicada:** ${slug}`,
        `Target: ${targetPath} (${changeType})`,
        `Decision logged: ${decisionPath}`,
      ].join("\n");
    } catch (err) {
      return `❌ Failed to apply: ${err instanceof Error ? err.message : err}`;
    }
  },
};
