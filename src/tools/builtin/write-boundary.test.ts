/**
 * checkWriteBoundary — the shared positional decision, per rule and per
 * operation. Pure: paths need not exist, the KB root is a literal, and no
 * checkout or git is consulted (child_process is mocked to prove it).
 */

import { describe, it, expect, vi, afterEach } from "vitest";

const git = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn(), spawnSync: vi.fn() }));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  ...git,
}));

import {
  checkWriteBoundary,
  getAllowWritePrefixes,
  DAY_LOG_MANAGED,
  RITUAL_WRITABLE_DOCS,
  SELF_IMPROVEMENT_ALLOWED,
  type BoundaryRule,
  type WriteOp,
} from "./write-boundary.js";
import { DAY_LOG_MANAGED as REINDEX_DAY_LOG_MANAGED } from "../../db/jarvis-reindex.js";

const KB = "/tmp/wb-unit-kb";
const MC = "/root/claude/mission-control/";
const WT = "/root/claude/mission-control-jarvis/";
const CT = "/workspace/";
const OPS: WriteOp[] = ["write", "edit", "delete"];

function ruleOf(path: string, op: WriteOp): BoundaryRule | "allowed" {
  const v = checkWriteBoundary(path, op, KB);
  return v.allowed ? "allowed" : v.rule;
}

afterEach(() => {
  // The boundary decides from the path alone: no child process, ever.
  expect(git.execFileSync).not.toHaveBeenCalled();
  expect(git.execSync).not.toHaveBeenCalled();
  expect(git.spawnSync).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("checkWriteBoundary — rules every operation shares", () => {
  const cases: Array<[string, BoundaryRule]> = [
    ["/etc/caddy/Caddyfile", "system-dir"],
    ["/usr/local/bin/x", "system-dir"],
    ["/var/spool/cron/x", "system-dir"],
    ["/root/.claude/settings.json", "operator-home"],
    ["/root/x.sh", "outside-allow-list"],
    ["/opt/supabase/docker-compose.yml", "outside-allow-list"],
    ["/root/claude/.claude/settings.json", "operator-config"],
    ["/root/claude/.mcp.json", "operator-config"],
    ["/root/claude/CLAUDE.md", "operator-config"],
    [`${MC}src/messaging/scope.ts`, "primary-checkout"],
    [`${MC}src/tools/builtin/file.ts`, "immutable"],
    [`${WT}src/tools/builtin/write-guard.ts`, "immutable"],
    [`${WT}src/tools/builtin/write-boundary.ts`, "immutable"],
    [`${WT}src/api/x.ts`, "immutable"],
    [`${WT}src/tools/builtin/git.ts`, "immutable"],
    [`${WT}mc-ctl`, "immutable"],
    [`${WT}.github/workflows/ci.yml`, "immutable"],
    [`${WT}scripts/git-hooks/pre-commit`, "immutable"],
    [`${WT}vitest.config.ts`, "immutable"],
    [`${CT}src/tools/builtin/shell.ts`, "immutable"],
    [`${CT}scripts/deploy.sh`, "immutable"],
    [`${CT}.github/workflows/ci.yml`, "immutable"],
    [`${KB}/directives/core.md`, "standing-orders"],
    [`${KB}/NorthStar/goals/a.md`, "northstar"],
    [`${KB}/projects/acme/project.md`, "project-record"],
    [`${KB}/skills/demo/SKILL.md`, "skill-file"],
    [`${KB}/logs/day-logs/2099-01-01.md`, "day-log"],
  ];
  for (const [path, rule] of cases) {
    for (const op of OPS) {
      it(`${op} ${path} → ${rule}`, () => {
        expect(ruleOf(path, op)).toBe(rule);
      });
    }
  }

  it("allows ordinary project, tmp, workspace and KB paths for every operation", () => {
    for (const op of OPS) {
      for (const p of [
        "/root/claude/vlcrm/src/a.ts",
        "/root/claude/CLAUDE-notes/x.md",
        "/tmp/x/y.txt",
        "/workspace/repo/a.ts",
        `${KB}/notes/a.md`,
      ]) {
        expect(ruleOf(p, op), `${op} ${p}`).toBe("allowed");
      }
    }
  });

  it("reports the allow-list entry that admitted the path", () => {
    expect(checkWriteBoundary("/tmp/x/y.txt", "write", KB)).toEqual({ allowed: true, prefix: "/tmp/" });
    expect(checkWriteBoundary(`${KB}/notes/a.md`, "delete", KB)).toEqual({ allowed: true, prefix: `${KB}/` });
  });

  it("keeps the allow-list order: KB root, /root/claude/, /tmp/, /workspace/", () => {
    expect(getAllowWritePrefixes(KB)).toEqual([`${KB}/`, "/root/claude/", "/tmp/", "/workspace/"]);
  });

  it("checks the deny prefixes before the KB-root allow entry", () => {
    expect(checkWriteBoundary("/var/kb/notes/a.md", "write", "/var/kb")).toMatchObject({
      allowed: false,
      rule: "system-dir",
    });
  });

  it("shares the day-log refusal sentence with jarvis-reindex", () => {
    expect(REINDEX_DAY_LOG_MANAGED).toBe(DAY_LOG_MANAGED);
    const v = checkWriteBoundary(`${KB}/logs/day-logs/2099-01-01.md`, "write", KB);
    expect(v).toEqual({ allowed: false, rule: "day-log", reason: DAY_LOG_MANAGED });
  });
});

describe("checkWriteBoundary — operation-specific semantics", () => {
  const LOG = `${MC}${RITUAL_WRITABLE_DOCS[0]}`;

  it("a ritual-writable doc in the primary checkout accepts a write only", () => {
    expect(ruleOf(LOG, "write")).toBe("allowed");
    expect(ruleOf(`${MC}docs/other.md`, "write")).toBe("primary-checkout");
    expect(ruleOf(LOG, "edit")).toBe("primary-checkout");
    expect(ruleOf(LOG, "delete")).toBe("primary-checkout");
  });

  it("the primary checkout is refused for every operation", () => {
    for (const op of OPS) expect(ruleOf(`${MC}src/tools/x.ts`, op)).toBe("primary-checkout");
  });

  it("day-log: write/edit refuse the registry .md files, delete also the directories above them", () => {
    expect(ruleOf(`${KB}/logs/day-logs/notes.txt`, "write")).toBe("allowed");
    for (const p of [`${KB}/logs`, `${KB}/logs/day-logs`, `${KB}/logs/day-logs/notes.txt`]) {
      expect(ruleOf(p, "delete"), p).toBe("day-log");
    }
    expect(ruleOf(`${KB}/logs/day-narratives/2099-01-01.md`, "delete")).toBe("allowed");
  });

  it("skill file: delete also refuses skills/ and skills/<name>/", () => {
    expect(ruleOf(`${KB}/skills/demo/REFERENCE.md`, "write")).toBe("allowed");
    expect(ruleOf(`${KB}/skills/demo`, "write")).toBe("allowed");
    expect(ruleOf(`${KB}/skills/demo`, "delete")).toBe("skill-file");
    expect(ruleOf(`${KB}/skills`, "delete")).toBe("skill-file");
    expect(ruleOf(`${KB}/skills/demo/REFERENCE.md`, "delete")).toBe("allowed");
  });

  it("immutable: delete also refuses a directory holding a protected file", () => {
    expect(ruleOf(`${WT}src/tools/builtin`, "delete")).toBe("immutable");
    expect(ruleOf(`${WT}src`, "delete")).toBe("immutable");
    expect(ruleOf(WT.slice(0, -1), "delete")).toBe("immutable");
    expect(ruleOf(`${WT}.github`, "delete")).toBe("immutable");
    expect(ruleOf(`${WT}scripts`, "delete")).toBe("immutable");
    expect(ruleOf(`${WT}scripts/git-hooks`, "delete")).toBe("immutable");
    expect(ruleOf(`${WT}src/intel`, "delete")).toBe("allowed");
    expect(ruleOf(`${WT}scripts/other`, "delete")).toBe("allowed");
    expect(ruleOf(`${WT}src/tools/builtin`, "write")).toBe("allowed");
  });
});

describe("checkWriteBoundary — normalizes its own input", () => {
  it("a `..` segment cannot step into the primary checkout unseen", () => {
    for (const op of OPS) {
      expect(ruleOf("/root/claude/vlcrm/../mission-control/src/x.ts", op)).toBe("primary-checkout");
      expect(ruleOf("/tmp/../root/claude/mission-control/src/tools/builtin/file.ts", op)).toBe("immutable");
      expect(ruleOf("/tmp/../etc/x.conf", op)).toBe("system-dir");
    }
  });

  it("doubled slashes are judged like the single-slash path", () => {
    for (const op of OPS) {
      expect(ruleOf("/root/claude//mission-control/src/x.ts", op)).toBe("primary-checkout");
      expect(ruleOf(`${WT}src//tools/builtin/shell.ts`, op)).toBe("immutable");
      expect(ruleOf(`${KB}//logs//day-logs/2099-01-01.md`, op)).toBe("day-log");
    }
  });

  it("a trailing-slash directory is judged like the directory for delete", () => {
    expect(ruleOf(`${WT}src/`, "delete")).toBe("immutable");
    expect(ruleOf(`${WT}.github/`, "delete")).toBe("immutable");
    expect(ruleOf(MC, "delete")).toBe("immutable");
    expect(ruleOf(`${KB}/skills/`, "delete")).toBe("skill-file");
    expect(ruleOf(`${KB}/logs/`, "delete")).toBe("day-log");
    expect(ruleOf(`${KB}/`, "delete")).toBe("kb-root");
  });

  it("refuses the primary checkout root itself without a trailing slash", () => {
    for (const op of ["write", "edit"] as const) {
      expect(ruleOf("/root/claude/mission-control", op)).toBe("primary-checkout");
    }
  });
});

describe("checkWriteBoundary — a KB root spelled with // or ./", () => {
  const NORM = "/tmp/wb-unit/kbmirror";
  for (const spelled of ["/tmp/wb-unit//kbmirror", "/tmp/wb-unit/./kbmirror"]) {
    it(`${spelled} is judged as ${NORM}`, () => {
      expect(checkWriteBoundary(`${NORM}/logs/day-logs/2099-01-01.md`, "write", spelled)).toMatchObject({
        allowed: false,
        rule: "day-log",
      });
      expect(checkWriteBoundary(`${NORM}/logs/day-narratives/2099-01-01.md`, "write", spelled)).toEqual({
        allowed: true,
        prefix: `${NORM}/`,
      });
      expect(checkWriteBoundary(`${NORM}/directives/core.md`, "write", spelled)).toMatchObject({
        allowed: false,
        rule: "standing-orders",
      });
    });
  }
});

describe("checkWriteBoundary — delete of the KB root", () => {
  it("refuses the KB root and every directory above it", () => {
    expect(ruleOf(KB, "delete")).toBe("kb-root");
    expect(ruleOf("/tmp", "delete")).toBe("kb-root");
    expect(ruleOf("/", "delete")).toBe("kb-root");
  });

  it("leaves write/edit of a KB file and delete of a sibling alone", () => {
    expect(ruleOf(`${KB}/notes/a.md`, "write")).toBe("allowed");
    expect(ruleOf(`${KB}/notes`, "delete")).toBe("allowed");
    expect(ruleOf("/tmp/wb-unit-kb-sibling", "delete")).toBe("allowed");
  });
});

describe("checkWriteBoundary — the container worker's clone (/workspace/)", () => {
  it("allows every non-protected path for every operation", () => {
    for (const op of OPS) {
      for (const rel of ["docs/notes.md", "src/tools/x.ts", "scripts/fix.ts"]) {
        expect(ruleOf(`${CT}${rel}`, op), `${op} ${rel}`).toBe("allowed");
      }
    }
  });

  it("refuses a delete of the clone root or a directory holding protected files", () => {
    for (const p of ["/workspace", `${CT}src`, `${CT}.github`, `${CT}scripts`]) {
      expect(ruleOf(p, "delete"), p).toBe("immutable");
    }
  });
});

describe("checkWriteBoundary — Jarvis's worktree", () => {
  it("allows every non-protected worktree path for every operation", () => {
    for (const op of OPS) {
      for (const rel of ["docs/notes.md", "src/tools/x.ts", "src/lib/x.ts", "scripts/fix.ts", "README.md"]) {
        expect(ruleOf(`${WT}${rel}`, op), `${op} ${rel}`).toBe("allowed");
      }
    }
  });

  it("refuses the protected files and prefixes for every operation", () => {
    for (const op of OPS) {
      for (const rel of ["src/tools/builtin/shell.ts", "scripts/deploy.sh", ".github/x.yml"]) {
        expect(ruleOf(`${WT}${rel}`, op), `${op} ${rel}`).toBe("immutable");
      }
    }
  });

  it("the instruction path list is unchanged", () => {
    expect(SELF_IMPROVEMENT_ALLOWED).toEqual([
      "src/tools/",
      "src/intel/",
      "src/messaging/scope.ts",
      "src/messaging/prompt-sections.ts",
      "src/video/",
    ]);
  });
});
