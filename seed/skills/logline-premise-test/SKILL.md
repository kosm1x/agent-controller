---
name: logline-premise-test
description: When the user asks whether a story idea, logline or premise works, is sellable, or "has a story", grade it against the logline and premise tests (Snyder's logline elements, Bork's PROBLEM seven, Egri's premise form, McKee's controlling idea, Hoxter's theme attitude), name the single weakest element and return a rewritten logline.
version: 1.1.1
output_type: structured
trigger_examples:
  - "Test this logline for me"
  - "Does this idea have a story or just a situation"
  - "Is this premise strong enough for a feature"
  - "Rewrite my logline so it actually sells"
  - "Evalúa este logline y dime si tiene historia"
  - "Prueba esta premisa antes de que escriba el guion"
tools_used:
inputs_json: '[{"name":"logline","type":"string","required":true,"description":"The idea, logline or premise to test, at most 80 words"},{"name":"format","type":"enum","values":["feature","series","short","spot"],"required":false,"default":"feature","description":"What the idea is for; a spot is graded as a 6-90 second commercial premise"},{"name":"genre","type":"string","required":false,"description":"Genre if known"},{"name":"language","type":"enum","values":["en","es-419"],"required":false,"default":"en","description":"Language of the rewritten logline"}]'
tests_json: '[{"name":"strong_feature_logline","input":{"logline":"A timid claims adjuster who has never left Ohio must smuggle his estranged father out of a Mexican hospital before the cartel that owns it collects the debt the old man owes.","format":"feature"},"expect":{"output_match":{"format":"feature","language":"en"}}},{"name":"situation_not_story","input":{"logline":"A man lives in a big city and thinks about his life.","format":"feature"},"expect":{"output_match":{"verdict":"fail"}}},{"name":"empty_logline","input":{"logline":"","format":"feature"},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"logline"}}]'
---

# Logline and premise test

Grade one idea against the tests a buyer or a script editor applies, then rewrite the logline.

## Steps

1. Validate. If `logline` is missing, null or an empty string, return exactly `{"error":"INPUT_REQUIRED","detail":"logline is required"}` and stop. If it exceeds 80 words, return exactly `{"error":"INPUT_INVALID","detail":"logline must be at most 80 words"}` and stop. Defaults: `format` feature, `language` en.
2. Snyder logline elements. Mark each present or absent: a protagonist described with one telling adjective; an antagonist or opposing force with one adjective; a concrete goal; an ironic hook (the protagonist is the wrong person for this goal); a sense of the whole story (you can imagine the ending); the audience it is for. For `spot`, replace "antagonist" with "the doubt or friction" and "goal" with "the action asked".
3. Bork PROBLEM. Judge each against the `genre` when supplied (the genre sets what Entertaining and Believable promise). Mark each pass or fail: Punishing (the central problem is hard and gets harder); Relatable (the audience cares because they recognize the want); Original (a fresh angle on a familiar want); Believable (it could happen in this world); Life-altering (the stakes change the protagonist's life); Entertaining (the promise of the genre is visible); Meaningful (it says something).
4. Egri premise. Write it as `[character trait] leads to [outcome]` (e.g. "reckless loyalty leads to ruin"). If no trait can be named, mark absent.
5. McKee controlling idea. Write `[value] because [cause]` (e.g. "justice prevails because the protagonist chooses truth over safety"). If the idea has no value at stake, mark absent.
6. Hoxter theme attitude. State in one sentence what the story's attitude to its theme is. If the idea is only a situation, mark absent.
7. Verdict. `pass` if all six Snyder elements are present and at most one PROBLEM fails and steps 4–6 are all present. `revise` if two to four items are missing or fail in total, or if exactly one item is missing and it is a Snyder element or one of steps 4–6. `fail` if five or more are missing or fail, or if there is no goal and no opposing force (a situation, not a story).
8. Weakest element. Name exactly one item from steps 2–6 that most limits the idea and say why in one sentence.
9. Rewrite. Write a new logline of at most 35 words in `language` that fixes the weakest element and keeps the user's intent. If the verdict is `fail` because there is no story, the rewrite proposes a goal and an opposing force and says so in `rewrite_note`. Do not introduce a number, price, date, brand claim or named real person or company that is not present in `logline`; if the rewrite needs one, write `[PROOF NEEDED: what]` in its place.

## Output contract

Return ONE JSON object with exactly these fields and no text outside it:

- `format` (string): the validated format
- `language` (string): "en" or "es-419"
- `verdict` (string): one of pass, revise, fail
- `snyder` (object): `{protagonist, antagonist, goal, irony, whole_story, audience}` each true or false
- `problem` (object): `{punishing, relatable, original, believable, life_altering, entertaining, meaningful}` each true or false
- `egri_premise` (string): the premise or ""
- `controlling_idea` (string): the value-because-cause line or ""
- `theme_attitude` (string): one sentence or ""
- `weakest_element` (string): the item name
- `weakest_reason` (string): one sentence
- `rewritten_logline` (string): at most 35 words
- `rewrite_note` (string): what the rewrite changed, one sentence

## Best practices

- A logline with a protagonist and a situation but no goal and no opposition always fails; do not soften it to "revise".
- Do not grade prose quality; grade whether the story elements exist.
- Keep the user's genre and setting in the rewrite unless they are the weakest element.

## Examples

- "A timid claims adjuster must smuggle his father out of a cartel-owned hospital": protagonist with adjective, opposing force, goal, irony (timid vs smuggling), stakes → pass or revise depending on theme attitude.
- "A man lives in a big city and thinks about his life": no goal, no opposition → fail; rewrite proposes both.
