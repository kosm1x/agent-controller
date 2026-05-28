/**
 * audit-always-read.ts — staleness audit for `jarvis_files` always-read tier.
 *
 * WHY:
 *   Rows with `qualifier='always-read'` are injected into EVERY Jarvis task's
 *   context. When they go stale (e.g. `mc-deploy PENDIENTE — f2a4c40 no
 *   deployado aún` carrying for days after f2a4c40 was actually deployed),
 *   Jarvis dutifully repeats the stale claim to the operator across every
 *   conversation. See `feedback_always_read_kb_drift.md`.
 *
 * Checks (per row):
 *   1. `updated_at` age vs threshold (default 7d).
 *   2. FS-mirror file (`KB_ROOT + path`) vs DB content (sha256 diff).
 *   3. Embedded commit hashes — for each unique hex token 7-40 chars that
 *      resolves to a real commit: how many commits behind HEAD is it, and how
 *      many of those touch `src/**`?
 *   4. `mc-deploy ... pendiente` / `pendiente ... mc-deploy` text co-located
 *      with reality check: `dist/index.js` mtime vs the last `src/**` commit
 *      author-timestamp. If dist is newer, the PENDIENTE claim is false.
 *
 * Output: markdown to stdout. Exits 1 if any STALE row found (>=1 stale),
 * 0 if only WARN or all OK. Read-only — no DB mutations, no FS writes.
 *
 * Usage:
 *   npx tsx scripts/audit-always-read.ts
 *
 * Env overrides:
 *   MC_DB_PATH=./data/mc.db
 *   JARVIS_KB_MIRROR_DIR=/root/claude/jarvis-kb
 *   MC_REPO_ROOT=/root/claude/mission-control
 *   MC_KB_STALE_DAYS=7
 */

import { execFileSync } from "node:child_process";
import { statSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { initDatabase, getDatabase, closeDatabase } from "../src/db/index.js";

import { dirname, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT_DEFAULT = resolve(SCRIPT_DIR, "..");

const DB_PATH =
  process.env.MC_DB_PATH ?? resolve(REPO_ROOT_DEFAULT, "data/mc.db");
const KB_ROOT = process.env.JARVIS_KB_MIRROR_DIR ?? "/root/claude/jarvis-kb";
const REPO_ROOT = process.env.MC_REPO_ROOT ?? REPO_ROOT_DEFAULT;
const STALE_DAYS = Number(process.env.MC_KB_STALE_DAYS ?? "30");

interface Row {
  path: string;
  content: string;
  updated_at: string;
  priority: number;
}

export type Level = "ok" | "warn" | "stale";

export interface Finding {
  path: string;
  level: Level;
  reasons: string[];
}

const HASH_RE = /\b([0-9a-f]{7,40})\b/gi;

/**
 * Pull every plausible commit-hash token out of text. Used by tests and by
 * the "are any of these referenced commits behind HEAD" check.
 */
export function extractCommitHashes(content: string): string[] {
  const seen = new Set<string>();
  for (const m of content.matchAll(HASH_RE)) {
    seen.add(m[1].toLowerCase());
  }
  return [...seen];
}

/**
 * Extract commit hashes that appear in a HEAD-claim *context* — i.e. labeled
 * as the file's current snapshot reference, not just mentioned in prose. This
 * is the load-bearing check for "is this file's claimed HEAD behind reality":
 * referencing `b2fc758` in prose ("fix b2fc758 lowered scores") shouldn't
 * fire, but `HEAD: f2a4c40` or `Última sincronización con repo: ... f2a4c40`
 * should.
 *
 * Window: 120 chars after the label keyword. Generous enough to span a
 * label-then-newline-then-hash layout but narrow enough that an unrelated
 * hash mentioned later in the same paragraph won't catch.
 */
const HEAD_CLAIM_RE =
  /(?:HEAD|último\s+(?:deploy|commit|src\/?\s*commit|sync)|commit\s+actual|(?:última\s+)?sincronización\s+con\s+repo|sincronizado\s+(?:con|a)\s+repo|repo\s+HEAD|tip\s+del\s+repo|repo\s+sincronizado)\b[\s\S]{0,120}?\b([0-9a-f]{7,40})\b/gi;

export function extractHeadClaimHashes(content: string): string[] {
  const seen = new Set<string>();
  for (const m of content.matchAll(HEAD_CLAIM_RE)) {
    seen.add(m[1].toLowerCase());
  }
  return [...seen];
}

/**
 * Detect a *claim* (not a discussion) that mc-deploy is pending. Strategy:
 * (1) find `mc-deploy` within 60 chars of `pendiente`, (2) suppress if an
 * anti-claim particle appears in a 60-char-before window — `salvo`, `no
 * reportar`, `nunca`, etc. — i.e. the prose is teaching what NOT to say.
 *
 * Catches table-cell (`| mc-deploy | PENDIENTE`), property-style
 * (`mc-deploy: PENDIENTE`), header-status (`mc-deploy ⚠️ PENDIENTE — ...`)
 * and bold-prose (`**mc-deploy** está pendiente`) forms. Anti-claim particles
 * (`no reportar "mc-deploy pendiente" salvo que ...`) are correctly NOT
 * matched.
 */
const MC_DEPLOY_NEAR_PENDING_RE = /\bmc-deploy\b[\s\S]{0,60}?\bpendiente\b/i;
const MC_DEPLOY_NEAR_OK_RE = /\bmc-deploy\b[\s\S]{0,60}?\bal\s+d[ií]a\b/i;
const ANTI_CLAIM_PARTICLE_RE =
  /\b(?:salvo|no\s+report\w*|nunca|no\s+afirm\w*|evita|jamás|unless|do\s+not\s+report)\b/i;

function isClaim(content: string, claimRe: RegExp): boolean {
  const m = content.match(claimRe);
  if (!m || m.index === undefined) return false;
  const start = Math.max(0, m.index - 60);
  const end = m.index + m[0].length;
  return !ANTI_CLAIM_PARTICLE_RE.test(content.slice(start, end));
}

export function claimsMcDeployPending(content: string): boolean {
  return isClaim(content, MC_DEPLOY_NEAR_PENDING_RE);
}

export function claimsMcDeployOk(content: string): boolean {
  return isClaim(content, MC_DEPLOY_NEAR_OK_RE);
}

export function decideLevel(reasons: ReadonlyArray<{ level: Level }>): Level {
  if (reasons.some((r) => r.level === "stale")) return "stale";
  if (reasons.some((r) => r.level === "warn")) return "warn";
  return "ok";
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function tryGit(args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function classify(row: Row): Finding {
  const findings: { level: Level; text: string }[] = [];

  const updated = new Date(
    row.updated_at.includes("T") ? row.updated_at : row.updated_at + "Z",
  );
  const ageDays = (Date.now() - updated.getTime()) / 86_400_000;
  if (ageDays > STALE_DAYS) {
    findings.push({
      level: "warn",
      text: `updated_at ${ageDays.toFixed(1)}d ago (>${STALE_DAYS}d threshold)`,
    });
  }

  const fsPath = join(KB_ROOT, row.path);
  if (!existsSync(fsPath)) {
    findings.push({
      level: "stale",
      text: `FS-mirror file missing: ${fsPath}`,
    });
  } else {
    const fsContent = readFileSync(fsPath, "utf8");
    if (sha256(fsContent) !== sha256(row.content)) {
      findings.push({
        level: "warn",
        text: "FS-mirror vs DB content drift (sha256 mismatch)",
      });
    }
  }

  for (const hash of extractHeadClaimHashes(row.content)) {
    const resolved = tryGit(["rev-parse", "--verify", `${hash}^{commit}`]);
    if (!resolved) continue;
    const isAncestor =
      tryGit(["merge-base", "--is-ancestor", hash, "HEAD"]) !== null;
    if (!isAncestor) {
      findings.push({
        level: "stale",
        text: `commit \`${hash}\` is NOT an ancestor of HEAD (unmerged / wrong-branch / rewritten history)`,
      });
      continue;
    }
    const total = Number(
      tryGit(["rev-list", "--count", `${hash}..HEAD`]) ?? "0",
    );
    if (total === 0) continue;
    const srcBehind = Number(
      tryGit(["rev-list", "--count", `${hash}..HEAD`, "--", "src"]) ?? "0",
    );
    if (srcBehind > 0) {
      findings.push({
        level: "stale",
        text: `commit \`${hash}\` is ${total} behind HEAD (${srcBehind} of those touch \`src/\`)`,
      });
    } else if (total >= 10) {
      findings.push({
        level: "warn",
        text: `commit \`${hash}\` is ${total} behind HEAD (no \`src/\` deltas — likely fine but worth a refresh)`,
      });
    }
  }

  // Path-prefix exemption: directive-tier files teach about states by
  // definition (they contain example claims of both kinds), so the
  // dist-mtime claim checks would false-positive on them. Skip the
  // mc-deploy claim detectors for those paths.
  const isDirective = row.path.startsWith("directives/");
  const pendingClaim = !isDirective && claimsMcDeployPending(row.content);
  const okClaim = !isDirective && claimsMcDeployOk(row.content);
  if (pendingClaim || okClaim) {
    const distPath = join(REPO_ROOT, "dist/index.js");
    if (existsSync(distPath)) {
      const distMs = statSync(distPath).mtime.getTime();
      const lastSrcCommitTs = tryGit([
        "log",
        "-1",
        "--format=%ct",
        "--",
        "src",
      ]);
      if (lastSrcCommitTs) {
        const lastSrcMs = Number(lastSrcCommitTs) * 1000;
        if (pendingClaim && distMs > lastSrcMs) {
          findings.push({
            level: "stale",
            text: `claims \`mc-deploy PENDIENTE\` but \`dist/index.js\` mtime ${new Date(distMs).toISOString()} > last \`src/\` commit ${new Date(lastSrcMs).toISOString()}`,
          });
        }
        if (okClaim && distMs < lastSrcMs) {
          findings.push({
            level: "stale",
            text: `claims \`mc-deploy AL DÍA\` but \`dist/index.js\` mtime ${new Date(distMs).toISOString()} < last \`src/\` commit ${new Date(lastSrcMs).toISOString()} — a redeploy is actually pending`,
          });
        }
      }
    } else {
      findings.push({
        level: "warn",
        text: "claims mc-deploy state but `dist/index.js` not found — cannot verify",
      });
    }
  }

  return {
    path: row.path,
    level: decideLevel(findings),
    reasons: findings.map((f) => `[${f.level.toUpperCase()}] ${f.text}`),
  };
}

function renderReport(rows: Row[], findings: Finding[]): string {
  const out: string[] = [];
  out.push(`# Always-read tier staleness audit`);
  out.push(``);
  out.push(`- DB: \`${DB_PATH}\``);
  out.push(`- KB root: \`${KB_ROOT}\``);
  out.push(`- Repo root: \`${REPO_ROOT}\``);
  out.push(`- Stale threshold: \`${STALE_DAYS}d\``);
  out.push(`- Audit time: \`${new Date().toISOString()}\``);
  out.push(`- Rows scanned: ${rows.length}`);
  out.push(``);

  const buckets: Record<Level, Finding[]> = { stale: [], warn: [], ok: [] };
  for (const f of findings) buckets[f.level].push(f);

  out.push(`## Summary`);
  out.push(``);
  out.push(`| Level | Count |`);
  out.push(`|---|---|`);
  out.push(`| STALE | ${buckets.stale.length} |`);
  out.push(`| WARN  | ${buckets.warn.length} |`);
  out.push(`| OK    | ${buckets.ok.length} |`);
  out.push(``);

  for (const tier of ["stale", "warn", "ok"] as Level[]) {
    const items = buckets[tier];
    if (items.length === 0) continue;
    out.push(`## ${tier.toUpperCase()}`);
    out.push(``);
    for (const f of items) {
      out.push(`### \`${f.path}\``);
      if (f.reasons.length === 0) {
        out.push(`(no findings — clean)`);
      } else {
        for (const r of f.reasons) out.push(`- ${r}`);
      }
      out.push(``);
    }
  }

  return out.join("\n");
}

function main(): void {
  if (!existsSync(DB_PATH)) {
    console.error(
      `# ERROR: DB not found at \`${DB_PATH}\`. Set MC_DB_PATH or run from mission-control/.`,
    );
    process.exit(2);
  }
  initDatabase(DB_PATH);
  const db = getDatabase();
  const rows = db
    .prepare(
      `SELECT path, CAST(content AS TEXT) AS content, updated_at, priority
       FROM jarvis_files
       WHERE qualifier='always-read'
       ORDER BY priority DESC, path`,
    )
    .all() as Row[];

  if (rows.length === 0) {
    console.error(
      `# ERROR: 0 always-read rows in \`${DB_PATH}\`. Likely a phantom/empty DB. The real mc.db has >=1 always-read entry (INDEX.md / context-management).`,
    );
    closeDatabase();
    process.exit(2);
  }

  const findings = rows.map(classify);
  console.log(renderReport(rows, findings));

  closeDatabase();
  process.exit(findings.some((f) => f.level === "stale") ? 1 : 0);
}

function resolveRealPathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  resolveRealPathSafe(fileURLToPath(import.meta.url)) ===
    resolveRealPathSafe(process.argv[1]);
if (isMain) main();
