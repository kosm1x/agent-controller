/**
 * v7.7 Spine 4 Bundle 3 — seed the general-events middle layer.
 *
 * Conway Pattern 1's manual-seed population path (spec §5). Backfills the
 * `general_events` table with the v7.x substrate arc transcribed from
 * existing closure docs and project memories — these are already-abstracted
 * artifacts, so this is structuring, not LLM summarization (the Spine 4
 * anti-mission bars auto-discovery / LLM event-summarization).
 *
 * Idempotent: an event whose `event_id` already exists is skipped. Re-run
 * freely; only missing events are created.
 *
 * Env: MODE=apply|dry-run (default apply).
 *   dry-run — print what WOULD be seeded, touch nothing.
 *   apply   — create the missing events (embeds each summary via Gemini —
 *             requires GEMINI_API_KEY; run with `.env` sourced).
 *
 * Exit codes: 0 ok (all events present after the run) | 1 partial | 2 fatal.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initDatabase } from "../src/db/index.js";
import {
  createGeneralEvent,
  getGeneralEvent,
  type CreateGeneralEventInput,
} from "../src/events/general-events.js";

// Resolve the DB path relative to THIS script, not the process cwd — so the
// seed touches the real mc.db regardless of where it is invoked from (R1-W1
// fold; the cited reference script guarded cwd, this is the stronger fix).
const DB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "data",
  "mc.db",
);

/**
 * The seed cohort — the v7.x substrate arc + the active long-running
 * projects. `created_by: 'seed'` distinguishes these from manually-curated
 * or (future) auto-discovered events. `goal_context_id` is left null —
 * NorthStar objective attribution is Conway Pattern 4 (a later spine).
 */
const SEED_EVENTS: ReadonlyArray<Omit<CreateGeneralEventInput, "created_by">> =
  [
    {
      event_id: "v8-substrate-completion-arc",
      level: "lifetime",
      title: "V8 substrate completion arc",
      summary:
        "The pre-8.0 foundation phase spanning v7.6 and v7.7 — building the " +
        "substrate (S1-S5 + Conway patterns) the V8.x capability layer will " +
        "stand on. v7.6 closed the Reliability Phase; v7.7 completes the " +
        "remaining substrate spines. The governing discipline: ship substrate, " +
        "not capability — every spine is gated by a 'V8.x can run against this " +
        "without further build-out' done-when.",
      themes: ["v8-substrate", "arc", "foundation"],
      start_at: "2026-05-08T00:00:00-06:00",
      end_at: null,
    },
    {
      event_id: "v7-5-closure",
      level: "general",
      title: "v7.5 closure",
      summary:
        "Tier-A v7.5-leftovers cleared (L1-L6, six ship-it bundles, +183 " +
        "tests). v7.5 formally closed with a closure doc and the v7.5-closed " +
        "tag. The audit caught two real bugs (an L4 NaN-cascade and an L6 " +
        "token-loss). The closure ritual became a reusable template.",
      themes: ["v7.5", "closure"],
      start_at: "2026-05-08T00:00:00-06:00",
      end_at: "2026-05-08T23:59:59-06:00",
    },
    {
      event_id: "anthropic-sdk-cutover",
      level: "general",
      title: "Anthropic SDK cutover",
      summary:
        "agent-controller moved off Fireworks/Groq onto the Claude Agent SDK " +
        "(Sonnet/Haiku for infer() callers, Opus→Sonnet for Prometheus). CRM " +
        "and the Hindsight container deliberately stayed on Fireworks. A " +
        "three-round audit cleared per-model circuit-breaker keys and a " +
        "cost-ledger drift; the operator .env diff followed.",
      themes: ["inference", "provider-cutover", "cost"],
      start_at: "2026-05-10T00:00:00-06:00",
      end_at: "2026-05-10T23:59:59-06:00",
    },
    {
      event_id: "hindsight-demote-verdict",
      level: "general",
      title: "Hindsight demote verdict",
      summary:
        "Queue #15 closed with a DEMOTE verdict on Hindsight recall. " +
        "Thirty-day data showed mc-jarvis on the SQLite hybrid returning " +
        "38.9% utility at 301ms versus mc-operational on Hindsight at 4.0% / " +
        "2496ms. HINDSIGHT_RECALL_ENABLED=false became the documented default; " +
        "the container stays up as a frozen-but-queryable long-term store.",
      themes: ["recall-stack", "hindsight", "decision"],
      start_at: "2026-05-15T00:00:00-06:00",
      end_at: "2026-05-15T23:59:59-06:00",
    },
    {
      event_id: "email-channel-rollout-arc",
      level: "general",
      title: "Community email channel rollout",
      summary:
        "A roughly 24-hour arc rolling out the community-manager email " +
        "channel — eight commits, four audits, one production incident (an " +
        "RFC 3834 auto-reply loop firing two messages a minute). The fix " +
        "required dropping inbound bounces and marking every outbound message " +
        "Auto-Submitted. Twelve transferable patterns for any agent channel " +
        "that accepts external input were codified.",
      themes: ["email-channel", "incident", "rollout"],
      start_at: "2026-05-15T00:00:00-06:00",
      end_at: "2026-05-16T00:00:00-06:00",
    },
    {
      event_id: "v7-6-reliability-phase",
      level: "general",
      title: "v7.6 Reliability Phase",
      summary:
        "The v7.6 Reliability Phase — seven spines, closed 2026-05-18 with the " +
        "v7.6-closed tag. Final scoreboard: six pre-existing bugs found, forty " +
        "bundle-regressions caught, 159 new tests, zero production " +
        "regressions, and zero new user-facing capability (by design — it was " +
        "a reliability phase). A four-week projection landed in ten days, " +
        "driven by spine independence.",
      themes: ["v7.6", "reliability", "closure"],
      start_at: "2026-05-08T00:00:00-06:00",
      end_at: "2026-05-18T23:59:59-06:00",
    },
    {
      event_id: "v7-7-spine-1-s2-self-audit",
      level: "general",
      title: "v7.7 Spine 1 — S2 self-audit",
      summary:
        "First v7.7 spine: the S2 self-audit substrate. Four phases in one " +
        "day — typed-report harness, morning-brief gate, community-email " +
        "gate, closure docs. Three application shapes for the same two " +
        "primitives: a typed-report tool, a router-level free-text gate, and " +
        "a heuristic markdown lint. +4923 LOC, +188 tests, zero regressions.",
      themes: ["v7.7", "spine-1", "s2-self-audit"],
      start_at: "2026-05-19T00:00:00-06:00",
      end_at: "2026-05-19T23:59:59-06:00",
    },
    {
      event_id: "v7-7-spine-2-s3-drift-detector",
      level: "general",
      title: "v7.7 Spine 2 — S3 drift detector",
      summary:
        "The S3 out-of-band drift detector — schema, evaluator, burst guard, " +
        "morning-brief delivery, push, suppression, aging. Thirteen seed " +
        "signals (three enabled live, ten awaiting their substrates). The " +
        "counter-recovery-path pattern was reinforced: a fire-and-forget " +
        "broadcast was swallowing per-channel failures, making an error " +
        "counter unreachable until an onChannelFailure callback was added.",
      themes: ["v7.7", "spine-2", "s3-drift"],
      start_at: "2026-05-19T00:00:00-06:00",
      end_at: "2026-05-19T23:59:59-06:00",
    },
    {
      event_id: "v7-7-spine-3-s5-skills",
      level: "general",
      title: "v7.7 Spine 3 — S5 skills substrate",
      summary:
        "The S5 skills-as-stored-procedures substrate — all five phases in " +
        "one calendar day. Schema, critic gate, test harness, vector " +
        "retrieval, the runSkill dispatcher, three deferred builtin tools, " +
        "and the mc-ctl skills operator surface. The activation gate was met " +
        "with five certified production skills. The key lesson: the " +
        "mini-runner test harness runs skill bodies as pure LLM calls, so " +
        "certified skills must be pure-reasoning transforms.",
      themes: ["v7.7", "spine-3", "s5-skills"],
      start_at: "2026-05-19T00:00:00-06:00",
      end_at: "2026-05-19T23:59:59-06:00",
    },
    {
      event_id: "v7-7-spine-4-general-events",
      level: "general",
      title: "v7.7 Spine 4 — general-events middle layer",
      summary:
        "Conway Pattern 1: the general-events middle layer between abstract " +
        "knowledge and raw episodic chunks. Bundle 1 shipped the write path " +
        "(two tables, the create/link/archive API); Bundle 2 the hierarchical " +
        "two-layer retrieval; Bundle 3 the operator surface, this seed, and " +
        "closure. This event is itself part of the seed cohort — the layer " +
        "describing its own construction.",
      themes: ["v7.7", "spine-4", "conway-pattern-1", "general-events"],
      start_at: "2026-05-20T00:00:00-06:00",
      end_at: null,
    },
    {
      event_id: "denue-eurekamd-arc",
      level: "general",
      title: "DENUE / EurekaMD data-analysis arc",
      summary:
        "The DENUE data-analysis project — EurekaMD, live at " +
        "uncharted.eurekamd.cloud. A v0.3 demo and a v0.3.1 hardening pass, " +
        "then a Locust reachability arc and a Locust hardening arc. Thirty-six " +
        "of thirty-nine fields reachable, a per-capita toggle, 1280-plus " +
        "tests. Eight audits caught eleven criticals and thirty-five warnings.",
      // start-approximate: a long-running project — start_at is the earliest
      // reliably-tracked date, not the true project origin (R1-R3 fold).
      themes: [
        "denue",
        "eurekamd",
        "data-analysis",
        "project",
        "start-approximate",
      ],
      start_at: "2026-05-10T00:00:00-06:00",
      end_at: null,
    },
    {
      event_id: "crm-azteca-arc",
      level: "general",
      title: "Agentic CRM (crm-azteca) arc",
      summary:
        "The agentic CRM project — WhatsApp-channel customer relationship " +
        "management. Seventy-one tools, twenty-nine tables, 1124 tests. The " +
        "beta pilot window was missed; the project carries forward as an " +
        "active long-running engagement with a commercial-intelligence gap " +
        "still lacking production validation.",
      // start-approximate: see denue-eurekamd-arc above (R1-R3 fold).
      themes: ["crm", "whatsapp", "project", "start-approximate"],
      start_at: "2026-05-01T00:00:00-06:00",
      end_at: null,
    },
  ];

async function main(): Promise<number> {
  initDatabase(DB_PATH);
  const mode = (process.env.MODE ?? "apply").toLowerCase();
  if (mode !== "apply" && mode !== "dry-run") {
    console.error(`[events-seed] invalid MODE="${mode}" — use apply|dry-run`);
    return 2;
  }

  let created = 0;
  let skipped = 0;
  let failed = 0;

  console.log(
    `[events-seed] MODE=${mode} — ${SEED_EVENTS.length} events in cohort\n`,
  );

  for (const event of SEED_EVENTS) {
    const existing = getGeneralEvent(event.event_id);
    if (existing) {
      console.log(`  skip    ${event.event_id} (already present)`);
      skipped++;
      continue;
    }
    if (mode === "dry-run") {
      console.log(`  WOULD   ${event.event_id} [${event.level}]`);
      created++;
      continue;
    }
    try {
      await createGeneralEvent({ ...event, created_by: "seed" });
      console.log(`  created ${event.event_id} [${event.level}]`);
      created++;
    } catch (err) {
      console.error(
        `  FAILED  ${event.event_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
  }

  console.log(
    `\n[events-seed] ${mode === "dry-run" ? "would create" : "created"} ${created}, skipped ${skipped}, failed ${failed}`,
  );
  if (failed > 0) return 1;
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
