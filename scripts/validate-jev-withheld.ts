/**
 * Why the live scope path withholds turns from Jev — rule names per text
 * part, never text. `jev_shadow` scope rows keep no ref, so the last N days
 * of router exchanges (`conversations`, source router, `User: …\nJarvis: …`)
 * are replayed in channel order through `withholdReasons` on the same two
 * texts the classifier filters: the message, and the previous Jarvis reply
 * (the whole turn behind it). Approximate on purpose: fast-path and
 * intercepted exchanges are persisted but never classified, thread history
 * expires while the replay's does not, the replay keys a channel by its first
 * tag where the live thread is channel + sender (group senders interleave), a
 * user text holding a literal `\nJarvis: ` splits early, after a poisoned
 * exchange the live turn behind is the previous USER text (the router drops
 * the reply; 0.7 % of turns), the live 150-char context cut manufactures
 * line ends that `bare_token` fires on (0.3 % of turns), and
 * `normalizeForMatching` and the structural "context with no whole turns
 * behind it" branch are not replayed — so the shares differ from what
 * `jev_shadow` recorded (printed beside them); the RULE mix is the answer.
 *
 *   npx tsx scripts/validate-jev-withheld.ts [--days 7]
 */

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseExchange,
  PARTS,
  tallyWithholds,
  type Exchange,
} from "../src/jev/withheld-replay.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const daysArg =
  args.indexOf("--days") >= 0 ? args[args.indexOf("--days") + 1] : undefined;
const days =
  daysArg !== undefined &&
  Number.isFinite(Number(daysArg)) &&
  Number(daysArg) > 0
    ? Number(daysArg)
    : 7;

const db = new Database(join(ROOT, "data/mc.db"), {
  readonly: true,
  fileMustExist: true,
});
const rows = db
  .prepare(
    `SELECT tags, content FROM conversations
     WHERE source = 'router' AND created_at >= datetime('now', ?)
     ORDER BY created_at, id`,
  )
  .all(`-${days} days`) as { tags: string; content: string }[];
const recorded = db
  .prepare(
    `SELECT date(created_at) AS day, SUM(item = 'answered') AS answered,
            SUM(item = '_withheld') AS withheld
     FROM jev_shadow WHERE consumer = 'scope' AND created_at >= datetime('now', ?)
     GROUP BY 1 ORDER BY 1`,
  )
  .all(`-${days} days`) as {
  day: string;
  answered: number;
  withheld: number;
}[];
db.close();

let unparsed = 0;
const exchanges: Exchange[] = [];
for (const r of rows) {
  const parsed = parseExchange(r.content);
  if (!parsed) {
    unparsed++;
    continue;
  }
  let channel = "unknown";
  try {
    const tags: unknown = JSON.parse(r.tags);
    if (Array.isArray(tags) && typeof tags[0] === "string") channel = tags[0];
  } catch {
    // keep "unknown"
  }
  exchanges.push({ channel, ...parsed });
}
const t = tallyWithholds(exchanges);
const pct = (n: number, of: number): string =>
  of > 0 ? `${((n / of) * 100).toFixed(1)} %` : "n/a";

console.log(
  `Scope withhold replay — last ${days} days, ${rows.length} router exchanges (${unparsed} unparsed)\n`,
);
console.log(
  `Replayed: ${t.turns} turns, ${t.withheld} withheld (${pct(t.withheld, t.turns)}); context alone withheld ${t.contextOnly}`,
);
console.log(
  `By part (turns where that part fires): ${PARTS.map((p) => `${p} ${t.byPart[p]}`).join(" · ")}\n`,
);
console.log(`rule            ${PARTS.map((p) => p.padStart(12)).join("")}`);
for (const [rule, parts] of Object.entries(t.byRule).sort(
  (a, b) =>
    PARTS.reduce((s, p) => s + b[1][p], 0) -
    PARTS.reduce((s, p) => s + a[1][p], 0),
))
  console.log(
    `${rule.padEnd(16)}${PARTS.map((p) => String(parts[p]).padStart(12)).join("")}`,
  );

console.log(`\nRecorded by jev_shadow (scope):`);
for (const r of recorded)
  console.log(
    `  ${r.day}  answered ${r.answered}  withheld ${r.withheld}  (${pct(r.withheld, r.answered + r.withheld)})`,
  );
