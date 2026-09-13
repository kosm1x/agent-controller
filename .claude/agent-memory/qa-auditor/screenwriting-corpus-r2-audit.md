# Screenwriting corpus adoption — R2 (fold verification), 2026-09-12

Bundle: `seed/knowledge/screenwriting/` (15 docs), `seed/skills/{5}/SKILL.md` v1.1.0,
`scripts/seed-screenwriting.ts`, `src/skills/test-sweep.ts` + `test-runner.ts`, 3 planning docs.
R1 = 3 lenses (A skills-as-contracts FAIL, B seed-script, C authored-docs FAIL). R2 verdict: **PASS-WITH-NOTES**, 0 Critical, 5 Warnings.

## Verified green
tsc exit 0 / 0 errors · `src/skills/test-{sweep,runner}.test.ts` 19/19 · 16/16 live certification
(skill_test_runs 2026-09-12 23:41–23:43, max duration 17,905 ms vs the 26,490 ms that triggered R1-A-C1) ·
15 `jarvis_files` rows under `knowledge/screenwriting/` (qualifier `reference`, priority 50) + FS mirror ·
5 skills v1.1.0 critic_verdict=pass, 6144-byte embeddings · registered bodies byte-identical to disk ·
all 5 empty-string INPUT_REQUIRED fixtures pass `validateSkillArgs` AND the body rejects them live ·
doc 13 §2 table ≡ skill step 4 budgets (6 rows, identical) · doc 14 per-beat 4-5/7-8/7-8/10-12/5-6 sums to exactly 33–39 ·
doc 14 families ≡ promo-video-agent `docs/PLAN.md:125` (cinematic/promo/briefing/training) ·
CJK regex matches han/kana/hangul/fullwidth/ideographic-space, no FP on `· – — ≤ → ’` or Spanish accents ·
gate query index-covered (`idx_skill_test_runs_skill`) and byte-identical to the phase-5 original ·
no bare `NN-name.md` in KB docs or skills (16 remaining are plan-internal file listings); zero `knowledge/screenwriting/knowledge/`.

## Doctrine crumbs (the transferable ones)

- **`length()` in SQLite counts CHARACTERS, not bytes.** A "registered body ≠ disk file" alarm
  (10369 vs 10195) was pure UTF-8: em-dashes and `·`. Diff the CONTENT before reporting drift.
- **A src-code fold can ship 100% unpinned while the suite is green.** Neither test file names
  `timeoutMs`/`maxTokens`/`SWEEP_TEST_TIMEOUT_MS`/`TEST_MAX_TOKENS`, and neither asserts the mocked
  `infer` call args (0 `toHaveBeenCalledWith` in both). Grep the TEST for the constant, not the src.
- **A defense-in-depth fold can be inert on the live provider.** `maxTokens: 4096` only reaches the
  OpenAI-compat path; `INFERENCE_PRIMARY_PROVIDER=claude-sdk` is live (journal 172×) and
  `src/inference/claude-sdk.ts` has ZERO `max_tokens` references. Pre-fold runs at the 1024 default passed.
  Corollary: the queue's "without this deploy the skill is decertified on the first tick" was false on both counts.
- **Measure "does this change retrieval?" instead of speculating.** `composeEmbeddingText` =
  description + trigger_examples.join("\n"), so 2 added Spanish examples are ~1/3 of the trigger text.
  Measured against the live 0.4 `DEFAULT_MIN_SIMILARITY`: EN queries −0.003..−0.027, ES queries
  +0.014..+0.033, every live score 0.57–0.78. Verdict: real gain, no threshold risk. ~15 embed calls, no DB writes.
- **A rule qualified in the prose can stay unqualified in the CHECKLIST.** doc 13 §2 line 32 got the
  "below 20 s" carve-out; §9 Q4/Q5 (lines 108-109) did not — and §9 is what an agent actually applies.
  When a fold qualifies a threshold, grep for EVERY restatement of that number in the same file.
- **A relaxed cap must be checked against the SMALLEST row it now admits.** "hook ≤ 15% below 20 s"
  still fails the 6 s budget's own `hook 0–1` (16.7%). The relaxation was sized for 15 s and never replayed at 6 s.
- **A spelling/style rule that names its own scope is checkable.** 00-index.md:36 says the skills use
  US spelling; 6 British spellings survive in 4 of 5 skills — two of them inside the EMBEDDED text
  (a `description` and a `trigger_examples` entry).
- Verdict-rule folds close GAPS and open OVERLAPS: logline step 7 `pass` (≤1 PROBLEM fails) and
  `revise` ("one to four … fail") both match at exactly one failure. Order resolves it; the wording should.
