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
  SOCIAL_TOOLS,
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
  { keyword: "social", tools: SOCIAL_TOOLS },
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

/**
 * Detect Rumi / creative-poetry requests in message text.
 *
 * Returns true when the message is asking for a Rumi poem by Rumi.
 * When true, `buildKnowledgeBaseSections` force-injects into the variable layer:
 *   - `knowledge/Rumi/INDEX.md`  (which poems have already been delivered)
 *   - `knowledge/procedures/sop-verificacion-fuentes-contenido-creativo.md`
 *
 * This is the structural guardrail that prevents the fast runner from skipping
 * the SOP and serving a duplicate poem straight from training memory.
 * Root cause (2026-05-23): detectRumiRequest() did not exist; the SOP lived as a
 * "reference" qualifier file — invisible until explicitly fetched, which never
 * happened on creative requests because the LLM answered from training data first.
 */
export function detectRumiRequest(text: string): boolean {
  // Any mention of rumi (with or without accent, common typos, Arabic script)
  const hasRumi = /\brumi\b|jalal|jalaluddin|جلال/i.test(text);
  // Explicit poem/creative request verbs
  const hasPoem =
    /poema|poem|recítame|regálame|comparte|versos|verso|poetry/i.test(text);
  // Fire on bare "rumi" mention OR poem-request-with-rumi context
  return hasRumi || (hasPoem && hasRumi);
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
  // crm-azteca was cut over to pulso-aura-upfront on 2026-06-20 — the old
  // slug resolved to no README for months (logic audit F15).
  if (/\bcrm\b|\bpulso\b/i.test(text)) return "pulso-aura-upfront";
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
      const mandatory = f.qualifier === "enforce" || f.qualifier === "always-read";
      const section = `### ${prefix}${f.title}\n${
        mandatory ? capStableContent(f.path, f.content, logTag) : f.content
      }`;

      if (!mandatory && totalChars + section.length > KB_CHAR_BUDGET) {
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
            const projectSection = `### Project Context: ${readme.title}\n${capStableContent(readme.path, readme.content, logTag)}`;
            sections.push(projectSection);
            totalChars += projectSection.length;
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
 * Per-file ceiling for the MANDATORY layer (design audit D1, 2026-09-10).
 * `enforce`/`always-read` files bypassed every budget: 180 KB (~45K tokens)
 * rode into every task prompt, 85 % of it one 153 KB project README that
 * grew ~5 KB/day — ~$0.13 per turn in cache-creation tokens. A file over the
 * cap is injected as HEAD + TAIL with a pointer to the full text: the head
 * carries the title/front-matter, the tail the newest state — the live
 * README is an append-only log whose current facts (HEAD commit, operator
 * guardrails) all sit at the bottom (qa C1: a head-only cut froze a July
 * snapshot that read as current). An odd number of line-start fences in the
 * kept text is closed before the marker so a truncated code block cannot
 * swallow the rest of the prompt.
 */
export const STABLE_FILE_CHAR_CAP = 24_000;
const STABLE_HEAD_CHARS = 6_000;

export function closeOpenFence(text: string): string {
  const fences = (text.match(/^```/gm) ?? []).length;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

/** The tail may START inside a fenced block (opened in the omitted middle):
 *  its first fence is then an orphan CLOSE, not an open — drop it instead
 *  of appending another (qa R2 W1), then balance what remains. */
function balanceTailFences(content: string, tailStart: number, tail: string): string {
  const fencesBefore = (content.slice(0, tailStart).match(/^```/gm) ?? []).length;
  const t = fencesBefore % 2 === 1 ? tail.replace(/^```[^\n]*\n?/m, "") : tail;
  return closeOpenFence(t);
}

export function capStableContent(path: string, content: string, logTag: string): string {
  if (content.length <= STABLE_FILE_CHAR_CAP) return content;
  const headCut = content.lastIndexOf("\n", STABLE_HEAD_CHARS);
  const head = content.slice(0, headCut > STABLE_HEAD_CHARS / 2 ? headCut : STABLE_HEAD_CHARS);
  const tailLen = STABLE_FILE_CHAR_CAP - head.length;
  const tailStartRaw = content.length - tailLen;
  const tailCut = content.indexOf("\n", tailStartRaw);
  const tailStart = tailCut > 0 && tailCut < tailStartRaw + tailLen / 2 ? tailCut + 1 : tailStartRaw;
  const tail = content.slice(tailStart);
  const omitted = content.length - head.length - tail.length;
  console.warn(
    `[${logTag}] KB stable file ${path} is ${content.length} chars — injected head ${head.length} + tail ${tail.length}; read the rest with jarvis_file_read`,
  );
  return `${closeOpenFence(head)}\n\n[… omitidos ${omitted} caracteres del medio — el archivo completo se lee con jarvis_file_read("${path}")]\n\n${balanceTailFences(content, tailStart, tail)}`;
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
      stableSections.push(
        `### ${prefix}${f.title}\n${capStableContent(f.path, f.content, logTag)}`,
      );
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
            const projectSection = `### Project Context: ${readme.title}\n${capStableContent(readme.path, readme.content, logTag)}`;
            variableSections.push(projectSection);
            variableChars += projectSection.length;
            console.log(
              `[${logTag}] Project README injected into variable layer: projects/${projectSlug}/README.md (${readme.content.length} chars)`,
            );
          }
        } catch {
          // non-fatal
        }
      }

      // Rumi SOP guardrail: force-inject Index + SOP on any Rumi/poem request.
      // Without this, the LLM answers from training memory and bypasses the SOP,
      // causing duplicate poems to be served (3 documented incidents: 2026-04-06,
      // 2026-05-19, 2026-05-23).
      if (detectRumiRequest(messageText)) {
        const rumiPaths = [
          "knowledge/Rumi/INDEX.md",
          "knowledge/procedures/sop-verificacion-fuentes-contenido-creativo.md",
        ];
        for (const rumiPath of rumiPaths) {
          try {
            const rumiFile = getFile(rumiPath);
            if (rumiFile) {
              const section = `### ${rumiFile.title}\n${rumiFile.content}`;
              // Bypasses budget — these are mandatory context for correctness
              variableSections.push(section);
              variableChars += section.length;
              console.log(
                `[${logTag}] Rumi SOP guardrail: injected ${rumiPath} (${rumiFile.content.length} chars)`,
              );
            }
          } catch {
            // non-fatal — log and continue
            console.warn(
              `[${logTag}] Rumi SOP guardrail: could not inject ${rumiPath}`,
            );
          }
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
