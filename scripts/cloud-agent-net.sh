#!/usr/bin/env bash
# Sandbox Runner egress lockdown — run ON THE DOCKER HOST (Linux, root).
#
# The cloud-agent bridge deliberately allows public internet (P1 spec D4:
# npm install / docs browsing), but must NOT reach:
#   • the cloud metadata endpoint (169.254.169.254 — instance credentials!)
#   • link-local + RFC1918 (the host's other containers/services: on the dev
#     box that's mongo --bind_ip_all, redis, emqx, TDengine, postgres…)
# …EXCEPT the api itself via the host gateway (host.docker.internal).
#
# TWO chains are needed, and missing either one leaves a wide-open hole:
#   • DOCKER-USER — docker's sanctioned hook, but it only sees FORWARDed
#     traffic, i.e. container → somewhere else.
#   • INPUT — traffic to the HOST'S OWN addresses is delivered locally, never
#     forwarded, so DOCKER-USER never sees it. Without INPUT rules a sandbox
#     still reaches every host-published port by dialing the host's LAN IP
#     (verified 2026-07-31 on dev: mongo :27017 answered through a fully
#     "locked down" DOCKER-USER). That covers docker-proxy publishes as well
#     as anything bound to 0.0.0.0 on the host itself.
#
# Idempotent: safe to re-run; use `--remove` to undo. Persist across reboots
# via your init (e.g. a systemd oneshot or /etc/rc.local) — iptables rules are
# not durable by themselves.
#
# Usage:
#   sudo bash scripts/cloud-agent-net.sh            # apply
#   sudo bash scripts/cloud-agent-net.sh --remove   # undo
#   SANDBOX_RUNNER_NETWORK=cloud-agent API_PORT=3108 sudo -E bash scripts/cloud-agent-net.sh
#   API_PORT=3109,3110 sudo -E bash scripts/cloud-agent-net.sh   # blue/green: both slots
set -euo pipefail

NETWORK="${SANDBOX_RUNNER_NETWORK:-${CLOUD_AGENT_NETWORK:-cloud-agent}}"
# One port, or a comma-separated list when two API slots take turns behind a
# reverse proxy (blue/green): every listed port is reachable, nothing else.
# `--check` demands every listed port and accepts extra allow rows for other
# ports on the same gateways — the API checks with its own port only, while
# the host applied the rules for both slots.
API_PORT="${API_PORT:-3108}"
COMMENT="greenhouse-mission-sandbox"
FWD_CHAIN="GREENHOUSE-MISSION-FWD"
INPUT_CHAIN="GREENHOUSE-MISSION-IN"

case "${1:-}" in
  '' | --check | --remove) ;;
  *) echo "usage: $0 [--check|--remove]" >&2; exit 2 ;;
esac
IFS=',' read -r -a API_PORTS <<< "$API_PORT"
[ "${#API_PORTS[@]}" -ge 1 ] || { echo "API_PORT must list at least one port" >&2; exit 2; }
for port in "${API_PORTS[@]}"; do
  [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] \
    || { echo "API_PORT entries must be integers between 1 and 65535 (got '$port')" >&2; exit 2; }
done

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  echo "docker network '$NETWORK' does not exist — create it first with ICC disabled" >&2
  exit 1
fi

ENABLE_IPV6=$(docker network inspect "$NETWORK" --format '{{.EnableIPv6}}')
ENABLE_ICC=$(docker network inspect "$NETWORK" --format '{{index .Options "com.docker.network.bridge.enable_icc"}}')
[ "$ENABLE_IPV6" = "false" ] || { echo "network '$NETWORK' must have IPv6 disabled" >&2; exit 1; }
[ "$ENABLE_ICC" = "false" ] || {
  echo "network '$NETWORK' must be recreated with --opt com.docker.network.bridge.enable_icc=false" >&2
  exit 1
}

SUBNET=$(docker network inspect "$NETWORK" --format '{{(index .IPAM.Config 0).Subnet}}')
GATEWAY=$(docker network inspect "$NETWORK" --format '{{(index .IPAM.Config 0).Gateway}}')
# ⚠️ `--add-host host.docker.internal:host-gateway` (docker.ts) resolves to the
# daemon's host-gateway-ip, which defaults to the DEFAULT bridge's gateway
# (172.17.0.1) — NOT this bridge's. That address is inside the 172.16/12 deny,
# so without an explicit allow the sandbox loses the api entirely (relay, event
# push, artifact upload) and every run dies. Allow both gateways.
HOST_GATEWAY="${HOST_GATEWAY_IP:-$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)}"
echo "network=$NETWORK subnet=$SUBNET gateway=$GATEWAY host_gateway=${HOST_GATEWAY:-<none>} api_ports=${API_PORTS[*]}"

# Dedicated chains make the effective order auditable. Merely checking that a
# deny rule exists is unsafe: an earlier broad ACCEPT/RETURN can shadow it.
remove_rules() {
  for chain in DOCKER-USER INPUT; do
    while true; do
      rule=$(iptables -S "$chain" | grep -- "--comment $COMMENT" | head -1 || true)
      [ -z "$rule" ] && break
      # shellcheck disable=SC2086
      iptables ${rule/-A/-D}
    done
  done
  for chain in "$FWD_CHAIN" "$INPUT_CHAIN"; do
    iptables -F "$chain" >/dev/null 2>&1 || true
    iptables -X "$chain" >/dev/null 2>&1 || true
  done
}

tag() { echo -m comment --comment "$COMMENT"; }

check_first_jump() {
  local chain="$1" target="$2"
  local first
  # Do not exit awk early: with pipefail, a verbose iptables producer can
  # receive SIGPIPE and turn an otherwise valid verification into exit 141.
  first=$(iptables -L "$chain" -n --line-numbers | awk '$1 == "1" { print $2 }')
  [ "$first" = "$target" ] || {
    echo "$chain must enter $target as its first effective rule (found ${first:-none})" >&2
    return 1
  }
}

# Some iptables builds (e.g. 1.8.9 legacy on TencentOS 4) print the protocol
# column numerically under -n: tcp → 6, all → 0. Accept both spellings.
proto_matches() {
  local wanted="$1" actual="$2"
  [ "$actual" = "$wanted" ] && return 0
  case "$wanted" in
    tcp) [ "$actual" = "6" ] ;;
    all) [ "$actual" = "0" ] ;;
    *) return 1 ;;
  esac
}

check_row() {
  local chain="$1" line="$2" target="$3" protocol="$4" destination="$5" detail="${6:-}"
  local row actual_target actual_protocol actual_destination
  row=$(iptables -L "$chain" -n --line-numbers | awk -v wanted="$line" '$1 == wanted { print }')
  actual_target=$(echo "$row" | awk '{print $2}')
  actual_protocol=$(echo "$row" | awk '{print $3}')
  actual_destination=$(echo "$row" | awk '{print $6}')
  [ "$actual_target" = "$target" ] && proto_matches "$protocol" "$actual_protocol" \
    && [ "$actual_destination" = "$destination" ] || {
      echo "$chain rule $line has unsafe order/content: ${row:-missing}" >&2
      return 1
    }
  if [ -n "$detail" ]; then
    echo "$row" | grep -F -- "$detail" >/dev/null || {
      echo "$chain rule $line is missing $detail: $row" >&2
      return 1
    }
  fi
}

# The rows before the deny block must ALL be tcp allows to one of the two
# gateways on some port — nothing broader may precede a deny. Prints how many
# there are; the required ports are checked separately with `iptables -C`.
count_leading_allows() {
  local chain="$1" target="$2" n=0 row actual_target actual_protocol actual_destination
  while :; do
    row=$(iptables -L "$chain" -n --line-numbers | awk -v wanted="$((n + 1))" '$1 == wanted { print }')
    [ -n "$row" ] || break
    actual_target=$(echo "$row" | awk '{print $2}')
    actual_protocol=$(echo "$row" | awk '{print $3}')
    actual_destination=$(echo "$row" | awk '{print $6}')
    [ "$actual_target" = "$target" ] || break
    proto_matches tcp "$actual_protocol" || break
    if [ "$actual_destination" != "$GATEWAY" ]; then
      [ -n "$HOST_GATEWAY" ] && [ "$actual_destination" = "$HOST_GATEWAY" ] || break
    fi
    echo "$row" | grep -Eq 'dpt:[0-9]+$' || break
    n=$((n + 1))
  done
  echo "$n"
}

check_rules() {
  check_first_jump DOCKER-USER "$FWD_CHAIN"
  check_first_jump INPUT "$INPUT_CHAIN"
  # shellcheck disable=SC2046
  iptables -C DOCKER-USER -s "$SUBNET" -j "$FWD_CHAIN" $(tag)
  # shellcheck disable=SC2046
  iptables -C INPUT -s "$SUBNET" -j "$INPUT_CHAIN" $(tag)
  [ "$(iptables -S DOCKER-USER | grep -c -- "-j $FWD_CHAIN")" -eq 1 ]
  [ "$(iptables -S INPUT | grep -c -- "-j $INPUT_CHAIN")" -eq 1 ]
  for port in "${API_PORTS[@]}"; do
    iptables -C "$FWD_CHAIN" -d "$GATEWAY" -p tcp --dport "$port" -j RETURN
    iptables -C "$INPUT_CHAIN" -d "$GATEWAY" -p tcp --dport "$port" -j ACCEPT
    if [ -n "$HOST_GATEWAY" ] && [ "$HOST_GATEWAY" != "$GATEWAY" ]; then
      iptables -C "$FWD_CHAIN" -d "$HOST_GATEWAY" -p tcp --dport "$port" -j RETURN
      iptables -C "$INPUT_CHAIN" -d "$HOST_GATEWAY" -p tcp --dport "$port" -j ACCEPT
    fi
  done
  iptables -C "$FWD_CHAIN" -d "$SUBNET" -j REJECT
  iptables -C "$FWD_CHAIN" -d 10.0.0.0/8 -j REJECT
  iptables -C "$FWD_CHAIN" -d 172.16.0.0/12 -j REJECT
  iptables -C "$FWD_CHAIN" -d 192.168.0.0/16 -j REJECT
  iptables -C "$FWD_CHAIN" -d 169.254.0.0/16 -j REJECT
  iptables -C "$FWD_CHAIN" -d 100.64.0.0/10 -j REJECT
  iptables -C "$FWD_CHAIN" -j RETURN
  iptables -C "$INPUT_CHAIN" -j REJECT

  # Exact sequence: precise API allows first (this port's and, on a blue/green
  # host, the other slot's), every private/east-west deny next, and only then
  # the public-internet RETURN. Existence + rule count is insufficient because
  # moving the final RETURN to line 1 bypasses all denies.
  local fwd_allows input_allows
  fwd_allows=$(count_leading_allows "$FWD_CHAIN" RETURN)
  input_allows=$(count_leading_allows "$INPUT_CHAIN" ACCEPT)
  [ "$fwd_allows" -ge 1 ] && [ "$input_allows" -ge 1 ]
  [ "$(iptables -S "$FWD_CHAIN" | grep -c '^-A ')" -eq $((fwd_allows + 7)) ]
  [ "$(iptables -S "$INPUT_CHAIN" | grep -c '^-A ')" -eq $((input_allows + 1)) ]

  local line=$((fwd_allows + 1))
  for destination in "$SUBNET" 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
    check_row "$FWD_CHAIN" "$line" REJECT all "$destination"
    line=$((line + 1))
  done
  check_row "$FWD_CHAIN" "$line" RETURN all 0.0.0.0/0
  check_row "$INPUT_CHAIN" $((input_allows + 1)) REJECT all 0.0.0.0/0
}

if [ "${1:-}" = "--check" ]; then
  check_rules
  echo "verified all $COMMENT rules"
  exit 0
fi

remove_rules
if [ "${1:-}" = "--remove" ]; then
  echo "removed all $COMMENT rules"
  exit 0
fi

iptables -N "$FWD_CHAIN"
iptables -N "$INPUT_CHAIN"

# The API is the only private destination. Same-subnet traffic is explicitly
# rejected so concurrent Missions from different users cannot communicate.
for port in "${API_PORTS[@]}"; do
  iptables -A "$FWD_CHAIN" -d "$GATEWAY" -p tcp --dport "$port" -j RETURN
  if [ -n "$HOST_GATEWAY" ] && [ "$HOST_GATEWAY" != "$GATEWAY" ]; then
    iptables -A "$FWD_CHAIN" -d "$HOST_GATEWAY" -p tcp --dport "$port" -j RETURN
  fi
done
iptables -A "$FWD_CHAIN" -d "$SUBNET" -j REJECT
iptables -A "$FWD_CHAIN" -d 10.0.0.0/8 -j REJECT
iptables -A "$FWD_CHAIN" -d 172.16.0.0/12 -j REJECT
iptables -A "$FWD_CHAIN" -d 192.168.0.0/16 -j REJECT
iptables -A "$FWD_CHAIN" -d 169.254.0.0/16 -j REJECT
iptables -A "$FWD_CHAIN" -d 100.64.0.0/10 -j REJECT
iptables -A "$FWD_CHAIN" -j RETURN

for port in "${API_PORTS[@]}"; do
  iptables -A "$INPUT_CHAIN" -d "$GATEWAY" -p tcp --dport "$port" -j ACCEPT
  if [ -n "$HOST_GATEWAY" ] && [ "$HOST_GATEWAY" != "$GATEWAY" ]; then
    iptables -A "$INPUT_CHAIN" -d "$HOST_GATEWAY" -p tcp --dport "$port" -j ACCEPT
  fi
done
iptables -A "$INPUT_CHAIN" -j REJECT

# Anchors are always inserted at rule 1; --check verifies both position and an
# exact rule count inside the owned chains, catching broad shadow rules.
iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$FWD_CHAIN" $(tag)
iptables -I INPUT 1 -s "$SUBNET" -j "$INPUT_CHAIN" $(tag)

check_rules

echo "applied. verify with: iptables -S DOCKER-USER; iptables -S INPUT | grep $COMMENT"
echo "smoke (expect blocked/blocked/ok):"
echo "  docker run --rm --network $NETWORK alpine:3 wget -q -T3 -O- http://169.254.169.254/ && echo LEAK || echo blocked"
echo "  docker run --rm --network $NETWORK alpine:3 nc -z -w3 \$(hostname -I | awk '{print \$1}') 27017 && echo LEAK || echo blocked"
echo "  docker run --rm --network $NETWORK alpine:3 wget -q -T8 -O- https://registry.npmmirror.com/ >/dev/null && echo ok || echo FAIL"
