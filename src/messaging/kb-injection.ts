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
import { recordMemoryInjection } from "../observability/prometheus.js";
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
  PREVIEW_SITE_RE,
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

/** KB row written by scripts/kb-preview-directive.mjs (operator-run). */
const PREVIEW_DIRECTIVE_PATH = "directives/preview-publishing.md";

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
  "very-light-cms",
  "vlmp",
  "williams-radar",
];

/** Match project names in message text (slug or natural name). */
export function detectProjectInMessage(text: string): string | null {
  // very-light-cms (VLCMS, the thewilliamsradar.com CMS) and vlmp (the media
  // player) are unrelated repos. Checked before the slug loop so a message
  // naming both ("VLCMS is not VLMP") binds to VLCMS, not to the "vlmp" slug.
  if (/\bvlcms\b|\bvery[ -]light[ -]cms\b/i.test(text)) {
    return "very-light-cms";
  }
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

/** Project README for an explicitly mentioned project slug — bypasses every
 *  budget (silently dropping it leaves the runner blind to the asked-about
 *  project). */
function projectReadmeSection(
  messageText: string | undefined,
  logTag: string,
): string | null {
  if (!messageText) return null;
  const projectSlug = detectProjectInMessage(messageText);
  if (!projectSlug) return null;
  try {
    const readme = getFile(`projects/${projectSlug}/README.md`);
    if (!readme) return null;
    console.log(
      `[${logTag}] Project README injected: projects/${projectSlug}/README.md (${readme.content.length} chars)`,
    );
    return `### Project Context: ${readme.title}\n${capStableContent(readme.path, readme.content, logTag)}`;
  } catch {
    return null; // Project README not found — non-fatal
  }
}

/**
 * The per-turn KB sections, shared by both builders: `conditional` rows that
 * match the scope (own 8000-char budget, a pointer line for each one that did
 * not fit), the project README, and the preview / Rumi guardrails.
 */
export const KB_CHAR_BUDGET = 8000;

/** A conditional row, as far as packing needs it. */
export interface ConditionalRow {
  path: string;
  title: string;
  content: string;
  condition?: string | null;
}

/**
 * Which conditional rows apply to this scope, and which of those fit the
 * budget in the order given. Pure: the KB dry run and the Jev shadow read the
 * same split the prompt gets.
 */
export function packConditionalRows<T extends ConditionalRow>(
  files: readonly T[],
  scopedTools: readonly string[],
): { inBudget: T[]; pointer: T[]; chars: number } {
  const inBudget: T[] = [];
  const pointer: T[] = [];
  let chars = 0;
  for (const f of files) {
    if (f.condition && !conditionMatches(f.condition, scopedTools)) {
      continue;
    }
    const length = `### ${f.title}\n${f.content}`.length;
    if (chars + length > KB_CHAR_BUDGET) {
      pointer.push(f);
      continue;
    }
    inBudget.push(f);
    chars += length;
  }
  return { inBudget, pointer, chars };
}

function collectVariableSections(
  scopedTools: string[],
  messageText: string | undefined,
  logTag: string,
): string[] {
  const packed = packConditionalRows(
    getFilesByQualifier("conditional"),
    scopedTools,
  );
  const variableSections = packed.inBudget.map(
    (f) => `### ${f.title}\n${f.content}`,
  );
  const budgetSkipped = packed.pointer.map((f) => `- ${f.path} — ${f.title}`);
  const variableChars = packed.chars;
  // The goal prompt is persisted nowhere, so this line is the only direct
  // evidence that conditional rows reached a heavy/swarm goal (2026-09-19).
  console.log(
    `[${logTag}] KB variable layer: ${variableSections.length} conditional row(s) in budget, ${variableChars} chars, ${budgetSkipped.length} in pointer`,
  );
  // A row that APPLIES to this turn but did not fit must not vanish silently:
  // with coding in scope ~6.2k chars of earlier rows push every later
  // directive out, so Jarvis closed a Caddy preview with no recipe (task
  // b1583f19, qa R2 W1). One line per skipped row keeps it reachable for any
  // phrasing, at ~100 chars instead of the row's full text.
  if (budgetSkipped.length > 0) {
    variableSections.push(
      `### Directivas que aplican a este turno pero no cupieron — léelas con jarvis_file_read ANTES de actuar en su tema\n${budgetSkipped.join("\n")}`,
    );
  }

  const readme = projectReadmeSection(messageText, logTag);
  if (readme) variableSections.push(readme);

  if (messageText) {
    // Preview guardrail: the publish/close recipe must reach any turn that
    // talks about a Caddy preview. As a plain conditional row it never did:
    // priority 70 puts it behind ~6.2k chars of coding-scope rows, so the
    // 8000 budget skipped it every time (qa R1 C1, 2026-09-19) — and without
    // it Jarvis tried `rm` (blocked) and told the operator to hand-edit a
    // GENERATED Caddy file (task b1583f19). Same budget bypass as Rumi below.
    if (
      PREVIEW_SITE_RE.test(messageText) &&
      conditionMatches("coding", scopedTools)
    ) {
      try {
        const preview = getFile(PREVIEW_DIRECTIVE_PATH);
        const section = preview && `### ${preview.title}\n${preview.content}`;
        if (section && !variableSections.includes(section)) {
          variableSections.push(section);
          console.log(
            `[${logTag}] Preview guardrail: injected ${PREVIEW_DIRECTIVE_PATH} (${preview.content.length} chars)`,
          );
        }
      } catch {
        console.warn(
          `[${logTag}] Preview guardrail: could not inject ${PREVIEW_DIRECTIVE_PATH}`,
        );
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
  return variableSections;
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
    // Conditional rows go through collectVariableSections(): counting them
    // against a budget the mandatory rows had already spent (9.5k chars before
    // the first conditional row) made every one of them unreachable for
    // heavy/swarm goals — 42 of 42 executor prompts in 7 days carried none
    // (2026-09-19).
    const files = getFilesByQualifier(
      ...(enforceOnly ? ["enforce"] : ["always-read", "enforce"]),
    );

    const sections: string[] = [];
    for (const f of files) {
      const prefix = f.qualifier === "enforce" ? "MANDATORY: " : "";
      sections.push(
        `### ${prefix}${f.title}\n${capStableContent(f.path, f.content, logTag)}`,
      );
    }

    const mandatoryChars = sections.reduce((n, sec) => n + sec.length, 0);

    if (enforceOnly) {
      const readme = projectReadmeSection(messageText, logTag);
      if (readme) sections.push(readme);
    } else {
      sections.push(...collectVariableSections(scopedTools, messageText, logTag));
    }
    if (sections.length === 0) return null;

    if (mandatoryChars > 6000) {
      console.warn(
        `[${logTag}] KB injection at ${mandatoryChars} chars — enforce+always-read files may be too large`,
      );
    }

    const block = `[JARVIS KNOWLEDGE BASE]\n\n${sections.join("\n\n---\n\n")}`;
    // Memory tax is per chat TURN: the planner/executor callers (>100 calls
    // a week live) would swamp the histogram (qa R2 W-4).
    if (logTag === "fast-runner") recordMemoryInjection("kb", block.length);
    return block;
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
    const stableSections: string[] = [];
    for (const f of stableFiles) {
      const prefix = f.qualifier === "enforce" ? "MANDATORY: " : "";
      stableSections.push(
        `### ${prefix}${f.title}\n${capStableContent(f.path, f.content, logTag)}`,
      );
    }

    const variableSections = collectVariableSections(
      scopedTools,
      messageText,
      logTag,
    );

    const stable =
      stableSections.length > 0
        ? `[JARVIS KNOWLEDGE BASE]\n\n${stableSections.join("\n\n---\n\n")}`
        : null;
    const variable =
      variableSections.length > 0
        ? `[JARVIS KNOWLEDGE BASE — task-specific]\n\n${variableSections.join("\n\n---\n\n")}`
        : null;

    // Chat turns only, like buildKnowledgeBaseSection: executor goals would
    // swamp the per-turn histogram (qa R2 W-4; audit 2026-09-22 R1 W1).
    if (logTag === "fast-runner") {
      recordMemoryInjection("kb_stable", stable?.length ?? 0);
      recordMemoryInjection("kb_variable", variable?.length ?? 0);
    }
    return { stable, variable };
  } catch {
    return { stable: null, variable: null };
  }
}
