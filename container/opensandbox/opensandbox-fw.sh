#!/usr/bin/env bash
# Firewall guard for OpenSandbox sandboxes (2026-08-16; lateral rules + per-binary
# guard folded from qa R1 C2/W2, R2 W-3/rec-1/rec-2 the same day).
#
# The Docker runtime publishes each sandbox's UNAUTHENTICATED execd port on
# 0.0.0.0:<40000-40999> (port_allocator.py DOCKER_PUBLISH_HOST + the sidecar
# path hardcode "0.0.0.0"), and Docker's iptables rules bypass UFW. Only the
# HOST (mission-control) may talk to execd. Idempotent DROPs, v4 + v6:
#
#   FORWARD / DOCKER-USER (evaluated first in FORWARD; host→sandbox is OUTPUT,
#   so mission-control is unaffected):
#   R1  public edge    -i eth0                 NEW --ctorigdstport 40000:40999
#   R2  other bridges  -i br-+ -o docker0      NEW --ctorigdstport 40000:40999   (published-port DNAT path
#                                                                                 from any docker network;
#                                                                                 -o docker0 keeps container
#                                                                                 egress to 40000-40999 intact)
#   R3  same bridge    -i docker0 -o docker0   NEW --dports 44772,18080          (sandbox→sandbox execd /
#                                                                                 egress API; needs br_netfilter,
#                                                                                 loaded below, so bridged frames
#                                                                                 traverse FORWARD)
#   INPUT (docker-proxy hairpin — a container hitting <hostIP|172.17.0.1>:40xxx
#   is NOT DNATed for its own bridge and lands in INPUT; UFW's default-deny
#   covers it today, this rule makes the control self-contained):
#   R4  docker0→host   -i docker0              NEW --dport 40000:40999
#
# --ctorigdstport matches the ORIGINAL dst port because DNAT precedes FORWARD.
# Idempotent: `-C` guards duplicates; a missing DOCKER-USER chain in one
# family (e.g. ip6tables disabled in daemon.json) skips that family instead
# of failing the unit. Verify: iptables -S DOCKER-USER   ·   readout: mc-ctl sandboxes
set -uo pipefail
IFACE="${OPENSANDBOX_FW_IFACE:-eth0}"
RANGE="${OPENSANDBOX_FW_RANGE:-40000:40999}"
BRIDGE="${OPENSANDBOX_FW_BRIDGE:-docker0}"
COMMENT="opensandbox: block public access to sandbox execd ports"

# Same-bridge frames only hit iptables FORWARD with br_netfilter (bridge-nf-call).
if ! modprobe br_netfilter 2>/dev/null; then
  echo "opensandbox-fw: WARN br_netfilter not loadable — same-bridge rule (R3) is inert" >&2
fi
sysctl -q -w net.bridge.bridge-nf-call-iptables=1 2>/dev/null || true
sysctl -q -w net.bridge.bridge-nf-call-ip6tables=1 2>/dev/null || true

# ensure <bin> <chain> <rule args...> — insert unless already present.
ensure() {
  local bin="$1" chain="$2"; shift 2
  if ! "$bin" -C "$chain" "$@" 2>/dev/null; then
    "$bin" -I "$chain" "$@" || { echo "opensandbox-fw: ERROR $bin -I $chain $*" >&2; return 1; }
  fi
}

# retire <bin> <chain> <rule args...> — delete every copy of a superseded rule.
retire() {
  local bin="$1" chain="$2"; shift 2
  while "$bin" -C "$chain" "$@" 2>/dev/null; do "$bin" -D "$chain" "$@" || break; done
}

rc=0
for bin in iptables ip6tables; do
  if ! "$bin" -S DOCKER-USER >/dev/null 2>&1; then
    echo "opensandbox-fw: $bin has no DOCKER-USER chain — skipping family" >&2
    continue
  fi
  # Superseded 2026-08-16 (R2 W-3): the first cross-bridge rule lacked -o docker0
  # and also dropped container EGRESS to 40000-40999.
  retire "$bin" DOCKER-USER -i br-+ -p tcp -m conntrack --ctstate NEW --ctorigdstport "$RANGE" \
    -m comment --comment "$COMMENT (cross-bridge)" -j DROP
  ensure "$bin" DOCKER-USER -i "$IFACE" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$RANGE" \
    -m comment --comment "$COMMENT" -j DROP || rc=1
  ensure "$bin" DOCKER-USER -i br-+ -o "$BRIDGE" -p tcp -m conntrack --ctstate NEW --ctorigdstport "$RANGE" \
    -m comment --comment "$COMMENT (cross-bridge)" -j DROP || rc=1
  ensure "$bin" DOCKER-USER -i "$BRIDGE" -o "$BRIDGE" -p tcp -m conntrack --ctstate NEW -m multiport --dports 44772,18080 \
    -m comment --comment "$COMMENT (same-bridge)" -j DROP || rc=1
  ensure "$bin" INPUT -i "$BRIDGE" -p tcp -m conntrack --ctstate NEW --dport "$RANGE" \
    -m comment --comment "$COMMENT (docker-proxy hairpin)" -j DROP || rc=1
done
[ "$rc" -eq 0 ] && echo "opensandbox-fw: guard active ($IFACE edge · br-+→$BRIDGE cross-bridge · $BRIDGE same-bridge · INPUT hairpin; tcp $RANGE / 44772,18080)"
exit "$rc"
