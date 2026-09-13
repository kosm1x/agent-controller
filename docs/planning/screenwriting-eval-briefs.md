# Screenwriting corpus — evaluation briefs (Phase 4)

**Status:** drafted 2026-09-12 from the public sites (operator ruling: draft from public copy). Scoring is the operator's.
**Protocol:** each brief is run twice with the same model — **A** = Jarvis with the KB docs + the `short-form-script` / craft skills; **B** = Jarvis told in the brief "do not use any skill or screenwriting knowledge doc". B is an instruction, not an exclusion (the skills stay active), so this is a labelled comparison, not a blind one: before scoring, a helper shuffles the two outputs of each brief into slots 1/2 by coin flip and reveals the mapping only after the sheet is filled. Score each output 1–5 on: usable without edits · hook strength · voice · claims stay inside the proof points. Gate: median ≥ 4 and A ≥ B on ≥ 5 of 6 briefs.
**Proof points** below are the only facts the script may state; anything else must appear as `[PROOF NEEDED: …]`. Nothing here is legal or compliance review; that stays with the operator.

## S1 — Solera Properties: 30 s listing / zone spot (9:16)

- brand: Solera Properties · audience: North American buyers considering a second home or investment on the Riviera Nayarit coast · goal: download the Nayarit Investment Brief 2026 · length 30 · architecture auto (expect `demo` or `listing`) · tone: data-driven, calm, direct
- proof points (solera.properties, 09-12): average price per m² in Riviera Nayarit 1,800–2,800 USD vs Los Cabos 4,800–6,200 USD · 40+ direct routes from US/Canada into PVR · 7.4 M PVR passengers in 2024, +12% YoY · every call, document and negotiation update in English · advisors introduce notarios, attorneys and property managers they have worked with
- must_not_say: guaranteed return, appreciation guarantee

## S2 — Solera Properties: 60 s objection explainer (16:9, landing hero)

- brand: Solera Properties · audience: same, at the "is it safe / is it legal" stage · goal: book a call · length 60 · architecture `objection` · tone: plain, unhurried
- proof points: fideicomiso, condominium title and ejido explained in plain English before any decision · the security question answered with data (sources: SESNSP 2024, US State Department) · five zones, five buyer profiles · property management and rental setup after closing
- must_say: "in plain English"

## M1 — Meridian Bariatrics: 30 s testimonial (9:16)

- brand: Meridian Bariatrics · audience: US and Canadian adults who have been denied or delayed by insurance for bariatric surgery · goal: book a video consultation · length 30 · architecture `testimonial` · tone: warm, factual
- proof points (bariatrica demo site, 09-12): one patient's stated experience: first call to surgery in 19 days after two years fighting US insurance (attribute, never generalize) · 12-month telehealth follow-up included · surgeons board-certified and fellowship-trained; patients meet the surgeon before surgery · a coordinator responds within 24 hours
- must_not_say: cure, guaranteed weight loss, any specific pounds-lost figure

## M2 — Meridian Bariatrics: 60 s "how it works" explainer (9:16)

- brand: Meridian Bariatrics · audience: same, researching what the process would actually be · goal: take the "Am I a candidate?" quiz · length 60 · architecture `explainer` · tone: calm, structured
- proof points: three steps — first contact with no commitment, video consultation with the surgical team, surgery in Mexico City with airport transfers · all-inclusive covers surgeon and anesthesiologist fees, hospital stay, pre-op labs, transfers and 12-month telehealth follow-up · final pricing confirmed at the virtual consultation · HIPAA-compliant handling of patient data (a regulatory claim from the site: operator review before it is stated in a script)
- must_say: "no commitment"

## B1 — Broadcaster: 20 s sales-force promo (9:16, es-419 allowed)

- brand: [a broadcaster's prime-time series — placeholder "Serie del Rey"] · audience: the broadcaster's own advertising sales force · goal: pitch the Thursday 21:00 slot to clients this week · length 20 · architecture auto (expect `cinematic` structure from 14-promo-piece-20s.md) · language es-419
- proof points: none supplied on purpose — the output must carry `[PROOF NEEDED: rating]`, `[PROOF NEEDED: audience profile]` and not invent a number
- must_not_say: any rating figure

## B2 — Broadcaster: series logline + engine test (text, not video)

- Run `logline-premise-test` then `series-engine-test` on an unseen concept of the same shape (procedural plus serialized antagonist; the skills' own certification fixtures are excluded from the eval set): "A former customs inspector in Manzanillo runs a two-truck freight firm with her brother, who wants out; each week a shipper with a problem the port authority will not touch, and a rival operator who owns the inspectors she used to work with and wants her routes." · format one-hour
- Expected shape: logline verdict pass or revise with a weakest element named; engine verdict `has_legs`, three distinct sample episodes, pilot type with a reason. Score on whether a development executive could act on it.

## Scoring sheet

| Brief | A usable | A hook | A voice | A claims | B usable | B hook | B voice | B claims | A ≥ B? |
|---|---|---|---|---|---|---|---|---|---|
| S1 (slot 1 / slot 2 shuffled) | | | | | | | | | |
| S2 | | | | | | | | | |
| M1 | | | | | | | | | |
| M2 | | | | | | | | | |
| B1 | | | | | | | | | |
| B2 | | | | | | | | | |

Below the gate → revise 13-short-form-commercial.md and the `short-form-script` body first; the distilled corpus is not the first suspect.
