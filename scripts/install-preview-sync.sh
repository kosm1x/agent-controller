#!/usr/bin/env bash
# install-preview-sync — one-shot installer for the self-serve preview
# publisher (2026-08-23). Run as root:
#
#   sudo bash /root/claude/mission-control/scripts/install-preview-sync.sh
#
# What it does (idempotent):
#   1. Installs scripts/preview-caddy-sync.sh to /usr/local/bin (0755).
#   2. Creates preview-caddy-sync.service (oneshot) + .path (watches
#      /root/claude/previews) and enables the path unit.
#   3. Appends `import /etc/caddy/previews-generated.caddy` to the Caddyfile
#      (with a timestamped backup) if not already present.
#   4. Runs the first sync (generates vhosts, validates, reloads caddy).
#   5. Prints verification for every current preview.
set -euo pipefail

SRC=/root/claude/mission-control/scripts/preview-caddy-sync.sh
BIN=/usr/local/bin/preview-caddy-sync.sh
CADDYFILE=/etc/caddy/Caddyfile
GEN=/etc/caddy/previews-generated.caddy
STAMP=$(date +%Y%m%d-%H%M%S)

[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }

# 1. Script into place
install -m 755 "$SRC" "$BIN"
echo "installed $BIN ($(wc -c < "$BIN") bytes)"

# 2. systemd units
cat > /etc/systemd/system/preview-caddy-sync.service << 'UNIT'
[Unit]
Description=Regenerate Caddy preview vhosts from /root/claude/previews

[Service]
Type=oneshot
ExecStart=/usr/local/bin/preview-caddy-sync.sh
UNIT

cat > /etc/systemd/system/preview-caddy-sync.path << 'UNIT'
[Unit]
Description=Watch /root/claude/previews for added/removed preview dirs

[Path]
PathModified=/root/claude/previews
Unit=preview-caddy-sync.service

[Install]
WantedBy=multi-user.target
UNIT

# Guard against the 0-byte-unit failure mode (session-resilience rule)
for u in preview-caddy-sync.service preview-caddy-sync.path; do
  s=$(wc -c < "/etc/systemd/system/$u")
  [ "$s" -gt 50 ] || { echo "unit $u is $s bytes — write failed"; exit 1; }
done

mkdir -p /root/claude/previews
systemctl daemon-reload
systemctl enable --now preview-caddy-sync.path
echo "path unit enabled: $(systemctl is-active preview-caddy-sync.path)"

# 3. Caddyfile import line (once)
if ! grep -qF "import $GEN" "$CADDYFILE"; then
  cp "$CADDYFILE" "$CADDYFILE.bak-preview-sync-$STAMP"
  # Generated file must exist before the import is added
  [ -f "$GEN" ] || printf '# empty (first sync pending)\n' > "$GEN"
  printf '\n# Auto-generated preview vhosts — managed by preview-caddy-sync\nimport %s\n' "$GEN" >> "$CADDYFILE"
  echo "import line appended (backup: $CADDYFILE.bak-preview-sync-$STAMP)"
else
  echo "import line already present"
fi

# 4. First sync (validates + reloads caddy)
"$BIN"

# 5. Verify every published preview end-to-end
echo "--- verification ---"
found=0
for dir in /root/claude/previews/*/; do
  [ -d "$dir" ] || continue
  name=$(basename "$dir")
  found=1
  url="https://$name.187.77.25.101.nip.io"
  ok=""
  for i in 1 2 3 4 5 6; do
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" || true)
    if [ "$code" = 200 ]; then ok=yes; break; fi
    sleep 5
  done
  if [ "$ok" = yes ]; then
    echo "LIVE  $url"
  else
    echo "FAIL  $url (last http_code=$code) — check: journalctl -u caddy --since '2 min ago' | grep -i acme"
  fi
done
[ "$found" = 1 ] || echo "(no preview dirs yet)"

# 6. Register the recipe in Jarvis's KB (searchable directive + disk mirror)
node /root/claude/mission-control/scripts/kb-preview-directive.mjs || echo "KB directive insert failed (non-fatal) — re-run: node /root/claude/mission-control/scripts/kb-preview-directive.mjs"
echo "done."
