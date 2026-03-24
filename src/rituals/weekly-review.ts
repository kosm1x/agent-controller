/**
 * Weekly review ritual template.
 *
 * Submitted Sunday 8PM as a Heavy runner task.
 * Performs a comprehensive weekly scan of COMMIT hierarchy, projects,
 * accomplishments, and generates a strategic focus for the coming week.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createWeeklyReview(dateLabel: string): TaskSubmission {
  return {
    title: `Weekly review — ${dateLabel}`,
    description: `Eres Jarvis, el asistente estratégico personal de Fede. Ejecuta la revisión semanal.

## Instrucciones

1. Llama commit__get_hierarchy para ver la estructura completa: visiones, metas, objetivos, tareas.
2. Llama commit__list_goals con status "in_progress" para revisar el estado de cada meta activa.
3. Llama commit__list_tasks para ver tareas completadas esta semana y pendientes.
4. Llama commit__get_daily_snapshot para obtener el resumen del día y racha actual.
5. Llama project_list para ver proyectos activos y su vinculación con metas COMMIT.
6. Llama memory_search con query "semana" o "weekly" para recuperar contexto relevante.

## Análisis requerido

### 1. Salud del sistema COMMIT
- Metas huérfanas (sin objetivos activos)
- Objetivos estancados (sin actividad en 7+ días)
- Tareas vencidas (overdue)
- Tareas completadas esta semana (celebrar logros)

### 2. Salud de proyectos
- Para cada proyecto activo: estado actual + progreso de la meta COMMIT vinculada
- Proyectos sin actividad esta semana
- Desincronización proyecto ↔ meta

### 3. Logros de la semana
- Total de tareas completadas
- Rachas de hábitos recurrentes
- Hitos alcanzados (objetivos o metas completadas)

### 4. Enfoque de la próxima semana
- Top 3 prioridades derivadas del estado de COMMIT + proyectos
- Tareas críticas que requieren atención
- Sugerencias estratégicas (replanteamiento de metas estancadas, nuevos objetivos)

## Formato del email (Spanish, Mexican)

**Revisión Semanal** 📊 Semana del ${dateLabel}

**🏆 Logros de la semana**
- X tareas completadas
- [hitos alcanzados]
- Racha: X días consecutivos

**📋 Estado de metas activas**
| Meta | Progreso | Estado |
|------|----------|--------|
| ... | X/Y objetivos | 🟢/🟡/🔴 |

**🔍 Proyectos**
- [proyecto]: [estado + vinculación con meta]

**⚠️ Atención requerida**
- [metas estancadas, tareas vencidas, desincronizaciones]

**🎯 Enfoque próxima semana**
1. [prioridad 1 — por qué]
2. [prioridad 2 — por qué]
3. [prioridad 3 — por qué]

**💡 Sugerencia estratégica**
[una recomendación concreta basada en los patrones observados]

7. Envía el reporte via gmail_send a fede@eureka.md con asunto "Revisión Semanal — ${dateLabel}".

IMPORTANTE: Do NOT write to the journal. The journal is exclusively for the user's personal input.`,
    agentType: "heavy",
    tools: [
      "commit__get_hierarchy",
      "commit__get_daily_snapshot",
      "commit__list_goals",
      "commit__list_objectives",
      "commit__list_tasks",
      "project_list",
      "memory_search",
      "gmail_send",
    ],
    requiredTools: ["commit__get_hierarchy", "gmail_send"],
  };
}
