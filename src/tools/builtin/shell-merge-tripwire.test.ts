/**
 * Merge authority in the shell gate (operator ruling 2026-11-10): merging, approving and changing branch
 * protection are the operator's actions. The rule is a tripwire for plainly written forms; the hosting side
 * holds the barrier. Both directions are pinned: the plain forms are refused, ordinary work is not.
 */

import { describe, it, expect } from "vitest";
import { validateShellCommand } from "./shell.js";

const REASON =
  "merging, approving and changing branch protection are the operator's actions — open or update the pull request and report its link instead";

// Linear-time pins as in shell.test.ts (queue 4ap): minimum of 3 runs of process CPU time, the bound scaled
// by how much slower this box runs a fixed reference scan than the VPS did, never below 1x.
async function minCpuMs<T>(fn: () => T): Promise<{ ms: number; result: T }> {
  let ms = Infinity;
  let result!: T;
  for (let r = 0; r < 3; r++) {
    if (r > 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const c0 = process.cpuUsage();
    result = fn();
    const d = process.cpuUsage(c0);
    ms = Math.min(ms, (d.user + d.system) / 1000);
  }
  return { ms, result };
}
const REF_CPU_MS_VPS = 40;
const REF_TEXT = "ab cd ".repeat(350_000);
function refScanCpuMs(): number {
  let best = Infinity;
  let spaces = 0;
  for (let r = 0; r < 3; r++) {
    const c0 = process.cpuUsage();
    for (let pass = 0; pass < 4; pass++) {
      for (let i = 0; i < REF_TEXT.length; i++) if (REF_TEXT.charCodeAt(i) === 32) spaces++;
    }
    const d = process.cpuUsage(c0);
    best = Math.min(best, (d.user + d.system) / 1000);
  }
  if (spaces !== 3 * 4 * 2 * 350_000) throw new Error(`reference scan counted ${spaces} spaces`);
  return best;
}
const refCpuMs = refScanCpuMs();
const linearBound = (base: number): number => base * Math.max(1, refCpuMs / REF_CPU_MS_VPS);

const REFUSED = [
  "gh pr merge 12",
  "gh pr merge 12 --squash --delete-branch",
  "gh -R owner/repo pr merge 12",
  "cd /x && gh pr merge 12",
  "/usr/bin/gh pr merge 12",
  "env FOO=1 gh pr merge 12",
  "gh pr review 12 --approve",
  "gh pr review --approve 12",
  "gh pr review 12 -a",
  "gh api -X PUT repos/o/r/pulls/12/merge",
  "gh api repos/o/r/merges -f base=main -f head=x",
  "gh api -X DELETE repos/o/r/branches/main/protection",
  "gh api repos/o/r/rulesets",
  "gh api -X PUT repos/o/r/collaborators/someone",
  `gh api graphql -f query='mutation { mergePullRequest(input:{pullRequestId:"x"}) { clientMutationId } }'`,
  "gh api repos/o/r/pulls/12/reviews -f event=APPROVE",
  // the same plain forms in other segments of a command
  "git status; gh pr merge 12",
  "gh pr list\ngh pr merge 12",
  "gh pr checks 12 || gh pr merge 12 --auto",
  "(cd /x && gh pr merge 12)",
  "gh pr merge 12 2>&1 | tail -5",
  "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input:{}) { clientMutationId } }'",
  "gh api repos/o/r/pulls/12/reviews -F event=approve",
  // a shell's -c string is judged as its own command
  "bash -c 'gh pr merge 12'",
  `sh -c "gh pr review 12 --approve"`,
  // a tab, a line continuation and a carriage return separate words like a space
  "gh\tpr\tmerge\t12",
  "gh pr merge \\\n12 --squash",
  "gh api \\\n-X PUT repos/o/r/pulls/12/merge",
  "gh pr review 12 --approve\r\n",
  "gh pr review 12 -a\r\n",
];

const ALLOWED = [
  `gh pr create --title "x" --body "y"`,
  `gh pr create -R o/r --title "merge the pr review notes" --body "pr merge is manual; do not --approve"`,
  "gh pr view 12",
  "gh pr list",
  "gh pr checks 12",
  "gh pr diff 12",
  `gh pr comment 12 --body "ready to merge"`,
  `gh pr review 12 --comment --body "looks fine"`,
  `gh pr review 12 --request-changes --body "x"`,
  "gh pr close 12",
  "gh pr edit 12 --add-label x",
  `gh issue create --title "pr merge question" --body "b"`,
  "gh issue list -R o/r",
  `gh issue comment 5 --body "pr review --approve is not allowed"`,
  "gh api repos/o/r/pulls/12",
  "gh api repos/o/r/pulls/12/files",
  "gh api repos/o/r/pulls/12/comments",
  "gh run list",
  "gh run view 5",
  "gh repo view",
  "gh auth status",
  // in the jarvis worktree: the primary checkout's own git guard is a separate rule
  "cd /root/claude/mission-control-jarvis && git merge feature",
  "git -C /root/claude/mission-control-jarvis merge --no-ff x",
  "git grep -c merge",
  "git log -c",
  "git branch -c a b",
  "git ls-files -c",
  "bash -c 'git status'",
  `grep -r "gh pr merge" docs`,
  `echo "run gh pr merge yourself"`,
  // a refused word in another segment than the gh word is not this rule's concern
  "gh pr review 12 --comment --body x | grep -a approve",
  "gh pr view 12 --json mergeable",
  "gh pr checks 12 && echo merge ready",
  "gh pr review 12 --comment -b ok && gh pr list -a @me",
  "gh api repos/o/r/pulls/12 && gh pr list --search /merge",
  // `pr merge` is two consecutive words
  `gh pr comment 12 --body "merge"`,
  "gh pr list --search merge",
  "gh pr view 12 --json title -q merge",
  // without a `gh` word the rule does not fire
  "grep -rn api docs/protection.md",
  "ls pr merge",
  "cat pr review --approve",
  // whitespace inside a quoted word stays inside that word
  `gh pr comment 12 --body "line one\tpr merge"`,
  `gh pr comment 12 --body "line one\npr merge\npr review --approve"`,
];

describe("merge authority tripwire — merging, approving and protection changes are the operator's (ruling 2026-11-10)", () => {
  it.each(REFUSED)("refuses %j", (command) => {
    const verdict = validateShellCommand(command);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain(REASON);
  });

  it.each(ALLOWED)("allows %j", (command) => {
    expect(validateShellCommand(command)).toEqual({ allowed: true });
  });

  it("the refusal is one plain-text reason with no control characters", () => {
    const { reason } = validateShellCommand("gh pr merge 12");
    expect(reason).toBe(REASON);
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  it("stays linear on long input after a gh word (one forward pass per segment)", async () => {
    for (const [cmd, allowed] of [
      ["gh " + "x ".repeat(40_000), true],
      ["gh " + "x ".repeat(40_000) + "pr merge 12", false],
      [("gh pr gh api ".repeat(8_000)).slice(0, 100_000), true],
      [("gh pr gh api ".repeat(8_000)).slice(0, 100_000) + " repos/o/r/rulesets", false],
    ] as const) {
      expect(Buffer.byteLength(cmd)).toBeLessThanOrEqual(131_072);
      const { ms, result: r } = await minCpuMs(() => validateShellCommand(cmd));
      console.log(`[merge-tripwire linear] len=${cmd.length} ms=${ms.toFixed(1)} allowed=${r.allowed}`);
      expect(r.allowed, `len=${cmd.length}`).toBe(allowed);
      if (!allowed) expect(r.reason).toBe(REASON);
      // The bound of shell.test.ts's linear pins (minCpuMs, linearBound; queue 4ap).
      expect(ms, `len=${cmd.length}`).toBeLessThan(linearBound(1500));
    }
  }, 120_000);

  it("applies whatever repository the command targets", () => {
    for (const repo of ["kosm1x/agent-controller", "someone/else", "o/r"]) {
      expect(validateShellCommand(`gh pr merge 1 -R ${repo}`).allowed).toBe(false);
    }
  });
});
