# How to Talk to Jarvis

> This is not an ordinary chatbot. Jarvis is an autonomous agent with 144 tools, internet access, file system control, Google Workspace integration, and the ability to write and deploy code. What you say matters less than how you say it.

## The Core Principle

**Be mechanical, not conceptual.**

Jarvis is brilliant at understanding what you want. He's unreliable at executing it faithfully. The gap between understanding and execution is where every failure in this system has occurred — hallucinated push results, hardcoded data instead of sheet reads, commits to the wrong repo, fabricated error messages.

The fix is always the same: constrain the architecture, not the intent.

---

## Three Rules

### 1. Constrain the HOW, not the WHAT

Jarvis excels at figuring out what to do. He invents how to do it — and his inventions substitute his knowledge for your data, his assumptions for your requirements, his shortcuts for your process.

When you say "reproduce the sheet calculations," he understands planetary harmonics and regenerates from what he knows about astronomy. When you say "the script must fetch from the CSV URL, zero hardcoded data," he follows the architecture because it's a code constraint, not a behavioral request.

| Weak prompt                                  | Strong prompt                                                                                                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Haz una visualización de los harmónicos"    | "Haz una visualización que lea del CSV export de esta sheet. Cero datos hardcodeados. Si la sheet cambia, la visualización cambia."                                                                   |
| "Escribe un script que resuma la sheet"      | "Escribe un script que descargue el CSV de la sheet, parsee cada fila, y genere el resumen desde los datos parseados. No uses tu conocimiento del tema — usa EXCLUSIVAMENTE los valores de la sheet." |
| "Crea un adaptador de intel para Open-Meteo" | "Crea src/intel/adapters/open-meteo.ts siguiendo el patrón exacto de src/intel/adapters/usgs.ts. Mismo interface CollectorAdapter, mismo timeout, mismo error handling."                              |
| "Organiza el repo"                           | "Crea las carpetas src/, docs/, tests/, scripts/ en /root/claude/cuatro-flor-org/. Mueve planet_harmonics.py a src/. Commit al repo EurekaMD-net/cuatro-flor."                                        |

**Why this works:** LLMs can't resist interpreting. They narrativize data, paraphrase exact text, and substitute knowledge for source material. Structural constraints (file paths, data sources, interface patterns) survive the interpretation layer. Behavioral pleas ("relay exactly," "don't change anything") get ignored under complexity.

### 2. Name the files, paths, and repos explicitly

Jarvis loses context between turns. Every message is a fresh task with limited history from prior exchanges. He forgets where files are, which repo he's working on, which directory has the code. He will guess — and guess wrong.

Every request that involves files, repos, or directories must include the full path. Don't assume he remembers.

| Weak prompt                        | Strong prompt                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| "Commitea y pushea"                | "Haz git_commit de los archivos en /root/claude/cuatro-flor/ con cwd=/root/claude/cuatro-flor al repo EurekaMD-net/cuatro-flor" |
| "Lee la sheet que usamos antes"    | "Lee la sheet con ID 11ZKjulKOPaw3xzpLof_6g5PCtxZztMslsPQlzIdJy0k"                                                              |
| "Actualiza el archivo del resumen" | "Actualiza /root/claude/cuatro-flor/src/resumen.md"                                                                             |
| "Sube esto a Drive"                | "Sube /tmp/cuatro_flor_resumen.md a la carpeta 'Jarvis Knowledge Base/projects/' en Google Drive"                               |

**Why this works:** Jarvis's thread buffer preserves ~3000 characters of prior responses. File contents read by tools are evicted between turns. The auto-persist system saves summaries but not raw data. Explicit paths bypass the memory problem entirely — Jarvis doesn't need to remember if you tell him.

### 3. Verify before celebrating

Jarvis reports intent as completion. "Pushed successfully" can mean "I planned to push." "Commit realizado" can mean "I called git_commit" (which may have operated on the wrong directory). He is not lying — he genuinely believes he completed the action because his training conflates planning with execution.

Never accept a narrative claim. Always ask for tool-verified proof.

| Weak prompt           | Strong prompt                                                                 |
| --------------------- | ----------------------------------------------------------------------------- |
| "Listo?"              | "Muéstrame el output de git_status en /root/claude/cuatro-flor/"              |
| "Ya subiste?"         | "Verifica con gh repo view EurekaMD-net/cuatro-flor y muéstrame los archivos" |
| "Funcionó el script?" | "Ejecuta python3 /tmp/script.py y muéstrame el output completo"               |
| "Se guardó la tarea?" | "Lee el archivo NorthStar/tasks/ que acabas de crear con jarvis_file_read"    |

**Why this works:** Tool results are ground truth. LLM text is narrative. When Jarvis calls `git_status` and shows you the output, that's the actual state of the repo. When Jarvis says "commit realizado" without showing you the git output, that's a story.

---

## Patterns That Work

### For coding tasks

```
Escribe [qué] en [ruta exacta].
Sigue el patrón de [archivo de referencia].
Prueba con [comando exacto].
Si pasa: git_commit con cwd=[directorio del proyecto].
Si falla: muéstrame el error.
```

**Example:**

> "Escribe un nuevo adaptador de Intel Depot para Open-Meteo en src/intel/adapters/open-meteo.ts. Sigue el patrón exacto de src/intel/adapters/usgs.ts. Prueba con npx tsc --noEmit. Si pasa, git_commit con cwd=/root/claude/mission-control y pushea."

### For data tasks

```
Lee [fuente exacta con ID/URL].
Usa EXCLUSIVAMENTE los datos de [fuente]. Cero datos hardcodeados.
Guarda en [ruta exacta].
Muéstrame [verificación].
```

**Example:**

> "Lee la Google Sheet 11ZKjulKOPaw3xzpLof_6g5PCtxZztMslsPQlzIdJy0k. Genera un CSV con SOLO los datos de la sheet — no uses tu conocimiento del tema. Guarda en /root/claude/cuatro-flor/data/export.csv. Muéstrame las primeras 5 filas."

### For research tasks

```
Busca [tema específico] con [herramienta: web_search/exa_search/intel_query].
Dame [cantidad] resultados con fuentes.
No inventes — si no encuentras, dilo.
```

**Example:**

> "Busca con exa_search las últimas noticias sobre regulación de AI en México. Dame 5 resultados con URL y fecha. Si no hay resultados recientes, dilo."

### For NorthStar management

```
Lee [archivo exacto de NorthStar] con jarvis_file_read.
[Acción específica]: crear/actualizar/completar.
Escribe con jarvis_file_write.
Verifica leyendo el archivo que escribiste.
```

**Example:**

> "Lee NorthStar/goals/consolidar-eurekamd.md. Agrega un nuevo objetivo: 'Lanzar landing page de CuatroFlor'. Escribe con jarvis_file_write. Léelo de vuelta para confirmar."

---

## What NOT to Do

### Don't be vague when execution matters

- "Hazlo" → Jarvis will do _something_, probably not what you expected
- "Arréglalo" → Jarvis will fix _something_, possibly the wrong thing
- "Súbelo" → Upload where? Which file? To which service?

### Don't trust "listo" without proof

If Jarvis says "✅ Completado" after a complex task, ask: "Muéstrame el output del último tool que llamaste." If he can't show it, he didn't do it.

### Don't give conceptual instructions for mechanical tasks

- "Reproduce la sheet" → He'll reproduce his understanding of the concept
- "Copia los datos exactos de la sheet al script" → He'll read and copy

### Don't assume context survives between messages

Each message is a fresh task. Jarvis gets ~3000 chars of prior conversation + keyword-recalled memories. If you referenced a file 3 messages ago, mention it again.

---

## Understanding Jarvis's Limitations

### Why he "lies"

He doesn't. He conflates planning with execution. When the LLM generates "commit realizado," it's completing a narrative pattern — not verifying the commit actually happened. The hallucination guard catches many of these, but under max-round pressure or with weaker fallback models, fabricated completions slip through.

### Why he ignores your data

When Jarvis has domain knowledge (astronomy, programming patterns, business frameworks), he generates from knowledge instead of reading your source data. This is an inherent LLM behavior — not a bug, not fixable by prompt alone. The fix is structural: make the code READ from the source at runtime, not embed data at write time.

### Why he forgets

Each Telegram message spawns an independent task. The thread buffer carries ~3000 chars of prior exchanges. Tool results (file contents, API responses) are evicted between turns. Auto-persist saves summaries of substantial exchanges, but raw data doesn't survive. Always provide full paths and IDs in each message.

### Why complex tasks fail at the end

Jarvis gets 35 rounds for coding tasks. A complex flow (read sheet → write code → test → iterate → commit → push) can consume 25+ rounds on the code alone, leaving no room for git operations. If a task is this complex, break it into two messages: "Write and test the code" then "Commit and push."

---

## Quick Reference

| You want                 | Say                                                                           |
| ------------------------ | ----------------------------------------------------------------------------- |
| Code from source data    | "Lee de [fuente]. Cero hardcodeado. Si la fuente cambia, el output cambia."   |
| Code following a pattern | "Sigue el patrón exacto de [archivo]. Mismo interface, mismo error handling." |
| Commit to a repo         | "git_commit con cwd=[directorio] al repo [org/repo]"                          |
| Verify an action         | "Muéstrame el output de [tool] en [path]"                                     |
| Break a complex task     | Message 1: "Escribe y prueba." Message 2: "Commitea y pushea."                |
| Recall prior context     | Include the file path, sheet ID, or repo name explicitly                      |
| Prevent invention        | "Usa EXCLUSIVAMENTE los datos de [fuente]. No uses tu conocimiento."          |

---

_This guide is based on 1,200+ production tasks, 5 sessions of hallucination debugging, the COMMIT fiasco (10 failed iterations → NorthStar migration), and 5 iterations of git tool hardening — all in the agent-controller codebase. Every recommendation was earned through failure._
