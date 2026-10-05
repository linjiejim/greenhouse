#!/usr/bin/env bash
# Smoke test of the greenhouse/bot-computer image with the API's exact
# `docker run` argv (docs/specs/20261005-personal-assistant-bots.md §6, §12):
#
#   1. starts with the real argv and answers DevTools (through gh-cdp-relay) in ≤45 s
#   2. VNC greets on the Unix socket; nothing listens on TCP
#   3. the agent uid cannot reach cdp.sock, vnc.sock, the X display or the profile
#   4. file:// and greenhouse's own origins are blocked; the welcome page is not
#   5. a timed-out command leaves no process behind (the API's exec wrapper + kill script)
#   6. relay hand-off: after a client vanishes mid-auto-attach, the next client
#      can open and drive a new target without hanging
#   7. the home volume (files, browser cookies) survives docker stop + rm + a fresh run
#   8. (hardened hosts) egress lockdown: from inside, the bridge gateway's API port and
#      cloud metadata are refused — the same probe the API runs after every start
#
# Usage: bash scripts/bot-computer-smoke.sh   (BOTS_COMPUTER_RUNTIME=runsc on a gVisor host;
# defaults to runc for a development box). Cleans up everything it creates.
# BOTS_COMPUTER_NETWORK=<the computers' bridge> runs on that network (it is never
# created or removed here) and adds check 8; apply the rules first with
# `sudo BOTS_COMPUTER_NETWORK=<net> bash scripts/cloud-agent-net.sh --profile bots`.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNTIME="${BOTS_COMPUTER_RUNTIME:-runc}"
ID="smoke$$"
NAME="gh-computer-${ID}"
VOLUME="${NAME}-home"
OWN_NETWORK=1
NETWORK="gh-bots-${ID}"
if [ -n "${BOTS_COMPUTER_NETWORK:-}" ]; then
  OWN_NETWORK=0
  NETWORK="$BOTS_COMPUTER_NETWORK"
fi
BLOCKLIST="smoke-blocked.example,host.docker.internal:4401"
TSX=(node_modules/.bin/tsx scripts/bot-computer-argv.ts)

pass() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
fail() {
  printf '  \033[31m✗\033[0m %s\n' "$*"
  docker logs "$NAME" 2>&1 | grep -E '^\[gh-' | tail -20 || true
  exit 1
}
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm -f "$VOLUME" >/dev/null 2>&1 || true
  if [ "$OWN_NETWORK" = 1 ]; then docker network rm "$NETWORK" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

# DevTools client run INSIDE the container as uid browser (the API's position).
# Commands: version | nav <url>... | setcookie | getcookie | attach-and-vanish | drive-new-target
CDP_PY=$(cat <<'PY'
import json, socket, sys, time
sock = socket.socket(socket.AF_UNIX); sock.settimeout(10); sock.connect('/tmp/browser/cdp.sock')
buf = b''; counter = [0]; events = []
def send(method, params=None, session=None):
    counter[0] += 1
    msg = {'id': counter[0], 'method': method, 'params': params or {}}
    if session: msg['sessionId'] = session
    sock.sendall(json.dumps(msg).encode() + b'\0')
    return counter[0]
def wait(i):
    global buf
    while True:
        while b'\0' in buf:
            raw, buf = buf.split(b'\0', 1)
            obj = json.loads(raw)
            if obj.get('id') == i:
                return obj
            if 'method' in obj:
                events.append(obj)
        chunk = sock.recv(1 << 20)
        if not chunk:
            raise SystemExit('relay closed the connection')
        buf += chunk
def call(method, params=None, session=None):
    return wait(send(method, params, session))
cmd = sys.argv[1]
if cmd == 'version':
    print(call('Browser.getVersion')['result']['product'])
elif cmd == 'nav':
    target = call('Target.createTarget', {'url': 'about:blank'})['result']['targetId']
    session = call('Target.attachToTarget', {'targetId': target, 'flatten': True})['result']['sessionId']
    for url in sys.argv[2:]:
        result = call('Page.navigate', {'url': url}, session).get('result', {})
        print(url, result.get('errorText') or 'loaded')
    call('Target.closeTarget', {'targetId': target})
elif cmd == 'setcookie':
    call('Storage.setCookies', {'cookies': [{'name': 'gh_smoke', 'value': 'kept', 'domain': '.example.com', 'path': '/', 'expires': time.time() + 86400}]})
    print('set')
elif cmd == 'getcookie':
    print(' '.join(c['name'] for c in call('Storage.getCookies')['result']['cookies']))
elif cmd == 'attach-and-vanish':
    # What Playwright does on connect, then the client dies without cleaning up.
    call('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': True, 'flatten': True})
    call('Target.setDiscoverTargets', {'discover': True})
    call('Target.createTarget', {'url': 'about:blank'})
    time.sleep(0.5)
    print('vanished')
elif cmd == 'drive-new-target':
    # What Playwright needs after the hand-off: the existing pages are announced
    # to the new client, and a new tab actually loads (not paused for a dead debugger).
    started = time.time()
    call('Target.setAutoAttach', {'autoAttach': True, 'waitForDebuggerOnStart': False, 'flatten': True})
    call('Browser.getVersion')  # a round trip, so the attach events have arrived
    pages = sum(1 for e in events if e['method'] == 'Target.attachedToTarget' and e['params']['targetInfo']['type'] == 'page')
    target = call('Target.createTarget', {'url': 'file:///opt/greenhouse/welcome.html'})['result']['targetId']
    session = call('Target.attachToTarget', {'targetId': target, 'flatten': True})['result']['sessionId']
    title = ''
    while time.time() - started < 8 and 'greenhouse' not in title:
        title = call('Runtime.evaluate', {'expression': 'document.title', 'returnByValue': True}, session)['result']['result'].get('value', '')
        time.sleep(0.1)
    call('Target.closeTarget', {'targetId': target})
    print(f'pages={pages} loaded={"greenhouse" in title} in {time.time() - started:.2f}s')
PY
)
cdp() { docker exec -i -u browser "$NAME" python3 - "$@" <<<"$CDP_PY"; }
# `lines_into ARR cmd…` — one array element per output line (macOS bash 3.2 has no mapfile).
lines_into() {
  local __name=$1 __line
  shift
  eval "$__name=()"
  while IFS= read -r __line; do eval "$__name+=(\"\$__line\")"; done < <("$@")
}
as_agent() { docker exec -u agent -e HOME=/home/agent "$NAME" bash -c "$1"; }

start_computer() {
  lines_into RUN_ARGS "${TSX[@]}" run "$NAME" "$VOLUME" "$NETWORK" "$RUNTIME" "$BLOCKLIST"
  docker "${RUN_ARGS[@]}" >/dev/null  # the argv starts with `run`
  local deadline=$((SECONDS + 45))
  until cdp version >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then fail "DevTools did not answer within 45 s"; fi
    sleep 0.5
  done
}

echo "==> bot-computer smoke (runtime: ${RUNTIME})"
if [ "$OWN_NETWORK" = 1 ]; then
  docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false \
    --label greenhouse.bots.computer=smoke "$NETWORK" >/dev/null
fi

# 1. start + DevTools
t0=$SECONDS
start_computer
pass "started with the API argv; DevTools answers: $(cdp version) ($((SECONDS - t0)) s)"
lines_into RUN_ARGS "${TSX[@]}" run "$NAME" "$VOLUME" "$NETWORK" "$RUNTIME" "$BLOCKLIST"
printf '%s\n' "${RUN_ARGS[@]}" | grep -qx -- '-p' && fail "argv publishes a port"
[ "$(docker inspect -f '{{json .HostConfig.PortBindings}}' "$NAME")" = "{}" ] || fail "container has port bindings"
docker exec "$NAME" env | grep -qE '^(HTTP|HTTPS)_PROXY=.+' && fail "a proxy leaked into the container env"
pass "no published ports; proxy env cleared"

# 2. VNC on the socket only
greeting=$(docker exec -i -u browser "$NAME" timeout 3 socat -T2 STDIO UNIX-CONNECT:/tmp/browser/vnc.sock </dev/null 2>/dev/null | head -c 12 || true)
[ "$greeting" = "RFB 003.008" ] || fail "no VNC greeting on vnc.sock (got: ${greeting:-nothing})"
pass "VNC greets on the Unix socket: ${greeting}"
for port in 5900 9222; do
  if as_agent "timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/${port}'" 2>/dev/null; then fail "TCP ${port} is open"; fi
done
pass "nothing listens on TCP 5900/9222"

# 3. the agent uid is walled off
if as_agent "timeout 3 socat -T1 - UNIX-CONNECT:/tmp/browser/cdp.sock </dev/null" 2>/dev/null; then fail "agent reached cdp.sock"; fi
if as_agent "timeout 3 socat -T1 - UNIX-CONNECT:/tmp/browser/vnc.sock </dev/null" 2>/dev/null; then fail "agent reached vnc.sock"; fi
if as_agent "DISPLAY=:0 timeout 3 xsetroot -solid red" 2>/dev/null; then fail "agent drew on the X display"; fi
if as_agent "ls /home/browser" >/dev/null 2>&1; then fail "agent listed the browser profile"; fi
as_agent "curl -sS -o /dev/null -m 15 --retry 3 --retry-all-errors https://cn.bing.com/" >/dev/null || fail "agent has no internet"
pass "agent: cdp.sock, vnc.sock, X display and profile denied; internet works"

# 4. URL policy
nav=$(cdp nav "file:///home/browser/chromium/Default/Preferences" "file:///etc/passwd" \
  "file:///opt/greenhouse/welcome.html" "https://smoke-blocked.example/" "http://host.docker.internal:4401/")
echo "$nav" | grep -q "chromium/Default/Preferences net::ERR_BLOCKED_BY_ADMINISTRATOR" || fail "profile readable via file://: $nav"
echo "$nav" | grep -q "/etc/passwd net::ERR_BLOCKED_BY_ADMINISTRATOR" || fail "file:// not blocked: $nav"
echo "$nav" | grep -q "welcome.html loaded" || fail "welcome page blocked: $nav"
echo "$nav" | grep -q "smoke-blocked.example/ net::ERR_BLOCKED_BY_ADMINISTRATOR" || fail "runtime blocklist ignored: $nav"
echo "$nav" | grep -q "host.docker.internal:4401/ net::ERR_BLOCKED_BY_ADMINISTRATOR" || fail "greenhouse port not blocked: $nav"
pass "file:// and greenhouse origins blocked by policy; welcome page allowed"

# 5. timed-out command leaves nothing behind
lines_into SHELL_ARGV "${TSX[@]}" shell 2 '(sleep 300 &); sleep 300'
set +e
docker exec -u agent -w /home/agent -e HOME=/home/agent -e GH_EXEC_ID=smoke-exec "$NAME" "${SHELL_ARGV[@]}" >/dev/null 2>&1
code=$?
set -e
[ "$code" = 124 ] || [ "$code" = 137 ] || fail "timeout(1) did not fire (exit $code)"
docker exec -u agent "$NAME" sh -c "$("${TSX[@]}" kill-script)" gh-kill smoke-exec "" >/dev/null
left=$(as_agent "pgrep -u agent -a sleep || true")
[ -z "$left" ] || fail "processes survived the timeout: $left"
pass "timed-out command (exit $code) leaves no process behind"

# 6. relay hand-off
cdp attach-and-vanish >/dev/null
handoff=$(timeout 15 docker exec -i -u browser "$NAME" python3 - drive-new-target <<<"$CDP_PY" || true)
[[ "$handoff" == pages=[1-9]*\ loaded=True* ]] || fail "the next DevTools client was not handed the browser cleanly (${handoff:-timeout})"
pass "relay hand-off: the next client is shown the open pages and loads a new tab (${handoff})"

# 7. persistence across stop + rm + run
as_agent "mkdir -p ~/work && echo kept > ~/work/smoke.txt"
cdp setcookie >/dev/null
t0=$SECONDS
docker stop -t 5 "$NAME" >/dev/null
stop_s=$((SECONDS - t0))
docker logs "$NAME" 2>&1 | grep -q 'chromium exited (0)' || fail "browser did not shut down cleanly on docker stop"
docker rm "$NAME" >/dev/null
start_computer
[ "$(as_agent 'cat ~/work/smoke.txt')" = "kept" ] || fail "files lost across rm + run"
cdp getcookie | grep -qw gh_smoke || fail "browser cookies lost across rm + run"
pass "home survives stop (${stop_s} s, clean browser exit) + rm + run: files and cookies intact"

# 8. egress lockdown (curl 7 = refused, 28 = timed out: no connection made)
if [ "$OWN_NETWORK" = 1 ]; then
  echo "  - egress lockdown not checked (set BOTS_COMPUTER_NETWORK to the hardened bridge)"
else
  gateway=$(docker network inspect "$NETWORK" --format '{{(index .IPAM.Config 0).Gateway}}')
  for url in "http://${gateway}:${API_PORT:-3000}/" "http://169.254.169.254/"; do
    set +e
    as_agent "curl -sS -m 3 --noproxy '*' -o /dev/null '$url'" >/dev/null 2>&1
    code=$?
    set -e
    [ "$code" = 7 ] || [ "$code" = 28 ] || fail "the computer reached ${url} (curl exit ${code}): egress rules not in force"
  done
  pass "egress lockdown: ${gateway}:${API_PORT:-3000} and cloud metadata refused"
fi

echo "==> all checks passed"
