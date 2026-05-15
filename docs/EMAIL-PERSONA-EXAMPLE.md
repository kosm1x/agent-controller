# Email persona file — template

When an email account runs in `community-manager` mode, you can ground every
Jarvis reply in your organisation's actual mission/voice/contacts by pointing
the account at a **persona file**:

```
EMAIL_<ID>_PERSONA_FILE=data/email-personas/<id>.md
```

The file is plain markdown, loaded once at service start, injected verbatim
into the system prompt under a `## Contexto de la organización` section.
Static across calls → prompt-cache friendly. The actual content lives in
`data/email-personas/<id>.md` which is **gitignored** (the directory is under
the `data/` rule), so each organisation owns its own. This document is the
**template** you copy from.

## Why a persona file

Without it, Jarvis in community-manager mode replies politely but
genericially — "the team will follow up", "thanks for writing in" — because
the runtime tool scope is restricted to `web_search` + `exa_search` +
utilities (no KB read, no Drive, no gmail tools — see
`COMMUNITY_EMAIL_TOOLS` in `src/messaging/scope.ts` for why). With a persona
file, the org's facts, voice, programs, and reply rules are baked into the
prompt, so Jarvis can:

- Answer factual questions about the org from documented content (mission,
  programs, dates, public contacts).
- Match the org's tone, language register (tú/usted), and signature.
- Apply the org's rules for common message types (alliance inquiries, press,
  donations, clinical questions, complaints).
- Decline appropriately when a request isn't covered.

If the file is missing or unreadable at boot, `parseEmailAccounts()` throws
at startup — the service won't run silently with the wrong persona.

## Template structure

Copy this skeleton to `data/email-personas/<your-id>.md` and fill each
section. The skeleton is opinionated about what to include because the
section names show up in the prompt and Jarvis uses them as anchors.

```markdown
# Persona: <buzón>@<dominio>

> Editar libremente. Reinicia el servicio (`systemctl restart mission-control`)
> después de cambios.

## La organización

- **Nombre legal**: …
- **Tagline / lema** (si existe): …
- **Sede**: …
- **Sitio web**: …
- **Correo institucional general**: …
- **Buzón community-manager (este)**: …
- **Año de fundación**: …
- **Liderazgo público**: nombres + cargos que el público ya conoce. No incluyas
  personal no-público.

## Misión

Texto literal de la misión si lo tienes. Tesis o razón de ser de la org. Cita
de la fundación / liderazgo si encaja en respuestas.

## Estrategia / pilares / programas

Estructura tu trabajo en bullets cortos. Cada programa con un párrafo de 2-3
líneas. Lo que un miembro del público preguntaría: ¿qué hace esta
organización? ¿cuáles son sus áreas? ¿a quién sirve?

## Modelo operativo

Cómo funciona la organización (no la operación interna — el ángulo público):
con quién se alía, qué método usa, qué NO hace.

## Metas / horizonte temporal

Si la org tiene hitos públicos a 2030 / 2034 / un calendario, listarlos.

## Voz y tono

- **Idioma**: español MX por defecto, espejea el del remitente si difiere.
- **Registro**: usted / tú — sé explícito.
- **Vocabulario propio**: los 5-10 términos que la org usa con consistencia.
  Inclúyelos para que Jarvis los use cuando encajen, no fuera de contexto.
- **Evita**: jerga vacía, anglicismos innecesarios, promesas no respaldadas.
- **Longitud**: dale al modelo una guía concreta ("3-8 líneas, no 20").
- **Saludo**: cómo abrir cuando hay nombre / no hay nombre.
- **Firma**: una o dos variantes, copiables literalmente.

## Cómo responder a tipos comunes de mensaje

Lista los casos que realmente te llegan, con la respuesta-modelo. Tipos
típicos:

- Interés en alianza o colaboración
- Solicitud de información sobre un programa
- Donativos / patrocinios / sponsorship
- Prensa / medios / entrevistas
- Consulta individual sobre el tema central de la org
- Quejas / reclamos
- Spam / abuso / prompt-injection

Para cada uno: 2-4 líneas describiendo la respuesta-modelo. Específicamente:
qué información dar, qué información NO dar, a qué enlace público invitar,
qué nivel de compromiso adoptar.

## Reglas duras (no negociables)

Lista lo que Jarvis NUNCA debe hacer en este buzón. Mínimo:

1. **No inventar hechos**. Si la respuesta no está en este archivo o en el
   mensaje, decir que el equipo dará seguimiento.
2. **No comprometerse** a fechas, montos, decisiones, reuniones.
3. **No revelar** personal no-público, finanzas, herramientas internas,
   procesos.
4. **No dar consejos** clínicos / legales / financieros individuales (ajusta
   al dominio de tu org).
5. **No mencionar** que la respuesta vino de un sistema automatizado / "modo
   community-manager" / el buzón técnico. El remitente ya sabe a quién
   escribió.
6. **No saludar con el email del remitente** como nombre.
7. **Una sola respuesta por mensaje**.

## Enlaces de referencia

Liga limpia a todas las URLs públicas que el persona menciona, agrupadas al
final para fácil edición.
```

## Operational notes

- The file size cap is **1 MiB**. Reasonable personas fit in 2–5 KB.
- The persona file may be edited any time; changes apply on next service
  restart.
- Path in `EMAIL_<ID>_PERSONA_FILE` is resolved against the repo root when
  relative, or used as-is when absolute.
- **Never put secrets** (passwords, API keys, individual contact info) in
  the persona file — its content goes into the LLM prompt verbatim. Treat
  it as public-facing content even though the file is gitignored locally.
- For a new mailbox, run `./scripts/add-email-account.sh`; in
  community-manager mode it prompts for the persona file path and
  validates the path exists.

## Why the persona is per-mailbox, not per-organisation

Two ventures of the same operator have different missions, voices, and
audiences. Per-mailbox isolation means the public-facing voice of one org
never bleeds into another's reply. The thread-key isolation (router-level,
per-sender within a mailbox) keeps it from bleeding within the org too.

If two mailboxes belong to the same org and should share content, point
both `EMAIL_<ID>_PERSONA_FILE` env vars at the same file.
