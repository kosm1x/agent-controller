/**
 * google_workspace_cli — dispatch tool for Google Workspace APIs via gws CLI.
 *
 * Adopts googleworkspace/cli (Rust, Apache-2.0, v0.22.5+) which reads Google's
 * Discovery Service at runtime to build its entire command surface from the live
 * API spec. Unlocks ~25+ Workspace services (Chat, Tasks, People, Forms, Meet,
 * Classroom, Admin Reports, Apps Script, Keep, Workspace Events, Model Armor,
 * etc.) without writing per-service handler code in Jarvis.
 *
 * **Auth model:** per-call injection of Jarvis's existing OAuth access token via
 * `GOOGLE_WORKSPACE_CLI_TOKEN` env var. No `gws auth` state on disk — we do not
 * call `gws auth login` / `gws auth setup`. Token refresh happens BEFORE each
 * subprocess exec using `getAccessToken()` from `src/google/auth.ts`.
 *
 * **When NOT to use this tool:** prefer the hardened builtin handlers for
 * services Jarvis already supports natively: `gmail_send`, `gmail_search`,
 * `gmail_read`, `gdrive_*`, `calendar_*`, `gsheets_*`, `gdocs_*`, `gslides_*`.
 * Those have scope integration, confirmation gates, and battle-tested error
 * handling that this dispatch tool does not reproduce. `google_workspace_cli`
 * is the fallback for Workspace APIs WITHOUT a dedicated handler.
 *
 * v7.6 — ships as the infrastructure unblocker for Chat/Tasks/People/Forms
 * that v7.3 Phase 2 and beyond will consume.
 */

import type { Tool } from "../types.js";
import { execFile } from "node:child_process";
import { getAccessToken, isGoogleConfigured } from "../../google/auth.js";

const GWS_BINARY = "gws";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 2 MiB subprocess stdout cap

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/**
 * Run a child process with an explicit env + stdout byte cap + timeout.
 * execFile() collects both streams fully; we just cap via maxBuffer which
 * triggers ERR_CHILD_PROCESS_STDIO_MAXBUFFER on overflow (caught as error).
 */
function runSubprocess(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      binary,
      args,
      { env, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES },
      (error, stdout, stderr) => {
        const errWithCode = error as
          | (Error & {
              code?: number | string;
              killed?: boolean;
              signal?: NodeJS.Signals | null;
            })
          | null;
        const timedOut =
          Boolean(errWithCode?.killed) && errWithCode?.signal === "SIGTERM";
        const exitCode =
          typeof errWithCode?.code === "number"
            ? errWithCode.code
            : error
              ? 1
              : 0;
        resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          exitCode,
          signal: (errWithCode?.signal as NodeJS.Signals | null) ?? null,
          timedOut,
        });
      },
    );
    // The handler above runs whether or not execFile synchronously throws
    // on spawn; the Promise always resolves via the callback.
    void child;
  });
}

/**
 * Parse gws stdout. Default mode = single JSON object. Pagination mode
 * (page_all) = NDJSON, one JSON object per line (each line is one page).
 */
function parseGwsOutput(stdout: string, pageAll: boolean): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return null;

  if (!pageAll) {
    return JSON.parse(trimmed);
  }

  const pages: unknown[] = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.length === 0) continue;
    pages.push(JSON.parse(l));
  }
  return pages;
}

export const googleWorkspaceCliTool: Tool = {
  name: "google_workspace_cli",
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "google_workspace_cli",
      description: `Dispatch tool for Google Workspace APIs NOT covered by a dedicated Jarvis handler.

USE WHEN:
- The user wants to work with Google Chat (spaces, messages), Google Tasks (tasklists, tasks), Google People (contacts), Google Forms, Google Meet, Classroom, Admin Reports, Apps Script, Keep, or Workspace Events — services Jarvis does NOT have dedicated tools for.
- You need a long-tail Google Workspace API that's accessible via Google's Discovery Service at runtime.

DO NOT USE WHEN:
- A dedicated handler exists for the service. ALWAYS prefer:
  - Email → gmail_send, gmail_search, gmail_read
  - Drive → gdrive_list, gdrive_create, gdrive_share, gdrive_delete, gdrive_move, gdrive_upload
  - Calendar → calendar_list, calendar_create, calendar_update
  - Docs → gdocs_read, gdocs_write, gdocs_replace
  - Sheets → gsheets_read, gsheets_write
  - Slides → gslides_read, gslides_create
  The dedicated handlers have scope integration, confirmation gates, and mature error handling that this tool does not reproduce.

COMMAND SHAPE (reads Google's Discovery Service dynamically):
  {service, resource, method, params?, json?, page_all?, timeout_ms?}

CANONICAL EXAMPLES:

1. Google Chat — post a message to a space:
   { "service": "chat", "resource": "spaces.messages", "method": "create",
     "params": { "parent": "spaces/AAAA1234" },
     "json": { "text": "Deploy complete." } }

2. Google Tasks — insert a new task into a tasklist:
   { "service": "tasks", "resource": "tasks", "method": "insert",
     "params": { "tasklist": "MDkyNTE5NjAyMzQxNjA..." },
     "json": { "title": "Review v7 roadmap", "notes": "Check F1 timeline" } }

3. Google People — list contacts:
   { "service": "people", "resource": "people.connections", "method": "list",
     "params": { "resourceName": "people/me", "pageSize": 25,
                 "personFields": "names,emailAddresses,phoneNumbers" } }

4. Google Forms — list responses for a form:
   { "service": "forms", "resource": "forms.responses", "method": "list",
     "params": { "formId": "1abc...xyz" } }

INTROSPECTION: if you don't know a method's shape, pass --help via the method field:
   { "service": "chat", "resource": "spaces", "method": "--help" }
This returns the service's subcommand tree so you can discover what's available.

PAGINATION: set page_all=true to auto-paginate. Output becomes an array where each element is one page. Default page limit is 10 pages; use params.pageSize for per-page count.

RESPONSE SHAPE: { "ok": true, "result": <parsed JSON> } on success, or { "ok": false, "error": <stderr>, "exitCode": N } on failure.`,
      parameters: {
        type: "object",
        properties: {
          service: {
            type: "string",
            description:
              "Google Workspace service name: chat, tasks, people, forms, meet, classroom, keep, admin, script, workspaceevents, etc. Use the lowercase service slug from Google Discovery.",
          },
          resource: {
            type: "string",
            description:
              "Resource path within the service. Dot-separated for nested resources: 'spaces.messages', 'people.connections', 'forms.responses', 'tasks', 'tasklists'. Empty string is valid when using --help on the service directly.",
          },
          method: {
            type: "string",
            description:
              "Method name: 'create', 'list', 'get', 'patch', 'update', 'delete'. Pass '--help' to introspect available methods on a resource.",
          },
          params: {
            type: "object",
            description:
              "Query parameters and path parameters as a JSON object. For path params like 'parent' or 'tasklist', put the full resource path as the value. Example: {parent: 'spaces/AAAA1234', pageSize: 10}.",
          },
          json: {
            type: "object",
            description:
              "Request body for POST/PATCH/PUT methods. Matches the Google API's documented request shape. Omit for GET/DELETE.",
          },
          page_all: {
            type: "boolean",
            description:
              "Auto-paginate through all pages (up to 10 by default). Returns an array of page objects instead of a single response. Use for list operations when you need the full dataset.",
          },
          timeout_ms: {
            type: "number",
            description:
              "Subprocess wall-clock timeout in milliseconds. Defaults to 30000 (30s). Bump for large paginated pulls.",
          },
        },
        required: ["service", "resource", "method"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const service = args.service as string;
    const resource = args.resource as string;
    const method = args.method as string;
    const params = args.params as Record<string, unknown> | undefined;
    const json = args.json as Record<string, unknown> | undefined;
    const pageAll = Boolean(args.page_all ?? false);
    const timeoutMs = Math.max(
      1000,
      Math.min(600_000, Number(args.timeout_ms ?? DEFAULT_TIMEOUT_MS)),
    );

    if (!service || typeof service !== "string") {
      return JSON.stringify({
        ok: false,
        error: "service is required",
      });
    }
    if (typeof resource !== "string") {
      return JSON.stringify({
        ok: false,
        error: "resource is required (empty string allowed)",
      });
    }
    if (!method || typeof method !== "string") {
      return JSON.stringify({
        ok: false,
        error: "method is required",
      });
    }

    // Guard: cannot run gws without Google OAuth configured. Surface the
    // same error message the builtin google tools produce so the LLM
    // recognizes the failure class.
    if (!isGoogleConfigured()) {
      return JSON.stringify({
        ok: false,
        error:
          "Google OAuth not configured (missing GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, or GOOGLE_REFRESH_TOKEN)",
      });
    }

    // Token refresh BEFORE exec — fail fast on auth issues instead of
    // letting gws surface a cryptic 401 after a successful HTTP round-trip.
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        ok: false,
        error: `Token refresh failed: ${msg}`,
      });
    }

    // Build argv: gws <service> [resource segments...] <method> [--params ...] [--json ...] [--page-all]
    // Resource is dot-separated for nested subcommands (spaces.messages → ["spaces", "messages"]).
    const argv: string[] = [service];
    if (resource.length > 0) {
      for (const segment of resource.split(".")) {
        if (segment.length > 0) argv.push(segment);
      }
    }
    argv.push(method);
    if (params !== undefined) {
      argv.push("--params", JSON.stringify(params));
    }
    if (json !== undefined) {
      argv.push("--json", JSON.stringify(json));
    }
    if (pageAll) {
      argv.push("--page-all");
    }

    // Inject the token into the child env. Never log it. Strip unrelated
    // Jarvis env that could confuse gws behavior (none currently, but keep
    // the env surface minimal).
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GOOGLE_WORKSPACE_CLI_TOKEN: token,
    };

    const result = await runSubprocess(GWS_BINARY, argv, childEnv, timeoutMs);

    if (result.timedOut) {
      return JSON.stringify({
        ok: false,
        error: `gws subprocess timed out after ${timeoutMs}ms`,
        exitCode: result.exitCode,
      });
    }

    if (result.exitCode !== 0) {
      // Non-zero exit — surface stderr. Sanitize by stripping any token
      // accidentally echoed (belt and suspenders; gws should never do this).
      const stderrClean = result.stderr.replace(token, "[REDACTED]").trim();
      const stdoutClean = result.stdout.replace(token, "[REDACTED]").trim();
      return JSON.stringify({
        ok: false,
        error:
          stderrClean ||
          stdoutClean ||
          `gws exited with code ${result.exitCode}`,
        exitCode: result.exitCode,
      });
    }

    // Success path — parse JSON (or NDJSON if page_all).
    try {
      const parsed = parseGwsOutput(result.stdout, pageAll);
      return JSON.stringify({ ok: true, result: parsed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // gws returned 0 but the output didn't parse — surface raw for debugging.
      return JSON.stringify({
        ok: false,
        error: `gws output did not parse as JSON: ${msg}`,
        rawPreview: result.stdout.slice(0, 500),
      });
    }
  },
};
