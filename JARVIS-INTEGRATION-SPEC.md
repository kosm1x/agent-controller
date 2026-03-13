# JARVIS Integration Spec — Agent Controller × COMMIT-AI

> **Audience**: Claude Code working on the `agent-controller` repo (located under `~/Claude/agent-controller/` on the dev VPS)
> **Goal**: Connect Agent Controller to COMMIT-AI (app.mycommit.net) so AI agents can read and write the user's vision/goals/objectives/tasks hierarchy, and power a daily ritual engine (morning briefing, on-demand, nightly close).
> **Approach**: Build an MCP server (`commit-bridge`) that wraps COMMIT-AI's Supabase backend, then add a ritual scheduling layer to Agent Controller.

---

## 1. Context — What exists today

### 1.1 Agent Controller (`~/Claude/agent-controller/`)

A unified AI agent orchestrator with five runner types (fast, nanoclaw, heavy, swarm, a2a), a heuristic classifier, SQLite persistence, SSE event stream, and a web dashboard. Already supports MCP tool servers via `mcp-servers.json`. All runners can consume MCP tools with zero additional configuration — tools are namespaced as `{serverId}__{toolName}`.

Key files to understand:
- `src/mcp/manager.ts` — connects to MCP servers at startup, discovers tools, registers them
- `src/mcp/bridge.ts` — adapts MCP tools to the internal Tool interface
- `src/mcp/config.ts` — loads `mcp-servers.json`
- `src/tools/registry.ts` — central tool registry (built-in + MCP tools coexist)
- `src/dispatch/dispatcher.ts` — task lifecycle, runner routing
- `src/runners/heavy-runner.ts` — Plan-Execute-Reflect (used for briefings)
- `src/runners/fast-runner.ts` — quick tool loops (used for status updates)

### 1.2 COMMIT-AI (GitHub: `kosm1x/COMMIT-AI`, hosted at app.mycommit.net)

A personal growth journaling app built with React 18 + TypeScript + Tailwind, hosted at app.mycommit.net. Uses **Supabase** (PostgreSQL + Auth + PostgREST API) as the backend.

**Stack**: Vite, React Router DOM, Supabase JS client, Groq Qwen 3.2 for AI features, Mermaid for mind maps, Capacitor for mobile.

**Database tables** (all have RLS enabled, scoped to `auth.uid()`):

| Table | Purpose | Key columns (inferred from README + schema) |
|---|---|---|
| `visions` | Long-term aspirations | id, user_id, title, description, status, created_at |
| `goals` | Major milestones | id, user_id, vision_id (FK → visions), title, description, status, priority, created_at |
| `objectives` | Specific targets | id, user_id, goal_id (FK → goals), title, description, status, priority, created_at |
| `tasks` | Concrete actions | id, user_id, objective_id (FK → objectives), title, description, status, priority, due_date, is_recurring, created_at |
| `task_completions` | Daily completion tracking for recurring tasks | id, task_id (FK → tasks), user_id, completed_at |
| `journal_entries` | Freeform journal | id, user_id, content, primary_emotion, created_at |
| `ai_analysis` | AI emotional analysis of journal entries | id, entry_id, emotions, patterns, strategies |
| `ideas` | Captured ideas | id, user_id, title, description, category, tags, created_at |
| `idea_connections` | Relationships between ideas | id, idea_id_1, idea_id_2, relationship |
| `idea_ai_suggestions` | AI-generated enhancements | id, idea_id, suggestion |
| `mind_maps` | Saved mind map visualizations | id, user_id, title, content, created_at |

**Status values** (used across visions, goals, objectives, tasks): `not_started`, `in_progress`, `completed`, `on_hold`

**Priority values**: `high`, `medium`, `low`

**Authentication**: Supabase Auth with email/password. JWT tokens. RLS policies enforce `user_id = auth.uid()` on all tables.

**Supabase credentials** (from `.env`):
- `VITE_SUPABASE_URL` — the project URL (e.g., `https://xxxxx.supabase.co`)
- `VITE_SUPABASE_ANON_KEY` — the public anon key

---

## 2. What to build

Two components:

### Component A: `commit-bridge` MCP server
### Component B: Ritual scheduling layer in Agent Controller

---

## 3. Component A — `commit-bridge` MCP server

### 3.1 Location and structure

Create a new directory inside the agent-controller repo:

```
agent-controller/
  mcp-servers/
    commit-bridge/
      package.json
      tsconfig.json
      src/
        index.ts          # MCP server entry point (stdio transport)
        supabase.ts       # Supabase client initialization + auth
        tools/
          read.ts         # Read tools (get_vision, list_goals, etc.)
          write.ts        # Write tools (create_task, update_status, etc.)
          snapshot.ts     # Composite: get_daily_snapshot
        types.ts          # Shared types matching Supabase schema
```

### 3.2 Technology choices

- **MCP SDK**: Use `@modelcontextprotocol/sdk` (latest) with stdio transport
- **Supabase client**: Use `@supabase/supabase-js` v2
- **Auth strategy**: Service role key (bypasses RLS). This is a private server running on the same VPS — acceptable for single-user. Store as `SUPABASE_SERVICE_ROLE_KEY` env var.
- **Alternative auth** (if service role key is not available): Sign in with email/password at startup using `supabase.auth.signInWithPassword()`, then use the session JWT. The anon key + user JWT respects RLS. Store `COMMIT_USER_EMAIL` and `COMMIT_USER_PASSWORD` as env vars.
- **Build**: TypeScript compiled to JS. The MCP server runs as a subprocess spawned by Agent Controller.

### 3.3 Environment variables

```bash
# Required
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...    # Option A: service role (preferred)

# Option B: user auth (if no service role key)
SUPABASE_ANON_KEY=eyJ...
COMMIT_USER_EMAIL=fede@eurekamd.net
COMMIT_USER_PASSWORD=123456

# Optional
COMMIT_USER_ID=<uuid>               # If using service role, filter by this user_id
```

### 3.4 Supabase client initialization (`supabase.ts`)

```typescript
import { createClient } from '@supabase/supabase-js';

// Option A: Service role
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// All queries must filter by user_id when using service role:
// .eq('user_id', process.env.COMMIT_USER_ID)

// Option B: User auth
// const supabase = createClient(url, anonKey);
// await supabase.auth.signInWithPassword({ email, password });
// RLS handles user_id filtering automatically
```

Implement both options with a factory function. Detect which auth method to use based on which env vars are present. Prefer service role if available.

### 3.5 MCP tools specification

Each tool is registered with the MCP SDK's `server.setRequestHandler(ListToolsRequestSchema, ...)` and `server.setRequestHandler(CallToolRequestSchema, ...)`.

#### READ TOOLS

**`commit__get_vision`**
- Description: "Get the active vision(s) for the user"
- Input: `{ status?: string }` (default: all)
- Supabase query: `supabase.from('visions').select('*').eq('user_id', userId).order('created_at', { ascending: false })`
- Returns: Array of vision objects

**`commit__list_goals`**
- Description: "List goals, optionally filtered by vision, status, or priority"
- Input: `{ vision_id?: string, status?: string, priority?: string }`
- Supabase query: `supabase.from('goals').select('*, visions(title)').eq('user_id', userId)` + optional filters
- Returns: Array of goal objects with parent vision title

**`commit__list_objectives`**
- Description: "List objectives, optionally filtered by goal, status, or priority"
- Input: `{ goal_id?: string, status?: string, priority?: string }`
- Supabase query: `supabase.from('objectives').select('*, goals(title)').eq('user_id', userId)` + optional filters
- Returns: Array of objective objects with parent goal title

**`commit__list_tasks`**
- Description: "List tasks, optionally filtered by objective, status, priority, due date range, or recurring flag"
- Input: `{ objective_id?: string, status?: string, priority?: string, due_before?: string, due_after?: string, is_recurring?: boolean }`
- Supabase query: `supabase.from('tasks').select('*, objectives(title, goals(title, visions(title)))').eq('user_id', userId)` + filters
- Returns: Array of task objects with full hierarchy breadcrumb

**`commit__get_daily_snapshot`**
- Description: "Get a complete snapshot for today: pending tasks, recurring tasks needing completion, upcoming deadlines (7 days), active goals count, recent completions, and streaks. This is the primary tool for morning briefings."
- Input: `{}` (no params)
- Logic:
  1. Fetch all tasks where `status != 'completed'`, ordered by priority then due_date
  2. Fetch today's `task_completions` to know which recurring tasks are already done
  3. Fetch tasks with `due_date` in next 7 days
  4. Count active goals (`status = 'in_progress'`)
  5. Count active objectives (`status = 'in_progress'`)
  6. Fetch the user's vision(s) for context
  7. Calculate basic streaks: count consecutive days with at least one completion in `task_completions`
- Returns: A structured JSON object:
  ```json
  {
    "vision": { "title": "...", "description": "..." },
    "active_goals_count": 5,
    "active_objectives_count": 12,
    "tasks": {
      "critical": [...],
      "high_priority": [...],
      "medium_priority": [...],
      "low_priority": [...]
    },
    "recurring_tasks": {
      "pending_today": [...],
      "completed_today": [...]
    },
    "upcoming_deadlines": [...],
    "streak_days": 7,
    "yesterday_completions": 4
  }
  ```

**`commit__get_hierarchy`**
- Description: "Get the full vision → goals → objectives → tasks tree for strategic review"
- Input: `{ vision_id?: string }` (if omitted, return all)
- Logic: Fetch visions, then goals with their objectives and tasks nested. Build a tree structure.
- Returns: Nested JSON tree

**`commit__search_journal`**
- Description: "Search journal entries by date range or keyword"
- Input: `{ query?: string, date_from?: string, date_to?: string, limit?: number }`
- Supabase query: Use `.ilike('content', '%query%')` for keyword search, date filters on `created_at`
- Returns: Array of journal entries

#### WRITE TOOLS

**`commit__create_task`**
- Description: "Create a new task linked to an objective"
- Input: `{ title: string, description?: string, objective_id: string, priority?: 'high'|'medium'|'low', due_date?: string, is_recurring?: boolean }`
- Supabase query: `supabase.from('tasks').insert({ ...input, user_id: userId, status: 'not_started' }).select()`
- Returns: Created task object

**`commit__create_objective`**
- Description: "Create a new objective linked to a goal"
- Input: `{ title: string, description?: string, goal_id: string, priority?: 'high'|'medium'|'low' }`
- Returns: Created objective object

**`commit__create_goal`**
- Description: "Create a new goal linked to a vision"
- Input: `{ title: string, description?: string, vision_id: string, priority?: 'high'|'medium'|'low' }`
- Returns: Created goal object

**`commit__update_item_status`**
- Description: "Update the status of any item (vision, goal, objective, or task)"
- Input: `{ table: 'visions'|'goals'|'objectives'|'tasks', id: string, status: 'not_started'|'in_progress'|'completed'|'on_hold' }`
- Supabase query: `supabase.from(table).update({ status }).eq('id', id).eq('user_id', userId).select()`
- Returns: Updated item

**`commit__update_task`**
- Description: "Update any field on a task (title, description, priority, due_date, is_recurring, objective_id)"
- Input: `{ id: string, ...fields }` (partial update)
- Returns: Updated task

**`commit__complete_recurring_today`**
- Description: "Mark a recurring task as completed for today (inserts into task_completions)"
- Input: `{ task_id: string }`
- Logic:
  1. Check if already completed today (prevent duplicates)
  2. Insert into `task_completions`: `{ task_id, user_id, completed_at: new Date().toISOString() }`
- Returns: Completion record or "already completed today" message

**`commit__add_journal_entry`**
- Description: "Create a new journal entry (used for nightly reflections and AI-generated summaries)"
- Input: `{ content: string, primary_emotion?: string }`
- Returns: Created journal entry

**`commit__bulk_reprioritize`**
- Description: "Update priorities for multiple tasks at once (used by the morning briefing agent to rebalance)"
- Input: `{ updates: Array<{ id: string, priority: 'high'|'medium'|'low' }> }`
- Logic: Loop through updates, execute each. Use a transaction if Supabase supports it via RPC, otherwise sequential updates.
- Returns: Count of updated tasks

### 3.6 MCP server entry point (`index.ts`)

Use the standard MCP stdio transport pattern:

```typescript
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'commit-bridge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Register tool list handler
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ... all tool definitions with name, description, inputSchema (JSON Schema)
  ]
}));

// Register tool call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  switch (name) {
    case 'commit__get_vision': return handleGetVision(args);
    case 'commit__list_tasks': return handleListTasks(args);
    // ... etc
    default: throw new Error(`Unknown tool: ${name}`);
  }
});

// Connect
const transport = new StdioServerTransport();
await server.connect(transport);
```

### 3.7 Registration in Agent Controller

Add to `mcp-servers.json` in the agent-controller root:

```json
{
  "commit": {
    "command": "node",
    "args": ["./mcp-servers/commit-bridge/dist/index.js"],
    "env": {
      "SUPABASE_URL": "${SUPABASE_URL}",
      "SUPABASE_SERVICE_ROLE_KEY": "${SUPABASE_SERVICE_ROLE_KEY}",
      "COMMIT_USER_ID": "${COMMIT_USER_ID}"
    }
  }
}
```

Note: Check how `src/mcp/config.ts` handles env var interpolation. If it doesn't support `${VAR}` syntax, the env vars need to be passed through the process environment directly (the MCP server inherits the parent process env).

### 3.8 Important: Schema discovery

Before implementing, **read the actual Supabase migrations** to confirm the exact column names, types, and foreign keys. The schema above is inferred from the README — it may have additional columns (e.g., `order`, `color`, `archived`, `parent_id` for orphaned items support).

Run this before coding:
```bash
cd ~/Claude/COMMIT-AI
ls supabase/migrations/
cat supabase/migrations/*.sql
```

Pay special attention to:
- Exact column names and types
- Foreign key relationships and cascades
- Whether `vision_id`, `goal_id`, `objective_id` are nullable (the README mentions "orphaned items")
- Any RPC functions defined
- RLS policies (to understand access patterns)

---

## 4. Component B — Ritual scheduling layer

### 4.1 Overview

Add a lightweight cron-like scheduler to Agent Controller that submits pre-configured tasks at specific times. This powers the three daily rituals:

1. **Morning briefing** (7:00 AM Mexico City time) — Heavy runner
2. **On-demand** — User-initiated via WhatsApp/Telegram/API (no scheduler needed)
3. **Nightly close** (10:00 PM Mexico City time) — Heavy runner

### 4.2 Location

```
agent-controller/
  src/
    rituals/
      scheduler.ts      # Cron scheduler (node-cron or setInterval)
      morning.ts        # Morning briefing task template
      nightly.ts        # Nightly close task template
      config.ts         # Schedule configuration
```

### 4.3 Scheduler implementation

Use `node-cron` (add as dependency) or a simple `setInterval` with time checks. The scheduler runs inside the Agent Controller process — no separate service.

```typescript
// config.ts
export const RITUALS_TIMEZONE = 'America/Mexico_City';

export const rituals = [
  {
    id: 'morning-briefing',
    cron: '0 7 * * *',  // 7:00 AM daily
    taskTemplate: morningBriefingTask,
    enabled: true
  },
  {
    id: 'nightly-close',
    cron: '0 22 * * *', // 10:00 PM daily
    taskTemplate: nightlyCloseTask,
    enabled: true
  }
];
```

### 4.4 Morning briefing task template

This is submitted to the dispatcher as a Heavy runner task:

```typescript
export const morningBriefingTask = {
  title: 'Morning briefing',
  description: `You are Jarvis, Fede's personal strategic assistant. Execute the morning briefing ritual.

## Instructions

1. Call the tool commit__get_daily_snapshot to get today's full context.
2. Review the vision and active goals to frame the day strategically.
3. Analyze pending tasks and classify each using the Eisenhower matrix:
   - CRITICAL: Urgent + Important (do first)
   - URGENT: Urgent + Not as important (do second or delegate)
   - IMPORTANT: Not urgent + Important (schedule time blocks)
   - DELEGABLE: Not urgent + Not important (defer or drop)
   Use these signals: due_date proximity, priority field, whether the task blocks other tasks, and alignment with active goals.
4. Check recurring tasks that need completion today.
5. Identify the top 3 tasks that would make today a win.
6. If any tasks have overdue due_dates, flag them prominently.
7. If any goals have no active objectives or tasks, flag the gap.

## Output format

Produce a structured briefing message in Spanish (Mexican) suitable for WhatsApp delivery:

**Buenos días, Fede.** 🗓️ [Date]

**Tu visión**: [one-line reminder]

**🔴 Crítico** (hacer primero)
- [ ] Task 1 — [context/why it matters]
- [ ] Task 2

**🟠 Urgente**
- [ ] Task 3

**🟡 Importante** (bloques de deep work)
- [ ] Task 4

**🔁 Hábitos del día**
- [ ] Recurring task 1
- [ ] Recurring task 2

**⚠️ Alertas**
- [overdue tasks, stalled goals, gaps]

**🏆 Si logras estas 3 cosas, hoy fue un buen día:**
1. ...
2. ...
3. ...

Racha actual: X días consecutivos.`,
  agent_type: 'heavy',
  tools: ['commit__get_daily_snapshot', 'commit__list_tasks', 'commit__get_hierarchy']
};
```

### 4.5 Nightly close task template

```typescript
export const nightlyCloseTask = {
  title: 'Nightly close',
  description: `You are Jarvis, Fede's personal strategic assistant. Execute the nightly close ritual.

## Instructions

1. Call commit__get_daily_snapshot to see today's final state.
2. Compare with what was planned (the morning briefing context): what got done, what didn't, what was added mid-day.
3. For each incomplete critical/urgent task, assess: should it carry over to tomorrow, be reprioritized, or be dropped?
4. Call commit__bulk_reprioritize if any tasks need rebalancing for tomorrow.
5. Write a brief reflection and log it as a journal entry using commit__add_journal_entry.
6. Prepare tomorrow's preliminary priority list.

## Output format

Structured WhatsApp message in Spanish (Mexican):

**Cierre del día** 🌙 [Date]

**✅ Completado hoy** (X de Y tareas)
- Task 1 ✓
- Task 2 ✓

**⏳ Pendiente (movido a mañana)**
- Task 3 — [reason/new priority]

**📝 Reflexión**
[2-3 sentences about what worked, what didn't, and one learning]

**📋 Preview de mañana**
Top 3 prioridades preliminares:
1. ...
2. ...
3. ...

Racha: X días. [motivational note if streak is growing]`,
  agent_type: 'heavy',
  tools: ['commit__get_daily_snapshot', 'commit__list_tasks', 'commit__bulk_reprioritize', 'commit__add_journal_entry']
};
```

### 4.6 Notification delivery (future enhancement)

The ritual tasks produce text output. Initially, this output is available via:
- The SSE event stream (`/api/events/stream`)
- The dashboard UI (`/dashboard/`)
- The task result in the API (`GET /api/tasks/:id`)

WhatsApp/Telegram delivery is a **separate integration** (not in this spec). When ready, it can be implemented as:
- A post-completion hook in the dispatcher that sends the task result to a messaging API
- Or a dedicated "notification runner" that wraps the output and sends it

For now, the dashboard and SSE stream are sufficient to test the full ritual loop.

### 4.7 Integration with Agent Controller startup

In `src/index.ts`, after the server starts and MCP tools are initialized:

```typescript
import { startRitualScheduler } from './rituals/scheduler.js';

// After server.listen() and initMcp()
if (process.env.RITUALS_ENABLED === 'true') {
  startRitualScheduler();
  console.log('[rituals] Scheduler started');
}
```

New env vars:
```bash
RITUALS_ENABLED=true
RITUALS_TIMEZONE=America/Mexico_City
```

---

## 5. Autonomy levels (configuration)

Add a config object (can be in `rituals/config.ts` or a separate `autonomy.ts`) that defines what the agents can do without asking:

```typescript
export const autonomy = {
  // Full autonomy — agent does it, no notification needed
  autonomous: [
    'commit__get_vision',
    'commit__list_goals',
    'commit__list_objectives',
    'commit__list_tasks',
    'commit__get_daily_snapshot',
    'commit__get_hierarchy',
    'commit__search_journal',
    'commit__complete_recurring_today',  // Marking habits done
    'commit__update_task',               // Reordering, minor edits
  ],

  // Execute and notify — agent does it, sends a notification
  notify: [
    'commit__create_task',
    'commit__update_item_status',
    'commit__bulk_reprioritize',
    'commit__add_journal_entry',
  ],

  // Requires approval — agent proposes, waits for confirmation
  approval_required: [
    'commit__create_goal',
    'commit__create_objective',
    // Any action that changes the strategic hierarchy
  ]
};
```

This is informational for now — the enforcement mechanism (approval gates) can be implemented later. The agents' system prompts should reference these levels so they self-regulate.

---

## 6. Implementation order

**Working directory**: `~/Claude/agent-controller/` — all paths below are relative to this root. The COMMIT-AI repo (`kosm1x/COMMIT-AI`) should be cloned alongside for schema reference: `~/Claude/COMMIT-AI/`.

Execute in this sequence:

### Phase 1: commit-bridge MCP server (do this first)
1. Read `~/Claude/COMMIT-AI/supabase/migrations/*.sql` to confirm exact schema
2. Initialize the `mcp-servers/commit-bridge/` project (package.json, tsconfig)
3. Implement `supabase.ts` with dual auth support
4. Implement read tools (`get_vision`, `list_goals`, `list_objectives`, `list_tasks`, `get_daily_snapshot`, `get_hierarchy`, `search_journal`)
5. Implement write tools (`create_task`, `create_objective`, `create_goal`, `update_item_status`, `update_task`, `complete_recurring_today`, `add_journal_entry`, `bulk_reprioritize`)
6. Implement `index.ts` MCP server entry point
7. Build and test: `npm run build && echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | node dist/index.js`
8. Register in `mcp-servers.json`
9. Test via Agent Controller API: submit a fast task that calls `commit__get_daily_snapshot`

### Phase 2: Ritual scheduler
1. Add `node-cron` dependency to agent-controller
2. Implement `rituals/config.ts`, `rituals/scheduler.ts`
3. Implement `rituals/morning.ts` and `rituals/nightly.ts` task templates
4. Wire into `src/index.ts` startup
5. Test by temporarily setting cron to run in 2 minutes, verify task appears in dashboard

### Phase 3: Validation and tuning
1. Run a full morning briefing manually (`POST /api/tasks` with the morning template)
2. Verify the Heavy runner correctly calls MCP tools and produces the expected output
3. Tune the system prompts based on actual output quality
4. Run a full nightly close manually
5. Enable the scheduler and let it run for 3 days, review outputs

---

## 7. Testing strategy

### Unit tests for commit-bridge
- Mock Supabase client, verify each tool produces correct queries
- Test `get_daily_snapshot` composition logic
- Test auth fallback (service role → user auth)
- Test error handling (network failures, empty results, invalid input)

### Integration tests
- Submit a fast task via Agent Controller API that calls `commit__list_tasks`
- Verify the task completes and the result contains actual data from Supabase
- Submit a fast task that calls `commit__create_task`, then verify in app.mycommit.net
- Submit a heavy task with the morning briefing template, verify output quality

### E2E ritual test
- Set RITUALS_ENABLED=true with a 1-minute cron
- Verify task auto-submits, runs, completes, and result is visible in dashboard + SSE stream

---

## 8. Security considerations

- **Never expose Supabase service role key** in client-facing code or API responses
- The commit-bridge runs as a subprocess — its env vars are isolated from the web server
- The Agent Controller API is already protected by `X-Api-Key` — ritual tasks inherit this
- COMMIT-AI's RLS policies remain intact for the web/mobile app; only the MCP server bypasses them (if using service role)
- If the Agent Controller is exposed to the internet, ensure `MC_API_KEY` is strong and rotated regularly

---

## 9. Dependencies to add

### For `mcp-servers/commit-bridge/`:
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "@supabase/supabase-js": "^2"
  },
  "devDependencies": {
    "typescript": "^5.5",
    "@types/node": "^22"
  }
}
```

### For `agent-controller/` (ritual scheduler):
```json
{
  "dependencies": {
    "node-cron": "^3.0.0"
  },
  "devDependencies": {
    "@types/node-cron": "^3.0.0"
  }
}
```

---

## 10. Key decision: Eisenhower classification

The COMMIT-AI schema uses `priority: high | medium | low`. The Jarvis briefing needs a four-quadrant Eisenhower matrix (critical, urgent, important, delegable).

**Do NOT modify the COMMIT-AI schema.** Instead, the Eisenhower classification is computed at runtime by the Heavy runner's LLM based on:
- `priority` field (high → likely critical/urgent, low → likely delegable)
- `due_date` proximity (overdue or due today → urgency boost)
- Alignment with active goals (linked to in-progress goal → importance boost)
- Whether other tasks depend on it (blocking → urgency boost)

This keeps the classification dynamic and intelligent rather than a static field. The LLM in the Heavy runner is the classifier — that's the whole point of using Plan-Execute-Reflect for briefings.

---

## 11. Open questions for the developer

Before starting, confirm:

1. **Supabase credentials**: Do you have access to the Supabase project dashboard? You'll need the service role key from Settings → API → `service_role` (secret). If not available, use the email/password auth fallback.

2. **Schema verification**: Run `cat supabase/migrations/*.sql` and verify the exact column names. The README mentions orphaned items (items without parents) — check if `vision_id`, `goal_id`, `objective_id` are nullable.

3. **MCP SDK version**: Check the latest `@modelcontextprotocol/sdk` version and its API. The patterns above are based on the March 2026 SDK. If the API has changed, adapt accordingly.

4. **Node version**: Agent Controller requires Node 22+. Ensure the commit-bridge tsconfig targets ES2022+ and uses ESM modules to match the parent project.

5. **Network access**: The commit-bridge needs outbound HTTPS to `*.supabase.co`. Verify the VPS/container allows this.
