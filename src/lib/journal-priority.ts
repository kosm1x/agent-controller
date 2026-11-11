/**
 * Journal priority for console.error / console.warn.
 *
 * The service unit sends stderr to the journal with `SyslogLevelPrefix=yes`:
 * a line starting with `<3>` is stored at priority "err", `<4>` at "warning",
 * and journald strips the prefix. Without it every console line is stored at
 * "info" and a priority filter on the journal shows nothing.
 *
 * Installs only when stderr IS the journal stream (`JOURNAL_STREAM` names the
 * device:inode of fd 2), so a terminal, a pipe or a test runner keep plain
 * output. Every line of a multi-line message gets the prefix, because journald
 * stores each line as its own record. console.log/info/debug are untouched.
 */

import { fstatSync } from "fs";
import { format } from "util";

type ConsoleFn = (...args: unknown[]) => void;

interface PriorityTarget {
  error: ConsoleFn;
  warn: ConsoleFn;
}

export interface JournalPriorityDeps {
  env?: Record<string, string | undefined>;
  fstat?: (fd: number, opts: { bigint: true }) => { dev: bigint; ino: bigint };
  target?: PriorityTarget;
}

/** Marks a wrapped method, shared across module copies, so a second install is a no-op. */
const WRAPPED = Symbol.for("mission-control.journal-priority");

function stderrIsJournal(
  env: Record<string, string | undefined>,
  fstat: NonNullable<JournalPriorityDeps["fstat"]>,
): boolean {
  const m = /^(\d+):(\d+)$/.exec(env.JOURNAL_STREAM ?? "");
  if (!m) return false;
  const st = fstat(2, { bigint: true });
  return st.dev === BigInt(m[1]!) && st.ino === BigInt(m[2]!);
}

function wrap(target: PriorityTarget, key: "error" | "warn", prefix: string): void {
  const original = target[key];
  if ((original as unknown as Record<symbol, unknown>)[WRAPPED]) return;
  const wrapped: ConsoleFn = (...args) => {
    let line: string;
    try {
      line = format(...args)
        .split("\n")
        .map((l) => prefix + l)
        .join("\n");
    } catch {
      // Formatting failed: hand the arguments over unchanged, as before.
      return original.apply(target, args);
    }
    return original.call(target, line);
  };
  (wrapped as unknown as Record<symbol, unknown>)[WRAPPED] = true;
  target[key] = wrapped;
}

/** Route console.error to priority "err" and console.warn to "warning". Never throws. */
export function installJournalPriority(deps: JournalPriorityDeps = {}): void {
  try {
    const env = deps.env ?? process.env;
    const fstat = deps.fstat ?? ((fd, opts) => fstatSync(fd, opts));
    const target = deps.target ?? console;
    if (!stderrIsJournal(env, fstat)) return;
    wrap(target, "error", "<3>");
    wrap(target, "warn", "<4>");
  } catch {
    // A failed check leaves plain output; logging setup must never stop boot.
  }
}
