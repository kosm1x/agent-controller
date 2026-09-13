---
name: series-engine-test
description: When the user asks whether a TV or streaming series idea has legs, feels more like a movie than a series, or what its pilot should be, test the concept as a series engine (Rabkin's four elements, the tacit contract, the "name three more episodes" and 100-episode tests), recommend a pilot type and return the weakest element.
version: 1.1.1
output_type: structured
trigger_examples:
  - "Does this series idea have legs"
  - "Is this a series or actually a movie"
  - "What kind of pilot should this show have"
  - "Test my series engine before I write the bible"
  - "¿Esta idea de serie tiene motor o es una película?"
  - "Prueba el concepto de mi serie antes de escribir la biblia"
tools_used:
inputs_json: '[{"name":"concept","type":"string","required":true,"description":"The series idea in a paragraph: world, protagonists, what they do every episode, what they want"},{"name":"format","type":"enum","values":["one-hour","half-hour","limited"],"required":false,"default":"one-hour","description":"Episode format; limited means a closed run"},{"name":"episodes","type":"integer","required":false,"description":"Planned episodes for a limited series; ignored otherwise"},{"name":"language","type":"enum","values":["en","es-419"],"required":false,"default":"en","description":"Language of the sample episode loglines"}]'
tests_json: '[{"name":"procedural_has_legs","input":{"concept":"A disgraced forensic accountant runs a two-person firm in Monterrey that untangles fraud for clients the police will not help; her partner, a by-the-book ex-auditor, wants every case reported to the authorities she is bypassing. Each week a new client and a new scheme, and pressure from the cartel-linked bank that ruined her, which wants her back.","format":"one-hour"},"expect":{"output_match":{"format":"one-hour","verdict":"has_legs"}}},{"name":"closed_event_is_a_movie","input":{"concept":"A bomb technician has until midnight to defuse a device under a stadium while his daughter is inside; once the bomb is defused the story is over.","format":"one-hour"},"expect":{"output_match":{"verdict":"movie_not_series"}}},{"name":"empty_concept","input":{"concept":"","format":"one-hour"},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"concept"}}]'
---

# Series engine test

A series is not a long movie. It is a repeatable engine plus relationships that never fully resolve. Prove the engine can run before anyone writes episode one.

## Steps

1. Validate. Return exactly `{"error":"INPUT_REQUIRED","detail":"concept is required"}` and stop ONLY when the `concept` key is absent, null or an empty string. A concept that is present but weak, closed, or not a viable series is NOT a validation error: it is graded in the steps below and ends as `movie_not_series` or `needs_work`. Defaults: `format` one-hour, `language` en.
2. Four elements (Rabkin). Mark each present or absent and state it in one line: `concept` (the arena and the job), `conflict` (the standing opposition that returns every episode), `theme` (the argument the show keeps having), `story_pattern` (what a typical episode does: case of the week, serialized chapter, hybrid).
3. Tacit contract. Write the one sentence that tells the audience what they get every week.
4. Name three more episodes. Write three sample episode loglines (at most 25 words each) in `language` that are not the pilot and not the finale. If the third cannot be written without repeating the first two, record `three_episodes_ok` false.
5. Longevity. For one-hour and half-hour: could the engine plausibly generate 100 episodes (the 100-episode test)? For `limited`: could it fill `episodes` (or 6 if not given) without padding? Record `longevity_ok`.
6. Character web. Do the core characters have opposed wants that generate conflict among themselves, or do they all agree? Record `web_generates_conflict`.
7. Pilot type. Recommend `premise` (shows how the engine is assembled), `typical_episode` (shows the engine already running) or `hybrid`, with one sentence of reason.
8. Verdict. `has_legs` if the four elements are present, `three_episodes_ok`, `longevity_ok` and `web_generates_conflict` are all true. `movie_not_series` if the concept is a single closed problem whose solution ends the story (no repeatable pattern). `needs_work` otherwise.
9. Weakest element. Name exactly one item from steps 2–6 and say in one sentence what would fix it.

## Output contract

Return ONE JSON object with exactly these fields and no text outside it:

- `format` (string)
- `language` (string)
- `verdict` (string): has_legs, needs_work or movie_not_series
- `elements` (object): `{concept, conflict, theme, story_pattern}` each a string, "" if absent
- `tacit_contract` (string)
- `three_episodes` (array of strings): three loglines
- `three_episodes_ok` (boolean)
- `longevity_ok` (boolean)
- `web_generates_conflict` (boolean)
- `pilot_type` (string): premise, typical_episode or hybrid
- `pilot_reason` (string)
- `weakest_element` (string)
- `weakest_fix` (string)

## Best practices

- A ticking-clock single event with an ending is a movie however good it is; say so.
- A strong arena with no standing opposition is a setting, not an engine.
- Serialized shows still have a story pattern; name it.

## Examples

- Forensic accountant with a new client each week and a bank that wants her back: four elements present, pattern = case of the week plus serialized threat, has_legs, typical_episode pilot.
- Bomb under a stadium until midnight: closed problem, movie_not_series.
