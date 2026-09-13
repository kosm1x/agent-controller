# Screenplay format, the Fountain output contract, drafts and adaptation
**Read this when:** formatting a spec script, choosing the output format, writing action lines, planning drafts, cutting pages, adapting a novel, play or true story.
**Source:** distilled 2026-09-12 from jtydhr88/screenwriting-skills `sw-format-adaptation` (method only); underlying books: Wendy Henson (Screenwriting: Step by Step), Richard Walter (Essentials of Screenwriting), Neill Hicks (Screenwriting 101), Syd Field (Screenplay), Robert McKee (Story), Julian Hoxter (screenwriting rules text), Diamond & Weissman (Hollywood screenwriting method), Eric Bork (The Idea); grid and Fountain contract from measured scripts, not those books.
**Pairs with:** knowledge/screenwriting/01-workflow-and-story-bible.md, knowledge/screenwriting/06-scene-craft.md, knowledge/screenwriting/12-terms.md, knowledge/screenwriting/13-short-form-commercial.md

Terms: knowledge/screenwriting/12-terms.md. Asian industry formats are out of scope here.

## 1. You write a selling script, not a shooting script

- Hicks: format descends from obsolete shooting scripts; a spec is a selling script: no shot numbers, no camera shorthand. First law: easy to read; never send the reader back a page.
- Henson: readers check format on the first pages before content; give nobody a reason not to read. The script is a blueprint.
- Walter (principle 32): professional standards first; respect the image-and-sound limit and format follows.
- Diamond: read scripts constantly. Henson/Walter caveat: online scripts are mostly shooting scripts; do not copy their camera terms.

## 2. Hard rules of spec format (Henson, Walter, Hicks, Hoxter, Diamond merged)

- Courier 12; one page = about one minute. 100–110 pages ideal, 90–120 acceptable, under 80 amateur, over 125 "cannot write".
- Title page: title and author only (contact if unrepresented). No date, draft number, WGA number, artwork. Two brads.
- Page numbers top right from page 2. No scene numbers. FADE IN only at the start, FADE OUT only at the end.
- Headings: INT/EXT + location + DAY/NIGHT, caps, general to specific. Dates and clock times go in action.
- Action: present tense, active voice, list-like; time and weather before place. Only what a camera can shoot and an actor can play. Cut modifiers. Character in CAPS with age on first appearance; props and post-produced sounds in CAPS; only off-screen sounds. Blank line between paragraphs.
- Never mention the camera: no CU, POV, cuts, dissolves, "we see/hear". Imply the shot with text. Every scene ends on an implied cut; dropping CUT TO: saves about ten pages. FADE/DISSOLVE only when unavoidable; P.O.V. only for a true subjective shot.
- Master scenes only: one heading covers continuous action across one location; coverage is the editor's job.
- Dialogue: narrow left-aligned column, 2.5" from the edge, 3.5" wide (not centered). Name in caps. Never break a speech across pages. Parentheticals: three words, verbs only, 99% unnecessary. No emphasis by underlining, exclamation marks or ellipses. Avoid (O.S.)/(V.O.); no phonetic dialect; a line is a sentence, never a grunt.
- Introductions: sex and age (Walter) plus one characteristic action; no cast list, bios or casting.
- New scene = change of place, time, people or dramatic purpose.
- Effects: only what the audience sees. Montage: avoid; as compression, a header plus features. Flashback: ideally unlabeled; a "- FLASHBACK" suffix is a mild cheat.
- Submission: PDF, never Word. Spelling and punctuation: be a pedant.

## 3. The grid, element conventions and the Fountain contract

US Letter, Courier 12 (10 characters per inch, 6 lines per inch), measured from professional scripts. "One page = one minute" rests on this table.

| Element | Left edge | Width / right stop |
|---|---|---|
| Margins | left 1.5", right 1.0", top/bottom 1.0" | about 55 lines per page |
| Scene heading (CAPS, two blank lines above) | 1.5" (flush) | to 7.5", about 60 chars |
| Action | 1.5" (flush) | 6.0" wide, about 60 chars |
| Character (extension follows the name) | 3.7" (about char 37) | fixed indent, not centered |
| Parenthetical | 3.1" | about 2.0" wide |
| Dialogue (single spaced) | 2.5" | 3.5" wide (to 6.0"), about 35 chars |
| Transition (`CUT TO:`) | right-aligned to 7.5" | starts about 6.0" |
| Page number (`2.`, from page 2) | top right, 0.5" from top | 7.0"–7.5" |

Conventions:
- (V.O.): speaker not in the scene's space (narration, phone's far end, inner monologue). (O.S.): in the space but off camera; TV drafts often write (O.C.).
- (CONT'D): same speaker resumes after action; across a page break `(MORE)` at the foot, `(CONT'D)` after the name overleaf. Software adds these.
- Dual dialogue: two speakers at once in side-by-side columns; Fountain marks the second name with `^`.
- `MONTAGE - TITLE`, items on `--` lines, `END MONTAGE`; `INTERCUT - A / B`, then alternate freely; `FLASHBACK - ` prefix; `SUPER: "..."` in action.

Fountain contract. Agent-produced scripts ship as Fountain plain text (`.fountain`), never Markdown: it maps onto the grid, diffs, and renders to PDF or .fdx. Markers (spec at fountain.io):
- Title page: `Title:` `Credit:` `Author:` `Draft date:` `Contact:` key-value lines, then a blank line.
- Scene heading: a line starting `INT.` `EXT.` `I/E` auto-detects; force with leading `.`. Character: an all-caps line after a blank line; force with leading `@`; extension follows (`@NAME (V.O.)`); dual dialogue adds `^`.
- Parenthetical: `(...)` under the name. Dialogue: the lines that follow. Transition: an all-caps line ending `TO:`; force with leading `>`. Centered: `> THE END <`.
- Action: everything else; force with leading `!`. Page break `===`; note `[[...]]`; boneyard `/* ... */`; section `#`; synopsis `=`; lyric `~`.
- Forced markers rescue anything auto-detection would misread; otherwise the line renders as action.
- Render: PDF via afterwriting (CLI), Beat, Highland, Slugline; .fdx via Fade In, Final Draft or afterwriting. Stage 5 of knowledge/screenwriting/01-workflow-and-story-bible.md delivers the `.fountain`; the story bible records file name and page count.

## 4. Writing action lines well

- McKee: absolute present tense, vivid movement; concrete nouns and specific verbs; ban is/are; shun Latinate abstractions; every metaphor must pass "what is seen or heard"; short paragraphs imply shot changes.
- Walter's margin marks: Hwk?/See/Hear (how would the audience know? only sight and sound exist); Ess. Det. Only / SIFYN (save it for your novel); Drekt/Akt (do not direct or act); Notnot (never write what did not happen); Prez (present tense); Novry (never "very"); Conk (concrete); No Tt (no Tarzan fragments); 4 v. 6 (needed vs. unneeded words); Fmpmt (find the point, make it, move on); NoFX (no centering, italics, bold); Clok (screen seconds per paragraph).
- Henson: for two weeks, sentences of ten words or fewer. Diamond: collapse gesture chains into one action; do not do the director's job. Hicks: write images, not pictures; action has cause-effect shape; the first scene teaches the reader how to read the script.

## 5. From idea to finished draft

Before writing:
- Bork 60/30/10: 60% idea, 30% structure, 10% execution. Log line plus one-page summary, then feedback.
- Diamond: three Cs (character, concept, context) > comparables > one-page nine-step synopsis > character action chart (each character retells the nine steps) > outline > set pieces > script. No pages before pitch and outline are agreed. Nine steps: set-up; opportunity; act-one commitment; p. 45 news raises stakes; midpoint reversal; p. 75 escalation; end of act two, all lost; then worse; climax drawing out a quality the hero never knew they had.
- Henson: statement of purpose (theme > basic action + purpose) and a three-sentence dramatic premise (inciting incident, act-one hook, act-two hook, each with its core question) on one sheet; trouble writing means a hole in the concept.
- Walter: an outline is not a synopsis; outlining is the hardest, most necessary step. Principle 44: outline past tense, script present tense; the danger is following the track, not leaving it. About sixty numbered cards; stuck at two-thirds, re-card. Principles 41–43: block is the natural state, deadlines are friends, perfectionism must not bar the road; revise only yesterday's page.
- McKee, inside out: of six months, four go to a step outline on cards (a line or two per scene) > tell it in ten minutes and watch the listener > treatment (60–90 pages, present tense, no dialogue, subtext written out) > screenplay at five to ten pages a day. Jumping to pages is the slowest route.
- Field's cards: act one in a day, act two in two, act three in one; fix opening, plot points and ending first.
- Hicks' draft chain: couch writing > outline > prose treatment > everything-in first draft (100+ pages) > revised draft (cut actor direction, furniture) > agent's draft (script-literate readers) > market draft.
- Hoxter: outline for you (scene by scene); treatment for buyers (prose in the film's tone, 4–30 pages).

Habits: Field: three pages a day; when in doubt, write. Hoxter: start the next scene before stopping; big changes go to the outline first.

Revision and cutting pages:
- Walter 46–48: real writing is rewriting; answer notes with "yes, but"; when in doubt, throw it out.
- Diamond: nobody buys a first draft; fix concept before details; give every minor character a distinct voice; cut heads and tails (a scene starts when a goal meets obstruction); cut purposeless scenes; cut two or three lines per page; rhythm beats page count.
- Hoxter: technical pass > creative pass (leaner description, one voice) > targeted pass (act two is usually the problem); save every version; check arcs against the outline.
- Henson: five of six readers liking it is safe; five calling it limp means start over. Field: if unsure a scene works, it does not; two honest readers, not four.

## 6. Adaptation

- Field: apples and oranges. An adaptation is an original screenplay using the source as a starting point; faithful to the material's integrity, not its letter. Novels write inner life, plays language, screenplays external situation; adapting a play, visualize what the dialogue reports. History: characters free, outcomes accurate.
- McKee, principle one: the purer the novel (inner conflict) or play (personal conflict), the worse the film; choose conflict on all three levels. Reread until you know it by smell, reduce each event to a line, ask whether it is a well-told story. Principle two: reinvent (reorder time, step outline, cut and add scenes, give inner conflict visual form); the camera cannot film thought.
- Hoxter's four questions: rights (none, stop)? filmable? what is specific to the source medium? what of its theme and symbols transfers? Outline it as is, then cut.
- Bork on true events: reality has no story shape; select, edit, exaggerate, invent. Two questions: why the goal matters, how hard the road. Write through, then check against research.
- Hicks on true lives: lawyer first; option the life rights; private people's privacy weighs most. Walter: bestseller adaptations usually disappoint.
- Expanding to series or compressing to fragments: separate crafts (knowledge/screenwriting/13-short-form-commercial.md).

## 7. Format diagnostic

### General (12 questions, as in the source)

1. Action: present tense, active, no is/are, concrete, no camera terms, no "we see", no unfilmable thought, no negatives, short sentences?
2. Screen seconds per paragraph? Purpose, value, best way?
3. Headings complete, general to specific, clock in action?
4. Dialogue: no dialect spelling, no grunts, no punctuation emphasis, parentheticals three verbs and usually cut?
5. Intros: sex, age, one action; no cast list, bios, casting?
6. Master scenes only? Montage avoided or compressed? Flashbacks minimal and unmistakable?
7. Before pages: synopsis, premise, action chart, step outline? Told aloud in ten minutes?
8. Treatment or outline holds subtext and no dialogue? Which chain step was skipped?
9. Revision: concept before detail? heads and tails cut? minor voices distinct?
10. Adaptation: which conflict level dominates? what was reinvented? rights signed? true events: why it matters, how hard the road?
11. Length: which page reckoning, stated in the deliverable?
12. One format throughout?

### Spec format (7 questions, as in the source)

13. Title page only title and author? No scene numbers, date, draft? Courier 12? 90–120 pages?
14. Layout matches the grid (left 1.5", dialogue 2.5"–6.0", character 3.7", transitions right-aligned)?
15. Characters CAPS with age on first entrance? Props and post sounds CAPS?
16. No speech broken across pages; `(MORE)` / `(CONT'D)` where needed?
17. (V.O.) vs (O.S.) correct?
18. No camera anywhere, no CUT TO:?
19. Delivered as `.fountain` plain text, not Markdown or Word?

Format unspecified: default to spec format / Fountain, say so in one line at the top; do not stop to ask.

## 8. Workflow: idea to submittable draft

1. Log line plus one-page summary; outside reactions.
2. Three Cs, comparables, nine-step synopsis, thesis.
3. Statement of purpose, premise, action chart.
4. Step outline / cards with the value turn per scene.
5. Tell it in ten minutes; treatment (subtext, no dialogue).
6. First draft by pages per day, long over short.
7. Revised draft: cut direction, furniture, modifiers; two or three lines per page; heads and tails.
8. Agent's draft: script-literate readers only.
9. Market draft: PDF; minimal title page; WGA registration off the cover.

## Provenance
Underlying books: Wendy Henson (Screenwriting: Step by Step), Richard Walter (Essentials of Screenwriting), Neill Hicks (Screenwriting 101), Syd Field (Screenplay), Robert McKee (Story), Julian Hoxter (screenwriting rules text), Diamond & Weissman (Hollywood screenwriting method), Eric Bork (The Idea); grid and Fountain contract from measured scripts. No quotations; all wording is a paraphrase of method.
