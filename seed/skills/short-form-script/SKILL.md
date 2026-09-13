---
name: short-form-script
description: When the user asks for a commercial, promo, spot, explainer, testimonial or listing video script of 6 to 90 seconds for a brand, clinic, property or product, write it as a timed beat table (shot, VO, super, SFX) built on one value turn, one promise and one CTA, using only the proof points supplied, and return it with a self-check.
version: 1.1.1
output_type: structured
trigger_examples:
  - "Write a 30 second spot for our clinic aimed at US patients"
  - "I need a 20 second vertical promo script for this listing"
  - "Draft a 60 second testimonial video script from this patient story"
  - "Give me a 15 second explainer for how the consultation works"
  - "Escríbeme un spot de 30 segundos para la clínica dirigido a pacientes de Estados Unidos"
  - "Necesito el guion de un promo vertical de 20 segundos para este desarrollo"
tools_used:
inputs_json: '[{"name":"brand","type":"string","required":true,"description":"Brand, clinic, property or product name exactly as it must appear"},{"name":"audience","type":"string","required":true,"description":"Who the piece is for, in one sentence (e.g. US patients researching bariatric surgery abroad)"},{"name":"goal","type":"string","required":true,"description":"The single action the viewer should take (e.g. book a video consultation)"},{"name":"length_s","type":"integer","required":true,"description":"Runtime in seconds; supported budgets are 6, 15, 20, 30, 60, 90 and any other value is rounded to the nearest one"},{"name":"aspect","type":"enum","values":["9:16","16:9"],"required":false,"default":"9:16","description":"Frame aspect; 9:16 is mobile vertical"},{"name":"architecture","type":"enum","values":["auto","story","demo","testimonial","explainer","objection","listing","offer"],"required":false,"default":"auto","description":"Spot architecture; auto lets the skill choose from the brief"},{"name":"proof_points","type":"array","required":false,"description":"Facts the script may use verbatim (numbers, names, mechanisms). Nothing else may be stated as fact"},{"name":"must_say","type":"array","required":false,"description":"Phrases that must appear in VO or super"},{"name":"must_not_say","type":"array","required":false,"description":"Words or claims that must not appear"},{"name":"tone","type":"string","required":false,"description":"Tone in a few words (e.g. calm, direct, warm)"},{"name":"language","type":"enum","values":["en","es-419"],"required":false,"default":"en","description":"Language of VO and supers"}]'
tests_json: '[{"name":"testimonial_30s","input":{"brand":"Meridian Bariatrics","audience":"US adults who have fought their insurance for bariatric surgery and are researching Mexico","goal":"book a video consultation","length_s":30,"architecture":"testimonial","proof_points":["19 days from first call to surgery","12-month telehealth follow-up included","surgeons are board-certified and fellowship-trained"]},"expect":{"output_match":{"architecture":"testimonial","length_s":30,"aspect":"9:16","language":"en"}}},{"name":"demo_15s_16x9","input":{"brand":"Solera Properties","audience":"North American buyers considering a second home in Riviera Nayarit","goal":"download the investment brief","length_s":15,"aspect":"16:9","architecture":"demo","proof_points":["average price per square meter 1,800 to 2,800 USD versus 4,800 to 6,200 in Los Cabos"]},"expect":{"output_match":{"architecture":"demo","length_s":15,"aspect":"16:9"}}},{"name":"empty_brand","input":{"brand":"","audience":"anyone","goal":"call us","length_s":30},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"brand"}},{"name":"length_rounds_to_budget","input":{"brand":"Acme","audience":"people who need a plumber today","goal":"call us","length_s":27,"proof_points":["same-day service since 2015"]},"expect":{"output_match":{"length_s":30}}}]'
---

# Short-form script

Write a 6–90 s commercial piece as a timed beat table. A spot is one scene: one value turn (negative charge to positive), one promise, one call to action (CTA). Proof is specific; adjectives are not proof.

## Steps

1. Validate. If `brand`, `audience`, `goal` or `length_s` is missing, null or an empty string, return exactly `{"error":"INPUT_REQUIRED","detail":"<field> is required"}` naming the first missing field, and stop. If `length_s` is not one of 6, 15, 20, 30, 60, 90, round it to the nearest supported value (ties round up), use that value everywhere, and record the substitution in `self_check.flagged` (e.g. "length_s 27 rounded to 30"). Defaults: `aspect` 9:16, `architecture` auto, `language` en.
2. Premise. Write one line: `[audience] who [pain] can [outcome] because [mechanism]`. Every beat must serve it.
3. Architecture. If `architecture` is not auto, use it. If auto, choose by the brief: a doubt or objection to answer → `objection`; a person's dated result → `testimonial`; a visual product or a price gap → `demo`; a process question → `explainer`; a property or venue → `listing`; a deadline or package → `offer`; otherwise `story`. Use exactly one.
4. Beats. Fill the budget for `length_s` (start–end seconds, VO words total):
   - 6: hook 0–1 · turn 1–3 · CTA 3–6 · 8–10 words
   - 15: hook 0–2 · setup 2–5 · turn 5–8 · proof 8–12 · CTA 12–15 · 27–32 words
   - 20: hook 0–2 · setup 2–6 · turn 6–10 · proof 10–16 · CTA 16–20 · 38–45 words (a sales-force promo per knowledge/screenwriting/14-promo-piece-20s.md uses 33–39)
   - 30: hook 0–3 · setup 3–9 · turn 9–14 · proof 14–24 · CTA 24–30 · 60–70 words
   - 60: hook 0–3 · setup 3–15 · turn 15–22 · proof 22–50 · CTA 50–60 · 122–145 words
   - 90: hook 0–4 · setup 4–20 · turn 20–30 · proof 30–75 · CTA 75–90 · 185–220 words
   Skeletons: story = doubt voiced → product enters → one specific result → ask. demo = claim → show it working → the number → ask. testimonial = who I was → the doubt → what happened, dated and specific → where I am now → ask (first person). explainer = the question → at most three steps → what you get → ask. objection = the objection in the audience's words → the answer with evidence → ask. listing = the buyer's want → three shots that prove it → the fact that closes → ask. offer = deadline or scarcity → what you get → terms → ask.
5. Hook. Frame 1 carries a face, motion or object, never a logo or the brand name. The first line is a question, a contradiction, a number or the objection itself; it is not answered until the turn. The hook super states it in at most 6 words.
6. VO. Second person, present tense (first person only for testimonial). Short words, active voice, one idea per sentence; word choice follows `tone` when supplied. No three consecutive sentences about the brand. Put the core word last in the hook and the CTA. Read at 2.1–2.5 words per second; if over budget, cut setup, never proof.
7. Proof. State as fact only what is in `proof_points`, and put the proof point a beat relies on in that beat's `source` ("" for beats that state no fact). Where a number, name or mechanism is needed and none was supplied, write `[PROOF NEEDED: what]` in the VO and list it in `placeholders`. Never invent a figure.
8. Supers. One per beat, at most 6 words, noun-led, restating the proof not the adjectives. The CTA super is the last frame and includes the logo lockup. For 9:16 keep essential text inside the middle 4:5 zone (top ~14% and bottom ~20% clear).
9. Shots. One shot per beat, starting mid-action; no establishing shots; the proof shot is literal (the number on screen, the room, the document). Write each shot as a prompt-able sentence: subject, action, setting, light, aspect. Give each beat one SFX or music cue in `sfx`, or an empty string when the beat is silent.
10. Constraints. Every `must_say` phrase appears in VO or a super. No `must_not_say` item appears anywhere; if a proof point contains one, drop that proof point and add a placeholder. Write VO and supers in `language`.
11. Self-check. Answer the 12 questions: single premise; one value turn; frame 1 has no logo; hook ≤ 10% of runtime (≤ 15% below 20 s; the 6 s bumper's 1 s hook is exempt) and unanswered until the turn; proof is specific and ≥ 30% of runtime (≥ 25% at 15 s; not required at 6 s); VO within word budget; cover-the-names test (hide the brand: could a competitor run it?); exactly one CTA with a verb, in VO and on screen, last; supers ≤ 6 words, one per beat; each shot starts mid-action; adjectives standing in for proof removed; one architecture. Fix what you can before returning, then report honestly: list only the flagged items with a one-line reason each (an empty list means all twelve passed).

## Output contract

Return ONE JSON object with exactly these fields and no text outside it:

- `architecture` (string): one of story, demo, testimonial, explainer, objection, listing, offer
- `length_s` (number): the validated runtime
- `aspect` (string): "9:16" or "16:9"
- `language` (string): "en" or "es-419"
- `premise` (string): the one-line premise
- `hook_super` (string): at most 6 words
- `beats` (array of objects): `{n, name, start_s, end_s, shot, vo, super, sfx, source}` where `name` is one of hook, setup, turn, proof, cta; `start_s`/`end_s` numbers; `vo` spoken words only; `super` may be empty; `source` is the proof point the beat states, or ""
- `cta` (string): the verb-led CTA line
- `vo_word_count` (number): total words in all `vo` fields
- `placeholders` (array of strings): every `[PROOF NEEDED: …]` written
- `self_check` (object): `{flagged: [string]}` — only the questions that did not pass, each with its reason; `{flagged: []}` when all twelve pass

## Best practices

- The brand is the mentor, the viewer is the hero.
- A 30 s piece is rebuilt from the premise, never cut down from a 60 s draft.
- When `proof_points` is empty, the piece will carry placeholders; that is correct behavior, not a failure.

## Examples

- Clinic testimonial, 30 s, proof "19 days from first call to surgery": hook voices the two years lost to insurance, turn names the clinic, proof states 19 days on screen, CTA "Book your video consultation".
- Property demo, 15 s, 16:9, proof = the price-per-square-meter gap: hook is the gap as a question, proof puts both numbers on one super, CTA "Download the brief".
