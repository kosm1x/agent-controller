/**
 * Knowledge-base injection — shared across runners.
 *
 * Assembles the [JARVIS KNOWLEDGE BASE] block that gets prepended to system
 * prompts. Pulls from `jarvis_files` (always-read + enforce + matching
 * conditional rows) and optionally injects the project README when the user
 * mentions a known project slug.
 *
 * Used by:
 *   - fast-runner (per-task system prompt)
 *   - prometheus executor (per-goal system prompt)
 *   - prometheus planner (enforce-only, plan-time)
 *
 * Keep this module pure and side-effect-free except for `console.warn` /
 * `console.log` instrumentation. Do not import runner internals.
 */

import { getFilesByQualifier, getFile } from "../db/jarvis-fs.js";
import {
  CRM_TOOLS_SCOPE,
  GOOGLE_TOOLS,
  WORDPRESS_TOOLS,
  CODING_TOOLS,
  BROWSER_TOOLS,
  SCHEDULE_TOOLS,
  RESEARCH_TOOLS,
  TEACHING_TOOLS,
} from "./scope.js";

/**
 * Maps a `condition=` keyword on a jarvis_file row to the scope-tool group
 * that gates injection. Imported from `messaging/scope.ts` to stay in sync
 * with the source-of-truth scope definitions; do NOT re-derive tool lists
 * via string prefixes here (e.g. `t.startsWith("learning_plan_")` would
 * miss `learner_model_status`).
 */
const CONDITION_TOOL_GROUPS: ReadonlyArray<{
  keyword: string;
  tools: readonly string[];
}> = [
  { keyword: "crm", tools: CRM_TOOLS_SCOPE },
  { keyword: "northstar", tools: ["northstar_sync"] },
  { keyword: "google", tools: GOOGLE_TOOLS },
  { keyword: "wordpress", tools: WORDPRESS_TOOLS },
  { keyword: "coding", tools: CODING_TOOLS },
  { keyword: "browser", tools: BROWSER_TOOLS },
  { keyword: "schedule", tools: SCHEDULE_TOOLS },
  { keyword: "reporting", tools: ["web_search", "exa_search", "gmail_send"] },
  { keyword: "research", tools: RESEARCH_TOOLS },
  { keyword: "teaching", tools: TEACHING_TOOLS },
];

export function conditionMatches(
  condition: string,
  scopedTools: readonly string[],
): boolean {
  const condLower = condition.toLowerCase();
  return CONDITION_TOOL_GROUPS.some(
    ({ keyword, tools }) =>
      condLower.includes(keyword) && tools.some((t) => scopedTools.includes(t)),
  );
}

/** Known project slugs for README auto-injection. */
const PROJECT_SLUGS = [
  "agent-controller",
  "braid-jarvis",
  "cmll-gira-estrellas",
  "cuatro-flor",
  "livingjoyfully",
  "obsidian-brain",
  "pipesong",
  "presencia-digital-eurekamd",
  "reddit-scraper-tool",
  "vlmp",
  "williams-radar",
];

/** Match project names in message text (slug or natural name). */
export function detectProjectInMessage(text: string): string | null {
  const lower = text.toLowerCase();
  for (const slug of PROJECT_SLUGS) {
    if (lower.includes(slug) || lower.includes(slug.replace(/-/g, " "))) {
      return slug;
    }
  }
  if (/\bcrm\b/i.test(text)) return "crm-azteca";
  if (/\bvlmp\b/i.test(text)) return "vlmp";
  if (/\bpipesong\b/i.test(text)) return "pipesong";
  // "Williams" alone always refers to the Williams Entry Radar in this
  // workspace. We don't alias bare "radar" — "PipeSong Tech Radar" and
  // other project-specific radars would collide.
  if (/\bwilliams\b/i.test(text)) return "williams-radar";
  return null;
}

/**
 * Build the [JARVIS KNOWLEDGE BASE] section.
 *
 * @param scopedTools  Tools currently in scope (used to gate conditional files)
 * @param enforceOnly  When true, only `enforce` files are returned. Used by
 *                     prometheus planner where the SOP is overkill but
 *                     directives like repo-authorization.md must apply.
 * @param messageText  Optional user message — if it mentions a known project
 *                     slug, that project's README is appended (bypasses budget
 *                     because explicit project mention is a strong signal).
 * @param logTag       Optional log prefix (default `"runner"`) — distinguishes
 *                     fast-runner vs executor in journalctl output.
 */
export function buildKnowledgeBaseSection(
  scopedTools: string[],
  enforceOnly = false,
  messageText?: string,
  logTag = "runner",
): string | null {
  try {
    const files = enforceOnly
      ? getFilesByQualifier("enforce")
      : getFilesByQualifier("always-read", "enforce", "conditional");
    if (files.length === 0) return null;

    const sections: string[] = [];
    let totalChars = 0;
    const KB_CHAR_BUDGET = 8000;

    for (const f of files) {
      if (
        f.qualifier === "conditional" &&
        f.condition &&
        !conditionMatches(f.condition, scopedTools)
      ) {
        continue;
      }

      const prefix = f.qualifier === "enforce" ? "MANDATORY: " : "";
      const section = `### ${prefix}${f.title}\n${f.content}`;

      if (
        f.qualifier !== "enforce" &&
        f.qualifier !== "always-read" &&
        totalChars + section.length > KB_CHAR_BUDGET
      ) {
        continue;
      }
      sections.push(section);
      totalChars += section.length;
    }

    // Project README auto-injection: explicit project mention bypasses budget
    // (silently dropping it leaves the runner blind to the asked-about project).
    if (messageText) {
      const projectSlug = detectProjectInMessage(messageText);
      if (projectSlug) {
        try {
          const readme = getFile(`projects/${projectSlug}/README.md`);
          if (readme) {
            sections.push(
              `### Project Context: ${readme.title}\n${readme.content}`,
            );
            totalChars += readme.content.length;
            console.log(
              `[${logTag}] Project README injected: projects/${projectSlug}/README.md (${readme.content.length} chars, totalChars now ${totalChars})`,
            );
          }
        } catch {
          // Project README not found — non-fatal
        }
      }
    }

    if (sections.length === 0) return null;

    if (totalChars > 6000) {
      console.warn(
        `[${logTag}] KB injection at ${totalChars} chars — enforce+always-read files may be too large`,
      );
    }

    return `[JARVIS KNOWLEDGE BASE]\n\n${sections.join("\n\n---\n\n")}`;
  } catch {
    return null;
  }
}
