#!/bin/bash
# DENUE pattern catalog test harness — operator-runnable Jarvis integration test.
#
# Submits 12 queries (one per pattern) to the running mc API, polls until all
# complete, and reports first-tool / turn-count / status / output preview for
# each. Scores by ANSWER QUALITY (status=completed + turns<15 + table/ranked
# output), not by tool choice — Jarvis may legitimately route via shell_exec OR
# http_fetch for many patterns.
#
# Usage:
#   ./scripts/test-denue-patterns.sh [iteration-label]
#
# Exit codes: 0 = ≥80% pass, 1 = below threshold (or harness error).
#
# Origin: 2026-05-06 session that took DENUE query success from 1/12 baseline
# to 12/12 across 6 iterations. The 12 patterns mirror
# `/root/claude/jarvis-kb/directives/denue-patterns.md`. Re-run any time the
# inline routing guard in `src/runners/fast-runner.ts` changes, or when
# DENUE Analyzer schema/endpoints shift.
#
# Companion docs:
#   - jarvis-kb/directives/denue-patterns.md        (catalog: intent → path)
#   - jarvis-kb/directives/denue-analyzer-granularities.md (schema reference)
#   - feedback_jarvis_kb_directive_loading.md       (architectural lesson)

set -u
LABEL="${1:-iter1}"
API="${MC_API_URL:-http://localhost:8080}/api/tasks"

# Pull API key from mc env (process env first, then .env file fallback)
KEY="${MC_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$(dirname "$0")/../.env" ]; then
  KEY=$(grep -E '^MC_API_KEY=' "$(dirname "$0")/../.env" 2>/dev/null | cut -d= -f2- | head -1)
fi
if [ -z "$KEY" ]; then
  echo "ERROR: MC_API_KEY not in env and not found in mission-control/.env" >&2
  exit 1
fi

DB="${MC_DB_PATH:-/root/claude/mission-control/data/mc.db}"
RESULTS_DIR="${RESULTS_DIR:-/tmp}"
RESULTS="$RESULTS_DIR/denue-test-$LABEL.tsv"

# Pattern table: NUM|NAME|PROMPT|EXPECTED_TOOL|EXPECTED_SUBSTRING
# Expected tool is informational (not used for scoring — kept for
# diff-tracking how Jarvis routes across iterations).
declare -a PATTERNS=(
  "1|Site selection|Top 10 AGEBs para abrir farmacia en Iztapalapa según el DENUE Analyzer (cve_mun=09007, SCIAN 464111+464112)|http_fetch|cvegeo"
  "2|Demographic ranking|Top 10 municipios con más densidad de gente mayor de 65 años en el DENUE Analyzer|shell_exec|pob65_mas"
  "3|Brand lookup|Cuántas tiendas Neto hay en el DENUE Analyzer? Dame distribución por estado top 10|shell_exec|TIENDAS"
  "4|Vertical footprint|Cuántas farmacias hay en CDMX según el DENUE Analyzer? (entidad=09)|shell_exec|farmacias"
  "5|Competitive saturation|Top 10 cadenas de farmacias dominantes en Guadalajara según el DENUE Analyzer (cve_mun=14039)|shell_exec|razon_social"
  "6|Cross-layer intersection|Top 5 AGEBs en Iztapalapa con rezago Alto y mucha demanda DM2 según el DENUE Analyzer (cve_mun=09007)|http_fetch|rezago"
  "7|Public-data crime|Tendencia de homicidios dolosos en Tlaxcala (entidad=29) según el DENUE Analyzer|http_fetch|delitos"
  "8|Coverage health-check|Cómo va la cobertura nacional del DENUE Analyzer? Dame status por estado|http_fetch|entidades"
  "9|Travel tourism|Top 10 ciudades con mayor afluencia de viajeros aéreos según el DENUE Analyzer|http_fetch|aeropuertos"
  "10|License pharma|Farmacias licenciadas con estupefacientes en Cuauhtémoc según el DENUE Analyzer (cve_mun=09015)|http_fetch|licenciadas"
  "11|Census microdata|Top 10 manzanas más pobladas del AGEB 0900700012475 según el DENUE Analyzer|http_fetch|manzana"
  "12|Mortality drilldown|Top 5 causas de muerte en Iztapalapa (cve_mun=09007) según el DENUE Analyzer|http_fetch|causa"
)

echo "=== DENUE Pattern Test Harness — $LABEL ==="
echo "API: $API"
echo "DB:  $DB"
echo ""
echo "Submitting 12 tasks..."

declare -a TASK_IDS=()
declare -a EXPECTED_TOOLS=()
declare -a EXPECTED_SUBSTRINGS=()
declare -a PATTERN_NAMES=()

for entry in "${PATTERNS[@]}"; do
  IFS='|' read -r num name prompt expected_tool expected_substr <<< "$entry"
  resp=$(curl -sS -X POST "$API" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $KEY" \
    -d "$(jq -nc \
      --arg t "Pattern $num test ($LABEL): $name" \
      --arg d "$prompt" \
      '{title: $t, description: $d, conversationHistory: [{role: "user", content: $d}]}')")
  task_id=$(echo "$resp" | jq -r '.task_id // "ERROR"')
  echo "  P$num ($name): $task_id"
  TASK_IDS+=("$task_id")
  EXPECTED_TOOLS+=("$expected_tool")
  EXPECTED_SUBSTRINGS+=("$expected_substr")
  PATTERN_NAMES+=("$num|$name")
  sleep 0.3
done

echo ""
echo "Polling for completion (timeout 10 min)..."
poll_start=$(date +%s)
while true; do
  pending=0
  for tid in "${TASK_IDS[@]}"; do
    status=$(sqlite3 "$DB" "SELECT status FROM tasks WHERE task_id='$tid';" 2>/dev/null)
    if [[ "$status" == "queued" || "$status" == "running" ]]; then
      pending=$((pending+1))
    fi
  done
  elapsed=$(($(date +%s) - poll_start))
  if [ "$pending" -eq 0 ]; then
    echo "  All 12 complete in ${elapsed}s."
    break
  fi
  if [ "$elapsed" -gt 600 ]; then
    echo "  TIMEOUT — $pending still pending after 10min, continuing with what we have."
    break
  fi
  echo "  ${pending} pending (${elapsed}s elapsed)..."
  sleep 8
done

echo ""
echo "=== Results ==="
printf "%-3s %-25s %-25s %-13s %-6s %s\n" "#" "Pattern" "Status" "First tool" "Turns" "Verdict"
echo "-------------------------------------------------------------------------------------------------------------"

pass=0
fail=0
for i in "${!TASK_IDS[@]}"; do
  tid="${TASK_IDS[$i]}"
  expected_substr="${EXPECTED_SUBSTRINGS[$i]}"
  IFS='|' read -r pnum pname <<< "${PATTERN_NAMES[$i]}"

  row=$(sqlite3 -separator $'\t' "$DB" \
    "SELECT status, output FROM tasks WHERE task_id='$tid';" 2>/dev/null)
  status=$(echo "$row" | cut -f1)
  output=$(echo "$row" | cut -f2-)

  first_tool=$(echo "$output" | jq -r '.toolCalls[0] // "none"' 2>/dev/null)
  num_turns=$(echo "$output" | jq -r '.toolCalls | length // 0' 2>/dev/null)
  text=$(echo "$output" | jq -r '.text // ""' 2>/dev/null | head -c 5000)

  # Quality scoring (NOT tool-choice based):
  #   PASS: status=completed AND turns<15 AND (has expected substring OR markdown table OR ranked list)
  #   WEAK: completed in <15 turns but no recognizable answer structure
  #   MAX_TURNS: completed_with_concerns OR turns >= 15
  has_table=$(echo "$text" | grep -cE '^\| ?[0-9#]')
  has_ranking=$(echo "$text" | grep -ciE 'top *[0-9]+|ranking|\*\*[0-9,]+\*\*')
  has_substr=$(echo "$text" | grep -qi "$expected_substr" && echo 1 || echo 0)

  verdict="?"
  if [[ "$status" == "completed" ]] && [[ $num_turns -lt 15 ]] && { [[ "$has_substr" == "1" ]] || [[ $has_table -gt 2 ]] || [[ $has_ranking -gt 0 ]]; }; then
    verdict="PASS (turns=$num_turns, tool=$first_tool)"
    pass=$((pass+1))
  elif [[ "$status" == "completed" ]] && [[ $num_turns -lt 15 ]]; then
    verdict="WEAK (completed but no clear answer, turns=$num_turns)"
    fail=$((fail+1))
  elif [[ "$status" == "completed_with_concerns" ]] || [[ $num_turns -ge 15 ]]; then
    verdict="MAX_TURNS (turns=$num_turns)"
    fail=$((fail+1))
  else
    verdict="$status"
    fail=$((fail+1))
  fi

  printf "%-3s %-25s %-25s %-13s %-6s %s\n" "P$pnum" "$pname" "$status" "$first_tool" "$num_turns" "$verdict"
  echo "    task=$tid"
  echo "    preview: $(echo "$text" | tr '\n' ' ' | head -c 200)"
  echo ""
done

# Save TSV for cross-iteration diffing.
{
  echo -e "pattern\tname\ttask_id\tstatus\tfirst_tool\tnum_turns\tverdict"
  for i in "${!TASK_IDS[@]}"; do
    tid="${TASK_IDS[$i]}"
    IFS='|' read -r pnum pname <<< "${PATTERN_NAMES[$i]}"
    row=$(sqlite3 -separator $'\t' "$DB" "SELECT status, output FROM tasks WHERE task_id='$tid';" 2>/dev/null)
    status=$(echo "$row" | cut -f1)
    output=$(echo "$row" | cut -f2-)
    first_tool=$(echo "$output" | jq -r '.toolCalls[0] // "none"' 2>/dev/null)
    num_turns=$(echo "$output" | jq -r '.toolCalls | length // 0' 2>/dev/null)
    expected_substr="${EXPECTED_SUBSTRINGS[$i]}"
    text=$(echo "$output" | jq -r '.text // ""' 2>/dev/null)
    has_table=$(echo "$text" | grep -cE '^\| ?[0-9#]')
    has_ranking=$(echo "$text" | grep -ciE 'top *[0-9]+|ranking|\*\*[0-9,]+\*\*')
    has_substr=$(echo "$text" | grep -qi "$expected_substr" && echo 1 || echo 0)
    verdict="?"
    if [[ "$status" == "completed" ]] && [[ $num_turns -lt 15 ]] && { [[ "$has_substr" == "1" ]] || [[ $has_table -gt 2 ]] || [[ $has_ranking -gt 0 ]]; }; then verdict="PASS"
    elif [[ "$status" == "completed" ]] && [[ $num_turns -lt 15 ]]; then verdict="WEAK"
    elif [[ "$status" == "completed_with_concerns" ]] || [[ $num_turns -ge 15 ]]; then verdict="MAX_TURNS"
    else verdict="$status"
    fi
    echo -e "P$pnum\t$pname\t$tid\t$status\t$first_tool\t$num_turns\t$verdict"
  done
} > "$RESULTS"

total=12
pct=$((pass * 100 / total))
echo ""
echo "=== Summary ==="
echo "PASS: $pass / $total ($pct%)"
echo "FAIL: $fail / $total"
echo "TSV:  $RESULTS"

if [ "$pass" -ge $((total * 80 / 100)) ]; then
  echo "✅ Above 80% threshold."
  exit 0
else
  echo "❌ Below 80% threshold — investigate failures + iterate the inline guard in src/runners/fast-runner.ts."
  exit 1
fi
