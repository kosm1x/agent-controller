/**
 * Shell execution tool.
 *
 * Executes a shell command with timeout and output limits.
 */

import { execSync } from "child_process";
import type { Tool } from "../types.js";

const MAX_OUTPUT = 10_000; // chars
const TIMEOUT_MS = 30_000; // 30 seconds

export const shellTool: Tool = {
  name: "shell_exec",
  definition: {
    type: "function",
    function: {
      name: "shell_exec",
      description:
        "Execute a shell command and return its output. Use for running system commands, scripts, or CLI tools.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
          timeout_ms: {
            type: "number",
            description: `Timeout in milliseconds (default: ${TIMEOUT_MS}, max: 60000)`,
          },
        },
        required: ["command"],
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const command = args.command as string;
    if (!command) {
      return JSON.stringify({ error: "command is required" });
    }

    const timeout = Math.min(
      typeof args.timeout_ms === "number" ? args.timeout_ms : TIMEOUT_MS,
      60_000,
    );

    try {
      const output = execSync(command, {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });

      const trimmed =
        output.length > MAX_OUTPUT
          ? output.slice(0, MAX_OUTPUT) +
            `\n... (truncated, ${output.length} total chars)`
          : output;

      return JSON.stringify({ stdout: trimmed, exit_code: 0 });
    } catch (err: unknown) {
      const error = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return JSON.stringify({
        exit_code: error.status ?? 1,
        stdout: (error.stdout ?? "").slice(0, MAX_OUTPUT),
        stderr: (error.stderr ?? error.message ?? "").slice(0, MAX_OUTPUT),
      });
    }
  },
};
