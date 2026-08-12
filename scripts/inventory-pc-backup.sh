#!/bin/bash
# Inventory the PC-side backup mirror and diff it against the live VPS.
# Run on Windows WSL Ubuntu (user fmoctezuma).
#
# Complements check-vps-backup.sh (which answers "is the pull healthy?").
# This one answers "what is actually on each side, and what would a sync change?"
#
#   1. SSH reachability to the VPS (also proves the backup key still works)
#   2. PC inventory  — dated pg_dumps + mission-control bundles
#   3. VPS inventory — same, fetched live
#   4. Sync preview  — what the next pull DELETES, what it DOWNLOADS
#   5. Preserve-dir check — is the about-to-be-deleted history saved elsewhere?
#   6. Disk headroom on D: vs the download size
#
# The pull is an rsync MIRROR with no --backup-dir: anything present on the PC
# but absent on the VPS is DELETED on the next run. Check 4 is the whole point
# of this script — run it BEFORE syncing after any multi-day gap.
#
# Usage: sudo ./inventory-pc-backup.sh
# (sudo because the mirrored files are root-owned)

set -u
export LC_ALL=C   # comm requires both inputs in the SAME collation as the sort

DEST="${DEST:-/mnt/d/Ubuntu/VPS-backup}"
BUNDLE_DIR="$DEST/opt/supabase/backups"
VPS_HOST="${VPS_HOST:-root@187.77.25.101}"
VPS_DIR="/opt/supabase/backups"
PRESERVE_GLOB="${PRESERVE_GLOB:-/mnt/d/Ubuntu/VPS-backup-preserved-*}"

SSH_KEY="$HOME/.ssh/vps-backup"
[ -n "${SUDO_USER:-}" ] && SSH_KEY="/home/$SUDO_USER/.ssh/vps-backup"

RED="\033[0;31m"; GREEN="\033[0;32m"; YELLOW="\033[0;33m"; RESET="\033[0m"
pass() { echo -e "${GREEN}[ OK ]${RESET} $1"; }
warn() { echo -e "${YELLOW}[WARN]${RESET} $1"; }
fail() { echo -e "${RED}[FAIL]${RESET} $1"; FAILED=1; }

FAILED=0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Single-file stat only — never `du -sh` a /mnt/d tree, it hangs for minutes.
human() { numfmt --to=iec --suffix=B "${1:-0}" 2>/dev/null || echo "${1:-0}B"; }

echo "=== PC Backup Inventory — $(date) ==="
echo

# ---------------------------------------------------------------- 1. SSH
echo "1. VPS reachability"
if [ ! -f "$SSH_KEY" ]; then
    fail "backup key missing at $SSH_KEY — the pull cannot authenticate"
else
    if ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 \
           -o StrictHostKeyChecking=accept-new "$VPS_HOST" true 2>"$TMP/ssherr"; then
        pass "SSH to $VPS_HOST works (key: $SSH_KEY)"
    else
        fail "SSH to $VPS_HOST FAILED — this alone would stop every nightly pull:"
        sed 's/^/      /' "$TMP/ssherr"
    fi
fi
echo

# ---------------------------------------------------------------- 2. PC side
echo "2. On the PC ($BUNDLE_DIR)"
if [ ! -d "$BUNDLE_DIR" ]; then
    fail "mirror directory missing — rsync never ran, or D: is not mounted"
    : > "$TMP/pc"
else
    for f in "$BUNDLE_DIR"/commit_ai_*.sql.gz "$BUNDLE_DIR"/mission-control-*.tar.gz; do
        [ -e "$f" ] || continue
        printf '%s\t%s\n' "$(basename "$f")" "$(stat -c %s "$f")"
    done | sort > "$TMP/pc"
    if [ ! -s "$TMP/pc" ]; then
        fail "no pg_dumps or bundles found on the PC"
    else
        while IFS=$'\t' read -r name bytes; do
            printf '      %-40s %10s  %s\n' "$name" "$(human "$bytes")" \
                "$(stat -c %y "$BUNDLE_DIR/$name" | cut -d' ' -f1)"
        done < "$TMP/pc"
        pass "$(wc -l < "$TMP/pc") artifact(s) on the PC"
    fi
fi
echo

# ---------------------------------------------------------------- 3. VPS side
echo "3. On the VPS ($VPS_DIR)"
: > "$TMP/vps"
if ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=10 "$VPS_HOST" \
      "cd $VPS_DIR 2>/dev/null && stat -c '%n	%s' commit_ai_*.sql.gz mission-control-*.tar.gz 2>/dev/null" \
      2>/dev/null | sort > "$TMP/vps"; then
    if [ -s "$TMP/vps" ]; then
        while IFS=$'\t' read -r name bytes; do
            printf '      %-40s %10s\n' "$name" "$(human "$bytes")"
        done < "$TMP/vps"
        pass "$(wc -l < "$TMP/vps") artifact(s) on the VPS"
    else
        fail "VPS backup directory is empty or unreadable"
    fi
else
    fail "could not list the VPS backup directory over SSH"
fi
echo

# ---------------------------------------------------------------- 4. Sync preview
echo "4. What the NEXT pull would change"
# Refuse to render a verdict on a half-known picture. If the VPS listing failed,
# every PC file looks "absent upstream" and this check would scream DELETE at
# files that are perfectly safe — the exact false alarm it exists to prevent.
if [ ! -s "$TMP/vps" ]; then
    fail "VPS inventory unavailable — cannot compute the sync preview."
    echo "      Fix check 1/3 first. Do NOT sync until this check can run."
    echo
    echo "==="
    echo -e "${RED}Inventory INCOMPLETE — resolve the VPS listing before syncing.${RESET}"
    exit 1
fi
cut -f1 "$TMP/pc"  > "$TMP/pc_names"
cut -f1 "$TMP/vps" > "$TMP/vps_names"
comm -23 "$TMP/pc_names" "$TMP/vps_names" > "$TMP/only_pc"
comm -13 "$TMP/pc_names" "$TMP/vps_names" > "$TMP/only_vps"
comm -12 "$TMP/pc_names" "$TMP/vps_names" > "$TMP/both"

DEL_BYTES=0
if [ -s "$TMP/only_pc" ]; then
    # WARN, not FAIL: deletion is a preview, not yet a fault. Check 5 decides —
    # deletions that are preserved elsewhere are fine, unpreserved ones are not.
    warn "$(wc -l < "$TMP/only_pc") file(s) exist ONLY on the PC — the mirror will DELETE these:"
    while read -r name; do
        b=$(awk -F'\t' -v n="$name" '$1==n{print $2}' "$TMP/pc")
        DEL_BYTES=$(( DEL_BYTES + ${b:-0} ))
        echo "      DELETE  $name  ($(human "${b:-0}"))"
    done < "$TMP/only_pc"
    echo "      -> $(human "$DEL_BYTES") of history that exists NOWHERE ELSE."
    echo "      -> Copy these OUTSIDE $DEST before syncing, or they are gone."
else
    pass "nothing on the PC is absent from the VPS — no deletions pending"
fi

DL_BYTES=0
if [ -s "$TMP/only_vps" ]; then
    while read -r name; do
        b=$(awk -F'\t' -v n="$name" '$1==n{print $2}' "$TMP/vps")
        DL_BYTES=$(( DL_BYTES + ${b:-0} ))
        echo "      GET     $name  ($(human "${b:-0}"))"
    done < "$TMP/only_vps"
    warn "$(wc -l < "$TMP/only_vps") file(s) to download — $(human "$DL_BYTES")"
else
    pass "PC already has every VPS artifact"
fi
echo "      unchanged on both sides: $(wc -l < "$TMP/both")"
echo

# ---------------------------------------------------------------- 5. Preserve
echo "5. Preserved history (outside the mirror)"
PRESERVE_DIRS=()
# shellcheck disable=SC2086  # PRESERVE_GLOB is a glob pattern — expansion is the point
for d in $PRESERVE_GLOB; do
    [ -d "$d" ] && PRESERVE_DIRS+=("$d")
done

if [ ! -s "$TMP/only_pc" ]; then
    pass "nothing pending deletion — no preserve directory needed"
elif [ "${#PRESERVE_DIRS[@]}" -eq 0 ]; then
    fail "no preserve directory found, and $(wc -l < "$TMP/only_pc") file(s) are about to be deleted"
else
    for d in "${PRESERVE_DIRS[@]}"; do
        echo "      $d — $(find "$d" -maxdepth 1 -type f | wc -l) file(s)"
    done
    MISSING=0
    while read -r name; do
        found=0
        for d in "${PRESERVE_DIRS[@]}"; do
            [ -f "$d/$name" ] && { found=1; break; }
        done
        if [ "$found" -eq 0 ]; then
            echo "      NOT PRESERVED: $name"
            MISSING=$((MISSING+1))
        fi
    done < "$TMP/only_pc"
    if [ "$MISSING" -gt 0 ]; then
        fail "$MISSING about-to-be-deleted file(s) are NOT in any preserve directory"
    else
        pass "all $(wc -l < "$TMP/only_pc") about-to-be-deleted file(s) are preserved elsewhere"
    fi
fi
echo

# ---------------------------------------------------------------- 6. Space
echo "6. Disk headroom on D:"
if [ -d "$DEST" ]; then
    AVAIL=$(df -B1 --output=avail "$DEST" | tail -1)
    df -h "$DEST" | tail -1 | awk '{printf "      %s used of %s (%s free)\n", $3, $2, $4}'
    NEED=$(( DL_BYTES ))
    if [ "$AVAIL" -lt "$NEED" ]; then
        fail "need $(human "$NEED") to download but only $(human "$AVAIL") free"
    else
        pass "$(human "$AVAIL") free covers the $(human "$NEED") download"
    fi
else
    fail "$DEST not mounted"
fi
echo

echo "==="
if [ "$FAILED" -eq 0 ]; then
    echo -e "${GREEN}Inventory clean — safe to sync.${RESET}"; exit 0
else
    echo -e "${RED}Review the FAIL lines above BEFORE running backup-vps.sh.${RESET}"; exit 1
fi
