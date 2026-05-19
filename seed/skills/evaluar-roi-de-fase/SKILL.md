---
name: evaluar-roi-de-fase
description: Cuando el usuario necesita decidir si avanzar a la siguiente fase de un proyecto, calcula la razon de retorno sobre inversion y entrega un veredicto de semaforo verde amarillo o rojo.
version: 1.0.0
output_type: structured
trigger_examples:
  - "Vale la pena avanzar a la siguiente fase, evalua el ROI"
  - "Dame el semaforo de viabilidad de esta fase del proyecto"
  - "Calcula el retorno de inversion de esta etapa antes de continuar"
tools_used:
inputs_json: '[{"name":"phase_name","type":"string","required":true,"description":"Nombre de la fase a evaluar"},{"name":"time_cost_hours","type":"number","required":true,"description":"Horas estimadas de esfuerzo para la fase"},{"name":"expected_value_score","type":"number","required":true,"description":"Puntaje de valor esperado de 0 a 100"}]'
tests_json: '[{"name":"happy_path_verde","input":{"phase_name":"Motor Core","time_cost_hours":10,"expected_value_score":80},"expect":{"output_match":{"verdict":"verde","roi_ratio":8}}},{"name":"bad_cost","input":{"phase_name":"X","time_cost_hours":0,"expected_value_score":50},"expect_error":{"class":"INVALID_INPUT","detail_contains":"time_cost_hours"}}]'
---

# Evaluar ROI de fase

Calcula la razon de retorno sobre inversion de una fase y la traduce a un semaforo de viabilidad. Sirve como compuerta obligatoria antes de avanzar a la siguiente fase de un proyecto.

## Steps

1. Si `time_cost_hours` falta, no es numero, o es menor o igual a 0, devuelve exactamente {"error": "INVALID_INPUT", "detail": "time_cost_hours debe ser un numero mayor que 0"} y termina.
2. Calcula `roi_ratio` = `expected_value_score` dividido entre `time_cost_hours`. Redondea a un decimal; si el resultado es entero deja el entero.
3. Aplica esta regla de semaforo en orden y detente en la primera que se cumpla:
   - Si `roi_ratio` es mayor o igual a 2, entonces `verdict` = "verde".
   - Si `roi_ratio` es mayor o igual a 1, entonces `verdict` = "amarillo".
   - En cualquier otro caso, `verdict` = "rojo".
4. Redacta una `recommendation` de una frase: verde significa avanzar, amarillo significa avanzar con cautela, rojo significa replantear la fase.

## Output contract

Devuelve UN unico objeto JSON con estos campos exactos:

- `roi_ratio` (number): el cociente calculado
- `verdict` (string): exactamente uno de "verde", "amarillo", "rojo"
- `recommendation` (string): una frase en espanol

No incluyas texto fuera del objeto JSON.

## Best practices

- Un costo de cero o negativo no es valido: no se puede dividir, se devuelve error.
- El semaforo es determinista por umbral; no apliques juicio adicional fuera de la regla.

## Examples

- expected_value_score 80, time_cost_hours 10: roi_ratio 8, verdict verde.
- expected_value_score 30, time_cost_hours 40: roi_ratio 0.8, verdict rojo.
