/**
 * Runtime skill catalog — v7.6 Spine 5.
 *
 * Surfaces first-party skill scaffolding that already exists in the codebase
 * so the engine has visible payload (it's been a "gate without skills" since
 * v7.4.3.6 L1). Anti-mission for v7.6 forbids authoring new skills — this
 * file only re-exposes catalogs that were already in `src/video/html-skills.ts`
 * and `src/tools/builtin/diagram-svg-prompt.ts`. Both upstreams expose their
 * own `{ surface, label, content }[]` arrays so the catalog never authors
 * surface keys or labels.
 *
 * Two consumers:
 *   1. `availableSkillsSection()` in messaging/prompt-sections.ts — lists
 *      surface + label (NOT full content) in the system prompt, gated to the
 *      tools currently in scope. The full guidance content already travels in
 *      the relevant tool's surface (html-compose lives in the
 *      `video_html_compose` description; svg-diagram lives inside
 *      `svgHtmlSystemPrompt()` at exec time of `diagram_generate`).
 *   2. `mc-ctl skills` — operator-facing inventory.
 *
 * Skills sourced from the DB (`skill_save` / `skill_list` runtime path) are
 * NOT mixed into this registry. They are surfaced separately via the existing
 * `skill_list` tool and the mc-ctl skills subcommand. Keeping the two layers
 * distinct prevents a runtime-mutated skill from masking a first-party catalog.
 */

/**
 * Stable skill record shape. Mirrors the upstream catalog shape plus a
 * `source` provenance tag and a `requiresTool` gate so the system-prompt
 * section can omit skills whose parent tool isn't currently in scope.
 */
export interface FirstPartySkill {
  /** Stable key for runtime discovery and tuning. Must be globally unique. */
  surface: string;
  /** Short human label for prompts and CLI. */
  label: string;
  /** Full guidance text. Mirrors upstream constant; not duplicated here. */
  content: string;
  /** Origin tag for provenance reports. */
  source: "html-compose" | "svg-diagram";
  /** Tool name whose presence in scope means this skill is referenceable. */
  requiresTool: string;
}

import {
  HTML_COMPOSE_SKILLS,
  HTML_COMPOSE_SKILL_GATE,
  HTML_COMPOSE_HOUSE_STYLE,
  HTML_COMPOSE_VISUAL_STYLES,
} from "../video/html-skills.js";
import {
  COCOON_SVG_SKILLS,
  COCOON_PALETTE_DARK,
  COCOON_PALETTE_LIGHT,
  COCOON_LAYOUT_RULES,
} from "../tools/builtin/diagram-svg-prompt.js";

/**
 * Round-2 audit M4: canonical tool names that gate first-party skills. These
 * MUST stay in sync with the `name` field on the corresponding `Tool`
 * definitions in src/tools/builtin/. Importing the tool modules here would
 * pull `child_process`, `playwright`, and other heavy deps into the catalog's
 * import chain — breaking partial-mock tests that share dependencies (see
 * `src/rituals/safeguard-tags.test.ts` which mocks only `execFileSync`).
 *
 * The runtime equivalence is asserted in `catalog.test.ts` via a test that
 * loads the tool modules in test isolation and pins
 * `VIDEO_HTML_COMPOSE_TOOL_NAME === videoHtmlComposeTool.name` so a rename
 * still produces a loud test failure — at the cost of one test boundary
 * instead of a typecheck-time guarantee.
 */
const VIDEO_HTML_COMPOSE_TOOL_NAME = "video_html_compose";
const DIAGRAM_GENERATE_TOOL_NAME = "diagram_generate";

// Re-export the underlying constants so call-sites can verify shape parity
// without importing two modules. Tests exercise this for syntactic coupling.
export {
  HTML_COMPOSE_SKILL_GATE,
  HTML_COMPOSE_HOUSE_STYLE,
  HTML_COMPOSE_VISUAL_STYLES,
  COCOON_PALETTE_DARK,
  COCOON_PALETTE_LIGHT,
  COCOON_LAYOUT_RULES,
};

/**
 * Frozen registry of first-party skills. Both `Object.freeze` calls run so
 * runtime mutation of either the array or its individual entries throws in
 * strict mode — see `catalog.test.ts` for the strict-mode mutation test.
 */
export const FIRST_PARTY_SKILLS: readonly Readonly<FirstPartySkill>[] =
  Object.freeze([
    ...HTML_COMPOSE_SKILLS.map((s) =>
      Object.freeze({
        surface: s.surface,
        label: s.label,
        content: s.content,
        source: "html-compose" as const,
        requiresTool: VIDEO_HTML_COMPOSE_TOOL_NAME,
      }),
    ),
    ...COCOON_SVG_SKILLS.map((s) =>
      Object.freeze({
        surface: s.surface,
        label: s.label,
        content: s.content,
        source: "svg-diagram" as const,
        requiresTool: DIAGRAM_GENERATE_TOOL_NAME,
      }),
    ),
  ]);

/** List all first-party skills. Defensive shallow copy of the array; entries
 *  themselves are frozen so callers cannot mutate their fields either. */
export function listFirstPartySkills(): FirstPartySkill[] {
  return FIRST_PARTY_SKILLS.slice();
}

/**
 * Filter the catalog to skills whose `requiresTool` is in the supplied tool
 * list. Used by `availableSkillsSection` so the prompt never advertises a
 * skill whose parent tool isn't currently scoped — addresses the H1 contract
 * violation against the identity rule "no menciones herramientas que no están
 * en tu lista" (prompt-sections.ts:65-66).
 *
 * Match semantics: exact equality via Set lookup. Substring / prefix matches
 * do NOT count — e.g., a tool list containing `video_html_compose_v2` does
 * NOT match a skill that requires `video_html_compose`. Round-2 audit W3.
 */
export function listSkillsForTools(tools: string[]): FirstPartySkill[] {
  const set = new Set(tools);
  return FIRST_PARTY_SKILLS.filter((s) => set.has(s.requiresTool));
}

/** Look up a skill by its surface key. Returned object is frozen — do not
 *  attempt to mutate. Returns undefined if not found. */
export function findFirstPartySkill(
  surface: string,
): FirstPartySkill | undefined {
  return FIRST_PARTY_SKILLS.find((s) => s.surface === surface);
}

/** Group skills by source tag — used by mc-ctl skills for grouped output. */
export function groupFirstPartySkillsBySource(): Record<
  FirstPartySkill["source"],
  FirstPartySkill[]
> {
  const out: Record<FirstPartySkill["source"], FirstPartySkill[]> = {
    "html-compose": [],
    "svg-diagram": [],
  };
  for (const skill of FIRST_PARTY_SKILLS) out[skill.source].push(skill);
  return out;
}
