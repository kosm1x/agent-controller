# VPS Upgrade Checklist — KVM 2 → KVM 4 (or larger)

Estimated total wall time: **~15 minutes** (5–10 min Hostinger resize + 5 min verification).

Run from a stable terminal — not the one inside the VPS, since SSH will drop during the resize.

---

## Pre-upgrade (2 min) — capture baseline

Run from a terminal still connected to the VPS:

```bash
# Disk + RAM + CPU baseline
df -h / | tail -1
free -h | head -2
nproc
docker ps --format 'table {{.Names}}\t{{.Status}}'

# Snapshot baseline numbers somewhere outside the VPS
# (Hostinger weekly backup + the desktop pull both have point-in-time copies if needed)
```

**Confirm before starting:**

- [ ] Last desktop backup ran (`~/vps-backup/backup.log` on Windows desktop shows recent FINISHED line)
- [ ] No running long jobs (`ps aux | grep -E "tsx|build|simulator"` returns nothing critical)
- [ ] No active deploys in progress (`git status` in mission-control is clean or stashed)

---

## Hostinger resize (5–10 min) — their side

1. Log into hPanel → VPS → upgrade plan to **KVM 4** (or larger)
2. Confirm: 4 vCPU, 16 GB RAM, 200 GB disk
3. Hostinger does the resize: brief downtime (~5–15 min), VPS reboots automatically
4. Wait for the panel to show "Running" again

**During downtime:**

- Telegram will go quiet (cron is paused)
- Public endpoints (mycommit.net, db.mycommit.net, studio.mycommit.net) will 502 until reboot completes — that's normal

---

## Post-upgrade verification (5 min)

Reconnect via SSH, then run:

### 1. Hardware grew

```bash
df -h /        # disk should show ~200 GB total (was 96 GB)
free -h        # RAM should show ~16 GB total (was 8 GB)
nproc          # should show 4 (was 2)
```

If `df -h /` still shows 96 GB after the resize, the partition didn't auto-grow:

```bash
# Check available space on the block device
lsblk
# If /dev/sda is bigger than /dev/sda1, resize the partition + filesystem:
growpart /dev/sda 1
resize2fs /dev/sda1
df -h /        # confirm now ~200 GB
```

### 2. Services back up

```bash
systemctl is-active mission-control agentic-crm caddy very-light-cms
docker ps --format 'table {{.Names}}\t{{.Status}}' | grep -v "Up"
# All 4 services "active". All 11 containers "Up" — no missing ones.
```

### 3. Endpoints respond

```bash
curl -sf http://localhost:8080/health && echo "MC OK"
curl -sf http://localhost:8888/health && echo "Hindsight OK"
curl -sf http://localhost:9090/-/healthy && echo "Prometheus OK"
```

### 4. Watchdog + briefing wakeup

```bash
# Force a watchdog run to confirm cron is alive
bash /root/claude/mission-control/scripts/watchdog.sh
tail -3 /var/log/watchdog.log
# Should show "OK: all checks passed"

# Verify cron itself
crontab -l | head -5
systemctl is-active cron
```

### 5. Telegram heartbeat

```bash
# Send a one-line manual confirmation through the same channel watchdog uses
. /root/claude/mission-control/.env
curl -s -o /dev/null -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${TELEGRAM_OWNER_CHAT_ID}" \
  -d parse_mode=HTML \
  -d text="<b>VPS upgrade complete</b>: $(df -h / | awk 'NR==2{print $2" disk, "$5" used"}'), $(free -h | awk '/^Mem:/{print $2" RAM"}'), $(nproc) cores"
```

You should see the message in your Telegram within seconds.

---

## Optional follow-ups (2 min) — once everything is green

### Bump backup retention back to 14 days

We tightened to 7 days when disk was scarce. With 100+ GB of headroom, longer retention is cheap insurance:

```bash
sed -i 's/-mtime +7 -delete/-mtime +14 -delete/' /opt/supabase/backup.sh
grep mtime /opt/supabase/backup.sh   # confirm "+14"
```

### Update memory with the new plan

```bash
# Add a one-liner to project_vps_architecture.md noting the upgrade date and new specs
# (or let next session sync it; the data above will carry forward)
```

### Verify watchdog disk threshold still makes sense

Current Check 5 fires at >90%. With 200 GB, 90% = 180 GB used — that's a much later trigger than before. Probably fine, but consider tightening to >85% if you want earlier warning. No edit required unless you decide.

---

## If something breaks

| Symptom                         | Likely cause                      | Fix                                                                     |
| ------------------------------- | --------------------------------- | ----------------------------------------------------------------------- |
| Disk size unchanged             | Partition didn't auto-grow        | `growpart /dev/sda 1 && resize2fs /dev/sda1`                            |
| `agentic-crm` won't start       | tsx cache stale                   | `rm -rf /tmp/tsx-0 && systemctl restart agentic-crm`                    |
| Caddy serves wrong cert         | Caddy didn't refresh on reboot    | `systemctl restart caddy`                                               |
| SSH won't reconnect             | Hostinger reassigned IP           | Check hPanel for new IP, update local `~/.ssh/config`                   |
| Hindsight CPU spike post-reboot | Stale consolidation task recovery | Follow `project_hindsight_ops.md` § "Known failure: consolidation loop" |

Hostinger weekly backup + desktop nightly pull both have point-in-time recovery if anything goes catastrophically wrong. Worst case: provision fresh KVM 4, restore from backup. ~30 min recovery.

---

## Sign-off

- [ ] Disk shows 200 GB
- [ ] RAM shows 16 GB
- [ ] 4 cores
- [ ] All 4 services active
- [ ] All 11 containers Up
- [ ] All 3 endpoints respond
- [ ] Watchdog OK
- [ ] Telegram heartbeat received
- [ ] (Optional) Backup retention bumped back to 14 days

Done. Working room went from ~7 GB → ~115 GB. Good for 4–6 more medium projects.
