-- Posthumanismo daily reflection (schedule 9081e6cd): make one source search mandatory per run.
-- Sonnet 5.5 takes the prompt's no-citation branch every run (0 tool calls 6/6 since 2026-09-29);
-- step 2 only asked for web_search "Si vas a citar a un autor". Citation stays optional; the search does not.
-- Idempotent: the WHERE refuses a second application and a drifted prompt (changes() = 0 then).
UPDATE scheduled_tasks
SET description = replace(
  description,
  '2. **Si vas a citar a un autor o atribuir una idea específica a alguien** (Bostrom, Haraway, Kurzweil, Tegmark, etc.):',
  '2. **Ancla la idea en una fuente real (obligatorio en CADA ejecución):** antes de escribir, usa web_search al menos una vez para encontrar un texto real y reciente sobre el tema elegido (ensayo, artículo, entrevista o paper) y web_read para leerlo. Una reflexión escrita sin haber consultado una fuente en ESTA ejecución no cumple el flujo. La cita en el texto sigue siendo opcional; la búsqueda no.
   **Si vas a citar a un autor o atribuir una idea específica a alguien** (Bostrom, Haraway, Kurzweil, Tegmark, etc.):'
)
WHERE schedule_id = '9081e6cd-fa0b-45f7-ad67-71deabc99275'
  AND instr(description, '2. **Si vas a citar a un autor o atribuir una idea específica a alguien** (Bostrom, Haraway, Kurzweil, Tegmark, etc.):') > 0
  AND instr(description, 'obligatorio en CADA ejecución') = 0;
SELECT changes() AS rows_updated;
SELECT schedule_id, active, instr(description, 'web_search al menos una vez') > 0 AS search_mandatory, length(description) AS len
FROM scheduled_tasks WHERE schedule_id = '9081e6cd-fa0b-45f7-ad67-71deabc99275';
