# Graphify Knowledge-Graph Bootstrap

v7.2 introduced the `graphify-code` MCP server which queries an AST-derived knowledge graph of the mission-control source tree. The graph is **not checked into git** (`data/` and `venv/` are gitignored) because it's a large, machine-specific artifact that should be rebuilt from source.

On a **fresh deployment** (new VPS, cloned repo, no prior state) you must bootstrap it before mission-control will boot cleanly — otherwise the `graphify-code` MCP server fails to connect with `graph.json not found` and mission-control logs `[mcp] DEGRADED`.

## One-time bootstrap

```bash
cd /root/claude/mission-control

# 0. If fresh clone: seed the MCP config. mcp-servers.json is gitignored;
# the committed example includes the graphify-code block.
[ -f mcp-servers.json ] || cp mcp-servers.example.json mcp-servers.json

# 1. Create an isolated Python venv (Python 3.10–3.12; 3.13+ not supported upstream)
python3 -m venv ./venv/graphify

# 2. Install graphifyy (pinned — internal API used by scripts/build-graphify-code.sh)
./venv/graphify/bin/pip install 'graphifyy[mcp]==0.4.23'

# 3. Build the initial code graph (AST-only, no LLM cost)
./scripts/build-graphify-code.sh
```

Expected output from step 3:

```
extract: 335 files
build: 1757 nodes, 4686 edges
cluster: 25 communities
wrote /root/claude/mission-control/data/graphify/code/graphify-out/graph.json
graph rebuilt at ./data/graphify/code/graphify-out/graph.json
```

Counts will drift as the codebase grows. Expect **node count ≈ 5× file count** and **edge count ≈ 2–3× node count**.

## Rebuild cadence

The graph is AST-only — it captures symbols, imports, and call relationships but **not** the semantic relationships that graphify's skill-driven LLM pass adds (which requires an Anthropic budget and is deferred to v7.2.1). Rebuild the graph whenever the structural view is meaningfully stale:

- After every major sprint that adds/removes source files (~25+ file delta)
- Before expecting `graphify-code__query_graph` to return accurate paths for newly-added code
- Not needed for edits within existing files — symbol names rarely change

Just re-run `./scripts/build-graphify-code.sh`. The script rewrites `graph.json` in-place and takes <30 seconds on the current codebase. Graphify's internal SHA256 cache (`graphify-out/cache/`) makes repeat builds incremental.

## Version pinning

`scripts/build-graphify-code.sh` imports graphify's Python-level internal modules (`graphify.extract`, `graphify.build`, `graphify.cluster`, `graphify.export`). Those APIs are not promised stable across minor versions. The install command pins `graphifyy==0.4.23`; the script asserts that version at startup. If you upgrade, re-validate the bootstrap produces sensible counts.

## Troubleshooting

| Symptom                                                                 | Cause                                                | Fix                                                                                        |
| ----------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Boot log: `graphify-code: failed to connect — Graph file not found`     | `data/graphify/code/graphify-out/graph.json` missing | Run `./scripts/build-graphify-code.sh`                                                     |
| Boot log: `graphify-code: failed to connect — No module named graphify` | venv missing or wrong Python                         | Re-run the 3-step bootstrap                                                                |
| `graph_stats` returns `Nodes: 0`                                        | Corpus subset hit the wrong path                     | Verify `TARGET="./src"` in `scripts/build-graphify-code.sh` and rerun                      |
| `god_nodes` dominated by test files                                     | Build missed the `.test.ts` exclusion                | Check the `collect_files` filter in the script; should exclude `.test.ts`                  |
| Graph build fails with `graspologic` / `Python 3.13` error              | Python version too new                               | Recreate venv with Python 3.12: `rm -rf venv/graphify; python3.12 -m venv ./venv/graphify` |

## Deferrals (v7.2.1 and later)

The v7.2 MVP ships **AST-only** knowledge of `src/` code. The following are deliberately out of scope:

- **Codebase semantic extraction** — adds LLM-derived relationships (docstrings, comments, cross-reference inference). Deferred until upstream issue #451 (duplicate nodes from parallel semantic subagents) is confirmed fixed on our 360-file corpus.
- **Docs/markdown corpus** — graphify has no first-class markdown extractor; would require either upstream extractor work or a semantic LLM pass (cost-heavy).
- **CRM entity graph** — requires a markdown-export pipeline out of crm-azteca. Scheduled for v7.2.1 after the CRM pilot stabilizes.
- **Cross-source unified query** — ships after ≥2 graphs exist.
- **Automatic rebuild cron** — not wired. First stale-graph incident will trigger scheduling.
