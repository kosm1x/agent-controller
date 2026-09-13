# The 20-second promo piece (promo-video-agent standard)

**Read this when:** writing the script step for a sales-force promo piece — the promo-video-agent product's standard output — or any 20 s vertical promo derived from product documents (ratings, advertiser-fit specs, marketing decks, key art).
**Source:** authored 2026-09-12 for Jarvis from the promo-video-agent decisions (D-005 music by retrieval, D-008 output spec, D-013 hybrid shots, D-014 VO by default and 20 s standard) and PLAN.md §2 (template families, archetypes, safe area) and knowledge/screenwriting/13-short-form-commercial.md.
**Pairs with:** knowledge/screenwriting/13-short-form-commercial.md, knowledge/screenwriting/05-dialogue.md.

---

## 1. Fixed parameters

| Parameter | Value | Ruling |
|---|---|---|
| Runtime | 20 s (10 s only on operator input; briefings and trainings may run to 60 s) | D-014 / R2 |
| Aspect | 1080×1920 9:16 (16:9 only on operator input) | D-008 |
| Voice-over | ON by default in every family; `no_vo` is an operator option | D-014 |
| Captions | burned-in (Spanish for the broadcaster product) | R1 / D-008 |
| Delivery | personal phones, WhatsApp-kind link, ≤ 16 MB | requirements |
| Language | es-419 for the broadcaster product; the structure below is language-neutral | requirements |
| Music | curated licensed library, retrieved by mood; never generated | D-005 |

## 2. The 20 s beat budget

| Beat | Time | Job | VO words | Shot |
|---|---|---|---|---|
| Hook | 0–2 s | the one fact or emotion that makes a seller stop | 4–5 | key art or face, motion, no logo |
| Setup | 2–6 s | who this product is for, in the advertiser's terms | 7–8 | audience or context shot |
| Turn | 6–10 s | the product enters: name + its single sharpest claim | 7–8 | product / show shot (gen-shot or key-art motion) |
| Proof | 10–16 s | the number: rating, reach, audience fit, slot, date | 10–12 | number on screen, literal |
| CTA | 16–20 s | what the seller does next (pitch line, contact, date) | 5–6 | lockup + CTA super, held to the end |

Total VO 33–39 words (≈ 35 per D-014: VO occupies about 70% of the piece, so the generic 20 s budget in knowledge/screenwriting/13-short-form-commercial.md does not apply here). Silence of ≥ 1 s before the CTA line.

## 3. Template families (promo-video-agent PLAN.md §2 contracts)

| Family | What the ingest found | Beat mapping |
|---|---|---|
| `cinematic` | key art, a show, an event | hook = key-art push-in; setup + turn = 3–5 gen-shots with the title reveal; proof = schedule-card (dates, times, channel); CTA over music and SFX |
| `promo` | ratings, audience profiles, an offer | hook; 2–3 data beats (setup / turn / proof carry one number each); offer; CTA |
| `briefing` | a product sheet, a rate card, a pitch summary | title; list beats (one fact per beat, supers carry them); CTA; may run to 60 s |
| `training` | a process, a sales script, a how-to | title; numbered steps (≤ 3 at 20 s); recap as the CTA; may run to 60 s |

Every family is VO-driven (D-014) and keeps the CTA last. `no_vo` removes VO words but keeps the supers, which then carry the full sentence per beat. Family names are the promo agent's own; Jarvis's script step names the family at the top so the director can pick archetypes.

## 4. Writing rules specific to sales-force promos

1. The audience is the seller, not the viewer at home. VO addresses the seller's job: "your client", "your pitch", "this slot".
2. Every number in the proof beat must trace to a page in the ingested document; the script cites `(doc p.N)` in a notes column so the director can verify. Unsourced numbers are not written.
3. Exact text and logos are overlays, never generated inside a shot (D-013).
4. One product per piece. Two products = two pieces.
5. The hook may open on the strongest number in the `promo` family; it may not reuse the product name.

## 5. Script format

```
# | Time      | Family shot                         | VO (es-419 or en)                        | Super                | Source
1 | 0:00–0:02 | key-art motion, 9:16                | …                                        | "…"                  | doc p.1
…
5 | 0:16–0:20 | lockup + CTA                        | …                                        | "…"                  | brief
```

## 6. Self-check

(8 questions)

1. Five beats, 20 s, CTA last and held?
2. VO ≤ 39 words, read aloud in ≤ 16 s?
3. Hook contains no logo and no product name?
4. Every proof number carries a `doc p.N` source?
5. One product only?
6. Supers ≤ 6 words, one per beat, inside the 9:16 safe area?
7. Family named at the top?
8. Addressed to the seller, not the consumer?

## Provenance

Authored for Jarvis 2026-09-12 from promo-video-agent `docs/DECISIONS.md` (D-005, D-008, D-013, D-014), `docs/PLAN.md` §2 and `docs/REQUIREMENTS.md` (R1, R2, A4), plus knowledge/screenwriting/13-short-form-commercial.md. No quotations.
