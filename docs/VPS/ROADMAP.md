# VPS Optimization Roadmap
*Created: 2026-04-04*

## Completed (2026-04-04)

- [x] Hindsight CPU cap (1 core) + reduced consolidation
- [x] Duplicate monitoring containers removed + merged
- [x] Docker mem_limit on monitoring stack
- [x] DB retention script (30-day, daily cron at 4:05 UTC)
- [x] Polling intervals reduced (IPC 3s, messages 3s)
- [x] SQLite pragma tuning (cache 32MB, mmap 64MB)
- [x] Production logger (JSON, no colorize)
- [x] Backup rotation 3 days
- [x] Max containers 5→3
- [x] Docker disk cleanup (5 images removed, 3 GB recovered)
- [x] Prometheus alerting (node-exporter + 12 rules)
- [x] Telegram alert notifications (10 Grafana rules → Telegram)

## Quick Wins (< 30 min each)

### 1. npm prune production
```bash
cd /root/claude/crm-azteca && npm prune --production
cd /root/claude/mission-control && npm prune --production
```
**Impact**: ~50-100 MB disk
**Risk**: Dev deps unavailable until next npm install

### 2. Prometheus alerting rules enhancement
Add alerts for:
- Hindsight container CPU usage (via cAdvisor or docker metrics)
- CRM WhatsApp connection drops
- Supabase DB connection count
**Impact**: Better visibility
**Difficulty**: Easy

## Medium-Term (1-2 weeks)

### 3. Lazy-load Playwright MCP
Only spawn the Playwright browser process when a browsing tool is actually called. Currently loaded at MC startup (98 MB wasted when idle).
**Impact**: -98 MB RAM
**Difficulty**: Medium (needs MCP lazy-init pattern)

### 4. Consolidate CRM schedulers
Replace 4 independent `setInterval` timers with a single `node-cron` dispatcher.
Files: `crm/src/alert-scheduler.ts`, `warmth-scheduler.ts`, `overnight-scheduler.ts`, `followup-scheduler.ts`
**Impact**: Cleaner code, -1% CPU, easier to reason about timing
**Difficulty**: Easy

### 5. Event-driven IPC (replace polling)
Replace filesystem polling (`fs.readdirSync` every 3s per group) with Linux inotify.
Use `chokidar` or `fs.watch` on the IPC directories.
**Impact**: -5-10% idle CPU, lower latency
**Difficulty**: Medium (need graceful fallback)

## Strategic (1-2 months)

### 6. Remote Hindsight instance
Move Hindsight to a dedicated instance or cloud GPU.
**Impact**: -2.2 GB RAM, -1 CPU core freed, -26.9 GB disk
**Difficulty**: Hard (network latency, reliability)
**Prerequisite**: Stable remote hosting option

### 7. VPS upgrade path
If workload grows:
- **Minimum**: 4 vCPU / 16 GB — eliminates swap, supports 5 concurrent containers
- **Recommended**: 4 vCPU / 32 GB — room for growth, Hindsight can run uncapped
- **Ideal**: 8 vCPU / 32 GB + GPU — native ML inference without CPU bottleneck

### 8. Hindsight connection pooling
Add PgBouncer between Hindsight API and embedded PostgreSQL.
10+ idle connections at 63 MB each → pool of 3 connections.
**Impact**: -400 MB RAM inside container
**Difficulty**: Hard (modify container startup, third-party image)

## Monitoring Checklist

After any infrastructure change, verify:
- [ ] `systemctl is-active agentic-crm` → active
- [ ] `systemctl is-active mission-control` → active
- [ ] `docker ps` → all expected containers running
- [ ] `curl -sf http://localhost:8888/health` → Hindsight OK
- [ ] `curl -sf http://localhost:9090/api/v1/targets` → all targets UP
- [ ] `top -bn1` → CPU idle > 50%, load avg < 3.0
- [ ] Telegram test alert → received

## Active Alerting (Telegram)

| Alert | Threshold | Severity | Repeat |
|-------|-----------|----------|--------|
| High CPU | >80% 5m | warning | 4h |
| Critical CPU | >95% 2m | critical | 1h |
| Low Memory | <500MB 5m | warning | 4h |
| Critical Memory | <200MB 2m | critical | 1h |
| High Disk | >85% 5m | warning | 4h |
| High Load | >4.0 10m | warning | 4h |
| High Steal | >20% 5m | warning | 4h |
| High Swap | >50% 10m | warning | 4h |
| MC High Memory | >500MB 10m | warning | 4h |
| MC Event Loop Lag | p99 >500ms 5m | warning | 4h |
