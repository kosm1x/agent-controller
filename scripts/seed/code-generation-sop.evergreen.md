# SOP: Generación de Código — Memoria y Aprendizajes

> **LEER ANTES de planear o escribir código.** Este archivo contiene los principios evergreen. Las evaluaciones por proyecto y aprendizajes específicos están en `knowledge/journal/code-evaluations.md` (no auto-inyectado — léelo cuando trabajes en ese proyecto).

---

## Protocolo Pre-Código (obligatorio)

### 1. Antes de planear

- [ ] Inspeccionar la API / formato real **antes** de asumir campos — 1 llamada de prueba evita 3 fix cycles
- [ ] Leer los archivos existentes con `file_read` o `grep` — nunca asumir el contenido
- [ ] Verificar paths permitidos para `file_write` (`/root/claude/`, `/tmp/`, `/workspace/`)
- [ ] Estimar turnos con margen del 40% — la complejidad real siempre supera el estimado optimista
- [ ] Identificar restricciones antes de empezar: ¿feature-freeze? ¿paths bloqueados? ¿herramientas no disponibles?

### 2. Antes de escribir código

- [ ] Inspeccionar respuestas reales de APIs externas (raw response, campos disponibles) — no confiar en documentación
- [ ] Mapear todos los puntos de integración (imports, registros, scope, tests) antes del primer archivo
- [ ] Si el proyecto usa TypeScript: identificar todas las interfaces que necesitan nuevos campos antes de tocar código

### 3. Antes de hacer commit

- [ ] `npx tsc --noEmit` — zero errores obligatorio
- [ ] Grep-sweep del anti-patrón corregido en todo el codebase
- [ ] Verificar que `.gitignore` excluye: `data/`, `output/`, `.env`, `*.db`
- [ ] Confirmar que no hay tests pre-existentes fallando que yo causé

---

## Patrones que Funcionan

### Descubrimiento de API en 2 pasos (antes de implementar)

```bash
# 1. Llamada raw para ver el formato real
# 2. Inspeccionar campos disponibles
# Luego implementar el parser
```

### Fix cycles que se pueden evitar

| Error común                         | Verificación previa que lo evita                           |
| ----------------------------------- | ---------------------------------------------------------- |
| Campo inexistente en API            | Raw call manual antes de tipar                             |
| Filtro elimina todos los results    | Probar con datos reales antes de aplicar filtros           |
| Import de named export como default | Leer el archivo de exportación con `grep export`           |
| Tipo faltante en interfaz           | Mapear todos los consumidores antes de definir la interfaz |
| Path no permitido para `file_write` | Verificar paths permitidos al inicio                       |

### Estrategia de recuperación

- Si el mismo fix falla 3 veces → parar, declarar hipótesis errónea, proponer enfoque diferente
- Si el shell timeout corta un proceso largo → correr en background con `&`, capturar output a archivo
- Si `tsx` da comportamiento extraño → limpiar cache `/tmp/tsx-0/`

---

## Checklist de Integración (mission-control específico)

Para nueva tool en Jarvis:

1. Handler en `src/tools/builtin/{name}.ts`
2. Registrar en `allTools` + `registerTools` en `src/tools/sources/`
3. Agregar al grupo de scope en `src/messaging/scope.ts`
4. Si read-only → agregar a `READ_ONLY_TOOLS` en `src/inference/guards.ts`
5. Test file con mocks
6. `npx tsc --noEmit` → zero errores
7. `npm test` → todos los tests pasan (verificar que fallas son pre-existentes, no mías)

Para MCP server externo:

1. Implementar con `@modelcontextprotocol/sdk`, stdio transport
2. Build a `dist/` antes de registrar
3. Registrar en `mcp-servers.json` de mission-control
4. Restart de mission-control (no rebuild necesario para config changes)
5. Test end-to-end: `tools/list` devuelve tools esperadas

---

## Métricas de Calidad

| Dimensión                      | Objetivo      |
| ------------------------------ | ------------- |
| Estimación de turnos           | ±20% del real |
| Bugs anticipados pre-código    | >70%          |
| Fix cycles por fase            | ≤2            |
| Typecheck al primer intento    | 100%          |
| Recuperación ante bloqueadores | Fluida        |

Calificación actual y desglose por proyecto: ver `knowledge/journal/code-evaluations.md`.

---

## REGLA: Evaluación Post-Tarea (OBLIGATORIA)

**Después de cada tarea que involucre código**, antes de reportar "listo", debo:

1. Hacer una evaluación honesta con las dimensiones: Planeación, Generación de Código, Estimación de Turnos, Anticipación de Bugs, Recuperación
2. Calificar cada dimensión (A/B/C/D con +/-)
3. Identificar 1-2 patrones nuevos aprendidos
4. Hacer **append de esa evaluación al archivo journal** `knowledge/journal/code-evaluations.md` (no a este SOP)
5. Si surge un patrón nuevo evergreen (no project-specific), agregarlo aquí en `Patrones que Funcionan` o `Fix cycles que se pueden evitar`

Esta regla no tiene excepciones. Si la tarea fue simple (1-2 archivos), la evaluación puede ser breve — pero debe existir.
