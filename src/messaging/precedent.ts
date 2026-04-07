/**
 * Precedent resolution (v6.4 CL1.2).
 *
 * Extracts recent entities (files, projects, tools, tasks) from conversation
 * history and builds a context block. Helps the LLM resolve anaphoric
 * references like "it", "that", "the report", "continue with that".
 *
 * Runs synchronously on conversation turns — no LLM call needed.
 */

/** Entity types we track for precedent resolution. */
interface PrecedentContext {
  files: string[];
  projects: string[];
  tools: string[];
  tasks: string[];
  urls: string[];
}

/**
 * Extract entities from conversation turns and build a precedent block.
 * Returns empty string if no significant entities found.
 */
export function buildPrecedentBlock(
  conversationHistory: Array<{ role: string; content: string }>,
): string {
  if (conversationHistory.length === 0) return "";

  const ctx: PrecedentContext = {
    files: [],
    projects: [],
    tools: [],
    tasks: [],
    urls: [],
  };

  // Scan last 3 turns for entities
  const recentTurns = conversationHistory.slice(-3);

  for (const turn of recentTurns) {
    const text = turn.content;

    // File paths
    const filePaths = text.match(
      /(?:\/[\w.-]+){2,}\.(?:ts|js|md|json|py|txt|yaml|yml|sql|sh)/g,
    );
    if (filePaths) ctx.files.push(...filePaths);

    // Jarvis KB paths
    const kbPaths = text.match(
      /(?:NorthStar|projects|knowledge|directives|logs)\/[\w./-]+/g,
    );
    if (kbPaths) ctx.files.push(...kbPaths);

    // Project names (common ones)
    const projectPatterns =
      /\b(agent-controller|mission-control|crm-azteca|cuatro-flor|livingjoyfully|vlmp|pipesong|commit-ai)\b/gi;
    const projectMatches = text.match(projectPatterns);
    if (projectMatches) ctx.projects.push(...projectMatches);

    // Tool names (snake_case patterns that look like tools)
    const toolMatches = text.match(
      /\b(?:gmail_send|web_search|jarvis_file_\w+|northstar_sync|vps_status|git_\w+|schedule_task|batch_decompose|dashboard_\w+|screenshot_\w+|wp_\w+|gsheets_\w+)\b/g,
    );
    if (toolMatches) ctx.tools.push(...toolMatches);

    // Task/schedule references
    const taskRefs = text.match(
      /(?:tarea|task|reporte|report|schedule)\s+["']?([^"'\n,]{3,40})["']?/gi,
    );
    if (taskRefs) ctx.tasks.push(...taskRefs.slice(0, 3));

    // URLs
    const urls = text.match(/https?:\/\/\S{10,}/g);
    if (urls) ctx.urls.push(...urls.slice(0, 2));
  }

  // Deduplicate
  const dedup = (arr: string[]) => [...new Set(arr)].slice(0, 5);
  ctx.files = dedup(ctx.files);
  ctx.projects = dedup(ctx.projects);
  ctx.tools = dedup(ctx.tools);
  ctx.tasks = dedup(ctx.tasks);
  ctx.urls = dedup(ctx.urls);

  // Build block only if we have something
  const parts: string[] = [];
  if (ctx.files.length > 0) parts.push(`Files: ${ctx.files.join(", ")}`);
  if (ctx.projects.length > 0)
    parts.push(`Projects: ${ctx.projects.join(", ")}`);
  if (ctx.tools.length > 0) parts.push(`Tools used: ${ctx.tools.join(", ")}`);
  if (ctx.tasks.length > 0) parts.push(`Tasks: ${ctx.tasks.join(", ")}`);
  if (ctx.urls.length > 0) parts.push(`URLs: ${ctx.urls.join(", ")}`);

  if (parts.length === 0) return "";

  return `[RECENT CONTEXT — resolve "it"/"that"/"the file" from these]\n${parts.join("\n")}`;
}
