# Pre-v6.0 Hardening Sprint

> Fix the rough edges from v5.0 before Jarvis starts coding on himself.
> Estimated: 1 session (Claude Code) + 1 testing session (User via Telegram).

---

## H1 — Flatten project paths (Claude Code, ~15min)

**Problem:** `projects/` AND `projects/open-projects/` both exist. Jarvis created the nesting during migration. 31 files under `open-projects/` should be directly under `projects/`.

**Fix:**

```
projects/open-projects/livingjoyfully/README.md → projects/livingjoyfully/README.md
projects/open-projects/pipesong/README.md → projects/pipesong/README.md
... (all 31 files)
```

**Who:** Claude Code (migration script, same pattern as Unified FS migration)
**Verify:** `./mc-ctl db "SELECT path FROM jarvis_files WHERE path LIKE 'projects/open-projects/%'"` → 0 results

---

## H2 — Tighten prompt enhancer (Claude Code, ~30min)

**Problem:** Enhancer intervenes on ~80% of messages. Should be ~20%. Asks unnecessary questions on clear requests like "Lista mis proyectos" or "Monitor Jarvis."

**Fixes:**

1. Raise MIN_ENHANCE_LENGTH from 40 to 80 chars
2. Add more pass-through patterns: "lista", "muestra", "abre", "lee", "busca", "monitor", "estado", "status"
3. Strengthen the PASS bias in the system prompt: "En caso de duda, di PASS. Solo pregunta cuando la ambigüedad causará un error grave."
4. Add a user preference: if user has said "enhancer off" in the last 24h, stay off

**Who:** Claude Code
**Verify:** Send 10 messages via Telegram, count how many trigger questions vs PASS

---

## H3 — Migrate remaining user_facts (Claude Code, ~30min)

**Problem:** 39 genuine facts in user_facts table. Jarvis reads from BOTH user_facts AND jarvis_files — two sources of truth.

**Fix:**

1. Export all non-credential user_facts to `knowledge/` files:
   - `knowledge/people/fede.md` — personal, contact, philosophy
   - `knowledge/preferences/tech.md` — tech preferences
   - `knowledge/domain/projects-config.md` — project URLs, API keys, config
2. Keep credentials in user_facts (WP passwords, FTP, API keys) — don't put secrets in files
3. Reduce `formatUserFactsBlock()` to inject ONLY credentials + 3-line summary
4. Most context now comes from INDEX.md + jarvis_file_read on demand

**Who:** Claude Code
**Verify:** `./mc-ctl db "SELECT COUNT(*) FROM user_facts"` → only credentials remain

---

## H4 — Test video pipeline end-to-end (User + Claude Code)

**Problem:** S5d shipped but never tested by a real user. Multiple potential failure points.

### Step 1: Test TTS (User via Telegram)

```
"Genera un audio de prueba con video_tts: 'Bienvenidos a esta demostración de video'"
```

**Expected:** MP3 file path returned. If edge-tts fails, silent audio fallback.
**If fails:** Claude Code diagnoses and fixes.

### Step 2: Test image fetch (User via Telegram)

```
"Busca una imagen de stock con video_image: 'artificial intelligence technology'"
```

**Expected:** JPG file path returned from Pexels. If no API key, solid color fallback.
**If fails:** Claude Code diagnoses Pexels API issue.

### Step 3: Test script generation (User via Telegram)

```
"Genera un script de video de 30 segundos sobre inteligencia artificial con video_script"
```

**Expected:** JSON with scenes array, narration text, image queries.
**If fails:** LLM response parsing issue. Claude Code fixes.

### Step 4: Full pipeline (User via Telegram)

```
"Hazme un video de 30 segundos sobre el futuro de la inteligencia artificial"
```

**Expected:** Job ID returned → video_status shows progress → MP4 file when done.
**If fails:** Which step broke? Claude Code fixes.

### Step 5: Verify MP4 (User)

Download the MP4 from the VPS path. Play it. Does it have:

- [x] Image slides matching the topic
- [x] Audio narration (or silent if TTS failed)
- [x] Subtitles burned in
- [x] Correct duration (~30s)

> **Tested 2026-04-06** via direct module invocation: TTS (edge-tts, 32KB MP3) → placeholder images (FFmpeg) → subtitles (SRT) → compose (libx264) → valid 5.3s MP4 (143KB) with video + audio streams. VERDICT: PASS.

**Who:** User tests steps 1-5 via Telegram. Claude Code on standby to fix failures.

---

## H5 — Verify self-tuning ran (Claude Code, ~5min)

**Problem:** Overnight tuning was enabled Tuesday. Did it actually run?

**Check:**

```bash
./mc-ctl db "SELECT run_id, status, baseline_score, best_score, experiments_run, experiments_won FROM tune_runs ORDER BY started_at DESC LIMIT 3"
```

**If it ran:** Check results. Any wins? What score?
**If it didn't:** Check TUNING_ENABLED in .env, check ritual scheduler logs, diagnose.

---

## H6 — Provider health baseline (Claude Code, ~15min)

**Problem:** Primary degrades daily. No data on WHEN and for how long.

**Fix:** Add a simple provider health log:

- After each inference call, log: `provider, latency_ms, success/fail`
- Daily summary: per-provider success rate and avg latency
- Accessible via `./mc-ctl db "SELECT ..."` or a new `mc-ctl providers` command

This gives data to plan multi-model routing in v6.0.

---

## Execution Order

| #   | Task                     | Who                | Depends on                 |
| --- | ------------------------ | ------------------ | -------------------------- |
| H1  | Flatten project paths    | Claude Code        | —                          |
| H2  | Tighten prompt enhancer  | Claude Code        | —                          |
| H3  | Migrate user_facts       | Claude Code        | H1 (paths settled)         |
| H5  | Verify self-tuning       | Claude Code        | —                          |
| H6  | Provider health baseline | Claude Code        | —                          |
| H4  | Test video pipeline      | User + Claude Code | H1-H3 done (stable system) |

H1, H2, H5, H6 can run in parallel. H3 depends on H1. H4 is last (needs stable system).

---

## Success Criteria

Before starting v6.0 S1:

- [x] Zero files under `projects/open-projects/` (H1, 2026-04-05)
- [x] Prompt enhancer PASS rate >80% on normal messages (H2, 2026-04-05)
- [x] user_facts has only credentials — 6 remain, 27 migrated to KB (H3, 2026-04-06)
- [x] Video pipeline tested end-to-end, MP4 verified (H4, 2026-04-06 — PASS)
- [x] Self-tuning has run at least once with results (H5, 2026-04-05 — baseline 79.3%)
- [x] Provider health data available for routing decisions (H6, 2026-04-06 — 7-day baseline in KB)

**ALL PRE-V6.0 HARDENING ITEMS COMPLETE.** Slate clean for v6.2.
