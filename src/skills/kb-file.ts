/**
 * Model-facing KB write path for versioned skills (`skills/<name>/SKILL.md`).
 *
 * The boot loader registers every SKILL.md row it finds with the critic
 * SKIPPED, and only at restart. A model write to that path therefore has to
 * go through `skillSave` (critic gate → skill_versions row → pointer) BEFORE
 * the file lands — that makes the skill usable at once and keeps the next
 * boot scan a no-op (`unchanged`). `jarvis_file_write` calls
 * `registerSkillFile`; every other jarvis_file_* writer refuses the path via
 * `skillFileGuard`, so no draft can be appended, moved or batch-written into
 * place around the critic.
 */

import { getDatabase } from "../db/index.js";
import { canonicalKbPath } from "../tools/builtin/immutable-core.js";
import { currentRunSignal, currentRunTaskId } from "../tools/rule-of-two.js";
import { FrontmatterError, parseSkillFile } from "./frontmatter.js";
import { skillSave } from "./lifecycle.js";
import { SKILL_PATH_RE } from "./loader.js";
import { compareSemver, currentSkillVersion, sha256 } from "./storage.js";
import {
  claimCertificationRun,
  releaseCertificationRun,
  runSkillTests,
  SkillTestsArraySchema,
  type RunSkillTestsResult,
} from "./test-runner.js";

/** Wall-clock cap on the certification test run inside one file write. */
const CERTIFY_DEADLINE_MS = 120_000;
/** Test runs per version before a retry needs a new version. */
const MAX_TEST_RUNS = 3;

export const SKILL_FILE_FORMAT = `---
name: <verb-led-kebab-name, identical to the folder name, e.g. generar-slogan>
description: When the user asks to <X>, <what it does and returns> (max 1024 chars)
version: 1.0.0
output_type: text
trigger_examples:
  - "<user request 1>"
  - "<user request 2>"
  - "<user request 3>"
tools_used:
  - <tool_name>
inputs_json: '[{"name":"brief","type":"string","required":true,"description":"..."}]'
tests_json: '[{"name":"happy_path","input":{"brief":"..."},"expect":{"output_type":"text"}},{"name":"empty_brief","input":{"brief":""},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"brief"}}]'
---

# <Title>

## Steps
1. ...`;

/** Accurate guidance for a skill that has steps but no registered version. */
export function unversionedSkillNote(name: string): string {
  return (
    `"${name}" was saved with skill_save and has no versioned SKILL.md, so skill_run cannot ` +
    "execute it; skill_load returns its saved steps to follow directly. To make it a versioned skill, " +
    "write skills/<verb-led-kebab-name>/SKILL.md (lowercase and hyphens, no underscores) with jarvis_file_write " +
    "(frontmatter: verb-led name, description, version, output_type, trigger_examples ≥3, " +
    "tools_used, inputs_json, tests_json with ≥2 tests; then the steps as the body)."
  );
}

/** True when `p` names a skill definition file, in any spelling. */
export function isSkillFilePath(p: string, kbRoot: string): boolean {
  return /^skills\/[^/]+\/skill\.md$/.test(canonicalKbPath(p, kbRoot));
}

export interface SkillFileRefusal {
  error: "SKILL_FILE_PROTECTED";
  message: string;
  paths: string[];
}

/** Refusal for the jarvis_file_* writers that must not touch SKILL.md. */
export function skillFileGuard(
  paths: ReadonlyArray<unknown>,
  kbRoot: string,
): SkillFileRefusal | null {
  const hits = paths.filter(
    (p): p is string => typeof p === "string" && isSkillFilePath(p, kbRoot),
  );
  if (hits.length === 0) return null;
  return {
    error: "SKILL_FILE_PROTECTED",
    message:
      "skills/<name>/SKILL.md is a registered skill definition. Create or change it ONLY " +
      "with jarvis_file_write (the whole file: frontmatter + body) — that runs the skill " +
      "critic and registers the version so skill_load/skill_run can use it. To change a " +
      "skill, write the full file with a higher `version`. Deleting or moving the file " +
      "does not unregister the skill.",
    paths: hits,
  };
}

export interface SkillFileRegistrationInfo {
  name: string;
  version: string;
  status: "registered" | "unchanged";
  certified: boolean;
  /** Per-test results of the certification run, when one ran. */
  tests?: Array<{ name: string; result: string; detail?: string }>;
  next: string;
}

export type SkillFileRegistration =
  | {
      ok: true;
      skill: SkillFileRegistrationInfo;
      /** Runs the version's tests; call it AFTER the file is written. */
      certify?: () => Promise<SkillFileRegistrationInfo>;
    }
  | { ok: false; error: Record<string, unknown> };

/**
 * Parse + critic-gate + register a SKILL.md before it is written to the KB.
 * `priorContent` is the file currently at `path` (null when absent). Returns
 * `ok:false` with a model-facing error whenever the file must NOT be written.
 */
export async function registerSkillFile(
  path: string,
  content: string,
  priorContent: string | null,
): Promise<SkillFileRegistration> {
  const fail = (error: Record<string, unknown>): SkillFileRegistration => ({
    ok: false,
    error: { ...error, saved: false },
  });

  const match = SKILL_PATH_RE.exec(path);
  if (!match) {
    return fail({
      error: "SKILL_PATH_INVALID",
      message: `Skill files live at exactly skills/<kebab-name>/SKILL.md (folder: lowercase letters, digits, hyphens; file name SKILL.md). Got "${path}".`,
    });
  }

  let parsed;
  try {
    parsed = parseSkillFile(content);
  } catch (err) {
    if (!(err instanceof FrontmatterError)) throw err;
    return fail({
      error: "SKILL_FRONTMATTER_INVALID",
      message: err.message,
      format: SKILL_FILE_FORMAT,
    });
  }

  const { name, version } = parsed.frontmatter;
  if (name !== match[1]) {
    return fail({
      error: "SKILL_NAME_MISMATCH",
      message: `frontmatter name "${name}" must equal the folder name "${match[1]}".`,
    });
  }

  // Versions only move up (DB trigger `skills_version_monotonic`).
  const current = currentSkillVersion(name);
  if (current !== null && compareSemver(version, current) < 0) {
    return fail({
      error: "SKILL_VERSION_NOT_HIGHER",
      message: `version ${version} of "${name}" is lower than its current version ${current}. Versions only go up: write the skill with a version higher than ${current}.`,
    });
  }

  const testCount = (() => {
    try {
      return SkillTestsArraySchema.parse(JSON.parse(parsed.frontmatter.tests_json)).length;
    } catch {
      return 0;
    }
  })();

  const isCertified = () =>
    (
      getDatabase()
        .prepare("SELECT is_certified FROM skills WHERE name = ?")
        .get(name) as { is_certified: number } | undefined
    )?.is_certified === 1;

  const info = (
    status: "registered" | "unchanged",
    tests?: RunSkillTestsResult,
    notCertifiedWhy?: string,
  ): SkillFileRegistrationInfo => {
    const certified = isCertified();
    const usable = `Usable now by name: skill_load("${name}") to read it, skill_run("${name}", {...inputs}) to execute it.`;
    const outcomes = tests?.outcomes ?? [];
    const describe = (o: RunSkillTestsResult["outcomes"][number]) =>
      `${o.testName} (${o.result}${o.diffSummary ? `: ${o.diffSummary}` : ""})`;
    const failed = outcomes.filter((o) => o.result === "fail");
    const unfinished = outcomes.filter((o) => o.result === "error" || o.result === "timeout");
    let next: string;
    if (certified) {
      next = `${usable} Certified (all tests pass), so it is also suggested automatically.`;
    } else if (notCertifiedWhy) {
      next = `${usable} Not certified: ${notCertifiedWhy}`;
    } else if (testCount === 0) {
      next = `${usable} Not certified: tests_json has no valid tests. Add at least 2 tests and write it again with a higher \`version\`.`;
    } else if (failed.length > 0) {
      next =
        `${usable} Not certified: failing tests: ${failed.map(describe).join("; ")}. ` +
        "Fix the skill (or its tests) and write it again with a higher `version`.";
    } else if (tests) {
      next =
        `${usable} Not certified: its tests did not finish` +
        (unfinished.length > 0 ? ` (${unfinished.map(describe).join("; ")})` : "") +
        `. Write the same file again to re-run them (at most ${MAX_TEST_RUNS} runs per version).`;
    } else {
      next = `${usable} Not certified yet: write the same file again to run its tests.`;
    }
    return {
      name,
      version,
      status,
      certified,
      ...(tests
        ? {
            tests: outcomes.map((o) => ({
              name: o.testName,
              result: o.result,
              ...(o.diffSummary ? { detail: o.diffSummary } : {}),
            })),
          }
        : {}),
      next,
    };
  };

  // Why this version may not run its tests again, or null when it may. A
  // version with a failing test needs a new version; one whose runs only
  // errored or timed out retries at most MAX_TEST_RUNS times.
  const retryRefusal = (versionId: number): string | null => {
    const runs = getDatabase()
      .prepare(
        "SELECT COUNT(*) AS n, COALESCE(SUM(result = 'fail'), 0) AS failed FROM skill_test_runs WHERE version_id = ?",
      )
      .get(versionId) as { n: number; failed: number };
    if (runs.failed > 0) {
      return "this version failed its tests. Fix it and write it again with a higher `version`.";
    }
    if (testCount > 0 && runs.n >= MAX_TEST_RUNS * testCount) {
      return `its tests did not finish in ${MAX_TEST_RUNS} runs. Write it again with a higher \`version\`, or ask the operator to certify it.`;
    }
    return null;
  };

  // Certification = the version's own tests all pass (runSkillTests flips
  // is_certified, for the current version only). The caller runs `certify`
  // AFTER the file lands, so the KB file and the registered version agree
  // even if the run is cut short; the deadline, or cancelling the task,
  // ends the wait.
  const withTests = (
    status: "registered" | "unchanged",
    skillId: string,
    versionId: number,
  ): SkillFileRegistration => ({
    ok: true,
    skill: info(status),
    certify: async () => {
      // Re-checked here, with no await before the claim: another write (or
      // the scheduled sweep) may have run or started this version's tests
      // since registration.
      const refusal = retryRefusal(versionId);
      if (refusal) return info(status, undefined, refusal);
      if (!claimCertificationRun(versionId)) {
        return info(status, undefined, "its tests are already running. Check the result with skill_load shortly.");
      }
      try {
        const deadline = AbortSignal.timeout(CERTIFY_DEADLINE_MS);
        const runSignal = currentRunSignal();
        return info(
          status,
          await runSkillTests(skillId, versionId, {
            signal: runSignal ? AbortSignal.any([deadline, runSignal]) : deadline,
            taskId: currentRunTaskId(),
          }),
        );
      } finally {
        releaseCertificationRun(versionId);
      }
    },
  });

  // The body of this version is already registered. Writing different
  // frontmatter under the same version would leave the file and the
  // registered row disagreeing, so only an identical (or missing) file is
  // accepted. An uncertified current version is re-tested when its runs so
  // far only errored or timed out, at most MAX_TEST_RUNS times; a version
  // with a failing test needs a new version.
  const unchanged = (registered?: {
    skillId: string;
    versionId: number;
  }): SkillFileRegistration => {
    if (priorContent !== null && priorContent !== content) {
      return fail({
        error: "SKILL_VERSION_EXISTS",
        message: `version ${version} of "${name}" is already registered with this body. Raise \`version\` to change the skill.`,
      });
    }
    if (registered && !isCertified()) {
      const refusal = retryRefusal(registered.versionId);
      if (refusal) return { ok: true, skill: info("unchanged", undefined, refusal) };
      return withTests("unchanged", registered.skillId, registered.versionId);
    }
    return { ok: true, skill: info("unchanged") };
  };

  // Settle an already-registered version BEFORE the critic: an identical
  // rewrite or a same-version change must not cost (or be failed by) an LLM
  // call. recordVersion keys on (skill, version) and hashes the body only.
  const registered = getDatabase()
    .prepare(
      `SELECT v.id, v.skill_id, v.body_sha256, s.current_version_id FROM skill_versions v
       JOIN skills s ON s.skill_id = v.skill_id
       WHERE s.name = ? AND v.version = ?`,
    )
    .get(name, version) as
    | { id: number; skill_id: string; body_sha256: string; current_version_id: number | null }
    | undefined;
  if (registered) {
    if (registered.current_version_id !== registered.id) {
      return fail({
        error: "SKILL_VERSION_EXISTS",
        message: `version ${version} of "${name}" is already registered but is not its current version${current ? ` (${current})` : ""}. Write the skill with a new version higher than ${version}.`,
      });
    }
    if (registered.body_sha256 !== sha256(parsed.body)) {
      return fail({
        error: "SKILL_VERSION_EXISTS",
        message: `version ${version} of "${name}" is already registered with a different body. Raise \`version\` to change the skill.`,
      });
    }
    return unchanged({ skillId: registered.skill_id, versionId: registered.id });
  }

  const result = await skillSave(parsed, { createdBy: "refiner", bodyPath: path });
  if (result.ok) {
    // pointSkillAtVersion left it uncertified; it certifies only if its tests pass.
    return withTests("registered", result.skillId, result.versionId);
  }

  switch (result.kind) {
    case "unchanged": // a concurrent writer registered it first
      return unchanged();
    case "drift":
      return fail({ error: "SKILL_VERSION_EXISTS", message: result.critique });
    case "version_not_higher": // a concurrent writer raised the version first
      return fail({ error: "SKILL_VERSION_NOT_HIGHER", message: result.critique });
    case "critic_failed":
      return fail({
        error: "SKILL_CRITIC_FAILED",
        critique: result.critique,
        message: "The skill critic rejected this file. Revise it per the critique and write it again.",
      });
    case "critic_error":
      return fail({
        error: "SKILL_CRITIC_UNAVAILABLE",
        message: `The skill critic could not run (${result.critique}). Retry the write later.`,
      });
  }
}
