---
name: planificar-proyecto-por-fases
description: Cuando el usuario propone una idea, proyecto, herramienta o emprendimiento nuevo, genera un plan estructurado en 5 fases secuenciales con validacion de ROI obligatoria por etapa.
version: 1.0.0
output_type: structured
trigger_examples:
  - "Quiero construir un CRM para mi equipo de ventas, dame un plan por fases"
  - "Como estructuro el desarrollo de esta nueva herramienta paso a paso"
  - "Necesito un plan de fases para lanzar este emprendimiento"
tools_used:
inputs_json: '[{"name":"project_idea","type":"string","required":true,"description":"La idea o proyecto a planificar"},{"name":"project_type","type":"enum","values":["software","negocio","habilidad"],"required":true,"description":"Categoria del proyecto"}]'
tests_json: '[{"name":"happy_path","input":{"project_idea":"un CRM para ventas","project_type":"software"},"expect":{"output_match":{"phase_count":5,"roi_gate_required":true}}},{"name":"missing_idea","input":{"project_type":"software"},"expect_error":{"class":"INPUT_REQUIRED","detail_contains":"project_idea"}}]'
---

# Planificar proyecto por fases

Meta-formato de ingenieria aplicado a cualquier proyecto (software, negocio o habilidad) descompuesto en fases secuenciales, cada una con un semaforo de ROI antes de avanzar.

## Steps

1. Si `project_idea` falta, es null o es cadena vacia, devuelve exactamente {"error": "INPUT_REQUIRED", "detail": "project_idea es obligatorio"} y termina.
2. Define la Vision de Exito: una sola frase que describa que significa que el proyecto este terminado y sea un exito medible.
3. Genera EXACTAMENTE 5 fases, en este orden fijo: (1) Cimientos: validacion y arquitectura; (2) Motor/Core: construccion del funcional principal; (3) Filtro/Refinamiento: logica de negocio e inteligencia; (4) Almacenamiento/Integracion: persistencia y conexion con sistemas externos; (5) Automatizacion y Escala: ejecucion recurrente, monitoreo y optimizacion de costos.
4. Para cada fase produce un objeto con `name` (string) y `objective` (string de una frase adaptada a `project_idea`).
5. Recuerda que cada fase exige una validacion de costo-beneficio antes de avanzar a la siguiente.

## Output contract

Devuelve UN unico objeto JSON con estos campos exactos:

- `success_vision` (string): la vision de exito de un solo enunciado
- `phases` (array): exactamente 5 objetos, cada uno {name, objective}
- `phase_count` (number): el numero 5
- `roi_gate_required` (boolean): el valor true

No incluyas texto fuera del objeto JSON.

## Best practices

- Las fases son siempre 5 y siempre en el mismo orden; no las renombres ni las fusiones.
- Adapta cada `objective` al `project_idea` concreto, no uses descripciones genericas.

## Examples

- Entrada {"project_idea":"un blog de finanzas","project_type":"negocio"} produce phase_count 5, roi_gate_required true, y 5 fases adaptadas al blog.
