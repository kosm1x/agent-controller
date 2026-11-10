/**
 * scripts/lib/deploy-checks.sh — the deploy's decisions, driven through small
 * bash snippets that source the lib. Every external command the deploy uses
 * (systemctl, journalctl, curl, sqlite3, logger) is a stub that records its
 * call; the build, image, migration validator and snapshot helper are stubbed
 * as functions. A PATH-first directory makes any command that slips past the
 * variables fail loudly instead of reaching the host. Each case runs inside a
 * copy of one throwaway git repo (built once) under the OS temp dir: no test
 * touches the service, the journal, the live database, the system log or the
 * network.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = resolve(HERE, "lib/deploy-checks.sh");
const DEPLOY = resolve(HERE, "deploy.sh");

let template: string;
let root: string;
let repo: string;
let stub: string;
let env: NodeJS.ProcessEnv;

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};

const BASE_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_") && !k.startsWith("DEPLOY_") && !k.startsWith("MC_")),
);

function write(path: string, body: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  if (mode !== undefined) chmodSync(path, mode);
}

/** Writes a stub state file (sequences end in a newline so wc -l counts every entry). */
function state(name: string, body: string): void {
  write(join(stub, name), body.endsWith("\n") ? body : `${body}\n`);
}

const calls = (): string[] =>
  existsSync(join(stub, "calls")) ? readFileSync(join(stub, "calls"), "utf8").trim().split("\n") : [];
const syslog = (): string[] =>
  existsSync(join(stub, "syslog")) ? readFileSync(join(stub, "syslog"), "utf8").trim().split("\n") : [];

// Nth call returns the Nth line of <name>.seq; past the end, the last line repeats.
// Builtins only: the stubs run hundreds of times per file.
const SEQ = `seq_next() {
  local f="$STUB/$1.seq" nf="$STUB/$1.n" n=0 lines
  if [ -f "$nf" ]; then read -r n < "$nf"; fi
  n=$((n + 1)); echo "$n" > "$nf"
  mapfile -t lines < "$f"
  if [ "$n" -gt "\${#lines[@]}" ]; then n=\${#lines[@]}; fi
  printf '%s\\n' "\${lines[n - 1]}"
}
`;

const STUBS: Record<string, string> = {
  systemctl: `#!/bin/bash
. "$STUB/seq.sh"
echo "systemctl $*" >> "$STUB/calls"
if [ "$1" = show ] && [ "$3" = MainPID ]; then seq_next mainpid; fi
if [ "$1" = show ] && [ "$3" = NRestarts ]; then seq_next nrestarts; fi
if [ "$1" = is-active ]; then seq_next active; fi
if [ "$1" = restart ]; then exit "$(cat "$STUB/restart.rc" 2>/dev/null || echo 0)"; fi
exit 0
`,
  journalctl: `#!/bin/bash
echo "journalctl $*" >> "$STUB/calls"
case "$*" in
  *_PID=200*) cat "$STUB/journal-new.txt" ;;
  *_PID=100*) cat "$STUB/journal-old.txt" ;;
  # Without a PID filter the unit's journal holds the old process's lines too.
  *) cat "$STUB/journal-old.txt" "$STUB/journal-new.txt"; echo '{"level":"fatal","msg":"old process shutting down"}' ;;
esac
`,
  curl: `#!/bin/bash
. "$STUB/seq.sh"
echo "curl $*" >> "$STUB/calls"
l=$(seq_next health)
code=\${l%% *}
body=\${l#"$code"}; body=\${body# }
printf '%s\\n%s' "$body" "$code"
`,
  sqlite3: `#!/bin/bash
. "$STUB/seq.sh"
echo "sqlite3 $*" >> "$STUB/calls"
case "$*" in
  *"PRAGMA user_version"*)
    case "$*" in
      *backups/*) cat "$STUB/snap_version" ;;
      *) cat "$STUB/live_version" ;;
    esac ;;
  *"COUNT(*)"*"status='running'"*) seq_next running ;;
  *"COUNT(*)"*) echo 0 ;;
  *task_id*) echo "t-1  nanoclaw  a running task" ;;
esac
`,
  logger: `#!/bin/bash
echo "$*" >> "$STUB/syslog"
`,
};

// Anything reached by bare name instead of through the command variables.
const DENY = ["systemctl", "journalctl", "logger", "curl", "sqlite3", "npm", "npx", "docker"];

// Step functions replaced with recorders; each one's exit code comes from <step>.rc.
// The operator gate is stubbed BEFORE sourcing (the lib calls it at load time):
// tests and CI run outside any operator context. The gate's own verdicts are
// tested in src/lib/operator-gate.test.ts; its use here in "the lib is gated at load".
const PRELUDE = `require_operator_context() { return 0; }
source "$LIB"
deploy_build() { echo step:build >> "$STUB/calls"; return "$(cat "$STUB/build.rc" 2>/dev/null || echo 0)"; }
deploy_build_info() { echo step:build-info >> "$STUB/calls"; return "$(cat "$STUB/build-info.rc" 2>/dev/null || echo 0)"; }
deploy_image_gate() { echo step:image >> "$STUB/calls"; return "$(cat "$STUB/image.rc" 2>/dev/null || echo 0)"; }
deploy_run_migration_validator() { echo step:validator >> "$STUB/calls"; cat "$STUB/validator.out"; return "$(cat "$STUB/validator.rc" 2>/dev/null || echo 0)"; }
deploy_run_snapshot_helper() {
  echo step:snapshot >> "$STUB/calls"
  if [ -f "$STUB/snapshot.writes" ]; then mkdir -p backups; echo db > "backups/mc-$(date +%Y-%m-%d).db"; fi
  return "$(cat "$STUB/snapshot.rc" 2>/dev/null || echo 0)"
}
`;

function drive(body: string, args: string[] = []): { status: number | null; out: string } {
  const r = spawnSync("bash", ["-c", PRELUDE + body, "driver", ...args], { cwd: repo, env, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

const deploy = (...args: string[]) => drive(`deploy_run "$@"`, args);

/** A bash child with no prelude: the gate is whatever the body sets up. */
function child(body: string, args: string[] = []): { status: number | null; out: string } {
  const r = spawnSync("bash", ["-c", body, "child", ...args], { cwd: repo, env, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

// The real gate reads /proc/self/cgroup through `cat`; a shell function of that
// name hands it a chosen cgroup line, so the verdict never depends on the host.
const CGROUP_SHIM = `cat() { if [ "\${1:-}" = /proc/self/cgroup ]; then printf '%s' "$CG"; else command cat "$@"; fi; }`;
const TASK_CGROUP = "0::/system.slice/mission-control.service\n";
const SESSION_CGROUP = "0::/user.slice/user-0.slice/session-29815.scope\n";
const REFUSING_GATE = `require_operator_context() { echo "[operator-gate] not an operator login session or operator unit" >&2; exit 2; }`;

const VALIDATOR_OK = [
  "[db] schema migration v1 applied: legacy probes",
  "[db] schema migration v2 applied: drop baseline_history",
  "[db] schema migration v3 applied: add index",
  '{"mode":"fresh","userVersion":3,"tableCount":1,"tables":{"tasks":["id"]},"indexes":[]}',
].join("\n");

const TOOLS = (n: number) =>
  `{"level":"info","time":"2026-11-10T10:00:00.000Z","pid":1,"hostname":"h","module":"mc","initialized":5,"failed":0,"totalTools":${n},"msg":"tool sources loaded"}`;
const INFO = '{"level":"info","time":"2026-11-10T10:00:01.000Z","pid":1,"hostname":"h","module":"mc","msg":"Mission Control listening"}';

beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), "deploy-checks-fixture-"));
  const t = join(template, "repo");
  const bin = join(template, "stub/bin");
  mkdirSync(t);
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(template, "deny"));
  mkdirSync(join(template, "proc"));
  for (const [name, body] of Object.entries(STUBS)) write(join(bin, name), body, 0o755);
  for (const name of DENY) write(join(template, "deny", name), `#!/bin/bash\necho "DENIED $0 $*" >> "$STUB/calls"\nexit 99\n`, 0o755);
  write(join(template, "stub/seq.sh"), SEQ);
  const g = (...args: string[]) =>
    execFileSync("git", args, { cwd: t, env: { ...BASE_ENV, ...GIT_ENV, GIT_CEILING_DIRECTORIES: template }, encoding: "utf8" });
  g("init", "-q", "-b", "main");
  write(join(t, "src/x.ts"), "export const x = 1;\n");
  write(join(t, "scripts/s.sh"), "echo s\n");
  write(join(t, "docs/EVOLUTION-LOG.md"), "# log\n");
  write(join(t, "package.json"), "{}\n");
  write(
    join(t, "package-lock.json"),
    JSON.stringify({
      packages: {
        "": { name: "x" },
        "node_modules/a": { version: "1.0.0" },
        "node_modules/b": { version: "2.0.0", dev: true },
        "node_modules/plat": { version: "1.0.0", optional: true },
      },
    }),
  );
  write(join(t, ".gitignore"), "node_modules/\ndist/\ndata/\nbackups/\n");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  write(
    join(t, "node_modules/.package-lock.json"),
    JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" }, "node_modules/b": { version: "2.0.0" } } }),
  );
  write(join(t, "data/mc.db"), "");
});

afterAll(() => {
  rmSync(template, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "deploy-checks-"));
  execFileSync("cp", ["-a", `${template}/.`, root]);
  repo = join(root, "repo");
  stub = join(root, "stub");
  const bin = join(stub, "bin");

  env = {
    ...BASE_ENV,
    ...GIT_ENV,
    PATH: `${join(root, "deny")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    LIB,
    STUB: stub,
    SYSTEMCTL: join(bin, "systemctl"),
    JOURNALCTL: join(bin, "journalctl"),
    CURL: join(bin, "curl"),
    SQLITE3: join(bin, "sqlite3"),
    LOGGER: join(bin, "logger"),
    GIT: "git",
    NODE: process.execPath,
    PROC_ROOT: join(root, "proc"),
    DEPLOY_POLL_SECS: "0.02",
    // Every wait polls at least once, so 0 is a single poll; the cases that
    // need a longer wait set it themselves.
    DEPLOY_STABLE_SECS: "0",
    DEPLOY_HEALTH_WAIT_SECS: "0",
    MC_DEPLOY_TIMEOUT_SECS: "0",
    GIT_CEILING_DIRECTORIES: root,
  };

  // A healthy deploy: old pid 100 (no /proc entry = gone), new pid 200 that stays.
  state("mainpid.seq", "100\n200");
  state("nrestarts.seq", "0");
  state("active.seq", "active");
  state("health.seq", '200 {"status":"healthy","messaging":{"telegram":true}}');
  state("running.seq", "0");
  state("live_version", "3");
  state("snap_version", "3");
  state("validator.out", VALIDATOR_OK);
  state("journal-old.txt", TOOLS(150));
  state("journal-new.txt", [TOOLS(150), INFO].join("\n"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The ordered step markers a run left in the call log. */
function order(): string[] {
  return calls().flatMap((c) => {
    if (c.startsWith("step:")) return [c.slice(5)];
    if (/^sqlite3 .*COUNT\(\*\).*status='running'/.test(c)) return ["task-guard"];
    if (c === "systemctl restart mission-control") return ["restart"];
    return [];
  });
}

describe("deploy_run carries the operator gate", () => {
  it("a refusing gate stops deploy_run before any other step", () => {
    const r = drive('require_operator_context() { echo "refused: not an operator context" >&2; return 1; }; deploy_run');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("operator gate unavailable or refused; nothing ran");
    expect(calls()).toEqual([]);
    expect(syslog()).toEqual([]);
  });

  it("refuses when the gate function is not defined", () => {
    const r = drive("unset -f require_operator_context; deploy_run --force");
    expect(r.status).not.toBe(0);
    expect(calls()).toEqual([]);
    expect(syslog()).toEqual([]);
  });


  it("the first command of deploy_run is the gate call", () => {
    const lib = readFileSync(LIB, "utf8").split("\n");
    const at = lib.indexOf("deploy_run() {");
    expect(at).toBeGreaterThan(-1);
    const first = lib.slice(at + 1).find((l) => l.trim() && !l.trim().startsWith("#"));
    expect(first?.trim()).toBe("declare -F require_operator_context >/dev/null && require_operator_context \\");
  });
});

describe("the lib is gated at load: no step function exists outside an operator context", () => {
  const FNS = ["deploy_build", "deploy_restart", "deploy_take_snapshot", "deploy_run"];

  it("a refusing gate (exit 2, as the real one) ends the sourcing shell before anything is defined", () => {
    const r = child(`${REFUSING_GATE}\nsource "$LIB"\necho REACHED-AFTER-SOURCE\ndeclare -F ${FNS.join(" ")}`);
    expect(r.status).toBe(2);
    expect(r.out).not.toContain("REACHED-AFTER-SOURCE");
    for (const f of FNS) expect(r.out).not.toContain(f);
  });

  it("a gate that returns non-zero instead of exiting still stops the load", () => {
    const r = child(`require_operator_context() { return 1; }\nsource "$LIB"; echo "source rc=$?"\ndeclare -F ${FNS.join(" ")}; echo "declared rc=$?"`);
    expect(r.out).toContain("source rc=2");
    expect(r.out).toContain("declared rc=1");
    for (const f of FNS) expect(r.out).not.toContain(f);
  });

  it("through the real gate file: a task (service) cgroup is refused and nothing is defined", () => {
    env.CG = TASK_CGROUP;
    const r = child(`${CGROUP_SHIM}\ndeclare -F require_operator_context && echo PREDEFINED\nsource "$LIB"\necho REACHED-AFTER-SOURCE\ndeclare -F ${FNS.join(" ")}`);
    expect(r.status).toBe(2);
    expect(r.out).not.toContain("PREDEFINED");
    expect(r.out).toContain("[operator-gate] running inside mission-control.service (a task)");
    expect(r.out).not.toContain("REACHED-AFTER-SOURCE");
    for (const f of FNS) expect(r.out).not.toContain(f);
  });

  it("through the real gate file: an operator login-session cgroup loads every function", () => {
    env.CG = SESSION_CGROUP;
    const r = child(`${CGROUP_SHIM}\nsource "$LIB"\necho REACHED-AFTER-SOURCE\ndeclare -F ${FNS.join(" ")}`);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("REACHED-AFTER-SOURCE");
    expect(r.out.trim().split("\n").slice(1)).toEqual(FNS);
  });

  it("the gate block is the first code in the file, above every default and function", () => {
    const lines = readFileSync(LIB, "utf8").split("\n");
    const code = lines.map((l, i) => [l.trim(), i] as const).filter(([l]) => l && !l.startsWith("#"));
    expect(code.slice(0, 4).map(([l]) => l)).toEqual([
      "if ! declare -F require_operator_context >/dev/null; then",
      'source "$(dirname "${BASH_SOURCE[0]}")/operator-gate.sh"',
      "fi",
      "require_operator_context || return 2 2>/dev/null || exit 2",
    ]);
    const gateAt = code[3][1];
    const firstFn = lines.findIndex((l) => /^deploy_[a-z_]*\(\)/.test(l));
    const firstDefault = lines.findIndex((l) => l.startsWith(': "${'));
    expect(firstFn).toBeGreaterThan(gateAt);
    expect(firstDefault).toBeGreaterThan(gateAt);
  });

  it.each([
    "deploy_build",
    "deploy_build_info",
    "deploy_image_gate",
    "deploy_run_snapshot_helper",
    "deploy_take_snapshot",
    "deploy_snapshot_decision",
    "deploy_restart",
  ])("%s is unreachable without the gate", (fn) => {
    const r = child(`${REFUSING_GATE}\nsource "$LIB"\necho REACHED-AFTER-SOURCE\n${fn} 3\necho "called ${fn} rc=$?" >> "$STUB/calls"`);
    expect(r.status).toBe(2);
    expect(r.out).not.toContain("REACHED-AFTER-SOURCE");
    expect(calls()).toEqual([]);
    expect(syslog()).toEqual([]);
  });
});

describe("deploy_run order: every refusal before the build", () => {
  it("a clean, healthy deploy runs guard → validator → build → build-info → image → guard → restart, verdict OK", () => {
    const r = deploy();
    expect(r.out).toContain("[deploy] OK");
    expect(r.status).toBe(0);
    expect(order()).toEqual(["task-guard", "validator", "build", "build-info", "image", "task-guard", "restart"]);
    expect(calls().filter((c) => c.startsWith("DENIED"))).toEqual([]);
  });

  it("BLOCKED by running tasks never invokes the build, the image or the restart", () => {
    state("running.seq", "2");
    const r = deploy();
    expect(r.status).toBe(1);
    expect(r.out).toContain("BLOCKED — 2 task(s) currently running");
    expect(r.out).toContain("Nothing was built");
    expect(order()).toEqual(["task-guard"]);
    expect(calls()).not.toContain("step:build");
    expect(calls().some((c) => c.startsWith("systemctl restart"))).toBe(false);
  });

  it("--force proceeds past running tasks with a warning", () => {
    state("running.seq", "2");
    const r = deploy("--force");
    expect(r.status).toBe(0);
    expect(r.out).toContain("--force given — restart will kill them");
    expect(order()).toContain("restart");
  });

  it("--drain waits for running tasks to finish, then proceeds", () => {
    state("running.seq", "2\n1\n0");
    const r = deploy("--drain", "5");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("2 task(s) running — draining for up to 5s");
    expect(order()).toContain("restart");
  });

  it("--drain that times out is BLOCKED before the build", () => {
    state("running.seq", "2");
    const r = deploy("--drain", "1");
    expect(r.status).toBe(1);
    expect(r.out).toContain("BLOCKED — 2 task(s) currently running");
    expect(calls()).not.toContain("step:build");
    expect(order().filter((s) => s === "task-guard").length).toBeGreaterThan(1);
  });

  it("--drain with --force proceeds after the timeout", () => {
    state("running.seq", "2");
    const r = deploy("--drain", "1", "--force");
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain("--force given — restart will kill them");
    expect(order()).toContain("restart");
  });

  it("the guard runs again before the restart and says the new build is already on disk", () => {
    state("running.seq", "0\n1");
    const r = deploy();
    expect(r.status).toBe(1);
    expect(order()).toEqual(["task-guard", "validator", "build", "build-info", "image", "task-guard"]);
    expect(r.out).toContain("NEW BUILD IS ALREADY ON DISK");
    expect(r.out).toContain("re-run the deploy to the end");
    expect(syslog().at(-1)).toMatch(/verdict=BLOCKED step=task-guard-pre-restart$/);
  });

  it("a migration-gate refusal comes before the build", () => {
    state("validator.rc", "1");
    const r = deploy();
    expect(r.status).toBe(1);
    expect(order()).toEqual(["task-guard", "validator"]);
  });

  it("a build failure says dist/ may be half-written and never restarts", () => {
    state("build.rc", "2");
    const r = deploy();
    expect(r.status).toBe(1);
    expect(r.out).toContain("re-run the deploy to the end");
    expect(order()).toEqual(["task-guard", "validator", "build"]);
  });
});

describe("dirty tree (ruling 5)", () => {
  it("refuses a modified code file and names it; nothing runs after", () => {
    write(join(repo, "src/x.ts"), "export const x = 2;\n");
    const r = deploy();
    expect(r.status).toBe(1);
    expect(r.out).toContain("REFUSED — 1 code file(s) differ");
    expect(r.out).toContain("[deploy]     src/x.ts");
    expect(r.out).toContain("--allow-dirty");
    expect(order()).toEqual([]);
    expect(syslog()).toHaveLength(1);
    expect(syslog()[0]).toMatch(/dirty=yes allow_dirty=no .*verdict=REFUSED step=dirty-tree$/);
  });

  it("refuses an untracked file under src/ too", () => {
    write(join(repo, "src/new.ts"), "export {};\n");
    const r = drive("deploy_check_dirty");
    expect(r.status).toBe(1);
    expect(r.out).toContain("src/new.ts");
  });

  it("lists the first 10 files and counts the rest", () => {
    for (let i = 0; i < 12; i++) write(join(repo, `src/n${String(i).padStart(2, "0")}.ts`), "export {};\n");
    const r = drive("deploy_check_dirty");
    expect(r.status).toBe(1);
    expect(r.out).toContain("REFUSED — 12 code file(s)");
    expect(r.out.match(/\[deploy\] {5}src\//g)).toHaveLength(10);
    expect(r.out).toContain("… and 2 more");
  });

  it("a documentation-only change does not block", () => {
    write(join(repo, "docs/EVOLUTION-LOG.md"), "# log\n- new entry\n");
    const r = deploy();
    expect(r.status).toBe(0);
    expect(syslog()[0]).toMatch(/dirty=no /);
  });

  it("--allow-dirty deploys and records dirty=yes allow_dirty=yes in provenance", () => {
    write(join(repo, "src/x.ts"), "export const x = 2;\n");
    const r = deploy("--allow-dirty");
    expect(r.status).toBe(0);
    expect(r.out).toContain("--allow-dirty given, deploying them");
    expect(syslog()[0]).toMatch(/dirty=yes allow_dirty=yes .*verdict=OK/);
  });

  it("build-info.sh and the deploy read one path list (no forked copy)", () => {
    const buildInfo = readFileSync(resolve(HERE, "build-info.sh"), "utf8");
    const lib = readFileSync(LIB, "utf8");
    for (const text of [buildInfo, lib]) {
      expect(text).toMatch(/source "(\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)|\$_DEPLOY_LIB_DIR)\/(lib\/)?code-paths\.sh"/);
      expect(text).not.toContain("--porcelain");
    }
  });
});

describe("host dependencies (R6)", () => {
  it("matching install record passes (missing optional packages are fine)", () => {
    const r = drive("deploy_check_host_deps");
    expect(r.status).toBe(0);
    expect(r.out).toContain("matches package-lock.json");
  });

  it("a version mismatch is refused with numbered operator steps, none chaining the stop with the deploy", () => {
    write(
      join(repo, "node_modules/.package-lock.json"),
      JSON.stringify({ packages: { "node_modules/a": { version: "1.0.1" }, "node_modules/b": { version: "2.0.0" } } }),
    );
    const r = deploy();
    expect(r.status).toBe(1);
    expect(r.out).toContain("a installed 1.0.1, lockfile 1.0.0");
    expect(r.out).toContain("step 2 needs the service STOPPED");
    const steps = ["1. systemctl stop mission-control", "&& npm ci", "3. systemctl start mission-control", "4. ./scripts/deploy.sh"];
    let at = -1;
    for (const step of steps) {
      const next = r.out.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    for (const line of r.out.split("\n")) {
      const n = ["systemctl stop", "npm ci", "systemctl start", "deploy.sh"].filter((w) => line.includes(w)).length;
      expect(n, line).toBeLessThanOrEqual(1);
    }
    expect(order()).toEqual([]);
    expect(syslog()[0]).toMatch(/verdict=REFUSED step=host-deps$/);
  });

  it("a missing package, an extraneous one and a missing install record are refused", () => {
    write(join(repo, "node_modules/.package-lock.json"), JSON.stringify({ packages: { "node_modules/a": { version: "1.0.0" }, "node_modules/z": { version: "9.0.0" } } }));
    let r = drive("deploy_check_host_deps");
    expect(r.status).toBe(1);
    expect(r.out).toContain("missing b@2.0.0");
    expect(r.out).toContain("not in lockfile z");
    rmSync(join(repo, "node_modules/.package-lock.json"));
    r = drive("deploy_check_host_deps");
    expect(r.status).toBe(1);
    expect(r.out).toContain("no install record");
  });
});

describe("migration preflight", () => {
  it("derives the head version from the applied migrations and the JSON signature", () => {
    const r = drive('deploy_migration_preflight && echo "expected=$DEPLOY_EXPECTED_VERSION"');
    expect(r.status).toBe(0);
    expect(r.out).toContain("applied v1..v3 in order, user_version=3");
    expect(r.out).toContain("expected=3");
  });

  it("refuses a gap in the applied versions, a user_version below the head, and a baseline_history table", () => {
    const cases = [
      VALIDATOR_OK.replace("v2 applied", "v4 applied"),
      VALIDATOR_OK.replace('"userVersion":3', '"userVersion":2'),
      VALIDATOR_OK.replace('"tables":{', '"tables":{"baseline_history":["id"],'),
      "[db] schema migration v1 applied: x", // no JSON line
    ];
    for (const out of cases) {
      state("validator.out", out);
      const r = drive("deploy_migration_preflight");
      expect(r.status, out).toBe(1);
      expect(r.out).toContain("REFUSED — fresh-boot schema signature unexpected");
    }
  });

  it("MC_SKIP_MIGRATION_GATE=1 skips the validator and leaves the head unknown", () => {
    env.MC_SKIP_MIGRATION_GATE = "1";
    const r = drive('deploy_migration_preflight && echo "expected=[$DEPLOY_EXPECTED_VERSION]"');
    expect(r.status).toBe(0);
    expect(r.out).toContain("expected=[]");
    expect(calls()).not.toContain("step:validator");
  });
});

describe("snapshot before a migrating deploy (ruling 6)", () => {
  it("no snapshot when the live version equals the head", () => {
    const r = drive("DEPLOY_EXPECTED_VERSION=3; deploy_snapshot_decision");
    expect(r.status).toBe(0);
    expect(r.out).toContain("no migration will run, no snapshot taken");
    expect(calls()).not.toContain("step:snapshot");
    expect(calls().some((c) => c.startsWith("sqlite3 -readonly data/mc.db PRAGMA user_version"))).toBe(true);
  });

  it("live below the head: runs the helper, proves the file and keeps it outside the helper's rotation", () => {
    state("live_version", "2");
    state("snap_version", "2");
    write(join(stub, "snapshot.writes"), "");
    const r = drive("DEPLOY_COMMIT=abc1234; DEPLOY_EXPECTED_VERSION=3; deploy_snapshot_decision");
    expect(r.status).toBe(0);
    expect(calls()).toContain("step:snapshot");
    const m = r.out.match(/Snapshot taken before the build \(the migration runs at the restart\): (backups\/pre-migrate-v2-abc1234-\d+\.db) \(schema v2\)/);
    expect(m, r.out).not.toBeNull();
    expect(r.out).toContain("it replaces today's date-named mc-*.db and is kept until removed by hand");
    // The kept name is outside backup-db.sh's mc-*.db rotation and same-day overwrite.
    expect(m![1]).not.toMatch(/(^|\/)mc-[^/]*\.db$/);
    expect(readFileSync(join(repo, m![1]), "utf8")).toBe("db\n");
    expect(existsSync(join(repo, `backups/mc-${new Date().toISOString().slice(0, 10)}.db`))).toBe(false);
  });

  it("the helper's rotation pattern is mc-*.db (the kept snapshot's name must stay outside it)", () => {
    const helper = readFileSync(resolve(HERE, "backup-db.sh"), "utf8");
    expect(helper).toMatch(/mc-\*\.db/);
    expect("pre-migrate-v2-abc1234-1.db").not.toMatch(/^mc-.*\.db$/);
  });

  it("a migrating full deploy names the commit in the kept snapshot and still ends OK", () => {
    state("live_version", "2");
    state("snap_version", "2");
    write(join(stub, "snapshot.writes"), "");
    const r = deploy();
    expect(r.status, r.out).toBe(0);
    expect(order()).toEqual(["task-guard", "validator", "snapshot", "build", "build-info", "image", "task-guard", "restart"]);
    expect(r.out).toMatch(/backups\/pre-migrate-v2-[0-9a-f]{7,}-\d+\.db/);
  });

  it("live AHEAD of the new code's head warns with both numbers and takes no snapshot", () => {
    state("live_version", "4");
    const r = drive("DEPLOY_EXPECTED_VERSION=3; deploy_snapshot_decision");
    expect(r.status).toBe(0);
    expect(r.out).toContain("WARNING — live schema v4 is AHEAD of the new code's head v3");
    expect(calls()).not.toContain("step:snapshot");
  });

  it("refuses when the helper fails, writes nothing, or writes a copy at another version", () => {
    state("live_version", "2");
    state("snapshot.rc", "1");
    let r = drive("DEPLOY_EXPECTED_VERSION=3; deploy_snapshot_decision");
    expect(r.status).toBe(1);
    expect(r.out).toContain("the snapshot helper failed");

    state("snapshot.rc", "0"); // exit 0 with no file: the helper's status alone is not trusted
    r = drive("DEPLOY_EXPECTED_VERSION=3; deploy_snapshot_decision");
    expect(r.status).toBe(1);
    expect(r.out).toContain("no fresh snapshot");

    write(join(stub, "snapshot.writes"), "");
    state("snap_version", "1");
    r = drive("DEPLOY_EXPECTED_VERSION=3; deploy_snapshot_decision");
    expect(r.status).toBe(1);
    expect(r.out).toContain("reports schema v1, live is v2");
  });

  it("a snapshot refusal in a full run stops before the build", () => {
    state("live_version", "2");
    state("snapshot.rc", "1");
    const r = deploy();
    expect(r.status).toBe(1);
    expect(order()).toEqual(["task-guard", "validator", "snapshot"]);
    expect(syslog()[0]).toMatch(/verdict=REFUSED step=snapshot$/);
  });

  it("an unknown head (gate skipped) takes the snapshot", () => {
    write(join(stub, "snapshot.writes"), "");
    const r = drive("DEPLOY_EXPECTED_VERSION=; deploy_snapshot_decision");
    expect(r.status).toBe(0);
    expect(calls()).toContain("step:snapshot");
  });

  it("an unreadable live version is refused", () => {
    state("live_version", "Error: database is locked");
    const r = drive("DEPLOY_EXPECTED_VERSION=3; deploy_snapshot_decision");
    expect(r.status).toBe(1);
    expect(r.out).toContain("could not read the live schema version");
  });
});

describe("post-restart check (R3)", () => {
  // Called directly with the state deploy_capture_baseline + deploy_wait_old_exit leave.
  const post = (extra = "") =>
    drive(`DEPLOY_OLD_PID=100; DEPLOY_NEW_PID=200; DEPLOY_NRESTARTS_PRE=0; DEPLOY_PREV_TOOLS=150
DEPLOY_PREV_CHANNELS="telegram=true"; DEPLOY_SINCE="2026-11-10 10:00:00"; ${extra}
deploy_post_restart_check; echo "rc=$?"`);

  it("stable PID, health 200 with the channel connected, same tools, no errors: rc 0", () => {
    state("mainpid.seq", "200");
    const r = post();
    expect(r.out).toContain("rc=0");
    expect(r.out).toContain("Stable — MainPID 200 active");
    expect(r.out).toContain("Health 200; channels: telegram=true");
    expect(calls()).toContain("journalctl _SYSTEMD_UNIT=mission-control.service _PID=200 --since 2026-11-10 10:00:00 -o cat --no-pager");
  });

  it("the tool count and the error counts read only the new process's lines", () => {
    state("mainpid.seq", "200");
    const oldErr = '{"level":"error","msg":"old process error"}';
    state("journal-old.txt", [TOOLS(150), oldErr, oldErr].join("\n"));
    const r = post();
    expect(r.out, r.out).toContain("rc=0");
    expect(r.out).toContain("No fatal or error-level lines since the restart");
    const reads = calls().filter((c) => c.startsWith("journalctl") && c.includes("--since"));
    expect(reads).toHaveLength(2);
    for (const c of reads) expect(c).toContain("_SYSTEMD_UNIT=mission-control.service _PID=200 ");
  });

  it("a PID change inside the window is a restart loop", () => {
    state("mainpid.seq", "300");
    const r = post();
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("FAILED — restart loop: MainPID 200 → 300");
  });

  it("the unit leaving active inside the window is a restart loop", () => {
    state("mainpid.seq", "200");
    state("active.seq", "activating");
    const r = post();
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("unit activating");
  });

  it("a window of 0 still polls once", () => {
    state("mainpid.seq", "300");
    let r = post("DEPLOY_STABLE_SECS=0");
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("MainPID 200 → 300");

    rmSync(join(stub, "mainpid.n"));
    rmSync(join(stub, "calls"));
    state("mainpid.seq", "200");
    r = post("DEPLOY_STABLE_SECS=0");
    expect(r.out).toContain("rc=0");
    expect(calls().filter((c) => c === "systemctl is-active mission-control")).toHaveLength(1);
  });

  it("the window keeps polling for its whole length", () => {
    state("mainpid.seq", "200");
    const r = post("DEPLOY_STABLE_SECS=2");
    expect(r.out).toContain("rc=0");
    // SECONDS ticks on wall-clock boundaries: a 2 s window lasts at least 1 s, so more than one poll.
    expect(calls().filter((c) => c === "systemctl is-active mission-control").length).toBeGreaterThanOrEqual(2);
  });

  it("NRestarts rising between the window's start and end is a restart loop", () => {
    state("mainpid.seq", "200");
    state("nrestarts.seq", "0\n1");
    const r = post();
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("NRestarts rose 0 → 1 during the window");
  });

  it("NRestarts above 0 at the window's start after 0 before the restart is a restart loop", () => {
    state("mainpid.seq", "200");
    state("nrestarts.seq", "1");
    const r = post();
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("NRestarts 0 before the restart, 1 at the window's start");
  });

  it("NRestarts steady through the window is not compared with a non-zero pre-restart value", () => {
    state("mainpid.seq", "200");
    for (const seq of ["0", "3"]) {
      rmSync(join(stub, "mainpid.n"), { force: true });
      rmSync(join(stub, "nrestarts.n"), { force: true });
      state("nrestarts.seq", seq);
      const r = post("DEPLOY_NRESTARTS_PRE=2");
      expect(r.out, seq).toContain("rc=0");
    }
  });

  it("health that never answers 200 fails", () => {
    state("mainpid.seq", "200");
    state("health.seq", "503 {}");
    const r = post();
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("loopback health answered 503");
  });

  it("health recovering within the wait passes", () => {
    state("mainpid.seq", "200");
    state("health.seq", '000\n200 {"messaging":{"telegram":true}}');
    // 2 s on a SECONDS clock is at least 1 s: the second read always happens.
    const r = post("DEPLOY_HEALTH_WAIT_SECS=2");
    expect(r.out).toContain("rc=0");
  });

  it("a channel connected before the restart and not after fails, by name", () => {
    state("mainpid.seq", "200");
    state("health.seq", '200 {"messaging":{"telegram":false,"whatsapp":true}}');
    const r = post();
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("FAILED — channel telegram was connected before the restart and is not now");
  });

  it("a channel missing from the map after the restart fails", () => {
    state("mainpid.seq", "200");
    state("health.seq", '200 {"messaging":{"whatsapp":true}}');
    const r = post('DEPLOY_PREV_CHANNELS="telegram=true\nwhatsapp=true"');
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("channel telegram was connected");
  });

  it("with no baseline, at least one connected channel is required", () => {
    state("mainpid.seq", "200");
    state("health.seq", '200 {"messaging":{}}');
    const r = post('DEPLOY_PREV_CHANNELS=""');
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("no messaging channel connected");
  });

  it("a lower tool count than the previous boot warns with both numbers (rc 3, not a failure)", () => {
    state("mainpid.seq", "200");
    state("journal-new.txt", [TOOLS(140), INFO].join("\n"));
    const r = post();
    expect(r.out).toContain("rc=3");
    expect(r.out).toContain("WARNING — tool count dropped: 150 before, 140 now");
  });

  it("error-level lines warn with a count; fatal and uncaught lines fail", () => {
    state("mainpid.seq", "200");
    const err = '{"level":"error","time":"t","module":"mc","msg":"unhandled rejection"}';
    state("journal-new.txt", [TOOLS(150), err, err].join("\n"));
    let r = post();
    expect(r.out).toContain("rc=3");
    expect(r.out).toContain("WARNING — 2 error-level line(s)");

    rmSync(join(stub, "mainpid.n"));
    state("journal-new.txt", [TOOLS(150), '{"level":"fatal","time":"t","module":"mc","msg":"cannot open the database — shutting down"}'].join("\n"));
    r = post();
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("FAILED — 1 fatal/uncaught line(s)");
  });

  it("journal lines are never printed, only counted", () => {
    state("mainpid.seq", "200");
    const marker = "PRIVATE-MESSAGE-TEXT-7f3a";
    state(
      "journal-new.txt",
      [TOOLS(150), `{"level":"error","msg":"${marker}"}`, `{"level":"fatal","msg":"${marker}"}`, `SyntaxError: ${marker}`].join("\n"),
    );
    state("journal-old.txt", `${TOOLS(150)}\n{"level":"error","msg":"${marker}"}`);
    const r = post();
    expect(r.out).toContain("rc=1");
    expect(r.out).not.toContain(marker);
  });

  it("failures print the clean-checkout guidance, never a checkout over the tree", () => {
    state("mainpid.seq", "200");
    state("health.seq", "503 {}");
    const r = post();
    expect(r.out).toContain("re-deploy the previous commit from a clean checkout");
    expect(r.out).not.toMatch(/git checkout/);
  });
});

describe("deploy_count_log_levels (the logger writes level labels)", () => {
  it("counts the logger's real error and fatal lines plus uncaught and Node crash shapes", () => {
    const lines = [
      '{"level":"error","time":"2026-11-10T10:00:00.000Z","pid":1,"hostname":"h","module":"mc","msg":"unhandled rejection"}',
      '{"level":"fatal","time":"2026-11-10T10:00:00.000Z","pid":1,"hostname":"h","module":"mc","msg":"fatal error"}',
      "Uncaught TypeError: x is not a function",
      "[UnhandledPromiseRejection: This error originated either by throwing inside of an async function]",
      "SyntaxError: The requested module './x.js' does not provide an export named 'y'",
      '{"level":"info","msg":"no error here, error in text only"}',
      '{"level":"warn","msg":"fatal word in a warning"}',
      '{"level":50,"msg":"numeric levels are not what this logger writes"}',
      "[messaging] Telegram channel active",
    ];
    const r = drive(`printf '%s\\n' "$@" | deploy_count_log_levels`, lines);
    expect(r.out.trim()).toBe("4 1");
  });
});

describe("old PID exit without signals (/proc)", () => {
  it("waits for MainPID to change and the old PID's /proc entry to go", () => {
    mkdirSync(join(root, "proc/100"));
    state("mainpid.seq", "100\n200");
    let r = drive('DEPLOY_OLD_PID=100; deploy_wait_old_exit; echo "rc=$? new=$DEPLOY_NEW_PID"');
    expect(r.out).toContain("rc=1");
    expect(r.out).toContain("old PID 100 still alive");

    rmSync(join(root, "proc/100"), { recursive: true });
    rmSync(join(stub, "mainpid.n"));
    state("mainpid.seq", "200");
    r = drive('DEPLOY_OLD_PID=100; deploy_wait_old_exit; echo "rc=$? new=$DEPLOY_NEW_PID"');
    expect(r.out).toContain("rc=0 new=200");
  });

  it("deploy_pid_alive takes only a numeric pid above 1", () => {
    mkdirSync(join(root, "proc/4242"));
    const r = drive(
      'for p in 4242 4243 1 0 "" "-1" "42 43" "../proc"; do if deploy_pid_alive "$p"; then echo "alive:[$p]"; fi; done',
    );
    expect(r.out.trim()).toBe("alive:[4242]");
  });

  it("neither the lib nor deploy.sh sends a signal", () => {
    for (const file of [LIB, DEPLOY]) {
      const code = readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("#"));
      // A signal-sending command in command position (start, after an operator or `$(`).
      expect(code.filter((l) => /(^|[;&|(`]|\$\()\s*(kill|pkill|killall|trap|timeout)\b/.test(l.trim())), file).toEqual([]);
    }
    expect(readFileSync(LIB, "utf8")).toContain('[[ -d "$PROC_ROOT/$1" ]]');
  });
});

describe("provenance (R4): one system-log line at every exit", () => {
  const cases: Array<[string, () => void, string[], string, number]> = [
    ["bad argument", () => {}, ["--drain", "x"], "REFUSED step=args", 2],
    ["dirty tree", () => write(join(repo, "scripts/s.sh"), "echo t\n"), [], "REFUSED step=dirty-tree", 1],
    ["host deps", () => rmSync(join(repo, "node_modules/.package-lock.json")), [], "REFUSED step=host-deps", 1],
    ["running tasks", () => state("running.seq", "1"), [], "BLOCKED step=task-guard", 1],
    ["migration gate", () => state("validator.rc", "1"), [], "REFUSED step=migration-gate", 1],
    ["snapshot", () => { state("live_version", "1"); state("snapshot.rc", "1"); }, [], "REFUSED step=snapshot", 1],
    ["build", () => state("build.rc", "1"), [], "FAILED step=build", 1],
    ["build-info", () => state("build-info.rc", "1"), [], "FAILED step=build-info", 1],
    ["image", () => state("image.rc", "1"), [], "FAILED step=image", 1],
    ["second guard", () => state("running.seq", "0\n3"), [], "BLOCKED step=task-guard-pre-restart", 1],
    ["restart", () => state("restart.rc", "1"), [], "FAILED step=restart", 1],
    ["old pid never exits", () => state("mainpid.seq", "100"), [], "FAILED step=old-pid", 1],
    ["crash loop", () => state("mainpid.seq", "100\n200\n300"), [], "FAILED step=post-restart", 1],
    ["warning", () => state("journal-new.txt", TOOLS(10)), [], "WARNING step=post-restart", 0],
    ["ok", () => {}, [], "OK step=post-restart", 0],
  ];

  for (const [name, arrange, args, verdict, code] of cases) {
    it(`${name} → ${verdict}`, () => {
      arrange();
      const r = deploy(...args);
      expect(r.status, r.out).toBe(code);
      const lines = syslog();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(
        new RegExp(`^-t mc-deploy -- commit=[0-9a-f]{7,} dirty=(yes|no|unknown) allow_dirty=(yes|no) old_pid=\\S* new_pid=\\S* verdict=${verdict}$`),
      );
      expect(r.out).toContain(`provenance: commit=`);
    });
  }

  it("records the old and new PID of a completed restart", () => {
    deploy();
    expect(syslog()[0]).toContain("old_pid=100 new_pid=200 verdict=OK");
    // The previous boot's tool count is read from the old process's own lines, before the restart.
    const c = calls();
    const prev = c.indexOf("journalctl _SYSTEMD_UNIT=mission-control.service _PID=100 -o cat --no-pager");
    expect(prev).toBeGreaterThan(-1);
    expect(prev).toBeLessThan(c.indexOf("systemctl restart mission-control"));
  });
});

describe("scripts/deploy.sh is the thin ordered sequence", () => {
  const text = readFileSync(DEPLOY, "utf8");
  const cmds = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));

  it("gates, sources the lib and hands every decision to deploy_run", () => {
    expect(cmds).toEqual([
      "set -e",
      "cd /root/claude/mission-control",
      "source scripts/lib/operator-gate.sh",
      "require_operator_context",
      "SYSTEMCTL=systemctl JOURNALCTL=journalctl CURL=curl SQLITE3=sqlite3 LOGGER=logger GIT=git NODE=node",
      "PROC_ROOT=/proc DEPLOY_SERVICE=mission-control DEPLOY_DB=data/mc.db DEPLOY_BACKUP_DIR=backups",
      "DEPLOY_HEALTH_URL=http://127.0.0.1:8080/health DEPLOY_STABLE_SECS=15 DEPLOY_HEALTH_WAIT_SECS=60 DEPLOY_POLL_SECS=2",
      "source scripts/lib/deploy-checks.sh",
      'deploy_run "$@"',
    ]);
  });

  it("assigns every command variable and window value the lib reads, at the lib's own default", () => {
    const assigned = new Map(
      cmds
        .filter((l) => /^[A-Z_]+=\S/.test(l))
        .flatMap((l) => l.split(" "))
        .map((kv) => kv.split("=", 2) as [string, string]),
    );
    const lib = readFileSync(LIB, "utf8");
    const defaults = [...lib.matchAll(/\$\{([A-Z_]+):=([^}]*)\}/g)].map((m) => [m[1], m[2]] as const);
    const knobs = ["MC_DEPLOY_TIMEOUT_SECS"];
    expect(defaults.length).toBeGreaterThan(10);
    for (const [name, value] of defaults) {
      if (knobs.includes(name)) expect(assigned.has(name), name).toBe(false);
      else expect(assigned.get(name), name).toBe(value);
    }
    expect(assigned.has("MC_SKIP_MIGRATION_GATE")).toBe(false);
    expect(lib).toContain(': "${DEPLOY_HEALTH_WAIT_SECS:=60}"');
  });

  it("documents every flag and the two env knobs", () => {
    for (const s of ["--force", "--drain <secs>", "--allow-dirty", "MC_SKIP_MIGRATION_GATE", "MC_DEPLOY_TIMEOUT_SECS"]) {
      expect(text).toContain(s);
    }
  });
});
