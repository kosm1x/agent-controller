/**
 * VPS Management tools — v6.0 S4.
 *
 * Jarvis can monitor, back up and read logs on the VPS. Deploying is the
 * operator's: vps_deploy hands over the deploy line and spawns nothing.
 */

import { execFile } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import type { Tool } from "../types.js";

const MC_DIR = "/root/claude/mission-control";
const DB_PATH = join(MC_DIR, "data", "mc.db");
const BACKUP_DIR = join(MC_DIR, "backups");
const BACKUP_RETENTION_DAYS = 7;

// Async on purpose (2026-10-26): execFileSync blocked the event loop for the
// child's whole run, so a slow `docker ps`, curl or journalctl froze every
// other task and could cross the 5 s MCEventLoopBlock alert. Promisified
// children keep stdin open; each site closes it right after spawn so a child
// that reads stdin fails fast instead of hanging to the timeout.
const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// vps_status
// ---------------------------------------------------------------------------

export const vpsStatusTool: Tool = {
  name: "vps_status",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  deferred: true,
  triggerPhrases: [
    "cómo está el servidor",
    "estado del VPS",
    "server status",
    "cuánta memoria queda",
    "revisa el server",
  ],
  definition: {
    type: "function",
    function: {
      name: "vps_status",
      description: `System health dashboard — CPU, memory, disk, Docker, mission-control service.

USE WHEN:
- User asks "estado del servidor", "how's the VPS", "system status"
- Before the operator deploys, to check whether the system is healthy
- Debugging slow responses or timeouts

DO NOT USE WHEN:
- You want what a service logged (errors, startup lines): this tool returns no log lines — use vps_logs when it is among your tools.
- You want to deploy or restart the service: this tool only reads.
- You want the state of a unit other than mission-control: this tool checks only that one unit, the first ten running Docker containers and the health endpoint.

AFTER CHECKING: Report the key metrics concisely.`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    const lines: string[] = ["🖥️ **VPS Status**"];

    // CPU + Memory
    try {
      const p = execFileAsync("uptime", {
        encoding: "utf-8",
        timeout: 5000,
      });
      p.child.stdin?.end();
      const uptime = (await p).stdout.trim();
      const loadMatch = uptime.match(/load average:\s*([\d.]+)/);
      lines.push(`Load: ${loadMatch?.[1] ?? "?"}`);
    } catch {
      /* */
    }

    try {
      const p = execFileAsync("free", ["-h", "--si"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      p.child.stdin?.end();
      const mem = (await p).stdout;
      const memLine = mem.split("\n").find((l) => l.startsWith("Mem:"));
      if (memLine) {
        const parts = memLine.split(/\s+/);
        lines.push(`Memory: ${parts[2]} used / ${parts[1]} total`);
      }
    } catch {
      /* */
    }

    // Disk
    try {
      const p = execFileAsync("df", ["-h", "/"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      p.child.stdin?.end();
      const df = (await p).stdout;
      const dfLine = df.split("\n")[1];
      if (dfLine) {
        const parts = dfLine.split(/\s+/);
        lines.push(`Disk: ${parts[2]} used / ${parts[1]} (${parts[4]})`);
      }
    } catch {
      /* */
    }

    // Services
    const services = ["mission-control"];
    for (const svc of services) {
      try {
        const p = execFileAsync("systemctl", ["is-active", svc], {
          encoding: "utf-8",
          timeout: 5000,
        });
        p.child.stdin?.end();
        const status = (await p).stdout.trim();
        lines.push(`${status === "active" ? "✅" : "❌"} ${svc}: ${status}`);
      } catch {
        lines.push(`❌ ${svc}: inactive`);
      }
    }

    // Docker containers
    try {
      const p = execFileAsync(
        "docker",
        ["ps", "--format", "{{.Names}}\t{{.Status}}", "--no-trunc"],
        { encoding: "utf-8", timeout: 5000 },
      );
      p.child.stdin?.end();
      const containers = (await p).stdout.trim();
      if (containers) {
        lines.push("\n**Docker:**");
        for (const c of containers.split("\n").slice(0, 10)) {
          const [name, ...status] = c.split("\t");
          lines.push(`  ${name}: ${status.join(" ")}`);
        }
      }
    } catch {
      /* */
    }

    // Health endpoint
    try {
      const p = execFileAsync(
        "curl",
        [
          "-s",
          "-o",
          "/dev/null",
          "-w",
          "%{http_code}",
          "http://localhost:8080/health",
        ],
        { encoding: "utf-8", timeout: 5000 },
      );
      p.child.stdin?.end();
      const health = (await p).stdout.trim();
      lines.push(
        `\nHealth endpoint: ${health === "200" ? "✅ 200 OK" : `❌ ${health}`}`,
      );
    } catch {
      /* */
    }

    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// vps_deploy
// ---------------------------------------------------------------------------

const DEPLOY_OPERATOR_LINE = `cd ${MC_DIR} && ./scripts/deploy.sh`;
const DEPLOY_HANDOVER =
  "El deploy de mission-control lo hace solo el operador con el script de deploy, " +
  "que antes de compilar rechaza código sin commit, dependencias que no coinciden con el lockfile y tareas en curso, " +
  "respalda la base de datos antes de una migración y después verifica salud y canales. " +
  "Esta herramienta no compila, no corre tests ni reinicia el servicio. " +
  `Pásale al operador esta línea para la terminal del servidor: ${DEPLOY_OPERATOR_LINE}`;

export const vpsDeployTool: Tool = {
  name: "vps_deploy",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  requiresConfirmation: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "vps_deploy",
      description: `Hand the mission-control deploy to the operator. This tool does not build, run tests or restart the service, and it starts no process: when it runs, it returns the same error object every time, whose text says that only the operator deploys, with the deploy script, and gives the command to run in the server's terminal. That error means the tool does not deploy, not that a deploy failed.

USE WHEN:
- The user asks to deploy mission-control ("haz deploy", "deploy")
- A pull request from the jarvis_dev workflow was merged and the change has to go live

DO NOT USE WHEN:
- You want to check whether the service is healthy — use vps_status when it is among your tools
- You want the service logs, for example after the operator's deploy — use vps_logs when it is among your tools

AFTER CALLING: Give the user the command from the error text exactly as written and say that only the operator runs it. Never report the deploy as done, started or scheduled.`,
      parameters: { type: "object", properties: {} },
    },
  },

  // Deploying is the operator's (ruling 4cm): deploy.sh refuses uncommitted
  // code, a dependency folder that does not match the lockfile and running
  // tasks, snapshots the database before a migrating deploy and verifies
  // health and channels afterwards. This tool spawns nothing on any path; it
  // hands the operator the line to run.
  async execute(): Promise<string> {
    return JSON.stringify({ error: DEPLOY_HANDOVER });
  },
};

// ---------------------------------------------------------------------------
// vps_backup
// ---------------------------------------------------------------------------

export const vpsBackupTool: Tool = {
  name: "vps_backup",
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "vps_backup",
      description: `Back up the mc.db database. Copies to backups/ with timestamp. Deletes files in backups/ older than 7 days.

USE WHEN:
- Before risky operations (schema changes, bulk deletes)
- User asks "haz backup", "backup the database"

DO NOT USE WHEN:
- You want to back up files or a database other than mc.db: this tool copies only mc.db.
- You want to restore a backup: this tool has no restore.
- You only want to see which backups exist, or need the files older than 7 days in backups/ kept: each successful call writes a new copy and then deletes such files.

AFTER BACKUP: Report the backup file path and size.`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    if (!existsSync(DB_PATH)) {
      return JSON.stringify({ error: "Database not found at " + DB_PATH });
    }

    mkdirSync(BACKUP_DIR, { recursive: true });

    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const backupPath = join(BACKUP_DIR, `mc.db.${timestamp}`);

    try {
      // Use SQLite backup API for WAL-safe consistent snapshots
      const { getDatabase } = await import("../../db/index.js");
      const db = getDatabase();
      await db.backup(backupPath);
      const sizeKB = Math.round(statSync(backupPath).size / 1024);

      // Prune old backups
      let pruned = 0;
      const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 86400_000;
      for (const f of readdirSync(BACKUP_DIR)) {
        const full = join(BACKUP_DIR, f);
        if (full === backupPath) continue; // never delete what we just created
        if (statSync(full).mtimeMs < cutoff) {
          unlinkSync(full);
          pruned++;
        }
      }

      const lines = [
        `💾 **Backup complete**`,
        `File: ${backupPath}`,
        `Size: ${sizeKB} KB`,
      ];
      if (pruned > 0) lines.push(`Pruned: ${pruned} old backup(s)`);
      return lines.join("\n");
    } catch (err) {
      return JSON.stringify({
        error: `Backup failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  },
};

// ---------------------------------------------------------------------------
// vps_logs
// ---------------------------------------------------------------------------

export const vpsLogsTool: Tool = {
  name: "vps_logs",
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
  deferred: true,
  definition: {
    type: "function",
    function: {
      name: "vps_logs",
      description: `Read recent service logs from journalctl.

USE WHEN:
- Debugging an issue — check what happened recently
- After a deploy to verify startup
- User asks "logs", "qué dicen los logs"

DO NOT USE WHEN:
- You want to know whether the mission-control service is up or healthy now: this tool returns log lines only, with no unit state or health check — use vps_status when it is among your tools.
- You want a Docker container's output: this tool reads a systemd unit's journal by unit name (journalctl -u), and a container name is not a unit name.
- You want entries older than the newest few hundred: the filter runs only over the newest 3 × lines journal entries (at most 300), not over the whole journal.

Returns filtered log entries. Default: last 30 lines of mission-control.`,
      parameters: {
        type: "object",
        properties: {
          lines: {
            type: "number",
            description: "Number of lines to return (default: 30, max: 100)",
          },
          service: {
            type: "string",
            description: 'Service name (default: "mission-control").',
          },
          filter: {
            type: "string",
            description:
              'Filter keyword (e.g. "error", "warn", "halluc"). Case-insensitive.',
          },
        },
      },
    },
  },

  async execute(args: Record<string, unknown>): Promise<string> {
    const lineCount = Math.min(Math.max(Number(args.lines) || 30, 1), 100);
    const service = (args.service as string) ?? "mission-control";
    const filter = args.filter as string | undefined;

    // Validate service name (prevent injection)
    if (!/^[a-z0-9-]+$/.test(service)) {
      return JSON.stringify({ error: "Invalid service name." });
    }

    try {
      const p = execFileAsync(
        "journalctl",
        ["-u", service, "--no-pager", "-n", String(lineCount * 3)],
        // execFile always pipes stdio (the sync `stdio: [pipe x3]` is implied).
        { encoding: "utf-8", timeout: 10_000 },
      );
      p.child.stdin?.end();
      const rawLogs = (await p).stdout;

      let lines = rawLogs.split("\n").filter(Boolean);

      if (filter) {
        const re = new RegExp(filter, "i");
        lines = lines.filter((l) => re.test(l));
      }

      lines = lines.slice(-lineCount);

      if (lines.length === 0) {
        return `📋 No log entries found for ${service}${filter ? ` matching "${filter}"` : ""}.`;
      }

      // Trim timestamps for readability
      const trimmed = lines.map((l) =>
        l
          .replace(/^\w+\s+\d+\s+[\d:]+\s+\S+\s+\S+\[\d+\]:\s*/, "")
          .slice(0, 200),
      );

      return `📋 **${service}** (${trimmed.length} lines${filter ? `, filter: "${filter}"` : ""})\n\n${trimmed.join("\n")}`;
    } catch {
      return JSON.stringify({ error: `Could not read logs for ${service}.` });
    }
  },
};
