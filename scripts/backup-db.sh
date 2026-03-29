#!/bin/bash
# Daily SQLite backup — 7-day rotation
# Cron: 0 4 * * * /root/claude/mission-control/scripts/backup-db.sh >> /var/log/mc-backup.log 2>&1

BACKUP_DIR="/root/claude/mission-control/backups"
DB_PATH="/root/claude/mission-control/data/mc.db"
DATE=$(date +%Y-%m-%d)

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/mc-$DATE.db'"

# Remove backups older than 7 days
find "$BACKUP_DIR" -name "mc-*.db" -mtime +7 -delete

echo "[$(date)] backup: mc.db → $BACKUP_DIR/mc-$DATE.db ($(du -sh "$BACKUP_DIR/mc-$DATE.db" 2>/dev/null | cut -f1))"
