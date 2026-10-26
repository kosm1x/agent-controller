/**
 * Drain what upsertFile leaves running, for short-lived operator scripts that
 * close the database right after writing (scripts/kb-rewrite-denue-psql.ts,
 * scripts/kb-import-from-disk.ts, scripts/reindex-jarvis-kb.ts).
 *
 * upsertFile starts a pgvector sync and a Drive sync that outlive the call (a
 * Drive CREATE maps its new file id into sqlite only after the upload; closing
 * first left a Drive file unmapped on 2026-10-20) and sets the INDEX.md mark
 * through a dynamic import that lands an unknown number of ticks later. So the
 * index is regenerated UNCONDITIONALLY here (idempotent) instead of trusting a
 * pending timer, and any mark is cancelled before and after; INDEX.md's own
 * upsert starts syncs too, hence the second settle. Call it only when the run
 * wrote at least one row, and before closeDatabase().
 */

import { settlePgvectorSyncs } from "./pgvector-sync.js";
import { settleDriveSyncs } from "./drive-sync.js";
import { cancelPendingRegeneration, regenerateIndex } from "./jarvis-index.js";

export type KbWriteDrainDeps = {
  settlePgvectorSyncs: () => Promise<void>;
  settleDriveSyncs: () => Promise<void>;
  regenerateIndex: () => void;
  cancelPendingRegeneration: () => void;
};

const realDeps: KbWriteDrainDeps = {
  settlePgvectorSyncs,
  settleDriveSyncs,
  regenerateIndex,
  cancelPendingRegeneration,
};

export async function drainKbWrites(deps: KbWriteDrainDeps = realDeps): Promise<void> {
  await deps.settlePgvectorSyncs();
  await deps.settleDriveSyncs();
  deps.cancelPendingRegeneration();
  deps.regenerateIndex();
  await deps.settlePgvectorSyncs();
  await deps.settleDriveSyncs();
  deps.cancelPendingRegeneration(); // a mark that landed while settling
}
