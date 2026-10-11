/**
 * S6 item 3c (audit R1 W3, R2 W6): the benchmark harnesses copy mc.db + WAL
 * into MC_BENCH_SCRATCH and write results to --out. Both must lie under the
 * repo's data/ (gitignored, operator-owned), whatever the operator gate
 * decides. Every component is lstat'ed: a symlink anywhere on the path (a
 * dangling one included) is refused, and so is a missing parent: only the
 * leaf may be new.
 */

import { lstatSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

export const REPO_DATA = "/root/claude/mission-control/data";

/** True when `p` (whose leaf may not exist yet) lies under REPO_DATA with no symlink on its path. */
export function isUnderRepoData(p: string, dataDir: string = REPO_DATA): boolean {
  const abs = resolve(p);
  const parts = abs.split(sep).filter(Boolean);
  let head = "";
  for (const [i, part] of parts.entries()) {
    head = `${head}${sep}${part}`;
    const st = lstatSync(head, { throwIfNoEntry: false });
    if (!st) {
      if (i !== parts.length - 1) return false;
    } else if (st.isSymbolicLink()) {
      return false;
    }
  }
  return abs.startsWith(`${realpathSync(dataDir)}/`);
}
