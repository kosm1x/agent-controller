/**
 * Ritual scheduler.
 *
 * Uses node-cron to submit pre-configured tasks at scheduled times.
 * Idempotent: checks if a ritual already ran today before submitting.
 */

import cron, { type ScheduledTask } from "node-cron";
import { execFileSync } from "child_process";
import { getDatabase } from "../db/index.js";
import { scheduleCanary, stopCanary } from "./canary.js";
import { submitTask, type TaskSubmission } from "../dispatch/dispatcher.js";
import { getRouter } from "../messaging/index.js";
import { getEventBus } from "../lib/event-bus.js";
import { rituals, RITUALS_TIMEZONE, type RitualDefinition } from "./config.js";
import { createMorningBriefing } from "./morning.js";
import { composeMorningBriefDriftSection } from "../lib/s3/delivery.js";
import { createNightlyClose } from "./nightly.js";
import { createEvolutionLogEntry } from "./evolution-log.js";
import { createDayNarrative } from "./day-narrative.js";
import { createEvolutionRitual } from "./evolution.js";
import { createWeeklyReview } from "./weekly-review.js";
import { createSignalIntelligence } from "./signal-intelligence.js";
import { executeOvernightTuning } from "./overnight-tuning.js";
import { createMarketMorningScan } from "./market-morning-scan.js";
import { createMarketEodScan } from "./market-eod-scan.js";
import { createPmDailyRebalance } from "./pm-daily-rebalance.js";
import { isNyseTradingDay } from "../finance/market-calendar.js";
import { getConfig } from "../config.js";

const scheduledJobs: ScheduledTask[] = [];

/**
 * Dim-4 R5 fix: record a ritual failure as a persistent event.
 *
 * Static rituals (morning-briefing, market-*, nightly-close, kb-backup,
 * memory-consolidation, diff-digest, stale-artifact-prune) previously logged
 * failures to console only — full-system-audit success criterion requires an
 * events row with category=schedule + type=failed so health queries,
 * monitoring, and reaction rules can catch systemic ritual outages.
 *
 * Always best-effort: if the bus isn't initialized yet (e.g. during boot
 * before initEventBus ran), we swallow the throw rather than mask the real
 * failure. console.error still fires at the caller for tail-the-log diagnosis.
 */
function recordRitualFailure(
  ritualId: string,
  err: unknown,
  phase: "submit" | "execute",
): void {
  const message = err instanceof Error ? err.message : String(err);
  try {
    getEventBus().emitEvent("schedule.run_failed", {
      ritual_id: ritualId,
      error: message.slice(0, 1000),
      phase,
    });
  } catch (busErr) {
    // Dim-4 round-2 C-RES-5/M-RES-6 fix: the prior bare `catch {}` silently
    // swallowed EVERY throw — event-bus-not-initialized AND any programming
    // bug in the emit path (type mismatch after payload shape change,
    // SQLITE_MISUSE on a closed DB during shutdown, etc.). That turned the
    // enforcement gate into theater. Narrow swallow: still non-fatal, but
    // passthrough to console so the break is observable in journalctl.
    const busMsg = busErr instanceof Error ? busErr.message : String(busErr);
    console.error(
      `[rituals] recordRitualFailure: event bus unavailable (${busMsg}) — original error: ${message}`,
    );
  }
}

function todayLabel(timezone: string = RITUALS_TIMEZONE): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: timezone });
}

function getTaskTemplate(ritual: RitualDefinition): TaskSubmission {
  // Audit W1 round 1: compute date in the ritual's own timezone so title +
  // dedup keys align across DST / day-boundary edges between MX and NY.
  const date = todayLabel(ritual.timezone);
  switch (ritual.id) {
    case "signal-intelligence":
      return createSignalIntelligence(date);
    case "morning-briefing": {
      // v7.7 Spine 2 Bundle 2+3: pre-render S3 drift alerts + Sunday aging
      // baseline reminders for inclusion in the brief. Computed at task-
      // creation time (not via an LLM tool) so the LLM's job is verbatim
      // delivery, not source-of-truth authorship. DB query failure is
      // swallowed at the composer layer; alert injection failure MUST NOT
      // block the brief itself.
      let alertSection = "";
      try {
        alertSection = composeMorningBriefDriftSection();
      } catch (err) {
        console.warn(
          "[rituals] S3 brief section load failed (brief proceeds without it):",
          err instanceof Error ? err.message : err,
        );
      }
      return createMorningBriefing(date, alertSection);
    }
    case "nightly-close":
      return createNightlyClose(date);
    case "skill-evolution":
      return createEvolutionRitual(date);
    case "day-narrative":
      return createDayNarrative(date);
    case "evolution-log":
      return createEvolutionLogEntry(date);
    case "weekly-review":
      return createWeeklyReview(date);
    case "market-morning-scan":
      return createMarketMorningScan(date);
    case "market-eod-scan":
      return createMarketEodScan(date);
    case "pm-daily-rebalance":
      return createPmDailyRebalance(date);
    default:
      throw new Error(`Unknown ritual: ${ritual.id}`);
  }
}

/**
 * Check if a ritual already ran today by looking for a task with a matching
 * title prefix and today's date in the title.
 */
function alreadyRanToday(ritual: RitualDefinition): boolean {
  const db = getDatabase();
  const date = todayLabel(ritual.timezone);
  const titlePattern = `${ritual.title} — ${date}`;

  const row = db
    .prepare(
      "SELECT 1 FROM tasks WHERE title = ? AND status != 'cancelled' LIMIT 1",
    )
    .get(titlePattern);

  return row !== undefined;
}

async function executeRitual(ritual: RitualDefinition): Promise<void> {
  if (alreadyRanToday(ritual)) {
    console.log(
      `[rituals] ${ritual.id}: already ran today (${todayLabel(ritual.timezone)}), skipping`,
    );
    return;
  }

  // Audit W4 round 1: belt-and-braces trading-day gate at the scheduler
  // level. Prompt-level gate in the ritual template is the first line of
  // defense; this catches the hallucination case where the LLM ignores the
  // calendar instruction and proceeds into a full-budget run on a holiday.
  if (ritual.id === "market-morning-scan" || ritual.id === "market-eod-scan") {
    const today = todayLabel(ritual.timezone);
    if (!isNyseTradingDay(today)) {
      console.log(
        `[rituals] ${ritual.id}: NYSE not trading on ${today}, skipping`,
      );
      return;
    }
  }

  // Overnight tuning runs its own async loop instead of submitting a task.
  // It needs 25+ cycles with state carried across them, exceeding fast-runner limits.
  if (ritual.id === "overnight-tuning") {
    await executeOvernightTuning();
    return;
  }

  const template = getTaskTemplate(ritual);
  template.interactive = false; // Rituals have no interactive user
  // Tag the submission so dispatcher.ts wraps runner.execute() in
  // ritualContext, exempting the ritual's legitimate SELECT/curl chains from
  // the flailing-guard. See P1+P2 in feedback_evolution_log_misattribution.
  template.ritualId = ritual.id;

  try {
    const result = await submitTask(template);
    console.log(
      `[rituals] ${ritual.id}: submitted task ${result.taskId} (agent: ${result.agentType}) at ${new Date().toISOString()}`,
    );

    // Notify messaging router to broadcast ritual result on completion
    const router = getRouter();
    if (router) {
      router.watchRitualTask(result.taskId, ritual.id);
    }
  } catch (err) {
    console.error(`[rituals] ${ritual.id}: failed to submit —`, err);
    recordRitualFailure(ritual.id, err, "submit");
  }
}

export function startRitualScheduler(): void {
  const config = getConfig();

  for (const ritual of rituals) {
    // V8.1 Phase 8: when briefing delivery is activated, the new
    // morning-surface trigger (src/triggers/morning-surface.ts) replaces the
    // legacy morning-briefing ritual — skip the old one so the operator does
    // not receive two morning briefs. Reversible: flag off (the default) →
    // the legacy ritual runs unchanged.
    if (
      ritual.id === "morning-briefing" &&
      process.env.V81_BRIEF_DELIVERY_ENABLED === "true"
    ) {
      console.log(
        "[rituals] morning-briefing: superseded by V8.1 morning-surface trigger, skipping",
      );
      continue;
    }

    // Overnight tuning is gated by TUNING_ENABLED env var, not static config
    const isEnabled =
      ritual.id === "overnight-tuning" ? config.tuningEnabled : ritual.enabled;

    if (!isEnabled) {
      console.log(`[rituals] ${ritual.id}: disabled, skipping`);
      continue;
    }

    // Allow per-ritual timezone override (F9 market rituals use
    // America/New_York so 8:00 AM / 4:30 PM align with NYSE hours across DST).
    const tz = ritual.timezone ?? RITUALS_TIMEZONE;
    // Catch at the cron boundary: throws BEFORE the submitTask try/catch
    // inside executeRitual (alreadyRanToday DB read hitting SQLITE_BUSY,
    // unknown template id, trading-day check) otherwise escape as unhandled
    // rejections and bypass recordRitualFailure — the reaction rules built to
    // catch systemic ritual outages miss exactly this class.
    const job = cron.schedule(
      ritual.cron,
      () =>
        void executeRitual(ritual).catch((err) => {
          console.error(`[rituals] ${ritual.id}: execute failed —`, err);
          recordRitualFailure(ritual.id, err, "execute");
        }),
      { timezone: tz },
    );

    scheduledJobs.push(job);
    console.log(`[rituals] ${ritual.id}: scheduled (${ritual.cron}, tz=${tz})`);
  }

  // Mechanical backups + autonomous improvement + safeguards + canary + consolidation
  scheduleKbBackup();
  scheduleKbReindex();
  scheduleAutonomousImprovement();
  scheduleDiffDigest();
  scheduleMemoryConsolidation();
  scheduleStaleArtifactPrune();
  scheduleHindsightCostPull();
  schedulePrometheusAlertPoller();

  // v6.4 H3: Self-monitoring canary — health alerts every 4 hours
  try {
    scheduleCanary();
  } catch (err) {
    console.error(
      `[rituals] Failed to schedule canary: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// SG5: Pre-cycle git tags for autonomous improvement rollback
// ---------------------------------------------------------------------------

const MC_DIR = "/root/claude/mission-control";

/** Create an annotated git tag before autonomous improvement. Non-fatal. */
export function createPreCycleTag(): void {
  const date = new Date().toISOString().slice(0, 10);
  const tagName = `pre-auto-${date}`;

  try {
    const existing = execFileSync("git", ["tag", "-l", tagName], {
      cwd: MC_DIR,
      timeout: 5000,
      encoding: "utf-8",
    }).trim();
    if (existing) {
      console.log(
        `[rituals] pre-cycle tag ${tagName} already exists, skipping`,
      );
      return;
    }

    execFileSync(
      "git",
      ["tag", "-a", tagName, "-m", "Pre-autonomous-improvement snapshot"],
      { cwd: MC_DIR, timeout: 10_000, encoding: "utf-8" },
    );
    console.log(`[rituals] Created pre-cycle tag: ${tagName}`);

    pruneOldTags();
  } catch (err) {
    console.error("[rituals] Failed to create pre-cycle tag:", err);
  }
}

/** Prune pre-auto-* tags: keep last 10, delete any older than 30 days. */
export function pruneOldTags(): void {
  try {
    const raw = execFileSync(
      "git",
      ["tag", "-l", "pre-auto-*", "--sort=-version:refname"],
      { cwd: MC_DIR, timeout: 5000, encoding: "utf-8" },
    ).trim();
    const tags = raw ? raw.split("\n").filter(Boolean) : [];

    if (tags.length <= 10) return;

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    for (const tag of tags.slice(10)) {
      const dateStr = tag.replace("pre-auto-", "");
      const tagDate = new Date(dateStr);
      if (tagDate < thirtyDaysAgo) {
        execFileSync("git", ["tag", "-d", tag], {
          cwd: MC_DIR,
          timeout: 5000,
          encoding: "utf-8",
        });
        console.log(`[rituals] Pruned old tag: ${tag}`);
      }
    }
  } catch (err) {
    console.error("[rituals] Tag pruning failed:", err);
  }
}

/** Autonomous improvement — detects issues, creates fix branch + PR. */
function scheduleAutonomousImprovement(): void {
  // 1:30 AM Tue/Thu/Sat — right after overnight tuning (1:00 AM)
  const job = cron.schedule(
    "30 1 * * 2,4,6",
    async () => {
      try {
        // SG5: Create pre-cycle snapshot tag
        createPreCycleTag();

        const { createImprovementTask } =
          await import("./autonomous-improvement.js");
        const task = createImprovementTask();
        if (!task) return; // no candidates or gates blocked

        task.interactive = false; // Autonomous — no interactive user
        const result = await submitTask(task);
        console.log(
          `[rituals] autonomous-improvement: submitted task ${result.taskId} (agent: ${result.agentType})`,
        );

        const router = getRouter();
        if (router) {
          router.watchRitualTask(result.taskId, "autonomous-improvement");
        }
      } catch (err) {
        console.error("[rituals] autonomous-improvement failed:", err);
        recordRitualFailure("autonomous-improvement", err, "execute");
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] autonomous-improvement: scheduled (30 1 * * 2,4,6, tz=${RITUALS_TIMEZONE})`,
  );
}

/** Mechanical KB backup — no LLM, just pushes jarvis_files to Postgres. */
function scheduleKbBackup(): void {
  // 10:30 PM daily — right after nightly close
  const job = cron.schedule(
    "30 22 * * *",
    async () => {
      try {
        const { syncKbToRemote } = await import("../db/kb-backup.js");
        const result = await syncKbToRemote();
        console.log(
          `[rituals] kb-backup: ${result.pushed} files synced to db.mycommit.net (${result.duration_ms}ms)`,
        );
      } catch (err) {
        console.error("[rituals] kb-backup failed:", err);
        recordRitualFailure("kb-backup", err, "execute");
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] kb-backup: scheduled (30 22 * * *, tz=${RITUALS_TIMEZONE})`,
  );
}

/**
 * Mechanical KB reindex — walks the FS mirror at /root/claude/jarvis-kb/
 * and upserts any .md files missing from the jarvis_files table. Catches
 * drift introduced by external writers (shell_exec, manual edits, batch
 * migrations) that bypass `upsertFile()`. 2026-05-07: shipped after a
 * one-off pass restored 1229 orphan files. Hourly cadence keeps drift
 * bounded without busy-looping.
 */
function scheduleKbReindex(): void {
  const job = cron.schedule(
    "10 * * * *",
    async () => {
      try {
        const { reindexJarvisKb } = await import("../db/jarvis-reindex.js");
        const result = reindexJarvisKb();
        if (result.drift > 0) {
          console.log(
            `[rituals] kb-reindex: drift=${result.drift} upserted=${result.upserted} errored=${result.errored} (${result.durationMs}ms)`,
          );
        }
        // Queue #12 (2026-05-07): emit drift + counts to Prometheus so the
        // KB-orphan failure mode is observable. Alert rule
        // `KbReindexDrift` fires when drift > 10 for 2h+ (≥2 consecutive runs).
        const { recordKbReindex } =
          await import("../observability/prometheus.js");
        recordKbReindex({
          drift: result.drift,
          fsCount: result.fsCount,
          dbCount: result.dbCount,
          errored: result.errored,
        });
      } catch (err) {
        console.error("[rituals] kb-reindex failed:", err);
        recordRitualFailure("kb-reindex", err, "execute");
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] kb-reindex: scheduled (10 * * * *, tz=${RITUALS_TIMEZONE})`,
  );
}

/**
 * v7.7.3: Prune stale runner artifacts — orphaned Docker containers.
 *
 * Normal-path: every `spawnContainer()` call uses `--rm`, so containers
 * auto-clean on exit. But if mission-control crashes mid-run (OOM,
 * segfault, hard reboot), the `--rm` hook doesn't fire and the container
 * survives in `exited` state until `docker container prune` is run.
 *
 * This ritual runs hourly, finds exited containers whose name matches
 * the EXACT runner-name shape produced by `generateContainerName()` in
 * `src/runners/container.ts` (`mc-<prefix>-<13-digit-timestamp>`), and
 * only if they're older than 6 hours. Long-running non-runner
 * containers that share the `mc-` namespace (mc-grafana, mc-prometheus,
 * mc-node-exporter) are protected by the strict post-filter regex and
 * MUST NOT match. Unit tests enforce that invariant.
 *
 * Adopted from NanoClaw v1.2.48 (2026-04-12) "auto-prune stale session
 * artifacts on startup + daily" per reference_nanoclaw_upstream.md
 * Tier 1 adoption list. Our accumulation surface is smaller (no
 * per-session workspace files because we use claude-agent-sdk as a
 * library, not Claude Code as a subprocess), so Docker containers are
 * the one real risk.
 *
 * v7.7.4 audit follow-up (qa-auditor 2026-04-14) fixed:
 *   C1  Strict name regex — mc-grafana / mc-prometheus no longer match
 *   C2  Docker CLI name filter is untrusted — verify in TS after parse
 *   M1  Per-id rm with per-container try/catch + summary log
 *   M2  ENOENT / spawn-not-found silenced for test environments
 *   M3  Batch cap (50 per cycle) to prevent E2BIG on crash loops
 *   M4  Unit tests cover the mc-grafana-must-not-match case
 *   MN1 Age gate raised 1h → 6h so long-running heavy-runner tasks
 *       can drain stdout after exit without racing the next tick
 */
const RUNNER_NAME_RE = /^mc-[a-z0-9-]+-\d{13}$/;
const PRUNE_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours
const PRUNE_BATCH_CAP = 50;
const DOCKER_UNAVAILABLE_RE =
  /no such|not found|cannot connect|ENOENT|spawn\s+docker|permission denied while trying to connect/i;

/** Exposed for testing. Applies the RUNNER_NAME_RE + age filter to a
 *  tab-separated `docker container ls` output. */
export function selectStaleContainersForPrune(
  listOutput: string,
  nowMs: number = Date.now(),
): Array<{ id: string; name: string }> {
  const ageCutoff = nowMs - PRUNE_AGE_MS;
  const out: Array<{ id: string; name: string }> = [];
  for (const line of listOutput.split("\n")) {
    if (!line.trim()) continue;
    const [id, name, createdAt] = line.split("\t");
    if (!id || !name || !createdAt) continue;
    // Strict name shape — mc-grafana, mc-prometheus etc. must NOT match.
    if (!RUNNER_NAME_RE.test(name)) continue;
    const createdMs = Date.parse(createdAt);
    if (Number.isNaN(createdMs)) continue;
    if (createdMs >= ageCutoff) continue;
    out.push({ id, name });
    if (out.length >= PRUNE_BATCH_CAP) break;
  }
  return out;
}

function scheduleStaleArtifactPrune(): void {
  // Every hour at :17 so it doesn't collide with the backup cron or the
  // nightly close ritual. Cron TZ is noise for hourly cadence but kept
  // consistent with the rest of the scheduler.
  const job = cron.schedule(
    "17 * * * *",
    async () => {
      let listOutput: string;
      try {
        // The CLI `name=^mc-` filter is a coarse substring pre-filter in
        // practice — we do not trust it for safety. The strict regex in
        // selectStaleContainersForPrune() is the actual guard.
        listOutput = execFileSync(
          "docker",
          [
            "container",
            "ls",
            "-a",
            "--filter",
            "status=exited",
            "--format",
            "{{.ID}}\t{{.Names}}\t{{.CreatedAt}}",
          ],
          { timeout: 15_000, encoding: "utf-8" },
        ).trim();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!DOCKER_UNAVAILABLE_RE.test(message)) {
          console.error("[rituals] stale-artifact-prune list failed:", message);
          recordRitualFailure("stale-artifact-prune", err, "execute");
        }
        return;
      }

      if (!listOutput) return;

      const candidates = selectStaleContainersForPrune(listOutput);
      if (candidates.length === 0) return;

      // Per-id rm with isolated error handling — one failing container
      // must not abort the batch, and we want a summary at the end.
      let removed = 0;
      const failures: Array<{ name: string; error: string }> = [];
      for (const { id, name } of candidates) {
        try {
          execFileSync("docker", ["container", "rm", id], {
            timeout: 15_000,
            encoding: "utf-8",
          });
          removed++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ name, error: message.slice(0, 120) });
        }
      }

      if (removed > 0) {
        console.log(
          `[rituals] stale-artifact-prune: removed ${removed} orphaned runner container(s)`,
        );
      }
      if (failures.length > 0) {
        console.error(
          `[rituals] stale-artifact-prune: ${failures.length} rm failure(s):`,
          failures,
        );
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] stale-artifact-prune: scheduled (17 * * * *, tz=${RITUALS_TIMEZONE})`,
  );
}

/** CCP7: Memory consolidation — prune stale/duplicate memories. */
function scheduleMemoryConsolidation(): void {
  // 2:30 AM Tue/Thu/Sat — after overnight tuning (1:00 AM)
  const job = cron.schedule(
    "30 2 * * 2,4,6",
    async () => {
      try {
        const { runConsolidation } = await import("../memory/consolidation.js");
        const report = await runConsolidation();
        console.log(
          `[rituals] memory-consolidation: removed ${report.duplicatesRemoved + report.pruned}, remaining ${report.remaining} (${report.durationMs}ms)`,
        );
      } catch (err) {
        console.error("[rituals] memory-consolidation failed:", err);
        recordRitualFailure("memory-consolidation", err, "execute");
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] memory-consolidation: scheduled (30 2 * * 2,4,6, tz=${RITUALS_TIMEZONE})`,
  );
}

/** Weekly diff digest — SG1 safeguard. Summarizes autonomous activity. */
function scheduleDiffDigest(): void {
  // Sunday 8 PM — same timezone as weekly review
  const job = cron.schedule(
    "0 20 * * 0",
    async () => {
      try {
        const { executeDiffDigest } = await import("./diff-digest.js");
        const result = await executeDiffDigest();
        console.log(
          `[rituals] diff-digest: sent=${result.sent}, sections=${result.sections}`,
        );
      } catch (err) {
        console.error("[rituals] diff-digest failed:", err);
        recordRitualFailure("diff-digest", err, "execute");
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] diff-digest: scheduled (0 20 * * 0, tz=${RITUALS_TIMEZONE})`,
  );
}

/**
 * Hindsight cost-pull — every 5 min, scrape Hindsight LLM token counters
 * from mc-prometheus and write per-(scope, model) cost_ledger rows so
 * Hindsight spend rolls into the 3-window budget. Set
 * HINDSIGHT_COST_PULL_ENABLED=false to disable. See queue item #4.
 *
 * Auto-gated when HINDSIGHT_ENABLED!=true: under the 2026-05-10 SDK cutover,
 * retain/reflect stopped writing to Hindsight, so every 5-min pull queries
 * a flat-line series (series=0 recorded=0 cost=$0). Skipping the cron when
 * the write side is off keeps journald free of 288 noise lines/day without
 * losing real signal. Operator can force-run via HINDSIGHT_COST_PULL_ENABLED=true.
 */
function scheduleHindsightCostPull(): void {
  if (process.env.HINDSIGHT_COST_PULL_ENABLED === "false") {
    console.log("[rituals] hindsight-cost-pull: disabled via env");
    return;
  }
  // Skip when Hindsight writes are off, unless explicitly force-enabled.
  if (
    process.env.HINDSIGHT_ENABLED !== "true" &&
    process.env.HINDSIGHT_COST_PULL_ENABLED !== "true"
  ) {
    console.log(
      "[rituals] hindsight-cost-pull: skipped (HINDSIGHT_ENABLED!=true; set HINDSIGHT_COST_PULL_ENABLED=true to override)",
    );
    return;
  }
  const job = cron.schedule(
    "*/5 * * * *",
    async () => {
      try {
        const { runHindsightCostPull } =
          await import("./hindsight-cost-pull.js");
        const summary = await runHindsightCostPull();
        // Only log when there's actual data. Empty pulls (series=0) accumulate
        // 288 lines/day of "nothing happened" — operators get no signal from
        // the noise. A failure still logs via the catch below, so silent
        // failure is impossible.
        if (summary.series > 0) {
          console.log(
            `[rituals] hindsight-cost-pull: bucket=${summary.bucket} series=${summary.series} recorded=${summary.recorded} skipped=${summary.skipped} cost=$${summary.cost_usd}`,
          );
        }
      } catch (err) {
        console.error(
          `[rituals] hindsight-cost-pull failed: ${err instanceof Error ? err.message : err}`,
        );
        recordRitualFailure("hindsight-cost-pull", err, "execute");
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] hindsight-cost-pull: scheduled (*/5 * * * *, tz=${RITUALS_TIMEZONE})`,
  );
}

/**
 * Prometheus alert notifier (queue: salones-wa alert-delivery follow-up).
 *
 * mc-prometheus evaluates alert rules but has no Alertmanager/Grafana wired, so
 * firing alerts only show in its UI. Every 2 min this polls /api/v1/alerts and
 * pushes newly firing + newly resolved alerts to the operator via WhatsApp /
 * Telegram (notify-once). Default OFF — set ALERT_NOTIFY_ENABLED=true to arm.
 */
function schedulePrometheusAlertPoller(): void {
  if (process.env.ALERT_NOTIFY_ENABLED !== "true") {
    console.log(
      "[rituals] prometheus-alert-notifier: disabled (set ALERT_NOTIFY_ENABLED=true)",
    );
    return;
  }
  const job = cron.schedule(
    "*/2 * * * *",
    async () => {
      try {
        const { runPrometheusAlertPoll } =
          await import("./prometheus-alert-poller.js");
        const summary = await runPrometheusAlertPoll();
        if (summary.sent) {
          console.log(
            `[rituals] prometheus-alert-notifier: firing=${summary.firing} newly=${summary.newlyFiring} reminders=${summary.reminders} resolved=${summary.resolved} → notified operator`,
          );
        }
      } catch (err) {
        console.error(
          `[rituals] prometheus-alert-notifier failed: ${err instanceof Error ? err.message : err}`,
        );
        recordRitualFailure("prometheus-alert-notifier", err, "execute");
      }
    },
    { timezone: RITUALS_TIMEZONE },
  );
  scheduledJobs.push(job);
  console.log(
    `[rituals] prometheus-alert-notifier: scheduled (*/2 * * * *, tz=${RITUALS_TIMEZONE})`,
  );
}

export function stopRitualScheduler(): void {
  for (const job of scheduledJobs) {
    job.stop();
  }
  scheduledJobs.length = 0;
  stopCanary();
  console.log("[rituals] All jobs stopped");
}
