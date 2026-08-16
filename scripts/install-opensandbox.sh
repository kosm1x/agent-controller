#!/usr/bin/env bash
# Install / upgrade the OpenSandbox lifecycle server as Jarvis's sandbox
# runtime backend (2026-08-16). Idempotent — safe to re-run.
#
#   sudo /root/claude/mission-control/scripts/install-opensandbox.sh
#
# Steps: uv tool install (pinned) → keep-labelled execd/egress images → server
# TOML (only if absent) → API key env file (only if absent, mode 600) →
# firewall guard script + systemd units → enable --now → health probe.
# Docs: docs/planning/opensandbox-adoption.md
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO/container/opensandbox"
SERVER_VERSION="${OPENSANDBOX_SERVER_VERSION:-0.2.2}"

log() { printf '[install-opensandbox] %s\n' "$*"; }

# 1. Server package (isolated venv under /root/.local/share/uv/tools).
if ! /root/.local/bin/opensandbox-server --help >/dev/null 2>&1 \
   || ! /root/.local/bin/uv tool list 2>/dev/null | grep -q "opensandbox-server v${SERVER_VERSION}"; then
  log "installing opensandbox-server==${SERVER_VERSION}"
  /root/.local/bin/uv tool install --force "opensandbox-server==${SERVER_VERSION}" >/dev/null
fi

# 2. Runtime images (LABEL keep=true — survive the nightly image prune).
"$REPO/scripts/build-opensandbox-images.sh"

# 3. Server config (never overwrite an operator-edited file).
install -d -m 700 /root/.opensandbox
if [ ! -f /root/.opensandbox/sandbox.toml ]; then
  install -m 600 "$SRC/sandbox.toml" /root/.opensandbox/sandbox.toml
  log "wrote /root/.opensandbox/sandbox.toml"
fi

# 4. Shared API key: server reads OPENSANDBOX_SERVER_API_KEY, mission-control
#    reads OPENSANDBOX_API_KEY/OPENSANDBOX_URL. Generated once, never printed.
install -d -m 700 /etc/opensandbox
if [ ! -f /etc/opensandbox/api.env ]; then
  k="$(openssl rand -hex 32)"
  umask 077
  printf 'OPENSANDBOX_SERVER_API_KEY=%s\nOPENSANDBOX_API_KEY=%s\nOPENSANDBOX_URL=127.0.0.1:8098\n' "$k" "$k" > /etc/opensandbox/api.env
  unset k
  log "generated /etc/opensandbox/api.env"
fi
chmod 600 /etc/opensandbox/api.env

# 5. Firewall guard + units.
install -m 755 "$SRC/opensandbox-fw.sh" /usr/local/sbin/opensandbox-fw.sh
install -m 644 "$SRC/systemd/opensandbox-fw.service" /etc/systemd/system/opensandbox-fw.service
install -m 644 "$SRC/systemd/opensandbox-server.service" /etc/systemd/system/opensandbox-server.service
systemctl daemon-reload
systemctl enable opensandbox-fw.service opensandbox-server.service >/dev/null 2>&1
# oneshot + RemainAfterExit stays "active" — restart re-executes the updated guard script
systemctl restart opensandbox-fw.service
systemctl restart opensandbox-server.service

# 6. Verify.
n="$( { iptables -S DOCKER-USER; iptables -S INPUT; } | grep -c 'opensandbox: block public access' || true)"
[ "$n" -ge 4 ] || { log "ERROR: firewall guard incomplete ($n/4 rules) — journalctl -u opensandbox-fw"; exit 1; }
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:8098/health >/dev/null 2>&1; then
    log "server healthy on 127.0.0.1:8098 (systemd: $(systemctl is-active opensandbox-server))"
    exit 0
  fi
  sleep 1
done
log "ERROR: server not healthy after 20s — journalctl -u opensandbox-server -n 50"
exit 1
