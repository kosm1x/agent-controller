---
name: verification-claims-need-the-live-store
description: A log or status doc saying artifacts were "registered"/"deleted" must be checked against the live store (jarvis_files, filesystem) before it counts as done.
metadata:
  type: feedback
---

A completion/verification log is a claim about the world. Check the world.

**Why:** 2026-09-12 screenwriting audit — `docs/planning/screenwriting-distill-log.md` stated the KB docs were registered via `seed-screenwriting.ts MODE=kb` and that the Chinese source clone was "deleted after this pass". Live: `SELECT count(*) FROM jarvis_files WHERE path LIKE 'knowledge/screenwriting/%'` = 0 (the five skills WERE registered and certified), and the clone was still in the session scratchpad. The log also pointed at a PROJECT-STATUS entry that did not exist.

**How to apply:** for every "registered / deployed / deleted / certified" sentence, run the cheapest live probe — `sqlite3 -readonly data/mc.db` count on the target path prefix, `ls -d` on the path claimed deleted, grep the doc claimed updated. Report the query and its result in the finding.

Related: [[authored-doc-citation-is-a-claim]]
