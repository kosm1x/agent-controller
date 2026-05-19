/**
 * v7.7 Spine 3 Phase 2 — S5 skill_save lifecycle.
 *
 * `skillSave(...)` is the operator-facing entry point for writing a new
 * skill version. Flow:
 *
 *   1. Run critic gate (`runSkillCritic`) on the parsed frontmatter + body.
 *   2. On `verdict='pass'`: write a `skill_versions` row + update the
 *      parent `skills` row's metadata via `pointSkillAtVersion`.
 *   3. On `verdict='fail'`: return `{ok:false, kind:'critic_failed', critique}`
 *      WITHOUT writing. Caller decides whether to revise + retry.
 *   4. Operator override path (`forceOperatorOverride: true`): write the
 *      row anyway with `critic_verdict='fail_returned_anyway'`. The
 *      `created_by` stays under the caller's value (default 'operator'):
 *      the Phase 1 schema CHECK on `skill_versions.created_by` does not
 *      include 'operator-override' (see comment in the override block
 *      below + queue item S5-P2-I1). `'fail_returned_anyway'` is
 *      unreachable except via this override path, so the verdict alone
 *      is the unambiguous marker visible in `mc-ctl skill-health`.
 *   5. Drift on existing (skill_id, version) returns `{ok:false, kind:'drift'}`
 *      — operator must bump version to register new body.
 *
 * Anti-mission compliance: this function GATES authoring; it does not
 * author. The caller provides frontmatter + body; the critic grades; the
 * lifecycle persists.
 *
 * No retry loop here. Spec §8's "3 producer revisions max" refers to a
 * producer agent revising in response to critique. Phase 2's lifecycle
 * just returns the critique to the caller; a Phase 4+ producer-agent
 * helper may wrap this in a retry loop.
 */

import {
  runSkillCritic,
  SkillCriticOptions,
  SkillCriticResult,
} from "./critic.js";
import type { ParsedSkillFile } from "./frontmatter.js";
import {
  CreatedBy,
  CriticVerdictColumn,
  ensureSkillRow,
  pointSkillAtVersion,
  recordVersion,
} from "./storage.js";

export interface SkillSaveOptions {
  /**
   * Who is writing this skill. Drives `skill_versions.created_by`.
   * Default 'operator'. `discovery` is set by `skill-discovery.ts`;
   * `refiner` is set by a future Phase 4 producer agent.
   */
  createdBy?: Exclude<CreatedBy, "boot-scan">;

  /**
   * Operator override: write the version row even if the critic says
   * fail (or errors). The row's `critic_verdict` is stamped
   * 'fail_returned_anyway'; `created_by` stays under the caller's
   * value (default 'operator'). The verdict alone is the unambiguous
   * override marker — see the comment near the override block in
   * `skillSave` for the Phase 1 schema-CHECK reason.
   *
   * Pre-V8.3 perimeter: this is the only override path. Operator-only.
   */
  forceOperatorOverride?: boolean;

  /**
   * Body path in jarvis_files (`skills/<name>/SKILL.md`). Recorded on
   * the parent `skills` row's body_path column on initial insert. Null
   * for in-memory / discovery-extracted submissions that have no file.
   */
  bodyPath?: string | null;

  /** Critic invocation options forwarded to `runSkillCritic`. */
  critic?: SkillCriticOptions;
}

export type SkillSaveResult =
  | {
      ok: true;
      skillId: string;
      versionId: number;
      criticVerdict: CriticVerdictColumn;
      critique: string;
      critic: SkillCriticResult;
    }
  | {
      ok: false;
      kind: "critic_failed" | "critic_error" | "drift" | "unchanged";
      critique: string;
      /** Present on `drift`. The first 8 chars of the existing body sha. */
      existingShaPrefix?: string;
      /**
       * Present on `critic_failed` / `critic_error`. The raw critic
       * result so the caller can inspect cost/latency/error flags.
       */
      critic?: SkillCriticResult;
    };

/**
 * Save a skill version. See module-level comment for full flow.
 */
export async function skillSave(
  parsed: ParsedSkillFile,
  options: SkillSaveOptions = {},
): Promise<SkillSaveResult> {
  const critic = await runSkillCritic(parsed, options.critic ?? {});

  // Infrastructure failures are distinct from content failures. Caller
  // may choose to retry; lifecycle treats them as non-write events.
  if (critic.error) {
    if (!options.forceOperatorOverride) {
      return {
        ok: false,
        kind: "critic_error",
        critique: critic.critique,
        critic,
      };
    }
    // Override on critic_error: still write, but record critic_verdict
    // as 'fail_returned_anyway' (we don't know the verdict; assume worst).
  } else if (critic.verdict === "fail" && !options.forceOperatorOverride) {
    return {
      ok: false,
      kind: "critic_failed",
      critique: critic.critique,
      critic,
    };
  }

  const skillId = ensureSkillRow(parsed.frontmatter, options.bodyPath ?? null);

  // Operator-override marker is carried via critic_verdict, NOT created_by.
  // The Phase 1 schema CHECK constraint on `skill_versions.created_by` lacks
  // an 'operator-override' value, and SQLite can't add it without destructive
  // table re-create (forbidden without operator approval). Since
  // 'fail_returned_anyway' is unreachable except via override, the signal is
  // unambiguous. Tracked as S5-P2-I1 for v8.0 schema-reset cleanup.
  const isOverride =
    options.forceOperatorOverride &&
    (critic.verdict === "fail" || critic.error);
  const createdBy: CreatedBy = options.createdBy ?? "operator";
  const criticVerdict: CriticVerdictColumn = isOverride
    ? "fail_returned_anyway"
    : "pass";
  const criticCritique = critic.critique || null;

  const outcome = recordVersion({
    skillId,
    fm: parsed.frontmatter,
    body: parsed.body,
    createdBy,
    criticVerdict,
    criticCritique,
  });

  if (outcome.kind === "drift") {
    return {
      ok: false,
      kind: "drift",
      critique: `body_sha256 drift on version ${parsed.frontmatter.version}: existing ${outcome.existingSha.slice(0, 8)}…. Bump frontmatter \`version\` to register the new body.`,
      existingShaPrefix: outcome.existingSha.slice(0, 8),
      critic,
    };
  }

  if (outcome.kind === "unchanged") {
    return {
      ok: false,
      kind: "unchanged",
      critique:
        "skill version already registered with identical body; no write performed.",
      critic,
    };
  }

  pointSkillAtVersion(skillId, parsed.frontmatter, outcome.versionId);

  return {
    ok: true,
    skillId,
    versionId: outcome.versionId,
    criticVerdict,
    critique: critic.critique,
    critic,
  };
}

/**
 * Revise an existing skill. Same flow as `skillSave` semantically — the
 * caller produces a new `(frontmatter, body)` pair (typically with a
 * bumped `version`) and we re-run the critic + persist. Provided as a
 * separate named function so call sites are explicit about intent;
 * spec §7 lists `skill_save` and `skill_revise` as distinct surfaces.
 *
 * `createdBy` defaults to 'refiner' for revisions vs 'operator' for saves.
 */
export async function skillRevise(
  parsed: ParsedSkillFile,
  options: SkillSaveOptions = {},
): Promise<SkillSaveResult> {
  return skillSave(parsed, {
    ...options,
    createdBy: options.createdBy ?? "refiner",
  });
}
