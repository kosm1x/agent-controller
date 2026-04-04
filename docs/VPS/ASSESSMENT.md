# VPS & Code Efficiency Assessment
*Last updated: 2026-04-04*
*Assessed by: Claude Opus 4.6 + kosm1x*

## Hardware Specs

| Resource | Spec | Rating |
|----------|------|--------|
| CPU | 2 vCPU (AMD EPYC 9354P) | **D+** — undersized for workload |
| RAM | 8 GB + 4 GB swap | **C** — functional but swap-dependent |
| Disk | 96 GB SSD | **B+** — generous, 31 GB free |
| Hypervisor | Shared (steal time up to 52%) | **C-** — overcommitted host node |

**VPS Overall: C** — Functional but undersized. This is a 4-core, 16 GB workload.

## Memory Map (Resident, ~6.2 GB total)

| Component | RAM | % of Total | Notes |
|-----------|-----|------------|-------|
| Hindsight (Python + ML + PG) | 2,230 MB | 36% | Local embeddings + reranker on CPU. Biggest consumer |
| Claude Code + TSServer (LSP) | 2,900 MB | 47% | Transient — only active during dev sessions |
| CRM Engine (tsx) | 235 MB | 4% | Lean for 70-tool CRM |
| Mission Control + Playwright | 236 MB | 4% | Lean orchestrator |
| Docker containers (11) | 435 MB | 7% | Supabase + monitoring |
| System (journald, dockerd) | 150 MB | 2% | Normal |

## Code Efficiency Grades

### CRM Engine (crm-azteca) — **B**
- 235 MB for full CRM + WhatsApp + 70 tools + vector search + Google Workspace
- Polling-based design (IPC 3s, messages 3s, scheduler 60s) — functional but not event-driven
- SQLite pragmas well-tuned (WAL on MC, DELETE on CRM for Docker compat)
- Circuit breaker for external deps is well-designed
- Room to improve: inotify instead of polling would cut idle CPU ~80%

### Mission Control — **B+**
- 138 MB for 5-runner orchestrator with self-tuning
- Clean architecture: singleton discipline, vendor-agnostic inference, write retry with jitter
- Playwright MCP always loaded (98 MB) even when not needed — lazy-load would help
- DB retention was missing (fixed 2026-04-04, now 30-day auto-cleanup)

### Hindsight — **D** (third-party, deployment mismatch)
- 1.6 GB Python + ML models + 630 MB PG connections = 2.2 GB total
- Designed for GPU-backed servers, running on 2-core VPS
- Consolidation recall: 6-9 min CPU-bound vector search per 8-memory batch
- Now capped at 1 CPU core + reduced consolidation concurrency
- 10+ idle PG connections at 63 MB each — needs connection pooling

## Fixes Applied (2026-04-04)

1. **Hindsight CPU cap** — `--cpus=1.0`, consolidation slots 2→1, batch size 8→4
2. **Duplicate monitoring removed** — merged prometheus targets, killed old stack (-104 MB)
3. **Docker resource limits** — mem_limit on prometheus (256M) + grafana (256M) + node-exporter (64M)
4. **DB retention** — 30-day auto-cleanup for tasks, runs, cost_ledger, telemetry (cron 4:05 UTC)
5. **Polling intervals** — IPC 1s→3s, messages 2s→3s (-67% scan frequency)
6. **SQLite pragmas** — cache 64→32 MB, mmap 256→64 MB (-224 MB virtual)
7. **Logger** — pino-pretty disabled in production (JSON to journalctl)
8. **Backup retention** — 7→3 days (-77 MB disk)
9. **Max containers** — 5→3 (matches 2-core reality)
10. **Docker disk cleanup** — removed 5 unused images (3 GB), build cache pruned
11. **Alerting** — 10 Grafana alert rules → Telegram notifications (confirmed working)

## Disk Waste (Actionable)

| Item | Size | Action |
|------|------|--------|
| Docker images (reclaimable) | 38 GB | `docker system prune` — safe, recovers 38 GB |
| Docker build cache | 3.1 GB | `docker builder prune` — safe |
| node_modules (2 projects) | 434 MB | `npm prune --production` in each |
| MC backups (rotating) | ~240 MB | Auto-managed (3-day retention) |

## Bottleneck Priority

1. **CPU (2 cores)** — hard ceiling. Hindsight ML + CRM + MC + containers compete for 2 cores
2. **RAM (8 GB)** — swap-dependent during dev sessions (Claude + TSServer = 2.9 GB transient)
3. **Hypervisor steal** — uncontrollable, depends on VPS provider neighbor load
4. **Disk** — not a bottleneck (31 GB free, 38 GB reclaimable)
