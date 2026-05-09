#!/bin/bash
# Mission-control state bundle — creates a hot-safe daily snapshot of all
# irreplaceable mission-control state and parks it in /opt/supabase/backups/
# so the PC's nightly rsync (which already pulls that path) carries it offsite.
#
# Cron: 30 2 * * * /root/claude/mission-control/scripts/backup-state-bundle.sh \
#         >> /var/log/mc-state-bundle.log 2>&1
#
# Pull window: ~09:09 UTC daily, so 02:30 UTC gives a 6.5h buffer.

set -euo pipefail

MC_DIR="/root/claude/mission-control"
DEST_DIR="/opt/supabase/backups"
DATE="$(date -u +%Y%m%d)"
STAGE_DIR="$(mktemp -d -t mc-bundle-XXXXXX)"
ARCHIVE="${DEST_DIR}/mission-control-${DATE}.tar.gz"
RETAIN_DAYS=7

trap 'rm -rf "$STAGE_DIR"' EXIT

echo "=== $(date -u +%FT%TZ) starting mc state bundle ==="

# Hot-safe SQLite snapshot — uses .backup API, captures WAL atomically.
sqlite3 "${MC_DIR}/data/mc.db" ".backup '${STAGE_DIR}/mc.db'"
echo "  + mc.db snapshot $(du -sh "${STAGE_DIR}/mc.db" | cut -f1)"

# Stateful subdirs — anything in data/ that isn't the live DB or rotating backups.
for sub in whatsapp-session jarvis graphify reflections; do
    src="${MC_DIR}/data/${sub}"
    if [ -d "$src" ]; then
        cp -a "$src" "${STAGE_DIR}/"
        echo "  + ${sub} $(du -sh "${STAGE_DIR}/${sub}" | cut -f1)"
    fi
done

# Critical config — bundled defense-in-depth (the .env is also pulled directly,
# but co-locating ensures the snapshot is self-contained for restore).
for f in mcp-servers.json .env; do
    if [ -f "${MC_DIR}/${f}" ]; then
        cp -a "${MC_DIR}/${f}" "${STAGE_DIR}/"
    fi
done

# Manifest for restore reference.
cat > "${STAGE_DIR}/MANIFEST.txt" <<EOF
mission-control state bundle
created:  $(date -u +%FT%TZ)
host:     $(hostname)
mc-commit: $(git -C "${MC_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)
contents:
$(cd "${STAGE_DIR}" && du -sh -- *)
EOF

# Compress.
tar -czf "$ARCHIVE" -C "$STAGE_DIR" .
echo "  = ${ARCHIVE} $(du -sh "$ARCHIVE" | cut -f1)"

# Retention — keep last $RETAIN_DAYS days. Matches Supabase backup policy.
find "$DEST_DIR" -maxdepth 1 -name "mission-control-*.tar.gz" -mtime "+${RETAIN_DAYS}" -delete

echo "=== $(date -u +%FT%TZ) bundle done ==="
