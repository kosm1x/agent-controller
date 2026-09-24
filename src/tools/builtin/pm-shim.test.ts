/**
 * pm-shim — the structural layer of the package-manager gate (dependency trust
 * audit 2026-09-16). The shim runs under /bin/sh against a FAKE `npm`/`npx`/
 * `pip`/`uv` on a temp PATH, never the host binaries: an allowed verb must
 * reach the fake (stdout `REAL <name> <args>`), a refused one must exit 1 with
 * the operator hand-off on stderr and never reach it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PM_SHIM_DIR, pmShimMissing, withPmShimPath } from "./shell.js";

const NAMES = ["npm", "npx", "pnpm", "yarn", "bun", "bunx", "uvx", "corepack", "pip", "pip3", "pipx", "uv", "poetry", "pipenv", "conda"];

let tmp = "";
let proj = "";
let env: NodeJS.ProcessEnv = {};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "pm-shim-"));
  const real = join(tmp, "real");
  mkdirSync(real);
  // The fake `npm` emulates `npm run <script>` (a package.json script is a real
  // route to a nested package manager call) and otherwise echoes its argv.
  writeFileSync(
    join(real, "npm"),
    `#!/bin/sh
if [ "$1" = run ] || [ "$1" = run-script ]; then
  cmd=$(node -e 'console.log(require(process.cwd()+"/package.json").scripts[process.argv[1]])' "$2")
  exec sh -c "$cmd"
fi
echo "REAL npm $*"
`,
    { mode: 0o755 },
  );
  for (const n of ["npx", "pip", "pip3", "uv"]) {
    writeFileSync(join(real, n), `#!/bin/sh\necho "REAL ${n} $*"\n`, { mode: 0o755 });
  }
  proj = join(tmp, "proj");
  mkdirSync(join(proj, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(proj, "node_modules", "@scope", "pkg"), { recursive: true });
  mkdirSync(join(proj, "sub", "deeper"), { recursive: true });
  writeFileSync(join(proj, "node_modules", ".bin", "tsx"), "#!/bin/sh\necho tsx\n", { mode: 0o755 });
  writeFileSync(join(proj, "package.json"), JSON.stringify({ scripts: { sneaky: "npm i lodash", fine: "npm ls" } }));
  // No host package manager is reachable: the fakes come right after the shim.
  // `node` alone, wherever it lives (CI's is not in /usr/bin): the fake npm
  // needs it, and its directory holds a real npm/npx the fakes must shadow.
  const nodeBin = join(tmp, "node-bin");
  mkdirSync(nodeBin);
  symlinkSync(process.execPath, join(nodeBin, "node"));
  env = withPmShimPath({ PATH: `${real}:${nodeBin}:/usr/bin:/bin`, HOME: tmp });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function run(name: string, args: string[], cwd?: string) {
  const r = spawnSync(join(PM_SHIM_DIR, name), args, { cwd: cwd ?? tmp, env, encoding: "utf-8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
function sh(command: string, cwd?: string) {
  const r = spawnSync("/bin/sh", ["-c", command], { cwd: cwd ?? tmp, env, encoding: "utf-8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("pm-shim — layout and PATH wiring", () => {
  it("ships next to shell.ts with every package-manager name executable", () => {
    expect(PM_SHIM_DIR.endsWith("/tools/builtin/pm-shim")).toBe(true);
    expect(pmShimMissing()).toBeNull();
    // qa R4 W-4: the fail-closed branch is reachable (an unbuilt tree refuses to spawn).
    expect(pmShimMissing(join(tmp, "not-built"))).toMatch(/\[pm-shim\] missing: .*not-built\/npm/);
    for (const n of NAMES) expect(() => accessSync(join(PM_SHIM_DIR, n), constants.X_OK), n).not.toThrow();
  });

  it("withPmShimPath puts the shim dir first, once, and keeps the rest", () => {
    expect(withPmShimPath({ PATH: "/usr/bin:/bin" }).PATH).toBe(`${PM_SHIM_DIR}:/usr/bin:/bin`);
    expect(withPmShimPath({ PATH: `/usr/bin:${PM_SHIM_DIR}:/bin` }).PATH).toBe(`${PM_SHIM_DIR}:/usr/bin:/bin`);
    expect(withPmShimPath({}).PATH?.startsWith(`${PM_SHIM_DIR}:`)).toBe(true);
    expect(withPmShimPath({ PATH: "/bin", HOME: "/x" }).HOME).toBe("/x");
  });

  it("is what `command -v npm` resolves to under the shell_exec env", () => {
    expect(sh("command -v npm").out.trim()).toBe(join(PM_SHIM_DIR, "npm"));
  });
});

describe("pm-shim — refused verbs never reach the real binary", () => {
  const cases: Array<[string, string[], string?]> = [
    ["npm", ["install", "lodash"]],
    ["npm", ["i", "lodash"]],
    ["npm", ["ci"]],
    ["npm", ["add", "lodash"]],
    ["npm", ["update"]],
    ["npm", ["uninstall", "lodash"]],
    ["npm", ["link"]],
    ["npm", ["dedupe"]],
    ["npm", ["prune"]],
    ["npm", ["rebuild"]],
    ["npm", ["init", "-y"]],
    ["npm", ["create", "vite"]],
    ["npm", ["exec", "cowsay"]],
    ["npm", ["x", "cowsay"]],
    ["npm", ["config", "set", "registry", "http://evil.test"]],
    ["pnpm", ["-w", "add", "lodash"]], // qa R4 W-5: pnpm -w is boolean
    ["bun", ["-w", "add", "lodash"]],
    ["npm", ["set", "registry", "http://evil.test"]],
    ["npm", ["login"]],
    ["npm", ["adduser"]],
    ["npm", ["publish"]],
    ["npm", ["token", "create"]],
    ["npm", ["audit", "fix"]],
    ["npm", ["version", "patch"]],
    ["npm", ["pkg", "set", "scripts.x=npm i y"]],
    ["npm", ["install-scripts", "allow", "x"]],
    ["npm", ["--prefix", "/tmp", "install", "lodash"]],
    ["npm", ["--registry", "http://evil.test", "install", "lodash"]],
    ["npm", [...Array<string>(64).fill("--no-audit"), "install", "lodash"]],
    ["npm", ["sneakyverb"]],
    ["yarn", []],
    ["yarn", ["add", "lodash"]],
    ["yarn", ["workspace", "a", "add", "lodash"]],
    ["yarn", ["dlx", "cowsay"]],
    ["pnpm", ["dlx", "cowsay"]],
    ["pnpm", ["--filter", "a", "add", "lodash"]],
    ["pnpm", ["i"]],
    ["bun", ["install"]],
    ["bun", ["x", "cowsay"]],
    ["npx", ["cowsay", "hi"]],
    ["npx", ["cowsay", "hi"], "proj"],
    ["npx", ["-y", "cowsay"], "proj"],
    ["npx", ["--yes", "cowsay"], "proj"],
    ["npx", ["--package=cowsay", "cowsay"], "proj"],
    ["npx", ["-p", "cowsay", "cowsay"], "proj"],
    ["npx", ["-c", "cowsay hi"], "proj"],
    ["npx", ["tsx@latest", "x.ts"], "proj"],
    ["npx", ["tsx@9.9.9", "x.ts"], "proj"],
    ["npx", ["@evil/tsx", "x.ts"], "proj"],
    ["npx", ["@scope/pkg@1.0.0"], "proj"],
    ["npx", ["../evil/bin"], "proj"],
    ["npx", ["tsx", "x.ts"]], // cwd = tmp root: no node_modules above
    ["pip", ["install", "requests"]],
    ["pip3", ["install", "-r", "requirements.txt"]],
    ["pip", ["download", "requests"]],
    ["pip", ["wheel", "."]],
    ["pip", ["config", "set", "global.index-url", "http://evil.test"]],
    ["pip", ["cache", "purge"]],
    ["pipx", ["install", "ruff"]],
    ["pipx", ["run", "ruff"]],
    ["uv", ["pip", "install", "requests"]],
    ["uv", ["add", "requests"]],
    ["uv", ["sync"]],
    ["uv", ["run", "x.py"]],
    ["uv", ["tool", "run", "ruff"]],
    ["uv", ["tool", "install", "ruff"]],
    ["uv", ["python", "install", "3.13"]],
    ["uv", ["self", "update"]],
    ["uvx", ["ruff", "check", "."]],
    ["uvx", ["--version"]],
    ["bunx", ["cowsay"]],
    ["corepack", ["enable"]],
    ["corepack", ["pnpm", "install"]],
    ["poetry", ["add", "requests"]],
    ["poetry", ["install"]],
    ["poetry", ["config", "repositories.x", "http://evil.test"]],
    ["pipenv", ["install", "requests"]],
    ["pipenv", ["run", "x"]],
    ["conda", ["install", "numpy"]],
    ["conda", ["env", "create"]],
    ["conda", ["config", "--add", "channels", "evil"]],
  ];
  for (const [name, args, where] of cases) {
    it(`${name} ${args.join(" ").slice(0, 60)}${where ? ` (cwd ${where})` : ""}`, () => {
      const r = run(name, args, where === "proj" ? proj : undefined);
      expect(r.code, r.err).toBe(1);
      expect(r.err).toMatch(/^\[pm-shim\] refused: /);
      expect(r.err).toMatch(/operator decision/);
      expect(r.out).toBe("");
    });
  }
});

describe("pm-shim — read-only verbs pass through to the real binary", () => {
  const cases: Array<[string, string[], string?]> = [
    ["npm", []],
    ["npm", ["--version"]],
    ["npm", ["-v"]],
    ["npm", ["--help"]],
    ["npm", ["ls"]],
    ["npm", ["ls", "i"]], // an argument that merely EQUALS a verb
    ["npm", ["ls", "--depth=0", "lodash"]],
    ["npm", ["view", "lodash", "version"]],
    ["npm", ["info", "lodash"]],
    ["npm", ["outdated"]],
    ["npm", ["audit"]],
    ["npm", ["audit", "--json"]],
    ["npm", ["why", "lodash"]],
    ["npm", ["explain", "lodash"]],
    ["npm", ["config", "get", "registry"]],
    ["npm", ["config", "list"]],
    ["npm", ["config", "ls"]],
    ["npm", ["get", "registry"]],
    ["npm", ["pkg", "get", "name"]],
    ["npm", ["install-scripts", "ls"]],
    ["npm", ["version"]],
    ["npm", ["--prefix", "/tmp", "ls"]],
    ["npm", ["--prefix", "/tmp", "config", "get", "registry"]],
    ["npm", ["test"]],
    ["npm", ["help", "install"]],
    ["npm", ["query", ".dev"]],
    ["npm", ["search", "lodash"]],
    ["npm", ["doctor"]],
    ["npm", ["ping"]],
    ["npm", ["root"]],
    ["npm", ["prefix"]],
    ["npx", []],
    ["npx", ["--version"]],
    ["npx", ["tsx", "x.ts"], "proj"],
    ["npx", ["tsx", "x.ts"], "proj/sub"],
    ["npx", ["tsx", "x.ts"], "proj/sub/deeper"],
    ["npx", ["--no-install", "tsx", "x.ts"], "proj"],
    ["npx", ["./node_modules/.bin/tsx", "x.ts"], "proj"],
    ["npx", ["@scope/pkg", "x"], "proj"],
    ["pip", ["list"]],
    ["pip", ["--version"]],
    ["pip3", ["show", "requests"]],
    ["pip", ["freeze"]],
    ["pip", ["check"]],
    ["pip", ["config", "list"]],
    ["pip", ["cache", "dir"]],
    ["uv", ["--version"]],
    ["uv", ["pip", "list"]],
    ["uv", ["pip", "freeze"]],
    ["uv", ["tree"]],
    ["uv", ["tool", "list"]],
    ["uv", ["python", "list"]],
  ];
  for (const [name, args, where] of cases) {
    it(`${name} ${args.join(" ")}${where ? ` (cwd ${where})` : ""}`, () => {
      const r = run(name, args, where ? join(tmp, where) : undefined);
      expect(r.code, r.err).toBe(0);
      expect(r.out.trim()).toBe(`REAL ${name} ${args.join(" ")}`.trim());
      expect(r.err).toBe("");
    });
  }

  it("a package manager absent from the rest of PATH is 'command not found' (127), not silently allowed", () => {
    const r = run("pnpm", ["ls"]);
    expect(r.code).toBe(127);
    expect(r.err).toMatch(/pnpm: command not found/);
  });
});

describe("pm-shim — every shell spelling resolves through PATH (the R1–R3 bypass classes)", () => {
  const refused = (r: { code: number | null; err: string; out: string }) => {
    expect(r.code, r.err).not.toBe(0);
    expect(r.err).toMatch(/\[pm-shim\] refused/);
    expect(r.out).not.toMatch(/REAL/);
  };
  it("parameter expansion, adjacent expansion, ANSI-C quoting, indirection", () => {
    refused(sh("${P:-npm} install lodash"));
    refused(sh("${A:-${B:-npm}} install lodash"));
    refused(sh("X=; npm${X} install lodash"));
    refused(sh("bash -c \"$'npm' install lodash\""));
    refused(sh("P=npm; $P install lodash"));
    refused(sh('P=$(printf npm); "$P" install lodash'));
    refused(sh("bash -c 'read -r P <<< npm; $P install lodash'"));
  });
  it("heredoc piped to an interpreter, eval, xargs, env, command", () => {
    refused(sh("cat <<'EOF' | sh\nnpm install lodash\nEOF"));
    refused(sh("tee /dev/null <<'EOF' | sh\nnpm i lodash\nEOF"));
    refused(sh("eval 'npm install lodash'"));
    refused(sh("echo lodash | xargs npm install"));
    refused(sh("env npm install lodash"));
    refused(sh("command npm install lodash"));
    refused(sh("\\npm install lodash"));
  });
  it("run-time assembly inside node / python (the string guard's documented residual)", () => {
    refused(sh(`node -e "require('child_process').execSync('np'+'m ins'+'tall lodash',{stdio:'inherit'})"`));
    refused(sh(`python3 -c "import subprocess,sys; sys.exit(subprocess.call(['pi'+'p','inst'+'all','requests']))"`));
    refused(sh(`node -e "require('child_process').spawnSync('npx',['-y','cowsay'],{stdio:'inherit'}); process.exit(1)"`));
  });
  it("a package.json script that installs is refused when `npm run` reaches it", () => {
    refused(sh("npm run sneaky", proj));
    for (const cmd of ["npm run fine", "npm run-script fine"]) {
      const ok = sh(cmd, proj);
      expect(ok.code).toBe(0);
      expect(ok.out.trim()).toBe("REAL npm ls"); // the fake ran the script, which reached the shim, which passed the read
    }
  });
  it("PATH=… override in the command still lands on the shim when the shim dir stays first", () => {
    // A child cannot remove the shim from a PATH it inherits FIRST unless it rewrites PATH wholesale —
    // that rewrite is the one absolute-path spelling the string gate covers.
    refused(sh("PATH=$PATH:/usr/local/bin npm install lodash"));
  });
});
