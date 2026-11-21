/**
 * The Jarvis system-prompt builders: they assemble a chat turn's system
 * prompt from the section functions, by priority tier and under the size
 * budget, as a stable half (byte-identical across turns, so the provider can
 * cache it) and a variable half, plus the variant for an external caller.
 * The section texts live in `./prompt-sections.js`; the callers join the two
 * halves around the cache-break marker.
 *
 * This module must not import the message router: the router imports these
 * builders and re-exports them for its existing callers, so an import back
 * would make the two a cycle.
 */
import {
  recordMemoryInjection,
  recordPromptSectionDropped,
} from "../observability/prometheus.js";
import { SYSTEM_PROMPT_TOKEN_BUDGET } from "../config/constants.js";
import {
  detectToolFlags,
  identitySection,
  fileSystemSection,
  capabilitiesSection,
  orgPersonaSection,
  personalDataSection,
  confirmationSection,
  verificationSection,
  toolFirstSection,
  wordpressSection,
  mechanicalVerificationSection,
  memoryPersistenceSection,
  correctionMemorySection,
  codingSection,
  browserSection,
  researchSection,
  sourceGroundingSection,
  figuresProvenanceSection,
  availableSkillsSection,
  cohortSection,
} from "./prompt-sections.js";
import { listSkillsForTools } from "../skills/catalog.js";
import { getCohort, type CohortMember } from "../cohort/self-defining.js";
import { errMsg } from "../lib/err-msg.js";

// ---------------------------------------------------------------------------
// Jarvis system prompt builder — conditional sections based on scoped tools
// ---------------------------------------------------------------------------

/**
 * Build the Jarvis system prompt with only the sections relevant to the
 * tools actually in scope. Prevents the LLM from attempting to use tools
 * it cannot call (e.g., browser__goto when browser tools aren't scoped).
 *
 * Returns the prompt as a stable half (P1 + P2) and a variable half
 * (P3 + P4). The current date/time is deliberately NOT included here — it
 * goes into the user message via `timeContextLine()` so the SDK's prompt
 * cache hits on the system prompt. See `identitySection` comment for history.
 *
 * v8 S1: Returns `{ stable, variable }` so runners can place the variable
 * portion AFTER stable content (essentials, enforce-KB, always-read-KB) for
 * cache stability. See `CACHE_BREAK_MARKER`.
 *
 * User facts are split by cache lifetime (2026-10-15): `stableProfileBlock`
 * (always-inject profile facts + active projects — byte-stable for days) is
 * the LAST P2 entry, so it rides the cached stable half and is the first P2
 * section the budget loop drops; `userFactsBlock` carries only the
 * message-relevant facts and stays in P4 (variable half).
 */
export function buildJarvisSystemPrompt(
  tools: string[],
  stableProfileBlock: string,
  userFactsBlock: string,
  enrichmentBlock: string,
  personaContent: string | null = null,
  // Operator-private grounding (the self-defining cohort) is emitted ONLY
  // when this is true. Defaults to false so a caller that forgets to pass it
  // fails safe — no private data leaks. See `cohortSection`.
  ownerChannel = false,
  // External caller (jarvis-pull): identity without operator addressing.
  external = false,
): { stable: string; variable: string } {
  const flags = detectToolFlags(tools);

  // CCP6: Priority-ordered sections. Higher priority = kept when over budget.
  // P1 (safety-critical), P2 (core), P3 (conditional), P4 (supplementary)
  const p1: string[] = []; // Never truncated
  const p2: string[] = [];
  const p3: string[] = [];
  const p4: string[] = []; // First to truncate

  // P1: Identity + safety (STABLE)
  p1.push(identitySection({ external }));
  // Per-channel org persona for community-manager email mailboxes. Loaded
  // once at startup from `EMAIL_<ID>_PERSONA_FILE`, so the content is byte-
  // stable across calls on the same channel and prompt-cache friendly. P1
  // because it is authoritative context for the reply — never truncate it
  // in favour of variable-half blocks.
  if (personaContent) p1.push(orgPersonaSection(personaContent));
  p1.push(confirmationSection(flags));
  p1.push(toolFirstSection(flags));
  p1.push(mechanicalVerificationSection());

  // P2: Core knowledge (STABLE — same content per user across tasks)
  // Note: fileSystemSection is gated on hasJarvisFiles but the gate decision is
  // stable per scope-tool composition; it stays in the stable layer. Coding
  // tasks without jarvis file tools won't see this either way.
  // External caller (jarvis-pull): no host paths for the CRM model.
  if (flags.hasJarvisFiles && !external) p2.push(fileSystemSection());
  p2.push(capabilitiesSection(flags));
  // V8.1 Phase A — Conway Pattern 2 grounding. Surface the self-defining
  // cohort (what the operator actually has live) in the stable layer so the
  // model grounds answers in real projects/objectives. getCohort() is one indexed
  // SELECT on a ≤30-row table; the cohort is re-rolled once daily, so the
  // section is byte-stable within a day → prompt-cache friendly. The cohort
  // is operator-PRIVATE — cohortSection() emits it only when ownerChannel.
  let cohortMembers: CohortMember[] = [];
  try {
    cohortMembers = getCohort();
  } catch (err) {
    // Table absent in bootstrap/test paths is expected; once it exists in
    // prod (it does) any throw is an anomaly worth surfacing — not silence.
    console.warn(
      "[prompt] getCohort failed — cohort grounding omitted:",
      errMsg(err),
    );
  }
  const cohortBlock = cohortSection(cohortMembers, ownerChannel);
  if (cohortBlock) p2.push(cohortBlock);
  // personalDataSection instructs the model to call user_fact_set — gate on
  // the tool's availability. Community-manager email scope excludes the tool
  // (the section would otherwise hallucinate calls on stranger-sent data).
  if (flags.hasUserFacts) p2.push(personalDataSection());
  p2.push(correctionMemorySection());
  p2.push(figuresProvenanceSection());
  // User profile + active projects: byte-stable across turns (no message
  // input), so it belongs in the cached half. Last P2 entry = first P2
  // casualty of the budget loop. Never for an external caller.
  if (stableProfileBlock && !external) p2.push(stableProfileBlock);

  // P3: Domain-specific (VARIABLE — varies by tool scope)
  if (flags.hasBrowser) p3.push(verificationSection());
  if (flags.hasWordpress) p3.push(wordpressSection());
  if (tools.includes("memory_store")) p3.push(memoryPersistenceSection());
  if (flags.hasCoding) p3.push(codingSection());
  if (flags.hasBrowser) p3.push(browserSection());
  if (flags.hasResearch) p3.push(researchSection());
  if (flags.hasWebResearch) p3.push(sourceGroundingSection());
  // v7.6 Spine 5 — surface first-party skill catalog. Filtered to skills whose
  // parent tool is in scope so we never advertise a skill the LLM cannot use
  // (see the rule on using only the available tools in `identitySection`).
  // availableSkillsSection returns "" when the filtered list is empty so the
  // section auto-omits cleanly.
  const skillsBlock = availableSkillsSection(listSkillsForTools(tools));
  if (skillsBlock) p3.push(skillsBlock);

  // P4: Supplementary data (VARIABLE — message-relevant user facts, enrichment)
  if (userFactsBlock && !external) p4.push(userFactsBlock);
  if (enrichmentBlock) p4.push(enrichmentBlock);

  // Assemble with budget check across both halves combined
  const budget = SYSTEM_PROMPT_TOKEN_BUDGET * 4; // Convert tokens to chars
  let stable = [...p1, ...p2].join("\n\n");
  let variable = [...p3, ...p4].join("\n\n");
  let combinedLength = stable.length + variable.length;

  // CCP6: Truncate from lowest priority tier first, then next tier up.
  // Drain P4 completely before touching P3, P3 before P2. Never touch P1.
  if (combinedLength > budget) {
    const tiers: { tier: string; arr: string[]; recompute: () => void }[] = [
      {
        tier: "p4",
        arr: p4,
        recompute: () => {
          variable = [...p3, ...p4].join("\n\n");
        },
      },
      {
        tier: "p3",
        arr: p3,
        recompute: () => {
          variable = [...p3, ...p4].join("\n\n");
        },
      },
      {
        tier: "p2",
        arr: p2,
        recompute: () => {
          stable = [...p1, ...p2].join("\n\n");
        },
      },
    ];
    const dropped: string[] = [];
    for (const { tier, arr, recompute } of tiers) {
      while (arr.length > 0 && combinedLength > budget) {
        const section = arr.pop()!;
        dropped.push(
          (section.trim().split("\n")[0] ?? "").slice(0, 48) || "(enrichment)",
        );
        recordPromptSectionDropped(tier);
        recompute();
        combinedLength = stable.length + variable.length;
      }
    }
    // Name the casualties: a bare "truncated" line hid that P4 was dropped on
    // every turn for months (reliability audit R1).
    console.warn(
      `[prompt] System prompt truncated: ${Math.round(combinedLength / 4)} tokens (budget: ${SYSTEM_PROMPT_TOKEN_BUDGET}); dropped ${dropped.length}: ${dropped.join(" | ")}`,
    );
  }
  // Memory tax (5-layer plan P0): only blocks that SURVIVED the budget loop
  // were injected — a dropped enrichment block (36 turns / 30 d live) is
  // counted by mc_prompt_section_dropped_total, not here (qa R2 W-3).
  // Empty blocks pass through (the recorder drops ≤ 0) so the call site is
  // observable in tests; only a block the loop popped is skipped.
  const survived = (block: string) => !block || p4.includes(block);
  // user_facts = profile+projects (P2) + relevant facts (P4) that survived.
  const factsChars =
    (p2.includes(stableProfileBlock) ? stableProfileBlock.length : 0) +
    (survived(userFactsBlock) ? userFactsBlock.length : 0);
  recordMemoryInjection("user_facts", factsChars);
  if (survived(enrichmentBlock)) recordMemoryInjection("enrichment", enrichmentBlock.length);

  console.log(
    `[prompt] System prompt: ${Math.round(combinedLength / 4)} tokens, ${p1.length + p2.length + p3.length + p4.length} sections (stable=${p1.length + p2.length}, variable=${p3.length + p4.length})`,
  );
  return { stable, variable };
}

/**
 * Jarvis persona for an EXTERNAL caller (jarvis-pull): no user facts, no
 * enrichment, no org persona, and never the operator-private cohort.
 */
export function buildExternalJarvisSystemPrompt(tools: string[]): {
  stable: string;
  variable: string;
} {
  return buildJarvisSystemPrompt(tools, "", "", "", null, false, true);
}
