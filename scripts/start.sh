#!/bin/bash
# Kill any existing mission-control process, then restart via systemd.
pkill -f "tsx src/index.ts" 2>/dev/null
sleep 2
systemctl restart mission-control
journalctl -u mission-control -f
