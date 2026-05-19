---
name: clasificar-prioridad-tarea
description: Cuando el usuario necesita asignar prioridad a una tarea segun su fecha limite y si esta bloqueada, clasifica la tarea en alta media o baja con una regla determinista y entrega la justificacion.
version: 1.0.0
output_type: structured
trigger_examples:
  - "Que prioridad le doy a esta tarea con esta fecha limite"
  - "Clasifica la urgencia de esta tarea para mi"
  - "Esta tarea esta bloqueada y vence pronto, que prioridad tiene"
tools_used:
inputs_json: '[{"name":"task_title","type":"string","required":true,"description":"Titulo de la tarea"},{"name":"due_date","type":"string","required":true,"description":"Fecha limite YYYY-MM-DD"},{"name":"today","type":"string","required":true,"description":"Fecha de hoy YYYY-MM-DD"},{"name":"is_blocked","type":"boolean","required":true,"description":"Si la tarea esta bloqueada por otra"}]'
tests_json: '[{"name":"happy_path_alta","input":{"task_title":"Entregar reporte","due_date":"2026-05-20","today":"2026-05-19","is_blocked":false},"expect":{"output_match":{"priority":"alta"}}},{"name":"missing_title","input":{"due_date":"2026-05-20","today":"2026-05-19","is_blocked":false},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"task_title"}}]'
---

# Clasificar prioridad de tarea

Asigna una prioridad determinista a una sola tarea segun cuanto falta para su fecha limite y si esta bloqueada. La regla es fija para que el resultado sea reproducible.

## Steps

1. Si `task_title` falta, es null o es cadena vacia, devuelve exactamente {"error": "INPUT_REQUIRED", "detail": "task_title es obligatorio"} y termina.
2. Calcula `days_until_due` = numero de dias enteros desde `today` hasta `due_date` (negativo si ya vencio).
3. Aplica esta regla en orden y detente en la primera que se cumpla:
   - Si `is_blocked` es true, entonces `priority` = "alta".
   - Si `days_until_due` es menor o igual a 2, entonces `priority` = "alta".
   - Si `days_until_due` es menor o igual a 7, entonces `priority` = "media".
   - En cualquier otro caso, `priority` = "baja".
4. Redacta una `rationale` de una frase explicando que regla aplico.

## Output contract

Devuelve UN unico objeto JSON con estos campos exactos:

- `priority` (string): exactamente uno de "alta", "media", "baja"
- `days_until_due` (number entero, puede ser negativo)
- `rationale` (string): una frase en espanol

No incluyas texto fuera del objeto JSON.

## Best practices

- La regla de bloqueo gana sobre la regla de fecha: una tarea bloqueada siempre es alta.
- No inventes prioridades fuera del enum de tres valores.

## Examples

- Tarea no bloqueada que vence manana (days_until_due 1): priority alta.
- Tarea no bloqueada que vence en 30 dias: priority baja.
