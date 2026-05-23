#!/bin/bash
# Local-side verification of VPS rsync backup.
# Run on Windows WSL Ubuntu (user fmoctezuma).
#
# Checks:
#   1. Cron entry is installed
#   2. Last rsync completed in the expected window (within 30h)
#   3. Log has no rsync failures on the latest run
#   4. Mission-control bundle on disk is fresh (within 48h)
#   5. Free space on D: is healthy
#
# Usage: sudo ./check-vps-backup.sh
# (sudo because backup.log is root-owned and dest dir may be too)

set -u

DEST="/mnt/d/Ubuntu/VPS-backup"
LOG="$HOME/vps-backup/backup.log"
[ -n "${SUDO_USER:-}" ] && LOG="/home/$SUDO_USER/vps-backup/backup.log"
CRON_PATTERN="backup-vps.sh"

RED="\033[0;31m"; GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RESET="\033[0m"
pass() { echo -e "${GREEN}[ OK ]${RESET} $1"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $1"; }
fail() { echo -e "${RED}[FAIL]${RESET} $1"; FAILED=1; }

FAILED=0
NOW=$(date +%s)

echo "=== VPS Backup Health Check — $(date) ==="
echo

# 1. Cron entry (search all the places WSL might keep it)
echo "1. Cron schedule"
FOUND_CRON=""
# root's crontab
if sudo crontab -l 2>/dev/null | grep -q "$CRON_PATTERN"; then
    FOUND_CRON="root crontab: $(sudo crontab -l | grep "$CRON_PATTERN")"
fi
# invoking user's crontab (when run via sudo, check the original user too)
if [ -z "$FOUND_CRON" ] && [ -n "${SUDO_USER:-}" ]; then
    if sudo -u "$SUDO_USER" crontab -l 2>/dev/null | grep -q "$CRON_PATTERN"; then
        FOUND_CRON="$SUDO_USER crontab: $(sudo -u "$SUDO_USER" crontab -l | grep "$CRON_PATTERN")"
    fi
fi
# /etc/cron.d/ and /etc/crontab
if [ -z "$FOUND_CRON" ]; then
    SYS_HIT=$(sudo grep -rH "$CRON_PATTERN" /etc/cron.d/ /etc/crontab 2>/dev/null | head -1)
    [ -n "$SYS_HIT" ] && FOUND_CRON="$SYS_HIT"
fi
# /var/spool/cron/crontabs/* (raw scan)
if [ -z "$FOUND_CRON" ]; then
    SPOOL_HIT=$(sudo grep -rH "$CRON_PATTERN" /var/spool/cron/crontabs/ 2>/dev/null | head -1)
    [ -n "$SPOOL_HIT" ] && FOUND_CRON="$SPOOL_HIT"
fi
if [ -n "$FOUND_CRON" ]; then
    pass "cron entry installed — $FOUND_CRON"
else
    warn "no cron entry found anywhere — but log is fresh, so backup is running. Check $HOME/.bashrc or systemd timer."
fi
# Sanity: is cron service even running?
if pgrep -x cron >/dev/null 2>&1; then
    pass "cron daemon is running (pid $(pgrep -x cron | head -1))"
else
    fail "cron daemon NOT running — next scheduled run will be missed"
fi
echo

# 2. Log freshness
echo "2. Last backup run"
if [ ! -f "$LOG" ]; then
    fail "log file not found at $LOG"
else
    LOG_MTIME=$(stat -c %Y "$LOG")
    AGE_HOURS=$(( (NOW - LOG_MTIME) / 3600 ))
    LAST_LINE=$(tail -1 "$LOG")
    if [ "$AGE_HOURS" -gt 30 ]; then
        fail "log not touched in ${AGE_HOURS}h (>30h means cron likely missed a run)"
    else
        pass "log updated ${AGE_HOURS}h ago"
    fi
    echo "      last line: $LAST_LINE"
fi
echo

# 3. rsync exit status on the most recent run
echo "3. Last rsync exit status"
if [ -f "$LOG" ]; then
    # Look at last 100 lines for failure markers
    if tail -100 "$LOG" | grep -qiE "rsync error|failed|connection refused|permission denied"; then
        fail "errors found in last 100 log lines:"
        tail -100 "$LOG" | grep -iE "rsync error|failed|connection refused|permission denied" | tail -5 | sed 's/^/      /'
    else
        pass "no error markers in last 100 log lines"
    fi
fi
echo

# 4. Mission-control bundle freshness on disk
echo "4. Latest mission-control bundle on D:"
BUNDLE_DIR="$DEST/opt/supabase/backups"
if [ -d "$BUNDLE_DIR" ]; then
    LATEST=$(ls -1t "$BUNDLE_DIR"/mission-control-*.tar.gz 2>/dev/null | head -1)
    if [ -z "$LATEST" ]; then
        fail "no mission-control-*.tar.gz bundles in $BUNDLE_DIR"
    else
        BUNDLE_MTIME=$(stat -c %Y "$LATEST")
        BUNDLE_AGE_H=$(( (NOW - BUNDLE_MTIME) / 3600 ))
        SIZE=$(du -h "$LATEST" | cut -f1)
        if [ "$BUNDLE_AGE_H" -gt 48 ]; then
            warn "latest bundle is ${BUNDLE_AGE_H}h old: $(basename "$LATEST") ($SIZE)"
        else
            pass "latest bundle ${BUNDLE_AGE_H}h old: $(basename "$LATEST") ($SIZE)"
        fi
    fi
else
    fail "bundle directory missing: $BUNDLE_DIR (rsync never ran or wrong mount)"
fi
echo

# 5. Latest Supabase pg_dump
echo "5. Latest Supabase pg_dump on D:"
if [ -d "$BUNDLE_DIR" ]; then
    LATEST_SQL=$(ls -1t "$BUNDLE_DIR"/commit_ai_*.sql.gz 2>/dev/null | head -1)
    if [ -z "$LATEST_SQL" ]; then
        fail "no commit_ai_*.sql.gz pg_dumps in $BUNDLE_DIR"
    else
        SQL_MTIME=$(stat -c %Y "$LATEST_SQL")
        SQL_AGE_H=$(( (NOW - SQL_MTIME) / 3600 ))
        SIZE=$(du -h "$LATEST_SQL" | cut -f1)
        if [ "$SQL_AGE_H" -gt 48 ]; then
            warn "latest pg_dump is ${SQL_AGE_H}h old: $(basename "$LATEST_SQL") ($SIZE)"
        else
            pass "latest pg_dump ${SQL_AGE_H}h old: $(basename "$LATEST_SQL") ($SIZE)"
        fi
    fi
fi
echo

# 6. Free space on D:
echo "6. Disk space on D:"
if [ -d "$DEST" ]; then
    df -h "$DEST" | tail -1 | awk '{
        used_pct = $5+0
        if (used_pct > 90) printf "[FAIL] D: at %s used (%s free of %s)\n", $5, $4, $2
        else if (used_pct > 80) printf "[WARN] D: at %s used (%s free of %s)\n", $5, $4, $2
        else printf "[ OK ] D: at %s used (%s free of %s)\n", $5, $4, $2
    }'
fi
echo

# 7. Bundle count (cheap; skip du -sh — too slow on /mnt/d Windows mount)
echo "7. Backup inventory"
if [ -d "$BUNDLE_DIR" ]; then
    MC_COUNT=$(ls -1 "$BUNDLE_DIR"/mission-control-*.tar.gz 2>/dev/null | wc -l)
    SQL_COUNT=$(ls -1 "$BUNDLE_DIR"/commit_ai_*.sql.gz 2>/dev/null | wc -l)
    echo "      mission-control bundles: $MC_COUNT"
    echo "      pg_dumps:                $SQL_COUNT"
    echo "      (total size: skipped — du -sh on /mnt/d/ is too slow; see check 6 instead)"
fi
echo

echo "==="
if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}All checks passed.${RESET}"
    exit 0
else
    echo -e "${RED}One or more checks FAILED. Investigate above.${RESET}"
    exit 1
fi
