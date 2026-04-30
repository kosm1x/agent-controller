# V8.1 Capability — Proactive Context Engine

> **Status**: Spec, not implementation. Freeze-aligned (no code changes proposed for the 2026-04-22 → 2026-05-22 window).
> **Authored**: 2026-04-30 — synthesis of V8-VISION §4-V8.1, the existing `rituals/morning.ts`, the 2026-04-30 scout findings on Letta sleep-time agents (`reference_letta_sleeptime.md`), and Conway 2005 SMS framework Patterns 1-3 (`reference_conway_2005_sms.md`).
> **Activation gate** (per V8-VISION §4-V8.1): "cache-read ratio ≥80% sustained over a 24h window with morning-brief generation included."
> **Reading order**: §1 problem → §2 current state → §3 precedents → §4 architecture → §5 general-events layer (load-bearing) → §6 trigger model → §7 detection algorithms → §8 briefing schema → §9 judgment prompt → §10 promote/discard → §11 cross-substrate → §12 phasing → §13 measurement → §14 open questions.

---

## §1 — Problem

V8-VISION §4-V8.1 names three capabilities Jarvis cannot do today:

1. **Notice what wasn't asked**: stalled tasks (>7d no activity), dormant objectives, implicit deadlines parsed from descriptions
2. **Brief with judgment**: not "summarize what happened" — "this is at risk, this has momentum, this is today's highest-leverage move"
3. **Pattern recognition on recurring blockers**: same obstacle in 3 conversations gets named

The existing morning ritual (`src/rituals/morning.ts`) covers a fraction. It's a hardcoded Spanish-email template that asks the LLM to read NorthStar files, classify pending tasks via Eisenhower matrix, and email the result. It runs once per day, has no judgment-vs-summary distinction, no stalled-task detector, no dormant-objective alert, no recurring-blocker recognition, no audit before delivery.

V8.1's shift is from a **once-daily ritual** that summarizes data into a **continuous reflection process** that constructs judgments. The morning brief becomes one _surface_ of that engine — not the engine itself.

Per Conway 2005 (Pattern 2 from `reference_conway_2005_sms.md`): briefings without grounding in self-defining memories read as generic; per Pattern 1: briefings without a general-events middle layer drown in episodic detail. Per Letta scout: reflection cadence should be activity-driven, not wall-clock-driven, to maximize fidelity per token.

---

## §2 — Current state

| Artifact                             | What it does                                                               | What it lacks for v8.1                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/rituals/morning.ts`             | Hardcoded prompt: Eisenhower classification, NorthStar read, Spanish email | No judgment vocabulary; no stalled detector; no dormant alert; no audit; runs once/day              |
| `src/rituals/scheduler.ts`           | Cron-driven ritual scheduler                                               | Wall-clock only; no N-turn-piggybacked option; no idle-detect                                       |
| `src/rituals/day-narrative.ts`       | End-of-day journal-style summary                                           | Pure correspondence (what happened); no coherence-mode forward judgment                             |
| `src/rituals/diff-digest.ts`         | Diff-based change summarization                                            | Operates on file diffs, not goal/task state diffs                                                   |
| `tasks` table                        | Status / priority / parent / assigned_to / dates                           | No `last_activity_at` indexed for stalled-task detection; no `goal_context_id` per Conway Pattern 4 |
| NorthStar (`data/jarvis/NorthStar/`) | File-system goals/objectives/tasks/visions                                 | No general-events layer; no "self-defining" qualifier; no implicit-deadline extraction              |
| `memory_search` (Hindsight)          | Vector recall on observation/world banks                                   | Episodic-level only; no general-events tier                                                         |
| Pattern recognition                  | None; emerges from operator's manual review                                | No automated repeated-blocker detector                                                              |

Two structural gaps stand out: **no general-events middle layer** (Conway Pattern 1) and **no proposed-briefings table with promote/discard** (Letta divergence — they write directly to memory, which is unsafe for judgments).

---

## §3 — Precedents (composed)

### From Letta sleep-time agents (`reference_letta_sleeptime.md`)

- **N-turn-piggybacked trigger** (default freq=5): not cron, not idle. Reflection fires after every Nth foreground task completes
- **Bounded message-diff scope via `last_processed_message_id`**: reflector sees the delta, not all memory
- **Role-reframe via injected `<system-reminder>`**: "Messages labeled 'assistant' are from the primary agent, not you" — prevents identity collapse
- **Same agent class, different prompt + tools + invocation**: don't subclass; reuse fast-runner with reflection-specific config

### From Conway 2005 SMS (`reference_conway_2005_sms.md`)

- **Pattern 1 — General-events middle layer**: between abstract knowledge (NorthStar, MEMORY.md) and episodic chunks (conversations, tasks). Briefings retrieve at general-event level; descend to episodic on demand
- **Pattern 2 — Self-defining memory cohort**: briefings ground forward-looking judgments in identity-defining context. **Conway's empirical claim**: V8.1 fails without this — briefs read as generic LLM output
- **Pattern 3 — Coherence/correspondence recall modes**: V8.1's morning brief uses `coherence` (forward-looking, goal-supportive). End-of-day narrative uses `correspondence` (what happened, including failures). Mixing modes = drift toward confabulation

### Explicit divergence from Letta

Letta writes sleep-agent output **directly to memory**. For V8.1 judgments ("at risk / momentum / highest-leverage"), this is unsafe. Spec adds a `proposed_briefings` table with promote-on-read/discard semantics — operator's first morning interaction triggers promotion or discard. Reversibility built in from day one.

### Per Conway's framing-shift

V8.1 morning brief is NOT "summarize what happened." It IS "construct what you would have noticed, given my current goals." Memory is constructed at retrieval, modulated by working-self goals. The brief generation is itself an act of constructed memory.

---

## §4 — Architecture overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Trigger layer                                                          │
│  ─────────────                                                          │
│  • N-turn counter (default freq=5) on foreground task completion        │
│  • Cron fallback: 06:00 local time daily morning-brief surface          │
│  • Idle-detect: 4h no foreground activity → fire reflection             │
│                       │                                                  │
│                       ▼                                                  │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│  Reflection runner (fast-runner with reflection-specific config)        │
│  ─────────────────                                                      │
│  • System prompt: V8.1 reflection template                              │
│  • Scope: bounded diff via last_processed_event_id cursor               │
│  • Tools: read-only (NorthStar, journal, cost_ledger, recall_audit)     │
│           + write-only-to-proposed-table (proposed_briefings)           │
│  • Mode: coherence (default for forward) or correspondence (audits)     │
│                       │                                                  │
│                       ▼                                                  │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│  General-events layer (Conway Pattern 1)                                │
│  ─────────────────                                                      │
│  • Aggregates episodic chunks into named general events                 │
│  • Indexed at retrieval-target granularity                              │
│  • Examples: "Phase β sprint", "Hindsight rehab arc", "S5 design"       │
│  • Hierarchical retrieval: match general-event → descend to episodic    │
│                       │                                                  │
│                       ▼                                                  │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│  Detection algorithms                                                   │
│  ─────────────────                                                      │
│  • Stalled: tasks.status='running' AND tasks.updated_at < now-7d        │
│  • Dormant: NorthStar objective with no task activity > 14d             │
│  • Implicit deadline: regex-extract dates from objective descriptions    │
│  • Recurring blocker: same error text/class in ≥3 distinct task runs    │
│                       │                                                  │
│                       ▼                                                  │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│  Judgment construction (the Conway shift)                               │
│  ─────────────────                                                      │
│  • Inputs: detection outputs + general-events + self-defining cohort    │
│  • Output: typed Briefing object (§8 schema)                            │
│  • Judgment vocabulary: at-risk | has-momentum | highest-leverage       │
│  • Goes through S2 critic before being persisted to proposed_briefings  │
│                       │                                                  │
│                       ▼                                                  │
└─────────────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────────────┐
│  Promote/discard (the Letta divergence)                                 │
│  ─────────────────                                                      │
│  • proposed_briefings.status = 'pending' until operator interacts       │
│  • First morning operator turn → 'promoted' OR 'discarded'              │
│  • Promoted brief becomes a memory_item at general-event level          │
│  • Discarded brief retained for forensic recall (correspondence mode)   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## §5 — General-events middle layer (the load-bearing structural choice)

**This is the substrate item that gates V8.1.** Conway Pattern 1, applied directly. Without it, V8.1 briefings either (a) drown in episodic detail (top-50 task chunks) or (b) hallucinate from abstract knowledge (NorthStar at the goal level, no episodic grounding).

### Schema (additive migration)

```sql
CREATE TABLE general_events (
  id INTEGER PRIMARY KEY,
  event_id TEXT UNIQUE NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('lifetime', 'general', 'episodic-cluster')),
  title TEXT NOT NULL,                       -- "Phase β sprint", "Hindsight rehab arc"
  summary TEXT NOT NULL,                     -- 1-3 paragraph abstracted narrative
  goal_context_id TEXT,                      -- NorthStar objective id (Pattern 4 prep)
  themes TEXT NOT NULL DEFAULT '[]',         -- ['hardening', 'recall-stack', 'V8-substrate']
  start_at TEXT NOT NULL,                    -- when this period began
  end_at TEXT,                               -- NULL = ongoing
  episodic_count INTEGER NOT NULL DEFAULT 0, -- # of associated episodic items
  embedding BLOB,                            -- sqlite-vec, indexed for retrieval
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_by INTEGER REFERENCES general_events(id),
  archived_at TEXT
);
CREATE INDEX idx_general_events_active ON general_events(end_at) WHERE archived_at IS NULL;
CREATE INDEX idx_general_events_goal ON general_events(goal_context_id);

CREATE TABLE general_event_episodic_links (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES general_events(event_id),
  episodic_kind TEXT NOT NULL CHECK (episodic_kind IN ('task', 'conversation', 'memory_item', 'recall_audit', 'cost_ledger', 'report')),
  episodic_ref TEXT NOT NULL,                -- task_id / conversation_id / etc
  linked_at TEXT NOT NULL DEFAULT (datetime('now')),
  link_reason TEXT                            -- 'auto-themed' | 'manual' | 'co-occurrence'
);
CREATE INDEX idx_geel_event ON general_event_episodic_links(event_id);
CREATE INDEX idx_geel_ref ON general_event_episodic_links(episodic_kind, episodic_ref);

CREATE VIRTUAL TABLE general_events_vec USING vec0(
  event_id TEXT PRIMARY KEY,
  summary_embedding FLOAT[1024],
  details_embedding FLOAT[1024]
);
```

**Multi-vector per record (MIRIX port)** — see `reference_mirix.md`. Every general_event stores TWO embeddings: `summary_embedding` (probes general-event-level retrieval) + `details_embedding` (probes episodic-level retrieval after descent). Collapses Conway Pattern 1's 2-step retrieval into 1 row read with 2 vector probes. Replaces `embedding BLOB` placeholder above.

### Population strategy

**Manual seed**: backfill from existing consolidations

- `feedback_phase_beta_gamma_patterns.md` → 1 lifetime-level event ("Phase β/γ stabilization arc")
- `feedback_audit_discipline.md` → 1 general event ("V7 audit dimension protocol")
- Each Phase β sprint (F1-F9) → 1 general event each (auto-derived from sprint post-mortems)
- V8 substrate scouts session (today) → 1 general event ("V8 substrate scouts and design")
- Hindsight rehab → 1 general event spanning Sessions 110-118

Estimated initial cohort: 30-50 general events covering the last 90 days. Coverage threshold: every active NorthStar objective has ≥1 general event.

**Auto-discovery**: nightly cron walks recent tasks/conversations, clusters by `(theme, goal_context_id, ±3-day window)`, proposes new general-event candidates. Each candidate goes through S2 critic before insertion (`created_by='auto-discovery'`).

### Retrieval

```typescript
function retrieveForBriefing(
  context: {
    active_objective_ids: string[];
    window: { start: string; end: string };
  },
  k = 8,
): { generalEvents: GeneralEvent[]; episodicSamples: EpisodicItem[] } {
  // Layer 1: top-k general events matching active objectives + window
  const events = retrieveGeneralEvents(context, k);
  // Layer 2: descend — for each event, fetch top-3 most relevant episodic items
  const episodic = events.flatMap((e) => sampleEpisodic(e.event_id, 3));
  return { generalEvents: events, episodicSamples: episodic };
}
```

**Why hierarchical**: a 50-item episodic recall is too noisy for judgment construction. 8 general events + 24 episodic samples (3 per event) is the right granularity — fits in the variable section of the prompt with cache-friendly margin.

### Cache implications (S1 alignment)

General events surface in the **variable** half of the prompt (after cache-break marker). Self-defining cohort (Conway Pattern 2) lives in the **stable** half. Both feed the briefing, but the access patterns differ — self-defining is per-day-stable, general-events are per-task-window-fresh.

---

## §6 — Trigger model

Three triggers, layered by purpose:

### Trigger 1 — N-turn-piggybacked reflection (Letta pattern)

- After every Nth foreground task completes (default `reflection_freq=5`)
- Fire-and-forget via `safe_create_task` (existing pattern)
- Updates `general_events` (auto-discovery candidates) + `proposed_briefings` (drafts that may surface tomorrow)
- Cost: lazy — runs only when foreground is active

### Trigger 2 — Cron-driven morning surface

- 06:00 local time daily (configurable via `MORNING_BRIEF_TIME` env)
- Pulls latest `proposed_briefings` row with `surface='morning'` + `status='pending'`
- If none exists (low foreground activity overnight): generates one synchronously
- Always emits operator-facing message via Telegram + email

### Trigger 3 — Idle-detect alert

- 4h no foreground activity AND active project has stalled task → fire reflection focused on stalled detection
- Emits Telegram-only nudge (not full briefing)
- Throttled: max 1 per 12h to avoid notification spam

**The default triggering mode is N-turn (Trigger 1)**: reflection cadence tracks operator activity, so high-activity days produce richer morning briefs. Cron (Trigger 2) is fallback for delivery. Idle-detect (Trigger 3) is for the "operator went away mid-task" case.

---

## §7 — Reflection scope (the bounded diff)

Per Letta pattern: reflector never sees "all memory." Scope is bounded by `last_processed_event_id`.

### State table

```sql
CREATE TABLE reflection_cursors (
  cursor_name TEXT PRIMARY KEY,
  last_event_id INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Cursors:

- `morning_brief` — advances on every promoted brief
- `pattern_detector` — advances on every blocker-detection pass
- `general_events_discovery` — advances on every auto-discovery cron pass

### Scope per trigger

| Trigger          | Window                                   | Read scope                                          |
| ---------------- | ---------------------------------------- | --------------------------------------------------- |
| N-turn (5 tasks) | Last 5 task IDs                          | Tasks + their conversations + cost_ledger rows      |
| Cron morning     | Last 24h OR since `morning_brief` cursor | Tasks + general_events + recall_audit + cost_ledger |
| Idle-detect      | Last 4h                                  | Stalled-task subset only                            |

The reflector receives `(prior_state_snapshot, delta_events, last_processed_event_id)` as input contract. Cursor advances atomically on success.

### Role-reframe (Letta pattern)

Reflector receives a `<system-reminder>`-style injected user message:

> You are a background reflector for the primary Jarvis agent. The events labeled `task` / `conversation` / `memory_item` below are records of the primary agent's interactions with Fede — they are NOT yours. Your job is to construct judgments about state, momentum, and risk based on these records, and write them to `proposed_briefings`. You do NOT speak to Fede directly. Your output is reviewed and either promoted or discarded by the morning surface.

This prevents identity collapse — the same `feedback_sonnet_identity_drift.md` failure mode applies if not handled.

---

## §8 — Detection algorithms

### Stalled task — two layers (SQL pre-filter + LLM-judged ledger)

**Layer 1 — SQL pre-filter** (cheap; catches silent abandonment):

```sql
SELECT task_id, title, started_at, updated_at, agent_type, priority,
       (julianday('now') - julianday(updated_at)) AS days_since_activity
FROM tasks
WHERE status IN ('running', 'queued', 'needs_context', 'blocked')
  AND days_since_activity > 7
ORDER BY priority DESC, days_since_activity DESC;
```

**Layer 2 — LLM-judged tri-boolean progress ledger** (AutoGen Magentic-One port — see `reference_autogen_stall.md`). Catches the failure mode SQL misses: tasks with recent activity that are nonetheless stalled (loop, no real progress despite updates).

```typescript
type ProgressLedger = {
  task_id: string;
  judged_at: string;
  is_request_satisfied: boolean;
  is_progress_being_made: boolean;
  is_in_loop: boolean; // 'repeating same requests/responses across multiple turns'
  reason_satisfied: string;
  reason_progress: string;
  reason_loop: string;
  evidence_refs: string[]; // pointers to recent task events
};
```

Stored in `task_progress_ledgers` (additive migration). Bidirectional counter on `tasks`:

```sql
ALTER TABLE tasks ADD COLUMN n_stalls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN max_stalls INTEGER NOT NULL DEFAULT 3;
```

`n_stalls` increments on `progress=false OR loop=true`; **decrements (floor 0) on productive turns** so one slow update doesn't flip the flag. When `n_stalls >= max_stalls`, surface as `at_risk` posture next briefing. Default `max_stalls=3` aligns with `feedback_3strike_rule.md`.

Surfaced under `briefing.signals[].kind = 'stalled_task'` with both `days_since_activity` AND `n_stalls` + ledger reasons in evidence.

### Dormant objective

```sql
SELECT obj.path, obj.title,
       MAX(t.updated_at) AS last_task_activity,
       (julianday('now') - julianday(MAX(t.updated_at))) AS days_dormant
FROM jarvis_files obj
LEFT JOIN tasks t ON t.metadata LIKE '%' || obj.path || '%'
WHERE obj.path LIKE 'NorthStar/objectives/%'
  AND obj.qualifier != 'archived'
GROUP BY obj.path
HAVING days_dormant > 14 OR last_task_activity IS NULL;
```

Surfaced under `briefing.signals[].kind = 'dormant_objective'`.

### Implicit deadline extraction

- Parse objective + task descriptions for date patterns (regex: `\b(202[6-9]-\d{2}-\d{2})\b` plus Spanish/English month names + relative dates)
- Compare to `now`; flag if `deadline - now < 7 days` AND task status != completed
- Surface under `briefing.signals[].kind = 'implicit_deadline'` with `parsed_date` + `source_field` ('description' | 'title')

### Recurring blocker

**This is the V8-VISION §4-V8.1 capability AutoGen explicitly does NOT ship** (open issue microsoft/autogen#7487 "mission keeper" — see `reference_autogen_stall.md`). We build it ourselves with a dedicated table.

```sql
CREATE TABLE recurring_blockers (
  id INTEGER PRIMARY KEY,
  blocker_signature TEXT NOT NULL,    -- error_class + normalized error text hash
  signature_embedding BLOB,            -- semantic clustering for §14 open Q3
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  task_count INTEGER NOT NULL,
  task_ids_json TEXT NOT NULL,
  named_at TEXT,                       -- when surfaced to operator
  named_by_briefing_id TEXT,
  resolved_at TEXT,
  resolution_signal TEXT
);
CREATE INDEX idx_rb_active ON recurring_blockers(resolved_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_rb_signature ON recurring_blockers(blocker_signature);

CREATE TABLE task_errors (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  error_class TEXT NOT NULL,
  error_text TEXT NOT NULL,
  error_text_normalized TEXT NOT NULL,    -- lowercase + whitespace-collapsed for hashing
  occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
  signature_hash TEXT NOT NULL             -- sha256(error_class + error_text_normalized)
);
CREATE INDEX idx_task_errors_signature ON task_errors(signature_hash);
CREATE INDEX idx_task_errors_recent ON task_errors(occurred_at DESC);
```

Detection cron walks `task_errors` from last 14d, clusters by `signature_hash` plus embedding similarity (semantic equivalence — §14 Q3), increments `task_count`, surfaces when ≥3 distinct tasks involved.

Surfaced under `briefing.signals[].kind = 'recurring_blocker'` with `task_count` + `task_ids[]` + first occurrence as evidence.

---

## §9 — Briefing schema

The briefing is a typed JSON object, NOT prose. Per S2 spec (`v8-substrate-s2-spec.md`), this goes through `submit_report` before delivery — every claim cites `verified_against`.

```typescript
import { z } from "zod";

export const SignalKindSchema = z.enum([
  "stalled_task",
  "dormant_objective",
  "implicit_deadline",
  "recurring_blocker",
  "momentum", // recently completed objective milestone
  "self_defining_progress", // touches Conway Pattern 2 cohort
]);

export const JudgmentSchema = z.object({
  signal_id: z.string().uuid(),
  kind: SignalKindSchema,
  subject: z.string(), // task_id, objective path, error_class, etc
  posture: z.enum(["at_risk", "has_momentum", "highest_leverage", "noted"]),
  // Devin port (`reference_devin_background.md`) — confidence-as-control-flow.
  // After 30 days post-launch, audit confidence-vs-promote-rate correlation.
  // If green and red have similar promote rates, the score is uncalibrated.
  confidence: z.enum(["green", "yellow", "red"]),
  confidence_reason: z.string().min(10),
  why: z.string().min(20), // one-paragraph reasoning, must reference evidence
  evidence_indices: z.array(z.number().int().nonnegative()).min(1),
  proposed_action: z
    .object({
      surface: z.enum(["ask_operator", "auto_propose_skill", "log_only"]),
      // LangChain ambient port (`reference_langchain_ambient.md`) —
      // capability-flagged interrupt cards. Different surfaces get different combos.
      capability_flags: z.object({
        allow_ignore: z.boolean(),
        allow_respond: z.boolean(),
        allow_edit: z.boolean(), // operator can edit detail before action
        allow_accept: z.boolean(), // operator can approve as-is
      }),
      detail: z.string(),
    })
    .optional(),
});

export const BriefingSchema = z.object({
  briefing_id: z.string().uuid(),
  surface: z.enum(["morning", "idle_alert", "pattern_alert", "weekly"]),
  generated_at: z.string().datetime(),
  source_window: z.object({
    cursor_start_event_id: z.number().int(),
    cursor_end_event_id: z.number().int(),
    wall_start: z.string().datetime(),
    wall_end: z.string().datetime(),
  }),
  active_objective_ids: z.array(z.string()), // working-self snapshot at generation
  self_defining_grounding: z.array(z.string()), // Pattern 2 cohort entry IDs referenced
  general_events_used: z.array(z.string()), // event_ids feeding this brief
  judgments: z.array(JudgmentSchema).min(1).max(15),
  highest_leverage_pick: z.string().optional(), // signal_id of THE most important
  // S2 contract fields (from v8-substrate-s2-spec.md):
  verified_against: z.array(/* DataSourceCitationSchema */),
  sample_n: z.number().int().nonnegative(),
  concerns: z.array(/* ConcernSchema */),
  critic_verdict: z.enum(["pass", "fail_returned_anyway", "skipped_allowlist"]),
});

export type Briefing = z.infer<typeof BriefingSchema>;
```

### Storage

```sql
CREATE TABLE proposed_briefings (
  id INTEGER PRIMARY KEY,
  briefing_id TEXT UNIQUE NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('morning','idle_alert','pattern_alert','weekly')),
  generated_at TEXT NOT NULL,
  briefing_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','promoted','discarded','superseded','expired')),
  promoted_at TEXT,
  promoted_by_message_id INTEGER,
  discarded_at TEXT,
  superseded_by_briefing_id TEXT REFERENCES proposed_briefings(briefing_id),
  expires_at TEXT NOT NULL,                  -- defaults to generated_at + 24h for morning
  s2_report_id TEXT REFERENCES reports(report_id)
);
CREATE INDEX idx_pb_surface_status ON proposed_briefings(surface, status);
CREATE INDEX idx_pb_pending_expires ON proposed_briefings(status, expires_at) WHERE status='pending';
```

### Promote/discard semantics

- Operator's first interaction after generation → `promoted` (any non-rejecting reply) OR `discarded` (explicit "not interested" or 24h timeout)
- Promoted briefings inserted into `general_events` as a Pattern 1 entry (judgment becomes part of memory)
- Discarded briefings retained — recallable in `correspondence` mode for "what did I dismiss?" queries
- Superseded: a newer brief on the same surface auto-supersedes pending ones (no stack of 7 unread morning briefs)

### Triage policy as learned memory (LangChain ambient port)

Per `reference_langchain_ambient.md`: surface-vs-silent decision is NOT a static threshold. It's a **learned policy** stored in long-term memory. Every promote/discard signal updates the cell.

```sql
CREATE TABLE triage_policies (
  surface TEXT PRIMARY KEY CHECK (surface IN ('morning','idle_alert','pattern_alert','weekly')),
  policy_text TEXT NOT NULL,           -- accumulated learned criteria, operator-readable
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  promote_count INTEGER NOT NULL DEFAULT 0,
  discard_count INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT                     -- 'promoted' | 'discarded' | 'expired'
);
```

The reflection prompt template (§10) reads `triage_policies.policy_text` for the active surface and includes it as context. After every promote/discard, an LLM update pass rewrites `policy_text` to incorporate the new signal.

**Maps onto Conway Pattern 2**: the triage policy is part of the self-defining cohort — it encodes operator's accumulated preferences. Bilateral co-evolution at the surface layer. Lives in stable cache prefix.

---

## §10 — The judgment prompt (the Conway shift)

The reflection prompt teaches the agent to **construct judgments**, not summarize state. Template:

```
You are constructing a [SURFACE] briefing for Fede. This is a forward-looking judgment, not a summary.

INPUTS YOU'VE BEEN GIVEN:
- Active goal context: [active_objective_ids with titles + descriptions]
- Self-defining memory cohort (≤30 entries from Pattern 2): [pinned context]
- General events from the bounded diff window: [top-8 events with summaries]
- Episodic samples (top-3 per event): [24 chunks max]
- Detection outputs:
  - Stalled tasks: [list]
  - Dormant objectives: [list]
  - Implicit deadlines (within 7d): [list]
  - Recurring blockers: [list]

YOUR JOB:
Construct judgments using ONE of four postures per signal:
- AT_RISK: this needs attention, declining momentum or hard deadline approaching
- HAS_MOMENTUM: this is moving, don't disrupt — protect/amplify
- HIGHEST_LEVERAGE: this is the single most-impactful action available today
- NOTED: surfaced for awareness, no action needed

DISCIPLINE:
1. Every judgment MUST cite specific evidence from the input — no generic claims
2. Self-defining cohort grounds your reasoning — use it for "Fede has historically prioritized X"
3. Pick exactly ONE highest_leverage per briefing (or zero if nothing rises)
4. Maximum 15 judgments. Below 5 is fine — terseness is preferred to padding
5. Recall mode is COHERENCE — surface what serves goals, not "everything that happened"
6. If a signal is in the discarded-briefings history (last 7d), do NOT re-surface unless materially different — operator already saw it

DO NOT:
- Write prose paragraphs explaining what happened ("Yesterday, Fede worked on..."). That's correspondence mode, not your job.
- Recommend actions outside the operator's stated objectives
- Re-surface a signal previously promoted to general_events without new evidence
- Speak as if you were Jarvis to Fede — you are a reflector writing for Jarvis to use

OUTPUT:
A typed Briefing JSON conforming to BriefingSchema (validated by Zod at boundary).
```

### Judgment vocabulary calibration

The four postures (`at_risk` / `has_momentum` / `highest_leverage` / `noted`) are deliberately constrained. Open-ended posture taxonomies drift. After 3 months of operation, audit which postures dominate — if `noted` is >60% of all judgments, the agent isn't doing judgment, it's doing summarization. Re-tune the prompt.

### Mode selection

- Morning brief surface → `coherence` recall mode
- Pattern alert → `coherence` (forward-focused on the blocker)
- Weekly review → `correspondence` (retrospective audit)
- Idle alert → `coherence`

Per Pattern 3 from `reference_conway_2005_sms.md`. Mixing modes produces drift toward confabulation.

---

## §10.5 — Self-scheduled checkpoints (Devin port)

Per `reference_devin_background.md`: Devin's coordinator can "schedule messages to itself" as future checkpoints — self-cron is a built-in primitive. Reflection extends this:

```sql
CREATE TABLE reflection_followups (
  id INTEGER PRIMARY KEY,
  followup_id TEXT UNIQUE NOT NULL,
  fire_after TEXT NOT NULL,
  checkpoint_kind TEXT NOT NULL CHECK (checkpoint_kind IN (
    'verify_resolution',     -- did the at-risk signal actually resolve?
    'pattern_recheck',       -- has the recurring blocker reappeared?
    'deadline_warning',      -- implicit deadline is now within 48h
    'momentum_protect'       -- has-momentum signal — recheck that nothing disrupted it
  )),
  context_briefing_id TEXT REFERENCES proposed_briefings(briefing_id),
  context_signal_id TEXT,                  -- judgment.signal_id from the surfacing brief
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  fired_at TEXT,
  fired_briefing_id TEXT REFERENCES proposed_briefings(briefing_id)
);
CREATE INDEX idx_followups_pending ON reflection_followups(fire_after) WHERE fired_at IS NULL;
```

Cron sweeps every minute; due rows trigger a focused reflection pass with the original `signal_id` as context. Output is a follow-up briefing (`surface='pattern_alert'` typically) referencing the earlier judgment.

**Why this matters per Devin's discipline**: every prediction has a future audit point. No fire-and-forget. Surfaces the "I said X is at risk; was I right?" loop automatically. Mirrors V8.3 reversibility — Jarvis's predictions are themselves reversible by reality.

Pairs with V8-VISION §3-S2 self-audit discipline: every fired follow-up's verification result becomes evidence in the next S2 critic pass on the next briefing.

## §11 — Cross-substrate alignment

| Substrate                  | Role in V8.1                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1** cache-aware prompts | Self-defining cohort (Pattern 2) lives in stable prefix; general events + episodic samples in variable section                                                         |
| **S2** self-audit          | Every `BriefingSchema` instance goes through S2 critic before insertion to `proposed_briefings`. The `verified_against`/`sample_n`/`concerns` fields are S2 contract   |
| **S3** drift detector      | `general_events_count`, `proposed_briefings_pending_count`, `reflection_cursor_lag_hours` added to S3 invariants — alerts on stalled reflection                        |
| **S4** cost_ledger v2      | Reflection runs write `agent_type='reflection:<surface>'` rows. Per-surface cost analysis becomes one query                                                            |
| **S5** skills              | Brief generation is itself a skill (`skill__construct_morning_brief`). Lets us version the template, test it, audit it. Reflection trigger configures `skill_run`      |
| **Conway Pattern 1**       | General-events table is the load-bearing structural choice — V8.1 doesn't ship without it                                                                              |
| **Conway Pattern 2**       | Self-defining cohort grounds judgments. Without it, briefings read generic                                                                                             |
| **Conway Pattern 3**       | Recall mode parameter (`coherence`/`correspondence`) on every retrieval call                                                                                           |
| **Conway Pattern 4**       | `goal_context_id` capture on `general_events` and `proposed_briefings` (forward-compat for goal-conditioned retrieval)                                                 |
| **Letta pattern**          | N-turn trigger + bounded cursor + role-reframe; explicitly diverged on direct-write (we use proposed_briefings instead)                                                |
| **LangChain ambient**      | Learned triage policy in memory (not static threshold) + capability-flagged interrupt cards; rejected cron-as-only-heartbeat                                           |
| **Devin**                  | Confidence-as-control-flow (green/yellow/red on every judgment) + self-scheduled follow-up checkpoints; rejected tests-as-harness                                      |
| **AutoGen**                | LLM-judged tri-boolean progress ledger + bidirectional stall counter (max=3); rejected per-turn synchronous cadence                                                    |
| **MIRIX**                  | Multi-vector embeddings per record (summary + details) + parallel write-fanout via meta-router + source-tagged retrieval; rejected missing-decay (Pattern 5 post-V8.0) |

The compounding effect: V8.1 is the first capability that exercises every substrate item. Shipping V8.1 successfully validates the substrate ladder, which in turn unblocks V8.2 + V8.3.

---

## §12 — Phasing (post-freeze)

V8.1 is the largest capability item by effort because it's the first to exercise everything. Phasing splits structural work from capability work.

### Phase 1 — General-events layer + manual seed (~3 days)

1. Migration: `general_events`, `general_event_episodic_links`, `general_events_vec`
2. Manual seed: 30-50 events backfilled from existing consolidations + Phase β/γ post-mortems
3. Embedding pipeline: write-time embed via existing Hindsight pipeline
4. `retrieveForBriefing()` + tests
5. **Unblocks**: hierarchical retrieval works in isolation; can be used by anything before V8.1 ships

### Phase 2 — Self-defining cohort + S1 extension (~1 day)

1. Extend `jarvis_files.qualifier` enum with `'self-defining'`
2. Wire into `buildJarvisSystemPrompt` stable section
3. Operator picks initial cohort (≤30); document curation discipline in CLAUDE.md
4. **Unblocks**: V8.2 grounding (Conway Pattern 2)

### Phase 3 — Coherence/correspondence rename + audit cron (~1 day)

1. Rename `excludeOutcomes` default to `recall_mode` enum across recall paths
2. New `mc-ctl recall-correspondence-audit` weekly cron task
3. **Unblocks**: judgment-prompt mode-selection knob

### Phase 4 — Reflection runner + cursor + bounded-diff scope (~3 days)

1. `src/reflection/runner.ts` — fast-runner wrapper with reflection-specific config (per Letta same-class-different-prompt pattern)
2. `reflection_cursors` table + advance/read API
3. `src/reflection/scope.ts` — builds bounded-diff input from cursors
4. Role-reframe `<system-reminder>` injection
5. Tests: cursor advancement, scope construction, role-reframe presence

### Phase 5 — Detection algorithms (~2 days)

1. Stalled-task / dormant-objective / implicit-deadline / recurring-blocker queries
2. Schema extension for `task_errors` (if recurring-blocker uses error_class)
3. Tests: detection on synthetic data + held-out historical period

### Phase 6 — Briefing schema + judgment prompt + S2 integration (~3 days)

1. `BriefingSchema` Zod definitions
2. `proposed_briefings` migration
3. Judgment prompt template + skill registration (`skill__construct_morning_brief`)
4. S2 critic integration on every Briefing
5. Tests: schema validation, prompt rendering, critic mock pass/fail, retry budget

### Phase 7 — Triggers (N-turn + cron + idle) (~2 days)

1. N-turn counter wiring into dispatcher
2. Cron-driven 06:00 surface (replaces existing `rituals/morning.ts`)
3. Idle-detect job
4. Throttling per surface
5. Tests: trigger fires at correct boundaries, throttling holds

### Phase 8 — Surface delivery (~2 days)

1. Telegram + email render of `BriefingSchema` to operator-readable Spanish output
2. Promote/discard interaction (operator first turn after delivery)
3. Migration of existing morning ritual to skill — `rituals/morning.ts` becomes a thin wrapper over Trigger 2

### Phase 9 — Activation & curation (~1 day)

1. Run live for 7 days; curate self-defining cohort + general-events seed
2. Tune detection thresholds (stalled days, dormant days, blocker count)
3. Activation gate query (§13)

**Total**: ~18 days post-freeze. V8.1 is the largest single ship in V8 — significantly larger than any substrate item. This justifies splitting into Phase 1+2+3 (structural foundations, can ship independently) before Phase 4-9 (the actual capability).

**Phase 1+2+3 are also useful to ship even if V8.1 stalls**: they're the Conway-pattern infrastructure, valuable regardless of whether V8.1 capability lands.

---

## §13 — Activation gate & measurement

Per V8-VISION §4-V8.1: **"cache-read ratio ≥80% sustained over a 24h window with morning-brief generation included."**

### Activation queries

```sql
-- Cache-read ratio (V8-VISION explicit gate)
SELECT
  ROUND(100.0 * SUM(cache_read_tokens) / SUM(prompt_tokens), 1) AS cache_pct,
  COUNT(*) AS reflection_runs,
  SUM(cost_usd) AS total_cost
FROM cost_ledger
WHERE agent_type LIKE 'reflection:%'
  AND created_at > datetime('now', '-1 day');
-- Target: cache_pct >= 80, reflection_runs >= 5

-- Briefing health
SELECT
  surface,
  COUNT(*) AS generated,
  SUM(status='promoted') AS promoted,
  SUM(status='discarded') AS discarded,
  SUM(status='expired') AS expired,
  ROUND(100.0 * SUM(status='promoted') / COUNT(*), 1) AS promote_rate
FROM proposed_briefings
WHERE generated_at > datetime('now', '-7 days')
GROUP BY surface;
-- Target morning surface: promote_rate >= 60% (operator finds value most days)
```

### Operational metrics (post-V8.1 launch)

- **Promote rate ≥60%** on morning surface within 30 days
- **Time-to-first-action**: median minutes between morning brief delivery and operator's first action on a surfaced item — target <30 min on workdays
- **Audit-cycle rate**: count of operator "Audited?" messages on V8.1 briefings — target 0 within 60 days (S2 critic should make these unnecessary)
- **General-events coverage**: every active NorthStar objective has ≥1 general event referenced in the last 7 days of briefings — target 100%
- **Self-defining cohort drift**: cohort changes <5 entries per quarter — high churn signals operator hasn't found stable identity-grounding

### Watchpoints

- `noted` posture > 60% of all judgments → agent is summarizing, not judging. Re-tune
- Promote rate < 30% sustained → briefs aren't useful. Re-audit detection thresholds + judgment prompt
- Cache-read ratio < 70% sustained → cohort or general-events sizing issue; check stable/variable prefix split per `feedback_cache_prefix_variability.md`
- Discard-due-to-stale (24h expiry) > 20% → operator is offline more than expected; consider lengthening expiry or moving cron earlier

---

## §14 — Open questions

1. **Cohort curation cadence**: Pattern 2 self-defining cohort drift is bounded at 5/quarter — but who drives the curation? Operator-only (matches v8.3 perimeter discipline) vs Jarvis-proposes-operator-approves. Spec defaults to operator-only; revisit if cohort goes stale.

2. **General-events auto-discovery vs manual**: nightly cron proposes new general events from clustered tasks. Clustering algorithm? Theme-based? Goal-context-based? Embedding-cluster-based? Defer to Phase 1 implementation; start with goal-context + ±3-day window as the simplest heuristic.

3. **Recurring blocker semantic equivalence**: "same error" in 3 different languages or with different stack traces is hard to detect by exact match. Embedding-similarity threshold? LLM-judged equivalence? Spec defaults to error_class match; revisit if false-negatives surface.

4. **Trigger 1 (N-turn) cost on high-activity days**: 50 foreground tasks × freq=5 = 10 reflection runs/day. At ~$0.10/run that's $1/day — acceptable. But at 200 tasks (sustained heavy use) that's $4/day. Add an upper-bound throttle: max 10 reflection runs per 24h regardless of N-turn schedule.

5. **Multi-language briefings**: existing morning ritual is Spanish. Briefing schema is language-agnostic until render time. Render to operator's primary language; expose a `brief_language` env. Decision: keep Spanish default, no multi-render in V8.1.

6. **Promote-on-implicit-interaction**: operator's morning reply could be unrelated to the brief (e.g., asking about a CRM issue). Counts as promotion or not? Spec defaults to: ANY non-rejection reply within `expires_at` window = promotion. Operator can explicitly discard via "not now" / "skip morning" / etc. Revisit if too lenient.

7. **Discarded briefing forensics**: discarded briefs retained for `correspondence`-mode recall — but for how long? Storage cost is small (JSON), but indefinite retention bloats. Spec defaults to 90-day retention; archive after that.

---

## §15 — Cross-references

- V8-VISION.md §4-V8.1 — original capability requirement
- `docs/planning/v8-substrate-s2-spec.md` — critic primitive used by Phase 6
- `docs/planning/v8-substrate-s5-spec.md` — skill abstraction used for `skill__construct_morning_brief`
- `reference_letta_sleeptime.md` — N-turn trigger + bounded cursor + role-reframe
- `reference_conway_2005_sms.md` — Patterns 1 (general events) + 2 (self-defining) + 3 (coherence/correspondence) all load-bearing
- `reference_datagen.md` — note-agent JSON schema enforcement (parallel to BriefingSchema discipline)
- `feedback_metrics_extrapolation.md` — `verified_against` discipline applied to briefing claims
- `feedback_completed_task_failure_narrative.md` — empirical Conway coherence-distortion case; V8.1 must NOT re-introduce this failure mode
- `reference_langchain_ambient.md` — learned triage policy + capability-flagged Agent Inbox cards
- `reference_devin_background.md` — confidence-as-control-flow + self-scheduled checkpoints
- `reference_autogen_stall.md` — LLM-judged tri-boolean stall ledger + bidirectional counter
- `reference_mirix.md` — multi-vector embeddings per record + parallel write-fanout
- `feedback_cache_prefix_variability.md` — stable/variable prefix discipline for cohort + events
- `src/rituals/morning.ts` — current state, reduced to a Trigger 2 wrapper post-V8.1
- `src/rituals/scheduler.ts` — extended with N-turn-piggybacked trigger

---

## §16 — One-page summary

| Item                                 | Decision                                                                                                                |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Structural foundation**            | General-events middle layer (Conway Pattern 1) — REQUIRED. Without it, V8.1 can't construct judgments                   |
| **Grounding mechanism**              | Self-defining memory cohort (Conway Pattern 2) pinned in S1 stable prefix — Conway predicts V8.1 fails without this     |
| **Recall mode discipline**           | `coherence` (forward) / `correspondence` (audit) explicit per Pattern 3. Mixing → confabulation drift                   |
| **Trigger model**                    | N-turn-piggybacked (Letta default freq=5) + cron 06:00 fallback + 4h-idle alert                                         |
| **Reflection runtime**               | fast-runner reused with reflection-specific config (Letta same-class-different-prompt) — no new runner class            |
| **Briefing schema**                  | Typed JSON via Zod. 4-posture vocabulary (`at_risk`/`has_momentum`/`highest_leverage`/`noted`). ≤15 judgments per brief |
| **Validation**                       | S2 critic on every briefing before persistence. `verified_against` cites general-events + cost_ledger + recall_audit    |
| **Reversibility (Letta divergence)** | `proposed_briefings` table with promote-on-read/discard. Discarded retained 90 days for correspondence recall           |
| **Detection**                        | Stalled (>7d), dormant (>14d), implicit-deadline (regex), recurring-blocker (3+ same-class errors in 14d)               |
| **Effort**                           | ~18 days post-freeze across 9 phases. Phase 1+2+3 (foundations) ship independently                                      |
| **Freeze posture**                   | Spec only. No code changes during freeze. Implementation post 2026-05-22                                                |
| **Dependencies**                     | S2 (built first), S5 (skill registration), Conway Patterns 1+2+3 (built in Phases 1-3)                                  |
| **Unblocks**                         | V8.2 (proposals build on briefings), V8.3 (autonomous-action perimeter informed by recurring patterns)                  |
| **Activation gate**                  | Cache-read ≥80% sustained 24h with reflection runs included; promote rate ≥60% on morning surface within 30 days        |
| **Open Q count**                     | 7 (§14) — none are blocking                                                                                             |
