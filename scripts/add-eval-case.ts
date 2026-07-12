/**
 * Flywheel: pin a production behavior as a permanent eval case (V8.5 4.3).
 *
 * Every production delivery/selection bug becomes a regression case the
 * nightly eval + model-swap gate replay forever. Flywheel cases carry
 * source='flywheel' (retention-EXEMPT — the 90d mined-case prune skips
 * them) and weight 1.0 (human-confirmed ground truth).
 *
 * Usage:
 *   # Pin expected tools for a message
 *   npx tsx scripts/add-eval-case.ts --message "Busca el precio de NVDA" \
 *     --tools web_search --id nvda-price
 *
 *   # Pin FORBIDDEN tools (the model picked these and the operator said no)
 *   npx tsx scripts/add-eval-case.ts --message "..." --not-tools jarvis_write \
 *     --id bad-write
 *
 *   # Pin from a production task's telemetry (message + tools it used)
 *   npx tsx scripts/add-eval-case.ts --from-task <task_uuid> --id <slug>
 *
 * Optional: --category tool_selection|scope_accuracy|classification
 * (default tool_selection). Writes to the LIVE mined_test_cases table by
 * design — that IS the corpus the gate reads.
 */

import { loadConfig } from "../src/config.js";
import { getDatabase, initDatabase } from "../src/db/index.js";

interface Args {
  message?: string;
  tools?: string[];
  notTools?: string[];
  fromTask?: string;
  id?: string;
  category: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { category: "tool_selection" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--message") args.message = argv[++i];
    else if (a === "--tools") args.tools = argv[++i]?.split(",");
    else if (a === "--not-tools") args.notTools = argv[++i]?.split(",");
    else if (a === "--from-task") args.fromTask = argv[++i];
    else if (a === "--id") args.id = argv[++i];
    else if (a === "--category") args.category = argv[++i];
  }
  return args;
}

// Audit W1 (2026-07-12): a typo'd category is stored active but NEVER
// scored (scorer + eval-runner both skip unknown categories) — a silently
// inert pin is the exact eval-silence-floor class the flywheel prevents.
const VALID_CATEGORIES = new Set([
  "tool_selection",
  "scope_accuracy",
  "classification",
]);

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!VALID_CATEGORIES.has(args.category)) {
    console.error(
      `Invalid --category "${args.category}" — must be one of: ${[...VALID_CATEGORIES].join(" | ")}`,
    );
    process.exit(1);
  }
  loadConfig();
  initDatabase(process.env.MC_DB_PATH ?? "./data/mc.db");
  const db = getDatabase();

  let message = args.message;
  let expected: Record<string, unknown> | null = null;
  let minedFrom = "flywheel:manual";

  if (args.fromTask) {
    const row = db
      .prepare(
        `SELECT message, tools_called FROM scope_telemetry
         WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(args.fromTask) as
      { message: string; tools_called: string } | undefined;
    if (!row) {
      console.error(`No scope_telemetry row for task ${args.fromTask}`);
      process.exit(1);
    }
    message = row.message;
    let parsed: string[];
    try {
      parsed = JSON.parse(row.tools_called) as string[];
    } catch {
      console.error(
        `Task ${args.fromTask} has malformed tools_called telemetry — pin manually with --message/--tools`,
      );
      process.exit(1);
    }
    const tools = [...new Set(parsed)];
    if (tools.length === 0) {
      console.error(`Task ${args.fromTask} called no tools — nothing to pin`);
      process.exit(1);
    }
    expected = { tools };
    minedFrom = `flywheel:task:${args.fromTask}`;
  } else if (args.tools?.length) {
    expected = { tools: args.tools };
  } else if (args.notTools?.length) {
    expected = { not_tools: args.notTools };
  }

  if (!message || !expected || !args.id) {
    console.error(
      "Required: --id <slug> AND (--from-task <uuid> | --message <text> with --tools or --not-tools). See header for usage.",
    );
    process.exit(1);
  }

  const caseId = `flywheel-${args.id}`;
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO mined_test_cases
         (case_id, category, input, expected, weight, source, mined_from)
       VALUES (?, ?, ?, ?, 1.0, 'flywheel', ?)`,
    )
    .run(
      caseId,
      args.category,
      JSON.stringify({ message }),
      JSON.stringify(expected),
      minedFrom,
    );

  if (result.changes === 0) {
    console.error(`Case ${caseId} already exists — pick a different --id`);
    process.exit(1);
  }
  console.log(
    `Pinned ${caseId} [${args.category}] weight=1.0 retention-exempt\n  message: ${message.slice(0, 100)}\n  expected: ${JSON.stringify(expected)}`,
  );
}

main();
