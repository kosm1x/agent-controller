---
name: construir-peticion-http
description: Cuando el usuario tiene una URL base y parametros y necesita armar una peticion HTTP GET antes de ejecutarla, construye la URL final con query string y valida que la base sea http o https.
version: 1.0.0
output_type: structured
trigger_examples:
  - "Arma la URL con estos parametros para consultar la API"
  - "Construye la peticion HTTP a partir de esta base y estos datos"
  - "Necesito la URL final con query string para esta consulta"
tools_used:
inputs_json: '[{"name":"base_url","type":"string","required":true,"description":"URL base sin query string, debe empezar con http o https"},{"name":"query_params","type":"object","required":true,"description":"Objeto plano clave valor con los parametros de consulta"}]'
tests_json: '[{"name":"happy_path","input":{"base_url":"https://api.example.com/data","query_params":{"q":"test","limit":"10"}},"expect":{"output_match":{"method":"GET","param_count":2}}},{"name":"bad_scheme","input":{"base_url":"ftp://files.example.com","query_params":{"q":"x"}},"expect_error":{"class":"INVALID_URL","detail_contains":"http"}}]'
---

# Construir peticion HTTP

Toma una URL base y un objeto de parametros y arma la URL final de una peticion GET. No ejecuta la peticion: solo la construye para que el llamador la invoque despues.

## Steps

1. Si `base_url` no empieza con "http://" ni con "https://", devuelve exactamente {"error": "INVALID_URL", "detail": "base_url debe empezar con http o https"} y termina.
2. Toma los pares clave-valor de `query_params`.
3. Construye el query string uniendo cada par como clave=valor con el separador "&".
4. Concatena `base_url`, el caracter "?" y el query string para obtener la URL final. Si `query_params` esta vacio, la URL final es `base_url` sin "?".
5. Cuenta `param_count` = numero de pares en `query_params`.

## Output contract

Devuelve UN unico objeto JSON con estos campos exactos:

- `url` (string): la URL final construida
- `method` (string): siempre "GET"
- `param_count` (number entero)

No incluyas texto fuera del objeto JSON.

## Best practices

- No codifiques ni alteres los valores de los parametros mas alla de unirlos; el llamador se encarga del encoding fino.
- El metodo siempre es GET en esta version de la habilidad.

## Examples

- base_url https://api.example.com/data con {"q":"test","limit":"10"}: url termina en ?q=test&limit=10, method GET, param_count 2.
