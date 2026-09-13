---
name: dialogue-on-the-nose-pass
description: When the user asks to fix dialogue that is on the nose, expository, flat or interchangeable between characters, flag each faulty line with its flaw class (credibility, language, content, design), run the cover-the-names test for distinct voices, and return a rewrite for every flagged line.
version: 1.1.1
output_type: structured
trigger_examples:
  - "My dialogue is on the nose, fix this scene"
  - "These two characters sound the same, help"
  - "Cut the exposition out of this exchange"
  - "Give every flagged line a rewrite with subtext"
  - "Mis diálogos son demasiado explícitos, arregla esta escena"
  - "Estos dos personajes hablan igual, ayúdame a diferenciarlos"
tools_used:
inputs_json: '[{"name":"dialogue","type":"string","required":true,"description":"The exchange to review: speaker names and lines, with any action lines"},{"name":"language","type":"enum","values":["en","es-419"],"required":false,"default":"en","description":"Language of the rewrites"}]'
tests_json: '[{"name":"on_the_nose_exchange","input":{"dialogue":"MARA: I am furious with you because you lied to me about the money and now I feel betrayed and alone.\nJON: I understand that you feel betrayed. I lied because I was afraid you would leave me, as you know we have been married for twelve years.\nMARA: Yes, twelve years, since we met at college in Boston."},"expect":{"output_match":{"has_flags":true,"cover_the_names":"fail"}}},{"name":"clean_exchange","input":{"dialogue":"MARA: Twelve years.\nJON: You counting?\nMARA: (sliding the bank statement across) Somebody has to.\nJON: (not looking at it) Dinner is getting cold."},"expect":{"output_match":{"cover_the_names":"pass"}}},{"name":"empty_dialogue","input":{"dialogue":"","language":"en"},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"dialogue"}}]'
---

# Dialogue on-the-nose pass

Dialogue is action: every line does something under what it says. Lines that say the subtext, tell the listener what they already know, or could belong to anyone are flagged and rewritten.

## Steps

1. Validate. If `dialogue` is missing, null or an empty string, return exactly `{"error":"INPUT_REQUIRED","detail":"dialogue is required"}` and stop. Default `language` en.
2. Split into lines with speakers and number them 1..N in order (`n`). Ignore action lines for flagging but use them for context.
3. Flag by class. For each line, test in this order and record the first class that applies:
   - `credibility`: empty words (tells the listener a fact both already know); over-sentiment (language far above the emotion the moment earns); too explicit (the writer's knowledge spoken by the character); over-perceiving (the character analyzes their own psychology like a therapist).
   - `language`: cliché; character-neutral wording that any person would use; ornate wording that shows off the writer; dry abstractions where a concrete short word exists.
   - `content`: on the nose (the subtext stated as text: naming the feeling and its cause outright); inner-monologue fallacy (a long uninterrupted self-explanation); duologue stiffness (two people trading positions with no third object to fight through).
   - `design`: repetition of a beat with the same tactic; a crippled line whose meaning arrives too early or too late; the core word buried mid-sentence instead of last.
4. Cover-the-names test. Hide the speaker names and ask whether each line can be attributed by voice alone (vocabulary, rhythm, what the character notices). `cover_the_names` is `pass` if every speaker is distinguishable, `fail` otherwise. Name what makes each voice distinct or what is missing.
5. Rewrite each flagged line so the same action is performed through subtext: shorter words, a concrete object or gesture where possible, the core word last, nothing the listener already knows. Keep the speaker's intent. A rewrite may be silence or an action line if that performs the action better; write it as `(action: …)`.
6. Summary. One sentence on the exchange's main problem and the one change with the highest yield. `has_flags` is true if at least one line was flagged.

## Output contract

Return ONE JSON object with exactly these fields and no text outside it:

- `language` (string)
- `has_flags` (boolean)
- `flagged` (array of objects): `{n, speaker, line, flaw_class, reason, rewrite}` where `flaw_class` is one of credibility, language, content, design
- `cover_the_names` (string): pass or fail
- `voices` (array of objects): `{speaker, marker}` one line each on what distinguishes the voice or what is missing
- `summary` (string): one sentence
- `highest_yield_change` (string): one sentence

## Best practices

- "You know we have been married for twelve years" is the canonical empty-words flag: both know it; the writer wanted the audience to.
- Two legal on-the-nose exceptions: a direct question in crisis ("What do you want?") and a check-in ("Are you all right?"). Do not flag those.
- Do not add lines; rewrite or remove.

## Examples

- "I am furious because you lied and now I feel betrayed": content, on the nose → a rewrite that performs fury through an object or a refusal.
- An exchange where one speaker counts and the other deflects with dinner: distinct voices, cover-the-names pass, likely no flags.
