# piotr-identity-fix R1 audit (2026-08-31) — PASS WITH WARNINGS, 0 Critical

Bundle: 37 insertions / 2 deletions across 4 files. Jarvis replied "De nada, Piotr"
to the operator's "Gracias Piotr" twice. Prod prompt never named Piotr (the only
mention lived in the WhatsApp group block, compiled out because WHATSAPP_ENABLED is
unset). Fix = one sentence in the P1 identity paragraph + one "Names" rule in the
Haiku consolidator prompt + tests.

## Verified good

- `src/messaging/prompt-sections.ts:109` — the Spanish is unambiguous. "Fede te llama
  **Piotr**" is *calls-you*, not *is-called* (`se llama` would invert it); reinforced by
  "Piotr eres TÚ" + the explicit negative "nunca llames Piotr a Fede". No reading
  inverts it.
- Cache-prefix discipline holds: the sentence is a bare literal inside the template
  (no `${}`), `identitySection()` is `p1.push(...)` #1 in `router.ts:276` (stable half,
  never truncated). The history-comment entry (`prompt-sections.ts:100-103`) follows the
  file's own `- YYYY-MM-DD (label): …` convention.
- `user_facts#147 preferences.jarvis_name` ("Con Fede, Jarvis se llama Piotr. Jarvis =
  nombre técnico … Piotr = nombre estratégico") is an ALWAYS_INJECT category
  (`db/user-facts.ts:105 formatUserFactsBlock`) and AGREES with the new parenthetical —
  no P1/P4 contradiction. `jme_facts#307` already at confidence 0.0 + expired.
- `jme.test.ts:286-296` asserts on `inferMock.mock.calls[0][0].messages[0].content` —
  the string that actually reaches Haiku, i.e. the contract, not the exported constant.
- 92/92 scoped tests green; `npx tsc --noEmit` exit 0.

## Findings (carry forward)

1. **Prompt-only rule for a repeat offender.** The Names rule (`jme.ts:769`) patches a
   failure that was ALREADY a violation of its neighbour at `jme.ts:768` (anti-echo:
   "NEVER extract from Jarvis's replies"). Same instruction class, same prompt, one
   prior failure. This very file's precedent is to back a repeat rule with code —
   `jme.ts:945` caps inferred preferences "here, not just in the prompt". Step 5 of
   `consolidateAll` (`jme.ts:933-960`) does zero text validation between `JSON.parse`
   and `await upsertFact({ … factText: f.factText … })`.
   → CLASS: **a prose rule that already failed once needs a code-level twin.**
2. **A new self-name in P1 widens every deny-list that enumerates self-names.**
   `prompt-sections.ts:125` (community-manager email signature) reads
   `Nunca firmes como "Jarvis", "IA", "asistente virtual".` — "Piotr" is not in that
   enumeration, and before this ship P1 never named Piotr in prod. Instance of the
   [[flag-deny-never-converges]] class on PROSE deny-lists: adding a name upstream
   silently un-covers every downstream enumeration of names.
3. **An "ALWAYS / never" gloss on a proper noun has no third-party escape hatch.**
   "in Fede's messages \"Piotr\" ALWAYS refers to Jarvis" would misattribute a real
   person — `src/teaching/sm2.ts:4` already cites "Piotr Wozniak".
4. **Narrowing a `not.toContain` is the right move when the token goes global.**
   `prompt-sections.test.ts:444` `not.toContain("Piotr")` → `not.toContain("Tu nombre en
   WhatsApp es Piotr")`. Still a real guard because line 443 pins the block header and
   line 453 pins the same sentence POSITIVELY in the enabled case — the positive pin is
   what proves the negative pin is discriminating, without mutating anything.
5. **An ordering assertion is only as strong as its boundary token.**
   `prompt-sections.test.ts:479-481` claims "before any channel block" but measures
   against `"## Correo electrónico"`, which sits AFTER `${waGroupsSection}` — in the
   WA-enabled row the claim is unproven. Boundary token must be the FIRST thing the
   assertion claims to precede.
