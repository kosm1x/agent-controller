# Screenwriting corpus — evaluation briefs (Phase 4)

**Status:** drafted 2026-09-12 from the public sites (operator ruling: draft from public copy); B arm sent by the operator 2026-09-13 ~00:5x UTC, A arm after the 45-min scope window. Scoring is the operator's; results go in the sheet below and in PROJECT-STATUS.
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

## Appendix — mensajes para Jarvis (Telegram DM, uno por mensaje)

Orden: los seis mensajes **B** primero; después espera 45 min (el scope es pegajoso por hilo) o cambia de canal; luego los seis **A**. Los guiones se piden en inglés porque los clientes son angloparlantes; la instrucción a Jarvis va en español. Guarda cada respuesta como `S1-A.txt`, `S1-B.txt`, … antes de barajar.

**Prefijo B (brazo sin corpus):** `Sin skills y sin documentos de screenwriting del KB: escribe el guion tú mismo.`
**Prefijo A (brazo con corpus):** `Usa la skill short-form-script y los documentos de knowledge/screenwriting/ (empieza por 00-index.md).` — la palabra «skill» activa el grupo de herramientas.

### S1 — Solera Properties, spot 30 s (9:16)
```
[PREFIJO]
Escribe en inglés el guion de un spot de 30 segundos, vertical 9:16, para Solera Properties.
Audiencia: compradores de Norteamérica que consideran una segunda casa o una inversión en la costa de Riviera Nayarit.
Objetivo: que descarguen el "Nayarit Investment Brief 2026". Tono: calmado, directo, con datos.
Solo puedes afirmar estos hechos: precio promedio por m² en Riviera Nayarit 1,800–2,800 USD frente a 4,800–6,200 USD en Los Cabos; más de 40 rutas directas desde EE. UU. y Canadá a PVR; 7.4 millones de pasajeros en PVR en 2024, +12 % anual; cada llamada, documento y negociación en inglés; los asesores presentan notarios, abogados y administradores con los que ya han trabajado.
Prohibido decir: guaranteed return, appreciation guarantee.
Entrega: tabla de beats con tiempo, plano, VO, super y CTA.
```

### S2 — Solera Properties, explicativo de objeción 60 s (16:9)
```
[PREFIJO]
Escribe en inglés el guion de un video de 60 segundos, horizontal 16:9, para Solera Properties, que responda la objeción "¿es seguro y es legal comprar ahí?".
Audiencia: los mismos compradores, en la etapa de duda legal y de seguridad.
Objetivo: agendar una llamada. Tono: llano, sin prisa.
Solo puedes afirmar: fideicomiso, título de condominio y ejido se explican en inglés claro antes de cualquier decisión; la pregunta de seguridad se responde con datos (fuentes: SESNSP 2024, Departamento de Estado de EE. UU.); cinco zonas, cinco perfiles de comprador; administración de la propiedad y renta después del cierre.
Debe decir: "in plain English".
Entrega: tabla de beats con tiempo, plano, VO, super y CTA.
```

### M1 — Meridian Bariatrics, testimonial 30 s (9:16)
```
[PREFIJO]
Escribe en inglés el guion de un video testimonial de 30 segundos, vertical 9:16, para Meridian Bariatrics.
Audiencia: adultos de EE. UU. y Canadá a quienes su seguro negó o retrasó una cirugía bariátrica.
Objetivo: agendar una videoconsulta. Tono: cálido, factual.
Solo puedes afirmar: la experiencia de UNA paciente (atribúyela, no la generalices): de la primera llamada a la cirugía en 19 días tras dos años peleando con su seguro; seguimiento por telemedicina de 12 meses incluido; cirujanos certificados y con fellowship, y el paciente conoce a su cirujano antes de operarse; un coordinador responde en 24 horas.
Prohibido decir: cure, guaranteed weight loss, cualquier cifra de libras perdidas.
Entrega: tabla de beats con tiempo, plano, VO, super y CTA.
```

### M2 — Meridian Bariatrics, "cómo funciona" 60 s (9:16)
```
[PREFIJO]
Escribe en inglés el guion de un video explicativo de 60 segundos, vertical 9:16, para Meridian Bariatrics, sobre cómo es el proceso.
Audiencia: los mismos pacientes, investigando qué pasaría paso a paso.
Objetivo: que hagan el cuestionario "Am I a candidate?". Tono: calmado, ordenado.
Solo puedes afirmar: tres pasos: primer contacto sin compromiso, videoconsulta con el equipo quirúrgico, cirugía en Ciudad de México con traslados al aeropuerto; el paquete todo incluido cubre honorarios de cirujano y anestesiólogo, estancia hospitalaria, laboratorios preoperatorios, traslados y 12 meses de telemedicina; el precio final se confirma en la consulta virtual. NO afirmes nada sobre HIPAA ni sobre cumplimiento normativo.
Debe decir: "no commitment".
Entrega: tabla de beats con tiempo, plano, VO, super y CTA.
```

### B1 — Broadcaster, promo para fuerza de ventas 20 s (9:16, es-419)
```
[PREFIJO]
Escribe el guion de una pieza promo de 20 segundos, vertical 9:16, en español latino, para la fuerza de ventas de una televisora, sobre la serie "Serie del Rey".
Audiencia: los vendedores de publicidad de la televisora, no el público.
Objetivo: que presenten a sus clientes el horario del jueves a las 21:00 esta semana.
No te doy ratings ni perfil de audiencia a propósito: donde falte un dato escribe [PROOF NEEDED: …] y no inventes ninguna cifra.
Prohibido decir: cualquier cifra de rating.
Entrega: tabla de beats con tiempo, plano, VO, super, CTA y una columna de fuente.
```

### B2 — Broadcaster, logline + motor de serie (texto)
```
[PREFIJO — en A: "Usa las skills logline-premise-test y series-engine-test."]
Evalúa en inglés esta idea de serie de una hora: "A former customs inspector in Manzanillo runs a two-truck freight firm with her brother, who wants out; each week a shipper with a problem the port authority will not touch, and a rival operator who owns the inspectors she used to work with and wants her routes."
Primero califica el logline (veredicto, elemento más débil, logline reescrito). Después prueba el motor de la serie: los cuatro elementos, el contrato tácito, tres episodios de muestra distintos, si aguanta 100 episodios, tipo de piloto con su razón y el elemento más débil.
```

### Verificación de que el brazo A usó las skills (después de los seis A)
```
sqlite3 -readonly /root/claude/mission-control/data/mc.db "SELECT task_id, tool, ts FROM task_trace_events WHERE tool IN ('skill_run','skill_load') AND ts >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 hours') ORDER BY ts"
```
Seis filas o más: las skills se usaron (`skill_load` cuenta: el modelo carga el cuerpo de la skill y lo aplica en contexto; `skill_run` la ejecuta como llamada aparte — ambas valen). Cero filas: el brazo A fue en realidad un brazo B y la evaluación no vale. Primera prueba en vivo 2026-09-13 01:41 UTC (S1-A, tarea `a11489a9`): clasificador semántico → `skills, coding`; llamadas `ToolSearch → jarvis_file_read (00-index) → skill_load (short-form-script) → jarvis_file_read (doc 13) → file_write`; `short-form-script.use_count` 7 → 8.

### Barajar y calificar
Un ayudante (o Jarvis en un hilo nuevo) lanza una moneda por brief y renombra el par a `S1-slot1.txt` / `S1-slot2.txt`, guardando el mapa aparte. Califica cada slot 1–5 en: usable sin editar (5 = a producción tal cual, 3 = una pasada de edición, 1 = reescribir) · gancho (5 = detiene el pulgar en 3 s, 1 = abre con marca o saludo) · voz (5 = suena al cliente y pasa cover-the-names, 1 = cualquier competidor podría usarlo) · afirmaciones (5 = todo hecho trazable o placeholder, 1 = una cifra o promesa inventada). Revela el mapa, llena la hoja de arriba, aplica la puerta: mediana de A ≥ 4 y A ≥ B en ≥ 5 de 6.
