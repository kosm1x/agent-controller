/**
 * scripts/backup-db.sh and scripts/backup-state-bundle.sh create their new
 * files and folders readable by their owner only (a file the bundle copies
 * keeps its source's mode). Each case runs a copy of the real script inside a
 * temp folder: its absolute path assignments are pointed into that folder and
 * the child's PATH is one folder holding a stub for the database tool, a
 * wrapper around the real archive tool, and links to a fixed list of real
 * tools. The stub and the wrapper record the umask in effect when they run.
 * No database is opened and the scripts write inside the temp folder.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Real tools linked into the child's PATH; a command missing from it is not found. */
const REAL_TOOLS = ["bash", "cat", "cp", "cut", "date", "du", "find", "grep", "gzip", "hostname", "mkdir", "mktemp", "rm"];
/** A transformed copy is refused when a line outside its comments still names one of these. */
const HOST_PREFIXES = ["/root/", "/opt/", "/var/", "/etc/", "/home/"];

function which(name: string): string {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      // not in this folder
    }
  }
  throw new Error(`${name} is not on the test process's PATH`);
}

let root: string;
let bin: string;
let log: string;
let bash: string;
let realTar: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "backup-file-modes-"));
  bin = join(root, "bin");
  log = join(root, "umask.log");
  for (const d of [bin, join(root, "home"), join(root, "tmp"), join(root, "work")]) mkdirSync(d);
  for (const name of REAL_TOOLS) symlinkSync(which(name), join(bin, name));
  bash = which("bash");
  realTar = which("tar");
  const stubs: Record<string, string> = {
    // Synthetic bytes for a .backup target, "ok" for the integrity check.
    sqlite3: `#!${bash}
case "$2" in
  ".backup '"*"'")
    t=\${2#".backup '"}; t=\${t%"'"}
    printf '%s sqlite3\\n' "$(umask)" >> "${log}"
    printf 'synthetic\\n' > "$t" ;;
  *integrity_check*) echo ok ;;
  *) echo "unexpected sqlite3 call: $*" >&2; exit 3 ;;
esac
`,
    // Records the umask, then runs the real archive tool.
    tar: `#!${bash}
printf '%s tar\\n' "$(umask)" >> "${log}"
exec "${realTar}" "$@"
`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Copies the script with each named `NAME="..."` line pointed at the given value. */
function transformed(script: string, values: Record<string, string>): string {
  const seen = new Map(Object.keys(values).map((k) => [k, 0]));
  const lines = readFileSync(resolve(HERE, script), "utf8")
    .split("\n")
    .map((line) => {
      const m = /^([A-Z_]+)="[^"]*"$/.exec(line);
      if (m && seen.has(m[1])) {
        seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
        return `${m[1]}="${values[m[1]]}"`;
      }
      const code = line.trim();
      if (code && !code.startsWith("#")) {
        for (const p of HOST_PREFIXES) {
          if (code.includes(p)) throw new Error(`${script}: a host path (${p}) is left on a code line: ${code}`);
        }
      }
      return line;
    });
  for (const [name, n] of seen) {
    if (n !== 1) throw new Error(`${script}: anchor ${name}="..." matched ${n} times (want exactly 1)`);
  }
  const copy = join(root, "work", script);
  writeFileSync(copy, lines.join("\n"));
  return copy;
}

/** Runs the copy from a known umask of 022, so a missing or late umask line shows. */
function run(copy: string): { status: number | null; out: string } {
  const r = spawnSync(bash, ["-c", 'umask 022 && exec bash "$1"', "child", copy], {
    cwd: join(root, "work"),
    env: { PATH: bin, HOME: join(root, "home"), TMPDIR: join(root, "tmp"), LC_ALL: "C" },
    encoding: "utf8",
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` };
}

const umasks = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
const mode = (p: string): string => (statSync(p).mode & 0o777).toString(8);

/** Archive member name -> mode string, read with the real archive tool. */
function members(archive: string): Map<string, string> {
  const r = spawnSync(realTar, ["-tvzf", archive], { env: { PATH: bin, LC_ALL: "C" }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`listing ${archive} failed: ${r.stderr}`);
  return new Map(
    r.stdout
      .trim()
      .split("\n")
      .map((l) => {
        const f = l.trim().split(/\s+/);
        return [f[f.length - 1], f[0]] as [string, string];
      }),
  );
}

describe("scripts/backup-db.sh", () => {
  function prepare(): { dest: string; copy: string } {
    mkdirSync(join(root, "out"));
    const dest = join(root, "out", "backups");
    const copy = transformed("backup-db.sh", { BACKUP_DIR: dest, DB_PATH: join(root, "work", "source.db") });
    return { dest, copy };
  }

  function expectOwnerOnlyCopy(dest: string, r: { status: number | null; out: string }): void {
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/command not found/);
    expect(r.out).toMatch(/^\[.*\] backup: mc\.db → .*\/mc-[^/]*\.db \(/m);
    const names = readdirSync(dest);
    expect(names, "files in the destination folder").toHaveLength(1);
    expect(names[0]).toMatch(/^mc-.*\.db$/);
    expect(umasks(), "umask when the copy was written").toEqual(["0077 sqlite3"]);
    expect(mode(join(dest, names[0])), "the copy").toBe("600");
  }

  it("creates its missing folder 700 and the copy 600, under umask 077 when the copy is written", () => {
    const { dest, copy } = prepare();
    const r = run(copy);
    expectOwnerOnlyCopy(dest, r);
    expect(mode(dest), "the folder the script created").toBe("700");
  });

  it("keeps an existing folder's mode and still writes the new copy 600", () => {
    const { dest, copy } = prepare();
    mkdirSync(dest);
    chmodSync(dest, 0o755);
    expectOwnerOnlyCopy(dest, run(copy));
    expect(mode(dest), "the existing folder").toBe("755");
  });
});

describe("scripts/backup-state-bundle.sh", () => {
  it("writes the archive 600 with its new members 600, keeps a copied file's mode, and removes its staging folder", () => {
    const mc = join(root, "work", "repo");
    mkdirSync(join(mc, "data", "archive"), { recursive: true });
    const copied = join(mc, "data", "archive", "tasks.jsonl.gz");
    writeFileSync(copied, "synthetic\n");
    chmodSync(copied, 0o640);
    writeFileSync(join(mc, "mcp-servers.json"), "{}\n");
    const sibling = join(root, "work", "sibling.db");
    writeFileSync(sibling, "synthetic\n");
    const dest = join(root, "out");
    mkdirSync(dest);
    chmodSync(dest, 0o755);
    const copy = transformed("backup-state-bundle.sh", { MC_DIR: mc, DEST_DIR: dest, VLCRM_DB: sibling });

    const r = run(copy);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/command not found/);
    expect(r.out).not.toMatch(/^!! /m);
    for (const line of ["starting mc state bundle", "+ mc.db integrity_check ok", "= archive verified (tar -tzf ok)", "bundle done"]) {
      expect(r.out).toContain(line);
    }
    // Two database copies into the staging folder, then the archive and its check.
    expect(umasks(), "umask at each create").toEqual(["0077 sqlite3", "0077 sqlite3", "0077 tar", "0077 tar"]);

    const names = readdirSync(dest);
    expect(names, "files in the destination folder").toHaveLength(1);
    expect(names[0]).toMatch(/^mission-control-\d{8}\.tar\.gz$/);
    const archive = join(dest, names[0]);
    expect(mode(archive), "the archive").toBe("600");
    expect(mode(dest), "the existing destination folder").toBe("755");

    const m = members(archive);
    // Not a umask check: mktemp makes the staging folder owner-only under any umask.
    expect(m.get("./"), "the staging folder").toBe("drwx------");
    const created = [...m].filter(([n]) => n !== "./" && !n.startsWith("./archive") && n !== "./mcp-servers.json");
    expect(created.map(([n]) => n)).toEqual(expect.arrayContaining(["./mc.db", "./MANIFEST.txt"]));
    expect(created, "files the script created").toHaveLength(3);
    for (const [n, mo] of created) expect(mo, n).toBe("-rw-------");
    expect(m.get("./archive/tasks.jsonl.gz"), "a file copied with cp -a").toBe("-rw-r-----");

    expect(readdirSync(join(root, "tmp")).filter((n) => n.startsWith("mc-bundle-")), "staging folders left").toEqual([]);
  });
});
