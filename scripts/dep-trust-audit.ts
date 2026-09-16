/**
 * scripts/dep-trust-audit.ts — read-only dependency trust inventory.
 *
 * Audit only: installs nothing, executes no package code, changes nothing.
 * Mechanizes the inventory steps of the dependency trust audit
 * (docs/planning/dependency-trust-audit-2026-09-16.md): what was chosen
 * (package.json) vs what came along (package-lock.json), which packages carry
 * install-time scripts and whether `allowScripts` has ruled on each, and which
 * lockfile entries the registry cannot attest (non-registry `resolved`, no
 * `integrity`).
 *
 * Usage:
 *   npx tsx scripts/dep-trust-audit.ts             # lockfile-only, offline
 *   npx tsx scripts/dep-trust-audit.ts --registry  # + npm registry metadata per direct dep
 *
 * `--registry` runs `npm view <pkg> …` (network READS; nothing is installed):
 * maintainer count, last publish date, latest tag. A maintainer count of 1 is
 * a fact about the registry record, not a judgement about the package.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const withRegistry = process.argv.includes("--registry");

type LockPkg = {
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  os?: string[];
  hasInstallScript?: boolean;
};
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  allowScripts?: Record<string, boolean>;
};
const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
  lockfileVersion: number;
  packages: Record<string, LockPkg>;
};

const deps = pkg.dependencies ?? {};
const devDeps = pkg.devDependencies ?? {};
const allowScripts = pkg.allowScripts ?? {};
const entries = Object.entries(lock.packages).filter(([k]) => k !== "");
const name = (key: string) => key.replace(/^.*node_modules\//, "");
const isExact = (range: string) => /^\d/.test(range);

console.log(`# Dependency trust inventory — ${new Date().toISOString().slice(0, 10)}`);
console.log(`lockfileVersion ${lock.lockfileVersion}\n`);

console.log("## Chosen vs inherited");
console.log(`direct: ${Object.keys(deps).length} prod + ${Object.keys(devDeps).length} dev`);
console.log(`lockfile: ${entries.length} packages (${entries.filter(([, v]) => v.dev).length} flagged dev, ${entries.filter(([, v]) => v.optional).length} flagged optional, ${entries.filter(([, v]) => v.dev && v.optional).length} both)`);
const exact = Object.entries(deps).filter(([, r]) => isExact(r)).map(([n, r]) => `${n}@${r}`);
console.log(`exact-pinned prod deps: ${exact.length ? exact.join(", ") : "none"}\n`);

console.log("## Install-time scripts (lockfile `hasInstallScript`) vs `allowScripts`");
console.log("npm >= 12 SKIPS install scripts unless the package is listed; `npm install-scripts ls` must report none unreviewed.");
let unlisted = 0;
for (const [key, v] of entries) {
  if (!v.hasInstallScript) continue;
  const n = name(key);
  const ruling = allowScripts[n];
  // An os-restricted optional package (fsevents = darwin) is never unpacked here.
  const notOnThisOs = Array.isArray(v.os) && !v.os.includes(process.platform);
  const status = notOnThisOs
    ? `not installed on ${process.platform} (os: ${v.os!.join(",")})`
    : ruling === true ? "allowed" : ruling === false ? "blocked" : "UNLISTED (review)";
  if (ruling === undefined && !notOnThisOs) unlisted++;
  console.log(`- ${key}@${v.version ?? "?"} → ${status}${v.optional ? " (optional)" : ""}`);
}
console.log(unlisted ? `REVIEW: ${unlisted} install-script package(s) without an allowScripts ruling\n` : "all install-script packages have a ruling\n");

console.log("## Lockfile entries the registry cannot attest");
const nonRegistry = entries.filter(([, v]) => v.resolved && !v.resolved.startsWith("https://registry.npmjs.org/"));
const noIntegrity = entries.filter(([, v]) => !v.integrity && !v.link);
for (const [key, v] of nonRegistry) console.log(`- non-registry: ${key} ← ${v.resolved}`);
for (const [key] of noIntegrity) console.log(`- no integrity hash: ${key}`);
if (!nonRegistry.length && !noIntegrity.length) console.log("none");
console.log();

if (withRegistry) {
  console.log("## Registry metadata per direct dependency (npm view; reads only)");
  console.log("| package | declared | latest | last publish | maintainers |");
  console.log("|---|---|---|---|---|");
  for (const [n, range] of [...Object.entries(deps), ...Object.entries(devDeps)]) {
    try {
      const raw = execFileSync("npm", ["view", n, "dist-tags.latest", "time.modified", "maintainers", "--json"], {
        encoding: "utf8",
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const j = JSON.parse(raw) as { "dist-tags.latest"?: string; "time.modified"?: string; maintainers?: unknown[] };
      const m = Array.isArray(j.maintainers) ? j.maintainers.length : "?";
      console.log(`| ${n} | ${range} | ${j["dist-tags.latest"] ?? "?"} | ${(j["time.modified"] ?? "?").slice(0, 10)} | ${m} |`);
    } catch {
      console.log(`| ${n} | ${range} | (registry query failed) | | |`);
    }
  }
}
