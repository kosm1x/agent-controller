# Screenwriting corpus adoption — plan (2026-09-12)

**Status:** SHIPPED 2026-09-12c (Phases 1–3 + 5 done; Phase 4 eval and the live retrieval probe are operator steps — queue §2026-09-12c). Deviations: docs 08/10 accepted over cap; `self_check` returns flags only; `length_s` rounds instead of erroring; skill names kept as noun phrases pending an operator decision.
**Source:** https://github.com/jtydhr88/screenwriting-skills (v2.0.0, 21 skills, Chinese bodies, 32 craft books)
**Goal:** Jarvis writes good English-language scripts and screen content — first for solera.properties and Meridian Bariatrics (short-form commercial), later for broadcaster promo and series/feature development.

---

## 1. What we found (verified 09-12)

| Fact | Consequence |
|---|---|
| Skill bodies are Chinese (137k CJK chars vs 54k Latin); output language follows the question by author policy | Unauditable by us as-is; a distillation into English is the only reviewable form |
| Jarvis loader (`src/skills/frontmatter.ts`) requires `version`, `output_type`, ≥3 `trigger_examples`, `tools_used`, `inputs_json`, `tests_json` | The 21 files cannot be registered as Jarvis skills; they are craft knowledge, not executable procedures |
| KB `knowledge/` holds 150 docs, largest 20,442 bytes; retrieval via FTS + embeddings (`knowledge_map` is a concept map, not a file index) | Target ≤ ~16 KB per doc (revised 09-12: 08 landed at 21 KB and 10 at 15 KB, accepted in the distill log; the pgvector embedding covers only the first 8,000 chars of any doc); register via `upsertFile` (FS edits never reach `jarvis_files` — [[kb-mirror]]) |
| Jarvis skill registry: 5 skills, all Spanish, test-runner certification, activation gate ≥5 certified (spec §14) | New skills follow the same contract: structured output, `tests_json`, certification before activation |
| No Spanish/LatAm layer; no short-form ad/commercial layer (author explicitly excludes short-form) | Both are ours to write; the corpus supplies the craft underneath |
| License "for personal study use"; bodies quote copyrighted books | We distill METHOD (principles, checklists, tests) in our own words; no verbatim quotations land in the KB |
| 11 of 21 skills are English-origin craft; 10 are Chinese opera/series practice, Ozu, Chekhov, Japanese, Korean-French, American/series case-study tables | Adopt the 11, skip the 10 (case studies revisit later if series work materialises) |

## 2. Scope

**In**: 7 general-dramaturgy skills (workflow, story structure, premise & theme, character & conflict, dialogue, scene craft, format & adaptation) + 4 series skills (series structure, engine & bible, writers' room, sitcom) + `terms.md` glossary.
**Authored by us**: a short-form commercial layer (6–90 s spots, explainers, testimonials, promo pieces) and English-market conventions. Compliance notes: omitted by ruling 2 (§5).
**Out**: Chinese opera, mainland-China series practice, Ozu, Chekhov, Japanese, Korean-French, American case studies, series case studies, industry-business (US WGA/agents — irrelevant to us).

## 3. Phases

### Phase 1 — Distil the English corpus into Jarvis KB knowledge docs (≈2 sessions)

Deliverable: `jarvis-kb/knowledge/screenwriting/` with 13 docs, registered in `jarvis_files`.

| Doc | Source skill | Cap |
|---|---|---|
| `00-index.md` | — (map + when to read what) | 4 KB |
| `01-workflow-and-story-bible.md` | sw-workflow | 12 KB |
| `02-premise-theme-logline.md` | sw-premise-theme | 14 KB |
| `03-story-structure.md` | sw-story-structure | 16 KB |
| `04-character-and-conflict.md` | sw-character-conflict | 16 KB |
| `05-dialogue.md` | sw-dialogue | 14 KB |
| `06-scene-craft.md` | sw-scene-craft | 14 KB |
| `07-format-fountain-adaptation.md` | sw-format-adaptation (Fountain contract, English spec format only; drop Chinese/Japanese formats) | 14 KB |
| `08-series-structure.md` | sw-series-structure | 16 KB (landed 21 KB, accepted) |
| `09-series-engine-and-bible.md` | sw-series-engine-bible | 16 KB |
| `10-writers-room-and-notes.md` | sw-writers-room (breaking story, beat sheet → outline chain, taking notes) | 12 KB (landed 15 KB, accepted) |
| `11-half-hour-comedy.md` | sw-sitcom-comedy | 12 KB |
| `12-terms.md` | sw-workflow/terms.md (English craft vocabulary, definitions) | 8 KB |

Method:
1. One Claude distillation pass per skill with a fixed prompt: English, numbered principles, the diagnostic checklist preserved verbatim in structure (question count kept), tables kept, worked examples replaced by one-line references to the film/episode (no quoted text), provenance footer naming the source books.
2. **Verification pass** (separate agent, bilingual): sample 10 claims per doc, locate each in the Chinese source, flag any principle that was invented or attributed to the wrong author. Zero unresolved flags per doc before registration.
3. Register via `upsertFile` (batch tool `jarvis_files_batch_write`), run `scripts/kb-health.ts`, confirm `knowledge_map` surfaces the folder.
4. Live probe: three English prompts through the chat path ("fix this on-the-nose scene", "test this logline", "break this 30 s spot into beats") and confirm the journal shows the docs retrieved.

Exit: 13 docs registered, verification log in `docs/planning/screenwriting-distill-log.md`, 3 live retrievals observed.

### Phase 2 — Author Jarvis skills on top (≈1–2 sessions)

Deterministic, testable procedures that read the KB docs and return structured verdicts. Same frontmatter contract as the 5 existing skills; ≥3 trigger examples, ≥2 tests each (one happy path, one `INPUT_REQUIRED` error), `output_type: structured`.

| Skill | Input | Output |
|---|---|---|
| `short-form-script` | brief: brand, audience, goal/CTA, length (6/15/20/30/60/90 s), aspect (9:16/16:9), architecture, proof points, tone, must-say, must-not-say, language | structured beat table (hook ≤ 10%, beats with timecodes, VO, super, shot, SFX, source), CTA, placeholders for missing proof, self-check flags; Fountain only for multi-character dialogue spots |
| `logline-premise-test` | idea or logline (+ optional genre, length) | verdict per test (Snyder logline test, Hoxter theme-attitude, Bork PROBLEM 7 elements), rewritten logline, the one weakest element |
| `scene-value-turn-diagnostic` | scene text | value at open/close, turn present yes/no, beat list (action/reaction gerunds), enter-late/leave-early flags, cut suggestion |
| `dialogue-on-the-nose-pass` | scene dialogue | flagged lines with flaw class (credibility/language/content/design), cover-the-names test result, rewrite per flagged line |
| `series-engine-test` | series concept | Rabkin four elements, "name three more episodes", 100-episode test, pilot type recommendation, weakest element |

Order: `short-form-script` first (the one solera and Meridian need), then the three diagnostics, then series-engine-test.
Certification: `mc-ctl skills` test runner green for every version; activation only after certification.
Audit: 3-parallel qa-audit R1 → fold → R2 on the skill bodies and tests (per [[multi-round-audit-until-pass]]).

### Phase 3 — The layer the corpus lacks (≈1 session, authored by us)

`jarvis-kb/knowledge/screenwriting/13-short-form-commercial.md` (≤ 16 KB):
- Spot architectures: hook → problem → turn → proof → CTA; story-spot vs demo-spot vs testimonial; 15/20/30/60 s beat budgets; 9:16 mobile rules (text safe area, first-frame hook, captions burned).
- Mapping from the corpus: one value turn per spot (scene craft), dialogue as action (no brand monologue), premise before copy, cover-the-names for VO voice.
- Client compliance notes: OMITTED (ruling 2, §5); the operator reviews claims before use.
- English-market conventions: US spelling default, ad copy register, Fountain for scripts and a plain "VO / SUPER / SHOT" table for spots.

`14-promo-piece-20s.md` (≤ 8 KB): the promo-video-agent standard piece (20 s, VO default, 9:16), so Jarvis's brief → script step and the promo agent's director share one structure. Spanish es-419 remains that project's output language; the structure doc is English.

### Phase 4 — Evaluation before we call it good (operator time ≈ 1 h)

Eval set `docs/planning/screenwriting-eval-briefs.md`: 6 briefs — 2 solera.properties (a listing spot, a brand explainer), 2 Meridian Bariatrics (a patient-journey testimonial, a procedure explainer), 2 broadcaster (a 20 s promo, a series logline).
Labelled A/B with shuffled slots (see the briefs doc): Jarvis with the corpus + skills vs Jarvis instructed not to use them (same model, same brief). Operator scores 1–5 on: usable without edits, hook strength, voice, claims stay inside the proof points.
Gate: median ≥ 4 and A ≥ B on ≥ 5 of 6 briefs. Below gate → revise the short-form layer first, not the corpus.

### Phase 5 — Ship

`/ship-it`: docs (PROJECT-STATUS, this plan → SHIPPED, spec pointer), memory (`reference_screenwriting_skills` → adopted, `agent-controller` skill count), commit, push, operator deploy line for the skill registration (`./scripts/deploy.sh` only if TypeScript changes; KB and skills register live).

## 4. Risks and how each is held

| Risk | Hold |
|---|---|
| Distillation invents principles or misattributes them | Phase 1 bilingual verification pass, 10 sampled claims per doc, zero unresolved |
| KB bloat / retrieval noise (150 → 165 docs) | Index doc + `knowledge_map` folder; per-doc caps; watch retrieval hit rate in journal for a week |
| Token cost per turn | Docs are retrieved, not always-on; skills read only the docs they name |
| License | Method only, no quotations; provenance footer names the books; clone stays out of any repo |
| Compliance text treated as legal advice | No compliance text authored (ruling 2); the operator reviews claims before use |
| Jarvis language rule (product content Spanish) | These two clients are English by operator ruling 09-12; skills take a `language` input defaulting to `en`, es-419 allowed |

## 5. Operator rulings (2026-09-12)

1. **Series layer**: NOW — docs 08–11 distilled in Phase 1; `series-engine-test` skill built with the rest.
2. **Compliance notes**: LATER — omitted from doc 13; operator handles review. (Skill output carries no legal text.)
3. **Eval briefs**: drafted by Claude from the public sites (solera.properties, Meridian Bariatrics).
4. **Source clone**: DELETED after Phase 1 verification; nothing Chinese lands in any repo or KB.
5. **Order**: `short-form-script` + doc 13 pulled ahead of the full distillation.

## 6. Not doing

- No wholesale ingest of the Chinese bodies (unauditable, license, 619 KB).
- No new npm dependencies; no changes to the skill loader contract.
- No Spanish/telenovela layer in this plan (separate plan when a Spanish-market script project appears).
