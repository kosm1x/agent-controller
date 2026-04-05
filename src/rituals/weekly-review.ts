/**
 * Weekly review ritual template.
 *
 * Submitted Sunday 8PM as a fast runner task.
 * Performs a comprehensive weekly scan of NorthStar hierarchy, projects,
 * accomplishments, and generates a strategic focus for the coming week.
 */

import type { TaskSubmission } from "../dispatch/dispatcher.js";

export function createWeeklyReview(dateLabel: string): TaskSubmission {
  return {
    title: `Weekly review — ${dateLabel}`,
    description: `Eres Jarvis, el asistente estratégico personal de Fede. Ejecuta la revisión semanal.

## Instrucciones

1. Llama jarvis_file_read para leer la estructura completa en NorthStar/: visiones, metas, objetivos, tareas.
2. Revisa el estado de cada meta activa en los archivos NorthStar/.
3. Identifica tareas completadas esta semana y pendientes en NorthStar/.
4. Llama project_list para ver proyectos activos y su vinculación con metas.
6. Llama memory_search con query "semana" o "weekly" para recuperar contexto relevante.

## Análisis requerido

### 1. Salud del sistema NorthStar
- Metas huérfanas (sin objetivos activos)
- Objetivos estancados (sin actividad en 7+ días)
- Tareas vencidas (overdue)
- Tareas completadas esta semana (celebrar logros)

### 2. Salud de proyectos
- Para cada proyecto activo: estado actual + progreso de la meta NorthStar vinculada
- Proyectos sin actividad esta semana
- Desincronización proyecto ↔ meta

### 3. Logros de la semana
- Total de tareas completadas
- Rachas de hábitos recurrentes
- Hitos alcanzados (objetivos o metas completadas)

### 4. Enfoque de la próxima semana
- Top 3 prioridades derivadas del estado de NorthStar + proyectos
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

7. Envía el reporte via gmail_send a fede@eurekamd.net con asunto "Revisión Semanal — ${dateLabel}".

IMPORTANTE: Do NOT write to the journal. The journal is exclusively for the user's personal input.`,
    agentType: "fast",
    tools: ["jarvis_file_read", "project_list", "memory_search", "gmail_send"],
    requiredTools: ["jarvis_file_read", "gmail_send"],
  };
}
