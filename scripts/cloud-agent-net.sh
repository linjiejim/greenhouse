#!/usr/bin/env bash
# Sandbox egress lockdown — run ON THE DOCKER HOST (Linux, root).
#
# Two profiles share this script and its verification, each with its own
# comment and chains (the script flushes the chains it owns, so the names must
# never be shared):
#
#   mission (default) — the Mission Sandbox Runner bridge. Public internet is
#     allowed (P1 spec D4: npm install / docs browsing), but NOT:
#       • the cloud metadata endpoint (169.254.169.254 — instance credentials!)
#       • link-local + RFC1918 (the host's other containers/services: on the dev
#         box that's mongo --bind_ip_all, redis, emqx, TDengine, postgres…)
#     …EXCEPT the api itself via the host gateway (host.docker.internal).
#
#   bots (`--profile bots`) — the members' Bot computers (BOTS_COMPUTER_NETWORK,
#     docs/specs/20261005-personal-assistant-bots.md §6.1). Same denies, and
#     ZERO allow rows: a computer never talks to the API (everything goes
#     through `docker exec`), so not even the API port is reachable. The one
#     exception is BOTS_COMPUTER_PROXY when it is a private IP literal: exactly
#     that host:port is allowed (the proxy must refuse private destinations
#     itself, or it becomes the way around these rules).
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
# Both profiles insert their anchors at rule 1 of DOCKER-USER and INPUT, so on
# a host running both, whichever was applied last sits on top. `--check`
# accepts the OTHER profile's anchor above its own (comment-tagged, jumping to
# that profile's chain, for a source subnet disjoint from ours — it can never
# see our traffic), and nothing else.
#
# Idempotent: safe to re-run; use `--remove` to undo. Persist across reboots
# via your init (e.g. a systemd oneshot or /etc/rc.local) — iptables rules are
# not durable by themselves.
#
# Usage:
#   sudo bash scripts/cloud-agent-net.sh            # apply (Mission)
#   sudo bash scripts/cloud-agent-net.sh --remove   # undo (Mission)
#   SANDBOX_RUNNER_NETWORK=cloud-agent API_PORT=3108 sudo -E bash scripts/cloud-agent-net.sh
#   API_PORT=3109,3110 sudo -E bash scripts/cloud-agent-net.sh   # blue/green: both slots
#   sudo BOTS_COMPUTER_NETWORK=bots bash scripts/cloud-agent-net.sh --profile bots           # apply (Bot computers)
#   sudo BOTS_COMPUTER_NETWORK=bots bash scripts/cloud-agent-net.sh --profile bots --check   # what the API runs
set -euo pipefail

usage() { echo "usage: $0 [--profile mission|bots] [--check|--remove]" >&2; }

MODE=apply
PROFILE=mission
while [ "$#" -gt 0 ]; do
  case "$1" in
    --check | --remove)
      [ "$MODE" = apply ] || { usage; exit 2; }
      MODE="${1#--}"
      ;;
    --profile)
      [ "$#" -ge 2 ] || { usage; exit 2; }
      PROFILE="$2"
      shift
      ;;
    --profile=*) PROFILE="${1#--profile=}" ;;
    *) usage; exit 2 ;;
  esac
  shift
done

MISSION_COMMENT="greenhouse-mission-sandbox"
MISSION_CHAINS="GREENHOUSE-MISSION-FWD GREENHOUSE-MISSION-IN"
BOTS_COMMENT="greenhouse-bots-computer"
BOTS_CHAINS="GREENHOUSE-BOTS-FWD GREENHOUSE-BOTS-IN"

API_PORTS=()
PROXY_IP=""
PROXY_PORT=""
case "$PROFILE" in
  mission)
    NETWORK="${SANDBOX_RUNNER_NETWORK:-${CLOUD_AGENT_NETWORK:-cloud-agent}}"
    # One port, or a comma-separated list when two API slots take turns behind a
    # reverse proxy (blue/green): every listed port is reachable, nothing else.
    # `--check` demands every listed port and accepts extra allow rows for other
    # ports on the same gateways — the API checks with its own port only, while
    # the host applied the rules for both slots.
    API_PORT="${API_PORT:-3108}"
    COMMENT="$MISSION_COMMENT"
    FWD_CHAIN="GREENHOUSE-MISSION-FWD"
    INPUT_CHAIN="GREENHOUSE-MISSION-IN"
    SIBLING_COMMENT="$BOTS_COMMENT"
    SIBLING_CHAINS="$BOTS_CHAINS"
    IFS=',' read -r -a API_PORTS <<< "$API_PORT"
    [ "${#API_PORTS[@]}" -ge 1 ] || { echo "API_PORT must list at least one port" >&2; exit 2; }
    for port in "${API_PORTS[@]}"; do
      [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] \
        || { echo "API_PORT entries must be integers between 1 and 65535 (got '$port')" >&2; exit 2; }
    done
    ;;
  bots)
    NETWORK="${BOTS_COMPUTER_NETWORK:-}"
    [ -n "$NETWORK" ] || { echo "BOTS_COMPUTER_NETWORK must name the computers' bridge" >&2; exit 2; }
    COMMENT="$BOTS_COMMENT"
    FWD_CHAIN="GREENHOUSE-BOTS-FWD"
    INPUT_CHAIN="GREENHOUSE-BOTS-IN"
    SIBLING_COMMENT="$MISSION_COMMENT"
    SIBLING_CHAINS="$MISSION_CHAINS"
    # The only allow row a computer may get: a private-IP egress proxy. A proxy
    # named by hostname or on a public address needs none (public traffic passes
    # the denies), and the metadata range is never allowed.
    proxy="${BOTS_COMPUTER_PROXY:-}"
    if [ -n "$proxy" ]; then
      scheme="${proxy%%://*}"
      hostport="${proxy#*://}"
      hostport="${hostport%%/*}"
      proxy_host="${hostport%%:*}"
      proxy_port=""
      [ "$hostport" != "$proxy_host" ] && proxy_port="${hostport##*:}"
      if [[ "$proxy_host" =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]]; then
        o1="${BASH_REMATCH[1]}"; o2="${BASH_REMATCH[2]}"
        if [ "$o1" = 169 ] && [ "$o2" = 254 ]; then
          echo "BOTS_COMPUTER_PROXY may not point into 169.254.0.0/16 (link-local / metadata)" >&2
          exit 2
        fi
        if [ "$o1" = 10 ] || { [ "$o1" = 172 ] && [ "$o2" -ge 16 ] && [ "$o2" -le 31 ]; } \
          || { [ "$o1" = 192 ] && [ "$o2" = 168 ]; } || { [ "$o1" = 100 ] && [ "$o2" -ge 64 ] && [ "$o2" -le 127 ]; }; then
          PROXY_IP="$proxy_host"
          case "$scheme" in
            http) PROXY_PORT="${proxy_port:-80}" ;;
            https) PROXY_PORT="${proxy_port:-443}" ;;
            *) PROXY_PORT="${proxy_port:-1080}" ;;
          esac
          [[ "$PROXY_PORT" =~ ^[0-9]+$ ]] && [ "$PROXY_PORT" -ge 1 ] && [ "$PROXY_PORT" -le 65535 ] \
            || { echo "BOTS_COMPUTER_PROXY has an invalid port ('$PROXY_PORT')" >&2; exit 2; }
        fi
      elif [ "$MODE" = apply ]; then
        echo "note: BOTS_COMPUTER_PROXY names a host ($proxy_host); if it resolves to a private address, use its IP so it can be allowed" >&2
      fi
    fi
    ;;
  *) usage; exit 2 ;;
esac

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
HOST_GATEWAY=""
if [ "$PROFILE" = mission ]; then
  # ⚠️ `--add-host host.docker.internal:host-gateway` (docker.ts) resolves to the
  # daemon's host-gateway-ip, which defaults to the DEFAULT bridge's gateway
  # (172.17.0.1) — NOT this bridge's. That address is inside the 172.16/12 deny,
  # so without an explicit allow the sandbox loses the api entirely (relay, event
  # push, artifact upload) and every run dies. Allow both gateways.
  HOST_GATEWAY="${HOST_GATEWAY_IP:-$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || true)}"
  echo "network=$NETWORK subnet=$SUBNET gateway=$GATEWAY host_gateway=${HOST_GATEWAY:-<none>} api_ports=${API_PORTS[*]}"
else
  echo "profile=bots network=$NETWORK subnet=$SUBNET gateway=$GATEWAY proxy_allow=${PROXY_IP:+$PROXY_IP:$PROXY_PORT}"
fi

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

ip_to_int() {
  local IFS=.
  # shellcheck disable=SC2086
  set -- $1
  echo $(((${1:-0} << 24) | (${2:-0} << 16) | (${3:-0} << 8) | ${4:-0}))
}

# Do two IPv4 networks (a.b.c.d[/n]) share any address?
cidr_overlaps() {
  local a="${1%/*}" b="${2%/*}" an=32 bn=32 n mask
  [[ "$1" == */* ]] && an="${1#*/}"
  [[ "$2" == */* ]] && bn="${2#*/}"
  n=$((an < bn ? an : bn))
  mask=$((n == 0 ? 0 : (0xFFFFFFFF << (32 - n)) & 0xFFFFFFFF))
  [ $(($(ip_to_int "$a") & mask)) -eq $(($(ip_to_int "$b") & mask)) ]
}

# The other profile's anchor (see the header): its comment, its chain, a
# concrete source subnet that cannot contain ours.
is_sibling_anchor() {
  local row="$1" row_target row_source chain
  row_target=$(echo "$row" | awk '{print $2}')
  row_source=$(echo "$row" | awk '{print $5}')
  for chain in $SIBLING_CHAINS; do
    [ "$row_target" = "$chain" ] || continue
    echo "$row" | grep -F -- "/* $SIBLING_COMMENT */" >/dev/null || return 1
    [[ "$row_source" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(/[0-9]+)?$ ]] || return 1
    [ "$row_source" != 0.0.0.0/0 ] || return 1
    cidr_overlaps "$row_source" "$SUBNET" && return 1
    return 0
  done
  return 1
}

check_first_jump() {
  local chain="$1" target="$2" listing row first="" n=1
  # Do not exit awk early: with pipefail, a verbose iptables producer can
  # receive SIGPIPE and turn an otherwise valid verification into exit 141.
  listing=$(iptables -L "$chain" -n --line-numbers)
  while :; do
    row=$(echo "$listing" | awk -v wanted="$n" '$1 == wanted { print }')
    if [ -n "$row" ] && is_sibling_anchor "$row"; then
      n=$((n + 1))
      continue
    fi
    first=$(echo "$row" | awk '{print $2}')
    break
  done
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
  [ "$fwd_allows" -ge 1 ] || {
    echo "$FWD_CHAIN rule 1 has unsafe order/content: expected an API allow row first" >&2
    return 1
  }
  [ "$input_allows" -ge 1 ] || {
    echo "$INPUT_CHAIN rule 1 has unsafe order/content: expected an API allow row first" >&2
    return 1
  }
  [ "$(iptables -S "$FWD_CHAIN" | grep -c '^-A ')" -eq $((fwd_allows + 7)) ] || {
    echo "$FWD_CHAIN has an unexpected number of rules (want $((fwd_allows + 7)))" >&2
    return 1
  }
  [ "$(iptables -S "$INPUT_CHAIN" | grep -c '^-A ')" -eq $((input_allows + 1)) ] || {
    echo "$INPUT_CHAIN has an unexpected number of rules (want $((input_allows + 1)))" >&2
    return 1
  }

  local line=$((fwd_allows + 1))
  for destination in "$SUBNET" 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
    check_row "$FWD_CHAIN" "$line" REJECT all "$destination"
    line=$((line + 1))
  done
  check_row "$FWD_CHAIN" "$line" RETURN all 0.0.0.0/0
  check_row "$INPUT_CHAIN" $((input_allows + 1)) REJECT all 0.0.0.0/0
}

# Bot computers: zero allow rows (one for a private-IP proxy), then exactly the
# Mission deny block. Any port allow — the API's included — fails the check.
check_rules_bots() {
  check_first_jump DOCKER-USER "$FWD_CHAIN"
  check_first_jump INPUT "$INPUT_CHAIN"
  # shellcheck disable=SC2046
  iptables -C DOCKER-USER -s "$SUBNET" -j "$FWD_CHAIN" $(tag)
  # shellcheck disable=SC2046
  iptables -C INPUT -s "$SUBNET" -j "$INPUT_CHAIN" $(tag)
  [ "$(iptables -S DOCKER-USER | grep -c -- "-j $FWD_CHAIN")" -eq 1 ]
  [ "$(iptables -S INPUT | grep -c -- "-j $INPUT_CHAIN")" -eq 1 ]

  local allows=0
  if [ -n "$PROXY_IP" ]; then
    iptables -C "$FWD_CHAIN" -d "$PROXY_IP" -p tcp --dport "$PROXY_PORT" -j RETURN
    iptables -C "$INPUT_CHAIN" -d "$PROXY_IP" -p tcp --dport "$PROXY_PORT" -j ACCEPT
    check_row "$FWD_CHAIN" 1 RETURN tcp "$PROXY_IP" "dpt:$PROXY_PORT"
    check_row "$INPUT_CHAIN" 1 ACCEPT tcp "$PROXY_IP" "dpt:$PROXY_PORT"
    allows=1
  fi
  local ports
  for chain in "$FWD_CHAIN" "$INPUT_CHAIN"; do
    ports=$(iptables -S "$chain" | grep -c -- '--dport' || true)
    [ "$ports" -eq "$allows" ] || {
      echo "$chain has $ports port allow row(s); Bot computers get none (only BOTS_COMPUTER_PROXY when it is a private IP)" >&2
      return 1
    }
  done

  iptables -C "$FWD_CHAIN" -d "$SUBNET" -j REJECT
  iptables -C "$FWD_CHAIN" -d 10.0.0.0/8 -j REJECT
  iptables -C "$FWD_CHAIN" -d 172.16.0.0/12 -j REJECT
  iptables -C "$FWD_CHAIN" -d 192.168.0.0/16 -j REJECT
  iptables -C "$FWD_CHAIN" -d 169.254.0.0/16 -j REJECT
  iptables -C "$FWD_CHAIN" -d 100.64.0.0/10 -j REJECT
  iptables -C "$FWD_CHAIN" -j RETURN
  iptables -C "$INPUT_CHAIN" -j REJECT

  [ "$(iptables -S "$FWD_CHAIN" | grep -c '^-A ')" -eq $((allows + 7)) ] || {
    echo "$FWD_CHAIN has an unexpected number of rules (want $((allows + 7)))" >&2
    return 1
  }
  [ "$(iptables -S "$INPUT_CHAIN" | grep -c '^-A ')" -eq $((allows + 1)) ] || {
    echo "$INPUT_CHAIN has an unexpected number of rules (want $((allows + 1)))" >&2
    return 1
  }
  local line=$((allows + 1))
  for destination in "$SUBNET" 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
    check_row "$FWD_CHAIN" "$line" REJECT all "$destination"
    line=$((line + 1))
  done
  check_row "$FWD_CHAIN" "$line" RETURN all 0.0.0.0/0
  check_row "$INPUT_CHAIN" $((allows + 1)) REJECT all 0.0.0.0/0
}

verify() {
  if [ "$PROFILE" = bots ]; then check_rules_bots; else check_rules; fi
}

if [ "$MODE" = check ]; then
  verify
  echo "verified all $COMMENT rules"
  exit 0
fi

remove_rules
if [ "$MODE" = remove ]; then
  echo "removed all $COMMENT rules"
  exit 0
fi

iptables -N "$FWD_CHAIN"
iptables -N "$INPUT_CHAIN"

if [ "$PROFILE" = bots ]; then
  # Computers reach nothing private: no API port, no gateway. Only a private
  # egress proxy, when one is configured, gets its single allow row.
  if [ -n "$PROXY_IP" ]; then
    iptables -A "$FWD_CHAIN" -d "$PROXY_IP" -p tcp --dport "$PROXY_PORT" -j RETURN
  fi
else
  # The API is the only private destination. Same-subnet traffic is explicitly
  # rejected so concurrent Missions from different users cannot communicate.
  for port in "${API_PORTS[@]}"; do
    iptables -A "$FWD_CHAIN" -d "$GATEWAY" -p tcp --dport "$port" -j RETURN
    if [ -n "$HOST_GATEWAY" ] && [ "$HOST_GATEWAY" != "$GATEWAY" ]; then
      iptables -A "$FWD_CHAIN" -d "$HOST_GATEWAY" -p tcp --dport "$port" -j RETURN
    fi
  done
fi
iptables -A "$FWD_CHAIN" -d "$SUBNET" -j REJECT
iptables -A "$FWD_CHAIN" -d 10.0.0.0/8 -j REJECT
iptables -A "$FWD_CHAIN" -d 172.16.0.0/12 -j REJECT
iptables -A "$FWD_CHAIN" -d 192.168.0.0/16 -j REJECT
iptables -A "$FWD_CHAIN" -d 169.254.0.0/16 -j REJECT
iptables -A "$FWD_CHAIN" -d 100.64.0.0/10 -j REJECT
iptables -A "$FWD_CHAIN" -j RETURN

if [ "$PROFILE" = bots ]; then
  if [ -n "$PROXY_IP" ]; then
    iptables -A "$INPUT_CHAIN" -d "$PROXY_IP" -p tcp --dport "$PROXY_PORT" -j ACCEPT
  fi
else
  for port in "${API_PORTS[@]}"; do
    iptables -A "$INPUT_CHAIN" -d "$GATEWAY" -p tcp --dport "$port" -j ACCEPT
    if [ -n "$HOST_GATEWAY" ] && [ "$HOST_GATEWAY" != "$GATEWAY" ]; then
      iptables -A "$INPUT_CHAIN" -d "$HOST_GATEWAY" -p tcp --dport "$port" -j ACCEPT
    fi
  done
fi
iptables -A "$INPUT_CHAIN" -j REJECT

# Anchors are always inserted at rule 1; --check verifies both position and an
# exact rule count inside the owned chains, catching broad shadow rules.
# shellcheck disable=SC2046
iptables -I DOCKER-USER 1 -s "$SUBNET" -j "$FWD_CHAIN" $(tag)
# shellcheck disable=SC2046
iptables -I INPUT 1 -s "$SUBNET" -j "$INPUT_CHAIN" $(tag)

verify

echo "applied. verify with: iptables -S DOCKER-USER; iptables -S INPUT | grep $COMMENT"
echo "smoke (expect blocked/blocked/ok):"
echo "  docker run --rm --network $NETWORK alpine:3 wget -q -T3 -O- http://169.254.169.254/ && echo LEAK || echo blocked"
echo "  docker run --rm --network $NETWORK alpine:3 nc -z -w3 \$(hostname -I | awk '{print \$1}') 27017 && echo LEAK || echo blocked"
echo "  docker run --rm --network $NETWORK alpine:3 wget -q -T8 -O- https://registry.npmmirror.com/ >/dev/null && echo ok || echo FAIL"
