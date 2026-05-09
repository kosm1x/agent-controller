/**
 * NorthStar INDEX.md renderer — compass narrative.
 *
 * Operator directive 2026-05-09 (friction-pickup #3): NorthStar should be a
 * compass, not a backlog. INDEX.md was previously a flat per-kind list
 * ("## Visions (2) … ## Tasks (4)"). That rendering treats every record as
 * equal weight and buries the strategic framing under task-grain noise.
 *
 * The compass format walks the parent chain (vision → goal → objective →
 * task), groups records under their parent, and orders by status (active
 * first, completed at the bottom). Records whose parent doesn't resolve on
 * COMMIT fall into a "Sin parent" footer block — visible but de-emphasized.
 *
 * The post-sync local state remains the source of truth (matches the
 * pre-2026-05-09 contract): if a record was deleted in this sync run it is
 * absent from the render, and the local `Status:` / `Priority:` lines are
 * the fallback when COMMIT data is missing for a known commitId (mid-sync
 * race or app-side delete that hasn't propagated).
 */

// Inlined to avoid a circular import with northstar-sync.ts (which imports
// this module's renderer). The two helpers are 6 lines combined; sharing
// them via a third file is more refactor than the renderer needs.
function extractField(content: string, field: string): string | null {
  // `[ \t]*` not `\s*` — `\s` includes `\n` and would swallow the next line.
  const match = content.match(new RegExp(`^${field}:[ \\t]*(.+)$`, "mi"));
  return match ? match[1].trim() : null;
}

function extractTitle(content: string): string | null {
  const m = content.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

export interface IndexLocalEntry {
  path: string;
  commitId: string;
  content: string;
}

export interface IndexCommitItem {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  vision_id?: string | null;
  goal_id?: string | null;
  objective_id?: string | null;
}

export type IndexKind = "vision" | "goal" | "objective" | "task";

const STATUS_ORDER: ReadonlyArray<string> = [
  "in_progress",
  "blocked",
  "on_hold",
  "not_started",
  "completed",
  "done",
];

function statusBadge(status: string): string {
  switch (status) {
    case "in_progress":
      return "📍";
    case "blocked":
    case "on_hold":
      return "🚫";
    case "completed":
    case "done":
      return "✅";
    case "not_started":
      return "⏸";
    default:
      return "•";
  }
}

interface Display {
  title: string;
  status: string;
  priority: string;
  path: string;
  commitId: string;
  /** True when commit data was missing for this commitId — title/status came
   * from the local file, not COMMIT. Surfaced as `[unsynced]` so a partial
   * Phase-4 failure that left a stale local file can't render as a normal
   * entry. */
  unsynced: boolean;
}

/** Escape `[` and `]` in user-supplied text so a title like "FX trade [WIP]"
 * doesn't break the surrounding `[label](path.md)` Markdown link. Backslash
 * is also escaped to preserve any deliberate Markdown the user typed. */
function escMd(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[\[\]]/g, "\\$&");
}

/** Build the `— status (priority)` suffix used in headings and bullets. Keeps
 * level templates symmetric so a status-less or priority-less record renders
 * identically across kinds. */
function metaSuffix(d: Display): string {
  const status = d.status ? ` — ${d.status}` : "";
  const prio = d.priority ? ` (${d.priority})` : "";
  return status + prio;
}

function statusRank(s: string): number {
  const idx = STATUS_ORDER.indexOf(s);
  // Unknown statuses sort after the known ones; preserves alphabetical
  // ordering within the unknown block.
  return idx === -1 ? STATUS_ORDER.length : idx;
}

/**
 * Render NorthStar/INDEX.md as a compass narrative.
 *
 * @param locals Post-sync local entries grouped by kind. The renderer
 *   reflects exactly this state — records the sync just deleted MUST NOT
 *   appear in any group passed in.
 * @param commits COMMIT data grouped by kind. Used to resolve titles,
 *   statuses, and parent_id chains.
 * @param meta Sync-run metadata (bootstrap flag, totalListed count) for
 *   the trailing footer.
 */
export function renderCompassIndex(
  locals: Record<IndexKind, IndexLocalEntry[]>,
  commits: Record<IndexKind, Map<string, IndexCommitItem>>,
  meta: { bootstrap: boolean; totalListed: number; syncedAt: string },
): string {
  const asDisplay = (entry: IndexLocalEntry, kind: IndexKind): Display => {
    const commit = commits[kind].get(entry.commitId);
    // Mark as unsynced if commit data is missing for a known commitId. The
    // renderer prefixes such entries with `[unsynced]` so a partial Phase-4
    // failure that left a stale local file can't render as a normal entry.
    // Empty commitId (local-new file mid-sync) does NOT count as unsynced —
    // it's a transient pre-push state, not a stale post-delete one.
    const unsynced = !commit && entry.commitId.length > 0;
    return {
      title: commit?.title ?? extractTitle(entry.content) ?? "(untitled)",
      status: commit?.status ?? extractField(entry.content, "Status") ?? "",
      priority:
        commit?.priority || extractField(entry.content, "Priority") || "",
      path: entry.path,
      commitId: entry.commitId,
      unsynced,
    };
  };

  // Marker shown next to records whose commit data is missing — see asDisplay.
  const unsyncedTag = (d: Display) => (d.unsynced ? " `[unsynced]`" : "");

  const sortByStatusThenTitle = (
    entries: IndexLocalEntry[],
    kind: IndexKind,
  ): IndexLocalEntry[] => {
    return [...entries].sort((a, b) => {
      const da = asDisplay(a, kind);
      const db = asDisplay(b, kind);
      const ra = statusRank(da.status);
      const rb = statusRank(db.status);
      if (ra !== rb) return ra - rb;
      return da.title.toLowerCase().localeCompare(db.title.toLowerCase());
    });
  };

  const lines: string[] = ["# NorthStar — La Brújula", ""];

  const visions = sortByStatusThenTitle(locals.vision, "vision");

  // Track which records the narrative-walk emits so the orphan footer can
  // surface anything that wasn't reachable from any vision. This catches
  // records whose parent_id points to a commit no longer in `commits`
  // (mid-sync race) without the renderer needing to also walk parent
  // titles or filenames.
  const emitted = new Set<string>();

  if (visions.length === 0) {
    lines.push(
      "_Sin visiones registradas. Agrega una en NorthStar/visions/ para activar la brújula._",
    );
    lines.push("");
  } else {
    for (const v of visions) {
      const vd = asDisplay(v, "vision");
      lines.push(
        `## ${statusBadge(vd.status)} ${escMd(vd.title)}${unsyncedTag(vd)}`,
      );
      lines.push(`*[Visión](${vd.path})${metaSuffix(vd)}*`);
      lines.push("");
      emitted.add(v.commitId);

      const visionGoals = locals.goal.filter((g) => {
        const gc = commits.goal.get(g.commitId);
        return gc?.vision_id === v.commitId;
      });

      if (visionGoals.length === 0) {
        lines.push("_Sin metas activas bajo esta visión._");
        lines.push("");
        continue;
      }

      for (const g of sortByStatusThenTitle(visionGoals, "goal")) {
        const gd = asDisplay(g, "goal");
        lines.push(
          `### ${statusBadge(gd.status)} ${escMd(gd.title)}${metaSuffix(gd)}${unsyncedTag(gd)}`,
        );
        lines.push(`*[Meta](${gd.path})*`);
        emitted.add(g.commitId);

        const goalObjectives = locals.objective.filter((o) => {
          const oc = commits.objective.get(o.commitId);
          return oc?.goal_id === g.commitId;
        });

        for (const o of sortByStatusThenTitle(goalObjectives, "objective")) {
          const od = asDisplay(o, "objective");
          lines.push(
            `- ${statusBadge(od.status)} **[${escMd(od.title)}](${od.path})**${metaSuffix(od)}${unsyncedTag(od)}`,
          );
          emitted.add(o.commitId);

          const objectiveTasks = locals.task.filter((t) => {
            const tc = commits.task.get(t.commitId);
            return tc?.objective_id === o.commitId;
          });

          for (const t of sortByStatusThenTitle(objectiveTasks, "task")) {
            const td = asDisplay(t, "task");
            lines.push(
              `  - ${statusBadge(td.status)} [${escMd(td.title)}](${td.path})${metaSuffix(td)}${unsyncedTag(td)}`,
            );
            emitted.add(t.commitId);
          }
        }
        lines.push("");
      }
    }
  }

  // Orphan footer — anything not reached by the narrative walk. Includes
  // records with no parent_id (allowed for tasks; flag-worthy for goals
  // and objectives) plus records whose parent commit is missing.
  const orphanGoals = locals.goal.filter((g) => !emitted.has(g.commitId));
  const orphanObjectives = locals.objective.filter(
    (o) => !emitted.has(o.commitId),
  );
  const orphanTasks = locals.task.filter((t) => !emitted.has(t.commitId));

  if (orphanGoals.length + orphanObjectives.length + orphanTasks.length > 0) {
    lines.push("## Sin parent");
    lines.push("");
    // Order: goals, then objectives, then tasks. The kind sequence is
    // operator-visible — tests pin it (`renderCompassIndex — orphan footer`)
    // so a future loop reordering doesn't silently flip the rendered list.
    for (const g of sortByStatusThenTitle(orphanGoals, "goal")) {
      const gd = asDisplay(g, "goal");
      lines.push(
        `- ${statusBadge(gd.status)} **Meta**: [${escMd(gd.title)}](${gd.path})${metaSuffix(gd)}${unsyncedTag(gd)}`,
      );
    }
    for (const o of sortByStatusThenTitle(orphanObjectives, "objective")) {
      const od = asDisplay(o, "objective");
      lines.push(
        `- ${statusBadge(od.status)} **Objetivo**: [${escMd(od.title)}](${od.path})${metaSuffix(od)}${unsyncedTag(od)}`,
      );
    }
    for (const t of sortByStatusThenTitle(orphanTasks, "task")) {
      const td = asDisplay(t, "task");
      lines.push(
        `- ${statusBadge(td.status)} **Tarea**: [${escMd(td.title)}](${td.path})${metaSuffix(td)}${unsyncedTag(td)}`,
      );
    }
    lines.push("");
  }

  lines.push(
    `---\nLast sync: ${meta.syncedAt}\nMode: ${meta.bootstrap ? "bootstrap (no deletes)" : "LWW (deletes propagated)"}\nLocal records: ${meta.totalListed}\nSource of truth: local NorthStar files (post-sync). Run northstar_sync to reconcile with db.mycommit.net.`,
  );

  return lines.join("\n");
}
