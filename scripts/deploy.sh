#!/bin/bash
# Build from source and restart the service.
# Usage: ./scripts/deploy.sh
set -e
cd /root/claude/mission-control
echo "[deploy] Building..."
npm run build
echo "[deploy] Reloading systemd + restarting..."
systemctl daemon-reload
systemctl restart mission-control
sleep 3
if systemctl is-active --quiet mission-control; then
  echo "[deploy] OK — $(journalctl -u mission-control --since '5 sec ago' --no-pager 2>/dev/null | grep -o 'totalTools":[0-9]*' | head -1)"
else
  echo "[deploy] FAILED"
  journalctl -u mission-control --since '10 sec ago' --no-pager | tail -5
  exit 1
fi
