# Agent Learnings — mission-control (Jarvis)

## Standing rules
- Measure demand in mc.db before rating any external capability for Jarvis. Examples: 1 voice note since 06-25 (so R2T2 streaming ASR is no use); 0 `seo_*` calls in 30 days (so open-seo is no use).
- `task_trace_events` keeps only ~30 days. For longer horizons use `scope_telemetry` (from 2026-06-25). Run `.tables` + `pragma table_info(<t>)` before the first query.
- Group activation is not usage. `active_groups LIKE '%seo%'` hit only broad turns that switch every group on, so print sample rows before counting activation as demand.
- For a threshold re-tune, first reproduce the registered replay number from STORED answers, then walk forward. A fixed threshold that drifts does not mean periodic re-tuning helps: the Jev scope 0.70 walk-forward gave 92.6 % vs 92.0 % fixed, +2 turns of 299.
- Check whether a grid-search pick sits on the grid edge before trusting it.
- Replay/result files that carry user message text are sensitive: delete them when the readout closes, then check the backup paths too (`scripts/backup-state-bundle.sh` bundles only named `data/` subdirs).
- For a "no demand today" verdict, write a trigger-gated findings doc (e.g. `docs/planning/seo-capability-findings-2026-09-23.md`) so a later step-up starts from facts.

## 2026-09-23 — Jev walk-forward, open-seo, R2T2 (Jarvis side)
- **Mistake:** `pkill -f <pattern>` inside a compound Bash command matched its own shell and killed it (exit 144) → `pgrep -f` first, then `kill <pid>` in a separate call.
- **Mistake:** deleted a reviewed clone right after the verdict, then had to re-clone it for the findings doc → keep review clones in the scratchpad until the session ends.
- **Avoid:** putting `git` and `grep` in the same Bash command. The hook-bypass guard scans the whole string → run git commands alone.
- **Better:** voice-note transcription (`src/inference/transcription.ts`) is batch and Whisper-compatible, and almost unused. Check that call site first before probing any new ASR for Jarvis. Pipesong is the only streaming consumer.

## 2026-09-24 — Jarvis PR review (#37, #33 closed; #32 redone as 9d825dd)
- **Mistake:** rewrote the nanoclaw env-note guard around the incident's "read-only mc.db mount" without re-reading today's mount list; SEC-02 (4b353ac) had removed that mount, so the guard stated a false fact (qa R1 FAIL) → before writing any prompt text about the sandbox, read `nanoclaw-runner.ts` volumes + `MC_DB_PATH` on the CURRENT base, not the incident report.
- **Mistake:** put a review worktree under the scratchpad; `shell.test.ts` resolves `cd ..` against the real FS, so the pre-commit full suite failed there only → create temporary worktrees beside the main checkout (`/root/claude/<name>-tmp`) and remove them after the push.
- **Avoid:** reviewing a Jarvis PR on its own base. Check `git rev-list --count <branch>..origin/main`, trial-merge with `git merge-tree`, and replay its test inputs on main: #32's classifier rule was already redundant (5c279d0), #37's hunk re-added code main had removed.
- **Better:** measure each PR's premise in live data before judging the code: request rate vs the vendor limit (#37: 1/15 min vs 1/5 s), whether the configured ID still exists (#33: schedule recreated 09-23), and whether the incident has recurred (#32: 0 in 30 days).
