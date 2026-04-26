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

/**
 * v8 S1: Split KB into a stable layer (cache-friendly prefix) and a
 * variable layer (per-task / per-scope). Stable = `enforce` + `always-read`
 * sections — same across all tasks. Variable = `conditional` rows that match
 * the active scope + project README (if user mentioned a project slug).
 *
 * Cache rationale: Anthropic's prompt cache keys on the longest stable prefix.
 * When variable conditional content sits at the top of the prompt, every task
 * with a different scope busts the cache. Routing stable content into one
 * system message and variable content into a later message lets the cache hit
 * on the stable layer. See feedback_cache_prefix_variability.md for why this
 * matters: a 68% prompt-token shrink netted only 5% cost savings because the
 * cache-read ratio dropped 83%→59% on the 2026-04-26 KB-injection refactor.
 *
 * Returns `{ stable, variable }`. Either may be null if no rows match.
 *
 * @param scopedTools  Tools currently in scope (used to gate conditional files)
 * @param messageText  Optional user message — if it mentions a known project
 *                     slug, that project's README is appended to `variable`.
 * @param logTag       Optional log prefix (default `"runner"`).
 */
export function buildKnowledgeBaseSections(
  scopedTools: string[],
  messageText?: string,
  logTag = "runner",
): { stable: string | null; variable: string | null } {
  try {
    const stableFiles = getFilesByQualifier("enforce", "always-read");
    const variableFiles = getFilesByQualifier("conditional");

    const stableSections: string[] = [];
    for (const f of stableFiles) {
      const prefix = f.qualifier === "enforce" ? "MANDATORY: " : "";
      stableSections.push(`### ${prefix}${f.title}\n${f.content}`);
    }

    const variableSections: string[] = [];
    let variableChars = 0;
    const KB_CHAR_BUDGET = 8000;
    for (const f of variableFiles) {
      if (f.condition && !conditionMatches(f.condition, scopedTools)) {
        continue;
      }
      const section = `### ${f.title}\n${f.content}`;
      if (variableChars + section.length > KB_CHAR_BUDGET) continue;
      variableSections.push(section);
      variableChars += section.length;
    }

    // Project README belongs in variable — explicit project mention is a
    // per-message signal. Bypasses budget for the same reason as before.
    if (messageText) {
      const projectSlug = detectProjectInMessage(messageText);
      if (projectSlug) {
        try {
          const readme = getFile(`projects/${projectSlug}/README.md`);
          if (readme) {
            variableSections.push(
              `### Project Context: ${readme.title}\n${readme.content}`,
            );
            variableChars += readme.content.length;
            console.log(
              `[${logTag}] Project README injected into variable layer: projects/${projectSlug}/README.md (${readme.content.length} chars)`,
            );
          }
        } catch {
          // non-fatal
        }
      }
    }

    const stable =
      stableSections.length > 0
        ? `[JARVIS KNOWLEDGE BASE]\n\n${stableSections.join("\n\n---\n\n")}`
        : null;
    const variable =
      variableSections.length > 0
        ? `[JARVIS KNOWLEDGE BASE — task-specific]\n\n${variableSections.join("\n\n---\n\n")}`
        : null;

    return { stable, variable };
  } catch {
    return { stable: null, variable: null };
  }
}
