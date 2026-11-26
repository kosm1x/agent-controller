/**
 * Mission Control — Server entry point.
 *
 * Initializes database, event bus, MCP servers, and starts the Hono HTTP server.
 */

// First import: console.error/warn reach the journal at their real priority
// before any other module evaluates.
import "./lib/journal-priority-install.js";
import { createServer, type Server } from "net";
import { acquireSingleInstance } from "./lib/single-instance.js";
import { registerReadbackVerifiers } from "./lib/v8-4/readback-verifiers.js";
import { serve } from "@hono/node-server";
import { createLogger } from "./lib/logger.js";
import { readBuildInfo } from "./lib/build-info.js";
import { setMaxContainers } from "./dispatch/dispatcher.js";
import { registerOptionalCrons } from "./optional-crons.js";
import { getConfig } from "./config.js";
import { sdkLastline } from "./inference/adapter.js";
import {
  initDatabase,
  closeDatabase,
  reconcileOrphanedTasks,
} from "./db/index.js";
import { regenerateIndex } from "./db/jarvis-index.js";
import {
  getJarvisKbRoot,
  getKbMirrorWriteDir,
  seedDirectives,
} from "./db/jarvis-fs.js";
import { activateBestVariant } from "./tuning/activation.js";
import { initEventBus, getEventBus } from "./lib/event-bus.js";
import { seedReflectionCursors } from "./reflection/cursors.js";
import { startTriggers } from "./triggers/index.js";
import { createApp } from "./api/index.js";
import { startRitualScheduler } from "./rituals/scheduler.js";
import { startIntelCollectors, setIntelBroadcast } from "./intel/scheduler.js";
import { startDynamicScheduler } from "./rituals/dynamic.js";
import { initMessaging } from "./messaging/index.js";
import { MessageRouter } from "./messaging/router.js";
import { initMemoryService } from "./memory/index.js";
import { migrateLearningsToHindsight } from "./memory/migrate-learnings.js";
import { seedMentalModels } from "./intelligence/mental-models.js";
import { startProactiveScheduler } from "./intelligence/proactive.js";
import { buildStopSequence } from "./stop-sequence.js";

// Reaction engine
import { ReactionManager } from "./reactions/manager.js";

// Tool source plugin system
import { toolRegistry } from "./tools/registry.js";
import { seedV83Capabilities } from "./lib/v8-3/seed.js";
import { assertV82Dependencies } from "./lib/v8-3/schema.js";
import { ToolSourceManager } from "./tools/source.js";
import { BuiltinToolSource } from "./tools/sources/builtin.js";
import { McpToolSource } from "./tools/sources/mcp.js";
import { GoogleToolSource } from "./tools/sources/google.js";
import { MemoryToolSource } from "./tools/sources/memory.js";
import { SkillsToolSource } from "./tools/sources/skills.js";
// Runner registration (side-effect imports)
import "./runners/fast-runner.js";
import "./runners/heavy-runner.js";
import "./runners/nanoclaw-runner.js";
import "./runners/swarm-runner.js";
import "./runners/a2a-runner.js";

/** Fail fast if the port is already in use (prevents silent 409 conflicts). */
async function checkPort(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE")
        reject(
          new Error(`Port ${port} already in use — kill the old process first`),
        );
      else reject(err);
    });
    s.once("listening", () => {
      s.close();
      resolve();
    });
    s.listen(port);
  });
}

const log = createLogger("mc");

/** Held for the process lifetime; the socket lock dies with the process. */
let instanceGuard: Server | null = null;

async function main(): Promise<void> {
  // Which commit this process runs: dist/build-info.json sits next to the
  // compiled entry point, so the journal ties each boot to a build.
  log.info(
    { build: readBuildInfo(new URL("./build-info.json", import.meta.url)) },
    "running build",
  );
  const config = getConfig();
  // MAX_CONCURRENT_CONTAINERS was parsed but never applied — the dispatcher
  // ran on its hard-coded 5 regardless of the env (reliability audit R6).
  setMaxContainers(config.maxConcurrentContainers);

  // Boot guards run BEFORE anything opens the DB or spawns: a second process
  // would otherwise reconcile (fail) every in-flight task of the live service.
  // Check port availability before binding
  await checkPort(config.port);
  // One process per DB even when MC_PORT differs (abstract-socket lock).
  instanceGuard = await acquireSingleInstance(config.dbPath);

  // Initialize database
  const db = initDatabase(config.dbPath);
  // Opening the database does schema only. The directive rows are seeded
  // before INDEX.md is regenerated, and the archived tuning variant is
  // activated before the project scope groups are wired, which read the
  // activated scope patterns. Activation also precedes tool registration, so
  // its tool-description overrides find no tool and do not apply at start-up.
  seedDirectives();
  activateBestVariant();
  log.info({ path: config.dbPath }, "database initialized");
  // Operator check after deploy: the live service must say "enabled".
  const kbMirrorDir = getKbMirrorWriteDir();
  log.info(
    { dir: kbMirrorDir },
    kbMirrorDir
      ? "kb mirror enabled"
      : "kb mirror DISABLED (db is not the live mc.db)",
  );
  // INDEX.md is regenerated here, not inside initDatabase(): every script
  // that opened the live mc.db rewrote the row from its working source
  // (the eval gate did on every run — audit 2026-09-22).
  regenerateIndex();

  // V8.3 Phase-0 gate: V8.3 is hard-gated on V8.2's consent substrate (§12).
  // Fail loud at boot if the dependency tables are missing — never silently.
  assertV82Dependencies(db);

  // V8.1 Phase 4: ensure the named reflection cursors exist from boot so the
  // table is observable before the first reflection pass. Idempotent.
  seedReflectionCursors();

  // Dim-4 R3 fix: reconcile orphaned tasks from prior non-graceful shutdown.
  // Graceful SIGTERM/SIGINT already marks running/pending/queued → failed
  // (stop sequence registered below). SIGKILL / OOM / hard-reboot skips the handler,
  // leaving tasks stuck forever. reactions/manager catches 'running' tasks
  // after 15 minutes via stuck-task polling, but 'pending'/'queued' rows
  // never had started_at set and slip past that check entirely.
  //
  // Round-2 C-RES-6 fix: reconcile returns the list of orphaned task IDs
  // so we can emit `task.failed` events AFTER initEventBus below, giving
  // the normal reaction-engine + user-notification pipelines a chance to
  // run. Prior round-1 fix silently flipped rows with no downstream signal.
  let orphanedTaskIds: string[] = [];
  try {
    orphanedTaskIds = reconcileOrphanedTasks(db);
    if (orphanedTaskIds.length > 0) {
      log.warn(
        { count: orphanedTaskIds.length },
        "reconciled orphaned tasks from prior non-graceful shutdown",
      );
    }
  } catch (err) {
    log.warn({ err }, "startup task reconcile failed (non-fatal)");
  }

  // v7.7 Spine 3 Phase 1: skills boot-loader. Walks jarvis_files for
  // skills/<name>/SKILL.md, parses frontmatter, registers skill_versions
  // rows. Empty namespace = no-op. JARVIS_SKILLS_BOOT_LOAD_DISABLED=true
  // disables (used by tests that already init the DB without a loader run).
  if (process.env.JARVIS_SKILLS_BOOT_LOAD_DISABLED !== "true") {
    try {
      const { loadSkillsFromJarvisFiles } = await import("./skills/loader.js");
      loadSkillsFromJarvisFiles({
        info: (msg, fields) => log.info(fields ?? {}, msg),
        warn: (msg, fields) => log.warn(fields ?? {}, msg),
        error: (msg, fields) => log.error(fields ?? {}, msg),
      });
    } catch (err) {
      log.warn({ err }, "skills boot-loader failed (non-fatal)");
    }
  }

  // Initialize event bus
  initEventBus(db);
  log.info("event bus initialized");

  // Round-2 C-RES-6 fix: fire `task.failed` events for the rows reconcile
  // just flipped. Must happen after initEventBus above but before reaction
  // manager starts (`reactionManager.start()` below) — it subscribes on start()
  // and immediately drains any unread events, so ordering matters.
  if (orphanedTaskIds.length > 0) {
    const { writeCheckpoint } = await import("./runners/checkpoint.js");
    const { emitTraceEvent } = await import("./observability/task-trace.js");
    const bus = getEventBus();
    for (const taskId of orphanedTaskIds) {
      // Terminal trace row with a reason — the dispatcher never ran for these.
      emitTraceEvent({
        taskId,
        name: "task.failed",
        attrs: {
          termination_reason: "orphaned_restart",
          error: "Orphaned across non-graceful restart",
        },
      });
      try {
        bus.emitEvent("task.failed", {
          task_id: taskId,
          agent_id: "startup-reconcile",
          error: "Orphaned across non-graceful restart",
          recoverable: true,
          attempts: 1,
        });
      } catch (err) {
        log.warn(
          { err, taskId },
          "failed to emit orphaned-task event (non-fatal)",
        );
      }
      // Phase 4.3: an orphaned CHAT task must be recoverable, not just
      // reported — write a checkpoint so the operator's "continúa" resumes
      // it through the existing continuation seam (#07-12 03:23: a restart
      // mid-task dropped the request with no way back).
      try {
        // `tasks` has no `tags` column — tags live in `metadata` JSON
        // (see reactions/manager.ts). The old `SELECT title, tags` threw
        // at prepare time, so this checkpoint had never been written.
        const row = db
          .prepare(`SELECT title, metadata FROM tasks WHERE task_id = ?`)
          .get(taskId) as
          | { title: string; metadata: string | null }
          | undefined;
        if (row?.title?.startsWith("Chat: ")) {
          // Best-effort thread stamp (R3 audit W3): tags are
          // ["messaging", <channel>, ...] for chat tasks. A channel-level
          // stamp matches every thread on that channel — good enough to
          // stop cross-CHANNEL leaks; the runner writers stamp nothing.
          let channel: string | undefined;
          try {
            const meta = JSON.parse(row.metadata ?? "{}") as {
              tags?: unknown;
            };
            const tags = Array.isArray(meta.tags) ? (meta.tags as string[]) : [];
            if (tags[0] === "messaging" && typeof tags[1] === "string") {
              channel = tags[1];
            }
          } catch {
            /* unstamped */
          }
          // The title is 60-char truncated (R1 audit W3); the continuation
          // task also carries the hydrated thread history, so point there.
          const fromTitle = row.title.slice("Chat: ".length);
          writeCheckpoint({
            taskId,
            title: row.title,
            userMessage: fromTitle.endsWith("...")
              ? `${fromTitle} (título truncado — la solicitud completa está en el historial del hilo)`
              : fromTitle,
            toolsCalled: [],
            scopeGroups: [],
            exitReason: "orphaned_restart",
            roundsCompleted: 0,
            maxRounds: 0,
            responseText:
              "(el servicio se reinició a mitad de la tarea — no hay resultado parcial)",
            ...(channel ? { threadKey: channel } : {}),
          });
        }
      } catch (err) {
        log.warn(
          { err, taskId },
          "failed to checkpoint orphaned chat task (non-fatal)",
        );
      }
    }
  }

  // Migrate user_facts (category=projects) into projects table if needed
  try {
    const { migrateUserFactsToProjects } = await import("./db/projects.js");
    migrateUserFactsToProjects();
  } catch {
    // Non-fatal — migration is best-effort
  }

  // S6 WS1: project every registered record (`projects/<slug>/project.md`)
  // onto its `projects` row. No KB reindex runs at boot (it is the hourly
  // `kb-reindex` cron, which projects what it imports/refreshes), so this
  // reads the registry — the records' authority — not the disk.
  try {
    const { projectAllRecords } = await import("./projects/projector.js");
    const r = projectAllRecords(getJarvisKbRoot());
    log.info(r, "project records projected");
  } catch (err) {
    log.warn({ err }, "project record projection failed (non-fatal)");
  }

  // Initialize memory service (Hindsight if configured, else SQLite)
  const memory = await initMemoryService();

  // Migrate existing learnings and seed mental models if Hindsight is active
  if (memory.backend === "hindsight") {
    await migrateLearningsToHindsight(db);
    await seedMentalModels(
      process.env.HINDSIGHT_URL ?? "http://localhost:8888",
      process.env.HINDSIGHT_API_KEY,
    );
  }

  // Build code index for code_search tool (S7 semantic code search)
  try {
    const { rebuildIndex } = await import("./tools/builtin/code-index.js");
    rebuildIndex();
  } catch (err) {
    console.warn("[code-index] Build failed (non-fatal)");
  }

  // F1 — seed rate limiter from api_call_budget so post-restart calls don't
  // exceed provider ceilings for up to 60s before the window rebuilds.
  try {
    const { seedRateLimitersFromHistory } = await import("./finance/budget.js");
    seedRateLimitersFromHistory();
  } catch {
    // api_call_budget comes from schema.sql, so this is a failed read: swallowed, the
    // rate limiters not yet seeded start empty and count only calls made after boot.
  }

  // Initialize tool sources (plugin system)
  const sourceManager = new ToolSourceManager();
  sourceManager.addSource(new BuiltinToolSource());
  // Instance kept for alert wiring after messaging is up — this source owns
  // the LIVE McpManager (the src/mcp/index.ts barrel's was never initialized).
  const mcpSource = new McpToolSource();
  sourceManager.addSource(mcpSource);
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN) {
    sourceManager.addSource(new GoogleToolSource());
  }
  if (memory.backend === "hindsight") {
    sourceManager.addSource(new MemoryToolSource());
  } else {
    // Any other store: the narrow mode (memory_search, memory_kg_query,
    // memory_forget).
    sourceManager.addSource(new MemoryToolSource("backend_independent"));
  }
  sourceManager.addSource(new SkillsToolSource());

  const initResult = await sourceManager.initAll(toolRegistry);
  log.info(
    {
      initialized: initResult.initialized,
      failed: initResult.failed,
      totalTools: initResult.totalTools,
    },
    "tool sources loaded",
  );
  log.debug({ tools: toolRegistry.list() }, "tools registered");

  // S6 WS3: scope groups derived from project records (after the projector
  // above and the MCP tools just registered). No declaring record ⇒ no-op.
  try {
    const { wireProjectScopeGroups } = await import("./projects/scope-wiring.js");
    const { listProjects } = await import("./db/projects.js");
    const derived = wireProjectScopeGroups(
      listProjects("active"),
      mcpSource.recordServerIds(),
      () => toolRegistry.list(),
    );
    log.info(
      { groups: derived.groups.map((g) => g.name), skipped: derived.skipped },
      "project scope groups registered",
    );
  } catch (err) {
    log.warn({ err }, "project scope groups not registered (non-fatal)");
  }

  // V8.3 Phase 0+1 — seed the (inert) capability-autonomy ledger now that the
  // tool registry is populated (tool-backed capabilities resolve + hint-check
  // against the live registry). Idempotent; failures log loudly, never crash boot.
  const v83Seed = seedV83Capabilities(db, toolRegistry);
  if (v83Seed.errors.length > 0) {
    log.error(
      { errors: v83Seed.errors },
      "V8.3 capability seed reported errors",
    );
  } else {
    log.info(
      { seeded: v83Seed.seeded, skipped: v83Seed.skipped },
      "V8.3 capability-autonomy seed complete",
    );
  }

  // Start reaction engine
  const reactionManager = new ReactionManager(db);
  reactionManager.start();

  // Create and start HTTP server
  const app = createApp();

  const httpServer = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: process.env.MC_BIND_HOST ?? "0.0.0.0",
    },
    (info) => {
      log.info({ port: info.port }, "Mission Control listening");
      // timeoutMs/maxRetries are consumed only by the openai adapter; on the
      // claude-sdk provider the effective ceiling is SDK_TIMEOUT_MS inside
      // inference/claude-sdk.ts (reliability audit R8).
      log.info(
        {
          provider: config.inferencePrimaryProvider,
          timeoutMs: config.inferenceTimeoutMs,
          maxRetries: config.inferenceMaxRetries,
          appliesTo: config.inferencePrimaryProvider === "openai" ? "primary" : "openai-adapter-only",
        },
        "inference config",
      );
      // SDK last line: the same predicate the adapter and fast-runner use.
      // An empty key is legal (keyless endpoint) but worth a look.
      const lastline = sdkLastline();
      console.log(
        `[inference] sdk last line: ${
          lastline
            ? `ARMED fallback/${lastline.model}${config.inferenceFallbackKey ? "" : " key=unset"}`
            : `DISARMED (${
                !config.inferenceSdkLastlineEnabled
                  ? "flag off"
                  : config.inferencePrimaryProvider !== "claude-sdk"
                    ? "provider not claude-sdk"
                    : "fallback url/model unset"
              })`
        }`,
      );
    },
  );

  // Start ritual scheduler if enabled
  if (process.env.RITUALS_ENABLED === "true") {
    startRitualScheduler();
    // V8.1 Phase 7 — proactive-context triggers (N-turn / cron / idle).
    // Fire the reflection + briefing pipeline; produces only non-operator-
    // facing artifacts. Kill switch: V81_TRIGGERS_ENABLED=false.
    startTriggers();
  }

  // Start dynamic (user-defined) scheduled tasks
  startDynamicScheduler();
  // Usability Phase 2: read-back verifiers for write tools (KB, Sheets,
  // Docs, schedules) — the harness proves "Listo" at completion.
  registerReadbackVerifiers();

  // Register the optional scheduled jobs; nothing waits for them.
  registerOptionalCrons(log);

  // Start Intelligence Depot collectors (S6)
  startIntelCollectors();

  // Start messaging channels (WhatsApp/Telegram) if enabled
  const router = await initMessaging(new MessageRouter());

  // Wire MCP alerts + intel alerts to Telegram (after messaging is ready)
  if (router) {
    mcpSource.setAlertFn((msg: string) =>
      router.broadcastToAll(msg, undefined, { raw: true }),
    );
    setIntelBroadcast((msg: string) =>
      router
        .broadcastToAll(msg, undefined, { raw: true })
        .then(() => undefined),
    );
    startProactiveScheduler(router);
  }

  // Graceful shutdown — ordered teardown to prevent requests hitting torn-down state
  const shutdown = buildStopSequence({
    log,
    httpServer,
    reactionManager,
    sourceManager,
  });
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Global error handlers — prevent silent crashes
  process.on("unhandledRejection", (reason) => {
    log.error({ err: reason }, "unhandled rejection");
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception — shutting down");
    closeDatabase();
    process.exit(1);
  });
}

main().catch((err) => {
  log.fatal({ err }, "fatal error");
  process.exit(1);
});
