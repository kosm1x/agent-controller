---
name: scene-value-turn-diagnostic
description: When the user asks whether a scene works, why a scene feels flat, or what to cut in a scene, analyze the scene text for its value at stake, the charge at open and close, whether a turn occurs, the beats as action/reaction, enter-late and leave-early opportunities, and return a verdict with one cut suggestion.
version: 1.1.1
output_type: structured
trigger_examples:
  - "Does this scene turn or is it flat"
  - "Why does this scene feel like nothing happens"
  - "Break this scene into beats and tell me where to cut"
  - "Analyze this scene for subtext and turning point"
  - "Esta escena se siente plana, dime por qué"
  - "Divide esta escena en beats y dime dónde cortar"
tools_used:
inputs_json: '[{"name":"scene_text","type":"string","required":true,"description":"The scene: action lines and dialogue, or a prose summary of what happens"},{"name":"language","type":"enum","values":["en","es-419"],"required":false,"default":"en","description":"Language of the analysis text"}]'
tests_json: '[{"name":"scene_that_turns","input":{"scene_text":"INT. OFFICE - DAY. Dana walks in rehearsing her pitch for a raise, sets a folder of results on the desk. Her boss does not open it. He slides an envelope across: her position is being eliminated Friday. Dana picks up her folder, then puts it back down on his desk and leaves without a word."},"expect":{"output_match":{"turn_present":true,"verdict":"turns"}}},{"name":"flat_scene","input":{"scene_text":"INT. KITCHEN - MORNING. Two roommates make coffee. One says the weather is nice. The other agrees. They talk about which brand of coffee they prefer and agree on that too. They leave for work."},"expect":{"output_match":{"turn_present":false,"verdict":"flat"}}},{"name":"empty_scene","input":{"scene_text":"","language":"en"},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"scene_text"}}]'
---

# Scene value-turn diagnostic

A scene earns its place by turning a value: the charge of something at stake is different at the end than at the start. Diagnose that, then the beats, then the edges.

## Steps

1. Validate. If `scene_text` is missing, null or an empty string, return exactly `{"error":"INPUT_REQUIRED","detail":"scene_text is required"}` and stop. Default `language` en.
2. Value at stake. Name the value in play in one or two words (e.g. security, trust, freedom, status). If none can be named, write "none".
3. Charge. Mark the charge of that value at the open and at the close as `positive`, `negative` or `none`.
4. Turn. `turn_present` is true only if the charge changes (positive to negative, negative to positive, or a stated degree change such as negative to worse). Name the turning point: the line or action where it happens, and whether it comes through action or through revelation.
5. Beats. List the beats as pairs of action and reaction, each written as a gerund phrase for the acting character (e.g. "pleading", "dismissing", "retreating"). A beat changes when the tactic changes, not when the speaker changes.
6. Text and subtext. For up to two of the most important lines (one if the scene has only one line of dialogue), state what is said and what is actually being done.
7. Edges. `enter_late`: can the scene start later without losing the turn (name the new first line or action)? `leave_early`: can it end earlier, at or right after the turn?
8. Verdict. `turns` if a value changes charge; `flat` if not. If flat, `cut_suggestion` says either how to give the scene a turn (what the character wants and what blocks it) or that the scene should be cut and its necessary information moved elsewhere.
9. Cut suggestion. Always give exactly one: the single most valuable cut or change.

## Output contract

Return ONE JSON object with exactly these fields and no text outside it:

- `language` (string)
- `value` (string): the value at stake or "none"
- `open_charge` (string): positive, negative or none
- `close_charge` (string): positive, negative or none
- `turn_present` (boolean)
- `turning_point` (string): the line or action, or ""
- `turn_kind` (string): action, revelation or none
- `beats` (array of objects): `{n, actor, action, reactor, reaction}` gerund phrases
- `subtext` (array of objects): `{line, said, done}` for at most two lines
- `enter_late` (string): the later starting point or "no"
- `leave_early` (string): the earlier ending point or "no"
- `verdict` (string): turns or flat
- `cut_suggestion` (string): one sentence

## Best practices

- Agreement is not a beat; two characters agreeing on everything is the definition of a flat scene.
- A change of subject is not a turn; a change of charge is.
- Prefer a later entry over adding lines at the front.

## Examples

- Employee arrives to ask for a raise, learns she is being laid off: value = security, positive to negative, turn by revelation, verdict turns; enter late at the envelope.
- Roommates agree about coffee and weather: value none, no turn, verdict flat; cut or give one of them a want the other blocks.
