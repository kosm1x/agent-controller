#!/bin/bash
# v7.2 — rebuild the mission-control source-code knowledge graph (AST-only, no LLM).
# Output: data/graphify/code/graphify-out/graph.json (consumed by graphify-code MCP server).
set -euo pipefail

cd "$(dirname "$0")/.."

# Audit W5: assert CWD matches what the MCP config + graph.json paths expect.
# If this script is symlinked or sourced from elsewhere, the relative node
# keys baked into graph.json drift silently.
EXPECTED_CWD="/root/claude/mission-control"
if [ "$(pwd)" != "$EXPECTED_CWD" ]; then
  echo "error: expected CWD=$EXPECTED_CWD, got $(pwd). Run from repo root." >&2
  exit 1
fi

VENV="./venv/graphify"
OUT="./data/graphify/code/graphify-out/graph.json"
TARGET="./src"

if [ ! -x "$VENV/bin/python" ]; then
  echo "error: graphify venv missing at $VENV — run \`python3 -m venv $VENV && $VENV/bin/pip install 'graphifyy[mcp]==0.4.23'\`" >&2
  exit 1
fi

# Audit W4: assert the pinned graphify version. This script uses internal
# modules (graphify.extract, graphify.build, graphify.cluster, graphify.export)
# that are not stable across minor versions; fail loudly on drift.
PIN="0.4.23"
ACTUAL="$("$VENV/bin/python" -c 'import importlib.metadata as m; print(m.version("graphifyy"))' 2>/dev/null || echo "")"
if [ "$ACTUAL" != "$PIN" ]; then
  echo "error: graphifyy version mismatch — expected $PIN, got '$ACTUAL'. Run \`$VENV/bin/pip install 'graphifyy[mcp]==$PIN'\`" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

"$VENV/bin/python" <<'PY'
from pathlib import Path
from graphify.extract import collect_files, extract
from graphify.build import build
from graphify.cluster import cluster
from graphify.export import to_json
import sys

target = Path("./src").resolve()
out = Path("./data/graphify/code/graphify-out/graph.json").resolve()

files = [p for p in collect_files(target, root=target.parent) if not p.name.endswith(".test.ts")]
print(f"extract: {len(files)} files", file=sys.stderr, flush=True)

extraction = extract(files)
G = build([extraction])
print(f"build: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges", file=sys.stderr, flush=True)

communities = cluster(G)
print(f"cluster: {len(communities)} communities", file=sys.stderr, flush=True)

out.parent.mkdir(parents=True, exist_ok=True)
to_json(G, communities, str(out))
print(f"wrote {out}", file=sys.stderr, flush=True)
PY

echo "graph rebuilt at $OUT"
