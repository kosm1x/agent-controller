# Training Jarvis — SOPs as Programming

> Jarvis is not trained through weights. He's trained through SOPs, directives, tool descriptions, and structural constraints. Every behavior you want must be encoded mechanically — not requested behaviorally.

## The Core Insight

LLMs don't learn from corrections mid-conversation. Every message is a fresh task with a fixed system prompt + limited history. When you say "don't do that again," the correction lives in the thread buffer for ~2 messages, then it's gone. The LLM reverts to its default behavior.

The only persistent "training" is:

1. **Directives** (enforce qualifier) — injected into EVERY prompt, always
2. **Tool descriptions** — the LLM reads these to decide how to act
3. **Structural constraints** — tools that mechanically prevent wrong behavior
4. **SOPs in the Knowledge Base** — available via jarvis_file_read when relevant

Behavioral pleas ("don't hallucinate," "relay exactly," "be careful") have zero persistence. They work for one turn, maybe two. Then they're evicted from context.

## The Four Layers of Jarvis Training

### Layer 1: Directives (enforce qualifier)

**What:** Markdown files at `directives/*.md` with qualifier `enforce`, priority 0. Injected into every single prompt with "MANDATORY:" prefix.

**Budget:** ~4,000 chars total. This is expensive real estate — every char here is seen on every message. Keep it tight.

**Currently contains:**

- `directives/core.md` — Persona, 8 SOPs (verify before affirm, no hallucination, use file system, etc.)
- `directives/repo-authorization.md` — GitHub auth rules
- `directives/context-management.md` — Context pressure behavior

**When to add here:** Only for behaviors that must be enforced on EVERY task, regardless of context. If the rule only applies to coding, or email, or NorthStar — it doesn't belong here.

**Pattern:**

```
N. **Rule name.** One sentence explanation. Concrete action, not abstract principle.
```

**Example of good directive:**

> 7. **Tu file system es jarvis_file_write, NO file_write.** Cuando necesites guardar conocimiento, usa jarvis_file_write. file_write es para código fuente en proyectos externos.

**Example of bad directive (too vague):**

> 7. **Sé cuidadoso con los archivos.** Piensa antes de escribir.

### Layer 2: Tool Descriptions (ACI)

**What:** The `description` field in every tool definition. The LLM reads this to decide WHEN to call a tool, HOW to call it, and what NOT to do.

**This is the most powerful training surface.** A well-written tool description prevents more errors than any system prompt directive.

**Pattern:**

```
USE WHEN:
- [specific trigger scenarios]

DO NOT USE WHEN:
- [specific scenarios where this tool is wrong]

CRITICAL: [the one thing the LLM must never get wrong]
```

**Example — gmail_send (after hardening):**

```
CRITICAL: Sending unsolicited emails is a SERIOUS violation. NEVER send an email
unless the user explicitly requested it in the current message. "Verify the email"
means SEARCH, not SEND.
```

**Example — jarvis_file_move (teaching task classification):**

```
THIS IS A TRANSPORT OPERATION — use it instead of jarvis_file_read + jarvis_file_write
when you only need to move a file without modifying its content. It's faster and
doesn't consume context.
```

**Key insight:** Tool descriptions teach the LLM to CLASSIFY tasks, not just execute them. "Transport vs research" is a classification the LLM learns from the tool description, not from a directive.

### Layer 3: Structural Constraints (mechanical enforcement)

**What:** Code-level guards that make wrong behavior impossible, regardless of what the LLM tries.

**Examples already in production:**

- `shell_exec` blocks `git push/commit/add` → forces use of git tools
- `git_commit` requires `cwd` parameter → prevents wrong-repo commits
- `git_push` verifies remote exists → prevents push to non-existent repos
- `file_write` blocks `/root/claude/mission-control/` → Jarvis can't modify its own code
- First-round tool-skip guard → forces tool usage when LLM tries to fabricate
- Refusal fallback → uses raw tool result when LLM refuses to format it

**When to use:** When the same mistake happens 3+ times despite directives and tool descriptions. If the LLM keeps doing it wrong, make it mechanically impossible to do it wrong.

**The 3-strike rule:** If the same class of fix fails 3 times (prompt rewording, stronger directives, better descriptions), the problem is structural. Stop telling the LLM to behave — make it impossible to misbehave.

### Layer 4: Knowledge Base SOPs

**What:** Procedure files at `knowledge/procedures/*.md` with qualifier `reference`. Available via `jarvis_file_read` when Jarvis needs them, but not auto-injected (saves budget).

**Use for:** Domain-specific procedures that apply only in certain contexts. Unlike directives (always-on), SOPs are loaded on demand.

**Examples:**

- `knowledge/procedures/sync-protocol.md` — How to sync files to Google Drive
- `knowledge/procedures/northstar-sync-protocol.md` — How to update NorthStar files
- `knowledge/procedures/obsidian-sync-protocol.md` — Obsidian integration rules

**Pattern:**

```markdown
# [Procedure Name]

## When to use

[Specific trigger: "when the user asks to sync to Drive"]

## Steps

1. [Concrete action with tool name]
2. [Concrete action]
3. [Verification step]

## Common mistakes

- [What goes wrong and how to avoid it]
```

**When to add:** When you find yourself repeating the same multi-step instruction to Jarvis across multiple conversations. If you've said "first read the file, then update it, then verify" three times — write it as an SOP.

---

## Training Categories

### Category 1: Task Classification

Teach Jarvis to RECOGNIZE what kind of task it's facing before acting.

| Task type      | Signal                                           | Correct behavior                                                 |
| -------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| Transport      | "move," "migrate," "rename," "reorganize"        | Use jarvis_file_move. Don't read content.                        |
| Research       | "investiga," "busca," "analiza," "qué hay sobre" | Use web_search/exa_search/intel_query. Cite sources.             |
| Data relay     | "muéstrame," "lista," "lee," "qué dice"          | Use jarvis_file_read. Show content AS-IS, don't interpret.       |
| Creation       | "escribe," "crea," "genera," "haz"               | Use file_write/jarvis_file_write. Follow structural constraints. |
| Verification   | "verifica," "confirma," "revisa," "está bien?"   | Call the relevant tool and report ONLY what it returns.          |
| Git operations | "commitea," "pushea," "crea repo"                | Use git_commit/git_push with cwd. NEVER shell_exec for git.      |

**Where to encode:** Tool descriptions (Layer 2). The `jarvis_file_move` description already teaches "transport vs research." Each tool should teach its classification.

### Category 2: Data Fidelity

Teach Jarvis to relay data without interpretation.

**The problem:** When Jarvis has domain knowledge about a topic (astronomy, business, programming), he generates from knowledge instead of reading the source.

**The fix:** Structural constraints (Layer 3), not directives.

- Scripts that READ from data sources at runtime (not hardcoded)
- Tools that return pre-formatted text (not JSON for the LLM to narrativize)
- The anti-substitution directive in tool descriptions: "Cero datos hardcodeados. Usa EXCLUSIVAMENTE los datos de la fuente."

**Where to encode:**

- Tool descriptions for any data-reading tool (gsheets_read, intel_query, jarvis_file_read)
- The prompt enhancer (adds anti-substitution constraint automatically)
- Structural: the `csv_to_viz.py` pattern — generic pipeline, data-agnostic

### Category 3: State Management

Teach Jarvis where things are and where to put new things.

**The problem:** Jarvis loses context between turns. Forgets paths, repos, file locations.

**The fix:**

- INDEX.md (always-read) — maps the file system on every prompt
- `fileSystemSection()` in system prompt — teaches the hierarchy
- Directive #7 — "Tu file system es jarvis_file_write, NO file_write"
- Directive #8 — "Puedes migrar archivos" (read→write→delete or jarvis_file_move)

**Where to encode:**

- Directives (Layer 1) for the core rule
- INDEX.md (always-read) for the map
- Prompt enhancer for adding explicit paths to every request

### Category 4: Action Boundaries

Teach Jarvis what he CAN and CANNOT do.

**The problem:** Jarvis sends unsolicited emails, writes to wrong repos, modifies his own source code.

**The fix:** Structural constraints (Layer 3).

- `file_write` blocks mission-control
- `shell_exec` blocks git commands
- `git_commit` requires cwd
- `gmail_send` description: "NEVER send unless explicitly requested"

**Where to encode:** Tool descriptions (Layer 2) for soft boundaries, code guards (Layer 3) for hard boundaries. Never rely on directives alone for dangerous actions.

### Category 5: Failure Recovery

Teach Jarvis what to do when things go wrong.

**The problem:** When a tool fails or returns unexpected results, Jarvis fabricates success or gives up.

**The fix:**

- First-round tool-skip guard (nudges when LLM skips tools)
- Refusal fallback (uses raw tool result when LLM refuses to format)
- Hallucination guard (detects narrated tool execution without actual calls)
- `gmail_search` description: "If 0 results, say '0 results' — NEVER fabricate responses"

**Where to encode:** Code guards (Layer 3) for detection, tool descriptions (Layer 2) for recovery behavior.

### Category 6: Communication Style

Teach Jarvis how to format and present information.

**The problem:** Jarvis wraps lists in code blocks, adds unsolicited suggestions, uses emoji excessively.

**The fix:** Directive #6 — "Formato de respuesta: texto plano y markdown simple. NUNCA uses bloques de código para listas."

**Where to encode:** Directives (Layer 1) — this applies to every response.

---

## The Training Loop

```
1. User encounters unwanted behavior
2. Diagnose: is it a classification, fidelity, state, boundary, recovery, or style issue?
3. Attempt fix at the appropriate layer:
   - Style/universal → Directive (Layer 1)
   - Task-specific → Tool description (Layer 2)
   - Repeated failure → Structural guard (Layer 3)
   - Domain procedure → Knowledge Base SOP (Layer 4)
4. Test the fix in production
5. If it fails → escalate to the next layer (behavioral → structural)
6. Document in memory for future sessions
```

**The 3-strike rule applies at every layer.** If a directive doesn't work after 3 attempts, escalate to a tool description. If that fails 3 times, build a code guard. If the code guard fails, the problem is architectural — redesign.

---

## What NOT to Do

### Don't train through conversation

"Hey Jarvis, remember to always use jarvis_file_write" → forgotten in 2 messages.

### Don't over-load directives

Every char in enforce files is seen on every prompt. Directives should be <4000 chars total. Put domain-specific rules in SOPs (Layer 4).

### Don't rely on behavioral pleas for dangerous actions

"Please don't send emails without asking" → will be ignored under pressure. Build a code guard instead.

### Don't duplicate training across layers

If a tool description says "NEVER use for X," don't also add a directive saying the same thing. One source of truth per rule.

---

_This document reflects patterns learned from 2000+ production tasks, 10 iterations of hallucination debugging, 5 iterations of git tool hardening, and the COMMIT/NorthStar migration. Every recommendation was earned through failure._
