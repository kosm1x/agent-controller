-- Domain-specific confidence decay (SAGE pattern)
-- Replaces uniform 0.01 decay rate with qualifier-based rates.
-- enforce entries decay 10x slower than workspace entries.
-- Adds corroboration boost: reinforced entries decay slower.

CREATE OR REPLACE FUNCTION kb_retention_score(entry kb_entries)
RETURNS REAL AS $$
  SELECT (
    -- Base decay: salience * exp(-lambda * days)
    -- lambda varies by qualifier (domain-specific volatility)
    entry.salience * exp(
      -1.0 * (
        CASE entry.qualifier
          WHEN 'enforce'     THEN 0.001   -- 693-day half-life (near-permanent)
          WHEN 'always-read' THEN 0.002   -- 346-day half-life
          WHEN 'conditional' THEN 0.005   -- 138-day half-life
          WHEN 'reference'   THEN 0.01    -- 69-day half-life (default)
          WHEN 'workspace'   THEN 0.02    -- 35-day half-life (fast decay)
          ELSE 0.01
        END
      ) * EXTRACT(EPOCH FROM (now() - entry.created_at)) / 86400.0
    )
    -- Corroboration boost: log(1 + reinforcement_count) * 0.1
    -- Each reinforcement slightly increases retention
    * (1.0 + 0.1 * ln(1.0 + COALESCE(entry.reinforcement_count, 0)))
    -- Access recency bonus (unchanged)
    + 0.2 * COALESCE(entry.access_count, 0)
      / GREATEST(1.0, EXTRACT(EPOCH FROM (now() - COALESCE(entry.last_accessed_at, entry.created_at))) / 86400.0)
  )
$$ LANGUAGE SQL STABLE;
