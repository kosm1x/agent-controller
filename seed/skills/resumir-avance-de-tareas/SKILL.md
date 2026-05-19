---
name: resumir-avance-de-tareas
description: Cuando el usuario entrega una lista de tareas de un objetivo y pide revisar el avance, calcula totales, cuenta completadas pendientes y vencidas, y produce un resumen de porcentaje de avance.
version: 1.0.0
output_type: structured
trigger_examples:
  - "Revisa el avance de las tareas de este objetivo y dame un resumen"
  - "Cuantas tareas estan completadas y cuantas vencidas en esta lista"
  - "Dame el porcentaje de avance del sprint con estas tareas"
tools_used:
inputs_json: '[{"name":"objective","type":"string","required":true,"description":"Nombre del objetivo al que pertenecen las tareas"},{"name":"tasks","type":"array","required":true,"description":"Lista de objetos tarea con campos title status y due_date"},{"name":"today","type":"string","required":true,"description":"Fecha de hoy en formato YYYY-MM-DD para detectar vencidas"}]'
tests_json: '[{"name":"happy_path","input":{"objective":"Agent-Controller v4.0","tasks":[{"title":"A","status":"done","due_date":"2026-05-01"},{"title":"B","status":"done","due_date":"2026-05-10"},{"title":"C","status":"pending","due_date":"2026-05-05"}],"today":"2026-05-19"},"expect":{"output_match":{"total":3,"completed":2,"pending":1,"overdue":1}}},{"name":"empty_tasks","input":{"objective":"X","tasks":[],"today":"2026-05-19"},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"tasks"}}]'
---

# Resumir avance de tareas

Toma una lista de tareas ya recuperada y la convierte en un resumen cuantitativo de avance. No recupera las tareas: el llamador las pasa como entrada.

## Steps

1. Si `tasks` falta, no es un arreglo, o esta vacio, devuelve exactamente {"error": "INPUT_REQUIRED", "detail": "tasks debe ser una lista no vacia"} y termina.
2. Cuenta `total` = numero de elementos en `tasks`.
3. Cuenta `completed` = tareas cuyo `status` es "done" o "completed".
4. Cuenta `pending` = tareas cuyo `status` NO es "done" ni "completed".
5. Cuenta `overdue` = tareas NO completadas cuyo `due_date` es estrictamente anterior a `today`.
6. Calcula `pct_complete` = redondea a entero (completed / total \* 100).

## Output contract

Devuelve UN unico objeto JSON con estos campos exactos, todos numeros enteros salvo donde se indique:

- `total` (number entero)
- `completed` (number entero)
- `pending` (number entero)
- `overdue` (number entero)
- `pct_complete` (number entero de 0 a 100)
- `summary` (string): una frase en espanol describiendo el estado general

No incluyas texto fuera del objeto JSON.

## Best practices

- `completed` + `pending` siempre debe igualar `total`.
- Una tarea completada nunca cuenta como vencida aunque su due_date sea pasada.

## Examples

- 3 tareas, 2 done, 1 pending con due_date pasada: total 3, completed 2, pending 1, overdue 1, pct_complete 67.
