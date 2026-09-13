# Distillation brief (shared by every distillation agent)

Source clone (read-only, Chinese; a session-scratchpad clone of jtydhr88/screenwriting-skills, deleted 2026-09-12 after verification per operator ruling 4 — re-clone to re-run): <clone>/plugins/screenwriting/skills/<skill>/SKILL.md (+ reference*.md for tables only)
Target: /root/claude/mission-control/seed/knowledge/screenwriting/<NN-name>.md — ENGLISH, UTF-8, Markdown.

Rules
1. English only. No Chinese characters anywhere in the output (the doc is read by an English-writing agent; the KB is audited by an English reader).
2. Distil METHOD, not text: principles, rules, tests, tables, checklists, procedures — rewritten in your own words. NO verbatim quotations from the source books (paraphrase; never a quoted sentence). Films/episodes may be named as one-line references ("Chinatown: the plot point at p. 25") but no dialogue or prose is reproduced.
3. Keep the structure of the source: same top-level sections in the same order, numbered principles, every table kept (translated), and EVERY diagnostic checklist kept with the SAME number of questions as the source. State the count in a line under the checklist heading, e.g. "(13 questions, as in the source)".
4. Use the original English craft vocabulary (logline, act out, beat sheet, inciting incident, controlling idea, cold open, tentpole, bottle episode, showrunner, spec script, step outline, treatment, on-the-nose, subtext). Where the source uses a Chinese-only term with no English equivalent, give an English gloss once and use the gloss.
5. Where the source keeps two authors' conflicting positions side by side, keep both and the note on when to use which.
6. Attribute correctly: a principle that the source credits to McKee stays McKee's; do not merge authors. If the source does not name an author for a claim, do not invent one.
7. Byte cap is per doc (given in the task). Prefer dropping worked examples over dropping principles, tables or checklists. Never exceed the cap.
8. Header block at the top:
   # <Title>
   **Read this when:** <one sentence: the situations this doc serves>
   **Source:** distilled 2026-09-12 from jtydhr88/screenwriting-skills `<skill>` (method only); underlying books: <list from the skill's description>.
   **Pairs with:** <other NN-docs in this folder by filename>
9. Footer: "## Provenance" repeating the book list and the sentence "No quotations; all wording is a paraphrase of method."
10. Final report (your last message): file path, byte size (`wc -c`), list of H2 sections, and for each checklist its question count in source vs output. Nothing else.
