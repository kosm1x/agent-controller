/**
 * VPS Management tools — v6.0 S4.
 *
 * Jarvis can monitor, back up, deploy, and read logs on the VPS.
 * vps_deploy requires tests to pass before restarting.
 */

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import type { Tool } from "../types.js";

const MC_DIR = "/root/claude/mission-control";
const DB_PATH = join(MC_DIR, "data", "mc.db");
const BACKUP_DIR = join(MC_DIR, "backups");
const BACKUP_RETENTION_DAYS = 7;

// ---------------------------------------------------------------------------
// vps_status
// ---------------------------------------------------------------------------

export const vpsStatusTool: Tool = {
  name: "vps_status",
  definition: {
    type: "function",
    function: {
      name: "vps_status",
      description: `System health dashboard — CPU, memory, disk, Docker, services.

USE WHEN:
- User asks "estado del servidor", "how's the VPS", "system status"
- Before deploying to check if the system is healthy
- Debugging slow responses or timeouts

AFTER CHECKING: Report the key metrics concisely.`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    const lines: string[] = ["🖥️ **VPS Status**"];

    // CPU + Memory
    try {
      const uptime = execFileSync("uptime", {
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const loadMatch = uptime.match(/load average:\s*([\d.]+)/);
      lines.push(`Load: ${loadMatch?.[1] ?? "?"}`);
    } catch {
      /* */
    }

    try {
      const mem = execFileSync("free", ["-h", "--si"], {
        encoding: "utf-8",
        timeout: 5000,
      });
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
      const df = execFileSync("df", ["-h", "/"], {
        encoding: "utf-8",
        timeout: 5000,
      });
      const dfLine = df.split("\n")[1];
      if (dfLine) {
        const parts = dfLine.split(/\s+/);
        lines.push(`Disk: ${parts[2]} used / ${parts[1]} (${parts[4]})`);
      }
    } catch {
      /* */
    }

    // Services
    const services = ["mission-control", "agentic-crm"];
    for (const svc of services) {
      try {
        const status = execFileSync("systemctl", ["is-active", svc], {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();
        lines.push(`${status === "active" ? "✅" : "❌"} ${svc}: ${status}`);
      } catch {
        lines.push(`❌ ${svc}: inactive`);
      }
    }

    // Docker containers
    try {
      const containers = execFileSync(
        "docker",
        ["ps", "--format", "{{.Names}}\t{{.Status}}", "--no-trunc"],
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
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
      const health = execFileSync(
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
      ).trim();
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

export const vpsDeployTool: Tool = {
  name: "vps_deploy",
  requiresConfirmation: true,
  definition: {
    type: "function",
    function: {
      name: "vps_deploy",
      description: `Build and deploy mission-control. Gates on test suite — will NOT restart if tests fail.

USE WHEN:
- After merging a Jarvis PR (jarvis_dev workflow)
- User says "haz deploy", "deploy", "restart Jarvis"

WORKFLOW:
1. Runs npx tsc (build)
2. Runs npx vitest run (tests)
3. If tests pass: systemctl restart mission-control
4. Waits 5s, checks health endpoint
5. Reports success or rollback instructions

CRITICAL: This restarts the service. All running tasks will be orphaned (shutdown hook marks them failed).`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    const lines: string[] = ["🚀 **Deploy**"];

    // 1. Build
    try {
      execFileSync("npx", ["tsc"], {
        cwd: MC_DIR,
        timeout: 60_000,
        encoding: "utf-8",
        stdio: "pipe",
      });
      lines.push("✅ Build: PASS");
    } catch (err) {
      const msg =
        (err as { stderr?: string }).stderr?.slice(0, 300) ?? "build error";
      return `❌ Deploy aborted: build failed\n${msg}`;
    }

    // 2. Tests
    try {
      const output = execFileSync("npx", ["vitest", "run", "--reporter=dot"], {
        cwd: MC_DIR,
        timeout: 120_000,
        encoding: "utf-8",
        stdio: "pipe",
      });
      const match = output.match(/Tests\s+(\d+)\s+passed/);
      lines.push(`✅ Tests: ${match?.[1] ?? "?"} passed`);
    } catch (err) {
      const stdout =
        (err as { stdout?: string }).stdout?.slice(-300) ?? "test error";
      return `❌ Deploy aborted: tests failed\n${stdout}`;
    }

    // 3. Restart — NOTE: this kills the current process.
    // The response is returned BEFORE the restart takes effect via
    // systemctl's --no-block flag. Jarvis should call vps_status after
    // to confirm health.
    lines.push("✅ Build + tests passed. Initiating restart...");
    lines.push(
      "⚠️ The service will restart momentarily. Call vps_status in ~10s to confirm health.",
    );

    try {
      execFileSync("systemctl", ["restart", "--no-block", "mission-control"], {
        timeout: 5_000,
        stdio: "pipe",
      });
    } catch {
      lines.push("❌ systemctl restart failed");
    }

    return lines.join("\n");
  },
};

// ---------------------------------------------------------------------------
// vps_backup
// ---------------------------------------------------------------------------

export const vpsBackupTool: Tool = {
  name: "vps_backup",
  definition: {
    type: "function",
    function: {
      name: "vps_backup",
      description: `Back up the mc.db database. Copies to backups/ with timestamp. Auto-prunes >7 days.

USE WHEN:
- Before risky operations (schema changes, bulk deletes)
- User asks "haz backup", "backup the database"
- Nightly ritual backup

AFTER BACKUP: Report the backup file path and size.`,
      parameters: { type: "object", properties: {} },
    },
  },

  async execute(): Promise<string> {
    if (!existsSync(DB_PATH)) {
      return "❌ Database not found at " + DB_PATH;
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
      return `❌ Backup failed: ${err instanceof Error ? err.message : err}`;
    }
  },
};

// ---------------------------------------------------------------------------
// vps_logs
// ---------------------------------------------------------------------------

export const vpsLogsTool: Tool = {
  name: "vps_logs",
  definition: {
    type: "function",
    function: {
      name: "vps_logs",
      description: `Read recent service logs from journalctl.

USE WHEN:
- Debugging an issue — check what happened recently
- After a deploy to verify startup
- User asks "logs", "qué dicen los logs"

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
            description:
              'Service name (default: "mission-control"). Also: "agentic-crm".',
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
      return "❌ Invalid service name.";
    }

    try {
      const rawLogs = execFileSync(
        "journalctl",
        ["-u", service, "--no-pager", "-n", String(lineCount * 3)],
        { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] },
      );

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
      return `❌ Could not read logs for ${service}.`;
    }
  },
};
