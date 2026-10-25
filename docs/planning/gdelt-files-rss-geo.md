# Plan: reemplazar la API de GDELT por archivos GDELT + RSS geopolitico

Motivo: api.gdeltproject.org devuelve HTTP 429 persistente a la IP del VPS (incluso con consulta minima).
data.gdeltproject.org es otro host y responde 200 (probado 2026-10-24).

## Pasos
1. Adaptador `gdelt` (archivos): lee `lastupdate.txt`, baja `export.CSV.zip` (https), lo descomprime con zlib
   y emite: events_count, goldstein_avg, avg_tone (numericos) y hasta 15 eventos de conflicto material
   (QuadClass 4) por NumMentions, con geo. Verificar: tests con zip sintetico.
2. Adaptador `geo_rss` (domain geopolitical): Google News (consulta de hoy), BBC, Al Jazeera, DW, France24,
   ReliefWeb. Deduplica por URL, tolera que falle un feed pero lanza si fallan todos. Emite conflict_articles.
3. Hard-cut: se elimina el adaptador de la API (`gdelt.ts` reescrito, sin fallback). Registro, delta-engine
   (conflict_articles -> geo_rss; goldstein_avg sigue en gdelt) y descripciones de tools actualizados.
4. Tests (adapters.test.ts), typecheck, commit y push en la rama jarvis/feat/gdelt-files-rss-geo.

Desviacion: no se usa el gkg; AvgTone ya viene en el export.
