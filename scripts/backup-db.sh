#!/bin/bash
# Copies the database to mc-<date>.db; removes mc-*.db copies 8 or more days old.
# Started by the deploy when it snapshots the database (scripts/lib/deploy-checks.sh), or by hand.

# New files and folders are readable by their owner only.
umask 077

BACKUP_DIR="/root/claude/mission-control/backups"
DB_PATH="/root/claude/mission-control/data/mc.db"
DATE=$(date +%Y-%m-%d)

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/mc-$DATE.db'"

# Remove mc-*.db copies 8 or more days old
find "$BACKUP_DIR" -name "mc-*.db" -mtime +7 -delete

echo "[$(date)] backup: mc.db → $BACKUP_DIR/mc-$DATE.db ($(du -sh "$BACKUP_DIR/mc-$DATE.db" 2>/dev/null | cut -f1))"
